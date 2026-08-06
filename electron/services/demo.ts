import type { AccountingDocument, Client, DeliveryRoute, Product, RouteStop } from '@shared/types';
import { newId, nowIso, store, today } from '../store';
import { round2 } from './text';
import { resolveDocumentLines } from './stock';

/**
 * Jeu de démonstration : clients, consommables, factures et une tournée
 * événementielle réelle en Loire-Atlantique. Tout est marqué `démo` pour
 * pouvoir être retiré d'un clic.
 */

const DEMO_TAG = 'démo';

interface Seed {
  clients: Omit<Client, 'id' | 'createdAt' | 'updatedAt'>[];
  products: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>[];
}

const seed: Seed = {
  clients: [
    {
      code: 'CLI-9001',
      name: 'Le Comptoir des Glaces',
      legalName: 'LE COMPTOIR DES GLACES SARL',
      contact: 'Camille Renaud',
      email: 'contact@comptoir-glaces.fr',
      phone: '02 40 11 22 33',
      siret: '81234567800019',
      address: {
        label: '8 avenue de la Plage, 44500 La Baule-Escoublac',
        street: '8 avenue de la Plage',
        postcode: '44500',
        city: 'La Baule-Escoublac',
        country: 'France',
        lat: 47.2864,
        lon: -2.3933,
      },
      tags: [DEMO_TAG, 'revendeur'],
      aliases: ['LE COMPTOIR DES GLACES SARL'],
      archived: false,
      notes: 'Livraison hebdomadaire le mardi matin.',
    },
    {
      code: 'CLI-9002',
      name: 'Restaurant La Dune',
      contact: 'Yann Le Goff',
      email: 'resa@ladune-piriac.fr',
      phone: '02 40 44 55 66',
      address: {
        label: '3 boulevard de l’Océan, 44420 Piriac-sur-Mer',
        street: '3 boulevard de l’Océan',
        postcode: '44420',
        city: 'Piriac-sur-Mer',
        country: 'France',
        lat: 47.3789,
        lon: -2.5461,
      },
      tags: [DEMO_TAG, 'restaurant'],
      aliases: [],
      archived: false,
    },
    {
      code: 'CLI-9003',
      name: 'Mairie de Pornichet',
      contact: 'Service événementiel',
      email: 'evenements@pornichet.fr',
      phone: '02 40 61 03 03',
      address: {
        label: 'Place du Marché, 44380 Pornichet',
        street: 'Place du Marché',
        postcode: '44380',
        city: 'Pornichet',
        country: 'France',
        lat: 47.2653,
        lon: -2.3397,
      },
      tags: [DEMO_TAG, 'collectivité'],
      aliases: [],
      archived: false,
      notes: 'Marchés d’été : prestation chariot le samedi.',
    },
    {
      code: 'CLI-9004',
      name: 'Camping Les Ajoncs',
      email: 'accueil@lesajoncs.fr',
      phone: '02 40 23 45 67',
      address: {
        label: '17 route de Guérande, 44490 Le Croisic',
        street: '17 route de Guérande',
        postcode: '44490',
        city: 'Le Croisic',
        country: 'France',
        lat: 47.2925,
        lon: -2.5133,
      },
      tags: [DEMO_TAG, 'saisonnier'],
      aliases: [],
      archived: false,
    },
    {
      code: 'CLI-9005',
      name: 'Brasserie du Port',
      email: 'contact@brasserieduport.fr',
      phone: '02 40 22 88 99',
      address: {
        label: '2 quai Demange, 44600 Saint-Nazaire',
        street: '2 quai Demange',
        postcode: '44600',
        city: 'Saint-Nazaire',
        country: 'France',
        lat: 47.2735,
        lon: -2.2015,
      },
      tags: [DEMO_TAG, 'restaurant'],
      aliases: [],
      archived: false,
    },
  ],
  products: [
    { sku: 'CUP-100', name: 'Coupelle carton 100 ml (x50)', type: 'consumable', category: 'Contenants', unit: 'carton', qtyOnHand: 48, minQty: 20, unitCost: 8.9, supplier: 'EmballagePro', aliases: ['Coupelle 100ml', 'Coupelles carton 100 ml'], archived: false },
    { sku: 'CON-STD', name: 'Cornet gaufré standard (x120)', type: 'consumable', category: 'Contenants', unit: 'carton', qtyOnHand: 26, minQty: 15, unitCost: 12.4, supplier: 'EmballagePro', aliases: ['Cornet gaufre standard'], archived: false },
    { sku: 'SPO-BOI', name: 'Cuillère bois 95 mm (x100)', type: 'consumable', category: 'Ustensiles', unit: 'carton', qtyOnHand: 12, minQty: 18, unitCost: 4.2, supplier: 'EcoTable', aliases: ['Cuillere bois 95mm'], archived: false },
    { sku: 'SAC-KR', name: 'Sachet kraft imprimé (x250)', type: 'consumable', category: 'Emballages', unit: 'carton', qtyOnHand: 9, minQty: 6, unitCost: 31, supplier: 'EmballagePro', aliases: [], archived: false },
    { sku: 'BAC-5L', name: 'Bac inox 5 L', type: 'consumable', category: 'Matériel', unit: 'pièce', qtyOnHand: 22, minQty: 8, unitCost: 23.5, supplier: 'FroidOuest', aliases: ['Bac inox 5L'], archived: false },
    { sku: 'SER-BLA', name: 'Serviette blanche 30x30 (x500)', type: 'consumable', category: 'Ustensiles', unit: 'carton', qtyOnHand: 4, minQty: 10, unitCost: 14.8, supplier: 'EcoTable', aliases: [], archived: false },
    { sku: 'GAN-VIN', name: 'Gants vinyle taille M (x100)', type: 'consumable', category: 'Hygiène', unit: 'boîte', qtyOnHand: 31, minQty: 12, unitCost: 6.5, supplier: 'HygiPro', aliases: [], archived: false },
    { sku: 'CO2-CAR', name: 'Carboglace 10 kg', type: 'consumable', category: 'Froid', unit: 'sac', qtyOnHand: 3, minQty: 4, unitCost: 42, supplier: 'FroidOuest', aliases: ['Carboglace'], archived: false },
    { sku: 'MAC-ITA', name: 'Machine à glace italienne 2 parfums', type: 'machine', category: 'Machines', unit: 'pièce', qtyOnHand: 2, minQty: 1, unitCost: 4200, supplier: 'FroidOuest', aliases: [], archived: false },
    { sku: 'MAC-GRA', name: 'Machine à granité 2 bols', type: 'machine', category: 'Machines', unit: 'pièce', qtyOnHand: 1, minQty: 1, unitCost: 1850, supplier: 'FroidOuest', aliases: [], archived: false },
    { sku: 'PIE-JOI', name: 'Joint de cuve (jeu complet)', type: 'part', category: 'Pièces détachées', unit: 'jeu', qtyOnHand: 6, minQty: 3, unitCost: 24.9, supplier: 'FroidOuest', aliases: ['Joint cuve'], archived: false },
    { sku: 'PIE-COU', name: 'Courroie d’entraînement', type: 'part', category: 'Pièces détachées', unit: 'pièce', qtyOnHand: 2, minQty: 4, unitCost: 38, supplier: 'FroidOuest', aliases: ['Courroie'], archived: false },
  ],
};

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setDate(Math.min(d.getDate(), 26));
  return d.toISOString().slice(0, 10);
}

