import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AccountingDocument,
  Client,
  DocumentKind,
  DocumentLine,
  ID,
  ScanReport,
} from '@shared/types';
import { newId, nowIso, store, today } from '../store';
import { extractPdf } from './pdf';
import { parsePdfDocument, type ParsedDocument, type ParsedLine } from './parseInvoice';
import { parseEInvoiceXml, pickEInvoiceAttachment, looksLikeEInvoice } from './facturx';
import { DOCUMENT_FIELDS, guessMapping, readTable } from './tabular';
import { normalize, parseDate, parseNumber, round2 } from './text';
import {
  createClientFromDocument,
  fillClientContact,
  matchClient,
  rememberClientAlias,
} from './clients';
import { recomputeProductQty } from './stock';
import { applyDocumentToStock, resolveDocumentLines } from './stock';
import { storePath } from './paths';
import { announce } from './activity';

/* ------------------------------------------------------------------ */
/* Dossier surveillé                                                    */
/* ------------------------------------------------------------------ */

export const SUBFOLDERS = ['Factures', 'Devis', 'Avoirs', 'Clients', 'Releves', 'Pieces-jointes', 'Exports'] as const;

/**
 * Où ranger une pièce dont on connaît déjà le type.
 *
 * Un poste qui surveille ses propres dossiers sait ce qu'il envoie : le fichier
 * vient de *son* dossier « Factures ». Sans cette table, tout atterrirait en
 * vrac à la racine du dossier surveillé et le type serait redevinné du contenu
 * — en perdant en route un classement que l'utilisateur avait déjà fait.
 */
export const KIND_FOLDER: Record<DocumentKind, string> = {
  invoice: 'Factures',
  quote: 'Devis',
  credit: 'Avoirs',
};

/** Crée le dossier de travail et ses sous-dossiers s'ils n'existent pas. */
export function ensureWatchFolder(folder: string): string {
  fs.mkdirSync(folder, { recursive: true });
  for (const sub of SUBFOLDERS) fs.mkdirSync(path.join(folder, sub), { recursive: true });

  const readme = path.join(folder, 'LISEZ-MOI.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        'CompaGelato — dossier de travail',
        '================================',
        '',
        'Déposez ici les fichiers produits par votre logiciel de comptabilité :',
        '',
        '  Factures\\   vos factures (PDF, Factur-X, XML, CSV, Excel)',
        '  Devis\\      vos devis',
        '  Avoirs\\     vos avoirs',
        '  Clients\\    votre liste clients à importer (CSV ou Excel)',
        '  Releves\\    vos relevés de compte exportés par la banque (CSV ou Excel)',
        '  Pieces-jointes\\  flyers et plaquettes à joindre à vos envois par e-mail',
        '  Exports\\    les fichiers exportés depuis CompaGelato',
        '',
        'Le logiciel surveille ce dossier en permanence : tout nouveau fichier est',
        'analysé et ajouté automatiquement aux tableaux. Les fichiers d’origine ne',
        'sont jamais modifiés ni déplacés.',
        '',
        'Formats lus : PDF (y compris Factur-X/ZUGFeRD), XML (Factur-X, UBL/Chorus),',
        'CSV et Excel (.xlsx).',
        '',
      ].join('\r\n'),
      'utf8',
    );
  }
  return folder;
}

export const DOC_EXTENSIONS = new Set(['.pdf', '.xml', '.csv', '.xlsx', '.xls', '.xlsm']);
const IGNORED_DIRS = new Set([
  // « Releves » a son propre lecteur (services/bank.ts) : un relevé de compte
  // n'est pas une pièce comptable à rapprocher du stock.
  'clients', 'releves', 'exports', 'archive', 'corbeille', 'pieces jointes', '.git', 'node modules',
]);

interface FoundFile {
  filePath: string;
  mtimeMs: number;
  size: number;
  folderHint: DocumentKind | null;
}

