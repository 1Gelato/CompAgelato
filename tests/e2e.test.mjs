/**
 * Test de bout en bout : lance réellement l'application Electron, parcourt les
 * écrans et vérifie que le circuit complet fonctionne — import d'un dossier de
 * factures, rattachement client, déduction du stock, optimisation de tournée.
 *
 * Chaque exécution utilise un profil et un dossier surveillé neufs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-e2e-'));
const userData = path.join(workspace, 'profil');
const watchFolder = path.join(workspace, 'Documents', 'CompaGelato');

fs.mkdirSync(path.join(watchFolder, 'Factures'), { recursive: true });
fs.mkdirSync(path.join(watchFolder, 'Devis'), { recursive: true });
fs.mkdirSync(path.join(watchFolder, 'Clients'), { recursive: true });

// Les PDF de test servent de factures déposées par le logiciel de comptabilité.
const pdfDir = path.join(here, 'fixtures', 'pdf');
fs.copyFileSync(path.join(pdfDir, 'FA-2026-0142.pdf'), path.join(watchFolder, 'Factures', 'FA-2026-0142.pdf'));
fs.copyFileSync(path.join(pdfDir, 'FA-2026-0143.pdf'), path.join(watchFolder, 'Factures', 'FA-2026-0143.pdf'));
fs.copyFileSync(path.join(pdfDir, 'DE-2026-0031.pdf'), path.join(watchFolder, 'Devis', 'DE-2026-0031.pdf'));

// Liste clients exportée d'un logiciel de comptabilité : séparateur « ; », accents Windows-1252.
const clientsCsv = [
  'Code client;Raison sociale;E-mail;Téléphone;Adresse;CP;Ville;SIRET',
  'C001;LE COMPTOIR DES GLACES SARL;contact@comptoir.fr;0240112233;8 avenue de la Plage;44500;La Baule;81234567800019',
  'C002;Restaurant La Dune;resa@ladune.fr;0240445566;3 boulevard Océan;44420;Piriac-sur-Mer;',
  'C003;Mairie de Pornichet;evenements@pornichet.fr;0240610303;Place du Marché;44380;Pornichet;',
].join('\r\n');
const clientsFile = path.join(watchFolder, 'Clients', 'clients.csv');
fs.writeFileSync(clientsFile, Buffer.from(clientsCsv, 'latin1'));

// Catalogue de consommables.
const stockCsv = [
  'Référence;Désignation;Unité;Stock actuel;Stock mini;Prix achat;Fournisseur',
  'CUP-100;Coupelle carton 100 ml (x50);carton;40;20;8,90;EmballagePro',
  'SPO-BOI;Cuillère bois 95 mm (x100);carton;30;18;4,20;EcoTable',
  'BAC-5L;Bac inox 5 L;pièce;10;8;23,50;FroidOuest',
  'SAC-KR;Sachet kraft imprimé (x250);carton;12;6;31,00;EmballagePro',
  'CON-STD;Cornet gaufré standard (x120);carton;25;15;12,40;EmballagePro',
].join('\r\n');
const stockFile = path.join(workspace, 'stock.csv');
fs.writeFileSync(stockFile, Buffer.from(stockCsv, 'utf8'));

let app;
let page;

test.before(async () => {
  app = await electron.launch({
    args: [path.join(root, 'dist/main/main.mjs'), `--user-data-dir=${userData}`, '--no-sandbox'],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.sidebar__name', { timeout: 30000 });

  // Redirige le dossier surveillé vers l'espace de test, puis analyse.
  await app.evaluate(async (_electronApi, folder) => {
    const { ipcMain } = require('electron');
    void ipcMain;
    return folder;
  }, watchFolder).catch(() => {});

  await page.evaluate(async (folder) => {
    await window.api.settings.update({ watchFolder: folder, autoScan: false, autoCreateClients: true });
  }, watchFolder);
});

test.after(async () => {
  await app?.close();
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* nettoyage best-effort */
  }
});

test('la fenêtre s’ouvre sur le tableau de bord', async () => {
  assert.equal(await page.title(), 'CompaGelato');
  await page.waitForSelector('h1');
  assert.match(await page.textContent('h1'), /Tableau de bord/);

  const navLabels = await page.$$eval('.navitem', (items) => items.map((i) => i.textContent.trim()));
  for (const expected of ['Tableau de bord', 'Documents', 'Clients', 'Stock', 'Tournées', 'Réglages']) {
    assert.ok(
      navLabels.some((l) => l.startsWith(expected)),
      `entrée de menu manquante : ${expected}`,
    );
  }
});

