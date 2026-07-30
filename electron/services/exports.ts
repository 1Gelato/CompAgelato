import fs from 'node:fs';
import path from 'node:path';
import type { DeliveryRoute } from '@shared/types';
import { store } from '../store';
import { ensureWatchFolder } from './documents';

/** Échappe une valeur pour un CSV lisible par Excel en français (séparateur `;`). */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(';'), ...rows.map((r) => r.map(cell).join(';'))];
  // BOM UTF-8 : Excel ouvre alors le fichier avec les bons accents.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function exportPath(name: string): string {
  const folder = path.join(ensureWatchFolder(store.settings.watchFolder), 'Exports');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return path.join(folder, `${name}-${stamp}.csv`);
}

function write(name: string, content: string): string {
  const target = exportPath(name);
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export function exportClientsCsv(): string {
  const rows = store.db.clients.map((c) => [
    c.code, c.name, c.legalName ?? '', c.contact ?? '', c.email ?? '', c.phone ?? '',
    c.siret ?? '', c.vatNumber ?? '',
    c.address.street ?? '', c.address.postcode ?? '', c.address.city ?? '', c.address.country ?? '',
    c.address.lat ?? '', c.address.lon ?? '',
    c.tags.join(' | '), c.notes ?? '',
  ]);
  return write(
    'clients',
    toCsv(
      ['Code', 'Nom', 'Raison sociale', 'Contact', 'E-mail', 'Téléphone', 'SIRET', 'N° TVA',
       'Adresse', 'Code postal', 'Ville', 'Pays', 'Latitude', 'Longitude', 'Étiquettes', 'Notes'],
      rows,
    ),
  );
}

const KIND_LABEL: Record<string, string> = { invoice: 'Facture', quote: 'Devis', credit: 'Avoir' };
const STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon', confirmed: 'Validé', paid: 'Réglé', cancelled: 'Annulé',
};

export function exportDocumentsCsv(): string {
  const rows = store.db.documents.flatMap((d) => {
    const client = store.db.clients.find((c) => c.id === d.clientId);
    if (!d.lines.length) {
      return [[
        KIND_LABEL[d.kind] ?? d.kind, d.number, d.date, d.dueDate ?? '',
        client?.name ?? d.clientNameRaw ?? '', client?.code ?? '',
        '', '', '', '', '',
        d.totalHT, d.totalVAT, d.totalTTC, STATUS_LABEL[d.status] ?? d.status,
        d.stockApplied ? 'oui' : 'non', d.sourceFile ?? '',
      ]];
    }
    return d.lines.map((l) => {
      const product = store.db.products.find((p) => p.id === l.productId);
      return [
        KIND_LABEL[d.kind] ?? d.kind, d.number, d.date, d.dueDate ?? '',
        client?.name ?? d.clientNameRaw ?? '', client?.code ?? '',
        l.ref ?? '', l.label, l.qty, l.unit ?? '', l.unitPriceHT ?? '',
        l.totalHT ?? '', product?.sku ?? '', product?.name ?? '',
        d.totalTTC, STATUS_LABEL[d.status] ?? d.status,
        d.stockApplied ? 'oui' : 'non', d.sourceFile ?? '',
      ];
    });
  });

  return write(
    'documents',
    toCsv(
      ['Type', 'Numéro', 'Date', 'Échéance', 'Client', 'Code client',
       'Réf. ligne', 'Désignation', 'Quantité', 'Unité', 'P.U. HT', 'Total ligne HT',
       'Réf. stock', 'Produit stock', 'Total TTC pièce', 'Statut', 'Stock déduit', 'Fichier source'],
      rows,
    ),
  );
}

export function exportProductsCsv(): string {
  const rows = store.db.products.map((p) => [
    p.sku, p.name, p.category ?? '', p.unit, p.qtyOnHand, p.minQty,
    p.unitCost ?? '', p.unitCost ? (p.unitCost * p.qtyOnHand).toFixed(2) : '',
    p.supplier ?? '', p.aliases.join(' | '), p.archived ? 'oui' : 'non',
  ]);
  return write(
    'stock',
    toCsv(
      ['Référence', 'Désignation', 'Catégorie', 'Unité', 'Stock', 'Stock mini',
       'Prix unitaire', 'Valeur stock', 'Fournisseur', 'Libellés reconnus', 'Archivé'],
      rows,
    ),
  );
}

export function exportRouteCsv(routeId: string): string {
  const route = store.db.routes.find((r) => r.id === routeId) as DeliveryRoute | undefined;
  if (!route) throw new Error('Tournée introuvable.');

  const rows: unknown[][] = [];
  rows.push(['Départ', route.start.label || 'Dépôt', route.start.address.label, '', '', '', '']);
  route.stops.forEach((s, i) => {
    const client = store.db.clients.find((c) => c.id === s.clientId);
    rows.push([
      `Arrêt ${i + 1}`, s.label, s.address.label, client?.name ?? '',
      s.pinned ? 'épinglé' : '', s.legDistanceKm ?? '', s.legDurationMin ?? '',
      s.serviceMinutes, s.notes ?? '',
    ]);
  });
  if (route.returnToStart) {
    rows.push(['Retour', route.start.label || 'Dépôt', route.start.address.label, '', '', '', '']);
  }

  const c = route.computation;
  rows.push([]);
  rows.push(['Récapitulatif']);
  rows.push(['Distance totale (km)', c?.distanceKm ?? '']);
  rows.push(['Temps de route (min)', c?.durationMin ?? '']);
  rows.push(['Temps sur place (min)', c?.serviceMin ?? '']);
  rows.push(['Carburant (L)', c?.fuelLiters ?? '']);
  rows.push(['Prix du litre (€)', c?.fuelPricePerLiter ?? '']);
  rows.push(['Coût carburant (€)', c?.fuelCost ?? '']);
  rows.push(['Coût usure véhicule (€)', c?.maintenanceCost ?? '']);
  rows.push(['Coût chauffeur (€)', c?.driverCost ?? '']);
  rows.push(['Péages (€)', c?.tollCost ?? '']);
  rows.push(['COÛT TOTAL (€)', c?.totalCost ?? '']);
  rows.push(['Coût par arrêt (€)', c?.costPerStop ?? '']);

  const safeName = route.name.replace(/[^\w\-]+/g, '-').slice(0, 40);
  return write(
    `tournee-${safeName}`,
    toCsv(['Étape', 'Libellé', 'Adresse', 'Client', 'Priorité', 'Distance (km)', 'Durée (min)', 'Sur place (min)', 'Notes'], rows),
  );
}

export function exportDatabaseJson(): string {
  const folder = path.join(ensureWatchFolder(store.settings.watchFolder), 'Exports');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const target = path.join(folder, `compagelato-sauvegarde-${stamp}.json`);
  store.flushSync();
  fs.copyFileSync(store.dbFile, target);
  return target;
}
