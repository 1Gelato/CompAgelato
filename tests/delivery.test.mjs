import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataStore,
  withContext,
  setActivityPublisher,
  registerDevice,
  recipientsFor,
  nextDeliveryNumber,
  deliveryTotal,
  upsertDeliveryNote,
  listDeliveryNotes,
  markDeliveryInvoiced,
  removeDeliveryNote,
} from './build/services.mjs';

/**
 * Le bon de livraison remplace un papier signé sur le capot : il doit porter
 * un numéro sûr, arriver au bureau avec une annonce, et n'être poussé qu'aux
 * téléphones qui ont le droit de le voir — jamais à son auteur.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-bons-'));

const QUENTIN = { userId: 'usr_quentin', username: 'quentin', displayName: 'Quentin', role: 'gerant' };
const HERVE = { userId: 'usr_herve', username: 'herve', displayName: 'Hervé', role: 'livreur' };

function enTantQue(identity, run) {
  return withContext({ identity, role: identity.role, token: '', from: 'test' }, run);
}

const annonces = [];

test.before(() => {
  dataStore.init({
    dataDir: path.join(dir, 'donnees'),
    documentsDir: path.join(dir, 'Documents'),
  });
  dataStore.mutate((db) => {
    db.users.push(
      { ...QUENTIN, id: QUENTIN.userId, passwordHash: 'sel:empreinte', createdAt: '', updatedAt: '' },
      { ...HERVE, id: HERVE.userId, passwordHash: 'sel:empreinte', createdAt: '', updatedAt: '' },
    );
    db.clients.push({
      id: 'cli_qg',
      code: 'CL0001',
      name: 'Bar le QG',
      address: { label: '92 rue Jean Jaurès, 29200 Brest' },
      tags: [],
      aliases: [],
      archived: false,
      createdAt: '',
      updatedAt: '',
    });
  });
  setActivityPublisher((event) => annonces.push(event));
});

test.after(() => {
  setActivityPublisher(() => {});
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* La numérotation                                                      */
/* ------------------------------------------------------------------ */

test('les numéros se suivent dans l’année et repartent à 1 l’année suivante', () => {
  const notes = [
    { number: 'BL-2026-0001' },
    { number: 'BL-2026-0007' },
    { number: 'BL-2025-0042' },
  ];
  assert.equal(nextDeliveryNumber(notes, '2026-08-21'), 'BL-2026-0008');
  assert.equal(nextDeliveryNumber(notes, '2027-01-02'), 'BL-2027-0001');
  assert.equal(nextDeliveryNumber([], '2026-08-21'), 'BL-2026-0001');
});

/* ------------------------------------------------------------------ */
/* La création : signée, numérotée, annoncée                            */
/* ------------------------------------------------------------------ */

const SIGNATURE = { strokes: [[[0.1, 0.5], [0.4, 0.3], [0.8, 0.6]]], at: '2026-08-21T09:00:00.000Z' };

test('le bon créé en tournée est numéroté par le serveur et annoncé au bureau', () => {
  const note = enTantQue(HERVE, () =>
    upsertDeliveryNote({
      date: '2026-08-21',
      clientId: 'cli_qg',
      items: [
        { label: 'Bac vanille 5 L', qty: 2 },
        { label: 'Cornets ×200', qty: 1 },
      ],
      routeId: 'rte_test',
      driverSignature: { ...SIGNATURE, name: 'Hervé' },
      clientSignature: { ...SIGNATURE, name: 'Le patron' },
    }),
  );

  assert.match(note.number, /^BL-\d{4}-0001$/);
  assert.equal(note.status, 'signed');
  assert.equal(note.createdBy, HERVE.userId);
  assert.equal(note.createdByName, 'Hervé');

  assert.equal(annonces.length, 1);
  const annonce = annonces[0];
  assert.equal(annonce.source, 'delivery');
  assert.ok(annonce.title.includes(note.number));
  assert.ok(annonce.title.includes('Bar le QG'), 'le client se lit dans le titre');
  assert.ok(annonce.text.includes('2 article(s)'));
  assert.ok(annonce.text.includes('par Hervé'));
  assert.equal(annonce.by, HERVE.userId, 'l’auteur est porté : son poste ne sonnera pas');
});

test('un identifiant pré-assigné hors ligne est respecté, pas le numéro', () => {
  const note = enTantQue(HERVE, () =>
    upsertDeliveryNote({
      id: 'bl_horsligne01',
      number: 'BL (en attente)',
      date: '2026-08-21',
      clientName: 'Client de passage',
      items: [{ label: 'Sundae fraise', qty: 3 }],
      driverSignature: SIGNATURE,
      clientSignature: SIGNATURE,
    }),
  );
  assert.equal(note.id, 'bl_horsligne01');
  // Le placeholder du téléphone n'entre jamais en base : la suite est au serveur.
  assert.match(note.number, /^BL-\d{4}-0002$/);
});

test('modifier un bon n’en refait ni le numéro ni une annonce', () => {
  const [premier] = listDeliveryNotes().filter((n) => n.clientId === 'cli_qg');
  const avant = annonces.length;
  const modifie = enTantQue(QUENTIN, () =>
    upsertDeliveryNote({ id: premier.id, notes: 'Vu avec Hervé.' }),
  );
  assert.equal(modifie.number, premier.number);
  assert.equal(modifie.createdByName, 'Hervé', 'l’origine ne se réécrit pas');
  assert.equal(annonces.length, avant, 'pas d’annonce pour une retouche');
});

