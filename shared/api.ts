import type {
  AccountingDocument,
  Address,
  AddressSuggestion,
  Attachment,
  BankImportReport,
  BankDedupeReport,
  BankDuplicateGroup,
  BankMatchSuggestion,
  BankScanReport,
  BankSummary,
  BankTransaction,
  Client,
  DashboardStats,
  Database,
  DeliveryRoute,
  EmailDraft,
  EventMachine,
  ID,
  ImportClientsReport,
  OptimizeOptions,
  OptimizeResult,
  MachineAvailability,
  Product,
  RegisterEntry,
  RegisterStatus,
  Role,
  Session,
  SyncedCollection,
  UserSummary,
  RouteComputation,
  RouteStop,
  ScanReport,
  Settings,
  StockApplyReport,
  StockMove,
  Task,
  TaskStatus,
  Vehicle,
} from './types';

/**
 * Liste des canaux IPC. Le preload génère `window.api` à partir de cette
 * structure, ce qui garantit que l'interface TypeScript ci-dessous et les
 * canaux réellement exposés ne peuvent pas diverger.
 */
export const CHANNELS = {
  app: [
    'info', 'openPath', 'openExternal', 'chooseFolder', 'chooseFile', 'revealFile', 'quit',
    'relaunch', 'connection', 'setConnection',
  ],
  settings: ['get', 'update', 'resetFolder'],
  clients: ['list', 'save', 'remove', 'importFrom', 'pickAndImport', 'exportCsv', 'merge', 'geocodeMissing', 'forgetAliases'],
  documents: [
    'list', 'get', 'save', 'remove', 'scan', 'rescanFile', 'setClient', 'setStatus', 'exportCsv',
    'openFile', 'print', 'setPrinted', 'prepareEmail', 'sendEmail', 'addFiles', 'pickAndAdd',
  ],
  attachments: ['list', 'pickAndAdd', 'addFiles', 'update', 'remove', 'open', 'sync', 'openFolder'],
  products: ['list', 'save', 'remove', 'importFrom', 'pickAndImport', 'exportCsv', 'adjust'],
  stock: ['moves', 'apply', 'revert', 'applyAll', 'linkLine', 'suggestions'],
  routes: ['list', 'save', 'remove', 'compute', 'optimize', 'link', 'qr', 'exportCsv'],
  vehicles: ['list', 'save', 'remove'],
  registers: ['list', 'save', 'remove', 'setStatus', 'addToRoute'],
  machines: ['list', 'save', 'remove'],
  tasks: ['list', 'save', 'remove', 'restore', 'purge', 'setStatus', 'people'],
  notify: ['test'],
  bank: [
    'list', 'scan', 'pickAndImport', 'importFrom', 'update', 'remove', 'suggestions',
    'reconcile', 'autoReconcile', 'summary', 'exportCsv', 'openFolder', 'chooseFolder',
    'duplicates', 'mergeDuplicates',
  ],
  geo: ['autocomplete', 'reverse', 'fuelPrice'],
  stats: ['dashboard'],
  db: ['backup', 'restore', 'exportAll', 'stats', 'seedDemo', 'wipeDemo'],
  updates: ['check', 'apply'],
  auth: ['status', 'login', 'logout', 'me', 'changePassword', 'users', 'saveUser', 'removeUser', 'sessions', 'revokeSession'],
  sync: ['pull', 'status', 'retry', 'discard'],
  folders: ['list', 'save', 'remove', 'syncNow', 'pick'],
} as const;

export type ChannelMap = typeof CHANNELS;

/** `"clients:list"`, `"bank:summary"`… — tous les canaux, un par un. */
export type ChannelName = {
  [N in keyof ChannelMap]: `${N & string}:${ChannelMap[N][number] & string}`;
}[keyof ChannelMap];

/**
 * Qui a le droit d'appeler quoi.
 *
 * Le type `Record<ChannelName, …>` est ce qui compte ici : **ajouter un canal
 * sans le classer fait échouer `npm run typecheck`**. Ce n'est donc pas une
 * discipline à tenir, c'est une impossibilité — la seule façon fiable de ne pas
 * ouvrir un trou en ajoutant une fonctionnalité.
 *
 * Une liste vide signifie « personne » : le canal n'est jamais joignable à
 * distance (gestes propres au poste, arrêt du serveur…).
 *
 * Deux classements méritent qu'on s'y arrête :
 *
 * - Le **tableau de bord** est refusé au livreur. Il a l'air anodin, mais il
 *   expose le chiffre d'affaires et les meilleurs clients.
 * - Les fonctions de **démonstration et d'effacement** sont réservées au
 *   gérant : elles détruisent des données.
 */
