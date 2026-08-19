import type { ID, Task, TaskEvent, TaskPriority, TaskStatus } from '@shared/types';
import { TASK_PRIORITY_LABEL, TASK_PRIORITY_RANK, TASK_STATUS_LABEL } from '@shared/format';
import { newId, nowIso, store } from '../store';
import { currentIdentity } from '../context';
import { sendNotification } from './notify';
import { announce } from './activity';

/**
 * Le suivi des tâches, pensé pour ne jamais perdre un geste :
 *
 * - chaque modification s'inscrit au **journal** de la tâche (qui, quand, quoi) ;
 * - « supprimer » met à la **corbeille** (`deletedAt`), d'où l'on restaure d'un
 *   clic — seule la purge efface vraiment, et la corbeille se vide seule au
 *   bout de trente jours ;
 * - l'ajout d'une tâche est **annoncé** : bulle du système sur les postes
 *   branchés (sauf chez son auteur) et, si un sujet ntfy est configuré,
 *   notification sur les téléphones — le même canal que les cahiers.
 */

/** Au-delà, les plus anciennes lignes du journal tombent : une tâche n'est pas
 *  un livre de bord, trente gestes racontent déjà toute son histoire. */
const HISTORY_LIMIT = 30;

/** La corbeille se vide d'elle-même : trente jours pour changer d'avis. */
const TRASH_DAYS = 30;

const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];
const STATUSES: TaskStatus[] = ['open', 'doing', 'done'];

function signature(): { by: ID | null; byName?: string } {
  const identity = currentIdentity();
  return { by: identity?.userId ?? null, byName: identity?.displayName };
}

/** Ajoute une ligne au journal, la plus récente en tête. */
function log(task: Task, text: string): void {
  const entry: TaskEvent = { at: nowIso(), ...signature(), text };
  task.history = [entry, ...(task.history ?? [])].slice(0, HISTORY_LIMIT);
}

function requireTask(db: { tasks: Task[] }, id: ID): Task {
  const task = db.tasks.find((t) => t.id === id);
  if (!task) throw new Error('Tâche introuvable.');
  return task;
}

function clientNameOf(task: Task): string | undefined {
  if (task.clientId) return store.db.clients.find((c) => c.id === task.clientId)?.name;
  return task.clientName;
}

