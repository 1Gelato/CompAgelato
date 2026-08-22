import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, elevation, font, radius, spacing, toneColors, touch, type Tone } from '../theme';

/**
 * La trousse d'interface du mobile — l'équivalent de `src/components/ui.tsx`
 * du bureau, en React Native.
 *
 * Deux règles la gouvernent :
 *
 * - **Tout vient des jetons** (`theme.ts`) : couleurs, échelle de texte,
 *   ombres, tailles tactiles. Un composant qui invente une valeur prive tous
 *   les écrans de sa correction future.
 * - **L'API n'est qu'additive.** Chaque nouveauté est une prop optionnelle ou
 *   un composant neuf : les écrans écrits avant la refonte compilent et
 *   s'affichent sans qu'on les touche — ils héritent seulement du nouveau
 *   dessin. `variant="default"` de Button reste un nom valide pour toujours.
 */

/** La seule famille d'icônes de l'application — figée par ce type. */
export type IconName = keyof typeof Ionicons.glyphMap;

export function Icon({
  name,
  size = 20,
  color = colors.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}

/* ---------------------------------------------------------------- */
/* Textes et surfaces                                                 */
/* ---------------------------------------------------------------- */

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * Une carte qui héberge des rangées pleine largeur (`ListItem`) sans le hack
 * `style={{ padding: 0 }}`. Deux View imbriquées, et c'est voulu : l'ombre
 * vit sur l'externe, le rognage des coins sur l'interne — `overflow: hidden`
 * posé sur la même View amputerait l'ombre iOS.
 */
export function CardList({ children, style }: { children: ReactNode; style?: object }) {
  return (
    <View style={[styles.cardListOuter, style]}>
      <View style={styles.cardListInner}>{children}</View>
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Muted({ children, size = 13 }: { children: ReactNode; size?: number }) {
  return <Text style={{ color: colors.secondary, fontSize: size }}>{children}</Text>;
}

export function Badge({
  tone = 'default',
  icon,
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
}) {
  const palette = toneColors[tone];
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      {icon ? <Ionicons name={icon} size={12} color={palette.fg} /> : null}
      <Text style={{ color: palette.fg, fontSize: 12.5, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}

export function EmptyState({
  title,
  text,
  icon,
}: {
  title: string;
  text?: string;
  icon?: IconName;
}) {
  return (
    <View style={styles.empty}>
      {icon ? <Ionicons name={icon} size={36} color={colors.tertiary} /> : null}
      <Text style={{ ...font.headline, color: colors.text, textAlign: 'center' }}>{title}</Text>
      {text ? (
        <Text style={{ ...font.sub, color: colors.secondary, textAlign: 'center' }}>{text}</Text>
      ) : null}
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

/** Fond d'écran standard : remplace le `<View flex:1 bg>` recopié partout. */
export function Screen({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[{ flex: 1, backgroundColor: colors.bg }, style]}>{children}</View>;
}

/* ---------------------------------------------------------------- */
/* Boutons et champs                                                  */
/* ---------------------------------------------------------------- */

/**
 * `default` était une carte blanche à texte bleu — invisible sur le fond gris
 * de l'application. Son rendu devient **tonal** (fond bleu doux, texte bleu
 * foncé) : les quinze boutons secondaires de l'app redeviennent des boutons
 * sans qu'un seul écran change. `tonal` est le nom moderne, `default` reste
 * un alias permanent.
 */
export function Button({
  title,
  onPress,
  variant = 'default',
  disabled,
  busy,
  icon,
  size = 'md',
}: {
  title: string;
  onPress: () => void;
  variant?: 'default' | 'tonal' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  size?: 'md' | 'lg';
}) {
  const background =
    variant === 'primary'
      ? colors.accent
      : variant === 'danger'
        ? colors.red
        : variant === 'ghost'
          ? 'transparent'
          : toneColors.info.bg;
  const color =
    variant === 'primary' || variant === 'danger'
      ? '#fff'
      : variant === 'ghost'
        ? colors.accent
        : toneColors.info.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, minHeight: size === 'lg' ? 54 : touch.minHeight },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={size === 'lg' ? 20 : 18} color={color} /> : null}
          <Text style={{ color, fontWeight: '600', fontSize: size === 'lg' ? 16 : 15 }}>
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Une icône qu'on presse — 44 px de vraie géométrie, pas un glyphe gonflé. */
export function IconButton({
  icon,
  onPress,
  tone = 'accent',
  disabled,
  label,
}: {
  icon: IconName;
  onPress: () => void;
  tone?: 'accent' | 'danger' | 'neutral';
  disabled?: boolean;
  /** Lu par les lecteurs d'écran : « Supprimer la ligne », pas une devinette. */
  label?: string;
}) {
  const palette =
    tone === 'danger'
      ? { bg: colors.redSoft, fg: colors.red }
      : tone === 'neutral'
        ? { bg: 'rgba(0,0,0,0.05)', fg: colors.secondary }
        : { bg: colors.accentSoft, fg: colors.accent };
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      hitSlop={touch.hitSlop}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: palette.bg },
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Ionicons name={icon} size={20} color={palette.fg} />
    </Pressable>
  );
}

/**
 * Une tuile d'action : icône au-dessus du libellé, en part égale d'une
 * rangée. Les gestes de terrain (naviguer, appeler, optimiser) méritent des
 * cibles à hauteur de pouce — trois `Button` côte à côte tronqueraient leurs
 * textes. Servie par l'en-tête de tournée et la fiche client : même dessin,
 * un seul endroit à régler.
 */
export function ActionTile({
  icon,
  label,
  onPress,
  busy,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.actionTile,
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.7 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={toneColors.info.fg} />
      ) : (
        <Ionicons name={icon} size={18} color={toneColors.info.fg} />
      )}
      <Text style={styles.actionTileLabel}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /** Prime sur l'indice : on ne dit pas deux choses à la fois. */
  error?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.secondary }}>{label}</Text>
      {children}
      {error ? (
        <Text style={{ ...font.caption, color: colors.red }}>{error}</Text>
      ) : hint ? (
        <Text style={{ ...font.caption, color: colors.secondary }}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Input(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor={colors.secondary}
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

export function SearchBar({
  value,
  onChange,
  placeholder = 'Rechercher…',
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={styles.search}>
      <Ionicons name="search" size={18} color={colors.secondary} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.secondary}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.searchInput}
      />
      {/* Croix maison : `clearButtonMode` n'existe que sur iOS. */}
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={touch.hitSlop} accessibilityLabel="Effacer">
          <Ionicons name="close-circle" size={18} color={colors.tertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Rangée de filtres : « Tous · Factures · Devis · Avoirs ». */
export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.chip, active && { backgroundColor: colors.accent }]}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: '600',
                color: active ? '#fff' : colors.secondary,
              }}
            >
              {option.label}
            </Text>
            {option.count ? (
              <View style={[styles.chipCount, active && { backgroundColor: 'rgba(255,255,255,0.25)' }]}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: active ? '#fff' : toneColors.default.fg }}>
                  {option.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- */
/* Lignes de liste                                                    */
/* ---------------------------------------------------------------- */

export function ListItem({
  title,
  subtitle,
  right,
  onPress,
  leading,
  chevron,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  leading?: ReactNode;
  onPress?: () => void;
  /**
   * Opt-in : les écrans d'avant la refonte dessinent leur propre « › » dans
   * `right` — un chevron automatique le doublerait. Chaque écran l'active en
   * retirant son glyphe, au fil des lots.
   */
  chevron?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.listItem, pressed && { backgroundColor: 'rgba(0,0,0,0.03)' }]}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.text }}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} style={{ ...font.sub, color: colors.secondary }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {chevron ? <Ionicons name="chevron-forward" size={17} color={colors.tertiary} /> : null}
    </Pressable>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.infoRow}>
      <Text style={{ ...font.sub, color: colors.secondary }}>{label}</Text>
      <Text style={{ ...font.body, color: colors.text, flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Rangée de navigation : pastille d'icône, libellé, indice, chevron. C'est
 * le motif de l'écran « Plus », extrait ici pour servir partout.
 */
export function NavRow({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.navRow, pressed && { backgroundColor: 'rgba(0,0,0,0.03)' }]}
    >
      <View style={styles.navRowBadge}>
        <Ionicons name={icon} size={20} color={colors.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.text }}>
          {label}
        </Text>
        {hint ? <Muted size={12}>{hint}</Muted> : null}
      </View>
      <Ionicons name="chevron-forward" size={17} color={colors.tertiary} />
    </Pressable>
  );
}

