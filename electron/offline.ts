import fs from 'node:fs';
import path from 'node:path';
import type {
  AuthIdentity,
  AuthStatus,
  SyncPullResult,
  SyncStatus,
  QueuedIntent,
} from '@shared/api';
import { CHANNELS } from '@shared/api';
import type {
  AccountingDocument,
  Attachment,
  ID,
  RegisterEntry,
  Role,
  Settings,
  StockMove,
  SyncedCollection,
  Syncable,
  Task,
} from '@shared/types';
import { SYNCED_COLLECTIONS } from '@shared/types';
import { TASK_PRIORITY_RANK } from '@shared/format';
import type { Registry } from './handlers';
import { newId, nowIso } from './store';
import { machineAvailability } from './services/registerRules';
import { round2 } from './services/text';
import { RemoteError, createRemoteRegistry, remoteCall } from './remote';

/**
 * Le mode hors-ligne de l'application branchée sur un serveur.
 *
 * Principe directeur, celui du plan : **descendre des états, remonter des
 * intentions.** Le serveur descend ses enregistrements modifiés (`sync:pull`),
 * et ce module les range tels quels dans un miroir sur disque — aucune logique
 * de fusion ici. Dans l'autre sens, chaque écriture faite sans réseau est
 * journalisée comme une intention `{namespace, method, args}` dans un fichier
 * durable, puis rejouée dans l'ordre au retour du serveur : ce sont les
 * gestionnaires du serveur, contre l'état réel du serveur, qui résolvent les
 * conflits — les règles métier ne sont écrites qu'une fois.
 *
 * En ligne, rien ne change : les appels partent au serveur comme avant, et le
 * miroir se rafraîchit en arrière-plan. La bascule est automatique dans les
 * deux sens, et un rejeu refusé est **présenté à l'utilisateur**, jamais
 * abandonné en silence.
 */

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */

interface MirrorFile {
  generation: string;
  role: Role | null;
  identity: AuthIdentity | null;
  /** Dernière révision répliquée. */
  since: number;
  savedAt: string;
  collections: Partial<Record<SyncedCollection, unknown[]>>;
  settings: Settings | null;
}

interface QueueFile {
  pending: QueuedIntent[];
  failed: QueuedIntent[];
}

let mirrorPath = '';
let queuePath = '';
let mirror: MirrorFile | null = null;
let queue: QueueFile = { pending: [], failed: [] };
let offline = false;
let lastPullAt: string | undefined;

/** Prévient l'hôte (fenêtre Electron) d'un passage hors-ligne / en ligne. */
let onTransition: (online: boolean, replayed: number, failed: number) => void = () => {};

