import { useMemo, useState } from 'react';
import type { Address, Client, ImportClientsReport } from '@shared/types';
import { AddressInput } from '../components/AddressInput';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  SearchInput,
  Select,
  Spinner,
  Textarea,
  Th,
  useToast,
} from '../components/ui';
import { errorMessage, refreshAll, useClients, useDocuments } from '../lib/data';
import { euro, matches } from '../lib/format';
import { useSort } from '../lib/sort';

export function Clients() {
  const { data: clients, loading } = useClients();
  const { data: documents } = useDocuments();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Client | 'new' | null>(null);
  const [importReport, setImportReport] = useState<ImportClientsReport | null>(null);
  const [merging, setMerging] = useState<Client | null>(null);
  const [importing, setImporting] = useState(false);
  const [geocoding, setGeocoding] = useState(false);

  const missingCoords = useMemo(
    () => clients.filter((c) => !c.archived && typeof c.address.lat !== 'number' && c.address.label).length,
    [clients],
  );

  const geocodeMissing = async () => {
    setGeocoding(true);
    try {
      const report = await window.api.clients.geocodeMissing();
      refreshAll();
      toast.push({
        tone: report.located ? 'success' : 'warn',
        title: report.located
          ? `${report.located} client(s) géolocalisé(s)`
          : 'Aucune adresse localisée',
        text: report.failed
          ? `${report.failed} adresse(s) non reconnue(s) : ouvrez la fiche et choisissez une proposition.`
          : 'Ces clients peuvent maintenant être ajoutés à une tournée.',
      });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Géolocalisation impossible', text: errorMessage(err) });
    } finally {
      setGeocoding(false);
    }
  };

  // Chiffre d'affaires et nombre de pièces par client.
  const activity = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const doc of documents) {
      if (!doc.clientId || doc.kind === 'quote' || doc.status === 'cancelled') continue;
      const sign = doc.kind === 'credit' ? -1 : 1;
      const entry = map.get(doc.clientId) ?? { total: 0, count: 0 };
      entry.total += sign * doc.totalHT;
      entry.count += 1;
      map.set(doc.clientId, entry);
    }
    return map;
  }, [documents]);

  const filtered = useMemo(
    () =>
      clients.filter((client) =>
        matches(
          [
            client.code,
            client.name,
            client.legalName ?? '',
            client.email ?? '',
            client.phone ?? '',
            client.address.city ?? '',
            client.address.postcode ?? '',
            client.tags.join(' '),
          ].join(' '),
          search,
        ),
      ),
    [clients, search],
  );

  const { sorted, sort, toggle } = useSort(
    filtered,
    useMemo(
      () => ({
        code: (c: Client) => c.code,
        name: (c: Client) => c.name,
        city: (c: Client) => c.address.city ?? null,
        contact: (c: Client) => c.email ?? c.phone ?? null,
        total: (c: Client) => activity.get(c.id)?.total ?? null,
        count: (c: Client) => activity.get(c.id)?.count ?? 0,
        tags: (c: Client) => c.tags.join(' ') || null,
      }),
      [activity],
    ),
    { key: 'name', direction: 'asc' },
  );

  const runImport = async () => {
    setImporting(true);
    try {
      const report = await window.api.clients.pickAndImport();
      if (report) {
        setImportReport(report);
        refreshAll();
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Import impossible', text: errorMessage(err) });
    } finally {
      setImporting(false);
    }
  };

  const exportCsv = async () => {
    try {
      const file = await window.api.clients.exportCsv();
      if (file) {
        toast.push({ tone: 'success', title: 'Export terminé', text: file });
        await window.api.app.revealFile(file);
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec de l’export', text: errorMessage(err) });
    }
  };

  return (
    <>
      <div className="row row--wrap" style={{ marginBottom: 12 }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Nom, ville, e-mail…"
          style={{ width: 270 }}
        />
        <div className="spacer" />
        <div className="row">
          {missingCoords > 0 && (
            <Button
              icon={<Icons.route size={14} />}
              onClick={geocodeMissing}
              loading={geocoding}
              title="Rechercher les coordonnées GPS des adresses importées"
            >
              Géolocaliser {missingCoords}
            </Button>
          )}
          <Button icon={<Icons.download size={14} />} onClick={exportCsv} title="Exporter en CSV" />
          <Button icon={<Icons.upload size={14} />} onClick={runImport} loading={importing}>
            Importer une liste
          </Button>
          <Button variant="primary" icon={<Icons.plus size={14} />} onClick={() => setEditing('new')}>
            Nouveau client
          </Button>
        </div>
      </div>

      {loading && !clients.length ? (
        <div className="empty">
          <Spinner size={22} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="tablewrap">
          <EmptyState
            icon={<Icons.clients size={32} />}
            title={clients.length ? 'Aucun client ne correspond' : 'Aucun client enregistré'}
            text={
              clients.length
                ? 'Modifiez votre recherche.'
                : 'Importez votre liste clients depuis un fichier CSV ou Excel : CompaGelato reconnaît seul les colonnes (nom, adresse, e-mail, SIRET…) et rattachera vos factures aux bonnes fiches.'
            }
            action={
              !clients.length ? (
                <div className="row" style={{ marginTop: 8 }}>
                  <Button variant="primary" icon={<Icons.upload size={14} />} onClick={runImport} loading={importing}>
                    Importer un fichier
                  </Button>
                  <Button onClick={() => setEditing('new')}>Créer à la main</Button>
                </div>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <Th sortKey="code" sort={sort} onSort={toggle}>Code</Th>
                <Th sortKey="name" sort={sort} onSort={toggle}>Nom</Th>
                <Th sortKey="city" sort={sort} onSort={toggle}>Ville</Th>
                <Th sortKey="contact" sort={sort} onSort={toggle}>Contact</Th>
                <Th sortKey="total" sort={sort} onSort={toggle} className="num">Facturé HT</Th>
                <Th sortKey="count" sort={sort} onSort={toggle} className="num">Pièces</Th>
                <Th sortKey="tags" sort={sort} onSort={toggle}>Étiquettes</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((client) => {
                const stats = activity.get(client.id);
                const located = typeof client.address.lat === 'number';
                return (
                  <tr key={client.id} onClick={() => setEditing(client)}>
                    <td className="mono muted">{client.code}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <span style={{ fontWeight: 500 }}>{client.name}</span>
                        {client.archived && <Badge>archivé</Badge>}
                      </div>
                      {client.address.street && (
                        <div className="tiny muted truncate" style={{ maxWidth: 300 }}>
                          {client.address.street}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        {located && (
                          <span title="Position GPS connue — ce client peut être ajouté à une tournée" style={{ color: 'var(--green)' }}>
                            <Icons.route size={12} />
                          </span>
                        )}
                        <span>
                          {client.address.postcode ? `${client.address.postcode} ` : ''}
                          {client.address.city ?? '—'}
                        </span>
                      </div>
                    </td>
                    <td className="tiny">
                      {client.email && <div className="truncate">{client.email}</div>}
                      {client.phone && <div className="muted">{client.phone}</div>}
                      {!client.email && !client.phone && <span className="muted">—</span>}
                    </td>
                    <td className="num">{stats ? euro(stats.total) : '—'}</td>
                    <td className="num muted">{stats?.count ?? 0}</td>
                    <td>
                      <div className="row row--wrap" style={{ gap: 4 }}>
                        {client.tags.slice(0, 2).map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </div>
                    </td>
                    <td style={{ width: 40 }} className="muted">
                      <Icons.chevron size={13} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="row tiny muted" style={{ marginTop: 10 }}>
          {filtered.length} client{filtered.length > 1 ? 's' : ''}
          {clients.length !== filtered.length ? ` sur ${clients.length}` : ''}
          <div className="spacer" />
          {missingCoords > 0 && (
            <span>
              {missingCoords} fiche(s) dont la position GPS est inconnue : elles ne peuvent pas
              encore entrer dans une tournée. Le bouton « Géolocaliser » cherche leur position à
              partir de l’adresse enregistrée.
            </span>
          )}
        </div>
      )}

      {editing && (
        <ClientEditor
          client={editing === 'new' ? null : editing}
          clients={clients}
          onClose={() => setEditing(null)}
          onMerge={(client) => {
            setEditing(null);
            setMerging(client);
          }}
        />
      )}

      {merging && <MergeDialog client={merging} clients={clients} onClose={() => setMerging(null)} />}

      {importReport && <ImportSummary report={importReport} onClose={() => setImportReport(null)} />}
    </>
  );
}

/* ================================================================== */
/* Fiche client                                                        */
/* ================================================================== */

function emptyClient(): Partial<Client> {
  return {
    name: '',
    address: { label: '', country: 'France' },
    tags: [],
    aliases: [],
    archived: false,
  };
}

function ClientEditor({
  client,
  clients,
  onClose,
  onMerge,
}: {
  client: Client | null;
  clients: Client[];
  onClose: () => void;
  onMerge: (client: Client) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Client>>(client ?? emptyClient());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof Client>(key: K, value: Client[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setAddress = (address: Address) =>
    setDraft((d) => ({ ...d, address: { ...(d.address ?? { label: '' }), ...address } }));

  const save = async () => {
    if (!draft.name?.trim()) {
      toast.push({ tone: 'warn', title: 'Nom obligatoire' });
      return;
    }
    setBusy(true);
    try {
      await window.api.clients.save({ ...draft, id: client?.id });
      refreshAll();
      toast.push({ tone: 'success', title: client ? 'Fiche mise à jour' : 'Client créé' });
      onClose();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Enregistrement impossible', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        wide
        title={client ? client.name : 'Nouveau client'}
        subtitle={client ? `${client.code} · créé le ${new Date(client.createdAt).toLocaleDateString('fr-FR')}` : undefined}
        onClose={onClose}
        footer={
          <>
            {client && (
              <>
                <Button variant="danger" icon={<Icons.trash size={14} />} onClick={() => setConfirmDelete(true)}>
                  Supprimer
                </Button>
                <Button onClick={() => onMerge(client)} title="Fusionner avec un doublon">
                  Fusionner
                </Button>
              </>
            )}
            <div className="spacer" />
            <Button onClick={onClose}>Annuler</Button>
            <Button variant="primary" onClick={save} loading={busy}>
              Enregistrer
            </Button>
          </>
        }
      >
        <div className="col" style={{ gap: 15 }}>
          <div className="formgrid">
            <Field label="Nom commercial">
              <Input value={draft.name ?? ''} onChange={(e) => set('name', e.target.value)} autoFocus />
            </Field>
            <Field label="Raison sociale" hint="Telle qu’elle apparaît sur les factures">
              <Input value={draft.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} />
            </Field>
            <Field label="Code client">
              <Input
                value={draft.code ?? ''}
                placeholder="attribué automatiquement"
                onChange={(e) => set('code', e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Adresse"
            hint="Choisissez une proposition pour enregistrer les coordonnées GPS : l’adresse devient utilisable dans le calculateur de tournée."
          >
            <AddressInput
              value={draft.address ?? { label: '' }}
              onChange={setAddress}
            />
          </Field>

          <div className="formgrid">
            <Field label="Code postal">
              <Input
                value={draft.address?.postcode ?? ''}
                onChange={(e) => setAddress({ ...(draft.address as Address), postcode: e.target.value })}
              />
            </Field>
            <Field label="Ville">
              <Input
                value={draft.address?.city ?? ''}
                onChange={(e) => setAddress({ ...(draft.address as Address), city: e.target.value })}
              />
            </Field>
            <Field label="Pays">
              <Input
                value={draft.address?.country ?? 'France'}
                onChange={(e) => setAddress({ ...(draft.address as Address), country: e.target.value })}
              />
            </Field>
          </div>

          <div className="formgrid">
            <Field label="Contact">
              <Input value={draft.contact ?? ''} onChange={(e) => set('contact', e.target.value)} />
            </Field>
            <Field label="E-mail">
              <Input type="email" value={draft.email ?? ''} onChange={(e) => set('email', e.target.value)} />
            </Field>
            <Field label="Téléphone">
              <Input value={draft.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="SIRET">
              <Input value={draft.siret ?? ''} onChange={(e) => set('siret', e.target.value)} />
            </Field>
            <Field label="N° TVA">
              <Input value={draft.vatNumber ?? ''} onChange={(e) => set('vatNumber', e.target.value)} />
            </Field>
            <Field label="Étiquettes" hint="Séparées par des virgules">
              <Input
                value={(draft.tags ?? []).join(', ')}
                onChange={(e) =>
                  set(
                    'tags',
                    e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  )
                }
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea value={draft.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </Field>

          {client && client.aliases.length > 0 && (
            <Field
              label="Autres noms reconnus"
              hint="Orthographes rencontrées sur vos documents comptables, utilisées pour le rattachement automatique."
            >
              <div className="row row--wrap">
                {client.aliases.map((alias) => (
                  <Badge key={alias}>{alias}</Badge>
                ))}
              </div>
            </Field>
          )}
        </div>
      </Modal>

      {client && (
        <ConfirmDialog
          open={confirmDelete}
          danger
          title="Supprimer ce client ?"
          confirmLabel="Supprimer"
          message={`La fiche « ${client.name} » sera supprimée. Ses documents sont conservés mais ne seront plus rattachés à un client.`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await window.api.clients.remove(client.id);
              refreshAll();
              toast.push({ tone: 'success', title: 'Client supprimé' });
              onClose();
            } catch (err) {
              toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
            }
          }}
        />
      )}
    </>
  );
}

/* ================================================================== */
/* Fusion de doublons                                                  */
/* ================================================================== */

function MergeDialog({
  client,
  clients,
  onClose,
}: {
  client: Client;
  clients: Client[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      title="Fusionner deux fiches"
      subtitle={`« ${client.name} » sera conservée`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button
            variant="primary"
            disabled={!target}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await window.api.clients.merge(client.id, target);
                refreshAll();
                toast.push({ tone: 'success', title: 'Fiches fusionnées' });
                onClose();
              } catch (err) {
                toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Fusionner
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 13 }}>
        <div className="infobox">
          Les documents, tournées et informations manquantes de la fiche choisie seront reportés sur
          « {client.name} », puis le doublon sera supprimé.
        </div>
        <Field label="Fiche à absorber">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">— Choisir —</option>
            {clients
              .filter((c) => c.id !== client.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                  {c.address.city ? ` (${c.address.city})` : ''}
                </option>
              ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Résultat d'import                                                   */
/* ================================================================== */

function ImportSummary({ report, onClose }: { report: ImportClientsReport; onClose: () => void }) {
  const mapped = Object.entries(report.mapping);
  const ignored = report.headers.filter((h) => !mapped.some(([, column]) => column === h));

  return (
    <Modal
      open
      title="Import de la liste clients"
      subtitle={`${report.total} ligne(s) lue(s)`}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Terminé</Button>}
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="grid grid--stats">
          <div className="stat stat--ok">
            <div className="stat__label">Créés</div>
            <div className="stat__value">{report.created}</div>
          </div>
          <div className="stat stat--accent">
            <div className="stat__label">Mis à jour</div>
            <div className="stat__value">{report.updated}</div>
          </div>
          <div className={`stat ${report.skipped ? 'stat--warn' : ''}`}>
            <div className="stat__label">Ignorés</div>
            <div className="stat__value">{report.skipped}</div>
          </div>
        </div>

        {report.errors.length > 0 && (
          <div className="warnbox">
            {report.errors.map((error, i) => (
              <div key={i}>{error}</div>
            ))}
          </div>
        )}

        {mapped.length > 0 && (
          <Field label="Colonnes reconnues">
            <div className="tablewrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Colonne du fichier</th>
                    <th>Champ CompaGelato</th>
                  </tr>
                </thead>
                <tbody>
                  {mapped.map(([field, column]) => (
                    <tr key={field}>
                      <td>{column}</td>
                      <td className="muted">{FIELD_LABELS[field] ?? field}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Field>
        )}

        {ignored.length > 0 && (
          <Field label="Colonnes non utilisées">
            <div className="row row--wrap">
              {ignored.map((header) => (
                <Badge key={header}>{header}</Badge>
              ))}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

const FIELD_LABELS: Record<string, string> = {
  code: 'Code client',
  name: 'Nom',
  legalName: 'Raison sociale',
  contact: 'Contact',
  email: 'E-mail',
  phone: 'Téléphone',
  siret: 'SIRET',
  vatNumber: 'N° TVA',
  street: 'Adresse',
  street2: 'Complément d’adresse',
  postcode: 'Code postal',
  city: 'Ville',
  country: 'Pays',
  notes: 'Notes',
  tags: 'Étiquettes',
};
