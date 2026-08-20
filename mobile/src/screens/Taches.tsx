import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import type { Task, TaskPriority, TaskStatus } from '@shared/types';
import {
  dateFr,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
} from '@shared/format';
import { api } from '../lib/runtime';
import { errorMessage, refreshAll, useClients, useTasks } from '../lib/data';
import {
  Badge,
  Button,
  Chips,
  EmptyState,
  Field,
  Input,
  ListItem,
  Loading,
  Sheet,
  SheetAction,
  useToast,
} from '../components/ui';
import { colors, spacing } from '../theme';
import type { Tone } from '../theme';

/**
 * Le suivi des tâches, en version téléphone.
 *
 * Sur le bureau c'est un tableau ; ici c'est une liste qu'on parcourt d'un
 * pouce. Les mêmes promesses tiennent : l'urgent d'abord, rien ne se perd
 * (la suppression est une mise à la corbeille), et tout marche sans réseau —
 * une tâche se note souvent là où justement il n'y en a pas.
 */

const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];
const STATUSES: TaskStatus[] = ['open', 'doing', 'done'];

const PRIORITY_TONE: Record<TaskPriority, Tone> = {
  urgent: 'danger',
  high: 'warn',
  normal: 'info',
  low: 'default',
};

const STATUS_TONE: Record<TaskStatus, Tone> = {
  open: 'warn',
  doing: 'info',
  done: 'success',
};

/** Échéance passée sans être faite : c'est ce que l'écran doit crier. */
function isLate(task: Task): boolean {
  return Boolean(
    task.dueDate && task.status !== 'done' && task.dueDate < new Date().toISOString().slice(0, 10),
  );
}

type Vue = 'todo' | 'all' | 'trash';

export function TachesScreen() {
  const { data: tasks, loading } = useTasks();
  const { data: clients } = useClients();
  const toast = useToast();

  const [view, setView] = useState<Vue>('todo');
  const [selected, setSelected] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [clientName, setClientName] = useState('');
  const [busy, setBusy] = useState(false);

  const clientLabel = (task: Task): string => {
    if (task.clientId) return clients.find((c) => c.id === task.clientId)?.name ?? 'Client supprimé';
    return task.clientName ?? '';
  };

  // Le serveur livre déjà le bon ordre (urgent, puis échéance) : on filtre.
  const filtered = useMemo(
    () =>
      tasks.filter((task) => {
        if (view === 'trash') return Boolean(task.deletedAt);
        if (task.deletedAt) return false;
        return view === 'all' || task.status !== 'done';
      }),
    [tasks, view],
  );

  const trashCount = useMemo(() => tasks.filter((t) => t.deletedAt).length, [tasks]);

  if (loading) return <Loading />;

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.tasks.save({
        title: title.trim(),
        details: details.trim() || undefined,
        priority,
        clientName: clientName.trim() || undefined,
      });
      refreshAll();
      setCreating(false);
      setTitle('');
      setDetails('');
      setClientName('');
      setPriority('normal');
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: () => Promise<unknown>, done?: string) => {
    try {
      await action();
      refreshAll();
      if (done) toast.push({ tone: 'success', title: done });
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setSelected(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <Chips
          value={view}
          onChange={setView}
          options={[
            { value: 'todo', label: 'À faire' },
            { value: 'all', label: 'Tout' },
            { value: 'trash', label: trashCount ? `Corbeille (${trashCount})` : 'Corbeille' },
          ]}
        />
        {view !== 'trash' && (
          <Button title="+ Nouvelle tâche" variant="primary" onPress={() => setCreating(true)} />
        )}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(task) => task.id}
        ListEmptyComponent={
          <EmptyState
            title={view === 'trash' ? 'Corbeille vide' : 'Aucune tâche'}
            text={
              view === 'trash'
                ? 'Les tâches supprimées attendent ici 30 jours avant de s’effacer.'
                : 'Notez ce qui doit être fait — une relance, un rappel, un papier à envoyer.'
            }
          />
        }
        renderItem={({ item: task }) => (
          <ListItem
            title={task.title}
            subtitle={[
              clientLabel(task),
              task.dueDate ? `${isLate(task) ? 'en retard — ' : ''}${dateFr(task.dueDate)}` : '',
              task.assignedToName ?? '',
            ]
              .filter(Boolean)
              .join(' · ')}
            right={
              <Badge tone={isLate(task) ? 'danger' : PRIORITY_TONE[task.priority]}>
                {TASK_PRIORITY_LABEL[task.priority]}
              </Badge>
            }
            onPress={() => setSelected(task)}
          />
        )}
      />

      {/* Un appui : changer le statut, jeter, ou restaurer. */}
      <Sheet open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.title}>
        {selected?.deletedAt ? (
          <SheetAction
            title="Restaurer"
            tone="success"
            onPress={() => void run(() => api.tasks.restore(selected.id), 'Tâche restaurée')}
          />
        ) : (
          selected && (
            <>
              {STATUSES.filter((status) => status !== selected.status).map((status) => (
                <SheetAction
                  key={status}
                  title={TASK_STATUS_LABEL[status]}
                  tone={status === 'done' ? 'success' : 'default'}
                  onPress={() => void run(() => api.tasks.setStatus(selected.id, status))}
                />
              ))}
              <SheetAction
                title="Mettre à la corbeille"
                tone="danger"
                onPress={() =>
                  void run(
                    () => api.tasks.remove(selected.id),
                    'À la corbeille — restaurable 30 jours',
                  )
                }
              />
            </>
          )
        )}
      </Sheet>

      {/* Nouvelle tâche : le strict nécessaire d'une prise de note. */}
      <Sheet open={creating} onClose={() => setCreating(false)} title="Nouvelle tâche">
        <Field label="À faire">
          <Input value={title} onChangeText={setTitle} placeholder="Rappeler le camping…" autoFocus />
        </Field>
        <Field label="Priorité">
          <Chips
            value={priority}
            onChange={setPriority}
            options={PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABEL[p] }))}
          />
        </Field>
        <Field label="Client" hint="Nom noté au vol — la fiche pourra être rattachée au bureau.">
          <Input value={clientName} onChangeText={setClientName} placeholder="Camping Les Ajoncs" />
        </Field>
        <Field label="Détails">
          <Input value={details} onChangeText={setDetails} placeholder="Détails…" multiline />
        </Field>
        <Button
          title="Enregistrer"
          variant="primary"
          onPress={create}
          busy={busy}
          disabled={!title.trim()}
        />
      </Sheet>
    </View>
  );
}