function folderHint(relative: string): DocumentKind | null {
  const first = normalize(relative.split(path.sep)[0] ?? '');
  if (first.startsWith('devis')) return 'quote';
  if (first.startsWith('avoir')) return 'credit';
  if (first.startsWith('facture')) return 'invoice';
  return null;
}

/** Parcourt récursivement le dossier surveillé. */
export async function listCandidateFiles(folder: string): Promise<FoundFile[]> {
  const out: FoundFile[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(normalize(entry.name))) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('~$') || entry.name.startsWith('.')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!DOC_EXTENSIONS.has(ext)) continue;
      try {
        const stat = await fsp.stat(full);
        out.push({
          filePath: full,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          folderHint: folderHint(path.relative(folder, full)),
        });
      } catch {
        continue;
      }
    }
  };

  await walk(folder, 0);
  return out;
}

async function hashFile(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Conversion ParsedDocument → AccountingDocument                       */
/* ------------------------------------------------------------------ */

function toLines(parsed: ParsedLine[]): DocumentLine[] {
  return parsed.map((l) => ({
    id: newId('lin'),
    ref: l.ref,
    label: l.label,
    qty: Number.isFinite(l.qty) ? l.qty : 1,
    unit: l.unit,
    unitPriceHT: l.unitPriceHT,
    totalHT: l.totalHT,
    vatRate: l.vatRate,
    matchMethod: 'none' as const,
  }));
}

/**
 * Cherche, dans le texte d'un document, le nom d'un client déjà enregistré.
 * On retient la correspondance la plus longue : « Camping Les Ajoncs » l'emporte
 * sur « Camping ». Les noms trop courts sont écartés (risque de faux positif).
 */
function findClientInText(text: string): Client | null {
  const haystack = normalize(text);
  if (!haystack) return null;
  let best: { client: Client; length: number } | null = null;

  for (const client of store.db.clients) {
    if (client.archived) continue;
    const candidates = [client.name, client.legalName, ...client.aliases].filter(
      (c): c is string => Boolean(c),
    );
    for (const candidate of candidates) {
      const needle = normalize(candidate);
      if (needle.length < 6) continue;
      if (!haystack.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { client, length: needle.length };
    }
  }
  return best?.client ?? null;
}

interface IngestContext {
  filePath?: string;
  sourceFormat: AccountingDocument['sourceFormat'];
  sourceHash?: string;
  sourceMtime?: number;
  kindHint?: DocumentKind | null;
}

/**
 * Champs qu'une relecture du fichier d'origine ne doit pas écraser dès lors
 * qu'ils ont été corrigés à la main. Les totaux en font partie : le lecteur se
 * trompe parfois sur un gabarit inhabituel, et la correction doit tenir.
 */
export const MANUAL_FIELDS = [
  'kind', 'number', 'date', 'dueDate', 'clientId',
  'totalHT', 'totalVAT', 'totalTTC', 'status', 'notes',
] as const;

export type ManualField = (typeof MANUAL_FIELDS)[number];

/** Note qu'un champ vient d'une saisie manuelle et non du lecteur automatique. */
export function markManual(doc: AccountingDocument, ...fields: ManualField[]): void {
  const set = new Set(doc.manualFields ?? []);
  for (const field of fields) set.add(field);
  doc.manualFields = [...set];
}

/**
 * Statut déduit de la lecture du fichier.
 *
 * Un devis n'est jamais définitif, une « facture brouillon » non plus : elle
 * tient lieu de proforma et la vraie facture suit, si bien qu'une pièce
 * provisoire comptée comme définitive ferait apparaître la vente deux fois.
 *
 * On recalcule ce statut à chaque relecture plutôt que de conserver l'ancien :
 * c'est ce qui permet de rattraper les pièces importées avant que le lecteur
 * ne sache reconnaître les brouillons. Deux garde-fous : un statut choisi à la
 * main est réappliqué juste après (il figure dans `manualFields`), et une pièce
 * dont le stock est déjà sorti garde le sien — le mouvement, lui, a bien eu
 * lieu, et le rétropédaler dans le dos de l'utilisateur serait pire.
 */
function autoStatus(
  parsed: ParsedDocument,
  kind: DocumentKind,
  existing: AccountingDocument | undefined,
): AccountingDocument['status'] {
  if (existing?.stockApplied) return existing.status;
  return parsed.draft || kind === 'quote' ? 'draft' : 'confirmed';
}

/**
 * Transforme un document analysé en enregistrement de la base : rattachement
 * du client, association des lignes au stock, contrôle des doublons.
 */
export function ingestParsedDocument(parsed: ParsedDocument, ctx: IngestContext): AccountingDocument {
  const settings = store.settings;
  const kind = ctx.kindHint ?? parsed.kind;

  // Un même numéro de pièce ne doit exister qu'une fois.
  const existing = store.db.documents.find(
    (d) =>
      (ctx.sourceHash && d.sourceHash === ctx.sourceHash) ||
      (normalize(d.number) === normalize(parsed.number) && d.kind === kind && parsed.number !== 'SANS-NUMERO'),
  );

  const warnings = [...parsed.warnings];

  /* Client -------------------------------------------------------- */
  let clientId: ID | undefined = existing?.clientId;
  if (!clientId) {
    const match = matchClient(store.db.clients, parsed.clientName, parsed.clientSiret);
    if (match) {
      clientId = match.client.id;
      if (match.method === 'fuzzy') {
        rememberClientAlias(match.client.id, parsed.clientName);
        warnings.push(`Client rapproché par ressemblance (${Math.round(match.score * 100)} %) — à confirmer.`);
      }
    }
  }
  // Beaucoup de factures n'écrivent pas « Client : » : le nom figure seul dans
  // un bloc d'adresse. On cherche alors un client connu dans le texte du document.
  if (!clientId && parsed.sourceText) {
    const found = findClientInText(parsed.sourceText);
    if (found) {
      clientId = found.id;
      warnings.push('Client reconnu à partir de son nom présent sur le document.');
    }
  }
  if (!clientId && parsed.clientName && settings.autoCreateClients) {
    clientId = createClientFromDocument(
      parsed.clientName,
      parsed.clientAddress,
      parsed.clientSiret,
      parsed.clientEmail,
      parsed.clientPhone,
      parsed.clientContact,
    ).id;
    warnings.push('Nouvelle fiche client créée automatiquement.');
  } else if (clientId) {
    // Fiche déjà connue : on complète l'e-mail / le téléphone s'ils manquaient,
    // sans jamais écraser une valeur déjà saisie à la main.
    fillClientContact(clientId, parsed.clientEmail, parsed.clientPhone, parsed.clientContact);
  }

  const totalHT = parsed.totalHT ?? 0;
  const totalVAT = parsed.totalVAT ?? 0;
  const totalTTC = parsed.totalTTC ?? round2(totalHT + totalVAT);

  // Une pièce dont le stock est déjà sorti garde ses lignes : les mouvements
  // enregistrés doivent continuer de correspondre à ce qui a été déduit. Les
  // totaux, eux, suivent le fichier. Si le montant a changé entre-temps — une
  // facture corrigée, un brouillon devenu définitif —, la pièce afficherait
  // donc un montant qui ne correspond plus à la marchandise sortie, sans que
  // rien ne le signale. On le signale.
  const totalChanged =
    !!existing?.stockApplied &&
    !existing.manualFields?.includes('totalHT') &&
    round2(totalHT) !== round2(existing.totalHT);
  if (totalChanged && existing) {
    warnings.push(
      `Montant modifié après la déduction du stock : ${existing.totalHT.toFixed(2)} € → ` +
        `${round2(totalHT).toFixed(2)} € HT. Les quantités déduites sont restées celles de la ` +
        'version précédente — annulez la déduction puis refaites-la pour que le stock suive.',
    );
  }

  const doc: AccountingDocument = {
    id: existing?.id ?? newId('doc'),
    kind,
    number: parsed.number,
    date: parsed.date ?? existing?.date ?? today(),
    dueDate: parsed.dueDate ?? undefined,
    clientId,
    clientNameRaw: parsed.clientName ?? undefined,
    currency: parsed.currency || settings.currency,
    totalHT: round2(totalHT),
    totalVAT: round2(totalVAT),
    totalTTC: round2(totalTTC),
    status: autoStatus(parsed, kind, existing),
    lines: existing && existing.stockApplied ? existing.lines : toLines(parsed.lines),
    sourceFile: ctx.filePath ? storePath(ctx.filePath) : existing?.sourceFile,
    sourceFormat: ctx.sourceFormat,
    sourceHash: ctx.sourceHash ?? existing?.sourceHash,
    sourceMtime: ctx.sourceMtime ?? existing?.sourceMtime,
    stockApplied: existing?.stockApplied ?? false,
    stockAppliedAt: existing?.stockAppliedAt,
    // Les repères d'impression et d'envoi appartiennent à l'utilisateur, pas au
    // fichier : une relecture ne doit pas les effacer.
    printedAt: existing?.printedAt,
    emailedAt: existing?.emailedAt,
    confidence: parsed.confidence,
    warnings,
    manualFields: existing?.manualFields,
    notes: existing?.notes,
    importedAt: existing?.importedAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  // Les corrections saisies à la main l'emportent sur ce que relit le lecteur.
  if (existing?.manualFields?.length) {
    const kept = MANUAL_FIELDS.filter((field) => existing.manualFields?.includes(field));
    Object.assign(doc, Object.fromEntries(kept.map((field) => [field, existing[field]])));
  }

  // Conserve les associations validées manuellement lors d'un ré-import.
  if (existing && !existing.stockApplied) {
    for (const line of doc.lines) {
      const previous = existing.lines.find(
        (l) => normalize(l.label) === normalize(line.label) && (l.ref ?? '') === (line.ref ?? ''),
      );
      if (previous?.matchMethod === 'manual') {
        line.productId = previous.productId;
        line.matchMethod = 'manual';
        line.matchScore = 1;
      }
    }
  }

  resolveDocumentLines(doc);

  store.mutate((db) => {
    const index = db.documents.findIndex((d) => d.id === doc.id);
    if (index >= 0) db.documents[index] = doc;
    else db.documents.unshift(doc);
  });

  if (settings.autoApplyStock && !doc.stockApplied && doc.kind !== 'quote' && doc.status !== 'draft') {
    applyDocumentToStock(doc.id);
  }

  return doc;
}

/* ------------------------------------------------------------------ */
/* Lecture d'un fichier                                                 */
/* ------------------------------------------------------------------ */

/** Analyse un fichier unique et renvoie les documents qu'il contient. */
export async function parseFile(
  filePath: string,
  kindHint: DocumentKind | null = null,
): Promise<{ parsed: ParsedDocument; format: AccountingDocument['sourceFormat'] }[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    const extract = await extractPdf(filePath);
    // Une facture Factur-X embarque le XML : bien plus fiable que la lecture visuelle.
    const attachment = pickEInvoiceAttachment(extract.attachments);
    if (attachment) {
      const parsed = parseEInvoiceXml(attachment.xml);
      if (parsed) {
        parsed.warnings.push(`Données lues dans la pièce jointe Factur-X « ${attachment.name} ».`);
        return [{ parsed, format: 'facturx' }];
      }
    }
    return [{ parsed: parsePdfDocument(extract, filePath), format: 'pdf' }];
  }

  if (ext === '.xml') {
    const xml = await fsp.readFile(filePath, 'utf8');
    if (!looksLikeEInvoice(xml)) throw new Error('Fichier XML non reconnu comme facture électronique.');
    const parsed = parseEInvoiceXml(xml);
    if (!parsed) throw new Error('Fichier XML illisible.');
    return [{ parsed, format: 'xml' }];
  }

  if (ext === '.csv' || ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
    const parsedDocs = await parseTabularDocuments(filePath, kindHint);
    return parsedDocs.map((parsed) => ({
      parsed,
      format: ext === '.csv' ? ('csv' as const) : ('xlsx' as const),
    }));
  }

  throw new Error(`Format non pris en charge : ${ext}`);
}

/**
 * Lit un journal de ventes exporté en CSV/Excel.
 * Deux dispositions sont acceptées : une ligne par pièce, ou une ligne par
 * article (les lignes sont alors regroupées par numéro de pièce).
 */
export async function parseTabularDocuments(
  filePath: string,
  kindHint: DocumentKind | null,
): Promise<ParsedDocument[]> {
  const table = await readTable(filePath);
  if (!table.rows.length) throw new Error('Fichier vide.');

  const mapping = guessMapping(table.headers, DOCUMENT_FIELDS);
  if (!mapping.number && !mapping.date) {
    throw new Error(
      `Colonnes non reconnues (ni numéro ni date). Colonnes trouvées : ${table.headers.join(', ')}.`,
    );
  }

  const get = (row: Record<string, string>, field: string): string | undefined => {
    const col = mapping[field];
    if (!col) return undefined;
    const v = row[col];
    return v && v.trim() ? v.trim() : undefined;
  };

  const hasLineDetail = Boolean(mapping.lineLabel || mapping.lineQty || mapping.lineRef);
  const groups = new Map<string, Record<string, string>[]>();

  for (const [index, row] of table.rows.entries()) {
    const number = get(row, 'number') ?? `${path.basename(filePath)}#${index + 1}`;
    const list = groups.get(number) ?? [];
    list.push(row);
    groups.set(number, list);
  }

  const documents: ParsedDocument[] = [];
  for (const [number, rows] of groups) {
    const head = rows[0];
    const warnings: string[] = [];

    const kindRaw = normalize(get(head, 'kind') ?? '');
    let kind: DocumentKind = kindHint ?? 'invoice';
    if (kindRaw.includes('devis') || kindRaw.includes('proforma')) kind = 'quote';
    else if (kindRaw.includes('avoir')) kind = 'credit';
    else if (kindRaw.includes('facture')) kind = 'invoice';

    const lines: ParsedLine[] = hasLineDetail
      ? rows
          .map((row): ParsedLine | null => {
            const label = get(row, 'lineLabel') ?? get(row, 'lineRef') ?? '';
            if (!label) return null;
            const qty = parseNumber(get(row, 'lineQty')) ?? 1;
            const unitPrice = parseNumber(get(row, 'lineUnitPrice')) ?? undefined;
            const total = parseNumber(get(row, 'lineTotal')) ?? undefined;
            return {
              ref: get(row, 'lineRef'),
              label,
              qty,
              unit: get(row, 'lineUnit'),
              unitPriceHT: unitPrice,
              totalHT: total ?? (unitPrice !== undefined ? round2(unitPrice * qty) : undefined),
            };
          })
          .filter((l): l is ParsedLine => l !== null)
      : [];

    if (!hasLineDetail) warnings.push('Fichier sans détail de lignes : le stock ne peut pas être déduit.');

    const totalHT = parseNumber(get(head, 'totalHT'));
    const totalVAT = parseNumber(get(head, 'totalVAT'));
    let totalTTC = parseNumber(get(head, 'totalTTC'));
    if (totalTTC === null && totalHT !== null) totalTTC = round2(totalHT + (totalVAT ?? 0));

    const statusRaw = normalize(get(head, 'status') ?? '');

    documents.push({
      kind,
      // Une ligne de journal de ventes décrit une pièce déjà émise : le
      // caractère provisoire, lui, se lit sur le document lui-même.
      draft: false,
      number,
      date: parseDate(get(head, 'date')),
      dueDate: parseDate(get(head, 'dueDate')),
      clientName: get(head, 'clientName') ?? null,
      clientAddress: null,
      clientSiret: null,
      clientEmail: null,
      clientPhone: null,
      clientContact: null,
      currency: 'EUR',
      totalHT: totalHT ?? (lines.length ? round2(lines.reduce((s, l) => s + (l.totalHT ?? 0), 0)) : null),
      totalVAT,
      totalTTC,
      lines,
      confidence: 0.9,
      warnings: [
        ...warnings,
        ...(statusRaw.includes('paye') || statusRaw.includes('regle') ? ['Marqué comme réglé dans le fichier.'] : []),
      ],
    });
  }

  return documents;
}

/* ------------------------------------------------------------------ */
/* Scan du dossier                                                      */
/* ------------------------------------------------------------------ */

export interface ScanOptions {
  force?: boolean;
  onProgress?: (payload: { current: number; total: number; file: string }) => void;
}

/**
 * Analyse le dossier surveillé et met à jour la base.
 * Un fichier déjà importé et inchangé (même empreinte) est ignoré.
 */
export async function scanFolder(options: ScanOptions = {}): Promise<ScanReport> {
  const startedAt = Date.now();
  const folder = ensureWatchFolder(store.settings.watchFolder);
  const files = await listCandidateFiles(folder);

  // Les pièces réellement créées par ce passage : c'est ce qui mérite d'être
  // annoncé, à la différence de celles simplement relues.
  const fresh: AccountingDocument[] = [];

  const report: ScanReport = {
    scanned: files.length,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    documents: [],
    errors: [],
    durationMs: 0,
  };

  for (const [index, file] of files.entries()) {
    options.onProgress?.({ current: index + 1, total: files.length, file: path.basename(file.filePath) });

    const stored = storePath(file.filePath);
    const known = store.db.documents.find((d) => d.sourceFile === stored);
    if (!options.force && known && known.sourceMtime === file.mtimeMs) {
      report.skipped++;
      continue;
    }

    try {
      const hash = await hashFile(file.filePath);
      if (!options.force && known && known.sourceHash === hash) {
        // Contenu identique : on rafraîchit seulement l'horodatage.
        store.mutate(() => {
          known.sourceMtime = file.mtimeMs;
        });
        report.skipped++;
        continue;
      }

      const results = await parseFile(file.filePath, file.folderHint);
      for (const { parsed, format } of results) {
        const existed = store.db.documents.some(
          (d) => d.sourceHash === hash || (normalize(d.number) === normalize(parsed.number) && d.kind === parsed.kind),
        );
        const doc = ingestParsedDocument(parsed, {
          filePath: file.filePath,
          sourceFormat: format,
          sourceHash: hash,
          sourceMtime: file.mtimeMs,
          kindHint: file.folderHint,
        });
        report.documents.push(doc);
        if (existed) report.updated++;
        else {
          report.imported++;
          fresh.push(doc);
        }
      }
    } catch (err) {
      report.failed++;
      report.errors.push({ file: path.basename(file.filePath), message: (err as Error).message });
    }
  }

  store.flushSync();
  report.durationMs = Date.now() - startedAt;
  announceImported(fresh);
  return report;
}

/**
 * Une annonce par passage, jamais une par fichier.
 *
 * Le premier import en compte plusieurs centaines : autant de bulles ferait
 * couper les notifications pour de bon, et la seule information utile serait
 * perdue avec elles. Seules les pièces réellement nouvelles comptent — une
 * relecture forcée repasse sur ce qui était déjà là et n'annonce donc rien.
 */
export function announceImported(fresh: AccountingDocument[]): void {
  if (!fresh.length) return;
  if (fresh.length === 1) {
    const doc = fresh[0];
    announce(
      'document',
      `Nouvelle pièce : ${doc.number}`,
      [doc.clientNameRaw, euroLike(doc.totalTTC)].filter(Boolean).join(' — ') ||
        'Arrivée dans le dossier surveillé.',
    );
    return;
  }
  const listed = fresh.slice(0, 4).map((d) => d.number).join(', ');
  announce(
    'document',
    `${fresh.length} nouvelles pièces`,
    fresh.length > 4 ? `${listed}…` : listed,
  );
}

/** « 216,00 € TTC », sans dépendre du formatage de l'interface. */
function euroLike(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return `${value.toFixed(2).replace('.', ',')} € TTC`;
}

/** Ré-analyse un fichier précis (bouton « Relire » de l'interface). */
export async function rescanFile(filePath: string): Promise<AccountingDocument | null> {
  const stat = await fsp.stat(filePath);
  const hash = await hashFile(filePath);
  const folder = store.settings.watchFolder;
  const hint = filePath.startsWith(folder) ? folderHint(path.relative(folder, filePath)) : null;

  const results = await parseFile(filePath, hint);
  let last: AccountingDocument | null = null;
  for (const { parsed, format } of results) {
    last = ingestParsedDocument(parsed, {
      filePath,
      sourceFormat: format,
      sourceHash: hash,
      sourceMtime: stat.mtimeMs,
      kindHint: hint,
    });
  }
  store.flushSync();
  return last;
}

/* ------------------------------------------------------------------ */
/* Écriture manuelle                                                    */
/* ------------------------------------------------------------------ */

export function upsertDocument(input: Partial<AccountingDocument> & { id?: ID }): AccountingDocument {
  return store.mutate((db) => {
    const existing = input.id ? db.documents.find((d) => d.id === input.id) : undefined;
    if (existing) {
      // Tout champ effectivement modifié ici vient de l'utilisateur : on le note
      // pour qu'une relecture du fichier d'origine ne le défasse pas.
      const edited = MANUAL_FIELDS.filter(
        (field) => field in input && (input as Record<string, unknown>)[field] !== existing[field],
      );
      Object.assign(existing, { ...input, updatedAt: nowIso() });
      if (edited.length) markManual(existing, ...edited);
      if (input.lines) resolveDocumentLines(existing);
      return existing;
    }
    const doc: AccountingDocument = {
      id: input.id ?? newId('doc'),
      kind: input.kind ?? 'invoice',
      number: input.number ?? 'SANS-NUMERO',
      date: input.date ?? today(),
      dueDate: input.dueDate,
      clientId: input.clientId,
      clientNameRaw: input.clientNameRaw,
      currency: input.currency ?? store.settings.currency,
      totalHT: input.totalHT ?? 0,
      totalVAT: input.totalVAT ?? 0,
      totalTTC: input.totalTTC ?? 0,
      status: input.status ?? 'confirmed',
      lines: input.lines ?? [],
      sourceFormat: 'manual',
      stockApplied: false,
      confidence: 1,
      warnings: [],
      notes: input.notes,
      importedAt: nowIso(),
      updatedAt: nowIso(),
    };
    resolveDocumentLines(doc);
    db.documents.unshift(doc);
    return doc;
  });
}

export function removeDocument(id: ID): void {
  store.mutate((db) => {
    // Le stock est la somme des mouvements : retirer ceux du document rend la
    // marchandise. Une soustraction manuelle en plus compterait double.
    const affected = new Set(
      db.stockMoves.filter((m) => m.documentId === id).map((m) => m.productId),
    );
    db.stockMoves = db.stockMoves.filter((m) => m.documentId !== id);
    db.documents = db.documents.filter((d) => d.id !== id);
    for (const productId of affected) {
      const product = db.products.find((p) => p.id === productId);
      if (product) recomputeProductQty(product);
    }
  });
}
