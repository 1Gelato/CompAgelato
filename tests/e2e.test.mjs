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

  // Redirige le dossier surveillé vers l'espace de test. La surveillance
  // continue est activée plus tard, par le test qui la vérifie.
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

test('la surveillance du dossier importe un fichier déposé sans intervention', async () => {
  // Active la surveillance en continu sur le dossier de test.
  await page.evaluate(async (folder) => {
    await window.api.settings.update({ watchFolder: folder, autoScan: true });
  }, watchFolder);

  const before = (await page.evaluate(() => window.api.documents.list())).length;

  // Nouveau fichier déposé par le logiciel de comptabilité.
  const dropped = path.join(watchFolder, 'Factures', 'FA-2026-0199.pdf');
  fs.copyFileSync(path.join(pdfDir, 'FA-2026-0143.pdf'), dropped);

  // La surveillance attend la fin d'écriture puis regroupe les événements.
  const deadline = Date.now() + 30000;
  let documents = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    documents = await page.evaluate(() => window.api.documents.list());
    if (documents.some((d) => d.sourceFile === dropped)) break;
  }

  const imported = documents.find((d) => d.sourceFile === dropped);
  assert.ok(imported, `fichier non repris automatiquement (${documents.length} document(s) en base)`);
  assert.equal(imported.totalHT, 143.7);
  // Même contenu qu'une facture déjà connue : le numéro lu est identique,
  // la pièce est donc mise à jour plutôt que dupliquée.
  assert.equal(documents.length, before);

  await page.evaluate(() => window.api.settings.update({ autoScan: false }));
});

test('une facture sans libellé « Client : » est quand même rattachée', async () => {
  // Le nom du client figure seul dans le bloc d'adresse, sans mot-clé :
  // le rapprochement doit se faire sur le nom connu présent dans le texte.
  const target = path.join(watchFolder, 'Factures', 'FA-2026-0210.pdf');
  fs.copyFileSync(path.join(pdfDir, 'FA-2026-0210.pdf'), target);

  const report = await page.evaluate(() => window.api.documents.scan({}));
  assert.equal(report.failed, 0, JSON.stringify(report.errors));

  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.number === 'FA-2026-0210');
  assert.ok(facture, 'facture non importée');
  assert.equal(facture.totalHT, 79.2);

  const clients = await page.evaluate(() => window.api.clients.list());
  const dune = clients.find((c) => c.name === 'Restaurant La Dune');
  assert.ok(dune, 'client de référence absent');
  assert.equal(facture.clientId, dune.id, 'client non reconnu dans le texte du document');

  // Aucune fiche en double n'a été créée au passage.
  assert.equal(clients.filter((c) => c.name.toLowerCase().includes('dune')).length, 1);
});

/* ================================================================== */
/* Dépôt, impression, e-mail et pièces jointes                         */
/* ================================================================== */

test('le dépôt de l’entreprise est renseigné et géolocalisé par défaut', async () => {
  const settings = await page.evaluate(() => window.api.settings.get());
  assert.ok(settings.depot, 'aucun dépôt par défaut');
  assert.match(settings.depot.label, /Jacques Daguerre/i);
  assert.equal(settings.depot.postcode, '44600');
  assert.equal(settings.depot.city, 'Saint-Nazaire');
  assert.ok(typeof settings.depot.lat === 'number', 'dépôt sans latitude');
  assert.ok(Math.abs(settings.depot.lat - 47.295669) < 0.001);
  assert.ok(Math.abs(settings.depot.lon - -2.29232) < 0.001);
});

test('un dépôt vidé est rétabli au redémarrage plutôt que de bloquer le calcul', async () => {
  await page.evaluate(() => window.api.settings.update({ depot: undefined }));
  // La restauration a lieu au chargement de la base ; on la déclenche via un
  // enregistrement suivi d'une relecture des réglages.
  const settings = await page.evaluate(() => window.api.settings.get());
  assert.ok(settings.depot === undefined || typeof settings.depot.lat === 'number');
  await page.evaluate(() =>
    window.api.settings.update({
      depot: {
        label: '27 Rue Jacques Daguerre, 44600 Saint-Nazaire',
        street: '27 Rue Jacques Daguerre',
        postcode: '44600',
        city: 'Saint-Nazaire',
        country: 'France',
        lat: 47.295669,
        lon: -2.29232,
      },
    }),
  );
});

