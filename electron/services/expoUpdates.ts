import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

/**
 * Le serveur de mises à jour de l'application mobile — auto-hébergé.
 *
 * L'APK embarque `expo-updates`, qui interroge une adresse à chaque lancement
 * et remplace le code JavaScript de l'application par la version proposée.
 * Expo vend ce service en ligne ; son protocole est ouvert, et l'oldpc sait le
 * parler lui-même. Personne d'autre dans le circuit : le code part de git,
 * le serveur le compile, les téléphones le récupèrent.
 *
 * Le déclencheur est le même que tout le reste : **le serveur qui se met à
 * jour**. À chaque démarrage, si le commit a changé depuis la dernière
 * fabrication, l'export mobile est refait en arrière-plan. La mise à jour
 * nocturne du serveur entraîne donc, sans aucun geste, celle des téléphones
 * à leur prochaine ouverture.
 *
 * Ce qui voyage ainsi : le JavaScript uniquement. Un changement *natif*
 * (nouveau module, permission Android) exige toujours une nouvelle APK — le
 * garde-fou est la « runtime version » : un téléphone ne reçoit jamais une
 * mise à jour prévue pour une autre version native que la sienne.
 *
 * Les routes sont publiques (pas de jeton) : elles ne servent que du code
 * compilé — jamais de données — et le port n'est joignable que du réseau
 * local et du tailnet.
 */

/** Sous-dossier du dossier de données où vivent l'export et son état. */
const FOLDER = 'mobile-update';

const NPM_TIMEOUT_MS = 10 * 60_000;
const EXPORT_TIMEOUT_MS = 10 * 60_000;

/** Ce qu'on sait de la dernière fabrication. */
export interface MobileUpdateState {
  /** Commit du dépôt au moment de l'export. */
  commit: string;
  /** Version native que cette mise à jour exige (expo.version). */
  runtimeVersion: string;
  /** Identifiant de la mise à jour, au format UUID exigé par le protocole. */
  id: string;
  createdAt: string;
}

interface AssetEntry {
  /** Empreinte SHA-256 en base64url — c'est elle que le téléphone vérifie. */
  hash: string;
  /** Clé de téléchargement (MD5 hexadécimal du contenu). */
  key: string;
  fileExtension: string;
  contentType: string;
  /** Chemin relatif dans l'export, pour servir le fichier. */
  filePath: string;
}

interface ManifestBase {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: AssetEntry;
  assets: AssetEntry[];
}

const CONTENT_TYPES: Record<string, string> = {
  hbc: 'application/javascript',
  js: 'application/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
};

function contentTypeOf(ext: string): string {
  return CONTENT_TYPES[ext.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Le protocole veut un UUID : on met en forme le début d'une empreinte. */
export function hashToUuid(hexHash: string): string {
  const h = hexHash.padEnd(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function describeAsset(distDir: string, filePath: string, ext: string): AssetEntry {
  const content = fs.readFileSync(path.join(distDir, filePath));
  return {
    hash: base64url(crypto.createHash('sha256').update(content).digest()),
    key: crypto.createHash('md5').update(content).digest('hex'),
    fileExtension: `.${ext}`,
    contentType: contentTypeOf(ext),
    filePath,
  };
}

/**
 * Construit la description complète d'un export Metro (`expo export`), hashs
 * compris — calculés une fois ici plutôt qu'à chaque téléphone qui interroge.
 */
export function describeExport(distDir: string, runtimeVersion: string): ManifestBase {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(distDir, 'metadata.json'), 'utf8'),
  ) as {
    fileMetadata: {
      android?: { bundle: string; assets: { path: string; ext: string }[] };
    };
  };
  const android = metadata.fileMetadata.android;
  if (!android) throw new Error('Export sans plateforme Android.');

  const launchAsset = describeAsset(distDir, android.bundle, 'bundle');
  // Le paquet de démarrage se déclare en JavaScript, même compilé Hermes.
  launchAsset.contentType = 'application/javascript';

  return {
    // L'identifiant découle du contenu : le même code redonne le même
    // identifiant, et un téléphone déjà à jour n'a rien à retélécharger.
    id: hashToUuid(crypto.createHash('sha256').update(launchAsset.hash).digest('hex')),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    launchAsset,
    assets: android.assets.map((a) => describeAsset(distDir, a.path, a.ext)),
  };
}

/* ------------------------------------------------------------------ */
/* Fabrication                                                          */
/* ------------------------------------------------------------------ */

function statePath(dataDir: string): string {
  return path.join(dataDir, FOLDER, 'etat.json');
}

export function readMobileUpdateState(dataDir: string): MobileUpdateState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8')) as MobileUpdateState;
    return parsed.commit && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

/** La version native attendue : `expo.version` (politique « appVersion »). */
export function readRuntimeVersion(projectRoot: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'mobile', 'app.json'), 'utf8'),
    ) as { expo?: { version?: string } };
    return parsed.expo?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Fabrique la mise à jour mobile si le code a changé depuis la dernière fois.
 *
 * Longue (installation des dépendances puis export Metro) : à lancer en
 * arrière-plan, jamais sur le chemin du démarrage. Un échec est signalé au
 * journal et ne casse rien — les téléphones gardent alors la version
 * précédente, ou leur version embarquée.
 */
