import fs from 'node:fs';
import path from 'node:path';
import { store, nowIso } from '../store';
import { applyUpdate, checkForUpdates } from './updater';

/**
 * Mise à jour automatique du serveur.
 *
 * Le serveur détient les données de tout le monde ; les postes, eux, se mettent
 * à jour d'un bouton sous les yeux de quelqu'un. Quand le serveur reste en
 * arrière, chaque poste finit par demander une fonction qu'il ne connaît pas —
 * et il faut aller ouvrir un navigateur *sur le serveur lui-même* pour le
 * réparer. Ce module supprime cette corvée : le passage se fait de nuit, tout
 * seul.
 *
 * Trois garde-fous, parce qu'une mise à jour non surveillée sur la machine qui
 * porte la comptabilité ne se lance pas à la légère :
 *
 * - **Rien ne part si rien ne relance le serveur.** Une mise à jour ne devient
 *   vivante qu'au redémarrage. Sans superviseur (`Restart=always` dans l'unité
 *   systemd), redémarrer serait éteindre — et il faudrait se déplacer. On
 *   s'abstient alors complètement, en le disant au journal, plutôt que de
 *   laisser le code neuf sur le disque et l'ancien en mémoire : cet entre-deux
 *   est précisément la confusion qu'on cherche à supprimer.
 * - **Une sauvegarde est prise juste avant de basculer.** Le jour où une
 *   nouvelle version se comporte mal, la copie qui compte est celle d'avant.
 * - **Un échec ne se répète pas indéfiniment.** L'état retient quelle version a
 *   été tentée et combien de fois : au troisième échec sur le même commit, on
 *   arrête d'essayer. Un serveur qui se relance en boucle toute la nuit serait
 *   pire que le retard qu'on voulait corriger.
 */

/** Heure du passage, par défaut. 3 h du matin : personne ne travaille. */
const DEFAULT_HOUR = 3;

/** Au-delà, on cesse de retenter la même version défaillante. */
const MAX_TRIES = 3;

const STATE_FILE = 'maj-auto.json';

export type RestartPolicy = 'always' | 'on-failure' | 'no';

export type AutoUpdateOutcome =
  /** Le serveur était déjà à jour. */
  | 'a-jour'
  /** Mise à jour installée ; le redémarrage a été demandé. */
  | 'appliquee'
  /** Pas un dossier cloné du dépôt : rien à faire ici. */
  | 'non-supportee'
  /** Rien ne relancerait ce serveur : on s'abstient. */
  | 'sans-superviseur'
  /** Cette version a déjà échoué plusieurs fois : on n'insiste plus. */
  | 'abandonnee'
  | 'echec';

export interface AutoUpdateResult {
  outcome: AutoUpdateOutcome;
  message: string;
  /** Nombre de commits de retard constatés. */
  behind?: number;
}

export interface AutoUpdateOptions {
  /** Dossier cloné du dépôt. */
  root: string;
  /** Heure locale du passage (0–23). Négatif : désactivé. */
  atHour?: number;
  /** Que se passe-t-il si ce processus s'arrête ? Injecté pour les tests. */
  policy?: () => RestartPolicy;
  /** Sauvegarde prise avant de basculer. */
  backup?: () => Promise<unknown>;
  /** Arrêt propre puis sortie, avec le code que le superviseur attend. */
  restart?: (exitCode: number) => void;
  log?: (message: string) => void;
  /** Horloge, remplacée par les tests. */
  now?: () => Date;
}

/* ------------------------------------------------------------------ */
/* Quand passer                                                        */
/* ------------------------------------------------------------------ */

/** Le jour local, `2026-08-19` — repère d'un « une fois par jour ». */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Est-ce le moment ?
 *
 * L'heure locale doit correspondre, et le passage ne doit pas déjà avoir eu
 * lieu aujourd'hui. Comparer le *jour* plutôt que compter les heures écoulées
 * rend le passage insensible aux redémarrages : un serveur relancé trois fois
 * dans la matinée ne refait pas trois fois le sien.
 */
export function shouldRunAt(now: Date, atHour: number, lastDay: string | null): boolean {
  if (!Number.isInteger(atHour) || atHour < 0 || atHour > 23) return false;
  if (now.getHours() !== atHour) return false;
  return lastDay !== localDay(now);
}

/* ------------------------------------------------------------------ */
/* Ce qu'on retient d'un passage à l'autre                              */
/* ------------------------------------------------------------------ */

interface AutoUpdateState {
  /** Dernier jour où un passage a eu lieu. */
  day: string;
  /** Version visée lors des dernières tentatives. */
  commit: string;
  /** Tentatives infructueuses sur cette version. */
  tries: number;
  at: string;
}

function stateFile(): string {
  return path.join(path.dirname(store.dbFile), STATE_FILE);
}

export function readUpdateState(): AutoUpdateState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<AutoUpdateState>;
    if (typeof parsed.day !== 'string') return null;
    return {
      day: parsed.day,
      commit: typeof parsed.commit === 'string' ? parsed.commit : '',
      tries: typeof parsed.tries === 'number' ? parsed.tries : 0,
      at: typeof parsed.at === 'string' ? parsed.at : '',
    };
  } catch {
    // Absent au premier lancement, illisible après un incident : dans les deux
    // cas on repart comme si rien n'avait jamais été tenté.
    return null;
  }
}

