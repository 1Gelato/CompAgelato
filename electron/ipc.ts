import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppInfo, Connection, EmailOutcome, PrintOutcome } from '@shared/api';
import { CHANNELS } from '@shared/api';
import type { AccountingDocument, EmailDraft, ID } from '@shared/types';
import {
  connectionConfig,
  currentMode,
  describeConnection,
  isRemote,
  pingServer,
  saveConnection,
} from './connection';
import {
  createRemoteRegistry,
  downloadToCache,
  remoteCall,
  uploadFile,
} from './remote';
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
 *
 * Deux montages sont possibles, choisis au démarrage selon la liaison
 * enregistrée pour l'appareil :
 *
 * - **local**  : gestionnaires partagés sur la base de la machine, calque
 *   `desktopHandlers` par-dessus. C'est le fonctionnement d'origine.
 * - **distant** : les mêmes canaux renvoyés au serveur (`remote.ts`), calque
 *   `remoteDesktopHandlers` par-dessus pour rendre au poste ce qui lui revient —
 *   imprimer, ouvrir un PDF, préparer un e-mail, choisir un fichier.
 *
 * Dans les deux cas l'interface ne voit qu'un `window.api` identique.
 */

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window;
  setBroadcast((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  });
}

/**
 * Réglage de la liaison au serveur : toujours traité sur le poste, dans les
 * deux montages. Une application branchée sur un serveur injoignable doit
 * pouvoir en changer l'adresse — demander au serveur serait absurde.
 */
const connectionHandlers = {
  async connection(): Promise<Connection> {
    if (!isRemote()) return describeConnection();
    const { ok, error } = await pingServer(connectionConfig(), 2500);
    return describeConnection(ok, error);
  },
  async setConnection(input: { serverUrl: string; token?: string }): Promise<Connection> {
    const saved = saveConnection(input);
    if (!saved.serverUrl) return describeConnection();
    const { ok, error } = await pingServer(saved);
    return describeConnection(ok, error);
  },
};

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
        mode: 'local',
        localFolders: true,
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
    ...connectionHandlers,
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

/* ------------------------------------------------------------------ */
/* Mode distant : les données viennent du serveur, les gestes du poste  */
/* ------------------------------------------------------------------ */

/** Un dossier du serveur ne s'ouvre pas depuis ce poste : on le dit clairement. */
function onServer(what: string): never {
  throw new Error(
    `${what} se trouve sur le serveur (${connectionConfig().serverUrl}), pas sur ce poste.`,
  );
}

async function remoteDocument(documentId: ID): Promise<AccountingDocument> {
  const doc = (await remoteCall('documents', 'get', [documentId])) as AccountingDocument | null;
  if (!doc) throw new Error('Document introuvable sur le serveur.');
  return doc;
}

/**
 * Rapatrie le fichier d'origine d'une pièce sous un nom lisible : c'est ce nom
 * que verra l'utilisateur dans sa visionneuse ou sa file d'impression.
 */
async function fetchDocumentFile(doc: AccountingDocument): Promise<string> {
  if (!doc.sourceFile) {
    throw new Error("Ce document n'a pas de fichier d'origine (saisie manuelle).");
  }
  const extension = path.extname(doc.sourceFile) || '.pdf';
  const name = `${safeFileName(`${KIND_LABEL[doc.kind]} ${doc.number}`)}${extension}`;
  return downloadToCache(`/files/document/${doc.id}`, name);
}

