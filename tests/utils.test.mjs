import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumber,
  parseDate,
  similarity,
  normalize,
  parseCsv,
  sniffDelimiter,
  decodeText,
  guessMapping,
  CLIENT_FIELDS,
  PRODUCT_FIELDS,
  googleMapsUrls,
  wazeUrls,
  appleMapsUrls,
} from './build/services.mjs';

test('lecture des nombres au format français et anglais', () => {
  assert.equal(parseNumber('1 234,56 €'), 1234.56);
  assert.equal(parseNumber('1 234,56'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('-45,20'), -45.2);
  assert.equal(parseNumber('3'), 3);
  assert.equal(parseNumber('106,80 €'), 106.8);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('néant'), null);
  assert.equal(parseNumber(8.9), 8.9);
});

test('lecture des dates', () => {
  assert.equal(parseDate('14/03/2026'), '2026-03-14');
  assert.equal(parseDate('14-03-2026'), '2026-03-14');
  assert.equal(parseDate('2026-03-14'), '2026-03-14');
  assert.equal(parseDate('2 avril 2026'), '2026-04-02');
  assert.equal(parseDate('15 déc. 2025'), '2025-12-15');
  assert.equal(parseDate('20260314'), '2026-03-14');
  assert.equal(parseDate('pas une date'), null);
});

test('normalisation et similarité de libellés', () => {
  assert.equal(normalize('Coupelle CARTON 100 ml (x50)'), 'coupelle carton 100 ml x 50');
  assert.ok(similarity('Coupelle carton 100 ml', 'coupelle carton 100ml') > 0.85);
  assert.ok(similarity('Coupelle carton 100 ml (x50)', 'Coupelle carton 100 ml') > 0.7);
  assert.ok(similarity('Cuillère bois 95mm', 'Bac inox 5L') < 0.3);
  assert.equal(similarity('', 'quelque chose'), 0);
});

test('CSV : séparateur, guillemets et sauts de ligne internes', () => {
  const csv = 'nom;ville;notes\n"Dupont; SARL";La Baule;"ligne 1\nligne 2"\nMartin;Pornic;ok\n';
  assert.equal(sniffDelimiter(csv), ';');
  const rows = parseCsv(csv, ';');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['Dupont; SARL', 'La Baule', 'ligne 1\nligne 2']);
  assert.deepEqual(rows[2], ['Martin', 'Pornic', 'ok']);
});

test('CSV séparé par virgules', () => {
  const csv = 'a,b,c\n1,2,3\n4,5,6';
  assert.equal(sniffDelimiter(csv), ',');
  assert.deepEqual(parseCsv(csv, ',')[2], ['4', '5', '6']);
});

test('décodage Windows-1252 des exports comptables', () => {
  const utf8 = Buffer.from('Société Générale — Prêt', 'utf8');
  assert.equal(decodeText(utf8).text, 'Société Générale — Prêt');
  assert.equal(decodeText(utf8).encoding, 'utf-8');

  const latin = Buffer.from([0x53, 0x6f, 0x63, 0x69, 0xe9, 0x74, 0xe9]); // "Société"
  const decoded = decodeText(latin);
  assert.equal(decoded.text, 'Société');
  assert.equal(decoded.encoding, 'windows-1252');
});

test('reconnaissance automatique des colonnes clients', () => {
  const headers = ['Code client', 'Raison sociale', 'E-mail', 'Téléphone', 'Adresse', 'CP', 'Ville', 'SIRET'];
  const mapping = guessMapping(headers, CLIENT_FIELDS);
  assert.equal(mapping.code, 'Code client');
  assert.equal(mapping.name, 'Raison sociale');
  assert.equal(mapping.email, 'E-mail');
  assert.equal(mapping.phone, 'Téléphone');
  assert.equal(mapping.street, 'Adresse');
  assert.equal(mapping.postcode, 'CP');
  assert.equal(mapping.city, 'Ville');
  assert.equal(mapping.siret, 'SIRET');
});

