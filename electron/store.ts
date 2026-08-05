import { app } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Address, Attachment, Database, Settings, Vehicle } from '@shared/types';

const DB_VERSION = 1;

export function newId(prefix = ''): string {
  const raw = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
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
  let documents: string;
  try {
    documents = app.getPath('documents');
  } catch {
    documents = path.join(app.getPath('home'), 'Documents');
  }
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
    settings: { ...defaultSettings(), defaultVehicleId: vehicle.id },
  };
}

class Store {
  private data: Database = emptyDatabase();
  private file = '';
  private backupDir = '';
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private loaded = false;

  init(): void {
    if (this.loaded) return;
    const dir = app.getPath('userData');
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
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
    };
    if (!db.settings.defaultVehicleId && db.vehicles[0]) {
      db.settings.defaultVehicleId = db.vehicles[0].id;
    }
    // Le dossier surveillé doit toujours pointer quelque part de valide.
    if (!db.settings.watchFolder) db.settings.watchFolder = defaultWatchFolder();
    // Un dépôt sans coordonnées empêche tout calcul de tournée : on rétablit
    // celui de l'entreprise s'il a été vidé ou saisi sans géolocalisation.
    if (!db.settings.depot?.lat || !db.settings.depot?.lon) {
      db.settings.depot = { ...DEFAULT_DEPOT };
    }
    return db;
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
