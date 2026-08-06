import type {
  AccountingDocument,
  ID,
  Product,
  StockApplyReport,
  StockMove,
} from '@shared/types';
import { newId, nowIso, store, today } from '../store';
import { invoiceQtyToStockUnits } from './packaging';
import { normalize, round2, similarity } from './text';

export interface ProductSuggestion {
  product: Product;
  score: number;
  reason: string;
}

const FUZZY_ACCEPT = 0.68;

/* ------------------------------------------------------------------ */
/* Rapprochement ligne de facture ↔ produit du stock                    */
/* ------------------------------------------------------------------ */

/**
 * Cherche le produit correspondant à une ligne de document.
 * Ordre de priorité : référence exacte, alias enregistré, référence contenue
 * dans le libellé, puis ressemblance du libellé.
 */
export function matchProduct(
  products: Product[],
  label: string,
  ref?: string,
): { product: Product; score: number; method: 'sku' | 'alias' | 'fuzzy' } | null {
  const active = products.filter((p) => !p.archived);
  if (!active.length) return null;

  const nRef = ref ? normalize(ref) : '';
  const nLabel = normalize(label);

  if (nRef) {
    const exact = active.find((p) => normalize(p.sku) === nRef);
    if (exact) return { product: exact, score: 1, method: 'sku' };
  }

  // Alias : libellés déjà rencontrés et validés pour ce produit.
  for (const p of active) {
    for (const alias of p.aliases) {
      const nAlias = normalize(alias);
      if (!nAlias) continue;
      if (nAlias === nLabel || (nRef && nAlias === nRef)) {
        return { product: p, score: 0.98, method: 'alias' };
      }
    }
  }

  // La référence produit apparaît parfois au début du libellé.
  for (const p of active) {
    const nSku = normalize(p.sku);
    if (nSku.length >= 3 && nLabel.includes(nSku)) {
      return { product: p, score: 0.9, method: 'sku' };
    }
  }

  let best: { product: Product; score: number } | null = null;
  for (const p of active) {
    let score = similarity(p.name, label);
    for (const alias of p.aliases) score = Math.max(score, similarity(alias, label));
    if (!best || score > best.score) best = { product: p, score };
  }
  if (best && best.score >= FUZZY_ACCEPT) {
    return { product: best.product, score: round2(best.score), method: 'fuzzy' };
  }
  return null;
}

