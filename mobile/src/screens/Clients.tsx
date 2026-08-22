import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, Text, View } from 'react-native';
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
  ActionTile,
  Badge,
  Button,
  Card,
  CardList,
  EmptyState,
  Icon,
  InfoRow,
  ListItem,
  Loading,
  Muted,
  SearchBar,
  Screen,
  SectionTitle,
} from '../components/ui';
import { colors, font, spacing } from '../theme';

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

  return (
    <Screen>
      <View style={{ padding: spacing.md }}>
        <SearchBar value={query} onChange={setQuery} placeholder="Nom, ville, code…" />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(client) => client.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          loading ? (
            <Loading />
          ) : (
            <EmptyState icon="people-outline" title="Aucun client ne correspond" />
          )
        }
        renderItem={({ item: client }) => (
          <ListItem
            title={client.name}
            subtitle={client.address.label || client.address.city || client.code}
            right={
              client.phone || client.mobile ? (
                <Icon name="call-outline" size={15} color={colors.secondary} />
              ) : undefined
            }
            chevron
            onPress={() => navigation.navigate('ClientDetail', { clientId: client.id })}
          />
        )}
      />
    </Screen>
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
      {/* Le nom est le titre de l'écran — plus un intitulé de section gris. */}
      <Card>
        <Text style={{ ...font.title, color: colors.text }}>{client.name}</Text>
        <Muted size={13}>
          {client.code}
          {client.address.label ? ` · ${client.address.label}` : ''}
        </Muted>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          {client.address.label ? (
            <ActionTile
              icon="navigate"
              label="Itinéraire"
              onPress={() =>
                openNavigation(
                  { id: 'nav', label: client.name, address: client.address, pinned: false, serviceMinutes: 0 },
                  settings?.mapProvider ?? 'google',
                )
              }
            />
          ) : null}
          {phone ? <ActionTile icon="call" label="Appeler" onPress={() => call(phone)} /> : null}
          {mobile ? (
            <ActionTile icon="phone-portrait" label="Portable" onPress={() => call(mobile)} />
          ) : null}
          {email ? (
            <ActionTile
              icon="mail"
              label="E-mail"
              onPress={() => openMailto(email, '', 'Bonjour,\n\n')}
            />
          ) : null}
        </View>
        {!client.address.label && !phone && !mobile && !email ? (
          <Muted size={12}>Aucune coordonnée sur cette fiche — complétez-la depuis le bureau.</Muted>
        ) : null}
      </Card>

      {/* Tous les enfants sont conditionnels : sans coordonnées du tout, ne
          pas laisser une carte blanche vide sous l'en-tête. */}
      {client.contact || phone || mobile || email || client.siret || client.notes ? (
        <Card>
          {client.contact ? <InfoRow label="Contact" value={client.contact} /> : null}
          {phone ? <InfoRow label="Téléphone" value={phone} /> : null}
          {mobile ? <InfoRow label="Portable" value={mobile} /> : null}
          {email ? <InfoRow label="E-mail" value={email} /> : null}
          {client.siret ? <InfoRow label="SIRET" value={client.siret} /> : null}
          {client.notes ? <InfoRow label="Notes" value={client.notes} /> : null}
        </Card>
      ) : null}

      {commandes.items.length > 0 && (
        <CardList>
          <View style={{ padding: spacing.lg, paddingBottom: spacing.sm, gap: 2 }}>
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
        </CardList>
      )}

      {clientDocs.length > 0 && (
        <CardList>
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
        </CardList>
      )}
    </ScrollView>
  );
}
