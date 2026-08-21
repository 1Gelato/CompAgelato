import { useMemo, useState } from 'react';
import type { Client } from '@shared/types';
import { Badge, Button, Field, Icons, Input } from './ui';
import { ClientEditor } from './ClientEditor';
import { matches } from '../lib/format';

/**
 * Sélecteur de client commun aux cahiers et aux tâches : choisir une fiche,
 * la créer à la volée, ou laisser simplement le nom noté tel quel — on ne
 * bloque jamais une prise de note parce qu'une fiche manque.
 *
 * Créer ouvre la **fiche complète**, celle de l'onglet Clients : adresse,
 * téléphones, SIRET. La version précédente n'enregistrait qu'un nom et
 * renvoyait l'utilisateur vers l'onglet Clients pour le reste — ce détour
 * n'était jamais fait, et les fiches nées d'un cahier restaient vides.
 */
export function ClientPicker({
  clients,
  clientId,
  clientName,
  onChange,
}: {
  clients: Client[];
  clientId?: string;
  clientName: string;
  onChange: (patch: { clientId?: string; clientName?: string }) => void;
}) {
  const [query, setQuery] = useState('');
  /** Fiche ouverte par-dessus : `'new'` en création, la fiche en modification. */
  const [editing, setEditing] = useState<Client | 'new' | null>(null);

  const selected = clientId ? clients.find((c) => c.id === clientId) : undefined;

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return clients
      .filter((c) => !c.archived && matches(`${c.name} ${c.address.city ?? ''}`, query))
      .slice(0, 6);
  }, [clients, query]);

  const typed = (query || clientName).trim();

  const editor = editing && (
    <ClientEditor
      client={editing === 'new' ? null : editing}
      initialName={editing === 'new' ? typed : undefined}
      onClose={() => setEditing(null)}
      onSaved={(client) => {
        // La fiche à peine créée est rattachée à ce qu'on était en train
        // d'écrire : sans cela il faudrait la rechercher soi-même.
        onChange({ clientId: client.id });
        setQuery('');
      }}
    />
  );

  if (selected) {
    return (
      <>
        <Field label="Client">
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <Badge tone="badge--blue">{selected.name}</Badge>
            {(selected.phone ?? selected.mobile) && (
              <span className="tiny muted">{selected.phone ?? selected.mobile}</span>
            )}
            <div className="spacer" />
            <Button
              size="sm"
              icon={<Icons.edit size={13} />}
              onClick={() => setEditing(selected)}
              title="Compléter l’adresse, le téléphone…"
            >
              Modifier
            </Button>
            <Button size="sm" onClick={() => onChange({ clientId: undefined, clientName: '' })}>
              Changer
            </Button>
          </div>
        </Field>
        {editor}
      </>
    );
  }

  return (
    <>
      <Field
        label="Client"
        hint="Choisissez une fiche, créez-la, ou laissez simplement le nom noté"
      >
        <div className="col" style={{ gap: 6 }}>
          <Input
            placeholder="Nom du client…"
            value={query || clientName}
            onChange={(e) => {
              setQuery(e.target.value);
              onChange({ clientName: e.target.value });
            }}
          />
          {results.length > 0 && (
            <div className="list">
              {results.map((client) => (
                <div
                  key={client.id}
                  className="list__item"
                  style={{ cursor: 'default' }}
                  onClick={() => {
                    onChange({ clientId: client.id });
                    setQuery('');
                  }}
                >
                  <span className="truncate">{client.name}</span>
                  <div className="spacer" />
                  {client.address.city && <span className="tiny muted">{client.address.city}</span>}
                </div>
              ))}
            </div>
          )}
          {typed && !results.some((c) => c.name.toLowerCase() === typed.toLowerCase()) && (
            <Button size="sm" icon={<Icons.plus size={13} />} onClick={() => setEditing('new')}>
              Créer la fiche « {typed} »
            </Button>
          )}
        </div>
      </Field>
      {editor}
    </>
  );
}
