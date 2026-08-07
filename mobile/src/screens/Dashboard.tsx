import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { dateFr, euro, KIND_LABEL } from '@shared/format';
import { useDashboard } from '../lib/data';
import { Card, EmptyState, InfoRow, Loading, Muted, SectionTitle } from '../components/ui';
import { colors, spacing } from '../theme';

/** L'activité en cartes simples : les chiffres qui se lisent en dix secondes. */
export function DashboardScreen() {
  const { data: stats, loading, error } = useDashboard();

  if (loading) return <Loading />;
  if (!stats) {
    return (
      <EmptyState
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
    >
      <View style={styles.tiles}>
        <View style={styles.tile}>
          <Muted size={12}>CA du mois (TTC)</Muted>
          <Text style={styles.tileValue}>{month ? euro(month.ttc) : '—'}</Text>
        </View>
        <View style={styles.tile}>
          <Muted size={12}>Factures</Muted>
          <Text style={styles.tileValue}>{stats.invoices}</Text>
        </View>
        <View style={styles.tile}>
          <Muted size={12}>Clients</Muted>
          <Text style={styles.tileValue}>{stats.clients}</Text>
        </View>
        <View style={styles.tile}>
          <Muted size={12}>Stock à surveiller</Muted>
          <Text style={[styles.tileValue, stats.lowStock.length ? { color: colors.orange } : null]}>
            {stats.lowStock.length}
          </Text>
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
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: spacing.lg,
    gap: 4,
  },
  tileValue: { fontSize: 20, fontWeight: '700', color: colors.text },
});