test('import de la liste clients depuis un CSV Windows-1252', async () => {
  const report = await page.evaluate((file) => window.api.clients.importFrom(file), clientsFile);
  assert.equal(report.created, 3, `clients créés : ${JSON.stringify(report)}`);
  assert.equal(report.mapping.name, 'Raison sociale');
  assert.equal(report.mapping.postcode, 'CP');

  const clients = await page.evaluate(() => window.api.clients.list());
  const comptoir = clients.find((c) => c.name.includes('COMPTOIR'));
  assert.ok(comptoir, 'client « Le Comptoir » absent');
  // Les accents doivent survivre au décodage.
  const piriac = clients.find((c) => c.address.city === 'Piriac-sur-Mer');
  assert.ok(piriac, 'ville accentuée mal décodée');
  assert.equal(comptoir.address.postcode, '44500');
  assert.equal(comptoir.siret, '81234567800019');
});

test('import du catalogue de consommables', async () => {
  const report = await page.evaluate((file) => window.api.products.importFrom(file), stockFile);
  assert.equal(report.created, 5, JSON.stringify(report));

  const products = await page.evaluate(() => window.api.products.list());
  const cup = products.find((p) => p.sku === 'CUP-100');
  assert.ok(cup);
  assert.equal(cup.qtyOnHand, 40);
  assert.equal(cup.minQty, 20);
  assert.equal(cup.unitCost, 8.9);
});

test('analyse du dossier : les PDF deviennent des documents rattachés aux clients', async () => {
  const report = await page.evaluate(() => window.api.documents.scan({ force: true }));
  assert.equal(report.failed, 0, `échecs : ${JSON.stringify(report.errors)}`);
  assert.equal(report.imported, 3, `importés : ${report.imported} / ${report.scanned}`);

  const documents = await page.evaluate(() => window.api.documents.list());
  assert.equal(documents.length, 3);

  const facture = documents.find((d) => d.number === 'FA-2026-0142');
  assert.ok(facture, 'facture FA-2026-0142 absente');
  assert.equal(facture.kind, 'invoice');
  assert.equal(facture.date, '2026-03-14');
  assert.equal(facture.totalHT, 319);
  assert.equal(facture.totalTTC, 382.8);
  assert.equal(facture.lines.length, 4);

  // Rattachement automatique au client importé (nom identique sur la facture).
  const clients = await page.evaluate(() => window.api.clients.list());
  const comptoir = clients.find((c) => c.name.includes('COMPTOIR'));
  assert.equal(facture.clientId, comptoir.id, 'facture non rattachée au bon client');

  // Le devis doit être reconnu comme tel grâce au sous-dossier et au contenu.
  const devis = documents.find((d) => d.number === 'DE-2026-0031');
  assert.ok(devis);
  assert.equal(devis.kind, 'quote');
});

test('les lignes de facture sont associées aux consommables du stock', async () => {
  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.number === 'FA-2026-0142');
  const products = await page.evaluate(() => window.api.products.list());

  const bySku = new Map(products.map((p) => [p.id, p.sku]));
  const associated = facture.lines.map((l) => ({ label: l.label, sku: bySku.get(l.productId) ?? null }));

  assert.equal(
    associated.filter((a) => a.sku).length,
    4,
    `lignes non associées : ${JSON.stringify(associated)}`,
  );
  assert.equal(associated.find((a) => a.label.includes('Coupelle')).sku, 'CUP-100');
  assert.equal(associated.find((a) => a.label.includes('Bac inox')).sku, 'BAC-5L');
});

