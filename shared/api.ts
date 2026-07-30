import type {
  AccountingDocument,
  Address,
  AddressSuggestion,
  Attachment,
  Client,
  DashboardStats,
  Database,
  DeliveryRoute,
  EmailDraft,
  ID,
  ImportClientsReport,
  OptimizeOptions,
  OptimizeResult,
  Product,
  RouteComputation,
  RouteStop,
  ScanReport,
  Settings,
  StockApplyReport,
  StockMove,
  Vehicle,
} from './types';

/**
 * Liste des canaux IPC. Le preload génère `window.api` à partir de cette
 * structure, ce qui garantit que l'interface TypeScript ci-dessous et les
 * canaux réellement exposés ne peuvent pas diverger.
 */
export const CHANNELS = {
  app: ['info', 'openPath', 'openExternal', 'chooseFolder', 'chooseFile', 'revealFile', 'quit'],
  settings: ['get', 'update', 'resetFolder'],
  clients: ['list', 'save', 'remove', 'importFrom', 'pickAndImport', 'exportCsv', 'merge', 'geocodeMissing'],
  documents: [
    'list', 'get', 'save', 'remove', 'scan', 'rescanFile', 'setClient', 'setStatus', 'exportCsv',
    'openFile', 'print', 'setPrinted', 'prepareEmail', 'sendEmail',
  ],
  attachments: ['list', 'pickAndAdd', 'update', 'remove', 'open', 'sync', 'openFolder'],
  products: ['list', 'save', 'remove', 'importFrom', 'pickAndImport', 'exportCsv', 'adjust'],
  stock: ['moves', 'apply', 'revert', 'applyAll', 'linkLine', 'suggestions'],
  routes: ['list', 'save', 'remove', 'compute', 'optimize', 'link', 'qr', 'exportCsv'],
  vehicles: ['list', 'save', 'remove'],
  geo: ['autocomplete', 'reverse', 'fuelPrice'],
  stats: ['dashboard'],
  db: ['backup', 'restore', 'exportAll', 'stats', 'seedDemo', 'wipeDemo'],
} as const;

export type ChannelMap = typeof CHANNELS;

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  platform: NodeJS.Platform;
  userDataPath: string;
  watchFolder: string;
  documentsPath: string;
  isPackaged: boolean;
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
}

export interface ProductSuggestion {
  product: Product;
  score: number;
  reason: string;
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
  };
  attachments: {
    list(): Promise<(Attachment & { exists: boolean })[]>;
    pickAndAdd(): Promise<Attachment[] | null>;
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
  /** Événements poussés par le processus principal (scan de dossier, alertes…). */
  on(event: 'documents-changed' | 'scan-progress' | 'toast', handler: (payload: any) => void): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export type { RouteStop };
