import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Client } from '@shared/types';
import { dateFr, euro, num } from '@shared/format';
import { clientOrderHistory } from '@shared/orders';
import {
  useClients,
  useDeliveryNotes,
  useDocuments,
  useProducts,
  useRefresh,
  useSettings,
} from '../lib/data';
import { call, openMailto, openNavigation } from '../lib/nav';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  InfoRow,
  ListItem,
  Loading,
  Muted,
  SearchBar,
  SheetAction,
  SectionTitle,
} from '../components/ui';
import { colors, spacing } from '../theme';

export type ClientsStackParams = {
  ClientsList: undefined;
  ClientDetail: { clientId: string };
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function ClientsListScreen({
  navigation,
}: NativeStackScreenProps<ClientsStackParams, 'ClientsList'>) {
  const { data: clients, loading } = useClients();
  const { refreshing, onRefresh } = useRefresh();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    const active = clients.filter((c) => !c.archived);
    if (!needle) return active;
    return active.filter((c) =>
      normalize(`${c.name} ${c.code} ${c.address.city ?? ''} ${c.address.label}`).includes(needle),
    );
  }, [clients, query]);

  if (loading) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: spacing.md }}>
        <SearchBar value={query} onChange={setQuery} placeholder="Nom, ville, code…" />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(client) => client.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<EmptyState title="Aucun client ne correspond" />}
        renderItem={({ item: client }) => (
          <ListItem
            title={client.name}
            subtitle={client.address.label || client.address.city || client.code}
            right={client.phone || client.mobile ? <Muted size={12}>📞</Muted> : undefined}
            onPress={() => navigation.navigate('ClientDetail', { clientId: client.id })}
          />
        )}
      />
    </View>
  );
}

export function ClientDetailScreen({
  route,
}: NativeStackScreenProps<ClientsStackParams, 'ClientDetail'>) {
  const { clientId } = route.params;
  const { data: clients, loading } = useClients();
  const { data: documents } = useDocuments();
  const { data: deliveryNotes } = useDeliveryNotes();
  const { data: products } = useProducts();
  const { data: settings } = useSettings();
  const [toutCommande, setToutCommande] = useState(false);

  const client = useMemo(() => clients.find((c) => c.id === clientId), [clients, clientId]);
  const clientDocs = useMemo(
    () => documents.filter((d) => d.clientId === clientId).slice(0, 8),
    [documents, clientId],
  );
  // Tout vient du miroir local : la question « qu'est-ce que j'avais pris ? »
  // se pose devant le client, souvent sans réseau.
  const commandes = useMemo(
    () => clientOrderHistory({ clientId, documents, deliveryNotes, products }),
    [clientId, documents, deliveryNotes, products],
  );

  if (loading) return <Loading />;
  if (!client) return <EmptyState title="Client introuvable" />;

  const phone = client.phone?.trim();
  const mobile = client.mobile?.trim();
  const email = client.email?.trim();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
      <Card>
        <SectionTitle>{client.name}</SectionTitle>
        <InfoRow label="Code" value={client.code} />
        {client.contact ? <InfoRow label="Contact" value={client.contact} /> : null}
        <InfoRow label="Adresse" value={client.address.label || '—'} />
        {phone ? <InfoRow label="Téléphone" value={phone} /> : null}
        {mobile ? <InfoRow label="Portable" value={mobile} /> : null}
        {email ? <InfoRow label="E-mail" value={email} /> : null}
        {client.siret ? <InfoRow label="SIRET" value={client.siret} /> : null}
        {client.notes ? <InfoRow label="Notes" value={client.notes} /> : null}
      </Card>

      <Card style={{ gap: 2, padding: spacing.sm }}>
        {client.address.label ? (
          <SheetAction
            title="🧭  Itinéraire vers ce client"
            onPress={() =>
              openNavigation(
                { id: 'nav', label: client.name, address: client.address, pinned: false, serviceMinutes: 0 },
                settings?.mapProvider ?? 'google',
              )
            }
          />
        ) : null}
        {phone ? <SheetAction title="📞  Appeler" subtitle={phone} onPress={() => call(phone)} /> : null}
        {mobile ? (
          <SheetAction title="📱  Appeler le portable" subtitle={mobile} onPress={() => call(mobile)} />
        ) : null}
        {email ? (
          <SheetAction
            title="✉️  Écrire un e-mail"
            subtitle={email}
            onPress={() => openMailto(email, '', 'Bonjour,\n\n')}
          />
        ) : null}
      </Card>

      {commandes.items.length > 0 && (
        <Card style={{ padding: 0, gap: 0 }}>
          <View style={{ padding: spacing.lg, paddingBottom: spacing.sm }}>
            <SectionTitle>Déjà commandé</SectionTitle>
            <Muted size={12}>
              {commandes.items.length} article(s) relevé(s) sur {commandes.sourceCount} pièce(s).
            </Muted>
          </View>
          {(toutCommande ? commandes.items : commandes.items.slice(0, 8)).map((item) => (
            <ListItem
              key={item.key}
              title={item.ref ? `${item.ref} · ${item.label}` : item.label}
              subtitle={`${dateFr(item.lastDate)} · ${item.lastSource}${
                item.orderCount > 1 ? ` · ${item.orderCount} fois` : ''
              }`}
              right={
                <View style={{ alignItems: 'flex-end' }}>
                  <Muted size={13}>× {num(item.lastQty, item.unit)}</Muted>
                  {item.lastUnitPriceHT != null ? (
                    <Muted size={11}>{euro(item.lastUnitPriceHT)}</Muted>
                  ) : null}
                </View>
              }
            />
          ))}
          {commandes.items.length > 8 && (
            <View style={{ padding: spacing.md }}>
              <Button
                title={
                  toutCommande ? 'Réduire' : `Voir les ${commandes.items.length} articles`
                }
                onPress={() => setToutCommande((v) => !v)}
              />
            </View>
          )}
        </Card>
      )}

      {clientDocs.length > 0 && (
        <Card style={{ padding: 0, gap: 0 }}>
          <View style={{ padding: spacing.lg, paddingBottom: spacing.sm }}>
            <SectionTitle>Derniers documents</SectionTitle>
          </View>
          {clientDocs.map((doc) => (
            <ListItem
              key={doc.id}
              title={doc.number}
              subtitle={doc.date}
              right={
                <Badge tone={doc.status === 'paid' ? 'success' : 'default'}>
                  {euro(doc.totalTTC)}
                </Badge>
              }
            />
          ))}
        </Card>
      )}
    </ScrollView>
  );
}
