import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import type { RegisterEntry, RegisterKind, RegisterStatus } from '@shared/types';
import { dateFr } from '@shared/format';
import { api } from '../lib/runtime';
import { errorMessage, refreshAll, useClients, useRefresh, useRegisterEntries } from '../lib/data';
import {
  Badge,
  Button,
  Chips,
  EmptyState,
  Field,
  Input,
  ListItem,
  Loading,
  Sheet,
  SheetAction,
  useToast,
} from '../components/ui';
import { colors, spacing } from '../theme';
import type { Tone } from '../theme';

/**
 * Les trois cahiers de l'entreprise — SAV, consommables, événementiel. Sur le
 * téléphone c'est avant tout une prise de note : un client appelle pendant la
 * tournée, la panne se note sur le champ.
 */

const KIND_LABEL: Record<RegisterKind, string> = {
  sav: 'SAV',
  consumables: 'Consommables',
  event: 'Événementiel',
};

const STATUS_LABEL: Record<RegisterStatus, string> = {
  open: 'À traiter',
  confirmed: 'Confirmée',
  done: 'Terminée',
  cancelled: 'Annulée',
};

const STATUS_TONE: Record<RegisterStatus, Tone> = {
  open: 'warn',
  confirmed: 'info',
  done: 'success',
  cancelled: 'default',
};

type KindFilter = 'all' | RegisterKind;

export function CahiersScreen() {
  const { data: entries, loading } = useRegisterEntries();
  const { refreshing, onRefresh } = useRefresh();
  const { data: clients } = useClients();

  /**
   * Le client de l'écriture.
   *
   * Une écriture rattachée à une fiche ne porte pas de `clientName` — c'est la
   * fiche qui fait foi. Se contenter de `clientName` laissait donc la ligne
   * vide précisément pour les écritures les mieux renseignées.
   */
  const clientLabel = (entry: RegisterEntry): string => {
    if (entry.clientId) return clients.find((c) => c.id === entry.clientId)?.name ?? 'Client supprimé';
    return entry.clientName ?? '';
  };
  const toast = useToast();
  const [kind, setKind] = useState<KindFilter>('all');
  const [selected, setSelected] = useState<RegisterEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftKind, setDraftKind] = useState<RegisterKind>('sav');
  const [title, setTitle] = useState('');
  const [clientName, setClientName] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(
    () => entries.filter((entry) => kind === 'all' || entry.kind === kind),
    [entries, kind],
  );

  if (loading) return <Loading />;

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.registers.save({
        kind: draftKind,
        title: title.trim(),
        clientName: clientName.trim() || undefined,
        details: details.trim() || undefined,
      });
      refreshAll();
      setCreating(false);
      setTitle('');
      setClientName('');
      setDetails('');
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (entry: RegisterEntry, status: RegisterStatus) => {
    try {
      await api.registers.setStatus(entry.id, status);
      refreshAll();
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setSelected(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <Chips
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'Tous' },
            { value: 'sav', label: 'SAV' },
            { value: 'consumables', label: 'Consommables' },
            { value: 'event', label: 'Événementiel' },
          ]}
        />
        <Button title="+ Nouvelle écriture" variant="primary" onPress={() => setCreating(true)} />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(entry) => entry.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<EmptyState title="Rien dans ce cahier" />}
        renderItem={({ item: entry }) => (
          <ListItem
            title={entry.title}
            subtitle={[KIND_LABEL[entry.kind], clientLabel(entry), dateFr(entry.createdAt.slice(0, 10))]
              .filter(Boolean)
              .join(' · ')}
            right={<Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Badge>}
            onPress={() => setSelected(entry)}
          />
        )}
      />

      {/* Changement de statut, d'un geste. */}
      <Sheet
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={
          selected
            ? [selected.title, clientLabel(selected)].filter(Boolean).join(' — ')
            : undefined
        }
      >
        {selected &&
          (['open', 'confirmed', 'done', 'cancelled'] as RegisterStatus[])
            .filter((status) => status !== selected.status)
            .map((status) => (
              <SheetAction
                key={status}
                title={STATUS_LABEL[status]}
                tone={status === 'done' ? 'success' : status === 'cancelled' ? 'danger' : 'default'}
                onPress={() => void setStatus(selected, status)}
              />
            ))}
      </Sheet>

      {/* Nouvelle écriture : le strict nécessaire d'une prise de note. */}
      <Sheet open={creating} onClose={() => setCreating(false)} title="Nouvelle écriture">
        <Chips
          value={draftKind}
          onChange={setDraftKind}
          options={[
            { value: 'sav', label: 'SAV' },
            { value: 'consumables', label: 'Consommables' },
            { value: 'event', label: 'Événementiel' },
          ]}
        />
        <Field label={draftKind === 'sav' ? 'Cause de la panne' : 'Objet'}>
          <Input value={title} onChangeText={setTitle} placeholder="Machine en panne…" autoFocus />
        </Field>
        <Field label="Client" hint="Nom noté au vol — la fiche pourra être rattachée au bureau.">
          <Input value={clientName} onChangeText={setClientName} placeholder="Glacier des Embruns" />
        </Field>
        <Field label="Commentaire">
          <Input value={details} onChangeText={setDetails} placeholder="Détails…" multiline />
        </Field>
        <Button title="Enregistrer" variant="primary" onPress={create} busy={busy} disabled={!title.trim()} />
      </Sheet>
    </View>
  );
}
