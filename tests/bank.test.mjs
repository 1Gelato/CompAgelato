import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCEPT_SCORE,
  categorizeLabel,
  looksLikeStatement,
  parseStatementTable,
  readTable,
  scoreDocumentMatch,
  transactionFingerprint,
} from './build/services.mjs';

/** Construit un objet Table comme le ferait readTable, sans passer par le disque. */
function table(headers, rows) {
  return {
    headers,
    rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    source: 'csv',
  };
}

test('colonnes Débit / Crédit séparées : les sens sont respectés', () => {
  const t = table(
    ['Date', 'Libellé', 'Débit', 'Crédit', 'Solde'],
    [
      ['01/01/2026', 'VIREMENT AMBASSADE BRETONNE', '', '1 250,00', '5 420,10'],
      ['03/01/2026', 'PRLV URSSAF', '842,15', '', '4 577,95'],
    ],
  );
  const { transactions, warnings } = parseStatementTable(t);

  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].amount, 1250);
  assert.equal(transactions[0].date, '2026-01-01');
  assert.equal(transactions[0].balance, 5420.1);
  assert.equal(transactions[1].amount, -842.15, 'un débit doit devenir négatif');
});

test('colonne Montant unique déjà signée', () => {
  const t = table(
    ['Date opération', 'Libellé', 'Montant'],
    [
      ['05/01/2026', 'CB CARREFOUR', '-96,30'],
      ['06/01/2026', 'VIR RECU AGRILLADE', '480,00'],
    ],
  );
  const { transactions } = parseStatementTable(t);
  assert.equal(transactions[0].amount, -96.3);
  assert.equal(transactions[1].amount, 480);
});

test('montant positif accompagné d’une colonne de sens (D/C)', () => {
  const t = table(
    ['Date', 'Libellé', 'Montant', 'Sens'],
    [
      ['07/01/2026', 'ACHAT METRO', '212,40', 'D'],
      ['08/01/2026', 'REMISE CHEQUE', '150,00', 'C'],
    ],
  );
  const { transactions } = parseStatementTable(t);
  assert.equal(transactions[0].amount, -212.4);
  assert.equal(transactions[1].amount, 150);
});

test('« date de valeur » ne vole pas la colonne « date d’opération »', () => {
  const t = table(
    ['Date opération', 'Date de valeur', 'Libellé', 'Montant'],
    [['10/01/2026', '12/01/2026', 'VIR SALAIRE', '-1 800,00']],
  );
  const { transactions, mapping } = parseStatementTable(t);
  assert.equal(mapping.date, 'Date opération');
  assert.equal(mapping.valueDate, 'Date de valeur');
  assert.equal(transactions[0].date, '2026-01-10');
  assert.equal(transactions[0].valueDate, '2026-01-12');
});

test('les lignes de total et de solde ne sont pas des opérations', () => {
  const t = table(
    ['Date', 'Libellé', 'Montant'],
    [
      ['01/01/2026', 'SOLDE INITIAL', '5 000,00'],
      ['02/01/2026', 'CB STATION AVIA', '-72,00'],
      ['31/01/2026', 'TOTAL DES OPERATIONS', '-72,00'],
      ['31/01/2026', 'NOUVEAU SOLDE', '4 928,00'],
    ],
  );
  const { transactions, skipped } = parseStatementTable(t);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].label, 'CB STATION AVIA');
  assert.equal(skipped, 3);
});

/* ------------------------------------------------------------------ */
/* Dédoublonnage — le cœur du besoin                                    */
/* ------------------------------------------------------------------ */

test('relire deux fois le même relevé produit exactement les mêmes empreintes', () => {
  const rows = [
    ['01/01/2026', 'VIREMENT AMBASSADE BRETONNE', '1 250,00'],
    ['03/01/2026', 'PRLV URSSAF', '-842,15'],
    ['05/01/2026', 'CB CARREFOUR', '-96,30'],
  ];
  const headers = ['Date', 'Libellé', 'Montant'];
  const first = parseStatementTable(table(headers, rows)).transactions.map((t) => t.fingerprint);
  const second = parseStatementTable(table(headers, rows)).transactions.map((t) => t.fingerprint);
  assert.deepEqual(first, second);
});

test('deux opérations réellement identiques le même jour restent distinctes', () => {
  const t = table(
    ['Date', 'Libellé', 'Montant'],
    [
      ['04/01/2026', 'CB BOULANGERIE', '-12,50'],
      ['04/01/2026', 'CB BOULANGERIE', '-12,50'],
    ],
  );
  const { transactions } = parseStatementTable(t);
  assert.equal(transactions.length, 2, 'un vrai doublon bancaire ne doit pas être supprimé');
  assert.notEqual(
    transactions[0].fingerprint,
    transactions[1].fingerprint,
    'deux opérations identiques doivent avoir des empreintes différentes',
  );
});