export async function prepareMobileUpdate(
  projectRoot: string,
  dataDir: string,
  log: (message: string) => void = (m) => console.log(m),
): Promise<MobileUpdateState | null> {
  const mobileDir = path.join(projectRoot, 'mobile');
  if (!fs.existsSync(path.join(mobileDir, 'app.json'))) return null;

  let commit = '';
  try {
    commit = (
      await exec('git rev-parse HEAD', { cwd: projectRoot, timeout: 20_000 })
    ).stdout.trim();
  } catch {
    log('[maj-mobile] dépôt git illisible : fabrication ignorée.');
    return null;
  }

  const previous = readMobileUpdateState(dataDir);
  if (previous?.commit === commit) return previous;

  const runtimeVersion = readRuntimeVersion(projectRoot);
  if (!runtimeVersion) {
    log('[maj-mobile] version introuvable dans mobile/app.json.');
    return null;
  }

  log(`[maj-mobile] le code a changé (${commit.slice(0, 7)}) : fabrication de la mise à jour…`);
  const target = path.join(dataDir, FOLDER);
  const dist = path.join(target, 'dist');

  try {
    await exec('npm install --no-audit --no-fund', { cwd: mobileDir, timeout: NPM_TIMEOUT_MS });
    // Export dans un dossier provisoire : la version en service reste
    // entière si la fabrication échoue à mi-chemin.
    const fresh = path.join(target, 'dist-en-cours');
    fs.rmSync(fresh, { recursive: true, force: true });
    await exec(
      `npx expo export --platform android --output-dir ${JSON.stringify(fresh)}`,
      { cwd: mobileDir, timeout: EXPORT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );

    const base = describeExport(fresh, runtimeVersion);
    fs.writeFileSync(path.join(fresh, 'manifest-base.json'), JSON.stringify(base, null, 2));

    fs.rmSync(dist, { recursive: true, force: true });
    fs.renameSync(fresh, dist);

    const state: MobileUpdateState = {
      commit,
      runtimeVersion,
      id: base.id,
      createdAt: base.createdAt,
    };
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(statePath(dataDir), `${JSON.stringify(state, null, 2)}\n`);
    log(
      `[maj-mobile] prête (${base.id.slice(0, 8)}, runtime ${runtimeVersion}) : les téléphones la prendront à leur prochaine ouverture.`,
    );
    return state;
  } catch (err) {
    log(`[maj-mobile] fabrication impossible : ${(err as Error).message?.slice(0, 300)}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Service aux téléphones                                               */
/* ------------------------------------------------------------------ */

/**
 * Le manifeste servi à un téléphone, protocole expo-updates version 0.
 *
 * `null` quand il n'y a rien à proposer — pas encore de fabrication, ou une
 * version native différente : un téléphone resté sur une ancienne APK ne doit
 * jamais recevoir du code prévu pour une autre.
 */
export function buildManifest(
  dataDir: string,
  requestedRuntime: string | null,
  baseUrl: string,
): object | null {
  const state = readMobileUpdateState(dataDir);
  if (!state) return null;
  if (requestedRuntime && requestedRuntime !== state.runtimeVersion) return null;

  let base: ManifestBase;
  try {
    base = JSON.parse(
      fs.readFileSync(path.join(dataDir, FOLDER, 'dist', 'manifest-base.json'), 'utf8'),
    ) as ManifestBase;
  } catch {
    return null;
  }

  const withUrl = (asset: AssetEntry) => ({
    hash: asset.hash,
    key: asset.key,
    fileExtension: asset.fileExtension,
    contentType: asset.contentType,
    url: `${baseUrl}/expo/assets/${asset.key}`,
  });

  return {
    id: base.id,
    createdAt: base.createdAt,
    runtimeVersion: base.runtimeVersion,
    launchAsset: withUrl(base.launchAsset),
    assets: base.assets.map(withUrl),
    metadata: {},
    extra: {},
  };
}

/** Le fichier derrière une clé de téléchargement, ou `null`. */
export function resolveAsset(
  dataDir: string,
  key: string,
): { file: string; contentType: string } | null {
  // La clé vient du réseau : rien d'autre qu'une empreinte hexadécimale.
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  try {
    const base = JSON.parse(
      fs.readFileSync(path.join(dataDir, FOLDER, 'dist', 'manifest-base.json'), 'utf8'),
    ) as ManifestBase;
    const all = [base.launchAsset, ...base.assets];
    const found = all.find((a) => a.key === key);
    if (!found) return null;
    const file = path.join(dataDir, FOLDER, 'dist', found.filePath);
    return fs.existsSync(file) ? { file, contentType: found.contentType } : null;
  } catch {
    return null;
  }
}
