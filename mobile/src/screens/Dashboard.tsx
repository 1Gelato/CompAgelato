import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { dateFr, euro, KIND_LABEL } from '@shared/format';
import { useDashboard, useRefresh } from '../lib/data';
import { Card, EmptyState, InfoRow, Loading, SectionTitle, Stat } from '../components/ui';
import { colors, spacing } from '../theme';

/**
 * L'activité en cartes simples : les chiffres qui se lisent en dix secondes.
 * Chaque tuile mène à l'écran qu'elle résume — un chiffre qui intrigue se
 * creuse d'un geste, sans repasser par la grille.
 */
export function DashboardScreen({
  navigation,
}: {
  // « Clients » n'appartient pas à la pile Plus : l'appel remonte alors aux
  // onglets — c'est React Navigation qui fait buller, le type nominal ne
  // peut rien en dire.
  navigation: { navigate: (name: string) => void };
}) {
  const { data: stats, loading, error } = useDashboard();
  const { refreshing, onRefresh } = useRefresh();

  if (loading) return <Loading />;
  if (!stats) {
    return (
      <EmptyState
        icon="stats-chart-outline"
        title="Tableau de bord indisponible"
        text={error ?? 'Le tableau de bord se calcule sur le serveur : il faut le réseau.'}
      />
    );
  }

  const month = stats.monthlyRevenue[stats.monthlyRevenue.length - 1];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.tiles}>
        <View style={styles.cell}>
          <Stat
            label="CA du mois (TTC)"
            value={month ? euro(month.ttc) : '—'}
            onPress={() => navigation.navigate('Documents')}
          />
        </View>
        <View style={styles.cell}>
          <Stat
            label="Factures"
            value={String(stats.invoices)}
            onPress={() => navigation.navigate('Documents')}
          />
        </View>
        <View style={styles.cell}>
          <Stat
            label="Clients"
            value={String(stats.clients)}
            onPress={() => navigation.navigate('Clients')}
          />
        </View>
        <View style={styles.cell}>
          <Stat
            label="Stock à surveiller"
            value={String(stats.lowStock.length)}
            tone={stats.lowStock.length ? 'warn' : undefined}
            onPress={() => navigation.navigate('Stock')}
          />
        </View>
      </View>

      {stats.topClients.length > 0 && (
        <Card style={{ gap: 4 }}>
          <SectionTitle>Meilleurs clients</SectionTitle>
          {stats.topClients.slice(0, 5).map((entry) => (
            <InfoRow key={entry.client.id} label={entry.client.name} value={euro(entry.total)} />
          ))}
        </Card>
      )}

      {stats.recentDocuments.length > 0 && (
        <Card style={{ gap: 4 }}>
          <SectionTitle>Derniers documents</SectionTitle>
          {stats.recentDocuments.slice(0, 6).map((doc) => (
            <InfoRow
              key={doc.id}
              label={`${KIND_LABEL[doc.kind]} ${doc.number} · ${dateFr(doc.date)}`}
              value={euro(doc.totalTTC)}
            />
          ))}
        </Card>
      )}

      {stats.lowStock.length > 0 && (
        <Card style={{ gap: 4 }}>
          <SectionTitle>Sous le seuil d’alerte</SectionTitle>
          {stats.lowStock.slice(0, 6).map((entry) => (
            <InfoRow
              key={entry.product.id}
              label={entry.product.name}
              value={`manque ${entry.missing} ${entry.product.unit}`}
            />
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexBasis: '47%', flexGrow: 1, flexDirection: 'row' },
});
