import fs from 'node:fs';
import path from 'node:path';
import type { AuthIdentity, AuthStatus, Connection, DataMode } from '@shared/api';

/**
 * Liaison de cet appareil au serveur CompaGelato.
 *
 * Ce réglage ne peut pas vivre dans la base : en mode branché, la base *vient*
 * du serveur, et une adresse de serveur qui se synchronise entre les postes
 * enverrait chaque machine chez sa voisine. Il vit donc dans un petit fichier à
 * côté de la base locale, propre à l'appareil — comme le prévoit le plan pour
 * tout ce qui appartient à la machine et non à l'entreprise.
 *
 * Adresse vide = mode local : l'application travaille sur sa propre base, comme
 * avant. C'est le comportement par défaut, et celui de repli.
 */

export interface ConnectionConfig {
  serverUrl: string;
  token: string;
}

const EMPTY: ConnectionConfig = { serverUrl: '', token: '' };

let file = '';
let current: ConnectionConfig = { ...EMPTY };

/** Normalise l'adresse saisie : protocole implicite, pas de barre finale. */
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

/**
 * Nettoie un jeton saisi ou collé.
 *
 * Deux accidents reviennent sans cesse. Coller `COMPAGELATO_TOKEN="secret"`
 * emmène les guillemets avec la valeur ; et un jeton passé par un traitement de
 * texte revient avec des guillemets **typographiques**, dont le code dépasse
 * 255. Or un jeton voyage dans un en-tête HTTP, qui n'accepte que du Latin-1 :
 * le navigateur refuse alors d'émettre la requête, et l'application traduisait
 * ce refus par « Le serveur ne répond pas » — accusant une machine en parfait
 * état pendant qu'on cherchait la panne ailleurs.
 */
const SURROUNDING_QUOTES = /^["'«»“”„‟‘’]+|["'«»“”„‟‘’]+$/g;

export function cleanToken(raw: string): string {
  return (raw ?? '').trim().replace(SURROUNDING_QUOTES, '').trim();
}

/** Le jeton peut-il tenir dans un en-tête HTTP ? Sinon, on dit pourquoi. */
export function assertTokenUsable(token: string): void {
  for (let index = 0; index < token.length; index++) {
    const code = token.charCodeAt(index);
    if (code > 255) {
      throw new Error(
        `Le jeton contient un caractère qui ne peut pas voyager dans une requête ` +
          `(« ${token[index]} », position ${index + 1}). C'est presque toujours un ` +
          `guillemet ou un tiret « embelli » par un traitement de texte : retapez-le ` +
          `à la main, sans guillemets autour.`,
      );
    }
  }
}

/**
 * Charge la liaison enregistrée. Les variables d'environnement l'emportent :
 * elles servent aux tests et à un poste configuré par script.
 */
export function initConnection(dataDir: string): ConnectionConfig {
  file = path.join(dataDir, 'connexion.json');

  let stored: Partial<ConnectionConfig> = {};
  try {
    if (fs.existsSync(file)) stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Un fichier illisible ne doit pas empêcher l'application de démarrer :
    // on repart en local, ce qui est toujours sûr.
    console.error('[connexion] fichier illisible, retour au mode local :', err);
  }

  const envUrl = process.env.COMPAGELATO_SERVER_URL;
  const envToken = process.env.COMPAGELATO_SERVER_TOKEN;

  current = {
    serverUrl: normalizeServerUrl(envUrl ?? stored.serverUrl ?? ''),
    // Nettoyage au chargement aussi : un jeton déjà enregistré avec ses
    // guillemets doit se réparer tout seul, sans que personne ait à comprendre
    // pourquoi le serveur « ne répond pas ».
    token: cleanToken(envToken ?? stored.token ?? ''),
  };
  return current;
}

export function connectionConfig(): ConnectionConfig {
  return current;
}

/**
 * Serveur injoignable et utilisateur qui choisit de continuer : on repasse en
 * local **pour cette session seulement**. Le fichier n'est pas touché, si bien
 * que le prochain démarrage retentera le serveur.
 */
export function useLocalForThisRun(): void {
  current = { ...current, serverUrl: '' };
}

export function isRemote(): boolean {
  return Boolean(current.serverUrl);
}

export function currentMode(): DataMode {
  return isRemote() ? 'remote' : 'local';
}

/** Enregistre la liaison. Prend effet au redémarrage de l'application. */
export function saveConnection(input: { serverUrl: string; token?: string }): ConnectionConfig {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const next: ConnectionConfig = {
    serverUrl,
    // Adresse effacée : le jeton n'a plus de raison d'être conservé.
    // Jeton absent alors que l'adresse reste : on garde celui déjà enregistré,
    // pour que l'interface n'ait jamais besoin de le réafficher.
    token: serverUrl ? cleanToken(input.token ?? current.token) : '',
  };
  // Refusé à l'enregistrement plutôt qu'au premier appel : le message arrive
  // pendant qu'on a le jeton sous les yeux, et non trois écrans plus loin sous
  // la forme d'un serveur prétendument injoignable.
  assertTokenUsable(next.token);
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  current = next;
  return next;
}

export interface PingResult {
  /** Le serveur répond-il ? Indépendant de la question « suis-je connecté ». */
  ok: boolean;
  error?: string;
  /** Le serveur exige-t-il un compte ? */
  authRequired?: boolean;
  /** La session enregistrée sur ce poste est-elle valable ? */
  authenticated?: boolean;
  identity?: AuthIdentity | null;
}

/**
 * Le serveur répond-il, et où en est-on de la connexion ?
 *
 * On interroge `auth:status`, qui répond **sans session** : c'est le seul moyen
 * de distinguer « serveur éteint » de « il faut se connecter ». Confondre les
 * deux enverrait l'utilisateur vérifier son réseau alors qu'il lui manque
 * seulement un mot de passe.
 */
export async function pingServer(
  config: ConnectionConfig = current,
  timeoutMs = 4000,
): Promise<PingResult> {
  if (!config.serverUrl) return { ok: false, error: 'Aucune adresse de serveur.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.serverUrl}/api/auth/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { 'x-auth-token': config.token } : {}),
      },
      body: JSON.stringify({ args: [] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `Le serveur a répondu ${response.status}.` };
    }
    const payload = (await response.json()) as { ok?: boolean; result?: AuthStatus };
    const status = payload.result;
    if (!status) return { ok: false, error: 'Réponse du serveur illisible.' };

    // `authorized` couvre les deux régimes : session ouverte, ou jeton partagé
    // correct. Un jeton faux se distingue donc d'un mot de passe manquant.
    return {
      ok: true,
      authRequired: status.required,
      authenticated: status.authorized,
      identity: status.identity,
      error: status.authorized
        ? undefined
        : status.required
          ? 'Connexion à un compte requise.'
          : 'Jeton d’accès refusé par le serveur.',
    };
  } catch (err) {
    const message = (err as Error).name === 'AbortError'
      ? 'Le serveur n’a pas répondu à temps.'
      : ((err as Error).message ?? String(err));
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Vue destinée à l'interface : l'adresse et l'état, jamais le jeton. */
export function describeConnection(ping?: PingResult): Connection {
  return {
    serverUrl: current.serverUrl,
    hasToken: Boolean(current.token),
    mode: currentMode(),
    reachable: ping?.ok,
    error: ping?.error,
    authRequired: ping?.authRequired,
    authenticated: ping?.authenticated,
    identity: ping?.identity ?? null,
  };
}
