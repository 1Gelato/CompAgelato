import fs from 'node:fs';
import path from 'node:path';
import { connectionConfig } from '../connection';
import { rotateFolder } from './autoBackup';

/**
 * La copie de sécurité d'un poste branché sur le serveur.
 *
 * Le miroir hors-ligne (`offline.ts`) garde déjà de quoi *travailler* sans le
 * serveur, mais ce n'en est pas une sauvegarde : il est filtré par le rôle de
 * l'utilisateur, rangé dans un format interne, et rien ne permettrait de le
 * restaurer. Si le disque du serveur lâchait, les postes continueraient
 * d'afficher les données sans qu'on puisse les remettre en place nulle part.
 *
 * Ce module comble exactement ce trou : à intervalle régulier, le poste
 * rapatrie la base entière du serveur et la dépose chez lui, sous un nom que
 * Réglages → Données sait restaurer. Les données existent alors sur deux
 * machines sans que personne ait eu à y penser.
 */

const DEFAULT_HOURS = 24;
const DEFAULT_KEEP = 14;
/** La base peut peser quelques mégaoctets, et le wifi du dépôt n'est pas rapide. */
const FETCH_TIMEOUT_MS = 60_000;
/**
 * Le premier passage attend : quand des comptes existent, l'utilisateur vient
 * d'ouvrir l'application et n'a pas encore saisi son mot de passe. Réclamer la
 * base à cet instant ne récolterait qu'un refus.
 */
const FIRST_DELAY_MS = 2 * 60_000;

export interface ServerBackupOptions {
  /** Dossier où déposer les copies. */
  dir: string;
  everyHours?: number;
  keep?: number;
  firstDelayMs?: number;
  log?: (message: string) => void;
}

/**
 * Un refus d'accès, une page d'interface, un proxy bavard : tout cela arrive
 * avec un corps parfaitement lisible. Sans ce contrôle, on l'écrirait sous le
 * nom d'une sauvegarde, et la rotation finirait par chasser les vraies.
 */
export function looksLikeDatabase(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return false;
    return (
      Array.isArray(parsed.clients) || Array.isArray(parsed.documents) || Boolean(parsed.settings)
    );
  } catch {
    return false;
  }
}

function newestCopy(dir: string): string | null {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
      .sort();
    const last = files.pop();
    return last ? path.join(dir, last) : null;
  } catch {
    return null;
  }
}

/**
 * Rapatrie la base du serveur. Renvoie le fichier écrit, ou `null` quand la
 * copie détenue est déjà la bonne — une base qui n'a pas bougé ne doit pas
 * consommer une place dans l'historique du poste.
 */
export async function pullServerBackup(options: ServerBackupOptions): Promise<string | null> {
  const { serverUrl, token } = connectionConfig();
  if (!serverUrl) return null;
  const keep = options.keep ?? DEFAULT_KEEP;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body: string;
  try {
    const response = await fetch(`${serverUrl}/files/backup`, {
      headers: token ? { 'x-auth-token': token } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`le serveur a répondu ${response.status}`);
    body = await response.text();
  } finally {
    clearTimeout(timer);
  }

  if (!looksLikeDatabase(body)) {
    throw new Error('la réponse du serveur n’est pas une base CompaGelato');
  }

  fs.mkdirSync(options.dir, { recursive: true });
  const previous = newestCopy(options.dir);
  if (previous) {
    try {
      if (fs.readFileSync(previous, 'utf8') === body) return null;
    } catch {
      /* copie précédente illisible : on en écrit une neuve, c'est le but */
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(options.dir, `backup-${stamp}.json`);
  // Fichier temporaire puis renommage, comme partout ailleurs : une écriture
  // interrompue ne laisse pas un fichier tronqué sous un nom rassurant.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, target);
  rotateFolder(options.dir, keep);
  return target;
}

/**
 * Démarre les passages et renvoie de quoi les arrêter.
 *
 * Un serveur éteint ou une session pas encore ouverte ne sont pas des incidents
 * ici : le poste réessaiera au passage suivant, et l'utilisateur est déjà
 * prévenu de l'état de la liaison par ailleurs. On l'écrit au journal, sans
 * déranger personne à l'écran.
 */
export function startServerBackup(options: ServerBackupOptions): () => void {
  const everyHours = options.everyHours ?? DEFAULT_HOURS;
  const log = options.log ?? ((message: string) => console.log(message));
  if (!(everyHours > 0)) return () => {};

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const file = await pullServerBackup(options);
      if (file) log(`[sauvegarde] copie du serveur : ${file}`);
    } catch (err) {
      log(`[sauvegarde] copie du serveur impossible : ${(err as Error).message ?? String(err)}`);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), options.firstDelayMs ?? FIRST_DELAY_MS);
  first.unref?.();
  const timer = setInterval(() => void tick(), everyHours * 3_600_000);
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** Dossier par défaut des copies du serveur, à côté de la base du poste. */
export function defaultServerBackupDir(dataDir: string): string {
  return path.join(dataDir, 'sauvegardes-serveur');
}

/** La copie la plus récente détenue par ce poste, pour l'afficher dans les réglages. */
export function lastServerBackup(dir: string): { at: string; file: string } | null {
  const file = newestCopy(dir);
  if (!file) return null;
  try {
    return { at: fs.statSync(file).mtime.toISOString(), file };
  } catch {
    return null;
  }
}