const ALL: readonly Role[] = ['gerant', 'bureau', 'livreur'];
const BUREAU: readonly Role[] = ['gerant', 'bureau'];
const GERANT: readonly Role[] = ['gerant'];
/** Réservé au poste : jamais servi à distance, quel que soit le rôle. */
const LOCAL: readonly Role[] = [];

export const CHANNEL_ACCESS: Record<ChannelName, readonly Role[]> = {
  /* Application ------------------------------------------------------ */
  'app:info': ALL,
  'app:openPath': LOCAL,
  'app:openExternal': LOCAL,
  'app:chooseFolder': LOCAL,
  'app:chooseFile': LOCAL,
  'app:revealFile': LOCAL,
  'app:quit': LOCAL,
  'app:relaunch': GERANT,
  'app:connection': LOCAL,
  'app:setConnection': LOCAL,

  /* Réglages de l'entreprise ----------------------------------------- */
  'settings:get': ALL,
  'settings:update': GERANT,
  'settings:resetFolder': GERANT,

  /* Clients — le livreur les lit pour retrouver ses arrêts ------------ */
  'clients:list': ALL,
  'clients:save': BUREAU,
  'clients:remove': BUREAU,
  'clients:importFrom': BUREAU,
  'clients:pickAndImport': BUREAU,
  'clients:exportCsv': BUREAU,
  'clients:merge': BUREAU,
  'clients:geocodeMissing': BUREAU,
  'clients:forgetAliases': BUREAU,

  /* Documents comptables --------------------------------------------- */
  'documents:list': BUREAU,
  'documents:get': BUREAU,
  'documents:save': BUREAU,
  'documents:remove': BUREAU,
  'documents:scan': BUREAU,
  'documents:rescanFile': BUREAU,
  'documents:setClient': BUREAU,
  'documents:setStatus': BUREAU,
  'documents:exportCsv': BUREAU,
  'documents:openFile': BUREAU,
  'documents:print': BUREAU,
  'documents:setPrinted': BUREAU,
  'documents:prepareEmail': BUREAU,
  'documents:sendEmail': BUREAU,
  'documents:addFiles': BUREAU,
  'documents:pickAndAdd': BUREAU,

  /* Pièces jointes ---------------------------------------------------- */
  'attachments:list': BUREAU,
  'attachments:pickAndAdd': BUREAU,
  'attachments:addFiles': BUREAU,
  'attachments:update': BUREAU,
  'attachments:remove': BUREAU,
  'attachments:open': BUREAU,
  'attachments:sync': BUREAU,
  'attachments:openFolder': LOCAL,

  /* Stock ------------------------------------------------------------- */
  'products:list': BUREAU,
  'products:save': BUREAU,
  'products:remove': BUREAU,
  'products:importFrom': BUREAU,
  'products:pickAndImport': BUREAU,
  'products:exportCsv': BUREAU,
  'products:adjust': BUREAU,
  'stock:moves': BUREAU,
  'stock:apply': BUREAU,
  'stock:revert': BUREAU,
  'stock:applyAll': BUREAU,
  'stock:linkLine': BUREAU,
  'stock:suggestions': BUREAU,

  /* Tournées — le cœur du métier du livreur --------------------------- */
  'routes:list': ALL,
  'routes:save': ALL,
  'routes:remove': BUREAU,
  'routes:compute': ALL,
  'routes:optimize': ALL,
  'routes:link': ALL,
  'routes:qr': ALL,
  'routes:exportCsv': ALL,
  'vehicles:list': ALL,
  'vehicles:save': BUREAU,
  'vehicles:remove': BUREAU,

  /* Cahiers ----------------------------------------------------------- */
  'registers:list': BUREAU,
  'registers:save': BUREAU,
  'registers:remove': BUREAU,
  'registers:setStatus': BUREAU,
  'registers:addToRoute': BUREAU,
  'machines:list': BUREAU,
  'machines:save': BUREAU,
  'machines:remove': BUREAU,

  /* Tâches — suivi des clients et du quotidien -------------------------- */
  // `remove` n'est qu'une mise à la corbeille : la vraie destruction, c'est
  // `purge`. Les deux restent au bureau — les tâches peuvent porter des
  // montants et des relances, pas de quoi les répliquer chez le livreur.
  'tasks:list': BUREAU,
  'tasks:save': BUREAU,
  'tasks:remove': BUREAU,
  'tasks:restore': BUREAU,
  'tasks:purge': BUREAU,
  'tasks:setStatus': BUREAU,
  // Noms affichés des comptes actifs, rien d'autre : de quoi confier une
  // tâche sans ouvrir la gestion des comptes, réservée au gérant.
  'tasks:people': BUREAU,

  /* Divers ------------------------------------------------------------ */
  'notify:test': BUREAU,
  'geo:autocomplete': ALL,
  'geo:reverse': ALL,
  'geo:fuelPrice': ALL,

  /* Banque — jamais pour le livreur ----------------------------------- */
  'bank:list': BUREAU,
  'bank:scan': BUREAU,
  'bank:pickAndImport': BUREAU,
  'bank:importFrom': BUREAU,
  'bank:update': BUREAU,
  'bank:remove': BUREAU,
  'bank:suggestions': BUREAU,
  'bank:reconcile': BUREAU,
  'bank:autoReconcile': BUREAU,
  'bank:summary': BUREAU,
  'bank:exportCsv': BUREAU,
  'bank:openFolder': LOCAL,
  'bank:chooseFolder': LOCAL,
  'bank:duplicates': BUREAU,
  'bank:mergeDuplicates': BUREAU,

  /* Tableau de bord — chiffre d'affaires et meilleurs clients ---------- */
  'stats:dashboard': BUREAU,

  /* Base de données --------------------------------------------------- */
  'db:backup': GERANT,
  'db:restore': GERANT,
  'db:exportAll': GERANT,
  'db:stats': GERANT,
  'db:seedDemo': GERANT,
  'db:wipeDemo': GERANT,
  'updates:check': GERANT,
  'updates:apply': GERANT,

  /* Comptes ------------------------------------------------------------ */
  // `status` et `login` répondent forcément avant toute connexion : c'est
  // l'aiguillage qui les laisse passer sans session, pas cette table.
  'auth:status': ALL,
  'auth:login': ALL,
  'auth:logout': ALL,
  'auth:me': ALL,
  'auth:changePassword': ALL,
  'auth:users': GERANT,
  'auth:saveUser': GERANT,
  'auth:removeUser': GERANT,
  'auth:sessions': GERANT,
  'auth:revokeSession': GERANT,

  /* Synchronisation ---------------------------------------------------- */
  // `pull` est ouvert à tous les rôles : c'est le mécanisme de réplication,
  // et il filtre lui-même collection par collection selon le rôle.
  'sync:pull': ALL,
  // L'état de la file d'attente appartient au poste, pas au serveur.
  'sync:status': LOCAL,
  'sync:retry': LOCAL,
  'sync:discard': LOCAL,

  // Les dossiers surveillés désignent des chemins de **cette machine** :
  // `D:\Compta\Factures` n'existe pas sur le serveur, et le navigateur n'a
  // aucun disque à proposer. Ces canaux ne sortent donc jamais du poste.
  'folders:list': LOCAL,
  'folders:save': LOCAL,
  'folders:remove': LOCAL,
  'folders:syncNow': LOCAL,
  'folders:pick': LOCAL,
};

