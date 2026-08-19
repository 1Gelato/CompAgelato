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
import { looksLikeClientName, normalize, parseDate, parseNumber, round2 } from './text';
import { createClientFromDocument, fillClientContact, matchClient } from './clients';
import { recomputeProductQty } from './stock';
import { applyDocumentToStock, resolveDocumentLines, revertDocumentFromStock } from './stock';
import { resolvePath, storePath } from './paths';
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
      // Un alias qui n'a jamais pu être un nom de client ne doit pas servir à
      // en reconnaître un dans le texte d'une pièce.
      (c): c is string => typeof c === 'string' && looksLikeClientName(c),
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
  /**
   * Le fichier contient plusieurs pièces (journal de ventes CSV/Excel).
   * L'empreinte du fichier ne peut alors PAS servir d'identité : toutes les
   * pièces du journal la partagent, et s'en servir les ferait s'écraser l'une
   * l'autre jusqu'à n'en laisser qu'une. Seul le numéro identifie.
   */
  multiPiece?: boolean;
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
  // Ce que la pièce dit d'elle-même l'emporte sur le dossier d'où elle vient :
  // un dossier de devis déclaré « Factures » ne transforme pas des devis en
  // factures. L'indice du dossier ne sert que lorsque rien n'a pu être lu.
  const kind = parsed.kindSure ? parsed.kind : (ctx.kindHint ?? parsed.kind);

  // Un même numéro de pièce ne doit exister qu'une fois. Deux identités :
  //
  // — le NUMÉRO, à type égal : c'est l'identité comptable ; un devis et une
  //   facture peuvent légitimement partager un numéro dans une numérotation
  //   commune, donc le numéro seul ne franchit jamais la frontière des types ;
  // — le CONTENU (empreinte du fichier), pour les fichiers mono-pièce
  //   seulement : c'est ce qui permet à une pièce dont le type vient d'être
  //   corrigé de se reconnaître elle-même, et à deux copies du même PDF rangées
  //   dans deux sous-dossiers de ne compter qu'une fois. Dans un journal
  //   multi-pièces l'empreinte est commune à tout le fichier : s'en servir
  //   ferait s'écraser les pièces l'une l'autre jusqu'à n'en laisser qu'une.
  //
  // Le chemin du fichier, lui, n'identifie RIEN : un scanner réécrit
  // volontiers « scan.pdf » avec une pièce entièrement nouvelle, et s'y fier
  // faisait disparaître la pièce précédente sous la nouvelle.
  const sameNumber = (d: AccountingDocument) =>
    parsed.number !== 'SANS-NUMERO' && normalize(d.number) === normalize(parsed.number);
  const matches = store.db.documents.filter(
    (d) =>
      (sameNumber(d) && d.kind === kind) ||
      (!ctx.multiPiece && ctx.sourceHash && d.sourceHash === ctx.sourceHash),
  );
  // Laquelle garder quand plusieurs enregistrements désignent la même pièce ?
  // Celle qui porte le travail de l'utilisateur : stock déjà déduit, champs
  // corrigés à la main, repères d'impression ou notes. « La plus ancienne »
  // était un mauvais critère : dans le cas des jumelles nées d'une correction
  // de type, c'est souvent la plus récente que l'utilisateur avait annotée, et
  // la résorption détruisait ses corrections sans un mot.
  const weight = (d: AccountingDocument) =>
    (d.stockApplied ? 4 : 0) +
    (d.manualFields?.length ? 2 : 0) +
    (d.printedAt || d.emailedAt || d.notes ? 1 : 0);
  matches.sort((a, b) => weight(b) - weight(a) || a.importedAt.localeCompare(b.importedAt));
  const existing = matches[0];
  // Les jumelles surnuméraires sont résorbées, en le disant : `removeDocument`
  // rend au stock ce qu'elles avaient sorti, et l'avertissement laisse une
  // trace de la fusion sur la pièce conservée.
  const resorbed = matches.slice(1);
  for (const twin of resorbed) removeDocument(twin.id);

  const warnings = [...parsed.warnings];
  if (resorbed.length) {
    warnings.push(
      `${resorbed.length} enregistrement(s) en double résorbé(s) — leur éventuelle ` +
        'déduction de stock a été rendue.',
    );
  }

  // Le type vient de changer alors que le stock était déjà sorti : les
  // mouvements enregistrés racontent l'ancien type. On rend la marchandise
  // avant de basculer — un devis ne sort rien, un avoir réintègre — plutôt que
  // de laisser un devis porteur d'une sortie de stock invisible, ou un avoir
  // comptant en sortie ce qu'il devrait rendre.
  if (existing?.stockApplied && existing.kind !== kind && !existing.manualFields?.includes('kind')) {
    revertDocumentFromStock(existing.id);
    warnings.push(
      'Type corrigé après la déduction du stock : la déduction a été annulée. ' +
        'Elle sera refaite selon le nouveau type si la déduction automatique est active.',
    );
  }

  /* Client -------------------------------------------------------- */
  // Le client est reconsidéré à chaque lecture. Le conserver tel quel — ce que
  // faisait ce code — rendait tout rattachement définitif : une correction du
  // lecteur ne pouvait plus rien rattraper, et une pièce attribuée au mauvais
  // client le restait pour toujours. Un client choisi à la main l'emporte de
  // toute façon juste après (voir `manualFields`), et si la nouvelle lecture ne
  // reconnaît personne on garde le lien précédent plutôt que de le perdre.
  // Votre entreprise n'est jamais son propre client. Sur une facture que vous
  // RECEVEZ — un transporteur, un fournisseur —, le bloc client porte VOS
  // coordonnées : votre SIRET, votre nom. Sans ce garde-fou, la pièce se
  // rattachait à la fiche de la base qui portait ce SIRET, avec un score
  // parfait, alors que rien dans le document ne désigne ce client-là.
  const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
  const ownSiret = digits(settings.companySiret);
  const receivedInvoice =
    (!!ownSiret && ownSiret.length >= 9 && digits(parsed.clientSiret) === ownSiret) ||
    (!!settings.companyName &&
      !!parsed.clientName &&
      normalize(parsed.clientName) === normalize(settings.companyName));
  if (receivedInvoice) {
    warnings.push(
      'Pièce reçue : le « client » de ce document, c’est vous. Ce n’est pas une ' +
        'vente — elle n’a pas été rattachée à un client.',
    );
  }

  let clientId: ID | undefined;
  if (!receivedInvoice) {
    const match = matchClient(store.db.clients, parsed.clientName, parsed.clientSiret);
    if (match && match.method !== 'fuzzy') {
      // Rattachement CERTAIN seulement : même SIRET, même nom, ou orthographe
      // que l'utilisateur a lui-même confirmée.
      clientId = match.client.id;
    } else if (match) {
      // Ressemblance : une hypothèse, jamais un rattachement. Une pièce dont le
      // nom n'a pas été reconnu doit rester SANS client — la rattacher « au
      // plus proche » attribuait des dizaines de pièces à un client vu deux
      // fois dans l'année, et personne ne pouvait s'en apercevoir. La piste est
      // conservée dans l'avertissement : un clic suffit à la confirmer, et
      // c'est cette confirmation qui apprend l'orthographe.
      warnings.push(
        `Client non reconnu — piste possible : « ${match.client.name} » ` +
          `(${Math.round(match.score * 100)} % de ressemblance). À rattacher à la main.`,
      );
    }
  }
  // Beaucoup de factures n'écrivent pas « Client : » : le nom figure seul dans
  // un bloc d'adresse. On cherche alors un client connu dans le texte du document.
  if (!clientId && !receivedInvoice && parsed.sourceText) {
    const found = findClientInText(parsed.sourceText);
    if (found) {
      clientId = found.id;
      warnings.push('Client reconnu à partir de son nom présent sur le document.');
    }
  }
  // Rien de reconnu. Garder le lien précédent n'a de sens que s'il repose sur
  // la MÊME lecture : c'est le cas d'une fiche renommée — le nom lu n'a pas
  // bougé, seule la fiche a changé d'intitulé, et recréer une fiche au nom lu
  // fabriquerait un doublon.
  //
  // Mais quand le nom lu a changé, l'ancien lien reposait sur autre chose —
  // typiquement une lecture erronée, désormais corrigée. Le conserver figerait
  // l'erreur pour toujours : c'est ce qui faisait survivre un mauvais client à
  // toutes les relectures, y compris forcées.
  if (!clientId && !receivedInvoice && existing?.clientId) {
    const sameReading =
      !parsed.clientName ||
      normalize(existing.clientNameRaw ?? '') === normalize(parsed.clientName);
    if (sameReading) clientId = existing.clientId;
  }
  if (!clientId && !receivedInvoice && parsed.clientName && settings.autoCreateClients) {
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

    // Un journal de ventes porte parfois une colonne « type ». Quand elle est
    // là, elle est lue ; sinon le classement du dossier reste le seul indice.
    const kindRaw = normalize(get(head, 'kind') ?? '');
    let kind: DocumentKind = kindHint ?? 'invoice';
    let kindSure = false;
    if (kindRaw.includes('devis') || kindRaw.includes('proforma')) (kind = 'quote'), (kindSure = true);
    else if (kindRaw.includes('avoir')) (kind = 'credit'), (kindSure = true);
    else if (kindRaw.includes('facture')) (kind = 'invoice'), (kindSure = true);

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
      kindSure,
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
    // « Connu » exige chemin ET horodatage : un scanner qui réécrit le même
    // nom de fichier avec une pièce neuve ne doit pas passer pour l'ancienne.
    const known = store.db.documents.find(
      (d) => d.sourceFile === stored && d.sourceMtime === file.mtimeMs,
    );
    if (!options.force && known) {
      report.skipped++;
      continue;
    }

    try {
      const hash = await hashFile(file.filePath);
      const byHash = store.db.documents.find((d) => d.sourceHash === hash);
      if (!options.force && byHash) {
        if (byHash.sourceFile !== stored) {
          const previous = resolvePath(byHash.sourceFile ?? '');
          if (previous && fs.existsSync(previous)) {
            // Deux copies du même contenu (une pièce renvoyée sous une autre
            // étiquette, rangée dans un autre sous-dossier). Relire la seconde
            // ferait basculer `sourceFile` à chaque passage — base réécrite et
            // événements en boucle. La copie déjà enregistrée fait foi.
            report.skipped++;
            continue;
          }
          // Le fichier a été déplacé : on suit son nouvel emplacement.
          store.mutate(() => {
            byHash.sourceFile = stored;
            byHash.sourceMtime = file.mtimeMs;
          });
          report.skipped++;
          continue;
        }
        // Contenu identique au même endroit : on rafraîchit l'horodatage.
        store.mutate(() => {
          byHash.sourceMtime = file.mtimeMs;
        });
        report.skipped++;
        continue;
      }

      const results = await parseFile(file.filePath, file.folderHint);
      // « Nouveauté » se juge sur l'identifiant : une pièce dont l'id existait
      // avant l'ingestion a été mise à jour, pas ajoutée — quel que soit le
      // chemin par lequel elle a été reconnue.
      const beforeIds = new Set(store.db.documents.map((d) => d.id));
      for (const { parsed, format } of results) {
        const doc = ingestParsedDocument(parsed, {
          filePath: file.filePath,
          sourceFormat: format,
          sourceHash: hash,
          sourceMtime: file.mtimeMs,
          kindHint: file.folderHint,
          multiPiece: results.length > 1,
        });
        report.documents.push(doc);
        if (beforeIds.has(doc.id)) report.updated++;
        else {
          report.imported++;
          fresh.push(doc);
          beforeIds.add(doc.id);
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
      multiPiece: results.length > 1,
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
