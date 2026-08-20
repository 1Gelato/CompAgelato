import crypto from 'node:crypto';
import type { AuthIdentity, LoginOutcome } from '@shared/api';
import type { ID, Role, Session, User, UserSummary } from '@shared/types';
import { newId, nowIso, store } from '../store';

/**
 * Comptes, mots de passe et sessions.
 *
 * `scrypt` est **inclus dans Node** : pas de nouvelle dépendance, ce qui
 * préserve la propriété « rien à compiler » qui rend l'installation du serveur
 * triviale.
 *
 * Les jetons de session sont **opaques et révocables** — pas de JWT. Quand un
 * salarié part, on veut couper son accès dans la seconde, pas attendre
 * l'expiration d'un jeton qu'on ne contrôle plus. Seule l'empreinte du jeton
 * est enregistrée : une copie de la base ne permet pas d'usurper une session.
 */

/** Coût de dérivation. 2^15 : quelques dizaines de ms, imperceptible à la connexion. */
const SCRYPT_COST = 32_768;
const KEY_LENGTH = 64;
/**
 * `scrypt` a besoin de 128 × N × r octets, soit 33,5 Mo ici — au-dessus des
 * 32 Mo que Node autorise par défaut. On relève la limite plutôt que d'abaisser
 * le coût : c'est lui qui fait la résistance au cassage hors ligne.
 */
const SCRYPT_OPTIONS = { N: SCRYPT_COST, maxmem: 64 * 1024 * 1024 } as const;

const SESSION_DAYS = 30;
/** Appareil de tournée : personne ne tape un mot de passe à 6 h dans une camionnette. */
const DEVICE_SESSION_DAYS = 180;

const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Mots de passe                                                        */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, expectedHex] = (stored ?? '').split(':');
  if (!saltHex || !expectedHex) return false;
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(
      password.normalize('NFKC'),
      Buffer.from(saltHex, 'hex'),
      KEY_LENGTH,
      SCRYPT_OPTIONS,
    );
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  // Comparaison à temps constant : une comparaison naïve laisserait deviner
  // l'empreinte octet par octet en mesurant le temps de réponse.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/** Refuse les mots de passe trop courts — la seule règle qui compte vraiment. */
export function checkPasswordStrength(password: string): void {
  if ((password ?? '').trim().length < 8) {
    throw new Error('Le mot de passe doit faire au moins 8 caractères.');
  }
}

/* ------------------------------------------------------------------ */
/* Limitation des tentatives                                            */
/* ------------------------------------------------------------------ */

interface Attempts {
  count: number;
  until: number;
}

// En mémoire seulement : un redémarrage remet les compteurs à zéro, ce qui est
// acceptable — l'attaque visée est le mitraillage, pas la patience.
const attempts = new Map<string, Attempts>();

function attemptKey(username: string, from: string): string {
  return `${username.toLowerCase()}@${from}`;
}

function assertNotLocked(key: string): void {
  const entry = attempts.get(key);
  if (!entry || entry.until < Date.now()) return;
  const minutes = Math.ceil((entry.until - Date.now()) / 60_000);
  throw new Error(`Trop de tentatives. Réessayez dans ${minutes} minute(s).`);
}

function noteFailure(key: string): void {
  const entry = attempts.get(key) ?? { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.until = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  attempts.set(key, entry);
}

function noteSuccess(key: string): void {
  attempts.delete(key);
}

/* ------------------------------------------------------------------ */
/* Comptes                                                              */
/* ------------------------------------------------------------------ */

function normalizeUsername(raw: string): string {
  const username = (raw ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    throw new Error(
      'Identifiant invalide : 2 à 32 caractères, lettres non accentuées, chiffres, point, tiret ou soulignement.',
    );
  }
  return username;
}

export function findUser(username: string): User | undefined {
  const wanted = (username ?? '').trim().toLowerCase();
  return store.db.users.find((u) => u.username === wanted);
}

/** Des comptes existent-ils ? Sinon le serveur reste au jeton partagé. */
export function accountsConfigured(): boolean {
  return store.db.users.some((u) => !u.disabled);
}

export function identityOf(user: User): AuthIdentity {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

export function summarize(user: User): UserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    sessions: store.db.sessions.filter((s) => s.userId === user.id && !expired(s)).length,
  };
}

