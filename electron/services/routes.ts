import type {
  DeliveryRoute,
  OptimizeOptions,
  OptimizeResult,
  RouteComputation,
  RouteStop,
  Vehicle,
} from '@shared/types';
import { newId, nowIso, store, today } from '../store';
import { distanceMatrix, routeLegs, type Engine, type Point } from './routing';
import { solveTour, tourCost } from './optimize';
import { round2 } from './text';

/* ------------------------------------------------------------------ */
/* Utilitaires                                                          */
/* ------------------------------------------------------------------ */

export function emptyStop(label = ''): RouteStop {
  return {
    id: newId('stp'),
    label,
    address: { label: '', country: 'France' },
    pinned: false,
    serviceMinutes: 10,
  };
}

/** Un arrêt n'entre dans le calcul que s'il est géolocalisé. */
function hasCoords(stop: RouteStop | null | undefined): boolean {
  return Boolean(
    stop && typeof stop.address?.lat === 'number' && typeof stop.address?.lon === 'number',
  );
}

function toPoint(stop: RouteStop): Point {
  return { lat: stop.address.lat as number, lon: stop.address.lon as number };
}

export function resolveVehicle(route: DeliveryRoute): Vehicle | undefined {
  const db = store.db;
  return (
    db.vehicles.find((v) => v.id === route.vehicleId) ??
    db.vehicles.find((v) => v.id === db.settings.defaultVehicleId) ??
    db.vehicles.find((v) => v.isDefault) ??
    db.vehicles[0]
  );
}

/** Points de l'itinéraire dans l'ordre : départ, arrêts, arrivée. */
export function routePoints(route: DeliveryRoute): RouteStop[] {
  const points: RouteStop[] = [];
  if (hasCoords(route.start)) points.push(route.start);
  points.push(...route.stops.filter(hasCoords));
  if (route.returnToStart && hasCoords(route.start)) points.push(route.start);
  else if (!route.returnToStart && hasCoords(route.end)) points.push(route.end as RouteStop);
  return points;
}

/* ------------------------------------------------------------------ */
/* Calcul de coût                                                       */
/* ------------------------------------------------------------------ */

export interface CostBreakdown extends RouteComputation {}

/**
 * Calcule distance, durée et coût complet d'une tournée.
 * Le coût combine carburant (consommation × prix du litre), usure kilométrique
 * du véhicule, temps de conduite valorisé et péages saisis.
 */
export async function computeRoute(
  route: DeliveryRoute,
): Promise<{ route: DeliveryRoute; computation: RouteComputation }> {
  const vehicle = resolveVehicle(route);
  const settings = store.settings;
  const ordered = routePoints(route);

  let distanceKm = 0;
  let durationMin = 0;
  let engine: Engine = 'haversine';
  const legs: { distanceKm: number; durationMin: number }[] = [];

  if (ordered.length >= 2) {
    const result = await routeLegs(ordered.map(toPoint));
    engine = result.engine;
    legs.push(...result.legs);
    for (const leg of result.legs) {
      distanceKm += leg.distanceKm;
      durationMin += leg.durationMin;
    }
  }

  // Chaque arrêt reçoit la distance du tronçon qui y mène.
  const updatedStops = route.stops.map((stop) => ({ ...stop }));
  let legIndex = 0;
  if (hasCoords(route.start)) {
    for (const stop of updatedStops) {
      if (!hasCoords(stop)) {
        stop.legDistanceKm = undefined;
        stop.legDurationMin = undefined;
        continue;
      }
      const leg = legs[legIndex++];
      stop.legDistanceKm = leg?.distanceKm;
      stop.legDurationMin = leg?.durationMin;
    }
  }

  const serviceMin = updatedStops.reduce((s, stop) => s + (Number(stop.serviceMinutes) || 0), 0);
  const consumption = vehicle?.consumption ?? 9;
  const fuelPrice = settings.fuelPricePerLiter ?? 1.75;
  // Véhicule électrique : la « consommation » s'exprime en kWh/100 km et le
  // prix du « litre » en €/kWh — le calcul reste identique.
  const fuelLiters = round2((distanceKm * consumption) / 100);
  const fuelCost = round2(fuelLiters * fuelPrice);
  const maintenanceCost = round2(distanceKm * (vehicle?.maintenancePerKm ?? 0));
  const driverCost = round2(((durationMin + serviceMin) / 60) * (vehicle?.driverCostPerHour ?? 0));
  const tollCost = round2(Number(route.tollCost) || 0);
  const totalCost = round2(fuelCost + maintenanceCost + driverCost + tollCost);

  const computation: RouteComputation = {
    distanceKm: round2(distanceKm),
    durationMin: Math.round(durationMin),
    serviceMin,
    fuelLiters,
    fuelCost,
    maintenanceCost,
    driverCost,
    tollCost,
    totalCost,
    costPerStop: updatedStops.length ? round2(totalCost / updatedStops.length) : 0,
    fuelPricePerLiter: fuelPrice,
    engine,
    computedAt: nowIso(),
  };

  return {
    route: { ...route, stops: updatedStops, computation, updatedAt: nowIso() },
    computation,
  };
}

