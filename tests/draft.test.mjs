import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataStore,
  ingestParsedDocument,
  buildDashboard,
  applyAllPending,
  awaitsStock,
} from './build/services.mjs';

/**
 * Les « factures brouillon » (BRO) tiennent lieu de proforma : elles servent à
 * réclamer un règlement sans avancer la TVA, et la facture définitive (FAC)
 * suit toujours. Comptées comme définitives, chaque vente apparaîtrait deux
 * fois — dans le chiffre d'affaires comme dans les sorties de stock.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-brouillon-'));

test.before(() => {
  dataStore.init({
    dataDir: path.join(dir, 'donnees'),
    documentsDir: path.join(dir, 'Documents'),
  });
});

test.after(() => {
  // L'écriture disque est différée : la forcer avant d'effacer le dossier.
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

function parsed(number, { draft = false, kind = 'invoice', ht = 100 } = {}) {
  return {
    kind,
    draft,
    number,
    date: '2026-06-12',
    dueDate: null,
    clientName: 'GLACIER DU MARCHE',
    clientAddress: null,
    clientSiret: null,
    clientEmail: null,
    clientPhone: null,
    currency: 'EUR',
    totalHT: ht,
    totalVAT: Math.round(ht * 0.2 * 100) / 100,
    totalTTC: Math.round(ht * 1.2 * 100) / 100,
    lines: [],
    confidence: 1,
    warnings: [],
  };
}

test('une facture brouillon entre en base comme provisoire', () => {
  const doc = ingestParsedDocument(parsed('BRO00001041', { draft: true }), { sourceFormat: 'pdf' });
  assert.equal(doc.status, 'draft');
  assert.equal(awaitsStock(doc), false, 'un brouillon n’attend aucune sortie de stock');
});

test('la facture définitive qui suit, elle, compte', () => {
  const doc = ingestParsedDocument(parsed('FAC00001041'), { sourceFormat: 'pdf' });
  assert.equal(doc.status, 'confirmed');
  assert.equal(awaitsStock(doc), true);
});

test('le chiffre d’affaires ignore le brouillon et retient la facture', () => {
  const stats = buildDashboard();
  // BRO 100 € HT + FAC 100 € HT en base, une seule vente : 100 €, pas 200 €.
  assert.equal(stats.revenueHT, 100);
  assert.equal(stats.invoices, 1);
});

test('l’application du stock en masse laisse les brouillons de côté', () => {
  const before = dataStore.db.documents.find((d) => d.number === 'BRO00001041');
  applyAllPending();
  const after = dataStore.db.documents.find((d) => d.number === 'BRO00001041');
  assert.equal(before.stockApplied, false);
  assert.equal(after.stockApplied, false, 'le stock d’un brouillon ne doit jamais sortir');
});

test('le compteur « en attente » ne réclame pas un travail impossible', () => {
  const stats = buildDashboard();
  const attendus = dataStore.db.documents.filter(awaitsStock).length;
  assert.equal(stats.unappliedDocuments, attendus);
  // Le brouillon en est exclu : il ne sortira jamais du stock.
  assert.ok(
    !dataStore.db.documents.filter(awaitsStock).some((d) => d.number === 'BRO00001041'),
  );
});

test('relire un fichier rattrape une pièce importée avant la détection', () => {
  // La pièce est déjà en base, marquée définitive par un lecteur qui ne savait
  // pas encore reconnaître les brouillons. La relecture doit la corriger.
  const avant = dataStore.db.documents.find((d) => d.number === 'BRO00001041');
  dataStore.mutate(() => {
    avant.status = 'confirmed';
  });
  const apres = ingestParsedDocument(parsed('BRO00001041', { draft: true }), { sourceFormat: 'pdf' });
  assert.equal(apres.id, avant.id, 'même pièce, pas un doublon');
  assert.equal(apres.status, 'draft');
});

test('un statut choisi à la main tient bon face au lecteur', () => {
  const doc = ingestParsedDocument(parsed('BRO00001042', { draft: true }), { sourceFormat: 'pdf' });
  dataStore.mutate(() => {
    doc.status = 'paid';
    doc.manualFields = ['status'];
  });
  const relu = ingestParsedDocument(parsed('BRO00001042', { draft: true }), { sourceFormat: 'pdf' });
  assert.equal(relu.status, 'paid', 'la décision de l’utilisateur l’emporte');
});

test('un montant qui change après la déduction du stock ne passe pas en silence', () => {
  // Cas réel : une pièce corrigée, ou un brouillon devenu facture définitive
  // sous le même numéro. Les lignes restent figées pour que les mouvements de
  // stock enregistrés gardent un sens — mais l'écart doit être dit.
  const doc = ingestParsedDocument(parsed('FAC00005555', { ht: 500 }), { sourceFormat: 'pdf' });
  dataStore.mutate(() => {
    doc.stockApplied = true;
  });
  const relu = ingestParsedDocument(parsed('FAC00005555', { ht: 800 }), { sourceFormat: 'pdf' });
  assert.equal(relu.totalHT, 800);
  assert.ok(
    relu.warnings.some((w) => /Montant modifié après la déduction du stock/.test(w)),
    `aucun avertissement : ${JSON.stringify(relu.warnings)}`,
  );
});

test('un montant inchangé ne déclenche aucun avertissement', () => {
  const doc = ingestParsedDocument(parsed('FAC00006666', { ht: 500 }), { sourceFormat: 'pdf' });
  dataStore.mutate(() => {
    doc.stockApplied = true;
  });
  const relu = ingestParsedDocument(parsed('FAC00006666', { ht: 500 }), { sourceFormat: 'pdf' });
  assert.deepEqual(relu.warnings, []);
});

test('un total corrigé à la main n’est pas signalé comme un écart', () => {
  // Le lecteur relit 800 € mais l'utilisateur a fixé 500 € : c'est sa valeur
  // qui est conservée, il n'y a donc aucun écart à signaler.
  const doc = ingestParsedDocument(parsed('FAC00007777', { ht: 500 }), { sourceFormat: 'pdf' });
  dataStore.mutate(() => {
    doc.stockApplied = true;
    doc.manualFields = ['totalHT'];
  });
  const relu = ingestParsedDocument(parsed('FAC00007777', { ht: 800 }), { sourceFormat: 'pdf' });
  assert.equal(relu.totalHT, 500);
  assert.deepEqual(relu.warnings, []);
});
