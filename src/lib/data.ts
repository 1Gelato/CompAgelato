import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AccountingDocument,
  Client,
  DashboardStats,
  DeliveryRoute,
  Product,
  Settings,
  StockMove,
  Vehicle,
} from '@shared/types';

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

export function useResource<T>(
  loader: () => Promise<T>,
  initial: T,
  deps: unknown[] = [],
): { data: T; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
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
    let cancelled = false;
    setLoading(true);
    loader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, loading, error, reload };
}

export const useClients = () => useResource<Client[]>(() => window.api.clients.list(), []);
export const useDocuments = () => useResource<AccountingDocument[]>(() => window.api.documents.list(), []);
export const useProducts = () => useResource<Product[]>(() => window.api.products.list(), []);
export const useRoutes = () => useResource<DeliveryRoute[]>(() => window.api.routes.list(), []);
export const useVehicles = () => useResource<Vehicle[]>(() => window.api.vehicles.list(), []);
export const useStockMoves = (productId?: string) =>
  useResource<StockMove[]>(() => window.api.stock.moves(productId), [], [productId]);
export const useDashboard = () =>
  useResource<DashboardStats | null>(() => window.api.stats.dashboard(), null);
export const useSettings = () => useResource<Settings | null>(() => window.api.settings.get(), null);

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
