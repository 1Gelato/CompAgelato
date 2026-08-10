import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FSWatcher } from 'chokidar';
import { alreadySent, forgetVanished, listFolders, markSent, type UploadFolder } from '../folders';
import { RemoteError, uploadFile } from '../remote';
import { DOC_EXTENSIONS } from './documents';
import { STATEMENT_EXTENSIONS } from './bank';

/**
 * Le pont entre les dossiers du poste et le serveur.
 *
 * En mode branché, c'est le serveur qui surveille *son* dossier : celui du
 * poste, où le logiciel de comptabilité dépose réellement ses PDF, n'intéresse
 * personne. Il fallait donc ouvrir l'application et désigner les fichiers un à
 * un — le geste répétitif que ce module supprime.
 *
 * Trois principes :
 *
 * - **Ne jamais perdre un fichier.** Un envoi n'est marqué comme fait qu'une
 *   fois le serveur d'accord. Coupure de réseau, serveur éteint, session
 *   expirée : le fichier reste à envoyer et repartira au passage suivant.
 * - **Ne jamais boucler.** Ce qui est parti est retenu (taille et date). Le
 *   serveur compare de toute façon les contenus avant de ranger, si bien qu'un
 *   envoi en trop ne crée pas de doublon — le registre est une économie, pas
 *   une garantie.
 * - **Ne jamais toucher aux fichiers de l'utilisateur.** On lit, on envoie ;
 *   rien n'est déplacé, renommé ni supprimé. Le dossier de comptabilité reste
 *   exactement tel que son propriétaire l'a rangé.
 */

/** Regroupe les rafales : un export de comptabilité écrit dix fichiers d'affilée. */
const DEBOUNCE_MS = 1500;
/** Limite du serveur (UPLOAD_LIMIT) : au-delà, l'envoi ne peut pas aboutir. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/**
 * Balayage périodique, en plus de la surveillance. Il rattrape ce qui est
 * arrivé pendant que l'application était fermée, et surtout ce qui a échoué
 * faute de réseau — sans lui, un fichier déposé serveur éteint attendrait la
 * prochaine écriture dans le dossier pour être reconsidéré.
 */
const SWEEP_MS = 10 * 60_000;

export interface UploadResult {
  sent: number;
  failed: { file: string; error: string }[];
  /** Vrai quand l'échec vient du réseau : rien ne sert d'insister maintenant. */
  offline: boolean;
}

function accepts(kind: UploadFolder['kind'], file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return kind === 'statement' ? STATEMENT_EXTENSIONS.has(ext) : DOC_EXTENSIONS.has(ext);
}

/**
 * Les fichiers d'un dossier qui n'ont pas encore été envoyés.
 *
 * Un fichier encore en cours d'écriture est écarté : un PDF que la comptabilité
 * est en train de produire serait envoyé tronqué, et son empreinte le ferait
 * passer pour envoyé. On exige donc qu'il n'ait pas bougé depuis deux secondes.
 */
export async function pendingFiles(folder: UploadFolder, now = Date.now()): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      // Fichiers temporaires d'Office et fichiers cachés : jamais des pièces.
      if (entry.name.startsWith('~$') || entry.name.startsWith('.')) continue;
      if (!accepts(folder.kind, entry.name)) continue;
      try {
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs < 2000) continue;
        if (alreadySent(full, stat.size, stat.mtimeMs)) continue;
        out.push(full);
      } catch {
        continue;
      }
    }
  };

  await walk(folder.path, 0);
  return out.sort();
}

/**
 * Envoie tout ce qui attend. S'arrête à la première coupure réseau : insister
 * n'aurait aucune chance d'aboutir et ferait patienter l'utilisateur pour rien.
 */
