import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthIdentity } from '@shared/api';
import type { Role } from '@shared/types';

/**
 * Qui appelle, pour la durée d'une requête.
 *
 * Les gestionnaires métier sont de simples fonctions, partagées entre l'IPC du
 * bureau et le HTTP du serveur. Leur ajouter un paramètre « appelant » aurait
 * demandé de toucher aux 100 signatures et à tous les appels. Un stockage lié
 * au contexte d'exécution donne le même résultat sans rien réécrire : le
 * serveur l'ouvre autour du traitement de la requête, les rares gestionnaires
 * qui ont besoin de l'identité la lisent.
 *
 * Hors serveur (application de bureau sur sa propre base), le contexte est
 * vide : il n'y a ni compte ni session, et l'utilisateur a tous les droits sur
 * ses propres données.
 */

export interface CallContext {
  identity: AuthIdentity | null;
  /**
   * Rôle effectif de l'appelant, `null` s'il n'est pas autorisé. Distinct de
   * `identity` : en jeton partagé (aucun compte créé), il n'y a pas d'identité
   * mais bien des droits de gérant.
   */
  role: Role | null;
  /** Jeton de session présenté, pour pouvoir le révoquer à la déconnexion. */
  token: string;
  /** Origine de l'appel, utilisée pour limiter les tentatives de connexion. */
  from: string;
}

const storage = new AsyncLocalStorage<CallContext>();

export function withContext<T>(context: CallContext, run: () => T): T {
  return storage.run(context, run);
}

export function currentContext(): CallContext | undefined {
  return storage.getStore();
}

export function currentIdentity(): AuthIdentity | null {
  return storage.getStore()?.identity ?? null;
}

/**
 * L'appelant est-il autorisé ? Hors serveur le contexte est vide : l'utilisateur
 * est chez lui, sur ses propres données, et a donc tous les droits.
 */
export function currentRole(): Role | null {
  const context = storage.getStore();
  return context ? context.role : 'gerant';
}
