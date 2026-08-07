import crypto from 'node:crypto';
import type { BankCategory } from '@shared/types';
import type { FieldDictionary, Table } from './tabular';
import { guessMapping } from './tabular';
import { normalize, parseDate, parseNumber, round2, tokens } from './text';

/**
 * Lecture des relevés de compte exportés par la banque (CSV / Excel).
 *
 * Ce module est volontairement sans dépendance à Electron ni à la base : il
 * ne fait que transformer un tableau en opérations, ce qui le rend testable
 * directement avec `node --test` (voir tests/bank.test.mjs).
 */

/**
 * Colonnes reconnues. L'ordre compte : `guessMapping` attribue chaque colonne
 * au premier champ qui la revendique, donc les champs les plus spécifiques
 * doivent être déclarés avant les plus génériques (« date de valeur » avant
 * « date », « montant débit » avant « montant »).
 */
export const STATEMENT_FIELDS: FieldDictionary = {
  valueDate: ['date de valeur', 'date valeur', 'valeur'],
  date: [
    'date de operation',
    "date d operation",
    'date operation',
    'date comptable',
    'date de comptabilisation',
    'date',
  ],
  label: [
    'libelle operation',
    'libelle simplifie',
    'libelle',
    'intitule',
    'nature operation',
    'designation',
    'description',
    'motif',
    'operation',
  ],
  debit: ['montant debit', 'debit', 'depense', 'retrait', 'sortie'],
  credit: ['montant credit', 'credit', 'recette', 'depot', 'entree'],
  amount: ['montant operation', 'montant eur', 'montant', 'somme', 'amount'],
  direction: ['sens operation', 'sens', 'debit credit'],
  balance: ['solde apres operation', 'solde', 'balance'],
  reference: ['reference operation', 'reference', 'numero operation', 'no operation'],
  account: ['numero de compte', 'compte bancaire', 'compte', 'iban'],
};

/** Un relevé exploitable a forcément une date, un libellé et un montant. */
export function looksLikeStatement(headers: string[]): boolean {
  const mapping = guessMapping(headers, STATEMENT_FIELDS);
  const hasDate = Boolean(mapping.date || mapping.valueDate);
  const hasLabel = Boolean(mapping.label);
  const hasAmount = Boolean(mapping.amount || mapping.debit || mapping.credit);
  return hasDate && hasLabel && hasAmount;
}

/* ------------------------------------------------------------------ */
/* Catégorisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Reconnaissance des dépenses courantes à partir du libellé bancaire.
 * Les libellés sont normalisés (sans accent, minuscules) avant comparaison.
 */
const CATEGORY_RULES: { category: BankCategory; pattern: RegExp }[] = [
  {
    category: 'taxes',
    pattern: /\b(urssaf|dgfip|impot|impots|tresor public|finances publiques|tva|taxe|cfe|cotisation fonciere|rsi|cipav|net entreprises)\b/,
  },
  { category: 'payroll', pattern: /\b(salaire|salaires|paie|paye|remuneration|bulletin de paie|acompte sur salaire)\b/ },
  {
    category: 'fuel',
    pattern: /\b(totalenergies|total energies|total acces|esso|shell|avia|intermarche carburant|carburant|gazole|gasoil|sp95|sp98|station service|peage|autoroute|vinci autoroutes|aprr|sanef|cofiroute|ulys)\b/,
  },
  {
    category: 'bankFees',
    pattern: /\b(frais bancaires|frais de tenue|frais sur|commission|commissions|cotisation carte|cotisation mensuelle|agios|interets debiteurs|tenue de compte|frais d intervention)\b/,
  },
  {
    category: 'insurance',
    pattern: /\b(assurance|assurances|axa|maaf|macif|matmut|groupama|allianz|generali|swisslife|mutuelle|harmonie mutuelle|mma)\b/,
  },
  { category: 'rent', pattern: /\b(loyer|loyers|bail|credit bail|creditbail|leasing|location immobiliere|scpi|sci)\b/ },
  {
    category: 'utilities',
    pattern: /\b(edf|engie|total direct energie|orange|sfr|bouygues telecom|free mobile|free sas|veolia|saur|suez|electricite|telecom|abonnement internet|sosh)\b/,
  },
  {
    category: 'transfer',
    pattern: /\b(virement interne|vir interne|compte a compte|vers livret|livret a|compte epargne|epargne|transfert interne)\b/,
  },
  {
    category: 'suppliers',
    pattern: /\b(metro|promocash|transgourmet|brake|davigel|pomona|sysco|france frais|even|relais d or|fournisseur|achat|amazon|leroy merlin|castorama|bricomarche)\b/,
  },
];