/** Ce rôle peut-il appeler ce canal ? */
export function mayCall(role: Role, channel: string): boolean {
  const allowed = CHANNEL_ACCESS[channel as ChannelName];
  return Boolean(allowed?.includes(role));
}

/**
 * Le canal qui gouverne la réplication de chaque collection. Le filtre
 * s'applique **à la source** : le miroir d'un livreur ne contient jamais les
 * données bancaires ni les documents — les cacher à l'écran ne protégerait
 * rien, le fichier local étant lisible sur l'appareil.
 */
export const COLLECTION_CHANNEL: Record<SyncedCollection, ChannelName> = {
  clients: 'clients:list',
  documents: 'documents:list',
  products: 'products:list',
  stockMoves: 'stock:moves',
  routes: 'routes:list',
  vehicles: 'vehicles:list',
  attachments: 'attachments:list',
  bankTransactions: 'bank:list',
  registerEntries: 'registers:list',
  eventMachines: 'machines:list',
  tasks: 'tasks:list',
};

/** Type d'un dossier surveillé : trois types de pièces, plus les relevés. */
export type UploadFolderKind = 'invoice' | 'quote' | 'credit' | 'statement';

export interface UploadFolder {
  id: string;
  path: string;
  kind: UploadFolderKind;
}

export interface UploadSummary {
  sent: number;
  failed: { file: string; error: string }[];
  /** Serveur injoignable : ce qui reste partira au passage suivant. */
  offline: boolean;
}