test('deux relevés qui se chevauchent ne créent aucun doublon', () => {
  const headers = ['Date', 'Libellé', 'Montant'];
  // Relevé de janvier.
  const janvier = parseStatementTable(
    table(headers, [
      ['20/01/2026', 'VIR AGRILLADE', '480,00'],
      ['25/01/2026', 'CB TOTALENERGIES', '-88,20'],
    ]),
  ).transactions;
  // Relevé janvier→février : reprend les mêmes lignes, puis en ajoute.
  const janvierFevrier = parseStatementTable(
    table(headers, [
      ['20/01/2026', 'VIR AGRILLADE', '480,00'],
      ['25/01/2026', 'CB TOTALENERGIES', '-88,20'],
      ['02/02/2026', 'VIR AMICALE DES PLAISANCIERS', '620,00'],
    ]),
  ).transactions;

  const connues = new Set(janvier.map((t) => t.fingerprint));
  const nouvelles = janvierFevrier.filter((t) => !connues.has(t.fingerprint));
  assert.equal(nouvelles.length, 1, 'seule l’opération de février doit être ajoutée');
  assert.equal(nouvelles[0].label, 'VIR AMICALE DES PLAISANCIERS');
});

test('l’empreinte change dès qu’un élément de l’opération change', () => {
  const base = transactionFingerprint('2026-01-04', -12.5, 'CB BOULANGERIE', 0);
  assert.notEqual(base, transactionFingerprint('2026-01-05', -12.5, 'CB BOULANGERIE', 0));
  assert.notEqual(base, transactionFingerprint('2026-01-04', -12.6, 'CB BOULANGERIE', 0));
  assert.notEqual(base, transactionFingerprint('2026-01-04', -12.5, 'CB BOULANGER', 0));
  // …mais reste insensible à la casse et aux accents du libellé.
  assert.equal(base, transactionFingerprint('2026-01-04', -12.5, 'cb boulangerie', 0));
});

/* ------------------------------------------------------------------ */
/* Catégorisation                                                       */
/* ------------------------------------------------------------------ */

test('reconnaissance des dépenses courantes', () => {
  assert.equal(categorizeLabel('PRLV URSSAF PAYS DE LOIRE', -842.15), 'taxes');
  assert.equal(categorizeLabel('CB TOTALENERGIES ST NAZAIRE', -88.2), 'fuel');
  assert.equal(categorizeLabel('VIR SEPA SALAIRE JANVIER', -1800), 'payroll');
  assert.equal(categorizeLabel('COTISATION CARTE VISA BUSINESS', -12), 'bankFees');
  assert.equal(categorizeLabel('PRLV AXA ASSURANCE PRO', -145.6), 'insurance');
  assert.equal(categorizeLabel('VIR LOYER LOCAL PA DE BRAIS', -950), 'rent');
  assert.equal(categorizeLabel('PRLV ORANGE SA', -49.99), 'utilities');
  assert.equal(categorizeLabel('CB METRO SAINT NAZAIRE', -318.4), 'suppliers');
});

test('un encaissement est une vente par défaut, jamais une dépense', () => {
  assert.equal(categorizeLabel('VIREMENT AMBASSADE BRETONNE', 1250), 'sales');
  // Un remboursement d'un fournisseur connu reste un encaissement.
  assert.equal(categorizeLabel('VIR METRO REMBOURSEMENT', 42), 'sales');
  assert.equal(categorizeLabel('OPERATION INCONNUE', -30), 'other');
});

/* ------------------------------------------------------------------ */
/* Reconnaissance de fichier                                            */
/* ------------------------------------------------------------------ */

test('un relevé est reconnu, une facture exportée ne l’est pas', () => {
  assert.equal(looksLikeStatement(['Date', 'Libellé', 'Débit', 'Crédit', 'Solde']), true);
  assert.equal(looksLikeStatement(['Date opération', 'Libellé', 'Montant']), true);
  assert.equal(
    looksLikeStatement(['Numéro', 'Date', 'Client', 'Total HT', 'Total TTC', 'Statut']),
    false,
    'un export de factures ne doit pas être lu comme un relevé',
  );
  assert.equal(looksLikeStatement(['Nom', 'Email', 'Téléphone']), false);
});

/* ------------------------------------------------------------------ */
/* Rapprochement facture ↔ encaissement                                 */
/* ------------------------------------------------------------------ */

const facture = (over = {}) => ({
  kind: 'invoice',
  number: 'FAC00000669',
  date: '2026-01-10',
  totalTTC: 1250,
  status: 'confirmed',
  ...over,
});

test('montant exact + nom du client dans le libellé : rapprochement certain', () => {
  const tx = { date: '2026-01-20', label: 'VIR RECU AMBASSADE BRETONNE', amount: 1250 };
  const result = scoreDocumentMatch(tx, facture(), ['AMBASSADE BRETONNE']);
  assert.ok(result, 'la facture doit être un candidat');
  assert.ok(result.score >= ACCEPT_SCORE, `note trop faible : ${result.score}`);
  assert.ok(result.reasons.includes('montant exact'));
});

