/**
 * Teclado visual "Sample Note Range" do Auto Sampler (ver AutoSamplerDialog.tsx) —
 * mesmo elemento do Auto Sampler do Logic Pro: mostra C-2 a C7, com uma
 * barra azul em cima indicando a faixa de notas selecionada (arrastável
 * pelas pontas pra ajustar Range Start/Range End, ou pelo meio pra mover a
 * faixa inteira preservando o tamanho), e colore as teclas conforme o
 * "Sample Every": fora da faixa = cinza escuro/desabilitada, dentro da
 * faixa mas NÃO amostrada diretamente (preenchida depois por pitch-shift) =
 * cinza claro, dentro da faixa E amostrada de verdade = azul (cor de
 * destaque). Clicar em qualquer tecla manda uma nota MIDI curta de verdade
 * pra pré-ouvir o instrumento (mesmo comportamento documentado no artigo da
 * Sound On Sound: "Click on the keyboard and a MIDI note is sent so you can
 * hear the instrument you plan to sample").
 *
 * Implementado com SVG (não DOM absoluto) porque a disposição de teclas
 * pretas/brancas de um teclado de piano não é uma grade uniforme — é mais
 * simples calcular posições em "unidades de tecla branca" e deixar o SVG
 * escalar pra qualquer largura via viewBox, do que gerenciar media
 * queries/porcentagens pra cada tecla preta manualmente.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { midiNoteName } from '../audio/rack/midiNoteNames';

const LOWEST_NOTE = 0; // C-2
const HIGHEST_NOTE = 108; // C7 — mesmo intervalo mostrado no Auto Sampler do Logic Pro.
const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);
const WHITE_X_IN_OCTAVE: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const BLACK_X_IN_OCTAVE: Record<number, number> = { 1: 0.62, 3: 1.65, 6: 3.55, 8: 4.58, 10: 5.65 };
const BLACK_KEY_WIDTH = 0.62;
const WHITE_KEY_HEIGHT = 46;
const BLACK_KEY_HEIGHT = 28;
const RANGE_BAR_HEIGHT = 16;
const LABEL_HEIGHT = 12;

interface KeyRect {
  note: number;
  isBlack: boolean;
  x: number;
  width: number;
}

function buildKeys(): KeyRect[] {
  const keys: KeyRect[] = [];
  for (let n = LOWEST_NOTE; n <= HIGHEST_NOTE; n += 1) {
    const octave = Math.floor(n / 12);
    const within = n % 12;
    if (BLACK_NOTES.has(within)) {
      keys.push({ note: n, isBlack: true, x: octave * 7 + BLACK_X_IN_OCTAVE[within], width: BLACK_KEY_WIDTH });
    } else {
      keys.push({ note: n, isBlack: false, x: octave * 7 + WHITE_X_IN_OCTAVE[within], width: 1 });
    }
  }
  return keys;
}
const ALL_KEYS = buildKeys();
const WHITE_KEYS = ALL_KEYS.filter((k) => !k.isBlack);
const BLACK_KEYS = ALL_KEYS.filter((k) => k.isBlack);
const TOTAL_WIDTH_UNITS = WHITE_KEYS[WHITE_KEYS.length - 1].x + 1;

/** Nota mais próxima de uma posição x (em unidades de tecla branca) — testa as pretas primeiro (ficam visualmente por cima). */
function noteAtX(xUnits: number): number {
  for (const k of BLACK_KEYS) {
    if (xUnits >= k.x && xUnits <= k.x + k.width) return k.note;
  }
  let best = WHITE_KEYS[0].note;
  let bestDist = Infinity;
  for (const k of WHITE_KEYS) {
    const center = k.x + k.width / 2;
    const dist = Math.abs(xUnits - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = k.note;
    }
  }
  return best;
}

function xForNote(note: number): number {
  const key = ALL_KEYS.find((k) => k.note === note);
  return key ? key.x : 0;
}
function widthForNote(note: number): number {
  const key = ALL_KEYS.find((k) => k.note === note);
  return key ? key.width : 1;
}

interface Props {
  rangeStartNote: number;
  rangeEndNote: number;
  sampleEverySemitones: number;
  onChangeRange: (start: number, end: number) => void;
  onPreviewNote?: (note: number) => void;
  disabled?: boolean;
  /** Estado de cada nota já capturada — 'ok' (verde) ou 'silent' (vermelho).
   *  Notas sem entrada aqui usam a cor normal da faixa (azul/cinza). */
  noteStatus?: Map<number, 'ok' | 'silent'>;
}

type DragTarget = 'start' | 'end' | 'move' | null;

