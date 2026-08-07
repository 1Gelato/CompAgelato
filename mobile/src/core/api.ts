import { CHANNELS } from '@shared/api';

/**
 * L'accès au serveur CompaGelato depuis le téléphone.
 *
 * Même contrat que le bureau et le navigateur : chaque canal déclaré dans
 * `CHANNELS` devient `POST /api/<domaine>/<méthode>`, la session s'annonce par
 * l'en-tête `x-auth-token`. Ce module ne connaît ni React Native ni Expo —
 * uniquement `fetch` — pour être exercé tel quel par la suite de tests Node,
 * contre un vrai serveur, comme le reste du projet.
 */

/**
 * `network` distingue la coupure (serveur injoignable, délai dépassé) du refus
 * métier. La distinction porte tout le mode hors-ligne : seule une coupure
 * bascule sur le miroir ou met en file — rejouer un refus ne servirait à rien.
 */
export class ApiError extends Error {
  network = false;
  /** Session absente ou révoquée : l'écran de connexion doit revenir. */
  authRequired = false;
}

function networkError(message: string): ApiError {
  const error = new ApiError(message);
  error.network = true;
  return error;
}

export interface ApiConfig {
  /** `http://100.100.53.66:4680` — sans barre finale. */
  baseUrl: string;
  /** Jeton de session (connexion d'appareil, 180 jours). */
  token: string;
}

let config: ApiConfig = { baseUrl: '', token: '' };
let onAuthRequired: () => void = () => {};

export function configureApi(next: Partial<ApiConfig>): void {
  config = { ...config, ...next };
}

export function apiConfig(): ApiConfig {
  return config;
}

/** Prévient l'application quand le serveur exige une (re)connexion. */
export function setAuthRequiredHandler(handler: () => void): void {
  onAuthRequired = handler;
}

/** Normalise une adresse saisie : protocole implicite, pas de barre finale. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    throw new Error(`Adresse de serveur illisible : ${raw}`);
  }
}

/** Adresse d'un fichier servi par le serveur, jeton compris (liens directs). */
export function fileUrl(route: string): string {
  const sep = route.includes('?') ? '&' : '?';
  return `${config.baseUrl}${route}${sep}token=${encodeURIComponent(config.token)}`;
}

/** Au-delà, le serveur est considéré injoignable — l'écran ne doit pas pendre. */
const CALL_TIMEOUT_MS = 12_000;

/** Appelle un gestionnaire sur le serveur et renvoie son résultat. */
export async function serverCall(
  namespace: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!config.baseUrl) throw networkError('Aucun serveur configuré.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/api/${namespace}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { 'x-auth-token': config.token } : {}),
      },
      body: JSON.stringify({ args }),
      signal: controller.signal,
    });
  } catch (err) {
    throw networkError(
      (err as Error).name === 'AbortError'
        ? 'Le serveur n’a pas répondu à temps.'
        : `Serveur injoignable : ${(err as Error).message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: { ok?: boolean; result?: unknown; error?: string; authRequired?: boolean };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new ApiError(`Le serveur a répondu ${response.status} sans détail.`);
  }
  if (!response.ok || !payload.ok) {
    const error = new ApiError(payload.error ?? `Erreur ${response.status}.`);
    if (payload.authRequired) {
      error.authRequired = true;
      onAuthRequired();
    }
    throw error;
  }
  return payload.result;
}

/** Tous les canaux du contrat, bâtis sur un appel injecté (serveur ou hors-ligne). */
export function buildApi<T>(
  invoke: (namespace: string, method: string, args: unknown[]) => Promise<unknown>,
): T {
  const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const [namespace, methods] of Object.entries(CHANNELS)) {
    api[namespace] = {};
    for (const method of methods as readonly string[]) {
      api[namespace][method] = (...args: unknown[]) => invoke(namespace, method, args);
    }
  }
  return api as T;
}
