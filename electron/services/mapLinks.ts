export interface MapPoint {
  label: string;
  lat?: number;
  lon?: number;
  address?: string;
}

export interface MapSegment {
  url: string;
  from: string;
  to: string;
  stops: number;
}

/** Coordonnées si disponibles, sinon adresse en clair (les deux fonctionnent). */
function locator(p: MapPoint): string {
  if (typeof p.lat === 'number' && typeof p.lon === 'number') {
    return `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  }
  return p.address ?? p.label;
}

function chunkRoute(points: MapPoint[], maxPerSegment: number): MapPoint[][] {
  if (points.length <= maxPerSegment) return [points];
  const segments: MapPoint[][] = [];
  let i = 0;
  while (i < points.length - 1) {
    const end = Math.min(i + maxPerSegment, points.length);
    segments.push(points.slice(i, end));
    // Le dernier point d'un segment devient le premier du suivant.
    i = end - 1;
  }
  return segments;
}

/**
 * Google Maps — API « universal URL ».
 * Limite de l'API : 1 origine + 1 destination + 9 étapes intermédiaires.
 */
export function googleMapsUrls(points: MapPoint[]): MapSegment[] {
  const valid = points.filter(Boolean);
  if (valid.length < 2) return [];
  return chunkRoute(valid, 11).map((seg) => {
    const params = new URLSearchParams({
      api: '1',
      origin: locator(seg[0]),
      destination: locator(seg[seg.length - 1]),
      travelmode: 'driving',
    });
    const waypoints = seg.slice(1, -1).map(locator);
    if (waypoints.length) params.set('waypoints', waypoints.join('|'));
    return {
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
      from: seg[0].label,
      to: seg[seg.length - 1].label,
      stops: seg.length,
    };
  });
}

/**
 * Waze ne gère qu'une destination à la fois : on produit un lien par étape,
 * à ouvrir successivement pendant la tournée.
 */
export function wazeUrls(points: MapPoint[]): MapSegment[] {
  const valid = points.filter(Boolean);
  if (valid.length < 2) return [];
  const segments: MapSegment[] = [];
  for (let i = 1; i < valid.length; i++) {
    const target = valid[i];
    const hasCoords = typeof target.lat === 'number' && typeof target.lon === 'number';
    const url = hasCoords
      ? `https://waze.com/ul?ll=${target.lat!.toFixed(6)},${target.lon!.toFixed(6)}&navigate=yes`
      : `https://waze.com/ul?q=${encodeURIComponent(target.address ?? target.label)}&navigate=yes`;
    segments.push({ url, from: valid[i - 1].label, to: target.label, stops: 2 });
  }
  return segments;
}

/** Plans (Apple) — chaînage des étapes avec `+to:`. */
export function appleMapsUrls(points: MapPoint[]): MapSegment[] {
  const valid = points.filter(Boolean);
  if (valid.length < 2) return [];
  return chunkRoute(valid, 15).map((seg) => {
    const daddr = seg.slice(1).map(locator).join('+to:');
    const url = `https://maps.apple.com/?saddr=${encodeURIComponent(locator(seg[0]))}&daddr=${encodeURIComponent(
      daddr,
    )}&dirflg=d`;
    return { url, from: seg[0].label, to: seg[seg.length - 1].label, stops: seg.length };
  });
}

export function buildMapUrls(provider: 'google' | 'waze' | 'apple', points: MapPoint[]): MapSegment[] {
  switch (provider) {
    case 'waze':
      return wazeUrls(points);
    case 'apple':
      return appleMapsUrls(points);
    default:
      return googleMapsUrls(points);
  }
}

export function providerLabel(provider: 'google' | 'waze' | 'apple'): string {
  return provider === 'waze' ? 'Waze' : provider === 'apple' ? 'Plans (Apple)' : 'Google Maps';
}

/** Limite d'étapes par lien, affichée dans l'interface. */
export function providerLimit(provider: 'google' | 'waze' | 'apple'): number {
  return provider === 'waze' ? 2 : provider === 'apple' ? 15 : 11;
}