test('la déduction de stock retire les bonnes quantités et se laisse annuler', async () => {
  const before = await page.evaluate(() => window.api.products.list());
  const cupBefore = before.find((p) => p.sku === 'CUP-100').qtyOnHand;

  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.number === 'FA-2026-0142');

  const report = await page.evaluate((id) => window.api.stock.apply(id), facture.id);
  assert.equal(report.applied, 4, report.message);

  const after = await page.evaluate(() => window.api.products.list());
  // La facture porte 12 cartons de coupelles.
  assert.equal(after.find((p) => p.sku === 'CUP-100').qtyOnHand, cupBefore - 12);
  assert.equal(after.find((p) => p.sku === 'BAC-5L').qtyOnHand, 10 - 4);
  assert.equal(after.find((p) => p.sku === 'SPO-BOI').qtyOnHand, 30 - 6);

  // Idempotence : une seconde application ne doit rien déduire.
  const again = await page.evaluate((id) => window.api.stock.apply(id), facture.id);
  assert.equal(again.applied, 0);
  const unchanged = await page.evaluate(() => window.api.products.list());
  assert.equal(unchanged.find((p) => p.sku === 'CUP-100').qtyOnHand, cupBefore - 12);

  // Un mouvement daté est enregistré pour chaque ligne.
  const moves = await page.evaluate(() => window.api.stock.moves());
  const cupMove = moves.find((m) => m.documentNumber === 'FA-2026-0142' && m.qty === -12);
  assert.ok(cupMove, 'mouvement de stock manquant');
  assert.equal(cupMove.type, 'out');

  // Annulation.
  await page.evaluate((id) => window.api.stock.revert(id), facture.id);
  const reverted = await page.evaluate(() => window.api.products.list());
  assert.equal(reverted.find((p) => p.sku === 'CUP-100').qtyOnHand, cupBefore);
});

test('un devis n’impacte pas le stock', async () => {
  const documents = await page.evaluate(() => window.api.documents.list());
  const devis = documents.find((d) => d.kind === 'quote');
  const report = await page.evaluate((id) => window.api.stock.apply(id), devis.id);
  assert.equal(report.applied, 0);
  assert.match(report.message, /devis/i);
});

test('une seconde analyse ne crée pas de doublons', async () => {
  const first = await page.evaluate(() => window.api.documents.list());
  const report = await page.evaluate(() => window.api.documents.scan({}));
  assert.equal(report.imported, 0, 'un fichier inchangé ne doit pas être réimporté');
  const second = await page.evaluate(() => window.api.documents.list());
  assert.equal(second.length, first.length);
});

test('optimisation de tournée avec arrêt épinglé et calcul du coût', async () => {
  const result = await page.evaluate(async () => {
    const clients = await window.api.clients.list();
    const stops = clients
      .filter((c) => typeof c.address.lat === 'number')
      .map((c) => ({
        id: `stp_${c.id}`,
        clientId: c.id,
        label: c.name,
        address: c.address,
        pinned: false,
        serviceMinutes: 10,
      }));
    return { count: stops.length };
  });

  // Les clients importés n'ont pas de coordonnées (pas de géocodage hors ligne) :
  // on construit la tournée avec des adresses géolocalisées explicites.
  assert.equal(result.count, 0, 'les fiches importées ne doivent pas être géolocalisées d’office');

  const optimization = await page.evaluate(async () => {
    const point = (label, lat, lon, pinned = false, pinnedIndex) => ({
      id: `stp_${label}`,
      label,
      address: { label, lat, lon, country: 'France' },
      pinned,
      pinnedIndex,
      serviceMinutes: 10,
    });

    // Ordre volontairement mauvais : le dépôt est à Saint-Nazaire.
    const route = {
      id: 'rte_test',
      name: 'Test',
      date: '2026-07-01',
      start: point('Dépôt Saint-Nazaire', 47.2733, -2.2134),
      stops: [
        point('Le Croisic', 47.2925, -2.5133),
        point('Pornichet', 47.2653, -2.3397, true, 0),
        point('Piriac', 47.3789, -2.5461),
        point('La Baule', 47.2864, -2.3933),
      ],
      returnToStart: true,
      end: null,
      tollCost: 0,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    };

    const optimized = await window.api.routes.optimize(route, { returnToStart: true });
    return {
      order: optimized.route.stops.map((s) => s.label),
      before: optimized.result.before,
      after: optimized.result.after,
      savedKm: optimized.result.savedKm,
      computation: optimized.computation,
    };
  });

  // L'arrêt épinglé reste en première position.
  assert.equal(optimization.order[0], 'Pornichet', `ordre obtenu : ${optimization.order.join(' → ')}`);
  assert.equal(optimization.order.length, 4);
  assert.ok(optimization.after.distanceKm <= optimization.before.distanceKm + 0.001);
  assert.ok(optimization.computation.distanceKm > 0, 'distance nulle');
  assert.ok(optimization.computation.fuelCost > 0, 'coût carburant nul');
  assert.ok(
    optimization.computation.totalCost >= optimization.computation.fuelCost,
    'le coût total doit inclure le carburant',
  );
  assert.equal(optimization.computation.serviceMin, 40);
});

