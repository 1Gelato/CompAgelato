import type { DeliveryNote, ID } from '@shared/types';
import { newId, nowIso, store, today } from '../store';
import { currentIdentity } from '../context';
import { sendNotification } from './notify';
import { announce } from './activity';

/**
 * Les bons de livraison — le bon papier signé sur le capot, numérisé.
 *
 * Un client servi en route sans facture préparée : le livreur note les
 * articles sur son téléphone, signe, fait signer le client, et le bon arrive
 * au bureau dans la minute — annoncé comme les tâches et les cahiers (bulle
 * du poste, notification des téléphones). La facture se fait ensuite ; le
 * bon garde la trace de qui a reçu quoi, signatures à l'appui.
 */

/** Total HT d'un bon : ce que valent les lignes qui portent un prix. */
export function deliveryTotal(items: { qty: number; unitPrice?: number }[]): number {
  const total = items.reduce((sum, item) => sum + (item.unitPrice ?? 0) * (item.qty || 0), 0);
  return Math.round(total * 100) / 100;
}

/** BL-2026-0001, BL-2026-0002… — la suite repart à 1 chaque année. */
export function nextDeliveryNumber(notes: DeliveryNote[], date?: string): string {
  const year = (date ?? today()).slice(0, 4);
  const prefix = `BL-${year}-`;
  const numbers = notes
    .filter((n) => n.number?.startsWith(prefix))
    .map((n) => Number(n.number.slice(prefix.length)))
    .filter((n) => Number.isFinite(n));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function clientNameOf(note: DeliveryNote): string {
  if (note.clientId) {
    const client = store.db.clients.find((c) => c.id === note.clientId);
    if (client) return client.name;
  }
  return note.clientName?.trim() || 'client sans fiche';
}

/**
 * Prévient le bureau — même double canal que les tâches : sujet ntfy si
 * configuré, et annonce aux postes branchés + téléphones abonnés. Jamais
 * bloquant : le bon compte, la bulle non.
 */
function announceSigned(note: DeliveryNote): void {
  const who = clientNameOf(note);
  const count = note.items.length;
  const total = deliveryTotal(note.items);
  const title = `Bon de livraison ${note.number} — ${who}`;
  const parts = [
    count ? `${count} article(s)` : 'sans article détaillé',
    // Le montant intéresse le bureau, qui va faire la facture — qu'il ait été
    // montré au client ou non.
    total ? `${total.toFixed(2)} € HT` : '',
    note.createdByName ? `par ${note.createdByName}` : '',
    note.clientSignature ? 'signé par le client' : 'non signé par le client',
  ].filter(Boolean);
  const message = parts.join(' · ');

  const { notifyTopic, notifyUrl } = store.settings;
  void sendNotification(
    { topic: notifyTopic, url: notifyUrl },
    { title, message, tags: ['package'] },
  );
  announce('delivery', title, message);
}

export function listDeliveryNotes(): DeliveryNote[] {
  return [...store.db.deliveryNotes].sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  );
}

export function upsertDeliveryNote(input: Partial<DeliveryNote> & { id?: ID }): DeliveryNote {
  const { note, created } = store.mutate((db) => {
    const existing = input.id ? db.deliveryNotes.find((n) => n.id === input.id) : undefined;

    if (existing) {
      Object.assign(existing, {
        ...input,
        // Le numéro et l'origine ne se réécrivent jamais : c'est l'identité du bon.
        id: existing.id,
        number: existing.number,
        createdBy: existing.createdBy,
        createdByName: existing.createdByName,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
      });
      return { note: existing, created: false };
    }

    const identity = currentIdentity();
    const note: DeliveryNote = {
      // Une fiche créée hors ligne pré-assigne son identifiant : on le respecte.
      id: input.id ?? newId('bl'),
      // Le numéro, lui, est toujours attribué ici : deux téléphones hors ligne
      // choisiraient le même, seul le serveur peut tenir la suite.
      number: nextDeliveryNumber(db.deliveryNotes, input.date),
      date: input.date ?? today(),
      clientId: input.clientId,
      clientName: input.clientName?.trim() || undefined,
      items: (input.items ?? []).filter((item) => item.label?.trim()),
      // Le réglage donne l'habitude de la maison ; le bon garde le dernier mot.
      showPrices: input.showPrices ?? store.settings.deliveryNotePrices ?? false,
      notes: input.notes?.trim() || undefined,
      routeId: input.routeId,
      driverSignature: input.driverSignature,
      clientSignature: input.clientSignature,
      status: input.status === 'invoiced' ? 'invoiced' : 'signed',
      documentId: input.documentId,
      createdBy: identity?.userId,
      createdByName: identity?.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.deliveryNotes.push(note);
    return { note, created: true };
  });

  if (created) announceSigned(note);
  return note;
}

/** La facture est faite (ou le geste se défait) : le bon change simplement d'état. */
export function markDeliveryInvoiced(id: ID, invoiced: boolean, documentId?: ID): DeliveryNote {
  return store.mutate((db) => {
    const note = db.deliveryNotes.find((n) => n.id === id);
    if (!note) throw new Error('Bon de livraison introuvable.');
    note.status = invoiced ? 'invoiced' : 'signed';
    note.documentId = invoiced ? documentId ?? note.documentId : undefined;
    note.updatedAt = nowIso();
    return note;
  });
}

export function removeDeliveryNote(id: ID): void {
  store.mutate((db) => {
    db.deliveryNotes = db.deliveryNotes.filter((n) => n.id !== id);
  });
}
