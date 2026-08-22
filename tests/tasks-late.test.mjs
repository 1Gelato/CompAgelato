import test from 'node:test';
import assert from 'node:assert/strict';
import { todayLocal, isTaskLate } from './build/services.mjs';

/**
 * Le retard d'une tâche, en heure locale.
 *
 * La règle est minuscule mais elle avait deux copies (la liste des tâches et
 * la pastille de l'onglet) et un piège : `toISOString()` donne le jour UTC.
 * Entre minuit et deux heures du matin en France, « aujourd'hui » était
 * encore hier, et une tâche échue la veille passait inaperçue.
 */

test('todayLocal écrit la date locale, zéro-paddée', () => {
  // Les composantes locales, exactement — pas un passage par UTC.
  assert.equal(todayLocal(new Date(2026, 0, 5, 12, 0)), '2026-01-05');
  assert.equal(todayLocal(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('todayLocal juste après minuit reste sur le jour local', () => {
  // 22/08 à 00 h 30 locale : quel que soit le fuseau de la machine de test,
  // la réponse vient de getDate(), donc c'est bien le 22 — là où un
  // toISOString() aurait pu répondre le 21 pour un fuseau positif.
  const nuit = new Date(2026, 7, 22, 0, 30);
  assert.equal(todayLocal(nuit), '2026-08-22');
});

test('une échéance passée sans être faite est en retard', () => {
  assert.equal(isTaskLate({ dueDate: '2026-08-21', status: 'open' }, '2026-08-22'), true);
  assert.equal(isTaskLate({ dueDate: '2026-08-21', status: 'doing' }, '2026-08-22'), true);
});

test('échéance du jour : pas encore en retard', () => {
  assert.equal(isTaskLate({ dueDate: '2026-08-22', status: 'open' }, '2026-08-22'), false);
});

test('échéance future : rien à crier', () => {
  assert.equal(isTaskLate({ dueDate: '2026-08-23', status: 'open' }, '2026-08-22'), false);
});

test('une tâche faite n’est jamais en retard, même échue', () => {
  assert.equal(isTaskLate({ dueDate: '2020-01-01', status: 'done' }, '2026-08-22'), false);
});

test('sans échéance, pas de retard possible', () => {
  assert.equal(isTaskLate({ status: 'open' }, '2026-08-22'), false);
  assert.equal(isTaskLate({ dueDate: '', status: 'open' }, '2026-08-22'), false);
});

test('sans repère fourni, la règle prend le jour local courant', () => {
  // Hier, construit par composantes locales (soustraire 24 h retomberait sur
  // le même jour les nuits de changement d'heure).
  const now = new Date();
  const hier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  assert.equal(isTaskLate({ dueDate: todayLocal(hier), status: 'open' }), true);
  // Aujourd'hui : jamais.
  assert.equal(isTaskLate({ dueDate: todayLocal(), status: 'open' }), false);
});