export function seedDemoData(): void {
  store.mutate((db) => {
    const clients: Client[] = seed.clients.map((c) => ({
      ...c,
      id: newId('cli'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));
    const products: Product[] = seed.products.map((p) => ({
      ...p,
      id: newId('prd'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));

    db.clients.push(...clients);
    db.products.push(...products);

    /* Documents ---------------------------------------------------- */
    const buildDoc = (
      kind: AccountingDocument['kind'],
      number: string,
      date: string,
      client: Client,
      items: { sku: string; qty: number }[],
    ): AccountingDocument => {
      const lines = items.map((item) => {
        const product = products.find((p) => p.sku === item.sku)!;
        const unitPrice = round2((product.unitCost ?? 10) * 1.45);
        return {
          id: newId('lin'),
          ref: product.sku,
          label: product.name,
          qty: item.qty,
          unit: product.unit,
          unitPriceHT: unitPrice,
          totalHT: round2(unitPrice * item.qty),
          vatRate: 20,
          matchMethod: 'none' as const,
        };
      });
      const totalHT = round2(lines.reduce((s, l) => s + (l.totalHT ?? 0), 0));
      const totalVAT = round2(totalHT * 0.2);
      const doc: AccountingDocument = {
        id: newId('doc'),
        kind,
        number,
        date,
        dueDate: undefined,
        clientId: client.id,
        clientNameRaw: client.legalName ?? client.name,
        currency: 'EUR',
        totalHT,
        totalVAT,
        totalTTC: round2(totalHT + totalVAT),
        status: kind === 'quote' ? 'draft' : 'confirmed',
        lines,
        sourceFormat: 'manual',
        stockApplied: false,
        confidence: 1,
        warnings: [],
        notes: 'Document de démonstration.',
        importedAt: nowIso(),
        updatedAt: nowIso(),
      };
      resolveDocumentLines(doc);
      return doc;
    };

    const [comptoir, dune, mairie, camping, brasserie] = clients;
    db.documents.unshift(
      buildDoc('invoice', 'DEMO-FA-0104', monthsAgo(4), comptoir, [
        { sku: 'CUP-100', qty: 10 },
        { sku: 'SPO-BOI', qty: 6 },
      ]),
      buildDoc('invoice', 'DEMO-FA-0117', monthsAgo(3), dune, [
        { sku: 'CON-STD', qty: 8 },
        { sku: 'SER-BLA', qty: 4 },
      ]),
      buildDoc('invoice', 'DEMO-FA-0126', monthsAgo(2), camping, [
        { sku: 'CUP-100', qty: 14 },
        { sku: 'SAC-KR', qty: 3 },
        { sku: 'GAN-VIN', qty: 5 },
      ]),
      buildDoc('invoice', 'DEMO-FA-0139', monthsAgo(1), brasserie, [
        { sku: 'BAC-5L', qty: 4 },
        { sku: 'CO2-CAR', qty: 2 },
      ]),
      buildDoc('invoice', 'DEMO-FA-0148', today(), comptoir, [
        { sku: 'CUP-100', qty: 12 },
        { sku: 'CON-STD', qty: 5 },
      ]),
      buildDoc('quote', 'DEMO-DE-0031', today(), mairie, [
        { sku: 'CUP-100', qty: 20 },
        { sku: 'SER-BLA', qty: 6 },
      ]),
    );

    /* Tournée événementielle --------------------------------------- */
    const stop = (client: Client, serviceMinutes: number, pinned = false, pinnedIndex?: number): RouteStop => ({
      id: newId('stp'),
      clientId: client.id,
      label: client.name,
      address: client.address,
      pinned,
      pinnedIndex,
      serviceMinutes,
    });

    const route: DeliveryRoute = {
      id: newId('rte'),
      name: 'Tournée événementielle — côte',
      date: today(),
      vehicleId: db.settings.defaultVehicleId,
      start: {
        id: newId('stp'),
        label: 'Dépôt Saint-Nazaire',
        address: {
          label: '12 rue des Sables, 44600 Saint-Nazaire',
          street: '12 rue des Sables',
          postcode: '44600',
          city: 'Saint-Nazaire',
          country: 'France',
          lat: 47.2733,
          lon: -2.2134,
        },
        pinned: false,
        serviceMinutes: 0,
      },
      // Le premier arrêt est épinglé : montage du chariot avant l'ouverture du marché.
      stops: [stop(mairie, 30, true, 0), stop(comptoir, 15), stop(camping, 20), stop(dune, 15), stop(brasserie, 10)],
      returnToStart: true,
      end: null,
      tollCost: 0,
      notes: 'Livraison des consommables + installation du chariot pour le marché.',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.routes.unshift(route);

    if (!db.settings.depot) db.settings.depot = route.start.address;
    if (!db.settings.fuelPricePostcode) db.settings.fuelPricePostcode = '44600';
  });
  store.flushSync();
}

/** Retire toutes les données de démonstration (repérées par leur préfixe / étiquette). */
export function wipeDemoData(): void {
  store.mutate((db) => {
    const demoClientIds = new Set(db.clients.filter((c) => c.tags.includes(DEMO_TAG)).map((c) => c.id));
    const demoDocIds = new Set(db.documents.filter((d) => d.number.startsWith('DEMO-')).map((d) => d.id));

    db.documents = db.documents.filter((d) => !demoDocIds.has(d.id));
    db.stockMoves = db.stockMoves.filter((m) => !m.documentId || !demoDocIds.has(m.documentId));
    db.clients = db.clients.filter((c) => !demoClientIds.has(c.id));
    db.products = db.products.filter((p) => !seed.products.some((s) => s.sku === p.sku));
    db.routes = db.routes.filter((r) => !r.name.includes('événementielle — côte'));
  });
  store.flushSync();
}
