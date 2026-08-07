import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AccountingDocument,
  BankCategory,
  BankDedupeReport,
  BankDuplicateGroup,
  BankImportReport,
  BankMatchSuggestion,
  BankScanReport,
  BankSummary,
  BankTransaction,
  ID,
} from '@shared/types';
import { newId, nowIso, store } from '../store';
import { readTable } from './tabular';
import {
  ACCEPT_MARGIN,
  ACCEPT_SCORE,
  looksLikeStatement,
  parseStatementTable,
  richerLabel,
  sameOperation,
  scoreDocumentMatch,
  type ParsedTransaction,
} from './bankStatement';
import { round2 } from './text';
import { storePath } from './paths';

const STATEMENT_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls', '.xlsm']);

/* ------------------------------------------------------------------ */
/* Dossier des relevés                                                  */
/* ------------------------------------------------------------------ */

/**
 * Dossier où sont déposés les relevés. Par défaut un sous-dossier du dossier
 * surveillé, mais il peut pointer n'importe où : les relevés sont souvent
 * déjà rangés ailleurs et il ne faut pas obliger à les déplacer.
 */
export function statementFolder(): string {
  const configured = store.settings.statementFolder?.trim();
  const folder = configured || path.join(store.settings.watchFolder, 'Releves');
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

async function listStatementFiles(folder: string): Promise<{ filePath: string; mtimeMs: number }[]> {
  const out: { filePath: string; mtimeMs: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!STATEMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = await fsp.stat(full);
        out.push({ filePath: full, mtimeMs: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  };
  await walk(folder, 0);
  return out.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */

/** Importe un relevé. Les opérations déjà connues sont ignorées, jamais dupliquées. */
export async function importStatementFile(filePath: string): Promise<BankImportReport> {
  const report: BankImportReport = {
    file: filePath,
    total: 0,
    imported: 0,
    duplicates: 0,
    updated: 0,
    skipped: 0,
    reconciled: 0,
    headers: [],
    mapping: {},
    errors: [],
    warnings: [],
  };

  const table = await readTable(filePath);
  report.headers = table.headers;
  if (!table.rows.length) {
    report.errors.push('Fichier vide ou illisible.');
    return report;
  }

  const parsed = parseStatementTable(table);
  report.mapping = parsed.mapping;
  report.warnings = parsed.warnings;
  report.total = table.rows.length;
  report.skipped = parsed.skipped;

  if (!parsed.transactions.length) {
    if (!report.warnings.length) report.errors.push('Aucune opération lue dans ce fichier.');
    return report;
  }

  const format: BankTransaction['sourceFormat'] = table.source === 'xlsx' ? 'xlsx' : 'csv';
  const created: BankTransaction[] = [];

  store.mutate((db) => {
    const known = new Map(db.bankTransactions.map((t) => [t.fingerprint, t]));
    // Index date + montant : c'est par là qu'on rattrape une opération déjà
    // connue dont seul le libellé a changé d'un export à l'autre. Seules les
    // opérations *déjà en base* y figurent : à l'intérieur d'un même fichier la
    // banque écrit ses libellés de façon cohérente, deux lignes qui diffèrent
    // sont deux opérations.
    const nearby = new Map<string, BankTransaction[]>();
    for (const t of db.bankTransactions) {
      const key = amountKey(t.date, t.amount);
      const list = nearby.get(key);
      if (list) list.push(t);
      else nearby.set(key, [t]);
    }
    // Une opération connue ne peut être réclamée que par une seule ligne du
    // relevé : deux virements identiques le même jour restent deux lignes.
    const claimed = new Set<ID>();

    for (const tx of parsed.transactions) {
      const existing =
        known.get(tx.fingerprint) ??
        (nearby.get(amountKey(tx.date, tx.amount)) ?? []).find(
          (t) => !claimed.has(t.id) && sameOperation(t.label, tx.label),
        );
      if (existing) {
        claimed.add(existing.id);
        report.duplicates++;
        // Le relevé peut compléter une opération déjà connue (solde, référence,
        // libellé plus détaillé) sans jamais écraser ce qui a été corrigé à la
        // main.
        let changed = false;
        if (existing.balance === undefined && tx.balance !== undefined) {
          existing.balance = tx.balance;
          changed = true;
        }
        if (!existing.reference && tx.reference) {
          existing.reference = tx.reference;
          changed = true;
        }
        const label = richerLabel(existing.label, tx.label);
        if (label !== existing.label) {
          existing.label = label;
          // La catégorie déduite du libellé suit, sauf si elle a été choisie.
          if (existing.categoryAuto) existing.category = tx.category;
          changed = true;
        }
        if (changed) {
          existing.updatedAt = nowIso();
          report.updated++;
        }
        continue;
      }

      const record = toRecord(tx, filePath, format);
      db.bankTransactions.push(record);
      known.set(record.fingerprint, record);
      claimed.add(record.id);
      created.push(record);
      report.imported++;
    }
    db.bankTransactions.sort((a, b) => b.date.localeCompare(a.date) || b.importedAt.localeCompare(a.importedAt));
  });

  if (store.settings.autoReconcile && created.length) {
    report.reconciled = autoReconcile(created.map((t) => t.id)).matched;
  }
  return report;
}

function toRecord(
  tx: ParsedTransaction,
  filePath: string,
  format: BankTransaction['sourceFormat'],
): BankTransaction {
  return {
    id: newId('bnk'),
    date: tx.date,
    valueDate: tx.valueDate,
    label: tx.label,
    amount: tx.amount,
    balance: tx.balance,
    reference: tx.reference,
    account: tx.account,
    category: tx.category,
    categoryAuto: true,
    matchAuto: false,
    fingerprint: tx.fingerprint,
    sourceFile: storePath(filePath),
    sourceFormat: format,
    importedAt: nowIso(),
    updatedAt: nowIso(),
  };
}

/** Clé de regroupement d'une opération : même jour, même montant au centime. */
function amountKey(date: string, amount: number): string {
  return `${date}|${amount.toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* Doublons déjà en base                                                */
/* ------------------------------------------------------------------ */

/**
 * L'opération d'un groupe qu'il faut garder en priorité : celle qui est
 * rapprochée d'une facture, puis celle qui porte le libellé le plus complet,
 * puis celle qui connaît le solde. À égalité, la plus ancienne — c'est elle
 * que l'utilisateur a sous les yeux depuis le plus longtemps.
 */
function richness(t: BankTransaction): number[] {
  return [
    t.documentId ? 1 : 0,
    t.note ? 1 : 0,
    t.categoryAuto ? 0 : 1,
    t.label.length,
    t.balance !== undefined ? 1 : 0,
  ];
}

function byRichnessDesc(a: BankTransaction, b: BankTransaction): number {
  const ra = richness(a);
  const rb = richness(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return rb[i] - ra[i];
  }
  return a.importedAt.localeCompare(b.importedAt);
}

/**
 * Repère les opérations enregistrées plusieurs fois parce que deux exports de
 * la banque ne libellaient pas la ligne pareil.
 *
 * Le comptage est prudent : dans un groupe, on ne descend jamais en dessous du
 * nombre de fois où la **même** variante de libellé apparaît. Si « VIR X » est
 * là deux fois et « VIR X FACTURE 12 » deux fois, l'opération a bien eu lieu
 * deux fois — on ramène le groupe à deux lignes, pas à une.
 */
export function findDuplicateGroups(): BankDuplicateGroup[] {
  const buckets = new Map<string, BankTransaction[]>();
  for (const t of store.db.bankTransactions) {
    const key = amountKey(t.date, t.amount);
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  }

  const groups: BankDuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const pending = [...bucket].sort(byRichnessDesc);

    while (pending.length) {
      const head = pending.shift() as BankTransaction;
      const cluster = [head];
      for (let i = pending.length - 1; i >= 0; i--) {
        if (sameOperation(head.label, pending[i].label)) cluster.push(...pending.splice(i, 1));
      }
      if (cluster.length < 2) continue;

      // Combien de fois l'opération a-t-elle réellement eu lieu ?
      const perVariant = new Map<string, number>();
      for (const t of cluster) {
        const key = t.label.trim().toLowerCase();
        perVariant.set(key, (perVariant.get(key) ?? 0) + 1);
      }
      const real = Math.max(...perVariant.values());
      if (cluster.length <= real) continue;

      cluster.sort(byRichnessDesc);
      groups.push({
        date: head.date,
        amount: head.amount,
        keep: cluster.slice(0, real).map((t) => t.id),
        drop: cluster.slice(real).map((t) => t.id),
        // Du plus complet au plus court : c'est le premier que l'utilisateur
        // reconnaîtra, et celui qui restera après le ménage.
        labels: [...new Set(cluster.map((t) => t.label))].sort((a, b) => b.length - a.length),
      });
    }
  }

  return groups.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Supprime les doublons repérés. Ce que portait la copie effacée — facture
 * rapprochée, solde, référence, note — passe sur celle qui reste : nettoyer ne
 * doit rien faire perdre.
 */
export function mergeDuplicates(): BankDedupeReport {
  const groups = findDuplicateGroups();
  const report: BankDedupeReport = { groups: groups.length, removed: 0, amount: 0 };
  if (!groups.length) return report;

  store.mutate((db) => {
    const index = new Map(db.bankTransactions.map((t) => [t.id, t]));
    const removed = new Set<ID>();

    for (const group of groups) {
      const keep = group.keep.map((id) => index.get(id)).filter((t): t is BankTransaction => !!t);
      if (!keep.length) continue;

      for (const id of group.drop) {
        const gone = index.get(id);
        if (!gone) continue;
        // Reverser ce que la copie effacée était seule à porter.
        const host = keep.find((t) => !t.documentId && gone.documentId) ?? keep[0];
        if (gone.documentId && !host.documentId) {
          host.documentId = gone.documentId;
          host.clientId = gone.clientId;
          host.matchScore = gone.matchScore;
          host.matchAuto = gone.matchAuto;
        }
        if (host.balance === undefined && gone.balance !== undefined) host.balance = gone.balance;
        if (!host.reference && gone.reference) host.reference = gone.reference;
        if (!host.note && gone.note) host.note = gone.note;
        host.label = richerLabel(host.label, gone.label);
        host.updatedAt = nowIso();

        removed.add(id);
        report.removed++;
        report.amount = round2(report.amount + Math.abs(gone.amount));
      }
    }

    db.bankTransactions = db.bankTransactions.filter((t) => !removed.has(t.id));
  });

  return report;
}

/** Analyse tout le dossier des relevés. */
export async function scanStatementFolder(): Promise<BankScanReport> {
  const started = Date.now();
  const report: BankScanReport = {
    files: 0,
    imported: 0,
    duplicates: 0,
    reconciled: 0,
    failed: 0,
    errors: [],
    durationMs: 0,
  };

  const folder = statementFolder();
  const files = await listStatementFiles(folder);
  for (const file of files) {
    try {
      const table = await readTable(file.filePath);
      // Un CSV quelconque déposé là ne doit pas polluer les opérations.
      if (!table.headers.length || !looksLikeStatement(table.headers)) continue;
      report.files++;
      const one = await importStatementFile(file.filePath);
      report.imported += one.imported;
      report.duplicates += one.duplicates;
      report.reconciled += one.reconciled;
      if (one.errors.length) {
        report.failed++;
        report.errors.push({ file: file.filePath, message: one.errors[0] });
      }
    } catch (err) {
      report.failed++;
      report.errors.push({ file: file.filePath, message: (err as Error).message });
    }
  }

  report.durationMs = Date.now() - started;
  store.flushSync();
  return report;
}

/* ------------------------------------------------------------------ */
/* Modification manuelle                                                */
/* ------------------------------------------------------------------ */

export function updateTransaction(id: ID, patch: Partial<BankTransaction>): BankTransaction {
  return store.mutate((db) => {
    const tx = db.bankTransactions.find((t) => t.id === id);
    if (!tx) throw new Error('Opération introuvable.');
    // L'empreinte et la provenance ne se modifient pas : elles garantissent
    // le dédoublonnage lors des prochains imports.
    const { id: _id, fingerprint, sourceFile, sourceFormat, importedAt, ...safe } = patch;
    Object.assign(tx, safe, { updatedAt: nowIso() });
    if (patch.category) tx.categoryAuto = false;
    return tx;
  });
}

export function removeTransaction(id: ID): void {
  store.mutate((db) => {
    db.bankTransactions = db.bankTransactions.filter((t) => t.id !== id);
  });
}

/* ------------------------------------------------------------------ */
/* Rapprochement facture ↔ opération                                    */
/* ------------------------------------------------------------------ */

interface Scored {
  doc: AccountingDocument;
  score: number;
  reasons: string[];
}

/** Tous les noms sous lesquels le client d'une pièce peut apparaître en banque. */
function clientNamesOf(doc: AccountingDocument): string[] {
  const client = doc.clientId ? store.db.clients.find((c) => c.id === doc.clientId) : undefined;
  return [client?.name, client?.legalName, doc.clientNameRaw, ...(client?.aliases ?? [])].filter(
    (n): n is string => Boolean(n && n.trim()),
  );
}

/** Note la ressemblance entre une opération bancaire et une facture. */
function scoreMatch(tx: BankTransaction, doc: AccountingDocument): Scored | null {
  const result = scoreDocumentMatch(tx, doc, clientNamesOf(doc));
  return result ? { doc, score: result.score, reasons: result.reasons } : null;
}

export function suggestMatches(transactionId: ID, limit = 5): BankMatchSuggestion[] {
  const tx = store.db.bankTransactions.find((t) => t.id === transactionId);
  if (!tx) throw new Error('Opération introuvable.');

  const taken = new Set(
    store.db.bankTransactions.filter((t) => t.documentId && t.id !== tx.id).map((t) => t.documentId),
  );

  const scored = store.db.documents
    .filter((d) => !taken.has(d.id))
    .map((d) => scoreMatch(tx, d))
    .filter((s): s is Scored => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => {
    const client = s.doc.clientId ? store.db.clients.find((c) => c.id === s.doc.clientId) : undefined;
    return {
      documentId: s.doc.id,
      number: s.doc.number,
      clientName: client?.name ?? s.doc.clientNameRaw ?? 'Client inconnu',
      date: s.doc.date,
      totalTTC: s.doc.totalTTC,
      score: s.score,
      reason: s.reasons.join(', '),
    };
  });
}

/**
 * Rattache une opération à une facture. La facture passe à « réglée » : c'est
 * tout l'intérêt du rapprochement, savoir qui a payé et qui reste à relancer.
 */
export function reconcile(transactionId: ID, documentId: ID | null, auto = false): BankTransaction {
  return store.mutate((db) => {
    const tx = db.bankTransactions.find((t) => t.id === transactionId);
    if (!tx) throw new Error('Opération introuvable.');

    // Détacher l'ancienne facture avant d'en rattacher une nouvelle.
    if (tx.documentId && tx.documentId !== documentId) {
      const previous = db.documents.find((d) => d.id === tx.documentId);
      if (previous && previous.status === 'paid') {
        previous.status = 'confirmed';
        previous.updatedAt = nowIso();
      }
    }

    if (!documentId) {
      tx.documentId = undefined;
      tx.clientId = undefined;
      tx.matchScore = undefined;
      tx.matchAuto = false;
      tx.updatedAt = nowIso();
      return tx;
    }

    const doc = db.documents.find((d) => d.id === documentId);
    if (!doc) throw new Error('Facture introuvable.');

    tx.documentId = doc.id;
    tx.clientId = doc.clientId;
    tx.matchAuto = auto;
    tx.updatedAt = nowIso();
    if (tx.categoryAuto) tx.category = tx.amount > 0 ? 'sales' : tx.category;

    if (doc.status !== 'cancelled' && doc.status !== 'paid') {
      doc.status = 'paid';
      doc.updatedAt = nowIso();
    }
    return tx;
  });
}

/**
 * Rapproche automatiquement les opérations non rattachées. Seuls les
 * candidats nettement meilleurs que les autres sont retenus : en cas de doute
 * l'opération reste à traiter à la main plutôt que d'être mal affectée.
 */
export function autoReconcile(onlyIds?: ID[]): { matched: number; ambiguous: number } {
  const scope = onlyIds
    ? store.db.bankTransactions.filter((t) => onlyIds.includes(t.id))
    : store.db.bankTransactions;
  const pending = scope.filter((t) => !t.documentId);

  let matched = 0;
  let ambiguous = 0;

  for (const tx of pending) {
    const suggestions = suggestMatches(tx.id, 2);
    if (!suggestions.length) continue;
    const [best, second] = suggestions;
    if (best.score < ACCEPT_SCORE) continue;
    if (second && best.score - second.score < ACCEPT_MARGIN) {
      ambiguous++;
      continue;
    }
    reconcile(tx.id, best.documentId, true);
    store.mutate((db) => {
      const t = db.bankTransactions.find((x) => x.id === tx.id);
      if (t) t.matchScore = best.score;
    });
    matched++;
  }
  return { matched, ambiguous };
}

/* ------------------------------------------------------------------ */
/* Synthèse                                                             */
/* ------------------------------------------------------------------ */

export function bankSummary(): BankSummary {
  const txs = [...store.db.bankTransactions].sort((a, b) => a.date.localeCompare(b.date));
  const summary: BankSummary = {
    from: txs.length ? txs[0].date : null,
    to: txs.length ? txs[txs.length - 1].date : null,
    totalIn: 0,
    totalOut: 0,
    net: 0,
    months: [],
    categories: [],
    unreconciled: 0,
    unreconciledAmount: 0,
  };

  const months = new Map<string, { in: number; out: number; balance?: number }>();
  const categories = new Map<BankCategory, { in: number; out: number; count: number }>();

  for (const tx of txs) {
    if (tx.amount >= 0) summary.totalIn += tx.amount;
    else summary.totalOut += Math.abs(tx.amount);

    const month = tx.date.slice(0, 7);
    const m = months.get(month) ?? { in: 0, out: 0 };
    if (tx.amount >= 0) m.in += tx.amount;
    else m.out += Math.abs(tx.amount);
    // Les opérations sont triées par date : le dernier solde vu est celui de
    // la fin du mois.
    if (tx.balance !== undefined) m.balance = tx.balance;
    months.set(month, m);

    const c = categories.get(tx.category) ?? { in: 0, out: 0, count: 0 };
    if (tx.amount >= 0) c.in += tx.amount;
    else c.out += Math.abs(tx.amount);
    c.count++;
    categories.set(tx.category, c);

    // Seuls les encaissements ont vocation à être rapprochés d'une facture.
    if (tx.amount > 0 && !tx.documentId) {
      summary.unreconciled++;
      summary.unreconciledAmount += tx.amount;
    }

    if (tx.balance !== undefined) {
      summary.balance = tx.balance;
      summary.balanceDate = tx.date;
    }
  }

  summary.totalIn = round2(summary.totalIn);
  summary.totalOut = round2(summary.totalOut);
  summary.net = round2(summary.totalIn - summary.totalOut);
  summary.unreconciledAmount = round2(summary.unreconciledAmount);

  summary.months = [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, m]) => ({
      month,
      in: round2(m.in),
      out: round2(m.out),
      net: round2(m.in - m.out),
      balance: m.balance,
    }));

  summary.categories = [...categories.entries()]
    .map(([category, c]) => ({ category, in: round2(c.in), out: round2(c.out), count: c.count }))
    .sort((a, b) => b.out - a.out || b.in - a.in);

  return summary;
}
