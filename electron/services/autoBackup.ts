import fs from 'node:fs';
import path from 'node:path';
import { store, nowIso } from '../store';

/**
 * Sauvegardes automatiques.
 *
 * Une sauvegarde qu'il faut penser à déclencher n'en est pas une : le jour où
 * elle compte est justement celui où on a oublié d'appuyer. Ce module fait donc
 * le geste tout seul — au démarrage, puis à intervalle régulier — et sait le
 * faire suivre ailleurs que sur le disque qui détient la base.
 *
 * Trois principes gouvernent ce qui suit :
 *
 * - **Ne jamais réécrire une base inchangée.** Le nombre de sauvegardes gardées
 *   est borné ; en écrire une identique toutes les heures chasserait du dossier
 *   les versions anciennes — précisément celles qui servent quand une erreur est
 *   remarquée avec des jours de retard. La base porte déjà son compteur de
 *   modifications (`sync.maxRev`) : le comparer suffit, et ne coûte rien.
 * - **Une copie ailleurs ne bloque jamais.** Disque externe débranché, partage
 *   réseau éteint : c'est signalé au journal, et ni la sauvegarde locale ni le
 *   reste du programme n'en souffrent.
 * - **Un dossier de copie se rattrape.** Le disque absent mardi doit recevoir sa
 *   copie mercredi, sans attendre la prochaine modification de la base — sans
 *   quoi une semaine calme laisserait la copie distante indéfiniment en retard.
 */

/** Toutes les 24 h : assez fréquent pour ne rien perdre, assez rare pour garder de la profondeur. */
const DEFAULT_HOURS = 24;
/** Trente jours d'historique quand la base bouge tous les jours. */
const DEFAULT_KEEP = 30;

const STATE_FILE = 'sauvegarde-auto.json';

export interface AutoBackupOptions {
  /** Heures entre deux passages. `0` désactive complètement. */
  everyHours?: number;
  /** Sauvegardes conservées, ici comme dans les dossiers de copie. */
  keep?: number;
  /** Dossiers supplémentaires où recopier chaque sauvegarde. */
  copyTo?: string[];
  /** Journal ; remplacé par les tests. */
  log?: (message: string) => void;
}

export interface AutoBackupResult {
  /** Le fichier écrit, ou `null` si la base n'a pas bougé depuis la dernière fois. */
  file: string | null;
  /** Dossiers de copie servis pendant ce passage. */
  copied: string[];
  /** Dossiers de copie injoignables, avec leur raison. */
  failed: { dir: string; error: string }[];
}

/**
 * Ce qu'on retient d'un passage à l'autre. Volontairement rangé à côté de la
 * base, et non dans le dossier des sauvegardes : ce dernier est proposé tel quel
 * à la restauration, et un fichier d'état n'y aurait rien à faire.
 */
interface AutoBackupState {
  generation: string;
  maxRev: number;
  at: string;
  file: string;
}

function stateFile(): string {
  return path.join(path.dirname(store.dbFile), STATE_FILE);
}

function readState(): AutoBackupState | null {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AutoBackupState>;
    if (typeof parsed.maxRev !== 'number' || typeof parsed.file !== 'string') return null;
    return parsed as AutoBackupState;
  } catch {
    // Absent au premier lancement, illisible après un incident : dans les deux
    // cas la conduite à tenir est la même — sauvegarder.
    return null;
  }
}

function writeState(state: AutoBackupState): void {
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Ne garde que les `keep` sauvegardes les plus récentes d'un dossier.
 *
 * Le filtre sur `backup-` n'est pas cosmétique : ce dossier peut être choisi par
 * l'utilisateur — une clé USB, un partage réseau — et contenir tout autre chose.
 * On ne supprime que ce qu'on a écrit soi-même.
 */
export function rotateFolder(dir: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
    .sort();
  while (files.length > keep) {
    const victim = files.shift();
    if (victim) fs.unlinkSync(path.join(dir, victim));
  }
}

/**
 * Recopie une sauvegarde dans un dossier de destination. Renvoie `false` quand
 * la copie y était déjà — c'est le cas ordinaire des passages où rien n'a
 * changé, et il ne doit pas faire tourner l'historique de la destination.
 */
function copyInto(file: string, dir: string, keep: number): boolean {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(file));
  if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(file).size) return false;
  // Fichier temporaire puis renommage : une copie interrompue — câble débranché,
  // partage qui tombe — ne laisse pas une sauvegarde tronquée sous un nom qui
  // inspire confiance.
  const tmp = `${target}.tmp`;
  fs.copyFileSync(file, tmp);
  fs.renameSync(tmp, target);
  rotateFolder(dir, keep);
  return true;
}