/* ------------------------------------------------------------------ */
/* Optimisation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Réordonne les arrêts pour minimiser la distance parcourue, en respectant
 * les arrêts épinglés (leur position dans la tournée est figée).
 */
export async function optimizeRoute(
  route: DeliveryRoute,
  options: OptimizeOptions = { returnToStart: true },
): Promise<{ route: DeliveryRoute; result: OptimizeResult; computation: RouteComputation }> {
  const locatable = route.stops.filter(hasCoords);
  const unlocatable = route.stops.filter((s) => !hasCoords(s));

  if (!hasCoords(route.start) || locatable.length < 2) {
    const { route: computed, computation } = await computeRoute(route);
    return {
      route: computed,
      computation,
      result: {
        order: route.stops.map((s) => s.id),
        before: { distanceKm: computation.distanceKm, durationMin: computation.durationMin },
        after: { distanceKm: computation.distanceKm, durationMin: computation.durationMin },
        savedKm: 0,
        savedMin: 0,
        engine: computation.engine,
        pinnedRespected: route.stops.filter((s) => s.pinned).length,
      },
    };
  }

  // Index 0 = départ ; 1..n = arrêts ; dernier = arrivée si différente du départ.
  const nodes: Point[] = [toPoint(route.start), ...locatable.map(toPoint)];
  const useEnd = !route.returnToStart && hasCoords(route.end);
  if (useEnd) nodes.push(toPoint(route.end as RouteStop));

  const matrix = await distanceMatrix(nodes);
  const stopIndices = locatable.map((_, i) => i + 1);
  const endIndex = route.returnToStart ? 0 : useEnd ? nodes.length - 1 : null;

  const pinned = new Map<number, number>();
  locatable.forEach((stop, i) => {
    if (!stop.pinned) return;
    const position = typeof stop.pinnedIndex === 'number' ? stop.pinnedIndex : i;
    pinned.set(i + 1, Math.max(0, Math.min(locatable.length - 1, position)));
  });

  const problem = {
    cost: matrix.distanceKm,
    start: 0,
    end: endIndex,
    stops: stopIndices,
    pinned,
  };

  const beforeOrder = stopIndices;
  const beforeKm = tourCost(problem, beforeOrder);
  const beforeMin = tourCost({ ...problem, cost: matrix.durationMin }, beforeOrder);

  const solution = solveTour(problem, { maxIterations: options.maxIterations ?? 60000 });
  const afterKm = solution.cost;
  const afterMin = tourCost({ ...problem, cost: matrix.durationMin }, solution.order);

  const reordered = solution.order.map((index) => locatable[index - 1]);
  // Les arrêts sans coordonnées sont conservés à la fin, sans être optimisés.
  const newStops = [...reordered, ...unlocatable].map((stop, position) => ({
    ...stop,
    pinnedIndex: stop.pinned ? position : undefined,
  }));

  const optimized: DeliveryRoute = { ...route, stops: newStops, updatedAt: nowIso() };
  const { route: computed, computation } = await computeRoute(optimized);

  return {
    route: computed,
    computation,
    result: {
      order: newStops.map((s) => s.id),
      before: { distanceKm: round2(beforeKm), durationMin: Math.round(beforeMin) },
      after: { distanceKm: round2(afterKm), durationMin: Math.round(afterMin) },
      savedKm: round2(Math.max(0, beforeKm - afterKm)),
      savedMin: Math.round(Math.max(0, beforeMin - afterMin)),
      engine: matrix.engine,
      pinnedRespected: pinned.size,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Persistance                                                          */
/* ------------------------------------------------------------------ */

export function upsertRoute(input: Partial<DeliveryRoute> & { id?: string }): DeliveryRoute {
  return store.mutate((db) => {
    const existing = input.id ? db.routes.find((r) => r.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, { ...input, updatedAt: nowIso() });
      return existing;
    }
    const route: DeliveryRoute = {
      id: input.id ?? newId('rte'),
      name: input.name?.trim() || `Tournée du ${today()}`,
      date: input.date ?? today(),
      vehicleId: input.vehicleId ?? db.settings.defaultVehicleId,
      start: input.start ?? { ...emptyStop('Dépôt'), address: db.settings.depot ?? { label: '', country: 'France' } },
      stops: input.stops ?? [],
      returnToStart: input.returnToStart ?? true,
      end: input.end ?? null,
      tollCost: input.tollCost ?? 0,
      computation: input.computation,
      notes: input.notes,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.routes.unshift(route);
    return route;
  });
}

export function removeRoute(id: string): void {
  store.mutate((db) => {
    db.routes = db.routes.filter((r) => r.id !== id);
  });
}
