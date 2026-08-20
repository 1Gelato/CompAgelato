import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { serverCall } from '../core/api';

/**
 * Notifications natives de CompaGelato.
 *
 * L'application reçoit un jeton d'appareil de Firebase et le confie au
 * serveur, qui s'en sert pour la réveiller — y compris fermée, écran éteint.
 * Rien à installer à côté, aucun sujet à saisir : c'est CompaGelato qui sonne.
 *
 * Deux principes gouvernent ce module :
 *
 * - **Rien n'est bloquant.** Permission refusée, Firebase absent du téléphone,
 *   serveur sans clé : l'application fonctionne exactement pareil, simplement
 *   sans notifications. Une fonctionnalité de confort ne doit jamais empêcher
 *   un livreur de voir sa tournée.
 * - **Le jeton se réaffirme à chaque ouverture.** Firebase le renouvelle
 *   parfois de lui-même ; un abonnement enregistré une fois pour toutes
 *   finirait par ne plus réveiller personne, sans que rien ne le signale.
 */

/**
 * Canal Android. Sans canal déclaré, Android range les notifications en
 * importance minimale : pas de son, pas d'affichage en haut de l'écran — on
 * les découvre le lendemain en déroulant la liste.
 */
const CHANNEL_ID = 'compagelato';

/** Ce que l'application sait de son abonnement, pour l'écran Réglages. */
export type PushState =
  | { status: 'active'; serverReady: boolean }
  /** L'utilisateur a refusé, ou ne s'est pas prononcé. */
  | { status: 'refusée' }
  /** Émulateur sans Google Play, ou plateforme sans push. */
  | { status: 'indisponible'; reason: string }
  | { status: 'erreur'; reason: string };

let current: PushState | null = null;
let lastToken = '';

export function pushState(): PushState | null {
  return current;
}

/** Bulle affichée même quand l'application est ouverte au premier plan. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'CompaGelato',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

/**
 * Demande la permission, obtient le jeton, l'enregistre auprès du serveur.
 *
 * Appelée après chaque connexion et à chaque retour au premier plan. Ne lève
 * jamais : l'état est rangé dans `current` et l'écran Réglages le montre.
 */
export async function registerForPush(): Promise<PushState> {
  try {
    // Un émulateur sans services Google ne recevra jamais rien : le dire vaut
    // mieux que laisser croire que les notifications marchent.
    if (!Device.isDevice) {
      current = {
        status: 'indisponible',
        reason:
          'Émulateur : les notifications exigent un téléphone réel, ou une image système avec les services Google.',
      };
      return current;
    }

    await ensureChannel();

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) {
      current = { status: 'refusée' };
      return current;
    }

    // Jeton **natif** (FCM), et non un jeton Expo : le serveur parle
    // directement à Firebase, sans passer par le service de push d'Expo.
    const { data: token } = await Notifications.getDevicePushTokenAsync();
    if (typeof token !== 'string' || !token) {
      current = { status: 'erreur', reason: 'Firebase n’a pas délivré de jeton pour cet appareil.' };
      return current;
    }

    const outcome = (await serverCall('push', 'register', [
      {
        token,
        label: Device.deviceName || Device.modelName || 'Téléphone',
        platform: Platform.OS,
      },
    ])) as { registered: boolean; enabled: boolean };

    lastToken = token;
    current = { status: 'active', serverReady: outcome.enabled };
    return current;
  } catch (err) {
    current = { status: 'erreur', reason: (err as Error).message ?? String(err) };
    return current;
  }
}

/**
 * Désabonne cet appareil. Appelé à la déconnexion : le téléphone d'un compte
 * fermé ne doit plus annoncer les arrivées de l'entreprise.
 *
 * Le serveur fait déjà le ménage de son côté quand la session se ferme ; cet
 * appel-ci vaut pour le cas où l'on se déconnecte sans que la session soit
 * révoquée, et il est sans effet s'il arrive après.
 */
export async function unregisterFromPush(): Promise<void> {
  const token = lastToken;
  current = null;
  lastToken = '';
  if (!token) return;
  try {
    await serverCall('push', 'unregister', [token]);
  } catch {
    /* serveur muet : la session part quand même, il purgera de son côté */
  }
}

/**
 * Branche l'ouverture de l'écran annoncé quand on touche une notification.
 *
 * Deux chemins : l'application était ouverte (`addNotificationResponse…`), ou
 * elle était fermée et c'est le clic qui l'a lancée (`getLastNotification…`).
 * Oublier le second donnerait une notification qui ouvre l'accueil — c'est
 * précisément le cas le plus fréquent.
 */
export function onNotificationOpened(handler: (page: string) => void): () => void {
  const pageOf = (response: Notifications.NotificationResponse | null): string | null => {
    const data = response?.notification?.request?.content?.data as
      | { page?: string }
      | undefined;
    return typeof data?.page === 'string' ? data.page : null;
  };

  void Notifications.getLastNotificationResponseAsync().then((response) => {
    const page = pageOf(response);
    if (page) handler(page);
  });

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const page = pageOf(response);
    if (page) handler(page);
  });
  return () => subscription.remove();
}
