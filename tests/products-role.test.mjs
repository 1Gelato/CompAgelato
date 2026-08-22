import test from 'node:test';
import assert from 'node:assert/strict';
import { productForRole, productsForRole } from './build/services.mjs';

/**
 * Ce qu'un rôle voit d'un article.
 *
 * Le livreur a besoin du catalogue — c'est lui qui nourrit les suggestions
 * quand il établit un bon devant le client. Il n'a aucune raison de connaître
 * le prix d'achat : deux champs suffiraient à lui donner la marge de
 * l'entreprise.
 */

/** Un article complet, tel que le bureau le connaît. */
function article(extra = {}) {
  return {
    id: 'prd_1',
    sku: 'VANILLE5',
    name: 'Bac vanille 5 L',
    type: 'consumable',
    unit: 'bac',
    qtyOnHand: 12,
    minQty: 2,
    unitCost: 7.4,
    salePrice: 18.9,
    vatRate: 5.5,
    supplier: 'Fournisseur du Nord',
    aliases: [],
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

test('le livreur perd le prix d’achat et le fournisseur', () => {
  const vu = productForRole(article(), 'livreur');
  assert.equal(vu.unitCost, undefined);
  assert.equal(vu.supplier, undefined);
});

test('le livreur garde de quoi établir un bon et répondre au client', () => {
  const vu = productForRole(article(), 'livreur');
  assert.equal(vu.name, 'Bac vanille 5 L');
  assert.equal(vu.sku, 'VANILLE5');
  assert.equal(vu.unit, 'bac');
  assert.equal(vu.salePrice, 18.9);
  assert.equal(vu.vatRate, 5.5);
  assert.equal(vu.qtyOnHand, 12);
});

test('le bureau et le gérant voient l’article entier', () => {
  for (const role of ['gerant', 'bureau']) {
    const vu = productForRole(article(), role);
    assert.equal(vu.unitCost, 7.4, `${role} devrait voir le prix d’achat`);
    assert.equal(vu.supplier, 'Fournisseur du Nord', `${role} devrait voir le fournisseur`);
  }
});

test('l’article d’origine n’est jamais modifié', () => {
  // Le filtre sert une réponse : il ne doit pas amputer la base au passage.
  const source = article();
  productForRole(source, 'livreur');
  assert.equal(source.unitCost, 7.4);
  assert.equal(source.supplier, 'Fournisseur du Nord');
});

test('la même règle s’applique à une liste entière', () => {
  const liste = [article(), article({ id: 'prd_2', sku: 'CHOCO5', name: 'Bac chocolat 5 L' })];
  const vue = productsForRole(liste, 'livreur');
  assert.equal(vue.length, 2);
  for (const vu of vue) {
    assert.equal(vu.unitCost, undefined);
    assert.equal(vu.supplier, undefined);
  }
  // Et pour le bureau, la liste passe telle quelle.
  assert.equal(productsForRole(liste, 'bureau')[0].unitCost, 7.4);
});

test('un article sans prix d’achat traverse le filtre sans dommage', () => {
  const vu = productForRole(article({ unitCost: undefined, supplier: undefined }), 'livreur');
  assert.equal(vu.name, 'Bac vanille 5 L');
  assert.equal(vu.unitCost, undefined);
});