/** Tuile de chiffre : total du jour, encaissé, stock à surveiller. */
export function Stat({
  label,
  value,
  tone,
  onPress,
}: {
  label: string;
  value: string;
  /** Colore le chiffre quand il réclame l'attention (stock bas en orange). */
  tone?: Tone;
  onPress?: () => void;
}) {
  const color = tone && tone !== 'default' ? toneColors[tone].fg : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.stat, pressed && { opacity: 0.7 }]}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit style={{ ...font.stat, color }}>
        {value}
      </Text>
      <Text style={{ ...font.sub, color: colors.secondary }}>{label}</Text>
    </Pressable>
  );
}

/** La progression d'une tournée — assez haute pour se voir en plein soleil. */
export function ProgressBar({
  ratio,
  leftLabel,
  rightLabel,
}: {
  /** 0 → 1 ; toute valeur hors bornes est ramenée dedans. */
  ratio: number;
  leftLabel?: string;
  rightLabel?: string;
}) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <View style={{ gap: 5 }}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${clamped * 100}%` }]} />
      </View>
      {leftLabel || rightLabel ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: colors.green }}>
            {leftLabel ?? ''}
          </Text>
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: colors.secondary }}>
            {rightLabel ?? ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** L'interrupteur natif, aux couleurs de l'application. */
export function AppSwitch({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ false: 'rgba(0,0,0,0.15)', true: colors.accent }}
      thumbColor="#ffffff"
    />
  );
}

/* ---------------------------------------------------------------- */
/* Feuille d'action (bas d'écran)                                     */
/* ---------------------------------------------------------------- */

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      // Sans ces deux drapeaux, Android mesure la fenêtre sans les barres
      // système : la feuille débordait sous l'écran et son dernier bouton
      // était coupé, donc introuvable.
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View style={styles.sheetWrap}>
        <Pressable style={styles.sheetBackdrop} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.sheetHandle} />
          {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
          {/* Une feuille trop garnie défile à l'intérieur, jamais hors écran. */}
          <ScrollView bounces={false} style={{ flexGrow: 0 }}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function SheetAction({
  title,
  onPress,
  tone = 'default',
  subtitle,
  icon,
}: {
  title: string;
  onPress: () => void;
  tone?: 'default' | 'danger' | 'success';
  subtitle?: string;
  icon?: IconName;
}) {
  const color = tone === 'danger' ? colors.red : tone === 'success' ? colors.green : colors.text;
  const pastille =
    tone === 'danger'
      ? { bg: colors.redSoft, fg: colors.red }
      : tone === 'success'
        ? { bg: colors.greenSoft, fg: colors.green }
        : { bg: colors.accentSoft, fg: colors.accent };
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.sheetAction, pressed && { backgroundColor: 'rgba(0,0,0,0.04)' }]}
    >
      {icon ? (
        <View style={[styles.sheetPastille, { backgroundColor: pastille.bg }]}>
          <Ionicons name={icon} size={18} color={pastille.fg} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color }}>{title}</Text>
        {subtitle ? (
          <Text style={{ ...font.caption, color: colors.secondary }}>{subtitle}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/* ---------------------------------------------------------------- */
/* Toasts                                                             */
/* ---------------------------------------------------------------- */

interface ToastMessage {
  id: number;
  tone: Tone;
  title: string;
  text?: string;
}

const ToastContext = createContext<{ push: (toast: Omit<ToastMessage, 'id'>) => void }>({
  push: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

/** Durée d'affichage — assez longue pour lire deux lignes en conduisant… non, à l'arrêt. */
const TOAST_MS = 4200;

/**
 * Un toast porte sa propre animation (une `Animated.Value` chacun) : entrée
 * en fondu + glissement, sortie animée **avant** le retrait de la liste. Le
 * retrait n'a qu'un seul chemin (`leave`), gardé par un ref — le minuteur et
 * le tap peuvent tous deux le déclencher sans se marcher dessus.
 */
function ToastCard({ toast, onDone }: { toast: ToastMessage; onDone: (id: number) => void }) {
  const progress = useRef(new Animated.Value(0)).current;
  const leaving = useRef(false);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    Animated.timing(progress, { toValue: 0, duration: 160, useNativeDriver: true }).start(() =>
      onDone(toast.id),
    );
  }, [onDone, progress, toast.id]);

  useEffect(() => {
    Animated.timing(progress, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    const timer = setTimeout(leave, TOAST_MS);
    return () => clearTimeout(timer);
  }, [leave, progress]);

  const palette = toneColors[toast.tone];
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
        ],
      }}
    >
      <Pressable
        onPress={leave}
        accessibilityLabel="Fermer la notification"
        style={[styles.toast, { borderLeftColor: palette.fg }]}
      >
        <Text style={{ fontWeight: '700', color: colors.text, fontSize: 13.5 }}>{toast.title}</Text>
        {toast.text ? (
          <Text style={{ ...font.caption, color: colors.secondary }}>{toast.text}</Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const counter = useRef(0);
  const insets = useSafeAreaInsets();

  const push = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = ++counter.current;
    setToasts((current) => [...current, { ...toast, id }]);
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* `box-none` : les toasts se touchent, l'écran derrière eux aussi. */}
      <View pointerEvents="box-none" style={[styles.toastWrap, { top: insets.top + 8 }]}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDone={remove} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

/* ---------------------------------------------------------------- */

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.md,
    ...elevation.card,
  },
  cardListOuter: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    ...elevation.card,
  },
  cardListInner: {
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.full,
    paddingHorizontal: 9,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: 8,
  },
  button: {
    flexDirection: 'row',
    gap: 8,
    borderRadius: radius.md,
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    width: touch.icon,
    height: touch.icon,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionTile: {
    flex: 1,
    minHeight: touch.minHeight,
    borderRadius: radius.md,
    backgroundColor: toneColors.info.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 6,
  },
  actionTileLabel: { fontSize: 11.5, fontWeight: '600', color: toneColors.info.fg },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: touch.minHeight - 2,
    fontSize: 15,
    color: colors.text,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    paddingHorizontal: 12,
    minHeight: touch.minHeight,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minHeight: 38,
    ...elevation.card,
    elevation: 0,
    shadowOpacity: 0,
  },
  chipCount: {
    minWidth: 18,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.07)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: 'center',
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    minHeight: 56,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 60,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    ...elevation.card,
  },
  navRowBadge: {
    width: 38,
    height: 38,
    borderRadius: radius.sm + 2,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: 2,
    ...elevation.card,
  },
  progressTrack: {
    height: 9,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.07)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.full,
    backgroundColor: colors.green,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.lg,
    paddingVertical: 5,
  },
  sheetWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10, 12, 18, 0.4)',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: 4,
    maxHeight: '80%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.separator,
    marginBottom: spacing.sm,
  },
  sheetTitle: {
    ...font.headline,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  sheetAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    minHeight: 50,
  },
  sheetPastille: {
    width: 34,
    height: 34,
    borderRadius: radius.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastWrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    gap: 8,
  },
  toast: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    padding: spacing.md,
    gap: 2,
    ...elevation.raised,
  },
});
