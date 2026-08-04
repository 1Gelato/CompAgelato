import type { Address, Client, ID, ImportClientsReport, Product } from '@shared/types';
import { newId, nowIso, store } from '../store';
import { normalize, parseNumber, round2, similarity } from './text';
import { CLIENT_FIELDS, PRODUCT_FIELDS, guessMapping, readTable } from './tabular';

const FUZZY_ACCEPT = 0.82;

/* ------------------------------------------------------------------ */
/* Création / modification                                              */
/* ------------------------------------------------------------------ */

export function nextClientCode(): string {
  const numbers = store.db.clients
    .map((c) => Number(/(\d+)/.exec(c.code ?? '')?.[1] ?? 0))
    .filter((n) => Number.isFinite(n));
  const max = numbers.length ? Math.max(...numbers) : 0;
  return `CLI-${String(max + 1).padStart(4, '0')}`;
}

export function emptyAddress(): Address {
  return { label: '', country: 'France' };
}

export function upsertClient(input: Partial<Client> & { id?: ID }): Client {
  return store.mutate((db) => {
    const existing = input.id ? db.clients.find((c) => c.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, {
        ...input,
        address: { ...existing.address, ...(input.address ?? {}) },
        tags: input.tags ?? existing.tags,
        aliases: input.aliases ?? existing.aliases,
        updatedAt: nowIso(),
      });
      return existing;
    }
    const client: Client = {
      id: newId('cli'),
      code: input.code?.trim() || nextClientCode(),
      name: input.name?.trim() || 'Client sans nom',
      legalName: input.legalName,
      contact: input.contact,
      email: input.email,
      phone: input.phone,
      siret: input.siret,
      vatNumber: input.vatNumber,
      address: { ...emptyAddress(), ...(input.address ?? {}) },
      notes: input.notes,
      tags: input.tags ?? [],
      aliases: input.aliases ?? [],
      archived: input.archived ?? false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.clients.push(client);
    return client;
  });
}

export function removeClient(id: ID): void {
  store.mutate((db) => {
    db.clients = db.clients.filter((c) => c.id !== id);
    // Les documents restent, mais perdent leur rattachement.
    for (const doc of db.documents) if (doc.clientId === id) doc.clientId = undefined;
    for (const route of db.routes) {
      for (const stop of route.stops) if (stop.clientId === id) stop.clientId = undefined;
    }
  });
}

/** Fusionne deux fiches en doublon : tout est reporté sur `keepId`. */
export function mergeClients(keepId: ID, mergeId: ID): Client {
  return store.mutate((db) => {
    const keep = db.clients.find((c) => c.id === keepId);
    const merge = db.clients.find((c) => c.id === mergeId);
    if (!keep || !merge) throw new Error('Client introuvable.');
    if (keepId === mergeId) return keep;

    // Complète les champs vides de la fiche conservée.
    for (const field of ['legalName', 'contact', 'email', 'phone', 'siret', 'vatNumber', 'notes'] as const) {
      if (!keep[field] && merge[field]) keep[field] = merge[field];
    }
    if (!keep.address.label && merge.address.label) keep.address = merge.address;
    keep.tags = [...new Set([...keep.tags, ...merge.tags])];
    keep.aliases = [...new Set([...keep.aliases, ...merge.aliases, merge.name])];
    keep.updatedAt = nowIso();

    for (const doc of db.documents) if (doc.clientId === mergeId) doc.clientId = keepId;
    for (const route of db.routes) {
      for (const stop of route.stops) if (stop.clientId === mergeId) stop.clientId = keepId;
    }
    db.clients = db.clients.filter((c) => c.id !== mergeId);
    return keep;
  });
}

/* ------------------------------------------------------------------ */
/* Rapprochement document ↔ client                                      */
/* ------------------------------------------------------------------ */

export interface ClientMatch {
  client: Client;
  score: number;
  method: 'siret' | 'exact' | 'alias' | 'fuzzy';
}

export function matchClient(clients: Client[], name?: string | null, siret?: string | null): ClientMatch | null {
  const pool = clients.filter((c) => !c.archived);
  if (!pool.length) return null;

  if (siret) {
    const digits = siret.replace(/\D/g, '');
    const hit = pool.find((c) => (c.siret ?? '').replace(/\D/g, '') === digits && digits.length >= 9);
    if (hit) return { client: hit, score: 1, method: 'siret' };
  }
  if (!name) return null;

  const n = normalize(name);
  if (!n) return null;

  const exact = pool.find((c) => normalize(c.name) === n);
  if (exact) return { client: exact, score: 1, method: 'exact' };

  for (const c of pool) {
    if (c.aliases.some((a) => normalize(a) === n)) return { client: c, score: 0.97, method: 'alias' };
  }

  let best: ClientMatch | null = null;
  for (const c of pool) {
    let score = similarity(c.name, name);
    if (c.legalName) score = Math.max(score, similarity(c.legalName, name));
    for (const a of c.aliases) score = Math.max(score, similarity(a, name));
    if (!best || score > best.score) best = { client: c, score: round2(score), method: 'fuzzy' };
  }
  return best && best.score >= FUZZY_ACCEPT ? best : null;
}