export async function uploadPending(
  log: (message: string) => void = () => {},
): Promise<UploadResult> {
  const result: UploadResult = { sent: 0, failed: [], offline: false };

  for (const folder of listFolders()) {
    if (result.offline) break;
    let files: string[];
    try {
      files = await pendingFiles(folder);
    } catch (err) {
      log(`[dossiers] ${folder.path} illisible : ${(err as Error).message ?? String(err)}`);
      continue;
    }

    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      // Le serveur refuse au-delà de 200 Mo en détruisant la connexion, ce que
      // le poste prenait pour une coupure réseau : la file entière restait
      // bloquée derrière le gros fichier, à chaque passage. Une limite est un
      // état permanent — on le dit et on marque, pour que la file avance.
      if (stat.size > MAX_UPLOAD_BYTES) {
        result.failed.push({
          file,
          error: 'Fichier de plus de 200 Mo — trop volumineux pour l’envoi au serveur.',
        });
        markSent(file, stat.size, stat.mtimeMs);
        log(`[dossiers] trop volumineux, ignoré : ${path.basename(file)}`);
        continue;
      }
      try {
        await uploadFile(
          folder.kind === 'statement' ? 'bank' : 'documents',
          file,
          folder.kind === 'statement' ? undefined : folder.kind,
        );
        // Marqué **après** l'accord du serveur : un fichier dont l'envoi a
        // échoué doit repartir, pas être oublié.
        markSent(file, stat.size, stat.mtimeMs);
        result.sent++;
        log(`[dossiers] envoyé : ${path.basename(file)}`);
      } catch (err) {
        // Coupure réseau OU connexion exigée (session expirée, premier compte
        // créé) : deux états transitoires. Marquer « envoyé » sur un 401 —
        // l'ancien comportement — condamnait le fichier : il ne repartait
        // jamais, même une fois la session rétablie.
        if (err instanceof RemoteError && (err.network || err.authRequired)) {
          result.offline = true;
          log(
            err instanceof RemoteError && err.authRequired
              ? '[dossiers] connexion requise : le reste partira une fois la session rétablie.'
              : '[dossiers] serveur injoignable : le reste partira plus tard.',
          );
          break;
        }
        // Refus métier (fichier illisible, droit manquant) : il est signalé et
        // marqué, sinon il serait représenté à chaque passage sans jamais passer.
        result.failed.push({ file, error: (err as Error).message ?? String(err) });
        markSent(file, stat.size, stat.mtimeMs);
        log(`[dossiers] refusé : ${path.basename(file)} — ${(err as Error).message}`);
      }
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Surveillance                                                         */
/* ------------------------------------------------------------------ */

class UploadWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private notify: (result: UploadResult) => void = () => {};
  private log: (message: string) => void = (m) => console.log(m);

  setListener(fn: (result: UploadResult) => void): void {
    this.notify = fn;
  }

  setLogger(fn: (message: string) => void): void {
    this.log = fn;
  }

  /** (Re)démarre la surveillance sur la liste courante. */
  async start(): Promise<void> {
    await this.stop();
    const folders = listFolders();
    if (!folders.length) return;

    const chokidar = await import('chokidar');
    this.watcher = chokidar.watch(
      folders.map((f) => f.path),
      {
        ignoreInitial: true,
        depth: 5,
        // Un PDF de plusieurs mégaoctets met un instant à s'écrire : on attend
        // qu'il se stabilise plutôt que d'en envoyer une moitié.
        awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 150 },
        ignored: (p: string) => /[/\\]~\$/.test(p),
      },
    );
    const onChange = () => this.schedule();
    this.watcher.on('add', onChange).on('change', onChange);
    this.watcher.on('error', (err) => this.log(`[dossiers] surveillance : ${String(err)}`));

    this.sweep = setInterval(() => this.schedule(), SWEEP_MS);
    this.sweep.unref?.();

    // Un premier passage tout de suite : l'application vient peut-être de
    // s'ouvrir sur des fichiers déposés pendant qu'elle était fermée.
    this.schedule(0);
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      const result = await uploadPending(this.log);
      if (result.sent || result.failed.length) this.notify(result);
      // Le registre ne doit pas gonfler indéfiniment ni retenir des fichiers
      // effacés : un document remis en place doit pouvoir repartir.
      forgetVanished();
    } catch (err) {
      this.log(`[dossiers] envoi : ${(err as Error).message ?? String(err)}`);
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }

  /** Passage immédiat, déclenché par l'utilisateur. */
  async now(): Promise<UploadResult> {
    const result = await uploadPending(this.log);
    forgetVanished();
    return result;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

export const uploadWatcher = new UploadWatcher();
