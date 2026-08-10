import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataStore,
  ingestParsedDocument,
  detectKindDetailed,
  detectDraft,
  extractNumber,
  extractTotals,
  extractDates,
  extractClient,
  sniffDelimiter,
  alreadySent,
  markSent,
  forgetVanished,
  applyDocumentToStock,
  initFolders,
  saveFolder,
  removeFolder,
  matchClient,
  looksLikeClientName,
  forgetLearnedAliases,
} from './build/services.mjs';

/**
 * Régressions de la relecture croisée du 10/08 : trois agents indépendants ont
 * relu la chaîne d'import (lecture, ingestion, transport), un quatrième a
 * contre-vérifié chaque constat — 24 confirmés. Chaque test ci-dessous fige un
 * de ces constats pour qu'il ne revienne pas. Les identifiants (A2, B1, C5…)
 * renvoient au rapport de vérification.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-audit-'));

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

function piece(number, patch = {}) {
  return {
    kind: 'invoice',
    kindSure: true,
    draft: false,
    number,
    date: '2026-07-01',
    dueDate: null,
    clientName: null,
    clientAddress: null,
    clientSiret: null,
    clientEmail: null,
    clientPhone: null,
    clientContact: null,
    currency: 'EUR',
    totalHT: 100,
    totalVAT: 20,
    totalTTC: 120,
    lines: [],
    confidence: 1,
    warnings: [],
    ...patch,
  };
}

/* ------------------------------------------------------------------ */
/* Lecture (rapport A)                                                  */
/* ------------------------------------------------------------------ */

test('A1 : une facture d’acompte qui cite son devis reste une facture', () => {
  const r = detectKindDetailed(
    'FACTURE\nN° : FAC00000816\nAcompte de 50,00 % suivant devis N° DEV00000594',
    'FAC00000816.pdf',
  );
  assert.deepEqual(r, { kind: 'invoice', sure: true });
});

test('A7 : une rectificative écrite « après avoir n° … » reste une facture', () => {
  const r = detectKindDetailed(
    'FACTURE RECTIFICATIVE\nAnnule et remplace la facture FAC00000816 après avoir n° AV-2026-0007',
  );
  assert.equal(r.kind, 'invoice');
});

test('A1 bis : un avoir et un devis restent reconnus par leur titre', () => {
  assert.equal(detectKindDetailed('AVOIR\nSur facture FAC-123').kind, 'credit');
  assert.equal(detectKindDetailed('DEVIS\nFacture pro forma à venir').kind, 'quote');
});

test('A2 : « NET À PAYER 0,00 € » n’écrase pas le Total TTC', () => {
  const t = extractTotals([
    'Total HT 1 022,40 €',
    'TVA 20,00 % 204,48 €',
    'Total TTC 1 226,88 €',
    'Acompte versé 613,44 €',
    'NET À PAYER 0,00 €',
  ]);
  assert.equal(t.totalTTC, 1226.88);
  assert.equal(t.totalVAT, 204.48);
});

test('A2 bis : sans Total TTC, un net à payer incohérent ne fabrique pas une TVA négative', () => {
  const t = extractTotals(['Total HT 1 022,40 €', 'TVA 20,00 % 204,48 €', 'NET À PAYER 0,00 €']);
  assert.ok(t.totalVAT === null || t.totalVAT >= 0, `TVA négative : ${t.totalVAT}`);
  assert.notEqual(t.totalTTC, 0);
});

test('A6 : « TVA non applicable, art. 293 B » vaut zéro, pas 293 €', () => {
  const t = extractTotals(['Total HT 850,00 €', 'TVA non applicable, art. 293 B du CGI']);
  assert.equal(t.totalVAT, 0);
  assert.equal(t.totalTTC, 850);
});

test('A3 : « N° client : » ne fournit jamais le numéro de la pièce', () => {
  const n = extractNumber('Siret : 00000000000000  N° client : CLT00000127\nN° : FAC00000816');
  assert.equal(n.value, 'FAC00000816');
});

test('A3 bis : un « numéro » sans chiffre n’en est pas un', () => {
  const n = extractNumber('Réf. : PROPOSITION COMMERCIALE MACHINE GLACE', 'DEV00000613.pdf');
  assert.ok(/\d/.test(n.value), `numéro sans chiffre : ${n.value}`);
});