/** Retient l'orthographe rencontrée sur un document comme alias du client. */
export function rememberClientAlias(clientId: ID, rawName?: string | null): void {
  if (!rawName?.trim()) return;
  store.mutate((db) => {
    const client = db.clients.find((c) => c.id === clientId);
    if (!client) return;
    const n = normalize(rawName);
    if (!n || normalize(client.name) === n) return;
    if (client.aliases.some((a) => normalize(a) === n)) return;
    client.aliases.push(rawName.trim());
    client.updatedAt = nowIso();
  });
}

/** Crée une fiche à partir des informations lues sur un document comptable. */
export function createClientFromDocument(
  name: string,
  address?: string | null,
  siret?: string | null,
  email?: string | null,
  phone?: string | null,
): Client {
  const parsed = parseAddressLine(address ?? '');
  return upsertClient({
    name: name.trim(),
    siret: siret ?? undefined,
    email: email ?? undefined,
    phone: phone ?? undefined,
    address: { label: address?.trim() ?? '', ...parsed },
    tags: ['importé'],
    notes: 'Fiche créée automatiquement depuis un document comptable.',
  });
}

/**
 * Complète l'e-mail / le téléphone d'une fiche existante à partir d'un
 * document comptable, sans jamais écraser une valeur déjà saisie.
 */
export function fillClientContact(id: ID, email?: string | null, phone?: string | null): void {
  if (!email && !phone) return;
  store.mutate((db) => {
    const client = db.clients.find((c) => c.id === id);
    if (!client) return;
    let changed = false;
    if (!client.email && email) {
      client.email = email;
      changed = true;
    }
    if (!client.phone && phone) {
      client.phone = phone;
      changed = true;
    }
    if (changed) client.updatedAt = nowIso();
  });
}