/** Choisit un fichier sur le poste, puis l'envoie au serveur qui l'importe. */
async function pickThenUpload(
  kind: string,
  options: { title: string; filters: { name: string; extensions: string[] }[] },
): Promise<unknown | null> {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
    title: options.title,
    filters: [...options.filters, { name: 'Tous les fichiers', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return uploadFile(kind, result.filePaths[0]);
}

const remoteDesktopHandlers: Registry = {
  app: {
    async info(): Promise<AppInfo> {
      const remote = (await remoteCall('app', 'info', [])) as AppInfo;
      return {
        ...remote,
        // Les dossiers et la base restent ceux du serveur ; l'exécution, elle,
        // est bien celle de ce poste.
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
        isPackaged: app.isPackaged,
        mode: 'remote',
        localFolders: false,
      };
    },
    async openPath(target: string) {
      onServer(`Ce dossier (${target})`);
    },
    async openExternal(url: string) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Lien non autorisé.');
      await shell.openExternal(url);
    },
    async chooseFolder() {
      onServer('Le dossier surveillé');
    },
    async chooseFile(filters?: { name: string; extensions: string[] }[]) {
      // Un fichier choisi ici sert à être téléversé : le chemin reste local.
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Choisir un fichier',
        filters: filters ?? [{ name: 'Tous les fichiers', extensions: ['*'] }],
        properties: ['openFile'],
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    async revealFile(target: string) {
      // Les exports sont écrits par le serveur : rien à montrer sur ce poste.
      // Le chemin est déjà affiché à l'utilisateur, on n'ajoute pas d'erreur.
      if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    },
    async quit() {
      app.quit();
    },
    async relaunch() {
      app.relaunch();
      app.exit(0);
    },
    ...connectionHandlers,
  },

  documents: {
    async openFile(documentId: ID) {
      const file = await fetchDocumentFile(await remoteDocument(documentId));
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    },

    async print(documentId: ID): Promise<PrintOutcome> {
      const doc = await remoteDocument(documentId);
      const result = await printFile(await fetchDocumentFile(doc));
      // La marque « imprimé » appartient à la donnée partagée : elle repart au
      // serveur, pour que les autres postes la voient aussi.
      if (result.printed) await remoteCall('documents', 'setPrinted', [documentId, true]);
      return result;
    },

    async sendEmail(documentId: ID, draft: EmailDraft): Promise<EmailOutcome> {
      const doc = await remoteDocument(documentId);
      // Le serveur assemble le brouillon : c'est lui qui détient les pièces
      // jointes. Ce poste ne fait que l'ouvrir dans la messagerie.
      const outcome = (await remoteCall('documents', 'sendEmail', [
        documentId,
        draft,
      ])) as EmailOutcome;
      if (!outcome.fileUrl) return outcome;

      const name = `${safeFileName(`${KIND_LABEL[doc.kind]} ${doc.number}`)}.eml`;
      try {
        const file = await downloadToCache(outcome.fileUrl, name);
        const error = await shell.openPath(file);
        if (error) throw new Error(error);
        return {
          ...outcome,
          fileUrl: undefined,
          message: outcome.message.replace(
            'Brouillon téléchargé',
            'Brouillon ouvert dans votre messagerie',
          ),
        };
      } catch (err) {
        // Repli : au moins le message part, sans les pièces jointes.
        await shell.openExternal(
          buildMailto({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body }),
        );
        return {
          ...outcome,
          method: 'mailto',
          attachmentMb: 0,
          fileUrl: undefined,
          message: `Le brouillon complet n'a pas pu être ouvert (${(err as Error).message}). Un message vide a été ouvert : ajoutez les fichiers à la main.`,
        };
      }
    },
  },

  attachments: {
    async open(id: ID) {
      const file = await downloadToCache(`/files/attachment/${id}`, `piece-jointe-${id}`);
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    },
    async openFolder() {
      onServer('La bibliothèque de pièces jointes');
    },
    async pickAndAdd() {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: 'Ajouter des pièces jointes (flyers, plaquettes…)',
        filters: [
          { name: 'Documents et images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'xlsx', 'pptx'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      const added: unknown[] = [];
      for (const file of result.filePaths) {
        added.push(...((await uploadFile('attachments', file)) as unknown[]));
      }
      return added;
    },
  },

  clients: {
    pickAndImport: () =>
      pickThenUpload('clients', {
        title: 'Importer la liste clients',
        filters: [{ name: 'Fichiers clients', extensions: ['csv', 'xlsx', 'xls', 'txt'] }],
      }),
  },

  products: {
    pickAndImport: () =>
      pickThenUpload('products', {
        title: 'Importer le stock de consommables',
        filters: [{ name: 'Fichiers stock', extensions: ['csv', 'xlsx', 'xls', 'txt'] }],
      }),
  },

  bank: {
    pickAndImport: () =>
      pickThenUpload('bank', {
        title: 'Importer un relevé de compte',
        filters: [{ name: 'Relevés de compte', extensions: ['csv', 'xlsx', 'xls', 'xlsm'] }],
      }),
    async openFolder() {
      onServer('Le dossier des relevés');
    },
    async chooseFolder() {
      onServer('Le dossier des relevés');
    },
  },

  db: {
    restore: () =>
      pickThenUpload('restore', {
        title: 'Restaurer une sauvegarde sur le serveur',
        filters: [{ name: 'Sauvegarde CompaGelato', extensions: ['json'] }],
      }),
  },
};

/* ------------------------------------------------------------------ */
/* Enregistrement                                                      */
/* ------------------------------------------------------------------ */

/** Le montage retenu au démarrage, selon la liaison enregistrée. */
function buildHandlers(): Registry {
  return isRemote()
    ? mergeRegistries(createRemoteRegistry(), remoteDesktopHandlers)
    : mergeRegistries(coreHandlers, desktopHandlers);
}

export function registerIpc(): void {
  const handlers = buildHandlers();
  console.log(`[ipc] mode ${currentMode()}${isRemote() ? ` → ${connectionConfig().serverUrl}` : ''}`);
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