test('A4 : un fichier BRO est un brouillon même si son numéro est mal lu', () => {
  assert.equal(detectDraft('FACTURE', 'BRO00001044.pdf', '00001044'), true);
  assert.equal(detectDraft('FACTURE', 'FAC00000816.pdf', 'FAC00000816'), false);
});

test('A5 : le SIRET du vendeur répété en pied de page n’est pas celui du client', () => {
  const { siret } = extractClient([
    'Client : LE COMPTOIR',
    'Siret : 00000000000000',
    '— page 2 —',
    'Siret : 00000000000000',
  ]);
  assert.equal(siret, null);
});

test('A5 bis : un second SIRET distinct reste attribué au client', () => {
  const { siret } = extractClient([
    'Client : LE COMPTOIR',
    'Siret : 00000000000000',
    'Siret : 81234567800019',
  ]);
  assert.equal(siret, '81234567800019');
});

test('A8 : sur une ligne fusionnée, l’échéance se lit après son mot-clé', () => {
  const d = extractDates(['Date : 22/03/2026    Échéance : 21/04/2026']);
  assert.equal(d.date, '2026-03-22');
  assert.equal(d.dueDate, '2026-04-21');
});

test('A8 bis : « Date d’échéance » seule ne date pas la pièce', () => {
  const d = extractDates(["Date d'échéance : 21/04/2026", 'Date : 22/03/2026']);
  assert.equal(d.date, '2026-03-22');
  assert.equal(d.dueDate, '2026-04-21');
});

test('A9 : la date de validité d’un devis n’est pas sa date d’émission', () => {
  const d = extractDates([
    'DEVIS N° DEV00000622',
    "Devis valable jusqu'au 29/08/2026",
    'Émis à Guérande, le 10/07/2026',
  ]);
  assert.equal(d.date, '2026-07-10');
});

test('A10 : une ligne de titre sans séparateur ne fait pas choisir la virgule', () => {
  const csv =
    'Relevé des factures clients\nDate;Numéro;Client;Total TTC\n14/03/2026;FA-2026-0142;LE COMPTOIR;382,80\n22/03/2026;FA-2026-0143;LA DUNE;172,44';
  assert.equal(sniffDelimiter(csv), ';');
});

/* ------------------------------------------------------------------ */
/* Ingestion (rapport B)                                                */
/* ------------------------------------------------------------------ */

test('B1 : un journal de trois pièces donne trois pièces, pas une', () => {
  for (const n of ['FAC-100', 'FAC-101', 'FAC-102']) {
    ingestParsedDocument(piece(n), {
      sourceFormat: 'csv',
      filePath: '/srv/Factures/journal.csv',
      sourceHash: 'hJournal',
      multiPiece: true,
    });
  }
  const found = dataStore.db.documents.filter((d) => /^FAC-10[012]$/.test(d.number));
  assert.equal(found.length, 3, `pièces écrasées : ${found.map((d) => d.number).join(', ')}`);
});

test('B2 : un nom de fichier réutilisé ne détourne pas la pièce précédente', () => {
  const juillet = ingestParsedDocument(piece('FAC-2026-071', { totalHT: 450 }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/scan.pdf',
    sourceHash: 'hJuillet',
  });
  const aout = ingestParsedDocument(piece('FAC-2026-082', { totalHT: 980 }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/scan.pdf',
    sourceHash: 'hAout',
  });
  assert.notEqual(juillet.id, aout.id, 'la facture de juillet a été écrasée');
  assert.ok(dataStore.db.documents.some((d) => d.number === 'FAC-2026-071'));
  assert.ok(dataStore.db.documents.some((d) => d.number === 'FAC-2026-082'));
});

test('B3 : un devis et une facture partageant un numéro restent deux pièces', () => {
  const devis = ingestParsedDocument(piece('2026-100', { kind: 'quote' }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Devis/devis-2026-100.pdf',
    sourceHash: 'hDevis100',
  });
  const facture = ingestParsedDocument(piece('2026-100', { kind: 'invoice' }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/facture-2026-100.pdf',
    sourceHash: 'hFacture100',
  });
  assert.notEqual(devis.id, facture.id, 'le devis a été absorbé par sa facture');
  assert.equal(dataStore.db.documents.filter((d) => d.number === '2026-100').length, 2);
});