export function setTransitionListener(fn: typeof onTransition): void {
  onTransition = fn;
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function saveMirror(): void {
  if (mirror && mirrorPath) writeJson(mirrorPath, mirror);
}

function saveQueue(): void {
  if (queuePath) writeJson(queuePath, queue);
}

export function initOffline(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  mirrorPath = path.join(dataDir, 'miroir.json');
  queuePath = path.join(dataDir, 'attente.json');
  try {
    if (fs.existsSync(mirrorPath)) mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
  } catch (err) {
    // Miroir illisible : il sera reconstruit à la prochaine synchronisation.
    console.error('[hors-ligne] miroir illisible, il sera resynchronisé :', err);
    mirror = null;
  }
  try {
    if (fs.existsSync(queuePath)) queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (err) {
    // La file, elle, contient du travail de l'utilisateur : on la met de côté
    // plutôt que de l'écraser.
    console.error('[hors-ligne] file d’attente illisible :', err);
    try {
      fs.copyFileSync(queuePath, `${queuePath}.corrompu-${Date.now()}`);
    } catch {
      /* ignore */
    }
    queue = { pending: [], failed: [] };
  }
}

export function hasMirror(): boolean {
  return mirror !== null;
}

/** Réglages mémorisés, pour les écrans qui s'ouvrent serveur éteint. */
export function mirrorSettings(): Settings | null {
  return mirror?.settings ?? null;
}

export function isOffline(): boolean {
  return offline;
}

export function markOffline(): void {
  if (offline) return;
  offline = true;
  onTransition(false, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Synchronisation descendante                                          */
/* ------------------------------------------------------------------ */

let pulling: Promise<void> | null = null;
let pullTimer: NodeJS.Timeout | null = null;

/** Applique un delta du serveur au miroir. Remplacer, supprimer — c'est tout. */
function applyPull(result: SyncPullResult): void {
  const base: MirrorFile =
    result.full || !mirror || mirror.generation !== result.generation
      ? {
          generation: result.generation,
          role: result.role,
          identity: result.identity,
          since: 0,
          savedAt: nowIso(),
          collections: {},
          settings: null,
        }
      : mirror;

  for (const collection of SYNCED_COLLECTIONS) {
    const incoming = result.changes[collection];
    if (result.full) {
      // Synchronisation complète : la collection est remplacée — et une
      // collection absente de la réponse (rôle sans droit) est retirée.
      if (incoming) base.collections[collection] = incoming;
      else delete base.collections[collection];
      continue;
    }
    if (!incoming) continue;
    const rows = (base.collections[collection] ?? []) as (Syncable & { id: ID })[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of incoming as (Syncable & { id: ID })[]) byId.set(row.id, row);
    for (const id of result.removed[collection] ?? []) byId.delete(id);
    base.collections[collection] = [...byId.values()];
  }

  if (result.settings) base.settings = result.settings;
  base.since = result.maxRev;
  base.role = result.role;
  base.identity = result.identity;
  base.savedAt = nowIso();
  mirror = base;
  lastPullAt = nowIso();
  saveMirror();
}

/** Synchronise maintenant. Les appels concurrents partagent la même passe. */
export function pullNow(): Promise<void> {
  if (pulling) return pulling;
  pulling = (async () => {
    const result = (await remoteCall('sync', 'pull', [
      // Un changement de rôle doit forcer la resynchronisation complète : les
      // collections visibles ne sont plus les mêmes. On oublie donc notre
      // génération quand le rôle mémorisé diffère de celui du serveur.
      mirror
        ? { generation: mirror.generation, since: mirror.since }
        : {},
    ])) as SyncPullResult;
    if (mirror && mirror.role !== result.role) {
      mirror = null;
      const again = (await remoteCall('sync', 'pull', [{}])) as SyncPullResult;
      applyPull(again);
      return;
    }
    applyPull(result);
  })().finally(() => {
    pulling = null;
  });
  return pulling;
}

/** Synchronisation groupée : plusieurs écritures rapprochées → une seule passe. */
export function schedulePull(delayMs = 600): void {
  if (pullTimer) return;
  pullTimer = setTimeout(() => {
    pullTimer = null;
    pullNow().catch(() => {
      /* serveur reparti ? la prochaine occasion réessaiera */
    });
  }, delayMs);
  pullTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* File d'attente montante                                              */
/* ------------------------------------------------------------------ */

function enqueue(namespace: string, method: string, args: unknown[]): void {
  queue.pending.push({ id: newId('int'), at: nowIso(), namespace, method, args });
  saveQueue();
}

/**
 * Rejoue la file dans l'ordre. Une coupure en cours de route arrête tout (on
 * est encore hors ligne) ; un refus métier — la fiche visée a été supprimée
 * entre-temps, le stock déjà déduit ailleurs — met l'intention de côté avec son
 * explication, à l'attention de l'utilisateur.
 */
async function replayQueue(): Promise<{ replayed: number; failed: number }> {
  let replayed = 0;
  let failed = 0;
  while (queue.pending.length) {
    const intent = queue.pending[0];
    try {
      await remoteCall(intent.namespace, intent.method, intent.args);
      queue.pending.shift();
      replayed++;
      saveQueue();
    } catch (err) {
      if (err instanceof RemoteError && err.network) throw err;
      queue.pending.shift();
      queue.failed.push({ ...intent, error: (err as Error).message ?? String(err) });
      failed++;
      saveQueue();
    }
  }
  return { replayed, failed };
}

/** Le serveur est revenu : rejouer, resynchroniser, prévenir. */
export async function backOnline(): Promise<void> {
  const wasOffline = offline;
  try {
    const { replayed, failed } = await replayQueue();
    await pullNow();
    offline = false;
    if (wasOffline || replayed || failed) onTransition(true, replayed, failed);
  } catch {
    // Retombé pendant le rejeu : on reste hors ligne, la reconnexion suivante
    // reprendra la file là où elle en était.
    offline = true;
  }
}

export function syncStatus(): SyncStatus {
  return {
    online: !offline,
    since: mirror?.since ?? 0,
    lastPullAt,
    pending: [...queue.pending],
    failed: [...queue.failed],
  };
}

export async function retryNow(): Promise<SyncStatus> {
  await backOnline();
  return syncStatus();
}

export function discardIntent(intentId: ID): SyncStatus {
  queue.failed = queue.failed.filter((intent) => intent.id !== intentId);
  queue.pending = queue.pending.filter((intent) => intent.id !== intentId);
  saveQueue();
  return syncStatus();
}

/* ------------------------------------------------------------------ */
/* Lectures servies par le miroir                                       */
/* ------------------------------------------------------------------ */

function rows<T>(collection: SyncedCollection): T[] {
  return (mirror?.collections[collection] ?? []) as T[];
}

function requireMirror(): void {
  if (!mirror) {
    throw new Error(
      'Serveur injoignable et aucune copie locale : connectez-vous une première fois au serveur.',
    );
  }
}

/**
 * Ce qu'on sait servir sans le serveur. Même logique de tri que les
 * gestionnaires d'origine : l'interface ne voit pas la différence.
 */
const MIRROR_READS: Record<string, (...args: unknown[]) => unknown> = {
  'clients:list': () =>
    [...rows<{ name: string }>('clients')].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  'documents:list': () =>
    [...rows<AccountingDocument>('documents')].sort(
      (a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.importedAt.localeCompare(a.importedAt),
    ),
  'documents:get': (id) => rows<AccountingDocument>('documents').find((d) => d.id === id) ?? null,
  'products:list': () =>
    [...rows<{ name: string }>('products')].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  'stock:moves': (productId) => {
    const all = rows<StockMove>('stockMoves');
    const balances = new Map<ID, number>();
    const computed = new Map<ID, number>();
    for (const move of [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const balance = round2((balances.get(move.productId) ?? 0) + move.qty);
      balances.set(move.productId, balance);
      computed.set(move.id, balance);
    }
    return [...all]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((m) => !productId || m.productId === productId)
      .slice(0, 500)
      .map((m) => ({ ...m, balanceAfter: computed.get(m.id) ?? m.balanceAfter }));
  },
  'routes:list': () =>
    [...rows<{ date?: string }>('routes')].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')),
  'vehicles:list': () => rows('vehicles'),
  'registers:list': () =>
    [...rows<RegisterEntry>('registerEntries')].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  'machines:list': () => {
    // La disponibilité se calcule d'une fonction pure déjà testée : le miroir
    // a les machines et les cahiers, cela suffit.
    const clients = new Map(rows<{ id: ID; name: string }>('clients').map((c) => [c.id, c.name]));
    return machineAvailability(
      rows('eventMachines'),
      rows<RegisterEntry>('registerEntries'),
      (entry) => entry.clientName ?? (entry.clientId ? clients.get(entry.clientId) : undefined) ?? entry.title,
    ).sort((a, b) => a.machine.name.localeCompare(b.machine.name, 'fr'));
  },
  // Même tri que le serveur : l'urgent d'abord, puis l'échéance la plus
  // proche. La purge automatique de la corbeille, elle, attend le serveur.
  'tasks:list': () =>
    [...rows<Task>('tasks')].sort(
      (a, b) =>
        (TASK_PRIORITY_RANK[a.priority] ?? 2) - (TASK_PRIORITY_RANK[b.priority] ?? 2) ||
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        b.createdAt.localeCompare(a.createdAt),
    ),
  'delivery:list': () =>
    [...rows<{ date: string; createdAt: string }>('deliveryNotes')].sort(
      (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    ),
  'bank:list': () => rows('bankTransactions'),
  // L'existence des fichiers ne se vérifie que sur le serveur : hors ligne, on
  // suppose la bibliothèque intacte plutôt que d'afficher de fausses alertes.
  'attachments:list': () => rows<Attachment>('attachments').map((a) => ({ ...a, exists: true })),
  'settings:get': () => {
    requireMirror();
    return mirror!.settings;
  },
  // Sans réseau, l'identité est celle mémorisée à la dernière synchronisation.
  'auth:status': (): AuthStatus => ({
    configured: Boolean(mirror?.identity),
    required: Boolean(mirror?.identity),
    identity: mirror?.identity ?? null,
    authorized: true,
  }),
  'auth:me': () => mirror?.identity ?? null,
};

/* ------------------------------------------------------------------ */
/* Écritures mises en file                                              */
/* ------------------------------------------------------------------ */

/** Collections des fiches, pour l'application optimiste des saves/removes. */
const NAMESPACE_COLLECTION: Record<string, { collection: SyncedCollection; prefix: string }> = {
  clients: { collection: 'clients', prefix: 'cli' },
  products: { collection: 'products', prefix: 'prd' },
  routes: { collection: 'routes', prefix: 'rte' },
  vehicles: { collection: 'vehicles', prefix: 'veh' },
  machines: { collection: 'eventMachines', prefix: 'mch' },
  registers: { collection: 'registerEntries', prefix: 'reg' },
  documents: { collection: 'documents', prefix: 'doc' },
  tasks: { collection: 'tasks', prefix: 'tsk' },
  delivery: { collection: 'deliveryNotes', prefix: 'bl' },
};

function upsertOptimistic(namespace: string, input: Record<string, unknown>): unknown {
  requireMirror();
  const target = NAMESPACE_COLLECTION[namespace];
  const list = (mirror!.collections[target.collection] ??= []) as Record<string, unknown>[];
  const existing = input.id ? list.find((row) => row.id === input.id) : undefined;
  if (existing) {
    Object.assign(existing, input, { updatedAt: nowIso() });
    saveMirror();
    return existing;
  }
  // L'identifiant est pré-assigné **dans l'intention** : le serveur créera la
  // fiche sous ce même identifiant au rejeu, et les gestes suivants de la file
  // (l'ajouter à une tournée, la modifier) la retrouveront.
  input.id = input.id ?? newId(target.prefix);
  const created: Record<string, unknown> = {
    tags: [],
    aliases: [],
    archived: false,
    ...(namespace === 'clients' ? { address: { label: '' }, code: '' } : {}),
    ...input,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  list.push(created);
  saveMirror();
  return created;
}

function patchOptimistic(
  collection: SyncedCollection,
  id: unknown,
  patch: Record<string, unknown>,
): unknown {
  requireMirror();
  const row = (mirror!.collections[collection] ?? []).find(
    (r) => (r as { id: ID }).id === id,
  ) as Record<string, unknown> | undefined;
  if (row) {
    Object.assign(row, patch, { updatedAt: nowIso() });
    saveMirror();
  }
  return row ?? null;
}

function removeOptimistic(collection: SyncedCollection, id: unknown): void {
  requireMirror();
  mirror!.collections[collection] = (mirror!.collections[collection] ?? []).filter(
    (row) => (row as { id: ID }).id !== id,
  );
  saveMirror();
}

/**
 * L'application locale d'une intention mise en file : juste assez pour que
 * l'écran reflète le geste. Cet état optimiste est jeté à la synchronisation
 * suivante — le serveur, en rejouant l'intention, fait foi.
 */
const OPTIMISTIC: Record<string, (args: unknown[]) => unknown> = {
  'clients:save': (a) => upsertOptimistic('clients', { ...(a[0] as object) }),
  'products:save': (a) => upsertOptimistic('products', { ...(a[0] as object) }),
  'routes:save': (a) => upsertOptimistic('routes', { ...(a[0] as object) }),
  'vehicles:save': (a) => upsertOptimistic('vehicles', { ...(a[0] as object) }),
  'machines:save': (a) => upsertOptimistic('machines', { ...(a[0] as object) }),
  'registers:save': (a) => upsertOptimistic('registers', { ...(a[0] as object) }),
  'documents:save': (a) => upsertOptimistic('documents', { ...(a[0] as object) }),
  'tasks:save': (a) => upsertOptimistic('tasks', { ...(a[0] as object) }),
  // Le numéro définitif est attribué par le serveur au rejeu de l'intention.
  'delivery:save': (a) =>
    upsertOptimistic('delivery', { number: 'BL (en attente)', status: 'signed', items: [], ...(a[0] as object) }),
  // « Supprimer » une tâche n'en retire jamais l'enregistrement : c'est une
  // mise à la corbeille, réversible — le miroir reflète le même geste.
  'tasks:remove': (a) => patchOptimistic('tasks', a[0], { deletedAt: nowIso() }),
  'tasks:restore': (a) => patchOptimistic('tasks', a[0], { deletedAt: undefined }),
  'tasks:setStatus': (a) =>
    patchOptimistic('tasks', a[0], {
      status: a[1],
      doneAt: a[1] === 'done' ? nowIso() : undefined,
    }),
  'clients:remove': (a) => removeOptimistic('clients', a[0]),
  'products:remove': (a) => removeOptimistic('products', a[0]),
  'routes:remove': (a) => removeOptimistic('routes', a[0]),
  'vehicles:remove': (a) => removeOptimistic('vehicles', a[0]),
  'machines:remove': (a) => removeOptimistic('eventMachines', a[0]),
  'registers:remove': (a) => removeOptimistic('registerEntries', a[0]),
  'documents:remove': (a) => removeOptimistic('documents', a[0]),
  'documents:setStatus': (a) => patchOptimistic('documents', a[0], { status: a[1] }),
  'documents:setClient': (a) => patchOptimistic('documents', a[0], { clientId: a[1] ?? undefined }),
  'documents:setPrinted': (a) =>
    patchOptimistic('documents', a[0], { printedAt: a[1] ? nowIso() : undefined }),
  'registers:setStatus': (a) => patchOptimistic('registerEntries', a[0], { status: a[1] }),
  'products:adjust': (a) => patchOptimistic('products', a[0], { qtyOnHand: a[1] }),
  'stock:apply': (a) => {
    patchOptimistic('documents', a[0], { stockApplied: true, stockAppliedAt: nowIso() });
    return {
      documentId: a[0],
      applied: 0,
      unmatched: [],
      moves: [],
      message: 'Hors ligne : la déduction sera faite à la reconnexion au serveur.',
    };
  },
  'stock:revert': (a) => {
    patchOptimistic('documents', a[0], { stockApplied: false, stockAppliedAt: undefined });
    return {
      documentId: a[0],
      applied: 0,
      unmatched: [],
      moves: [],
      message: 'Hors ligne : l’annulation sera faite à la reconnexion au serveur.',
    };
  },
  'stock:linkLine': (a) =>
    rows<AccountingDocument>('documents').find((d) => d.id === a[0]) ?? null,
  'settings:update': (a) => {
    requireMirror();
    mirror!.settings = { ...(mirror!.settings as Settings), ...(a[0] as Partial<Settings>) };
    saveMirror();
    return mirror!.settings;
  },
};

/* ------------------------------------------------------------------ */
/* Le registre : serveur d'abord, miroir en secours                      */
/* ------------------------------------------------------------------ */

/**
 * Construit le registre du mode branché, conscient du hors-ligne.
 *
 * - **Lectures** : le serveur d'abord (comportement inchangé) ; s'il ne répond
 *   pas, le miroir prend le relais et l'application continue.
 * - **Écritures rejouables** : au serveur quand il répond ; sinon en file
 *   d'attente, avec une application optimiste pour que l'écran suive.
 * - **Le reste** (analyses de dossier, imports de fichiers, géocodage…) exige
 *   le serveur et le dit clairement.
 */
export function createOfflineRegistry(): Registry {
  const registry = createRemoteRegistry();

  for (const [namespace, methods] of Object.entries(CHANNELS)) {
    for (const method of methods as readonly string[]) {
      const channel = `${namespace}:${method}`;
      const mirrorRead = MIRROR_READS[channel];
      const optimistic = OPTIMISTIC[channel];
      const direct = registry[namespace][method];

      registry[namespace][method] = async (...args: unknown[]) => {
        // Hors ligne connu : pas d'aller-retour voué au délai d'attente.
        if (offline) {
          if (mirrorRead) return mirrorRead(...args);
          if (optimistic) {
            enqueue(namespace, method, args);
            return optimistic(args);
          }
          throw new Error('Hors ligne : cette action nécessite le serveur.');
        }

        try {
          const result = await direct(...args);
          // Une écriture vient d'aboutir : le miroir se met au niveau, pour
          // que la copie locale soit fraîche si le réseau tombe ensuite.
          if (!mirrorRead) schedulePull();
          return result;
        } catch (err) {
          if (!(err instanceof RemoteError) || !err.network) throw err;
          markOffline();
          if (mirrorRead && hasMirror()) return mirrorRead(...args);
          if (optimistic && hasMirror()) {
            enqueue(namespace, method, args);
            return optimistic(args);
          }
          throw err;
        }
      };
    }
  }

  return registry;
}
