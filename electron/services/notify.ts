import type { NotificationPayload } from './registerRules';

/**
 * Notifications sur téléphone via ntfy (https://ntfy.sh) : un service de
 * publication/abonnement volontairement simple. Chaque téléphone installe
 * l'application ntfy (gratuite, Android/iPhone) et s'abonne au sujet configuré
 * dans les réglages — aucun compte à créer. Le sujet fait office de clé :
 * il doit être long et impossible à deviner.
 *
 * Le jour où CompaGelato aura son serveur au dépôt, le même code pointera vers
 * un ntfy auto-hébergé et plus rien ne transitera par ntfy.sh. En attendant,
 * c'est désactivé par défaut : rien n'est envoyé tant qu'aucun sujet n'est
 * configuré.
 */

export interface NotifyConfig {
  url?: string;
  topic?: string;
}

const TIMEOUT_MS = 6000;

export function notifyEnabled(config: NotifyConfig): boolean {
  return Boolean(config.topic?.trim());
}

/**
 * Publie une notification. Renvoie `true` si le serveur l'a acceptée.
 * Ne lève jamais : une panne de réseau ne doit pas empêcher d'enregistrer
 * une écriture dans un cahier.
 */
export async function sendNotification(
  config: NotifyConfig,
  payload: NotificationPayload,
): Promise<boolean> {
  if (!notifyEnabled(config)) return false;
  const base = (config.url?.trim() || 'https://ntfy.sh').replace(/\/+$/, '');

  try {
    // Publication JSON à la racine : les en-têtes HTTP n'acceptent pas les
    // accents, le corps JSON si.
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: config.topic!.trim(),
        title: payload.title,
        message: payload.message,
        tags: payload.tags,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('[notify] refus du serveur', response.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notify] envoi impossible', (err as Error).message);
    return false;
  }
}