/* ------------------------------------------------------------------ */
/* Qui est prévenu                                                      */
/* ------------------------------------------------------------------ */

test('l’annonce part vers gérant et livreurs, jamais vers son auteur', () => {
  dataStore.mutate((db) => {
    db.pushDevices = [];
  });
  enTantQue(QUENTIN, () => registerDevice({ token: 'tok-quentin', label: 'PC de poche' }));
  enTantQue(HERVE, () => registerDevice({ token: 'tok-herve', label: 'Téléphone tournée' }));

  const event = { source: 'delivery', title: 'x', text: 'y', by: HERVE.userId, at: 'z' };
  const destinataires = recipientsFor(event).map((d) => d.token);
  // Le livreur a le droit de voir les bons (il les crée) — mais pas le sien
  // en notification : il vient de le signer.
  assert.deepEqual(destinataires, ['tok-quentin']);

  const anonyme = { ...event, by: null };
  assert.deepEqual(
    recipientsFor(anonyme).map((d) => d.token).sort(),
    ['tok-herve', 'tok-quentin'],
  );
});

/* ------------------------------------------------------------------ */
/* Le cycle de vie au bureau                                            */
/* ------------------------------------------------------------------ */

test('marquer facturé, revenir en arrière, supprimer', () => {
  const [note] = listDeliveryNotes();

  const facture = markDeliveryInvoiced(note.id, true, 'doc_fac_01');
  assert.equal(facture.status, 'invoiced');
  assert.equal(facture.documentId, 'doc_fac_01');

  const rouvert = markDeliveryInvoiced(note.id, false);
  assert.equal(rouvert.status, 'signed');
  assert.equal(rouvert.documentId, undefined);

  const avant = listDeliveryNotes().length;
  removeDeliveryNote(note.id);
  assert.equal(listDeliveryNotes().length, avant - 1);
});

/* ------------------------------------------------------------------ */
/* Les prix : montrés au client, ou gardés pour le bureau               */
/* ------------------------------------------------------------------ */

test('le total ne compte que les lignes chiffrées', () => {
  assert.equal(
    deliveryTotal([
      { label: 'Bac vanille', qty: 2, unitPrice: 24.5 },
      { label: 'Cornets', qty: 3, unitPrice: 10 },
      // Une ligne sans prix ne fausse pas le total.
      { label: 'Échantillon', qty: 1 },
    ]),
    79,
  );
  assert.equal(deliveryTotal([]), 0);
});

test('l’affichage des prix suit le réglage, et chaque bon garde le dernier mot', () => {
  dataStore.mutate((db) => {
    db.settings.deliveryNotePrices = true;
  });
  const suitLeReglage = enTantQue(HERVE, () =>
    upsertDeliveryNote({ clientName: 'Réglage', items: [{ label: 'x', qty: 1 }] }),
  );
  assert.equal(suitLeReglage.showPrices, true);

  const decoche = enTantQue(HERVE, () =>
    upsertDeliveryNote({ clientName: 'Décoché', showPrices: false, items: [{ label: 'x', qty: 1 }] }),
  );
  assert.equal(decoche.showPrices, false, 'la case du bon prime sur le réglage');

  dataStore.mutate((db) => {
    db.settings.deliveryNotePrices = false;
  });
  const sansReglage = enTantQue(HERVE, () =>
    upsertDeliveryNote({ clientName: 'Sans prix', items: [{ label: 'x', qty: 1 }] }),
  );
  assert.equal(sansReglage.showPrices, false);
});

test('le montant part au bureau même quand le client ne l’a pas vu', () => {
  const avant = annonces.length;
  enTantQue(HERVE, () =>
    upsertDeliveryNote({
      clientName: 'Camping du Bord de Mer',
      showPrices: false,
      items: [{ label: 'Bac vanille 5 L', qty: 2, unitPrice: 24.5 }],
    }),
  );
  assert.equal(annonces.length, avant + 1);
  const annonce = annonces.at(-1);
  // Prix masqués côté client, montant annoncé côté bureau : c'est lui qui
  // fera la facture.
  assert.ok(annonce.text.includes('49.00 € HT'), `annonce sans montant : ${annonce.text}`);
});

test('le prix copié sur la ligne reste celui du jour de la livraison', () => {
  const note = enTantQue(HERVE, () =>
    upsertDeliveryNote({
      clientName: 'Tarif du jour',
      items: [{ label: 'Bac vanille 5 L', qty: 1, unitPrice: 24.5 }],
    }),
  );
  // Le prix est porté par la ligne du bon, pas lu dans le catalogue : changer
  // le tarif demain ne réécrit pas un bon déjà signé.
  assert.equal(note.items[0].unitPrice, 24.5);
});

test('la liste vient du plus récent au plus ancien', () => {
  enTantQue(HERVE, () =>
    upsertDeliveryNote({
      date: '2026-08-19',
      clientName: 'Ancien',
      items: [{ label: 'x', qty: 1 }],
    }),
  );
  const dates = listDeliveryNotes().map((n) => n.date);
  const triees = [...dates].sort().reverse();
  assert.deepEqual(dates, triees);
});
