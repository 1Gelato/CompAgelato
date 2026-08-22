import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { dateFr, euro } from '@shared/format';
import { useBankSummary, useBankTransactions, useRefresh } from '../lib/data';
import { Badge, EmptyState, ListItem, Loading, SearchBar, Stat } from '../components/ui';
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {summary && (
        <View style={styles.summary}>
          <Stat label="Solde connu" value={summary.balance !== undefined ? euro(summary.balance) : '—'} />
          <Stat label="Encaissé" value={euro(summary.totalIn)} tone="success" />
          <Stat label="À rapprocher" value={String(summary.unreconciled)} />
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
          loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon="card-outline"
              title="Aucune opération"
              text="Les relevés s’importent depuis l’ordinateur ou l’interface web."
            />
          )
        }
        renderItem={({ item: tx }) => (
          <ListItem
            title={tx.label}
            subtitle={`${dateFr(tx.date)}${tx.category ? ` · ${tx.category}` : ''}`}
            right={
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '600',
                    color: tx.amount >= 0 ? colors.green : colors.text,
                  }}
                >
                  {euro(tx.amount)}
                </Text>
                {tx.documentId ? <Badge tone="success">rapprochée</Badge> : null}
              </View>
            }
          />
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
});