/**
 * Un passage : sauvegarder si la base a bougé, puis s'assurer que chaque dossier
 * de copie détient bien la dernière sauvegarde.
 */
export async function backupNow(options: AutoBackupOptions = {}): Promise<AutoBackupResult> {
  const keep = options.keep ?? DEFAULT_KEEP;
  const log = options.log ?? ((message: string) => console.log(message));

  store.flushSync();
  const sync = store.db.sync;
  const generation = sync?.generation ?? '';
  const maxRev = sync?.maxRev ?? 0;

  const previous = readState();
  // `!==` plutôt que `>` : une restauration peut faire *reculer* le compteur, et
  // c'est un moment où l'on veut particulièrement une sauvegarde de ce qui est
  // en place juste avant.
  const changed = !previous || previous.generation !== generation || previous.maxRev !== maxRev;

  let file: string | null = null;
  if (changed) {
    file = await store.backup(keep);
    writeState({ generation, maxRev, at: nowIso(), file });
    log(`[sauvegarde] ${file}`);
  }

  const copied: string[] = [];
  const failed: { dir: string; error: string }[] = [];
  const latest = file ?? previous?.file ?? null;
  if (latest && fs.existsSync(latest)) {
    for (const dir of options.copyTo ?? []) {
      try {
        if (copyInto(latest, dir, keep)) {
          copied.push(dir);
          log(`[sauvegarde] copie vers ${dir}`);
        }
      } catch (err) {
        failed.push({ dir, error: (err as Error).message ?? String(err) });
      }
    }
  }

  return { file, copied, failed };
}

/**
 * Démarre les passages et renvoie de quoi les arrêter.
 *
 * Le premier a lieu tout de suite : un serveur qu'on redémarre après avoir
 * travaillé est exactement le moment où une sauvegarde manque, et le contrôle
 * des changements évite qu'un redémarrage en boucle n'en produise vingt.
 */
export function startAutoBackup(options: AutoBackupOptions = {}): () => void {
  const everyHours = options.everyHours ?? DEFAULT_HOURS;
  const log = options.log ?? ((message: string) => console.log(message));
  if (!(everyHours > 0)) {
    log('[sauvegarde] sauvegardes automatiques désactivées (COMPAGELATO_BACKUP_HOURS=0).');
    return () => {};
  }

  // Un passage lent — copie sur un partage réseau poussif — ne doit pas se
  // chevaucher avec le suivant.
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await backupNow(options);
      for (const { dir, error } of result.failed) {
        log(`[sauvegarde] copie impossible vers ${dir} : ${error}`);
      }
    } catch (err) {
      // Une sauvegarde ratée est un incident à signaler, jamais de quoi arrêter
      // le serveur : le prochain passage réessaiera.
      log(`[sauvegarde] échec : ${(err as Error).message ?? String(err)}`);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), everyHours * 3_600_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Découpe une liste de dossiers. `;` fonctionne sous Windows comme sous Linux. */
export function splitFolders(raw?: string): string[] {
  return (raw ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Réglages lus dans l'environnement, pour le serveur du dépôt. */
export function autoBackupOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AutoBackupOptions {
  const hours = Number(env.COMPAGELATO_BACKUP_HOURS);
  const keep = Number(env.COMPAGELATO_BACKUP_KEEP);
  return {
    everyHours: Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_HOURS,
    keep: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_KEEP,
    copyTo: splitFolders(env.COMPAGELATO_BACKUP_COPY),
  };
}

/** Dernière sauvegarde automatique connue, pour l'afficher dans les réglages. */
export function lastAutoBackup(): { at: string; file: string } | null {
  const state = readState();
  return state ? { at: state.at, file: state.file } : null;
}
