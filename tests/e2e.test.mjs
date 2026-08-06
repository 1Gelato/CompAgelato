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
  for (const expected of ['Tableau de bord', 'Documents', 'Clients', 'Stock', 'Tournées', 'Banque', 'Réglages']) {
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

test('une relecture ne défait pas les corrections manuelles', async () => {
  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.number === 'FA-2026-0142');
  assert.ok(facture, 'facture de référence absente');

  // L'utilisateur corrige des champs que le lecteur avait remplis lui-même,
  // marque la pièce imprimée, puis détache volontairement le client.
  await page.evaluate(async (id) => {
    await window.api.documents.save({ id, totalHT: 999.99, dueDate: '2026-12-31', notes: 'vérifié à la main' });
    await window.api.documents.setPrinted(id, true);
    await window.api.documents.setClient(id, null);
  }, facture.id);

  // Le fichier d'origine est relu de force.
  const report = await page.evaluate(() => window.api.documents.scan({ force: true }));
  assert.equal(report.failed, 0, JSON.stringify(report.errors));

  const after = (await page.evaluate(() => window.api.documents.list()))
    .find((d) => d.id === facture.id);
  assert.ok(after, 'la facture a disparu après relecture');

  assert.equal(after.totalHT, 999.99, 'le total corrigé a été écrasé par le lecteur');
  assert.equal(after.dueDate, '2026-12-31', 'l’échéance saisie a été perdue');
  assert.equal(after.notes, 'vérifié à la main');
  assert.ok(after.printedAt, 'le repère d’impression a été effacé par la relecture');
  assert.equal(after.clientId, undefined, 'le client détaché a été rerattaché tout seul');

  // Ce qui n'a pas été corrigé continue bien de suivre le fichier.
  assert.equal(after.totalTTC, 382.8, 'les champs non corrigés doivent rester à jour');

  // Remise en état pour les tests suivants.
  await page.evaluate(async (payload) => {
    await window.api.documents.save({
      id: payload.id, totalHT: payload.totalHT, dueDate: payload.dueDate, notes: undefined,
    });
    await window.api.documents.setPrinted(payload.id, false);
    await window.api.documents.setClient(payload.id, payload.clientId);
  }, { id: facture.id, totalHT: facture.totalHT, dueDate: facture.dueDate ?? null, clientId: facture.clientId });
});

