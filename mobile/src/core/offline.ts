import type {
  AuthIdentity,
  AuthStatus,
  SyncPullResult,
  SyncStatus,
  QueuedIntent,
} from '@shared/api';
import type {
  AccountingDocument,
  DeliveryNote,
  DeliveryRoute,
  ID,
  RegisterEntry,
  Role,
  Settings,
  StockMove,
  Syncable,
  SyncedCollection,
  Task,
} from '@shared/types';
import { SYNCED_COLLECTIONS } from '@shared/types';
import { TASK_PRIORITY_RANK } from '@shared/format';
import { ApiError, serverCall } from './api';

/**
 * Le hors-ligne du téléphone — même principe que l'application de bureau :
 * **descendre des états, remonter des intentions.**
 *
 * Le serveur descend ses enregistrements modifiés (`sync:pull`), rangés tels
 * quels dans un miroir sur l'appareil ; aucune fusion ici. Les gestes de
 * tournée faits sans réseau (marquer livré, réordonner) deviennent des
 * intentions `{namespace, method, args}` dans une file durable, rejouées dans
 * l'ordre au retour du serveur — les conflits se résolvent là-bas, par les
 * gestionnaires existants, contre l'état réel.
 *
 * Le stockage est **injecté** (expo-file-system sur le téléphone, un dossier
 * temporaire dans la suite de tests Node) : ce module ne connaît ni React
 * Native ni Expo, et la suite l'exerce contre un vrai serveur, coupure
 * comprise.
 */

export interface OfflineStorage {
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
}

interface MirrorFile {
  generation: string;
  role: Role | null;
  identity: AuthIdentity | null;
  since: number;
  savedAt: string;
  collections: Partial<Record<SyncedCollection, unknown[]>>;
  settings: Settings | null;
}

interface QueueFile {
  pending: QueuedIntent[];
  failed: QueuedIntent[];
}

const MIRROR_FILE = 'miroir.json';
const QUEUE_FILE = 'attente.json';

let storage: OfflineStorage | null = null;
let mirror: MirrorFile | null = null;
let queue: QueueFile = { pending: [], failed: [] };
let offline = false;
let lastPullAt: string | undefined;

/** L'interface s'abonne : bandeau hors-ligne, compteur d'attente, toasts. */
export type OfflineListener = (event: {
  online: boolean;
  replayed: number;
  failed: number;
}) => void;

const listeners = new Set<OfflineListener>();

