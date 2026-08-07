import fsp from 'node:fs/promises';
import path from 'node:path';
import { normalize } from './text';

export interface Table {
  headers: string[];
  rows: Record<string, string>[];
  source: 'csv' | 'xlsx';
  delimiter?: string;
  encoding?: string;
}

/* ------------------------------------------------------------------ */
/* Décodage                                                             */
/* ------------------------------------------------------------------ */

/** Décode un buffer texte : UTF-8 si valide, sinon Windows-1252 (exports FR). */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
    } catch {
      return { text: buf.toString('latin1'), encoding: 'latin1' };
    }
  }
}

/* ------------------------------------------------------------------ */
/* CSV                                                                  */
/* ------------------------------------------------------------------ */

/** Détecte le séparateur en comparant la régularité du découpage des 1res lignes. */
export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  if (!sample.length) return ',';
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = sample.map((l) => splitCsvLine(l, d).length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 10 + Math.min(first, 20) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parseur CSV conforme RFC 4180 : gère les guillemets et les retours à la ligne dans les cellules. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' && cur === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* ------------------------------------------------------------------ */
/* Lecture générique                                                    */
/* ------------------------------------------------------------------ */

/** Une cellule qui contient une date ou un montant : c'est une donnée, pas un titre de colonne. */
function looksLikeData(cell: string): boolean {
  if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/.test(cell)) return true;
  const compact = cell.replace(/[\s  ]/g, '').replace(/[€$]/g, '');
  return compact !== '' && /^-?\d+([.,]\d+)?$/.test(compact);
}

/**
 * Cherche la ligne d'en-tête au début du fichier.
 *
 * Beaucoup d'exports bancaires et comptables commencent par un bloc de titre —
 * nom du compte, RIB, solde initial — avant le vrai en-tête. Prendre
 * aveuglément la première ligne donne alors des colonnes qui ne veulent rien
 * dire, et l'import échoue sans que l'utilisateur puisse y remédier.
 *
 * Deux signaux suffisent en pratique :
 *
 * - une ligne de titre étalée sur des cellules fusionnées **répète la même
 *   valeur** dans chaque colonne, là où un en-tête a des libellés distincts ;
 * - un en-tête ne contient ni dates ni montants, contrairement aux données.
 *
 * À qualité égale la première ligne l'emporte : c'est de loin le cas courant,
 * et les fichiers déjà importés doivent continuer de l'être à l'identique.
 */
function findHeaderRow(matrix: unknown[][], limit = 25): number {
  let best = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < Math.min(limit, matrix.length); i++) {
    const filled = (matrix[i] ?? [])
      .map((c) => String(c ?? '').trim())
      .filter((c) => c !== '');
    if (filled.length < 2) continue;

    const distinct = new Set(filled).size;
    // Une seule valeur répétée : c'est un titre sur cellules fusionnées.
    if (distinct < 2) continue;

    const dataLike = filled.filter(looksLikeData).length;
    const score = distinct * 2 + filled.length - dataLike * 4 - i * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Découpe une matrice en en-tête + lignes, à partir de la ligne d'en-tête trouvée. */
function toTable(matrix: unknown[][]): { headers: string[]; rows: Record<string, string>[] } {
  const headerRow = findHeaderRow(matrix);
  const headers = dedupeHeaders((matrix[headerRow] ?? []).map((c) => String(c ?? '')));
  const rows = matrix.slice(headerRow + 1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = String(r?.[i] ?? '').trim();
    });
    return obj;
  });
  return { headers, rows };
}

function dedupeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, idx) => {
    let name = h.trim().replace(/^\uFEFF/, '');
    if (!name) name = `colonne_${idx + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count ? `${name}_${count + 1}` : name;
  });
}

export async function readTable(filePath: string): Promise<Table> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' || ext === '.ods') {
    const XLSX = await import('xlsx');
    const buf = await fsp.readFile(filePath);
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { headers: [], rows: [], source: 'xlsx' };
    const sheet = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
    const cleaned = matrix.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    if (!cleaned.length) return { headers: [], rows: [], source: 'xlsx' };
    return { ...toTable(cleaned), source: 'xlsx' };
  }

  const buf = await fsp.readFile(filePath);
  const { text, encoding } = decodeText(buf);
  const delimiter = sniffDelimiter(text);
  const matrix = parseCsv(text, delimiter);
  if (!matrix.length) return { headers: [], rows: [], source: 'csv', delimiter, encoding };
  return { ...toTable(matrix), source: 'csv', delimiter, encoding };
}

/* ------------------------------------------------------------------ */
/* Correspondance de colonnes                                           */
/* ------------------------------------------------------------------ */

export type FieldDictionary = Record<string, string[]>;

/**
 * Associe chaque champ cible à la colonne du fichier qui lui correspond.
 * Les synonymes sont comparés après normalisation (sans accents ni ponctuation).
 */
export function guessMapping(headers: string[], dictionary: FieldDictionary): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalize(h) }));

  // 1) Correspondance exacte, 2) préfixe, 3) inclusion — dans cet ordre de priorité.
  for (const pass of ['exact', 'prefix', 'includes'] as const) {
    for (const [field, synonyms] of Object.entries(dictionary)) {
      if (mapping[field]) continue;
      for (const syn of synonyms) {
        const ns = normalize(syn);
        const hit = normalizedHeaders.find((h) => {
          if (used.has(h.raw)) return false;
          if (pass === 'exact') return h.norm === ns;
          if (pass === 'prefix') return h.norm.startsWith(ns) || ns.startsWith(h.norm);
          return h.norm.includes(ns) || ns.includes(h.norm);
        });
        if (hit) {
          mapping[field] = hit.raw;
          used.add(hit.raw);
          break;
        }
      }
    }
  }
  return mapping;
}

export const CLIENT_FIELDS: FieldDictionary = {
  code: ['code client', 'code', 'numero client', 'n client', 'ref client', 'reference client', 'id client', 'id'],
  name: ['nom', 'client', 'raison sociale', 'nom client', 'societe', 'denomination', 'name', 'company', 'intitule'],
  legalName: ['raison sociale complete', 'legal name', 'denomination sociale'],
  contact: ['contact', 'interlocuteur', 'responsable', 'nom contact', 'prenom nom'],
  email: ['email', 'e mail', 'mail', 'courriel', 'adresse email'],
  phone: ['telephone', 'tel', 'phone', 'portable', 'mobile', 'tel fixe', 'numero de telephone'],
  siret: ['siret', 'siren', 'numero siret'],
  vatNumber: ['tva', 'numero tva', 'tva intracommunautaire', 'vat', 'n tva'],
  street: ['adresse', 'adresse 1', 'rue', 'voie', 'adresse ligne 1', 'address', 'street'],
  street2: ['adresse 2', 'complement adresse', 'adresse ligne 2', 'complement'],
  postcode: ['code postal', 'cp', 'zip', 'postal', 'postcode'],
  city: ['ville', 'commune', 'city', 'localite'],
  country: ['pays', 'country'],
  notes: ['notes', 'commentaire', 'remarque', 'observation', 'note'],
  tags: ['tags', 'categorie', 'famille', 'type client', 'segment'],
};

export const PRODUCT_FIELDS: FieldDictionary = {
  sku: ['reference', 'ref', 'code article', 'code', 'sku', 'code produit', 'ean', 'article'],
  name: ['designation', 'libelle', 'nom', 'produit', 'description', 'intitule', 'name'],
  category: ['categorie', 'famille', 'rayon', 'type', 'groupe'],
  unit: ['unite', 'conditionnement', 'uv', 'unit', 'cond'],
  qtyOnHand: ['stock', 'quantite', 'qte', 'stock actuel', 'quantite en stock', 'qte stock', 'disponible'],
  minQty: ['stock mini', 'seuil', 'stock minimum', 'alerte', 'seuil alerte', 'mini', 'stock alerte'],
  unitCost: ['prix achat', 'cout', 'prix unitaire', 'pu', 'prix', 'cout unitaire', 'pa'],
  supplier: ['fournisseur', 'supplier', 'marque'],
  aliases: ['alias', 'synonymes', 'autres libelles', 'libelles factures'],
};

export const DOCUMENT_FIELDS: FieldDictionary = {
  number: ['numero', 'n facture', 'numero facture', 'numero piece', 'num piece', 'piece', 'reference', 'n document', 'numero document', 'no'],
  kind: ['type', 'type piece', 'nature', 'type document'],
  date: ['date', 'date facture', 'date piece', 'date emission'],
  dueDate: ['echeance', 'date echeance', 'date limite'],
  clientName: ['client', 'nom client', 'tiers', 'raison sociale', 'compte tiers', 'destinataire'],
  clientCode: ['code client', 'code tiers', 'compte'],
  totalHT: ['total ht', 'montant ht', 'ht', 'base ht'],
  totalVAT: ['tva', 'montant tva', 'total tva'],
  totalTTC: ['total ttc', 'montant ttc', 'ttc', 'net a payer', 'total'],
  status: ['statut', 'etat', 'regle', 'paye'],
  lineRef: ['reference article', 'ref article', 'code article', 'ref produit', 'article'],
  lineLabel: ['designation', 'libelle', 'description', 'produit', 'intitule ligne'],
  lineQty: ['quantite', 'qte', 'qty', 'nombre'],
  lineUnit: ['unite', 'conditionnement'],
  lineUnitPrice: ['prix unitaire', 'pu ht', 'pu', 'prix'],
  lineTotal: ['montant ligne', 'total ligne', 'montant', 'total ht ligne'],
};