/** Propositions classées, pour l'association manuelle dans l'interface. */
export function suggestProducts(products: Product[], label: string, ref?: string, limit = 6): ProductSuggestion[] {
  const nRef = ref ? normalize(ref) : '';
  return products
    .filter((p) => !p.archived)
    .map((p) => {
      const bySku = nRef && normalize(p.sku) === nRef ? 1 : 0;
      const byAlias = Math.max(0, ...p.aliases.map((a) => similarity(a, label)));
      const byName = similarity(p.name, label);
      const score = Math.max(bySku, byAlias, byName);
      const reason = bySku
        ? 'Référence identique'
        : byAlias >= byName
          ? 'Libellé déjà associé'
          : 'Désignation proche';
      return { product: p, score: round2(score), reason };
    })
    .filter((s) => s.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Renseigne `productId` sur les lignes d'un document qui n'en ont pas encore. */
export function resolveDocumentLines(doc: AccountingDocument): AccountingDocument {
  const products = store.db.products;
  for (const line of doc.lines) {
    if (line.matchMethod === 'manual') continue;
    const match = matchProduct(products, line.label, line.ref);
    if (match) {
      line.productId = match.product.id;
      line.matchMethod = match.method;
      line.matchScore = match.score;
    } else {
      line.productId = undefined;
      line.matchMethod = 'none';
      line.matchScore = 0;
    }
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* Mouvements de stock                                                  */
/* ------------------------------------------------------------------ */

function recordMove(
  product: Product,
  qty: number,
  type: StockMove['type'],
  opts: { documentId?: ID; documentNumber?: string; note?: string; date?: string } = {},
): StockMove {
  product.qtyOnHand = round2(product.qtyOnHand + qty);
  product.updatedAt = nowIso();
  const move: StockMove = {
    id: newId('mv'),
    productId: product.id,
    qty: round2(qty),
    type,
    date: opts.date ?? today(),
    documentId: opts.documentId,
    documentNumber: opts.documentNumber,
    note: opts.note,
    balanceAfter: product.qtyOnHand,
    createdAt: nowIso(),
  };
  store.db.stockMoves.unshift(move);
  return move;
}

/**
 * Déduit du stock les quantités facturées.
 * Une facture sort du stock, un avoir le réintègre. L'opération est idempotente :
 * un document déjà appliqué n'est pas décrémenté deux fois.
 */
export function applyDocumentToStock(documentId: ID): StockApplyReport {
  const doc = store.db.documents.find((d) => d.id === documentId);
  if (!doc) throw new Error('Document introuvable.');

  if (doc.stockApplied) {
    return {
      documentId,
      applied: 0,
      unmatched: [],
      moves: [],
      message: 'Stock déjà déduit pour ce document.',
    };
  }
  if (doc.kind === 'quote') {
    return {
      documentId,
      applied: 0,
      unmatched: [],
      moves: [],
      message: "Un devis n'impacte pas le stock (aucune sortie tant qu'il n'est pas facturé).",
    };
  }

  // Un avoir remet la marchandise en stock.
  const direction = doc.kind === 'credit' ? 1 : -1;
  const moves: StockMove[] = [];
  const unmatched: StockApplyReport['unmatched'] = [];

  store.mutate(() => {
    for (const line of doc.lines) {
      const invoiced = Number(line.qty) || 0;
      if (invoiced <= 0) continue;
      const product = line.productId ? store.db.products.find((p) => p.id === line.productId) : undefined;
      if (!product) {
        unmatched.push({ lineId: line.id, label: line.label, qty: invoiced });
        continue;
      }
      // La facture ne compte pas toujours en unités de stock : 12,5 kg de mix
      // poudre, ce sont 5 poches de 2,5 kg, pas 12,5.
      const qty = round2(invoiceQtyToStockUnits(product, invoiced));
      if (qty <= 0) continue;
      moves.push(
        recordMove(product, direction * qty, direction < 0 ? 'out' : 'in', {
          documentId: doc.id,
          documentNumber: doc.number,
          note: `${doc.kind === 'credit' ? 'Avoir' : 'Facture'} ${doc.number}`,
          date: doc.date,
        }),
      );
    }
    if (moves.length) {
      doc.stockApplied = true;
      doc.stockAppliedAt = nowIso();
    }
    doc.updatedAt = nowIso();
  });

  const message = moves.length
    ? `${moves.length} ligne(s) déduite(s) du stock${unmatched.length ? `, ${unmatched.length} non associée(s)` : ''}.`
    : 'Aucune ligne associée à un produit du stock.';

  return { documentId, applied: moves.length, unmatched, moves, message };
}

/** Annule la déduction de stock d'un document (mouvements inverses). */
export function revertDocumentFromStock(documentId: ID): StockApplyReport {
  const doc = store.db.documents.find((d) => d.id === documentId);
  if (!doc) throw new Error('Document introuvable.');
  if (!doc.stockApplied) {
    return { documentId, applied: 0, unmatched: [], moves: [], message: 'Ce document n’a pas impacté le stock.' };
  }

  const related = store.db.stockMoves.filter((m) => m.documentId === documentId);
  const moves: StockMove[] = [];

  store.mutate(() => {
    for (const move of related) {
      const product = store.db.products.find((p) => p.id === move.productId);
      if (!product) continue;
      moves.push(
        recordMove(product, -move.qty, 'adjust', {
          documentId: doc.id,
          documentNumber: doc.number,
          note: `Annulation ${doc.number}`,
        }),
      );
    }
    doc.stockApplied = false;
    doc.stockAppliedAt = undefined;
    doc.updatedAt = nowIso();
  });

  return {
    documentId,
    applied: moves.length,
    unmatched: [],
    moves,
    message: `Déduction annulée : ${moves.length} mouvement(s) inverse(s) enregistré(s).`,
  };
}

/** Correction manuelle du stock (inventaire, casse, réception fournisseur). */
export function adjustStock(productId: ID, newQty: number, note?: string): Product {
  const product = store.db.products.find((p) => p.id === productId);
  if (!product) throw new Error('Produit introuvable.');
  const delta = round2(newQty - product.qtyOnHand);
  if (delta === 0) return product;
  store.mutate(() => {
    recordMove(product, delta, delta > 0 ? 'in' : 'adjust', { note: note ?? 'Ajustement manuel' });
  });
  return product;
}

/** Applique le stock de toutes les factures validées qui ne l'ont pas encore été. */
export function applyAllPending(): { applied: number; reports: StockApplyReport[] } {
  const pending = store.db.documents.filter(
    (d) => !d.stockApplied && d.kind !== 'quote' && d.status !== 'cancelled' && d.status !== 'draft',
  );
  const reports = pending.map((d) => applyDocumentToStock(d.id));
  return { applied: reports.reduce((s, r) => s + r.applied, 0), reports };
}

/** Enregistre le libellé de la ligne comme alias du produit : le prochain import sera automatique. */
export function linkLineToProduct(documentId: ID, lineId: ID, productId: ID | null): AccountingDocument {
  const doc = store.db.documents.find((d) => d.id === documentId);
  if (!doc) throw new Error('Document introuvable.');
  const line = doc.lines.find((l) => l.id === lineId);
  if (!line) throw new Error('Ligne introuvable.');

  store.mutate(() => {
    if (!productId) {
      line.productId = undefined;
      line.matchMethod = 'none';
      line.matchScore = 0;
      return;
    }
    const product = store.db.products.find((p) => p.id === productId);
    if (!product) throw new Error('Produit introuvable.');
    line.productId = productId;
    line.matchMethod = 'manual';
    line.matchScore = 1;

    // Mémorisation : le même libellé sera reconnu tout seul la prochaine fois.
    const nLabel = normalize(line.label);
    const known = product.aliases.some((a) => normalize(a) === nLabel) || normalize(product.name) === nLabel;
    if (!known && line.label.trim()) {
      product.aliases.push(line.label.trim());
      product.updatedAt = nowIso();
    }
    doc.updatedAt = nowIso();
  });
  return doc;
}
