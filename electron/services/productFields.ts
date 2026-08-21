import type { InvoicedAs, ProductType } from '@shared/types';
import { normalize, parseNumber, round2 } from './text';

/**
 * Lecture des colonnes d'un catalogue d'articles — la partie qui interprète,
 * séparée de celle qui écrit en base pour se vérifier valeur par valeur.
 *
 * Un export de logiciel comptable ne parle pas la langue de CompaGelato : il
 * dit « Actif », « Marchandise », « 20,00 % », « 1 234,56 € ». Tout se traduit
 * ici, et ce qui n'est pas compris vaut `null` — jamais une valeur inventée.
 */

/** « Actif » / « Inactif » → l'article est-il encore au catalogue ? */
export function parseActive(raw?: string): boolean | null {
  if (!raw) return null;
  const n = normalize(raw);
  if (!n) return null;
  if (/^(actif|active|oui|vrai|true|1|en service|disponible)/.test(n)) return true;
  if (/^(inactif|inactive|archive|non|faux|false|0|obsolete|supprime|retire)/.test(n)) return false;
  return null;
}

/**
 * La nature quand la colonne la dit clairement.
 *
 * Les logiciels de comptabilité classent en « Marchandise », « Service »,
 * « Fabrication » — des catégories fiscales qui ne disent rien de ce qu'on
 * range sur l'étagère. Elles renvoient donc `null`, et c'est le libellé de
 * l'article qui tranchera.
 */
export function explicitProductType(raw?: string): ProductType | null {
  if (!raw) return null;
  const n = normalize(raw);
  if (/\bmix\b.*poudre|poudre.*\bmix\b/.test(n)) return 'mixPowder';
  if (/\bmix\b.*liquide|liquide.*\bmix\b/.test(n)) return 'mixLiquid';
  if (/^machine|\bmachines?\b/.test(n)) return 'machine';
  if (/piece detachee|pieces detachees|^piece|^pieces/.test(n)) return 'part';
  if (/^consommable/.test(n)) return 'consumable';
  return null;
}

/**
 * La nature devinée du libellé, faute de colonne exploitable.
 *
 * Sans cela un catalogue importé range tout en « consommable » — y compris
 * les machines et les pièces détachées, qui n'ont ni le même conditionnement
 * ni la même place dans les cahiers. Le doute profite au consommable, et la
 * fiche reste modifiable d'un clic.
 */
export function guessProductType(name: string, category?: string): ProductType {
  const n = normalize([name, category].filter(Boolean).join(' '));
  if (/\bmix\b/.test(n) && /\bpoudre\b/.test(n)) return 'mixPowder';
  if (/\bmix\b/.test(n) && /\bliquide\b/.test(n)) return 'mixLiquid';
  if (/\b(machine|turbine|pasteurisateur|vitrine|granita|distributeur|conservateur)\b/.test(n)) {
    return 'machine';
  }
  if (/\b(piece|pieces|detachee|detachees|joint|joints|courroie|racleur|palier|roulement|sonde)\b/.test(n)) {
    return 'part';
  }
  return 'consumable';
}

/** « Au carton », « à la mesure » — sinon l'unité, cas de loin le plus courant. */
export function parseInvoicedAs(raw?: string): InvoicedAs | null {
  if (!raw) return null;
  const n = normalize(raw);
  if (/carton|colis|case/.test(n)) return 'case';
  if (/mesure|kilo|\bkg\b|litre|\bl\b|measure|poids/.test(n)) return 'measure';
  if (/unite|piece|unit/.test(n)) return 'unit';
  return null;
}

/**
 * Taux de TVA en pourcentage. Un fichier qui écrit « 0,2 » parle d'un rapport,
 * pas d'un taux à 0,2 % : au-dessous de 1, on multiplie par cent.
 */
export function parseVatRate(raw?: string): number | null {
  const value = parseNumber(raw);
  if (value == null || value < 0 || value > 100) return null;
  return value > 0 && value < 1 ? round2(value * 100) : round2(value);
}

/**
 * Prix de vente HT : celui du fichier, ou celui que le TTC et le taux
 * permettent de retrouver — beaucoup d'exports ne donnent que le TTC.
 */
export function saleHtFrom(
  ht: string | undefined,
  ttc: string | undefined,
  vatRate: number | null,
): number | null {
  const direct = parseNumber(ht);
  if (direct != null) return round2(direct);
  const withTax = parseNumber(ttc);
  if (withTax == null) return null;
  return round2(vatRate ? withTax / (1 + vatRate / 100) : withTax);
}

