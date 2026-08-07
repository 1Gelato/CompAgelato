import { useMemo, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { EmailPreparation } from '@shared/api';
import type { DocumentKind } from '@shared/types';
import { dateFr, euro, KIND_LABEL, STATUS_LABEL } from '@shared/format';
import { api, downloadFile } from '../lib/runtime';
import { errorMessage, refreshAll, useClientIndex, useClients, useDocuments } from '../lib/data';
import { openMailto } from '../lib/nav';
import {
  Badge,
  Card,
  Chips,
  EmptyState,
  InfoRow,
  ListItem,
  Loading,
  SearchBar,
  SectionTitle,
  SheetAction,
  useToast,
} from '../components/ui';
import { colors, spacing } from '../theme';
import type { Tone } from '../theme';

export type DocumentsStackParams = {
  DocumentsList: undefined;
  DocumentDetail: { documentId: string };
};

type KindFilter = 'all' | DocumentKind;

const STATUS_TONE_MOBILE: Record<string, Tone> = {
  draft: 'default',
  confirmed: 'info',
  paid: 'success',
  cancelled: 'danger',
};

export function DocumentsListScreen({
  navigation,
}: NativeStackScreenProps<DocumentsStackParams, 'DocumentsList'>) {
  const { data: documents, loading } = useDocuments();
  const { data: clients } = useClients();
  const clientIndex = useClientIndex(clients);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents
      .filter((d) => kind === 'all' || d.kind === kind)
      .filter((d) => {
        if (!needle) return true;
        const client = d.clientId ? clientIndex.get(d.clientId)?.name ?? '' : d.clientNameRaw ?? '';
        return `${d.number} ${client} ${d.totalTTC}`.toLowerCase().includes(needle);
      });
  }, [documents, clientIndex, query, kind]);

  if (loading) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <SearchBar value={query} onChange={setQuery} placeholder="Numéro, client, montant…" />
        <Chips
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'Tous' },
            { value: 'invoice', label: 'Factures' },
            { value: 'quote', label: 'Devis' },
            { value: 'credit', label: 'Avoirs' },
          ]}
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(doc) => doc.id}
        ListEmptyComponent={<EmptyState title="Aucun document ne correspond" />}
        renderItem={({ item: doc }) => {
          const client = doc.clientId
            ? clientIndex.get(doc.clientId)?.name
            : doc.clientNameRaw;
          return (
            <ListItem
              title={`${KIND_LABEL[doc.kind]} ${doc.number}`}
              subtitle={`${dateFr(doc.date)}${client ? ` · ${client}` : ''}`}
              right={
                <View style={{ alignItems: 'flex-end', gap: 3 }}>
                  <Badge tone={STATUS_TONE_MOBILE[doc.status] ?? 'default'}>
                    {STATUS_LABEL[doc.status] ?? doc.status}
                  </Badge>
                  <Badge>{euro(doc.totalTTC)}</Badge>
                </View>
              }
              onPress={() => navigation.navigate('DocumentDetail', { documentId: doc.id })}
            />
          );
        }}
      />
    </View>
  );
}

export function DocumentDetailScreen({
  route,
}: NativeStackScreenProps<DocumentsStackParams, 'DocumentDetail'>) {
  const { documentId } = route.params;
  const { data: documents, loading } = useDocuments();
  const { data: clients } = useClients();
  const clientIndex = useClientIndex(clients);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const doc = useMemo(() => documents.find((d) => d.id === documentId), [documents, documentId]);

  if (loading) return <Loading />;
  if (!doc) return <EmptyState title="Document introuvable" />;

  const client = doc.clientId ? clientIndex.get(doc.clientId) : undefined;

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  /** Le PDF descend du serveur puis passe par la feuille de partage : lecture,
   *  impression ou envoi, au choix du téléphone. */
  const sharePdf = () =>
    run('pdf', async () => {
      const uri = await downloadFile(
        `/files/document/${doc.id}`,
        `${KIND_LABEL[doc.kind]} ${doc.number}.pdf`,
      );
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf' });
    });

  const email = () =>
    run('email', async () => {
      const preparation = (await api.documents.prepareEmail(doc.id)) as EmailPreparation;
      openMailto(
        preparation.draft.to,
        preparation.draft.subject,
        preparation.draft.body,
        preparation.draft.cc,
      );
    });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}
    >
      <Card>
        <SectionTitle>
          {KIND_LABEL[doc.kind]} {doc.number}
        </SectionTitle>
        <InfoRow label="Date" value={dateFr(doc.date)} />
        {doc.dueDate ? <InfoRow label="Échéance" value={dateFr(doc.dueDate)} /> : null}
        <InfoRow label="Client" value={client?.name ?? doc.clientNameRaw ?? '—'} />
        <InfoRow label="Statut" value={STATUS_LABEL[doc.status] ?? doc.status} />
        <InfoRow label="Total HT" value={euro(doc.totalHT)} />
        <InfoRow label="TVA" value={euro(doc.totalVAT)} />
        <InfoRow label="Total TTC" value={euro(doc.totalTTC)} />
        {doc.printedAt ? <InfoRow label="Imprimé" value={dateFr(doc.printedAt)} /> : null}
        {doc.emailedAt ? <InfoRow label="Envoyé" value={dateFr(doc.emailedAt)} /> : null}
      </Card>

      {doc.lines.length > 0 && (
        <Card style={{ gap: 4 }}>
          <SectionTitle>Lignes</SectionTitle>
          {doc.lines.map((line) => (
            <InfoRow
              key={line.id}
              label={`${line.qty} × ${line.label}`}
              value={line.totalHT !== undefined ? euro(line.totalHT) : '—'}
            />
          ))}
        </Card>
      )}

      <Card style={{ gap: 2, padding: spacing.sm }}>
        {doc.sourceFile ? (
          <SheetAction
            title={busy === 'pdf' ? '⏳  Téléchargement…' : '📄  Ouvrir / partager le PDF'}
            subtitle="Lecture, impression ou envoi depuis le téléphone"
            onPress={sharePdf}
          />
        ) : null}
        <SheetAction
          title="✉️  Préparer un e-mail"
          subtitle={client?.email ?? 'Brouillon dans la messagerie du téléphone'}
          onPress={email}
        />
        {doc.status !== 'paid' ? (
          <SheetAction
            title="✓  Marquer réglée"
            tone="success"
            onPress={() =>
              run('paid', async () => {
                await api.documents.setStatus(doc.id, 'paid');
                refreshAll();
              })
            }
          />
        ) : (
          <SheetAction
            title="↩︎  Repasser en validée"
            onPress={() =>
              run('unpaid', async () => {
                await api.documents.setStatus(doc.id, 'confirmed');
                refreshAll();
              })
            }
          />
        )}
        <SheetAction
          title={doc.printedAt ? '🖨  Retirer le repère « imprimé »' : '🖨  Marquer imprimé'}
          onPress={() =>
            run('printed', async () => {
              await api.documents.setPrinted(doc.id, !doc.printedAt);
              refreshAll();
            })
          }
        />
      </Card>
    </ScrollView>
  );
}
