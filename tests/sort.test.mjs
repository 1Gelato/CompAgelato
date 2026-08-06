import test from 'node:test';
import assert from 'node:assert/strict';
import { compareValues, sortRows } from './build/ui.mjs';

/**
 * Le tri des tableaux est du code d'interface, mais sa logique de comparaison
 * est pure : elle se teste sans navigateur, depuis le bundle produit par
 * scripts/build-tests.mjs.
 */

const by = (key, direction) => ({ key, direction });
const accessors = {
  name: (r) => r.name,
  amount: (r) => r.amount,
  date: (r) => r.date,
};

test('les nombres se trient sur leur valeur, pas sur leur écriture', () => {
  const rows = [{ amount: 90 }, { amount: 1000 }, { amount: 200 }];
  assert.deepEqual(
    sortRows(rows, by('amount', 'asc'), accessors).map((r) => r.amount),
    [90, 200, 1000],
  );
  assert.deepEqual(
    sortRows(rows, by('amount', 'desc'), accessors).map((r) => r.amount),
    [1000, 200, 90],
  );
});

test('les textes se trient selon l’alphabet français, accents et casse ignorés', () => {
  const rows = [{ name: 'Étoile' }, { name: 'accord' }, { name: 'Zèbre' }, { name: 'Accueil' }];
  assert.deepEqual(
    sortRows(rows, by('name', 'asc'), accessors).map((r) => r.name),
    ['accord', 'Accueil', 'Étoile', 'Zèbre'],
  );
});

test('les nombres écrits dans du texte se trient naturellement', () => {
  // Sans tri « numérique », FAC10 passerait avant FAC9.
  const rows = [{ name: 'FAC00000010' }, { name: 'FAC00000009' }, { name: 'FAC00000100' }];
  assert.deepEqual(
    sortRows(rows, by('name', 'asc'), accessors).map((r) => r.name),
    ['FAC00000009', 'FAC00000010', 'FAC00000100'],
  );
});

test('les valeurs manquantes finissent en bas, quel que soit le sens', () => {
  const rows = [{ amount: 50 }, { amount: null }, { amount: 10 }, { amount: undefined }];
  assert.deepEqual(
    sortRows(rows, by('amount', 'asc'), accessors).map((r) => r.amount),
    [10, 50, null, undefined],
  );
  assert.deepEqual(
    sortRows(rows, by('amount', 'desc'), accessors).map((r) => r.amount),
    [50, 10, null, undefined],
    'une ligne sans montant n’a rien à faire en tête du classement des plus gros montants',
  );
});

test('le tri est stable : à valeur égale, l’ordre d’origine est conservé', () => {
  const rows = [
    { name: 'b', date: '2026-01-01' },
    { name: 'a', date: '2026-01-01' },
    { name: 'c', date: '2026-01-01' },
  ];
  assert.deepEqual(
    sortRows(rows, by('date', 'asc'), accessors).map((r) => r.name),
    ['b', 'a', 'c'],
  );
});

test('les dates ISO se trient chronologiquement', () => {
  const rows = [{ date: '2026-01-09' }, { date: '2025-12-31' }, { date: '2026-01-10' }];
  assert.deepEqual(
    sortRows(rows, by('date', 'desc'), accessors).map((r) => r.date),
    ['2026-01-10', '2026-01-09', '2025-12-31'],
  );
});

test('sortRows renvoie la liste intacte sans tri ou sur une colonne inconnue', () => {
  const rows = [{ name: 'b' }, { name: 'a' }];
  assert.deepEqual(sortRows(rows, null, accessors), rows);
  assert.deepEqual(sortRows(rows, by('inconnue', 'asc'), accessors), rows);
});

test('compareValues : les booléens se trient faux puis vrai', () => {
  assert.ok(compareValues(false, true, 'asc') < 0);
  assert.ok(compareValues(false, true, 'desc') > 0);
  assert.equal(compareValues(true, true, 'asc'), 0);
});

test('une chaîne vide compte comme une valeur manquante', () => {
  const rows = [{ name: 'Zoé' }, { name: '' }, { name: 'Alice' }];
  assert.deepEqual(
    sortRows(rows, by('name', 'asc'), accessors).map((r) => r.name),
    ['Alice', 'Zoé', ''],
  );
});
