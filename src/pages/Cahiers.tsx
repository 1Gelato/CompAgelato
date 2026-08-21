import { useEffect, useMemo, useState } from 'react';
import type {
  Client,
  DeliveryRoute,
  EventMachine,
  MachineAvailability,
  RegisterEntry,
  RegisterItem,
  RegisterKind,
  RegisterStatus,
} from '@shared/types';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Icons,
  IconButton,
  Input,
  LoadError,
  Modal,
  NumberInput,
  SearchInput,
  Segmented,
  Select,
  Spinner,
  Textarea,
  Th,
  useToast,
} from '../components/ui';
import { ClientPicker } from '../components/ClientPicker';
import { ItemPicker } from '../components/ItemPicker';
import { CahierPrintView } from '../components/printLayouts';
import { printView } from '../lib/print';
import {
  errorMessage,
  refreshAll,
  useClientIndex,
  useClients,
  useMachines,
  useRegisterEntries,
  useRoutes,
  useSettings,
} from '../lib/data';
import {
  dateFr,
  dateTimeFr,
  matches,
  REGISTER_KIND_LABEL,
  REGISTER_STATUS_LABEL,
  REGISTER_STATUS_TONE,
} from '../lib/format';
import { useSort } from '../lib/sort';

const STATUSES: RegisterStatus[] = ['open', 'confirmed', 'done', 'cancelled'];

const KIND_TITLE: Record<RegisterKind, string> = {
  sav: 'Cause de la panne',
  consumables: 'Objet de la commande',
  event: 'Nom de l’événement',
  purchase: 'Ce que le client veut acheter',
  wintering: 'Machine gardée',
};

const KIND_EMPTY: Record<RegisterKind, string> = {
  sav: 'Aucune intervention SAV notée. « Nouvelle écriture » remplace le cahier papier.',
  consumables:
    'Aucune commande de consommables notée (mix, gobelets, pots…). « Nouvelle écriture » remplace le cahier papier.',
  event:
    'Aucune demande événementielle. Les machines ne sont réservées qu’au passage en « Devis validé ».',
  purchase:
    'Aucune demande d’achat. Quand un client veut acheter une machine, notez sa demande ici — le devis ou la facture viendront plus tard, s’ils viennent.',
  wintering:
    'Aucune machine à l’hivernage. Quand un client confie sa machine pour l’hiver, notez-la ici : « Au dépôt » à son arrivée, « Restituée » quand il la reprend.',
};

/** Colonne et champ des articles, propres à chaque cahier. */
const KIND_ITEMS_LABEL: Record<RegisterKind, string | null> = {
  sav: 'Pièces demandées',
  consumables: 'Articles commandés',
  event: null,
  purchase: 'Matériel souhaité',
  wintering: 'Accessoires laissés avec',
};

/** Nature du stock mise en avant dans le sélecteur d'articles. */
const KIND_ITEMS_TYPE: Record<RegisterKind, 'part' | 'consumable' | 'machine'> = {
  sav: 'part',
  consumables: 'consumable',
  event: 'consumable',
  purchase: 'machine',
  wintering: 'part',
};

/** Libellé de la colonne de date propre au cahier (vide : pas de colonne). */
const KIND_DATE_LABEL: Partial<Record<RegisterKind, string>> = {
  event: 'Prestation',
  wintering: 'Restitution prévue',
};

