import { DEFAULT_DESKTOP_NOTIFY, type ActivityEvent, type DesktopNotifySettings } from '@shared/types';

/**
 * Faut-il montrer cette annonce sur ce poste ?
 *
 * Toute la décision tient ici, sans Electron : c'est ce qui permet de la
 * vérifier sans ouvrir de fenêtre. Le processus principal ne garde que le geste
 * d'afficher.
 *
 * Quatre raisons de se taire, dans cet ordre :
 *
 * 1. **C'est moi.** Être prévenu de sa propre saisie n'apprend rien et use la
 *    confiance qu'on accorde aux notifications — au bout de trois, on les
 *    coupe, et on rate celle qui comptait. Une annonce sans auteur (`by`
 *    absent) n'est jamais la mienne : c'est typiquement un fichier déposé
 *    directement dans le dossier du serveur, ce qu'on veut justement savoir.
 * 2. **La source ne m'intéresse pas**, d'après les réglages du poste.
 * 3. **Je regarde déjà.** Fenêtre au premier plan : l'écriture apparaît d'elle
 *    même à l'écran, une bulle ne ferait que répéter. Réglable, parce que
 *    « regarder l'application » et « regarder la bonne page » sont deux choses
 *    différentes.
 * 4. **Je l'ai déjà vue.** Le flux d'événements est retenté après chaque
 *    coupure ; sans repère, un serveur qui redémarre rejouerait ses annonces.
 */
export function shouldNotify(
  event: ActivityEvent,
  context: {
    myUserId: string | null;
    windowFocused: boolean;
    settings?: DesktopNotifySettings;
  },
): boolean {
  const settings = context.settings ?? DEFAULT_DESKTOP_NOTIFY;
  if (event.by && context.myUserId && event.by === context.myUserId) return false;
  if (event.source === 'register' && !settings.registers) return false;
  if (event.source === 'document' && !settings.documents) return false;
  if (event.source === 'statement' && !settings.statements) return false;
  if (context.windowFocused && !settings.whenFocused) return false;
  return true;
}

/** Page à ouvrir quand on clique sur la bulle. */
export const SOURCE_PAGE: Record<ActivityEvent['source'], string> = {
  register: 'cahiers',
  document: 'documents',
  statement: 'banque',
};

/**
 * Mémoire courte des annonces déjà montrées.
 *
 * Le flux d'événements se rouvre à chaque coupure réseau et à chaque
 * redémarrage du serveur. Sans cette mémoire, une journée de travail hors
 * couverture se solderait par une pluie de bulles au retour du réseau.
 */
export class SeenActivity {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 200) {}

  /** Vrai la première fois seulement. */
  accept(event: ActivityEvent): boolean {
    const key = `${event.at}|${event.source}|${event.title}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }
}
