import type { Client } from '@shared/types';
import type { GeocodeProgress } from '@shared/api';
import { nowIso, store } from '../store';
import { cleanAddressLine } from './address';
import { geocodeOne } from './routing';

/**
 * Géolocalisation des fiches clients, en tâche de fond.
 *
 * Elle se faisait dans la requête : sept cents adresses à interroger l'une
 * après l'autre, la réponse n'arrivait jamais avant l'expiration du délai —
 * le poste se croyait hors ligne et basculait sur sa copie locale, alors que
 * le serveur travaillait toujours. Le travail vit désormais sa vie côté
 * serveur ; la requête ne fait que le lancer, et un second canal donne
 * l'avancement à qui veut l'afficher.
 */

export interface GeocodeDeps {
  /** Injectable pour les tests : jamais de vrai appel réseau dans la suite. */
  geocode?: typeof geocodeOne;
  /** Politesse envers le service public : pause entre deux adresses. */
  delayMs?: number;
}

/** Ce qu'on envoie au service d'adresses : les morceaux sûrs d'abord. */
export function addressQuery(client: Client): string {
  return addressQueries(client)[0] ?? '';
}

/**
 * Les tentatives, de la plus précise à la plus grossière.
 *
 * Une seule question ne suffisait pas. Les listes importées portent souvent un
 * e-mail, un téléphone ou un prénom collés dans la rue — « 158 RUE DE BELGIQUE
 * atonaise56@gmail.com JULIEN » —, et le service d'adresses ne reconnaît rien.
 * La fiche restait alors sans coordonnées pour toujours : chaque passe la
 * reprenait et échouait pareil, si bien que le compteur ne descendait jamais.
 *
 * On nettoie donc la question, puis on se replie sur le code postal et la
 * ville. Le point tombe au centre de la commune plutôt que devant la porte —
 * mais un client placé dans la bonne ville entre dans une tournée, alors
 * qu'un client sans coordonnées n'y entre pas du tout.
 */
export function addressQueries(client: Client): string[] {
  const { address } = client;
  const precise = cleanAddressLine(
    [address.street, address.postcode, address.city].filter(Boolean).join(' '),
  );
  const commune = [address.postcode, address.city].filter(Boolean).join(' ').trim();
  const label = cleanAddressLine(address.label ?? '');

  const attempts = [precise || label, label, commune];
  const seen = new Set<string>();
  return attempts.filter((query) => {
    const clean = query.trim();
    if (!clean || seen.has(clean)) return false;
    seen.add(clean);
    return true;
  });
}

let state: GeocodeProgress = {
  running: false,
  processed: 0,
  located: 0,
  failed: 0,
  total: 0,
};

let job: Promise<void> | null = null;

export function geocodeStatus(): GeocodeProgress {
  return { ...state };
}

/**
 * Lance la passe si elle ne tourne pas déjà, et répond tout de suite.
 * Relancer pendant qu'elle tourne ne fait que renvoyer l'avancement en cours.
 */
export function startGeocode(deps: GeocodeDeps = {}): GeocodeProgress {
  if (state.running) return { ...state };

  const lookup = deps.geocode ?? geocodeOne;
  const delayMs = deps.delayMs ?? 120;
  const targets = store.db.clients.filter(
    (c) => !c.archived && typeof c.address.lat !== 'number' && addressQuery(c),
  );

  state = { running: targets.length > 0, processed: 0, located: 0, failed: 0, total: targets.length };
  if (!targets.length) return { ...state };

  job = (async () => {
    for (const client of targets) {
      try {
        // Chaque tentative est moins précise que la précédente : on s'arrête
        // à la première qui répond.
        let found: Awaited<ReturnType<typeof lookup>> = null;
        for (const query of addressQueries(client)) {
          found = await lookup(query);
          if (found) break;
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const hit = found;
        if (hit) {
          store.mutate(() => {
            client.address = {
              ...client.address,
              label: client.address.label || hit.label,
              postcode: client.address.postcode ?? hit.postcode,
              city: client.address.city ?? hit.city,
              lat: hit.lat,
              lon: hit.lon,
            };
            client.updatedAt = nowIso();
          });
          state.located++;
        } else {
          state.failed++;
        }
      } catch {
        state.failed++;
      }
      state.processed++;
      // Écrit par paquets : un arrêt du serveur en pleine passe ne perd pas tout.
      if (state.processed % 25 === 0) store.flushSync();
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    store.flushSync();
    state.running = false;
    state.finishedAt = nowIso();
  })().finally(() => {
    job = null;
  });

  return { ...state };
}

/** Attend la fin de la passe en cours — pour les tests uniquement. */
export async function waitGeocode(): Promise<void> {
  if (job) await job;
}
