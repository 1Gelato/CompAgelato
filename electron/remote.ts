import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHANNELS } from '@shared/api';
import type { Registry } from './handlers';
import { connectionConfig } from './connection';

/**
 * L'application de bureau branchée sur un serveur.
 *
 * Le proxy vit ici, dans le processus principal, et non dans l'interface. Ce
 * choix évite trois ennuis d'un coup : aucune requête d'origine croisée à
 * autoriser côté serveur, le jeton d'accès ne descend jamais dans la page, et
 * l'interface continue de parler à l'IPC exactement comme avant — les 94 appels
 * à `window.api` restent inchangés.
 *
 * Chaque canal métier devient `POST /api/<domaine>/<méthode>`. Les gestes qui
 * touchent au poste (imprimer, ouvrir, choisir un fichier) restent locaux : ils
 * sont réintroduits par-dessus dans `ipc.ts`, en téléchargeant d'abord le
 * fichier depuis le serveur.
 */

/**
 * Erreur venue du serveur : le message est celui que l'interface affichera.
 * `network` distingue la coupure (serveur injoignable, délai dépassé) du refus
 * métier : seule la première autorise le passage en mode hors-ligne — mettre en
 * file une intention que le serveur vient de refuser la rejouerait pour rien.
 */
export class RemoteError extends Error {
  network = false;
  /**
   * Le serveur exige une connexion : session expirée, révoquée, ou premier
   * compte venant d'être créé — le jeton partagé cesse alors de suffire.
   * L'appelant doit RÉESSAYER plus tard, jamais classer l'appel comme un refus
   * définitif : c'est ce classement qui faisait marquer « envoyés » des
   * fichiers jamais acceptés, perdus sans bruit.
   */
  authRequired = false;
}

/**
 * Prévient l'application qu'il faut réafficher l'écran de connexion.
 *
 * Le navigateur lit ce cas directement dans la réponse HTTP. Le bureau, lui,
 * passe par l'IPC, qui ne transporte qu'un message d'erreur : sans ce signal,
 * l'utilisateur ne verrait qu'un « Connexion requise » en rouge, sans jamais se
 * voir proposer de se connecter.
 */
let onSessionLost: () => void = () => {};

export function setSessionLostListener(fn: () => void): void {
  onSessionLost = fn;
}

function networkError(message: string): RemoteError {
  const error = new RemoteError(message);
  error.network = true;
  return error;
}

/** Au-delà, on considère le serveur injoignable plutôt que de laisser l'interface pendre. */
const CALL_TIMEOUT_MS = 10_000;

function authHeaders(): Record<string, string> {
  const { token } = connectionConfig();
  return token ? { 'x-auth-token': token } : {};
}

function base(): string {
  const { serverUrl } = connectionConfig();
  if (!serverUrl) throw new RemoteError('Aucun serveur configuré.');
  return serverUrl;
}

