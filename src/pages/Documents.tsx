import { useEffect, useMemo, useState } from 'react';
import type { AccountingDocument, Client, DocumentLine, Product } from '@shared/types';
import type { ProductSuggestion } from '@shared/api';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Icons,
  IconButton,
  Modal,
  SearchInput,
  Segmented,
  Select,
  Spinner,
  useToast,
} from '../components/ui';
import {
  errorMessage,
  refreshAll,
  useClientIndex,
  useClients,
  useDocuments,
  useProductIndex,
  useProducts,
} from '../lib/data';
import { dateFr, euro, KIND_LABEL, matches, num, percent, STATUS_LABEL, STATUS_TONE } from '../lib/format';

type KindFilter = 'all' | 'invoice' | 'quote' | 'credit';
type StockFilter = 'all' | 'todo' | 'done';

export function Documents({ scanning, onScan }: { scanning: boolean; onScan: (force?: boolean) => void }) {
  const { data: documents, loading } = useDocuments();
  const { data: clients } = useClients();
  const { data: products } = useProducts();
  const clientIndex = useClientIndex(clients);
  const productIndex = useProductIndex(products);
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [selected, setSelected] = useState<AccountingDocument | null>(null);
  const [busy, setBusy] = useState(false);

  // La fiche ouverte doit refléter les données rechargées après chaque écriture.
  useEffect(() => {
    if (!selected) return;
    const fresh = documents.find((d) => d.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [documents, selected]);

  const filtered = useMemo(() => {
    return documents.filter((doc) => {
      if (kind !== 'all' && doc.kind !== kind) return false;
      if (stockFilter === 'todo' && (doc.stockApplied || doc.kind === 'quote')) return false;
      if (stockFilter === 'done' && !doc.stockApplied) return false;
      if (!search) return true;
      const client = doc.clientId ? clientIndex.get(doc.clientId) : undefined;
      const haystack = [doc.number, doc.clientNameRaw ?? '', client?.name ?? '', doc.notes ?? '']
        .join(' ');
      return matches(haystack, search);
    });
  }, [documents, kind, stockFilter, search, clientIndex]);

  const totals = useMemo(() => {
    const sign = (d: AccountingDocument) => (d.kind === 'credit' ? -1 : 1);
    const billable = filtered.filter((d) => d.kind !== 'quote' && d.status !== 'cancelled');
    return {
      ht: billable.reduce((s, d) => s + sign(d) * d.totalHT, 0),
      ttc: billable.reduce((s, d) => s + sign(d) * d.totalTTC, 0),
      count: filtered.length,
    };
  }, [filtered]);

  const applyAll = async () => {
    setBusy(true);
    try {
      const result = await window.api.stock.applyAll();
      toast.push({
        tone: result.applied ? 'success' : 'warn',
        title: result.applied ? 'Stock mis à jour' : 'Rien à déduire',
        text: result.applied
          ? `${result.applied} ligne(s) déduite(s) sur ${result.reports.length} document(s).`
          : 'Aucune ligne des documents en attente n’est associée à un produit du stock.',
      });
      refreshAll();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    try {
      const file = await window.api.documents.exportCsv();
      if (file) {
        toast.push({ tone: 'success', title: 'Export terminé', text: file });
        await window.api.app.revealFile(file);
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec de l’export', text: errorMessage(err) });
    }
  };

  const pendingCount = documents.filter((d) => !d.stockApplied && d.kind !== 'quote' && d.status !== 'cancelled').length;

  return (
    <>
      <div className="row row--wrap" style={{ marginBottom: 12 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Numéro, client…" style={{ width: 250 }} />
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'Tout' },
            { value: 'invoice', label: 'Factures' },
            { value: 'quote', label: 'Devis' },
            { value: 'credit', label: 'Avoirs' },
          ]}
        />
        <Segmented
          value={stockFilter}
          onChange={setStockFilter}
          options={[
            { value: 'all', label: 'Tous stocks' },
            { value: 'todo', label: 'À déduire' },
            { value: 'done', label: 'Déduits' },
          ]}
        />
        <div className="spacer" />
        {pendingCount > 0 && (
          <Button icon={<Icons.stock size={14} />} onClick={applyAll} loading={busy}>
            Déduire {pendingCount} document{pendingCount > 1 ? 's' : ''}
          </Button>
        )}
        <Button icon={<Icons.download size={14} />} onClick={exportCsv} title="Exporter en CSV" />
        <Button
          variant="primary"
          icon={<Icons.refresh size={14} />}
          onClick={() => onScan(false)}
          loading={scanning}
        >
          Analyser le dossier
        </Button>
      </div>

      {loading && !documents.length ? (
        <div className="empty">
          <Spinner size={22} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="tablewrap">
          <EmptyState
            icon={<Icons.documents size={32} />}
            title={documents.length ? 'Aucun document ne correspond' : 'Aucun document importé'}
            text={
              documents.length
                ? 'Modifiez les filtres ou la recherche.'
                : 'Déposez vos factures et devis (PDF, Factur-X, XML, CSV, Excel) dans le dossier surveillé : ils seront lus automatiquement et ajoutés à ce tableau.'
            }
            action={
              !documents.length ? (
                <Button variant="primary" onClick={() => onScan(true)} loading={scanning}>
                  Analyser le dossier maintenant
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Numéro</th>
                  <th>Date</th>
                  <th>Client</th>
                  <th className="num">Total HT</th>
                  <th className="num">Total TTC</th>
                  <th>Statut</th>
                  <th>Stock</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((doc) => {
                  const client = doc.clientId ? clientIndex.get(doc.clientId) : undefined;
                  const hasWarnings = doc.warnings.length > 0 || doc.confidence < 0.7;
                  return (
                    <tr key={doc.id} onClick={() => setSelected(doc)} style={{ cursor: 'default' }}>
                      <td>
                        <Badge
                          tone={
                            doc.kind === 'quote'
                              ? 'badge--purple'
                              : doc.kind === 'credit'
                                ? 'badge--orange'
                                : 'badge--blue'
                          }
                        >
                          {KIND_LABEL[doc.kind]}
                        </Badge>
                      </td>
                      <td style={{ fontWeight: 500 }}>{doc.number}</td>
                      <td className="muted">{dateFr(doc.date)}</td>
                      <td>
                        {client ? (
                          <span className="truncate">{client.name}</span>
                        ) : (
                          <span className="muted truncate">
                            {doc.clientNameRaw ? `${doc.clientNameRaw} (non rattaché)` : 'Non identifié'}
                          </span>
                        )}
                      </td>
                      <td className="num">{euro(doc.totalHT)}</td>
                      <td className="num" style={{ fontWeight: 500 }}>
                        {euro(doc.totalTTC)}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[doc.status]}>{STATUS_LABEL[doc.status]}</Badge>
                      </td>
                      <td>
                        {doc.kind === 'quote' ? (
                          <span className="muted tiny">—</span>
                        ) : doc.stockApplied ? (
                          <Badge tone="badge--green">Déduit</Badge>
                        ) : (
                          <Badge tone="badge--orange">À déduire</Badge>
                        )}
                      </td>
                      <td style={{ width: 34 }}>
                        {hasWarnings && (
                          <span title={doc.warnings.join('\n') || 'Lecture incertaine'} style={{ color: 'var(--orange)' }}>
                            <Icons.warning size={14} />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 10, fontSize: 12.5 }}>
            <span className="muted">
              {totals.count} document{totals.count > 1 ? 's' : ''}
            </span>
            <div className="spacer" />
            <span className="muted">Total facturé :</span>
            <strong>{euro(totals.ht)} HT</strong>
            <span className="muted">·</span>
            <strong>{euro(totals.ttc)} TTC</strong>
          </div>
        </>
      )}

      {selected && (
        <DocumentDetail
          document={selected}
          clients={clients}
          products={products}
          productIndex={productIndex}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/* ================================================================== */
/* Fiche document                                                      */
/* ================================================================== */

function DocumentDetail({
  document: doc,
  clients,
  products,
  productIndex,
  onClose,
}: {
  document: AccountingDocument;
  clients: Client[];
  products: Product[];
  productIndex: Map<string, Product>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linking, setLinking] = useState<DocumentLine | null>(null);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      refreshAll();
      if (success) toast.push({ tone: 'success', title: success });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Opération impossible', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const unmatchedCount = doc.lines.filter((l) => !l.productId).length;
  const linesTotal = doc.lines.reduce((s, l) => s + (l.totalHT ?? 0), 0);

  return (
    <>
      <Modal
        open
        wide
        title={`${KIND_LABEL[doc.kind]} ${doc.number}`}
        subtitle={`${dateFr(doc.date)}${doc.dueDate ? ` · échéance ${dateFr(doc.dueDate)}` : ''} · ${euro(doc.totalTTC)} TTC`}
        onClose={onClose}
        footer={
          <>
            <Button variant="danger" icon={<Icons.trash size={14} />} onClick={() => setConfirmDelete(true)}>
              Supprimer
            </Button>
            <div className="spacer" />
            {doc.sourceFile && (
              <>
                <Button
                  icon={<Icons.folder size={14} />}
                  onClick={() => window.api.app.revealFile(doc.sourceFile as string)}
                >
                  Voir le fichier
                </Button>
                <Button
                  icon={<Icons.refresh size={14} />}
                  loading={busy}
                  onClick={() =>
                    run(() => window.api.documents.rescanFile(doc.sourceFile as string), 'Document relu')
                  }
                >
                  Relire
                </Button>
              </>
            )}
            {doc.kind !== 'quote' &&
              (doc.stockApplied ? (
                <Button
                  loading={busy}
                  onClick={() => run(() => window.api.stock.revert(doc.id), 'Déduction annulée')}
                >
                  Annuler la déduction
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<Icons.stock size={14} />}
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const report = await window.api.stock.apply(doc.id);
                      refreshAll();
                      toast.push({
                        tone: report.applied ? 'success' : 'warn',
                        title: report.applied ? 'Stock déduit' : 'Aucune déduction',
                        text: report.message,
                      });
                    } catch (err) {
                      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Déduire du stock
                </Button>
              ))}
          </>
        }
      >
        <div className="col" style={{ gap: 15 }}>
          {doc.warnings.length > 0 && (
            <div className="warnbox">
              <strong>Points à vérifier</strong>
              <ul style={{ margin: '4px 0 0 16px' }}>
                {doc.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="formgrid">
            <Field label="Client rattaché" hint="Sert au regroupement des pièces et aux tournées.">
              <Select
                value={doc.clientId ?? ''}
                disabled={busy}
                onChange={(e) =>
                  run(() => window.api.documents.setClient(doc.id, e.target.value || null), 'Client mis à jour')
                }
              >
                <option value="">— Non rattaché —</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                    {client.address.city ? ` — ${client.address.city}` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Statut">
              <Select
                value={doc.status}
                disabled={busy}
                onChange={(e) =>
                  run(
                    () =>
                      window.api.documents.setStatus(
                        doc.id,
                        e.target.value as AccountingDocument['status'],
                      ),
                    'Statut mis à jour',
                  )
                }
              >
                <option value="draft">Brouillon</option>
                <option value="confirmed">Validé</option>
                <option value="paid">Réglé</option>
                <option value="cancelled">Annulé</option>
              </Select>
            </Field>

            <Field label="Fiabilité de la lecture">
              <div className="row" style={{ height: 30 }}>
                <div className="progress" style={{ flex: 1 }}>
                  <div
                    className="progress__bar"
                    style={{
                      width: `${Math.round(doc.confidence * 100)}%`,
                      background:
                        doc.confidence > 0.8
                          ? 'var(--green)'
                          : doc.confidence > 0.55
                            ? 'var(--orange)'
                            : 'var(--red)',
                    }}
                  />
                </div>
                <span className="tiny muted" style={{ minWidth: 34 }}>
                  {percent(doc.confidence)}
                </span>
              </div>
            </Field>

            <Field label="Origine">
              <div className="row" style={{ height: 30 }}>
                <Badge tone={doc.sourceFormat === 'facturx' ? 'badge--green' : ''}>
                  {doc.sourceFormat === 'facturx'
                    ? 'Factur-X (structuré)'
                    : doc.sourceFormat === 'pdf'
                      ? 'PDF (lecture visuelle)'
                      : doc.sourceFormat === 'manual'
                        ? 'Saisie manuelle'
                        : (doc.sourceFormat ?? '—').toUpperCase()}
                </Badge>
              </div>
            </Field>
          </div>

          <div>
            <div className="row row--between" style={{ marginBottom: 7 }}>
              <div className="card__title">Lignes du document</div>
              {unmatchedCount > 0 && (
                <span className="tiny" style={{ color: 'var(--orange)' }}>
                  {unmatchedCount} ligne(s) sans produit associé — elles ne seront pas déduites du stock
                </span>
              )}
            </div>
            <div className="tablewrap">
              {doc.lines.length === 0 ? (
                <EmptyState
                  title="Aucune ligne détaillée"
                  text="Ce document n’expose pas le détail de ses articles : le stock ne peut pas être déduit automatiquement."
                />
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Réf.</th>
                      <th>Désignation</th>
                      <th className="num">Qté</th>
                      <th className="num">P.U. HT</th>
                      <th className="num">Total HT</th>
                      <th>Produit du stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.lines.map((line) => {
                      const product = line.productId ? productIndex.get(line.productId) : undefined;
                      return (
                        <tr key={line.id}>
                          <td className="mono muted">{line.ref ?? '—'}</td>
                          <td>{line.label}</td>
                          <td className="num">
                            {num(line.qty)} {line.unit ?? ''}
                          </td>
                          <td className="num">{line.unitPriceHT !== undefined ? euro(line.unitPriceHT) : '—'}</td>
                          <td className="num">{line.totalHT !== undefined ? euro(line.totalHT) : '—'}</td>
                          <td>
                            {product ? (
                              <button
                                className="btn btn--ghost btn--sm"
                                onClick={() => setLinking(line)}
                                disabled={doc.stockApplied}
                                title={doc.stockApplied ? 'Annulez la déduction pour modifier' : 'Changer le produit'}
                              >
                                <span
                                  className="dot"
                                  style={{
                                    background:
                                      line.matchMethod === 'fuzzy' ? 'var(--orange)' : 'var(--green)',
                                  }}
                                />
                                <span className="truncate" style={{ maxWidth: 170 }}>
                                  {product.name}
                                </span>
                              </button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => setLinking(line)}
                                disabled={doc.stockApplied}
                                icon={<Icons.link size={12} />}
                              >
                                Associer
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {doc.lines.length > 0 && (
              <div className="row" style={{ marginTop: 8, fontSize: 12.5 }}>
                <span className="muted">Somme des lignes : {euro(linesTotal)}</span>
                <div className="spacer" />
                <span className="muted">Total HT déclaré : {euro(doc.totalHT)}</span>
                <span className="muted">· TVA : {euro(doc.totalVAT)}</span>
                <strong>· TTC : {euro(doc.totalTTC)}</strong>
              </div>
            )}
          </div>

          {doc.sourceFile && (
            <div className="tiny muted" style={{ overflowWrap: 'anywhere' }}>
              Fichier source : {doc.sourceFile}
            </div>
          )}
        </div>
      </Modal>

      {linking && (
        <LinkProductDialog
          documentId={doc.id}
          line={linking}
          products={products}
          onClose={() => setLinking(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Supprimer ce document ?"
        confirmLabel="Supprimer"
        message={
          <>
            <p>
              {KIND_LABEL[doc.kind]} <strong>{doc.number}</strong> sera retirée de CompaGelato.
              {doc.stockApplied && ' Les quantités déduites seront rendues au stock.'}
            </p>
            <p className="muted" style={{ marginTop: 8 }}>
              Le fichier d’origine n’est pas supprimé du disque. Il sera réimporté à la prochaine
              analyse du dossier.
            </p>
          </>
        }
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          await run(() => window.api.documents.remove(doc.id), 'Document supprimé');
          onClose();
        }}
      />
    </>
  );
}

/* ================================================================== */
/* Association ligne ↔ produit                                         */
/* ================================================================== */

function LinkProductDialog({
  documentId,
  line,
  products,
  onClose,
}: {
  documentId: string;
  line: DocumentLine;
  products: Product[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.api.stock
      .suggestions(line.label, line.ref)
      .then(setSuggestions)
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false));
  }, [line]);

  const link = async (productId: string | null) => {
    try {
      await window.api.stock.linkLine(documentId, line.id, productId);
      refreshAll();
      toast.push({
        tone: 'success',
        title: productId ? 'Produit associé' : 'Association retirée',
        text: productId
          ? 'Le libellé est mémorisé : les prochaines factures seront reconnues automatiquement.'
          : undefined,
      });
      onClose();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
    }
  };

  const listed = search
    ? products.filter((p) => matches(`${p.sku} ${p.name} ${p.category ?? ''}`, search))
    : [];

  return (
    <Modal
      open
      title="Associer au stock"
      subtitle={line.label}
      onClose={onClose}
      footer={
        <>
          {line.productId && (
            <Button variant="danger" onClick={() => link(null)}>
              Retirer l’association
            </Button>
          )}
          <div className="spacer" />
          <Button onClick={onClose}>Fermer</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 13 }}>
        <div className="infobox">
          Une fois associé, le libellé « {line.label} » sera reconnu automatiquement sur les
          prochaines factures de votre logiciel de comptabilité.
        </div>

        <SearchInput value={search} onChange={setSearch} placeholder="Chercher un consommable…" />

        {loading ? (
          <div className="row" style={{ justifyContent: 'center', padding: 20 }}>
            <Spinner />
          </div>
        ) : (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Désignation</th>
                  <th className="num">Stock</th>
                  <th>{search ? '' : 'Correspondance'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(search ? listed.map((product) => ({ product, score: 0, reason: '' })) : suggestions).map(
                  ({ product, score, reason }) => (
                    <tr key={product.id} data-selected={product.id === line.productId}>
                      <td className="mono muted">{product.sku}</td>
                      <td>{product.name}</td>
                      <td className="num">
                        {num(product.qtyOnHand)} {product.unit}
                      </td>
                      <td className="tiny muted">
                        {reason && (
                          <>
                            {reason} · {percent(score)}
                          </>
                        )}
                      </td>
                      <td style={{ width: 90 }}>
                        <Button
                          size="sm"
                          variant={product.id === line.productId ? 'default' : 'primary'}
                          disabled={product.id === line.productId}
                          onClick={() => link(product.id)}
                        >
                          {product.id === line.productId ? 'Associé' : 'Choisir'}
                        </Button>
                      </td>
                    </tr>
                  ),
                )}
                {!search && suggestions.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="muted" style={{ padding: 12, textAlign: 'center' }}>
                        Aucune correspondance trouvée. Utilisez la recherche ci-dessus.
                      </div>
                    </td>
                  </tr>
                )}
                {search && listed.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="muted" style={{ padding: 12, textAlign: 'center' }}>
                        Aucun consommable ne correspond à « {search} ».
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
