import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AuthIdentity, ChannelName } from '@shared/api';
import { mayCall } from '@shared/api';
import { Muted, SectionTitle } from '../components/ui';
import { colors, radius, spacing } from '../theme';

/**
 * Le reste de l'application, en grille.
 *
 * Neuf onglets dans une barre de téléphone donnaient neuf libellés tronqués
 * (« Tourn… », « Docu… », « Régla… ») et des cibles trop étroites pour un
 * pouce. Quatre onglets portent donc le quotidien, et cet écran accueille ce
 * qu'on ouvre plus rarement — avec des noms entiers et de vraies surfaces à
 * toucher.
 */

export interface PlusEntry {
  name: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  channel: ChannelName | null;
  hint: string;
}

export const PLUS_ENTRIES: PlusEntry[] = [
  {
    name: 'Bons',
    label: 'Bons de livraison',
    icon: 'create-outline',
    channel: 'delivery:list',
    hint: 'Signés en tournée, facturés ensuite',
  },
  {
    name: 'Documents',
    label: 'Documents',
    icon: 'document-text-outline',
    channel: 'documents:list',
    hint: 'Factures, devis et avoirs',
  },
  {
    name: 'Stock',
    label: 'Stock',
    icon: 'cube-outline',
    channel: 'products:list',
    hint: 'Consommables, machines, pièces',
  },
  {
    name: 'Banque',
    label: 'Banque',
    icon: 'card-outline',
    channel: 'bank:list',
    hint: 'Opérations et rapprochement',
  },
  {
    name: 'Activité',
    label: 'Activité',
    icon: 'stats-chart-outline',
    channel: 'stats:dashboard',
    hint: 'Chiffre d’affaires du mois',
  },
  {
    name: 'Réglages',
    label: 'Réglages',
    icon: 'settings-outline',
    channel: null,
    hint: 'Compte, synchronisation, notifications',
  },
];

export function PlusScreen({
  identity,
  onOpen,
}: {
  identity: AuthIdentity | null;
  onOpen: (name: string) => void;
}) {
  // Même filtre que la barre d'onglets : le masquage est un confort, le
  // serveur refuse de toute façon ce qui n'est pas permis.
  const visible = PLUS_ENTRIES.filter(
    (entry) => !entry.channel || !identity || mayCall(identity.role, entry.channel),
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
    >
      <SectionTitle>Tout le reste</SectionTitle>
      {visible.map((entry) => (
        <Pressable
          key={entry.name}
          onPress={() => onOpen(entry.name)}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              backgroundColor: colors.card,
              borderRadius: radius.md,
              padding: spacing.md,
            },
            pressed && { backgroundColor: 'rgba(0,0,0,0.03)' },
          ]}
        >
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: radius.sm,
              backgroundColor: colors.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name={entry.icon} size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 15.5, fontWeight: '600', color: colors.text }}>
              {entry.label}
            </Text>
            <Muted size={12}>{entry.hint}</Muted>
          </View>
          <Text style={{ color: colors.tertiary, fontSize: 18 }}>›</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
