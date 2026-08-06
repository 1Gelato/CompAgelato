import { useEffect, useState } from 'react';
import type { Address, Attachment, Settings as SettingsType, Vehicle } from '@shared/types';
import type { AppInfo, Connection, UpdateCheckResult } from '@shared/api';
import { AddressInput } from '../components/AddressInput';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Icons,
  IconButton,
  Input,
  Modal,
  NumberInput,
  Segmented,
  Select,
  Spinner,
  Switch,
  Textarea,
  useToast,
} from '../components/ui';
import {
  errorMessage,
  refreshAll,
  useAppInfo,
  useAttachments,
  useSettings,
  useVehicles,
} from '../lib/data';
import { euro, FUEL_LABEL, num } from '../lib/format';

const MONO = { fontFamily: 'var(--font-mono)', fontSize: 12 } as const;

/**
 * Champ « dossier », dans les deux situations possibles.
 *
 * Sur le poste, le dossier se choisit dans un sélecteur natif et s'ouvre d'un
 * clic. Quand les données viennent d'un serveur, ce dossier est sur l'autre
 * machine : un sélecteur montrerait les dossiers du poste, et « Ouvrir » n'a
 * plus de sens. Le chemin se saisit alors au clavier — sans quoi une base
 * restaurée depuis un autre système garderait un chemin impossible à corriger.
 */
