/**
 * Recherche par montant.
 *
 * Taper « 482 » doit retrouver l'opération de 482,96 €, et « 115,56 » la
 * facture de ce total. La règle est unique et se dit en une phrase : le montant
 * écrit avec deux décimales doit contenir les chiffres tapés. Elle est donc
 * généreuse — « 115 » retrouve aussi 1 150,00 € — mais on affine en tapant
 * davantage, alors qu'une règle stricte ne renvoie rien et laisse démuni.
 *
 * Le signe est ignoré : on cherche « 482 », pas « −482 ».
 */

/** Une requête de montant : des chiffres, éventuellement une partie décimale. */
const AMOUNT_QUERY = /^\d+([.,]\d{0,2})?$/;

/** Espaces (dont insécables), symbole monétaire et virgule française retirés. */
export function normalizeAmountQuery(query: string): string | null {
  const cleaned = query
    .trim()
    .replace(/[\s  €]/g, '')
    .replace(',', '.');
  if (!cleaned || !AMOUNT_QUERY.test(cleaned)) return null;
  return cleaned;
}

/** La requête, lue comme un montant, correspond-elle à l'une des valeurs ? */
export function matchesAmount(query: string, amounts: (number | null | undefined)[]): boolean {
  const needle = normalizeAmountQuery(query);
  if (needle === null) return false;
  for (const amount of amounts) {
    if (amount === null || amount === undefined || !Number.isFinite(amount)) continue;
    if (Math.abs(amount).toFixed(2).includes(needle)) return true;
  }
  return false;
}
