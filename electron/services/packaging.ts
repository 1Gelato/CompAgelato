import type { InvoicedAs, Product, ProductType } from '@shared/types';

/**
 * Conditionnements : convertir ce que dit la facture en unités de stock.
 *
 * Le besoin vient du terrain. Deux fournisseurs de prémix facturent
 * différemment le même genre de produit :
 * - mix liquide : « Poche de 4,5 kg (vendu en carton de 2 poches) »,
 *   facturé 20 pc à 17,20 € — la quantité est un nombre de poches ;
 * - mix poudre : « PREMIX VANILLE CREMITO », facturé 12,5 à 11,50 € —
 *   la quantité est un nombre de **kilos**, pas de poches.
 *
 * Sans cette conversion, 12,5 kg de poudre retireraient 12,5 poches du stock
 * au lieu de 5. Ce module est pur : il se teste sans base ni Electron.
 */

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  consumable: 'Consommable',
  mixLiquid: 'Mix glace liquide',
  mixPowder: 'Mix glace poudre',
  machine: 'Machine',
  part: 'Pièce détachée',
};

export const INVOICED_AS_LABEL: Record<InvoicedAs, string> = {
  unit: 'À l’unité',
  case: 'Au carton',
  measure: 'À la mesure (kg, L)',
};

/** Le conditionnement n'a de sens que pour ce qui se conditionne. */
export function hasPackaging(type: ProductType): boolean {
  return type === 'mixLiquid' || type === 'mixPowder' || type === 'consumable';
}

/**
 * Valeurs de départ proposées à la création, tirées des conditionnements
 * réellement rencontrés sur les factures.
 */
export function packagingDefaults(type: ProductType): Partial<Product> {
  switch (type) {
    case 'mixLiquid':
      // Poche de 4,5 kg, vendue en carton de 2, facturée à la poche.
      return { unit: 'poche', packSize: 4.5, packMeasure: 'kg', unitsPerCase: 2, invoicedAs: 'unit' };
    case 'mixPowder':
      // Poche de 2,5 kg, facturée au kilo.
      return { unit: 'poche', packSize: 2.5, packMeasure: 'kg', unitsPerCase: undefined, invoicedAs: 'measure' };
    case 'machine':
      return { unit: 'pièce', packSize: undefined, packMeasure: undefined, unitsPerCase: undefined, invoicedAs: 'unit' };
    case 'part':
      return { unit: 'pièce', packSize: undefined, packMeasure: undefined, unitsPerCase: undefined, invoicedAs: 'unit' };
    default:
      return { unit: 'pièce', invoicedAs: 'unit' };
  }
}

/**
 * Quantité facturée → quantité en unités de stock.
 * En l'absence de conditionnement exploitable, la quantité est reprise telle
 * quelle : mieux vaut un stock inchangé qu'un stock faussé par une division
 * hasardeuse.
 */
export function invoiceQtyToStockUnits(
  product: Pick<Product, 'packSize' | 'unitsPerCase' | 'invoicedAs'>,
  invoicedQty: number,
): number {
  if (!Number.isFinite(invoicedQty)) return 0;

  switch (product.invoicedAs) {
    case 'case': {
      const perCase = product.unitsPerCase;
      return perCase && perCase > 0 ? invoicedQty * perCase : invoicedQty;
    }
    case 'measure': {
      const size = product.packSize;
      return size && size > 0 ? invoicedQty / size : invoicedQty;
    }
    default:
      return invoicedQty;
  }
}

/** Contenu total d'une quantité de stock, pour l'afficher (« 5 poches = 12,5 kg »). */
export function stockContent(
  product: Pick<Product, 'packSize' | 'packMeasure'>,
  stockQty: number,
): { amount: number; measure: string } | null {
  if (!product.packSize || product.packSize <= 0 || !product.packMeasure) return null;
  return { amount: stockQty * product.packSize, measure: product.packMeasure };
}

/** Phrase lisible décrivant le conditionnement, affichée sous la fiche article. */
export function describePackaging(
  product: Pick<Product, 'unit' | 'packSize' | 'packMeasure' | 'unitsPerCase' | 'invoicedAs'>,
): string {
  const unit = product.unit || 'unité';
  const parts: string[] = [];

  if (product.packSize && product.packMeasure) {
    parts.push(`1 ${unit} = ${formatNumber(product.packSize)} ${product.packMeasure}`);
  }
  if (product.unitsPerCase && product.unitsPerCase > 1) {
    parts.push(`carton de ${product.unitsPerCase} ${unit}s`);
  }

  switch (product.invoicedAs) {
    case 'case':
      parts.push(`facturé au carton`);
      break;
    case 'measure':
      parts.push(`facturé ${product.packMeasure ? `au ${product.packMeasure}` : 'à la mesure'}`);
      break;
    default:
      parts.push(`facturé à l’${unit}`);
  }
  return parts.join(' · ');
}

function formatNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000).replace('.', ',');
}
