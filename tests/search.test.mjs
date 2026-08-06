import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesAmount, normalizeAmountQuery } from './build/ui.mjs';

test('les chiffres tapés retrouvent le montant, avec ou sans décimales', () => {
  // Le cas qui a motivé la fonctionnalité : une opération de 482,96 € qu'on
  // cherche en tapant simplement « 482 ».
  assert.equal(matchesAmount('482', [482.96]), true);
  assert.equal(matchesAmount('482,96', [482.96]), true);
  assert.equal(matchesAmount('482.96', [482.96]), true);
  // Et une facture de 115,56 € qu'on cherche par « 115 ».
  assert.equal(matchesAmount('115', [115.56]), true);
});

test('le signe est ignoré : un débit se cherche comme un crédit', () => {
  assert.equal(matchesAmount('842,15', [-842.15]), true);
  assert.equal(matchesAmount('842', [-842.15]), true);
});

test('les séparateurs de milliers et le symbole € sont tolérés', () => {
  assert.equal(matchesAmount('1 250', [1250]), true);
  assert.equal(matchesAmount('1250', [1250]), true);
  assert.equal(matchesAmount('1250,00 €', [1250]), true);
  // Espace insécable, tel que collé depuis un tableau ou un PDF.
  assert.equal(matchesAmount('1 250', [1250]), true);
});

test('la recherche porte sur plusieurs montants à la fois', () => {
  // Une facture : HT 96,30 — TVA 19,26 — TTC 115,56.
  const facture = [115.56, 96.3, 19.26];
  assert.equal(matchesAmount('96,30', facture), true, 'le HT doit être trouvé');
  assert.equal(matchesAmount('19,26', facture), true, 'la TVA doit être trouvée');
  assert.equal(matchesAmount('115,56', facture), true, 'le TTC doit être trouvé');
  assert.equal(matchesAmount('77', facture), false);
});

test('un montant absent ne correspond pas', () => {
  assert.equal(matchesAmount('999', [482.96, 115.56]), false);
  assert.equal(matchesAmount('483', [482.96]), false);
});

test('les valeurs manquantes sont ignorées sans planter', () => {
  assert.equal(matchesAmount('10', [null, undefined, Number.NaN]), false);
  assert.equal(matchesAmount('10', [null, 10]), true);
  assert.equal(matchesAmount('10', []), false);
});

test('une recherche textuelle n’est jamais lue comme un montant', () => {
  // Sans quoi le filtre par montant renverrait des résultats inattendus sur
  // une recherche de client ou de numéro de pièce.
  assert.equal(normalizeAmountQuery('AMBASSADE'), null);
  assert.equal(normalizeAmountQuery('FAC00000669'), null);
  assert.equal(normalizeAmountQuery(''), null);
  assert.equal(normalizeAmountQuery('   '), null);
  assert.equal(normalizeAmountQuery('12,345'), null, 'trois décimales : ce n’est pas un montant');
  assert.equal(matchesAmount('AMBASSADE', [482.96]), false);
});

test('normalizeAmountQuery ramène toute écriture à un nombre à point', () => {
  assert.equal(normalizeAmountQuery('1 250,00 €'), '1250.00');
  assert.equal(normalizeAmountQuery('482'), '482');
  assert.equal(normalizeAmountQuery('482,9'), '482.9');
});

test('les centimes seuls restent trouvables', () => {
  // « 0,50 » doit retrouver une opération de 0,50 €.
  assert.equal(matchesAmount('0,50', [0.5]), true);
  assert.equal(matchesAmount('0', [0]), true);
});
