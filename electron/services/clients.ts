import type { Address, Client, ID, ImportClientsReport, Product } from '@shared/types';
import { newId, nowIso, store } from '../store';
import { parseAddressLine } from './address';
import {
  explicitProductType,
  guessProductType,
  parseActive,
  parseInvoicedAs,
  parseVatRate,
  saleHtFrom,
} from './productFields';
import { looksLikeClientName, normalize, parseNumber, round2, similarity } from './text';
import { CLIENT_FIELDS, PRODUCT_FIELDS, guessMapping, readTable } from './tabular';
import { adjustStock, registerOpeningStock } from './stock';

export { cleanAddressLine, parseAddressLine, repairAddress } from './address';

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
      // Une fiche créée hors ligne pré-assigne son identifiant : on le respecte.
      id: input.id ?? newId('cli'),
      code: input.code?.trim() || nextClientCode(),
      name: input.name?.trim() || 'Client sans nom',
      legalName: input.legalName,
      contact: input.contact,
      email: input.email,
      phone: input.phone,
      mobile: input.mobile,
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
    for (const field of ['legalName', 'contact', 'email', 'phone', 'mobile', 'siret', 'vatNumber', 'notes'] as const) {
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

  // Un alias qui porte le nom d'une AUTRE fiche n'est pas une orthographe : il
  // vient d'un rapprochement automatique malheureux, qui a inscrit le nom d'un
  // client dans la fiche d'un autre. S'en servir attirait toutes les pièces de
  // l'un vers l'autre, avec un score presque parfait et sans le moindre
  // avertissement.
  const named = new Set(pool.map((c) => normalize(c.name)));
  const usableAlias = (client: Client, alias: string): boolean => {
    if (!looksLikeClientName(alias)) return false;
    const a = normalize(alias);
    return !(named.has(a) && a !== normalize(client.name));
  };

  for (const c of pool) {
    if (c.aliases.some((a) => usableAlias(c, a) && normalize(a) === n)) {
      return { client: c, score: 0.97, method: 'alias' };
    }
  }

  let best: ClientMatch | null = null;
  for (const c of pool) {
    let score = similarity(c.name, name);
    if (c.legalName) score = Math.max(score, similarity(c.legalName, name));
    // Un alias qui n'a jamais pu être un nom de client ne sert pas de point de
    // comparaison. Les fiches en portent parfois d'anciens, hérités d'un
    // rapprochement automatique malheureux ; les ignorer répare la fiche sans
    // rien demander à l'utilisateur.
    for (const a of c.aliases) {
      if (!usableAlias(c, a)) continue;
      score = Math.max(score, similarity(a, name));
    }
    if (!best || score > best.score) best = { client: c, score: round2(score), method: 'fuzzy' };
  }
  return best && best.score >= FUZZY_ACCEPT ? best : null;
}

/**
 * Oublie toutes les orthographes mémorisées sur les fiches.
 *
 * Réparation d'un dégât précis : pendant des mois, chaque rapprochement par
 * ressemblance inscrivait le nom lu comme alias de la fiche retenue. Une
 * lecture erronée devenait donc une certitude, et cet alias servait ensuite de
 * point de comparaison — attirant à son tour toutes les pièces voisines. Le
 * mécanisme est retiré, mais les alias déjà écrits gardent leur pouvoir : un
 * nom pourtant lu correctement repart vers la mauvaise fiche, avec un score de
 * 0,97 et sans le moindre signe.
 *
 * On ne peut pas distinguer après coup ce qui a été appris tout seul de ce que
 * l'utilisateur a confirmé : les deux se ressemblent en base. D'où ce geste
 * explicite, à sa main. Ce qu'il perd est modeste — corriger à nouveau un
 * rattachement réapprend l'orthographe — au regard de ce qu'il récupère.
 */
export function forgetLearnedAliases(): { clients: number; aliases: number } {
  let clients = 0;
  let aliases = 0;
  store.mutate((db) => {
    for (const client of db.clients) {
      if (!client.aliases.length) continue;
      clients++;
      aliases += client.aliases.length;
      client.aliases = [];
      client.updatedAt = nowIso();
    }
  });
  return { clients, aliases };
}

