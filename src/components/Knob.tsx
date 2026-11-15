/**
 * Knob giratório premium dos Controles ao Vivo (v0.2.25) — visual de
 * sampler profissional: corpo circular escuro com profundidade, arco
 * luminoso azul/ciano proporcional ao valor, ponteiro de alta precisão e
 * valor numérico destacado abaixo. Três tamanhos (sm/md/lg).
 *
 * Interação:
 *  - arrastar pra cima/baixo (150px = faixa completa; Shift = fino);
 *  - roda do mouse (um passo por "clique");
 *  - duplo-clique volta ao valor padrão;
 *  - setas do teclado (com foco) ajustam de um passo;
 *  - clicar no valor abre um campo pra digitar o número.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type KnobSize = 'sm' | 'md' | 'lg';

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
  size?: KnobSize;
  unit?: string;
}

const CX = 32;
const CY = 32;
const R_ARC = 26;
const R_KNOB = 19;
const MIN_ANGLE = -135;
const MAX_ANGLE = 135;

const SIZES: Record<KnobSize, number> = { sm: 44, md: 64, lg: 80 };

function polar(r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + r * Math.sin(rad), y: CY - r * Math.cos(rad) };
}

function arcPath(r: number, startDeg: number, endDeg: number) {
  const s = polar(r, startDeg);
  const e = polar(r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

export default function Knob({ label, value, min, max, step, defaultValue, format, onChange, disabled, size = 'md', unit }: KnobProps) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  // Roda do mouse com preventDefault (o onWheel do React é passivo na raiz).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (disabled) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      onChangeRef.current(clamp(valueRef.current + dir * step));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clamp, disabled, step]);

  const range = max - min;
  const norm = range > 0 ? (value - min) / range : 0;
  const angle = MIN_ANGLE + norm * (MAX_ANGLE - MIN_ANGLE);
  const pointer = polar(R_KNOB - 5, angle);
  const shown = format ? format(value) : String(value);
  const px = SIZES[size];

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startValue: valueRef.current };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const pixels = e.shiftKey ? 1500 : 150;
    const delta = ((drag.startY - e.clientY) / pixels) * range;
    onChangeRef.current(clamp(drag.startValue + delta));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = value + step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = value - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next !== null) {
      e.preventDefault();
      onChange(clamp(next));
    }
  }

  function commitDraft() {
    const parsed = Number.parseFloat(draft.replace(',', '.'));
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
    setEditing(false);
  }

  return (
    <div className={`knob knob-${size}${disabled ? ' disabled' : ''}`} ref={rootRef}>
      <span className="knob-label">{label}</span>
      <div
        className="knob-dial"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        tabIndex={disabled ? -1 : 0}
        title={`${label}: ${shown}${unit ? ` ${unit}` : ''} — arraste, roda do mouse ou setas. Duplo-clique reseta.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => !disabled && onChange(defaultValue)}
        onKeyDown={onKeyDown}
      >
        <svg viewBox="0 0 64 64" width={px} height={px} aria-hidden="true">
          <defs>
            <radialGradient id={`knob-body-${size}`} cx="0.38" cy="0.3" r="0.9">
              <stop offset="0%" stopColor="#454f5e" />
              <stop offset="55%" stopColor="#232a34" />
              <stop offset="100%" stopColor="#10141a" />
            </radialGradient>
            <filter id={`knob-glow-${size}`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="1.6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <path d={arcPath(R_ARC, MIN_ANGLE, MAX_ANGLE)} fill="none" stroke="#262e3a" strokeWidth="3.5" strokeLinecap="round" />
          <path d={arcPath(R_ARC, MIN_ANGLE, angle)} fill="none" stroke="#54c9ef" strokeWidth="3.5" strokeLinecap="round" filter={`url(#knob-glow-${size})`} />
          <circle cx={CX} cy={CY} r={R_KNOB} fill={`url(#knob-body-${size})`} stroke="#4a5566" strokeWidth="1" />
          <line x1={CX} y1={CY} x2={pointer.x} y2={pointer.y} stroke="#eaf6ff" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={pointer.x} cy={pointer.y} r="2.2" fill="#54c9ef" />
        </svg>
      </div>
      {editing ? (
        <input
          className="knob-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitDraft();
            else if (e.key === 'Escape') setEditing(false);
          }}
          aria-label={`${label} (valor)`}
        />
      ) : (
        <button
          type="button"
          className="knob-value"
          disabled={disabled}
          title="Clique pra digitar o valor"
          onClick={() => {
            setDraft(shown);
            setEditing(true);
          }}
        >
          {shown}
        </button>
      )}
    </div>
  );
}
