import { useState } from 'react';
import type { Address, Client } from '@shared/types';
import { AddressInput } from './AddressInput';
import { ClientOrders } from './ClientOrders';
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Icons,
  Input,
  Modal,
  Textarea,
  useToast,
} from './ui';
import { errorMessage, refreshAll } from '../lib/data';

/**
 * La fiche client complète — une seule, partout.
 *
 * Elle vivait dans la page Clients, si bien que créer une fiche depuis un
 * cahier ou une tâche ne permettait d'entrer qu'un nom : il fallait ensuite
 * penser à retourner dans l'onglet Clients pour l'adresse et le téléphone,
 * ce que personne ne fait au moment où l'on prend une note. Le même
 * formulaire s'ouvre désormais des trois endroits.
 *
 * Les gestes propres au carnet d'adresses — fusionner un doublon, supprimer —
 * n'apparaissent que si le parent sait quoi en faire : depuis un cahier, ils
 * n'auraient pas de sens.
 */

export function emptyClient(name = ''): Partial<Client> {
  return {
    name,
    address: { label: '', country: 'France' },
    tags: [],
    aliases: [],
    archived: false,
  };
}

export function ClientEditor({
  client,
  initialName,
  onClose,
  onSaved,
  onMerge,
  onDeleted,
}: {
  /** Fiche à modifier, ou `null` pour une création. */
  client: Client | null;
  /** Nom déjà tapé ailleurs (sélecteur de client d'un cahier, d'une tâche). */
  initialName?: string;
  onClose: () => void;
  /** La fiche enregistrée, pour la rattacher aussitôt à ce qu'on saisissait. */
  onSaved?: (client: Client) => void;
  onMerge?: (client: Client) => void;
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Client>>(client ?? emptyClient(initialName));
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
      const saved = await window.api.clients.save({ ...draft, id: client?.id });
      refreshAll();
      toast.push({ tone: 'success', title: client ? 'Fiche mise à jour' : 'Client créé' });
      onSaved?.(saved);
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
        subtitle={
          client
            ? `${client.code} · créé le ${new Date(client.createdAt).toLocaleDateString('fr-FR')}`
            : undefined
        }
        onClose={onClose}
        footer={
          <>
            {client && onDeleted && (
              <Button variant="danger" icon={<Icons.trash size={14} />} onClick={() => setConfirmDelete(true)}>
                Supprimer
              </Button>
            )}
            {client && onMerge && (
              <Button onClick={() => onMerge(client)} title="Fusionner avec un doublon">
                Fusionner
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
            <AddressInput value={draft.address ?? { label: '' }} onChange={setAddress} />
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
            <Field label="Portable">
              <Input value={draft.mobile ?? ''} onChange={(e) => set('mobile', e.target.value)} />
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

          {/* Une fiche qui vient d'être ouverte n'a pas d'historique : la
              section n'apparaît qu'une fois le client enregistré. */}
          {client && <ClientOrders clientId={client.id} />}

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

      {client && onDeleted && (
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
              onDeleted();
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
