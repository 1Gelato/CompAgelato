/**
 * Modèle de données CompaGelato — partagé entre le processus principal (Electron)
 * et l'interface (React). Aucune dépendance externe ici.
 */

export type ID = string;

/**
 * Enregistrement synchronisable entre appareils.
 *
 * `rev` est un numéro de version **attribué par le serveur**, strictement
 * croissant sur toute la base : un appareil qui connaît la révision N demande
 * « tout ce qui a changé depuis N » et reçoit exactement le delta. Les
 * enregistrements créés avant la synchronisation n'en ont pas encore — ils en
 * reçoivent un à leur première modification, et les synchronisations complètes
 * les emportent de toute façon.
 */
export interface Syncable {
  rev?: number;
}

/** Pierre tombale : un enregistrement supprimé, à propager aux appareils. */
export interface Tombstone {
  id: ID;
  rev: number;
  deletedAt: string;
}

/**
 * Collections répliquées sur les appareils. Les comptes et les sessions n'en
 * font jamais partie : ils appartiennent au serveur.
 */
export const SYNCED_COLLECTIONS = [
  'clients',
  'documents',
  'products',
  'stockMoves',
  'routes',
  'vehicles',
  'attachments',
  'bankTransactions',
  'registerEntries',
  'eventMachines',
  'tasks',
  'deliveryNotes',
] as const;

export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number];

/** État de synchronisation de la base, tenu par le serveur. */
export interface SyncMeta {
  /**
   * Identité de cette lignée de données. Elle change à chaque restauration de
   * sauvegarde : les appareils comprennent alors « repars de zéro » au lieu de
   * garder des fiches ressuscitées ou fantômes.
   */
  generation: string;
  /** Dernière révision attribuée. */
  maxRev: number;
  /** Révision des réglages, tenue à part : c'est un objet unique, sans id. */
  settingsRev?: number;
  /**
   * En deçà de cette révision, les pierres tombales ont été purgées : un
   * appareil plus en retard doit refaire une synchronisation complète.
   */
  floorRev: number;
  tombstones: Partial<Record<SyncedCollection, Tombstone[]>>;
}

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

