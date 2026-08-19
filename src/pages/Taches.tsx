import { useEffect, useMemo, useState } from 'react';
import type { Client, Task, TaskPriority, TaskStatus } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Icons,
  IconButton,
  Input,
  Modal,
  SearchInput,
  Segmented,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';
import { ClientPicker } from '../components/ClientPicker';
import { errorMessage, refreshAll, useClientIndex, useClients, useTasks } from '../lib/data';
import {
  dateFr,
  dateTimeFr,
  matches,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_TONE,
  TASK_STATUS_LABEL,
} from '../lib/format';

const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];
const STATUSES: TaskStatus[] = ['open', 'doing', 'done'];

/** Échéance passée sans être faite : c'est ce que l'écran doit crier. */
function isLate(task: Task): boolean {
  return Boolean(
    task.dueDate && task.status !== 'done' && task.dueDate < new Date().toISOString().slice(0, 10),
  );
}

export function Taches() {
  const { data: tasks, loading } = useTasks();
  const { data: clients } = useClients();
  const clientIndex = useClientIndex(clients);
  const toast = useToast();

  const [view, setView] = useState<'todo' | 'all' | 'trash'>('todo');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [busy, setBusy] = useState(false);

  // La fiche ouverte doit refléter les données rechargées après chaque écriture.
  useEffect(() => {
    if (!editing || editing === 'new') return;
    const fresh = tasks.find((t) => t.id === editing.id);
    if (fresh && fresh !== editing) setEditing(fresh);
  }, [tasks, editing]);

  const clientLabel = (task: Task): string => {
    if (task.clientId) return clientIndex.get(task.clientId)?.name ?? 'Client supprimé';
    return task.clientName ?? '—';
  };

  const trashCount = useMemo(() => tasks.filter((t) => t.deletedAt).length, [tasks]);

  // Le serveur livre déjà le bon ordre (urgent d'abord, puis l'échéance) :
  // l'écran ne fait que filtrer.
  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (view === 'trash') {
        if (!t.deletedAt) return false;
      } else {
        if (t.deletedAt) return false;
        if (view === 'todo' && t.status === 'done') return false;
      }
      if (!search) return true;
      return matches([t.title, t.details ?? '', clientLabel(t), t.assignedToName ?? ''].join(' '), search);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, view, search, clientIndex]);

  const setStatus = async (task: Task, status: TaskStatus) => {
    setBusy(true);
    try {
      await window.api.tasks.setStatus(task.id, status);
      refreshAll();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Changement impossible', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  // « Supprimer » = corbeille : le message le dit, pour que personne n'hésite.
  const moveToTrash = async (task: Task) => {
    try {
      await window.api.tasks.remove(task.id);
      refreshAll();
      toast.push({
        tone: 'success',
        title: 'Tâche mise à la corbeille',
        text: 'Restaurable depuis l’onglet « Corbeille » pendant 30 jours.',
      });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Suppression impossible', text: errorMessage(err) });
    }
  };

  const restore = async (task: Task) => {
    try {
      await window.api.tasks.restore(task.id);
      refreshAll();
      toast.push({ tone: 'success', title: 'Tâche restaurée' });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Restauration impossible', text: errorMessage(err) });
    }
  };

  if (loading) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 48 }}>
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row row--wrap" style={{ gap: 10 }}>
        <Segmented
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { value: 'todo', label: 'À faire' },
            { value: 'all', label: 'Tout' },
            { value: 'trash', label: trashCount ? `Corbeille (${trashCount})` : 'Corbeille' },
          ]}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Tâche, client, détails…"
          style={{ minWidth: 220 }}
        />
        <div className="spacer" />
        {view === 'trash' && trashCount > 0 && (
          <Button icon={<Icons.trash size={14} />} onClick={() => setEmptying(true)}>
            Vider la corbeille
          </Button>
        )}
        <Button variant="primary" icon={<Icons.plus size={14} />} onClick={() => setEditing('new')}>
          Nouvelle tâche
        </Button>
      </div>

      {!filtered.length ? (
        <div className="card">
          <EmptyState
            icon={<Icons.tasks size={32} />}
            title={
              view === 'trash'
                ? 'Corbeille vide'
                : tasks.some((t) => !t.deletedAt)
                  ? 'Rien ne correspond aux filtres'
                  : 'Aucune tâche'
            }
            text={
              view === 'trash'
                ? 'Les tâches supprimées attendent ici 30 jours avant de s’effacer : le temps de changer d’avis.'
                : tasks.some((t) => !t.deletedAt)
                  ? 'Modifiez la recherche ou affichez « Tout » pour voir les tâches faites.'
                  : 'Notez ce qui doit être fait — relance d’un client, SAV à rappeler, papier à envoyer — et l’équipe est prévenue sur ses postes.'
            }
            action={
              view !== 'trash' ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Nouvelle tâche
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th>Priorité</th>
                <th>Tâche</th>
                <th>Client</th>
                <th>Échéance</th>
                <th>Confiée à</th>
                {view === 'trash' ? <th>Supprimée le</th> : <th>Statut</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <tr key={task.id} onClick={() => setEditing(task)} style={{ cursor: 'default' }}>
                  <td>
                    <Badge tone={TASK_PRIORITY_TONE[task.priority]}>
                      {TASK_PRIORITY_LABEL[task.priority]}
                    </Badge>
                  </td>
                  <td>
                    <span
                      className="truncate"
                      style={{
                        fontWeight: 500,
                        textDecoration: task.status === 'done' ? 'line-through' : undefined,
                        opacity: task.status === 'done' ? 0.6 : 1,
                      }}
                    >
                      {task.title}
                    </span>
                    {task.details && <div className="tiny muted truncate">{task.details}</div>}
                  </td>
                  <td>
                    <span className="truncate">{clientLabel(task)}</span>
                    {!task.clientId && task.clientName && (
                      <div className="tiny muted">sans fiche client</div>
                    )}
                  </td>
                  <td>
                    {task.dueDate ? (
                      isLate(task) ? (
                        <Badge tone="badge--red">en retard — {dateFr(task.dueDate)}</Badge>
                      ) : (
                        dateFr(task.dueDate)
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="tiny">{task.assignedToName ?? <span className="muted">—</span>}</td>
                  {view === 'trash' ? (
                    <td className="muted tiny">{task.deletedAt ? dateTimeFr(task.deletedAt) : '—'}</td>
                  ) : (
                    <td onClick={(e) => e.stopPropagation()}>
                      <Select
                        value={task.status}
                        disabled={busy}
                        onChange={(e) => setStatus(task, e.target.value as TaskStatus)}
                        title="Changer le statut — un retour en arrière est toujours possible"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {TASK_STATUS_LABEL[s]}
                          </option>
                        ))}
                      </Select>
                    </td>
                  )}
                  <td style={{ width: 78 }} onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      {view === 'trash' ? (
                        <IconButton title="Restaurer" onClick={() => restore(task)}>
                          <Icons.refresh size={15} />
                        </IconButton>
                      ) : (
                        <IconButton
                          title="Mettre à la corbeille (restaurable 30 jours)"
                          danger
                          onClick={() => moveToTrash(task)}
                        >
                          <Icons.trash size={15} />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          clients={clients}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={emptying}
        title="Vider la corbeille ?"
        message={
          <>
            Les {trashCount} tâche(s) de la corbeille seront effacées pour de bon. C’est le seul
            geste de cet écran qui ne se défait pas.
          </>
        }
        confirmLabel="Tout effacer"
        onCancel={() => setEmptying(false)}
        onConfirm={async () => {
          setEmptying(false);
          try {
            const { purged } = await window.api.tasks.purge();
            refreshAll();
            toast.push({ tone: 'success', title: `Corbeille vidée (${purged})` });
          } catch (err) {
            toast.push({ tone: 'error', title: 'Purge impossible', text: errorMessage(err) });
          }
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* Tâche (création / modification)                                     */
/* ================================================================== */

function TaskDialog({
  task,
  clients,
  onClose,
}: {
  task: Task | null;
  clients: Client[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(task?.title ?? '');
  const [details, setDetails] = useState(task?.details ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'normal');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'open');
  const [clientId, setClientId] = useState<string | undefined>(task?.clientId);
  const [clientName, setClientName] = useState(task?.clientName ?? '');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [assignedTo, setAssignedTo] = useState(task?.assignedTo ?? '');
  const [people, setPeople] = useState<{ id: string; displayName: string }[]>([]);
  const [saving, setSaving] = useState(false);

  // Les comptes actifs, pour confier la tâche. Sans compte (application seule
  // sur ses propres données), le champ disparaît simplement.
  useEffect(() => {
    let cancelled = false;
    window.api.tasks
      .people()
      .then((list) => {
        if (!cancelled) setPeople(list);
      })
      .catch(() => {
        /* hors ligne ou sans droit : on cache le champ */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!title.trim()) {
      toast.push({ tone: 'warn', title: 'Donnez un intitulé à la tâche' });
      return;
    }
    setSaving(true);
    try {
      await window.api.tasks.save({
        id: task?.id,
        title,
        details,
        priority,
        status,
        clientId,
        clientName: clientId ? undefined : clientName.trim() || undefined,
        dueDate: dueDate || undefined,
        assignedTo: assignedTo || undefined,
        assignedToName: assignedTo
          ? people.find((p) => p.id === assignedTo)?.displayName ?? task?.assignedToName
          : undefined,
      });
      refreshAll();
      toast.push({ tone: 'success', title: task ? 'Tâche mise à jour' : 'Tâche ajoutée' });
      onClose();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Enregistrement impossible', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      wide
      title={task ? 'Modifier la tâche' : 'Nouvelle tâche'}
      subtitle={
        task
          ? `Créée le ${dateTimeFr(task.createdAt)}${task.createdByName ? ` par ${task.createdByName}` : ''}`
          : 'L’équipe est prévenue sur ses postes — sauf vous : vos propres ajouts ne vous sont jamais notifiés.'
      }
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="formgrid">
          <Field label="À faire">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!task} />
          </Field>
          <Field label="Priorité">
            <Segmented
              value={priority}
              onChange={(p) => setPriority(p)}
              options={PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABEL[p] }))}
            />
          </Field>
          <Field label="Échéance" hint="Passée sans être faite, la tâche s’affiche en retard">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Statut">
            <Select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          {people.length > 0 && (
            <Field label="Confiée à">
              <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">— Personne en particulier —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <ClientPicker
          clients={clients}
          clientId={clientId}
          clientName={clientName}
          onChange={(patch) => {
            setClientId(patch.clientId);
            setClientName(patch.clientName ?? '');
          }}
        />

        <Field label="Détails">
          <Textarea rows={3} value={details} onChange={(e) => setDetails(e.target.value)} />
        </Field>

        {task && task.history.length > 0 && (
          <Field
            label="Journal"
            hint="Chaque geste est noté — de quoi voir qui a changé quoi, et revenir en arrière en connaissance de cause"
          >
            <div className="list">
              {task.history.map((event, index) => (
                <div key={`${event.at}-${index}`} className="list__item">
                  <span className="tiny muted" style={{ minWidth: 118 }}>
                    {dateTimeFr(event.at)}
                  </span>
                  <span className="tiny" style={{ minWidth: 90, fontWeight: 500 }}>
                    {event.byName ?? 'Serveur'}
                  </span>
                  <span className="tiny truncate">{event.text}</span>
                </div>
              ))}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
