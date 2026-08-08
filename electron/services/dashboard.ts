import { awaitsStock, type Client, type DashboardStats, type Product } from '@shared/types';
import { store } from '../store';
import { round2 } from './text';

const MONTHS_FR = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
];

export function buildDashboard(): DashboardStats {
  const db = store.db;
  // Les pièces provisoires — brouillons tenant lieu de proforma — sont mises de
  // côté : la facture définitive arrive ensuite et compterait la vente deux fois.
  const final = (d: { status: string }) => d.status !== 'cancelled' && d.status !== 'draft';
  const invoices = db.documents.filter((d) => d.kind === 'invoice' && final(d));
  const credits = db.documents.filter((d) => d.kind === 'credit' && final(d));
  const quotes = db.documents.filter((d) => d.kind === 'quote');

  // Les avoirs viennent en déduction du chiffre d'affaires.
  const revenueHT = round2(
    invoices.reduce((s, d) => s + d.totalHT, 0) - credits.reduce((s, d) => s + d.totalHT, 0),
  );
  const revenueTTC = round2(
    invoices.reduce((s, d) => s + d.totalTTC, 0) - credits.reduce((s, d) => s + d.totalTTC, 0),
  );

  const lowStock: { product: Product; missing: number }[] = [];
  let stockValue = 0;
  let outOfStock = 0;
  for (const p of db.products) {
    if (p.archived) continue;
    stockValue += (p.unitCost ?? 0) * p.qtyOnHand;
    if (p.qtyOnHand <= 0) outOfStock++;
    if (p.minQty > 0 && p.qtyOnHand < p.minQty) {
      lowStock.push({ product: p, missing: round2(p.minQty - p.qtyOnHand) });
    }
  }
  lowStock.sort((a, b) => b.missing - a.missing);

  /* Chiffre d'affaires des 12 derniers mois -------------------------- */
  const monthly: { month: string; ht: number; ttc: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${MONTHS_FR[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    const inMonth = (doc: { date: string }) => doc.date?.startsWith(key);
    const ht = round2(
      invoices.filter(inMonth).reduce((s, x) => s + x.totalHT, 0) -
        credits.filter(inMonth).reduce((s, x) => s + x.totalHT, 0),
    );
    const ttc = round2(
      invoices.filter(inMonth).reduce((s, x) => s + x.totalTTC, 0) -
        credits.filter(inMonth).reduce((s, x) => s + x.totalTTC, 0),
    );
    monthly.push({ month: label, ht, ttc });
  }

  /* Meilleurs clients ------------------------------------------------ */
  const byClient = new Map<string, { total: number; count: number }>();
  for (const doc of invoices) {
    if (!doc.clientId) continue;
    const entry = byClient.get(doc.clientId) ?? { total: 0, count: 0 };
    entry.total += doc.totalHT;
    entry.count += 1;
    byClient.set(doc.clientId, entry);
  }
  const topClients = [...byClient.entries()]
    .map(([clientId, agg]) => ({
      client: db.clients.find((c) => c.id === clientId) as Client,
      total: round2(agg.total),
      count: agg.count,
    }))
    .filter((t) => t.client)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  /* Tournées du mois en cours ---------------------------------------- */
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthRoutes = db.routes.filter((r) => r.date?.startsWith(monthKey));
  const routeCostThisMonth = round2(
    monthRoutes.reduce((s, r) => s + (r.computation?.totalCost ?? 0), 0),
  );

  return {
    clients: db.clients.filter((c) => !c.archived).length,
    invoices: invoices.length,
    quotes: quotes.length,
    revenueHT,
    revenueTTC,
    unappliedDocuments: db.documents.filter(awaitsStock).length,
    lowStock: lowStock.slice(0, 20),
    outOfStock,
    stockValue: round2(stockValue),
    recentDocuments: [...db.documents]
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.importedAt.localeCompare(a.importedAt))
      .slice(0, 8),
    monthlyRevenue: monthly,
    topClients,
    routesThisMonth: monthRoutes.length,
    routeCostThisMonth,
  };
}
