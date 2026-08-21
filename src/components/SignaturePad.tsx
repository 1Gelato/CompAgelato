import { useRef, useState } from 'react';
import type { Signature } from '@shared/types';

/**
 * Signature à la souris (ou au doigt sur écran tactile) pour le bureau.
 *
 * Mêmes tracés vectoriels que le pad du téléphone : des points `[x, y]`
 * normalisés entre 0 et 1 — une signature faite sur PC s'affiche et s'imprime
 * exactement comme une signature faite en tournée.
 */

type Strokes = Signature['strokes'];

const VIEW_W = 400;
const VIEW_H = 140;

export function SignaturePad({
  strokes,
  onChange,
  height = 140,
}: {
  strokes: Strokes;
  onChange: (next: Strokes) => void;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const current = useRef<[number, number][]>([]);
  const [live, setLive] = useState<[number, number][]>([]);

  const point = (event: React.PointerEvent): [number, number] => {
    const box = svgRef.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [
      Math.round(clamp((event.clientX - box.left) / box.width) * 1000) / 1000,
      Math.round(clamp((event.clientY - box.top) / box.height) * 1000) / 1000,
    ];
  };

  const start = (event: React.PointerEvent) => {
    event.preventDefault();
    svgRef.current?.setPointerCapture(event.pointerId);
    current.current = [point(event)];
    setLive([...current.current]);
  };

  const move = (event: React.PointerEvent) => {
    if (!current.current.length) return;
    const next = point(event);
    const last = current.current[current.current.length - 1];
    // Un déplacement perceptible seulement : le tracé reste léger.
    if (Math.hypot(next[0] - last[0], next[1] - last[1]) > 0.004) {
      current.current.push(next);
      setLive([...current.current]);
    }
  };

  const end = () => {
    if (current.current.length) onChange([...strokes, current.current]);
    current.current = [];
    setLive([]);
  };

  const all = live.length ? [...strokes, live] : strokes;

  return (
    <div className="col" style={{ gap: 4 }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        style={{
          width: '100%',
          height,
          background: 'var(--bg-input, rgba(127,127,127,0.08))',
          border: '1px solid var(--border)',
          borderRadius: 8,
          cursor: 'crosshair',
          touchAction: 'none',
        }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {all.length === 0 && (
          <text
            x={VIEW_W / 2}
            y={VIEW_H / 2}
            textAnchor="middle"
            style={{ fill: 'var(--text-tertiary)', fontSize: 13 }}
          >
            Signez ici, à la souris
          </text>
        )}
        {all.map((stroke, index) =>
          stroke.length === 1 ? (
            <circle
              key={index}
              cx={stroke[0][0] * VIEW_W}
              cy={stroke[0][1] * VIEW_H}
              r={1.5}
              fill="currentColor"
            />
          ) : (
            <polyline
              key={index}
              points={stroke.map(([x, y]) => `${(x * VIEW_W).toFixed(1)},${(y * VIEW_H).toFixed(1)}`).join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ),
        )}
      </svg>
      {strokes.length > 0 && (
        <button
          type="button"
          className="navitem tiny"
          style={{ alignSelf: 'flex-start', color: 'var(--accent)', padding: '2px 4px' }}
          onClick={() => onChange([])}
        >
          Effacer et recommencer
        </button>
      )}
    </div>
  );
}
