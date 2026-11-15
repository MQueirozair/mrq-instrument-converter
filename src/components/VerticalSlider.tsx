/**
 * Slider vertical dos módulos de efeito (v0.2.25) — trilha escura com
 * preenchimento azul/ciano e alça luminosa. Arrastar, roda do mouse, setas
 * do teclado e duplo-clique (padrão). Usado como parâmetro secundário de
 * cada efeito (ex.: Wet do reverb, Depth do chorus).
 */
import { useCallback, useEffect, useRef } from 'react';

interface VerticalSliderProps {
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

const TRACK_H = 84;

export default function VerticalSlider({ label, value, min, max, step, defaultValue, format, onChange, disabled }: VerticalSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);
  const range = max - min;
  const norm = range > 0 ? (value - min) / range : 0;
  const shown = format ? format(value) : String(value);

  function valueFromClientY(clientY: number) {
    const el = trackRef.current;
    if (!el) return valueRef.current;
    const rect = el.getBoundingClientRect();
    const t = 1 - (clientY - rect.top) / rect.height;
    return clamp(min + Math.min(1, Math.max(0, t)) * range);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onChangeRef.current(valueFromClientY(e.clientY));
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    if (e.buttons === 0) return;
    onChangeRef.current(valueFromClientY(e.clientY));
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

  useEffect(() => {
    const el = trackRef.current;
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

  return (
    <div className={`vslider${disabled ? ' disabled' : ''}`}>
      <div
        className="vslider-track"
        ref={trackRef}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        tabIndex={disabled ? -1 : 0}
        title={`${label}: ${shown} — arraste, roda do mouse ou setas. Duplo-clique reseta.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => !disabled && onChange(defaultValue)}
        onKeyDown={onKeyDown}
        style={{ height: TRACK_H }}
      >
        <div className="vslider-fill" style={{ height: `${norm * 100}%` }} />
        <div className="vslider-handle" style={{ bottom: `calc(${norm * 100}% - 7px)` }} />
      </div>
      <span className="vslider-label">{label}</span>
    </div>
  );
}
