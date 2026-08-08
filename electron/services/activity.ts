import type { ActivityEvent } from '@shared/types';
import { currentIdentity } from '../context';
import { nowIso } from '../store';

/**
 * Annonce une arrivée à tous les postes branchés.
 *
 * Le serveur ne décide pas ce qui sera montré : il dit ce qui vient
 * d'arriver et *qui* l'a provoqué. Chaque poste écarte ensuite ce qu'il a
 * lui-même déclenché et applique ses propres réglages — c'est le seul endroit
 * où ces réglages ont un sens, puisqu'ils dépendent de qui est devant l'écran.
 *
 * L'auteur est lu dans le contexte de la requête en cours. Il vaut `null` hors
 * requête : ainsi une pièce ramassée par la surveillance du dossier serveur
 * n'appartient à personne et sera annoncée à tout le monde, ce qui est
 * exactement l'intention.
 */
let publish: (event: ActivityEvent) => void = () => {};

/** Branche la diffusion. Sans branchement, annoncer ne fait rien. */
export function setActivityPublisher(fn: (event: ActivityEvent) => void): void {
  publish = fn;
}

export function announce(
  source: ActivityEvent['source'],
  title: string,
  text: string,
): ActivityEvent {
  const event: ActivityEvent = {
    source,
    title,
    text,
    by: currentIdentity()?.userId ?? null,
    at: nowIso(),
  };
  // Une annonce ne doit jamais faire échouer l'enregistrement qui l'a
  // déclenchée : la donnée compte, la bulle non.
  try {
    publish(event);
  } catch {
    /* diffusion impossible : sans conséquence */
  }
  return event;
}
