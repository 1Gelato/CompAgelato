import type { Client, DeliveryNote, RegisterEntry, RegisterKind, Signature } from '@shared/types';
import { dateFr, dateTimeFr, REGISTER_STATUS_LABEL } from '../lib/format';

/**
 * Les mises en page imprimables — du React rendu en HTML statique par
 * `printView`, jamais monté dans l'application. Noir sur blanc, tables aux
 * bordures fines : du papier qui se classe, pas une copie d'écran.
 */

/* ------------------------------------------------------------------ */
/* Signature vectorielle                                                */
/* ------------------------------------------------------------------ */

const SIG_W = 300;
const SIG_H = 110;

function SignatureInk({ signature }: { signature: Signature }) {
  return (
    <svg viewBox={`0 0 ${SIG_W} ${SIG_H}`} xmlns="http://www.w3.org/2000/svg">
      {signature.strokes.map((stroke, index) =>
        stroke.length === 1 ? (
          <circle key={index} cx={stroke[0][0] * SIG_W} cy={stroke[0][1] * SIG_H} r={1.4} fill="#111" />
        ) : (
          <polyline
            key={index}
            points={stroke.map(([x, y]) => `${(x * SIG_W).toFixed(1)},${(y * SIG_H).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="#111"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </svg>
  );
}

function SignatureBlock({ label, signature }: { label: string; signature?: Signature }) {
  return (
    <div className="signature">
      <div className="titre" style={{ fontSize: 11, textTransform: 'uppercase', color: '#555' }}>
        {label}
      </div>
      {signature ? (
        <>
          <SignatureInk signature={signature} />
          <div className="tiny muted">
            {[signature.name, signature.at ? `le ${dateTimeFr(signature.at)}` : '']
              .filter(Boolean)
              .join(' — ')}
          </div>
        </>
      ) : (
        <div style={{ height: 70 }} className="tiny muted">
          Non signé
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bon de livraison                                                     */
/* ------------------------------------------------------------------ */

export function BonPrintView({
  note,
  client,
  clientName,
  companyName,
}: {
  note: DeliveryNote;
  /** Fiche rattachée, si elle existe : elle fournit adresse et téléphone. */
  client?: Client;
  clientName: string;
  companyName?: string;
}) {
  return (
    <div>
      <div className="entete">
        <div>
          <div className="societe">{companyName || 'CompaGelato'}</div>
          <h1>Bon de livraison {note.number}</h1>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div>
            Livraison du <strong>{dateFr(note.date)}</strong>
          </div>
          {note.createdByName && <div className="tiny muted">Établi par {note.createdByName}</div>}
          {note.status === 'invoiced' && <div className="tiny muted">Facturé</div>}
        </div>
      </div>

      <div className="blocs">
        <div className="bloc">
          <div className="titre">Client</div>
          <div style={{ fontWeight: 600 }}>{clientName}</div>
          {client?.address.label && <div className="tiny">{client.address.label}</div>}
          {(client?.phone || client?.mobile) && (
            <div className="tiny muted">{[client.phone, client.mobile].filter(Boolean).join(' · ')}</div>
          )}
          {client?.siret && <div className="tiny muted">SIRET {client.siret}</div>}
        </div>
      </div>

      <h2>Articles livrés</h2>
      <table>
        <thead>
          <tr>
            <th>Article</th>
            <th className="num" style={{ width: 90 }}>
              Quantité
            </th>
          </tr>
        </thead>
        <tbody>
          {note.items.length ? (
            note.items.map((item, index) => (
              <tr key={index}>
                <td>{item.label}</td>
                <td className="num">{item.qty}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2} className="muted">
                Aucun article détaillé.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {note.notes && (
        <>
          <h2>Notes</h2>
          <div>{note.notes}</div>
        </>
      )}

      <div className="signatures">
        <SignatureBlock label="Le livreur" signature={note.driverSignature} />
        <SignatureBlock label="Le client" signature={note.clientSignature} />
      </div>

      <div className="pied">
        Bon {note.number} · imprimé le {dateTimeFr(new Date().toISOString())} · CompaGelato
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cahier                                                               */
/* ------------------------------------------------------------------ */

export interface CahierPrintRow {
  entry: RegisterEntry;
  who: string;
  machines?: string;
}

export function CahierPrintView({
  kind,
  kindLabel,
  rows,
  filterLabel,
  companyName,
}: {
  kind: RegisterKind;
  kindLabel: string;
  rows: CahierPrintRow[];
  /** Ce que la page affichait : « En cours », « Tout », une recherche… */
  filterLabel: string;
  companyName?: string;
}) {
  return (
    <div>
      <div className="entete">
        <div>
          <div className="societe">{companyName || 'CompaGelato'}</div>
          <h1>Cahier {kindLabel}</h1>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div>
            Imprimé le <strong>{dateTimeFr(new Date().toISOString())}</strong>
          </div>
          <div className="tiny muted">{filterLabel}</div>
        </div>
      </div>

      <table style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th style={{ width: 78 }}>Noté le</th>
            {kind === 'event' && <th style={{ width: 78 }}>Prestation</th>}
            {kind === 'wintering' && <th style={{ width: 90 }}>Restitution</th>}
            <th>Client</th>
            <th>Objet</th>
            <th>{kind === 'event' ? 'Machines' : 'Articles'}</th>
            <th style={{ width: 92 }}>Statut</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ entry, who, machines }) => (
            <tr key={entry.id}>
              <td>{dateFr(entry.createdAt.slice(0, 10))}</td>
              {(kind === 'event' || kind === 'wintering') && (
                <td>{entry.eventDate ? dateFr(entry.eventDate) : '—'}</td>
              )}
              <td>{who || '—'}</td>
              <td>
                {entry.title}
                {entry.details && <div className="tiny muted">{entry.details}</div>}
              </td>
              <td className="tiny">
                {kind === 'event'
                  ? machines || '—'
                  : (entry.items ?? []).map((i) => `${i.qty} × ${i.label}`).join(', ') || '—'}
              </td>
              <td>{REGISTER_STATUS_LABEL[entry.kind]?.[entry.status] ?? entry.status}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={kind === 'event' || kind === 'wintering' ? 6 : 5} className="muted">
                Rien à imprimer avec ces filtres.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="pied">
        {rows.length} écriture{rows.length > 1 ? 's' : ''} · Cahier {kindLabel} · CompaGelato
      </div>
    </div>
  );
}
