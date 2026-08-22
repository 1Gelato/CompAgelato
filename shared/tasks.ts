import type { Task } from './types';
import { todayLocal } from './format';

/**
 * La règle du retard d'une tâche — une seule, partagée.
 *
 * Trois endroits comptent les retards : la liste des tâches du bureau, celle
 * du téléphone, et la pastille de l'onglet Tâches. Chacun avait sa copie de
 * la même règle, et toutes comparaient l'échéance au jour **UTC** — voir
 * `todayLocal` dans `format.ts`. La règle vit désormais ici, en heure locale.
 */

/** Échéance passée sans être faite : ce que l'écran doit crier. */
export function isTaskLate(
  task: Pick<Task, 'dueDate' | 'status'>,
  today: string = todayLocal(),
): boolean {
  return Boolean(task.dueDate && task.status !== 'done' && task.dueDate < today);
}
