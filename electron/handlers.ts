import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppInfo,
  AuthIdentity,
  AuthStatus,
  Connection,
  SyncPullRequest,
  SyncPullResult,
  EmailOutcome,
  EmailPreparation,
  PrintOutcome,
  ProductSuggestion,
  RouteQr,
} from '@shared/api';
import { COLLECTION_CHANNEL, mayCall } from '@shared/api';
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
  Role,
  Settings,
  UserSummary,
  Vehicle,
} from '@shared/types';
import { SYNCED_COLLECTIONS } from '@shared/types';
import { currentContext, currentIdentity, currentRole } from './context';
import {
  accountsConfigured,
  changePassword,
  listSessions,
  login,
  logout,
  removeUser,
  revokeSession,
  saveUser,
  summarize,
} from './services/auth';
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
  registerOpeningStock,
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
  findDuplicateGroups,
  importStatementFile,
  mergeDuplicates,
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
import { applyTemplate, buildEml, safeFileName } from './services/mail';
import { applyUpdate, checkForUpdates, currentBuild } from './services/updater';

export type Handler = (...args: any[]) => unknown;
export type Registry = Record<string, Record<string, Handler>>;

/**
 * Racine du projet (dossier cloné du dépôt), utilisée pour la mise à jour par
 * git. Le fichier compilé est un bundle unique placé dans `dist/main/` ou
 * `dist/server/` : deux niveaux au-dessus se trouve toujours la racine.
 */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------------------------------------------------ */
/* Diffusion vers l'interface                                          */
/* ------------------------------------------------------------------ */

let broadcast: (channel: string, payload: unknown) => void = () => {};

/**
 * Branche la diffusion des événements (`documents-changed`, `scan-progress`,
 * `toast`). Sur le bureau : `webContents.send` ; côté serveur : le flux SSE.
 */
export function setBroadcast(fn: (channel: string, payload: unknown) => void): void {
  broadcast = fn;
}

export function send(channel: string, payload: unknown): void {
  broadcast(channel, payload);
}

/* ------------------------------------------------------------------ */
/* Aides partagées                                                     */
/* ------------------------------------------------------------------ */

/**
 * Certaines actions ouvrent une fenêtre ou un programme sur le poste
 * (sélecteur de fichier, visionneuse PDF, messagerie) : elles n'existent que
 * dans l'application de bureau. Le navigateur reçoit ce message clair plutôt
 * qu'un silence.
 */
const LOCAL_ONLY =
  "Cette action ouvre une fenêtre sur l'ordinateur : utilisez l'application de bureau.";

function localOnly(): never {
  throw new Error(LOCAL_ONLY);
}

/**
 * Copie un fichier déposé dans le dossier surveillé, sans jamais en écraser un
 * autre.
 *
 * Redéposer exactement le même fichier ne crée pas de second exemplaire : le
 * contenu est comparé, et le fichier déjà rangé est réutilisé. Un homonyme au
 * contenu différent, lui, reçoit un suffixe — perdre une pièce parce qu'elle
 * porte un nom déjà pris serait bien pire qu'un doublon sur le disque.
 */
