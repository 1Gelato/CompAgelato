import type { ActivityEvent, ID, PushDevice } from '@shared/types';
import type { ChannelName } from '@shared/api';
import { mayCall } from '@shared/api';
import { newId, nowIso, store } from '../store';
import { currentIdentity } from '../context';
import { fcmEnabled, sendPush, type FcmDeps } from './fcm';

/**
 * Le registre des téléphones abonnés, et la décision d'à qui pousser quoi.
 *
 * Deux filtres, dans cet ordre, avant tout envoi :
 *
 * 1. **Jamais l'auteur.** Être prévenu de sa propre saisie n'apprend rien et
 *    use la confiance qu'on accorde aux notifications — c'est la règle déjà
 *    appliquée aux bulles du bureau (`shouldNotify`), et elle vaut ici mot pour
 *    mot.
 * 2. **Jamais au-delà du rôle.** Une annonce de facture ne part pas sur le
 *    téléphone d'un livreur : il n'a pas accès aux documents. Masquer un écran
 *    tout en criant son contenu dans la barre de notifications serait une
 *    passoire — le filtre est donc le même que celui des écrans et du miroir,
 *    la table `CHANNEL_ACCESS`.
 */

/** Ce qu'il faut avoir le droit de lire pour être prévenu de chaque source. */
const SOURCE_CHANNEL: Record<ActivityEvent['source'], ChannelName> = {
  register: 'registers:list',
  document: 'documents:list',
  statement: 'bank:list',
  task: 'tasks:list',
  delivery: 'delivery:list',
};

/** Écran à ouvrir au clic — même correspondance que les bulles du bureau. */
const SOURCE_PAGE: Record<ActivityEvent['source'], string> = {
  register: 'cahiers',
  document: 'documents',
  statement: 'banque',
  task: 'taches',
  delivery: 'bons',
};

/**
 * Abonne un appareil.
 *
 * Le jeton fait l'identité : Firebase en attribue un par installation, et le
 * renouvelle parfois de lui-même. L'application rappelle donc cette fonction à
 * chaque ouverture — d'où la mise à jour en place plutôt qu'un doublon.
 */
export function registerDevice(input: {
  token: string;
  label?: string;
  platform?: string;
  sessionId?: ID;
}): PushDevice {
  const identity = currentIdentity();
  if (!identity) {
    throw new Error('Ouvrez une session avant d’abonner cet appareil aux notifications.');
  }
  const token = input.token?.trim();
  if (!token) throw new Error('Jeton d’appareil manquant.');

  return store.mutate((db) => {
    const existing = db.pushDevices.find((d) => d.token === token);
    if (existing) {
      // Un téléphone qui change de main garde son jeton : le propriétaire est
      // réécrit, sans quoi l'ancien continuerait de recevoir ses annonces.
      existing.userId = identity.userId;
      existing.sessionId = input.sessionId ?? existing.sessionId;
      existing.label = input.label?.trim() || existing.label;
      existing.platform = input.platform?.trim() || existing.platform;
      existing.lastSeenAt = nowIso();
      return existing;
    }
    const device: PushDevice = {
      id: newId('psh'),
      userId: identity.userId,
      sessionId: input.sessionId,
      token,
      label: input.label?.trim() || 'Téléphone',
      platform: input.platform?.trim() || 'android',
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
    };
    db.pushDevices.push(device);
    return device;
  });
}

export function unregisterDevice(token: string): void {
  if (!token) return;
  store.mutate((db) => {
    db.pushDevices = db.pushDevices.filter((d) => d.token !== token);
  });
}

/** Une session révoquée emporte les abonnements ouverts sous elle. */
export function forgetDevicesOfSession(sessionId: ID): void {
  if (!sessionId) return;
  store.mutate((db) => {
    db.pushDevices = db.pushDevices.filter((d) => d.sessionId !== sessionId);
  });
}

/** Un compte supprimé n'a plus de téléphone à prévenir. */
export function forgetDevicesOfUser(userId: ID): void {
  if (!userId) return;
  store.mutate((db) => {
    db.pushDevices = db.pushDevices.filter((d) => d.userId !== userId);
  });
}

export function listDevices(): (PushDevice & { username: string })[] {
  return store.db.pushDevices.map((device) => ({
    ...device,
    username: store.db.users.find((u) => u.id === device.userId)?.username ?? '—',
  }));
}

/** Les appareils qui doivent recevoir cette annonce, filtres appliqués. */
export function recipientsFor(event: ActivityEvent): PushDevice[] {
  const channel = SOURCE_CHANNEL[event.source];
  return store.db.pushDevices.filter((device) => {
    if (event.by && device.userId === event.by) return false;
    const owner = store.db.users.find((u) => u.id === device.userId);
    // Compte disparu ou désactivé : on ne pousse plus rien vers cet appareil.
    if (!owner || owner.disabled) return false;
    return mayCall(owner.role, channel);
  });
}

/**
 * Pousse une annonce vers les téléphones concernés.
 *
 * Ne lève jamais et n'est jamais attendue : une notification est un service
 * rendu, pas une condition de l'enregistrement qui l'a déclenchée.
 */
export async function pushActivityToDevices(
  event: ActivityEvent,
  deps: FcmDeps = {},
): Promise<void> {
  if (!fcmEnabled()) return;
  const targets = recipientsFor(event);
  if (!targets.length) return;

  const outcomes = await Promise.all(
    targets.map(async (device) => ({
      device,
      outcome: await sendPush(
        device.token,
        {
          title: event.title,
          body: event.text,
          data: { source: event.source, page: SOURCE_PAGE[event.source] },
        },
        deps,
      ),
    })),
  );

  // Application désinstallée, données effacées : Firebase ne connaît plus
  // l'appareil. On l'oublie, sinon le registre se remplit de fantômes qu'on
  // rappellerait à chaque annonce.
  const gone = outcomes.filter((o) => o.outcome === 'gone').map((o) => o.device.token);
  if (gone.length) {
    store.mutate((db) => {
      db.pushDevices = db.pushDevices.filter((d) => !gone.includes(d.token));
    });
    store.flushSync();
  }
}

/** Notification d'essai sur les appareils de l'appelant. */
export async function testPush(): Promise<{ sent: number; failed: number; reason?: string }> {
  if (!fcmEnabled()) {
    return {
      sent: 0,
      failed: 0,
      reason:
        'Les notifications ne sont pas configurées sur le serveur : la clé Firebase manque (COMPAGELATO_FCM_KEY_FILE).',
    };
  }
  const identity = currentIdentity();
  const mine = identity
    ? store.db.pushDevices.filter((d) => d.userId === identity.userId)
    : [];
  if (!mine.length) {
    return {
      sent: 0,
      failed: 0,
      reason:
        'Aucun téléphone abonné pour ce compte : ouvrez l’application mobile et acceptez les notifications.',
    };
  }

  const outcomes = await Promise.all(
    mine.map((device) =>
      sendPush(device.token, {
        title: 'CompaGelato — essai',
        body: 'Les notifications fonctionnent sur ce téléphone.',
        data: { source: 'task', page: 'taches' },
      }),
    ),
  );
  return {
    sent: outcomes.filter((o) => o === 'sent').length,
    failed: outcomes.filter((o) => o !== 'sent').length,
  };
}