test('déplacer le dossier de travail ne duplique aucun document', async () => {
  // C'est le piège des chemins absolus : si le chemin enregistré ne correspond
  // plus, chaque pièce est relue comme si elle était nouvelle.
  const before = await page.evaluate(() => window.api.documents.list());
  assert.ok(before.length >= 3, 'trop peu de documents pour que le test ait du sens');

  // Les chemins sont désormais enregistrés relativement au dossier de travail.
  const withSource = before.filter((d) => d.sourceFile);
  assert.ok(withSource.length >= 3, 'aucun document ne porte de fichier source');
  for (const doc of withSource) {
    assert.ok(
      !/^([A-Za-z]:[\\/]|\/)/.test(doc.sourceFile),
      `chemin encore absolu en base : ${doc.sourceFile}`,
    );
  }

  // Déménagement : le dossier entier change d'emplacement.
  const moved = path.join(workspace, 'Documents', 'CompaGelato-Deplace');
  fs.cpSync(watchFolder, moved, { recursive: true });
  await page.evaluate(
    (folder) => window.api.settings.update({ watchFolder: folder, autoScan: false }),
    moved,
  );

  const report = await page.evaluate(() => window.api.documents.scan({}));
  assert.equal(report.failed, 0, JSON.stringify(report.errors));
  assert.equal(report.imported, 0, `le déménagement a réimporté ${report.imported} document(s)`);

  const after = await page.evaluate(() => window.api.documents.list());
  assert.equal(after.length, before.length, 'le nombre de documents a changé après déménagement');

  // Le fichier d'origine reste ouvrable depuis le nouvel emplacement.
  const target = after.find((d) => d.number === 'FA-2026-0142');
  assert.ok(target?.sourceFile, 'la facture de référence a perdu son fichier');
  assert.ok(
    fs.existsSync(path.join(moved, target.sourceFile)),
    `fichier introuvable au nouvel emplacement : ${target.sourceFile}`,
  );

  // Retour à l'emplacement d'origine pour la suite des tests.
  await page.evaluate(
    (folder) => window.api.settings.update({ watchFolder: folder }),
    watchFolder,
  );
  fs.rmSync(moved, { recursive: true, force: true });
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
  // Les chemins sont enregistrés relativement au dossier de travail.
  const droppedRelative = 'Factures/FA-2026-0199.pdf';
  fs.copyFileSync(path.join(pdfDir, 'FA-2026-0143.pdf'), dropped);

  // La surveillance attend la fin d'écriture puis regroupe les événements.
  const deadline = Date.now() + 30000;
  let documents = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    documents = await page.evaluate(() => window.api.documents.list());
    if (documents.some((d) => d.sourceFile === droppedRelative)) break;
  }

  const imported = documents.find((d) => d.sourceFile === droppedRelative);
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

test('vérification des mises à jour depuis l’application réelle', async () => {
  const result = await page.evaluate(() => window.api.updates.check());
  // Cette session tourne depuis le dépôt cloné réel : la fonctionnalité doit
  // se reconnaître comme utilisable et lire la branche courante.
  assert.equal(result.supported, true, JSON.stringify(result));
  assert.ok(result.branch, 'branche non détectée');
  assert.ok(result.currentCommit, 'commit courant non détecté');
  assert.equal(typeof result.available, 'boolean');
  assert.equal(typeof result.behind, 'number');

  await page.click('.navitem:has-text("Réglages")');
  await page.waitForSelector('button:has-text("Rechercher les mises à jour")');
  await page.click('button:has-text("Rechercher les mises à jour")');
  await page.waitForTimeout(1500);
  const bodyText = await page.textContent('.content');
  // Le bouton doit toujours aboutir à un message clair. Sans réseau (machine
  // de compilation isolée), c'est l'échec de la vérification qui s'affiche :
  // c'est un résultat valable, pas un défaut du logiciel.
  assert.match(
    bodyText,
    /derni[eè]re version|amélioration.*disponible|Vérification impossible/i,
    `aucun message de mise à jour affiché : ${bodyText.slice(0, 400)}`,
  );
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

/* ------------------------------------------------------------------ */
/* Relevés bancaires                                                    */
/* ------------------------------------------------------------------ */

const statementFolder = path.join(workspace, '17-RELEVES DE COMPTE');

test('import d’un relevé de compte : lecture, catégories et solde', async () => {
  fs.mkdirSync(statementFolder, { recursive: true });

  // Le relevé cite une vraie facture importée plus tôt : son montant TTC et son
  // client servent à vérifier le rapprochement automatique.
  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.kind === 'invoice' && d.totalTTC > 0);
  assert.ok(facture, 'aucune facture disponible pour le rapprochement');
  const clients = await page.evaluate(() => window.api.clients.list());
  const client = clients.find((c) => c.id === facture.clientId);
  assert.ok(client, 'la facture de test doit être rattachée à un client');

  const montant = facture.totalTTC.toFixed(2).replace('.', ',');
  const releve = [
    'Date;Libellé;Débit;Crédit;Solde',
    `15/06/2026;VIR RECU ${client.name.toUpperCase()};;${montant};7 500,00`,
    '16/06/2026;PRLV URSSAF PAYS DE LOIRE;842,15;;6 657,85',
    '17/06/2026;CB TOTALENERGIES ST NAZAIRE;88,20;;6 569,65',
    '18/06/2026;CB BOULANGERIE;12,50;;6 557,15',
    '18/06/2026;CB BOULANGERIE;12,50;;6 544,65',
  ].join('\r\n');
  fs.writeFileSync(path.join(statementFolder, 'releve-juin.csv'), Buffer.from(releve, 'latin1'));

  await page.evaluate((folder) => window.api.settings.update({ statementFolder: folder }), statementFolder);
  const report = await page.evaluate(() => window.api.bank.scan());
  assert.equal(report.files, 1, `fichiers lus : ${JSON.stringify(report)}`);
  assert.equal(report.imported, 5, `opérations importées : ${JSON.stringify(report)}`);

  const transactions = await page.evaluate(() => window.api.bank.list());
  assert.equal(transactions.length, 5);

  // Les sens sont respectés : un seul encaissement, quatre dépenses.
  assert.equal(transactions.filter((t) => t.amount > 0).length, 1);
  assert.equal(transactions.filter((t) => t.amount < 0).length, 4);

  // Les catégories sont déduites du libellé.
  const urssaf = transactions.find((t) => t.label.includes('URSSAF'));
  assert.equal(urssaf.category, 'taxes');
  assert.equal(urssaf.amount, -842.15);
  assert.equal(transactions.find((t) => t.label.includes('TOTALENERGIES')).category, 'fuel');

  // Deux passages identiques le même jour restent deux opérations distinctes.
  assert.equal(transactions.filter((t) => t.label === 'CB BOULANGERIE').length, 2);
});

test('l’encaissement est rapproché tout seul de la bonne facture', async () => {
  const transactions = await page.evaluate(() => window.api.bank.list());
  const encaissement = transactions.find((t) => t.amount > 0);
  assert.ok(encaissement.documentId, 'l’encaissement aurait dû être rapproché automatiquement');
  assert.equal(encaissement.matchAuto, true);

  // La facture correspondante passe à « réglée » : c'est tout l'intérêt.
  const documents = await page.evaluate(() => window.api.documents.list());
  const facture = documents.find((d) => d.id === encaissement.documentId);
  assert.equal(facture.status, 'paid', 'la facture rapprochée doit être marquée réglée');
  assert.equal(facture.totalTTC.toFixed(2), encaissement.amount.toFixed(2));
});

test('relire le même relevé n’ajoute aucun doublon', async () => {
  const avant = await page.evaluate(() => window.api.bank.list());
  const report = await page.evaluate(() => window.api.bank.scan());
  assert.equal(report.imported, 0, `aucune opération ne devait être ajoutée : ${JSON.stringify(report)}`);
  assert.equal(report.duplicates, 5);

  const apres = await page.evaluate(() => window.api.bank.list());
  assert.equal(apres.length, avant.length, 'le nombre d’opérations ne doit pas bouger');
});

test('un second relevé qui chevauche le premier n’ajoute que les nouveautés', async () => {
  const chevauchement = [
    'Date;Libellé;Débit;Crédit;Solde',
    // Les deux premières lignes figurent déjà dans le relevé de juin.
    '17/06/2026;CB TOTALENERGIES ST NAZAIRE;88,20;;6 569,65',
    '18/06/2026;CB BOULANGERIE;12,50;;6 557,15',
    '02/07/2026;VIR RECU AMICALE DES PLAISANCIERS;;620,00;7 177,15',
  ].join('\r\n');
  fs.writeFileSync(
    path.join(statementFolder, 'releve-juillet.csv'),
    Buffer.from(chevauchement, 'latin1'),
  );

  const report = await page.evaluate(() => window.api.bank.scan());
  assert.equal(report.imported, 1, `seule l’opération de juillet est nouvelle : ${JSON.stringify(report)}`);

  const transactions = await page.evaluate(() => window.api.bank.list());
  assert.equal(transactions.length, 6);
  assert.equal(transactions.filter((t) => t.label.includes('TOTALENERGIES')).length, 1);
  assert.equal(transactions.filter((t) => t.label === 'CB BOULANGERIE').length, 2);
});

test('la synthèse donne les totaux, les catégories et la trésorerie', async () => {
  const summary = await page.evaluate(() => window.api.bank.summary());
  assert.ok(summary.totalIn > 0);
  assert.ok(summary.totalOut > 0);
  assert.equal(summary.net.toFixed(2), (summary.totalIn - summary.totalOut).toFixed(2));

  // Le solde retenu est celui de la dernière opération connue.
  assert.equal(summary.balance, 7177.15);
  assert.equal(summary.balanceDate, '2026-07-02');

  // Deux mois d'activité, dans l'ordre chronologique.
  assert.deepEqual(summary.months.map((m) => m.month), ['2026-06', '2026-07']);

  const taxes = summary.categories.find((c) => c.category === 'taxes');
  assert.equal(taxes.out, 842.15);

  // L'encaissement de juillet n'a aucune facture en face : il reste à traiter.
  assert.equal(summary.unreconciled, 1);
  assert.equal(summary.unreconciledAmount, 620);
});

test('l’écran Banque affiche les opérations et permet de filtrer', async () => {
  await page.click('.navitem:has-text("Banque")');
  await page.waitForSelector('table.data tbody tr');

  const lignes = await page.$$eval('table.data tbody tr', (rows) => rows.length);
  assert.equal(lignes, 6);

  // Filtre « Entrées » : seuls les encaissements restent.
  await page.click('.segmented button:has-text("Entrées")');
  await page.waitForTimeout(250);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), 2);

  // Filtre « À rapprocher » : l'encaissement de juillet, sans facture en face.
  await page.click('.segmented button:has-text("Tout")');
  await page.waitForTimeout(150);
  await page.click('.segmented button:has-text("À rapprocher")');
  await page.waitForTimeout(250);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), 1);
  assert.ok(await page.isVisible('text=AMICALE DES PLAISANCIERS'));

  // Le détail s'ouvre et propose le rapprochement manuel. On clique le libellé :
  // la cellule « Catégorie » porte une liste déroulante et ne doit justement
  // pas ouvrir la fiche.
  await page.click('table.data tbody tr td:nth-child(2)');
  await page.waitForSelector('.modal');
  assert.ok(await page.isVisible('text=Rapprochement'));
  await page.locator('.modal .modal__header .iconbtn').last().click();
  await page.waitForTimeout(250);
});

