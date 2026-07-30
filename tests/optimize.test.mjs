import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveTour,
  tourCost,
  respectsPins,
  haversineKm,
  estimateLeg,
} from './build/services.mjs';

/** Matrice de coûts euclidienne à partir de points (x, y). */
function matrixFrom(points) {
  return points.map((a) => points.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
}

/** Meilleur ordre par force brute — référence pour valider l'heuristique. */
function bruteForce(cost, start, end, stops) {
  let best = null;
  let bestCost = Infinity;
  const permute = (arr, current = []) => {
    if (!arr.length) {
      const c = tourCost({ cost, start, end, stops, pinned: new Map() }, current);
      if (c < bestCost) {
        bestCost = c;
        best = [...current];
      }
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      permute([...arr.slice(0, i), ...arr.slice(i + 1)], [...current, arr[i]]);
    }
  };
  permute(stops);
  return { order: best, cost: bestCost };
}

test('résolution exacte : optimum global sur une petite tournée', () => {
  // Carré : le tour optimal suit le périmètre.
  const points = [
    [0, 0], // dépôt
    [0, 10],
    [10, 10],
    [10, 0],
    [5, 12],
  ];
  const cost = matrixFrom(points);
  const problem = { cost, start: 0, end: 0, stops: [1, 2, 3, 4], pinned: new Map() };
  const solution = solveTour(problem);
  const reference = bruteForce(cost, 0, 0, [1, 2, 3, 4]);

  assert.equal(solution.method, 'exact');
  assert.ok(
    Math.abs(solution.cost - reference.cost) < 1e-9,
    `coût ${solution.cost} ≠ optimum ${reference.cost}`,
  );
});

test("l'optimisation améliore franchement un ordre en zigzag", () => {
  // Deux colonnes de points : l'ordre naturel 1,2,3… fait des allers-retours.
  const points = [[0, 0]];
  for (let i = 0; i < 7; i++) {
    points.push([0, (i + 1) * 3]);
    points.push([14, (i + 1) * 3]);
  }
  const cost = matrixFrom(points);
  const stops = points.map((_, i) => i).slice(1);
  const problem = { cost, start: 0, end: 0, stops, pinned: new Map() };

  const naive = tourCost(problem, stops);
  const solution = solveTour(problem);

  assert.equal(solution.order.length, stops.length);
  assert.equal(new Set(solution.order).size, stops.length, 'chaque arrêt doit apparaître une seule fois');
  assert.ok(solution.cost < naive * 0.75, `attendu < ${naive * 0.75}, obtenu ${solution.cost}`);
});

test('les arrêts épinglés conservent leur position', () => {
  const points = [[0, 0]];
  for (let i = 0; i < 9; i++) points.push([Math.cos(i) * 20, Math.sin(i * 1.7) * 20]);
  const cost = matrixFrom(points);
  const stops = points.map((_, i) => i).slice(1);

  // L'arrêt 5 doit être servi en premier, l'arrêt 2 en dernier.
  const pinned = new Map([
    [5, 0],
    [2, stops.length - 1],
  ]);
  const problem = { cost, start: 0, end: 0, stops, pinned };
  const solution = solveTour(problem);

  assert.equal(solution.order[0], 5, 'arrêt épinglé en tête non respecté');
  assert.equal(solution.order[solution.order.length - 1], 2, 'arrêt épinglé en queue non respecté');
  assert.ok(respectsPins(solution.order, pinned));
  assert.equal(new Set(solution.order).size, stops.length);
});

test('une tournée entièrement épinglée reste inchangée', () => {
  const points = [[0, 0], [5, 5], [1, 9], [8, 2]];
  const cost = matrixFrom(points);
  const stops = [1, 2, 3];
  const pinned = new Map([
    [1, 0],
    [2, 1],
    [3, 2],
  ]);
  const solution = solveTour({ cost, start: 0, end: 0, stops, pinned });
  assert.deepEqual(solution.order, [1, 2, 3]);
});

test('trajet aller simple (sans retour au dépôt)', () => {
  const points = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  const cost = matrixFrom(points);
  const solution = solveTour({ cost, start: 0, end: null, stops: [4, 2, 1, 3], pinned: new Map() });
  assert.deepEqual(solution.order, [1, 2, 3, 4]);
});

test('distances géographiques : Saint-Nazaire → La Baule', () => {
  const stNazaire = { lat: 47.2733, lon: -2.2134 };
  const laBaule = { lat: 47.2864, lon: -2.3933 };
  const km = haversineKm(stNazaire, laBaule);
  // ~13,7 km à vol d'oiseau.
  assert.ok(km > 12 && km < 16, `distance inattendue : ${km}`);

  const leg = estimateLeg(stNazaire, laBaule);
  assert.ok(leg.distanceKm > km, 'la distance routière doit dépasser la ligne droite');
  assert.ok(leg.durationMin > 5 && leg.durationMin < 60);
});
