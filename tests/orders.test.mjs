import test from 'node:test';
import assert from 'node:assert/strict';
import { clientOrderHistory } from './build/services.mjs';

/**
 * « Qu'est-ce que j'avais pris la dernière fois ? »
 *
 * Ces vérifications tiennent la promesse faite au comptoir : la référence
 * exacte, la dernière quantité, le dernier prix — sans ouvrir une seule
 * facture.
 */

/** Fabrique une facture minimale, avec juste ce que la fonction regarde. */
function facture(number, date, lines, extra = {}) {
  return {
    id: `doc_${number}`,
    kind: 'invoice',
    number,
    date,
    clientId: 'cli_1',
    status: 'paid',
    lines,
    ...extra,
  };
}

function bon(number, date, items, extra = {}) {
  return {
    id: `bl_${number}`,
    number,
    date,
    clientId: 'cli_1',
    status: 'signed',
    items,
    ...extra,
  };
}

test('les articles se regroupent par référence, le plus récent en tête', () => {
  const documents = [
    facture('FA-2026-001', '2026-01-12', [
      { id: 'l1', ref: 'ART0042', label: 'Coupelle carton 100 ml', qty: 10, unitPriceHT: 4.2 },
      { id: 'l2', ref: 'ART0100', label: 'Cuillère bois 95 mm', qty: 5, unitPriceHT: 2.1 },
    ]),
    facture('FA-2026-014', '2026-03-04', [
      { id: 'l3', ref: 'ART0042', label: 'Coupelle carton 100 ml', qty: 6, unitPriceHT: 4.5 },
    ]),
  ];

  const { items, sourceCount, lastDate } = clientOrderHistory({ clientId: 'cli_1', documents });

  assert.equal(sourceCount, 2);
  assert.equal(lastDate, '2026-03-04');
  assert.equal(items.length, 2);

  const [premier, second] = items;
  assert.equal(premier.ref, 'ART0042');
  assert.equal(premier.orderCount, 2);
  assert.equal(premier.totalQty, 16);
  assert.equal(premier.lastDate, '2026-03-04');
  assert.equal(premier.lastQty, 6);
  // Le prix montré est celui de la dernière fois, pas le premier rencontré.
  assert.equal(premier.lastUnitPriceHT, 4.5);
  assert.equal(premier.lastSource, 'FA-2026-014');
  assert.equal(second.ref, 'ART0100');
});

test('devis, pièce annulée et avoir ne sont pas des commandes', () => {
  const ligne = [{ id: 'l', ref: 'ART0042', label: 'Coupelle', qty: 3 }];
  const documents = [
    facture('DE-2026-002', '2026-05-01', ligne, { kind: 'quote' }),
    facture('FA-2026-020', '2026-05-02', ligne, { status: 'cancelled' }),
    facture('AV-2026-003', '2026-05-03', ligne, { kind: 'credit' }),
  ];

  const { items, sourceCount } = clientOrderHistory({ clientId: 'cli_1', documents });
  assert.equal(sourceCount, 0);
  assert.deepEqual(items, []);
});

test('l’historique ne mélange pas deux clients', () => {
  const documents = [
    facture('FA-1', '2026-02-01', [{ id: 'a', ref: 'ART0042', label: 'Coupelle', qty: 2 }]),
    facture('FA-2', '2026-02-02', [{ id: 'b', ref: 'ART0900', label: 'Bac inox', qty: 1 }], {
      clientId: 'cli_2',
    }),
  ];

  const { items } = clientOrderHistory({ clientId: 'cli_1', documents });
  assert.equal(items.length, 1);
  assert.equal(items[0].ref, 'ART0042');
});

test('un bon de livraison non facturé compte comme une commande', () => {
  const documents = [
    facture('FA-2026-030', '2026-06-01', [
      { id: 'l', ref: 'ART0042', label: 'Coupelle carton', qty: 4 },
    ]),
  ];
  const deliveryNotes = [
    bon('BL-2026-0007', '2026-06-18', [
      { productId: 'prd_1', label: 'Coupelle carton', qty: 3, unitPrice: 4.6 },
    ]),
  ];
  const products = [{ id: 'prd_1', sku: 'ART0042', name: 'Coupelle carton', unit: 'carton' }];

  const { items, sourceCount } = clientOrderHistory({
    clientId: 'cli_1',
    documents,
    deliveryNotes,
    products,
  });

  assert.equal(sourceCount, 2);
  // La référence vient de la fiche produit : un bon n'en porte pas.
  assert.equal(items.length, 1, 'le bon rejoint la ligne de facture sous la même référence');
  assert.equal(items[0].ref, 'ART0042');
  assert.equal(items[0].totalQty, 7);
  assert.equal(items[0].lastSource, 'BL-2026-0007');
  assert.equal(items[0].lastFromDeliveryNote, true);
  assert.equal(items[0].unit, 'carton');
});

test('un bon déjà facturé n’est plus compté : sa facture le raconte', () => {
  const deliveryNotes = [
    bon('BL-2026-0008', '2026-06-20', [{ label: 'Coupelle carton', qty: 3 }], {
      status: 'invoiced',
      documentId: 'doc_FA-2026-040',
    }),
    bon('BL-2026-0009', '2026-06-21', [{ label: 'Coupelle carton', qty: 2 }], {
      // Rattaché à une facture sans que le statut ait suivi : le lien suffit.
      documentId: 'doc_FA-2026-041',
    }),
  ];

  const { items, sourceCount } = clientOrderHistory({
    clientId: 'cli_1',
    documents: [],
    deliveryNotes,
  });
  assert.equal(sourceCount, 0);
  assert.deepEqual(items, []);
});