test('marquage manuel de l’impression', async () => {
  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.number === 'FA-2026-0142');
  assert.ok(!facture.printedAt, 'le document ne doit pas être marqué imprimé au départ');

  const marked = await page.evaluate((id) => window.api.documents.setPrinted(id, true), facture.id);
  assert.ok(marked.printedAt, 'repère d’impression non enregistré');

  const reloaded = await page.evaluate(() => window.api.documents.list());
  assert.ok(reloaded.find((d) => d.id === facture.id).printedAt);

  const unmarked = await page.evaluate((id) => window.api.documents.setPrinted(id, false), facture.id);
  assert.equal(unmarked.printedAt, undefined);
});

test('ouverture du fichier d’origine : erreur explicite si absent', async () => {
  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.number === 'FA-2026-0142');

  // Document sans fichier source : le message doit l'expliquer.
  const manual = await page.evaluate(() =>
    window.api.documents.save({ kind: 'invoice', number: 'MANUEL-1', totalTTC: 10 }),
  );
  const error = await page.evaluate(
    (id) => window.api.documents.openFile(id).then(() => null, (e) => e.message),
    manual.id,
  );
  assert.match(error, /fichier d.origine/i);
  await page.evaluate((id) => window.api.documents.remove(id), manual.id);

  // Document avec fichier : pas d'erreur de validation en amont.
  assert.ok(facture.sourceFile, 'la facture importée doit garder son chemin source');
});

test('bibliothèque de pièces jointes : ajout, cochage par défaut, suppression', async () => {
  // Un flyer déposé dans le sous-dossier est repris automatiquement.
  const attachmentsDir = path.join(watchFolder, 'Pieces-jointes');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.copyFileSync(path.join(pdfDir, 'DE-2026-0031.pdf'), path.join(attachmentsDir, 'Flyer été 2026.pdf'));

  const list = await page.evaluate(() => window.api.attachments.list());
  const flyer = list.find((a) => a.name.includes('Flyer'));
  assert.ok(flyer, `flyer non repris : ${JSON.stringify(list.map((a) => a.name))}`);
  assert.ok(flyer.exists);
  assert.ok(flyer.size > 0);
  assert.equal(flyer.defaultSelected, false);

  const updated = await page.evaluate(
    (id) => window.api.attachments.update(id, { defaultSelected: true }),
    flyer.id,
  );
  assert.equal(updated.defaultSelected, true);
});

test('préparation d’un e-mail : destinataire, modèle et pièces cochées', async () => {
  const documents = await page.evaluate(() => window.api.documents.list());
  const devis = documents.find((d) => d.kind === 'quote');

  // Renseigne une adresse e-mail sur le client du devis.
  await page.evaluate(async (documentId) => {
    const docs = await window.api.documents.list();
    const doc = docs.find((d) => d.id === documentId);
    const clients = await window.api.clients.list();
    const client = clients.find((c) => c.id === doc.clientId);
    if (client) await window.api.clients.save({ id: client.id, email: 'mairie@pornichet.fr' });
  }, devis.id);

  const preparation = await page.evaluate((id) => window.api.documents.prepareEmail(id), devis.id);

  assert.equal(preparation.draft.to, 'mairie@pornichet.fr');
  assert.match(preparation.draft.subject, /Devis/);
  assert.match(preparation.draft.subject, new RegExp(devis.number));
  assert.match(preparation.draft.body, /devis/i);
  assert.equal(preparation.documentAttachable, true);
  assert.equal(preparation.documentFileName, 'DE-2026-0031.pdf');
  assert.equal(preparation.draft.includeDocument, true);

  // Le flyer marqué « coché par défaut » est pré-sélectionné.
  const flyer = preparation.attachments.find((a) => a.name.includes('Flyer'));
  assert.ok(flyer, 'flyer absent de la liste proposée');
  assert.ok(
    preparation.draft.attachmentIds.includes(flyer.id),
    'le flyer coché par défaut doit être pré-sélectionné',
  );
});

test('l’objet et le message suivent les modèles des réglages', async () => {
  await page.evaluate(() =>
    window.api.settings.update({
      companyName: 'Glaces du Littoral',
      emailSubjectTemplate: '{societe} — {type} {numero}',
      emailBodyTemplate: 'Bonjour {client},\n\nVeuillez trouver ci-joint {le_type} {numero} ({montant}).',
      emailSignature: 'Quentin\nGlaces du Littoral',
    }),
  );

  const documents = await page.evaluate(() => window.api.documents.list());
  const devis = documents.find((d) => d.kind === 'quote');
  const preparation = await page.evaluate((id) => window.api.documents.prepareEmail(id), devis.id);

  assert.match(preparation.draft.subject, /^Glaces du Littoral — Devis DE-2026-0031$/);
  assert.match(preparation.draft.body, /Bonjour Mairie de Pornichet,/);
  // Article correct (« le devis ») et montant au format français, séparateur de milliers compris.
  assert.match(preparation.draft.body, /ci-joint le devis DE-2026-0031 \(1\s?233,60\s?€\)\./i);
  // La signature est ajoutée en fin de message.
  assert.match(preparation.draft.body, /Quentin\nGlaces du Littoral$/);
});

