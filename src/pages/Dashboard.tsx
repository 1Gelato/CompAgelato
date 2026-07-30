import { useMemo } from 'react';
import type { DashboardStats } from '@shared/types';
import { Button, Card, EmptyState, Icons, Spinner, Stat, Badge } from '../components/ui';
import { useDashboard } from '../lib/data';
import { dateFr, euro, euroShort, KIND_LABEL, num } from '../lib/format';

export function Dashboard({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { data, loading } = useDashboard();

  if (loading && !data) {
    return (
      <div className="empty">
        <Spinner size={22} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Données indisponibles" />;

  const isEmpty = data.clients === 0 && data.invoices === 0 && data.quotes === 0;
  if (isEmpty) {
    return (
      <EmptyState
        icon={<Icons.sparkle size={34} />}
        title="Bienvenue dans CompaGelato"
        text="Déposez vos factures et devis dans le dossier surveillé, importez votre liste clients, puis saisissez votre stock de consommables. Vous pouvez aussi charger un jeu de démonstration depuis les réglages pour découvrir le logiciel."
        action={
          <div className="row" style={{ marginTop: 8 }}>
            <Button variant="primary" icon={<Icons.folder size={14} />} onClick={() => onNavigate('settings')}>
              Configurer le dossier
            </Button>
            <Button icon={<Icons.clients size={14} />} onClick={() => onNavigate('clients')}>
              Importer les clients
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid grid--stats">
        <Stat
          label="Chiffre d’affaires HT"
          value={euroShort(data.revenueHT)}
          hint={`${euro(data.revenueTTC)} TTC`}
          icon={<Icons.euro size={13} />}
        />
        <Stat
          label="Factures"
          value={data.invoices}
          hint={`${data.quotes} devis en cours`}
          icon={<Icons.documents size={13} />}
        />
        <Stat label="Clients" value={data.clients} icon={<Icons.clients size={13} />} />
        <Stat
          label="Valeur du stock"
          value={euroShort(data.stockValue)}
          hint={data.outOfStock ? `${data.outOfStock} article(s) à zéro` : 'Aucune rupture'}
          tone={data.outOfStock ? 'warn' : ''}
          icon={<Icons.stock size={13} />}
        />
        <Stat
          label="Coût des tournées"
          value={euroShort(data.routeCostThisMonth)}
          hint={`${data.routesThisMonth} tournée(s) ce mois-ci`}
          icon={<Icons.routes size={13} />}
        />
      </div>

      {(data.lowStock.length > 0 || data.unappliedDocuments > 0) && (
        <div className="grid grid--2">
          {data.lowStock.length > 0 && (
            <Card
              title="Stock sous le seuil d’alerte"
              subtitle={`${data.lowStock.length} article(s) à réapprovisionner`}
              padded={false}
              actions={
                <Button size="sm" onClick={() => onNavigate('stock')}>
                  Voir le stock
                </Button>
              }
            >
              <div className="list">
                {data.lowStock.slice(0, 6).map(({ product, missing }) => (
                  <div key={product.id} className="list__item">
                    <span
                      className="dot"
                      style={{ background: product.qtyOnHand <= 0 ? 'var(--red)' : 'var(--orange)' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate">{product.name}</div>
                      <div className="tiny muted mono">{product.sku}</div>
                    </div>
                    <div className="num tiny">
                      <div>
                        {num(product.qtyOnHand)} / {num(product.minQty)} {product.unit}
                      </div>
                      <div style={{ color: 'var(--orange)' }}>manque {num(missing)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {data.unappliedDocuments > 0 && (
            <Card
              title="Stock à déduire"
              subtitle="Factures importées dont les quantités n’ont pas encore été sorties du stock"
            >
              <div className="col" style={{ gap: 12 }}>
                <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-0.03em' }}>
                  {data.unappliedDocuments}
                </div>
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                  Ces pièces sont enregistrées mais leurs lignes n’ont pas encore été retirées du
                  stock de consommables. Vérifiez l’association des articles, puis déduisez-les.
                </p>
                <Button variant="primary" onClick={() => onNavigate('documents')}>
                  Traiter les documents
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      <RevenueChart data={data} />

      <div className="grid grid--2">
        <Card title="Derniers documents" padded={false}>
          {data.recentDocuments.length === 0 ? (
            <EmptyState title="Aucun document" text="Déposez vos fichiers dans le dossier surveillé." />
          ) : (
            <div className="list">
              {data.recentDocuments.map((doc) => (
                <div key={doc.id} className="list__item">
                  <Badge tone={doc.kind === 'quote' ? 'badge--purple' : doc.kind === 'credit' ? 'badge--orange' : 'badge--blue'}>
                    {KIND_LABEL[doc.kind]}
                  </Badge>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate">{doc.number}</div>
                    <div className="tiny muted truncate">{doc.clientNameRaw ?? 'Client non identifié'}</div>
                  </div>
                  <div className="num tiny">
                    <div style={{ fontWeight: 500 }}>{euro(doc.totalTTC)}</div>
                    <div className="muted">{dateFr(doc.date)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Meilleurs clients" subtitle="Cumul facturé HT" padded={false}>
          {data.topClients.length === 0 ? (
            <EmptyState title="Pas encore de facturation par client" />
          ) : (
            <div className="list">
              {data.topClients.map(({ client, total, count }) => (
                <div key={client.id} className="list__item">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate">{client.name}</div>
                    <div className="tiny muted">
                      {count} facture{count > 1 ? 's' : ''}
                      {client.address.city ? ` · ${client.address.city}` : ''}
                    </div>
                  </div>
                  <div className="num" style={{ fontWeight: 500 }}>
                    {euro(total)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RevenueChart({ data }: { data: DashboardStats }) {
  const max = useMemo(
    () => Math.max(1, ...data.monthlyRevenue.map((m) => m.ht)),
    [data.monthlyRevenue],
  );
  const hasData = data.monthlyRevenue.some((m) => m.ht !== 0);

  return (
    <Card title="Chiffre d’affaires HT" subtitle="12 derniers mois">
      {hasData ? (
        <div className="chart">
          {data.monthlyRevenue.map((month) => (
            <div className="chart__col" key={month.month} title={`${month.month} — ${euro(month.ht)}`}>
              <div
                className="chart__bar"
                style={{ height: `${Math.max(2, (Math.max(0, month.ht) / max) * 108)}px` }}
              />
              <span className="chart__label">{month.month}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          Le graphique se remplira dès que des factures datées seront importées.
        </p>
      )}
    </Card>
  );
}
