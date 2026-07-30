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
  /** Fiabilité de l'extraction automatique, 0 → 1. */
  confidence: number;
  /** Champs que l'extraction n'a pas su lire de façon sûre. */
  warnings: string[];
  notes?: string;
  importedAt: string;
  updatedAt: string;
}

export interface Product {
  id: ID;
  sku: string;
  name: string;
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

export interface Settings {
  /** Dossier surveillé (par défaut Documents/CompaGelato). */
  watchFolder: string;
  autoScan: boolean;
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
}

export interface Database {
  version: number;
  clients: Client[];
  documents: AccountingDocument[];
  products: Product[];
  stockMoves: StockMove[];
  routes: DeliveryRoute[];
  vehicles: Vehicle[];
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
