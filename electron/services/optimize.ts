/**
 * Optimisation de tournée (problème du voyageur de commerce) avec contraintes
 * d'épinglage : certains arrêts doivent rester à une position imposée.
 *
 * - n ≤ 10 sans épinglage : résolution exacte (programmation dynamique de
 *   Held-Karp) — l'ordre renvoyé est le minimum global.
 * - au-delà : construction par plus proche voisin (multi-départ) puis
 *   amélioration 2-opt et Or-opt, en ne déplaçant jamais un arrêt épinglé.
 */

export interface TourProblem {
  /** Matrice des coûts, indices 0..n-1 (généralement des kilomètres). */
  cost: number[][];
  /** Index du point de départ. */
  start: number;
  /** Index du point d'arrivée ; égal à `start` pour une boucle, `null` si libre. */
  end: number | null;
  /** Index des arrêts à ordonner. */
  stops: number[];
  /** arrêt → position figée dans la séquence (0-based). */
  pinned: Map<number, number>;
}

export interface TourSolution {
  /** Séquence des arrêts (hors départ/arrivée). */
  order: number[];
  cost: number;
  method: 'exact' | 'heuristic' | 'trivial';
  iterations: number;
}

export function tourCost(problem: TourProblem, order: number[]): number {
  const { cost, start, end } = problem;
  if (!order.length) {
    return end !== null && end !== start ? cost[start][end] : 0;
  }
  let total = cost[start][order[0]];
  for (let i = 0; i + 1 < order.length; i++) total += cost[order[i]][order[i + 1]];
  if (end !== null) total += cost[order[order.length - 1]][end];
  return total;
}

/** Vérifie que chaque arrêt épinglé occupe bien sa position imposée. */
export function respectsPins(order: number[], pinned: Map<number, number>): boolean {
  for (const [stop, position] of pinned) {
    if (position < 0 || position >= order.length) continue;
    if (order[position] !== stop) return false;
  }
  return true;
}

/** Séquence initiale : arrêts épinglés à leur place, les autres au plus proche voisin. */
function nearestNeighbour(problem: TourProblem, firstFree: number | null): number[] {
  const { cost, start, stops, pinned } = problem;
  const n = stops.length;
  const order = new Array<number>(n).fill(-1);

  const pinnedByPos = new Map<number, number>();
  for (const [stop, pos] of pinned) {
    if (pos >= 0 && pos < n) pinnedByPos.set(pos, stop);
  }

  const remaining = new Set(stops.filter((s) => !pinned.has(s)));
  let current = start;

  for (let pos = 0; pos < n; pos++) {
    const pinnedStop = pinnedByPos.get(pos);
    if (pinnedStop !== undefined) {
      order[pos] = pinnedStop;
      current = pinnedStop;
      continue;
    }
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    // Multi-départ : au tout premier arrêt libre, on impose la graine pour
    // explorer une autre région de l'espace des solutions.
    const isFirstFreeChoice = remaining.size === stops.length - pinned.size;
    if (firstFree !== null && isFirstFreeChoice && remaining.has(firstFree)) {
      best = firstFree;
    } else {
      for (const candidate of remaining) {
        const c = cost[current][candidate];
        if (c < bestCost) {
          bestCost = c;
          best = candidate;
        }
      }
    }
    if (best === -1) break;
    remaining.delete(best);
    order[pos] = best;
    current = best;
  }

  // Sécurité : complète les positions restées vides.
  if (remaining.size) {
    for (let pos = 0; pos < n && remaining.size; pos++) {
      if (order[pos] === -1) {
        const next = remaining.values().next().value as number;
        remaining.delete(next);
        order[pos] = next;
      }
    }
  }
  return order.filter((v) => v !== -1);
}

/** Résolution exacte par programmation dynamique — réservée aux petites tournées. */
function heldKarp(problem: TourProblem): TourSolution {
  const { cost, start, end, stops } = problem;
  const n = stops.length;
  const full = 1 << n;
  const dp = Array.from({ length: full }, () => new Float64Array(n).fill(Number.POSITIVE_INFINITY));
  const parent = Array.from({ length: full }, () => new Int16Array(n).fill(-1));

  for (let i = 0; i < n; i++) dp[1 << i][i] = cost[start][stops[i]];

  for (let mask = 1; mask < full; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const base = dp[mask][last];
      if (!Number.isFinite(base)) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nextMask = mask | (1 << next);
        const candidate = base + cost[stops[last]][stops[next]];
        if (candidate < dp[nextMask][next]) {
          dp[nextMask][next] = candidate;
          parent[nextMask][next] = last;
        }
      }
    }
  }

  let bestLast = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  const finalMask = full - 1;
  for (let last = 0; last < n; last++) {
    const total = dp[finalMask][last] + (end !== null ? cost[stops[last]][end] : 0);
    if (total < bestCost) {
      bestCost = total;
      bestLast = last;
    }
  }

  const order: number[] = [];
  let mask = finalMask;
  let last = bestLast;
  while (last !== -1) {
    order.unshift(stops[last]);
    const prev = parent[mask][last];
    mask ^= 1 << last;
    last = prev;
  }
  return { order, cost: bestCost, method: 'exact', iterations: full * n };
}