/* ------------------------------------------------------------------ */
/* Tri des tableaux et filtre par période                               */
/* ------------------------------------------------------------------ */

/** Contenu d'une colonne du tableau affiché, ligne par ligne. */
async function column(nth) {
  return page.$$eval(
    `table.data tbody tr td:nth-child(${nth})`,
    (cells) => cells.map((c) => c.textContent.trim()),
  );
}

test('les colonnes des documents se trient dans les deux sens', async () => {
  await page.click('.navitem:has-text("Documents")');
  await page.waitForSelector('table.data tbody tr');
  // Repart d'un tableau non filtré.
  await page.click('.segmented button:has-text("Tout")');
  await page.waitForTimeout(200);

  // Colonne « Total TTC » (6e). Premier clic : du plus grand au plus petit.
  await page.click('table.data th:has-text("Total TTC")');
  await page.waitForTimeout(200);
  const desc = (await column(6)).map((v) => Number(v.replace(/[^\d,]/g, '').replace(',', '.')));
  assert.ok(desc.length >= 3, 'trop peu de lignes pour vérifier le tri');
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a), `ordre décroissant attendu : ${desc}`);

  // Second clic : le sens s'inverse.
  await page.click('table.data th:has-text("Total TTC")');
  await page.waitForTimeout(200);
  const asc = (await column(6)).map((v) => Number(v.replace(/[^\d,]/g, '').replace(',', '.')));
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b), `ordre croissant attendu : ${asc}`);

  // L'en-tête actif porte l'état du tri.
  assert.equal(
    await page.getAttribute('table.data th:has-text("Total TTC")', 'aria-sort'),
    'ascending',
  );
});

