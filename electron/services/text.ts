/** Outils de normalisation et de rapprochement de libellés (français). */

export function stripAccents(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalize(input: string): string {
  return stripAccents(String(input ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    // Sépare chiffres et lettres pour que « 100ml » et « 100 ml » se ressemblent.
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'a', 'au', 'aux', 'en', 'pour',
  'sarl', 'sas', 'sasu', 'eurl', 'sa', 'sci', 'snc', 'eirl', 'ei', 'scop', 'association',
  'monsieur', 'madame', 'mr', 'mme', 'ste', 'societe',
]);

export function tokens(input: string): string[] {
  return normalize(input)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Distance de Levenshtein bornée, implémentation itérative à deux lignes. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/** Similarité 0 → 1 combinant Levenshtein et recouvrement de mots. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const maxLen = Math.max(na.length, nb.length);
  const lev = 1 - levenshtein(na, nb) / maxLen;

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union ? inter / union : 0;

  // Bonus si l'un contient l'autre (« Coupelle 100ml » vs « Coupelle 100ml carton x50 »).
  const contains = na.includes(nb) || nb.includes(na) ? 0.15 : 0;

  return Math.min(1, Math.max(lev * 0.45 + jaccard * 0.55, jaccard) + contains);
}

/**
 * Convertit un nombre écrit à la française ou à l'anglaise en number.
 * « 1 234,56 € », « 1,234.56 », « 12.5 », « 3 » → 1234.56, 1234.56, 12.5, 3
 */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Retire devises, espaces (y compris insécables) et caractères parasites.
  s = s.replace(/[\u20ac$\u00a3\s\u00a0\u202f\u2009]/g, '').replace(/[^\d,.\-+]/g, '');
  if (!s || s === '-' || s === '+') return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Le séparateur décimal est le dernier des deux.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    /*
     * Une seule virgule et trois chiffres derrière : « 11,635 » vaut-il onze
     * mille, ou onze euros et six cent trente-cinq millièmes ?
     *
     * Il faut **plusieurs** groupes pour parler de milliers (« 1,234,567 ») :
     * dans un fichier français, les milliers s'écrivent avec des espaces —
     * déjà retirés plus haut — et la virgule reste le séparateur décimal. Les
     * logiciels de comptabilité écrivent d'ailleurs les prix d'achat à trois
     * décimales (« 11,635 »), qui devenaient ici onze mille six cent
     * trente-cinq euros : un prix multiplié par mille, une marge absurde.
     */
    const after = s.length - lastComma - 1;
    if (after === 3 && /^\d{1,3}(,\d{3}){2,}$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, string> = {
  janvier: '01', janv: '01', jan: '01',
  fevrier: '02', fevr: '02', fev: '02',
  mars: '03', mar: '03',
  avril: '04', avr: '04',
  mai: '05',
  juin: '06',
  juillet: '07', juil: '07',
  aout: '08',
  septembre: '09', sept: '09', sep: '09',
  octobre: '10', oct: '10',
  novembre: '11', nov: '11',
  decembre: '12', dec: '12',
};

/** Analyse une date française ou ISO et renvoie yyyy-mm-dd. */
export function parseDate(raw: unknown): string | null {
  if (raw == null) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return toIsoDate(raw);
  const s = String(raw).trim();
  if (!s) return null;

  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = Number(y) > 70 ? `19${y}` : `20${y}`;
    if (Number(mo) >= 1 && Number(mo) <= 12) return `${y}-${mo}-${d}`;
  }

  m = stripAccents(s.toLowerCase()).match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[2]];
    if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`;
  }

  m = s.match(/(\d{8})/);
  if (m) {
    const v = m[1];
    const y = Number(v.slice(0, 4));
    if (y > 1990 && y < 2100) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  return null;
}

export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Pays seul : la dernière ligne d'un bloc d'adresse, jamais un nom de client.
 * Le motif est ancré aux deux bouts — « FRANCE BOISSONS » est une entreprise
 * bien réelle, et la rejeter coûterait plus cher que le cas qu'on écarte.
 */
const COUNTRY_ONLY =
  /^(france|belgique|suisse|luxembourg|espagne|italie|allemagne|portugal|pays bas|royaume uni)$/;

/**
 * Mentions qui appartiennent au document, pas à qui le reçoit.
 *
 * Sur les gabarits où le bloc client est imprimé bien plus bas que « N° client :
 * », la fenêtre de recherche traverse d'abord la colonne du vendeur et ses
 * mentions légales. « FRANCE  Devis valable jusqu'au 29/08/2026 » — la ligne
 * pays de l'émetteur fusionnée avec la validité du devis — s'y présentait
 * comme un nom de client.
 */
const DOCUMENT_META =
  /valable jusqu|date d emission|bon pour accord|date et signature|devis gratuit|conditions? (generale|de vente)|acompte demande|reglement|echeance/;

/**
 * « Libellé : valeur » propre au document.
 *
 * Sur les gabarits à deux colonnes, la ligne pays du vendeur fusionne avec le
 * champ que le logiciel imprime en face : « FRANCE  Date de livraison :
 * 03/07/2026 », « FRANCE  N° TVA : NC ». Énumérer ces mentions une par une
 * était sans fin — on reconnaît la FORME, un intitulé suivi de deux-points, et
 * la liste des intitulés reste celle des champs d'un en-tête de pièce.
 *
 * Testé sur la chaîne brute : `normalize` retire la ponctuation.
 */
const DOCUMENT_LABEL =
  /\b(dates?|n[°ºo]|num[ée]ros?|r[ée]f(?:[ée]rence)?|tva|siret|siren|client|devis|factures?|avoirs?|[ée]ch[ée]ances?|acomptes?|r[èe]glements?|livraison|[ée]mission|validit[ée]|page)\b[^:\n]{0,24}:/i;

/** Une date écrite sur la ligne : mention du document, jamais un nom. */
const CONTAINS_DATE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/;

/**
 * Cette chaîne peut-elle être le nom d'un client ?
 *
 * Garde-fou volontairement étroit : il n'essaie pas de reconnaître un vrai nom
 * — impossible —, seulement d'écarter ce qui n'en est certainement pas un. Un
 * faux rejet renverrait le lecteur sur la ligne suivante, un faux accord
 * rattache la pièce au mauvais client et, pire, le mémorise.
 */
export function looksLikeClientName(value: string): boolean {
  const raw = String(value ?? '').trim();
  const n = normalize(raw);
  if (n.length < 3) return false;
  if (COUNTRY_ONLY.test(n)) return false;
  if (CONTAINS_DATE.test(raw)) return false;
  if (DOCUMENT_LABEL.test(raw)) return false;
  if (DOCUMENT_META.test(n)) return false;
  return true;
}