export interface Client extends Syncable {
  id: ID;
  code: string; // référence interne, ex: "CLI-0007"
  name: string;
  legalName?: string;
  contact?: string;
  email?: string;
  phone?: string;
  /** Second numéro (portable) : les exports comptables en portent souvent deux. */
  mobile?: string;
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

export interface AccountingDocument extends Syncable {
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
 * La pièce attend-elle encore une sortie de stock ?
 *
 * Trois cas ne sortent jamais rien : un devis n'engage rien, une pièce annulée
 * non plus, et un brouillon tient lieu de proforma — la facture définitive
 * suivra, et c'est elle qui décrémentera le stock. Compter ces pièces dans les
 * « en attente » afficherait un travail à faire qui ne se fera jamais.
 *
 * Définie une seule fois : le compteur du bandeau latéral, celui du tableau de
 * bord et l'application en masse du stock doivent dire la même chose.
 */
export function awaitsStock(doc: AccountingDocument): boolean {
  if (doc.stockApplied) return false;
  if (doc.kind === 'quote') return false;
  return doc.status !== 'cancelled' && doc.status !== 'draft';
}

/**
 * Nature d'un article du stock. Le stock ne contient pas que des consommables :
 * on y suit aussi les machines vendues (glace, granité…) et les pièces
 * détachées utilisées en SAV.
 */
export type ProductType = 'consumable' | 'mixLiquid' | 'mixPowder' | 'machine' | 'part';

/**
 * Ce que compte la facture du fournisseur, qui ne correspond pas toujours à
 * l'unité de stock :
 * - `unit`    : l'unité elle-même (20 poches)
 * - `case`    : le carton (10 cartons de 2 poches)
 * - `measure` : le contenu (12,5 kg, facturés au kilo)
 */
export type InvoicedAs = 'unit' | 'case' | 'measure';

export interface Product extends Syncable {
  id: ID;
  sku: string;
  name: string;
  /** Consommable par défaut : c'est ce qu'étaient tous les articles existants. */
  type: ProductType;
  category?: string;
  /** Unité de stock : ce que vous comptez sur l'étagère (poche, carton, pièce…). */
  unit: string;
  /** Contenu d'une unité : 4,5 pour une poche de 4,5 kg. */
  packSize?: number;
  /** Mesure du contenu (kg, L). */
  packMeasure?: string;
  /** Unités par carton : 2 poches liquides par carton. */
  unitsPerCase?: number;
  /** Ce que compte la facture, pour convertir en unités de stock. */
  invoicedAs?: InvoicedAs;
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

export interface StockMove extends Syncable {
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
export interface Attachment extends Syncable {
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

export interface Vehicle extends Syncable {
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
  /** Livraison faite, pointée depuis le téléphone en tournée (ou le bureau). */
  doneAt?: string;
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

export interface DeliveryRoute extends Syncable {
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

export type RegisterKind = 'sav' | 'consumables' | 'event' | 'purchase';

/**
 * Statuts communs aux cahiers, avec des libellés propres à chacun :
 * - SAV :           open = À traiter,  confirmed = En cours,       done = Résolu
 * - Consommables :  open = À préparer, confirmed = En préparation, done = Livré
 * - Événementiel :  open = Demande,    confirmed = Devis validé,   done = Terminé
 * - Achats :        open = À acheter,  confirmed = Commandé,       done = Reçu
 *
 * Pour l'événementiel, seul « Devis validé » réserve les machines : une simple
 * demande ne retire rien du parc. Le cahier des achats note ce que l'entreprise
 * doit se procurer : son « client » est un fournisseur.
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

export interface RegisterEntry extends Syncable {
  id: ID;
  kind: RegisterKind;
  clientId?: ID;
  /** Nom noté à la volée quand le client n'a pas (encore) de fiche.
   *  Dans le cahier des achats, c'est le nom du fournisseur. */
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

/* ------------------------------------------------------------------ */
/* Tâches (suivi des clients et du quotidien)                           */
/* ------------------------------------------------------------------ */

/**
 * Quatre niveaux suffisent : au-delà, plus personne ne sait ce qui distingue
 * un « P2 » d'un « P3 » et tout finit urgent. Le tri de l'écran suit cet ordre.
 */
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

export type TaskStatus = 'open' | 'doing' | 'done';

/**
 * Une ligne du journal d'une tâche : qui a fait quoi, quand, en clair.
 *
 * C'est la moitié du « retour en arrière » : avant d'annuler une erreur, il
 * faut pouvoir la voir. L'autre moitié est la corbeille (`deletedAt`).
 */
export interface TaskEvent {
  at: string;
  /** Compte à l'origine du geste, `null` quand personne n'est identifiable. */
  by: ID | null;
  /** Nom affiché au moment du geste — le compte peut disparaître ensuite. */
  byName?: string;
  text: string;
}

export interface Task extends Syncable {
  id: ID;
  title: string;
  details?: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Fiche client concernée — c'est le cœur du suivi des clients. */
  clientId?: ID;
  /** Nom noté à la volée quand le client n'a pas (encore) de fiche. */
  clientName?: string;
  /** Échéance (ISO yyyy-mm-dd). Passée sans être faite, la tâche est en retard. */
  dueDate?: string;
  /** Compte à qui la tâche est confiée. */
  assignedTo?: ID;
  /** Nom affiché du compte, pour rester lisible si le compte est supprimé. */
  assignedToName?: string;
  doneAt?: string;
  /**
   * Corbeille : une tâche « supprimée » reste restaurable au lieu d'être
   * perdue — c'est la protection contre le clic malheureux. Elle n'est
   * réellement effacée qu'à la purge (manuelle, ou automatique après 30 jours).
   */
  deletedAt?: string;
  /** Journal des gestes, du plus récent au plus ancien (borné). */
  history: TaskEvent[];
  createdBy?: ID;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Bons de livraison (signés en tournée, facturés ensuite au bureau)    */
/* ------------------------------------------------------------------ */

/**
 * Une signature tracée au doigt sur le téléphone.
 *
 * Les tracés sont gardés en vecteurs — des suites de points `[x, y]`
 * normalisés entre 0 et 1 — plutôt qu'en image : quelques centaines d'octets,
 * lisibles sur n'importe quel écran à n'importe quelle taille, et rien à
 * transporter de lourd dans la synchronisation.
 */
export interface Signature {
  strokes: [number, number][][];
  /** Nom du signataire, saisi à côté du tracé. */
  name?: string;
  at: string;
}

/**
 * Le bon fait foi de la livraison ; la facture vient ensuite, au bureau.
 * `invoiced` marque simplement que ce travail est fait.
 */
export type DeliveryNoteStatus = 'signed' | 'invoiced';

/**
 * Bon de livraison établi sur la route, quand un client est servi sans
 * facture préparée. Il remplace le bon papier : articles notés sur place,
 * signé par le livreur et par le client, reçu au bureau dans la minute —
 * la facture se fait ensuite, tranquillement.
 */
export interface DeliveryNote extends Syncable {
  id: ID;
  /** Numéro attribué par le serveur : BL-2026-0001, BL-2026-0002… */
  number: string;
  /** Jour de la livraison (ISO yyyy-mm-dd). */
  date: string;
  clientId?: ID;
  /** Nom noté à la volée quand le client n'a pas (encore) de fiche. */
  clientName?: string;
  /** Ce qui a été livré — mêmes lignes libres que les cahiers. */
  items: RegisterItem[];
  notes?: string;
  /** Tournée pendant laquelle le bon a été établi, si c'est le cas. */
  routeId?: ID;
  driverSignature?: Signature;
  clientSignature?: Signature;
  status: DeliveryNoteStatus;
  /** Facture créée ensuite au bureau, rattachée pour la traçabilité. */
  documentId?: ID;
  createdBy?: ID;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}

/** Machine du parc événementiel (machine à glace italienne, vitrine…). */
export interface EventMachine extends Syncable {
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

export interface BankTransaction extends Syncable {
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

/**
 * Une opération enregistrée plusieurs fois parce que deux exports de la banque
 * ne libellaient pas la ligne de la même façon.
 */
export interface BankDuplicateGroup {
  date: string;
  amount: number;
  /** Les opérations à conserver — autant que l'opération a réellement eu lieu. */
  keep: ID[];
  /** Les copies en trop. */
  drop: ID[];
  /** Les libellés rencontrés, du plus complet au plus court. */
  labels: string[];
}

export interface BankDedupeReport {
  groups: number;
  removed: number;
  /** Montant cumulé des copies supprimées — l'erreur que portaient les totaux. */
  amount: number;
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
  /**
   * SIRET de votre entreprise.
   *
   * Sert d'abord à un garde-fou : sur une facture que vous **recevez**, le
   * « client » c'est vous — votre propre SIRET figure donc dans le bloc client.
   * Sans ce repère, cette pièce se rattachait à la fiche de votre base qui
   * portait ce SIRET, avec un rapprochement à 100 %, alors que votre
   * entreprise n'est évidemment pas son propre client.
   */
  companySiret?: string;
  lowStockAlert: boolean;
  /** Adresse e-mail d'expédition, reprise dans les brouillons générés. */
  senderEmail?: string;
  /** Signature ajoutée en fin de message. */
  emailSignature?: string;
  /** Objet type des e-mails ; {type} et {numero} sont remplacés. */
  emailSubjectTemplate?: string;
  /** Corps type des e-mails ; {client}, {type}, {numero}, {date} sont remplacés. */
  emailBodyTemplate?: string;
  /** Notifications du système sur le poste. */
  desktopNotify?: DesktopNotifySettings;
}

/**
 * Ce qui mérite une notification du système sur le poste.
 *
 * Réglage de confort, pas de sécurité : le serveur annonce de toute façon
 * chaque arrivée, c'est le poste qui décide s'il la montre.
 */
export interface DesktopNotifySettings {
  /** Nouvelle écriture dans un cahier (SAV, consommables, événementiel). */
  registers: boolean;
  /** Nouvelle pièce comptable arrivée sur le serveur. */
  documents: boolean;
  /** Nouveau relevé bancaire importé. */
  statements: boolean;
  /** Nouvelle tâche ajoutée au suivi. */
  tasks: boolean;
  /** Bon de livraison signé en tournée. */
  deliveries: boolean;
  /**
   * Notifier aussi quand la fenêtre CompaGelato est au premier plan. Faux par
   * défaut : sous les yeux de l'utilisateur, l'écriture apparaît d'elle-même et
   * une bulle système ne ferait que répéter ce qu'il voit déjà.
   */
  whenFocused: boolean;
}

export const DEFAULT_DESKTOP_NOTIFY: DesktopNotifySettings = {
  registers: true,
  documents: true,
  statements: true,
  tasks: true,
  deliveries: true,
  whenFocused: false,
};

/**
 * Une arrivée annoncée à tous les postes branchés.
 *
 * `by` porte l'auteur : chaque poste écarte ce qu'il a lui-même provoqué —
 * être prévenu de sa propre saisie n'apprend rien et use la confiance qu'on
 * accorde aux notifications. `null` quand personne n'est identifiable : un
 * fichier déposé directement dans le dossier surveillé du serveur, par
 * exemple, qui est justement ce qu'on veut savoir.
 */
export interface ActivityEvent {
  source: 'register' | 'document' | 'statement' | 'task' | 'delivery';
  title: string;
  text: string;
  /** Identifiant du compte à l'origine, `null` si l'arrivée n'a pas d'auteur. */
  by: ID | null;
  at: string;
}

/* ------------------------------------------------------------------ */
/* Comptes et droits                                                    */
/* ------------------------------------------------------------------ */

/**
 * Trois rôles suffisent à l'entreprise :
 *
 * - `gerant`  : tout, y compris les réglages et les comptes ;
 * - `bureau`  : tout le travail quotidien, sans toucher aux réglages ;
 * - `livreur` : ses tournées, et les clients en lecture seule pour les
 *   retrouver — ni comptabilité, ni banque, ni stock.
 */
export type Role = 'gerant' | 'bureau' | 'livreur';

export const ROLE_LABEL: Record<Role, string> = {
  gerant: 'Gérant',
  bureau: 'Bureau',
  livreur: 'Livreur',
};

export interface User {
  id: ID;
  /** Identifiant de connexion, comparé sans tenir compte de la casse. */
  username: string;
  displayName: string;
  role: Role;
  /** `sel:empreinte` en hexadécimal, produit par scrypt. */
  passwordHash: string;
  /** Un compte désactivé ne peut plus se connecter, sans être effacé. */
  disabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

/**
 * Session ouverte sur un appareil. Le jeton n'est jamais stocké en clair :
 * seule son empreinte l'est, si bien qu'une copie de la base ne permet pas
 * d'usurper une session en cours.
 */
export interface Session {
  id: ID;
  userId: ID;
  /** Empreinte SHA-256 du jeton remis à l'appareil. */
  tokenHash: string;
  /** Nom lisible de l'appareil, pour que le gérant sache quoi révoquer. */
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/**
 * Un téléphone abonné aux notifications de l'application.
 *
 * Volontairement **hors des collections synchronisées** : comme les comptes et
 * les sessions, ce registre appartient au serveur seul. Un jeton d'appareil
 * permet de lui pousser des messages — il n'a rien à faire dans le miroir d'un
 * poste, encore moins dans celui d'un téléphone.
 */
export interface PushDevice {
  id: ID;
  /** À qui appartient l'appareil : c'est ce qui décide de ce qu'il reçoit. */
  userId: ID;
  /** Session qui l'a enregistré : révoquée, l'abonnement part avec elle. */
  sessionId?: ID;
  /** Jeton remis par Firebase à cette installation de l'app. */
  token: string;
  /** « Pixel 7 de Hervé » — pour que le gérant sache quoi révoquer. */
  label: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string;
}

/** Vue d'un compte destinée à l'interface : jamais d'empreinte de mot de passe. */
export interface UserSummary {
  id: ID;
  username: string;
  displayName: string;
  role: Role;
  disabled?: boolean;
  createdAt: string;
  lastLoginAt?: string;
  /** Nombre de sessions ouvertes, pour repérer un appareil oublié. */
  sessions: number;
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
  tasks: Task[];
  deliveryNotes: DeliveryNote[];
  settings: Settings;
  /** État de synchronisation multi-appareils, créé à la migration. */
  sync?: SyncMeta;
  /**
   * Comptes et sessions. Tant que la liste est vide, le serveur reste dans son
   * fonctionnement d'origine (jeton partagé) : créer le premier compte est un
   * geste explicite, jamais une surprise au redémarrage.
   */
  users: User[];
  sessions: Session[];
  /** Téléphones abonnés aux notifications. Jamais répliqué (voir PushDevice). */
  pushDevices: PushDevice[];
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