test('le numéro de facture cité dans le libellé suffit même sans le nom', () => {
  const tx = { date: '2026-01-22', label: 'VIREMENT FAC00000669', amount: 1250 };
  const result = scoreDocumentMatch(tx, facture(), []);
  assert.ok(result.score >= ACCEPT_SCORE);
  assert.ok(result.reasons.some((r) => r.includes('FAC00000669')));
});

test('un montant sans rapport et sans numéro n’est pas un candidat', () => {
  const tx = { date: '2026-01-20', label: 'VIR RECU AMBASSADE BRETONNE', amount: 42 };
  assert.equal(scoreDocumentMatch(tx, facture(), ['AMBASSADE BRETONNE']), null);
});

test('un encaissement antérieur à la facture est fortement pénalisé', () => {
  const avant = scoreDocumentMatch(
    { date: '2025-11-01', label: 'VIR AMBASSADE BRETONNE', amount: 1250 },
    facture(),
    ['AMBASSADE BRETONNE'],
  );
  const apres = scoreDocumentMatch(
    { date: '2026-01-20', label: 'VIR AMBASSADE BRETONNE', amount: 1250 },
    facture(),
    ['AMBASSADE BRETONNE'],
  );
  assert.ok(avant.score < apres.score, 'un paiement avant émission doit être moins bien noté');
  assert.ok(avant.score < ACCEPT_SCORE, 'et ne doit pas être rapproché automatiquement');
});

test('une facture annulée ou un devis ne sont jamais rapprochés', () => {
  const tx = { date: '2026-01-20', label: 'VIR AMBASSADE BRETONNE FAC00000669', amount: 1250 };
  assert.equal(scoreDocumentMatch(tx, facture({ status: 'cancelled' }), []), null);
  assert.equal(scoreDocumentMatch(tx, facture({ kind: 'quote' }), []), null);
});

test('un décaissement se rapproche d’un avoir, jamais d’une facture', () => {
  const tx = { date: '2026-01-20', label: 'VIR EMIS AMBASSADE BRETONNE', amount: -1250 };
  assert.equal(scoreDocumentMatch(tx, facture(), ['AMBASSADE BRETONNE']), null);
  const avoir = scoreDocumentMatch(tx, facture({ kind: 'credit' }), ['AMBASSADE BRETONNE']);
  assert.ok(avoir && avoir.score >= ACCEPT_SCORE);
});

test('deux factures du même montant se départagent par le nom du client', () => {
  const tx = { date: '2026-01-20', label: 'VIR RECU AGRILLADE', amount: 1250 };
  const bonne = scoreDocumentMatch(tx, facture({ number: 'FAC00000670' }), ['AGRILLADE']);
  const autre = scoreDocumentMatch(tx, facture(), ['AMBASSADE BRETONNE']);
  assert.ok(bonne.score > autre.score, 'le client cité doit l’emporter');
  assert.ok(bonne.score - autre.score >= 0.1, 'l’écart doit lever l’ambiguïté');
});

test('un écart de centimes reste rapprochable, un écart de 20 % non', () => {
  const centimes = scoreDocumentMatch(
    { date: '2026-01-20', label: 'VIR AMBASSADE BRETONNE', amount: 1249.99 },
    facture(),
    ['AMBASSADE BRETONNE'],
  );
  assert.ok(centimes.score >= ACCEPT_SCORE);
  assert.equal(
    scoreDocumentMatch(
      { date: '2026-01-20', label: 'VIR AMBASSADE BRETONNE', amount: 1000 },
      facture(),
      ['AMBASSADE BRETONNE'],
    ),
    null,
  );
});

test('fichier réel : séparateur point-virgule et accents Windows-1252', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-releve-'));
  const file = path.join(dir, 'releve.csv');
  const contenu = [
    'Date;Libellé;Débit;Crédit;Solde',
    '02/02/2026;VIREMENT REÇU AMICALE DES PLAISANCIERS;;620,00;6 040,10',
    '04/02/2026;PRÉLÈVEMENT URSSAF;842,15;;5 197,95',
  ].join('\r\n');
  fs.writeFileSync(file, Buffer.from(contenu, 'latin1'));

  try {
    const t = await readTable(file);
    const { transactions, warnings } = parseStatementTable(t);
    assert.equal(warnings.length, 0, JSON.stringify(warnings));
    assert.equal(transactions.length, 2);
    assert.match(transactions[0].label, /AMICALE DES PLAISANCIERS/);
    assert.equal(transactions[0].amount, 620);
    assert.equal(transactions[1].amount, -842.15);
    assert.equal(transactions[1].category, 'taxes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
