import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataStore,
  marginRate,
  importProductsFile,
  guessMapping,
  PRODUCT_FIELDS,
  parseActive,
  explicitProductType,
  guessProductType,
  parseVatRate,
  saleHtFrom,
} from './build/services.mjs';

/**
 * Le catalogue vient d'un export MEG : dix-huit colonnes dont trois de prix,
 * un « Etat », un « Type » fiscal et une « Disponibilité (jours) » qui n'a
 * rien d'un stock. Une colonne mal comprise ici, et ce sont des centaines
 * d'articles faux — d'où ce fichier, qui fige l'en-tête réel.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-articles-'));

test.before(() => {
  dataStore.init({
    dataDir: path.join(dir, 'donnees'),
    documentsDir: path.join(dir, 'Documents'),
  });
});

test.after(() => {
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** L'en-tête exact de l'export d'articles de MEG. */
const MEG_HEADERS = [
  'Code', 'Libellé', 'Etat', 'Type', 'Famille', 'Description', 'Compte comptable',
  "Prix d'achat moyen", 'Taux de marge', 'Prix de vente HT', 'TVA', 'Prix de vente TTC',
  'Unité', 'Forcer TTC', 'Eco-participation', 'Disponibilité (jours)', 'Volume (m³)', 'Poids (kg)',
];

/* ------------------------------------------------------------------ */
/* La reconnaissance des colonnes                                       */
/* ------------------------------------------------------------------ */

test('chaque colonne MEG tombe dans le bon champ', () => {
  const mapping = guessMapping(MEG_HEADERS, PRODUCT_FIELDS);
  assert.equal(mapping.sku, 'Code');
  assert.equal(mapping.name, 'Libellé');
  // Deux colonnes voisines qui ne disent pas la même chose.
  assert.equal(mapping.description, 'Description');
  assert.equal(mapping.state, 'Etat');
  assert.equal(mapping.type, 'Type');
  assert.equal(mapping.category, 'Famille');
  assert.equal(mapping.unit, 'Unité');
  assert.equal(mapping.accountingCode, 'Compte comptable');
  // Trois colonnes commencent par « Prix » : chacune à sa place.
  assert.equal(mapping.unitCost, "Prix d'achat moyen");
  assert.equal(mapping.salePrice, 'Prix de vente HT');
  assert.equal(mapping.salePriceTtc, 'Prix de vente TTC');
  assert.equal(mapping.vatRate, 'TVA');
  assert.equal(mapping.leadTimeDays, 'Disponibilité (jours)');
});

test('« Disponibilité (jours) » n’est jamais lu comme une quantité en stock', () => {
  const mapping = guessMapping(MEG_HEADERS, PRODUCT_FIELDS);
  // Le délai d'approvisionnement passait pour un stock : cinq jours devenaient
  // cinq unités sur l'étagère, mouvement d'inventaire à l'appui.
  assert.equal(mapping.qtyOnHand, undefined);
  assert.equal(mapping.minQty, undefined);
});

test('les colonnes propres à MEG qu’on n’utilise pas restent visibles', () => {
  const mapping = guessMapping(MEG_HEADERS, PRODUCT_FIELDS);
  const utilisees = Object.values(mapping);
  // Le taux de marge se recalcule, « Forcer TTC » est un réglage interne :
  // ils sont annoncés « non utilisés » plutôt que rangés au hasard.
  for (const colonne of ['Taux de marge', 'Forcer TTC', 'Eco-participation', 'Volume (m³)', 'Poids (kg)']) {
    assert.ok(!utilisees.includes(colonne), `${colonne} ne devrait pas être utilisée`);
  }
});

test('un fichier qui n’a qu’une colonne « Description » y trouve sa désignation', () => {
  const mapping = guessMapping(['Code', 'Description', 'Stock'], PRODUCT_FIELDS);
  assert.equal(mapping.name, 'Description');
  assert.equal(mapping.qtyOnHand, 'Stock');
});

test('les colonnes propres à CompaGelato sont reconnues aussi', () => {
  const mapping = guessMapping(
    ['Référence', 'Désignation', 'Unité de stock', 'Contenu', 'Mesure', 'Unités par carton',
     'Facturé par', 'Stock', 'Stock mini', 'Fournisseur', 'Libellés reconnus'],
    PRODUCT_FIELDS,
  );
  assert.equal(mapping.unit, 'Unité de stock');
  assert.equal(mapping.packSize, 'Contenu');
  assert.equal(mapping.packMeasure, 'Mesure');
  assert.equal(mapping.unitsPerCase, 'Unités par carton');
  assert.equal(mapping.invoicedAs, 'Facturé par');
  assert.equal(mapping.qtyOnHand, 'Stock');
  assert.equal(mapping.minQty, 'Stock mini');
  assert.equal(mapping.aliases, 'Libellés reconnus');
});

/* ------------------------------------------------------------------ */
/* L'interprétation des valeurs                                         */
/* ------------------------------------------------------------------ */

