import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

/**
 * La même langue visuelle que le bureau : accent bleu, fonds doux, angles
 * arrondis — mise au gabarit d'un téléphone tenu debout, dehors, parfois en
 * plein soleil. Un seul thème clair, assumé : sur la route, c'est le
 * contraste du mode clair qui fait la lisibilité, pas un mode sombre.
 *
 * Ce fichier est la seule source des couleurs, tailles de texte, ombres et
 * dimensions tactiles. Un écran qui écrit `fontSize: 14` ou `#fff` en dur
 * est un écran à corriger.
 *
 * Contrastes vérifiés (WCAG, calculés sur le fond réellement affiché — un
 * fond translucide est composité sur la carte blanche avant le calcul) :
 *
 *   texte      #1d1d1f sur carte blanche ... 16,9:1
 *   secondary  #6e6e73 sur carte blanche ...  5,1:1   sur fond #f5f5f7 : 4,7:1
 *   blanc sur accent  #0071e3 ............... 4,7:1
 *   blanc sur green   #157347 ............... 5,9:1   (ancien #1d8f4e : 4,1 — échec)
 *   blanc sur red     #d02b20 ............... 5,2:1
 *   badge default #55565c sur son fond ...... 6,5:1
 *   badge info    #005bb7 sur son fond ...... 5,6:1
 *   badge success #115c39 sur son fond ...... 6,7:1
 *   badge warn    #8a3e00 sur son fond ...... 6,3:1
 *   badge danger  #a02219 sur son fond ...... 6,4:1
 *
 * `tertiary` (#98989d, 2,9:1) échoue AA : il est réservé au **décoratif** —
 * chevrons, poignées, filets — jamais à un texte qu'on doit lire.
 */
export const colors = {
  bg: '#f5f5f7',
  card: '#ffffff',
  text: '#1d1d1f',
  secondary: '#6e6e73',
  /** Décoratif uniquement (chevrons, poignées) — illisible comme texte. */
  tertiary: '#98989d',
  separator: 'rgba(0, 0, 0, 0.09)',
  accent: '#0071e3',
  accentSoft: 'rgba(0, 113, 227, 0.1)',
  green: '#157347',
  greenSoft: 'rgba(21, 115, 71, 0.13)',
  orange: '#b25000',
  orangeSoft: 'rgba(178, 80, 0, 0.13)',
  red: '#d02b20',
  redSoft: 'rgba(208, 43, 32, 0.12)',
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 22, full: 999 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * L'échelle de texte — six tailles nommées, au lieu des seize littéraux
 * qu'elle remplace. Les graisses se limitent à 400/600/700 : Roboto confond
 * 500 et 600 sur une partie des téléphones Android, un contraste
 * d'information ne doit jamais reposer sur cette nuance.
 */
export const font = {
  /** Grand chiffre d'une tuile : total du jour, montant d'un bon. */
  stat: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  /** Titre d'un objet : le nom du client en tête de sa fiche. */
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  /** Titre d'une rangée de liste, d'une feuille, d'un en-tête. */
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  /** Texte courant : valeurs, actions, champs de saisie. */
  body: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  /** Sous-titres et détails : l'adresse sous le nom, la date sous l'objet. */
  sub: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  /** Mentions : numéros de pièce, indices de champ, libellés d'onglet. */
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
} as const satisfies Record<string, TextStyle>;

/**
 * La profondeur. `card` porte les deux mondes à la fois — `elevation` pour
 * Android, `shadow*` pour iOS — plus un liseré hairline : quand le soleil
 * efface l'ombre, c'est lui qui continue de détacher la carte du fond.
 */
export const elevation = {
  card: {
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0, 0, 0, 0.06)',
  },
  /** Ce qui flotte au-dessus de tout : toasts, éléments détachés. */
  raised: {
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
} as const satisfies Record<string, ViewStyle>;

/**
 * Tailles tactiles. La cible se fait d'abord en vraie géométrie —
 * `hitSlop` n'est qu'une marge de confort : sur Android il ne s'étend pas
 * au-delà du parent, et ne gagne jamais contre un voisin superposé.
 */
export const touch = {
  /** Hauteur minimale d'un élément qu'on presse : boutons, rangées. */
  minHeight: 48,
  /** Côté d'un bouton-icône seul. */
  icon: 44,
  hitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
} as const;

export type Tone = 'default' | 'info' | 'success' | 'warn' | 'danger';

/**
 * Les encres des badges sont plus foncées que les couleurs pleines : un
 * texte de 12,5 px sur un fond teinté à 12 % n'a droit à aucune concession
 * de contraste. Les valeurs sont prouvées dans la table d'en-tête.
 */
export const toneColors: Record<Tone, { fg: string; bg: string }> = {
  default: { fg: '#55565c', bg: 'rgba(0,0,0,0.05)' },
  info: { fg: '#005bb7', bg: 'rgba(0, 113, 227, 0.12)' },
  success: { fg: '#115c39', bg: colors.greenSoft },
  warn: { fg: '#8a3e00', bg: colors.orangeSoft },
  danger: { fg: '#a02219', bg: colors.redSoft },
};