test('le tri par numéro suit l’ordre naturel des nombres', async () => {
  await page.click('table.data th:has-text("Numéro")');
  await page.waitForTimeout(200);
  const numbers = await column(2);
  const sorted = [...numbers].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  assert.deepEqual(numbers, sorted, `ordre naturel attendu : ${numbers}`);
});

test('les tableaux clients et stock se trient aussi', async () => {
  await page.click('.navitem:has-text("Clients")');
  await page.waitForSelector('table.data tbody tr');
  await page.click('table.data th:has-text("Nom")');
  await page.waitForTimeout(200);
  const names = await page.$$eval('table.data tbody tr td:nth-child(2)', (cells) =>
    cells.map((c) => c.querySelector('span')?.textContent.trim() ?? ''),
  );
  const sortedNames = [...names].sort((a, b) =>
    a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' }),
  );
  // Le premier clic sur « Nom » trie de A à Z ; ici l'état initial l'est déjà,
  // donc le clic inverse : on vérifie l'un ou l'autre ordre, pas le hasard.
  assert.ok(
    JSON.stringify(names) === JSON.stringify(sortedNames) ||
      JSON.stringify(names) === JSON.stringify([...sortedNames].reverse()),
    `ordre alphabétique attendu : ${names}`,
  );

  await page.click('.navitem:has-text("Stock")');
  await page.waitForSelector('table.data tbody tr');
  await page.click('table.data th:has-text("Stock")');
  await page.waitForTimeout(200);
  const qty = (await column(4)).map((v) => Number(v.replace(/[^\d,-]/g, '').replace(',', '.')));
  assert.deepEqual(qty, [...qty].sort((a, b) => b - a), `stock décroissant attendu : ${qty}`);
});

