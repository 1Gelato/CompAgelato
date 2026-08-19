import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AccountingDocument,
  Attachment,
  BankSummary,
  BankTransaction,
  Client,
  DashboardStats,
  DeliveryRoute,
  EventMachine,
  MachineAvailability,
  RegisterEntry,
  Product,
  Role,
  Settings,
  StockMove,
  Task,
  Vehicle,
} from '@shared/types';
import type { AppInfo, ChannelName } from '@shared/api';
import { mayCall } from '@shared/api';

/**
 * Chargement des données depuis le processus principal.
 * Un compteur global permet à n'importe quel écran de demander un
 * rafraîchissement complet après une écriture.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function refreshAll(): void {
  for (const listener of listeners) listener();
}

/**
 * Rôle de l'utilisateur connecté, `null` quand il n'y a pas de compte
 * (application de bureau sur ses propres données).
 *
 * Sert à ne pas *demander* ce à quoi on n'a pas droit. Le serveur refuserait de
 * toute façon, mais les compteurs de la barre latérale interrogent documents,
 * stock et cahiers depuis n'importe quel écran : un livreur récolterait une
 * volée de refus à chaque chargement.
 */
let currentRole: Role | null = null;

export function setCurrentRole(role: Role | null): void {
  currentRole = role;
}

function allowed(channel?: ChannelName): boolean {
  return !channel || !currentRole || mayCall(currentRole, channel);
}

export function useResource<T>(
  loader: () => Promise<T>,
  initial: T,
  deps: unknown[] = [],
  /** Canal exigé. Sans droit dessus, la ressource reste à sa valeur initiale. */
  channel?: ChannelName,
): { data: T; loading: boolean; refreshing: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>(initial);
  // `loading` ne vaut true que tant que rien n'a encore été chargé. Un
  // rechargement ultérieur laisse les données affichées : sans cela, l'écran
  // serait remplacé par un indicateur d'attente et les champs en cours de
  // saisie (auto-complétion d'adresse notamment) perdraient leur état.
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    listeners.add(reload);
    return () => {
      listeners.delete(reload);
    };
  }, [reload]);

  useEffect(() => {
    // Pas le droit : on n'appelle pas. L'écran correspondant est de toute façon
    // masqué ; seuls les compteurs transverses passaient encore par ici.
    if (!allowed(channel)) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setRefreshing(true);
    loader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
          setLoaded(true);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, loading: !loaded, refreshing, error, reload };
}

export const useClients = () => useResource<Client[]>(() => window.api.clients.list(), [], [], 'clients:list');
export const useDocuments = () => useResource<AccountingDocument[]>(() => window.api.documents.list(), [], [], 'documents:list');
export const useProducts = () => useResource<Product[]>(() => window.api.products.list(), [], [], 'products:list');
export const useRoutes = () => useResource<DeliveryRoute[]>(() => window.api.routes.list(), [], [], 'routes:list');
export const useVehicles = () => useResource<Vehicle[]>(() => window.api.vehicles.list(), [], [], 'vehicles:list');
export const useAttachments = () =>
  useResource<(Attachment & { exists: boolean })[]>(
    () => window.api.attachments.list(),
    [],
    [],
    'attachments:list',
  );
export const useStockMoves = (productId?: string) =>
  useResource<StockMove[]>(() => window.api.stock.moves(productId), [], [productId], 'stock:moves');
export const useRegisterEntries = () =>
  useResource<RegisterEntry[]>(() => window.api.registers.list(), [], [], 'registers:list');
export const useMachines = () =>
  useResource<MachineAvailability[]>(() => window.api.machines.list(), [], [], 'machines:list');
export const useTasks = () =>
  useResource<Task[]>(() => window.api.tasks.list(), [], [], 'tasks:list');
export const useBankTransactions = () =>
  useResource<BankTransaction[]>(() => window.api.bank.list(), [], [], 'bank:list');
export const useBankSummary = () =>
  useResource<BankSummary | null>(() => window.api.bank.summary(), null, [], 'bank:summary');
export const useDashboard = () =>
  useResource<DashboardStats | null>(() => window.api.stats.dashboard(), null, [], 'stats:dashboard');
export const useSettings = () => useResource<Settings | null>(() => window.api.settings.get(), null);

/**
 * Où tourne l'application et d'où viennent ses données. Sert notamment à savoir
 * si les dossiers désignés sont sur cette machine : quand ils sont sur un
 * serveur, les boutons « Ouvrir le dossier » n'ont plus de sens.
 */
export const useAppInfo = () => useResource<AppInfo | null>(() => window.api.app.info(), null);

/** Index id → client, pour afficher un nom sans reparcourir la liste. */
export function useClientIndex(clients: Client[]): Map<string, Client> {
  return useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
}

export function useProductIndex(products: Product[]): Map<string, Product> {
  return useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
}

/** Extrait le message d'une erreur IPC pour l'afficher tel quel. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron préfixe les erreurs IPC ; on retire ce bruit technique.
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}