test('l’état dit si l’article est encore au catalogue', () => {
  assert.equal(parseActive('Actif'), true);
  assert.equal(parseActive('Inactif'), false);
  assert.equal(parseActive('Oui'), true);
  assert.equal(parseActive('Non'), false);
  // Ce qu'on ne comprend pas ne décide rien.
  assert.equal(parseActive('en cours de création'), null);
  assert.equal(parseActive(undefined), null);
});

test('la nature vient de la colonne quand elle parle, du libellé sinon', () => {
  assert.equal(explicitProductType('Machine'), 'machine');
  assert.equal(explicitProductType('Pièce détachée'), 'part');
  assert.equal(explicitProductType('Mix poudre'), 'mixPowder');
  // « Marchandise » et « Service » sont des catégories fiscales : elles ne
  // disent rien de ce qu'on range sur l'étagère.
  assert.equal(explicitProductType('Marchandise'), null);
  assert.equal(explicitProductType('Service'), null);

  assert.equal(guessProductType('Turbine à glace 2 parfums'), 'machine');
  assert.equal(guessProductType('Mix vanille poudre 2,5 kg'), 'mixPowder');
  assert.equal(guessProductType('Mix lait liquide 4,5 kg'), 'mixLiquid');
  assert.equal(guessProductType('Joint de piston'), 'part');
  assert.equal(guessProductType('Racleur silicone', 'Pièces détachées'), 'part');
  // Dans le doute, consommable — et la fiche reste modifiable.
  assert.equal(guessProductType('Gobelets 20 cl'), 'consumable');
});

test('les taux et les prix français sont lus tels qu’ils sont écrits', () => {
  assert.equal(parseVatRate('20,00 %'), 20);
  assert.equal(parseVatRate('5,5'), 5.5);
  // « 0,2 » est un rapport, pas un taux à 0,2 %.
  assert.equal(parseVatRate('0,2'), 20);
  assert.equal(parseVatRate(''), null);

  assert.equal(saleHtFrom('1 234,56 €', undefined, 20), 1234.56);
  // Sans prix HT, le TTC et le taux le retrouvent.
  assert.equal(saleHtFrom(undefined, '120,00', 20), 100);
  assert.equal(saleHtFrom(undefined, undefined, 20), null);
});

test('le taux de marge affiché est celui du logiciel de comptabilité', () => {
  // La ligne réelle de l'export : 11,635 € achetés, revendus 19,39 € — MEG
  // affiche 67 %. Rapporter la marge au prix de vente donnerait 40 % et
  // ferait douter de l'un des deux logiciels.
  assert.equal(Math.round(marginRate(11.635, 19.39)), 67);
  assert.equal(marginRate(0, 19.39), null, 'sans prix d’achat, pas de marge à annoncer');
  assert.equal(marginRate(10, undefined), null);
});

/* ------------------------------------------------------------------ */
/* L'import complet                                                     */
/* ------------------------------------------------------------------ */

const MEG_ROWS = [
  {
    Code: 'ART0001', 'Libellé': 'Mix vanille poudre 2,5 kg', Etat: 'Actif', Type: 'Marchandise',
    Famille: 'Mix', Description: 'Sachet de 2,5 kg, dilution 1:3',
    'Compte comptable': '707100', "Prix d'achat moyen": '12,40', 'Taux de marge': '38,00',
    'Prix de vente HT': '20,00', TVA: '5,50', 'Prix de vente TTC': '21,10',
    'Unité': 'sachet', 'Forcer TTC': 'Non', 'Eco-participation': '0,00',
    'Disponibilité (jours)': '5', 'Volume (m³)': '0,01', 'Poids (kg)': '2,5',
  },
  {
    Code: 'ART0002', 'Libellé': 'Turbine à glace 2 parfums', Etat: 'Actif', Type: 'Marchandise',
    Famille: 'Matériel', Description: 'Machine d’occasion révisée',
    'Compte comptable': '707200', "Prix d'achat moyen": '4 200,00', 'Taux de marge': '30,00',
    'Prix de vente HT': '', TVA: '20,00', 'Prix de vente TTC': '7 200,00',
    'Unité': 'pièce', 'Forcer TTC': 'Oui', 'Eco-participation': '14,00',
    'Disponibilité (jours)': '21', 'Volume (m³)': '1,20', 'Poids (kg)': '180',
  },
  {
    Code: 'ART0003', 'Libellé': 'Gobelets 20 cl (ancien modèle)', Etat: 'Inactif', Type: 'Marchandise',
    Famille: 'Emballage', Description: '', 'Compte comptable': '707100',
    "Prix d'achat moyen": '0,08', 'Taux de marge': '', 'Prix de vente HT': '0,20',
    TVA: '20,00', 'Prix de vente TTC': '0,24', 'Unité': 'pièce', 'Forcer TTC': 'Non',
    'Eco-participation': '', 'Disponibilité (jours)': '', 'Volume (m³)': '', 'Poids (kg)': '',
  },
];