export function onOfflineChange(listener: OfflineListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(online: boolean, replayed = 0, failed = 0): void {
  for (const listener of listeners) listener({ online, replayed, failed });
}

function newIntentId(): string {
  return `int_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`;
}

/** Identifiant de fiche pré-assigné hors ligne, respecté par le serveur au rejeu. */
export function newRecordId(prefix: string): string {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function saveMirror(): Promise<void> {
  if (storage && mirror) await storage.write(MIRROR_FILE, JSON.stringify(mirror));
}

async function saveQueue(): Promise<void> {
  if (storage) await storage.write(QUEUE_FILE, JSON.stringify(queue));
}

export async function initOffline(nextStorage: OfflineStorage): Promise<void> {
  storage = nextStorage;
  try {
    const raw = await storage.read(MIRROR_FILE);
    mirror = raw ? (JSON.parse(raw) as MirrorFile) : null;
  } catch {
    // Miroir illisible : il sera reconstruit à la prochaine synchronisation.
    mirror = null;
  }
  try {
    const raw = await storage.read(QUEUE_FILE);
    queue = raw ? (JSON.parse(raw) as QueueFile) : { pending: [], failed: [] };
  } catch {
    queue = { pending: [], failed: [] };
  }
}

export function hasMirror(): boolean {
  return mirror !== null;
}

export function isOffline(): boolean {
  return offline;
}

export function mirrorIdentity(): AuthIdentity | null {
  return mirror?.identity ?? null;
}

export function markOffline(): void {
  if (offline) return;
  offline = true;
  emit(false);
}

/* ------------------------------------------------------------------ */
/* Synchronisation descendante                                          */
/* ------------------------------------------------------------------ */

let pulling: Promise<void> | null = null;
let pullTimer: ReturnType<typeof setTimeout> | null = null;

function applyPull(result: SyncPullResult): void {
  const base: MirrorFile =
    result.full || !mirror || mirror.generation !== result.generation
      ? {
          generation: result.generation,
          role: result.role,
          identity: result.identity,
          since: 0,
          savedAt: new Date().toISOString(),
          collections: {},
          settings: null,
        }
      : mirror;

  for (const collection of SYNCED_COLLECTIONS) {
    const incoming = result.changes[collection];
    if (result.full) {
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
  base.savedAt = new Date().toISOString();
  mirror = base;
  lastPullAt = new Date().toISOString();
}

/** Synchronise maintenant. Les appels concurrents partagent la même passe. */
export function pullNow(): Promise<void> {
  if (pulling) return pulling;
  pulling = (async () => {
    const request = mirror ? { generation: mirror.generation, since: mirror.since } : {};
    let result = (await serverCall('sync', 'pull', [request])) as SyncPullResult;
    // Changement de rôle : les collections visibles ne sont plus les mêmes,
    // on oublie notre génération et on reprend tout.
    if (mirror && mirror.role !== result.role) {
      mirror = null;
      result = (await serverCall('sync', 'pull', [{}])) as SyncPullResult;
    }
    applyPull(result);
    await saveMirror();
  })().finally(() => {
    pulling = null;
  });
  return pulling;
}

/** Synchronisation groupée : plusieurs écritures rapprochées → une passe. */
export function schedulePull(delayMs = 700): void {
  if (pullTimer) return;
  pullTimer = setTimeout(() => {
    pullTimer = null;
    pullNow().catch(() => {
      /* la prochaine occasion réessaiera */
    });
  }, delayMs);
  const timer = pullTimer as { unref?: () => void };
  timer.unref?.();
}

/* ------------------------------------------------------------------ */
/* File d'attente montante                                              */
/* ------------------------------------------------------------------ */

async function replayQueue(): Promise<{ replayed: number; failed: number }> {
  let replayed = 0;
  let failed = 0;
  while (queue.pending.length) {
    const intent = queue.pending[0];
    try {
      await serverCall(intent.namespace, intent.method, intent.args);
      queue.pending.shift();
      replayed++;
      await saveQueue();
    } catch (err) {
      if (err instanceof ApiError && err.network) throw err;
      // Refus métier : mis de côté avec son explication, jamais avalé.
      queue.pending.shift();
      queue.failed.push({ ...intent, error: (err as Error).message ?? String(err) });
      failed++;
      await saveQueue();
    }
  }
  return { replayed, failed };
}

/** Le serveur est revenu : rejouer, resynchroniser, prévenir l'écran. */
export async function backOnline(): Promise<void> {
  const wasOffline = offline;
  try {
    const { replayed, failed } = await replayQueue();
    await pullNow();
    offline = false;
    if (wasOffline || replayed || failed) emit(true, replayed, failed);
  } catch {
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

export async function discardIntent(intentId: ID): Promise<SyncStatus> {
  queue.failed = queue.failed.filter((intent) => intent.id !== intentId);
  queue.pending = queue.pending.filter((intent) => intent.id !== intentId);
  await saveQueue();
  return syncStatus();
}

/* ------------------------------------------------------------------ */
/* Lectures servies par le miroir                                       */
/* ------------------------------------------------------------------ */

function rows<T>(collection: SyncedCollection): T[] {
  return (mirror?.collections[collection] ?? []) as T[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Ce qu'on sait servir sans le serveur — mêmes tris que les gestionnaires
 * d'origine, l'écran ne voit pas la différence.
 */
const MIRROR_READS: Record<string, (...args: unknown[]) => unknown> = {
  'clients:list': () =>
    [...rows<{ name: string }>('clients')].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  'documents:list': () =>
    [...rows<AccountingDocument>('documents')].sort(
      (a, b) =>
        (b.date ?? '').localeCompare(a.date ?? '') || b.importedAt.localeCompare(a.importedAt),
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
    [...rows<{ date?: string }>('routes')].sort((a, b) =>
      (b.date ?? '').localeCompare(a.date ?? ''),
    ),
  'vehicles:list': () => rows('vehicles'),
  'registers:list': () =>
    [...rows<RegisterEntry>('registerEntries')].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  // Hors ligne, la disponibilité fine des machines n'est pas recalculée : on
  // montre le parc tel quel plutôt que rien.
  'machines:list': () =>
    rows<{ id: ID; name: string; qtyTotal: number }>('eventMachines').map((machine) => ({
      machine,
      reserved: 0,
      available: machine.qtyTotal,
      upcoming: [],
    })),
  // Même ordre que le serveur : l'urgent d'abord, puis l'échéance la plus
  // proche. La corbeille descend aussi (repérable à `deletedAt`) — sa purge
  // automatique, elle, attend le serveur.
  'tasks:list': () =>
    [...rows<Task>('tasks')].sort(
      (a, b) =>
        (TASK_PRIORITY_RANK[a.priority] ?? 2) - (TASK_PRIORITY_RANK[b.priority] ?? 2) ||
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        b.createdAt.localeCompare(a.createdAt),
    ),
  // Sans réseau, la liste des comptes n'est pas connue : on n'attribue donc
  // pas de tâche hors ligne, plutôt que de proposer une liste vide trompeuse.
  'tasks:people': () => [],
  'delivery:list': () =>
    [...rows<DeliveryNote>('deliveryNotes')].sort(
      (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    ),
  'bank:list': () => rows('bankTransactions'),
  'attachments:list': () =>
    rows<{ id: ID }>('attachments').map((a) => ({ ...a, exists: true })),
  'settings:get': () => mirror?.settings ?? null,
  'auth:status': (): AuthStatus => ({
    configured: Boolean(mirror?.identity),
    required: Boolean(mirror?.identity),
    identity: mirror?.identity ?? null,
    authorized: true,
  }),
  'auth:me': () => mirror?.identity ?? null,
};

/* ------------------------------------------------------------------ */
/* Écritures mises en file : les gestes de tournée                      */
/* ------------------------------------------------------------------ */

/** Retrouve une tâche du miroir et lui applique un correctif. */
function patchTask(id: unknown, patch: Partial<Task>): Task | null {
  if (!mirror) throw new Error('Aucune copie locale.');
  const list = (mirror.collections.tasks ??= []) as Task[];
  const task = list.find((t) => t.id === id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  void saveMirror();
  return task;
}

/**
 * Les gestes rejouables depuis le téléphone : la tournée — c'est le cas réel
 * de la zone blanche en camionnette — et les tâches, qui se notent justement
 * là où l'on n'a pas de réseau. Le reste des écritures demande le serveur et
 * le dit clairement.
 */
const OPTIMISTIC: Record<string, (args: unknown[]) => unknown> = {
  'tasks:save': (args) => {
    if (!mirror) throw new Error('Aucune copie locale.');
    const input = { ...(args[0] as Partial<Task>) };
    const list = (mirror.collections.tasks ??= []) as Task[];
    const existing = input.id ? list.find((t) => t.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input, { updatedAt: new Date().toISOString() });
      void saveMirror();
      return existing;
    }
    // L'identifiant est pré-assigné **dans l'intention** : le serveur créera
    // la tâche sous ce même identifiant au rejeu, et les gestes suivants de la
    // file la retrouveront.
    input.id = input.id ?? newRecordId('tsk');
    (args[0] as Partial<Task>).id = input.id;
    const created = {
      priority: 'normal',
      status: 'open',
      history: [],
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    list.unshift(created);
    void saveMirror();
    return created;
  },
  // « Supprimer » n'efface jamais : c'est une mise à la corbeille, réversible.
  'tasks:remove': (args) => patchTask(args[0], { deletedAt: new Date().toISOString() }),
  'tasks:restore': (args) => patchTask(args[0], { deletedAt: undefined }),
  'tasks:setStatus': (args) =>
    patchTask(args[0], {
      status: args[1] as Task['status'],
      doneAt: args[1] === 'done' ? new Date().toISOString() : undefined,
    }),
  // Le bon s'écrit là où le réseau manque justement : il part en file, le
  // serveur lui attribue son numéro définitif au rejeu.
  'delivery:save': (args) => {
    if (!mirror) throw new Error('Aucune copie locale.');
    const input = { ...(args[0] as Partial<DeliveryNote>) };
    const list = (mirror.collections.deliveryNotes ??= []) as DeliveryNote[];
    const existing = input.id ? list.find((n) => n.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input, { updatedAt: new Date().toISOString() });
      void saveMirror();
      return existing;
    }
    input.id = input.id ?? newRecordId('bl');
    (args[0] as Partial<DeliveryNote>).id = input.id;
    const created = {
      number: 'BL (en attente)',
      status: 'signed',
      items: [],
      date: new Date().toISOString().slice(0, 10),
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as DeliveryNote;
    list.unshift(created);
    void saveMirror();
    return created;
  },
  'routes:save': (args) => {
    if (!mirror) throw new Error('Aucune copie locale.');
    const input = { ...(args[0] as Partial<DeliveryRoute>) };
    const list = (mirror.collections.routes ??= []) as DeliveryRoute[];
    const existing = input.id ? list.find((r) => r.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input, { updatedAt: new Date().toISOString() });
      void saveMirror();
      return existing;
    }
    input.id = input.id ?? newRecordId('rte');
    (args[0] as Partial<DeliveryRoute>).id = input.id;
    const created = {
      stops: [],
      returnToStart: true,
      tollCost: 0,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as DeliveryRoute;
    list.unshift(created);
    void saveMirror();
    return created;
  },
};

async function enqueue(namespace: string, method: string, args: unknown[]): Promise<void> {
  queue.pending.push({
    id: newIntentId(),
    at: new Date().toISOString(),
    namespace,
    method,
    args,
  });
  await saveQueue();
}

/* ------------------------------------------------------------------ */
/* L'aiguillage : serveur d'abord, miroir en secours                     */
/* ------------------------------------------------------------------ */

/**
 * Toute l'application passe par ici. En ligne : le serveur, comme le bureau et
 * le navigateur — puis le miroir se rafraîchit en arrière-plan après une
 * écriture. Serveur muet : les lectures continuent sur le miroir, les gestes
 * de tournée partent en file, le reste explique qu'il faut le serveur.
 */
export async function invoke(
  namespace: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const channel = `${namespace}:${method}`;
  const mirrorRead = MIRROR_READS[channel];
  const optimistic = OPTIMISTIC[channel];

  if (offline) {
    if (mirrorRead) return mirrorRead(...args);
    if (optimistic && hasMirror()) {
      const result = optimistic(args);
      await enqueue(namespace, method, args);
      emit(false);
      return result;
    }
    throw new Error('Hors ligne : cette action nécessite le serveur.');
  }

  try {
    const result = await serverCall(namespace, method, args);
    if (!mirrorRead) schedulePull();
    return result;
  } catch (err) {
    if (!(err instanceof ApiError) || !err.network) throw err;
    markOffline();
    if (mirrorRead && hasMirror()) return mirrorRead(...args);
    if (optimistic && hasMirror()) {
      const result = optimistic(args);
      await enqueue(namespace, method, args);
      return result;
    }
    throw err;
  }
}
