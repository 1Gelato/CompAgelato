import Constants, { ExecutionEnvironment } from 'expo-constants';

/**
 * Où tourne le code : dans une vraie installation, ou dans l'application
 * Expo Go pendant un essai ?
 *
 * La question n'est pas cosmétique. Expo Go est un bac à sable partagé par
 * tous les projets Expo : il ne reçoit plus les notifications distantes
 * (retirées du SDK 53), et il n'a pas de service de mises à jour puisque le
 * code lui arrive en direct de Metro. Sans ce test, l'écran Réglages annonce
 * des pannes qui n'en sont pas — « Firebase n'a pas délivré de jeton » alors
 * que rien n'est cassé.
 *
 * Ce module est volontairement seul dans son fichier : `push.ts` et
 * `runtime.ts` s'importent déjà l'un l'autre, et y ajouter cette fonction
 * fermerait le cycle.
 */
export function isExpoGo(): boolean {
  // `StoreClient` couvre Expo Go et les builds de développement
  // (`expo-dev-client`). CompaGelato n'en construit pas : ici, c'est Expo Go.
  return Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}
