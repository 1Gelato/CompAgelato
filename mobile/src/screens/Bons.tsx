import { useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DeliveryNote, RegisterItem } from '@shared/types';
import { dateFr } from '@shared/format';
import { api, isOffline } from '../lib/runtime';
import {
  errorMessage,
  hasRight,
  refreshAll,
  useClients,
  useDeliveryNotes,
  useRefresh,
} from '../lib/data';
import { loadMySignature, saveMySignature } from '../lib/signature';
import { SignaturePad, SignatureView, type Strokes } from '../components/SignaturePad';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  InfoRow,
  Input,
  ListItem,
  Loading,
  Muted,
  SearchBar,
  SectionTitle,
  useToast,
} from '../components/ui';
import { colors, spacing } from '../theme';

/**
 * Les bons de livraison — le bon papier signé sur le capot, numérisé.
 *
 * Hervé livre un client sans facture préparée : il note les articles, signe,
 * fait signer le client, et le bureau reçoit le bon dans la minute (bulle sur
 * le poste, notification sur les autres téléphones). La facture se fait
 * ensuite, tranquillement.
 */

export type BonsStackParams = {
  BonsList: undefined;
  BonDetail: { noteId: string };
  BonNouveau: { clientId?: string; clientName?: string; routeId?: string } | undefined;
};

const STATUS_LABEL: Record<DeliveryNote['status'], string> = {
  signed: 'À facturer',
  invoiced: 'Facturé',
};

/* ------------------------------------------------------------------ */
/* Liste                                                               */
/* ------------------------------------------------------------------ */

export function BonsListScreen({
  navigation,
}: NativeStackScreenProps<BonsStackParams, 'BonsList'>) {
  const { data: notes, loading } = useDeliveryNotes();
  const { data: clients } = useClients();
  const { refreshing, onRefresh } = useRefresh();

  const clientName = (note: DeliveryNote) =>
    (note.clientId && clients.find((c) => c.id === note.clientId)?.name) ||
    note.clientName ||
    'Client sans fiche';

  if (loading) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {hasRight('delivery:save') && (
        <View style={{ padding: spacing.md }}>
          <Button
            title="＋  Nouveau bon de livraison"
            variant="primary"
            onPress={() => navigation.navigate('BonNouveau', undefined)}
          />
        </View>
      )}
      <FlatList
        data={notes}
        keyExtractor={(note) => note.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <EmptyState
            title="Aucun bon de livraison"
            text="Depuis une tournée, touchez un arrêt puis « Bon de livraison » — ou créez-en un ici."
          />
        }
        renderItem={({ item: note }) => (
          <ListItem
            title={clientName(note)}
            subtitle={`${note.number} · ${dateFr(note.date)} · ${note.items.length} article(s)`}
            right={
              <Badge tone={note.status === 'invoiced' ? 'success' : 'warn'}>
                {STATUS_LABEL[note.status]}
              </Badge>
            }
            onPress={() => navigation.navigate('BonDetail', { noteId: note.id })}
          />
        )}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Détail                                                              */
/* ------------------------------------------------------------------ */

export function BonDetailScreen({
  route,
}: NativeStackScreenProps<BonsStackParams, 'BonDetail'>) {
  const { noteId } = route.params;
  const { data: notes, loading } = useDeliveryNotes();
  const { data: clients } = useClients();

  const note = useMemo(() => notes.find((n) => n.id === noteId), [notes, noteId]);

  if (loading) return <Loading />;
  if (!note) return <EmptyState title="Bon introuvable" />;

  const clientName =
    (note.clientId && clients.find((c) => c.id === note.clientId)?.name) ||
    note.clientName ||
    'Client sans fiche';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}
    >
      <Card>
        <SectionTitle>{note.number}</SectionTitle>
        <InfoRow label="Client" value={clientName} />
        <InfoRow label="Date" value={dateFr(note.date)} />
        <InfoRow label="Statut" value={STATUS_LABEL[note.status]} />
        {note.createdByName ? <InfoRow label="Établi par" value={note.createdByName} /> : null}
        {note.notes ? <InfoRow label="Notes" value={note.notes} /> : null}
      </Card>

      <Card>
        <SectionTitle>Articles livrés</SectionTitle>
        {note.items.length === 0 && <Muted>Aucun article détaillé.</Muted>}
        {note.items.map((item, index) => (
          <View
            key={index}
            style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}
          >
            <Text style={{ color: colors.text, fontSize: 14, flexShrink: 1 }}>{item.label}</Text>
            <Text style={{ color: colors.secondary, fontSize: 14 }}>× {item.qty}</Text>
          </View>
        ))}
      </Card>

      {note.driverSignature && (
        <Card>
          <SectionTitle>Signature du livreur{note.driverSignature.name ? ` — ${note.driverSignature.name}` : ''}</SectionTitle>
          <SignatureView strokes={note.driverSignature.strokes} />
        </Card>
      )}
      {note.clientSignature && (
        <Card>
          <SectionTitle>Signature du client{note.clientSignature.name ? ` — ${note.clientSignature.name}` : ''}</SectionTitle>
          <SignatureView strokes={note.clientSignature.strokes} />
        </Card>
      )}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Nouveau bon                                                         */