/** Amélioration 2-opt : inverse un segment, uniquement s'il ne contient aucun arrêt épinglé. */
function twoOpt(problem: TourProblem, order: number[], maxIterations: number): { order: number[]; iterations: number } {
  const { pinned } = problem;
  let best = [...order];
  let bestCost = tourCost(problem, best);
  let improved = true;
  let iterations = 0;

  while (improved && iterations < maxIterations) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        iterations++;
        if (iterations > maxIterations) break;
        // Un segment contenant un arrêt épinglé ne peut pas être inversé.
        let hasPinned = false;
        for (let k = i; k <= j; k++) {
          if (pinned.has(best[k])) {
            hasPinned = true;
            break;
          }
        }
        if (hasPinned) continue;

        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const candidateCost = tourCost(problem, candidate);
        if (candidateCost < bestCost - 1e-9) {
          best = candidate;
          bestCost = candidateCost;
          improved = true;
        }
      }
    }
  }
  return { order: best, iterations };
}

/** Or-opt : déplace un segment de 1 à 3 arrêts ailleurs dans la tournée. */
function orOpt(problem: TourProblem, order: number[], maxIterations: number): { order: number[]; iterations: number } {
  const { pinned } = problem;
  let best = [...order];
  let bestCost = tourCost(problem, best);
  let iterations = 0;
  let improved = true;

  while (improved && iterations < maxIterations) {
    improved = false;
    for (let size = 1; size <= 3 && size < best.length; size++) {
      for (let i = 0; i + size <= best.length; i++) {
        const segment = best.slice(i, i + size);
        if (segment.some((s) => pinned.has(s))) continue;
        const rest = [...best.slice(0, i), ...best.slice(i + size)];
        for (let j = 0; j <= rest.length; j++) {
          iterations++;
          if (iterations > maxIterations) break;
          if (j === i) continue;
          const candidate = [...rest.slice(0, j), ...segment, ...rest.slice(j)];
          if (!respectsPins(candidate, pinned)) continue;
          const candidateCost = tourCost(problem, candidate);
          if (candidateCost < bestCost - 1e-9) {
            best = candidate;
            bestCost = candidateCost;
            improved = true;
          }
        }
      }
    }
  }
  return { order: best, iterations };
}

export function solveTour(problem: TourProblem, options: { maxIterations?: number } = {}): TourSolution {
  const { stops, pinned } = problem;
  const maxIterations = options.maxIterations ?? 60000;

  if (stops.length <= 1) {
    return { order: [...stops], cost: tourCost(problem, stops), method: 'trivial', iterations: 0 };
  }

  // Résolution exacte quand c'est raisonnable et sans contrainte d'épinglage.
  if (stops.length <= 10 && pinned.size === 0) {
    return heldKarp(problem);
  }

  const freeStops = stops.filter((s) => !pinned.has(s));
  // Multi-départ : on essaie plusieurs premiers arrêts, on garde la meilleure tournée.
  const seeds: (number | null)[] = [null, ...freeStops.slice(0, 8)];

  let best: number[] = [];
  let bestCost = Number.POSITIVE_INFINITY;
  let iterations = 0;

  for (const seed of seeds) {
    let candidate = nearestNeighbour(problem, seed);
    const two = twoOpt(problem, candidate, Math.floor(maxIterations / seeds.length));
    candidate = two.order;
    iterations += two.iterations;
    const or = orOpt(problem, candidate, Math.floor(maxIterations / (seeds.length * 2)));
    candidate = or.order;
    iterations += or.iterations;

    const c = tourCost(problem, candidate);
    if (c < bestCost && respectsPins(candidate, pinned)) {
      bestCost = c;
      best = candidate;
    }
  }

  if (!best.length) {
    best = nearestNeighbour(problem, null);
    bestCost = tourCost(problem, best);
  }

  return { order: best, cost: bestCost, method: 'heuristic', iterations };
}