test('génération du lien d’itinéraire et du QR code', async () => {
  const links = await page.evaluate(async () => {
    const point = (label, lat, lon) => ({
      id: `stp_${label}`,
      label,
      address: { label, lat, lon, country: 'France' },
      pinned: false,
      serviceMinutes: 10,
    });
    const route = {
      id: 'rte_link',
      name: 'Lien',
      date: '2026-07-01',
      start: point('Dépôt', 47.2733, -2.2134),
      stops: [point('La Baule', 47.2864, -2.3933), point('Pornichet', 47.2653, -2.3397)],
      returnToStart: true,
      end: null,
      tollCost: 0,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    };
    const google = await window.api.routes.link(route, 'google');
    const waze = await window.api.routes.link(route, 'waze');
    return { google, waze };
  });

  assert.match(links.google.url, /^https:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.match(links.google.url, /waypoints=/);
  assert.match(links.google.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(links.google.qrDataUrl.length > 500, 'QR code vide');
  assert.equal(links.waze.segments.length, 3, 'Waze : un lien par étape');
  assert.match(links.waze.segments[0].url, /waze\.com\/ul/);
});

test('exports CSV et sauvegarde de la base', async () => {
  const files = await page.evaluate(async () => ({
    documents: await window.api.documents.exportCsv(),
    clients: await window.api.clients.exportCsv(),
    stock: await window.api.products.exportCsv(),
    backup: await window.api.db.backup(),
  }));

  for (const [name, file] of Object.entries(files)) {
    assert.ok(file && fs.existsSync(file), `export ${name} manquant : ${file}`);
    assert.ok(fs.statSync(file).size > 40, `export ${name} vide`);
  }
  const csv = fs.readFileSync(files.clients, 'utf8');
  assert.ok(csv.startsWith('﻿'), 'BOM UTF-8 attendu pour Excel');
  assert.match(csv, /Piriac-sur-Mer/);
});

test('le tableau de bord agrège correctement', async () => {
  const stats = await page.evaluate(() => window.api.stats.dashboard());
  assert.equal(stats.clients, 3);
  assert.equal(stats.invoices, 2);
  assert.equal(stats.quotes, 1);
  // 319,00 + 143,70 HT
  assert.ok(Math.abs(stats.revenueHT - 462.7) < 0.01, `CA HT : ${stats.revenueHT}`);
  assert.equal(stats.monthlyRevenue.length, 12);
});

test('navigation dans l’interface : chaque écran s’affiche', async () => {
  const screens = [
    ['Documents', /Factures et devis/],
    ['Clients', /Clients/],
    ['Stock', /Stock de consommables/],
    ['Tournées', /Tournées de livraison/],
    ['Réglages', /Réglages/],
    ['Tableau de bord', /Tableau de bord/],
  ];

  for (const [label, expected] of screens) {
    await page.click(`.navitem:has-text("${label}")`);
    await page.waitForTimeout(260);
    const title = await page.textContent('h1');
    assert.match(title, expected, `écran « ${label} » : titre « ${title} »`);
  }

  // Le tableau des documents doit être peuplé après les imports.
  await page.click('.navitem:has-text("Documents")');
  await page.waitForSelector('table.data tbody tr');
  const rows = await page.$$('table.data tbody tr');
  assert.equal(rows.length, 3, 'trois documents attendus dans le tableau');
  const body = await page.textContent('table.data');
  assert.match(body, /FA-2026-0142/);
  assert.match(body, /382,80/, 'montant formaté à la française attendu');
});

test('aucune erreur console pendant la session', async () => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.click('.navitem:has-text("Tournées")');
  await page.waitForTimeout(400);
  await page.click('.navitem:has-text("Tableau de bord")');
  await page.waitForTimeout(400);
  assert.deepEqual(errors, []);
});
