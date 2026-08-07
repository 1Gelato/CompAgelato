import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing, toneColors, type Tone } from '../theme';

/**
 * La petite trousse d'interface du mobile — l'équivalent de `src/components/
 * ui.tsx` du bureau, en React Native. Volontairement courte : des listes, des
 * cartes, des feuilles d'action, rien de plus.
 */

/* ---------------------------------------------------------------- */
/* Textes et surfaces                                                 */
/* ---------------------------------------------------------------- */

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Muted({ children, size = 13 }: { children: ReactNode; size?: number }) {
  return <Text style={{ color: colors.secondary, fontSize: size }}>{children}</Text>;
}

export function Badge({ tone = 'default', children }: { tone?: Tone; children: ReactNode }) {
  const palette = toneColors[tone];
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={{ color: palette.fg, fontSize: 11.5, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}

export function EmptyState({ title, text }: { title: string; text?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{title}</Text>
      {text ? (
        <Text style={{ color: colors.secondary, textAlign: 'center', marginTop: 6 }}>{text}</Text>
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

/* ---------------------------------------------------------------- */
/* Boutons et champs                                                  */
/* ---------------------------------------------------------------- */

export function Button({
  title,
  onPress,
  variant = 'default',
  disabled,
  busy,
}: {
  title: string;
  onPress: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
}) {
  const background =
    variant === 'primary' ? colors.accent : variant === 'danger' ? colors.red : colors.card;
  const color = variant === 'primary' || variant === 'danger' ? '#fff' : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        variant === 'ghost' ? styles.buttonGhost : { backgroundColor: background },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Text style={{ color, fontWeight: '600', fontSize: 15 }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.secondary }}>{label}</Text>
      {children}
      {hint ? <Text style={{ fontSize: 12, color: colors.tertiary }}>{hint}</Text> : null}
    </View>
  );
}

export function Input(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor={colors.tertiary}
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
    <Input
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      clearButtonMode="while-editing"
    />
  );
}

/** Rangée de filtres : « Tous · Factures · Devis · Avoirs ». */
export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
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
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  leading?: ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.listItem, pressed && { backgroundColor: 'rgba(0,0,0,0.03)' }]}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} style={{ fontSize: 12.5, color: colors.secondary }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.infoRow}>
      <Text style={{ color: colors.secondary, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '500', flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
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
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.sheetHandle} />
        {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
        {children}
      </View>
    </Modal>
  );
}

export function SheetAction({
  title,
  onPress,
  tone = 'default',
  subtitle,
}: {
  title: string;
  onPress: () => void;
  tone?: 'default' | 'danger' | 'success';
  subtitle?: string;
}) {
  const color = tone === 'danger' ? colors.red : tone === 'success' ? colors.green : colors.text;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.sheetAction, pressed && { backgroundColor: 'rgba(0,0,0,0.04)' }]}
    >
      <Text style={{ fontSize: 16, fontWeight: '500', color }}>{title}</Text>
      {subtitle ? <Text style={{ fontSize: 12, color: colors.secondary }}>{subtitle}</Text> : null}
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const counter = useRef(0);
  const insets = useSafeAreaInsets();

  const push = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = ++counter.current;
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <View pointerEvents="none" style={[styles.toastWrap, { top: insets.top + 8 }]}>
        {toasts.map((toast) => {
          const palette = toneColors[toast.tone];
          return (
            <View key={toast.id} style={[styles.toast, { borderLeftColor: palette.fg }]}>
              <Text style={{ fontWeight: '700', color: colors.text, fontSize: 13.5 }}>
                {toast.title}
              </Text>
              {toast.text ? (
                <Text style={{ color: colors.secondary, fontSize: 12.5 }}>{toast.text}</Text>
              ) : null}
            </View>
          );
        })}
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
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl * 2,
    gap: 4,
  },
  button: {
    borderRadius: radius.sm,
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGhost: { backgroundColor: 'transparent' },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  chip: {
    borderRadius: 999,
    backgroundColor: colors.card,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.lg,
    paddingVertical: 5,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: 4,
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
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  sheetAction: {
    borderRadius: radius.sm,
    paddingVertical: 13,
    paddingHorizontal: spacing.sm,
    gap: 2,
  },
  toastWrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    gap: 8,
  },
  toast: {
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    padding: spacing.md,
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
});
