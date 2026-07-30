import type { Address, AddressSuggestion } from '@shared/types';
import { round2 } from './text';

/* ------------------------------------------------------------------ */
/* Utilitaires réseau                                                   */
/* ------------------------------------------------------------------ */

const USER_AGENT = 'CompaGelato/1.0 (ERP de gestion, usage professionnel)';

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${new URL(url).host}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 12000): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${new URL(url).host}`);
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Géométrie                                                            */
/* ------------------------------------------------------------------ */

export interface Point {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_KM = 6371.0088;

/** Distance orthodromique en kilomètres. */
export function haversineKm(a: Point, b: Point): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Facteur de sinuosité : le réseau routier est plus long que la ligne droite.
 * 1,35 est la valeur usuelle en France pour des trajets régionaux.
 */
const ROAD_FACTOR = 1.35;

/** Vitesse moyenne estimée selon la distance (urbain lent, route rapide). */
function estimatedSpeedKmh(distanceKm: number): number {
  if (distanceKm < 3) return 22;
  if (distanceKm < 10) return 35;
  if (distanceKm < 30) return 55;
  if (distanceKm < 80) return 72;
  return 85;
}

export function estimateLeg(a: Point, b: Point): { distanceKm: number; durationMin: number } {
  const straight = haversineKm(a, b);
  const distanceKm = round2(straight * ROAD_FACTOR);
  const durationMin = Math.round((distanceKm / estimatedSpeedKmh(distanceKm)) * 60);
  return { distanceKm, durationMin };
}

/* ------------------------------------------------------------------ */
/* Auto-complétion d'adresses                                           */
/* ------------------------------------------------------------------ */

interface BanFeature {
  properties: {
    label: string;
    score: number;
    name?: string;
    postcode?: string;
    city?: string;
    context?: string;
    street?: string;
    type?: string;
  };
  geometry: { coordinates: [number, number] };
}

/**
 * Auto-complétion via la Base Adresse Nationale (api-adresse.data.gouv.fr).
 * Service public gratuit, sans clé d'API. Repli sur Nominatim (OpenStreetMap)
 * pour les adresses hors de France.
 */
export async function autocompleteAddress(
  query: string,
  options: { near?: Point; limit?: number } = {},
): Promise<AddressSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const limit = options.limit ?? 8;

  try {
    const params = new URLSearchParams({ q, limit: String(limit), autocomplete: '1' });
    if (options.near) {
      params.set('lat', String(options.near.lat));
      params.set('lon', String(options.near.lon));
    }
    const data = await getJson<{ features: BanFeature[] }>(
      `https://api-adresse.data.gouv.fr/search/?${params.toString()}`,
      6000,
    );
    const out = (data.features ?? []).map((f) => ({
      label: f.properties.label,
      street: f.properties.name ?? f.properties.street,
      postcode: f.properties.postcode,
      city: f.properties.city,
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      score: f.properties.score ?? 0,
      context: f.properties.context,
    }));
    if (out.length) return out;
  } catch {
    /* on tente le service de repli */
  }

  try {
    const params = new URLSearchParams({
      q,
      format: 'jsonv2',
      limit: String(limit),
      addressdetails: '1',
    });
    const data = await getJson<
      {
        display_name: string;
        lat: string;
        lon: string;
        importance?: number;
        address?: Record<string, string>;
      }[]
    >(`https://nominatim.openstreetmap.org/search?${params.toString()}`, 8000);
    return data.map((r) => ({
      label: r.display_name,
      street: [r.address?.house_number, r.address?.road].filter(Boolean).join(' ') || undefined,
      postcode: r.address?.postcode,
      city: r.address?.city ?? r.address?.town ?? r.address?.village,
      lat: Number(r.lat),
      lon: Number(r.lon),
      score: r.importance ?? 0,
      context: r.address?.country,
    }));
  } catch {
    return [];
  }
}

export async function reverseGeocode(lat: number, lon: number): Promise<Address | null> {
  try {
    const data = await getJson<{ features: BanFeature[] }>(
      `https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}`,
      6000,
    );
    const f = data.features?.[0];
    if (!f) return null;
    return {
      label: f.properties.label,
      street: f.properties.name,
      postcode: f.properties.postcode,
      city: f.properties.city,
      country: 'France',
      lat,
      lon,
    };
  } catch {
    return null;
  }
}

