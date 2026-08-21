import { useMemo, useState } from 'react';
import type { InvoicedAs, Product, ProductType, StockMove } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  SearchInput,
  Segmented,
  Select,
  Spinner,
  Stat,
  Textarea,
  Th,
  useToast,
} from '../components/ui';
import { errorMessage, refreshAll, useProducts, useStockMoves } from '../lib/data';
import { dateFr, euro, marginRate, matches, num, priceTtc } from '../lib/format';
import { useSort } from '../lib/sort';
import { matchesAmount } from '../lib/search';

type Filter = 'all' | 'low' | 'out';

const TYPE_LABEL: Record<ProductType, string> = {
  consumable: 'Consommable',
  mixLiquid: 'Mix liquide',
  mixPowder: 'Mix poudre',
  machine: 'Machine',
  part: 'Pièce détachée',
};

const TYPE_TONE: Record<ProductType, string> = {
  consumable: '',
  mixLiquid: 'badge--blue',
  mixPowder: 'badge--orange',
  machine: 'badge--purple',
  part: 'badge--green',
};

const INVOICED_LABEL: Record<InvoicedAs, string> = {
  unit: 'À l’unité',
  case: 'Au carton',
  measure: 'À la mesure (kg, L)',
};

const ALL_TYPES: ProductType[] = ['consumable', 'mixLiquid', 'mixPowder', 'machine', 'part'];

/** Le conditionnement n'a de sens que pour ce qui se conditionne. */
function hasPackaging(type: ProductType): boolean {
  return type === 'mixLiquid' || type === 'mixPowder' || type === 'consumable';
}

/** Valeurs de départ, tirées des conditionnements réels des factures. */
function packagingDefaults(type: ProductType): Partial<Product> {
  switch (type) {
    case 'mixLiquid':
      return { unit: 'poche', packSize: 4.5, packMeasure: 'kg', unitsPerCase: 2, invoicedAs: 'unit' };
    case 'mixPowder':
      return { unit: 'poche', packSize: 2.5, packMeasure: 'kg', unitsPerCase: undefined, invoicedAs: 'measure' };
    case 'machine':
    case 'part':
      return { unit: 'pièce', packSize: undefined, packMeasure: undefined, unitsPerCase: undefined, invoicedAs: 'unit' };
    default:
      return { unit: 'pièce', invoicedAs: 'unit' };
  }
}

