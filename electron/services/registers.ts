import type {
  DeliveryRoute,
  EventMachine,
  ID,
  MachineAvailability,
  RegisterEntry,
  RegisterStatus,
} from '@shared/types';
import { newId, nowIso, store, today } from '../store';
import {
  checkMachineAvailability,
  entryReservesMachines,
  machineAvailability,
  notificationFor,
} from './registerRules';
import { sendNotification } from './notify';
import { announce } from './activity';

/**
 * Les trois cahiers (SAV, consommables, événementiel) et le parc de machines.
 * La réservation des machines n'est jamais stockée : elle se déduit des
 * écritures « devis validé » non terminées, donc elle ne peut pas se
 * désynchroniser du cahier.
 */

function labelOf(entry: RegisterEntry): string {
  const client = entry.clientId
    ? store.db.clients.find((c) => c.id === entry.clientId)?.name
    : undefined;
  return [client ?? entry.clientName, entry.title].filter(Boolean).join(' — ') || 'Sans titre';
}

function clientNameOf(entry: RegisterEntry): string | undefined {
  if (entry.clientId) return store.db.clients.find((c) => c.id === entry.clientId)?.name;
  return entry.clientName;
}

/**
 * Prévient qui doit l'être, sans jamais bloquer l'enregistrement.
 *
 * Deux destinations pour un même message : les téléphones abonnés au sujet
 * ntfy, et les postes branchés sur le serveur, qui en feront une notification
 * du système. Le texte est écrit une seule fois — un cahier ne raconte pas
 * deux histoires différentes selon l'écran qui le lit.
 */
function pushNotification(entry: RegisterEntry, occasion: 'created' | 'confirmed'): void {
  const { notifyTopic, notifyUrl } = store.settings;
  const payload = notificationFor(entry, clientNameOf(entry), occasion);
  void sendNotification({ topic: notifyTopic, url: notifyUrl }, payload);
  announce('register', payload.title, payload.message);
}

/** Refuse de valider un devis si le parc ne suit pas, en nommant les manques. */
function assertMachinesAvailable(candidate: RegisterEntry): void {
  const shortages = checkMachineAvailability(
    store.db.eventMachines,
    store.db.registerEntries,
    candidate,
  );
  if (!shortages.length) return;
  const detail = shortages
    .map((s) => `${s.machine.name} (il en manque ${s.missing})`)
    .join(', ');
  throw new Error(
    `Parc insuffisant pour valider ce devis : ${detail}. ` +
      'Terminez une prestation en cours ou ajustez les machines demandées.',
  );
}