/** Extrait code postal et ville d'une adresse écrite en une ligne. */
export function parseAddressLine(line: string): Partial<Address> {
  const out: Partial<Address> = {};
  if (!line) return out;
  const m = line.match(/\b(\d{5})\b[\s,-]*([A-Za-zÀ-ÿ' -]{2,40})/);
  if (m) {
    out.postcode = m[1];
    out.city = m[2].trim().replace(/[,;]$/, '');
    out.street = line.slice(0, m.index).replace(/[,;\s-]+$/, '').trim() || undefined;
  } else {
    out.street = line.trim();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Import de la liste clients                                           */
/* ------------------------------------------------------------------ */

function joinAddress(parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(', ');
}

/**
 * Importe une liste de clients depuis un fichier CSV / Excel.
 * Les colonnes sont reconnues automatiquement ; un mapping explicite peut être
 * fourni pour les fichiers atypiques. Les fiches déjà connues (code, SIRET,
 * e-mail ou nom) sont mises à jour plutôt que dupliquées.
 */
export async function importClientsFile(
  filePath: string,
  overrideMapping?: Record<string, string>,
): Promise<ImportClientsReport> {
  const table = await readTable(filePath);
  if (!table.rows.length) {
    return { total: 0, created: 0, updated: 0, skipped: 0, errors: ['Fichier vide ou illisible.'], headers: table.headers, mapping: {} };
  }

  const mapping = { ...guessMapping(table.headers, CLIENT_FIELDS), ...(overrideMapping ?? {}) };
  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const value = (row: Record<string, string>, field: string): string | undefined => {
    const column = mapping[field];
    if (!column) return undefined;
    const v = row[column];
    return v && v.trim() ? v.trim() : undefined;
  };

  if (!mapping.name) {
    return {
      total: table.rows.length,
      created: 0,
      updated: 0,
      skipped: table.rows.length,
      errors: [
        `Aucune colonne de nom identifiée. Colonnes du fichier : ${table.headers.join(', ')}.`,
      ],
      headers: table.headers,
      mapping,
    };
  }

  store.mutate((db) => {
    for (const [index, row] of table.rows.entries()) {
      const name = value(row, 'name');
      if (!name) {
        skipped++;
        continue;
      }
      const code = value(row, 'code');
      const siret = value(row, 'siret')?.replace(/\s/g, '');
      const email = value(row, 'email');

      // Identification d'une fiche existante, par ordre de fiabilité.
      const existing =
        (code && db.clients.find((c) => normalize(c.code) === normalize(code))) ||
        (siret && db.clients.find((c) => (c.siret ?? '').replace(/\D/g, '') === siret.replace(/\D/g, ''))) ||
        (email && db.clients.find((c) => (c.email ?? '').toLowerCase() === email.toLowerCase())) ||
        db.clients.find((c) => normalize(c.name) === normalize(name));

      const street = joinAddress([value(row, 'street'), value(row, 'street2')]);
      const postcode = value(row, 'postcode');
      const city = value(row, 'city');
      const country = value(row, 'country') ?? 'France';
      const label = joinAddress([street, [postcode, city].filter(Boolean).join(' ')]);
      const tagsRaw = value(row, 'tags');
      const tags = tagsRaw ? tagsRaw.split(/[;,|]/).map((t) => t.trim()).filter(Boolean) : [];

      const payload = {
        code: code ?? existing?.code,
        name,
        legalName: value(row, 'legalName'),
        contact: value(row, 'contact'),
        email,
        phone: value(row, 'phone'),
        siret,
        vatNumber: value(row, 'vatNumber'),
        notes: value(row, 'notes'),
        tags,
        address: {
          label: label || existing?.address.label || '',
          street: street || undefined,
          postcode,
          city,
          country,
          // Les coordonnées existantes sont conservées (géocodage déjà fait).
          lat: existing?.address.lat,
          lon: existing?.address.lon,
        },
      };

      try {
        if (existing) {
          Object.assign(existing, {
            ...payload,
            code: existing.code,
            tags: tags.length ? [...new Set([...existing.tags, ...tags])] : existing.tags,
            address: { ...existing.address, ...payload.address },
            updatedAt: nowIso(),
          });
          updated++;
        } else {
          const client: Client = {
            id: newId('cli'),
            code: payload.code?.trim() || nextClientCode(),
            name: payload.name,
            legalName: payload.legalName,
            contact: payload.contact,
            email: payload.email,
            phone: payload.phone,
            siret: payload.siret,
            vatNumber: payload.vatNumber,
            address: { ...emptyAddress(), ...payload.address },
            notes: payload.notes,
            tags: payload.tags,
            aliases: [],
            archived: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          db.clients.push(client);
          created++;
        }
      } catch (err) {
        errors.push(`Ligne ${index + 2} : ${(err as Error).message}`);
      }
    }
  });

  return { total: table.rows.length, created, updated, skipped, errors, headers: table.headers, mapping };
}

/* ------------------------------------------------------------------ */
/* Import du catalogue produits / consommables                          */
/* ------------------------------------------------------------------ */

export function nextProductSku(): string {
  const numbers = store.db.products
    .map((p) => Number(/(\d+)/.exec(p.sku ?? '')?.[1] ?? 0))
    .filter((n) => Number.isFinite(n));
  return `ART-${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(4, '0')}`;
}

export async function importProductsFile(
  filePath: string,
): Promise<{ created: number; updated: number; errors: string[] }> {
  const table = await readTable(filePath);
  if (!table.rows.length) return { created: 0, updated: 0, errors: ['Fichier vide ou illisible.'] };

  const mapping = guessMapping(table.headers, PRODUCT_FIELDS);
  if (!mapping.name && !mapping.sku) {
    return {
      created: 0,
      updated: 0,
      errors: [`Aucune colonne de désignation ou de référence identifiée. Colonnes : ${table.headers.join(', ')}.`],
    };
  }

  const errors: string[] = [];
  let created = 0;
  let updated = 0;

  const value = (row: Record<string, string>, field: string): string | undefined => {
    const column = mapping[field];
    if (!column) return undefined;
    const v = row[column];
    return v && v.trim() ? v.trim() : undefined;
  };

  store.mutate((db) => {
    for (const [index, row] of table.rows.entries()) {
      const sku = value(row, 'sku');
      const name = value(row, 'name') ?? sku;
      if (!name) continue;

      const existing =
        (sku && db.products.find((p) => normalize(p.sku) === normalize(sku))) ||
        db.products.find((p) => normalize(p.name) === normalize(name));

      const aliasesRaw = value(row, 'aliases');
      const aliases = aliasesRaw ? aliasesRaw.split(/[;|]/).map((a) => a.trim()).filter(Boolean) : [];

      const payload = {
        sku: sku ?? existing?.sku ?? nextProductSku(),
        name,
        category: value(row, 'category'),
        unit: value(row, 'unit') ?? 'pièce',
        qtyOnHand: parseNumber(value(row, 'qtyOnHand')) ?? 0,
        minQty: parseNumber(value(row, 'minQty')) ?? 0,
        unitCost: parseNumber(value(row, 'unitCost')) ?? undefined,
        supplier: value(row, 'supplier'),
      };

      try {
        if (existing) {
          Object.assign(existing, {
            ...payload,
            sku: existing.sku,
            qtyOnHand: mapping.qtyOnHand ? round2(payload.qtyOnHand) : existing.qtyOnHand,
            aliases: [...new Set([...existing.aliases, ...aliases])],
            updatedAt: nowIso(),
          });
          updated++;
        } else {
          const product: Product = {
            id: newId('prd'),
            sku: payload.sku,
            name: payload.name,
            category: payload.category,
            unit: payload.unit,
            qtyOnHand: round2(payload.qtyOnHand),
            minQty: round2(payload.minQty),
            unitCost: payload.unitCost,
            supplier: payload.supplier,
            aliases,
            archived: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          db.products.push(product);
          created++;
        }
      } catch (err) {
        errors.push(`Ligne ${index + 2} : ${(err as Error).message}`);
      }
    }
  });

  return { created, updated, errors };
}