/** Géocode une adresse écrite en clair (import de clients, dépôt…). */
export async function geocodeOne(text: string): Promise<AddressSuggestion | null> {
  const results = await autocompleteAddress(text, { limit: 1 });
  return results[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Matrice de distances et itinéraires (OSRM)                           */
/* ------------------------------------------------------------------ */

export type Engine = 'osrm' | 'haversine';

export interface Matrix {
  distanceKm: number[][];
  durationMin: number[][];
  engine: Engine;
}

const OSRM_BASE = 'https://router.project-osrm.org';
const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de';

function coordsParam(points: Point[]): string {
  return points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}

/* --- Lecture des réponses (fonctions pures, testées unitairement) --- */

export interface OsrmTableResponse {
  code?: string;
  distances?: (number | null)[][];
  durations?: (number | null)[][];
}

/** Convertit une réponse OSRM /table (mètres, secondes) en matrice km / minutes. */
export function parseOsrmTable(data: OsrmTableResponse, fallback: Matrix): Matrix {
  if (data.code !== 'Ok' || !data.distances || !data.durations) throw new Error('OSRM : réponse invalide');
  const n = fallback.distanceKm.length;
  const distanceKm = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const durationMin = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = data.distances[i]?.[j];
      const t = data.durations[i]?.[j];
      // Une case nulle (point non raccordé au réseau) reprend l'estimation.
      distanceKm[i][j] = d === null || d === undefined ? fallback.distanceKm[i][j] : round2(d / 1000);
      durationMin[i][j] = t === null || t === undefined ? fallback.durationMin[i][j] : Math.round(t / 60);
    }
  }
  return { distanceKm, durationMin, engine: 'osrm' };
}

export interface OsrmRouteResponse {
  code?: string;
  routes?: { legs: { distance: number; duration: number }[] }[];
}

export function parseOsrmRoute(data: OsrmRouteResponse): LegResult[] {
  const route = data.routes?.[0];
  if (data.code !== 'Ok' || !route) throw new Error('OSRM : itinéraire indisponible');
  return route.legs.map((l) => ({
    distanceKm: round2(l.distance / 1000),
    durationMin: Math.round(l.duration / 60),
  }));
}

export interface ValhallaMatrixResponse {
  sources_to_targets?: ({ distance?: number | null; time?: number | null } | null)[][];
}

/** Convertit une réponse Valhalla /sources_to_targets (km, secondes) en matrice. */
export function parseValhallaMatrix(data: ValhallaMatrixResponse, fallback: Matrix): Matrix {
  const rows = data.sources_to_targets;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Valhalla : réponse invalide');
  const n = fallback.distanceKm.length;
  const distanceKm = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const durationMin = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const cell = rows[i]?.[j];
      const d = cell?.distance;
      const t = cell?.time;
      distanceKm[i][j] = d === null || d === undefined ? fallback.distanceKm[i][j] : round2(d);
      durationMin[i][j] = t === null || t === undefined ? fallback.durationMin[i][j] : Math.round(t / 60);
    }
  }
  return { distanceKm, durationMin, engine: 'osrm' };
}

export interface ValhallaRouteResponse {
  trip?: { legs?: { summary?: { length?: number; time?: number } }[] };
}

export function parseValhallaRoute(data: ValhallaRouteResponse): LegResult[] {
  const legs = data.trip?.legs;
  if (!Array.isArray(legs) || !legs.length) throw new Error('Valhalla : itinéraire indisponible');
  return legs.map((l) => ({
    distanceKm: round2(l.summary?.length ?? 0),
    durationMin: Math.round((l.summary?.time ?? 0) / 60),
  }));
}

function haversineMatrix(points: Point[]): Matrix {
  const n = points.length;
  const distanceKm = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const durationMin = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const leg = estimateLeg(points[i], points[j]);
      distanceKm[i][j] = leg.distanceKm;
      durationMin[i][j] = leg.durationMin;
    }
  }
  return { distanceKm, durationMin, engine: 'haversine' };
}

export interface LegResult {
  distanceKm: number;
  durationMin: number;
}

/**
 * Matrice des distances routières entre tous les points.
 * Deux services publics sans clé d'API sont tentés successivement (OSRM puis
 * Valhalla) ; en dernier recours, estimation hors-ligne — le calcul n'est
 * jamais bloqué par une panne de réseau.
 */
