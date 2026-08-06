import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMachineAvailability,
  entryReservesMachines,
  machineAvailability,
  notificationFor,
  notifyEnabled,
} from './build/services.mjs';

/** Machine du parc avec valeurs par défaut raisonnables. */
const machine = (id, qtyTotal, name = `Machine ${id}`) => ({
  id, name, qtyTotal, archived: false, createdAt: '', updatedAt: '',
});

/** Écriture d'un cahier, par défaut une demande événementielle. */
const entry = (over = {}) => ({
  id: over.id ?? 'e1',
  kind: 'event',
  title: 'Fête de la mer',
  status: 'open',
  machines: [{ machineId: 'm1', qty: 1 }],
  createdAt: '',
  updatedAt: '',
  ...over,
});

/* ------------------------------------------------------------------ */
/* La règle centrale : seul un devis validé réserve                     */
/* ------------------------------------------------------------------ */

test('une simple demande ne réserve rien, un devis validé oui', () => {
  assert.equal(entryReservesMachines(entry({ status: 'open' })), false);
  assert.equal(entryReservesMachines(entry({ status: 'confirmed' })), true);
  // Terminé ou annulé : la machine revient au parc.
  assert.equal(entryReservesMachines(entry({ status: 'done' })), false);
  assert.equal(entryReservesMachines(entry({ status: 'cancelled' })), false);
  // Un cahier SAV ne touche jamais au parc, quel que soit son statut.
  assert.equal(entryReservesMachines({ kind: 'sav', status: 'confirmed' }), false);
});

test('la disponibilité se déduit des devis validés non terminés', () => {
  const machines = [machine('m1', 3)];
  const entries = [
    entry({ id: 'a', status: 'open', machines: [{ machineId: 'm1', qty: 2 }] }),
    entry({ id: 'b', status: 'confirmed', machines: [{ machineId: 'm1', qty: 2 }] }),
    entry({ id: 'c', status: 'done', machines: [{ machineId: 'm1', qty: 1 }] }),
  ];
  const [slot] = machineAvailability(machines, entries);
  assert.equal(slot.reserved, 2, 'seul le devis validé compte');
  assert.equal(slot.available, 1);
  assert.equal(slot.upcoming.length, 1);
});

test('les prochaines sorties sont triées par date, machines archivées exclues', () => {
  const machines = [machine('m1', 5), { ...machine('m2', 2), archived: true }];
  const entries = [
    entry({ id: 'a', status: 'confirmed', eventDate: '2026-09-15', machines: [{ machineId: 'm1', qty: 1 }] }),
    entry({ id: 'b', status: 'confirmed', eventDate: '2026-08-20', machines: [{ machineId: 'm1', qty: 2 }] }),
    entry({ id: 'c', status: 'confirmed', machines: [{ machineId: 'm1', qty: 1 }] }), // sans date
  ];
  const slots = machineAvailability(machines, entries);
  assert.equal(slots.length, 1, 'une machine archivée ne figure plus au parc');
  assert.deepEqual(
    slots[0].upcoming.map((u) => u.date ?? 'sans'),
    ['2026-08-20', '2026-09-15', 'sans'],
  );
  assert.equal(slots[0].available, 1);
});

/* ------------------------------------------------------------------ */
/* Le garde-fou à la validation d'un devis                              */
/* ------------------------------------------------------------------ */

test('valider un devis au-delà du parc est refusé, en nommant le manque', () => {
  const machines = [machine('m1', 2, 'Machine à glace italienne')];
  const entries = [
    entry({ id: 'a', status: 'confirmed', machines: [{ machineId: 'm1', qty: 2 }] }),
  ];
  const candidate = entry({ id: 'b', status: 'confirmed', machines: [{ machineId: 'm1', qty: 1 }] });
  const shortages = checkMachineAvailability(machines, entries, candidate);
  assert.equal(shortages.length, 1);
  assert.equal(shortages[0].machine.name, 'Machine à glace italienne');
  assert.equal(shortages[0].missing, 1);
});

test('modifier un devis déjà validé ne se bloque pas lui-même', () => {
  const machines = [machine('m1', 2)];
  const already = entry({ id: 'a', status: 'confirmed', machines: [{ machineId: 'm1', qty: 2 }] });
  // Le même devis repasse par la validation (modification) : il doit pouvoir
  // conserver ses 2 machines puisque c'est lui qui les réserve.
  const shortages = checkMachineAvailability(machines, [already], { ...already });
  assert.equal(shortages.length, 0);
});

test('une demande (non validée) ne déclenche jamais le garde-fou', () => {
  const machines = [machine('m1', 1)];
  const entries = [entry({ id: 'a', status: 'confirmed', machines: [{ machineId: 'm1', qty: 1 }] })];
  // Le parc est plein, mais une simple demande peut toujours être notée.
  const candidate = entry({ id: 'b', status: 'open', machines: [{ machineId: 'm1', qty: 5 }] });
  assert.equal(checkMachineAvailability(machines, entries, candidate).length, 0);
});

/* ------------------------------------------------------------------ */
/* Notifications                                                        */
/* ------------------------------------------------------------------ */

test('le message d’ajout nomme le cahier, le client et l’objet', () => {
  const note = notificationFor(
    entry({ kind: 'sav', title: 'Machine en panne', parts: 'joint de cuve', status: 'open' }),
    'Restaurant La Dune',
  );
  assert.equal(note.title, 'SAV — Restaurant La Dune');
  assert.match(note.message, /Machine en panne/);
  assert.match(note.message, /joint de cuve/);
});

test('le message de devis validé signale la réservation des machines', () => {
  const note = notificationFor(
    entry({ status: 'confirmed', eventDate: '2026-08-20' }),
    'Mairie de Pornichet',
    'confirmed',
  );
  assert.equal(note.title, 'Devis validé — Mairie de Pornichet');
  assert.match(note.message, /20\/08\/2026/);
  assert.match(note.message, /machines réservées/);
});

test('sans fiche client, le nom noté à la volée est utilisé', () => {
  const note = notificationFor(entry({ clientName: 'Camping du Bois' }), undefined);
  assert.equal(note.title, 'Événementiel — Camping du Bois');
});

test('aucun envoi tant qu’aucun sujet n’est configuré', () => {
  assert.equal(notifyEnabled({}), false);
  assert.equal(notifyEnabled({ topic: '  ' }), false);
  assert.equal(notifyEnabled({ topic: 'compagelato-x' }), true);
});
