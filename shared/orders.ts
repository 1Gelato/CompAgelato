import type { AccountingDocument, DeliveryNote, ID, Product } from './types';

/**
 * Ce qu'un client a déjà commandé, regroupé par article.
 *
 * Le besoin vient du comptoir et du téléphone : un client rappelle pour
 * recommander « la même chose que la dernière fois » sans se souvenir de la
 * référence. Retrouver l'information suppose aujourd'hui d'ouvrir ses
 * dernières factures une par une et d'en lire les lignes. Cette fonction fait
 * ce travail d'un coup, depuis la fiche client.
 *
 * Le module est **pur et partagé** : le bureau, le téléphone et les tests
 * appellent le même code. Sur le téléphone, il travaille sur le miroir local,
 * donc la réponse arrive aussi chez le client, sans réseau.
 */

/** Un article déjà commandé, vu à travers toutes les pièces du client. */
export interface OrderedItem {
  /** Clé de regroupement : la référence si elle existe, sinon le libellé. */
  key: string;
  /** Référence telle qu'écrite sur la pièce — ce que le client cherche. */
  ref?: string;
  label: string;
  productId?: ID;
  unit?: string;
  /** Nombre de pièces où l'article figure. */
  orderCount: number;
  /** Quantité cumulée, toutes pièces confondues. */
  totalQty: number;
  /** Jour de la dernière commande (ISO yyyy-mm-dd). */
  lastDate: string;
  lastQty: number;
  lastUnitPriceHT?: number;
  /** Numéro de la pièce la plus récente : « FA-2026-014 », « BL-2026-0007 ». */
  lastSource: string;
  /** La dernière trace est-elle un bon de livraison pas encore facturé ? */
  lastFromDeliveryNote: boolean;
}

export interface OrderHistory {
  items: OrderedItem[];
  /** Nombre de pièces dépouillées — factures et bons confondus. */
  sourceCount: number;
  /** Date de la commande la plus récente, toutes lignes confondues. */
  lastDate?: string;
}

export interface OrderHistoryInput {
  clientId: ID;
  documents: AccountingDocument[];
  /**
   * Bons de livraison. Seuls ceux qui n'ont pas encore donné lieu à une
   * facture sont comptés : au-delà, la facture porte les mêmes articles et
   * tout compter deux fois gonflerait les quantités.
   */
  deliveryNotes?: DeliveryNote[];
  /** Sert à retrouver la référence d'un article noté sur un bon. */
  products?: Product[];
  /** Nombre d'articles rendus. Sans limite, on rend tout. */
  limit?: number;
}

/** Regroupe les libellés à l'orthographe voisine : espaces et casse ignorés. */
function labelKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Une pièce raconte-t-elle une commande ?
 *
 * Un devis n'engage rien et une pièce annulée n'a rien livré. Les avoirs sont
 * écartés aussi : un retour n'est pas une commande, et le soustraire ferait
 * disparaître de la liste un article pourtant bien connu du client — l'inverse
 * du service rendu ici.
 */
function isOrder(doc: AccountingDocument): boolean {
  return doc.kind === 'invoice' && doc.status !== 'cancelled';
}

export function clientOrderHistory({
  clientId,
  documents,
  deliveryNotes = [],
  products = [],
  limit,
}: OrderHistoryInput): OrderHistory {
  const skuOf = new Map<ID, { sku?: string; unit?: string }>();
  for (const product of products) skuOf.set(product.id, { sku: product.sku, unit: product.unit });

  const byKey = new Map<string, OrderedItem>();
  let sourceCount = 0;
  let lastDate: string | undefined;

  /** Range une ligne, en gardant la trace la plus récente comme référence. */
  const add = (
    line: {
      ref?: string;
      label: string;
      qty: number;
      unit?: string;
      unitPriceHT?: number;
      productId?: ID;
    },
    date: string,
    source: string,
    fromDeliveryNote: boolean,
  ) => {
    const label = line.label.trim();
    const ref = line.ref?.trim() || (line.productId ? skuOf.get(line.productId)?.sku : undefined);
    // Une ligne sans libellé ni référence ne dit rien à personne.
    if (!label && !ref) return;

    const key = ref ? `ref:${ref.toLowerCase()}` : `lib:${labelKey(label)}`;
    const existing = byKey.get(key);
    const qty = Number.isFinite(line.qty) ? line.qty : 0;
    const unit = line.unit ?? (line.productId ? skuOf.get(line.productId)?.unit : undefined);

    if (!existing) {
      byKey.set(key, {
        key,
        ref,
        label: label || (ref ?? ''),
        productId: line.productId,
        unit,
        orderCount: 1,
        totalQty: qty,
        lastDate: date,
        lastQty: qty,
        lastUnitPriceHT: line.unitPriceHT,
        lastSource: source,
        lastFromDeliveryNote: fromDeliveryNote,
      });
      return;
    }

    existing.orderCount += 1;
    existing.totalQty = Math.round((existing.totalQty + qty) * 1000) / 1000;
    // Le libellé, le prix et l'unité affichés sont ceux de la dernière fois :
    // c'est le tarif et l'appellation que le client a sous les yeux.
    if (date >= existing.lastDate) {
      existing.lastDate = date;
      existing.lastQty = qty;
      existing.lastSource = source;
      existing.lastFromDeliveryNote = fromDeliveryNote;
      if (label) existing.label = label;
      if (line.unitPriceHT !== undefined) existing.lastUnitPriceHT = line.unitPriceHT;
      if (unit) existing.unit = unit;
      if (ref) existing.ref = ref;
      if (line.productId) existing.productId = line.productId;
    }
  };

  for (const doc of documents) {
    if (doc.clientId !== clientId || !isOrder(doc)) continue;
    const date = (doc.date ?? '').slice(0, 10);
    sourceCount += 1;
    if (!lastDate || date > lastDate) lastDate = date;
    for (const line of doc.lines) {
      add(
        {
          ref: line.ref,
          label: line.label,
          qty: line.qty,
          unit: line.unit,
          unitPriceHT: line.unitPriceHT,
          productId: line.productId,
        },
        date,
        doc.number,
        false,
      );
    }
  }

  for (const note of deliveryNotes) {
    // Un bon déjà facturé est raconté par sa facture : le compter aussi
    // doublerait les quantités de la même livraison.
    if (note.clientId !== clientId || note.status === 'invoiced' || note.documentId) continue;
    const date = (note.date ?? '').slice(0, 10);
    sourceCount += 1;
    if (!lastDate || date > lastDate) lastDate = date;
    for (const item of note.items) {
      add(
        {
          label: item.label,
          qty: item.qty,
          unitPriceHT: item.unitPrice,
          productId: item.productId,
        },
        date,
        note.number,
        true,
      );
    }
  }

  const items = [...byKey.values()].sort(
    (a, b) =>
      b.lastDate.localeCompare(a.lastDate) ||
      b.orderCount - a.orderCount ||
      a.label.localeCompare(b.label, 'fr'),
  );

  return {
    items: limit && limit > 0 ? items.slice(0, limit) : items,
    sourceCount,
    lastDate,
  };
}
