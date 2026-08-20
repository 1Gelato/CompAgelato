import { useMemo, useState } from 'react';
import type { DeliveryNote, Signature } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Icons,
  Modal,
  SearchInput,
  Spinner,
  Th,
  useToast,
} from '../components/ui';
import {
  errorMessage,
  refreshAll,
  useClientIndex,
  useClients,
  useDeliveryNotes,
} from '../lib/data';
import { dateFr, matches } from '../lib/format';
import { useSort } from '../lib/sort';

/**
 * Les bons de livraison signés en tournée.
 *
 * Le téléphone du livreur les envoie sitôt signés ; ils arrivent ici avec la
 * bulle du système. Le travail du bureau tient en un geste : faire la facture
 * dans le logiciel de comptabilité, puis marquer le bon « facturé ».
 */

const STATUS_LABEL: Record<DeliveryNote['status'], string> = {
  signed: 'À facturer',
  invoiced: 'Facturé',
};

export function Bons() {
  const { data: notes, loading } = useDeliveryNotes();
  const { data: clients } = useClients();
  const clientIndex = useClientIndex(clients);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const clientName = (note: DeliveryNote) =>
    (note.clientId && clientIndex.get(note.clientId)?.name) || note.clientName || 'Client sans fiche';

  const filtered = useMemo(
    () =>
      notes.filter((note) =>
        matches(
          [
            note.number,
            clientName(note),
            note.createdByName ?? '',
            note.items.map((i) => i.label).join(' '),
            STATUS_LABEL[note.status],
          ].join(' '),
          search,
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, search, clientIndex],
  );

  const { sorted, sort, toggle } = useSort(
    filtered,
    useMemo(
      () => ({
        number: (n: DeliveryNote) => n.number,
        date: (n: DeliveryNote) => n.date,
        client: (n: DeliveryNote) => clientName(n),
        by: (n: DeliveryNote) => n.createdByName ?? null,
        items: (n: DeliveryNote) => n.items.length,
        status: (n: DeliveryNote) => n.status,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [clientIndex],
    ),
    { key: 'date', direction: 'desc' },
  );

  const open = openId ? notes.find((n) => n.id === openId) ?? null : null;

  return (
    <>
      <div className="row row--wrap" style={{ marginBottom: 12 }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Numéro, client, article…"
          style={{ width: 270 }}
        />
        <div className="spacer" />
        <div className="tiny muted">
          Les bons se créent sur le téléphone, en tournée — ici on les facture.
        </div>
      </div>

      {loading && !notes.length ? (
        <div className="empty">
          <Spinner size={22} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="tablewrap">
          <EmptyState
            icon={<Icons.edit size={32} />}
            title={notes.length ? 'Aucun bon ne correspond' : 'Aucun bon de livraison'}
            text={
              notes.length
                ? 'Modifiez votre recherche.'
                : 'Quand un client est servi en tournée sans facture préparée, le livreur établit le bon sur son téléphone : articles, signatures — il apparaît ici aussitôt.'
            }
          />
        </div>
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <Th sortKey="number" sort={sort} onSort={toggle}>Numéro</Th>
                <Th sortKey="date" sort={sort} onSort={toggle}>Date</Th>
                <Th sortKey="client" sort={sort} onSort={toggle}>Client</Th>
                <Th sortKey="items" sort={sort} onSort={toggle} className="num">Articles</Th>
                <Th sortKey="by" sort={sort} onSort={toggle}>Livreur</Th>
                <Th>Signatures</Th>
                <Th sortKey="status" sort={sort} onSort={toggle}>Statut</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((note) => (
                <tr key={note.id} onClick={() => setOpenId(note.id)}>
                  <td className="mono muted">{note.number}</td>
                  <td>{dateFr(note.date)}</td>
                  <td style={{ fontWeight: 500 }}>{clientName(note)}</td>
                  <td className="num">{note.items.length}</td>
                  <td className="tiny muted">{note.createdByName ?? '—'}</td>
                  <td className="tiny muted">
                    {[note.driverSignature && 'livreur', note.clientSignature && 'client']
                      .filter(Boolean)
                      .join(' + ') || '—'}
                  </td>
                  <td>
                    <Badge tone={note.status === 'invoiced' ? 'badge--green' : 'badge--orange'}>
                      {STATUS_LABEL[note.status]}
                    </Badge>
                  </td>
                  <td style={{ width: 40 }} className="muted">
                    <Icons.chevron size={13} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <BonDetail note={open} clientName={clientName(open)} onClose={() => setOpenId(null)} />}
    </>
  );
}

/* ================================================================== */
/* Détail d'un bon                                                     */
/* ================================================================== */

/** Une signature vectorielle, redessinée en SVG à la taille de l'écran. */
function SignatureSvg({ signature }: { signature: Signature }) {
  const W = 320;
  const H = 130;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{
        width: '100%',
        maxWidth: W,
        background: 'var(--bg-input, rgba(127,127,127,0.08))',
        borderRadius: 8,
        border: '1px solid var(--border)',
      }}
    >
      {signature.strokes.map((stroke, index) =>
        stroke.length === 1 ? (
          <circle key={index} cx={stroke[0][0] * W} cy={stroke[0][1] * H} r={1.4} fill="currentColor" />
        ) : (
          <polyline
            key={index}
            points={stroke.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </svg>
  );
}

function BonDetail({
  note,
  clientName,
  onClose,
}: {
  note: DeliveryNote;
  clientName: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const setInvoiced = async (invoiced: boolean) => {
    setBusy(true);
    try {
      await window.api.delivery.markInvoiced(note.id, invoiced);
      refreshAll();
      toast.push({
        tone: 'success',
        title: invoiced ? 'Bon marqué facturé' : 'Bon remis « à facturer »',
      });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        wide
        title={`${note.number} — ${clientName}`}
        subtitle={`${dateFr(note.date)}${note.createdByName ? ` · établi par ${note.createdByName}` : ''}`}
        onClose={onClose}
        footer={
          <>
            <Button variant="danger" icon={<Icons.trash size={14} />} onClick={() => setConfirmDelete(true)}>
              Supprimer
            </Button>
            <div className="spacer" />
            <Button onClick={onClose}>Fermer</Button>
            {note.status === 'signed' ? (
              <Button variant="primary" icon={<Icons.check size={14} />} loading={busy} onClick={() => setInvoiced(true)}>
                Marquer facturé
              </Button>
            ) : (
              <Button loading={busy} onClick={() => setInvoiced(false)}>
                Remettre « à facturer »
              </Button>
            )}
          </>
        }
      >
        <div className="col" style={{ gap: 15 }}>
          <Field label="Articles livrés">
            {note.items.length ? (
              <table className="data">
                <tbody>
                  {note.items.map((item, index) => (
                    <tr key={index}>
                      <td>{item.label}</td>
                      <td className="num" style={{ width: 80 }}>× {item.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="tiny muted">Aucun article détaillé.</div>
            )}
          </Field>

          {note.notes && (
            <Field label="Notes">
              <div className="tiny">{note.notes}</div>
            </Field>
          )}

          <div className="formgrid">
            {note.driverSignature && (
              <Field label={`Signature du livreur${note.driverSignature.name ? ` — ${note.driverSignature.name}` : ''}`}>
                <SignatureSvg signature={note.driverSignature} />
              </Field>
            )}
            {note.clientSignature && (
              <Field label={`Signature du client${note.clientSignature.name ? ` — ${note.clientSignature.name}` : ''}`}>
                <SignatureSvg signature={note.clientSignature} />
              </Field>
            )}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Supprimer ce bon ?"
        confirmLabel="Supprimer"
        message={`Le bon ${note.number} et ses signatures seront supprimés définitivement.`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await window.api.delivery.remove(note.id);
            refreshAll();
            toast.push({ tone: 'success', title: 'Bon supprimé' });
            onClose();
          } catch (err) {
            toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
          }
        }}
      />
    </>
  );
}
