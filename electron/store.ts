import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  Address,
  Attachment,
  Database,
  ID,
  Settings,
  StockMove,
  SyncMeta,
  Syncable,
  Vehicle,
} from '@shared/types';
import { SYNCED_COLLECTIONS } from '@shared/types';

const DB_VERSION = 1;

/**
 * Emplacements injectés par l'hôte. Le magasin ne dépend plus d'Electron :
 * l'application de bureau lui passe `app.getPath('userData')` et
 * `app.getPath('documents')`, le serveur un dossier de données explicite
 * (`COMPAGELATO_DATA_DIR`). Sans rien, on retombe sur le dossier personnel —
 * jamais sur une erreur.
 */
export interface StorePaths {
  /** Dossier où vivent la base et ses sauvegardes. */
  dataDir?: string;
  /** Dossier « Documents » de l'utilisateur, base du dossier surveillé par défaut. */
  documentsDir?: string;
}

const configured: StorePaths = {};

function resolveDataDir(): string {
  return (
    configured.dataDir ||
    process.env.COMPAGELATO_DATA_DIR ||
    path.join(os.homedir(), '.compagelato')
  );
}

/**
 * Identifiant unique. 16 caractères hexadécimaux (64 bits) : sur un seul poste
 * 12 suffisaient, mais dès que plusieurs appareils créent des fiches chacun de
 * leur côté la marge devient trop mince. Les identifiants déjà émis restent
 * valides — ce sont de simples chaînes.
 */