export function Stock() {
  const { data: products, loading } = useProducts();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | ProductType>('all');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [history, setHistory] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);

  const filtered = useMemo(
    () =>
      products.filter((product) => {
        if (filter === 'low' && !(product.minQty > 0 && product.qtyOnHand < product.minQty)) return false;
        if (filter === 'out' && product.qtyOnHand > 0) return false;
        if (typeFilter !== 'all' && (product.type ?? 'consumable') !== typeFilter) return false;
        return (
          matches(
            [product.sku, product.name, product.category ?? '', product.supplier ?? '', product.aliases.join(' ')].join(' '),
            search,
          ) ||
          matchesAmount(search, [
            product.unitCost,
            product.salePrice,
            priceTtc(product.salePrice, product.vatRate),
            product.unitCost === undefined ? null : product.unitCost * product.qtyOnHand,
          ])
        );
      }),
    [products, filter, typeFilter, search],
  );

  const { sorted, sort, toggle } = useSort(
    filtered,
    useMemo(
      () => ({
        sku: (p: Product) => p.sku,
        name: (p: Product) => p.name,
        type: (p: Product) => TYPE_LABEL[p.type ?? 'consumable'],
        category: (p: Product) => p.category ?? null,
        qtyOnHand: (p: Product) => p.qtyOnHand,
        minQty: (p: Product) => p.minQty,
        unitCost: (p: Product) => p.unitCost ?? null,
        salePrice: (p: Product) => p.salePrice ?? null,
        value: (p: Product) => (p.unitCost === undefined ? null : p.unitCost * p.qtyOnHand),
      }),
      [],
    ),
    { key: 'name', direction: 'asc' },
  );

  const stats = useMemo(() => {
    const active = products.filter((p) => !p.archived);
    return {
      count: active.length,
      value: active.reduce((s, p) => s + (p.unitCost ?? 0) * p.qtyOnHand, 0),
      low: active.filter((p) => p.minQty > 0 && p.qtyOnHand < p.minQty).length,
      out: active.filter((p) => p.qtyOnHand <= 0).length,
    };
  }, [products]);

  const runImport = async () => {
    setImporting(true);
    try {
      const report = await window.api.products.pickAndImport();
      if (report) {
        refreshAll();
        toast.push({
          tone: report.errors.length ? 'warn' : 'success',
          title: 'Import terminé',
          text: `${report.created} créé(s), ${report.updated} mis à jour.${
            report.errors.length ? ` ${report.errors[0]}` : ''
          }`,
        });
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Import impossible', text: errorMessage(err) });
    } finally {
      setImporting(false);
    }
  };

  const exportCsv = async () => {
    try {
      const file = await window.api.products.exportCsv();
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
      {products.length > 0 && (
        <div className="grid grid--stats" style={{ marginBottom: 14 }}>
          <Stat label="Références" value={stats.count} icon={<Icons.box size={13} />} />
          <Stat label="Valeur du stock" value={euro(stats.value)} icon={<Icons.euro size={13} />} />
          <Stat label="Sous le seuil" value={stats.low} tone={stats.low ? 'warn' : ''} />
          <Stat label="En rupture" value={stats.out} tone={stats.out ? 'danger' : 'ok'} />
        </div>
      )}

      <div className="row row--wrap" style={{ marginBottom: 12 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Référence, désignation, prix…" style={{ width: 250 }} />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Tout' },
            { value: 'low', label: 'Sous le seuil' },
            { value: 'out', label: 'Rupture' },
          ]}
        />
        <Segmented
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: 'all', label: 'Toutes' },
            { value: 'mixLiquid', label: 'Mix liquide' },
            { value: 'mixPowder', label: 'Mix poudre' },
            { value: 'consumable', label: 'Consommables' },
            { value: 'machine', label: 'Machines' },
            { value: 'part', label: 'Pièces' },
          ]}
        />
        <div className="spacer" />
        <div className="row">
          <Button icon={<Icons.download size={14} />} onClick={exportCsv} title="Exporter en CSV" />
          <Button icon={<Icons.upload size={14} />} onClick={runImport} loading={importing}>
            Importer
          </Button>
          <Button variant="primary" icon={<Icons.plus size={14} />} onClick={() => setEditing('new')}>
            Nouvel article
          </Button>
        </div>
      </div>

      {loading && !products.length ? (
        <div className="empty">
          <Spinner size={22} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="tablewrap">
          <EmptyState
            icon={<Icons.stock size={32} />}
            title={products.length ? 'Aucun article ne correspond' : 'Votre stock est vide'}
            text={
              products.length
                ? 'Modifiez les filtres ou la recherche.'
                : 'Saisissez vos consommables (coupelles, cuillères, cornets…), vos machines (glace, granité…) et vos pièces détachées, ou importez-les depuis un fichier CSV/Excel. Les quantités des consommables seront déduites automatiquement à partir des lignes de vos factures.'
            }
            action={
              !products.length ? (
                <div className="row" style={{ marginTop: 8 }}>
                  <Button variant="primary" icon={<Icons.plus size={14} />} onClick={() => setEditing('new')}>
                    Ajouter un article
                  </Button>
                  <Button icon={<Icons.upload size={14} />} onClick={runImport} loading={importing}>
                    Importer un fichier
                  </Button>
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
                <Th sortKey="sku" sort={sort} onSort={toggle}>Référence</Th>
                <Th sortKey="name" sort={sort} onSort={toggle}>Désignation</Th>
                <Th sortKey="type" sort={sort} onSort={toggle}>Nature</Th>
                <Th sortKey="category" sort={sort} onSort={toggle}>Catégorie</Th>
                <Th sortKey="qtyOnHand" sort={sort} onSort={toggle} className="num">Stock</Th>
                <Th sortKey="minQty" sort={sort} onSort={toggle} className="num">Seuil</Th>
                {/* Deux prix, deux colonnes : la confusion venait de n'en
                    montrer qu'un, l'achat, alors que les catalogues importés
                    portent surtout des prix de vente. */}
                <Th sortKey="unitCost" sort={sort} onSort={toggle} className="num">Prix d’achat</Th>
                <Th sortKey="salePrice" sort={sort} onSort={toggle} className="num">Prix de vente</Th>
                <Th sortKey="value" sort={sort} onSort={toggle} className="num">Valeur du stock</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((product) => {
                const low = product.minQty > 0 && product.qtyOnHand < product.minQty;
                const out = product.qtyOnHand <= 0;
                return (
                  <tr key={product.id} onClick={() => setEditing(product)}>
                    <td className="mono muted">{product.sku}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <span style={{ fontWeight: 500 }}>{product.name}</span>
                        {product.archived && <Badge>archivé</Badge>}
                      </div>
                      {product.supplier && <div className="tiny muted">{product.supplier}</div>}
                    </td>
                    <td>
                      <Badge tone={TYPE_TONE[product.type ?? 'consumable']}>
                        {TYPE_LABEL[product.type ?? 'consumable']}
                      </Badge>
                    </td>
                    <td className="muted">{product.category ?? '—'}</td>
                    <td className="num">
                      <span
                        style={{
                          fontWeight: 600,
                          color: out ? 'var(--red)' : low ? 'var(--orange)' : undefined,
                        }}
                      >
                        {num(product.qtyOnHand)}
                      </span>
                      <span className="muted"> {product.unit}</span>
                    </td>
                    <td className="num muted">{product.minQty > 0 ? num(product.minQty) : '—'}</td>
                    <td className="num muted">
                      {product.unitCost !== undefined ? euro(product.unitCost) : '—'}
                    </td>
                    <td className="num">
                      {product.salePrice !== undefined ? (
                        <>
                          <span style={{ fontWeight: 500 }}>{euro(product.salePrice)}</span>
                          {product.vatRate !== undefined && (
                            <div className="tiny muted">
                              {euro(priceTtc(product.salePrice, product.vatRate) ?? 0)} TTC
                            </div>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">
                      {product.unitCost !== undefined ? euro(product.unitCost * product.qtyOnHand) : '—'}
                    </td>
                    <td style={{ width: 40 }}>
                      <button
                        className="iconbtn"
                        title="Historique des mouvements"
                        onClick={(e) => {
                          e.stopPropagation();
                          setHistory(product);
                        }}
                      >
                        <Icons.clock size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ProductEditor product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {history && <MovesDialog product={history} onClose={() => setHistory(null)} />}
    </>
  );
}

/* ================================================================== */
/* Fiche consommable                                                   */
/* ================================================================== */

function ProductEditor({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Product>>(
    product ?? { name: '', unit: 'pièce', qtyOnHand: 0, minQty: 0, aliases: [], archived: false },
  );
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof Product>(key: K, value: Product[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    if (!draft.name?.trim()) {
      toast.push({ tone: 'warn', title: 'Désignation obligatoire' });
      return;
    }
    setBusy(true);
    try {
      await window.api.products.save({ ...draft, id: product?.id });
      refreshAll();
      toast.push({ tone: 'success', title: product ? 'Article mis à jour' : 'Consommable ajouté' });
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
        title={product ? product.name : 'Nouveau consommable'}
        subtitle={product ? product.sku : 'Article suivi en stock'}
        onClose={onClose}
        footer={
          <>
            {product && (
              <Button variant="danger" icon={<Icons.trash size={14} />} onClick={() => setConfirmDelete(true)}>
                Supprimer
              </Button>
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
            <Field label="Désignation">
              <Input value={draft.name ?? ''} onChange={(e) => set('name', e.target.value)} autoFocus />
            </Field>
            <Field label="Référence" hint="Sert au rapprochement avec vos factures">
              <Input
                value={draft.sku ?? ''}
                placeholder="attribuée automatiquement"
                onChange={(e) => set('sku', e.target.value)}
              />
            </Field>
            <Field
              label="Nature"
              hint="Les pièces sont proposées en priorité dans le cahier SAV, les consommables dans les commandes"
            >
              <Select
                value={draft.type ?? 'consumable'}
                onChange={(e) => {
                  const type = e.target.value as ProductType;
                  // Changer de nature réapplique le conditionnement habituel de
                  // cette nature : c'est ce qu'on attend en la choisissant, et
                  // tout reste modifiable juste en dessous.
                  setDraft((d) => ({ ...d, type, ...packagingDefaults(type) }));
                }}
              >
                {ALL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Catégorie">
              <Input value={draft.category ?? ''} onChange={(e) => set('category', e.target.value)} />
            </Field>
            <Field label="Unité de stock" hint="Ce que vous comptez sur l’étagère">
              <Input
                value={draft.unit ?? ''}
                placeholder="poche, carton, pièce…"
                onChange={(e) => set('unit', e.target.value)}
              />
            </Field>
            {hasPackaging(draft.type ?? 'consumable') && (
              <>
                <Field label={`Contenu d’${(draft.unit ?? 'une unité').startsWith('u') ? 'une' : 'une'} ${draft.unit || 'unité'}`}>
                  <div className="row" style={{ gap: 6 }}>
                    <NumberInput
                      value={draft.packSize}
                      step={0.1}
                      onValueChange={(v) => set('packSize', v)}
                      style={{ flex: 1 }}
                    />
                    <Input
                      value={draft.packMeasure ?? ''}
                      placeholder="kg"
                      onChange={(e) => set('packMeasure', e.target.value)}
                      style={{ width: 70 }}
                    />
                  </div>
                </Field>
                <Field label="Unités par carton" hint="Laissez vide si l’article ne se vend pas au carton">
                  <NumberInput
                    value={draft.unitsPerCase}
                    onValueChange={(v) => set('unitsPerCase', v || undefined)}
                  />
                </Field>
                <Field
                  label="Facturé par le fournisseur"
                  hint="Détermine la conversion : 12,5 kg de mix poudre font 5 poches de 2,5 kg"
                >
                  <Select
                    value={draft.invoicedAs ?? 'unit'}
                    onChange={(e) => set('invoicedAs', e.target.value as InvoicedAs)}
                  >
                    {(['unit', 'case', 'measure'] as InvoicedAs[]).map((v) => (
                      <option key={v} value={v}>
                        {INVOICED_LABEL[v]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            <Field label="Quantité en stock">
              <NumberInput
                value={draft.qtyOnHand}
                onValueChange={(v) => set('qtyOnHand', v)}
                suffix={draft.unit}
              />
            </Field>
            <Field label="Seuil d’alerte" hint="0 pour désactiver l’alerte">
              <NumberInput value={draft.minQty} onValueChange={(v) => set('minQty', v)} />
            </Field>
            <Field label="Prix unitaire d’achat">
              <NumberInput
                value={draft.unitCost}
                onValueChange={(v) => set('unitCost', v)}
                step={0.01}
                suffix="€"
              />
            </Field>
            <Field
              label="Prix de vente HT"
              hint={(() => {
                const margin = marginRate(draft.unitCost, draft.salePrice);
                const ttc = priceTtc(draft.salePrice, draft.vatRate);
                return [
                  ttc != null ? `${ttc.toFixed(2)} € TTC` : '',
                  margin != null ? `marge ${margin.toFixed(1)} %` : '',
                ]
                  .filter(Boolean)
                  .join(' · ');
              })()}
            >
              <NumberInput
                value={draft.salePrice}
                onValueChange={(v) => set('salePrice', v)}
                step={0.01}
                suffix="€"
              />
            </Field>
            <Field label="TVA">
              <NumberInput
                value={draft.vatRate}
                onValueChange={(v) => set('vatRate', v)}
                step={0.1}
                suffix="%"
              />
            </Field>
            <Field label="Fournisseur">
              <Input value={draft.supplier ?? ''} onChange={(e) => set('supplier', e.target.value)} />
            </Field>
            <Field label="Délai de réappro" hint="Jours annoncés par le fournisseur">
              <NumberInput
                value={draft.leadTimeDays}
                onValueChange={(v) => set('leadTimeDays', v || undefined)}
                suffix="j"
              />
            </Field>
            <Field label="Compte comptable" hint="Repris de votre logiciel de comptabilité">
              <Input
                value={draft.accountingCode ?? ''}
                onChange={(e) => set('accountingCode', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Description">
            <Textarea
              rows={2}
              value={draft.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <Field
            label="Libellés reconnus sur les factures"
            hint="Séparés par des points-virgules. Ils s’enrichissent tout seuls quand vous associez une ligne de facture à cet article."
          >
            <Input
              value={(draft.aliases ?? []).join(' ; ')}
              onChange={(e) =>
                set(
                  'aliases',
                  e.target.value
                    .split(';')
                    .map((a) => a.trim())
                    .filter(Boolean),
                )
              }
            />
          </Field>

          {product && (
            <div className="tiny muted">
              La modification de la quantité crée un mouvement d’ajustement daté, visible dans
              l’historique.
            </div>
          )}
        </div>
      </Modal>

      {product && (
        <ConfirmDialog
          open={confirmDelete}
          danger
          title="Supprimer cet article ?"
          confirmLabel="Supprimer"
          message={`« ${product.name} » et son historique de mouvements seront supprimés. Les lignes de factures qui y étaient associées redeviendront non associées.`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await window.api.products.remove(product.id);
              refreshAll();
              toast.push({ tone: 'success', title: 'Article supprimé' });
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
/* Historique des mouvements                                           */
/* ================================================================== */

function MovesDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const { data: moves, loading } = useStockMoves(product.id);

  const {
    sorted: sortedMoves,
    sort: moveSort,
    toggle: toggleMove,
  } = useSort(
    moves,
    useMemo(
      () => ({
        date: (m: StockMove) => m.date,
        type: (m: StockMove) => m.type,
        origin: (m: StockMove) => m.documentNumber ?? m.note ?? null,
        qty: (m: StockMove) => m.qty,
        balanceAfter: (m: StockMove) => m.balanceAfter,
      }),
      [],
    ),
    { key: 'date', direction: 'desc' },
  );

  return (
    <Modal
      open
      wide
      title={`Mouvements — ${product.name}`}
      subtitle={`Stock actuel : ${num(product.qtyOnHand)} ${product.unit}`}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Fermer</Button>}
    >
      {loading ? (
        <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
          <Spinner />
        </div>
      ) : moves.length === 0 ? (
        <EmptyState
          title="Aucun mouvement"
          text="Les entrées et sorties apparaîtront ici dès que des factures seront déduites du stock."
        />
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <Th sortKey="date" sort={moveSort} onSort={toggleMove}>Date</Th>
                <Th sortKey="type" sort={moveSort} onSort={toggleMove}>Type</Th>
                <Th sortKey="origin" sort={moveSort} onSort={toggleMove}>Origine</Th>
                <Th sortKey="qty" sort={moveSort} onSort={toggleMove} className="num">Quantité</Th>
                <Th sortKey="balanceAfter" sort={moveSort} onSort={toggleMove} className="num">Stock après</Th>
              </tr>
            </thead>
            <tbody>
              {sortedMoves.map((move) => (
                <tr key={move.id}>
                  <td className="muted">{dateFr(move.date)}</td>
                  <td>
                    <Badge tone={move.qty > 0 ? 'badge--green' : move.type === 'adjust' ? '' : 'badge--orange'}>
                      {move.type === 'in' ? 'Entrée' : move.type === 'out' ? 'Sortie' : 'Ajustement'}
                    </Badge>
                  </td>
                  <td className="tiny">
                    {move.documentNumber ?? move.note ?? '—'}
                  </td>
                  <td className="num" style={{ fontWeight: 600, color: move.qty > 0 ? 'var(--green)' : 'var(--red)' }}>
                    {move.qty > 0 ? '+' : ''}
                    {num(move.qty)}
                  </td>
                  <td className="num muted">{num(move.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
