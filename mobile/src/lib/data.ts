import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AccountingDocument,
  BankSummary,
  BankTransaction,
  Client,
  DashboardStats,
  DeliveryRoute,
  MachineAvailability,
  Product,
  RegisterEntry,
  Role,
  Settings,
  StockMove,
  Task,
  Vehicle,
} from '@shared/types';
import type { ChannelName } from '@shared/api';
import { mayCall } from '@shared/api';
import { api } from './runtime';

/**
 * Chargement des données — le même patron que le bureau : un compteur global
 * permet à n'importe quel écran de demander un rechargement après une
 * écriture, et le rôle de l'utilisateur évite de demander ce à quoi il n'a
 * pas droit.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export function refreshAll(): void {
  for (const listener of listeners) listener();
}

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
  channel?: ChannelName,
): { data: T; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
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
    if (!allowed(channel)) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    loader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
          setLoaded(true);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, loading: !loaded, error, reload };
}

export const useClients = () =>
  useResource<Client[]>(() => api.clients.list(), [], [], 'clients:list');
export const useDocuments = () =>
  useResource<AccountingDocument[]>(() => api.documents.list(), [], [], 'documents:list');
export const useProducts = () =>
  useResource<Product[]>(() => api.products.list(), [], [], 'products:list');
export const useRoutes = () =>
  useResource<DeliveryRoute[]>(() => api.routes.list(), [], [], 'routes:list');
export const useVehicles = () =>
  useResource<Vehicle[]>(() => api.vehicles.list(), [], [], 'vehicles:list');
export const useStockMoves = (productId?: string) =>
  useResource<StockMove[]>(() => api.stock.moves(productId), [], [productId], 'stock:moves');
export const useRegisterEntries = () =>
  useResource<RegisterEntry[]>(() => api.registers.list(), [], [], 'registers:list');
export const useMachines = () =>
  useResource<MachineAvailability[]>(() => api.machines.list(), [], [], 'machines:list');
export const useTasks = () => useResource<Task[]>(() => api.tasks.list(), [], [], 'tasks:list');
export const useBankTransactions = () =>
  useResource<BankTransaction[]>(() => api.bank.list(), [], [], 'bank:list');
export const useBankSummary = () =>
  useResource<BankSummary | null>(() => api.bank.summary(), null, [], 'bank:summary');
export const useDashboard = () =>
  useResource<DashboardStats | null>(() => api.stats.dashboard(), null, [], 'stats:dashboard');
export const useSettings = () =>
  useResource<Settings | null>(() => api.settings.get(), null, [], 'settings:get');

export function useClientIndex(clients: Client[]): Map<string, Client> {
  return useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
}

/** Extrait le message d'une erreur pour l'afficher tel quel. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