/**
 * Devine la catégorie d'une opération. À défaut de règle, un encaissement est
 * considéré comme une vente et un décaissement reste à classer.
 */
export function categorizeLabel(label: string, amount: number): BankCategory {
  const n = normalize(label);
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(n)) {
      // Un « virement » entrant reste une vente même si le libellé cite un
      // fournisseur connu (remboursement, avoir…) : seules les sorties
      // héritent des catégories de dépense.
      if (amount > 0 && rule.category !== 'transfer' && rule.category !== 'sales') continue;
      return rule.category;
    }
  }
  return amount > 0 ? 'sales' : 'other';
}

/* ------------------------------------------------------------------ */
/* Dédoublonnage                                                        */
/* ------------------------------------------------------------------ */

/**
 * Empreinte stable d'une opération. Le rang d'occurrence distingue deux
 * opérations réellement identiques le même jour (deux paiements CB du même
 * montant au même endroit) sans jamais confondre un ré-import avec un ajout :
 * un même fichier réimporté recalcule exactement les mêmes rangs.
 */
export function transactionFingerprint(
  date: string,
  amount: number,
  label: string,
  occurrence: number,
): string {
  const key = `${date}|${amount.toFixed(2)}|${normalize(label)}|${occurrence}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * Longueur minimale du libellé le plus court pour oser rapprocher deux
 * variantes. En dessous, le texte ne porte pas assez de signal.
 */
const MIN_PREFIX_LENGTH = 12;
/** Et au moins trois mots : « cb carrefour » ne distingue pas deux achats. */
const MIN_PREFIX_WORDS = 3;

/**
 * Deux libellés qui désignent la même opération bancaire.
 *
 * Une banque n'écrit pas le même texte d'un export à l'autre : le relevé
 * mensuel tronque le motif là où l'export annuel le donne en entier.
 * « VIR INST TIKTAK GARE » et « VIR INST TIKTAK GARE LE RESTE FACTURE TIKTAK »
 * sont la même ligne — mais l'affirmer à tort fusionnerait deux virements
 * distincts du même jour et du même montant, ce qui fausserait les comptes en
 * silence. La règle est donc étroite : le plus court doit être **exactement le
 * début** du plus long, coupé sur une fin de mot, et porter au moins trois
 * mots. Tout le reste — mots réordonnés, abréviations, libellés voisins —
 * reste deux opérations différentes.
 */
export function sameOperation(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  if (!x || !y) return false;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < MIN_PREFIX_LENGTH) return false;
  if (short.split(' ').length < MIN_PREFIX_WORDS) return false;
  return long.startsWith(`${short} `);
}

/** Des deux libellés, celui qui en dit le plus. */
export function richerLabel(current: string, candidate: string): string {
  return normalize(candidate).length > normalize(current).length ? candidate : current;
}

/* ------------------------------------------------------------------ */
/* Rapprochement facture ↔ opération                                    */
/* ------------------------------------------------------------------ */

/** Note à partir de laquelle un rapprochement se fait sans confirmation. */
export const ACCEPT_SCORE = 0.75;
/** Écart minimum avec le deuxième candidat pour lever toute ambiguïté. */
export const ACCEPT_MARGIN = 0.1;

export interface MatchableTransaction {
  date: string;
  label: string;
  amount: number;
}

export interface MatchableDocument {
  kind: string;
  number: string;
  date: string;
  totalTTC: number;
  status: string;
}

/**
 * Évalue la ressemblance entre une opération bancaire et une pièce comptable.
 * Renvoie `null` quand la pièce n'est pas un candidat crédible.
 *
 * Les noms du client sont passés en paramètre (nom, raison sociale, alias, nom
 * lu sur le document) pour que la fonction reste pure et testable.
 */
export function scoreDocumentMatch(
  tx: MatchableTransaction,
  doc: MatchableDocument,
  clientNames: string[] = [],
): { score: number; reasons: string[] } | null {
  if (doc.status === 'cancelled') return null;
  // Un encaissement se rapproche d'une facture, un décaissement d'un avoir.
  if (doc.kind !== (tx.amount > 0 ? 'invoice' : 'credit')) return null;

  const target = Math.abs(doc.totalTTC);
  const paid = Math.abs(tx.amount);
  if (target <= 0) return null;

  const label = normalize(tx.label);
  const labelKey = label.replace(/\s/g, '');
  const reasons: string[] = [];
  let score = 0;

  // 1) Numéro de pièce cité dans le libellé : le signal le plus fort.
  const numberKey = normalize(doc.number).replace(/\s/g, '');
  const digits = numberKey.replace(/\D/g, '');
  const numberHit =
    (numberKey.length >= 4 && labelKey.includes(numberKey)) ||
    (digits.length >= 4 && labelKey.includes(digits));
  if (numberHit) {
    score += 0.45;
    reasons.push(`n° ${doc.number} cité`);
  }

  // 2) Montant.
  const diff = Math.abs(paid - target);
  const ratio = diff / target;
  if (diff <= 0.01) {
    score += 0.55;
    reasons.push('montant exact');
  } else if (ratio <= 0.01) {
    score += 0.4;
    reasons.push('montant à 1 % près');
  } else if (ratio <= 0.05) {
    score += 0.18;
    reasons.push('montant proche');
  } else if (!numberHit) {
    // Ni numéro cité ni montant cohérent : ce n'est pas un candidat.
    return null;
  }

  // 3) Nom du client présent dans le libellé bancaire.
  let bestName = 0;
  for (const name of clientNames) {
    if (!name?.trim()) continue;
    const parts = tokens(name).filter((t) => t.length >= 4);
    if (!parts.length) continue;
    bestName = Math.max(bestName, parts.filter((t) => label.includes(t)).length / parts.length);
  }
  if (bestName >= 0.5) {
    score += 0.3 * bestName;
    reasons.push('nom du client reconnu');
  }

  // 4) Cohérence des dates : on encaisse après avoir facturé.
  if (doc.date && tx.date) {
    const delay = (Date.parse(tx.date) - Date.parse(doc.date)) / 86_400_000;
    if (delay >= -3 && delay <= 120) score += 0.12;
    else if (delay < -3) score -= 0.25; // encaissement antérieur à la facture
  }

  if (score <= 0) return null;
  return { score: round2(Math.min(1, score)), reasons };
}

/* ------------------------------------------------------------------ */
/* Lecture du tableau                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedTransaction {
  date: string;
  valueDate?: string;
  label: string;
  amount: number;
  balance?: number;
  reference?: string;
  account?: string;
  category: BankCategory;
  fingerprint: string;
}

export interface StatementParseResult {
  transactions: ParsedTransaction[];
  headers: string[];
  mapping: Record<string, string>;
  warnings: string[];
  /** Lignes ignorées (en-têtes répétées, totaux, lignes vides…). */
  skipped: number;
}

/** Une ligne « Total », « Solde initial »… n'est pas une opération. */
const NON_TRANSACTION = /^(total|totaux|solde (initial|final|precedent|de depart|au)|report|nouveau solde|ancien solde|sous total)/;

export function parseStatementTable(table: Table): StatementParseResult {
  const mapping = guessMapping(table.headers, STATEMENT_FIELDS);
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  let skipped = 0;

  const value = (row: Record<string, string>, field: string): string | undefined => {
    const column = mapping[field];
    if (!column) return undefined;
    const v = row[column];
    return v && v.trim() ? v.trim() : undefined;
  };

  if (!mapping.date && !mapping.valueDate) {
    return {
      transactions: [],
      headers: table.headers,
      mapping,
      warnings: [`Aucune colonne de date identifiée. Colonnes du fichier : ${table.headers.join(', ')}.`],
      skipped: table.rows.length,
    };
  }
  if (!mapping.amount && !mapping.debit && !mapping.credit) {
    return {
      transactions: [],
      headers: table.headers,
      mapping,
      warnings: [`Aucune colonne de montant identifiée. Colonnes du fichier : ${table.headers.join(', ')}.`],
      skipped: table.rows.length,
    };
  }
  if (!mapping.label) warnings.push('Aucune colonne de libellé identifiée : les opérations seront peu lisibles.');

  // Compteur d'occurrences : clé date|montant|libellé → nombre déjà vu.
  const seen = new Map<string, number>();

  for (const row of table.rows) {
    const date = parseDate(value(row, 'date')) ?? parseDate(value(row, 'valueDate'));
    const label = (value(row, 'label') ?? '').replace(/\s{2,}/g, ' ').trim();

    if (!date) {
      skipped++;
      continue;
    }
    if (label && NON_TRANSACTION.test(normalize(label))) {
      skipped++;
      continue;
    }

    const amount = resolveAmount(row, mapping, value);
    if (amount === null) {
      skipped++;
      continue;
    }

    const balance = parseNumber(value(row, 'balance'));
    const key = `${date}|${amount.toFixed(2)}|${normalize(label)}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    transactions.push({
      date,
      valueDate: parseDate(value(row, 'valueDate')) ?? undefined,
      label: label || 'Opération sans libellé',
      amount,
      balance: balance ?? undefined,
      reference: value(row, 'reference'),
      account: value(row, 'account'),
      category: categorizeLabel(label, amount),
      fingerprint: transactionFingerprint(date, amount, label, occurrence),
    });
  }

  if (!transactions.length && table.rows.length) {
    warnings.push('Aucune opération exploitable : vérifiez que le fichier est bien un relevé de compte.');
  }

  return { transactions, headers: table.headers, mapping, warnings, skipped };
}

