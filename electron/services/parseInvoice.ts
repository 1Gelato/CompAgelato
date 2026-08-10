import path from 'node:path';
import type { DocumentKind } from '@shared/types';
import type { PdfExtract, PdfLine, PdfTextItem } from './pdf';
import { looksLikeClientName, parseDate, parseNumber, normalize, round2 } from './text';

export interface ParsedLine {
  ref?: string;
  label: string;
  qty: number;
  unit?: string;
  unitPriceHT?: number;
  totalHT?: number;
  vatRate?: number;
}

export interface ParsedDocument {
  kind: DocumentKind;
  /**
   * Pièce provisoire (« facture brouillon » tenant lieu de proforma). Elle ne
   * doit ni compter dans le chiffre d'affaires ni sortir du stock : la vraie
   * facture arrive ensuite, et la vente serait comptée deux fois.
   */
  draft: boolean;
  /**
   * Le type a-t-il été lu sur la pièce, ou seulement supposé ? Voir
   * `detectKindDetailed` : c'est ce qui décide si le classement du dossier
   * d'origine peut le contredire.
   */
  kindSure: boolean;
  number: string;
  date: string | null;
  dueDate: string | null;
  clientName: string | null;
  clientAddress: string | null;
  clientSiret: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  /** Interlocuteur nommé sur la pièce, quand il n'est pas le client lui-même. */
  clientContact: string | null;
  currency: string;
  totalHT: number | null;
  totalVAT: number | null;
  totalTTC: number | null;
  lines: ParsedLine[];
  confidence: number;
  warnings: string[];
  /**
   * Texte brut du document (début), conservé le temps de l'import pour
   * chercher un client connu quand aucun libellé « Client : » n'est présent.
   * Non enregistré en base.
   */
  sourceText?: string;
}

/* ------------------------------------------------------------------ */
/* Détection du type de document                                        */
/* ------------------------------------------------------------------ */

export function detectKind(text: string, fileName = ''): DocumentKind {
  return detectKindDetailed(text, fileName).kind;
}

/**
 * Le type, et surtout : est-il **lu** ou seulement supposé ?
 *
 * La distinction décide d'un conflit réel. Un poste désigne des dossiers à
 * envoyer au serveur (« ici mes factures, là mes devis ») et ce classement sert
 * d'indice au lecteur. Mais l'étiquette peut être fausse — un dossier de devis
 * déclaré « Factures » d'un clic de trop —, et sans cette certitude l'indice
 * écrasait ce que la pièce disait d'elle-même : des centaines de devis rangés
 * en factures, gonflant le chiffre d'affaires et réclamant des sorties de stock
 * qu'un devis ne fait jamais.
 *
 * `sure` est donc vrai dès que le type vient du document — son titre ou son
 * nom de fichier — et faux pour le seul cas où rien n'a été lu et où l'on
 * retombe sur « facture », le type le plus courant. Là, et là seulement,
 * l'indice du dossier a le dernier mot.
 */
export function detectKindDetailed(
  text: string,
  fileName = '',
): { kind: DocumentKind; sure: boolean } {
  const head = normalize(`${fileName} ${text.slice(0, 1200)}`);
  // La PREMIÈRE mention l'emporte, pas un ordre de priorité fixe : le titre
  // vient avant le corps. Tester « devis » avant « facture » — l'ancien
  // comportement — basculait en devis toute facture d'acompte qui mentionne
  // « suivant devis N° … », et en avoir toute rectificative écrite « après
  // avoir n° … » : des pièces entières sortaient du chiffre d'affaires.
  const at = (re: RegExp): number => {
    const m = re.exec(head);
    return m ? m.index : Number.MAX_SAFE_INTEGER;
  };
  const first = [
    { kind: 'credit' as DocumentKind, i: at(/\bavoirs?\b|note de credit|credit note/) },
    { kind: 'quote' as DocumentKind, i: at(/\bdevis\b|proforma|pro forma|quotation|estimate/) },
    { kind: 'invoice' as DocumentKind, i: at(/\bfactures?\b|invoice|\bfac?\b/) },
  ].sort((a, b) => a.i - b.i)[0];
  if (first.i !== Number.MAX_SAFE_INTEGER) return { kind: first.kind, sure: true };
  // Repli sur le nom de fichier : « DEV00000622.pdf » dit ce qu'il est.
  // L'espace est obligatoire dans l'alternative : `normalize` sépare lettres et
  // chiffres, si bien que « DEV00000622 » devient « dev 00000622 » — sans lui,
  // ce repli ne se déclenchait jamais sur les noms des logiciels de facturation.
  const nf = normalize(fileName);
  if (/devis|\bdev[-_ ]?\d/.test(nf)) return { kind: 'quote', sure: true };
  if (/\bfac[-_ ]?\d|\bbro[-_ ]?\d/.test(nf)) return { kind: 'invoice', sure: true };
  if (/\bav[-_ ]?\d/.test(nf)) return { kind: 'credit', sure: true };
  return { kind: 'invoice', sure: false };
}

