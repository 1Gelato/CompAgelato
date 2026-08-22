import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DeliveryRoute, RouteStop } from '@shared/types';
import { dateFr } from '@shared/format';
import { api, isOffline } from '../lib/runtime';
import {
  errorMessage,
  hasRight,
  refreshAll,
  useClientIndex,
  useClients,
  useRefresh,
  useRoutes,
  useSettings,
  useVehicles,
} from '../lib/data';
import { newRecordId } from '../core/offline';
import { call, openNavigation } from '../lib/nav';
import {
  Badge,
  Button,
  Chips,
  EmptyState,
  Field,
  Icon,
  Input,
  ListItem,
  Loading,
  Muted,
  ProgressBar,
  SearchBar,
  Sheet,
  SheetAction,
  useToast,
  type IconName,
} from '../components/ui';
import { colors, font, radius, spacing, toneColors, touch } from '../theme';

/** Le fournisseur de navigation, nommé comme l'utilisateur le connaît. */
const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google Maps',
  waze: 'Waze',
  apple: 'Plans',
};

export type RoutesStackParams = {
  RoutesList: undefined;
  RouteDetail: { routeId: string };
  RouteAddStop: { routeId: string };
  RouteBon: { clientId?: string; clientName?: string; routeId?: string };
  ClientSheet: { clientId: string };
};

/* ------------------------------------------------------------------ */
/* Liste des tournées                                                  */
/* ------------------------------------------------------------------ */