/**
 * Reconstitue le montant signé, quel que soit le gabarit de la banque :
 * colonne unique signée, colonnes Débit/Crédit séparées, ou montant positif
 * accompagné d'une colonne de sens (D/C).
 */
function resolveAmount(
  row: Record<string, string>,
  mapping: Record<string, string>,
  value: (row: Record<string, string>, field: string) => string | undefined,
): number | null {
  const debit = mapping.debit ? parseNumber(value(row, 'debit')) : null;
  const credit = mapping.credit ? parseNumber(value(row, 'credit')) : null;

  // Colonnes séparées : une seule des deux est renseignée par ligne.
  if (debit !== null && debit !== 0) return round2(-Math.abs(debit));
  if (credit !== null && credit !== 0) return round2(Math.abs(credit));

  const raw = parseNumber(value(row, 'amount'));
  if (raw === null) {
    // Débit et crédit présents mais tous deux à zéro : opération neutre.
    if (debit === 0 || credit === 0) return 0;
    return null;
  }

  const direction = normalize(value(row, 'direction') ?? '');
  if (direction) {
    // « D », « Débit », « -1 » → sortie ; « C », « Crédit » → entrée.
    if (/^(d|debit|dt|dr|sortie|-)/.test(direction)) return round2(-Math.abs(raw));
    if (/^(c|credit|ct|cr|entree|\+)/.test(direction)) return round2(Math.abs(raw));
  }
  return round2(raw);
}