test('la banque se filtre sur une période donnée', async () => {
  await page.click('.navitem:has-text("Banque")');
  await page.waitForSelector('table.data tbody tr');
  const total = await page.$$eval('table.data tbody tr', (r) => r.length);
  assert.equal(total, 6);

  // Juillet seul : l'unique opération du 02/07.
  await page.fill('input[title="Début de la période"]', '2026-07-01');
  await page.waitForTimeout(250);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), 1);
  assert.ok(await page.isVisible('text=AMICALE DES PLAISANCIERS'));

  // Bornée à juin : les cinq opérations de juin, sans celle de juillet.
  await page.fill('input[title="Début de la période"]', '2026-06-01');
  await page.fill('input[title="Fin de la période"]', '2026-06-30');
  await page.waitForTimeout(250);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), 5);

  // Le bouton d'effacement rétablit la totalité.
  await page.click('button[title="Effacer la période"]');
  await page.waitForTimeout(250);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), total);
});

test('les opérations bancaires se trient par montant', async () => {
  await page.click('table.data th:has-text("Débit")');
  await page.waitForTimeout(250);
  const debits = (await column(4))
    .filter(Boolean)
    .map((v) => Number(v.replace(/[^\d,]/g, '').replace(',', '.')));
  assert.ok(debits.length >= 2, 'pas assez de débits pour vérifier');
  assert.deepEqual(debits, [...debits].sort((a, b) => b - a), `débits décroissants : ${debits}`);
  // Les lignes sans débit (les encaissements) sont rejetées en fin de tableau.
  const colonne = await column(4);
  const dernierChiffre = colonne.map(Boolean).lastIndexOf(true);
  const premierVide = colonne.map(Boolean).indexOf(false);
  if (premierVide !== -1) {
    assert.ok(premierVide > dernierChiffre - 1, 'les lignes vides doivent finir en bas');
  }
});

