import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describePackaging,
  invoiceQtyToStockUnits,
  packagingDefaults,
  stockContent,
} from './build/services.mjs';

/*
 * Conditionnements tirés de deux vraies factures O'Gelato :
 * - BRO00000960 : « Poche de 4.5kg (vendu en carton de 2 poches) », 20,00 pc
 *   à 17,20 € → la quantité est un nombre de poches.
 * - FAC00000837 : « PREMIX VANILLE CREMITO », 12,50 kg à 11,50 € → la
 *   quantité est un nombre de kilos, pas de poches.
 */

const mixLiquide = { packSize: 4.5, packMeasure: 'kg', unitsPerCase: 2, invoicedAs: 'unit', unit: 'poche' };
const mixPoudre = { packSize: 2.5, packMeasure: 'kg', unitsPerCase: undefined, invoicedAs: 'measure', unit: 'poche' };

test('mix liquide facturé à la poche : la quantité est déjà en unités de stock', () => {
  assert.equal(invoiceQtyToStockUnits(mixLiquide, 20), 20);
  assert.equal(invoiceQtyToStockUnits(mixLiquide, 12), 12);
});

test('mix poudre facturé au kilo : 12,5 kg font 5 poches de 2,5 kg', () => {
  assert.equal(invoiceQtyToStockUnits(mixPoudre, 12.5), 5);
  // SUBLIMO : sachet de 1,65 kg, facturé 13,20 kg → 8 sachets.
  assert.equal(invoiceQtyToStockUnits({ ...mixPoudre, packSize: 1.65 }, 13.2), 8);
});

test('facturation au carton : chaque carton apporte ses unités', () => {
  const auCarton = { ...mixLiquide, invoicedAs: 'case' };
  assert.equal(invoiceQtyToStockUnits(auCarton, 10), 20, '10 cartons de 2 poches = 20 poches');
});

test('sans conditionnement exploitable, la quantité est reprise telle quelle', () => {
  // Mieux vaut un stock inchangé qu'un stock faussé par une division hasardeuse.
  assert.equal(invoiceQtyToStockUnits({ invoicedAs: 'measure' }, 12.5), 12.5);
  assert.equal(invoiceQtyToStockUnits({ invoicedAs: 'measure', packSize: 0 }, 12.5), 12.5);
  assert.equal(invoiceQtyToStockUnits({ invoicedAs: 'case' }, 10), 10);
  assert.equal(invoiceQtyToStockUnits({}, 7), 7);
});

test('une quantité invalide ne touche pas au stock', () => {
  assert.equal(invoiceQtyToStockUnits(mixPoudre, Number.NaN), 0);
  assert.equal(invoiceQtyToStockUnits(mixPoudre, Number.POSITIVE_INFINITY), 0);
});

test('les valeurs par défaut reprennent les conditionnements réels', () => {
  const liquide = packagingDefaults('mixLiquid');
  assert.equal(liquide.packSize, 4.5);
  assert.equal(liquide.unitsPerCase, 2);
  assert.equal(liquide.invoicedAs, 'unit');

  const poudre = packagingDefaults('mixPowder');
  assert.equal(poudre.packSize, 2.5);
  assert.equal(poudre.invoicedAs, 'measure', 'la poudre est facturée au kilo');

  // Une machine ne se conditionne pas.
  assert.equal(packagingDefaults('machine').packSize, undefined);
  assert.equal(packagingDefaults('machine').unit, 'pièce');
});

test('le contenu total du stock est calculable', () => {
  assert.deepEqual(stockContent(mixLiquide, 20), { amount: 90, measure: 'kg' });
  assert.equal(stockContent({ packMeasure: 'kg' }, 5), null);
});

test('le conditionnement se dit en une phrase lisible', () => {
  const texte = describePackaging(mixLiquide);
  assert.match(texte, /1 poche = 4,5 kg/);
  assert.match(texte, /carton de 2/);
  assert.match(texte, /facturé à l’poche|facturé à l/);

  assert.match(describePackaging(mixPoudre), /facturé au kg/);
});