function writeMeg(file, rows = MEG_ROWS) {
  const lines = [MEG_HEADERS.join('\t')];
  for (const row of rows) lines.push(MEG_HEADERS.map((h) => row[h] ?? '').join('\t'));
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
}

test('l’import MEG remplit la fiche article sans toucher au stock', async () => {
  const file = path.join(dir, 'articles-meg.csv');
  writeMeg(file);
  const report = await importProductsFile(file);
  assert.deepEqual(report.errors, []);
  assert.equal(report.created, 3);

  const mix = dataStore.db.products.find((p) => p.sku === 'ART0001');
  assert.equal(mix.name, 'Mix vanille poudre 2,5 kg');
  assert.equal(mix.type, 'mixPowder', 'la nature se devine du libellé');
  assert.equal(mix.category, 'Mix');
  assert.equal(mix.description, 'Sachet de 2,5 kg, dilution 1:3');
  assert.equal(mix.unit, 'sachet');
  assert.equal(mix.accountingCode, '707100');
  assert.equal(mix.unitCost, 12.4);
  assert.equal(mix.salePrice, 20);
  assert.equal(mix.vatRate, 5.5);
  assert.equal(mix.leadTimeDays, 5);
  assert.equal(mix.archived, false);
  // Le délai de 5 jours ne doit pas être devenu du stock.
  assert.equal(mix.qtyOnHand, 0);
  assert.equal(
    dataStore.db.stockMoves.filter((m) => m.productId === mix.id).length,
    0,
    'aucun mouvement d’inventaire ne doit naître d’un fichier sans colonne de stock',
  );

  const turbine = dataStore.db.products.find((p) => p.sku === 'ART0002');
  assert.equal(turbine.type, 'machine');
  // Prix HT vide : retrouvé depuis le TTC et le taux.
  assert.equal(turbine.salePrice, 6000);
  assert.equal(turbine.leadTimeDays, 21);

  const gobelets = dataStore.db.products.find((p) => p.sku === 'ART0003');
  assert.equal(gobelets.archived, true, '« Inactif » arrive archivé');
  assert.equal(gobelets.type, 'consumable');
});

test('ré-importer un fichier plus pauvre n’efface rien', async () => {
  const avant = dataStore.db.products.find((p) => p.sku === 'ART0001');
  assert.equal(avant.salePrice, 20);

  const file = path.join(dir, 'articles-pauvre.csv');
  fs.writeFileSync(file, 'Code;Libellé\nART0001;Mix vanille poudre 2,5 kg\n', 'utf8');
  const report = await importProductsFile(file);
  assert.equal(report.updated, 1);
  assert.equal(report.created, 0);

  const apres = dataStore.db.products.find((p) => p.sku === 'ART0001');
  assert.equal(apres.salePrice, 20);
  assert.equal(apres.unitCost, 12.4);
  assert.equal(apres.category, 'Mix');
  assert.equal(apres.unit, 'sachet', 'l’unité n’est pas retombée sur « pièce »');
  assert.equal(apres.type, 'mixPowder', 'la nature déjà classée est conservée');
  assert.equal(apres.accountingCode, '707100');
});

test('un catalogue importé avant la mise à jour se complète en le réimportant', async () => {
  // La situation réelle : des articles créés par une version qui ne lisait ni
  // le prix de vente ni la TVA. Mettre à jour le logiciel n'invente pas la
  // donnée — il faut repasser le fichier.
  let ancienId = '';
  dataStore.mutate((db) => {
    const fiche = db.products.find((p) => p.sku === 'ART0002');
    ancienId = fiche.id;
    // Ce que l'ancienne version savait écrire : ni prix de vente, ni TVA, ni
    // compte comptable, ni délai.
    delete fiche.salePrice;
    delete fiche.vatRate;
    delete fiche.accountingCode;
    delete fiche.leadTimeDays;
  });
  const avant = dataStore.db.products.length;

  const file = path.join(dir, 'articles-reimport.csv');
  writeMeg(file);
  const report = await importProductsFile(file);

  const fiche = dataStore.db.products.find((p) => p.sku === 'ART0002');
  assert.equal(fiche.id, ancienId, 'la fiche existante est complétée, pas remplacée');
  assert.equal(fiche.salePrice, 6000);
  assert.equal(fiche.vatRate, 20);
  assert.equal(fiche.accountingCode, '707200');
  assert.equal(fiche.leadTimeDays, 21);
  // Retrouvées par leur code : aucune fiche en double.
  assert.equal(dataStore.db.products.length, avant);
  assert.equal(report.created, 0);
});

test('une colonne de stock, elle, crée bien le mouvement d’inventaire', async () => {
  const file = path.join(dir, 'articles-stock.csv');
  fs.writeFileSync(file, 'Code;Libellé;Stock\nART0001;Mix vanille poudre 2,5 kg;14\n', 'utf8');
  await importProductsFile(file);

  const mix = dataStore.db.products.find((p) => p.sku === 'ART0001');
  assert.equal(mix.qtyOnHand, 14);
  assert.ok(dataStore.db.stockMoves.some((m) => m.productId === mix.id && m.qty === 14));
});