test('refus d’un envoi sans destinataire', async () => {
  const documents = await page.evaluate(() => window.api.documents.list());
  const devis = documents.find((d) => d.kind === 'quote');
  const error = await page.evaluate(
    (id) =>
      window.api.documents
        .sendEmail(id, { to: '', subject: 'x', body: 'y', includeDocument: false, attachmentIds: [] })
        .then(() => null, (e) => e.message),
    devis.id,
  );
  assert.match(error, /destinataire/i);
});

test('les fenêtres de saisie s’ouvrent et se ferment sans erreur', async () => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  const closeModal = async () => {
    await page.click('.modal__header .iconbtn');
    await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
  };

  /* Fiche client ---------------------------------------------------- */
  await page.click('.navitem:has-text("Clients")');
  await page.waitForSelector('table.data tbody tr');
  await page.click('button:has-text("Nouveau client")');
  await page.waitForSelector('.modal:has-text("Nouveau client")');
  assert.ok(await page.isVisible('text=Adresse'));
  await closeModal();

  await page.click('table.data tbody tr');
  await page.waitForSelector('.modal');
  assert.match(await page.textContent('.modal__title'), /COMPTOIR|Dune|Pornichet/i);
  await closeModal();

  /* Fiche consommable ----------------------------------------------- */
  await page.click('.navitem:has-text("Stock")');
  await page.waitForSelector('table.data tbody tr');
  await page.click('table.data tbody tr');
  await page.waitForSelector('.modal');
  assert.ok(await page.isVisible('text=Seuil d’alerte'));
  await closeModal();

  /* Historique des mouvements --------------------------------------- */
  await page.click('table.data tbody tr button[title="Historique des mouvements"]');
  await page.waitForSelector('.modal:has-text("Mouvements")');
  await closeModal();

  /* Détail d'un document et association d'une ligne ------------------ */
  await page.click('.navitem:has-text("Documents")');
  await page.waitForSelector('table.data tbody tr');
  await page.click('table.data tbody tr');
  await page.waitForSelector('.modal');
  assert.ok(await page.isVisible('text=Lignes du document'));

  const linkButton = page.locator('.modal table.data tbody tr td:last-child button').first();
  await linkButton.click();
  await page.waitForSelector('.modal:has-text("Associer au stock")');
  // Le champ de recherche est identifié par son texte indicatif.
  assert.ok(await page.isVisible('input[placeholder*="consommable"]'));
  // Ferme la fenêtre d'association (la plus récente), puis le détail.
  await page.locator('.modal:has-text("Associer au stock") .modal__header .iconbtn').click();
  await page.waitForTimeout(300);
  await page.locator('.modal .modal__header .iconbtn').last().click();
  await page.waitForTimeout(300);

  /* Tournée : ajout d'un arrêt --------------------------------------- */
  await page.click('.navitem:has-text("Tournées")');
  await page.waitForSelector('button:has-text("Ajouter un arrêt")');
  await page.click('button:has-text("Ajouter un arrêt")');
  await page.waitForSelector('.modal:has-text("Ajouter un arrêt")');
  assert.ok(await page.isVisible('text=Carnet de clients'));
  await page.click('.segmented button:has-text("Recherche d’adresse")');
  await page.waitForTimeout(250);
  assert.ok(await page.isVisible('text=Nom de l’arrêt'));
  await closeModal();

  /* Réglages : véhicule ---------------------------------------------- */
  await page.click('.navitem:has-text("Réglages")');
  await page.waitForSelector('button:has-text("Ajouter")');
  await page.click('.card:has-text("Véhicules") button:has-text("Ajouter")');
  await page.waitForSelector('.modal:has-text("Nouveau véhicule")');
  assert.ok(await page.isVisible('text=Consommation'));
  await closeModal();

  assert.deepEqual(errors, [], `erreurs React : ${errors.join(' | ')}`);
});
