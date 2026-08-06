import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppInfo,
  EmailOutcome,
  EmailPreparation,
  PrintOutcome,
  ProductSuggestion,
  RouteQr,
} from '@shared/api';
import { CHANNELS } from '@shared/api';
import type {
  AccountingDocument,
  Attachment,
  BankTransaction,
  Client,
  DeliveryRoute,
  EmailDraft,
  EventMachine,
  ID,
  Product,
  RegisterEntry,
  RegisterStatus,
  Settings,
  Vehicle,
} from '@shared/types';
import { defaultWatchFolder, newId, nowIso, store } from './store';
import { folderWatcher } from './watcher';
import { resolvePath } from './services/paths';
import {
  ensureWatchFolder,
  markManual,
  removeDocument,
  rescanFile,
  scanFolder,
  upsertDocument,
} from './services/documents';
import {
  importClientsFile,
  importProductsFile,
  mergeClients,
  nextProductSku,
  removeClient,
  upsertClient,
} from './services/clients';
import {
  adjustStock,
  applyAllPending,
  applyDocumentToStock,
  linkLineToProduct,
  resolveDocumentLines,
  revertDocumentFromStock,
  suggestProducts,
} from './services/stock';
import { computeRoute, optimizeRoute, removeRoute, upsertRoute } from './services/routes';
import { autocompleteAddress, fetchFuelPrice, geocodeOne, reverseGeocode } from './services/routing';
import { buildMapUrls, providerLabel, providerLimit, type MapPoint } from './services/mapLinks';
import { buildDashboard } from './services/dashboard';
import {
  exportBankCsv,
  exportClientsCsv,
  exportDatabaseJson,
  exportDocumentsCsv,
  exportProductsCsv,
  exportRouteCsv,
} from './services/exports';
import {
  autoReconcile,
  bankSummary,
  importStatementFile,
  reconcile,
  removeTransaction,
  scanStatementFolder,
  statementFolder,
  suggestMatches,
  updateTransaction,
} from './services/bank';
import {
  addRegisterEntryToRoute,
  listMachineAvailability,
  listRegisterEntries,
  removeMachine,
  removeRegisterEntry,
  setRegisterStatus,
  upsertMachine,
  upsertRegisterEntry,
} from './services/registers';
import { sendNotification, notifyEnabled } from './services/notify';
import { seedDemoData, wipeDemoData } from './services/demo';
import { round2 } from './services/text';
import {
  addAttachment,
  attachmentExists,
  attachmentsFolder,
  listAttachments,
  removeAttachment,
  syncAttachmentsFolder,
  updateAttachment,
} from './services/attachments';
import { printFile } from './services/printing';
import { applyTemplate, buildEml, buildMailto, safeFileName } from './services/mail';
import { applyUpdate, checkForUpdates } from './services/updater';

type Handler = (...args: any[]) => unknown;
type Registry = Record<string, Record<string, Handler>>;

/**
 * Racine du projet (dossier cloné du dépôt), utilisée pour la mise à jour par
 * git. `app.getAppPath()` ne convient pas ici : lancé via `electron dist/main/main.mjs`,
 * Electron la fait pointer sur `dist/main` plutôt que sur la racine du dépôt.
 * Le fichier compilé étant unique (bundle esbuild), `import.meta.url` renvoie
 * toujours son propre emplacement — deux niveaux au-dessus se trouve la racine.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window;
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */
/* Génération de QR codes                                              */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<string, string> = {
  invoice: 'Facture',
  quote: 'Devis',
  credit: 'Avoir',
};

/** Le type précédé de son article, pour écrire « ci-joint la facture … ». */
const KIND_WITH_ARTICLE: Record<string, string> = {
  invoice: 'la facture',
  quote: 'le devis',
  credit: 'l’avoir',
};

const euroFormatter = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
});

/**
 * `child` est-il le dossier `parent` ou situé dedans ? La comparaison ignore la
 * casse : sous Windows, deux chemins qui ne diffèrent que par la casse
 * désignent le même dossier.
 */
function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}

