/**
 * Ce qui, sur une facture, ressemble à une ligne d'article sans en être une.
 *
 * Le bas d'une facture porte un **récapitulatif de TVA** : une petite table
 * « Base HT | Taux | Montant » dont chaque ligne commence par le nom du taux
 * — « Normale », « Réduite ». Lue naïvement, elle produit des articles
 * fantômes : « Réduite 450,88 € 5,50% 24,80 € », quantité 1, unité
 * « Total TTC ». On les voit apparaître partout où les lignes sont montrées,
 * et personne ne comprend d'où elles sortent.
 *
 * Le module est partagé : le lecteur de PDF s'en sert pour ne pas les lire, et
 * les écrans pour ne pas montrer celles déjà enregistrées avant ce correctif.
 */

/**
 * Intitulés des taux de TVA français, tels qu'imprimés dans les
 * récapitulatifs. « Particulière » et « super-réduite » couvrent les taux
 * régionaux (Corse, DOM) que certains logiciels nomment ainsi.
 */
const VAT_RATE_NAME =
  /^(taux\s+)?(normale?|r[ée]duite?|super[-\s]?r[ée]duite?|interm[ée]diaire|particuli[èe]re|exon[ée]r[ée]e?|non\s*soumis)\b/i;

/** Un pourcentage écrit à la française ou à l'anglaise : « 5,50% », « 20 % ». */
const PERCENT = /\d+(?:[.,]\d+)?\s*%/;

/**
 * Cette ligne est-elle une ligne du récapitulatif de TVA ?
 *
 * Les deux conditions comptent. Le nom du taux seul écarterait un article
 * réellement nommé « Réduite » ; le pourcentage seul écarterait une remise
 * (« Remise 5% ») qui, elle, appartient bien à la commande.
 */
export function looksLikeVatRecapRow(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return VAT_RATE_NAME.test(trimmed) && PERCENT.test(trimmed);
}

/**
 * Le libellé d'un article, sans la référence qu'il répète.
 *
 * Beaucoup de logiciels impriment la référence dans sa colonne **et** en tête
 * du libellé : « CORNETSIMPLE » puis « CORNETSIMPLE -CORNET SIMPLE X100 ».
 * Affiché tel quel à côté de la référence, cela donne « CORNETSIMPLE ·
 * CORNETSIMPLE -CORNET SIMPLE », deux fois la même chose sur un écran de
 * téléphone déjà étroit.
 *
 * On ne coupe que si un séparateur suit la référence : sans cette précaution,
 * une référence « REM » amputerait « REMISE » de ses trois premières lettres.
 */
export function cleanItemLabel(label: string, ref?: string): string {
  const clean = label.trim();
  const needle = ref?.trim();
  if (!needle || !clean.toLowerCase().startsWith(needle.toLowerCase())) return clean;

  const after = clean.slice(needle.length);
  if (after && !/^[\s\-–—:_/]/.test(after)) return clean;

  const rest = after.replace(/^[\s\-–—:_/]+/, '').trim();
  // Un libellé qui n'était *que* la référence reste tel quel : mieux vaut la
  // répéter que n'afficher plus rien.
  return rest || clean;
}