test('B4 : la résorption garde la jumelle qui porte le travail de l’utilisateur', () => {
  const ancienne = ingestParsedDocument(piece('DEV-777', { kind: 'invoice' }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/DEV-777.pdf',
    sourceHash: 'h777',
  });
  // La jumelle récente est celle que l'utilisateur a annotée : statut payé
  // choisi à la main, note. C'est ELLE qui doit survivre.
  dataStore.mutate((db) => {
    db.documents.unshift({
      ...ancienne,
      id: 'doc_travaillée',
      kind: 'quote',
      status: 'paid',
      notes: 'acompte reçu en espèces',
      manualFields: ['status'],
      sourceFile: 'Devis/DEV-777.pdf',
      importedAt: '2026-08-11T10:00:00.000Z',
    });
  });
  const relu = ingestParsedDocument(piece('DEV-777', { kind: 'quote', kindSure: true }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Devis/DEV-777.pdf',
    sourceHash: 'h777',
  });
  assert.equal(relu.id, 'doc_travaillée', 'la jumelle annotée a été détruite');
  assert.equal(relu.status, 'paid');
  assert.equal(relu.notes, 'acompte reçu en espèces');
  assert.ok(
    relu.warnings.some((w) => /résorbé/.test(w)),
    'la fusion doit laisser une trace',
  );
});