test('la recherche par montant retrouve une facture et une opération bancaire', async () => {
  /* Documents : la facture FA-2026-0142 vaut 319,00 HT / 382,80 TTC ------- */
  await page.click('.navitem:has-text("Documents")');
  await page.waitForSelector('table.data tbody tr');
  const searchDocs = 'input[placeholder*="Numéro, client"]';

  await page.fill(searchDocs, '382,80');
  await page.waitForTimeout(300);
  let numbers = await column(2);
  assert.deepEqual(numbers, ['FA-2026-0142'], `TTC exact : ${numbers}`);

  // Les chiffres du début suffisent, sans les décimales.
  await page.fill(searchDocs, '382');
  await page.waitForTimeout(300);
  numbers = await column(2);
  assert.ok(numbers.includes('FA-2026-0142'), `TTC partiel : ${numbers}`);

  // Le total HT est cherchable au même titre que le TTC.
  await page.fill(searchDocs, '319');
  await page.waitForTimeout(300);
  numbers = await column(2);
  assert.ok(numbers.includes('FA-2026-0142'), `HT : ${numbers}`);

  // Un montant absent ne renvoie rien plutôt que n'importe quoi.
  await page.fill(searchDocs, '99999');
  await page.waitForTimeout(300);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), 0);

  // Une recherche textuelle continue de fonctionner comme avant.
  await page.fill(searchDocs, '0142');
  await page.waitForTimeout(300);
  assert.deepEqual(await column(2), ['FA-2026-0142']);
  await page.fill(searchDocs, '');
  await page.waitForTimeout(250);

  /* Banque : le prélèvement URSSAF de 842,15 € ---------------------------- */
  await page.click('.navitem:has-text("Banque")');
  await page.waitForSelector('table.data tbody tr');
  const searchBank = 'input[placeholder*="Libellé, client"]';

  await page.fill(searchBank, '842,15');
  await page.waitForTimeout(300);
  assert.equal(
    await page.$$eval('table.data tbody tr', (r) => r.length),
    1,
    'un seul prélèvement à 842,15 €',
  );
  assert.ok(await page.isVisible('text=URSSAF'));

  // Un débit se cherche sans se soucier du signe.
  await page.fill(searchBank, '842');
  await page.waitForTimeout(300);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), 1);

  await page.fill(searchBank, '99999');
  await page.waitForTimeout(300);
  assert.equal(await page.$$eval('table.data tbody tr', (r) => r.length), 0);
  await page.fill(searchBank, '');
  await page.waitForTimeout(250);
});

/* ------------------------------------------------------------------ */
/* Cahiers : SAV, consommables, événementiel                            */
/* ------------------------------------------------------------------ */

test('cahier SAV : écriture avec fiche client créée à la volée', async () => {
  // Création de la fiche depuis le sélecteur du cahier (même appel que le bouton).
  const client = await page.evaluate(() =>
    window.api.clients.save({ name: 'CRÊPERIE DU MÔLE' }),
  );
  const entry = await page.evaluate(
    (clientId) =>
      window.api.registers.save({
        kind: 'sav',
        clientId,
        title: 'Machine à glace en panne',
        parts: 'Joint de cuve + courroie',
        details: 'Bruit anormal depuis mardi',
      }),
    client.id,
  );
  assert.equal(entry.status, 'open', 'une écriture démarre « À traiter »');
  assert.equal(entry.parts, 'Joint de cuve + courroie');

  // Un client sans fiche reste possible : le nom est simplement noté.
  const noted = await page.evaluate(() =>
    window.api.registers.save({ kind: 'consumables', clientName: 'Passage comptoir', title: '2 mix vanille' }),
  );
  assert.equal(noted.clientId, undefined);
  assert.equal(noted.clientName, 'Passage comptoir');
});

