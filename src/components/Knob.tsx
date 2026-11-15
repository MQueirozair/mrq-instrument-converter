/**
 * Knob giratório dos Controles ao Vivo (v0.2.22) — no visual da foto de
 * referência: rótulo em cima, arco azul de valor, valor em caixa embaixo.
 *
 * Interação:
 *  - arrastar pra cima/baixo (150px = faixa completa; Shift = fino);
 *  - roda do mouse (um passo por "clique");
 *  - duplo-clique volta ao valor padrão;
 *  - setas do teclado (com foco) ajustam de um passo.
 */
import { useCallback, useEffect, useRef } from 'react';

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
}

const CX = 32;
const CY = 32;
const R_ARC = 26;
const R_KNOB = 19;
const MIN_ANGLE = -135;
const MAX_ANGLE = 135;

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

export default function Knob({ label, value, min, max, step, defaultValue, format, onChange, disabled }: KnobProps) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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

  return (
    <div className={`knob${disabled ? ' disabled' : ''}`} ref={rootRef}>
      <span className="knob-label">{label}</span>
      <div
        className="knob-dial"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        tabIndex={disabled ? -1 : 0}
        title={`${label} — arraste, use a roda do mouse ou as setas. Duplo-clique reseta.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => !disabled && onChange(defaultValue)}
        onKeyDown={onKeyDown}
      >
        <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
          <defs>
            <radialGradient id="knob-body" cx="0.38" cy="0.32" r="0.85">
              <stop offset="0%" stopColor="#3a434f" />
              <stop offset="100%" stopColor="#14181e" />
            </radialGradient>
          </defs>
          <path d={arcPath(R_ARC, MIN_ANGLE, MAX_ANGLE)} fill="none" stroke="#2a313b" strokeWidth="3.5" strokeLinecap="round" />
          <path d={arcPath(R_ARC, MIN_ANGLE, angle)} fill="none" stroke="#54c9ef" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx={CX} cy={CY} r={R_KNOB} fill="url(#knob-body)" stroke="#454f5c" strokeWidth="1" />
          <line x1={CX} y1={CY} x2={pointer.x} y2={pointer.y} stroke="#e7ebf2" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </div>
      <span className="knob-value">{shown}</span>
    </div>
  );
}