export function RoutesListScreen({
  navigation,
}: NativeStackScreenProps<RoutesStackParams, 'RoutesList'>) {
  const { data: routes, loading } = useRoutes();
  const { data: settings } = useSettings();
  // Même geste que partout ailleurs : resynchroniser puis recharger. Le
  // rafraîchissement local d'origine ne faisait que relire la copie locale.
  const { refreshing, onRefresh } = useRefresh();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  const progress = (route: DeliveryRoute) => {
    const done = route.stops.filter((s) => s.doneAt).length;
    return route.stops.length ? `${done}/${route.stops.length} livrés` : 'aucun arrêt';
  };

  /**
   * La tournée naît ici comme sur le bureau : départ au dépôt, véhicule par
   * défaut, aucun arrêt — ils s'ajoutent ensuite. Hors ligne, la création
   * part en file comme n'importe quel geste de tournée.
   */
  const create = async () => {
    const today = new Date().toISOString().slice(0, 10);
    setCreating(true);
    try {
      const route = await api.routes.save({
        name: `Tournée du ${dateFr(today)}`,
        date: today,
        vehicleId: settings?.defaultVehicleId,
        start: {
          id: newRecordId('stp'),
          label: 'Dépôt',
          address: settings?.depot ?? { label: '', country: 'France' },
          pinned: false,
          serviceMinutes: 0,
        },
        stops: [],
        returnToStart: true,
        end: null,
        tollCost: 0,
      });
      refreshAll();
      navigation.navigate('RouteDetail', { routeId: route.id });
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Création impossible', text: errorMessage(err) });
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {hasRight('routes:save') && (
        <View style={{ padding: spacing.md }}>
          <Button title="Nouvelle tournée" icon="add" variant="primary" onPress={create} busy={creating} />
        </View>
      )}
      <FlatList
        data={routes}
        keyExtractor={(route) => route.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        // Le chargement vit dans la zone de liste : le bouton de création ne
        // disparaît plus le temps d'une synchronisation.
        ListEmptyComponent={
          loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon="navigate-outline"
              title="Aucune tournée"
              text="Créez-en une ici ou depuis l’ordinateur : elle se suit ensuite sur la route."
            />
          )
        }
        renderItem={({ item: route }) => {
          const done = route.stops.filter((s) => s.doneAt).length;
          const finished = route.stops.length > 0 && done === route.stops.length;
          return (
            <ListItem
              title={route.name}
              subtitle={`${dateFr(route.date)} · ${route.stops.length} arrêt(s)${
                route.computation ? ` · ${Math.round(route.computation.distanceKm)} km` : ''
              }`}
              right={
                <Badge tone={finished ? 'success' : done > 0 ? 'info' : 'default'}>
                  {progress(route)}
                </Badge>
              }
              chevron
              onPress={() => navigation.navigate('RouteDetail', { routeId: route.id })}
            />
          );
        }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Détail d'une tournée                                                */
/* ------------------------------------------------------------------ */

/** « 21/08/2026 » ou « 2026-08-21 » → ISO. Chaîne vide si illisible. */
function parseDay(raw: string): string {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

export function RouteDetailScreen({
  route: navRoute,
  navigation,
}: NativeStackScreenProps<RoutesStackParams, 'RouteDetail'>) {
  const { routeId } = navRoute.params;
  const { data: routes, loading } = useRoutes();
  const { data: clients } = useClients();
  const { data: settings } = useSettings();
  const { data: vehicles } = useVehicles();
  const clientIndex = useClientIndex(clients);
  const toast = useToast();
  const [selected, setSelected] = useState<RouteStop | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * Le verrou du pointage rapide. `markDone` envoie **toute la tournée** à
   * `routes:save` : deux taps rapides sur deux arrêts feraient deux envois
   * concurrents, et le second écraserait le `doneAt` du premier — une
   * livraison perdue, précisément dans le geste que ce bouton accélère.
   * Pendant un envoi, le rond tapé montre un sablier et les autres sont
   * inertes ; Hervé pointe un arrêt à la fois, c'est ce qu'il attend.
   */
  const [busyStopId, setBusyStopId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDate, setDraftDate] = useState('');

  const tour = useMemo(() => routes.find((r) => r.id === routeId), [routes, routeId]);
  const editable = hasRight('routes:save');

  if (loading) return <Loading />;
  if (!tour) return <EmptyState title="Tournée introuvable" />;

  const done = tour.stops.filter((s) => s.doneAt).length;
  const provider = settings?.mapProvider ?? 'google';

  /** Toute modification passe par là : `routes:save`, donc la file hors-ligne. */
  const saveTour = async (next: Partial<DeliveryRoute>) => {
    if (busyStopId) return; // un pointage rapide est en route : pas d'envoi concurrent
    setSaving(true);
    try {
      await api.routes.save({ ...tour, ...next });
      refreshAll();
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setSaving(false);
      setSelected(null);
    }
  };

  const markDone = (stop: RouteStop, isDone: boolean) =>
    saveTour({
      stops: tour.stops.map((s) =>
        s.id === stop.id ? { ...s, doneAt: isDone ? new Date().toISOString() : undefined } : s,
      ),
    });

  /**
   * Le pointage depuis la rangée : livrer en deux gestes au lieu de trois.
   * Le dé-pointage, lui, reste dans la feuille — un « livré » accidentel
   * (soleil, gant) se voit au badge d'heure et se répare en trois secondes,
   * alors qu'un second chemin d'écriture rouvrirait la course.
   */
  const quickDone = async (stop: RouteStop) => {
    if (busyStopId || saving) return;
    setBusyStopId(stop.id);
    try {
      const doneAt = new Date().toISOString();
      await api.routes.save({
        ...tour,
        stops: tour.stops.map((s) => (s.id === stop.id ? { ...s, doneAt } : s)),
      });
      refreshAll();
      toast.push({
        tone: 'success',
        title: `Livré à ${new Date(doneAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
        text: stop.label || 'Arrêt',
      });
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Pointage impossible', text: errorMessage(err) });
    } finally {
      setBusyStopId(null);
    }
  };

  /** Même règle que le bureau : un arrêt déplacé épinglé retient sa place. */
  const moveStop = (stop: RouteStop, delta: number) => {
    const from = tour.stops.findIndex((s) => s.id === stop.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= tour.stops.length) return;
    const next = [...tour.stops];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return saveTour({
      stops: next.map((s, index) => ({ ...s, pinnedIndex: s.pinned ? index : undefined })),
    });
  };

  const togglePin = (stop: RouteStop) =>
    saveTour({
      stops: tour.stops.map((s, index) =>
        s.id === stop.id
          ? { ...s, pinned: !s.pinned, pinnedIndex: !s.pinned ? index : undefined }
          : s,
      ),
    });

  const removeStop = (stop: RouteStop) =>
    saveTour({ stops: tour.stops.filter((s) => s.id !== stop.id) });

  /**
   * L'optimisation réordonne les arrêts et calcule le coût réel — elle vit sur
   * le serveur (distances routières, prix du carburant) : sans réseau, elle
   * attend, mais les ajouts et pointages, eux, partent en file.
   */
  const optimize = async (keepOrder: boolean) => {
    if (isOffline()) {
      toast.push({
        tone: 'warn',
        title: 'Serveur requis',
        text: 'L’optimisation se calcule sur le serveur. Vos autres gestes sont conservés.',
      });
      return;
    }
    setOptimizing(true);
    try {
      const outcome = keepOrder
        ? await api.routes.compute(tour)
        : await api.routes.optimize(tour);
      refreshAll();
      const c = outcome.computation;
      toast.push({
        tone: 'success',
        title: keepOrder ? 'Itinéraire recalculé' : 'Tournée optimisée',
        text: `${Math.round(c.distanceKm)} km · ${Math.round(c.durationMin + c.serviceMin)} min · ${c.totalCost.toFixed(2)} €`,
      });
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Calcul impossible', text: errorMessage(err) });
    } finally {
      setOptimizing(false);
    }
  };

  const removeTour = async () => {
    try {
      await api.routes.remove(tour.id);
      refreshAll();
      navigation.goBack();
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Suppression impossible', text: errorMessage(err) });
    }
  };

  const client = selected?.clientId ? clientIndex.get(selected.clientId) : undefined;
  // En livraison, le portable joint plus sûrement que le fixe du magasin.
  const phone = client?.mobile?.trim() || client?.phone?.trim();

  /**
   * L'itinéraire de la **tournée entière**, ouvert dans l'application de
   * navigation du téléphone. Le lien est construit par le serveur
   * (`routes:link`, le même qui alimente le QR code du bureau).
   */
  const openWholeRoute = async () => {
    setLinking(true);
    try {
      const link = await api.routes.link(tour, provider);
      await Linking.openURL(link.url);
      if (link.segments.length > 1) {
        toast.push({
          tone: 'warn',
          title: `Tournée découpée en ${link.segments.length} liens`,
          text: link.warning ?? 'Ouvrez les tronçons l’un après l’autre depuis cet écran.',
        });
      }
    } catch (err) {
      toast.push({
        tone: 'danger',
        title: 'Itinéraire indisponible',
        text: isOffline()
          ? 'Le trajet complet se calcule sur le serveur. Sans réseau, utilisez « Naviguer » arrêt par arrêt.'
          : errorMessage(err),
      });
    } finally {
      setLinking(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{tour.name}</Text>
        <Muted>
          {dateFr(tour.date)}
          {tour.computation
            ? ` · ${Math.round(tour.computation.distanceKm)} km · ${Math.round(tour.computation.durationMin + tour.computation.serviceMin)} min`
            : ''}
        </Muted>
        {tour.stops.length > 0 && (
          <View style={{ marginTop: 6 }}>
            <ProgressBar
              ratio={done / tour.stops.length}
              leftLabel={`${done}/${tour.stops.length} livré${done > 1 ? 's' : ''}`}
              rightLabel={
                done === tour.stops.length
                  ? 'tournée terminée'
                  : `${tour.stops.length - done} restant${tour.stops.length - done > 1 ? 's' : ''}`
              }
            />
          </View>
        )}
        <View style={{ marginTop: spacing.sm, gap: 8 }}>
          {tour.stops.length > 0 && (
            <Button
              title={`Ouvrir l’itinéraire (${PROVIDER_LABEL[provider]})`}
              icon="navigate"
              variant="primary"
              onPress={openWholeRoute}
              busy={linking}
            />
          )}
          {editable && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <HeaderAction
                icon="add"
                label="Arrêt"
                onPress={() => navigation.navigate('RouteAddStop', { routeId: tour.id })}
              />
              <HeaderAction
                icon="flash"
                label="Optimiser"
                busy={optimizing}
                disabled={tour.stops.length < 2}
                onPress={() => void optimize(false)}
              />
              <HeaderAction
                icon="pencil"
                label="Modifier"
                onPress={() => {
                  setDraftName(tour.name);
                  setDraftDate(dateFr(tour.date));
                  setEditing(true);
                }}
              />
            </View>
          )}
          {tour.stops.length > 0 && (
            <Muted size={12}>
              Le rond coche un arrêt livré. Touchez la rangée pour naviguer, appeler, déplacer.
            </Muted>
          )}
        </View>
      </View>

      <FlatList
        data={tour.stops}
        keyExtractor={(stop) => stop.id}
        ListEmptyComponent={
          <EmptyState
            icon="location-outline"
            title="Aucun arrêt dans cette tournée"
            text={editable ? 'Ajoutez des clients avec « Arrêt », puis optimisez.' : undefined}
          />
        }
        renderItem={({ item: stop, index }) => (
          <ListItem
            leading={
              <View style={[styles.index, stop.doneAt ? styles.indexDone : null]}>
                {stop.doneAt ? (
                  <Icon name="checkmark" size={16} color="#fff" />
                ) : (
                  <Text style={styles.indexText}>{index + 1}</Text>
                )}
              </View>
            }
            title={
              stop.pinned ? (
                <>
                  <Icon name="pin" size={13} color={toneColors.info.fg} />{' '}
                  {stop.label || 'Arrêt sans nom'}
                </>
              ) : (
                stop.label || 'Arrêt sans nom'
              )
            }
            subtitle={`${stop.address.label || 'Adresse non renseignée'}${
              stop.notes ? `\n${stop.notes}` : ''
            }`}
            right={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                {stop.doneAt ? (
                  <Badge tone="success">
                    {new Date(stop.doneAt).toLocaleTimeString('fr-FR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Badge>
                ) : stop.legDurationMin !== undefined ? (
                  <Muted size={12}>{Math.round(stop.legDurationMin)} min</Muted>
                ) : null}
                {stop.doneAt ? (
                  <View style={[styles.check, styles.checkDone]}>
                    <Icon name="checkmark" size={19} color="#fff" />
                  </View>
                ) : (
                  <Pressable
                    onPress={() => void quickDone(stop)}
                    disabled={busyStopId !== null}
                    accessibilityLabel={`Marquer ${stop.label || 'cet arrêt'} comme livré`}
                    style={({ pressed }) => [
                      styles.check,
                      busyStopId !== null && busyStopId !== stop.id && { opacity: 0.35 },
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    {busyStopId === stop.id ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <Icon name="checkmark" size={19} color={colors.accent} />
                    )}
                  </Pressable>
                )}
              </View>
            }
            onPress={() => setSelected(stop)}
          />
        )}
      />

      {/* La feuille d'un arrêt : naviguer, appeler, pointer, réordonner. */}
      <Sheet open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.label}>
        {selected && (
          <>
            <SheetAction
              icon="navigate"
              title="Naviguer vers cet arrêt"
              subtitle={selected.address.label}
              onPress={() => {
                openNavigation(selected, provider);
                setSelected(null);
              }}
            />
            {phone ? (
              <SheetAction
                icon="call"
                title={`Appeler ${client?.name ?? ''}`.trim()}
                subtitle={phone}
                onPress={() => {
                  call(phone);
                  setSelected(null);
                }}
              />
            ) : null}
            <SheetAction
              icon="document-text"
              title="Bon de livraison"
              subtitle="Articles livrés, signatures — le bureau le reçoit aussitôt"
              onPress={() => {
                const target = selected;
                setSelected(null);
                navigation.navigate('RouteBon', {
                  clientId: target.clientId,
                  clientName: target.label,
                  routeId: tour.id,
                });
              }}
            />
            {selected.doneAt ? (
              <SheetAction
                icon="arrow-undo"
                title="Annuler le pointage"
                subtitle={`Livré à ${new Date(selected.doneAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`}
                onPress={() => void markDone(selected, false)}
              />
            ) : (
              <SheetAction
                icon="checkmark"
                title="Marquer comme livré"
                tone="success"
                subtitle="Conservé même sans réseau, envoyé à la reconnexion."
                onPress={() => void markDone(selected, true)}
              />
            )}
            {editable && (
              <>
                <SheetAction
                  icon="pin"
                  title={selected.pinned ? 'Détacher (l’optimisation peut le déplacer)' : 'Épingler à cette position'}
                  onPress={() => void togglePin(selected)}
                />
                <SheetAction icon="arrow-up" title="Monter d’une place" onPress={() => void moveStop(selected, -1)} />
                <SheetAction icon="arrow-down" title="Descendre d’une place" onPress={() => void moveStop(selected, 1)} />
                <SheetAction
                  icon="trash"
                  title="Retirer de la tournée"
                  tone="danger"
                  onPress={() => void removeStop(selected)}
                />
              </>
            )}
            {saving && (
              <View style={{ paddingVertical: spacing.sm, alignItems: 'center' }}>
                <ActivityIndicator color={colors.accent} />
              </View>
            )}
          </>
        )}
      </Sheet>

      {/* Nom, date, véhicule — et les gestes rares : recalcul, suppression. */}
      <Sheet open={editing} onClose={() => setEditing(false)} title="Modifier la tournée">
        <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
          <Field label="Nom">
            <Input value={draftName} onChangeText={setDraftName} />
          </Field>
          <Field label="Date" hint="JJ/MM/AAAA">
            <Input value={draftDate} onChangeText={setDraftDate} keyboardType="numbers-and-punctuation" />
          </Field>
          {vehicles.length > 1 && (
            <Field label="Véhicule">
              <Chips
                options={vehicles.map((v) => ({ value: v.id, label: v.name }))}
                value={tour.vehicleId ?? vehicles[0]?.id ?? ''}
                onChange={(vehicleId) => void saveTour({ vehicleId })}
              />
            </Field>
          )}
          <Button
            title="Enregistrer"
            variant="primary"
            busy={saving}
            onPress={() => {
              const iso = draftDate.trim() ? parseDay(draftDate) : tour.date;
              if (!iso) {
                toast.push({ tone: 'warn', title: 'Date illisible', text: 'Écrivez-la JJ/MM/AAAA, par exemple 21/08/2026.' });
                return;
              }
              setEditing(false);
              void saveTour({ name: draftName.trim() || tour.name, date: iso });
            }}
          />
          <SheetAction
            icon="refresh"
            title="Recalculer l’itinéraire (sans changer l’ordre)"
            onPress={() => {
              setEditing(false);
              void optimize(true);
            }}
          />
          {hasRight('routes:remove') && (
            <SheetAction
              icon="trash"
              title="Supprimer la tournée"
              tone="danger"
              onPress={() => {
                setEditing(false);
                setConfirmDelete(true);
              }}
            />
          )}
        </View>
      </Sheet>

      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Supprimer cette tournée ?">
        <View style={{ gap: spacing.sm, paddingBottom: spacing.sm }}>
          <Muted>« {tour.name} » et sa feuille de route seront supprimées. Les fiches clients restent.</Muted>
          <Button title="Supprimer" variant="danger" onPress={() => void removeTour()} />
          <Button title="Annuler" onPress={() => setConfirmDelete(false)} />
        </View>
      </Sheet>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Ajout d'arrêts : les clients géolocalisés, cherchables               */
/* ------------------------------------------------------------------ */

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function RouteAddStopScreen({
  route: navRoute,
  navigation,
}: NativeStackScreenProps<RoutesStackParams, 'RouteAddStop'>) {
  const { routeId } = navRoute.params;
  const { data: routes } = useRoutes();
  const { data: clients, loading } = useClients();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const tour = useMemo(() => routes.find((r) => r.id === routeId), [routes, routeId]);

  // Comme sur le bureau : seuls les clients géolocalisés peuvent entrer dans
  // une tournée — sans position, pas d'itinéraire calculable.
  const candidates = useMemo(() => {
    const needle = normalize(query.trim());
    return clients
      .filter((c) => !c.archived && typeof c.address.lat === 'number')
      .filter((c) => !needle || normalize(`${c.name} ${c.address.city ?? ''} ${c.address.label}`).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [clients, query]);

  if (loading || !tour) return <Loading />;

  const inTour = new Set(tour.stops.map((s) => s.clientId).filter(Boolean));

  const add = async (clientId: string) => {
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;
    setBusyId(clientId);
    try {
      await api.routes.save({
        ...tour,
        stops: [
          ...tour.stops,
          {
            id: newRecordId('stp'),
            clientId: client.id,
            label: client.name,
            address: client.address,
            pinned: false,
            serviceMinutes: 0,
          },
        ],
      });
      refreshAll();
      toast.push({ tone: 'success', title: `${client.name} ajouté à la tournée` });
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Ajout impossible', text: errorMessage(err) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: spacing.md, gap: 6 }}>
        <SearchBar value={query} onChange={setQuery} placeholder="Nom, ville…" />
        <Muted size={12}>
          Seuls les clients géolocalisés apparaissent — le bouton « Géolocaliser » du bureau s’occupe des autres.
        </Muted>
      </View>
      <FlatList
        data={candidates}
        keyExtractor={(client) => client.id}
        ListEmptyComponent={
          <EmptyState icon="location-outline" title="Aucun client géolocalisé ne correspond" />
        }
        renderItem={({ item: client }) => {
          const already = inTour.has(client.id);
          return (
            <ListItem
              title={client.name}
              subtitle={client.address.label || client.address.city || client.code}
              right={
                already ? (
                  <Badge tone="success" icon="checkmark">
                    dans la tournée
                  </Badge>
                ) : busyId === client.id ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <View style={styles.addBubble}>
                    <Icon name="add" size={20} color={colors.accent} />
                  </View>
                )
              }
              onPress={already ? undefined : () => void add(client.id)}
            />
          );
        }}
      />
      <View style={{ padding: spacing.md }}>
        <Button title="Terminé" variant="primary" onPress={() => navigation.goBack()} />
      </View>
    </View>
  );
}

/**
 * Les trois gestes d'édition de l'en-tête : icône au-dessus du libellé, en
 * tiers de largeur. Trois `Button` côte à côte tronquaient leurs textes ;
 * ici chaque tuile respire, à hauteur tactile pleine.
 */
function HeaderAction({
  icon,
  label,
  onPress,
  busy,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.headerAction,
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.7 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={toneColors.info.fg} />
      ) : (
        <Icon name={icon} size={18} color={toneColors.info.fg} />
      )}
      <Text style={styles.headerActionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  headerTitle: { ...font.title, color: colors.text },
  headerAction: {
    flex: 1,
    minHeight: touch.minHeight,
    borderRadius: radius.md,
    backgroundColor: toneColors.info.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 6,
  },
  headerActionLabel: { fontSize: 11.5, fontWeight: '600', color: toneColors.info.fg },
  index: {
    width: 31,
    height: 31,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indexDone: { backgroundColor: colors.green },
  indexText: { color: toneColors.info.fg, fontWeight: '700', fontSize: 13.5 },
  /**
   * Le rond de pointage : 44 px de vraie géométrie — la cible se fait par la
   * taille, pas par un hitSlop qui ne s'étendrait pas hors du parent.
   */
  check: {
    width: touch.icon,
    height: touch.icon,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: 'rgba(0, 113, 227, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDone: { backgroundColor: colors.green, borderColor: colors.green },
  addBubble: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