test('reconnaissance automatique des colonnes produits', () => {
  const headers = ['Référence', 'Désignation', 'Unité', 'Stock actuel', 'Stock mini', 'Prix achat', 'Fournisseur'];
  const mapping = guessMapping(headers, PRODUCT_FIELDS);
  assert.equal(mapping.sku, 'Référence');
  assert.equal(mapping.name, 'Désignation');
  assert.equal(mapping.unit, 'Unité');
  assert.equal(mapping.qtyOnHand, 'Stock actuel');
  assert.equal(mapping.minQty, 'Stock mini');
  assert.equal(mapping.unitCost, 'Prix achat');
  assert.equal(mapping.supplier, 'Fournisseur');
});

test('liens Google Maps avec étapes intermédiaires', () => {
  const points = [
    { label: 'Dépôt', lat: 47.2733, lon: -2.2134 },
    { label: 'La Baule', lat: 47.2864, lon: -2.3933 },
    { label: 'Pornichet', lat: 47.2653, lon: -2.3397 },
  ];
  const [segment] = googleMapsUrls(points);
  const url = new URL(segment.url);
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('origin'), '47.273300,-2.213400');
  assert.equal(url.searchParams.get('destination'), '47.265300,-2.339700');
  assert.equal(url.searchParams.get('waypoints'), '47.286400,-2.393300');
  assert.equal(url.searchParams.get('travelmode'), 'driving');
});

test('Google Maps : découpage au-delà de la limite d’étapes', () => {
  const points = Array.from({ length: 25 }, (_, i) => ({
    label: `Arrêt ${i}`,
    lat: 47 + i * 0.01,
    lon: -2 - i * 0.01,
  }));
  const segments = googleMapsUrls(points);
  assert.ok(segments.length > 1, 'la tournée doit être découpée en plusieurs liens');
  // Chaque segment reprend le dernier point du précédent : aucun trou.
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].from, segments[i - 1].to);
  }
  assert.equal(segments[0].from, 'Arrêt 0');
  assert.equal(segments[segments.length - 1].to, 'Arrêt 24');
  for (const s of segments) {
    const u = new URL(s.url);
    const wp = u.searchParams.get('waypoints');
    assert.ok(!wp || wp.split('|').length <= 9, 'maximum 9 étapes intermédiaires par lien');
  }
});

test('Waze : un lien de navigation par étape', () => {
  const points = [
    { label: 'Dépôt', lat: 47.2733, lon: -2.2134 },
    { label: 'La Baule', lat: 47.2864, lon: -2.3933 },
    { label: 'Pornichet', lat: 47.2653, lon: -2.3397 },
  ];
  const segments = wazeUrls(points);
  assert.equal(segments.length, 2);
  assert.match(segments[0].url, /^https:\/\/waze\.com\/ul\?ll=47\.286400,-2\.393300&navigate=yes$/);
  assert.equal(segments[1].to, 'Pornichet');
});

test('Plans (Apple) : chaînage des étapes', () => {
  const points = [
    { label: 'Dépôt', lat: 47.2733, lon: -2.2134 },
    { label: 'La Baule', lat: 47.2864, lon: -2.3933 },
    { label: 'Pornichet', lat: 47.2653, lon: -2.3397 },
  ];
  const [segment] = appleMapsUrls(points);
  assert.match(segment.url, /maps\.apple\.com/);
  assert.match(decodeURIComponent(segment.url), /daddr=47\.286400,-2\.393300\+to:47\.265300,-2\.339700/);
});

test('adresse en clair acceptée quand les coordonnées manquent', () => {
  const [segment] = googleMapsUrls([
    { label: 'Dépôt', address: '12 rue des Sables, 44600 Saint-Nazaire' },
    { label: 'Client', address: '8 avenue de la Plage, 44500 La Baule' },
  ]);
  const url = new URL(segment.url);
  assert.equal(url.searchParams.get('origin'), '12 rue des Sables, 44600 Saint-Nazaire');
});