export function upsertRegisterEntry(
  input: Partial<RegisterEntry> & { id?: ID },
): RegisterEntry {
  if (!input.id && !input.kind) throw new Error('Cahier non précisé.');

  const entry = store.mutate((db) => {
    const existing = input.id ? db.registerEntries.find((e) => e.id === input.id) : undefined;

    if (existing) {
      const candidate: RegisterEntry = { ...existing, ...input, updatedAt: nowIso() };
      if (entryReservesMachines(candidate)) assertMachinesAvailable(candidate);
      const wasReserving = entryReservesMachines(existing);
      Object.assign(existing, candidate);
      if (!wasReserving && entryReservesMachines(existing)) {
        pushNotification(existing, 'confirmed');
      }
      return existing;
    }

    const created: RegisterEntry = {
      id: input.id ?? newId('reg'),
      kind: input.kind!,
      clientId: input.clientId,
      clientName: input.clientName?.trim() || undefined,
      title: input.title?.trim() || 'Sans titre',
      items: input.items?.filter((i) => i.qty > 0 && i.label.trim()),
      details: input.details?.trim() || undefined,
      eventDate: input.eventDate || undefined,
      machines: input.machines?.filter((m) => m.qty > 0),
      status: input.status ?? 'open',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (entryReservesMachines(created)) assertMachinesAvailable(created);
    db.registerEntries.unshift(created);
    pushNotification(created, 'created');
    if (entryReservesMachines(created)) pushNotification(created, 'confirmed');
    return created;
  });

  return entry;
}

export function setRegisterStatus(id: ID, status: RegisterStatus): RegisterEntry {
  return upsertRegisterEntry({ id, status });
}

/**
 * Ajoute l'écriture comme arrêt d'une tournée de livraison. `routeId` vide
 * crée une tournée du jour. L'adresse vient de la fiche client : sans fiche ni
 * adresse, on refuse plutôt que de créer un arrêt qu'aucun calcul ne pourra
 * placer.
 */
export function addRegisterEntryToRoute(
  entryId: ID,
  routeId?: ID,
): { route: DeliveryRoute; entry: RegisterEntry } {
  return store.mutate((db) => {
    const entry = db.registerEntries.find((e) => e.id === entryId);
    if (!entry) throw new Error('Écriture introuvable.');

    const client = entry.clientId ? db.clients.find((c) => c.id === entry.clientId) : undefined;
    if (!client) {
      throw new Error(
        'Cette écriture n’est rattachée à aucune fiche client : créez la fiche pour pouvoir l’ajouter à une tournée.',
      );
    }
    if (!client.address?.label?.trim()) {
      throw new Error(`La fiche « ${client.name} » n’a pas d’adresse : complétez-la depuis l’onglet Clients.`);
    }

    let route = routeId ? db.routes.find((r) => r.id === routeId) : undefined;
    if (routeId && !route) throw new Error('Tournée introuvable.');

    if (!route) {
      const date = entry.eventDate || today();
      route = {
        id: newId('rte'),
        name: `Tournée du ${date}`,
        date,
        vehicleId: db.settings.defaultVehicleId,
        start: {
          id: newId('stp'),
          label: 'Dépôt',
          address: db.settings.depot ?? { label: '', country: 'France' },
          pinned: false,
          serviceMinutes: 0,
        },
        stops: [],
        returnToStart: true,
        end: null,
        tollCost: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.routes.unshift(route);
    }

    // Un même client déjà présent n'est pas ajouté deux fois : on complète sa note.
    const existingStop = route.stops.find((s) => s.clientId === client.id);
    if (existingStop) {
      const mention = entry.title.trim();
      if (mention && !(existingStop.notes ?? '').includes(mention)) {
        existingStop.notes = [existingStop.notes, mention].filter(Boolean).join(' · ');
      }
    } else {
      route.stops.push({
        id: newId('stp'),
        clientId: client.id,
        label: client.name,
        address: { ...client.address },
        pinned: false,
        serviceMinutes: 15,
        notes: [entry.title, entry.details].filter(Boolean).join(' · ') || undefined,
      });
    }

    // Le calcul précédent ne vaut plus rien avec un arrêt de plus.
    route.computation = undefined;
    route.updatedAt = nowIso();

    entry.routeId = route.id;
    entry.updatedAt = nowIso();
    return { route, entry };
  });
}

export function removeRegisterEntry(id: ID): void {
  store.mutate((db) => {
    db.registerEntries = db.registerEntries.filter((e) => e.id !== id);
  });
}

export function listRegisterEntries(): RegisterEntry[] {
  return [...store.db.registerEntries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ------------------------------------------------------------------ */
/* Parc de machines                                                     */
/* ------------------------------------------------------------------ */

export function upsertMachine(input: Partial<EventMachine> & { id?: ID }): EventMachine {
  return store.mutate((db) => {
    const existing = input.id ? db.eventMachines.find((m) => m.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, {
        name: input.name?.trim() || existing.name,
        reference: input.reference?.trim() || undefined,
        qtyTotal: input.qtyTotal ?? existing.qtyTotal,
        notes: input.notes?.trim() || undefined,
        archived: input.archived ?? existing.archived,
        updatedAt: nowIso(),
      });
      return existing;
    }
    const machine: EventMachine = {
      id: input.id ?? newId('mch'),
      name: input.name?.trim() || 'Machine sans nom',
      reference: input.reference?.trim() || undefined,
      qtyTotal: Math.max(0, input.qtyTotal ?? 1),
      notes: input.notes?.trim() || undefined,
      archived: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.eventMachines.push(machine);
    return machine;
  });
}

export function removeMachine(id: ID): void {
  store.mutate((db) => {
    const reservedBy = db.registerEntries.filter(
      (e) => entryReservesMachines(e) && e.machines?.some((m) => m.machineId === id && m.qty > 0),
    );
    if (reservedBy.length) {
      throw new Error(
        'Cette machine est réservée par un devis validé : terminez ou annulez la prestation avant de la retirer du parc.',
      );
    }
    db.eventMachines = db.eventMachines.filter((m) => m.id !== id);
  });
}

/** Parc avec disponibilité et prochaines sorties, pour le tableau de l'onglet. */
export function listMachineAvailability(): MachineAvailability[] {
  return machineAvailability(store.db.eventMachines, store.db.registerEntries, labelOf).sort(
    (a, b) => a.machine.name.localeCompare(b.machine.name, 'fr'),
  );
}