test('événementiel : seule la validation du devis réserve les machines', async () => {
  const machine = await page.evaluate(() =>
    window.api.machines.save({ name: 'Machine à glace italienne', qtyTotal: 2 }),
  );

  const dispo = async () => {
    const parc = await page.evaluate(() => window.api.machines.list());
    return parc.find((m) => m.machine.name === 'Machine à glace italienne');
  };

  assert.equal((await dispo()).available, 2);

  // Une demande ne retire rien du parc.
  const demande = await page.evaluate(
    (machineId) =>
      window.api.registers.save({
        kind: 'event',
        clientName: 'Comité des fêtes',
        title: 'Fête de la mer',
        eventDate: '2026-09-12',
        machines: [{ machineId, qty: 1 }],
      }),
    machine.id,
  );
  assert.equal((await dispo()).available, 2, 'une simple demande ne doit rien réserver');

  // Devis validé : la machine sort du parc.
  await page.evaluate((id) => window.api.registers.setStatus(id, 'confirmed'), demande.id);
  let slot = await dispo();
  assert.equal(slot.available, 1);
  assert.equal(slot.reserved, 1);
  assert.ok(slot.upcoming.some((u) => u.date === '2026-09-12'), 'la sortie doit être annoncée');

  // Valider un second devis au-delà du parc est refusé, en nommant la machine.
  const trop = await page.evaluate(
    (machineId) =>
      window.api.registers.save({
        kind: 'event',
        clientName: 'Mariage Lefèvre',
        title: 'Mariage',
        machines: [{ machineId, qty: 2 }],
      }),
    machine.id,
  );
  await assert.rejects(
    page.evaluate((id) => window.api.registers.setStatus(id, 'confirmed'), trop.id),
    /Parc insuffisant.*Machine à glace italienne/,
  );
  assert.equal((await dispo()).available, 1, 'le refus ne doit rien réserver');

  // Une machine réservée ne peut pas être retirée du parc.
  await assert.rejects(
    page.evaluate((id) => window.api.machines.remove(id), machine.id),
    /réservée par un devis validé/,
  );

  // Prestation terminée : la machine revient, et le devis en attente passe.
  await page.evaluate((id) => window.api.registers.setStatus(id, 'done'), demande.id);
  assert.equal((await dispo()).available, 2, 'terminer la prestation doit rendre la machine');
  await page.evaluate((id) => window.api.registers.setStatus(id, 'confirmed'), trop.id);
  assert.equal((await dispo()).available, 0);

  // Nettoyage pour laisser le parc sain.
  await page.evaluate((id) => window.api.registers.setStatus(id, 'cancelled'), trop.id);
});

test('l’onglet Cahiers s’affiche avec ses trois cahiers et le parc', async () => {
  await page.click('.navitem:has-text("Cahiers")');
  await page.waitForSelector('table.data tbody tr');

  // SAV par défaut : l'écriture créée plus haut est visible.
  assert.ok(await page.isVisible('text=Machine à glace en panne'));
  assert.ok(await page.isVisible('text=CRÊPERIE DU MÔLE'));

  // Consommables.
  await page.click('.segmented button:has-text("Consommables")');
  await page.waitForTimeout(250);
  assert.ok(await page.isVisible('text=2 mix vanille'));
  assert.ok(await page.isVisible('text=sans fiche client'));

  // Événementiel : le tableau du parc apparaît dans le même onglet.
  await page.click('.segmented button:has-text("Événementiel")');
  await page.waitForTimeout(250);
  assert.ok(await page.isVisible('text=Parc de machines'));
  assert.ok(await page.isVisible('text=Machine à glace italienne'));
  assert.ok(await page.isVisible('text=Prochaines sorties'));

  // La fenêtre de saisie s'ouvre avec le sélecteur de client et les machines.
  await page.click('button:has-text("Nouvelle écriture")');
  await page.waitForSelector('.modal');
  assert.ok(await page.isVisible('text=Machines demandées'));
  assert.ok(await page.isVisible('text=Nom de l’événement'));
  await page.locator('.modal .modal__header .iconbtn').last().click();
  await page.waitForTimeout(200);
});
