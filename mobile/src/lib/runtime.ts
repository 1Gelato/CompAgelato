import { AppState } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { Api, AuthIdentity, AuthStatus } from '@shared/api';
import {
  apiConfig,
  buildApi,
  configureApi,
  normalizeServerUrl,
  serverCall,
  setAuthRequiredHandler,
} from '../core/api';
import {
  backOnline,
  hasMirror,
  initOffline,
  invoke,
  isOffline,
  markOffline,
  mirrorIdentity,
  pullNow,
  schedulePull,
  type OfflineStorage,
} from '../core/offline';
import { unregisterFromPush } from './push';

/**
 * Le branchement Expo du cœur portable : où vivent les fichiers, où vit la
 * session, et quand resynchroniser. C'est le seul module qui touche aux API
 * du téléphone — le reste (`core/`) est du TypeScript pur, testé en Node
 * contre un vrai serveur.
 */

/* ------------------------------------------------------------------ */
/* Stockage                                                            */
/* ------------------------------------------------------------------ */

/** Miroir et file d'attente : dossier documents de l'app, survit aux mises à jour. */
const fileStorage: OfflineStorage = {
  async read(name) {
    try {
      const file = new File(Paths.document, name);
      if (!file.exists) return null;
      return await file.text();
    } catch {
      return null;
    }
  },
  async write(name, content) {
    const file = new File(Paths.document, name);
    file.write(content);
  },
};

const SERVER_KEY = 'compagelato.serveur';
const TOKEN_KEY = 'compagelato.jeton';

/* ------------------------------------------------------------------ */
/* L'objet api, le même contrat que partout                             */
/* ------------------------------------------------------------------ */

/** `api.clients.list()`, `api.routes.save(...)` — le contrat `shared/`, sur HTTP. */
export const api = buildApi<Api>(invoke);

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export interface BootState {
  /** Une adresse de serveur est-elle enregistrée ? Sinon : premier démarrage. */
  configured: boolean;
  /** Identité de la session en cours, si le serveur (ou le miroir) la connaît. */
  identity: AuthIdentity | null;
  /** Une connexion est-elle exigée avant d'entrer ? */
  loginRequired: boolean;
  /** Démarrage sans réseau, sur la copie locale. */
  offline: boolean;
}

/** Restaure la session enregistrée et sonde le serveur. Jamais bloquant. */
export async function boot(): Promise<BootState> {
  const [serverUrl, token] = await Promise.all([
    SecureStore.getItemAsync(SERVER_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  configureApi({ baseUrl: serverUrl ?? '', token: token ?? '' });
  await initOffline(fileStorage);

  if (!serverUrl) return { configured: false, identity: null, loginRequired: false, offline: false };

  try {
    const status = (await serverCall('auth', 'status', [])) as AuthStatus;
    return {
      configured: true,
      identity: status.identity,
      loginRequired: status.required && !status.identity,
      offline: false,
    };
  } catch {
    // Serveur muet : on s'ouvre sur le miroir s'il existe — c'est tout l'objet
    // du hors-ligne. Sans miroir, l'écran de connexion expliquera.
    markOffline();
    const identity = mirrorIdentity();
    return {
      configured: true,
      identity,
      loginRequired: !identity && !hasMirror(),
      offline: true,
    };
  }
}

export async function saveServerUrl(raw: string): Promise<string> {
  const url = normalizeServerUrl(raw);
  await SecureStore.setItemAsync(SERVER_KEY, url);
  configureApi({ baseUrl: url });
  return url;
}

export async function login(username: string, password: string): Promise<AuthIdentity> {
  const outcome = (await serverCall('auth', 'login', [
    // Session d'appareil : 180 jours — personne ne tape un mot de passe à 6 h
    // du matin dans une camionnette.
    { username, password, device: true, label: 'Téléphone CompaGelato' },
  ])) as { identity: AuthIdentity; token: string };
  await SecureStore.setItemAsync(TOKEN_KEY, outcome.token);
  configureApi({ token: outcome.token });
  // Première synchronisation dans la foulée : le miroir est prêt avant même
  // que l'utilisateur n'ouvre un écran.
  pullNow().catch(() => {});
  return outcome.identity;
}

export async function logout(): Promise<void> {
  // Désabonner **avant** de fermer la session : après, le serveur refuserait
  // l'appel faute de jeton, et le téléphone continuerait de sonner.
  await unregisterFromPush();
  try {
    await serverCall('auth', 'logout', []);
  } catch {
    /* serveur muet : la session locale part quand même */
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  configureApi({ token: '' });
}

export function serverUrl(): string {
  return apiConfig().baseUrl;
}

export { setAuthRequiredHandler };

/* ------------------------------------------------------------------ */
/* Fichiers du serveur (PDF)                                            */
/* ------------------------------------------------------------------ */

/** Télécharge un fichier du serveur dans le cache et renvoie son URI locale. */
export async function downloadFile(route: string, fileName: string): Promise<string> {
  const { baseUrl, token } = apiConfig();
  const sep = route.includes('?') ? '&' : '?';
  const url = `${baseUrl}${route}${sep}token=${encodeURIComponent(token)}`;
  const target = new File(Paths.cache, fileName.replace(/[\\/:*?"<>|]/g, '_'));
  if (target.exists) target.delete();
  const file = await File.downloadFileAsync(url, new Directory(Paths.cache), {
    // Un nouveau téléchargement remplace l'ancien exemplaire du cache.
    idempotent: true,
  });
  return file.uri;
}

/* ------------------------------------------------------------------ */
/* Vie de l'application : resynchronisations                            */
/* ------------------------------------------------------------------ */

/**
 * Rafraîchissement : au retour au premier plan, puis toutes les deux minutes
 * tant que l'app est ouverte. Chaque passe tente aussi la reconnexion quand on
 * est hors ligne — le retour du réseau rejoue la file et prévient l'écran.
 */
export function startLive(onFresh: () => void): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    try {
      if (isOffline()) {
        await backOnline();
        if (!isOffline()) onFresh();
      } else {
        await pullNow();
        onFresh();
      }
    } catch {
      /* toujours hors ligne : la prochaine passe réessaiera */
    }
  };

  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void tick();
  });
  timer = setInterval(tick, 2 * 60_000);
  void tick();

  return () => {
    subscription.remove();
    if (timer) clearInterval(timer);
  };
}

export { hasMirror, isOffline, schedulePull };
