import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  describeExport,
  buildManifest,
  resolveAsset,
  hashToUuid,
} from './build/services.mjs';

/**
 * Le serveur de mises à jour mobiles parle le protocole d'expo-updates. Un
 * détail faux — un hash mal encodé, une clé qui ne correspond pas — et le
 * téléphone rejette la mise à jour sans un mot : tout se vérifie donc ici,
 * sur un export fabriqué de toutes pièces dont on connaît chaque octet.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-expo-'));
const dataDir = path.join(dir, 'donnees');
const dist = path.join(dataDir, 'mobile-update', 'dist');

/** Un faux export Metro : un bundle, une image, une police. */
function fabricateExport() {
  fs.mkdirSync(path.join(dist, '_expo/static/js/android'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

  const bundle = Buffer.from('code javascript compilé');
  const image = Buffer.from('fausse image png');
  const police = Buffer.from('fausse police ttf');

  const imageKey = crypto.createHash('md5').update(image).digest('hex');
  const policeKey = crypto.createHash('md5').update(police).digest('hex');

  fs.writeFileSync(path.join(dist, '_expo/static/js/android/index-abc.hbc'), bundle);
  fs.writeFileSync(path.join(dist, 'assets', imageKey), image);
  fs.writeFileSync(path.join(dist, 'assets', policeKey), police);
  fs.writeFileSync(
    path.join(dist, 'metadata.json'),
    JSON.stringify({
      version: 0,
      bundler: 'metro',
      fileMetadata: {
        android: {
          bundle: '_expo/static/js/android/index-abc.hbc',
          assets: [
            { path: `assets/${imageKey}`, ext: 'png' },
            { path: `assets/${policeKey}`, ext: 'ttf' },
          ],
        },
      },
    }),
  );
  return { bundle, image, imageKey, policeKey };
}

const fabriques = fabricateExport();

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* La description d'un export                                          */
/* ------------------------------------------------------------------ */

test('les hashs sont ceux que le téléphone recalculera', () => {
  const base = describeExport(dist, '1.0.0');

  // SHA-256 en base64url : c'est la comparaison que fait expo-updates après
  // téléchargement — un octet de différence et la mise à jour est rejetée.
  const attendu = crypto
    .createHash('sha256')
    .update(fabriques.bundle)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(base.launchAsset.hash, attendu);
  assert.equal(base.launchAsset.contentType, 'application/javascript');

  // La clé de téléchargement est le MD5 du contenu — pour les assets Metro,
  // c'est déjà leur nom de fichier.
  assert.equal(base.assets[0].key, fabriques.imageKey);
  assert.equal(base.assets[0].contentType, 'image/png');
  assert.equal(base.assets[1].contentType, 'font/ttf');
  assert.equal(base.runtimeVersion, '1.0.0');
});

test('le même code redonne le même identifiant', () => {
  // L'identifiant découle du contenu : un téléphone déjà à jour reconnaît la
  // mise à jour qu'il porte et ne retélécharge rien.
  const a = describeExport(dist, '1.0.0');
  const b = describeExport(dist, '1.0.0');
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('hashToUuid met une empreinte au format UUID', () => {
  assert.equal(
    hashToUuid('0123456789abcdef0123456789abcdef'),
    '01234567-89ab-cdef-0123-456789abcdef',
  );
});

/* ------------------------------------------------------------------ */
/* Le manifeste servi                                                  */
/* ------------------------------------------------------------------ */

function publier() {
  const base = describeExport(dist, '1.0.0');
  fs.writeFileSync(path.join(dist, 'manifest-base.json'), JSON.stringify(base));
  fs.writeFileSync(
    path.join(dataDir, 'mobile-update', 'etat.json'),
    JSON.stringify({ commit: 'abc', runtimeVersion: '1.0.0', id: base.id, createdAt: base.createdAt }),
  );
  return base;
}

test('le manifeste porte des adresses complètes vers chaque fichier', () => {
  const base = publier();
  const manifest = buildManifest(dataDir, '1.0.0', 'http://100.100.53.66:4680');
  assert.ok(manifest, 'aucun manifeste servi');
  assert.equal(manifest.id, base.id);
  assert.equal(
    manifest.launchAsset.url,
    `http://100.100.53.66:4680/expo/assets/${base.launchAsset.key}`,
  );
  assert.equal(manifest.assets.length, 2);
  // Les champs internes ne sortent pas : le protocole ne les connaît pas.
  assert.equal(manifest.launchAsset.filePath, undefined);
});

test('un téléphone d’une autre version native ne reçoit rien', () => {
  publier();
  // APK restée en 0.9 : lui servir du code prévu pour la 1.0 le ferait
  // planter au démarrage — le refus est la seule réponse sûre.
  assert.equal(buildManifest(dataDir, '0.9.0', 'http://x'), null);
  // Sans en-tête de version (curl, navigateur) : on sert, à titre de contrôle.
  assert.ok(buildManifest(dataDir, null, 'http://x'));
});

test('les fichiers se servent par leur clé, et uniquement par une clé saine', () => {
  publier();
  const asset = resolveAsset(dataDir, fabriques.imageKey);
  assert.ok(asset, 'asset introuvable');
  assert.equal(asset.contentType, 'image/png');
  assert.ok(fs.existsSync(asset.file));

  // Une clé est une empreinte hexadécimale, rien d'autre : pas de chemin, pas
  // de traversée de dossiers.
  assert.equal(resolveAsset(dataDir, '../etat.json'), null);
  assert.equal(resolveAsset(dataDir, 'assets/../../compagelato-data.json'), null);
  assert.equal(resolveAsset(dataDir, 'f'.repeat(31)), null);
  assert.equal(resolveAsset(dataDir, 'inconnu'.padEnd(32, '0')), null);
});

test('sans fabrication, le manifeste dit simplement qu’il n’y a rien', () => {
  const vide = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-expo-vide-'));
  assert.equal(buildManifest(vide, '1.0.0', 'http://x'), null);
  fs.rmSync(vide, { recursive: true, force: true });
});
