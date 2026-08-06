import { useEffect, useMemo, useState } from 'react';
import type { BankCategory, BankMatchSuggestion, BankTransaction } from '@shared/types';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Icons,
  IconButton,
  Input,
  Modal,
  SearchInput,
  Segmented,
  Select,
  Spinner,
  Stat,
  Textarea,
  Th,
  useToast,
} from '../components/ui';
import { useSort } from '../lib/sort';
import { matchesAmount } from '../lib/search';
import {
  errorMessage,
  refreshAll,
  useBankSummary,
  useBankTransactions,
  useClientIndex,
  useClients,
  useDocuments,
} from '../lib/data';
import {
  BANK_CATEGORY_LABEL,
  BANK_CATEGORY_TONE,
  dateFr,
  euro,
  matches,
  monthLong,
  percent,
} from '../lib/format';

type FlowFilter = 'all' | 'in' | 'out';
type MatchFilter = 'all' | 'todo' | 'done';

const CATEGORIES = Object.keys(BANK_CATEGORY_LABEL) as BankCategory[];

export function Banque() {
  const { data: transactions, loading } = useBankTransactions();
  const { data: summary } = useBankSummary();
  const { data: clients } = useClients();
  const clientIndex = useClientIndex(clients);
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [flow, setFlow] = useState<FlowFilter>('all');
  const [matchFilter, setMatchFilter] = useState<MatchFilter>('all');
  const [month, setMonth] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState<'all' | BankCategory>('all');
  const [selected, setSelected] = useState<BankTransaction | null>(null);
  const [removing, setRemoving] = useState<BankTransaction | null>(null);
  const [busy, setBusy] = useState(false);

  // La fiche ouverte doit refléter les données rechargées après chaque écriture.
  useEffect(() => {
    if (!selected) return;
    const fresh = transactions.find((t) => t.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [transactions, selected]);

  const months = useMemo(() => {
    const set = new Set(transactions.map((t) => t.date.slice(0, 7)));
    return [...set].sort().reverse();
  }, [transactions]);

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      if (flow === 'in' && t.amount < 0) return false;
      if (flow === 'out' && t.amount >= 0) return false;
      if (matchFilter === 'todo' && (t.documentId || t.amount < 0)) return false;
      if (matchFilter === 'done' && !t.documentId) return false;
      if (month !== 'all' && !t.date.startsWith(month)) return false;
      // Les dates sont au format ISO : la comparaison de chaînes suffit.
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (category !== 'all' && t.category !== category) return false;
      if (!search) return true;
      const client = t.clientId ? clientIndex.get(t.clientId) : undefined;
      // La recherche porte sur le texte *et* sur les montants : taper « 482 »
      // doit retrouver l'opération de 482,96 € comme celle dont le libellé
      // contient 482.
      return (
        matches([t.label, t.reference ?? '', t.note ?? '', client?.name ?? ''].join(' '), search) ||
        matchesAmount(search, [t.amount, t.balance])
      );
    });
  }, [transactions, flow, matchFilter, month, from, to, category, search, clientIndex]);

  const { sorted, sort, toggle } = useSort(
    filtered,
    useMemo(
      () => ({
        date: (t: BankTransaction) => t.date,
        label: (t: BankTransaction) => t.label,
        category: (t: BankTransaction) => BANK_CATEGORY_LABEL[t.category] ?? t.category,
        // Débit et crédit se trient sur la valeur absolue : chaque colonne ne
        // montre qu'un sens, on veut « la plus grosse dépense » en tête.
        debit: (t: BankTransaction) => (t.amount < 0 ? Math.abs(t.amount) : null),
        credit: (t: BankTransaction) => (t.amount > 0 ? t.amount : null),
        balance: (t: BankTransaction) => t.balance ?? null,
        document: (t: BankTransaction) =>
          t.documentId ? 2 : t.amount > 0 ? 1 : null,
      }),
      [],
    ),
    { key: 'date', direction: 'desc' },
  );

  const totals = useMemo(() => {
    let inSum = 0;
    let outSum = 0;
    for (const t of filtered) {
      if (t.amount >= 0) inSum += t.amount;
      else outSum += Math.abs(t.amount);
    }
    return { in: inSum, out: outSum, net: inSum - outSum, count: filtered.length };
  }, [filtered]);

  /* Actions --------------------------------------------------------- */

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      refreshAll();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const scan = () =>
    run(async () => {
      const report = await window.api.bank.scan();
      toast.push({
        tone: report.imported ? 'success' : 'warn',
        title: report.imported ? 'Relevés à jour' : 'Aucune nouvelle opération',
        text: report.imported
          ? `${report.imported} opération(s) ajoutée(s)${report.duplicates ? `, ${report.duplicates} déjà connue(s) ignorée(s)` : ''}${report.reconciled ? `, ${report.reconciled} rapprochée(s) d’une facture` : ''}.`
          : report.files
            ? `${report.files} fichier(s) relu(s), toutes les opérations étaient déjà enregistrées.`
            : 'Aucun relevé trouvé dans le dossier. Vérifiez le dossier configuré dans les réglages.',
      });
    });

  const importOne = () =>
    run(async () => {
      const report = await window.api.bank.pickAndImport();
      if (!report) return;
      if (report.errors.length) {
        toast.push({ tone: 'error', title: 'Lecture impossible', text: report.errors[0] });
        return;
      }
      toast.push({
        tone: report.imported ? 'success' : 'warn',
        title: report.imported ? 'Relevé importé' : 'Relevé déjà enregistré',
        text: `${report.imported} ajoutée(s), ${report.duplicates} déjà connue(s)${report.reconciled ? `, ${report.reconciled} rapprochée(s)` : ''}.`,
      });
      if (report.warnings.length) {
        toast.push({ tone: 'warn', title: 'Remarque', text: report.warnings[0] });
      }
    });

  const autoReconcile = () =>
    run(async () => {
      const result = await window.api.bank.autoReconcile();
      toast.push({
        tone: result.matched ? 'success' : 'warn',
        title: result.matched ? 'Rapprochement effectué' : 'Aucun rapprochement évident',
        text: result.matched
          ? `${result.matched} opération(s) rattachée(s) à une facture${result.ambiguous ? ` — ${result.ambiguous} ambiguë(s) laissée(s) de côté` : ''}.`
          : result.ambiguous
            ? `${result.ambiguous} opération(s) avaient plusieurs factures possibles : à rattacher à la main.`
            : 'Aucune facture ne correspond aux encaissements restants.',
      });
    });

  const exportCsv = async () => {
    try {
      const file = await window.api.bank.exportCsv();
      if (file) {
        toast.push({ tone: 'success', title: 'Export terminé', text: file });
        await window.api.app.revealFile(file);
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec de l’export', text: errorMessage(err) });
    }
  };

  const setCategoryOf = (tx: BankTransaction, next: BankCategory) =>
    run(async () => {
      await window.api.bank.update(tx.id, { category: next });
    });

  if (loading) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 48 }}>
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      {summary && transactions.length > 0 && (
        <div className="grid grid--stats">
          <Stat
            label="Encaissements"
            value={euro(summary.totalIn)}
            hint={summary.from ? `depuis le ${dateFr(summary.from)}` : undefined}
            tone="ok"
            icon={<Icons.euro size={16} />}
          />
          <Stat
            label="Décaissements"
            value={euro(summary.totalOut)}
            hint={`${transactions.length} opération(s)`}
            tone="danger"
            icon={<Icons.box size={16} />}
          />
          <Stat
            label="Solde de la période"
            value={euro(summary.net)}
            hint={summary.net >= 0 ? 'excédent' : 'déficit'}
            tone={summary.net >= 0 ? 'ok' : 'danger'}
            icon={<Icons.scale size={16} />}
          />
          <Stat
            label="Solde du compte"
            value={summary.balance !== undefined ? euro(summary.balance) : '—'}
            hint={
              summary.balanceDate
                ? `au ${dateFr(summary.balanceDate)}`
                : 'absent du relevé'
            }
            icon={<Icons.bank size={16} />}
          />
          <Stat
            label="Encaissements à rapprocher"
            value={String(summary.unreconciled)}
            hint={summary.unreconciled ? euro(summary.unreconciledAmount) : 'tout est rapproché'}
            tone={summary.unreconciled ? 'warn' : 'ok'}
            icon={<Icons.link size={16} />}
          />
        </div>
      )}

      <div className="row row--wrap" style={{ gap: 10 }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Libellé, client, montant…"
          style={{ minWidth: 240 }}
        />
        <Segmented
          value={flow}
          onChange={setFlow}
          options={[
            { value: 'all', label: 'Tout' },
            { value: 'in', label: 'Entrées' },
            { value: 'out', label: 'Sorties' },
          ]}
        />
        <Segmented
          value={matchFilter}
          onChange={setMatchFilter}
          options={[
            { value: 'all', label: 'Toutes' },
            { value: 'todo', label: 'À rapprocher' },
            { value: 'done', label: 'Rapprochées' },
          ]}
        />
        <Select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }}>
          <option value="all">Tous les mois</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLong(m)}
            </option>
          ))}
        </Select>
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value as 'all' | BankCategory)}
          style={{ width: 'auto' }}
        >
          <option value="all">Toutes les catégories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {BANK_CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="tiny muted">Du</span>
          <Input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            style={{ width: 148 }}
            title="Début de la période"
          />
          <span className="tiny muted">au</span>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            style={{ width: 148 }}
            title="Fin de la période"
          />
          {(from || to) && (
            <IconButton
              title="Effacer la période"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              <Icons.close size={14} />
            </IconButton>
          )}
        </div>
        <div className="spacer" />
        <Button icon={<Icons.link size={14} />} onClick={autoReconcile} disabled={busy}>
          Rapprocher
        </Button>
        <Button icon={<Icons.upload size={14} />} onClick={importOne} disabled={busy}>
          Importer un relevé
        </Button>
        <Button icon={<Icons.download size={14} />} onClick={exportCsv} disabled={!transactions.length}>
          Exporter
        </Button>
        <Button variant="primary" icon={<Icons.refresh size={14} />} onClick={scan} loading={busy}>
          Analyser le dossier
        </Button>
      </div>

      {!filtered.length ? (
        <div className="card">
          <EmptyState
            icon={<Icons.bank size={32} />}
            title={transactions.length ? 'Aucune opération ne correspond' : 'Aucun relevé importé'}
            text={
              transactions.length
                ? 'Modifiez les filtres ou la recherche.'
                : 'Déposez vos relevés de compte (CSV ou Excel exportés par la banque) dans le dossier des relevés : ils seront lus automatiquement, sans jamais créer de doublon. Le dossier se règle dans Réglages.'
            }
            action={
              !transactions.length ? (
                <div className="row" style={{ gap: 8 }}>
                  <Button variant="primary" onClick={scan} loading={busy}>
                    Analyser le dossier
                  </Button>
                  <Button onClick={importOne} disabled={busy}>
                    Choisir un fichier
                  </Button>
                </div>
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
                  <Th sortKey="date" sort={sort} onSort={toggle}>Date</Th>
                  <Th sortKey="label" sort={sort} onSort={toggle}>Libellé</Th>
                  <Th sortKey="category" sort={sort} onSort={toggle}>Catégorie</Th>
                  <Th sortKey="debit" sort={sort} onSort={toggle} className="num">Débit</Th>
                  <Th sortKey="credit" sort={sort} onSort={toggle} className="num">Crédit</Th>
                  <Th sortKey="balance" sort={sort} onSort={toggle} className="num">Solde</Th>
                  <Th sortKey="document" sort={sort} onSort={toggle}>Facture</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((tx) => {
                  const client = tx.clientId ? clientIndex.get(tx.clientId) : undefined;
                  return (
                    <tr key={tx.id} onClick={() => setSelected(tx)} style={{ cursor: 'default' }}>
                      <td className="muted">{dateFr(tx.date)}</td>
                      <td>
                        <span className="truncate" style={{ fontWeight: 500 }}>
                          {tx.label}
                        </span>
                        {client && <div className="tiny muted truncate">{client.name}</div>}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <Select
                          value={tx.category}
                          onChange={(e) => setCategoryOf(tx, e.target.value as BankCategory)}
                          title={
                            tx.categoryAuto
                              ? 'Catégorie déduite du libellé — modifiable'
                              : 'Catégorie choisie à la main'
                          }
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {BANK_CATEGORY_LABEL[c]}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="num" style={{ color: tx.amount < 0 ? 'var(--red)' : undefined }}>
                        {tx.amount < 0 ? euro(Math.abs(tx.amount)) : ''}
                      </td>
                      <td className="num" style={{ color: tx.amount > 0 ? 'var(--green)' : undefined, fontWeight: 500 }}>
                        {tx.amount > 0 ? euro(tx.amount) : ''}
                      </td>
                      <td className="num muted">{tx.balance !== undefined ? euro(tx.balance) : ''}</td>
                      <td>
                        {tx.documentId ? (
                          <Badge tone="badge--green">
                            {tx.matchAuto ? 'Auto' : 'Rapproché'}
                          </Badge>
                        ) : tx.amount > 0 ? (
                          <Badge tone="badge--orange">À rapprocher</Badge>
                        ) : (
                          <span className="muted tiny">—</span>
                        )}
                      </td>
                      <td style={{ width: 44 }} onClick={(e) => e.stopPropagation()}>
                        <IconButton title="Détail et rapprochement" onClick={() => setSelected(tx)}>
                          <Icons.chevron size={15} />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="muted">
                    {totals.count} opération(s)
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {euro(totals.out)}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {euro(totals.in)}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {euro(totals.net)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>

          {summary && summary.categories.length > 0 && (
            <div className="row row--wrap" style={{ gap: 18, alignItems: 'flex-start' }}>
              <Card title="Où part l’argent" subtitle="Dépenses par catégorie sur toute la période">
                <div className="list">
                  {summary.categories
                    .filter((c) => c.out > 0)
                    .map((c) => (
                      <div key={c.category} className="list__item">
                        <Badge tone={BANK_CATEGORY_TONE[c.category]}>
                          {BANK_CATEGORY_LABEL[c.category]}
                        </Badge>
                        <div className="spacer" />
                        <span className="tiny muted">{c.count} op.</span>
                        <span className="num" style={{ fontWeight: 500, minWidth: 92, textAlign: 'right' }}>
                          {euro(c.out)}
                        </span>
                        <span className="tiny muted" style={{ minWidth: 44, textAlign: 'right' }}>
                          {summary.totalOut ? percent(c.out / summary.totalOut) : '—'}
                        </span>
                      </div>
                    ))}
                </div>
              </Card>

              <Card title="Trésorerie mois par mois" subtitle="Entrées, sorties et solde de fin de mois">
                <div className="list">
                  {[...summary.months].reverse().map((m) => (
                    <div key={m.month} className="list__item">
                      <span style={{ minWidth: 118, textTransform: 'capitalize' }}>{monthLong(m.month)}</span>
                      <div className="spacer" />
                      <span className="num tiny" style={{ color: 'var(--green)', minWidth: 88, textAlign: 'right' }}>
                        +{euro(m.in)}
                      </span>
                      <span className="num tiny" style={{ color: 'var(--red)', minWidth: 88, textAlign: 'right' }}>
                        −{euro(m.out)}
                      </span>
                      <span
                        className="num"
                        style={{ fontWeight: 600, minWidth: 92, textAlign: 'right' }}
                        title="Résultat du mois"
                      >
                        {euro(m.net)}
                      </span>
                      <span className="num tiny muted" style={{ minWidth: 92, textAlign: 'right' }}>
                        {m.balance !== undefined ? euro(m.balance) : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}
        </>
      )}

      {selected && (
        <TransactionDetail
          transaction={selected}
          onClose={() => setSelected(null)}
          onDelete={() => {
            setRemoving(selected);
            setSelected(null);
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(removing)}
        title="Supprimer cette opération ?"
        message={
          <>
            L’opération «&nbsp;{removing?.label}&nbsp;» sera retirée du tableau. Elle sera réimportée
            au prochain passage si elle figure toujours dans un relevé du dossier.
          </>
        }
        confirmLabel="Supprimer"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const target = removing;
          setRemoving(null);
          if (!target) return;
          await run(async () => {
            await window.api.bank.remove(target.id);
            toast.push({ tone: 'success', title: 'Opération supprimée' });
          });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Détail d'une opération                                              */
/* ------------------------------------------------------------------ */

function TransactionDetail({
  transaction,
  onClose,
  onDelete,
}: {
  transaction: BankTransaction;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { data: documents } = useDocuments();
  const { data: clients } = useClients();
  const clientIndex = useClientIndex(clients);
  const toast = useToast();

  const [suggestions, setSuggestions] = useState<BankMatchSuggestion[] | null>(null);
  const [note, setNote] = useState(transaction.note ?? '');
  const [busy, setBusy] = useState(false);

  const linked = transaction.documentId
    ? documents.find((d) => d.id === transaction.documentId)
    : undefined;

  useEffect(() => {
    let cancelled = false;
    setSuggestions(null);
    if (transaction.documentId) return;
    window.api.bank
      .suggestions(transaction.id)
      .then((list) => {
        if (!cancelled) setSuggestions(list);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [transaction.id, transaction.documentId]);

  const run = async (action: () => Promise<void>, success?: string) => {
    setBusy(true);
    try {
      await action();
      refreshAll();
      if (success) toast.push({ tone: 'success', title: success });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const client = transaction.clientId ? clientIndex.get(transaction.clientId) : undefined;

  return (
    <Modal
      open
      wide
      title={transaction.label}
      subtitle={`${dateFr(transaction.date)} — ${euro(transaction.amount)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" icon={<Icons.trash size={14} />} onClick={onDelete} disabled={busy}>
            Supprimer
          </Button>
          <div className="spacer" />
          <Button onClick={onClose}>Fermer</Button>
        </>
      }
    >
      <div className="formgrid">
        <Field label="Date d’opération">
          <Input value={dateFr(transaction.date)} readOnly />
        </Field>
        <Field label="Date de valeur">
          <Input value={transaction.valueDate ? dateFr(transaction.valueDate) : '—'} readOnly />
        </Field>
        <Field label="Montant">
          <Input value={euro(transaction.amount)} readOnly />
        </Field>
        <Field label="Solde après opération">
          <Input value={transaction.balance !== undefined ? euro(transaction.balance) : '—'} readOnly />
        </Field>
        <Field label="Catégorie" hint={transaction.categoryAuto ? 'Déduite du libellé' : 'Choisie à la main'}>
          <Select
            value={transaction.category}
            disabled={busy}
            onChange={(e) =>
              run(async () => {
                await window.api.bank.update(transaction.id, {
                  category: e.target.value as BankCategory,
                });
              })
            }
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {BANK_CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Référence">
          <Input value={transaction.reference ?? '—'} readOnly />
        </Field>
      </div>

      <div className="divider" />

      <h4 style={{ margin: '0 0 10px' }}>Rapprochement</h4>

      {linked ? (
        <div className="infobox">
          <div className="row row--between" style={{ gap: 12 }}>
            <div className="col" style={{ gap: 2 }}>
              <strong>
                {linked.number} — {client?.name ?? linked.clientNameRaw ?? 'Client inconnu'}
              </strong>
              <span className="tiny muted">
                {dateFr(linked.date)} · {euro(linked.totalTTC)} ·{' '}
                {transaction.matchAuto
                  ? `rapproché automatiquement${transaction.matchScore ? ` (${percent(transaction.matchScore)} de confiance)` : ''}`
                  : 'rapproché à la main'}
              </span>
            </div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await window.api.bank.reconcile(transaction.id, null);
                }, 'Rapprochement annulé')
              }
            >
              Détacher
            </Button>
          </div>
        </div>
      ) : transaction.amount < 0 ? (
        <p className="muted tiny" style={{ margin: 0 }}>
          Les décaissements ne se rapprochent que d’un avoir. Classez plutôt cette dépense avec la
          catégorie ci-dessus.
        </p>
      ) : suggestions === null ? (
        <div className="row" style={{ gap: 8 }}>
          <Spinner /> <span className="tiny muted">Recherche des factures correspondantes…</span>
        </div>
      ) : !suggestions.length ? (
        <p className="muted tiny" style={{ margin: 0 }}>
          Aucune facture ne correspond à cet encaissement (ni par le montant, ni par le numéro, ni
          par le nom du client).
        </p>
      ) : (
        <div className="list">
          {suggestions.map((s) => (
            <div key={s.documentId} className="list__item">
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <span className="truncate">
                  <strong>{s.number}</strong> — {s.clientName}
                </span>
                <span className="tiny muted truncate">
                  {dateFr(s.date)} · {euro(s.totalTTC)} · {s.reason}
                </span>
              </div>
              <div className="spacer" />
              <Badge tone={s.score >= 0.75 ? 'badge--green' : 'badge--orange'}>{percent(s.score)}</Badge>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await window.api.bank.reconcile(transaction.id, s.documentId);
                  }, 'Facture rapprochée et marquée réglée')
                }
              >
                Rattacher
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="divider" />

      <Field label="Note">
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note === (transaction.note ?? '')) return;
            void run(async () => {
              await window.api.bank.update(transaction.id, { note });
            });
          }}
          placeholder="Précision à conserver sur cette opération…"
        />
      </Field>

      {transaction.sourceFile && (
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>
          Lu depuis {transaction.sourceFile}
        </p>
      )}
    </Modal>
  );
}
