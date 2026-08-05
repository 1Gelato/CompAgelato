import type { FSWatcher } from 'chokidar';
import type { BrowserWindow } from 'electron';
import { store } from './store';
import { ensureWatchFolder, scanFolder } from './services/documents';
import { scanStatementFolder, statementFolder } from './services/bank';

/**
 * Surveille le dossier de travail : tout fichier déposé est analysé
 * automatiquement, puis l'interface est prévenue. Le dossier des relevés
 * bancaires est surveillé en parallèle : il peut se trouver ailleurs sur le
 * disque, là où les relevés sont déjà rangés.
 */
class FolderWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private pending = false;
  private window: BrowserWindow | null = null;
  private current = '';

  attach(window: BrowserWindow): void {
    this.window = window;
  }

  async start(folder: string): Promise<void> {
    await this.stop();
    if (!store.settings.autoScan) return;

    const target = ensureWatchFolder(folder);
    this.current = target;

    // Le dossier des relevés n'est ajouté que s'il est hors du dossier
    // surveillé : sinon chokidar le couvre déjà.
    const targets = [target];
    try {
      const statements = statementFolder();
      if (!statements.toLowerCase().startsWith(target.toLowerCase())) targets.push(statements);
    } catch (err) {
      console.error('[watcher] dossier des relevés', err);
    }

    const chokidar = await import('chokidar');
    this.watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 900, pollInterval: 120 },
      ignored: (p: string) => /[/\\](Exports|\.git|node_modules)[/\\]?/i.test(p) || /[/\\]~\$/.test(p),
    });

    const onChange = () => this.schedule();
    this.watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    this.watcher.on('error', (err) => console.error('[watcher]', err));
  }

  /** Regroupe les rafales d'événements (copie de plusieurs fichiers d'un coup). */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, 1200);
  }

  private async run(): Promise<void> {
    if (this.scanning) {
      this.pending = true;
      return;
    }
    this.scanning = true;
    try {
      const report = await scanFolder();
      let bankImported = 0;
      try {
        const bank = await scanStatementFolder();
        bankImported = bank.imported;
      } catch (err) {
        console.error('[watcher] relevés', err);
      }
      if (report.imported || report.updated || report.failed || bankImported) {
        this.window?.webContents.send('documents-changed', { ...report, bankImported });
      }
    } catch (err) {
      console.error('[watcher] scan', err);
    } finally {
      this.scanning = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  get folder(): string {
    return this.current;
  }
}

export const folderWatcher = new FolderWatcher();
