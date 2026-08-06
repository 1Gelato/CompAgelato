/**
 * Modèle de données CompaGelato — partagé entre le processus principal (Electron)
 * et l'interface (React). Aucune dépendance externe ici.
 */

export type ID = string;

export type DocumentKind = 'invoice' | 'quote' | 'credit';

export type DocumentStatus =
  | 'draft' // importé mais non validé par l'utilisateur
  | 'confirmed' // validé — le stock a pu être déduit
  | 'paid'
  | 'cancelled';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface Address {
  label: string; // adresse complète en une ligne
  street?: string;
  postcode?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

export interface Client {
  id: ID;
  code: string; // référence interne, ex: "CLI-0007"
  name: string;
  legalName?: string;
  contact?: string;
  email?: string;
  phone?: string;
  siret?: string;
  vatNumber?: string;
  address: Address;
  notes?: string;
  tags: string[];
  /** Autres orthographes rencontrées dans les documents comptables. */
  aliases: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentLine {
  id: ID;
  ref?: string; // référence produit lue sur le document
  label: string;
  qty: number;
  unit?: string;
  unitPriceHT?: number;
  totalHT?: number;
  vatRate?: number;
  /** Produit du stock associé (résolu automatiquement ou manuellement). */
  productId?: ID;
  /** Comment l'association a été faite. */
  matchMethod?: 'sku' | 'alias' | 'fuzzy' | 'manual' | 'none';
  matchScore?: number;
}

export interface AccountingDocument {
  id: ID;
  kind: DocumentKind;
  number: string;
  date: string; // ISO yyyy-mm-dd
  dueDate?: string;
  clientId?: ID;
  /** Nom du client tel qu'écrit sur le document (avant rapprochement). */
  clientNameRaw?: string;
  currency: string;
  totalHT: number;
  totalVAT: number;
  totalTTC: number;
  status: DocumentStatus;
  lines: DocumentLine[];
  /** Chemin du fichier source dans le dossier surveillé. */
  sourceFile?: string;
  sourceFormat?: 'pdf' | 'facturx' | 'xml' | 'csv' | 'xlsx' | 'manual';
  sourceHash?: string;
  sourceMtime?: number;
  /** Le stock a-t-il déjà été décrémenté pour ce document ? */
  stockApplied: boolean;
  stockAppliedAt?: string;
  /** Date de la dernière impression — sert de repère visuel dans le tableau. */
  printedAt?: string;
  /** Date du dernier envoi par e-mail. */
  emailedAt?: string;
  /** Fiabilité de l'extraction automatique, 0 → 1. */
  confidence: number;
  /** Champs que l'extraction n'a pas su lire de façon sûre. */
  warnings: string[];
  /**
   * Champs corrigés à la main. Une relecture du fichier d'origine ne les
   * écrase jamais : sans cette liste, rattacher une facture au bon client ou
   * corriger une date serait défait au prochain passage du lecteur.
   */
  manualFields?: string[];
  notes?: string;
  importedAt: string;
  updatedAt: string;
}

/**
 * Nature d'un article du stock. Le stock ne contient pas que des consommables :
 * on y suit aussi les machines vendues (glace, granité…) et les pièces
 * détachées utilisées en SAV.
 */
export type ProductType = 'consumable' | 'machine' | 'part';

export interface Product {
  id: ID;
  sku: string;
  name: string;
  /** Consommable par défaut : c'est ce qu'étaient tous les articles existants. */
  type: ProductType;
  category?: string;
  unit: string; // pièce, kg, L, carton…
  qtyOnHand: number;
  minQty: number;
  unitCost?: number;
  supplier?: string;
  /** Libellés rencontrés sur les factures qui désignent ce produit. */
  aliases: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StockMoveType = 'in' | 'out' | 'adjust';

export interface StockMove {
  id: ID;
  productId: ID;
  qty: number; // signé : positif = entrée, négatif = sortie
  type: StockMoveType;
  date: string;
  documentId?: ID;
  documentNumber?: string;
  note?: string;
  /** Stock après application du mouvement (pour l'historique). */
  balanceAfter: number;
  createdAt: string;
}

/**
 * Pièce jointe réutilisable (flyer, plaquette, conditions générales…) que l'on
 * coche pour l'ajouter à un envoi par e-mail.
 */
export interface Attachment {
  id: ID;
  name: string;
  filePath: string;
  /** Taille en octets, pour prévenir des envois trop lourds. */
  size: number;
  category?: string;
  /** Proposé coché par défaut à chaque nouvel envoi. */
  defaultSelected: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDraft {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Joindre le document comptable lui-même. */
  includeDocument: boolean;
  attachmentIds: ID[];
}

export interface Vehicle {
  id: ID;
  name: string;
  /** Consommation moyenne en L/100 km. */
  consumption: number;
  fuelType: 'gazole' | 'sp95' | 'sp98' | 'e85' | 'gplc' | 'electrique';
  /** Coût kilométrique additionnel (entretien, pneus, usure) en €/km. */
  maintenancePerKm: number;
  /** Coût horaire du chauffeur en €/h (0 pour l'ignorer). */
  driverCostPerHour: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouteStop {
  id: ID;
  clientId?: ID;
  label: string;
  address: Address;
  /** Épinglé : la position dans la tournée est figée lors de l'optimisation. */
  pinned: boolean;
  /** Position figée (index 0-based dans la liste des arrêts) quand pinned = true. */
  pinnedIndex?: number;
  /** Durée d'intervention sur place, en minutes. */
  serviceMinutes: number;
  notes?: string;
  /** Renseigné après calcul : distance/durée depuis l'arrêt précédent. */
  legDistanceKm?: number;
  legDurationMin?: number;
}

export interface RouteComputation {
  distanceKm: number;
  durationMin: number;
  serviceMin: number;
  fuelLiters: number;
  fuelCost: number;
  maintenanceCost: number;
  driverCost: number;
  tollCost: number;
  totalCost: number;
  costPerStop: number;
  fuelPricePerLiter: number;
  /** 'osrm' = distances routières réelles, 'haversine' = estimation hors-ligne. */
  engine: 'osrm' | 'haversine';
  computedAt: string;
}

export interface DeliveryRoute {
  id: ID;
  name: string;
  date: string;
  vehicleId?: ID;
  /** Départ (dépôt). */
  start: RouteStop;
  stops: RouteStop[];
  /** Retour au dépôt en fin de tournée. */
  returnToStart: boolean;
  /** Arrivée différente du départ, si returnToStart = false et renseignée. */
  end?: RouteStop | null;
  tollCost: number;
  computation?: RouteComputation;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Cahiers (SAV, consommables, événementiel)                            */
/* ------------------------------------------------------------------ */

export type RegisterKind = 'sav' | 'consumables' | 'event';

/**
 * Statuts communs aux trois cahiers, avec des libellés propres à chacun :
 * - SAV :           open = À traiter,  confirmed = En cours,      done = Résolu
 * - Consommables :  open = À préparer, confirmed = En préparation, done = Livré
 * - Événementiel :  open = Demande,    confirmed = Devis validé,  done = Terminé
 *
 * Pour l'événementiel, seul « Devis validé » réserve les machines : une simple
 * demande ne retire rien du parc.
 */
export type RegisterStatus = 'open' | 'confirmed' | 'done' | 'cancelled';

export interface RegisterMachineLine {
  machineId: ID;
  qty: number;
}

/**
 * Article d'une écriture : pièce SAV, consommable commandé…
 * Rattaché au stock quand l'article y figure, libellé libre sinon — on ne
 * bloque jamais la prise de note parce qu'une référence manque au catalogue.
 */
export interface RegisterItem {
  productId?: ID;
  label: string;
  qty: number;
}

export interface RegisterEntry {
  id: ID;
  kind: RegisterKind;
  clientId?: ID;
  /** Nom noté à la volée quand le client n'a pas (encore) de fiche. */
  clientName?: string;
  /** Cause de la panne (SAV), objet de la commande, nom de l'événement. */
  title: string;
  /**
   * Articles concernés : pièces demandées en SAV, consommables commandés.
   * Rattachés au stock quand c'est possible.
   */
  items?: RegisterItem[];
  /** Commentaire libre. */
  details?: string;
  /** Tournée de livraison à laquelle cette écriture a été rattachée. */
  routeId?: ID;
  /** Événementiel : date de la prestation. */
  eventDate?: string;
  /** Événementiel : machines demandées. */
  machines?: RegisterMachineLine[];
  status: RegisterStatus;
  createdAt: string;
  updatedAt: string;
}

/** Machine du parc événementiel (machine à glace italienne, vitrine…). */
export interface EventMachine {
  id: ID;
  name: string;
  reference?: string;
  /** Nombre d'exemplaires possédés. */
  qtyTotal: number;
  notes?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Disponibilité calculée d'une machine — jamais stockée, donc jamais fausse. */
export interface MachineAvailability {
  machine: EventMachine;
  /** Exemplaires réservés par des devis validés non terminés. */
  reserved: number;
  available: number;
  /** Prochaines sorties confirmées (date + client + événement). */
  upcoming: { entryId: ID; date?: string; label: string; qty: number }[];
}

/* ------------------------------------------------------------------ */
/* Relevés bancaires                                                    */
/* ------------------------------------------------------------------ */

export type BankCategory =
  | 'sales'
  | 'suppliers'
  | 'payroll'
  | 'taxes'
  | 'fuel'
  | 'bankFees'
  | 'rent'
  | 'insurance'
  | 'utilities'
  | 'transfer'
  | 'other';

export interface BankTransaction {
  id: ID;
  /** Date d'opération (ISO yyyy-mm-dd). */
  date: string;
  /** Date de valeur, quand le relevé la distingue. */
  valueDate?: string;
  /** Libellé brut tel qu'écrit par la banque. */
  label: string;
  /** Montant signé : positif = encaissement, négatif = décaissement. */
  amount: number;
  /** Solde après opération, quand le relevé le fournit. */
  balance?: number;
  reference?: string;
  /** Compte concerné, quand le relevé le précise. */
  account?: string;
  category: BankCategory;
  /** La catégorie vient-elle de la reconnaissance automatique (vs choisie à la main) ? */
  categoryAuto: boolean;
  clientId?: ID;
  /** Facture rapprochée de cette opération. */
  documentId?: ID;
  /** Fiabilité du rapprochement automatique, 0 → 1. */
  matchScore?: number;
  /** Le rapprochement vient-il de l'automatisme (vs validé à la main) ? */
  matchAuto: boolean;
  note?: string;
  sourceFile?: string;
  sourceFormat?: 'csv' | 'xlsx' | 'manual';
  /**
   * Empreinte de dédoublonnage : date + montant + libellé + rang d'occurrence.
   * Deux imports du même relevé produisent exactement les mêmes empreintes,
   * donc aucune ligne n'est ajoutée deux fois — y compris quand deux fichiers
   * se chevauchent sur une même période.
   */
  fingerprint: string;
  importedAt: string;
  updatedAt: string;
}

export interface BankImportReport {
  file: string;
  total: number;
  imported: number;
  duplicates: number;
  updated: number;
  skipped: number;
  reconciled: number;
  headers: string[];
  mapping: Record<string, string>;
  errors: string[];
  warnings: string[];
}

export interface BankScanReport {
  files: number;
  imported: number;
  duplicates: number;
  reconciled: number;
  failed: number;
  errors: { file: string; message: string }[];
  durationMs: number;
}

export interface BankMatchSuggestion {
  documentId: ID;
  number: string;
  clientName: string;
  date: string;
  totalTTC: number;
  score: number;
  reason: string;
}

export interface BankMonthSummary {
  /** yyyy-mm */
  month: string;
  in: number;
  out: number;
  net: number;
  /** Dernier solde connu du mois, quand le relevé fournit les soldes. */
  balance?: number;
}

export interface BankCategorySummary {
  category: BankCategory;
  in: number;
  out: number;
  count: number;
}

export interface BankSummary {
  from: string | null;
  to: string | null;
  totalIn: number;
  totalOut: number;
  net: number;
  /** Dernier solde connu, et sa date. */
  balance?: number;
  balanceDate?: string;
  months: BankMonthSummary[];
  categories: BankCategorySummary[];
  /** Encaissements non encore rattachés à une facture. */
  unreconciled: number;
  unreconciledAmount: number;
}

export interface Settings {
  /** Dossier surveillé (par défaut Documents/CompaGelato). */
  watchFolder: string;
  autoScan: boolean;
  /**
   * Dossier des relevés bancaires. Peut pointer hors du dossier surveillé
   * (les relevés sont souvent déjà rangés ailleurs).
   */
  statementFolder?: string;
  /** Rapprocher automatiquement les encaissements avec les factures. */
  autoReconcile: boolean;
  /**
   * Notifications sur téléphone via ntfy : chaque ajout dans un cahier est
   * poussé sur le sujet configuré. Vide = désactivé. En attendant les comptes
   * utilisateurs, tous les téléphones abonnés au même sujet sont prévenus.
   */
  notifyTopic?: string;
  /** Serveur ntfy ; ntfy.sh par défaut, remplaçable par un serveur à soi. */
  notifyUrl?: string;
  /** Déduire le stock automatiquement à l'import des factures. */
  autoApplyStock: boolean;
  /** Créer automatiquement une fiche client si le nom lu est inconnu. */
  autoCreateClients: boolean;
  currency: string;
  vatDefault: number;
  fuelPricePerLiter: number;
  fuelPriceUpdatedAt?: string;
  fuelPriceSource?: string;
  /** Code postal utilisé pour relever le prix des carburants. */
  fuelPricePostcode?: string;
  defaultVehicleId?: ID;
  /** Adresse du dépôt, point de départ par défaut des tournées. */
  depot?: Address;
  mapProvider: 'google' | 'waze' | 'apple';
  theme: 'system' | 'light' | 'dark';
  companyName?: string;
  lowStockAlert: boolean;
  /** Adresse e-mail d'expédition, reprise dans les brouillons générés. */
  senderEmail?: string;
  /** Signature ajoutée en fin de message. */
  emailSignature?: string;
  /** Objet type des e-mails ; {type} et {numero} sont remplacés. */
  emailSubjectTemplate?: string;
  /** Corps type des e-mails ; {client}, {type}, {numero}, {date} sont remplacés. */
  emailBodyTemplate?: string;
}

export interface Database {
  version: number;
  clients: Client[];
  documents: AccountingDocument[];
  products: Product[];
  stockMoves: StockMove[];
  routes: DeliveryRoute[];
  vehicles: Vehicle[];
  attachments: Attachment[];
  bankTransactions: BankTransaction[];
  registerEntries: RegisterEntry[];
  eventMachines: EventMachine[];
  settings: Settings;
}

/* ------------------------------------------------------------------ */
/* Résultats d'opérations                                              */
/* ------------------------------------------------------------------ */

export interface ScanReport {
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  documents: AccountingDocument[];
  errors: { file: string; message: string }[];
  durationMs: number;
}

export interface ImportClientsReport {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  /** En-têtes détectées dans le fichier source. */
  headers: string[];
  mapping: Record<string, string>;
}

export interface StockApplyReport {
  documentId: ID;
  applied: number;
  unmatched: { lineId: ID; label: string; qty: number }[];
  moves: StockMove[];
  message: string;
}

export interface AddressSuggestion {
  label: string;
  street?: string;
  postcode?: string;
  city?: string;
  lat: number;
  lon: number;
  score: number;
  context?: string;
}

export interface OptimizeOptions {
  /** Conserver le point de départ en première position (toujours vrai en pratique). */
  returnToStart: boolean;
  /** Nombre d'itérations max pour l'amélioration 2-opt. */
  maxIterations?: number;
}

export interface OptimizeResult {
  /** Ordre optimisé des arrêts (ids). */
  order: ID[];
  before: { distanceKm: number; durationMin: number };
  after: { distanceKm: number; durationMin: number };
  savedKm: number;
  savedMin: number;
  engine: 'osrm' | 'haversine';
  /** Arrêts épinglés respectés. */
  pinnedRespected: number;
}

export interface DashboardStats {
  clients: number;
  invoices: number;
  quotes: number;
  revenueHT: number;
  revenueTTC: number;
  unappliedDocuments: number;
  lowStock: { product: Product; missing: number }[];
  outOfStock: number;
  stockValue: number;
  recentDocuments: AccountingDocument[];
  monthlyRevenue: { month: string; ht: number; ttc: number }[];
  topClients: { client: Client; total: number; count: number }[];
  routesThisMonth: number;
  routeCostThisMonth: number;
}
