import { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  useSettings,
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

/** Montant HT du bon : ce que valent les lignes qui portent un prix. */
function noteTotal(note: DeliveryNote): number {
  return note.items.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.qty, 0);
}

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
            <Text style={{ color: colors.secondary, fontSize: 14 }}>
              × {item.qty}
              {item.unitPrice != null ? `   ${(item.unitPrice * item.qty).toFixed(2)} €` : ''}
            </Text>
          </View>
        ))}
        {noteTotal(note) > 0 && (
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              borderTopWidth: 1,
              borderTopColor: colors.separator,
              paddingTop: 6,
            }}
          >
            <Text style={{ fontWeight: '700', color: colors.text }}>Total HT</Text>
            <Text style={{ fontWeight: '700', color: colors.text }}>
              {noteTotal(note).toFixed(2)} €
            </Text>
          </View>
        )}
        <Muted size={12}>
          {note.showPrices
            ? 'Les prix figuraient sur le bon signé par le client.'
            : 'Les prix n’ont pas été montrés au client.'}
        </Muted>
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
  /** Prix unitaire HT, saisi au clavier — vide quand la ligne n'est pas chiffrée. */
  price: string;
}

function lineTotal(item: DraftItem): number {
  return (Number(item.price.replace(',', '.')) || 0) * (Number(item.qty) || 0);
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
  const [items, setItems] = useState<DraftItem[]>([{ label: '', qty: '1', price: '' }]);
  const [showPrices, setShowPrices] = useState(false);
  const [notes, setNotes] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverStrokes, setDriverStrokes] = useState<Strokes>([]);
  const [savedSignature, setSavedSignature] = useState<Strokes | null>(null);
  const [clientSigName, setClientSigName] = useState('');
  const [clientStrokes, setClientStrokes] = useState<Strokes>([]);
  const [signing, setSigning] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: settings } = useSettings();

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

  // L'habitude de la maison, réglée au bureau — modifiable ici, bon par bon.
  useEffect(() => {
    if (settings) setShowPrices(settings.deliveryNotePrices ?? false);
  }, [settings]);

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
    .map((item) => {
      const price = Number(item.price.replace(',', '.'));
      return {
        label: item.label.trim(),
        qty: Math.max(1, Number(item.qty) || 1),
        ...(Number.isFinite(price) && price > 0 ? { unitPrice: Math.round(price * 100) / 100 } : {}),
      };
    });

  const total = items.reduce((sum, item) => sum + lineTotal(item), 0);

  /** De quoi tendre le téléphone : un client, des articles, ma signature. */
  const readyToSign =
    Boolean(displayedClient.trim()) && validItems.length > 0 && driverStrokes.length > 0;
  const ready = readyToSign && clientStrokes.length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const now = new Date().toISOString();
      await api.delivery.save({
        date: now.slice(0, 10),
        clientId,
        clientName: selectedClient ? undefined : clientName.trim() || undefined,
        items: validItems,
        showPrices,
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
          <View key={index} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
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
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ width: 110 }}>
                <Input
                  value={item.price}
                  onChangeText={(price) => setItem(index, { price })}
                  keyboardType="decimal-pad"
                  placeholder="P.U. HT €"
                />
              </View>
              {lineTotal(item) > 0 && <Muted size={12}>= {lineTotal(item).toFixed(2)} €</Muted>}
            </View>
          </View>
        ))}
        <Button
          title="＋ Ajouter un article"
          onPress={() => setItems((current) => [...current, { label: '', qty: '1', price: '' }])}
        />
        {total > 0 && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Muted size={13}>Total</Muted>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
              {total.toFixed(2)} € HT
            </Text>
          </View>
        )}
      </Card>

      {/*
        Le choix se fait ICI, avant de tendre le téléphone : l'écran de
        signature qui suit ne montre aucun réglage, seulement ce que le client
        doit lire. Décochée, la case laisse le montant visible au bureau —
        c'est le bon remis au client qui n'en porte pas.
      */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
              Montrer les prix au client
            </Text>
            <Muted size={12}>
              {showPrices
                ? 'Le client verra le détail et le total en signant.'
                : 'Le client ne verra que les quantités. Le bureau garde le montant.'}
            </Muted>
          </View>
          <Switch value={showPrices} onValueChange={setShowPrices} />
        </View>
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

      {/*
        La signature du client se prend dans un écran à part. C'est le moment
        où le téléphone change de mains : il ne doit rien y avoir d'autre à
        l'écran que ce que le client doit lire et l'endroit où signer.
      */}
      <Card>
        <SectionTitle>Signature du client</SectionTitle>
        {clientStrokes.length > 0 ? (
          <>
            <SignatureView strokes={clientStrokes} height={90} />
            <Muted size={12}>
              Signé{clientSigName.trim() ? ` par ${clientSigName.trim()}` : ''}.
            </Muted>
            <Button title="Refaire signer" onPress={() => setSigning(true)} />
          </>
        ) : (
          <>
            <Muted size={12}>
              Vérifiez les articles, puis tendez le téléphone au client.
            </Muted>
            <Button
              title="✍️  Faire signer le client"
              variant="primary"
              onPress={() => setSigning(true)}
              disabled={!readyToSign}
            />
            {!readyToSign && (
              <Muted size={12}>
                Il faut d’abord un client, au moins un article, et votre signature.
              </Muted>
            )}
          </>
        )}
      </Card>

      <ClientSignatureScreen
        open={signing}
        clientName={displayedClient}
        items={items}
        showPrices={showPrices}
        total={total}
        signerName={clientSigName}
        onSignerName={setClientSigName}
        onCancel={() => setSigning(false)}
        onDone={(strokes) => {
          setClientStrokes(strokes);
          setSigning(false);
        }}
      />

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

/* ------------------------------------------------------------------ */
/* L'écran tendu au client                                             */
/* ------------------------------------------------------------------ */

/**
 * Le moment où le téléphone change de mains.
 *
 * Rien d'autre à l'écran que ce que le client doit lire — ce qu'il reçoit,
 * le montant s'il a été décidé de le montrer — et l'endroit où signer. Aucun
 * réglage, aucune case à cocher : ces choix-là se prennent avant, dans le
 * formulaire du livreur. Le bouton « Annuler » rend la main sans rien signer.
 */
function ClientSignatureScreen({
  open,
  clientName,
  items,
  showPrices,
  total,
  signerName,
  onSignerName,
  onCancel,
  onDone,
}: {
  open: boolean;
  clientName: string;
  items: DraftItem[];
  showPrices: boolean;
  total: number;
  signerName: string;
  onSignerName: (name: string) => void;
  onCancel: () => void;
  onDone: (strokes: Strokes) => void;
}) {
  const [strokes, setStrokes] = useState<Strokes>([]);
  const insets = useSafeAreaInsets();

  // Chaque passation repart d'une ardoise vierge.
  useEffect(() => {
    if (open) setStrokes([]);
  }, [open]);

  const listed = items.filter((item) => item.label.trim());

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          paddingTop: insets.top + spacing.md,
          paddingBottom: insets.bottom + spacing.md,
          paddingHorizontal: spacing.md,
          gap: spacing.md,
        }}
      >
        <View>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            Bon de livraison
          </Text>
          <Muted size={13}>{clientName}</Muted>
        </View>

        <Card style={{ maxHeight: 230 }}>
          <ScrollView>
            {listed.map((item, index) => (
              <View
                key={index}
                style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 3 }}
              >
                <Text style={{ color: colors.text, fontSize: 14.5, flexShrink: 1 }}>
                  {item.label}
                </Text>
                <Text style={{ color: colors.secondary, fontSize: 14.5 }}>
                  × {item.qty}
                  {showPrices && lineTotal(item) > 0 ? `   ${lineTotal(item).toFixed(2)} €` : ''}
                </Text>
              </View>
            ))}
          </ScrollView>
          {showPrices && total > 0 && (
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                borderTopWidth: 1,
                borderTopColor: colors.separator,
                paddingTop: 6,
              }}
            >
              <Text style={{ fontWeight: '700', color: colors.text }}>Total HT</Text>
              <Text style={{ fontWeight: '700', color: colors.text }}>{total.toFixed(2)} €</Text>
            </View>
          )}
        </Card>

        <Input
          value={signerName}
          onChangeText={onSignerName}
          placeholder="Votre nom (facultatif)"
        />

        <View style={{ flex: 1 }}>
          <SignaturePad strokes={strokes} onChange={setStrokes} height={200} />
        </View>

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Button title="Annuler" onPress={onCancel} />
          </View>
          <View style={{ flex: 2 }}>
            <Button
              title="Valider la signature"
              variant="primary"
              onPress={() => onDone(strokes)}
              disabled={strokes.length === 0}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