/** « 2026-08-25 » → « 25/08/2026 », sans dépendre du code de l'interface. */
function frDate(iso?: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/**
 * Prévient qui doit l'être, sans jamais bloquer l'enregistrement — même
 * double destination que les cahiers : téléphones abonnés au sujet ntfy,
 * et postes branchés qui en font une bulle du système.
 */
function announceCreated(task: Task): void {
  const who = clientNameOf(task);
  const parts = [
    who,
    task.priority !== 'normal' ? `priorité ${TASK_PRIORITY_LABEL[task.priority].toLowerCase()}` : '',
    task.dueDate ? `pour le ${frDate(task.dueDate)}` : '',
  ].filter(Boolean);
  const title = `Nouvelle tâche — ${task.title}`;
  const message = parts.join(' · ') || 'Ajoutée au suivi.';

  const { notifyTopic, notifyUrl } = store.settings;
  void sendNotification(
    { topic: notifyTopic, url: notifyUrl },
    { title, message, tags: [task.priority === 'urgent' ? 'rotating_light' : 'memo'] },
  );
  announce('task', title, message);
}

export function upsertTask(input: Partial<Task> & { id?: ID }): Task {
  const task = store.mutate((db) => {
    const existing = input.id ? db.tasks.find((t) => t.id === input.id) : undefined;

    if (existing) {
      // Le journal raconte ce qui change réellement, pas la liste des champs
      // envoyés : une sauvegarde sans différence ne laisse aucune trace.
      const changes: string[] = [];
      if (input.title !== undefined && input.title.trim() !== existing.title) {
        changes.push(`intitulé « ${existing.title} » → « ${input.title.trim()} »`);
        existing.title = input.title.trim() || existing.title;
      }
      if (input.priority !== undefined && input.priority !== existing.priority) {
        changes.push(
          `priorité ${TASK_PRIORITY_LABEL[existing.priority]} → ${TASK_PRIORITY_LABEL[input.priority]}`,
        );
        existing.priority = input.priority;
      }
      if (input.status !== undefined && input.status !== existing.status) {
        changes.push(
          `statut ${TASK_STATUS_LABEL[existing.status]} → ${TASK_STATUS_LABEL[input.status]}`,
        );
        existing.status = input.status;
        existing.doneAt = input.status === 'done' ? nowIso() : undefined;
      }
      if (input.dueDate !== undefined && (input.dueDate || undefined) !== existing.dueDate) {
        changes.push(
          input.dueDate
            ? `échéance fixée au ${frDate(input.dueDate)}`
            : 'échéance retirée',
        );
        existing.dueDate = input.dueDate || undefined;
      }
      if (
        input.clientId !== undefined &&
        (input.clientId || undefined) !== existing.clientId
      ) {
        const next = input.clientId
          ? db.clients.find((c) => c.id === input.clientId)?.name ?? 'client inconnu'
          : null;
        changes.push(next ? `rattachée à « ${next} »` : 'détachée du client');
        existing.clientId = input.clientId || undefined;
        existing.clientName = input.clientId ? undefined : input.clientName?.trim() || undefined;
      } else if (input.clientName !== undefined && !existing.clientId) {
        existing.clientName = input.clientName.trim() || undefined;
      }
      if (input.assignedTo !== undefined && (input.assignedTo || undefined) !== existing.assignedTo) {
        changes.push(
          input.assignedTo && input.assignedToName
            ? `confiée à ${input.assignedToName}`
            : 'plus confiée à personne',
        );
        existing.assignedTo = input.assignedTo || undefined;
        existing.assignedToName = input.assignedTo ? input.assignedToName : undefined;
      }
      if (input.details !== undefined && (input.details.trim() || undefined) !== existing.details) {
        changes.push('détails modifiés');
        existing.details = input.details.trim() || undefined;
      }
      if (changes.length) {
        log(existing, changes.join(' ; '));
        existing.updatedAt = nowIso();
      }
      return existing;
    }

    if (!input.title?.trim()) throw new Error('Donnez un intitulé à la tâche.');
    const me = signature();
    const created: Task = {
      // Un identifiant fourni est respecté : une tâche créée hors ligne le
      // pré-assigne, pour que ses références tiennent au rejeu.
      id: input.id ?? newId('tsk'),
      title: input.title.trim(),
      details: input.details?.trim() || undefined,
      priority: PRIORITIES.includes(input.priority!) ? input.priority! : 'normal',
      status: STATUSES.includes(input.status!) ? input.status! : 'open',
      clientId: input.clientId || undefined,
      clientName: input.clientId ? undefined : input.clientName?.trim() || undefined,
      dueDate: input.dueDate || undefined,
      assignedTo: input.assignedTo || undefined,
      assignedToName: input.assignedTo ? input.assignedToName : undefined,
      history: [],
      createdBy: me.by ?? undefined,
      createdByName: me.byName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    log(created, 'créée');
    db.tasks.unshift(created);
    announceCreated(created);
    return created;
  });
  return task;
}

export function setTaskStatus(id: ID, status: TaskStatus): Task {
  return upsertTask({ id, status });
}

/** « Supprimer » : mise à la corbeille, toujours réversible. */
export function trashTask(id: ID): Task {
  return store.mutate((db) => {
    const task = requireTask(db, id);
    if (!task.deletedAt) {
      task.deletedAt = nowIso();
      log(task, 'mise à la corbeille');
      task.updatedAt = nowIso();
    }
    return task;
  });
}

export function restoreTask(id: ID): Task {
  return store.mutate((db) => {
    const task = requireTask(db, id);
    if (task.deletedAt) {
      task.deletedAt = undefined;
      log(task, 'restaurée de la corbeille');
      task.updatedAt = nowIso();
    }
    return task;
  });
}

/**
 * Efface pour de bon — uniquement depuis la corbeille : purger une tâche
 * vivante serait un « supprimer » qui aurait sauté le filet.
 */
export function purgeTask(id?: ID): { purged: number } {
  return store.mutate((db) => {
    const victims = db.tasks.filter((t) => t.deletedAt && (!id || t.id === id));
    if (id && !victims.length) {
      const alive = db.tasks.find((t) => t.id === id);
      if (alive) throw new Error('Cette tâche n’est pas à la corbeille : supprimez-la d’abord.');
    }
    const ids = new Set(victims.map((t) => t.id));
    db.tasks = db.tasks.filter((t) => !ids.has(t.id));
    return { purged: ids.size };
  });
}

/** La corbeille se vide seule après TRASH_DAYS jours — appelé à la lecture. */
function purgeExpired(now = Date.now()): void {
  const limit = now - TRASH_DAYS * 24 * 3600 * 1000;
  const expired = store.db.tasks.filter(
    (t) => t.deletedAt && Date.parse(t.deletedAt) < limit,
  );
  if (!expired.length) return;
  const ids = new Set(expired.map((t) => t.id));
  store.mutate((db) => {
    db.tasks = db.tasks.filter((t) => !ids.has(t.id));
  });
}

/**
 * Toutes les tâches, corbeille comprise (l'écran sépare sur `deletedAt`),
 * triées comme on veut les lire : l'urgent d'abord, à priorité égale
 * l'échéance la plus proche, et sinon la plus récente.
 */
export function listTasks(now = Date.now()): Task[] {
  purgeExpired(now);
  const rank = (t: Task) => TASK_PRIORITY_RANK[t.priority] ?? 2;
  return [...store.db.tasks].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

/**
 * Les comptes actifs, réduits à ce qu'il faut pour confier une tâche : la
 * liste complète des comptes est l'affaire du gérant, pas de cet écran.
 */
export function listTaskPeople(): { id: ID; displayName: string }[] {
  return store.db.users
    .filter((u) => !u.disabled)
    .map((u) => ({ id: u.id, displayName: u.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
}
