import { useMemo, useState } from 'react';
import type { ID } from '@shared/types';
import { clientOrderHistory } from '@shared/orders';
import { dateFr, euro, num } from '@shared/format';
import { useDeliveryNotes, useDocuments, useProducts } from '../lib/data';
import { Badge, Button, Field, Input } from './ui';

/**
 * « Qu'est-ce que j'avais pris la dernière fois ? »
 *
 * La question revient à chaque commande, et la réponse dormait dans les
 * factures — qu'il fallait ouvrir une par une. Cet encart la sort d'un coup
 * dans la fiche client : la référence d'abord, puisque c'est elle qu'on
 * oublie, puis la date, la quantité et le prix de la dernière fois.
 *
 * Les bons de livraison pas encore facturés comptent aussi : sans eux, ce que
 * le livreur a laissé la semaine dernière serait invisible ici.
 */

/** Au-delà, on replie : une fiche client n'est pas un catalogue. */
const APERCU = 12;

export function ClientOrders({ clientId }: { clientId: ID }) {
  const { data: documents, loading } = useDocuments();
  const { data: deliveryNotes } = useDeliveryNotes();
  const { data: products } = useProducts();
  const [search, setSearch] = useState('');
  const [tout, setTout] = useState(false);

  const history = useMemo(
    () => clientOrderHistory({ clientId, documents, deliveryNotes, products }),
    [clientId, documents, deliveryNotes, products],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return history.items;
    return history.items.filter((item) =>
      `${item.ref ?? ''} ${item.label}`.toLowerCase().includes(needle),
    );
  }, [history.items, search]);

  const shown = tout || search ? filtered : filtered.slice(0, APERCU);

  if (loading && !history.items.length) {
    return (
      <Field label="Déjà commandé">
        <div className="tiny muted">Lecture des factures…</div>
      </Field>
    );
  }

  if (!history.items.length) {
    return (
      <Field label="Déjà commandé">
        <div className="tiny muted">
          Aucune commande enregistrée. Cette liste se remplit toute seule à partir des factures
          rattachées à ce client et des bons de livraison signés.
        </div>
      </Field>
    );
  }

  return (
    <Field
      label="Déjà commandé"
      hint={`${history.items.length} article(s) sur ${history.sourceCount} pièce(s)${
        history.lastDate ? ` — dernière commande le ${dateFr(history.lastDate)}` : ''
      }.`}
    >
      <div className="col" style={{ gap: 8 }}>
        {history.items.length > APERCU && (
          <Input
            value={search}
            placeholder="Filtrer par référence ou libellé…"
            onChange={(e) => setSearch(e.target.value)}
          />
        )}

        <div className="tablewrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Réf.</th>
                <th>Article</th>
                <th style={{ width: 120 }}>Dernière fois</th>
                <th className="num" style={{ width: 90 }}>
                  Qté
                </th>
                <th className="num" style={{ width: 90 }}>
                  P.U. HT
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.key}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{item.ref ?? '—'}</td>
                  <td>
                    {item.label}
                    {item.orderCount > 1 && (
                      <span className="tiny muted"> · {item.orderCount} fois</span>
                    )}
                  </td>
                  <td className="tiny">
                    {dateFr(item.lastDate)}
                    <div className="muted">
                      {item.lastFromDeliveryNote ? (
                        <Badge tone="warn">{item.lastSource}</Badge>
                      ) : (
                        item.lastSource
                      )}
                    </div>
                  </td>
                  <td className="num">
                    {num(item.lastQty, item.unit)}
                    {item.orderCount > 1 && (
                      <div className="tiny muted">{num(item.totalQty)} au total</div>
                    )}
                  </td>
                  <td className="num">
                    {item.lastUnitPriceHT != null ? euro(item.lastUnitPriceHT) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!search && filtered.length > APERCU && (
          <div className="row">
            <div className="spacer" />
            <Button onClick={() => setTout((v) => !v)}>
              {tout ? 'Réduire' : `Voir les ${filtered.length} articles`}
            </Button>
          </div>
        )}

        {search && !shown.length && (
          <div className="tiny muted">Aucun article ne correspond à « {search} ».</div>
        )}
      </div>
    </Field>
  );
}
