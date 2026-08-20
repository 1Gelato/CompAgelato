import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { dateFr, euro } from '@shared/format';
import { useBankSummary, useBankTransactions, useRefresh } from '../lib/data';
import { Badge, EmptyState, Loading, Muted, SearchBar } from '../components/ui';
import { colors, spacing } from '../theme';

/**
 * La banque en consultation : les opérations, la trésorerie, ce qui reste à
 * rapprocher. Le rapprochement fin se fait au bureau — l'écran du téléphone
 * répond à « où en est-on ? », pas plus.
 */
export function BanqueScreen() {
  const { data: transactions, loading } = useBankTransactions();
  const { refreshing, onRefresh } = useRefresh();
  const { data: summary } = useBankSummary();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return transactions;
    return transactions.filter((tx) =>
      `${tx.label} ${tx.amount}`.toLowerCase().includes(needle),
    );
  }, [transactions, query]);

  if (loading) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {summary && (
        <View style={styles.summary}>
          <View style={styles.summaryItem}>
            <Muted size={12}>Solde connu</Muted>
            <Text style={styles.summaryValue}>
              {summary.balance !== undefined ? euro(summary.balance) : '—'}
            </Text>
          </View>
          <View style={styles.summaryItem}>
            <Muted size={12}>Encaissé</Muted>
            <Text style={[styles.summaryValue, { color: colors.green }]}>
              {euro(summary.totalIn)}
            </Text>
          </View>
          <View style={styles.summaryItem}>
            <Muted size={12}>À rapprocher</Muted>
            <Text style={styles.summaryValue}>{summary.unreconciled}</Text>
          </View>
        </View>
      )}

      <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.sm }}>
        <SearchBar value={query} onChange={setQuery} placeholder="Libellé ou montant…" />
      </View>

      <FlatList
        data={filtered.slice(0, 300)}
        keyExtractor={(tx) => tx.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <EmptyState
            title="Aucune opération"
            text="Les relevés s’importent depuis l’ordinateur ou l’interface web."
          />
        }
        renderItem={({ item: tx }) => (
          <View style={styles.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 14, color: colors.text }}>
                {tx.label}
              </Text>
              <Muted size={12}>
                {dateFr(tx.date)}
                {tx.category ? ` · ${tx.category}` : ''}
              </Muted>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: '600',
                  color: tx.amount >= 0 ? colors.green : colors.text,
                }}
              >
                {euro(tx.amount)}
              </Text>
              {tx.documentId ? <Badge tone="success">rapprochée</Badge> : null}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  summaryItem: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: spacing.md,
    gap: 2,
  },
  summaryValue: { fontSize: 16, fontWeight: '700', color: colors.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
});
