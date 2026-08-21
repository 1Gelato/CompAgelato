import type {
  EventMachine,
  MachineAvailability,
  RegisterEntry,
  RegisterKind,
  RegisterStatus,
} from '@shared/types';

/**
 * Règles des cahiers (SAV, consommables, événementiel), sans dépendance à la
 * base ni à Electron : tout se teste directement sous `node --test`.
 */

export const REGISTER_KIND_LABEL: Record<RegisterKind, string> = {
  sav: 'SAV',
  consumables: 'Consommables',
  event: 'Événementiel',
  purchase: 'Achats',
  wintering: 'Hivernage',
};

/** Libellés de statut propres à chaque cahier. */
export const REGISTER_STATUS_LABEL: Record<RegisterKind, Record<RegisterStatus, string>> = {
  sav: { open: 'À traiter', confirmed: 'En cours', done: 'Résolu', cancelled: 'Annulé' },
  consumables: { open: 'À préparer', confirmed: 'En préparation', done: 'Livré', cancelled: 'Annulé' },
  event: { open: 'Demande', confirmed: 'Devis validé', done: 'Terminé', cancelled: 'Annulé' },
  purchase: { open: 'Demande', confirmed: 'En discussion', done: 'Vendu', cancelled: 'Sans suite' },
  wintering: { open: 'Annoncée', confirmed: 'Au dépôt', done: 'Restituée', cancelled: 'Annulée' },
};

/**
 * Une machine n'est réservée que par un devis validé non terminé. C'est la
 * règle demandée : une simple demande ne retire rien du parc, et une
 * prestation terminée ou annulée rend ses machines.
 */
export function entryReservesMachines(entry: Pick<RegisterEntry, 'kind' | 'status'>): boolean {
  return entry.kind === 'event' && entry.status === 'confirmed';
}

/**
 * Disponibilité du parc, calculée à la demande à partir des cahiers — jamais
 * stockée, donc impossible à désynchroniser.
 */
export function machineAvailability(
  machines: EventMachine[],
  entries: RegisterEntry[],
  labelOf: (entry: RegisterEntry) => string = (e) => e.title,
): MachineAvailability[] {
  const reserving = entries.filter(entryReservesMachines);

  return machines
    .filter((m) => !m.archived)
    .map((machine) => {
      let reserved = 0;
      const upcoming: MachineAvailability['upcoming'] = [];
      for (const entry of reserving) {
        for (const line of entry.machines ?? []) {
          if (line.machineId !== machine.id || line.qty <= 0) continue;
          reserved += line.qty;
          upcoming.push({ entryId: entry.id, date: entry.eventDate, label: labelOf(entry), qty: line.qty });
        }
      }
      upcoming.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
      return { machine, reserved, available: Math.max(0, machine.qtyTotal - reserved), upcoming };
    });
}

/**
 * Vérifie qu'une écriture peut réserver ses machines. Renvoie la liste des
 * manques (machine + nombre manquant), vide si tout est disponible. L'écriture
 * en cours de modification est exclue du calcul : passer une demande en devis
 * validé ne doit pas se bloquer elle-même.
 */
export function checkMachineAvailability(
  machines: EventMachine[],
  entries: RegisterEntry[],
  candidate: RegisterEntry,
): { machine: EventMachine; missing: number }[] {
  if (!entryReservesMachines(candidate)) return [];
  const others = entries.filter((e) => e.id !== candidate.id);
  const availability = new Map(
    machineAvailability(machines, others).map((a) => [a.machine.id, a]),
  );

  const shortages: { machine: EventMachine; missing: number }[] = [];
  for (const line of candidate.machines ?? []) {
    if (line.qty <= 0) continue;
    const slot = availability.get(line.machineId);
    if (!slot) continue; // machine supprimée/archivée : rien à réserver
    if (line.qty > slot.available) {
      shortages.push({ machine: slot.machine, missing: line.qty - slot.available });
    }
  }
  return shortages;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                        */
/* ------------------------------------------------------------------ */

export interface NotificationPayload {
  title: string;
  message: string;
  /** Étiquettes ntfy (converties en émoji sur le téléphone). */
  tags: string[];
}

const KIND_TAGS: Record<RegisterKind, string> = {
  sav: 'wrench',
  consumables: 'package',
  event: 'tada',
  purchase: 'moneybag',
  wintering: 'snowflake',
};

/** « 2026-08-12 » → « 12/08/2026 » (sans dépendre du code de l'interface). */
function frDate(iso?: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/**
 * Message poussé sur les téléphones à l'ajout d'une écriture, ou quand un
 * devis événementiel est validé (c'est l'acte qui réserve les machines).
 */
export function notificationFor(
  entry: RegisterEntry,
  clientName: string | undefined,
  occasion: 'created' | 'confirmed' = 'created',
): NotificationPayload {
  const kind = REGISTER_KIND_LABEL[entry.kind];
  const who = clientName ?? entry.clientName ?? 'Client inconnu';
  const date = entry.eventDate ? ` — le ${frDate(entry.eventDate)}` : '';
  const items = (entry.items ?? []).map((i) => `${i.qty} × ${i.label}`).join(', ');

  if (occasion === 'confirmed') {
    return {
      title: `Devis validé — ${who}`,
      message: `${entry.title}${date} : machines réservées.`,
      tags: ['white_check_mark', KIND_TAGS[entry.kind]],
    };
  }
  return {
    title: `${kind} — ${who}`,
    message: `${entry.title}${date}${items ? ` (${items})` : ''}`,
    tags: [KIND_TAGS[entry.kind]],
  };
}