function placeInFolder(source: string, folder: string): string {
  const safe = path.basename(source).replace(/[\\/:*?"<>|]/g, '_');
  const extension = path.extname(safe);
  const stem = safe.slice(0, safe.length - extension.length) || 'document';
  const content = fs.readFileSync(source);

  for (let index = 1; ; index++) {
    const name = index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`;
    const target = path.join(folder, name);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content);
      return target;
    }
    // Même nom, même contenu : c'est la même pièce, on garde celle en place.
    if (fs.readFileSync(target).equals(content)) return target;
  }
}

export function appVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const KIND_LABEL: Record<string, string> = {
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
export function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}

export function requireDocument(documentId: ID): AccountingDocument {
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

/**
 * Brouillons .eml préparés pour le navigateur : le serveur les écrit dans son
 * dossier temporaire et les sert à l'adresse `/files/eml/<jeton>`.
 */
const emlFiles = new Map<string, string>();

export function emlFilePath(token: string): string | undefined {
  return emlFiles.get(token);
}

/* ------------------------------------------------------------------ */
/* Registre partagé bureau / serveur                                   */
/* ------------------------------------------------------------------ */

export const coreHandlers: Registry = {
  app: {
    async info(): Promise<AppInfo> {
      void store.db; // force l'initialisation pour connaître le fichier de base
      return {
        version: appVersion(),
        build: (await currentBuild(projectRoot)) ?? undefined,
        appPath: projectRoot,
        electron: process.versions.electron ?? '',
        node: process.versions.node,
        platform: process.platform,
        userDataPath: path.dirname(store.dbFile),
        watchFolder: store.settings.watchFolder,
        documentsPath: path.join(os.homedir(), 'Documents'),
        isPackaged: false,
        watchFolderInsideApp: isInside(store.settings.watchFolder, projectRoot),
        mode: 'server',
        // Les dossiers désignés sont ceux du serveur : un sélecteur ouvert dans
        // le navigateur montrerait ceux du poste, ce qui n'aurait aucun sens.
        localFolders: false,
      };
    },
    async openPath() {
      localOnly();
    },
    async openExternal() {
      localOnly();
    },
    async chooseFolder() {
      localOnly();
    },
    async chooseFile() {
      localOnly();
    },
    async revealFile() {
      localOnly();
    },
    async quit() {
      // Depuis un navigateur, fermer couperait le serveur à tout le monde.
      throw new Error('Le serveur ne se ferme pas depuis le navigateur.');
    },
    async relaunch() {
      // Après une mise à jour : le superviseur (systemd) relance le service.
      store.flushSync();
      setTimeout(() => process.exit(0), 300);
    },
    async connection(): Promise<Connection> {
      // Servie par le serveur : la question « à quel serveur se brancher »
      // ne se pose pas, on y est déjà.
      return { serverUrl: '', hasToken: false, mode: 'server', reachable: true };
    },
    async setConnection(): Promise<Connection> {
      throw new Error(
        'La liaison au serveur se règle dans l’application de bureau, pas depuis le navigateur.',
      );
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
      localOnly();
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

    /**
     * Dépôt d'une pièce depuis l'application : le fichier est copié dans le
     * dossier surveillé puis analysé sur-le-champ.
     *
     * Sans cela, envoyer une facture au serveur exigerait un transport de
     * fichiers à côté (partage réseau, synchronisation). Ici l'application
     * suffit, depuis n'importe quel poste et depuis le navigateur.
     *
     * Le fichier est déposé à la racine du dossier surveillé : le type de
     * pièce est alors déduit de son contenu, comme pour tout fichier trouvé
     * hors des sous-dossiers Factures/Devis/Avoirs.
     */
    async addFiles(filePaths: string[]): Promise<AccountingDocument[]> {
      const folder = ensureWatchFolder(store.settings.watchFolder);
      const added: AccountingDocument[] = [];

      for (const source of filePaths) {
        if (!source || !fs.existsSync(source)) continue;
        const target = placeInFolder(source, folder);
        const doc = await rescanFile(target);
        if (doc) added.push(doc);
      }

      store.flushSync();
      if (added.length) send('documents-changed', { imported: added.length });
      return added;
    },

    async pickAndAdd() {
      localOnly();
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

    async openFile() {
      localOnly();
    },

    async print(documentId: ID): Promise<PrintOutcome> {
      // Pas d'imprimante côté serveur : le navigateur ouvre le PDF et
      // l'utilisateur imprime depuis la visionneuse (Ctrl+P).
      const doc = requireDocument(documentId);
      if (!doc.sourceFile) throw new Error("Ce document n'a pas de fichier d'origine à imprimer.");
      return {
        printed: false,
        method: 'viewer',
        message:
          'Le PDF s’ouvre dans un onglet : imprimez-le depuis la visionneuse (Ctrl+P), puis cochez « imprimé » si besoin.',
      };
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
      // Variante navigateur : le brouillon est construit sur le serveur puis
      // proposé en téléchargement ; l'utilisateur l'ouvre dans sa messagerie.
      const doc = requireDocument(documentId);
      const built = buildDocumentEml(doc, draft);

      const folder = path.join(os.tmpdir(), 'CompaGelato');
      fs.mkdirSync(folder, { recursive: true });
      const token = newId('eml');
      const file = path.join(folder, `${safeFileName(`${KIND_LABEL[doc.kind]} ${doc.number}`)}.eml`);
      fs.writeFileSync(file, built.content, 'utf8');
      emlFiles.set(token, file);

      markDocumentEmailed(doc);
      const missing = built.missing.length
        ? ` ${built.missing.length} pièce(s) jointe(s) introuvable(s) : ${built.missing.join(', ')}.`
        : '';
      return {
        sent: true,
        method: 'eml',
        attachmentMb: round2(built.attachmentBytes / (1024 * 1024)),
        message: `Brouillon téléchargé avec ${built.fileCount} pièce(s) jointe(s).${missing} Ouvrez-le dans votre messagerie, relisez puis envoyez.`,
        fileUrl: `/files/eml/${token}`,
      };
    },
  },

  attachments: {
    async list() {
      syncAttachmentsFolder();
      store.flushSync();
      return listAttachments().map((a) => ({ ...a, exists: attachmentExists(a) }));
    },
    async pickAndAdd() {
      localOnly();
    },
    async addFiles(filePaths: string[]) {
      const added = filePaths.filter((f) => f && fs.existsSync(f)).map((file) => addAttachment(file));
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
    async open() {
      localOnly();
    },
    async sync() {
      const report = syncAttachmentsFolder();
      store.flushSync();
      return report;
    },
    async openFolder() {
      localOnly();
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
          // Un identifiant fourni est respecté : une fiche créée hors ligne le
          // pré-assigne, pour que ses références tiennent au rejeu.
          id: input.id ?? newId('prd'),
          sku: input.sku?.trim() || nextProductSku(),
          name: input.name?.trim() || 'Nouvel article',
          type: input.type ?? 'consumable',
          category: input.category,
          unit: input.unit || 'pièce',
          packSize: input.packSize,
          packMeasure: input.packMeasure,
          unitsPerCase: input.unitsPerCase,
          invoicedAs: input.invoicedAs,
          qtyOnHand: 0,
          minQty: round2(input.minQty ?? 0),
          unitCost: input.unitCost,
          supplier: input.supplier,
          aliases: input.aliases ?? [],
          archived: input.archived ?? false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        db.products.push(product);
        // Le stock de départ passe par un mouvement : sans lui, le total ne
        // repartirait pas de la somme du journal.
        registerOpeningStock(product, round2(input.qtyOnHand ?? 0));
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
      localOnly();
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
      // Le solde après mouvement se recalcule à la lecture : des mouvements
      // venus de plusieurs appareils s'entrelacent, toute valeur figée à
      // l'écriture serait fausse. Les enregistrements ne sont pas modifiés —
      // on renvoie des copies portant le solde du moment.
      const balances = new Map<ID, number>();
      const computed = new Map<ID, number>();
      const chronological = [...store.db.stockMoves].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      for (const move of chronological) {
        const balance = round2((balances.get(move.productId) ?? 0) + move.qty);
        balances.set(move.productId, balance);
        computed.set(move.id, balance);
      }
      const moves = productId
        ? store.db.stockMoves.filter((m) => m.productId === productId)
        : store.db.stockMoves;
      return moves.slice(0, 500).map((m) => ({ ...m, balanceAfter: computed.get(m.id) ?? m.balanceAfter }));
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
          id: input.id ?? newId('veh'),
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
      localOnly();
    },
    async importFrom(filePath: string) {
      const report = await importStatementFile(filePath);
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
      localOnly();
    },
    async chooseFolder() {
      localOnly();
    },
    async duplicates() {
      return findDuplicateGroups();
    },
    async mergeDuplicates() {
      const report = mergeDuplicates();
      store.flushSync();
      return report;
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
      if (!filePath) localOnly();
      const ok = await store.restore(filePath);
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

  /* ------------------------------------------------------------------ */
  /* Comptes et sessions                                                 */
  /* ------------------------------------------------------------------ */

  auth: {
    async status(): Promise<AuthStatus> {
      const configured = accountsConfigured();
      return {
        configured,
        // Tant qu'aucun compte n'existe, le serveur reste sur son jeton
        // partagé : créer le premier compte est un geste explicite.
        required: configured,
        identity: currentIdentity(),
        authorized: currentRole() !== null,
      };
    },

    async login(input: { username: string; password: string; label?: string }) {
      const context = currentContext();
      return login({ ...input, from: context?.from });
    },

    async logout() {
      const context = currentContext();
      if (context?.token) logout(context.token);
    },

    async me(): Promise<AuthIdentity | null> {
      return currentIdentity();
    },

    async changePassword(input: { current: string; next: string }) {
      const identity = currentIdentity();
      if (!identity) throw new Error('Aucune session ouverte.');
      changePassword(identity.userId, input.current, input.next);
    },

    async users(): Promise<UserSummary[]> {
      return store.db.users
        .slice()
        .sort((a, b) => a.username.localeCompare(b.username, 'fr'))
        .map(summarize);
    },

    async saveUser(input: {
      id?: ID;
      username: string;
      displayName: string;
      role: Role;
      password?: string;
      disabled?: boolean;
    }) {
      return saveUser(input);
    },

    async removeUser(id: ID) {
      const identity = currentIdentity();
      // Se supprimer soi-même laisserait une session orpheline et un gérant de
      // moins : le refus est plus clair qu'une déconnexion surprise.
      if (identity?.userId === id) throw new Error('Vous ne pouvez pas supprimer votre propre compte.');
      removeUser(id);
    },

    async sessions() {
      return listSessions();
    },

    async revokeSession(id: ID) {
      revokeSession(id);
    },
  },

  /* ------------------------------------------------------------------ */
  /* Synchronisation                                                     */
  /* ------------------------------------------------------------------ */

  sync: {
    /**
     * Descend l'état : les enregistrements modifiés depuis la révision connue
     * de l'appareil, ou la base entière quand un delta ne suffit plus. Le poste
     * remplace et supprime — il n'a aucune logique de fusion à écrire.
     */
    async pull(input: SyncPullRequest = {}): Promise<SyncPullResult> {
      // Les révisions s'attribuent à l'écriture : on force le passage pour que
      // tout ce qui vient de muter soit numéroté avant de répondre.
      store.flushSync();
      const sync = store.db.sync;
      if (!sync) throw new Error('Synchronisation non initialisée.');

      const role = currentRole() ?? 'gerant';
      const identity = currentIdentity();
      const since = input.since ?? 0;
      const full =
        !input.generation ||
        input.generation !== sync.generation ||
        since < sync.floorRev;

      const changes: SyncPullResult['changes'] = {};
      const removed: SyncPullResult['removed'] = {};

      for (const collection of SYNCED_COLLECTIONS) {
        // Le filtre par rôle s'applique ici, à la source. Une collection
        // interdite est absente de la réponse — pas vide : absente.
        if (!mayCall(role, COLLECTION_CHANNEL[collection])) continue;
        const rows = store.db[collection] as ({ rev?: number } & { id: ID })[];
        changes[collection] = full
          ? [...rows]
          : rows.filter((row) => (row.rev ?? 0) > since);
        if (!full) {
          const graves = sync.tombstones[collection] ?? [];
          const ids = graves.filter((g) => g.rev > since).map((g) => g.id);
          if (ids.length) removed[collection] = ids;
        }
      }

      const settingsChanged = full || (sync.settingsRev ?? 0) > since;
      return {
        generation: sync.generation,
        maxRev: sync.maxRev,
        role,
        identity,
        full,
        changes,
        removed,
        ...(settingsChanged && mayCall(role, 'settings:get')
          ? { settings: store.settings }
          : {}),
      };
    },

    /* L'état de la file d'attente vit sur le poste, pas ici. */
    async status(): Promise<never> {
      localOnly();
    },
    async retry(): Promise<never> {
      localOnly();
    },
    async discard(): Promise<never> {
      localOnly();
    },
  },
};

/* ------------------------------------------------------------------ */
/* Construction d'e-mail partagée bureau / serveur                     */
/* ------------------------------------------------------------------ */

export function buildDocumentEml(doc: AccountingDocument, draft: EmailDraft) {
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

  return { ...built, fileCount: files.length };
}

export function markDocumentEmailed(doc: AccountingDocument): void {
  store.mutate(() => {
    doc.emailedAt = nowIso();
    doc.updatedAt = nowIso();
  });
  store.flushSync();
}

/** Fusionne le registre partagé avec les surcharges propres à un hôte. */
export function mergeRegistries(base: Registry, overlay: Registry): Registry {
  const merged: Registry = {};
  for (const namespace of Object.keys(base)) {
    merged[namespace] = { ...base[namespace], ...(overlay[namespace] ?? {}) };
  }
  for (const namespace of Object.keys(overlay)) {
    if (!merged[namespace]) merged[namespace] = { ...overlay[namespace] };
  }
  return merged;
}
