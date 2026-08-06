import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppInfo, EmailOutcome, PrintOutcome } from '@shared/api';
import { CHANNELS } from '@shared/api';
import type { EmailDraft, ID } from '@shared/types';
import { nowIso, store } from './store';
import { resolvePath } from './services/paths';
import { ensureWatchFolder } from './services/documents';
import { statementFolder } from './services/bank';
import { addAttachment, attachmentsFolder } from './services/attachments';
import { printFile } from './services/printing';
import { buildMailto, safeFileName } from './services/mail';
import {
  KIND_LABEL,
  buildDocumentEml,
  coreHandlers,
  isInside,
  markDocumentEmailed,
  mergeRegistries,
  projectRoot,
  requireDocument,
  send,
  setBroadcast,
  type Registry,
} from './handlers';

/**
 * Surcharges propres au bureau : tout ce qui ouvre une fenêtre, un dialogue ou
 * un programme sur le poste. Le reste — la logique métier — vit dans le
 * registre partagé (`handlers.ts`), le même que sert le serveur.
 */

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window;
  setBroadcast((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  });
}

const desktopHandlers: Registry = {
  app: {
    async info(): Promise<AppInfo> {
      return {
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
        userDataPath: app.getPath('userData'),
        watchFolder: store.settings.watchFolder,
        documentsPath: (() => {
          try {
            return app.getPath('documents');
          } catch {
            return app.getPath('home');
          }
        })(),
        isPackaged: app.isPackaged,
        // Sur Windows les chemins sont insensibles à la casse : « Documents\
        // CompaGelato » et le dossier cloné « documents\compagelato » peuvent
        // être le même endroit. Les documents se retrouvent alors mêlés au code.
        watchFolderInsideApp: isInside(store.settings.watchFolder, projectRoot),
      };
    },
    async openPath(target: string) {
      if (!target) return 'Chemin vide.';
      if (!fs.existsSync(target)) {
        // Le dossier de travail est recréé à la demande s'il a été supprimé.
        if (target === store.settings.watchFolder) ensureWatchFolder(target);
        else return "Ce chemin n'existe plus.";
      }
      return shell.openPath(target);
    },
    async openExternal(url: string) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Lien non autorisé.');
      await shell.openExternal(url);
    },
    async chooseFolder(current?: string) {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Choisir le dossier surveillé',
        defaultPath: current || store.settings.watchFolder,
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    async chooseFile(filters?: { name: string; extensions: string[] }[]) {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Choisir un fichier',
        defaultPath: store.settings.watchFolder,
        filters: filters ?? [
          { name: 'Tableaux et documents', extensions: ['csv', 'xlsx', 'xls', 'pdf', 'xml'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    async revealFile(target: string) {
      if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    },
    async quit() {
      store.flushSync();
      app.quit();
    },
    async relaunch() {
      store.flushSync();
      app.relaunch();
      app.exit(0);
    },
  },

  clients: {
    async pickAndImport() {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Importer la liste clients',
        defaultPath: path.join(store.settings.watchFolder, 'Clients'),
        filters: [
          { name: 'Fichiers clients', extensions: ['csv', 'xlsx', 'xls', 'txt'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      // La suite (import + écriture) est celle du registre partagé.
      return coreHandlers.clients.importFrom(result.filePaths[0]);
    },
  },

  documents: {
    async openFile(documentId: ID) {
      const doc = requireDocument(documentId);
      if (!doc.sourceFile) throw new Error("Ce document n'a pas de fichier d'origine (saisie manuelle).");
      const source = resolvePath(doc.sourceFile);
      if (!fs.existsSync(source)) {
        throw new Error(`Le fichier n'est plus à son emplacement :\n${source}`);
      }
      const error = await shell.openPath(source);
      if (error) throw new Error(error);
    },

    async print(documentId: ID): Promise<PrintOutcome> {
      const doc = requireDocument(documentId);
      if (!doc.sourceFile) throw new Error("Ce document n'a pas de fichier d'origine à imprimer.");
      const result = await printFile(resolvePath(doc.sourceFile));
      if (result.printed) {
        store.mutate(() => {
          doc.printedAt = nowIso();
          doc.updatedAt = nowIso();
        });
        store.flushSync();
      }
      return result;
    },

    async sendEmail(documentId: ID, draft: EmailDraft): Promise<EmailOutcome> {
      const doc = requireDocument(documentId);
      const built = buildDocumentEml(doc, draft);
      const attachmentMb = Math.round((built.attachmentBytes / (1024 * 1024)) * 100) / 100;

      try {
        const folder = path.join(app.getPath('temp'), 'CompaGelato');
        fs.mkdirSync(folder, { recursive: true });
        const file = path.join(
          folder,
          `${safeFileName(`${KIND_LABEL[doc.kind]} ${doc.number}`)}.eml`,
        );
        fs.writeFileSync(file, built.content, 'utf8');

        const error = await shell.openPath(file);
        if (error) throw new Error(error);

        markDocumentEmailed(doc);
        const missing = built.missing.length
          ? ` ${built.missing.length} pièce(s) jointe(s) introuvable(s) : ${built.missing.join(', ')}.`
          : '';
        return {
          sent: true,
          method: 'eml',
          attachmentMb,
          message: `Brouillon ouvert dans votre messagerie avec ${built.fileCount} pièce(s) jointe(s).${missing} Relisez-le puis envoyez-le.`,
        };
      } catch (err) {
        // Repli sans pièce jointe : au moins le message part.
        const mailto = buildMailto({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
        await shell.openExternal(mailto);
        markDocumentEmailed(doc);
        return {
          sent: true,
          method: 'mailto',
          attachmentMb: 0,
          message: `Votre messagerie n'a pas accepté le brouillon avec pièces jointes (${(err as Error).message}). Un message vide a été ouvert : ajoutez les fichiers à la main.`,
        };
      }
    },
  },

  attachments: {
    async pickAndAdd() {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Ajouter des pièces jointes (flyers, plaquettes…)',
        defaultPath: attachmentsFolder(),
        filters: [
          { name: 'Documents et images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'xlsx', 'pptx'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      const added = result.filePaths.map((file) => addAttachment(file));
      store.flushSync();
      return added;
    },
    async open(id: ID) {
      const attachment = store.db.attachments.find((a) => a.id === id);
      if (!attachment) throw new Error('Pièce jointe introuvable.');
      const file = resolvePath(attachment.filePath);
      if (!fs.existsSync(file)) throw new Error('Le fichier a été déplacé ou supprimé.');
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    },
    async openFolder() {
      await shell.openPath(attachmentsFolder());
    },
  },

  products: {
    async pickAndImport() {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Importer le stock de consommables',
        defaultPath: store.settings.watchFolder,
        filters: [
          { name: 'Fichiers stock', extensions: ['csv', 'xlsx', 'xls', 'txt'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      // Import + rattachement des lignes déjà importées : logique partagée.
      return coreHandlers.products.importFrom(result.filePaths[0]);
    },
  },

  bank: {
    async pickAndImport() {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Importer un relevé de compte',
        defaultPath: statementFolder(),
        filters: [
          { name: 'Relevés de compte', extensions: ['csv', 'xlsx', 'xls', 'xlsm'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return coreHandlers.bank.importFrom(result.filePaths[0]);
    },
    async openFolder() {
      await shell.openPath(statementFolder());
    },
    async chooseFolder() {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Choisir le dossier des relevés de compte',
        defaultPath: statementFolder(),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const folder = result.filePaths[0];
      store.mutate((db) => {
        db.settings.statementFolder = folder;
      });
      store.flushSync();
      return folder;
    },
  },

  db: {
    async restore(filePath?: string) {
      let target = filePath;
      if (!target) {
        const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
          title: 'Restaurer une sauvegarde',
          defaultPath: store.backupFolder,
          filters: [{ name: 'Sauvegarde CompaGelato', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths[0]) return false;
        target = result.filePaths[0];
      }
      const ok = await store.restore(target);
      if (ok) send('documents-changed', { restored: true });
      return ok;
    },
  },
};

const handlers = mergeRegistries(coreHandlers, desktopHandlers);

/* ------------------------------------------------------------------ */
/* Enregistrement                                                      */
/* ------------------------------------------------------------------ */

export function registerIpc(): void {
  for (const [namespace, methods] of Object.entries(CHANNELS)) {
    for (const method of methods as readonly string[]) {
      const channel = `${namespace}:${method}`;
      const handler = handlers[namespace]?.[method];
      if (!handler) {
        // Un canal déclaré sans implémentation est une erreur de développement :
        // mieux vaut un message clair qu'un appel qui ne répond jamais.
        ipcMain.handle(channel, () => {
          throw new Error(`Canal non implémenté : ${channel}`);
        });
        console.error(`[ipc] canal sans implémentation : ${channel}`);
        continue;
      }
      ipcMain.handle(channel, async (_event, ...args) => {
        try {
          return await handler(...args);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          console.error(`[ipc] ${channel} :`, message);
          // L'erreur est renvoyée telle quelle : l'interface affiche le message.
          throw new Error(message);
        }
      });
    }
  }
}