/** Retient l'orthographe rencontrée sur un document comme alias du client. */
export function rememberClientAlias(clientId: ID, rawName?: string | null): void {
  if (!rawName?.trim()) return;
  // Ce qui n'a jamais pu être un nom de client n'a rien à faire dans les alias.
  if (!looksLikeClientName(rawName)) return;
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
  contact?: string | null,
): Client {
  const parsed = parseAddressLine(address ?? '');
  return upsertClient({
    name: name.trim(),
    contact: contact?.trim() || undefined,
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
export function fillClientContact(
  id: ID,
  email?: string | null,
  phone?: string | null,
  contact?: string | null,
): void {
  if (!email && !phone && !contact) return;
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
    if (!client.contact && contact?.trim()) {
      client.contact = contact.trim();
      changed = true;
    }
    if (changed) client.updatedAt = nowIso();
  });
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

  // Une mise à jour ne doit toucher que ce que le fichier apporte : une
  // colonne absente laissait `undefined` écraser l'e-mail ou les notes déjà
  // saisis sur la fiche. On ne reporte donc que les valeurs présentes.
  const present = <T extends object>(obj: T): Partial<T> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

  store.mutate((db) => {
    for (const [index, row] of table.rows.entries()) {
      const legalName = value(row, 'legalName');
      // Les exports comptables séparent Nom et Prénom ; une société n'a
      // parfois que sa raison sociale. La fiche porte le nom complet.
      const name =
        [value(row, 'firstName'), value(row, 'name')].filter(Boolean).join(' ') || legalName;
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

      let street: string | undefined =
        joinAddress([value(row, 'street'), value(row, 'street2'), value(row, 'street3')]) || undefined;
      let postcode = value(row, 'postcode');
      let city = value(row, 'city');
      let country = value(row, 'country');
      // Fichier sans colonnes CP/ville : l'adresse arrive en une seule ligne,
      // on la découpe pour que la ville s'affiche et se géolocalise.
      if (street && !postcode && !city) {
        const parsed = parseAddressLine(street);
        if (parsed.postcode || parsed.city) {
          street = parsed.street;
          postcode = parsed.postcode;
          city = parsed.city;
          country = country ?? parsed.country;
        }
      }
      const label =
        joinAddress([street, [postcode, city].filter(Boolean).join(' ')]) || undefined;
      const tagsRaw = value(row, 'tags');
      const tags = tagsRaw ? tagsRaw.split(/[;,|]/).map((t) => t.trim()).filter(Boolean) : [];

      const fields = {
        name,
        legalName,
        contact: value(row, 'contact'),
        email,
        phone: value(row, 'phone'),
        mobile: value(row, 'mobile'),
        siret,
        vatNumber: value(row, 'vatNumber'),
        notes: value(row, 'notes'),
      };
      const addressPatch = { label, street, postcode, city, country };

      try {
        if (existing) {
          Object.assign(existing, present(fields), {
            tags: tags.length ? [...new Set([...existing.tags, ...tags])] : existing.tags,
            // Les coordonnées GPS déjà trouvées restent : le géocodage est fait.
            address: { ...existing.address, ...present(addressPatch) },
            updatedAt: nowIso(),
          });
          updated++;
        } else {
          const client: Client = {
            id: newId('cli'),
            code: code?.trim() || nextClientCode(),
            name,
            legalName: fields.legalName,
            contact: fields.contact,
            email: fields.email,
            phone: fields.phone,
            mobile: fields.mobile,
            siret: fields.siret,
            vatNumber: fields.vatNumber,
            address: { ...emptyAddress(), ...present(addressPatch), label: label ?? '' },
            notes: fields.notes,
            tags,
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

  // Comme pour les clients : une colonne absente du fichier ne doit jamais
  // effacer ce que la fiche porte déjà.
  const present = <T extends object>(obj: T): Partial<T> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

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

      const category = value(row, 'category');
      const vatRate = parseVatRate(value(row, 'vatRate'));
      const salePrice = saleHtFrom(value(row, 'salePrice'), value(row, 'salePriceTtc'), vatRate);
      const active = parseActive(value(row, 'state'));
      const declaredType = explicitProductType(value(row, 'type'));
      const numberOf = (field: string): number | undefined => {
        const parsed = parseNumber(value(row, field));
        return parsed == null ? undefined : round2(parsed);
      };

      // Champs repris tels quels quand le fichier les porte.
      const fields = {
        name,
        description: value(row, 'description'),
        category,
        unit: value(row, 'unit'),
        packSize: numberOf('packSize'),
        packMeasure: value(row, 'packMeasure'),
        unitsPerCase: numberOf('unitsPerCase'),
        invoicedAs: parseInvoicedAs(value(row, 'invoicedAs')) ?? undefined,
        accountingCode: value(row, 'accountingCode'),
        unitCost: numberOf('unitCost'),
        salePrice: salePrice ?? undefined,
        vatRate: vatRate ?? undefined,
        leadTimeDays: numberOf('leadTimeDays'),
        minQty: numberOf('minQty'),
        supplier: value(row, 'supplier'),
        archived: active == null ? undefined : !active,
      };

      const stockInFile = mapping.qtyOnHand ? numberOf('qtyOnHand') : undefined;

      try {
        if (existing) {
          Object.assign(existing, present(fields), {
            // La nature n'est réécrite que si le fichier la nomme : sinon une
            // devinette effacerait un classement fait à la main.
            ...(declaredType ? { type: declaredType } : {}),
            aliases: [...new Set([...existing.aliases, ...aliases])],
            updatedAt: nowIso(),
          });
          // La quantité passe par un mouvement : le total repart toujours de
          // la somme du journal, jamais d'un nombre écrit directement.
          if (stockInFile !== undefined && stockInFile !== round2(existing.qtyOnHand)) {
            adjustStock(existing.id, stockInFile, 'Import du stock');
          }
          updated++;
        } else {
          const product: Product = {
            id: newId('prd'),
            sku: sku?.trim() || nextProductSku(),
            name,
            type: declaredType ?? guessProductType(name, category),
            unit: 'pièce',
            qtyOnHand: 0,
            minQty: 0,
            ...present(fields),
            archived: active === false,
            aliases,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          db.products.push(product);
          registerOpeningStock(product, stockInFile ?? 0, 'Import du stock');
          created++;
        }
      } catch (err) {
        errors.push(`Ligne ${index + 2} : ${(err as Error).message}`);
      }
    }
  });

  return { created, updated, errors };
}
