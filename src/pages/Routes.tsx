import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Address,
  Client,
  DeliveryRoute,
  OptimizeResult,
  RouteStop,
  Settings,
  Vehicle,
} from '@shared/types';
import type { RouteQr } from '@shared/api';
import { AddressInput } from '../components/AddressInput';
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
  Modal,
  NumberInput,
  Segmented,
  Select,
  Spinner,
  Switch,
  useToast,
} from '../components/ui';
import { errorMessage, refreshAll, useClients, useRoutes, useSettings, useVehicles } from '../lib/data';
import { dateFr, duration, euro, km, matches, num } from '../lib/format';

let localId = 0;
const nextId = (prefix: string) => `${prefix}_local${localId++}_${Date.now().toString(36)}`;

function blankRoute(settings: Settings | null, vehicles: Vehicle[]): DeliveryRoute {
  const now = new Date().toISOString();
  return {
    id: nextId('rte'),
    name: `Tournée du ${new Date().toLocaleDateString('fr-FR')}`,
    date: now.slice(0, 10),
    vehicleId: settings?.defaultVehicleId ?? vehicles[0]?.id,
    start: {
      id: nextId('stp'),
      label: 'Dépôt',
      address: settings?.depot ?? { label: '', country: 'France' },
      pinned: false,
      serviceMinutes: 0,
    },
    stops: [],
    returnToStart: true,
    end: null,
    tollCost: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function Routes() {
  const { data: routes, loading } = useRoutes();
  const { data: clients } = useClients();
  const { data: vehicles } = useVehicles();
  const { data: settings } = useSettings();
  const toast = useToast();

  const [route, setRoute] = useState<DeliveryRoute | null>(null);
  const [dirty, setDirty] = useState(false);
  const [computing, setComputing] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [lastOptimization, setLastOptimization] = useState<OptimizeResult | null>(null);
  const [sending, setSending] = useState<RouteQr | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedRouteIds, setSavedRouteIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSavedRouteIds(new Set(routes.map((r) => r.id)));
  }, [routes]);

  // Ouvre la tournée la plus récente au premier chargement.
  useEffect(() => {
    if (route || loading) return;
    if (routes.length) setRoute(routes[0]);
    else if (settings) setRoute(blankRoute(settings, vehicles));
  }, [routes, loading, route, settings, vehicles]);

  const update = useCallback((patch: Partial<DeliveryRoute>) => {
    setRoute((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  }, []);

  const isSaved = route ? savedRouteIds.has(route.id) : false;

  const save = async () => {
    if (!route) return;
    try {
      const saved = await window.api.routes.save(isSaved ? route : { ...route, id: undefined });
      setRoute(saved);
      setDirty(false);
      refreshAll();
      toast.push({ tone: 'success', title: 'Tournée enregistrée' });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Enregistrement impossible', text: errorMessage(err) });
    }
  };

  const compute = async () => {
    if (!route) return;
    setComputing(true);
    try {
      const result = await window.api.routes.compute(route);
      setRoute(result.route);
      setLastOptimization(null);
      if (isSaved) refreshAll();
      if (result.computation.engine === 'haversine') {
        toast.push({
          tone: 'warn',
          title: 'Estimation hors-ligne',
          text: 'Le service d’itinéraires n’a pas répondu : distances estimées à vol d’oiseau majorées de 35 %.',
        });
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Calcul impossible', text: errorMessage(err) });
    } finally {
      setComputing(false);
    }
  };

  const optimize = async () => {
    if (!route) return;
    setOptimizing(true);
    try {
      const result = await window.api.routes.optimize(route, { returnToStart: route.returnToStart });
      setRoute(result.route);
      setLastOptimization(result.result);
      if (isSaved) refreshAll();
      toast.push({
        tone: result.result.savedKm > 0.1 ? 'success' : 'info',
        title: result.result.savedKm > 0.1 ? 'Tournée optimisée' : 'Ordre déjà optimal',
        text:
          result.result.savedKm > 0.1
            ? `${km(result.result.savedKm)} et ${duration(result.result.savedMin)} économisés.`
            : 'Aucun gain possible en respectant vos arrêts épinglés.',
      });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Optimisation impossible', text: errorMessage(err) });
    } finally {
      setOptimizing(false);
    }
  };

  const send = async (provider: 'google' | 'waze' | 'apple') => {
    if (!route) return;
    try {
      const result = await window.api.routes.link(route, provider);
      setSending(result);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Itinéraire indisponible', text: errorMessage(err) });
    }
  };

  if (loading && !route) {
    return (
      <div className="empty">
        <Spinner size={22} />
      </div>
    );
  }
  if (!route) return <EmptyState title="Chargement…" />;

  const locatedStops = route.stops.filter((s) => typeof s.address.lat === 'number').length;
  const canCompute = typeof route.start.address.lat === 'number' && locatedStops >= 1;

  return (
    <>
      <div className="row row--wrap" style={{ marginBottom: 12 }}>
        <Select
          style={{ width: 260 }}
          value={isSaved ? route.id : ''}
          onChange={(e) => {
            const found = routes.find((r) => r.id === e.target.value);
            setRoute(found ?? blankRoute(settings, vehicles));
            setDirty(false);
            setLastOptimization(null);
          }}
        >
          {!isSaved && <option value="">Nouvelle tournée (non enregistrée)</option>}
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} — {dateFr(r.date)}
            </option>
          ))}
        </Select>
        <Button
          icon={<Icons.plus size={14} />}
          onClick={() => {
            setRoute(blankRoute(settings, vehicles));
            setDirty(false);
            setLastOptimization(null);
          }}
        >
          Nouvelle
        </Button>
        <div className="spacer" />
        <div className="row">
          {isSaved && (
            <Button
              icon={<Icons.download size={14} />}
              title="Exporter la feuille de route en CSV"
              onClick={async () => {
                try {
                  const file = await window.api.routes.exportCsv(route.id);
                  if (file) {
                    toast.push({ tone: 'success', title: 'Feuille de route exportée', text: file });
                    await window.api.app.revealFile(file);
                  }
                } catch (err) {
                  toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
                }
              }}
            />
          )}
          {isSaved && (
            <Button variant="danger" icon={<Icons.trash size={14} />} onClick={() => setConfirmDelete(true)} />
          )}
          <Button variant={dirty ? 'primary' : 'default'} onClick={save} disabled={!dirty && isSaved}>
            {isSaved ? 'Enregistrer' : 'Enregistrer la tournée'}
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 330px', gap: 14, alignItems: 'start' }}>
        <div className="col" style={{ gap: 14 }}>
          <Card title="Feuille de route" subtitle="Départ, arrêts et retour">
            <div className="col" style={{ gap: 13 }}>
              <div className="formgrid">
                <Field label="Nom de la tournée">
                  <Input value={route.name} onChange={(e) => update({ name: e.target.value })} />
                </Field>
                <Field label="Date">
                  <Input type="date" value={route.date} onChange={(e) => update({ date: e.target.value })} />
                </Field>
                <Field label="Véhicule">
                  <Select value={route.vehicleId ?? ''} onChange={(e) => update({ vehicleId: e.target.value })}>
                    {vehicles.map((vehicle) => (
                      <option key={vehicle.id} value={vehicle.id}>
                        {vehicle.name} — {num(vehicle.consumption)} L/100 km
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <Field label="Point de départ (dépôt)">
                <AddressInput
                  value={route.start.address}
                  onChange={(address) =>
                    update({ start: { ...route.start, address, label: route.start.label || 'Dépôt' } })
                  }
                  placeholder="Adresse du dépôt…"
                />
              </Field>

              <div className="row">
                <Switch
                  checked={route.returnToStart}
                  onChange={(v) => update({ returnToStart: v })}
                  label="Retour au dépôt en fin de tournée"
                />
              </div>

              {!route.returnToStart && (
                <Field label="Point d’arrivée" hint="Laissez vide pour terminer au dernier arrêt.">
                  <AddressInput
                    value={route.end?.address ?? { label: '', country: 'France' }}
                    onChange={(address) =>
                      update({
                        end: {
                          id: route.end?.id ?? nextId('stp'),
                          label: 'Arrivée',
                          address,
                          pinned: false,
                          serviceMinutes: 0,
                        },
                      })
                    }
                    placeholder="Adresse d’arrivée…"
                  />
                </Field>
              )}
            </div>
          </Card>

          <StopList
            route={route}
            clients={clients}
            onChange={(stops) => update({ stops })}
          />
        </div>

        <div className="col" style={{ gap: 14, position: 'sticky', top: 0 }}>
          <Card title="Coût du trajet">
            <CostPanel
              route={route}
              vehicle={vehicles.find((v) => v.id === route.vehicleId)}
              settings={settings}
              onTollChange={(tollCost) => update({ tollCost })}
            />
          </Card>

          <Card title="Actions">
            <div className="col" style={{ gap: 9 }}>
              <Button block variant="primary" icon={<Icons.sparkle size={14} />} onClick={optimize} loading={optimizing} disabled={!canCompute || route.stops.length < 2}>
                Optimiser la tournée
              </Button>
              <Button block icon={<Icons.refresh size={14} />} onClick={compute} loading={computing} disabled={!canCompute}>
                Recalculer le coût
              </Button>
              <div className="divider" style={{ margin: '3px 0' }} />
              <div className="field__label">Envoyer sur le téléphone</div>
              <div className="row" style={{ gap: 6 }}>
                <Button block size="sm" onClick={() => send('google')} disabled={!canCompute}>
                  Google Maps
                </Button>
                <Button block size="sm" onClick={() => send('waze')} disabled={!canCompute}>
                  Waze
                </Button>
              </div>
              <Button block size="sm" onClick={() => send('apple')} disabled={!canCompute}>
                Plans (Apple)
              </Button>
              {!canCompute && (
                <div className="warnbox">
                  {typeof route.start.address.lat !== 'number'
                    ? 'Le point de départ n’a pas de position GPS. Choisissez une proposition dans le champ « Point de départ », ou rétablissez le dépôt depuis les Réglages.'
                    : 'Aucun arrêt n’a de position GPS. Utilisez le bouton de localisation (icône repère) sur chaque arrêt, ou ouvrez-le pour choisir une adresse dans la liste.'}
                </div>
              )}
              {canCompute && route.stops.length < 2 && (
                <div className="field__hint">
                  L’optimisation demande au moins deux arrêts localisés.
                </div>
              )}
            </div>
          </Card>

          {lastOptimization && <OptimizationResult result={lastOptimization} />}
        </div>
      </div>

      {sending && <SendDialog result={sending} onClose={() => setSending(null)} />}

      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Supprimer cette tournée ?"
        confirmLabel="Supprimer"
        message={`« ${route.name} » sera définitivement supprimée.`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          try {
            await window.api.routes.remove(route.id);
            refreshAll();
            setRoute(blankRoute(settings, vehicles));
            toast.push({ tone: 'success', title: 'Tournée supprimée' });
          } catch (err) {
            toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

/* ================================================================== */
/* Liste des arrêts                                                    */
/* ================================================================== */

function StopList({
  route,
  clients,
  onChange,
}: {
  route: DeliveryRoute;
  clients: Client[];
  onChange: (stops: RouteStop[]) => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [editingStop, setEditingStop] = useState<RouteStop | null>(null);
  const [locating, setLocating] = useState<string | null>(null);

  /**
   * Cherche la position d'un arrêt à partir de son adresse écrite.
   * Sans coordonnées, l'arrêt ne peut entrer ni dans le calcul de distance ni
   * dans l'optimisation.
   */
  const locate = async (stop: RouteStop) => {
    const query = [stop.address.street, stop.address.postcode, stop.address.city]
      .filter(Boolean)
      .join(' ')
      .trim() || stop.address.label;
    if (!query) {
      toast.push({ tone: 'warn', title: 'Adresse vide', text: 'Renseignez d’abord une adresse.' });
      return;
    }
    setLocating(stop.id);
    try {
      const [hit] = await window.api.geo.autocomplete(query, undefined);
      if (!hit) {
        toast.push({
          tone: 'warn',
          title: 'Adresse non reconnue',
          text: `« ${query} » n’a pas été trouvée. Modifiez l’arrêt et choisissez une proposition.`,
        });
        return;
      }
      onChange(
        route.stops.map((s) =>
          s.id === stop.id
            ? {
                ...s,
                address: {
                  label: hit.label,
                  street: hit.street,
                  postcode: hit.postcode,
                  city: hit.city,
                  country: 'France',
                  lat: hit.lat,
                  lon: hit.lon,
                },
              }
            : s,
        ),
      );
      toast.push({ tone: 'success', title: 'Arrêt localisé', text: hit.label });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Localisation impossible', text: errorMessage(err) });
    } finally {
      setLocating(null);
    }
  };

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...route.stops];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    // Les arrêts épinglés mémorisent leur nouvelle position.
    onChange(next.map((stop, index) => ({ ...stop, pinnedIndex: stop.pinned ? index : undefined })));
  };

  const togglePin = (index: number) => {
    onChange(
      route.stops.map((stop, i) =>
        i === index
          ? { ...stop, pinned: !stop.pinned, pinnedIndex: !stop.pinned ? index : undefined }
          : stop,
      ),
    );
  };

  const pinnedCount = route.stops.filter((s) => s.pinned).length;
  const unlocated = route.stops.filter((s) => typeof s.address.lat !== 'number');

  /** Localise en une fois tous les arrêts dont la position est inconnue. */
  const locateAll = async () => {
    setLocating('all');
    let found = 0;
    const updated = [...route.stops];
    try {
      for (const stop of unlocated) {
        const query =
          [stop.address.street, stop.address.postcode, stop.address.city].filter(Boolean).join(' ').trim() ||
          stop.address.label;
        if (!query) continue;
        try {
          const [hit] = await window.api.geo.autocomplete(query, undefined);
          if (!hit) continue;
          const index = updated.findIndex((s) => s.id === stop.id);
          if (index < 0) continue;
          updated[index] = {
            ...updated[index],
            address: {
              label: hit.label,
              street: hit.street,
              postcode: hit.postcode,
              city: hit.city,
              country: 'France',
              lat: hit.lat,
              lon: hit.lon,
            },
          };
          found++;
        } catch {
          /* on continue avec les arrêts suivants */
        }
        // Rythme volontairement modéré : le service d'adresses est public.
        await new Promise((resolve) => setTimeout(resolve, 140));
      }
      if (found) onChange(updated);
      toast.push({
        tone: found ? 'success' : 'warn',
        title: found ? `${found} arrêt(s) localisé(s)` : 'Aucun arrêt localisé',
        text: found
          ? 'Le calcul de coût et l’optimisation sont maintenant possibles.'
          : 'Ouvrez les arrêts concernés et choisissez une adresse dans la liste de propositions.',
      });
    } finally {
      setLocating(null);
    }
  };

  return (
    <>
      <Card
        title={`Arrêts (${route.stops.length})`}
        subtitle={
          unlocated.length
            ? `${unlocated.length} arrêt(s) sans position GPS — ils sont exclus du calcul`
            : pinnedCount
              ? `${pinnedCount} arrêt(s) épinglé(s) : leur position ne bougera pas lors de l’optimisation`
              : 'Glissez pour réordonner, épinglez pour figer une position'
        }
        actions={
          <>
            {unlocated.length > 0 && (
              <Button
                size="sm"
                icon={<Icons.route size={12} />}
                loading={locating === 'all'}
                onClick={locateAll}
                title="Rechercher la position de tous les arrêts qui n’en ont pas"
              >
                Localiser {unlocated.length}
              </Button>
            )}
            <Button size="sm" variant="primary" icon={<Icons.plus size={12} />} onClick={() => setAdding(true)}>
              Ajouter un arrêt
            </Button>
          </>
        }
      >
        {route.stops.length === 0 ? (
          <EmptyState
            icon={<Icons.route size={28} />}
            title="Aucun arrêt"
            text="Ajoutez vos points de livraison : choisissez un client de votre carnet ou tapez une adresse, l’auto-complétion s’occupe du reste."
            action={
              <Button variant="primary" icon={<Icons.plus size={14} />} onClick={() => setAdding(true)}>
                Ajouter le premier arrêt
              </Button>
            }
          />
        ) : (
          <div className="stops">
            <div className="stop stop--depot">
              <span className="stop__index">
                <Icons.route size={12} />
              </span>
              <div className="stop__body">
                <div className="stop__title">{route.start.label || 'Départ'}</div>
                <div className="stop__sub">{route.start.address.label || 'Adresse non renseignée'}</div>
              </div>
              <span className="badge">Départ</span>
            </div>

            {route.stops.map((stop, index) => {
              const located = typeof stop.address.lat === 'number';
              return (
                <div
                  key={stop.id}
                  className={[
                    'stop',
                    stop.pinned ? 'stop--pinned' : '',
                    dragIndex === index ? 'stop--dragging' : '',
                    overIndex === index && dragIndex !== null && dragIndex !== index ? 'stop--over' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverIndex(index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null) move(dragIndex, index);
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                >
                  <span className="stop__handle" title="Glisser pour réordonner">
                    <Icons.grip size={14} />
                  </span>
                  <span className="stop__index">{index + 1}</span>
                  <div className="stop__body" onDoubleClick={() => setEditingStop(stop)}>
                    <div className="stop__title">
                      {stop.label || 'Arrêt sans nom'}
                      {!located && (
                        <span
                          style={{ color: 'var(--orange)', marginLeft: 6, fontSize: 11 }}
                          title="La position GPS de cette adresse est inconnue : l’arrêt est ignoré dans le calcul de distance et d’optimisation."
                        >
                          position inconnue
                        </span>
                      )}
                    </div>
                    <div className="stop__sub">{stop.address.label || 'Adresse non renseignée'}</div>
                  </div>

                  {stop.legDistanceKm !== undefined && (
                    <div className="stop__meta">
                      <div>{km(stop.legDistanceKm)}</div>
                      <div>{duration(stop.legDurationMin)}</div>
                    </div>
                  )}

                  <div className="stop__meta" style={{ minWidth: 44 }}>
                    <div>{stop.serviceMinutes} min</div>
                    <div className="tiny">sur place</div>
                  </div>

                  <div className="stop__actions">
                    {!located && (
                      <IconButton
                        title="Rechercher la position de cette adresse"
                        disabled={locating === stop.id}
                        onClick={() => locate(stop)}
                      >
                        {locating === stop.id ? (
                          <span className="spin">
                            <Icons.refresh size={14} />
                          </span>
                        ) : (
                          <span style={{ color: 'var(--orange)' }}>
                            <Icons.route size={14} />
                          </span>
                        )}
                      </IconButton>
                    )}
                    <IconButton
                      title={stop.pinned ? 'Libérer la position' : 'Épingler à cette position'}
                      active={stop.pinned}
                      onClick={() => togglePin(index)}
                    >
                      <Icons.pin size={14} />
                    </IconButton>
                    <IconButton title="Modifier" onClick={() => setEditingStop(stop)}>
                      <Icons.edit size={14} />
                    </IconButton>
                    <IconButton
                      title="Retirer"
                      danger
                      onClick={() => onChange(route.stops.filter((s) => s.id !== stop.id))}
                    >
                      <Icons.trash size={14} />
                    </IconButton>
                  </div>
                </div>
              );
            })}

            {route.returnToStart && (
              <div className="stop stop--depot">
                <span className="stop__index">
                  <Icons.route size={12} />
                </span>
                <div className="stop__body">
                  <div className="stop__title">Retour — {route.start.label || 'Dépôt'}</div>
                  <div className="stop__sub">{route.start.address.label}</div>
                </div>
                <span className="badge">Arrivée</span>
              </div>
            )}
          </div>
        )}
      </Card>

      {adding && (
        <AddStopDialog
          clients={clients}
          existing={route.stops}
          near={
            typeof route.start.address.lat === 'number'
              ? { lat: route.start.address.lat, lon: route.start.address.lon as number }
              : undefined
          }
          onClose={() => setAdding(false)}
          onAdd={(stops) => {
            onChange([...route.stops, ...stops]);
            setAdding(false);
          }}
        />
      )}

      {editingStop && (
        <EditStopDialog
          stop={editingStop}
          onClose={() => setEditingStop(null)}
          onSave={(updated) => {
            onChange(route.stops.map((s) => (s.id === updated.id ? updated : s)));
            setEditingStop(null);
          }}
        />
      )}
    </>
  );
}

/* ================================================================== */
/* Ajout d'arrêt                                                       */
/* ================================================================== */

function AddStopDialog({
  clients,
  existing,
  near,
  onClose,
  onAdd,
}: {
  clients: Client[];
  existing: RouteStop[];
  near?: { lat: number; lon: number };
  onClose: () => void;
  onAdd: (stops: RouteStop[]) => void;
}) {
  const [mode, setMode] = useState<'client' | 'address'>('client');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [address, setAddress] = useState<Address>({ label: '', country: 'France' });
  const [label, setLabel] = useState('');
  const [serviceMinutes, setServiceMinutes] = useState(10);

  const alreadyIn = useMemo(
    () => new Set(existing.map((s) => s.clientId).filter(Boolean) as string[]),
    [existing],
  );

  const listed = useMemo(
    () =>
      clients
        .filter((c) => !c.archived)
        .filter((c) =>
          matches([c.name, c.code, c.address.city ?? '', c.address.postcode ?? '', c.tags.join(' ')].join(' '), search),
        )
        .sort((a, b) => {
          // Les fiches géolocalisées d'abord : ce sont les seules calculables.
          const la = typeof a.address.lat === 'number' ? 0 : 1;
          const lb = typeof b.address.lat === 'number' ? 0 : 1;
          return la - lb || a.name.localeCompare(b.name, 'fr');
        }),
    [clients, search],
  );

  const addClients = () => {
    const stops: RouteStop[] = [...selected]
      .map((id) => clients.find((c) => c.id === id))
      .filter((c): c is Client => Boolean(c))
      .map((client) => ({
        id: nextId('stp'),
        clientId: client.id,
        label: client.name,
        address: client.address,
        pinned: false,
        serviceMinutes,
      }));
    if (stops.length) onAdd(stops);
  };

  const addAddress = () => {
    if (!address.label.trim()) return;
    onAdd([
      {
        id: nextId('stp'),
        label: label.trim() || address.city || address.label.slice(0, 40),
        address,
        pinned: false,
        serviceMinutes,
      },
    ]);
  };

  return (
    <Modal
      open
      wide
      title="Ajouter un arrêt"
      subtitle="Depuis votre carnet de clients ou par recherche d’adresse"
      onClose={onClose}
      footer={
        <>
          <div className="row" style={{ marginRight: 'auto' }}>
            <span className="field__label">Temps sur place</span>
            <div style={{ width: 90 }}>
              <NumberInput value={serviceMinutes} onValueChange={setServiceMinutes} suffix="min" />
            </div>
          </div>
          <Button onClick={onClose}>Annuler</Button>
          <Button
            variant="primary"
            onClick={mode === 'client' ? addClients : addAddress}
            disabled={mode === 'client' ? selected.size === 0 : !address.label.trim()}
          >
            {mode === 'client' && selected.size > 1 ? `Ajouter ${selected.size} arrêts` : 'Ajouter'}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 13 }}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'client', label: 'Carnet de clients' },
            { value: 'address', label: 'Recherche d’adresse' },
          ]}
        />

        {mode === 'client' ? (
          <>
            <Input
              placeholder="Rechercher un client…"
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="tablewrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
              {listed.length === 0 ? (
                <EmptyState title="Aucun client" text="Importez votre liste clients depuis l’onglet Clients." />
              ) : (
                <table className="data">
                  <tbody>
                    {listed.map((client) => {
                      const located = typeof client.address.lat === 'number';
                      const checked = selected.has(client.id);
                      return (
                        <tr
                          key={client.id}
                          data-selected={checked}
                          onClick={() =>
                            setSelected((set) => {
                              const next = new Set(set);
                              if (next.has(client.id)) next.delete(client.id);
                              else next.add(client.id);
                              return next;
                            })
                          }
                        >
                          <td style={{ width: 30 }}>
                            <span style={{ color: checked ? 'var(--accent)' : 'var(--separator-strong)' }}>
                              <Icons.check size={15} />
                            </span>
                          </td>
                          <td>
                            <div style={{ fontWeight: 500 }}>{client.name}</div>
                            <div className="tiny muted truncate" style={{ maxWidth: 420 }}>
                              {client.address.label || 'Adresse non renseignée'}
                            </div>
                          </td>
                          <td style={{ width: 130 }}>
                            <div className="row" style={{ gap: 5, justifyContent: 'flex-end' }}>
                              {alreadyIn.has(client.id) && <Badge>déjà dans la tournée</Badge>}
                              {!located && <Badge tone="badge--orange">position inconnue</Badge>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="field__hint">
              « Position inconnue » signifie que l’adresse du client n’a pas encore été rapprochée
              d’un point sur la carte. Vous pouvez tout de même l’ajouter : le bouton de
              localisation, sur la ligne de l’arrêt, cherchera sa position. L’onglet Clients permet
              aussi de traiter toutes les fiches d’un coup.
            </div>
          </>
        ) : (
          <>
            <Field label="Adresse">
              <AddressInput value={address} onChange={setAddress} near={near} autoFocus />
            </Field>
            <Field label="Nom de l’arrêt" hint="Facultatif — repris de l’adresse si vide">
              <Input
                value={label}
                placeholder="Marché de Pornichet, salle des fêtes…"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function EditStopDialog({
  stop,
  onClose,
  onSave,
}: {
  stop: RouteStop;
  onClose: () => void;
  onSave: (stop: RouteStop) => void;
}) {
  const [draft, setDraft] = useState<RouteStop>(stop);

  return (
    <Modal
      open
      title="Modifier l’arrêt"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 13 }}>
        <Field label="Nom">
          <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} autoFocus />
        </Field>
        <Field label="Adresse">
          <AddressInput value={draft.address} onChange={(address) => setDraft({ ...draft, address })} />
        </Field>
        <div className="formgrid">
          <Field label="Temps sur place">
            <NumberInput
              value={draft.serviceMinutes}
              onValueChange={(v) => setDraft({ ...draft, serviceMinutes: v })}
              suffix="min"
            />
          </Field>
        </div>
        <Field label="Notes">
          <Input
            value={draft.notes ?? ''}
            placeholder="Code portail, contact sur place…"
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Coûts                                                               */
/* ================================================================== */

function CostPanel({
  route,
  vehicle,
  settings,
  onTollChange,
}: {
  route: DeliveryRoute;
  vehicle?: Vehicle;
  settings: Settings | null;
  onTollChange: (value: number) => void;
}) {
  const c = route.computation;
  const isElectric = vehicle?.fuelType === 'electrique';

  return (
    <div className="col" style={{ gap: 13 }}>
      {!c ? (
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          Lancez « Recalculer le coût » pour obtenir la distance réelle par la route, la durée et le
          coût complet de la tournée.
        </p>
      ) : (
        <>
          <div className="row" style={{ gap: 16 }}>
            <div>
              <div className="stat__label">Distance</div>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {km(c.distanceKm)}
              </div>
            </div>
            <div>
              <div className="stat__label">Durée totale</div>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {duration(c.durationMin + c.serviceMin)}
              </div>
            </div>
          </div>

          <dl className="costgrid">
            <dt>
              {isElectric ? 'Électricité' : 'Carburant'} ({num(c.fuelLiters, isElectric ? 'kWh' : 'L')})
            </dt>
            <dd>{euro(c.fuelCost)}</dd>

            <dt>Usure véhicule</dt>
            <dd>{euro(c.maintenanceCost)}</dd>

            {c.driverCost > 0 && (
              <>
                <dt>Temps chauffeur</dt>
                <dd>{euro(c.driverCost)}</dd>
              </>
            )}

            <dt>Péages</dt>
            <dd>
              <div style={{ width: 92, marginLeft: 'auto' }}>
                <NumberInput value={route.tollCost} onValueChange={onTollChange} step={0.5} suffix="€" />
              </div>
            </dd>

            <dt className="total">Coût total</dt>
            <dd className="total">{euro(c.totalCost)}</dd>
          </dl>

          <div className="row row--between tiny muted">
            <span>Coût par arrêt</span>
            <span>{euro(c.costPerStop)}</span>
          </div>

          <div className="tiny muted" style={{ lineHeight: 1.5 }}>
            {isElectric ? 'Prix du kWh' : 'Prix du litre'} : <strong>{euro(c.fuelPricePerLiter)}</strong>
            {settings?.fuelPriceUpdatedAt && (
              <> · relevé le {new Date(settings.fuelPriceUpdatedAt).toLocaleDateString('fr-FR')}</>
            )}
            <br />
            Consommation : {num(vehicle?.consumption)} {isElectric ? 'kWh' : 'L'}/100 km
            <br />
            {c.engine === 'osrm' ? (
              <>Distances routières réelles</>
            ) : (
              <span style={{ color: 'var(--orange)' }}>Distances estimées (service d’itinéraires injoignable)</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function OptimizationResult({ result }: { result: OptimizeResult }) {
  const gained = result.savedKm > 0.1;
  return (
    <Card title="Résultat de l’optimisation">
      <div className="col" style={{ gap: 10 }}>
        <div className="costgrid" style={{ display: 'grid' }}>
          <dt>Avant</dt>
          <dd>
            {km(result.before.distanceKm)} · {duration(result.before.durationMin)}
          </dd>
          <dt>Après</dt>
          <dd style={{ fontWeight: 600 }}>
            {km(result.after.distanceKm)} · {duration(result.after.durationMin)}
          </dd>
        </div>
        {gained ? (
          <div className="infobox" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>
            <strong>{km(result.savedKm)}</strong> et <strong>{duration(result.savedMin)}</strong> économisés
            sur cette tournée.
          </div>
        ) : (
          <div className="infobox">L’ordre actuel est déjà le plus court possible.</div>
        )}
        {result.pinnedRespected > 0 && (
          <div className="tiny muted">
            {result.pinnedRespected} arrêt(s) épinglé(s) maintenu(s) à leur position.
          </div>
        )}
      </div>
    </Card>
  );
}

/* ================================================================== */
/* Envoi sur le téléphone                                              */
/* ================================================================== */

function SendDialog({ result, onClose }: { result: RouteQr; onClose: () => void }) {
  const toast = useToast();
  const [index, setIndex] = useState(0);
  const segment = result.segments[index] ?? result.segments[0];
  const copyRef = useRef<HTMLDivElement>(null);

  const providerName =
    result.provider === 'waze' ? 'Waze' : result.provider === 'apple' ? 'Plans' : 'Google Maps';

  return (
    <Modal
      open
      wide
      title={`Envoyer l’itinéraire vers ${providerName}`}
      subtitle="Scannez le QR code avec l’appareil photo de votre téléphone"
      onClose={onClose}
      footer={
        <>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(segment.url);
                toast.push({ tone: 'success', title: 'Lien copié' });
              } catch {
                // Le presse-papiers peut être refusé : le lien reste sélectionnable à l'écran.
                const range = document.createRange();
                if (copyRef.current) {
                  range.selectNodeContents(copyRef.current);
                  const selection = window.getSelection();
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                }
                toast.push({ tone: 'warn', title: 'Copie automatique refusée', text: 'Le lien est sélectionné : utilisez Ctrl+C.' });
              }
            }}
          >
            Copier le lien
          </Button>
          <Button
            icon={<Icons.link size={14} />}
            onClick={() => window.api.app.openExternal(segment.url)}
          >
            Ouvrir sur cet ordinateur
          </Button>
          <div className="spacer" />
          <Button variant="primary" onClick={onClose}>
            Terminé
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {result.warning && <div className="warnbox">{result.warning}</div>}

        {result.segments.length > 1 && (
          <div className="row row--wrap">
            {result.segments.map((s, i) => (
              <Button key={i} size="sm" variant={i === index ? 'primary' : 'default'} onClick={() => setIndex(i)}>
                Étape {i + 1}
              </Button>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
          <img className="qr" src={segment.qrDataUrl} alt="QR code de l’itinéraire" />
          <div className="col" style={{ gap: 10, flex: 1, minWidth: 0 }}>
            <div>
              <div className="field__label">Trajet</div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                {segment.from} → {segment.to}
              </div>
              <div className="tiny muted">
                {segment.stops} point{segment.stops > 1 ? 's' : ''} dans ce lien
              </div>
            </div>
            <div>
              <div className="field__label">Lien de navigation</div>
              <div className="linkbox" ref={copyRef}>
                {segment.url}
              </div>
            </div>
            <div className="tiny muted" style={{ lineHeight: 1.55 }}>
              <Icons.phone size={12} /> Ouvrez l’appareil photo de votre téléphone et visez le QR
              code : l’itinéraire complet s’ouvre directement dans {providerName}.
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