function writeUpdateState(state: AutoUpdateState): void {
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* Le passage lui-même                                                  */
/* ------------------------------------------------------------------ */

export async function updateNow(options: AutoUpdateOptions): Promise<AutoUpdateResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const policy = (options.policy ?? (() => 'no' as RestartPolicy))();
  const now = options.now ?? (() => new Date());

  // D'abord la question qui décide de tout : si rien ne relance ce serveur,
  // l'arrêter serait l'éteindre. On ne touche même pas à git.
  if (policy === 'no') {
    const message =
      'Mise à jour automatique inactive : rien ne relancerait ce serveur, il resterait éteint. ' +
      'Ajoutez « Restart=always » à la section [Service] de son unité systemd, ' +
      'puis « sudo systemctl daemon-reload ».';
    log(`[maj] ${message}`);
    return { outcome: 'sans-superviseur', message };
  }

  const check = await checkForUpdates(options.root);
  if (!check.supported) {
    const message = check.reason ?? 'Mise à jour automatique indisponible sur cette installation.';
    log(`[maj] ${message}`);
    return { outcome: 'non-supportee', message };
  }
  if (!check.available) {
    log('[maj] serveur déjà à jour.');
    return { outcome: 'a-jour', message: 'Le serveur est déjà à jour.', behind: 0 };
  }

  // Une version qui a déjà échoué plusieurs fois ne sera pas meilleure la
  // quatrième : on s'arrête, et on le dit assez fort pour être vu au journal.
  const target = check.remoteCommit ?? '';
  const previous = readUpdateState();
  const tries = previous && previous.commit === target ? previous.tries : 0;
  if (target && tries >= MAX_TRIES) {
    const message =
      `Mise à jour vers ${target.slice(0, 7)} abandonnée après ${tries} tentatives : ` +
      'elle échoue à chaque fois. Regardez le journal du service, puis mettez à jour à la main.';
    log(`[maj] ${message}`);
    return { outcome: 'abandonnee', message, behind: check.behind };
  }

  log(`[maj] ${check.behind} version(s) de retard — installation.`);

  // La copie qui compte le jour où une version se comporte mal est celle
  // d'avant. Elle ne coûte rien ici, et une sauvegarde ratée n'empêche pas la
  // mise à jour : c'est du code qu'on remplace, pas des données.
  try {
    await options.backup?.();
  } catch (err) {
    log(`[maj] sauvegarde préalable impossible : ${(err as Error).message ?? String(err)}`);
  }

  const applied = await applyUpdate(options.root, (step) => log(`[maj] ${step}`));
  if (!applied.success) {
    writeUpdateState({ day: localDay(now()), commit: target, tries: tries + 1, at: nowIso() });
    log(`[maj] ${applied.message}`);
    return { outcome: 'echec', message: applied.message, behind: check.behind };
  }

  // Réussite : le compteur de tentatives repart à zéro pour cette version.
  writeUpdateState({ day: localDay(now()), commit: target, tries: 0, at: nowIso() });

  store.flushSync();
  const message = `Mise à jour installée (${check.behind} version(s)). Redémarrage du serveur.`;
  log(`[maj] ${message}`);
  // `on-failure` ne relance pas une sortie propre : dans ce cas seulement, on
  // sort en erreur pour que le superviseur fasse son travail.
  options.restart?.(policy === 'always' ? 0 : 1);
  return { outcome: 'appliquee', message, behind: check.behind };
}

/**
 * Démarre les passages et renvoie de quoi les arrêter.
 *
 * Le réveil est fréquent (un quart d'heure) et la décision, elle, tient à
 * l'heure du jour : une machine mise en veille ou redémarrée ne rate pas son
 * passage pour avoir manqué un battement précis.
 */
export function startAutoUpdate(options: AutoUpdateOptions): () => void {
  const log = options.log ?? ((m: string) => console.log(m));
  const atHour = options.atHour ?? DEFAULT_HOUR;
  const now = options.now ?? (() => new Date());

  if (!Number.isInteger(atHour) || atHour < 0 || atHour > 23) {
    log('[maj] mise à jour automatique désactivée (COMPAGELATO_UPDATE_HOUR).');
    return () => {};
  }

  // Le jour du dernier passage est relu du disque : un serveur redémarré juste
  // après sa propre mise à jour ne doit pas en relancer une seconde.
  let lastDay = readUpdateState()?.day ?? null;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    const at = now();
    if (!shouldRunAt(at, atHour, lastDay)) return;
    running = true;
    lastDay = localDay(at);
    try {
      await updateNow(options);
    } catch (err) {
      // Une mise à jour ratée est un incident à signaler, jamais de quoi
      // arrêter le serveur : le passage de demain réessaiera.
      log(`[maj] échec : ${(err as Error).message ?? String(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 15 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Réglages lus dans l'environnement, pour le serveur du dépôt. */
export function autoUpdateHourFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COMPAGELATO_UPDATE_HOUR;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOUR;
  const hour = Number(raw);
  // Toute valeur hors 0–23 (dont `-1`, la façon documentée de dire « jamais »)
  // désactive le passage : `startAutoUpdate` le refusera et l'écrira au journal.
  return Number.isFinite(hour) ? Math.floor(hour) : DEFAULT_HOUR;
}