test('B5 : corriger le type après la déduction rend d’abord le stock', () => {
  dataStore.mutate((db) => {
    db.products.push({
      id: 'prd_bac',
      type: 'consumable',
      ref: 'BAC-5L',
      name: 'Bac inox 5 L',
      unit: 'pièce',
      qtyOnHand: 20,
      minQty: 0,
      archived: false,
      aliases: [],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
  });
  const facture = ingestParsedDocument(
    piece('AV-2026-09', {
      kind: 'invoice',
      lines: [{ label: 'Bac inox 5 L', qty: 4, ref: 'BAC-5L' }],
    }),
    { sourceFormat: 'pdf', filePath: '/srv/Factures/AV-2026-09.pdf', sourceHash: 'hAvoir' },
  );
  // Le stock sort selon le type « facture ». Le magasin recalcule la quantité
  // comme somme des mouvements : on raisonne donc en écarts, pas en absolu.
  applyDocumentToStock(facture.id);
  const sorti = dataStore.db.products.find((p) => p.id === 'prd_bac').qtyOnHand;
  // ... puis la pièce se révèle être un avoir : la sortie doit être rendue.
  const relu = ingestParsedDocument(
    piece('AV-2026-09', {
      kind: 'credit',
      lines: [{ label: 'Bac inox 5 L', qty: 4, ref: 'BAC-5L' }],
    }),
    { sourceFormat: 'pdf', filePath: '/srv/Factures/AV-2026-09.pdf', sourceHash: 'hAvoir' },
  );
  assert.equal(relu.kind, 'credit');
  assert.equal(relu.stockApplied, false, 'la déduction de l’ancien type devait être annulée');
  const rendu = dataStore.db.products.find((p) => p.id === 'prd_bac').qtyOnHand;
  assert.equal(rendu, sorti + 4, 'le mouvement de l’ancien type pèse encore sur le stock');
  assert.ok(
    !dataStore.db.stockMoves.some((m) => m.documentId === relu.id),
    'un mouvement de l’ancien type est resté attaché à la pièce',
  );
  assert.ok(relu.warnings.some((w) => /Type corrigé/.test(w)));
});

test('B6 : renommer une fiche puis relire ne crée pas de doublon client', () => {
  dataStore.mutate((db) => {
    db.clients.push({
      id: 'cli_ajoncs',
      code: 'C10',
      name: 'Camping Les Ajoncs',
      address: {},
      tags: [],
      aliases: [],
      archived: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
  });
  const doc = ingestParsedDocument(piece('FAC-AJONCS', { clientName: 'Camping Les Ajoncs' }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/FAC-AJONCS.pdf',
    sourceHash: 'hAjoncs',
  });
  assert.equal(doc.clientId, 'cli_ajoncs');
  // L'utilisateur renomme la fiche...
  dataStore.mutate((db) => {
    db.clients.find((c) => c.id === 'cli_ajoncs').name = 'SARL Vacances Océanes';
  });
  const avant = dataStore.db.clients.length;
  const relu = ingestParsedDocument(piece('FAC-AJONCS', { clientName: 'Camping Les Ajoncs' }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/FAC-AJONCS.pdf',
    sourceHash: 'hAjoncs',
  });
  assert.equal(relu.clientId, 'cli_ajoncs', 'la pièce a été détachée de sa fiche renommée');
  assert.equal(dataStore.db.clients.length, avant, 'une fiche doublon a été créée');
});

/* ------------------------------------------------------------------ */
/* Transport (rapport C)                                                */
/* ------------------------------------------------------------------ */

test('C5 : retirer un dossier surveillé oublie ses marques d’envoi', () => {
  const posteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-poste-'));
  const watched = path.join(posteDir, 'MesDevis');
  fs.mkdirSync(watched);
  const file = path.join(watched, 'DE-1.pdf');
  fs.writeFileSync(file, 'contenu');
  try {
    initFolders(posteDir);
    const folder = saveFolder({ path: watched, kind: 'invoice' });
    const stat = fs.statSync(file);
    markSent(file, stat.size, stat.mtimeMs);
    assert.equal(alreadySent(file, stat.size, stat.mtimeMs), true);
    removeFolder(folder.id);
    // Ré-ajout avec la bonne étiquette : tout doit repartir.
    saveFolder({ path: watched, kind: 'quote' });
    assert.equal(
      alreadySent(file, stat.size, stat.mtimeMs),
      false,
      'les marques du dossier retiré bloquent encore le renvoi',
    );
  } finally {
    fs.rmSync(posteDir, { recursive: true, force: true });
  }
});

test('C6 : un chemin avec majuscules survit au ménage sur un disque sensible à la casse', () => {
  const posteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-casse-'));
  const watched = path.join(posteDir, 'Factures');
  fs.mkdirSync(watched);
  const file = path.join(watched, 'FA-2026-0142.PDF');
  fs.writeFileSync(file, 'contenu');
  try {
    initFolders(posteDir);
    saveFolder({ path: watched, kind: 'invoice' });
    const stat = fs.statSync(file);
    markSent(file, stat.size, stat.mtimeMs);
    forgetVanished();
    assert.equal(
      alreadySent(file, stat.size, stat.mtimeMs),
      true,
      'la marque d’un fichier existant a été purgée — il repartirait en boucle',
    );
  } finally {
    fs.rmSync(posteDir, { recursive: true, force: true });
  }
});


/* ------------------------------------------------------------------ */
/* Rattachements figés (cas réel du 10/08)                              */
/* ------------------------------------------------------------------ */

test('un mauvais client ne survit pas à une lecture qui dit autre chose', () => {
  // Cas vécu : des devis rattachés à « Rondeau Vincent » par un lecteur
  // défaillant. Le lecteur corrigé lit « Madame NATHALIE GARDY », qui ne
  // correspond à aucune fiche — le repli « garder le lien précédent » figeait
  // alors l'erreur, relecture forcée comprise.
  dataStore.mutate((db) => {
    db.clients.push({
      id: 'cli_rondeau',
      code: 'C99',
      name: 'Rondeau Vincent',
      address: {},
      tags: [],
      aliases: [],
      archived: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
  });
  const doc = ingestParsedDocument(
    piece('DEV-GARDY', { kind: 'quote', clientName: "FRANCE Devis valable jusqu'au 09/09/2026" }),
    { sourceFormat: 'pdf', filePath: '/srv/Devis/DEV-GARDY.pdf', sourceHash: 'hGardy' },
  );
  dataStore.mutate(() => {
    doc.clientId = 'cli_rondeau';
  });

  const relu = ingestParsedDocument(
    piece('DEV-GARDY', { kind: 'quote', clientName: 'Madame NATHALIE GARDY' }),
    { sourceFormat: 'pdf', filePath: '/srv/Devis/DEV-GARDY.pdf', sourceHash: 'hGardy' },
  );
  assert.notEqual(relu.clientId, 'cli_rondeau', 'le mauvais rattachement a survécu');
  const client = dataStore.db.clients.find((c) => c.id === relu.clientId);
  assert.match(client.name, /GARDY/i);
});

test('une fiche renommée garde ses pièces : le nom lu, lui, n’a pas changé', () => {
  // Le pendant du test précédent : ici la lecture est IDENTIQUE, seule la
  // fiche a été renommée. Le lien doit tenir, sans fabriquer de doublon.
  dataStore.mutate((db) => {
    db.clients.push({
      id: 'cli_dune',
      code: 'C98',
      name: 'Restaurant La Dune',
      address: {},
      tags: [],
      aliases: [],
      archived: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
  });
  const doc = ingestParsedDocument(piece('FAC-DUNE', { clientName: 'Restaurant La Dune' }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/FAC-DUNE.pdf',
    sourceHash: 'hDune',
  });
  assert.equal(doc.clientId, 'cli_dune');
  dataStore.mutate((db) => {
    db.clients.find((c) => c.id === 'cli_dune').name = 'SAS Océane Restauration';
  });
  const avant = dataStore.db.clients.length;
  const relu = ingestParsedDocument(piece('FAC-DUNE', { clientName: 'Restaurant La Dune' }), {
    sourceFormat: 'pdf',
    filePath: '/srv/Factures/FAC-DUNE.pdf',
    sourceHash: 'hDune',
  });
  assert.equal(relu.clientId, 'cli_dune');
  assert.equal(dataStore.db.clients.length, avant, 'une fiche doublon a été créée');
});

test('un alias portant le nom d’une autre fiche n’attire plus les pièces', () => {
  // La fiche « Rondeau Vincent » a hérité, mois après mois, des noms de tous
  // les clients qu'un rapprochement automatique lui avait attribués par
  // erreur. Ces alias ressemblent à de vrais noms — ils le sont : ce sont ceux
  // des AUTRES fiches.
  const pollue = {
    id: 'cli_p',
    name: 'Rondeau Vincent',
    aliases: ['Madame HYACINTHE GNAWA'],
    archived: false,
  };
  const vraie = { id: 'cli_v', name: 'Madame HYACINTHE GNAWA', aliases: [], archived: false };
  const match = matchClient([pollue, vraie], 'Madame HYACINTHE GNAWA');
  assert.equal(match?.client.id, 'cli_v', 'l’alias parasite gagne encore');
});

/* ------------------------------------------------------------------ */
/* Les quatre gabarits réels d'EURL O'GELATO                            */
/* ------------------------------------------------------------------ */

/**
 * Tous impriment le pavé vendeur à gauche et le client à droite, fusionnés
 * ligne à ligne. La ligne « FRANCE » du vendeur se retrouve donc collée au
 * champ que le logiciel imprime en face — et se présentait comme un nom de
 * client. Énumérer ces mentions une par une était sans fin : « valable
 * jusqu'au » était couvert, « Date de livraison » et « N° TVA » ne l'étaient
 * pas. C'est la forme qui est reconnue désormais.
 */
const GABARITS = {
  'bon de livraison': {
    lignes: [
      'BON DE LIVRAISON',
      "EURL O'GELATO                    N° : BDL00000308",
      "27 RUE JACQUES DAGUERRE          Date d'émission : 03/07/2026",
      '44600 - ST NAZAIRE CEDEX 4460    N° client : CL0280',
      'FRANCE                           Date de livraison : 03/07/2026',
      'Siret : 80184990200011',
      "L'ERE GLACIERE ***",
      'Tél. : 09 54 93 49 90            Fabrice ABRARD',
      'Port. : 06 98 72 20 40           7 Rue des Ajoncs',
      'Email : contact@ogelato.fr       56410 Erdeven',
      'FRANCE',
      'Tel 1 : 02 90 74 41 13',
    ],
    nom: "L'ERE GLACIERE ***",
    contact: 'Fabrice ABRARD',
  },
  "facture d'acompte": {
    lignes: [
      "FACTURE D'ACOMPTE",
      "EURL O'GELATO                    N° : FAC00000755",
      '44600 - ST NAZAIRE CEDEX 4460    En référence : DEV00000411',
      'FRANCE                           N° TVA : NC',
      'Siret : 80184990200011           N° client : CLT00000194',
      'Tél. : 09 54 93 49 90            AB Airlines',
      'Port. : 06 98 72 20 40           FRÉDÉRIC LE TROADEC',
      'Email : contact@ogelato.fr       5 PLACE DE LA LIBERTÉ',
      'Monsieur Hervé GUEGUEN - GERANT  29200 BREST',
      'FRANCE',
    ],
    nom: 'AB Airlines',
    contact: 'FRÉDÉRIC LE TROADEC',
  },
  'devis (client nommé)': {
    lignes: [
      'DEVIS',
      "EURL O'GELATO                    N° : DEV00000614",
      '44600 - ST NAZAIRE CEDEX 4460    N° client : CLT00000362',
      "FRANCE                           Devis valable jusqu'au 29/08/2026",
      'Siret : 80184990200011',
      'Monsieur COLINE DIAS',
      'Tél. : 09 54 93 49 90            HALLE MARTENOT',
      'Port. : 06 98 72 20 40           PLACE DES LICES',
      'Email : contact@ogelato.fr       35000 RENNES',
      'FRANCE',
    ],
    nom: 'Monsieur COLINE DIAS',
    contact: null,
  },
};

for (const [gabarit, attendu] of Object.entries(GABARITS)) {
  test(`gabarit « ${gabarit} » : le client lu est celui du document`, () => {
    const { name, contact } = extractClient(attendu.lignes);
    assert.equal(name, attendu.nom);
    if (attendu.contact) assert.equal(contact, attendu.contact);
  });
}

test('une mention du document collée au pays du vendeur n’est pas un nom', () => {
  // La forme, pas la liste : un intitulé suivi de deux-points, ou une date sur
  // la ligne. C'est ce qui a fait attribuer des centaines de pièces au même
  // client — le nom lu, identique d'une pièce à l'autre, était mémorisé comme
  // alias et attirait ensuite tout le reste.
  for (const mention of [
    'FRANCE Date de livraison : 03/07/2026',
    'FRANCE N° TVA : NC',
    "FRANCE Devis valable jusqu'au 29/08/2026",
    'FRANCE En référence : DEV00000411',
    "FRANCE Date d'émission : 03/07/2026",
    'FRANCE N° client : CL0280',
  ]) {
    assert.equal(looksLikeClientName(mention), false, `accepté à tort : ${mention}`);
  }
});

test('les vrais noms de clients passent toujours', () => {
  for (const nom of [
    "L'ERE GLACIERE ***",
    'AB Airlines',
    'Monsieur COLINE DIAS',
    'Madame NATHALIE GARDY',
    'SAS LE CAP Brasserie 1930',
    'ACCOORD - Centre socioculturel',
    'EARL De Le Pierre de Py',
    'FRANCE BOISSONS',
  ]) {
    assert.equal(looksLikeClientName(nom), true, `rejeté à tort : ${nom}`);
  }
});

test('oublier les orthographes apprises libère les pièces mal rattachées', () => {
  // Le puits empoisonné : un nom pourtant lu correctement repartait vers la
  // mauvaise fiche parce que cette chaîne dormait dans ses orthographes, avec
  // un score de 0,97. Le garde-fou « alias qui nomme une AUTRE fiche » ne le
  // rattrape pas quand le vrai client n'a, lui, aucune fiche.
  dataStore.mutate((db) => {
    db.clients.length = 0;
    db.clients.push({
      id: 'cli_puits',
      code: 'C1',
      name: 'Rondeau Vincent',
      address: {},
      tags: [],
      aliases: ['Monsieur LOIC GASNIER', "L'École des Chefs"],
      archived: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
  });
  const avant = matchClient(dataStore.db.clients, 'Monsieur LOIC GASNIER');
  assert.equal(avant?.client.id, 'cli_puits', 'préparation : l’alias doit encore capter');

  const { clients, aliases } = forgetLearnedAliases();
  assert.equal(clients, 1);
  assert.equal(aliases, 2);

  const apres = matchClient(dataStore.db.clients, 'Monsieur LOIC GASNIER');
  assert.equal(apres, null, 'la fiche capte encore après l’oubli');
  // Les fiches elles-mêmes sont intactes.
  assert.equal(dataStore.db.clients.length, 1);
  assert.equal(dataStore.db.clients[0].name, 'Rondeau Vincent');
});
