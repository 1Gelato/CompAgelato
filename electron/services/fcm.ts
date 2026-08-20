import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Notifications natives des téléphones, par Firebase Cloud Messaging.
 *
 * C'est l'infrastructure d'Android : elle seule réveille une application
 * fermée, écran éteint. Le serveur s'y adresse **en direct**, sans relais —
 * ni service de push Expo, ni ntfy.
 *
 * Deux choses à savoir sur ce qui suit :
 *
 * - **Aucune dépendance ajoutée.** Google veut un jeton OAuth2 obtenu contre
 *   une assertion JWT signée RS256. `node:crypto` sait signer ; le reste est
 *   du base64url et un `fetch`. Le SDK `firebase-admin` apporterait une
 *   centaine de paquets pour ces quarante lignes — le projet n'en a pas voulu
 *   jusqu'ici, et ce n'est pas ici qu'il commencera.
 * - **Tout est injectable** (horloge, `fetch`) : la signature, le cache du
 *   jeton et le traitement des erreurs se vérifient hors ligne, sans jamais
 *   appeler Google.
 *
 * Sans clé de compte de service configurée, le module se déclare simplement
 * inactif : le serveur démarre et fonctionne, sans notifications.
 */

/** Portée demandée : l'envoi de messages, rien d'autre. */
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Un jeton Google vit une heure ; on le renouvelle cinq minutes avant. */
const TOKEN_TTL_SECONDS = 3600;
const RENEW_MARGIN_SECONDS = 300;

const REQUEST_TIMEOUT_MS = 10000;

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  /** Clé privée PEM, telle que Firebase la livre. */
  privateKey: string;
  tokenUri: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Données transportées, lues au clic pour ouvrir le bon écran. */
  data?: Record<string, string>;
}

/**
 * `gone` : Firebase ne connaît plus cet appareil — application désinstallée,
 * données effacées. C'est une réponse normale, pas une panne : le jeton doit
 * être oublié, faute de quoi le registre se remplirait de fantômes.
 */
export type PushOutcome = 'sent' | 'gone' | 'failed';

export interface FcmDeps {
  fetch?: typeof globalThis.fetch;
  /** Horloge en secondes depuis l'époque. */
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */

let account: ServiceAccount | null = null;
let cachedToken: { value: string; expiresAt: number } | null = null;

export function configureFcm(next: ServiceAccount | null): void {
  account = next;
  // Changer de compte invalide le jeton : il porte l'identité du précédent.
  cachedToken = null;
}

export function fcmEnabled(): boolean {
  return account !== null;
}

export function fcmProjectId(): string | null {
  return account?.projectId ?? null;
}

/**
 * Lit la clé de compte de service téléchargée depuis Firebase.
 *
 * Renvoie `null` — jamais une exception — quand le fichier manque ou ne
 * ressemble pas à une clé : une notification qu'on ne peut pas envoyer ne doit
 * pas empêcher le serveur de démarrer.
 */
export function readServiceAccount(file?: string): ServiceAccount | null {
  if (!file?.trim()) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    if (!raw.project_id || !raw.client_email || !raw.private_key) return null;
    return {
      projectId: raw.project_id,
      clientEmail: raw.client_email,
      privateKey: raw.private_key,
      tokenUri: raw.token_uri || 'https://oauth2.googleapis.com/token',
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Jeton d'accès                                                        */
/* ------------------------------------------------------------------ */

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * L'assertion JWT présentée à Google pour obtenir un jeton d'accès.
 *
 * Fonction pure : c'est ce qui permet de la vérifier dans les tests avec une
 * paire de clés fabriquée sur place, sans rien envoyer.
 */
export function signAssertion(sa: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.clientEmail,
      scope: SCOPE,
      aud: sa.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_TTL_SECONDS,
    }),
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(sa.privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** Jeton d'accès, du cache tant qu'il est valable. */
export async function accessToken(deps: FcmDeps = {}): Promise<string | null> {
  if (!account) return null;
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - RENEW_MARGIN_SECONDS > now) {
    return cachedToken.value;
  }

  const call = deps.fetch ?? globalThis.fetch;
  const response = await call(account.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signAssertion(account, now),
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    console.error('[push] jeton refusé par Google', response.status, await safeText(response));
    return null;
  }
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) return null;
  cachedToken = {
    value: payload.access_token,
    expiresAt: now + (payload.expires_in ?? TOKEN_TTL_SECONDS),
  };
  return cachedToken.value;
}

async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Envoi                                                                */
/* ------------------------------------------------------------------ */

/**
 * Pousse une notification vers un appareil.
 *
 * Ne lève jamais : prévenir un téléphone est un service rendu, jamais une
 * condition de l'enregistrement qui l'a déclenché.
 */
export async function sendPush(
  deviceToken: string,
  payload: PushPayload,
  deps: FcmDeps = {},
): Promise<PushOutcome> {
  if (!account || !deviceToken) return 'failed';
  try {
    const bearer = await accessToken(deps);
    if (!bearer) return 'failed';

    const call = deps.fetch ?? globalThis.fetch;
    const response = await call(
      `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: payload.title, body: payload.body },
            data: payload.data ?? {},
            android: {
              priority: 'high',
              notification: {
                // Doit correspondre au canal déclaré par l'application, sans
                // quoi Android range la notification en importance minimale.
                channel_id: 'compagelato',
                sound: 'default',
              },
            },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (response.ok) return 'sent';

    const detail = await safeText(response);
    // 404 (NOT_FOUND) et UNREGISTERED désignent tous deux un appareil disparu.
    // 400 sur un jeton malformé ne se réparera pas non plus : dans les deux
    // cas, insister à chaque annonce ne ferait qu'user le registre.
    if (response.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(detail)) {
      return 'gone';
    }
    console.error('[push] envoi refusé', response.status, detail);
    return 'failed';
  } catch (err) {
    console.error('[push] envoi impossible', (err as Error).message ?? String(err));
    return 'failed';
  }
}

/** Réglage lu dans l'environnement, pour le serveur du dépôt. */
export function fcmFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceAccount | null {
  return readServiceAccount(env.COMPAGELATO_FCM_KEY_FILE);
}
