/**
 * Teclado de piano "de verdade" — pressionar e segurar manda Note On, soltar
 * manda Note Off (sustentado, sem duração fixa) — diferente de
 * `SampleNoteRangeKeyboard.tsx` (clique = nota curta de pré-escuta, mais a
 * faixa de amostragem do Auto Sampler, que não interessa aqui). Usado pelo
 * `MidiControllerDialog.tsx` como um controlador MIDI simples dentro do
 * próprio app, pra tocar/testar o Kontakt ao vivo sem precisar de um
 * teclado MIDI físico nem configurar uma sessão de captura inteira.
 *
 * Suporta "arrastar" o dedo/mouse de uma tecla pra outra com o botão
 * pressionado (glissando) — solta a nota anterior e dispara a nova,
 * igual um teclado de verdade — via Pointer Capture + cálculo de posição
 * (mesma técnica de `SampleNoteRangeKeyboard.tsx`, sem a barra de faixa).
 */
import { useCallback, useRef } from 'react';
import { midiNoteName } from '../audio/rack/midiNoteNames';

const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);
const WHITE_X_IN_OCTAVE: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const BLACK_X_IN_OCTAVE: Record<number, number> = { 1: 0.62, 3: 1.65, 6: 3.55, 8: 4.58, 10: 5.65 };
const BLACK_KEY_WIDTH = 0.62;
const WHITE_KEY_HEIGHT = 64;
const BLACK_KEY_HEIGHT = 40;
const LABEL_HEIGHT = 12;

interface KeyRect {
  note: number;
  isBlack: boolean;
  x: number;
  width: number;
}

function buildKeys(lowest: number, highest: number): KeyRect[] {
  const keys: KeyRect[] = [];
  for (let n = lowest; n <= highest; n += 1) {
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

interface Props {
  lowestNote: number;
  highestNote: number;
  activeNotes: ReadonlySet<number>;
  disabled?: boolean;
  onNoteOn: (note: number) => void;
  onNoteOff: (note: number) => void;
}

export default function PlayableKeyboard({ lowestNote, highestNote, activeNotes, disabled, onNoteOn, onNoteOff }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const heldNoteRef = useRef<number | null>(null);

  const allKeys = buildKeys(lowestNote, highestNote);
  const whiteKeys = allKeys.filter((k) => !k.isBlack);
  const blackKeys = allKeys.filter((k) => k.isBlack);
  const totalWidthUnits = whiteKeys.length > 0 ? whiteKeys[whiteKeys.length - 1].x + 1 : 1;
  const totalHeight = LABEL_HEIGHT + WHITE_KEY_HEIGHT;

  const clientXToUnits = useCallback(
    (clientX: number): number => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return ((clientX - rect.left) / rect.width) * totalWidthUnits;
    },
    [totalWidthUnits]
  );

  function noteAtX(xUnits: number): number | null {
    for (const k of blackKeys) {
      if (xUnits >= k.x && xUnits <= k.x + k.width) return k.note;
    }
    let best: number | null = null;
    let bestDist = Infinity;
    for (const k of whiteKeys) {
      const center = k.x + k.width / 2;
      const dist = Math.abs(xUnits - center);
      if (dist < bestDist) {
        bestDist = dist;
        best = k.note;
      }
    }
    return best;
  }

  function startNote(note: number) {
    if (disabled) return;
    if (heldNoteRef.current === note) return;
    if (heldNoteRef.current !== null) onNoteOff(heldNoteRef.current);
    heldNoteRef.current = note;
    onNoteOn(note);
  }

  function stopHeldNote() {
    if (heldNoteRef.current !== null) {
      onNoteOff(heldNoteRef.current);
      heldNoteRef.current = null;
    }
  }

  function handlePointerDown(e: React.PointerEvent, note: number) {
    if (disabled) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    startNote(note);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (disabled || heldNoteRef.current === null) return;
    const note = noteAtX(clientXToUnits(e.clientX));
    if (note !== null && note !== heldNoteRef.current) startNote(note);
  }

  function handlePointerUp() {
    stopHeldNote();
  }

  return (
    <div className="playable-kb-wrap">
      <svg
        ref={svgRef}
        className="playable-kb-svg"
        viewBox={`0 0 ${totalWidthUnits} ${totalHeight}`}
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {whiteKeys.map((k) => (
          <rect
            key={k.note}
            x={k.x}
            y={LABEL_HEIGHT}
            width={k.width}
            height={WHITE_KEY_HEIGHT}
            className={activeNotes.has(k.note) ? 'playable-kb-white-active' : 'playable-kb-white'}
            stroke="#000"
            strokeWidth={0.015}
            onPointerDown={(e) => handlePointerDown(e, k.note)}
            style={{ cursor: disabled ? 'default' : 'pointer' }}
          />
        ))}
        {blackKeys.map((k) => (
          <rect
            key={k.note}
            x={k.x}
            y={LABEL_HEIGHT}
            width={k.width}
            height={BLACK_KEY_HEIGHT}
            className={activeNotes.has(k.note) ? 'playable-kb-black-active' : 'playable-kb-black'}
            onPointerDown={(e) => handlePointerDown(e, k.note)}
            style={{ cursor: disabled ? 'default' : 'pointer' }}
          />
        ))}
        {whiteKeys.filter((k) => k.note % 12 === 0).map((k) => (
          <text key={k.note} x={k.x + 0.5} y={LABEL_HEIGHT - 2} className="playable-kb-octave-label" textAnchor="middle">
            {midiNoteName(k.note)}
          </text>
        ))}
      </svg>
    </div>
  );
}