export interface AppInfo {
  version: string;
  /**
   * Le commit d'où tourne cette copie, et sa date. Le numéro de version, lui,
   * ne bouge pas d'une mise à jour à l'autre : sans cette ligne, rien ne
   * distingue un poste à jour d'un poste resté en arrière.
   */
  build?: string;
  /**
   * Le commit du **serveur**, quand ce poste y est branché. Chaque machine
   * exécute sa propre copie du logiciel : mettre le serveur à jour ne met pas
   * les postes à jour, et l'inverse non plus. Sans afficher les deux, un poste
   * resté en arrière est indiscernable d'un poste à jour — on cherche une
   * nouveauté qui ne peut pas apparaître.
   */
  serverBuild?: string;
  /**
   * Le dossier d'où s'exécute le logiciel. Une machine peut porter plusieurs
   * copies du dépôt : on en met une à jour, on en lance une autre, et rien ne
   * change jamais à l'écran sans qu'aucun message ne l'explique. Afficher ce
   * chemin rend la confusion impossible à tenir plus de trois secondes.
   */
  appPath?: string;
  electron: string;
  node: string;
  /** `win32`, `darwin`, `linux` — ou le système du téléphone en mode mobile. */
  platform: string;
  userDataPath: string;
  watchFolder: string;
  documentsPath: string;
  isPackaged: boolean;
  /**
   * Le dossier surveillé est-il situé à l'intérieur du dossier du logiciel ?
   * Les documents se mêlent alors au code : à signaler pour inviter à les
   * séparer.
   */
  watchFolderInsideApp?: boolean;
  /**
   * D'où viennent les données affichées :
   * - `local`  : application de bureau sur sa propre base ;
   * - `remote` : application de bureau branchée sur un serveur ;
   * - `server` : interface web servie par le serveur.
   */
  mode: DataMode;
  /**
   * Les dossiers désignés (surveillé, relevés, pièces jointes) sont-ils sur
   * cette machine ? Sinon ils se saisissent au clavier et ne s'ouvrent pas ici.
   */
  localFolders: boolean;
}

export type DataMode = 'local' | 'remote' | 'server';

/** Réglage de liaison au serveur, propre à cet appareil (jamais synchronisé). */
export interface Connection {
  /** Adresse du serveur, vide en mode local. */
  serverUrl: string;
  /** Jeton d'accès ; jamais renvoyé à l'interface, seule sa présence l'est. */
  hasToken: boolean;
  mode: DataMode;
  /** Le serveur répond-il ? Renseigné après un test. */
  reachable?: boolean;
  /** Détail de l'échec quand le serveur ne répond pas. */
  error?: string;
  /** Le serveur exige-t-il une connexion par compte ? */
  authRequired?: boolean;
  /** La session enregistrée sur ce poste est-elle encore valable ? */
  authenticated?: boolean;
  identity?: AuthIdentity | null;
}

export interface RouteQr {
  provider: 'google' | 'waze' | 'apple';
  url: string;
  /** Data-URL PNG du QR code à scanner avec le téléphone. */
  qrDataUrl: string;
  /** Découpage en plusieurs liens si la tournée dépasse la limite du fournisseur. */
  segments: { url: string; qrDataUrl: string; from: string; to: string; stops: number }[];
  warning?: string;
}

export interface UpdateCheckResult {
  supported: boolean;
  reason?: string;
  branch?: string;
  currentCommit?: string;
  remoteCommit?: string;
  available: boolean;
  behind: number;
  changes: string[];
}

export interface UpdateApplyResult {
  success: boolean;
  message: string;
  log: string;
  /** Fichiers du logiciel modifiés localement ayant bloqué la mise à jour. */
  localChanges?: string[];
}

export interface PrintOutcome {
  printed: boolean;
  method: 'dialog' | 'viewer';
  message: string;
}