export async function distanceMatrix(points: Point[]): Promise<Matrix> {
  const fallback = haversineMatrix(points);
  if (points.length < 2) return fallback;
  // Au-delà de ~90 points, les services publics refusent la requête.
  if (points.length > 90) return fallback;

  try {
    const url = `${OSRM_BASE}/table/v1/driving/${coordsParam(points)}?annotations=distance,duration`;
    return parseOsrmTable(await getJson<OsrmTableResponse>(url, 12000), fallback);
  } catch {
    /* on tente le service suivant */
  }

  try {
    const locations = points.map((p) => ({ lat: p.lat, lon: p.lon }));
    const data = await postJson<ValhallaMatrixResponse>(`${VALHALLA_BASE}/sources_to_targets`, {
      sources: locations,
      targets: locations,
      costing: 'auto',
      units: 'kilometers',
    });
    return parseValhallaMatrix(data, fallback);
  } catch {
    return fallback;
  }
}

/** Itinéraire réel passant par les points dans l'ordre donné. */
export async function routeLegs(points: Point[]): Promise<{ legs: LegResult[]; engine: Engine }> {
  if (points.length < 2) return { legs: [], engine: 'haversine' };

  try {
    const url = `${OSRM_BASE}/route/v1/driving/${coordsParam(points)}?overview=false&steps=false`;
    return { legs: parseOsrmRoute(await getJson<OsrmRouteResponse>(url, 12000)), engine: 'osrm' };
  } catch {
    /* on tente le service suivant */
  }

  try {
    const data = await postJson<ValhallaRouteResponse>(`${VALHALLA_BASE}/route`, {
      locations: points.map((p) => ({ lat: p.lat, lon: p.lon })),
      costing: 'auto',
      units: 'kilometers',
      directions_type: 'none',
    });
    return { legs: parseValhallaRoute(data), engine: 'osrm' };
  } catch {
    const legs: LegResult[] = [];
    for (let i = 0; i + 1 < points.length; i++) legs.push(estimateLeg(points[i], points[i + 1]));
    return { legs, engine: 'haversine' };
  }
}

/* ------------------------------------------------------------------ */
/* Prix des carburants (données publiques temps réel)                   */
/* ------------------------------------------------------------------ */

const FUEL_FIELD: Record<string, string> = {
  gazole: 'gazole_prix',
  sp95: 'sp95_prix',
  sp98: 'sp98_prix',
  e85: 'e85_prix',
  gplc: 'gplc_prix',
};

export interface FuelPrice {
  price: number;
  source: string;
  updatedAt: string;
  station?: string;
}

/**
 * Relève le prix moyen du carburant autour d'un code postal à partir du flux
 * instantané des prix des carburants (data.economie.gouv.fr, données ouvertes).
 */
export async function fetchFuelPrice(fuelType: string, postcode?: string): Promise<FuelPrice | null> {
  const field = FUEL_FIELD[fuelType];
  if (!field) return null; // véhicule électrique : pas de carburant

  const base =
    'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';
  const params = new URLSearchParams({
    select: `${field},ville,cp,adresse`,
    where: postcode ? `${field} > 0 and cp = "${postcode}"` : `${field} > 0`,
    limit: '40',
  });

  try {
    const data = await getJson<{ results?: Record<string, unknown>[] }>(`${base}?${params}`, 9000);
    let results = data.results ?? [];

    // Aucun relevé sur le code postal exact → on élargit au département.
    if (!results.length && postcode && postcode.length >= 2) {
      const dept = postcode.slice(0, 2);
      const wide = new URLSearchParams({
        select: `${field},ville,cp,adresse`,
        where: `${field} > 0 and startswith(cp, "${dept}")`,
        limit: '60',
      });
      const alt = await getJson<{ results?: Record<string, unknown>[] }>(`${base}?${wide}`, 9000);
      results = alt.results ?? [];
    }

    const prices = results
      .map((r) => Number(r[field]))
      .filter((n) => Number.isFinite(n) && n > 0.4 && n < 5);
    if (!prices.length) return null;

    // Médiane : insensible aux stations aberrantes (autoroute, promo ponctuelle).
    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const sample = results[0] as { ville?: string; cp?: string } | undefined;

    return {
      price: round2(median),
      source: postcode
        ? `Prix moyen relevé (${prices.length} stations, ${postcode})`
        : `Prix moyen national (${prices.length} stations)`,
      updatedAt: new Date().toISOString(),
      station: sample?.ville ? `${sample.ville} (${sample.cp ?? ''})`.trim() : undefined,
    };
  } catch {
    return null;
  }
}