test('sans référence, les libellés voisins se regroupent quand même', () => {
  const documents = [
    facture('FA-1', '2026-04-01', [{ id: 'a', label: 'Sirop  FRAISE', qty: 2 }]),
    facture('FA-2', '2026-04-08', [{ id: 'b', label: 'sirop fraise', qty: 3, unitPriceHT: 9.9 }]),
  ];

  const { items } = clientOrderHistory({ clientId: 'cli_1', documents });
  assert.equal(items.length, 1);
  assert.equal(items[0].totalQty, 5);
  // Le libellé retenu est celui de la dernière pièce, tel qu'il y est écrit.
  assert.equal(items[0].label, 'sirop fraise');
  assert.equal(items[0].lastUnitPriceHT, 9.9);
});

test('une ligne vide de libellé et de référence est ignorée', () => {
  const documents = [
    facture('FA-1', '2026-04-01', [
      { id: 'a', label: '   ', qty: 1 },
      { id: 'b', label: 'Bac inox 5 L', qty: 1 },
    ]),
  ];

  const { items } = clientOrderHistory({ clientId: 'cli_1', documents });
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Bac inox 5 L');
});

test('la limite garde les articles les plus récents', () => {
  const documents = [
    facture('FA-1', '2026-01-01', [{ id: 'a', ref: 'A', label: 'Vieux', qty: 1 }]),
    facture('FA-2', '2026-02-01', [{ id: 'b', ref: 'B', label: 'Moyen', qty: 1 }]),
    facture('FA-3', '2026-03-01', [{ id: 'c', ref: 'C', label: 'Récent', qty: 1 }]),
  ];

  const { items } = clientOrderHistory({ clientId: 'cli_1', documents, limit: 2 });
  assert.deepEqual(
    items.map((item) => item.ref),
    ['C', 'B'],
  );
});

test('une pièce plus ancienne n’écrase pas la dernière trace', () => {
  // Les pièces arrivent dans le désordre : c'est la date qui tranche, pas
  // l'ordre de lecture.
  const documents = [
    facture('FA-RECENTE', '2026-07-01', [
      { id: 'a', ref: 'ART1', label: 'Coupelle', qty: 4, unitPriceHT: 5 },
    ]),
    facture('FA-ANCIENNE', '2026-01-01', [
      { id: 'b', ref: 'ART1', label: 'Coupelle', qty: 9, unitPriceHT: 3 },
    ]),
  ];

  const { items } = clientOrderHistory({ clientId: 'cli_1', documents });
  assert.equal(items[0].lastSource, 'FA-RECENTE');
  assert.equal(items[0].lastQty, 4);
  assert.equal(items[0].lastUnitPriceHT, 5);
  assert.equal(items[0].totalQty, 13);
});

test('les récapitulatifs de TVA déjà enregistrés ne sont pas proposés', () => {
  // Les pièces lues avant que le lecteur n'apprenne à les reconnaître portent
  // encore ces lignes : l'historique ne les montre pas pour autant.
  const documents = [
    facture('FAC00000802', '2026-07-15', [
      { id: 'a', ref: 'CORNETSIMPLE', label: 'CORNETSIMPLE -CORNET SIMPLE', qty: 1, unitPriceHT: 52.3 },
      { id: 'b', label: 'Normale 144,00 € 20,00%', qty: 28.8 },
      { id: 'c', label: 'Réduite 104,60 € 5,50%', qty: 5.75 },
      { id: 'd', label: 'Réduite 450,88 € 5,50% 24,80 €', qty: 1, unit: 'Total TTC' },
    ]),
  ];

  const { items } = clientOrderHistory({ clientId: 'cli_1', documents });
  assert.equal(items.length, 1);
  assert.equal(items[0].ref, 'CORNETSIMPLE');
});

test('la référence n’est pas répétée dans le libellé', () => {
  // MEG imprime « CORNETSIMPLE » dans sa colonne et « CORNETSIMPLE -CORNET
  // SIMPLE » dans le libellé : affiché tel quel, l'écran dit deux fois la
  // même chose.
  const documents = [
    facture('FA-1', '2026-05-01', [
      { id: 'a', ref: 'CORNETSIMPLE', label: 'CORNETSIMPLE -CORNET SIMPLE X100', qty: 1 },
      // Une référence qui préfixe le libellé sans séparateur ne se coupe pas :
      // « REM » ne doit pas amputer « REMISE ».
      { id: 'b', ref: 'REM', label: 'REMISE FIN D’ANNÉE', qty: 1 },
    ]),
  ];

  const { items } = clientOrderHistory({ clientId: 'cli_1', documents });
  const cornet = items.find((i) => i.ref === 'CORNETSIMPLE');
  const remise = items.find((i) => i.ref === 'REM');
  assert.equal(cornet.label, 'CORNET SIMPLE X100');
  assert.equal(remise.label, 'REMISE FIN D’ANNÉE');
});