export function Cahiers() {
  const { data: entries, loading, error, reload } = useRegisterEntries();
  const { data: machines } = useMachines();
  const { data: clients } = useClients();
  const { data: routes } = useRoutes();
  const { data: settings } = useSettings();
  const clientIndex = useClientIndex(clients);
  const toast = useToast();

  const [kind, setKind] = useState<RegisterKind>('sav');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active'>('active');
  const [editing, setEditing] = useState<RegisterEntry | 'new' | null>(null);
  const [removing, setRemoving] = useState<RegisterEntry | null>(null);
  const [machineEditing, setMachineEditing] = useState<EventMachine | 'new' | null>(null);
  const [machineRemoving, setMachineRemoving] = useState<EventMachine | null>(null);
  const [routing, setRouting] = useState<RegisterEntry | null>(null);
  const [busy, setBusy] = useState(false);

  // La fiche ouverte doit refléter les données rechargées après chaque écriture.
  useEffect(() => {
    if (!editing || editing === 'new') return;
    const fresh = entries.find((e) => e.id === editing.id);
    if (fresh && fresh !== editing) setEditing(fresh);
  }, [entries, editing]);

  const clientLabel = (entry: RegisterEntry): string => {
    if (entry.clientId) return clientIndex.get(entry.clientId)?.name ?? 'Client supprimé';
    return entry.clientName ?? '—';
  };

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (e.kind !== kind) return false;
      if (statusFilter === 'active' && (e.status === 'done' || e.status === 'cancelled')) return false;
      if (!search) return true;
      return matches(
        [clientLabel(e), e.title, (e.items ?? []).map((i) => i.label).join(' '), e.details ?? ''].join(' '),
        search,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, kind, statusFilter, search, clientIndex]);

  const { sorted, sort, toggle } = useSort(
    filtered,
    useMemo(
      () => ({
        createdAt: (e: RegisterEntry) => e.createdAt,
        eventDate: (e: RegisterEntry) => e.eventDate ?? null,
        client: (e: RegisterEntry) => clientLabel(e),
        title: (e: RegisterEntry) => e.title,
        status: (e: RegisterEntry) => REGISTER_STATUS_LABEL[e.kind]?.[e.status] ?? e.status,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [clientIndex],
    ),
    { key: 'createdAt', direction: 'desc' },
  );

  const machineIndex = useMemo(
    () => new Map(machines.map((m) => [m.machine.id, m])),
    [machines],
  );

  const setStatus = async (entry: RegisterEntry, status: RegisterStatus) => {
    setBusy(true);
    try {
      await window.api.registers.setStatus(entry.id, status);
      refreshAll();
      if (entry.kind === 'event' && status === 'confirmed') {
        toast.push({ tone: 'success', title: 'Devis validé', text: 'Les machines sont réservées sur le parc.' });
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Changement impossible', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 48 }}>
        <Spinner size={22} />
      </div>
    );
  }

  if (error) return <LoadError error={error} onRetry={reload} />;

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row row--wrap" style={{ gap: 10 }}>
        <Segmented
          value={kind}
          onChange={(k) => setKind(k)}
          options={[
            { value: 'sav', label: 'SAV' },
            { value: 'consumables', label: 'Consommables' },
            { value: 'event', label: 'Événementiel' },
            { value: 'purchase', label: 'Achats' },
            { value: 'wintering', label: 'Hivernage' },
          ]}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Client, cause, commentaire…"
          style={{ minWidth: 220 }}
        />
        <Segmented
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'active', label: 'En cours' },
            { value: 'all', label: 'Tout' },
          ]}
        />
        <div className="spacer" />
        <Button
          icon={<Icons.print size={14} />}
          title="Imprimer ce cahier tel qu’il est affiché (filtres compris)"
          onClick={() => {
            // On imprime ce que l'écran montre : même cahier, mêmes filtres,
            // même ordre — pas de surprise entre l'écran et le papier.
            printView(
              `Cahier ${REGISTER_KIND_LABEL[kind]}`,
              <CahierPrintView
                kind={kind}
                kindLabel={REGISTER_KIND_LABEL[kind]}
                companyName={settings?.companyName}
                filterLabel={[
                  statusFilter === 'active' ? 'Écritures en cours' : 'Toutes les écritures',
                  search ? `recherche « ${search} »` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                rows={sorted.map((entry) => ({
                  entry,
                  who: clientLabel(entry),
                  machines: (entry.machines ?? [])
                    .map((m) => {
                      const machine = machineIndex.get(m.machineId)?.machine;
                      return machine ? `${m.qty} × ${machine.name}` : null;
                    })
                    .filter(Boolean)
                    .join(', '),
                }))}
              />,
            );
          }}
        >
          Imprimer
        </Button>
        <Button variant="primary" icon={<Icons.plus size={14} />} onClick={() => setEditing('new')}>
          Nouvelle écriture
        </Button>
      </div>

      {kind === 'wintering' && (
        <div className="infobox">
          {(() => {
            const stored = entries.filter((e) => e.kind === 'wintering' && e.status === 'confirmed');
            return stored.length
              ? `${stored.length} machine${stored.length > 1 ? 's' : ''} actuellement au dépôt. Le bouton « Imprimer » sort l'inventaire tel qu'affiché.`
              : 'Aucune machine au dépôt en ce moment. « Annoncée » quand le client prévient, « Au dépôt » à l’arrivée de la machine, « Restituée » quand il la reprend.';
          })()}
        </div>
      )}

      {!sorted.length ? (
        <div className="card">
          <EmptyState
            icon={<Icons.book size={32} />}
            title={
              entries.some((e) => e.kind === kind)
                ? 'Rien ne correspond aux filtres'
                : 'Cahier vide'
            }
            text={
              entries.some((e) => e.kind === kind)
                ? 'Modifiez la recherche ou affichez « Tout » pour voir les écritures terminées.'
                : KIND_EMPTY[kind]
            }
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                Nouvelle écriture
              </Button>
            }
          />
        </div>
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <Th sortKey="createdAt" sort={sort} onSort={toggle}>Noté le</Th>
                {KIND_DATE_LABEL[kind] && (
                  <Th sortKey="eventDate" sort={sort} onSort={toggle}>{KIND_DATE_LABEL[kind]}</Th>
                )}
                <Th sortKey="client" sort={sort} onSort={toggle}>Client</Th>
                <Th sortKey="title" sort={sort} onSort={toggle}>{KIND_TITLE[kind]}</Th>
                {KIND_ITEMS_LABEL[kind] && <Th>{KIND_ITEMS_LABEL[kind]}</Th>}
                {kind === 'event' && <Th>Machines</Th>}
                <Th sortKey="status" sort={sort} onSort={toggle}>Statut</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr key={entry.id} onClick={() => setEditing(entry)} style={{ cursor: 'default' }}>
                  <td className="muted">{dateFr(entry.createdAt.slice(0, 10))}</td>
                  {KIND_DATE_LABEL[kind] && (
                    <td style={{ fontWeight: 500 }}>
                      {entry.eventDate ? dateFr(entry.eventDate) : '—'}
                      {/* Une machine encore au dépôt après la date convenue : à rappeler. */}
                      {kind === 'wintering' &&
                        entry.status === 'confirmed' &&
                        entry.eventDate &&
                        entry.eventDate < new Date().toISOString().slice(0, 10) && (
                          <div>
                            <Badge tone="badge--orange">restitution dépassée</Badge>
                          </div>
                        )}
                    </td>
                  )}
                  <td>
                    <span className="truncate" style={{ fontWeight: 500 }}>
                      {clientLabel(entry)}
                    </span>
                    {!entry.clientId && entry.clientName && (
                      <div className="tiny muted">sans fiche client</div>
                    )}
                  </td>
                  <td>
                    <span className="truncate">{entry.title}</span>
                    {entry.details && <div className="tiny muted truncate">{entry.details}</div>}
                  </td>
                  {KIND_ITEMS_LABEL[kind] && (
                    <td className="tiny">
                      {entry.items?.length ? (
                        entry.items.map((i) => `${i.qty} × ${i.label}`).join(', ')
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  {kind === 'event' && (
                    <td className="tiny">
                      {(entry.machines ?? [])
                        .map((m) => {
                          const machine = machineIndex.get(m.machineId)?.machine;
                          return machine ? `${m.qty} × ${machine.name}` : null;
                        })
                        .filter(Boolean)
                        .join(', ') || <span className="muted">—</span>}
                    </td>
                  )}
                  <td onClick={(e) => e.stopPropagation()}>
                    <Select
                      value={entry.status}
                      disabled={busy}
                      onChange={(e) => setStatus(entry, e.target.value as RegisterStatus)}
                      title={
                        entry.kind === 'event'
                          ? 'Seul « Devis validé » réserve les machines'
                          : 'Changer le statut'
                      }
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {REGISTER_STATUS_LABEL[entry.kind][s]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td style={{ width: 78 }} onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      {/* Une machine vendue se livre, une machine hivernée se
                          restitue : la tournée sert à tous les cahiers. */}
                      <IconButton
                        title={
                          entry.routeId
                            ? 'Déjà dans une tournée — cliquer pour l’ajouter à une autre'
                            : 'Ajouter à une tournée de livraison'
                        }
                        active={Boolean(entry.routeId)}
                        onClick={() => setRouting(entry)}
                      >
                        <Icons.routes size={15} />
                      </IconButton>
                      <IconButton title="Supprimer" danger onClick={() => setRemoving(entry)}>
                        <Icons.trash size={15} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {kind === 'event' && (
        <Card
          title="Parc de machines"
          subtitle="Disponibilité en temps réel — réservées par les devis validés, rendues à la fin de la prestation"
          actions={
            <Button size="sm" icon={<Icons.plus size={13} />} onClick={() => setMachineEditing('new')}>
              Ajouter une machine
            </Button>
          }
        >
          {!machines.length ? (
            <EmptyState
              icon={<Icons.box size={28} />}
              title="Aucune machine dans le parc"
              text="Ajoutez vos machines à glace, vitrines et matériels prêtés en événementiel."
            />
          ) : (
            <div className="tablewrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Machine</th>
                    <th className="num">Parc</th>
                    <th className="num">Réservées</th>
                    <th className="num">Disponibles</th>
                    <th>Prochaines sorties</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {machines.map(({ machine, reserved, available, upcoming }) => (
                    <tr key={machine.id} onClick={() => setMachineEditing(machine)} style={{ cursor: 'default' }}>
                      <td>
                        <span style={{ fontWeight: 500 }}>{machine.name}</span>
                        {machine.reference && <span className="tiny muted mono"> · {machine.reference}</span>}
                        {machine.notes && <div className="tiny muted truncate">{machine.notes}</div>}
                      </td>
                      <td className="num">{machine.qtyTotal}</td>
                      <td className="num">{reserved || ''}</td>
                      <td className="num">
                        <Badge tone={available > 0 ? 'badge--green' : 'badge--red'}>{available}</Badge>
                      </td>
                      <td className="tiny muted">
                        {upcoming
                          .slice(0, 3)
                          .map((u) => `${u.date ? dateFr(u.date) : 'sans date'} — ${u.label}`)
                          .join(' · ') || '—'}
                      </td>
                      <td style={{ width: 44 }} onClick={(e) => e.stopPropagation()}>
                        <IconButton title="Retirer du parc" danger onClick={() => setMachineRemoving(machine)}>
                          <Icons.trash size={15} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {editing && (
        <EntryDialog
          kind={kind}
          entry={editing === 'new' ? null : editing}
          clients={clients}
          machines={machines}
          onClose={() => setEditing(null)}
        />
      )}

      {routing && (
        <RouteDialog entry={routing} routes={routes} onClose={() => setRouting(null)} />
      )}

      {machineEditing && (
        <MachineDialog
          machine={machineEditing === 'new' ? null : machineEditing}
          onClose={() => setMachineEditing(null)}
        />
      )}

      <ConfirmDialog
        open={Boolean(removing)}
        title="Supprimer cette écriture ?"
        message={<>« {removing?.title} » sera retirée du cahier. Cette action ne se défait pas.</>}
        confirmLabel="Supprimer"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const target = removing;
          setRemoving(null);
          if (!target) return;
          try {
            await window.api.registers.remove(target.id);
            refreshAll();
            toast.push({ tone: 'success', title: 'Écriture supprimée' });
          } catch (err) {
            toast.push({ tone: 'error', title: 'Suppression impossible', text: errorMessage(err) });
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(machineRemoving)}
        title="Retirer cette machine du parc ?"
        message={
          <>
            « {machineRemoving?.name} » disparaîtra du tableau des disponibilités. Une machine
            réservée par un devis validé ne peut pas être retirée.
          </>
        }
        confirmLabel="Retirer"
        onCancel={() => setMachineRemoving(null)}
        onConfirm={async () => {
          const target = machineRemoving;
          setMachineRemoving(null);
          if (!target) return;
          try {
            await window.api.machines.remove(target.id);
            refreshAll();
            toast.push({ tone: 'success', title: 'Machine retirée du parc' });
          } catch (err) {
            toast.push({ tone: 'error', title: 'Retrait impossible', text: errorMessage(err) });
          }
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* Écriture (création / modification)                                  */
/* ================================================================== */

function EntryDialog({
  kind,
  entry,
  clients,
  machines,
  onClose,
}: {
  kind: RegisterKind;
  entry: RegisterEntry | null;
  clients: Client[];
  machines: MachineAvailability[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [clientId, setClientId] = useState<string | undefined>(entry?.clientId);
  const [clientName, setClientName] = useState(entry?.clientName ?? '');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [items, setItems] = useState<RegisterItem[]>(entry?.items ?? []);
  const [details, setDetails] = useState(entry?.details ?? '');
  const [eventDate, setEventDate] = useState(entry?.eventDate ?? '');
  const [status, setStatus] = useState<RegisterStatus>(entry?.status ?? 'open');
  const [qty, setQty] = useState<Record<string, number>>(
    Object.fromEntries((entry?.machines ?? []).map((m) => [m.machineId, m.qty])),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) {
      toast.push({ tone: 'warn', title: 'Précisez l’objet', text: `« ${KIND_TITLE[kind]} » est vide.` });
      return;
    }
    setSaving(true);
    try {
      await window.api.registers.save({
        id: entry?.id,
        kind,
        clientId,
        clientName: clientId ? undefined : clientName.trim() || undefined,
        title,
        items: KIND_ITEMS_LABEL[kind] ? items : undefined,
        details,
        eventDate: KIND_DATE_LABEL[kind] ? eventDate || undefined : undefined,
        machines:
          kind === 'event'
            ? Object.entries(qty)
                .filter(([, q]) => q > 0)
                .map(([machineId, q]) => ({ machineId, qty: q }))
            : undefined,
        status,
      });
      refreshAll();
      toast.push({ tone: 'success', title: entry ? 'Écriture mise à jour' : 'Ajouté au cahier' });
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
      title={entry ? 'Modifier l’écriture' : 'Nouvelle écriture'}
      subtitle={
        kind === 'event'
          ? 'Une demande ne réserve rien : les machines ne sortent du parc qu’au « Devis validé ».'
          : entry
            ? `Notée le ${dateTimeFr(entry.createdAt)}`
            : undefined
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
        <ClientPicker
          clients={clients}
          clientId={clientId}
          clientName={clientName}
          onChange={(patch) => {
            setClientId(patch.clientId);
            setClientName(patch.clientName ?? '');
          }}
        />

        <div className="formgrid">
          <Field label={KIND_TITLE[kind]}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!entry} />
          </Field>
          <Field label="Statut">
            <Select value={status} onChange={(e) => setStatus(e.target.value as RegisterStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {REGISTER_STATUS_LABEL[kind][s]}
                </option>
              ))}
            </Select>
          </Field>

          {KIND_DATE_LABEL[kind] && (
            <Field
              label={kind === 'wintering' ? 'Restitution prévue' : 'Date de la prestation'}
              hint={
                kind === 'wintering'
                  ? 'Vers quand le client reprend sa machine — au printemps, souvent. Passée sans restitution, la ligne le signale.'
                  : undefined
              }
            >
              <Input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
            </Field>
          )}
        </div>

        {KIND_ITEMS_LABEL[kind] && (
          <ItemPicker
            label={KIND_ITEMS_LABEL[kind]!}
            preferredType={KIND_ITEMS_TYPE[kind]}
            items={items}
            onChange={setItems}
          />
        )}

        {kind === 'event' && (
          <Field
            label="Machines demandées"
            hint="Les disponibilités affichées tiennent compte des autres devis validés"
          >
            {machines.length === 0 ? (
              <p className="tiny muted" style={{ margin: 0 }}>
                Aucune machine dans le parc — ajoutez-les depuis le tableau « Parc de machines ».
              </p>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {machines.map(({ machine, available }) => (
                  <div key={machine.id} className="row" style={{ gap: 10, alignItems: 'center' }}>
                    <span style={{ minWidth: 220 }} className="truncate">
                      {machine.name}
                    </span>
                    <span className="tiny muted" style={{ minWidth: 90 }}>
                      {available} dispo / {machine.qtyTotal}
                    </span>
                    <NumberInput
                      value={qty[machine.id] ?? 0}
                      onValueChange={(v) => setQty((q) => ({ ...q, [machine.id]: Math.max(0, Math.round(v)) }))}
                      style={{ width: 90 }}
                    />
                  </div>
                ))}
              </div>
            )}
          </Field>
        )}

        <Field label="Commentaire">
          <Textarea rows={3} value={details} onChange={(e) => setDetails(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Machine du parc                                                     */
/* ================================================================== */

function MachineDialog({ machine, onClose }: { machine: EventMachine | null; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(machine?.name ?? '');
  const [reference, setReference] = useState(machine?.reference ?? '');
  const [qtyTotal, setQtyTotal] = useState(machine?.qtyTotal ?? 1);
  const [notes, setNotes] = useState(machine?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      toast.push({ tone: 'warn', title: 'Nommez la machine' });
      return;
    }
    setSaving(true);
    try {
      await window.api.machines.save({
        id: machine?.id,
        name,
        reference,
        qtyTotal: Math.max(0, Math.round(qtyTotal)),
        notes,
      });
      refreshAll();
      toast.push({ tone: 'success', title: machine ? 'Machine mise à jour' : 'Machine ajoutée au parc' });
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
      title={machine ? 'Modifier la machine' : 'Ajouter une machine'}
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
      <div className="formgrid">
        <Field label="Nom" hint="Ex. : Machine à glace italienne">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Référence">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Exemplaires possédés">
          <NumberInput value={qtyTotal} onValueChange={setQtyTotal} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ================================================================== */
/* Ajout d'une écriture à une tournée de livraison                     */
/* ================================================================== */

function RouteDialog({
  entry,
  routes,
  onClose,
}: {
  entry: RegisterEntry;
  routes: DeliveryRoute[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [routeId, setRouteId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Les tournées à venir d'abord : c'est là qu'on ajoute un arrêt en pratique.
  const sortedRoutes = useMemo(
    () => [...routes].sort((a, b) => b.date.localeCompare(a.date)),
    [routes],
  );

  const add = async () => {
    setSaving(true);
    try {
      const { route } = await window.api.registers.addToRoute(entry.id, routeId || undefined);
      refreshAll();
      toast.push({
        tone: 'success',
        title: 'Arrêt ajouté',
        text: `« ${entry.title} » figure dans la tournée « ${route.name} ». Calculez le trajet depuis l’onglet Tournées.`,
      });
      onClose();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ajout impossible', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title="Ajouter à une tournée"
      subtitle={entry.title}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={add} loading={saving}>
            Ajouter l’arrêt
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <Field label="Tournée">
          <Select value={routeId} onChange={(e) => setRouteId(e.target.value)}>
            <option value="">— Créer une nouvelle tournée —</option>
            {sortedRoutes.map((route) => (
              <option key={route.id} value={route.id}>
                {route.name} ({dateFr(route.date)}, {route.stops.length} arrêt
                {route.stops.length > 1 ? 's' : ''})
              </option>
            ))}
          </Select>
        </Field>

        <div className="infobox">
          L’arrêt reprend l’adresse de la fiche client, avec la cause ou l’objet en note. Le
          calcul du trajet est remis à zéro puisqu’un arrêt s’ajoute : relancez-le depuis
          l’onglet Tournées.
        </div>
      </div>
    </Modal>
  );
}