/** Brouillon pré-rempli proposé à l'utilisateur avant envoi. */
export interface EmailPreparation {
  draft: EmailDraft;
  /** Pièces jointes disponibles, celles cochées par défaut en premier. */
  attachments: (Attachment & { exists: boolean })[];
  /** Le document lui-même peut-il être joint ? */
  documentAttachable: boolean;
  documentFileName?: string;
  clientName?: string;
  warning?: string;
}

export interface EmailOutcome {
  sent: boolean;
  method: 'eml' | 'mailto';
  message: string;
  /** Taille totale des pièces jointes, en Mo. */
  attachmentMb: number;
  /**
   * En mode navigateur, le brouillon .eml est préparé sur le serveur : cette
   * adresse permet de le télécharger pour l'ouvrir dans sa messagerie.
   */
  fileUrl?: string;
}

/** État de l'authentification, consultable avant toute connexion. */
export interface AuthStatus {
  /** Des comptes existent-ils ? Sinon le serveur reste au jeton partagé. */
  configured: boolean;
  /** Une session est-elle exigée pour aller plus loin ? */
  required: boolean;
  /** Identité en cours, si une session est ouverte. */
  identity: AuthIdentity | null;
  /**
   * L'appelant peut-il travailler en l'état ?
   *
   * Distinct de `identity` : en jeton partagé il n'y a pas d'identité, mais un
   * jeton correct suffit. C'est ce drapeau qui permet à un poste de distinguer
   * « il me manque un mot de passe » de « mon jeton est mauvais » — deux
   * situations qu'un simple « serveur joignable » confondrait.
   */
  authorized: boolean;
}

export interface AuthIdentity {
  userId: ID;
  username: string;
  displayName: string;
  role: Role;
}

export interface LoginOutcome {
  identity: AuthIdentity;
  /** Jeton de session à présenter ensuite. Remis une seule fois. */
  token: string;
  expiresAt: string;
}