/**
 * La pièce est-elle provisoire ?
 *
 * Beaucoup de logiciels émettent une « facture brouillon » qui tient lieu de
 * proforma : elle sert à réclamer le règlement, mais la vraie facture est émise
 * ensuite. Comptée comme définitive, la vente apparaîtrait **deux fois** — dans
 * le chiffre d'affaires comme dans les sorties de stock.
 *
 * Deux repères : le numéro, quand le logiciel de facturation préfixe ses
 * brouillons (MEG émet des BRO00001041 puis la FAC correspondante), et le
 * titre. Le filigrane « PROVISOIRE » que ces pièces portent souvent, lui, est
 * retiré du texte avant analyse : on ne peut pas compter dessus.
 */
export function detectDraft(text: string, fileName = '', number = ''): boolean {
  if (/^bro[-_ ]?\d/i.test(number.trim())) return true;
  // Le numéro extrait peut être faux (gabarit piégeux) : le nom du fichier
  // émis par le logiciel de facturation reste alors le repère le plus sûr.
  if (/\bbro[-_ ]?\d/.test(normalize(fileName))) return true;
  const head = normalize(`${fileName} ${text.slice(0, 1200)}`);
  return /\bbrouillon\b|\bprovisoire\b|non valable pour encaissement|ne (?:vaut|tient) pas (?:lieu de )?facture/.test(
    head,
  );
}

/* ------------------------------------------------------------------ */
/* Numéro de pièce                                                      */
/* ------------------------------------------------------------------ */

const NUMBER_PATTERNS: RegExp[] = [
  /(?:facture|devis|avoir)\s*(?:n\s*[°ºo]|num(?:[ée]ro)?|#|:)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_/.]{2,30})/i,
  /\bn\s*[°ºo]\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_/.]{2,30})/i,
  /(?:invoice|quote)\s*(?:no\.?|number|#|:)\s*([A-Z0-9][A-Z0-9\-_/.]{2,30})/i,
  /\br[ée]f(?:[ée]rence)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_/.]{3,30})/i,
];

export function extractNumber(text: string, fileName = ''): { value: string; sure: boolean } {
  // « N° client : CLT00000127 », « N° TVA : NC » : des numéros, mais pas CELUI
  // de la pièce. Sans ce nettoyage, le motif générique « N° » capturait le mot
  // « client » lui-même — toutes les pièces du gabarit partageaient alors le
  // numéro « client » et fusionnaient entre elles à l'import.
  const scrubbed = text.replace(
    /n\s*[°ºo]?\s*(client|tva|siret|siren|dossier|compte)\b\s*:?\s*[A-Z0-9][A-Z0-9\-_/.]*/gi,
    ' ',
  );
  for (const re of NUMBER_PATTERNS) {
    for (const m of scrubbed.matchAll(new RegExp(re.source, re.flags + 'g'))) {
      const v = m[1].replace(/[.,;:]$/, '').trim();
      if (!v || /^(du|le|de)$/i.test(v)) continue;
      // Un numéro de pièce contient toujours au moins un chiffre : « client »,
      // « PROPOSITION » ou « NC » n'en sont pas.
      if (!/\d/.test(v)) continue;
      return { value: v, sure: true };
    }
  }
  // Repli : un identifiant reconnaissable dans le nom de fichier.
  const base = path.basename(fileName).replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/([A-Z]{0,4}[-_]?\d{2,4}[-_]\d{2,6})/i) ?? base.match(/(\d{4,})/);
  if (m) return { value: m[1], sure: false };
  return { value: base || 'SANS-NUMERO', sure: false };
}

/* ------------------------------------------------------------------ */
/* Dates                                                                */
/* ------------------------------------------------------------------ */

export function extractDates(lines: string[]): { date: string | null; dueDate: string | null } {
  let date: string | null = null;
  let dueDate: string | null = null;

  // Sur les gabarits à deux colonnes, « Date : 22/03 » et « Échéance : 21/04 »
  // fusionnent en une seule ligne : chercher une date « quelque part sur la
  // ligne » attrapait la première — l'échéance recevait la date d'émission.
  // L'échéance se lit donc APRÈS son mot-clé.
  const DUE = /[ée]ch[ée]ance|date\s*limite|payable|due\s*date|[àa]\s*r[ée]gler\s*avant|r[èe]glement\s*au\s*plus\s*tard/i;

  for (const line of lines) {
    const n = normalize(line);
    if (!dueDate) {
      const m = DUE.exec(line);
      if (m) dueDate = parseDate(line.slice(m.index + m[0].length));
    }
    // « Date d'échéance : … » commence aussi par « date » : sans cette garde,
    // la pièce prenait la date de son échéance.
    if (!date && /^(date|date de facture|date facture|date du devis|date d emission|emis le|le)\b/.test(n) && !/^date d ?echeance/.test(n)) {
      const d = parseDate(line);
      if (d) date = d;
    }
  }

  if (!date) {
    // Première date plausible du document — hors échéance, et hors mentions de
    // validité : « Devis valable jusqu'au 29/08 » daterait le devis de son
    // expiration.
    for (const line of lines) {
      if (/echeance|due date|valable|validit[ée]/i.test(normalize(line)) || DUE.test(line)) continue;
      const d = parseDate(line);
      if (d) {
        date = d;
        break;
      }
    }
  }
  return { date, dueDate };
}

