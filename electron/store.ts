import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Address, Attachment, Database, Settings, Vehicle } from '@shared/types';

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
  };
}

export class Store {
  private data: Database = emptyDatabase();
  private file = '';
  private backupDir = '';
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private loaded = false;

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
    this.flushSync();
    this.rotateBackups();
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
    // Le dossier surveillé doit toujours pointer quelque part de valide.
    if (!db.settings.watchFolder) db.settings.watchFolder = defaultWatchFolder();
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