function requireDocument(documentId: ID): AccountingDocument {
  const doc = store.db.documents.find((d) => d.id === documentId);
  if (!doc) throw new Error('Document introuvable.');
  return doc;
}

function formatFrenchDate(iso?: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** Chaîne d'adresse la plus complète possible pour interroger le géocodeur. */
function addressQuery(client: Client): string {
  const { address } = client;
  const parts = [address.street, address.postcode, address.city].filter(Boolean);
  const composed = parts.join(' ').trim();
  return composed || (address.label ?? '').trim();
}

async function makeQr(text: string): Promise<string> {
  const QRCode = await import('qrcode');
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#111114ff', light: '#ffffffff' },
  });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

const handlers: Registry = {
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

  settings: {
    async get(): Promise<Settings> {
      return store.settings;
    },
    async update(patch: Partial<Settings>): Promise<Settings> {
      const previousFolder = store.settings.watchFolder;
      const previousAutoScan = store.settings.autoScan;
      const settings = store.mutate((db) => {
        Object.assign(db.settings, patch);
        return db.settings;
      });
      store.flushSync();

      if (patch.watchFolder && patch.watchFolder !== previousFolder) {
        ensureWatchFolder(patch.watchFolder);
        await folderWatcher.start(patch.watchFolder);
      } else if (patch.autoScan !== undefined && patch.autoScan !== previousAutoScan) {
        if (patch.autoScan) await folderWatcher.start(settings.watchFolder);
        else await folderWatcher.stop();
      }
      return settings;
    },
    async resetFolder(): Promise<Settings> {
      const folder = defaultWatchFolder();
      ensureWatchFolder(folder);
      const settings = store.mutate((db) => {
        db.settings.watchFolder = folder;
        return db.settings;
      });
      await folderWatcher.start(folder);
      return settings;
    },
  },

  clients: {
    async list(): Promise<Client[]> {
      return [...store.db.clients].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    },
    async save(input: Partial<Client> & { id?: ID }) {
      const client = upsertClient(input);
      store.flushSync();
      return client;
    },
    async remove(id: ID) {
      removeClient(id);
      store.flushSync();
    },
    async importFrom(filePath: string, mapping?: Record<string, string>) {
      const report = await importClientsFile(filePath, mapping);
      store.flushSync();
      return report;
    },
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
      const report = await importClientsFile(result.filePaths[0]);
      store.flushSync();
      return report;
    },
    async exportCsv() {
      return exportClientsCsv();
    },
    async merge(keepId: ID, mergeId: ID) {
      const client = mergeClients(keepId, mergeId);
      store.flushSync();
      return client;
    },
    /**
     * Complète les coordonnées GPS des fiches importées, pour qu'elles
     * deviennent utilisables dans le calculateur de tournée.
     */
    async geocodeMissing() {
      const targets = store.db.clients.filter(
        (c) => !c.archived && typeof c.address.lat !== 'number' && addressQuery(c),
      );
      let located = 0;
      let failed = 0;
      // Traitement séquentiel et espacé : on reste courtois avec le service public.
      for (const client of targets.slice(0, 400)) {
        const query = addressQuery(client);
        try {
          const hit = await geocodeOne(query);
          if (hit) {
            store.mutate(() => {
              client.address = {
                ...client.address,
                label: client.address.label || hit.label,
                postcode: client.address.postcode ?? hit.postcode,
                city: client.address.city ?? hit.city,
                lat: hit.lat,
                lon: hit.lon,
              };
              client.updatedAt = nowIso();
            });
            located++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      store.flushSync();
      return { processed: targets.length, located, failed };
    },
  },

  documents: {
    async list(): Promise<AccountingDocument[]> {
      return [...store.db.documents].sort(
        (a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.importedAt.localeCompare(a.importedAt),
      );
    },
    async get(id: ID) {
      return store.db.documents.find((d) => d.id === id) ?? null;
    },
    async save(input: Partial<AccountingDocument> & { id?: ID }) {
      const doc = upsertDocument(input);
      store.flushSync();
      return doc;
    },
    async remove(id: ID) {
      removeDocument(id);
      store.flushSync();
    },
    async scan(options?: { force?: boolean }) {
      const report = await scanFolder({
        force: options?.force,
        onProgress: (payload) => send('scan-progress', payload),
      });
      return report;
    },
    async rescanFile(filePath: string) {
      return rescanFile(filePath);
    },
    async setClient(documentId: ID, clientId: ID | null) {
      const doc = store.mutate((db) => {
        const target = db.documents.find((d) => d.id === documentId);
        if (!target) throw new Error('Document introuvable.');
        target.clientId = clientId ?? undefined;
        target.warnings = target.warnings.filter((w) => !w.startsWith('Client'));
        // Y compris un détachement volontaire : sans cette marque, la relecture
        // rattacherait à nouveau le client deviné.
        markManual(target, 'clientId');
        target.updatedAt = nowIso();
        return target;
      });
      // Le nom lu sur la pièce devient un alias : les prochains imports seront directs.
      if (clientId && doc.clientNameRaw) {
        const client = store.db.clients.find((c) => c.id === clientId);
        if (client && !client.aliases.includes(doc.clientNameRaw) && client.name !== doc.clientNameRaw) {
          store.mutate(() => {
            client.aliases.push(doc.clientNameRaw as string);
          });
        }
      }
      store.flushSync();
      return doc;
    },
    async setStatus(documentId: ID, status: AccountingDocument['status']) {
      const doc = store.mutate((db) => {
        const target = db.documents.find((d) => d.id === documentId);
        if (!target) throw new Error('Document introuvable.');
        target.status = status;
        markManual(target, 'status');
        target.updatedAt = nowIso();
        return target;
      });
      // Une pièce annulée ne doit plus peser sur le stock.
      if (status === 'cancelled' && doc.stockApplied) revertDocumentFromStock(doc.id);
      store.flushSync();
      return doc;
    },
    async exportCsv() {
      return exportDocumentsCsv();
    },

    /* -- Fichier d'origine, impression, e-mail -------------------- */

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

    async setPrinted(documentId: ID, printed: boolean) {
      const doc = requireDocument(documentId);
      store.mutate(() => {
        doc.printedAt = printed ? nowIso() : undefined;
        doc.updatedAt = nowIso();
      });
      store.flushSync();
      return doc;
    },

    async prepareEmail(documentId: ID): Promise<EmailPreparation> {
      const doc = requireDocument(documentId);
      const settings = store.settings;
      const client = doc.clientId ? store.db.clients.find((c) => c.id === doc.clientId) : undefined;

      // Reprend les fichiers déposés à la main dans le dossier des pièces jointes.
      syncAttachmentsFolder();

      const values = {
        type: KIND_LABEL[doc.kind],
        type_minuscule: KIND_LABEL[doc.kind].toLowerCase(),
        le_type: KIND_WITH_ARTICLE[doc.kind],
        numero: doc.number,
        date: formatFrenchDate(doc.date),
        client: client?.name ?? doc.clientNameRaw ?? '',
        societe: settings.companyName ?? '',
        montant: euroFormatter.format(doc.totalTTC),
      };

      const subject = applyTemplate(settings.emailSubjectTemplate ?? '{type} {numero}', values);
      const bodyBase = applyTemplate(settings.emailBodyTemplate ?? 'Bonjour,', values);
      const signature = settings.emailSignature?.trim();
      const body = signature ? `${bodyBase}\n\n${signature}` : bodyBase;

      const attachments = listAttachments().map((a) => ({ ...a, exists: attachmentExists(a) }));
      const documentAttachable = Boolean(doc.sourceFile && fs.existsSync(resolvePath(doc.sourceFile)));

      return {
        draft: {
          to: client?.email ?? '',
          subject,
          body,
          includeDocument: documentAttachable,
          // Les pièces cochées par défaut sont pré-sélectionnées.
          attachmentIds: attachments.filter((a) => a.defaultSelected && a.exists).map((a) => a.id),
        },
        attachments,
        documentAttachable,
        documentFileName: doc.sourceFile ? path.basename(doc.sourceFile) : undefined,
        clientName: client?.name ?? doc.clientNameRaw,
        warning: !client?.email
          ? "Ce client n'a pas d'adresse e-mail enregistrée : saisissez-la ci-dessous ou complétez sa fiche."
          : undefined,
      };
    },

    async sendEmail(documentId: ID, draft: EmailDraft): Promise<EmailOutcome> {
      const doc = requireDocument(documentId);
      if (!draft.to?.trim()) throw new Error('Renseignez au moins un destinataire.');

      const files: { filePath: string; fileName?: string }[] = [];
      if (draft.includeDocument && doc.sourceFile && fs.existsSync(resolvePath(doc.sourceFile))) {
        files.push({ filePath: resolvePath(doc.sourceFile) });
      }
      for (const id of draft.attachmentIds ?? []) {
        const attachment = store.db.attachments.find((a) => a.id === id);
        if (!attachment) continue;
        const attachmentPath = resolvePath(attachment.filePath);
        if (!fs.existsSync(attachmentPath)) continue;
        files.push({
          filePath: attachmentPath,
          fileName: `${attachment.name}${path.extname(attachmentPath)}`,
        });
      }

      const built = buildEml({
        to: draft.to.trim(),
        cc: draft.cc?.trim() || undefined,
        from: store.settings.senderEmail?.trim() || undefined,
        subject: draft.subject,
        body: draft.body,
        attachments: files,
      });

      const markSent = () => {
        store.mutate(() => {
          doc.emailedAt = nowIso();
          doc.updatedAt = nowIso();
        });
        store.flushSync();
      };

      const attachmentMb = round2(built.attachmentBytes / (1024 * 1024));

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

        markSent();
        const missing = built.missing.length
          ? ` ${built.missing.length} pièce(s) jointe(s) introuvable(s) : ${built.missing.join(', ')}.`
          : '';
        return {
          sent: true,
          method: 'eml',
          attachmentMb,
          message: `Brouillon ouvert dans votre messagerie avec ${files.length} pièce(s) jointe(s).${missing} Relisez-le puis envoyez-le.`,
        };
      } catch (err) {
        // Repli sans pièce jointe : au moins le message part.
        const mailto = buildMailto({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
        await shell.openExternal(mailto);
        markSent();
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
    async list() {
      syncAttachmentsFolder();
      store.flushSync();
      return listAttachments().map((a) => ({ ...a, exists: attachmentExists(a) }));
    },
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
    async update(id: ID, patch: Partial<Attachment>) {
      const attachment = updateAttachment(id, patch);
      store.flushSync();
      return attachment;
    },
    async remove(id: ID) {
      removeAttachment(id);
      store.flushSync();
    },
    async open(id: ID) {
      const attachment = store.db.attachments.find((a) => a.id === id);
      if (!attachment) throw new Error('Pièce jointe introuvable.');
      const file = resolvePath(attachment.filePath);
      if (!fs.existsSync(file)) throw new Error('Le fichier a été déplacé ou supprimé.');
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    },
    async sync() {
      const report = syncAttachmentsFolder();
      store.flushSync();
      return report;
    },
    async openFolder() {
      await shell.openPath(attachmentsFolder());
    },
  },

  products: {
    async list(): Promise<Product[]> {
      return [...store.db.products].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    },
    async save(input: Partial<Product> & { id?: ID }) {
      const product = store.mutate((db) => {
        const existing = input.id ? db.products.find((p) => p.id === input.id) : undefined;
        if (existing) {
          const nextQty = input.qtyOnHand ?? existing.qtyOnHand;
          Object.assign(existing, {
            ...input,
            qtyOnHand: existing.qtyOnHand,
            aliases: input.aliases ?? existing.aliases,
            updatedAt: nowIso(),
          });
          // Une modification de quantité passe par un mouvement de stock tracé.
          if (round2(nextQty) !== round2(existing.qtyOnHand)) {
            adjustStock(existing.id, round2(nextQty), 'Correction depuis la fiche produit');
          }
          return existing;
        }
        const product: Product = {
          id: newId('prd'),
          sku: input.sku?.trim() || nextProductSku(),
          name: input.name?.trim() || 'Nouvel article',
          type: input.type ?? 'consumable',
          category: input.category,
          unit: input.unit || 'pièce',
          qtyOnHand: round2(input.qtyOnHand ?? 0),
          minQty: round2(input.minQty ?? 0),
          unitCost: input.unitCost,
          supplier: input.supplier,
          aliases: input.aliases ?? [],
          archived: input.archived ?? false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        db.products.push(product);
        return product;
      });

      // Le nouveau produit peut concerner des documents déjà importés.
      store.mutate((db) => {
        for (const doc of db.documents) if (!doc.stockApplied) resolveDocumentLines(doc);
      });
      store.flushSync();
      return product;
    },
    async remove(id: ID) {
      store.mutate((db) => {
        db.products = db.products.filter((p) => p.id !== id);
        db.stockMoves = db.stockMoves.filter((m) => m.productId !== id);
        for (const doc of db.documents) {
          for (const line of doc.lines) {
            if (line.productId === id) {
              line.productId = undefined;
              line.matchMethod = 'none';
            }
          }
        }
      });
      store.flushSync();
    },
    async importFrom(filePath: string) {
      const report = await importProductsFile(filePath);
      store.mutate((db) => {
        for (const doc of db.documents) if (!doc.stockApplied) resolveDocumentLines(doc);
      });
      store.flushSync();
      return report;
    },
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
      const report = await importProductsFile(result.filePaths[0]);
      store.mutate((db) => {
        for (const doc of db.documents) if (!doc.stockApplied) resolveDocumentLines(doc);
      });
      store.flushSync();
      return report;
    },
    async exportCsv() {
      return exportProductsCsv();
    },
    async adjust(productId: ID, qty: number, note?: string) {
      const product = adjustStock(productId, qty, note);
      store.flushSync();
      return product;
    },
  },

  stock: {
    async moves(productId?: ID) {
      const moves = productId
        ? store.db.stockMoves.filter((m) => m.productId === productId)
        : store.db.stockMoves;
      return moves.slice(0, 500);
    },
    async apply(documentId: ID) {
      const report = applyDocumentToStock(documentId);
      store.flushSync();
      return report;
    },
    async revert(documentId: ID) {
      const report = revertDocumentFromStock(documentId);
      store.flushSync();
      return report;
    },
    async applyAll() {
      const result = applyAllPending();
      store.flushSync();
      return result;
    },
    async linkLine(documentId: ID, lineId: ID, productId: ID | null) {
      const doc = linkLineToProduct(documentId, lineId, productId);
      store.flushSync();
      return doc;
    },
    async suggestions(label: string, ref?: string): Promise<ProductSuggestion[]> {
      return suggestProducts(store.db.products, label, ref);
    },
  },

  routes: {
    async list(): Promise<DeliveryRoute[]> {
      return [...store.db.routes].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    },
    async save(input: Partial<DeliveryRoute> & { id?: ID }) {
      const route = upsertRoute(input);
      store.flushSync();
      return route;
    },
    async remove(id: ID) {
      removeRoute(id);
      store.flushSync();
    },
    async compute(route: DeliveryRoute) {
      const result = await computeRoute(route);
      // Le résultat est mémorisé si la tournée est déjà enregistrée.
      if (store.db.routes.some((r) => r.id === route.id)) {
        upsertRoute({ ...result.route, id: route.id });
        store.flushSync();
      }
      return result;
    },
    async optimize(route: DeliveryRoute, options?: { returnToStart: boolean; maxIterations?: number }) {
      const result = await optimizeRoute(route, options ?? { returnToStart: route.returnToStart });
      if (store.db.routes.some((r) => r.id === route.id)) {
        upsertRoute({ ...result.route, id: route.id });
        store.flushSync();
      }
      return result;
    },
    async link(route: DeliveryRoute, provider: 'google' | 'waze' | 'apple'): Promise<RouteQr> {
      const points: MapPoint[] = [];
      const push = (label: string, address: { label: string; lat?: number; lon?: number }) => {
        if (typeof address.lat === 'number' && typeof address.lon === 'number') {
          points.push({ label, lat: address.lat, lon: address.lon, address: address.label });
        } else if (address.label) {
          points.push({ label, address: address.label });
        }
      };

      push(route.start.label || 'Départ', route.start.address);
      for (const stop of route.stops) push(stop.label || 'Arrêt', stop.address);
      if (route.returnToStart) push(`${route.start.label || 'Départ'} (retour)`, route.start.address);
      else if (route.end) push(route.end.label || 'Arrivée', route.end.address);

      const segments = buildMapUrls(provider, points);
      if (!segments.length) {
        throw new Error('Il faut au moins un départ et un arrêt géolocalisés pour créer un itinéraire.');
      }

      const withQr = await Promise.all(
        segments.map(async (s) => ({ ...s, qrDataUrl: await makeQr(s.url) })),
      );

      const warning =
        segments.length > 1
          ? `${providerLabel(provider)} accepte ${providerLimit(provider)} points par lien : la tournée est découpée en ${segments.length} liens à ouvrir l’un après l’autre.`
          : undefined;

      return {
        provider,
        url: withQr[0].url,
        qrDataUrl: withQr[0].qrDataUrl,
        segments: withQr,
        warning,
      };
    },
    async qr(text: string) {
      return makeQr(text);
    },
    async exportCsv(routeId: ID) {
      return exportRouteCsv(routeId);
    },
  },

  vehicles: {
    async list(): Promise<Vehicle[]> {
      return store.db.vehicles;
    },
    async save(input: Partial<Vehicle> & { id?: ID }) {
      const vehicle = store.mutate((db) => {
        const existing = input.id ? db.vehicles.find((v) => v.id === input.id) : undefined;
        if (existing) {
          Object.assign(existing, input, { updatedAt: nowIso() });
          if (input.isDefault) {
            for (const v of db.vehicles) v.isDefault = v.id === existing.id;
            db.settings.defaultVehicleId = existing.id;
          }
          return existing;
        }
        const created: Vehicle = {
          id: newId('veh'),
          name: input.name?.trim() || 'Nouveau véhicule',
          consumption: input.consumption ?? 9,
          fuelType: input.fuelType ?? 'gazole',
          maintenancePerKm: input.maintenancePerKm ?? 0.08,
          driverCostPerHour: input.driverCostPerHour ?? 0,
          isDefault: input.isDefault ?? db.vehicles.length === 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        if (created.isDefault) {
          for (const v of db.vehicles) v.isDefault = false;
          db.settings.defaultVehicleId = created.id;
        }
        db.vehicles.push(created);
        return created;
      });
      store.flushSync();
      return vehicle;
    },
    async remove(id: ID) {
      store.mutate((db) => {
        if (db.vehicles.length <= 1) throw new Error('Au moins un véhicule doit rester enregistré.');
        db.vehicles = db.vehicles.filter((v) => v.id !== id);
        if (db.settings.defaultVehicleId === id) {
          db.settings.defaultVehicleId = db.vehicles[0]?.id;
          if (db.vehicles[0]) db.vehicles[0].isDefault = true;
        }
      });
      store.flushSync();
    },
  },

  registers: {
    async list() {
      return listRegisterEntries();
    },
    async save(input: Partial<RegisterEntry> & { id?: ID }) {
      const entry = upsertRegisterEntry(input);
      store.flushSync();
      return entry;
    },
    async remove(id: ID) {
      removeRegisterEntry(id);
      store.flushSync();
    },
    async setStatus(id: ID, status: RegisterStatus) {
      const entry = setRegisterStatus(id, status);
      store.flushSync();
      return entry;
    },
    async addToRoute(entryId: ID, routeId?: ID) {
      const result = addRegisterEntryToRoute(entryId, routeId);
      store.flushSync();
      return result;
    },
  },

  machines: {
    async list() {
      return listMachineAvailability();
    },
    async save(input: Partial<EventMachine> & { id?: ID }) {
      const machine = upsertMachine(input);
      store.flushSync();
      return machine;
    },
    async remove(id: ID) {
      removeMachine(id);
      store.flushSync();
    },
  },

  notify: {
    async test() {
      const { notifyTopic, notifyUrl } = store.settings;
      if (!notifyEnabled({ topic: notifyTopic })) {
        throw new Error('Renseignez d’abord un sujet de notification dans les réglages.');
      }
      const ok = await sendNotification(
        { topic: notifyTopic, url: notifyUrl },
        {
          title: 'CompaGelato — essai',
          message: 'Les notifications fonctionnent sur ce téléphone.',
          tags: ['bell'],
        },
      );
      if (!ok) {
        throw new Error(
          'Le serveur de notifications n’a pas répondu. Vérifiez la connexion internet et l’adresse du serveur.',
        );
      }
      return true;
    },
  },

  bank: {
    async list(): Promise<BankTransaction[]> {
      return [...store.db.bankTransactions].sort(
        (a, b) => b.date.localeCompare(a.date) || b.importedAt.localeCompare(a.importedAt),
      );
    },
    async scan() {
      const report = await scanStatementFolder();
      store.flushSync();
      return report;
    },
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
      const report = await importStatementFile(result.filePaths[0]);
      store.flushSync();
      return report;
    },
    async update(id: ID, patch: Partial<BankTransaction>) {
      const tx = updateTransaction(id, patch);
      store.flushSync();
      return tx;
    },
    async remove(id: ID) {
      removeTransaction(id);
      store.flushSync();
    },
    async suggestions(transactionId: ID) {
      return suggestMatches(transactionId);
    },
    async reconcile(transactionId: ID, documentId: ID | null) {
      const tx = reconcile(transactionId, documentId);
      store.flushSync();
      return tx;
    },
    async autoReconcile() {
      const result = autoReconcile();
      store.flushSync();
      return result;
    },
    async summary() {
      return bankSummary();
    },
    async exportCsv() {
      return exportBankCsv();
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

  geo: {
    async autocomplete(query: string, options?: { near?: { lat: number; lon: number } }) {
      return autocompleteAddress(query, { near: options?.near });
    },
    async reverse(lat: number, lon: number) {
      return reverseGeocode(lat, lon);
    },
    async fuelPrice(fuelType: Vehicle['fuelType'], postcode?: string) {
      const result = await fetchFuelPrice(fuelType, postcode ?? store.settings.fuelPricePostcode);
      if (result) {
        store.mutate((db) => {
          db.settings.fuelPricePerLiter = result.price;
          db.settings.fuelPriceUpdatedAt = result.updatedAt;
          db.settings.fuelPriceSource = result.source;
        });
        store.flushSync();
      }
      return result;
    },
  },

  stats: {
    async dashboard() {
      return buildDashboard();
    },
  },

  db: {
    async backup() {
      return store.backup();
    },
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
    async exportAll() {
      return exportDatabaseJson();
    },
    async stats() {
      store.flushSync();
      let sizeKb = 0;
      try {
        sizeKb = Math.round(fs.statSync(store.dbFile).size / 1024);
      } catch {
        /* fichier pas encore écrit */
      }
      return {
        file: store.dbFile,
        sizeKb,
        counts: {
          clients: store.db.clients.length,
          documents: store.db.documents.length,
          products: store.db.products.length,
          stockMoves: store.db.stockMoves.length,
          routes: store.db.routes.length,
          vehicles: store.db.vehicles.length,
          attachments: store.db.attachments.length,
          bankTransactions: store.db.bankTransactions.length,
          registerEntries: store.db.registerEntries.length,
          eventMachines: store.db.eventMachines.length,
        },
      };
    },
    async seedDemo() {
      seedDemoData();
      send('documents-changed', { seeded: true });
    },
    async wipeDemo() {
      wipeDemoData();
      send('documents-changed', { wiped: true });
    },
  },

  updates: {
    async check() {
      return checkForUpdates(projectRoot);
    },
    async apply(options?: { discardLocalChanges?: boolean }) {
      return applyUpdate(
        projectRoot,
        (step) => send('toast', { tone: 'info', title: step }),
        { discardLocalChanges: options?.discardLocalChanges },
      );
    },
  },
};

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