/* ------------------------------------------------------------------ */
/* Totaux                                                               */
/* ------------------------------------------------------------------ */

/** Dernier nombre de la ligne — les tableaux de totaux mettent la valeur à droite. */
function lastNumber(line: string): number | null {
  const matches = line.match(/-?[\d][\d\s  .,]*/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const n = parseNumber(matches[i]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Lignes d'identification (SIRET, TVA intracommunautaire, IBAN…) : elles
 * contiennent de longs nombres qu'il ne faut jamais confondre avec un montant.
 */
const IDENTITY_LINE =
  /(siret|siren|\brcs\b|\bnaf\b|\bape\b|iban|\bbic\b|swift|capital social|tva\s*(intra\w*)?\s*:?\s*[a-z]{2}\s*\d{6,})/i;

/** Un montant de facture reste dans des ordres de grandeur raisonnables. */
function plausibleAmount(v: number | null): v is number {
  return v !== null && Number.isFinite(v) && Math.abs(v) < 100_000_000;
}

export function extractTotals(lines: string[]): {
  totalHT: number | null;
  totalVAT: number | null;
  totalTTC: number | null;
  warnings: string[];
} {
  let totalHT: number | null = null;
  let totalVAT: number | null = null;
  let totalTTC: number | null = null;
  // « Net à payer » n'est PAS le total TTC : sur une facture d'acompte soldée,
  // il vaut 0,00 € une fois l'acompte déduit. Le retenir à la place du total
  // effaçait le TTC réel et faisait recalculer une TVA négative, sans un mot.
  // On le garde à part, en dernier recours seulement.
  let netToPay: number | null = null;
  const warnings: string[] = [];

  // On parcourt tout le document et on retient la DERNIÈRE occurrence de chaque
  // total : le bloc récapitulatif se trouve en bas de la dernière page.
  for (const line of lines) {
    if (IDENTITY_LINE.test(line)) continue;
    const n = normalize(line);
    // « TVA non applicable, art. 293 B du CGI » : le 293 est un article de
    // loi, pas un montant. Sans ce garde-fou, une facture d'auto-entrepreneur
    // sortait avec 293 € de TVA fantôme.
    if (/tva\s*non\s*applicable|art\.?\s*293\s*b/.test(n)) {
      totalVAT = 0;
      continue;
    }
    const value = lastNumber(line);
    if (!plausibleAmount(value)) continue;

    if (/(total\s*t\s*t\s*c|montant\s*ttc|total\s*ttc|total\s*general)/.test(n)) {
      totalTTC = value;
      continue;
    }
    if (/(net\s*a\s*payer|total\s*a\s*payer|montant\s*du|reste\s*a\s*payer)/.test(n)) {
      netToPay = value;
      continue;
    }
    // « Base HT » est parfois un simple en-tête de colonne dans un tableau
    // récapitulatif de TVA (« Code | Base HT | Taux | Montant ») : sur ce
    // genre de ligne, la présence conjointe de « Code » et « Taux » trahit un
    // en-tête, pas un total, et le nombre en fin de ligne appartient en
    // réalité à une autre colonne (montant de TVA, pas total HT).
    const looksLikeRecapHeader = /\bcode\b/.test(n) && /\btaux\b/.test(n);
    if (
      /(total\s*h\s*t|montant\s*ht|total\s*hors\s*taxe|sous\s*total)/.test(n) ||
      (/base\s*ht/.test(n) && !looksLikeRecapHeader)
    ) {
      totalHT = value;
      continue;
    }
    if (/(^|\s)(tva|t\s*v\s*a|taxe)/.test(n)) {
      totalVAT = value;
      continue;
    }
  }

  // Sans total TTC explicite, le net à payer sert de repli — c'est mieux que
  // rien, mais seulement s'il ne contredit pas HT + TVA (un net à 0 après
  // acompte n'est pas un total).
  if (totalTTC === null && netToPay !== null) {
    const plausible =
      totalHT === null || totalVAT === null || Math.abs(totalHT + totalVAT - netToPay) <= 0.05;
    if (plausible) totalTTC = netToPay;
  }

  // La TVA lue doit rester cohérente avec HT et TTC ; sinon on la recalcule —
  // jamais en négatif : une TVA négative signifie que le « total » retenu n'en
  // est pas un, et l'écraser masquerait le problème au lieu de le signaler.
  if (totalHT !== null && totalTTC !== null) {
    const expected = round2(totalTTC - totalHT);
    if (expected >= 0 && (totalVAT === null || Math.abs(totalVAT - expected) > 0.05)) {
      totalVAT = expected;
    } else if (expected < 0) {
      warnings.push('Total TTC inférieur au total HT — montants à vérifier.');
    }
  }

  // Complétion et contrôle de cohérence.
  if (totalHT !== null && totalVAT !== null && totalTTC === null) totalTTC = round2(totalHT + totalVAT);
  if (totalHT !== null && totalTTC !== null && totalVAT === null) totalVAT = round2(totalTTC - totalHT);
  if (totalVAT !== null && totalTTC !== null && totalHT === null) totalHT = round2(totalTTC - totalVAT);

  if (totalHT !== null && totalVAT !== null && totalTTC !== null) {
    if (Math.abs(totalHT + totalVAT - totalTTC) > 0.05) {
      warnings.push('Totaux incohérents (HT + TVA ≠ TTC) — à vérifier.');
    }
  }
  return { totalHT, totalVAT, totalTTC, warnings };
}

/* ------------------------------------------------------------------ */
/* Client                                                               */
/* ------------------------------------------------------------------ */

const CLIENT_MARKERS = /(client|factur[ée]\s*(?:à|a)|adress[ée]\s*(?:à|a)|destinataire|livr[ée]\s*(?:à|a)|bill\s*to|customer)/i;
const SELLER_MARKERS = /(emetteur|vendeur|fournisseur|expediteur|siret|siren|ape|naf|rcs|iban|bic|tva\s*intra)/i;
/**
 * Un SIRET/SIREN peut appartenir aussi bien au vendeur qu'au client (chaque
 * facture affiche le sien) : contrairement à `SELLER_MARKERS`, ce marqueur ne
 * sert qu'à repérer qu'on a quitté le bloc client pour les mentions légales
 * propres au vendeur (RIB, capital social...), donc SIRET/SIREN en est exclu
 * pour ne pas couper la lecture avant les lignes téléphone/e-mail du client.
 */
const SELLER_ONLY_MARKERS = /(emetteur|vendeur|fournisseur|expediteur|ape|naf|rcs|iban|bic|tva\s*intra|capital\s*social)/i;
const TABLE_HEADER_MARKERS = /(total|qt[ée]|d[ée]signation|r[ée]f\.)/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /\b0\d(?:[\s.-]?\d{2}){4}\b/;
const PHONE_LABEL = /^(t[ée]l\.?|port\.?|mobile|gsm)\b/i;

/**
 * Beaucoup de gabarits de facture impriment le bloc vendeur (à gauche) et le
 * bloc client (à droite) sur les mêmes lignes visuelles : le texte fusionné
 * ressemble alors à « Tél. : 01 23 45 67 89   RUE DE LA PLAGE ». On retire le
 * préfixe connu du bloc vendeur pour ne garder que le fragment côté client,
 * repéré par le grand espacement laissé par les colonnes.
 */
function stripSellerColumnNoise(line: string): string {
  const labelled = line.match(/^(t[ée]l\.?|port\.?|fax|e-?mail|site\s*web|mobile)\b\s*[:.]?\s*.*?\s{2,}(.+)$/i);
  if (labelled) return labelled[2].trim();
  // Tout le bloc vendeur n'est pas étiqueté. Le nom du gérant, imprimé seul en
  // bas du pavé de gauche (« Monsieur Hervé GUEGUEN - GERANT »), se retrouve
  // fusionné avec la ligne de code postal du client — et atterrissait dans
  // l'adresse de tous ses propres clients. Quand la partie droite commence par
  // un code postal, elle est à elle seule la ligne d'adresse : ce qui la
  // précède, de l'autre côté du grand espacement, vient de l'autre colonne.
  const postcodeColumn = line.match(/^.*\S\s{2,}(\d{5}\s+\S.*)$/);
  return postcodeColumn ? postcodeColumn[1].trim() : line;
}

/**
 * Une ligne d'adresse qui est en fait le nom d'une personne.
 *
 * Certains logiciels de facturation obligent à choisir entre une raison
 * sociale et un nom de personne. Facturer une association ou une mairie en
 * gardant le nom de l'interlocuteur impose alors de le ranger dans la
 * **première ligne d'adresse** — d'où « SNSM LE CROISIC / LUCIE DEBEC / 2
 * PLACE DU TREHIC ». Ce n'est pas une adresse postale, c'est un contact.
 *
 * Le repère est volontairement étroit : aucun chiffre sur la ligne, et la
 * suivante commence par un **numéro de voie** — un petit nombre, jamais un code
 * postal à cinq chiffres, sans quoi « Place du Marché » suivi de « 44380
 * PORNICHET » passerait pour un interlocuteur et l'adresse perdrait sa rue.
 * Dans le doute, on laisse la ligne dans l'adresse : un contact manqué se
 * rattrape, une adresse amputée non.
 */
function looksLikeContactLine(line: string, next: string | undefined): boolean {
  const c = line.trim();
  if (c.length < 3 || /\d/.test(c)) return false;
  if (/^(france|belgique|suisse|luxembourg)$/i.test(c)) return false;
  return !!next && /^\d{1,4}(?!\d)/.test(next.trim());
}

/** Un code client (« CL0012 », « CLT00000127 ») n'est pas un nom : lettres/chiffres, sans espace. */
function looksLikeReferenceCode(value: string): boolean {
  return /^[A-Za-z]{0,4}\d[\dA-Za-z]*$/.test(value.trim());
}

export function extractClient(lines: string[]): {
  name: string | null;
  address: string | null;
  siret: string | null;
  email: string | null;
  phone: string | null;
  /** Interlocuteur nommé dans le bloc client, quand il n'est pas le client. */
  contact: string | null;
} {
  let name: string | null = null;
  const addressParts: string[] = [];
  let email: string | null = null;
  let phone: string | null = null;
  let contact: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CLIENT_MARKERS.test(line)) continue;
    // Le nom peut suivre le marqueur sur la même ligne (« Client : Dupont SARL »).
    // Si cette ligne mélange aussi un marqueur vendeur (« Siret : ...  N° client : CL0012 »)
    // ou ne contient qu'un code de référence, ce n'est pas le nom : on ignore l'inline
    // et on se rabat sur les lignes suivantes.
    const inline = line.split(/:/).slice(1).join(':').trim();
    const inlineUsable = inline.length > 2 && !SELLER_MARKERS.test(line) && !looksLikeReferenceCode(inline);
    const candidates: string[] = [];
    if (inlineUsable) candidates.push(inline);
    // Fenêtre large : le bloc client comprend souvent nom, adresse, SIRET/SIREN
    // propres au client puis téléphone et e-mail — on ne s'arrête qu'en
    // atteignant le tableau d'articles ou un bloc réservé au vendeur.
    for (let j = i + 1; j < Math.min(i + 18, lines.length); j++) {
      const l = lines[j].trim();
      if (!l) continue;
      if (TABLE_HEADER_MARKERS.test(l) || SELLER_ONLY_MARKERS.test(l)) break;
      candidates.push(l);
      if (candidates.length >= 10) break;
    }
    if (!candidates.length) continue;

    // Le nom n'est pas forcément la première ligne rencontrée.
    //
    // Un gabarit très répandu place « N° client : CLT00000132 » dans le bloc
    // de droite, juste au-dessus du « Siret : … » du **vendeur**, le nom du
    // client n'arrivant qu'ensuite, collé à une étiquette de la colonne de
    // gauche (« Tél. : 09 54 93 49 90   Monsieur THIERRY SALOMON »). Prendre la
    // première ligne venue donnait alors « Siret : 80184990200011 » comme nom
    // de client — sur toutes les factures du gabarit à la fois.
    //
    // Une ligne d'identification (SIRET, TVA, IBAN…) reste dans la liste, car
    // elle sert à lire l'adresse et le contact ; elle ne peut simplement pas
    // *être* le nom. On avance jusqu'à la première ligne qui en soit un.
    const nameFrom = candidates.find((raw) => {
      const c = stripSellerColumnNoise(raw).replace(/\s{2,}/g, ' ').trim();
      if (c.length < 3) return false;
      if (IDENTITY_LINE.test(c)) return false;
      if (looksLikeReferenceCode(c)) return false;
      // Une étiquette de contact seule (« Tél. : 09 54 93 49 90 ») n'est pas un
      // nom ; celle qui traîne un nom derrière elle a déjà été nettoyée.
      if (PHONE_LABEL.test(c) || EMAIL_RE.test(c)) return false;
      // Ni un pays seul, ni une mention propre au document : voir
      // `looksLikeClientName`.
      return looksLikeClientName(c);
    });
    if (!nameFrom) continue;
    name = stripSellerColumnNoise(nameFrom).replace(/\s{2,}/g, ' ').trim();
    // L'adresse s'arrête au code postal, mais on continue de parcourir les
    // lignes suivantes (SIRET, téléphone, e-mail) pour récupérer le contact.
    // Elle démarre **après le nom retenu**, et non après la première ligne : le
    // nom peut avoir été précédé d'une ligne d'identification du vendeur, qui
    // n'a rien à faire dans l'adresse du client.
    let addressDone = false;
    const after = candidates.slice(candidates.indexOf(nameFrom) + 1);
    for (let k = 0; k < after.length; k++) {
      const c = stripSellerColumnNoise(after[k]);
      if (!email) {
        const found = c.match(EMAIL_RE);
        if (found) email = found[0];
      }
      if (!phone && PHONE_LABEL.test(c)) {
        const found = c.match(PHONE_RE);
        if (found) phone = found[0].replace(/[\s.-]/g, '');
      }
      if (addressDone) continue;
      // Première ligne du bloc : c'est peut-être l'interlocuteur rangé faute de
      // place ailleurs, auquel cas il ne fait pas partie de l'adresse postale.
      if (!addressParts.length && !contact) {
        const next = after[k + 1] ? stripSellerColumnNoise(after[k + 1]) : undefined;
        if (looksLikeContactLine(c, next)) {
          contact = c.replace(/\s{2,}/g, ' ').trim();
          continue;
        }
      }
      addressParts.push(c.replace(/\s{2,}/g, ' ').trim());
      if (/\b\d{5}\b/.test(c)) addressDone = true; // code postal atteint → fin d'adresse
    }
    break;
  }

  let siret: string | null = null;
  const joined = lines.join('\n');
  const all = [...joined.matchAll(/siret\s*:?\s*((?:\d[\s.]?){14})/gi)].map((m) => m[1].replace(/\D/g, ''));
  // Le SIRET du client est le second SIRET DISTINCT du document (le premier est
  // l'émetteur). Compter les occurrences suffisait à se tromper : le pied de
  // page légal du vendeur se répète à chaque page, et toutes les factures
  // multipages recevaient le SIRET du vendeur — puis se rattachaient toutes à
  // la même fiche, score parfait.
  const distinct = [...new Set(all)];
  if (distinct.length > 1) siret = distinct[1];

  return {
    name: name && name.length >= 2 ? name : null,
    address: addressParts.length ? addressParts.join(', ') : null,
    siret,
    email,
    phone,
    contact,
  };
}

/* ------------------------------------------------------------------ */
/* Lignes de détail                                                     */
/* ------------------------------------------------------------------ */

type ColumnRole = 'ref' | 'label' | 'qty' | 'unit' | 'unitPrice' | 'total' | 'vat' | 'ignore';

function roleOf(header: string): ColumnRole {
  const n = normalize(header);
  if (!n) return 'ignore';
  if (/^(ref|reference|code|article|art|sku)/.test(n)) return 'ref';
  if (/(designation|description|libelle|produit|intitule|prestation|article)/.test(n)) return 'label';
  if (/^(qte|qty|quantite|nb|nbre|nombre)/.test(n)) return 'qty';
  if (/^(unite|un|u|conditionnement|cond)/.test(n)) return 'unit';
  if (/(p\s*u|prix\s*unitaire|prix\s*u|pu\s*ht|prix)/.test(n)) return 'unitPrice';
  if (/(montant|total|mt)/.test(n)) return 'total';
  if (/(tva|taxe|vat)/.test(n)) return 'vat';
  return 'ignore';
}

interface Column {
  role: ColumnRole;
  x: number;
  end: number;
}

function findHeader(lines: PdfLine[]): { index: number; columns: Column[] } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cells = groupCells(line.items);
    if (cells.length < 3) continue;
    const roles = cells.map((c) => roleOf(c.text));
    const known = roles.filter((r) => r !== 'ignore');
    const hasLabel = roles.includes('label') || roles.includes('ref');
    const hasNumeric = roles.includes('qty') || roles.includes('unitPrice') || roles.includes('total');
    if (known.length >= 3 && hasLabel && hasNumeric) {
      const columns: Column[] = cells.map((c, idx) => ({
        role: roles[idx],
        x: c.x,
        end: idx + 1 < cells.length ? cells[idx + 1].x : Number.POSITIVE_INFINITY,
      }));
      return { index: i, columns };
    }
  }
  return null;
}

