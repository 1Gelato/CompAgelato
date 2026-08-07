import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DeliveryRoute, RouteStop } from '@shared/types';
import { dateFr } from '@shared/format';
import { api } from '../lib/runtime';
import { errorMessage, refreshAll, useClientIndex, useClients, useRoutes, useSettings } from '../lib/data';
import { call, openNavigation } from '../lib/nav';
import {
  Badge,
  Button,
  EmptyState,
  ListItem,
  Loading,
  Muted,
  Sheet,
  SheetAction,
  useToast,
} from '../components/ui';
import { colors, spacing } from '../theme';

export type RoutesStackParams = {
  RoutesList: undefined;
  RouteDetail: { routeId: string };
  ClientSheet: { clientId: string };
};

/* ------------------------------------------------------------------ */
/* Liste des tournées                                                  */
/* ------------------------------------------------------------------ */

export function RoutesListScreen({
  navigation,
}: NativeStackScreenProps<RoutesStackParams, 'RoutesList'>) {
  const { data: routes, loading, reload } = useRoutes();
  const [refreshing, setRefreshing] = useState(false);

  if (loading) return <Loading />;

  const progress = (route: DeliveryRoute) => {
    const done = route.stops.filter((s) => s.doneAt).length;
    return route.stops.length ? `${done}/${route.stops.length} livrés` : 'aucun arrêt';
  };

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={routes}
      keyExtractor={(route) => route.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            reload();
            setTimeout(() => setRefreshing(false), 600);
          }}
        />
      }
      ListEmptyComponent={
        <EmptyState
          title="Aucune tournée"
          text="Les tournées se préparent depuis l’ordinateur, puis se suivent ici, sur la route."
        />
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
            onPress={() => navigation.navigate('RouteDetail', { routeId: route.id })}
          />
        );
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Détail d'une tournée                                                */
/* ------------------------------------------------------------------ */

export function RouteDetailScreen({
  route: navRoute,
}: NativeStackScreenProps<RoutesStackParams, 'RouteDetail'>) {
  const { routeId } = navRoute.params;
  const { data: routes, loading } = useRoutes();
  const { data: clients } = useClients();
  const { data: settings } = useSettings();
  const clientIndex = useClientIndex(clients);
  const toast = useToast();
  const [selected, setSelected] = useState<RouteStop | null>(null);
  const [saving, setSaving] = useState(false);

  const tour = useMemo(() => routes.find((r) => r.id === routeId), [routes, routeId]);

  if (loading) return <Loading />;
  if (!tour) return <EmptyState title="Tournée introuvable" />;

  const done = tour.stops.filter((s) => s.doneAt).length;
  const provider = settings?.mapProvider ?? 'google';

  /**
   * Le geste central de la tournée. Passe par `routes:save` — donc par la
   * file d'attente hors-ligne : en zone blanche, le pointage est conservé et
   * rejoué à la reconnexion.
   */
  const markDone = async (stop: RouteStop, isDone: boolean) => {
    setSaving(true);
    try {
      await api.routes.save({
        ...tour,
        stops: tour.stops.map((s) =>
          s.id === stop.id ? { ...s, doneAt: isDone ? new Date().toISOString() : undefined } : s,
        ),
      });
      refreshAll();
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setSaving(false);
      setSelected(null);
    }
  };

  const client = selected?.clientId ? clientIndex.get(selected.clientId) : undefined;
  const phone = client?.phone?.trim();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{tour.name}</Text>
        <Muted>
          {dateFr(tour.date)} · {done}/{tour.stops.length} livrés
          {tour.computation
            ? ` · ${Math.round(tour.computation.distanceKm)} km, ${Math.round(tour.computation.durationMin + tour.computation.serviceMin)} min`
            : ''}
        </Muted>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressBar,
              { width: `${tour.stops.length ? Math.round((done / tour.stops.length) * 100) : 0}%` },
            ]}
          />
        </View>
      </View>

      <FlatList
        data={tour.stops}
        keyExtractor={(stop) => stop.id}
        ListEmptyComponent={<EmptyState title="Aucun arrêt dans cette tournée" />}
        renderItem={({ item: stop, index }) => (
          <ListItem
            leading={
              <View style={[styles.index, stop.doneAt ? styles.indexDone : null]}>
                <Text style={{ color: stop.doneAt ? '#fff' : colors.secondary, fontWeight: '700', fontSize: 13 }}>
                  {stop.doneAt ? '✓' : index + 1}
                </Text>
              </View>
            }
            title={stop.label || 'Arrêt sans nom'}
            subtitle={`${stop.address.label || 'Adresse non renseignée'}${
              stop.notes ? `\n${stop.notes}` : ''
            }`}
            right={
              stop.doneAt ? (
                <Badge tone="success">
                  {new Date(stop.doneAt).toLocaleTimeString('fr-FR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Badge>
              ) : stop.legDurationMin !== undefined ? (
                <Muted size={12}>{Math.round(stop.legDurationMin)} min</Muted>
              ) : undefined
            }
            onPress={() => setSelected(stop)}
          />
        )}
      />

      <Sheet open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.label}>
        {selected && (
          <>
            <SheetAction
              title="🧭  Naviguer vers cet arrêt"
              subtitle={selected.address.label}
              onPress={() => {
                openNavigation(selected, provider);
                setSelected(null);
              }}
            />
            {phone ? (
              <SheetAction
                title={`📞  Appeler ${client?.name ?? ''}`}
                subtitle={phone}
                onPress={() => {
                  call(phone);
                  setSelected(null);
                }}
              />
            ) : null}
            {selected.doneAt ? (
              <SheetAction
                title="↩︎  Annuler le pointage"
                subtitle={`Livré à ${new Date(selected.doneAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`}
                onPress={() => void markDone(selected, false)}
              />
            ) : (
              <SheetAction
                title="✓  Marquer comme livré"
                tone="success"
                subtitle="Conservé même sans réseau, envoyé à la reconnexion."
                onPress={() => void markDone(selected, true)}
              />
            )}
            {saving && <Button title="" onPress={() => {}} busy />}
          </>
        )}
      </Sheet>
    </View>
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
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  progressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.07)',
    marginTop: 6,
    overflow: 'hidden',
  },
  progressBar: { height: '100%', backgroundColor: colors.green, borderRadius: 3 },
  index: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  indexDone: { backgroundColor: colors.green },
});