export function saveUser(input: {
  id?: ID;
  username: string;
  displayName: string;
  role: Role;
  password?: string;
  disabled?: boolean;
}): UserSummary {
  const username = normalizeUsername(input.username);
  const displayName = (input.displayName ?? '').trim() || username;

  const user = store.mutate((db) => {
    const existing = input.id ? db.users.find((u) => u.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('Compte introuvable.');

    const clash = db.users.find((u) => u.username === username && u.id !== input.id);
    if (clash) throw new Error(`L'identifiant « ${username} » est déjà pris.`);

    if (existing) {
      // Retirer le dernier gérant actif fermerait la porte à clé de l'intérieur.
      const losingLastManager =
        existing.role === 'gerant' &&
        (input.role !== 'gerant' || input.disabled) &&
        db.users.filter((u) => u.role === 'gerant' && !u.disabled && u.id !== existing.id).length === 0;
      if (losingLastManager) {
        throw new Error('Il doit rester au moins un gérant actif.');
      }

      existing.username = username;
      existing.displayName = displayName;
      existing.role = input.role;
      existing.disabled = input.disabled;
      existing.updatedAt = nowIso();
      if (input.password) {
        checkPasswordStrength(input.password);
        existing.passwordHash = hashPassword(input.password);
        // Changer le mot de passe coupe les sessions ouvertes ailleurs.
        db.sessions = db.sessions.filter((s) => s.userId !== existing.id);
      }
      return existing;
    }

    if (!input.password) throw new Error('Un mot de passe est nécessaire pour créer un compte.');
    checkPasswordStrength(input.password);
    const created: User = {
      id: newId('usr'),
      username,
      displayName,
      role: input.role,
      passwordHash: hashPassword(input.password),
      disabled: input.disabled,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.users.push(created);
    return created;
  });

  store.flushSync();
  return summarize(user);
}

export function removeUser(id: ID): void {
  store.mutate((db) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new Error('Compte introuvable.');
    const otherManagers = db.users.filter(
      (u) => u.role === 'gerant' && !u.disabled && u.id !== id,
    );
    if (user.role === 'gerant' && otherManagers.length === 0) {
      throw new Error('Il doit rester au moins un gérant actif.');
    }
    db.users = db.users.filter((u) => u.id !== id);
    db.sessions = db.sessions.filter((s) => s.userId !== id);
    // Un compte supprimé n'a plus de téléphone à prévenir : laisser
    // l'abonnement continuerait d'envoyer les annonces de l'entreprise à
    // l'appareil de quelqu'un qui n'en fait plus partie.
    db.pushDevices = db.pushDevices.filter((d) => d.userId !== id);
  });
  store.flushSync();
}

/* ------------------------------------------------------------------ */
/* Sessions                                                             */
/* ------------------------------------------------------------------ */

function fingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function expired(session: Session): boolean {
  return Date.parse(session.expiresAt) < Date.now();
}

/** Efface les sessions périmées. Appelée à chaque connexion, ça suffit. */
function purgeSessions(): void {
  const stale = store.db.sessions.filter(expired);
  if (!stale.length) return;
  store.mutate((db) => {
    db.sessions = db.sessions.filter((s) => !expired(s));
  });
}

export function login(input: {
  username: string;
  password: string;
  label?: string;
  from?: string;
  /** Session longue pour un appareil de tournée. */
  device?: boolean;
}): LoginOutcome {
  const key = attemptKey(input.username ?? '', input.from ?? 'inconnu');
  assertNotLocked(key);

  const user = findUser(input.username);
  // Message identique dans les deux cas : distinguer « compte inconnu » de
  // « mauvais mot de passe » révélerait quels identifiants existent.
  const refuse = () => {
    noteFailure(key);
    throw new Error('Identifiant ou mot de passe incorrect.');
  };
  if (!user || user.disabled) refuse();
  if (!verifyPassword(input.password ?? '', user!.passwordHash)) refuse();

  noteSuccess(key);
  purgeSessions();

  const token = crypto.randomBytes(32).toString('base64url');
  const days = input.device ? DEVICE_SESSION_DAYS : SESSION_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

  store.mutate((db) => {
    db.sessions.push({
      id: newId('ses'),
      userId: user!.id,
      tokenHash: fingerprint(token),
      label: (input.label ?? '').trim() || 'Appareil',
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
      expiresAt,
    });
    const fresh = db.users.find((u) => u.id === user!.id);
    if (fresh) fresh.lastLoginAt = nowIso();
  });
  store.flushSync();

  return { identity: identityOf(user!), token, expiresAt };
}

/** Résout un jeton en identité, ou `null`. Rafraîchit la date de dernière vue. */
export function resolveSession(token: string): { user: User; session: Session } | null {
  if (!token) return null;
  const hash = fingerprint(token);
  const session = store.db.sessions.find((s) => s.tokenHash === hash);
  if (!session || expired(session)) return null;
  const user = store.db.users.find((u) => u.id === session.userId);
  if (!user || user.disabled) return null;

  // Écriture au plus une fois par heure : marquer chaque requête réécrirait
  // toute la base à chaque appel.
  if (Date.now() - Date.parse(session.lastSeenAt) > 3600_000) {
    store.mutate(() => {
      session.lastSeenAt = nowIso();
    });
  }
  return { user, session };
}

export function logout(token: string): void {
  if (!token) return;
  const hash = fingerprint(token);
  store.mutate((db) => {
    // L'abonnement aux notifications ouvert sous cette session s'en va avec
    // elle : se déconnecter doit faire taire le téléphone.
    const closing = db.sessions.filter((s) => s.tokenHash === hash).map((s) => s.id);
    db.sessions = db.sessions.filter((s) => s.tokenHash !== hash);
    db.pushDevices = db.pushDevices.filter((d) => !d.sessionId || !closing.includes(d.sessionId));
  });
  store.flushSync();
}

export function listSessions(): (Session & { username: string })[] {
  purgeSessions();
  return store.db.sessions.map((session) => ({
    ...session,
    username: store.db.users.find((u) => u.id === session.userId)?.username ?? '—',
  }));
}

export function revokeSession(id: ID): void {
  store.mutate((db) => {
    db.sessions = db.sessions.filter((s) => s.id !== id);
    // Couper l'accès d'un appareil sans le faire taire serait à moitié fait :
    // il continuerait d'annoncer les arrivées sans pouvoir rien afficher.
    db.pushDevices = db.pushDevices.filter((d) => d.sessionId !== id);
  });
  store.flushSync();
}

export function changePassword(userId: ID, current: string, next: string): void {
  const user = store.db.users.find((u) => u.id === userId);
  if (!user) throw new Error('Compte introuvable.');
  if (!verifyPassword(current ?? '', user.passwordHash)) {
    throw new Error('Mot de passe actuel incorrect.');
  }
  checkPasswordStrength(next);
  store.mutate((db) => {
    const fresh = db.users.find((u) => u.id === userId);
    if (!fresh) return;
    fresh.passwordHash = hashPassword(next);
    fresh.updatedAt = nowIso();
    // Les autres appareils devront se reconnecter : c'est le but d'un
    // changement de mot de passe.
    db.sessions = db.sessions.filter((s) => s.userId !== userId);
  });
  store.flushSync();
}