interface Cell {
  text: string;
  x: number;
  end: number;
}

/** Regroupe les fragments d'une ligne en cellules à partir des écarts horizontaux. */
function groupCells(items: PdfTextItem[]): Cell[] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const medianH = sorted.map((i) => i.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 10;
  const gapThreshold = medianH * 1.1;

  const cells: Cell[] = [];
  let current: PdfTextItem[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1];
    const gap = sorted[i].x - (prev.x + prev.width);
    if (gap > gapThreshold) {
      cells.push(toCell(current));
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  cells.push(toCell(current));
  return cells.filter((c) => c.text.trim().length > 0);
}

function toCell(items: PdfTextItem[]): Cell {
  let text = '';
  let prevEnd: number | null = null;
  for (const it of items) {
    if (prevEnd !== null && it.x - prevEnd > 0.6 && !text.endsWith(' ')) text += ' ';
    text += it.str;
    prevEnd = it.x + it.width;
  }
  const last = items[items.length - 1];
  return { text: text.trim(), x: items[0].x, end: last.x + last.width };
}

const STOP_ROW =
  /^(total|sous[-\s]?total|montant\s*(ht|ttc)|d[ée]tail\s*(de\s*la\s*)?tva|tva|net\s*[àa]\s*payer|conditions?|mode\s*de\s*r|arr[êe]t[ée]e?\s*la|escompte|acompte|p[ée]nalit|r[èe]glement|coordonn[ée]es?\s*bancaires?|le\s*montant\s*total|page\s*\d+\s*(de|sur|\/)\s*\d+)/i;

/**
 * Pied de page légal, répété en bas de chaque page : il contient toujours
 * plusieurs mentions réglementaires à la suite. Le repérer évite de lire
 * l'adresse de l'émetteur comme une ligne d'article.
 */
const LEGAL_FOOTER = /(iban|code\s*naf|\bape\b|\brcs\b|n°?\s*tva|siret)/i;

function looksLikeLegalFooter(text: string): boolean {
  // Au moins deux mentions légales sur la même ligne : une facture peut citer
  // un SIRET seul dans le bloc client, jamais quatre mentions d'affilée.
  const hits = text.match(new RegExp(LEGAL_FOOTER, 'gi'));
  return (hits?.length ?? 0) >= 2;
}

/**
 * Reprise du tableau sur la page suivante.
 *
 * Une facture multipage réimprime en haut de chaque page son bloc vendeur
 * (raison sociale, adresse, numéro, date) avant de continuer le tableau. Lu
 * naïvement, ce bloc devient des lignes d'articles fantômes — une date
 * « 03/07/2026 » se transformant même en montant de 3 072 026 €. On ne reprend
 * donc la lecture qu'après avoir retrouvé un en-tête de tableau sur la nouvelle
 * page ; sans en-tête, c'est que le tableau est bel et bien terminé.
 *
 * On ne regarde que la page immédiatement suivante : un PDF contenant deux
 * factures scannées à la suite ne doit pas voir la seconde absorbée dans la
 * première.
 */
function resumeNextPage(
  lines: PdfLine[],
  from: number,
  currentPage: number,
): { index: number; page: number } | null {
  let start = -1;
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (lines[i].page > currentPage) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const page = lines[start].page;
  const pageLines = lines.slice(start).filter((l) => l.page === page);
  const header = findHeader(pageLines);
  if (!header) return null;
  const index = lines.indexOf(pageLines[header.index]);
  return index < 0 ? null : { index, page };
}

export function extractLinesFromPdf(extract: PdfExtract): { lines: ParsedLine[]; warnings: string[] } {
  const warnings: string[] = [];
  const header = findHeader(extract.lines);
  if (!header) {
    return { lines: [], warnings: ['Aucun tableau de lignes détecté dans le PDF.'] };
  }

  const out: ParsedLine[] = [];
  let pending: ParsedLine | null = null;
  let currentPage = extract.lines[header.index].page;

  for (let i = header.index + 1; i < extract.lines.length; i++) {
    const line = extract.lines[i];
    const text = line.text.trim();
    if (!text) continue;

    // Le tableau déborde sur la page suivante : on saute le bloc d'en-tête
    // réimprimé et on reprend au tableau, s'il y en a un.
    if (line.page !== currentPage) {
      const resume = resumeNextPage(extract.lines, i, currentPage);
      if (!resume) break;
      currentPage = resume.page;
      pending = null;
      i = resume.index;
      continue;
    }

    /*
     * Fin du tableau sur cette page. Attention : le total et le pied de page
     * légal se répètent en bas de *chaque* page. S'arrêter là perdrait les
     * articles des pages suivantes ; on tente donc d'abord la reprise.
     */
    if (STOP_ROW.test(text) || looksLikeLegalFooter(text)) {
      const resume = resumeNextPage(extract.lines, i + 1, currentPage);
      if (!resume) break;
      currentPage = resume.page;
      pending = null;
      i = resume.index;
      continue;
    }

    const cells = groupCells(line.items);
    if (!cells.length) continue;

    // Rattache chaque cellule à une colonne, en respectant l'ordre gauche→droite.
    // Les valeurs numériques (souvent alignées à droite) ne tombent pas
    // forcément sous le début visuel de leur en-tête : chercher la colonne la
    // plus proche indépendamment pour chaque cellule fait parfois « remonter »
    // une valeur dans la colonne précédente. En n'autorisant jamais de retour
    // en arrière (la colonne choisie pour une cellule ne peut être antérieure
    // à celle de la cellule précédente), l'ordre des colonnes de l'en-tête
    // sert d'ancre fiable même quand les positions x sont approximatives.
    const values: Partial<Record<ColumnRole, string>> = {};
    let columnPointer = 0;
    for (const cell of cells) {
      const center = (cell.x + cell.end) / 2;
      let bestIndex = columnPointer;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = columnPointer; i < header.columns.length; i++) {
        const col = header.columns[i];
        const colCenter = Number.isFinite(col.end) ? (col.x + col.end) / 2 : col.x + 20;
        const dist = Math.abs(center - colCenter);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }
      const best = header.columns[bestIndex];
      columnPointer = bestIndex;
      if (best.role === 'ignore') continue;
      values[best.role] = values[best.role] ? `${values[best.role]} ${cell.text}` : cell.text;
    }

    const qty = parseNumber(values.qty ?? '');
    const unitPrice = parseNumber(values.unitPrice ?? '');
    const total = parseNumber(values.total ?? '');
    const label = (values.label ?? '').trim();
    const ref = (values.ref ?? '').trim();

    const hasMoney = unitPrice !== null || total !== null;
    const hasText = Boolean(label || ref);

    if (!hasText && !hasMoney) continue;

    // Ligne de continuation : uniquement du texte, sans montant → suite du libellé précédent.
    if (hasText && !hasMoney && qty === null && pending) {
      pending.label = `${pending.label} ${label || ref}`.trim();
      continue;
    }
    if (!hasText && hasMoney && !pending) continue;

    const parsed: ParsedLine = {
      ref: ref || undefined,
      label: label || ref || 'Ligne sans libellé',
      qty: qty ?? 1,
      unit: (values.unit ?? '').trim() || undefined,
      unitPriceHT: unitPrice ?? undefined,
      totalHT: total ?? (unitPrice !== null && qty !== null ? round2(unitPrice * qty) : undefined),
      vatRate: parseNumber(values.vat ?? '') ?? undefined,
    };
    out.push(parsed);
    pending = parsed;
  }

  if (!out.length) warnings.push('Tableau détecté mais aucune ligne exploitable.');
  return { lines: out, warnings };
}

