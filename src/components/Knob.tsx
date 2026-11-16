/**
 * Knob premium dos Controles ao Vivo (v0.2.27) — visual de sampler
 * profissional (foto de referência): anel de progresso azul/ciano em
 * conic-gradient, corpo circular metálico escuro com profundidade,
 * ponteiro central luminoso e valor numérico abaixo. Três tamanhos
 * (sm/md/lg) — parâmetros principais usam md/lg, nunca sm.
 *
 * Interação:
 *  - arrastar pra cima/baixo (150px = faixa completa; Shift = fino);
 *  - roda do mouse (um passo por "clique");
 *  - duplo-clique volta ao valor padrão;
 *  - setas do teclado (com foco) ajustam de um passo;
 *  - clicar no valor abre um campo pra digitar o número.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

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
  /** Esconde o rótulo acima do knob (módulos de efeito) — v0.2.30. */
  hideLabel?: boolean;
}

const SIZES: Record<KnobSize, number> = { sm: 30, md: 40, lg: 48 };

export default function Knob({ label, value, min, max, step, defaultValue, format, onChange, disabled, size = 'md', unit, hideLabel }: KnobProps) {
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
  const percentage = range > 0 ? Math.min(1, Math.max(0, (value - min) / range)) : 0;
  const angle = -135 + percentage * 270;
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

  const knobStyle = {
    width: px,
    height: px,
    '--knob-progress': `${percentage * 100}%`,
    '--knob-angle': `${angle}deg`,
  } as CSSProperties;

  return (
    <div className={`mrq-knob-control knob-${size}${disabled ? ' disabled' : ''}`} ref={rootRef}>
      {!hideLabel && <span className="mrq-knob-label">{label}</span>}
      <div
        className="mrq-knob"
        style={knobStyle}
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
        <div className="mrq-knob-face">
          <span className="mrq-knob-pointer" />
        </div>
      </div>
      {editing ? (
        <input
          className="mrq-knob-value mrq-knob-edit"
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
          className="mrq-knob-value"
          disabled={disabled}
          title="Clique pra digitar o valor"
          onClick={() => {
            setDraft(shown);
            setEditing(true);
          }}
        >
          {shown}
          {unit ? <span className="mrq-knob-unit">{unit === '%' ? '%' : ` ${unit}`}</span> : null}
        </button>
      )}
    </div>
  );
}
