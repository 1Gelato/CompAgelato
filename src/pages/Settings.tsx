import { useEffect, useState } from 'react';
import type { Address, Settings as SettingsType, Vehicle } from '@shared/types';
import type { AppInfo } from '@shared/api';
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
  useToast,
} from '../components/ui';
import { errorMessage, refreshAll, useSettings, useVehicles } from '../lib/data';
import { euro, FUEL_LABEL, num } from '../lib/format';

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
  const [dbStats, setDbStats] = useState<{ file: string; sizeKb: number; counts: Record<string, number> } | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | 'new' | null>(null);
  const [fetchingFuel, setFetchingFuel] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.app.info().then(setInfo).catch(() => {});
    window.api.db.stats().then(setDbStats).catch(() => {});
  }, [loading]);

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
        <Card
          title="Dossier surveillé"
          subtitle="Déposez-y les factures et devis produits par votre logiciel de comptabilité"
        >
          <div className="col" style={{ gap: 13 }}>
            <div className="row" style={{ gap: 8 }}>
              <Input value={settings.watchFolder} readOnly style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
              <Button icon={<Icons.folder size={14} />} onClick={chooseFolder}>
                Choisir…
              </Button>
              <Button onClick={() => window.api.app.openPath(settings.watchFolder)}>Ouvrir</Button>
            </div>

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

            <Field label="Adresse du dépôt" hint="Point de départ proposé par défaut pour vos tournées">
              <AddressInput
                value={settings.depot ?? { label: '', country: 'France' }}
                onChange={(depot: Address) => patch({ depot })}
                placeholder="Adresse de votre dépôt…"
              />
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