/* ------------------------------------------------------------------ */

interface DraftItem {
  label: string;
  qty: string;
}

/**
 * Le formulaire est volontairement indépendant du navigateur qui l'héberge :
 * il s'ouvre depuis l'onglet Bons comme depuis un arrêt de tournée (client et
 * tournée alors pré-remplis).
 */
export function BonNouveauScreen({
  route,
  navigation,
}: {
  route: { params?: { clientId?: string; clientName?: string; routeId?: string } };
  navigation: { goBack: () => void };
}) {
  const params = route.params ?? {};
  const { data: clients } = useClients();
  const toast = useToast();

  const [clientId, setClientId] = useState<string | undefined>(params.clientId);
  const [clientName, setClientName] = useState(params.clientName ?? '');
  const [clientQuery, setClientQuery] = useState('');
  const [pickingClient, setPickingClient] = useState(!params.clientId && !params.clientName);
  const [items, setItems] = useState<DraftItem[]>([{ label: '', qty: '1' }]);
  const [notes, setNotes] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverStrokes, setDriverStrokes] = useState<Strokes>([]);
  const [savedSignature, setSavedSignature] = useState<Strokes | null>(null);
  const [clientSigName, setClientSigName] = useState('');
  const [clientStrokes, setClientStrokes] = useState<Strokes>([]);
  const [saving, setSaving] = useState(false);

  // Le nom du livreur et sa signature enregistrée se proposent d'eux-mêmes.
  useEffect(() => {
    api.auth
      .me()
      .then((identity) => {
        if (identity) setDriverName((current) => current || identity.displayName);
      })
      .catch(() => {});
    void loadMySignature().then(setSavedSignature);
  }, []);

  const selectedClient = clientId ? clients.find((c) => c.id === clientId) : undefined;
  const displayedClient = selectedClient?.name ?? clientName;

  const filteredClients = useMemo(() => {
    const needle = clientQuery.trim().toLowerCase();
    return clients
      .filter((c) => !c.archived)
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .slice(0, 30);
  }, [clients, clientQuery]);

  const setItem = (index: number, patch: Partial<DraftItem>) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const validItems: RegisterItem[] = items
    .filter((item) => item.label.trim())
    .map((item) => ({ label: item.label.trim(), qty: Math.max(1, Number(item.qty) || 1) }));

  const ready =
    Boolean(displayedClient.trim()) &&
    validItems.length > 0 &&
    driverStrokes.length > 0 &&
    clientStrokes.length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const now = new Date().toISOString();
      await api.delivery.save({
        date: now.slice(0, 10),
        clientId,
        clientName: selectedClient ? undefined : clientName.trim() || undefined,
        items: validItems,
        notes: notes.trim() || undefined,
        routeId: params.routeId,
        driverSignature: { strokes: driverStrokes, name: driverName.trim() || undefined, at: now },
        clientSignature: {
          strokes: clientStrokes,
          name: clientSigName.trim() || undefined,
          at: now,
        },
      });
      // « Enregistrer sa signature par la même occasion » : le prochain bon
      // la proposera d'un geste.
      void saveMySignature(driverStrokes);
      refreshAll();
      toast.push({
        tone: 'success',
        title: 'Bon de livraison enregistré',
        text: isOffline()
          ? 'Conservé sur le téléphone — il partira au bureau à la reconnexion.'
          : 'Le bureau est prévenu.',
      });
      navigation.goBack();
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Enregistrement impossible', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}
      keyboardShouldPersistTaps="handled"
    >
      <Card>
        <SectionTitle>Client</SectionTitle>
        {pickingClient ? (
          <View style={{ gap: 8 }}>
            <SearchBar value={clientQuery} onChange={setClientQuery} placeholder="Chercher une fiche…" />
            <View style={{ maxHeight: 260 }}>
              <ScrollView nestedScrollEnabled>
                {filteredClients.map((client) => (
                  <ListItem
                    key={client.id}
                    title={client.name}
                    subtitle={client.address.city ?? client.code}
                    onPress={() => {
                      setClientId(client.id);
                      setPickingClient(false);
                    }}
                  />
                ))}
              </ScrollView>
            </View>
            <Field label="Ou un nom, sans fiche">
              <Input
                value={clientName}
                onChangeText={setClientName}
                placeholder="Nom noté à la volée"
                onSubmitEditing={() => clientName.trim() && setPickingClient(false)}
              />
            </Field>
            {clientName.trim() ? (
              <Button title="Garder ce nom" onPress={() => setPickingClient(false)} />
            ) : null}
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: colors.text }}>
              {displayedClient || '—'}
            </Text>
            <Text
              style={{ color: colors.accent, fontWeight: '600' }}
              onPress={() => {
                setClientId(undefined);
                setPickingClient(true);
              }}
            >
              Changer
            </Text>
          </View>
        )}
      </Card>

      <Card>
        <SectionTitle>Articles livrés</SectionTitle>
        {items.map((item, index) => (
          <View key={index} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Input
                value={item.label}
                onChangeText={(label) => setItem(index, { label })}
                placeholder="Article (ex. bac vanille 5 L)"
              />
            </View>
            <View style={{ width: 64 }}>
              <Input
                value={item.qty}
                onChangeText={(qty) => setItem(index, { qty })}
                keyboardType="number-pad"
                placeholder="Qté"
              />
            </View>
            {items.length > 1 && (
              <Text
                style={{ color: colors.red, fontSize: 18, paddingHorizontal: 2 }}
                onPress={() => setItems((current) => current.filter((_, i) => i !== index))}
              >
                ✕
              </Text>
            )}
          </View>
        ))}
        <Button
          title="＋ Ajouter un article"
          onPress={() => setItems((current) => [...current, { label: '', qty: '1' }])}
        />
      </Card>

      <Card>
        <SectionTitle>Notes</SectionTitle>
        <Input
          value={notes}
          onChangeText={setNotes}
          placeholder="Remarques, références…"
          multiline
          style={{ minHeight: 60, textAlignVertical: 'top' }}
        />
      </Card>

      <Card>
        <SectionTitle>Signature du livreur</SectionTitle>
        <Input value={driverName} onChangeText={setDriverName} placeholder="Nom du livreur" />
        <SignaturePad strokes={driverStrokes} onChange={setDriverStrokes} height={140} />
        {savedSignature && driverStrokes.length === 0 && (
          <Button
            title="Réutiliser ma signature enregistrée"
            onPress={() => setDriverStrokes(savedSignature)}
          />
        )}
      </Card>

      <Card>
        <SectionTitle>Signature du client</SectionTitle>
        <Input
          value={clientSigName}
          onChangeText={setClientSigName}
          placeholder="Nom du signataire (facultatif)"
        />
        <SignaturePad strokes={clientStrokes} onChange={setClientStrokes} height={170} />
        <Muted size={12}>Tendez le téléphone au client pour qu’il signe.</Muted>
      </Card>

      <Button
        title="Enregistrer le bon"
        variant="primary"
        onPress={() => void save()}
        busy={saving}
        disabled={!ready}
      />
      {!ready && (
        <Muted size={12}>
          Il faut un client, au moins un article, et les deux signatures.
        </Muted>
      )}
      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}