export interface ProductSuggestion {
  product: Product;
  score: number;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Synchronisation                                                      */
/* ------------------------------------------------------------------ */

export interface SyncPullRequest {
  /** Génération connue de l'appareil ; absente ou différente → base complète. */
  generation?: string;
  /** Dernière révision connue de l'appareil. */
  since?: number;
}

/**
 * Delta descendu du serveur : les enregistrements modifiés, tels quels. Le
 * poste n'a **aucune logique de fusion** — il remplace, il supprime, c'est
 * tout. Toute la résolution de conflits vit côté serveur, dans les
 * gestionnaires qui rejouent les intentions.
 */
export interface SyncPullResult {
  generation: string;
  maxRev: number;
  /** Rôle et identité vus par le serveur, mémorisés dans le miroir. */
  role: Role;
  identity: AuthIdentity | null;
  /**
   * `true` : repartir de zéro (première synchro, génération changée, retard
   * au-delà des pierres tombales conservées, ou rôle différent).
   */
  full: boolean;
  /** Enregistrements nouveaux ou modifiés, par collection autorisée au rôle. */
  changes: Partial<Record<SyncedCollection, unknown[]>>;
  /** Identifiants supprimés depuis `since`, par collection. */
  removed: Partial<Record<SyncedCollection, ID[]>>;
  /** Réglages, quand ils ont changé (ou en synchro complète). */
  settings?: Settings;
}

/** Une intention en attente de rejeu sur le serveur. */
export interface QueuedIntent {
  id: ID;
  at: string;
  namespace: string;
  method: string;
  args: unknown[];
  /** Renseigné quand le rejeu a échoué pour une raison métier. */
  error?: string;
}

export interface SyncStatus {
  /** Le serveur répond-il en ce moment ? */
  online: boolean;
  /** Dernière révision répliquée dans le miroir. */
  since: number;
  lastPullAt?: string;
  /** Intentions en attente de rejeu, dans l'ordre. */
  pending: QueuedIntent[];
  /** Rejeux refusés par le serveur, à arbitrer par l'utilisateur. */
  failed: QueuedIntent[];
}

export interface Api {
  app: {
    info(): Promise<AppInfo>;
    openPath(target: string): Promise<string>;
    openExternal(url: string): Promise<void>;
    chooseFolder(current?: string): Promise<string | null>;
    chooseFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
    revealFile(target: string): Promise<void>;
    quit(): Promise<void>;
    /** Ferme puis relance l'application (utilisé après une mise à jour). */
    relaunch(): Promise<void>;
    /** Liaison actuelle au serveur. */
    connection(): Promise<Connection>;
    /**
     * Enregistre l'adresse du serveur pour cet appareil. Une adresse vide
     * repasse en local. Le changement prend effet au redémarrage.
     */
    setConnection(input: { serverUrl: string; token?: string }): Promise<Connection>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
    resetFolder(): Promise<Settings>;
  };
  clients: {
    list(): Promise<Client[]>;
    save(client: Partial<Client> & { id?: ID }): Promise<Client>;
    remove(id: ID): Promise<void>;
    importFrom(filePath: string, mapping?: Record<string, string>): Promise<ImportClientsReport>;
    pickAndImport(): Promise<ImportClientsReport | null>;
    exportCsv(): Promise<string | null>;
    merge(keepId: ID, mergeId: ID): Promise<Client>;
    /** Recherche les coordonnées GPS des fiches qui n'en ont pas encore. */
    geocodeMissing(): Promise<{ processed: number; located: number; failed: number }>;
    /**
     * Efface les orthographes mémorisées sur les fiches clients.
     *
     * Elles étaient apprises automatiquement à chaque rapprochement par
     * ressemblance — une hypothèse inscrite comme certitude, qui attirait
     * ensuite les pièces suivantes vers la même fiche. Ce mécanisme est retiré,
     * mais les orthographes déjà enregistrées continuent d'agir : voici de quoi
     * les oublier.
     */
    forgetAliases(): Promise<{ clients: number; aliases: number }>;
  };
  documents: {
    list(): Promise<AccountingDocument[]>;
    get(id: ID): Promise<AccountingDocument | null>;
    save(doc: Partial<AccountingDocument> & { id?: ID }): Promise<AccountingDocument>;
    remove(id: ID): Promise<void>;
    scan(options?: { force?: boolean }): Promise<ScanReport>;
    rescanFile(filePath: string): Promise<AccountingDocument | null>;
    setClient(documentId: ID, clientId: ID | null): Promise<AccountingDocument>;
    setStatus(documentId: ID, status: AccountingDocument['status']): Promise<AccountingDocument>;
    exportCsv(): Promise<string | null>;
    /** Ouvre le fichier d'origine dans l'application par défaut. */
    openFile(documentId: ID): Promise<void>;
    print(documentId: ID): Promise<PrintOutcome>;
    /** Coche ou décoche manuellement le repère « imprimé ». */
    setPrinted(documentId: ID, printed: boolean): Promise<AccountingDocument>;
    prepareEmail(documentId: ID): Promise<EmailPreparation>;
    sendEmail(documentId: ID, draft: EmailDraft): Promise<EmailOutcome>;
    /**
     * Range des fichiers dans le dossier surveillé puis les analyse. C'est le
     * dépôt « par l'application » : glisser-déposer ou bouton, sans passer par
     * un partage réseau. En mode branché, les fichiers partent au serveur.
     */
    addFiles(filePaths: string[]): Promise<AccountingDocument[]>;
    /** Ouvre un sélecteur de fichiers puis fait le dépôt ci-dessus. */
    pickAndAdd(): Promise<AccountingDocument[] | null>;
  };
  attachments: {
    list(): Promise<(Attachment & { exists: boolean })[]>;
    pickAndAdd(): Promise<Attachment[] | null>;
    /** Ajoute des fichiers déjà présents sur le disque (téléversement navigateur). */
    addFiles(filePaths: string[]): Promise<Attachment[]>;
    update(id: ID, patch: Partial<Attachment>): Promise<Attachment>;
    remove(id: ID): Promise<void>;
    open(id: ID): Promise<void>;
    sync(): Promise<{ added: number; missing: number }>;
    openFolder(): Promise<void>;
  };
  products: {
    list(): Promise<Product[]>;
    save(product: Partial<Product> & { id?: ID }): Promise<Product>;
    remove(id: ID): Promise<void>;
    importFrom(filePath: string): Promise<{ created: number; updated: number; errors: string[] }>;
    pickAndImport(): Promise<{ created: number; updated: number; errors: string[] } | null>;
    exportCsv(): Promise<string | null>;
    adjust(productId: ID, qty: number, note?: string): Promise<Product>;
  };
  stock: {
    moves(productId?: ID): Promise<StockMove[]>;
    apply(documentId: ID): Promise<StockApplyReport>;
    revert(documentId: ID): Promise<StockApplyReport>;
    applyAll(): Promise<{ applied: number; reports: StockApplyReport[] }>;
    linkLine(documentId: ID, lineId: ID, productId: ID | null): Promise<AccountingDocument>;
    suggestions(label: string, ref?: string): Promise<ProductSuggestion[]>;
  };
  routes: {
    list(): Promise<DeliveryRoute[]>;
    save(route: Partial<DeliveryRoute> & { id?: ID }): Promise<DeliveryRoute>;
    remove(id: ID): Promise<void>;
    compute(route: DeliveryRoute): Promise<{ route: DeliveryRoute; computation: RouteComputation }>;
    optimize(
      route: DeliveryRoute,
      options?: OptimizeOptions,
    ): Promise<{ route: DeliveryRoute; result: OptimizeResult; computation: RouteComputation }>;
    link(route: DeliveryRoute, provider: 'google' | 'waze' | 'apple'): Promise<RouteQr>;
    qr(text: string): Promise<string>;
    exportCsv(routeId: ID): Promise<string | null>;
  };
  vehicles: {
    list(): Promise<Vehicle[]>;
    save(vehicle: Partial<Vehicle> & { id?: ID }): Promise<Vehicle>;
    remove(id: ID): Promise<void>;
  };
  registers: {
    list(): Promise<RegisterEntry[]>;
    save(entry: Partial<RegisterEntry> & { id?: ID }): Promise<RegisterEntry>;
    remove(id: ID): Promise<void>;
    /** Passer un devis événementiel en « validé » réserve les machines. */
    setStatus(id: ID, status: RegisterStatus): Promise<RegisterEntry>;
    /** Ajoute l'écriture comme arrêt d'une tournée ; sans `routeId`, en crée une. */
    addToRoute(entryId: ID, routeId?: ID): Promise<{ route: DeliveryRoute; entry: RegisterEntry }>;
  };
  machines: {
    /** Parc avec disponibilité calculée et prochaines sorties. */
    list(): Promise<MachineAvailability[]>;
    save(machine: Partial<EventMachine> & { id?: ID }): Promise<EventMachine>;
    remove(id: ID): Promise<void>;
  };
  tasks: {
    /** Toutes les tâches, corbeille comprise (repérable à `deletedAt`). */
    list(): Promise<Task[]>;
    save(task: Partial<Task> & { id?: ID }): Promise<Task>;
    /** Met à la corbeille — rien n'est perdu, `restore` défait le geste. */
    remove(id: ID): Promise<Task>;
    restore(id: ID): Promise<Task>;
    /** Efface pour de bon une tâche de la corbeille (ou toute la corbeille sans id). */
    purge(id?: ID): Promise<{ purged: number }>;
    setStatus(id: ID, status: TaskStatus): Promise<Task>;
    /** Comptes actifs (id + nom affiché), pour confier une tâche. */
    people(): Promise<{ id: ID; displayName: string }[]>;
  };
  notify: {
    /** Envoie une notification d'essai sur le sujet configuré. */
    test(): Promise<boolean>;
  };
  bank: {
    list(): Promise<BankTransaction[]>;
    /** Analyse le dossier des relevés ; les opérations déjà connues sont ignorées. */
    scan(): Promise<BankScanReport>;
    pickAndImport(): Promise<BankImportReport | null>;
    /** Importe un relevé dont le fichier est déjà sur le disque (téléversement navigateur). */
    importFrom(filePath: string): Promise<BankImportReport>;
    update(id: ID, patch: Partial<BankTransaction>): Promise<BankTransaction>;
    remove(id: ID): Promise<void>;
    /** Factures candidates pour le rapprochement, les plus probables d'abord. */
    suggestions(transactionId: ID): Promise<BankMatchSuggestion[]>;
    reconcile(transactionId: ID, documentId: ID | null): Promise<BankTransaction>;
    autoReconcile(): Promise<{ matched: number; ambiguous: number }>;
    summary(): Promise<BankSummary>;
    exportCsv(): Promise<string | null>;
    openFolder(): Promise<void>;
    /** Choisit le dossier où sont rangés les relevés. */
    chooseFolder(): Promise<string | null>;
    /** Opérations enregistrées deux fois sous des libellés différents. */
    duplicates(): Promise<BankDuplicateGroup[]>;
    /** Supprime ces doublons en reportant ce qu'ils portaient sur la copie gardée. */
    mergeDuplicates(): Promise<BankDedupeReport>;
  };
  geo: {
    autocomplete(query: string, options?: { near?: { lat: number; lon: number } }): Promise<AddressSuggestion[]>;
    reverse(lat: number, lon: number): Promise<Address | null>;
    fuelPrice(
      fuelType: Vehicle['fuelType'],
      postcode?: string,
    ): Promise<{ price: number; source: string; updatedAt: string; station?: string } | null>;
  };
  stats: {
    dashboard(): Promise<DashboardStats>;
  };
  db: {
    backup(): Promise<string>;
    restore(filePath?: string): Promise<boolean>;
    exportAll(): Promise<string | null>;
    stats(): Promise<{ file: string; sizeKb: number; counts: Record<keyof Omit<Database, 'version' | 'settings'>, number> }>;
    seedDemo(): Promise<void>;
    wipeDemo(): Promise<void>;
  };
  updates: {
    check(): Promise<UpdateCheckResult>;
    /**
     * `discardLocalChanges` rétablit les fichiers du logiciel modifiés sur ce
     * poste avant d'installer. Sans conséquence sur les données.
     */
    apply(options?: { discardLocalChanges?: boolean }): Promise<UpdateApplyResult>;
  };
  auth: {
    /** Interrogeable sans être connecté : y a-t-il des comptes, faut-il ouvrir une session ? */
    status(): Promise<AuthStatus>;
    /**
     * `device: true` ouvre une session longue (180 jours), pour un téléphone :
     * personne ne tape un mot de passe à 6 h du matin dans une camionnette.
     */
    login(input: { username: string; password: string; label?: string; device?: boolean }): Promise<LoginOutcome>;
    logout(): Promise<void>;
    /** Qui suis-je ? `null` quand aucune session n'est ouverte. */
    me(): Promise<AuthIdentity | null>;
    changePassword(input: { current: string; next: string }): Promise<void>;
    users(): Promise<UserSummary[]>;
    /**
     * Crée ou modifie un compte. Le mot de passe n'est écrit que s'il est
     * fourni ; l'omettre laisse l'ancien en place.
     */
    saveUser(input: {
      id?: ID;
      username: string;
      displayName: string;
      role: Role;
      password?: string;
      disabled?: boolean;
    }): Promise<UserSummary>;
    removeUser(id: ID): Promise<void>;
    sessions(): Promise<(Session & { username: string })[]>;
    revokeSession(id: ID): Promise<void>;
  };
  sync: {
    /** Delta depuis la révision connue — ou base complète s'il le faut. */
    pull(input?: SyncPullRequest): Promise<SyncPullResult>;
    /** État du miroir et de la file d'attente de ce poste. */
    status(): Promise<SyncStatus>;
    /** Rejoue la file d'attente maintenant (et resynchronise). */
    retry(): Promise<SyncStatus>;
    /** Abandonne une intention dont le rejeu a échoué. */
    discard(intentId: ID): Promise<SyncStatus>;
  };
  /**
   * Dossiers de ce poste surveillés et envoyés au serveur : le logiciel de
   * comptabilité y dépose ses pièces, elles montent toutes seules.
   */
  folders: {
    list(): Promise<UploadFolder[]>;
    save(input: { id?: string; path: string; kind: UploadFolderKind }): Promise<UploadFolder[]>;
    remove(id: string): Promise<UploadFolder[]>;
    /** Passage immédiat, sans attendre la surveillance. */
    syncNow(): Promise<UploadSummary>;
    /** Ouvre le sélecteur de dossier du poste. */
    pick(current?: string): Promise<string | null>;
  };
  /** Événements poussés par le processus principal (scan de dossier, alertes…). */
  /**
   * `session-lost` et `go-to-page` ne sont poussés que par le bureau branché :
   * le premier parce que le navigateur lit ce cas dans la réponse HTTP, le
   * second parce qu'il vient d'un clic sur une notification du système, que
   * seul le processus principal reçoit.
   */
  on(
    event: 'documents-changed' | 'scan-progress' | 'toast' | 'session-lost' | 'go-to-page',
    handler: (payload: any) => void,
  ): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
  /**
   * Le commit d'où sort le bundle en cours d'exécution, gravé à la compilation
   * (voir `vite.config.ts`). Chaîne vide quand la compilation s'est faite hors
   * d'un dépôt git.
   */
  const __BUILD_COMMIT__: string;
}

export type { RouteStop };