/** Appelle un gestionnaire sur le serveur et renvoie son résultat. */
export async function remoteCall(
  namespace: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base()}/api/${namespace}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ args }),
      signal: controller.signal,
    });
  } catch (err) {
    throw networkError(
      (err as Error).name === 'AbortError'
        ? `Le serveur (${base()}) n'a pas répondu à temps.`
        : `Serveur injoignable (${base()}) : ${(err as Error).message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: { ok?: boolean; result?: unknown; error?: string; authRequired?: boolean };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new RemoteError(`Le serveur a répondu ${response.status} sans détail.`);
  }
  if (!response.ok || !payload.ok) {
    const error = new RemoteError(payload.error ?? `Erreur ${response.status}.`);
    if (payload.authRequired) {
      error.authRequired = true;
      onSessionLost();
    }
    throw error;
  }
  return payload.result;
}

/* ------------------------------------------------------------------ */
/* Fichiers                                                            */
/* ------------------------------------------------------------------ */

/** Dossier de travail local : copies temporaires des fichiers du serveur. */
export function cacheFolder(): string {
  const folder = path.join(os.tmpdir(), 'CompaGelato-serveur');
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function safeName(name: string): string {
  return (name || 'fichier').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

/**
 * Rapatrie un fichier du serveur pour qu'un geste du poste puisse s'en servir
 * (l'ouvrir dans le lecteur PDF, l'imprimer, le joindre à un e-mail).
 */
export async function downloadToCache(route: string, fileName: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${base()}${route}`, { headers: authHeaders() });
  } catch (err) {
    throw networkError(`Serveur injoignable : ${(err as Error).message ?? String(err)}`);
  }
  if (!response.ok) {
    // Le serveur explique lui-même les cas courants (fichier déplacé, inconnu).
    let detail = `Erreur ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) detail = payload.error;
    } catch {
      /* réponse non JSON : on garde le code */
    }
    throw new RemoteError(detail);
  }
  const target = path.join(cacheFolder(), safeName(fileName));
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return target;
}

/** Envoie un fichier du poste au serveur (import de liste, pièce jointe…). */
export async function uploadFile(
  kind: string,
  filePath: string,
  /**
   * Type de pièce, quand l'appelant le connaît déjà : le fichier vient d'un
   * dossier que l'utilisateur avait rangé « Factures ». Le serveur le classe
   * alors sans redeviner, et le tri fait sur le poste survit au voyage.
   */
  documentKind?: string,
): Promise<unknown> {
  if (!fs.existsSync(filePath)) throw new RemoteError('Fichier introuvable sur ce poste.');
  let response: Response;
  try {
    response = await fetch(`${base()}/upload/${kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(path.basename(filePath)),
        ...(documentKind ? { 'X-File-Kind': documentKind } : {}),
        ...authHeaders(),
      },
      body: fs.readFileSync(filePath),
    });
  } catch (err) {
    throw networkError(`Serveur injoignable : ${(err as Error).message ?? String(err)}`);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
    authRequired?: boolean;
  };
  if (!response.ok || !payload.ok) {
    const error = new RemoteError(payload.error ?? `Erreur ${response.status}.`);
    error.authRequired = response.status === 401 || payload.authRequired === true;
    throw error;
  }
  return payload.result;
}

/* ------------------------------------------------------------------ */
/* Flux d'événements                                                   */
/* ------------------------------------------------------------------ */

/**
 * S'abonne au flux d'événements du serveur et rejoue chaque message dans la
 * fenêtre. En cas de coupure, la connexion est retentée avec un délai qui
 * s'allonge, sans jamais abandonner : le serveur peut redémarrer.
 */
export function subscribeEvents(
  notify: (channel: string, payload: unknown) => void,
  hooks: { onOpen?: () => void } = {},
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const response = await fetch(`${base()}/api/events`, {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Erreur ${response.status}.`);
        attempt = 0;
        // Le flux est ouvert : le serveur est là. C'est le signal de reprise
        // qu'attend la file d'attente hors-ligne.
        hooks.onOpen?.();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Les trames SSE sont séparées par une ligne vide.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const { channel, payload } = JSON.parse(line.slice(5).trim()) as {
                  channel: string;
                  payload: unknown;
                };
                notify(channel, payload);
              } catch {
                /* trame illisible : ignorée */
              }
            }
          }
        }
      } catch {
        /* coupure : on retente plus bas */
      }
      if (stopped) return;
      // 1 s, 2 s, 4 s… plafonnées à 30 s.
      const delay = Math.min(1000 * 2 ** attempt++, 30_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };

  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

/* ------------------------------------------------------------------ */
/* Registre                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tous les canaux déclarés, renvoyés au serveur. `ipc.ts` recouvre ensuite ceux
 * qui doivent rester sur le poste.
 */
export function createRemoteRegistry(): Registry {
  const registry: Registry = {};
  for (const [namespace, methods] of Object.entries(CHANNELS)) {
    registry[namespace] = {};
    for (const method of methods as readonly string[]) {
      registry[namespace][method] = (...args: unknown[]) => remoteCall(namespace, method, args);
    }
  }
  return registry;
}