export default function SampleNoteRangeKeyboard({ rangeStartNote, rangeEndNote, sampleEverySemitones, onChangeRange, onPreviewNote, disabled, noteStatus }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const dragStartRef = useRef<{ xUnits: number; rangeStartNote: number; rangeEndNote: number } | null>(null);

  const totalHeight = LABEL_HEIGHT + RANGE_BAR_HEIGHT + WHITE_KEY_HEIGHT;

  const clientXToUnits = useCallback((clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return ((clientX - rect.left) / rect.width) * TOTAL_WIDTH_UNITS;
  }, []);

  const sampledSet = useMemo(() => {
    const set = new Set<number>();
    for (let n = rangeStartNote; n <= rangeEndNote; n += sampleEverySemitones) set.add(n);
    return set;
  }, [rangeStartNote, rangeEndNote, sampleEverySemitones]);

  function handlePointerDownHandle(e: React.PointerEvent, target: DragTarget) {
    if (disabled) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragTarget(target);
    dragStartRef.current = { xUnits: clientXToUnits(e.clientX), rangeStartNote, rangeEndNote };
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragTarget || !dragStartRef.current) return;
    const xUnits = clientXToUnits(e.clientX);
    const note = Math.max(LOWEST_NOTE, Math.min(HIGHEST_NOTE, noteAtX(xUnits)));
    if (dragTarget === 'start') {
      onChangeRange(Math.min(note, rangeEndNote), rangeEndNote);
    } else if (dragTarget === 'end') {
      onChangeRange(rangeStartNote, Math.max(note, rangeStartNote));
    } else if (dragTarget === 'move') {
      const deltaUnits = xUnits - dragStartRef.current.xUnits;
      const deltaNotes = Math.round(deltaUnits); // aproximação boa o bastante — teclas brancas têm ~1 unidade de largura
      const span = dragStartRef.current.rangeEndNote - dragStartRef.current.rangeStartNote;
      let newStart = dragStartRef.current.rangeStartNote + deltaNotes;
      newStart = Math.max(LOWEST_NOTE, Math.min(HIGHEST_NOTE - span, newStart));
      onChangeRange(newStart, newStart + span);
    }
  }

  function handlePointerUp() {
    setDragTarget(null);
    dragStartRef.current = null;
  }

  function handleKeyClick(note: number) {
    if (disabled) return;
    onPreviewNote?.(note);
  }

  const rangeX = xForNote(rangeStartNote);
  const rangeWidth = xForNote(rangeEndNote) + widthForNote(rangeEndNote) - rangeX;

  return (
    <div className="as-keyboard-wrap">
      <svg
        ref={svgRef}
        className="as-keyboard-svg"
        viewBox={`0 0 ${TOTAL_WIDTH_UNITS} ${totalHeight}`}
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Barra "Sample Note Range" + alças de arrastar */}
        <rect x={0} y={LABEL_HEIGHT} width={TOTAL_WIDTH_UNITS} height={RANGE_BAR_HEIGHT} className="as-kb-rangebar-bg" />
        <rect
          x={rangeX}
          y={LABEL_HEIGHT}
          width={rangeWidth}
          height={RANGE_BAR_HEIGHT}
          className="as-kb-rangebar-fill"
          onPointerDown={(e) => handlePointerDownHandle(e, 'move')}
          style={{ cursor: disabled ? 'default' : 'grab' }}
        />
        <rect
          x={rangeX - 0.12}
          y={LABEL_HEIGHT}
          width={0.3}
          height={RANGE_BAR_HEIGHT}
          className="as-kb-handle"
          onPointerDown={(e) => handlePointerDownHandle(e, 'start')}
          style={{ cursor: disabled ? 'default' : 'ew-resize' }}
        />
        <rect
          x={rangeX + rangeWidth - 0.18}
          y={LABEL_HEIGHT}
          width={0.3}
          height={RANGE_BAR_HEIGHT}
          className="as-kb-handle"
          onPointerDown={(e) => handlePointerDownHandle(e, 'end')}
          style={{ cursor: disabled ? 'default' : 'ew-resize' }}
        />

        {/* Teclas brancas */}
        {WHITE_KEYS.map((k) => {
          const inRange = k.note >= rangeStartNote && k.note <= rangeEndNote;
          const sampled = sampledSet.has(k.note);
          const status = noteStatus?.get(k.note);
          const cls = status === 'ok'
            ? 'as-kb-white-ok'
            : status === 'silent'
              ? 'as-kb-white-silent'
              : !inRange ? 'as-kb-white-out' : sampled ? 'as-kb-white-sampled' : 'as-kb-white-in';
          return (
            <rect
              key={k.note}
              x={k.x}
              y={LABEL_HEIGHT + RANGE_BAR_HEIGHT}
              width={k.width}
              height={WHITE_KEY_HEIGHT}
              className={cls}
              stroke="#000"
              strokeWidth={0.015}
              onClick={() => handleKeyClick(k.note)}
              style={{ cursor: disabled ? 'default' : 'pointer' }}
            />
          );
        })}
        {/* Teclas pretas (desenhadas por cima) */}
        {BLACK_KEYS.map((k) => {
          const inRange = k.note >= rangeStartNote && k.note <= rangeEndNote;
          const sampled = sampledSet.has(k.note);
          const status = noteStatus?.get(k.note);
          const cls = status === 'ok'
            ? 'as-kb-black-ok'
            : status === 'silent'
              ? 'as-kb-black-silent'
              : !inRange ? 'as-kb-black-out' : sampled ? 'as-kb-black-sampled' : 'as-kb-black-in';
          return (
            <rect
              key={k.note}
              x={k.x}
              y={LABEL_HEIGHT + RANGE_BAR_HEIGHT}
              width={k.width}
              height={BLACK_KEY_HEIGHT}
              className={cls}
              onClick={() => handleKeyClick(k.note)}
              style={{ cursor: disabled ? 'default' : 'pointer' }}
            />
          );
        })}

        {/* Rótulos de oitava (um "C" a cada 12 notas) */}
        {WHITE_KEYS.filter((k) => k.note % 12 === 0).map((k) => (
          <text key={k.note} x={k.x + 0.5} y={LABEL_HEIGHT - 2} className="as-kb-octave-label" textAnchor="middle">
            {midiNoteName(k.note)}
          </text>
        ))}
      </svg>
    </div>
  );
}