/* ------------------------------------------------------------------ */
/* Assemblage                                                           */
/* ------------------------------------------------------------------ */

export function parsePdfDocument(extract: PdfExtract, filePath: string): ParsedDocument {
  const textLines = extract.lines.map((l) => l.text);
  const fullText = textLines.join('\n');
  const fileName = path.basename(filePath);

  const { kind, sure: kindSure } = detectKindDetailed(fullText, fileName);
  const number = extractNumber(fullText, filePath);
  const draft = detectDraft(fullText, fileName, number.value);
  const { date, dueDate } = extractDates(textLines);
  const totals = extractTotals(textLines);
  const client = extractClient(textLines);
  const { lines, warnings: lineWarnings } = extractLinesFromPdf(extract);

  const warnings = [...totals.warnings, ...lineWarnings];
  if (!number.sure) warnings.push('Numéro de pièce déduit du nom de fichier.');
  if (!date) warnings.push('Date introuvable — date du fichier utilisée.');
  if (!client.name) warnings.push('Client non identifié sur le document.');
  if (totals.totalTTC === null && totals.totalHT === null) warnings.push('Aucun total détecté.');

  // Contrôle : la somme des lignes doit approcher le total HT.
  const sumLines = round2(lines.reduce((s, l) => s + (l.totalHT ?? 0), 0));
  if (lines.length && totals.totalHT !== null && Math.abs(sumLines - totals.totalHT) > 0.05) {
    warnings.push(
      `Somme des lignes (${sumLines.toFixed(2)} €) différente du total HT (${totals.totalHT.toFixed(2)} €).`,
    );
  }

  let confidence = 1;
  if (!number.sure) confidence -= 0.2;
  if (!date) confidence -= 0.15;
  if (!client.name) confidence -= 0.2;
  if (!lines.length) confidence -= 0.25;
  if (totals.totalTTC === null) confidence -= 0.2;
  if (warnings.some((w) => w.startsWith('Somme des lignes'))) confidence -= 0.1;

  const currency = /(\$|USD)/.test(fullText) && !/€|EUR/.test(fullText) ? 'USD' : 'EUR';

  return {
    kind,
    kindSure,
    draft,
    number: number.value,
    date,
    dueDate,
    clientName: client.name,
    clientAddress: client.address,
    clientSiret: client.siret,
    clientEmail: client.email,
    clientPhone: client.phone,
    clientContact: client.contact,
    currency,
    totalHT: totals.totalHT,
    totalVAT: totals.totalVAT,
    totalTTC: totals.totalTTC,
    lines,
    confidence: Math.max(0.05, round2(confidence)),
    warnings,
    sourceText: fullText.slice(0, 6000),
  };
}