export function newId(prefix = ''): string {
  const raw = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${raw}` : raw;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Dossier surveillé par défaut : Documents/CompaGelato (C:\Users\<user>\Documents\CompaGelato sur Windows). */
/**
 * Un chemin écrit par un autre système que celui qui tourne ici.
 *
 * Une sauvegarde faite sur un poste Windows et restaurée sur le serveur Linux
 * apporte avec elle `C:\Users\…\CompaGelato`. Gardé tel quel, ce dossier
 * n'existe nulle part sur le serveur : les pièces deviennent introuvables — les
 * chemins des documents sont enregistrés *relativement* au dossier de travail —
 * et l'analyse du dossier fabriquerait un répertoire au nom absurde. C'est le
 * chemin de la mise en commun des données : il doit marcher du premier coup.
 *
 * On ne juge que la *forme* : lettre de lecteur ou chemin UNC d'un côté, barre
 * oblique initiale de l'autre. Un chemin valide pour la machine courante n'est
 * jamais touché.
 */
export function isForeignPath(candidate: string): boolean {
  if (!candidate) return false;
  const windowsShaped = /^([a-zA-Z]:[\\/]|\\\\)/.test(candidate);
  return process.platform === 'win32' ? candidate.startsWith('/') : windowsShaped;
}

export function defaultWatchFolder(): string {
  const documents = configured.documentsDir || path.join(os.homedir(), 'Documents');
  return path.join(documents, 'CompaGelato');
}

/**
 * Dépôt de l'entreprise. Il n'y en a qu'un : ses coordonnées sont figées ici
 * pour que le calcul de tournée fonctionne dès la première ouverture, même
 * sans connexion au service d'adresses.
 */
export const DEFAULT_DEPOT: Address = {
  label: '27 Rue Jacques Daguerre, 44600 Saint-Nazaire',
  street: '27 Rue Jacques Daguerre',
  postcode: '44600',
  city: 'Saint-Nazaire',
  country: 'France',
  lat: 47.295669,
  lon: -2.29232,
};

export function defaultSettings(): Settings {
  return {
    watchFolder: defaultWatchFolder(),
    autoScan: true,
    autoApplyStock: false,
    autoCreateClients: true,
    autoReconcile: true,
    notifyTopic: '',
    notifyUrl: 'https://ntfy.sh',
    currency: 'EUR',
    vatDefault: 20,
    fuelPricePerLiter: 1.75,
    fuelPricePostcode: '44600',
    depot: { ...DEFAULT_DEPOT },
    mapProvider: 'google',
    theme: 'system',
    lowStockAlert: true,
    emailSubjectTemplate: '{type} {numero}',
    emailBodyTemplate:
      'Bonjour,\n\nVeuillez trouver ci-joint {le_type} {numero} du {date}.\n\n' +
      'Restant à votre disposition,',
  };
}

function defaultVehicle(): Vehicle {
  return {
    id: newId('veh'),
    name: 'Véhicule principal',
    consumption: 9.5,
    fuelType: 'gazole',
    maintenancePerKm: 0.08,
    driverCostPerHour: 0,
    isDefault: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function freshSyncMeta(): SyncMeta {
  return { generation: newId('gen'), maxRev: 0, floorRev: 0, tombstones: {} };
}

/** Pierres tombales conservées 90 jours ; au-delà, synchronisation complète. */
const TOMBSTONE_DAYS = 90;

/**
 * Empreinte du contenu d'un enregistrement, révision exclue : c'est elle qui
 * dit « quelque chose a changé », et la révision qu'on attribue en conséquence
 * ne doit pas déclencher elle-même un nouveau changement.
 */
function fingerprintOf(row: Syncable & { id: ID }): string {
  return JSON.stringify({ ...row, rev: undefined });
}

function emptyDatabase(): Database {
  const vehicle = defaultVehicle();
  return {
    version: DB_VERSION,
    clients: [],
    documents: [],
    products: [],
    stockMoves: [],
    routes: [],
    vehicles: [vehicle],
    attachments: [],
    bankTransactions: [],
    registerEntries: [],
    eventMachines: [],
    settings: { ...defaultSettings(), defaultVehicleId: vehicle.id },
    users: [],
    sessions: [],
    sync: freshSyncMeta(),
  };
}

export class Store {
  private data: Database = emptyDatabase();
  private file = '';
  private backupDir = '';
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private loaded = false;
  /**
   * Empreinte de chaque enregistrement telle que vue à la dernière écriture.
   * C'est le cœur du suivi des modifications : à chaque flush, on compare et on
   * numérote ce qui a changé — aucun des points d'écriture n'a besoin de le
   * signaler, et les mutations d'objets capturés avant l'appel sont vues quand
   * même. Un identifiant présent hier et absent aujourd'hui est une
   * suppression : sa pierre tombale est produite automatiquement.
   */
  private fingerprints = new Map<string, Map<ID, string>>();
  private settingsFingerprint = '';

  init(paths?: StorePaths): void {
    if (this.loaded) return;
    if (paths?.dataDir) configured.dataDir = paths.dataDir;
    if (paths?.documentsDir) configured.documentsDir = paths.documentsDir;
    const dir = resolveDataDir();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'compagelato-data.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });

    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw) as Partial<Database>;
        this.data = this.migrate(parsed);
      } catch (err) {
        // Fichier corrompu : on le met de côté et on repart d'une base saine
        // plutôt que d'empêcher le logiciel de démarrer.
        const broken = path.join(this.backupDir, `corrompu-${Date.now()}.json`);
        try {
          fs.copyFileSync(this.file, broken);
        } catch {
          /* ignore */
        }
        console.error('[store] base illisible, sauvegarde dans', broken, err);
        this.data = this.restoreLatestBackup() ?? emptyDatabase();
        this.dirty = true;
      }
    } else {
      this.data = emptyDatabase();
      this.dirty = true;
    }
    this.loaded = true;
    this.rebuildFingerprints();
    this.flushSync();
    this.rotateBackups();
  }

  /**
   * Reconstruit les empreintes après un chargement. Un enregistrement sans
   * révision n'est volontairement pas empreint : le prochain flush le verra
   * comme nouveau et lui en attribuera une.
   */
  private rebuildFingerprints(): void {
    this.fingerprints.clear();
    for (const collection of SYNCED_COLLECTIONS) {
      const map = new Map<ID, string>();
      for (const row of this.data[collection] as (Syncable & { id: ID })[]) {
        if (row.rev !== undefined) map.set(row.id, fingerprintOf(row));
      }
      this.fingerprints.set(collection, map);
    }
    this.settingsFingerprint = JSON.stringify(this.data.settings);
  }

  /**
   * Compare la base aux empreintes et numérote ce qui a changé. Appelée juste
   * avant chaque écriture disque : les révisions sont donc toujours à jour au
   * moment où un appareil vient les demander.
   */
  private assignRevisions(): void {
    const sync = (this.data.sync ??= freshSyncMeta());
    const now = nowIso();

    for (const collection of SYNCED_COLLECTIONS) {
      const rows = this.data[collection] as (Syncable & { id: ID })[];
      const before = this.fingerprints.get(collection) ?? new Map<ID, string>();
      const after = new Map<ID, string>();

      for (const row of rows) {
        const print = fingerprintOf(row);
        if (row.rev === undefined || before.get(row.id) !== print) {
          row.rev = ++sync.maxRev;
        }
        after.set(row.id, print);
        before.delete(row.id);
        // Un enregistrement recréé (restauration partielle, rejeu) reprend vie :
        // sa pierre tombale ne doit plus le faire supprimer ailleurs.
        const graves = sync.tombstones[collection];
        if (graves?.some((g) => g.id === row.id)) {
          sync.tombstones[collection] = graves.filter((g) => g.id !== row.id);
        }
      }

      // Ce qui reste dans `before` a disparu : suppression.
      if (before.size) {
        const graves = (sync.tombstones[collection] ??= []);
        for (const id of before.keys()) {
          graves.push({ id, rev: ++sync.maxRev, deletedAt: now });
        }
      }
      this.fingerprints.set(collection, after);
    }

    const settingsPrint = JSON.stringify(this.data.settings);
    if (settingsPrint !== this.settingsFingerprint) {
      sync.settingsRev = ++sync.maxRev;
      this.settingsFingerprint = settingsPrint;
    }

    // Purge des pierres tombales trop vieilles. `floorRev` avance d'autant :
    // un appareil resté en deçà refera une synchronisation complète.
    const limit = Date.now() - TOMBSTONE_DAYS * 24 * 3600 * 1000;
    for (const collection of SYNCED_COLLECTIONS) {
      const graves = sync.tombstones[collection];
      if (!graves?.length) continue;
      const kept = graves.filter((g) => Date.parse(g.deletedAt) >= limit);
      if (kept.length !== graves.length) {
        sync.floorRev = Math.max(
          sync.floorRev,
          ...graves.filter((g) => Date.parse(g.deletedAt) < limit).map((g) => g.rev),
        );
        sync.tombstones[collection] = kept;
      }
    }
  }

  private migrate(parsed: Partial<Database>): Database {
    const base = emptyDatabase();
    const db: Database = {
      version: DB_VERSION,
      clients: parsed.clients ?? [],
      documents: parsed.documents ?? [],
      products: parsed.products ?? [],
      stockMoves: parsed.stockMoves ?? [],
      routes: parsed.routes ?? [],
      vehicles: parsed.vehicles?.length ? parsed.vehicles : base.vehicles,
      attachments: (parsed.attachments as Attachment[] | undefined) ?? [],
      bankTransactions: parsed.bankTransactions ?? [],
      registerEntries: parsed.registerEntries ?? [],
      eventMachines: parsed.eventMachines ?? [],
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
      // Base antérieure aux comptes : elle en repart sans, donc en jeton
      // partagé. Aucune bascule automatique vers une connexion obligatoire.
      users: parsed.users ?? [],
      sessions: parsed.sessions ?? [],
      sync: parsed.sync ?? freshSyncMeta(),
    };
    if (!db.settings.defaultVehicleId && db.vehicles[0]) {
      db.settings.defaultVehicleId = db.vehicles[0].id;
    }
    // Véhicules et pièces jointes n'ont pas toujours porté de date de
    // modification : on la renseigne pour les fiches déjà enregistrées, faute
    // de quoi il serait impossible de départager deux versions plus tard.
    for (const vehicle of db.vehicles) {
      if (!vehicle.createdAt) vehicle.createdAt = nowIso();
      if (!vehicle.updatedAt) vehicle.updatedAt = vehicle.createdAt;
    }
    for (const attachment of db.attachments) {
      if (!attachment.updatedAt) attachment.updatedAt = attachment.createdAt ?? nowIso();
    }
    // Le stock ne contenait que des consommables avant d'accueillir machines et
    // pièces détachées : les articles déjà saisis le restent.
    for (const product of db.products) {
      if (!product.type) product.type = 'consumable';
    }
    // Les pièces SAV étaient une simple ligne de texte ; elles deviennent des
    // articles, rattachables au stock. Le texte déjà saisi est conservé tel quel
    // en libellé libre.
    for (const entry of db.registerEntries) {
      const legacy = (entry as { parts?: string }).parts;
      if (legacy?.trim() && !entry.items?.length) {
        entry.items = [{ label: legacy.trim(), qty: 1 }];
      }
      delete (entry as { parts?: string }).parts;
    }
    // Le stock devient la somme de ses mouvements. Les bases existantes ont
    // des quantités saisies ou importées sans trace : un mouvement de reprise
    // rétablit l'égalité, une fois pour toutes. Son identifiant est déterministe
    // pour que rejouer la migration n'en crée jamais un second.
    for (const product of db.products) {
      const total = db.stockMoves
        .filter((m) => m.productId === product.id)
        .reduce((sum, m) => sum + m.qty, 0);
      const gap = Math.round((product.qtyOnHand - total) * 100) / 100;
      if (gap !== 0) {
        db.stockMoves.push({
          id: `mv_ouv_${product.id}`,
          productId: product.id,
          qty: gap,
          type: gap > 0 ? 'in' : 'adjust',
          date: (product.createdAt ?? nowIso()).slice(0, 10),
          note: 'Reprise d’inventaire',
          balanceAfter: product.qtyOnHand,
          createdAt: product.createdAt ?? nowIso(),
        } as StockMove);
      }
    }
    // Le dossier surveillé doit toujours pointer quelque part de valide — y
    // compris après une sauvegarde restaurée depuis une machine d'un autre
    // système, cas normal de la mise en commun des données sur un serveur.
    if (!db.settings.watchFolder || isForeignPath(db.settings.watchFolder)) {
      db.settings.watchFolder = defaultWatchFolder();
    }
    // Le dossier des relevés, lui, retombe sur son défaut (`<travail>/Releves`).
    if (db.settings.statementFolder && isForeignPath(db.settings.statementFolder)) {
      db.settings.statementFolder = undefined;
    }
    // Un dépôt sans coordonnées empêche tout calcul de tournée : on rétablit
    // celui de l'entreprise s'il a été vidé ou saisi sans géolocalisation.
    if (!db.settings.depot?.lat || !db.settings.depot?.lon) {
      db.settings.depot = { ...DEFAULT_DEPOT };
    }
    this.relativizePaths(db);
    return db;
  }

  /**
   * Réécrit en relatif les chemins de fichiers enregistrés en absolu par les
   * versions précédentes. Sans cette reprise, déplacer le dossier de travail
   * ferait réimporter chaque document en double : la déduplication compare ces
   * chemins caractère par caractère.
   */
  private relativizePaths(db: Database): void {
    const root = db.settings.watchFolder;
    if (!root) return;
    const inside = path.resolve(root);

    const toRelative = (stored?: string): string | undefined => {
      if (!stored || !path.isAbsolute(stored)) return stored;
      const relative = path.relative(inside, path.resolve(stored));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return stored;
      return relative.split(path.sep).join('/');
    };

    for (const doc of db.documents) doc.sourceFile = toRelative(doc.sourceFile);
    for (const tx of db.bankTransactions) tx.sourceFile = toRelative(tx.sourceFile);
    for (const attachment of db.attachments) {
      attachment.filePath = toRelative(attachment.filePath) ?? attachment.filePath;
    }
  }

  private restoreLatestBackup(): Database | null {
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const f of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(this.backupDir, f), 'utf8'));
          console.warn('[store] restauration depuis la sauvegarde', f);
          return this.migrate(parsed);
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  get db(): Database {
    if (!this.loaded) this.init();
    return this.data;
  }

  get settings(): Settings {
    return this.db.settings;
  }

  get dbFile(): string {
    return this.file;
  }

  /** Marque la base comme modifiée ; l'écriture disque est groupée. */
  touch(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, 400);
  }

  /** Applique une mutation puis planifie l'écriture. */
  mutate<T>(fn: (db: Database) => T): T {
    const result = fn(this.db);
    this.touch();
    return result;
  }

  flushSync(): void {
    if (!this.dirty || !this.file) return;
    // Les révisions sont attribuées au moment d'écrire : tout ce qui a muté
    // depuis le dernier flush est numéroté d'un coup, suppressions comprises.
    this.assignRevisions();
    const tmp = `${this.file}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error('[store] échec écriture', err);
    }
  }

  async backup(): Promise<string> {
    this.flushSync();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.backupDir, `backup-${stamp}.json`);
    await fsp.writeFile(target, JSON.stringify(this.data, null, 2), 'utf8');
    this.rotateBackups();
    return target;
  }

  private rotateBackups(keep = 20): void {
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
        .sort();
      while (files.length > keep) {
        const victim = files.shift();
        if (victim) fs.unlinkSync(path.join(this.backupDir, victim));
      }
    } catch {
      /* ignore */
    }
  }

  async restore(filePath: string): Promise<boolean> {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Database>;
    if (!parsed || typeof parsed !== 'object') return false;
    await this.backup();
    this.data = this.migrate(parsed);
    // Nouvelle génération : les fiches supprimées depuis la sauvegarde
    // ressusciteraient sans que les appareils s'en aperçoivent (leurs révisions
    // sont anciennes, aucun delta ne les renverrait). Changer de génération
    // leur dit « repars de zéro » — c'est correct par construction.
    const sync = this.data.sync ?? freshSyncMeta();
    this.data.sync = { ...sync, generation: newId('gen'), tombstones: {}, floorRev: 0 };
    this.rebuildFingerprints();
    this.dirty = true;
    this.flushSync();
    return true;
  }

  get backupFolder(): string {
    return this.backupDir;
  }

  listBackups(): string[] {
    try {
      return fs
        .readdirSync(this.backupDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .map((f) => path.join(this.backupDir, f));
    } catch {
      return [];
    }
  }
}

export const store = new Store();
