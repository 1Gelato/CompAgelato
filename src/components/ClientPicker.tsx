import { useMemo, useState } from 'react';
import type { Client } from '@shared/types';
import { Badge, Button, Field, Icons, Input, useToast } from './ui';
import { errorMessage, refreshAll } from '../lib/data';
import { matches } from '../lib/format';

/**
 * Sélecteur de client commun aux cahiers et aux tâches : choisir une fiche,
 * la créer à la volée, ou laisser simplement le nom noté tel quel — on ne
 * bloque jamais une prise de note parce qu'une fiche manque.
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
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const selected = clientId ? clients.find((c) => c.id === clientId) : undefined;

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return clients
      .filter((c) => !c.archived && matches(`${c.name} ${c.address.city ?? ''}`, query))
      .slice(0, 6);
  }, [clients, query]);

  const createClient = async () => {
    const name = (query || clientName).trim();
    if (!name) return;
    setCreating(true);
    try {
      const client = await window.api.clients.save({ name });
      refreshAll();
      onChange({ clientId: client.id });
      setQuery('');
      toast.push({
        tone: 'success',
        title: 'Fiche client créée',
        text: 'Complétez le téléphone et l’adresse depuis l’onglet Clients quand vous voulez.',
      });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Création impossible', text: errorMessage(err) });
    } finally {
      setCreating(false);
    }
  };

  if (selected) {
    return (
      <Field label="Client">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <Badge tone="badge--blue">{selected.name}</Badge>
          {selected.phone && <span className="tiny muted">{selected.phone}</span>}
          <div className="spacer" />
          <Button size="sm" onClick={() => onChange({ clientId: undefined, clientName: '' })}>
            Changer
          </Button>
        </div>
      </Field>
    );
  }

  return (
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
        {(query || clientName).trim() &&
          !results.some(
            (c) => c.name.toLowerCase() === (query || clientName).trim().toLowerCase(),
          ) && (
            <Button
              size="sm"
              icon={<Icons.plus size={13} />}
              onClick={createClient}
              loading={creating}
            >
              Créer la fiche « {(query || clientName).trim()} »
            </Button>
          )}
      </div>
    </Field>
  );
}