function FolderField({
  value,
  localFolders,
  placeholder,
  onPick,
  onOpen,
  onSave,
}: {
  value: string;
  localFolders: boolean;
  placeholder: string;
  onPick: () => void;
  onOpen: () => void;
  onSave: (folder: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  // Le champ suit la valeur enregistrée tant que l'utilisateur n'a rien tapé.
  useEffect(() => setDraft(value), [value]);

  if (localFolders) {
    return (
      <div className="row" style={{ gap: 8 }}>
        <Input value={value} readOnly style={MONO} />
        <Button icon={<Icons.folder size={14} />} onClick={onPick}>
          Choisir…
        </Button>
        <Button onClick={onOpen}>Ouvrir</Button>
      </div>
    );
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      <Input
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        style={MONO}
      />
      <Button
        disabled={saving || !draft.trim() || draft.trim() === value}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(draft.trim());
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? <Spinner size={14} /> : 'Enregistrer'}
      </Button>
    </div>
  );
}

export function Settings({
  onScan,
  scanning,
  onThemeChange,
}: {
  onScan: (force?: boolean) => void;
  scanning: boolean;
  onThemeChange: (theme: SettingsType['theme']) => void;
}) {
  const { data: settings, loading } = useSettings();
  const { data: vehicles } = useVehicles();
  const toast = useToast();

  const [info, setInfo] = useState<AppInfo | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [serverDraft, setServerDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [linking, setLinking] = useState(false);
  const [dbStats, setDbStats] = useState<{ file: string; sizeKb: number; counts: Record<string, number> } | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | 'new' | null>(null);
  const [fetchingFuel, setFetchingFuel] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [updateDone, setUpdateDone] = useState(false);
  /** Fichiers du logiciel modifiés localement, quand ils bloquent la mise à jour. */
  const [localChanges, setLocalChanges] = useState<string[]>([]);
  // Le dépôt n'est enregistré qu'à la sélection d'une proposition : sans cela,
  // chaque frappe déclencherait une écriture puis un rechargement de l'écran.
  const [depotDraft, setDepotDraft] = useState<Address | null>(null);

  useEffect(() => {
    window.api.app.info().then(setInfo).catch(() => {});
    window.api.db.stats().then(setDbStats).catch(() => {});
    window.api.app
      .connection()
      .then((c) => {
        setConnection(c);
        setServerDraft(c.serverUrl);
      })
      .catch(() => {});
  }, [loading]);

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateDone(false);
    try {
      const result = await window.api.updates.check();
      setUpdateCheck(result);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Vérification impossible', text: errorMessage(err) });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const applyUpdateNow = async (discardLocalChanges = false) => {
    setApplyingUpdate(true);
    try {
      const result = await window.api.updates.apply({ discardLocalChanges });
      setLocalChanges(result.localChanges ?? []);
      if (result.success) {
        setUpdateDone(true);
        toast.push({ tone: 'success', title: 'Mise à jour installée', text: result.message });
      } else {
        toast.push({ tone: 'error', title: 'Échec de la mise à jour', text: result.message });
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec de la mise à jour', text: errorMessage(err) });
    } finally {
      setApplyingUpdate(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="empty">
        <Spinner size={22} />
      </div>
    );
  }

  const patch = async (changes: Partial<SettingsType>, message?: string) => {
    try {
      await window.api.settings.update(changes);
      refreshAll();
      if (changes.theme) onThemeChange(changes.theme);
      if (message) toast.push({ tone: 'success', title: message });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
    }
  };

  const chooseFolder = async () => {
    const folder = await window.api.app.chooseFolder(settings.watchFolder);
    if (folder) {
      await patch({ watchFolder: folder }, 'Dossier surveillé mis à jour');
      onScan(true);
    }
  };

  const refreshFuel = async () => {
    setFetchingFuel(true);
    try {
      const vehicle = vehicles.find((v) => v.id === settings.defaultVehicleId) ?? vehicles[0];
      const result = await window.api.geo.fuelPrice(vehicle?.fuelType ?? 'gazole', settings.fuelPricePostcode);
      refreshAll();
      if (result) {
        toast.push({
          tone: 'success',
          title: `Prix relevé : ${euro(result.price)} / L`,
          text: result.source,
        });
      } else {
        toast.push({
          tone: 'warn',
          title: 'Relevé indisponible',
          text: 'Aucun prix trouvé pour ce carburant / code postal. Saisissez le prix à la main.',
        });
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Relevé impossible', text: errorMessage(err) });
    } finally {
      setFetchingFuel(false);
    }
  };

  return (
    <>
      <div className="col" style={{ gap: 14, maxWidth: 940 }}>
        {/* Servie par le serveur : la question ne se pose pas, on y est déjà. */}
        {connection && connection.mode !== 'server' && (
          <Card
            title="Serveur"
            subtitle="Travailler sur les données partagées plutôt que sur celles de ce poste"
          >
            <div className="col" style={{ gap: 13 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                {connection.mode === 'remote' ? (
                  <Badge tone={connection.reachable ? 'success' : 'danger'}>
                    {connection.reachable ? 'Branché' : 'Serveur injoignable'}
                  </Badge>
                ) : (
                  <Badge>Données de ce poste</Badge>
                )}
                <span className="muted" style={{ fontSize: 12 }}>
                  {connection.mode === 'remote'
                    ? connection.error ?? 'Les données affichées sont celles du serveur.'
                    : 'Les données ne sont partagées avec aucun autre appareil.'}
                </span>
              </div>

              <Field label="Adresse du serveur" hint="Laissez vide pour travailler sur ce poste.">
                <Input
                  value={serverDraft}
                  placeholder="192.168.1.99:4680"
                  spellCheck={false}
                  onChange={(e) => setServerDraft(e.target.value)}
                  style={MONO}
                />
              </Field>

              <Field
                label="Jeton d’accès"
                hint={
                  connection.hasToken
                    ? 'Un jeton est déjà enregistré : laissez vide pour le conserver.'
                    : 'Le secret défini par COMPAGELATO_TOKEN sur le serveur.'
                }
              >
                <Input
                  type="password"
                  value={tokenDraft}
                  placeholder={connection.hasToken ? '••••••••' : ''}
                  spellCheck={false}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  style={MONO}
                />
              </Field>

              <div className="row" style={{ gap: 8 }}>
                <Button
                  variant="primary"
                  disabled={linking}
                  onClick={async () => {
                    setLinking(true);
                    try {
                      const next = await window.api.app.setConnection({
                        serverUrl: serverDraft,
                        // Champ laissé vide : le jeton déjà enregistré est conservé.
                        ...(tokenDraft ? { token: tokenDraft } : {}),
                      });
                      setConnection(next);
                      setTokenDraft('');
                      if (next.mode === 'remote' && !next.reachable) {
                        toast.push({
                          tone: 'warn',
                          title: 'Enregistré, mais le serveur ne répond pas',
                          text: next.error,
                        });
                      } else {
                        toast.push({
                          tone: 'success',
                          title: 'Liaison enregistrée',
                          text: 'Redémarrez l’application pour l’appliquer.',
                        });
                      }
                    } catch (err) {
                      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
                    } finally {
                      setLinking(false);
                    }
                  }}
                >
                  {linking ? <Spinner size={14} /> : 'Enregistrer'}
                </Button>
                <Button onClick={() => window.api.app.relaunch()}>Redémarrer maintenant</Button>
              </div>

              <div className="infobox">
                Le changement prend effet <strong>au redémarrage</strong>. Une fois branché, ce
                poste lit et écrit sur le serveur : les factures, clients et tournées sont les
                mêmes que sur les autres appareils. L’impression, l’ouverture des PDF et les
                brouillons d’e-mail continuent de se faire ici, sur cette machine.
              </div>
            </div>
          </Card>
        )}

        <Card
          title="Dossier surveillé"
          subtitle="Déposez-y les factures et devis produits par votre logiciel de comptabilité"
        >
          <div className="col" style={{ gap: 13 }}>
            <FolderField
              value={settings.watchFolder}
              localFolders={info?.localFolders ?? true}
              placeholder="/home/oldpc/Documents/CompaGelato"
              onPick={chooseFolder}
              onOpen={() => void window.api.app.openPath(settings.watchFolder)}
              onSave={async (folder) => {
                await patch({ watchFolder: folder }, 'Dossier surveillé mis à jour');
                onScan(true);
              }}
            />

            {info?.watchFolderInsideApp && (
              <div className="warnbox">
                <strong>Ce dossier est aussi celui du logiciel.</strong>
                <p style={{ margin: '6px 0 0' }}>
                  Vos documents sont rangés au même endroit que les fichiers de CompaGelato. Cela
                  fonctionne, mais il est plus sûr de les séparer : choisissez un dossier dédié
                  (par exemple <span className="mono">Documents\CompaGelato-Donnees</span>), puis
                  déplacez-y vos factures. Elles seront relues automatiquement, sans doublon.
                </p>
              </div>
            )}

            <div className="infobox">
              Les sous-dossiers <strong>Factures</strong>, <strong>Devis</strong>,{' '}
              <strong>Avoirs</strong> et <strong>Clients</strong> sont créés automatiquement. Le type
              de pièce est déduit du sous-dossier puis du contenu. Vos fichiers ne sont jamais
              modifiés ni déplacés.
              <br />
              Formats lus : PDF (y compris Factur-X/ZUGFeRD), XML (Factur-X, UBL/Chorus Pro), CSV et
              Excel.
            </div>

            <div className="col" style={{ gap: 10 }}>
              <Switch
                checked={settings.autoScan}
                onChange={(v) => patch({ autoScan: v })}
                label="Surveiller le dossier en continu et importer automatiquement"
              />
              <Switch
                checked={settings.autoApplyStock}
                onChange={(v) => patch({ autoApplyStock: v })}
                label="Déduire le stock dès l’import d’une facture"
              />
              <Switch
                checked={settings.autoCreateClients}
                onChange={(v) => patch({ autoCreateClients: v })}
                label="Créer une fiche client quand le nom lu est inconnu"
              />
              <Switch
                checked={settings.lowStockAlert}
                onChange={(v) => patch({ lowStockAlert: v })}
                label="Signaler les consommables sous le seuil d’alerte"
              />
            </div>

            <div className="row">
              <Button icon={<Icons.refresh size={14} />} onClick={() => onScan(false)} loading={scanning}>
                Analyser maintenant
              </Button>
              <Button onClick={() => onScan(true)} loading={scanning}>
                Tout relire (forcer)
              </Button>
              <div className="spacer" />
              <Button variant="ghost" onClick={() => window.api.settings.resetFolder().then(() => refreshAll())}>
                Réinitialiser l’emplacement
              </Button>
            </div>
          </div>
        </Card>

        <Card
          title="Relevés de compte"
          subtitle="Dossier où sont rangés les relevés exportés par votre banque"
        >
          <div className="col" style={{ gap: 13 }}>
            <FolderField
              value={settings.statementFolder || ''}
              localFolders={info?.localFolders ?? true}
              placeholder={`${settings.watchFolder || ''}/Releves`}
              onPick={async () => {
                const folder = await window.api.bank.chooseFolder();
                if (folder) {
                  refreshAll();
                  toast.push({ tone: 'success', title: 'Dossier des relevés mis à jour' });
                  await window.api.bank.scan();
                  refreshAll();
                }
              }}
              onOpen={() => void window.api.bank.openFolder()}
              onSave={async (folder) => {
                await patch({ statementFolder: folder }, 'Dossier des relevés mis à jour');
                await window.api.bank.scan();
                refreshAll();
              }}
            />

            <div className="infobox">
              Déposez-y les relevés au format <strong>CSV</strong> ou <strong>Excel</strong> exportés
              depuis votre banque. Chaque opération est reconnue par sa date, son montant et son
              libellé : réimporter un relevé, ou importer deux fichiers qui se chevauchent, ne crée
              jamais de doublon.
            </div>

            <Switch
              checked={settings.autoReconcile}
              onChange={(v) => patch({ autoReconcile: v })}
              label="Rapprocher automatiquement les encaissements des factures (et les marquer réglées)"
            />

            <div className="row">
              <Button
                icon={<Icons.refresh size={14} />}
                onClick={async () => {
                  const report = await window.api.bank.scan();
                  refreshAll();
                  toast.push({
                    tone: report.imported ? 'success' : 'warn',
                    title: report.imported ? 'Relevés à jour' : 'Aucune nouvelle opération',
                    text: `${report.files} fichier(s) lu(s), ${report.imported} opération(s) ajoutée(s).`,
                  });
                }}
              >
                Analyser les relevés
              </Button>
            </div>
          </div>
        </Card>

        <Card
          title="Notifications sur téléphone"
          subtitle="Chaque ajout dans les cahiers (SAV, consommables, événementiel) prévient toute l'équipe"
        >
          <div className="col" style={{ gap: 13 }}>
            <div className="infobox">
              Installez l'application gratuite <strong>ntfy</strong> sur chaque téléphone
              (Android ou iPhone), puis abonnez-la au sujet ci-dessous. Tous les téléphones
              abonnés reçoivent l'alerte — aucun compte à créer. Le sujet fait office de
              mot de passe : <strong>gardez-le long et secret</strong>. Les messages
              (nom du client, objet) transitent par le serveur choisi ; le jour où
              CompaGelato aura son propre serveur, il pourra héberger ntfy et plus rien
              ne sortira de l'entreprise.
            </div>

            <div className="formgrid">
              <Field label="Sujet de notification" hint="Vide = notifications désactivées">
                <div className="row" style={{ gap: 6 }}>
                  <Input
                    value={settings.notifyTopic ?? ''}
                    onChange={(e) => patch({ notifyTopic: e.target.value.trim() })}
                    placeholder="ex. compagelato-8f3k2m9x4p"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  />
                  <Button
                    size="sm"
                    title="Générer un sujet impossible à deviner"
                    onClick={() => {
                      const random = Array.from(crypto.getRandomValues(new Uint8Array(8)))
                        .map((b) => b.toString(36).padStart(2, '0'))
                        .join('')
                        .slice(0, 14);
                      patch({ notifyTopic: `compagelato-${random}` }, 'Sujet généré — abonnez les téléphones');
                    }}
                  >
                    Générer
                  </Button>
                </div>
              </Field>
              <Field label="Serveur ntfy" hint="Laissez ntfy.sh, ou votre propre serveur plus tard">
                <Input
                  value={settings.notifyUrl ?? 'https://ntfy.sh'}
                  onChange={(e) => patch({ notifyUrl: e.target.value.trim() })}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                />
              </Field>
            </div>

            <div className="row">
              <Button
                icon={<Icons.bell size={14} />}
                disabled={!settings.notifyTopic}
                onClick={async () => {
                  try {
                    await window.api.notify.test();
                    toast.push({
                      tone: 'success',
                      title: 'Notification envoyée',
                      text: 'Elle doit apparaître sur les téléphones abonnés au sujet.',
                    });
                  } catch (err) {
                    toast.push({ tone: 'error', title: 'Envoi impossible', text: errorMessage(err) });
                  }
                }}
              >
                Envoyer un essai
              </Button>
              {!settings.notifyTopic && (
                <span className="tiny muted">Renseignez un sujet pour activer l'essai.</span>
              )}
            </div>
          </div>
        </Card>

        <Card title="Coût de trajet" subtitle="Base de calcul du carburant et du dépôt">
          <div className="col" style={{ gap: 13 }}>
            <div className="formgrid">
              <Field label="Prix du carburant" hint="€ par litre (ou par kWh pour un véhicule électrique)">
                <NumberInput
                  value={settings.fuelPricePerLiter}
                  step={0.01}
                  onValueChange={(v) => patch({ fuelPricePerLiter: v })}
                  suffix="€"
                />
              </Field>
              <Field label="Code postal de référence" hint="Pour relever le prix près de chez vous">
                <Input
                  value={settings.fuelPricePostcode ?? ''}
                  placeholder="44600"
                  maxLength={5}
                  onChange={(e) => patch({ fuelPricePostcode: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
              <Field label="&nbsp;">
                <Button icon={<Icons.fuel size={14} />} onClick={refreshFuel} loading={fetchingFuel}>
                  Relever le prix du jour
                </Button>
              </Field>
            </div>

            {settings.fuelPriceSource && (
              <div className="tiny muted">
                {settings.fuelPriceSource}
                {settings.fuelPriceUpdatedAt && (
                  <> · mis à jour le {new Date(settings.fuelPriceUpdatedAt).toLocaleString('fr-FR')}</>
                )}
                <br />
                Source : prix des carburants en France, données ouvertes du ministère de l’Économie.
              </div>
            )}

            <Field
              label="Adresse du dépôt"
              hint="Point de départ de toutes vos tournées. Choisissez une proposition dans la liste pour enregistrer sa position."
            >
              <AddressInput
                value={depotDraft ?? settings.depot ?? { label: '', country: 'France' }}
                onChange={setDepotDraft}
                onSelect={(depot) => {
                  setDepotDraft(depot);
                  patch({ depot }, 'Dépôt enregistré');
                }}
                placeholder="Adresse de votre dépôt…"
              />
              <div className="row" style={{ marginTop: 6 }}>
                {typeof (depotDraft ?? settings.depot)?.lat === 'number' ? (
                  <span className="tiny" style={{ color: 'var(--green)' }}>
                    Position enregistrée — le calcul de tournée est opérationnel.
                  </span>
                ) : (
                  <span className="tiny" style={{ color: 'var(--orange)' }}>
                    Aucune position enregistrée : le calcul de tournée restera indisponible.
                  </span>
                )}
                <div className="spacer" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDepotDraft(null);
                    patch({ depot: undefined }, 'Dépôt rétabli');
                  }}
                  title="Revenir au 27 rue Jacques Daguerre, 44600 Saint-Nazaire"
                >
                  Rétablir le dépôt de l’entreprise
                </Button>
              </div>
            </Field>

            <Field label="Application de navigation par défaut">
              <Segmented
                value={settings.mapProvider}
                onChange={(mapProvider) => patch({ mapProvider })}
                options={[
                  { value: 'google', label: 'Google Maps' },
                  { value: 'waze', label: 'Waze' },
                  { value: 'apple', label: 'Plans' },
                ]}
              />
            </Field>
          </div>
        </Card>

        <Card
          title="Véhicules"
          subtitle="Consommation et coûts kilométriques utilisés dans le calcul de tournée"
          actions={
            <Button size="sm" icon={<Icons.plus size={12} />} onClick={() => setEditingVehicle('new')}>
              Ajouter
            </Button>
          }
          padded={false}
        >
          <div className="list">
            {vehicles.map((vehicle) => (
              <div className="list__item" key={vehicle.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <strong>{vehicle.name}</strong>
                    {vehicle.isDefault && <Badge tone="badge--blue">par défaut</Badge>}
                  </div>
                  <div className="tiny muted">
                    {FUEL_LABEL[vehicle.fuelType]} · {num(vehicle.consumption)}{' '}
                    {vehicle.fuelType === 'electrique' ? 'kWh' : 'L'}/100 km · usure{' '}
                    {euro(vehicle.maintenancePerKm)}/km
                    {vehicle.driverCostPerHour > 0 && ` · chauffeur ${euro(vehicle.driverCostPerHour)}/h`}
                  </div>
                </div>
                <IconButton title="Modifier" onClick={() => setEditingVehicle(vehicle)}>
                  <Icons.edit size={14} />
                </IconButton>
                <IconButton
                  title="Supprimer"
                  danger
                  disabled={vehicles.length <= 1}
                  onClick={async () => {
                    try {
                      await window.api.vehicles.remove(vehicle.id);
                      refreshAll();
                    } catch (err) {
                      toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
                    }
                  }}
                >
                  <Icons.trash size={14} />
                </IconButton>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Envoi par e-mail"
          subtitle="Modèle des messages générés depuis la fiche d’un document"
        >
          <div className="col" style={{ gap: 13 }}>
            <div className="formgrid">
              <Field label="Nom de votre entreprise">
                <Input
                  defaultValue={settings.companyName ?? ''}
                  placeholder="Glaces du Littoral"
                  onBlur={(e) => e.target.value !== (settings.companyName ?? '') && patch({ companyName: e.target.value })}
                />
              </Field>
              <Field label="Votre adresse e-mail" hint="Figure comme expéditeur du brouillon">
                <Input
                  type="email"
                  defaultValue={settings.senderEmail ?? ''}
                  placeholder="contact@monentreprise.fr"
                  onBlur={(e) => e.target.value !== (settings.senderEmail ?? '') && patch({ senderEmail: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Objet type" hint="Repères : {type} {le_type} {numero} {date} {client} {montant} {societe}">
              <Input
                defaultValue={settings.emailSubjectTemplate ?? ''}
                placeholder="{type} {numero}"
                onBlur={(e) =>
                  e.target.value !== (settings.emailSubjectTemplate ?? '') &&
                  patch({ emailSubjectTemplate: e.target.value })
                }
              />
            </Field>

            <Field label="Message type">
              <Textarea
                defaultValue={settings.emailBodyTemplate ?? ''}
                rows={4}
                onBlur={(e) =>
                  e.target.value !== (settings.emailBodyTemplate ?? '') &&
                  patch({ emailBodyTemplate: e.target.value })
                }
              />
            </Field>

            <Field label="Signature">
              <Textarea
                defaultValue={settings.emailSignature ?? ''}
                rows={3}
                placeholder={'Prénom Nom\nGlaces du Littoral\n02 40 00 00 00'}
                onBlur={(e) =>
                  e.target.value !== (settings.emailSignature ?? '') &&
                  patch({ emailSignature: e.target.value })
                }
              />
            </Field>

            <div className="infobox">
              CompaGelato prépare un brouillon complet, pièces jointes comprises, et l’ouvre dans
              votre messagerie habituelle. Rien n’est envoyé sans votre relecture.
            </div>
          </div>
        </Card>

        <AttachmentLibrary />

        <Card title="Apparence">
          <Field label="Thème">
            <Segmented
              value={settings.theme}
              onChange={(theme) => patch({ theme })}
              options={[
                { value: 'system', label: 'Automatique' },
                { value: 'light', label: 'Clair' },
                { value: 'dark', label: 'Sombre' },
              ]}
            />
          </Field>
        </Card>

        <Card title="Données" subtitle="Sauvegarde, restauration et jeu de démonstration">
          <div className="col" style={{ gap: 13 }}>
            {dbStats && (
              <div className="row row--wrap tiny muted" style={{ gap: 14 }}>
                <span>{dbStats.counts.clients} clients</span>
                <span>{dbStats.counts.documents} documents</span>
                <span>{dbStats.counts.products} consommables</span>
                <span>{dbStats.counts.stockMoves} mouvements</span>
                <span>{dbStats.counts.routes} tournées</span>
                <span>· {dbStats.sizeKb} Ko</span>
              </div>
            )}

            <div className="row row--wrap">
              <Button
                icon={<Icons.download size={14} />}
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const file = await window.api.db.backup();
                    toast.push({ tone: 'success', title: 'Sauvegarde créée', text: file });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sauvegarder
              </Button>
              <Button
                icon={<Icons.upload size={14} />}
                onClick={async () => {
                  try {
                    const ok = await window.api.db.restore();
                    if (ok) {
                      refreshAll();
                      toast.push({ tone: 'success', title: 'Sauvegarde restaurée' });
                    }
                  } catch (err) {
                    toast.push({ tone: 'error', title: 'Restauration impossible', text: errorMessage(err) });
                  }
                }}
              >
                Restaurer…
              </Button>
              <Button
                onClick={async () => {
                  const file = await window.api.db.exportAll();
                  if (file) {
                    toast.push({ tone: 'success', title: 'Export enregistré', text: file });
                    await window.api.app.revealFile(file);
                  }
                }}
              >
                Exporter dans le dossier
              </Button>
              <div className="spacer" />
              <Button
                onClick={async () => {
                  await window.api.db.seedDemo();
                  refreshAll();
                  toast.push({
                    tone: 'success',
                    title: 'Jeu de démonstration chargé',
                    text: '5 clients, 8 consommables, 6 documents et une tournée.',
                  });
                }}
              >
                Charger la démonstration
              </Button>
              <Button variant="danger" onClick={() => setConfirmWipe(true)}>
                Retirer la démonstration
              </Button>
            </div>

            <div className="tiny muted" style={{ lineHeight: 1.55 }}>
              Une sauvegarde automatique est conservée à chaque démarrage (20 dernières).
              {info && (
                <>
                  <br />
                  Emplacement des données :{' '}
                  <span className="mono" style={{ userSelect: 'text' }}>
                    {info.userDataPath}
                  </span>
                </>
              )}
            </div>
          </div>
        </Card>

        <Card title="Mises à jour" subtitle="Vérifie et installe les dernières améliorations du logiciel">
          <div className="col" style={{ gap: 12 }}>
            {updateDone ? (
              <>
                <div className="infobox" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>
                  Mise à jour installée. Redémarrez CompaGelato pour l’utiliser.
                </div>
                <Button
                  variant="primary"
                  icon={<Icons.refresh size={14} />}
                  onClick={() => window.api.app.relaunch()}
                >
                  Redémarrer maintenant
                </Button>
              </>
            ) : (
              <>
                <div className="row">
                  <Button icon={<Icons.refresh size={14} />} onClick={checkUpdate} loading={checkingUpdate}>
                    Rechercher les mises à jour
                  </Button>
                  {updateCheck?.available && (
                    <Button variant="primary" onClick={() => applyUpdateNow()} loading={applyingUpdate}>
                      Installer la mise à jour
                    </Button>
                  )}
                  {localChanges.length > 0 && (
                    <Button
                      variant="danger"
                      onClick={() => applyUpdateNow(true)}
                      loading={applyingUpdate}
                    >
                      Réparer et installer
                    </Button>
                  )}
                </div>

                {localChanges.length > 0 && (
                  <div className="warnbox">
                    <strong>
                      {localChanges.length} fichier{localChanges.length > 1 ? 's' : ''} du logiciel
                      {localChanges.length > 1 ? ' ont' : ' a'} été modifié
                      {localChanges.length > 1 ? 's' : ''} sur ce poste
                    </strong>
                    <ul style={{ margin: '6px 0 0 16px' }}>
                      {localChanges.slice(0, 8).map((f, i) => (
                        <li key={i} className="mono tiny">
                          {f}
                        </li>
                      ))}
                      {localChanges.length > 8 && <li className="tiny">…</li>}
                    </ul>
                    <p style={{ margin: '8px 0 0' }}>
                      « Réparer et installer » rétablit ces fichiers dans leur état d’origine puis
                      met à jour. Vos données — clients, documents, stock, relevés — sont stockées
                      ailleurs et ne sont pas concernées.
                    </p>
                  </div>
                )}

                {updateCheck && !updateCheck.supported && (
                  <div className="warnbox">{updateCheck.reason}</div>
                )}
                {updateCheck?.supported && updateCheck.reason && (
                  <div className="warnbox">{updateCheck.reason}</div>
                )}
                {updateCheck?.supported && !updateCheck.reason && !updateCheck.available && (
                  <div className="infobox">Vous avez déjà la dernière version de CompaGelato.</div>
                )}
                {updateCheck?.available && (
                  <div className="infobox">
                    <strong>
                      {updateCheck.behind} amélioration{updateCheck.behind > 1 ? 's' : ''} disponible
                      {updateCheck.behind > 1 ? 's' : ''}
                    </strong>
                    {updateCheck.changes.length > 0 && (
                      <ul style={{ margin: '6px 0 0 16px' }}>
                        {updateCheck.changes.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        {info && (
          <Card title="À propos">
            <div className="row row--wrap tiny muted" style={{ gap: 16 }}>
              <span>CompaGelato {info.version}</span>
              <span>Electron {info.electron}</span>
              <span>Node {info.node}</span>
              <span>{info.platform}</span>
              <span>{info.isPackaged ? 'version installée' : 'mode développement'}</span>
            </div>
            <p className="tiny muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
              Toutes vos données restent sur cet ordinateur. Seules trois requêtes sortent vers
              l’extérieur, et uniquement à votre demande : la recherche d’adresses (Base Adresse
              Nationale), le calcul d’itinéraires (OSRM) et le relevé du prix des carburants
              (données ouvertes du ministère de l’Économie).
            </p>
          </Card>
        )}
      </div>

      {editingVehicle && (
        <VehicleEditor
          vehicle={editingVehicle === 'new' ? null : editingVehicle}
          onClose={() => setEditingVehicle(null)}
        />
      )}

      <ConfirmDialog
        open={confirmWipe}
        danger
        title="Retirer les données de démonstration ?"
        confirmLabel="Retirer"
        message="Les clients, consommables, documents et tournées marqués « démo » seront supprimés. Vos données réelles ne sont pas touchées."
        onCancel={() => setConfirmWipe(false)}
        onConfirm={async () => {
          setConfirmWipe(false);
          await window.api.db.wipeDemo();
          refreshAll();
          toast.push({ tone: 'success', title: 'Démonstration retirée' });
        }}
      />
    </>
  );
}

/* ================================================================== */
/* Bibliothèque de pièces jointes (flyers, plaquettes…)                */
/* ================================================================== */

function AttachmentLibrary() {
  const { data: attachments, loading } = useAttachments();
  const { data: info } = useAppInfo();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const add = async () => {
    setAdding(true);
    try {
      const added = await window.api.attachments.pickAndAdd();
      if (added?.length) {
        refreshAll();
        toast.push({
          tone: 'success',
          title: `${added.length} pièce(s) jointe(s) ajoutée(s)`,
          text: 'Elles apparaîtront cochables lors de vos envois par e-mail.',
        });
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ajout impossible', text: errorMessage(err) });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Card
      title="Pièces jointes réutilisables"
      subtitle="Flyers, plaquettes, conditions générales — à cocher au moment d’envoyer un devis"
      padded={false}
      actions={
        <>
          {/* La bibliothèque vit sur le serveur en mode branché : rien à ouvrir ici. */}
          {(info?.localFolders ?? true) && (
            <Button size="sm" onClick={() => window.api.attachments.openFolder()}>
              Ouvrir le dossier
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<Icons.plus size={12} />} onClick={add} loading={adding}>
            Ajouter
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
          <Spinner />
        </div>
      ) : attachments.length === 0 ? (
        <div className="card__body">
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
            Aucune pièce jointe enregistrée. Ajoutez vos flyers une bonne fois pour toutes : ils
            seront ensuite proposés à cocher pour chaque devis ou facture que vous envoyez.
            <br />
            Vous pouvez aussi déposer directement des fichiers dans le sous-dossier{' '}
            <strong>Pieces-jointes</strong> du dossier surveillé : ils sont repris automatiquement.
          </p>
        </div>
      ) : (
        <div className="list">
          {attachments.map((attachment) => (
            <div className="list__item" key={attachment.id}>
              <Switch
                checked={attachment.defaultSelected}
                onChange={async (v) => {
                  await window.api.attachments.update(attachment.id, { defaultSelected: v });
                  refreshAll();
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="truncate">{attachment.name}</span>
                  {!attachment.exists && <Badge tone="badge--red">fichier introuvable</Badge>}
                  {attachment.defaultSelected && <Badge tone="badge--blue">cochée par défaut</Badge>}
                </div>
                <div className="tiny muted">
                  {(attachment.size / 1024).toFixed(0)} Ko · {attachment.filePath.split(/[\\/]/).pop()}
                </div>
              </div>
              <IconButton
                title="Ouvrir le fichier"
                disabled={!attachment.exists}
                onClick={() => window.api.attachments.open(attachment.id)}
              >
                <Icons.documents size={14} />
              </IconButton>
              <IconButton
                title="Retirer de la bibliothèque"
                danger
                onClick={async () => {
                  await window.api.attachments.remove(attachment.id);
                  refreshAll();
                  toast.push({
                    tone: 'success',
                    title: 'Pièce jointe retirée',
                    text: 'Le fichier reste présent sur le disque.',
                  });
                }}
              >
                <Icons.trash size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function VehicleEditor({ vehicle, onClose }: { vehicle: Vehicle | null; onClose: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Vehicle>>(
    vehicle ?? {
      name: '',
      consumption: 9,
      fuelType: 'gazole',
      maintenancePerKm: 0.08,
      driverCostPerHour: 0,
      isDefault: false,
    },
  );

  const set = <K extends keyof Vehicle>(key: K, value: Vehicle[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const isElectric = draft.fuelType === 'electrique';

  return (
    <Modal
      open
      title={vehicle ? vehicle.name : 'Nouveau véhicule'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await window.api.vehicles.save({ ...draft, id: vehicle?.id });
                refreshAll();
                onClose();
              } catch (err) {
                toast.push({ tone: 'error', title: 'Échec', text: errorMessage(err) });
              }
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 13 }}>
        <Field label="Nom">
          <Input
            value={draft.name ?? ''}
            placeholder="Camion frigorifique"
            onChange={(e) => set('name', e.target.value)}
            autoFocus
          />
        </Field>
        <div className="formgrid">
          <Field label="Énergie">
            <Select
              value={draft.fuelType ?? 'gazole'}
              onChange={(e) => set('fuelType', e.target.value as Vehicle['fuelType'])}
            >
              {Object.entries(FUEL_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Consommation (${isElectric ? 'kWh' : 'L'}/100 km)`}>
            <NumberInput value={draft.consumption} step={0.1} onValueChange={(v) => set('consumption', v)} />
          </Field>
          <Field label="Usure kilométrique" hint="Entretien, pneus, amortissement">
            <NumberInput
              value={draft.maintenancePerKm}
              step={0.01}
              onValueChange={(v) => set('maintenancePerKm', v)}
              suffix="€/km"
            />
          </Field>
          <Field label="Coût chauffeur" hint="0 pour ne pas le compter">
            <NumberInput
              value={draft.driverCostPerHour}
              step={0.5}
              onValueChange={(v) => set('driverCostPerHour', v)}
              suffix="€/h"
            />
          </Field>
        </div>
        <Switch
          checked={draft.isDefault ?? false}
          onChange={(v) => set('isDefault', v)}
          label="Véhicule par défaut"
        />
      </div>
    </Modal>
  );
}
