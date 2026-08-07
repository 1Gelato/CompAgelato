import { useMemo, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ProductType } from '@shared/types';
import { dateFr, num } from '@shared/format';
import { api } from '../lib/runtime';
import { errorMessage, refreshAll, useProducts, useStockMoves } from '../lib/data';
import {
  Badge,
  Button,
  Card,
  Chips,
  EmptyState,
  Field,
  InfoRow,
  Input,
  ListItem,
  Loading,
  SearchBar,
  SectionTitle,
  Sheet,
  useToast,
} from '../components/ui';
import { colors, spacing } from '../theme';

export type StockStackParams = {
  StockList: undefined;
  ProductDetail: { productId: string };
};

type TypeFilter = 'all' | ProductType;

const TYPE_LABEL: Record<string, string> = {
  consumable: 'Consommable',
  mixLiquid: 'Mix liquide',
  mixPowder: 'Mix poudre',
  machine: 'Machine',
  part: 'Pièce',
};

export function StockListScreen({
  navigation,
}: NativeStackScreenProps<StockStackParams, 'StockList'>) {
  const { data: products, loading } = useProducts();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return products
      .filter((p) => !p.archived)
      .filter((p) => type === 'all' || p.type === type)
      .filter((p) => !needle || `${p.name} ${p.sku}`.toLowerCase().includes(needle));
  }, [products, query, type]);

  if (loading) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <SearchBar value={query} onChange={setQuery} placeholder="Nom ou référence…" />
        <Chips
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: 'Tous' },
            { value: 'consumable', label: 'Consommables' },
            { value: 'mixLiquid', label: 'Mix liquide' },
            { value: 'mixPowder', label: 'Mix poudre' },
            { value: 'machine', label: 'Machines' },
            { value: 'part', label: 'Pièces' },
          ]}
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(product) => product.id}
        ListEmptyComponent={<EmptyState title="Aucun article ne correspond" />}
        renderItem={({ item: product }) => {
          const low = product.minQty > 0 && product.qtyOnHand < product.minQty;
          return (
            <ListItem
              title={product.name}
              subtitle={`${product.sku} · ${TYPE_LABEL[product.type] ?? product.type}`}
              right={
                <Badge tone={low ? 'warn' : 'default'}>
                  {num(product.qtyOnHand)} {product.unit}
                </Badge>
              }
              onPress={() => navigation.navigate('ProductDetail', { productId: product.id })}
            />
          );
        }}
      />
    </View>
  );
}

export function ProductDetailScreen({
  route,
}: NativeStackScreenProps<StockStackParams, 'ProductDetail'>) {
  const { productId } = route.params;
  const { data: products, loading } = useProducts();
  const { data: moves } = useStockMoves(productId);
  const toast = useToast();
  const [adjusting, setAdjusting] = useState(false);
  const [nextQty, setNextQty] = useState('');
  const [busy, setBusy] = useState(false);

  const product = useMemo(() => products.find((p) => p.id === productId), [products, productId]);

  if (loading) return <Loading />;
  if (!product) return <EmptyState title="Article introuvable" />;

  const low = product.minQty > 0 && product.qtyOnHand < product.minQty;

  const adjust = async () => {
    const value = Number(nextQty.replace(',', '.'));
    if (!Number.isFinite(value)) return;
    setBusy(true);
    try {
      // Le serveur trace l'ajustement comme un mouvement d'inventaire : le
      // stock reste la somme de son journal, ici comme partout.
      await api.products.adjust(product.id, value, 'Inventaire depuis le téléphone');
      refreshAll();
      setAdjusting(false);
      setNextQty('');
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}
    >
      <Card>
        <SectionTitle>{product.name}</SectionTitle>
        <InfoRow label="Référence" value={product.sku} />
        <InfoRow label="Nature" value={TYPE_LABEL[product.type] ?? product.type} />
        <InfoRow
          label="En stock"
          value={`${num(product.qtyOnHand)} ${product.unit}${low ? '  ⚠️ sous le seuil' : ''}`}
        />
        {product.minQty > 0 ? (
          <InfoRow label="Seuil d’alerte" value={`${num(product.minQty)} ${product.unit}`} />
        ) : null}
        {product.supplier ? <InfoRow label="Fournisseur" value={product.supplier} /> : null}
        <Button title="Ajuster le stock (inventaire)" onPress={() => setAdjusting(true)} />
      </Card>

      <Card style={{ gap: 4 }}>
        <SectionTitle>Derniers mouvements</SectionTitle>
        {moves.length === 0 ? (
          <EmptyState title="Aucun mouvement" />
        ) : (
          moves.slice(0, 20).map((move) => (
            <InfoRow
              key={move.id}
              label={`${dateFr(move.date)} · ${move.note ?? move.documentNumber ?? move.type}`}
              value={`${move.qty > 0 ? '+' : ''}${num(move.qty)} → ${num(move.balanceAfter)}`}
            />
          ))
        )}
      </Card>

      <Sheet open={adjusting} onClose={() => setAdjusting(false)} title="Inventaire">
        <Field
          label={`Quantité réellement en stock (${product.unit})`}
          hint={`Actuellement : ${num(product.qtyOnHand)} ${product.unit}. L’écart sera tracé comme un mouvement d’ajustement.`}
        >
          <Input
            value={nextQty}
            onChangeText={setNextQty}
            keyboardType="decimal-pad"
            placeholder={String(product.qtyOnHand)}
            autoFocus
          />
        </Field>
        <Button title="Enregistrer" variant="primary" onPress={adjust} busy={busy} />
      </Sheet>
    </ScrollView>
  );
}
