import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { colors, radius, spacing } from '../theme';

/**
 * Signature au doigt, sans module natif.
 *
 * Les bibliothèques de dessin habituelles (SVG, canvas) exigent du code natif —
 * donc une nouvelle APK sur chaque téléphone. Ici, chaque trait est rendu par
 * de petits segments positionnés en absolu : du pur JavaScript, qui part par la
 * mise à jour automatique comme le reste de l'application.
 *
 * Le tracé est conservé en **vecteurs** — des points `[x, y]` normalisés entre
 * 0 et 1 — quelques centaines d'octets qui se redessinent à n'importe quelle
 * taille, sur le téléphone comme sur l'écran du bureau.
 */

export type Strokes = [number, number][][];

/** Trait de crayon : les segments entre points consécutifs, en pixels. */
function Ink({ strokes, width, height, color }: { strokes: Strokes; width: number; height: number; color: string }) {
  if (!width || !height) return null;
  return (
    <>
      {strokes.map((stroke, s) =>
        stroke.map(([x, y], i) => {
          if (i === 0) {
            // Un point isolé (le « point » sur un i) reste visible.
            return (
              <View
                key={`${s}-p`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: x * width - 1.2,
                  top: y * height - 1.2,
                  width: 2.4,
                  height: 2.4,
                  borderRadius: 1.2,
                  backgroundColor: color,
                }}
              />
            );
          }
          const [px, py] = stroke[i - 1];
          const ax = px * width;
          const ay = py * height;
          const bx = x * width;
          const by = y * height;
          const len = Math.max(1, Math.hypot(bx - ax, by - ay));
          const angle = Math.atan2(by - ay, bx - ax);
          return (
            <View
              key={`${s}-${i}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: (ax + bx) / 2 - len / 2,
                top: (ay + by) / 2 - 1.2,
                width: len,
                height: 2.4,
                borderRadius: 1.2,
                backgroundColor: color,
                transform: [{ rotate: `${angle}rad` }],
              }}
            />
          );
        }),
      )}
    </>
  );
}

export function SignaturePad({
  strokes,
  onChange,
  height = 170,
}: {
  strokes: Strokes;
  onChange: (next: Strokes) => void;
  height?: number;
}) {
  const size = useRef({ width: 0, height });
  const current = useRef<[number, number][]>([]);
  // Le tracé en cours vit dans un état local : le doigt voit son trait
  // apparaître sans attendre le parent.
  const [live, setLive] = useState<[number, number][]>([]);
  const [laidOut, setLaidOut] = useState(false);

  const point = (x: number, y: number): [number, number] => {
    const { width, height: h } = size.current;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [Math.round(clamp(x / width) * 1000) / 1000, Math.round(clamp(y / h) * 1000) / 1000];
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // La feuille de saisie vit souvent dans un écran qui défile : le pad
        // garde le geste pour lui, sinon signer fait défiler la page.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          current.current = [point(locationX, locationY)];
          setLive([...current.current]);
        },
        onPanResponderMove: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          const next = point(locationX, locationY);
          const last = current.current[current.current.length - 1];
          // On n'enregistre qu'un déplacement perceptible : le tracé reste
          // léger sans que l'œil voie la différence.
          if (!last || Math.hypot(next[0] - last[0], next[1] - last[1]) > 0.004) {
            current.current.push(next);
            setLive([...current.current]);
          }
        },
        onPanResponderRelease: () => {
          if (current.current.length) onChange([...strokes, current.current]);
          current.current = [];
          setLive([]);
        },
        onPanResponderTerminate: () => {
          if (current.current.length) onChange([...strokes, current.current]);
          current.current = [];
          setLive([]);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strokes, onChange],
  );

  const onLayout = (event: LayoutChangeEvent) => {
    size.current = { width: event.nativeEvent.layout.width, height };
    setLaidOut(true);
  };

  const empty = strokes.length === 0 && live.length === 0;

  return (
    <View style={{ gap: 6 }}>
      <View
        onLayout={onLayout}
        {...responder.panHandlers}
        style={[styles.pad, { height }]}
      >
        {empty && (
          <Text style={styles.hint} pointerEvents="none">
            Signez ici, au doigt
          </Text>
        )}
        {laidOut && (
          <Ink
            strokes={live.length ? [...strokes, live] : strokes}
            width={size.current.width}
            height={height}
            color={colors.text}
          />
        )}
      </View>
      {strokes.length > 0 && (
        <Text style={styles.clear} onPress={() => onChange([])}>
          Effacer et recommencer
        </Text>
      )}
    </View>
  );
}

/** Affichage seul d'une signature enregistrée (détail d'un bon). */
export function SignatureView({ strokes, height = 110 }: { strokes: Strokes; height?: number }) {
  const [width, setWidth] = useState(0);
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.pad, { height }]}
    >
      {width > 0 && <Ink strokes={strokes} width={width} height={height} color={colors.text} />}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    position: 'absolute',
    color: colors.tertiary,
    fontSize: 14,
  },
  clear: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    alignSelf: 'flex-start',
  },
});
