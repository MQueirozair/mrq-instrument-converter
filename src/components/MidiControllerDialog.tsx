/**
 * "Controlador MIDI" — modal independente do Auto Sampler/Captura, só pra
 * tocar notas MIDI de verdade (sustentadas, apertar-e-segurar) direto do
 * app, numa porta/canal escolhidos pelo usuário. Serve como ferramenta de
 * diagnóstico pro problema "o Kontakt não está tocando as notas que o
 * conversor manda": em vez de rodar uma sessão de Auto Sampler inteira,
 * o usuário abre isso aqui, escolhe a mesma porta/canal que configurou no
 * Kontakt (ver aba MIDI Inputs do Kontakt) e toca direto no teclado da
 * tela — se não ouvir nada, o problema é roteamento (porta/canal
 * errados, porta virtual não assinada no Kontakt, etc.), não o conversor.
 *
 * Usa as funções de baixo nível em `autoSampler.ts`
 * (`sendMidiNoteOn`/`sendMidiNoteOff`/`sendMidiAllNotesOff`), que mandam
 * mensagens Note On/Off de verdade (sem duração fixa) — diferente de
 * `previewMidiNote` (nota curta, só pro clique de pré-escuta do Auto
 * Sampler).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Music2, OctagonX, RotateCcw, X } from 'lucide-react';
import {
  listMidiOutputs,
  sendMidiAllNotesOff,
  sendMidiNoteOff,
  sendMidiNoteOn,
  type MidiPortInfo,
} from '../audio/rack/autoSampler';
import PlayableKeyboard from './PlayableKeyboard';

interface Props {
  onClose: () => void;
}

const LOWEST_NOTE = 24; // C1 — faixa mais compacta que o seletor do Auto Sampler, focada em tocar de verdade.
const HIGHEST_NOTE = 96; // C7

// Mapeamento de teclado do computador pro "teclado de piano branco e preto" de uma oitava e meia,
// igual boa parte de DAWs (Ableton, FL Studio) fazem no "modo teclado MIDI do computador".
const COMPUTER_KEY_TO_SEMITONE: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16,
};

export default function MidiControllerDialog({ onClose }: Props) {
  const [midiOutputs, setMidiOutputs] = useState<MidiPortInfo[]>([]);
  const [midiOutputId, setMidiOutputId] = useState('');
  const [midiChannel, setMidiChannel] = useState(1);
  const [velocity, setVelocity] = useState(100);
  const [midiLoading, setMidiLoading] = useState(false);
  const [midiError, setMidiError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());
  const [baseOctaveNote, setBaseOctaveNote] = useState(60); // C4 — nota que a tecla "a" do computador toca.

  const activeNotesRef = useRef<Set<number>>(new Set());
  const computerKeyNoteRef = useRef<Map<string, number>>(new Map());

  const loadMidiOutputs = useCallback(async () => {
    setMidiLoading(true);
    setMidiError(null);
    try {
      const outs = await listMidiOutputs();
      setMidiOutputs(outs);
      setMidiOutputId((prev) => (outs.some((o) => o.id === prev) ? prev : outs[0]?.id ?? ''));
      if (outs.length === 0) {
        setMidiError(
          'Nenhuma porta MIDI de saída encontrada. Crie/ative uma porta MIDI virtual roteada até o Kontakt (IAC Driver no macOS, loopMIDI no Windows, aconnect/a2jmidid no Linux — ver docs/mrq-instrument-converter/mrq-auto-sampler.md) e clique em "Tentar de novo".'
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMidiError(`Não foi possível listar as portas MIDI: ${message}`);
    } finally {
      setMidiLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMidiOutputs();
  }, [loadMidiOutputs]);

  // Ao fechar o modal (ou desmontar por qualquer motivo), solta tudo que ainda estiver
  // pressionado — evita nota(s) presas tocando pra sempre no Kontakt depois do usuário sair da tela.
  useEffect(() => {
    return () => {
      if (midiOutputId && activeNotesRef.current.size > 0) {
        void sendMidiAllNotesOff(midiOutputId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setActive(note: number, on: boolean) {
    setActiveNotes((prev) => {
      const next = new Set(prev);
      if (on) next.add(note);
      else next.delete(note);
      activeNotesRef.current = next;
      return next;
    });
  }

  async function handleNoteOn(note: number) {
    if (!midiOutputId) {
      setSendError('Escolha uma porta MIDI primeiro.');
      return;
    }
    setActive(note, true);
    try {
      await sendMidiNoteOn(midiOutputId, midiChannel - 1, note, velocity);
      setSendError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSendError(`Falha ao mandar Note On: ${message}`);
      setActive(note, false);
    }
  }

  async function handleNoteOff(note: number) {
    setActive(note, false);
    if (!midiOutputId) return;
    try {
      await sendMidiNoteOff(midiOutputId, midiChannel - 1, note);
    } catch {
      /* note-off de limpeza — não vale a pena mostrar erro pro usuário por isso. */
    }
  }

  async function handlePanic() {
    setActiveNotes(new Set());
    activeNotesRef.current = new Set();
    if (midiOutputId) await sendMidiAllNotesOff(midiOutputId);
  }

  // Suporte a tocar pelo teclado do computador (facilita testar rápido sem precisar de mouse/trackpad).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const key = e.key.toLowerCase();
      const semitone = COMPUTER_KEY_TO_SEMITONE[key];
      if (semitone === undefined) return;
      e.preventDefault();
      const note = baseOctaveNote + semitone;
      if (note < 0 || note > 127) return;
      computerKeyNoteRef.current.set(key, note);
      void handleNoteOn(note);
    }
    function onKeyUp(e: KeyboardEvent) {
      const key = e.key.toLowerCase();
      const note = computerKeyNoteRef.current.get(key);
      if (note === undefined) return;
      computerKeyNoteRef.current.delete(key);
      void handleNoteOff(note);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseOctaveNote, midiOutputId, midiChannel, velocity]);

  return (
    <div className="modal-overlay" onClick={() => { void handlePanic(); onClose(); }}>
      <div className="modal wide as-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Controlador MIDI</h2>
          <button className="icon-btn" onClick={() => { void handlePanic(); onClose(); }}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="kc-disclaimer">
            <AlertTriangle size={16} />
            <div>
              Toque direto aqui (clique e segure no teclado abaixo, ou use o teclado do computador — teclas{' '}
              <strong>A S D F G H J K</strong> pras brancas e <strong>W E T Y U</strong> pras pretas) pra testar, ao
              vivo, se a porta/canal MIDI escolhidos chegam até o Kontakt. Confira se a mesma porta aparece marcada em{' '}
              <strong>Kontakt → página MIDI Inputs</strong> — se o Kontakt só mostra uma interface física (ex.: "UMX
              610") e não a porta virtual escolhida aqui, é isso que está impedindo as notas de chegar (ver
              docs/mrq-instrument-converter/mrq-auto-sampler.md pra criar/rotear uma porta MIDI virtual).
            </div>
          </div>

          <div className="as-grid">
            <section className="as-section">
              <h4><Music2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Saída MIDI (para o Kontakt)</h4>
              <div className="field-row">
                <div className="label">Porta MIDI</div>
                <select value={midiOutputId} onChange={(e) => setMidiOutputId(e.target.value)} disabled={midiLoading}>
                  {midiOutputs.length === 0 && <option value="">Nenhuma porta encontrada</option>}
                  {midiOutputs.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="label">Canal MIDI</div>
                <select value={midiChannel} onChange={(e) => setMidiChannel(Number(e.target.value))}>
                  {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => (
                    <option key={c} value={c}>Canal {c}</option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="label">Velocity</div>
                <input
                  type="range"
                  min={1}
                  max={127}
                  value={velocity}
                  onChange={(e) => setVelocity(Number(e.target.value))}
                  style={{ verticalAlign: -4, marginRight: 8 }}
                />
                <span>{velocity}</span>
              </div>
              <div className="field-row">
                <div className="label">Oitava (tecla "a")</div>
                <select value={baseOctaveNote} onChange={(e) => setBaseOctaveNote(Number(e.target.value))}>
                  {[36, 48, 60, 72].map((n) => (
                    <option key={n} value={n}>{n === 60 ? 'C4 (central)' : n === 48 ? 'C3' : n === 36 ? 'C2' : 'C5'}</option>
                  ))}
                </select>
              </div>
              {midiError && (
                <div className="as-device-error">
                  <AlertTriangle size={13} />
                  <div>{midiError}</div>
                </div>
              )}
              <div className="field-row">
                <button className="ghost-btn small" onClick={() => void loadMidiOutputs()} disabled={midiLoading}>
                  <RotateCcw size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                  {midiLoading ? 'Atualizando…' : 'Tentar de novo'}
                </button>
                <button className="ghost-btn small" onClick={() => void handlePanic()} style={{ marginLeft: 8 }}>
                  <OctagonX size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                  Pânico (silenciar tudo)
                </button>
              </div>
              {sendError && (
                <div className="as-device-error">
                  <AlertTriangle size={13} />
                  <div>{sendError}</div>
                </div>
              )}
            </section>
          </div>

          <section className="as-section as-keyboard-section">
            <h4>Teclado (clique e segure, ou arraste pra fazer glissando)</h4>
            <PlayableKeyboard
              lowestNote={LOWEST_NOTE}
              highestNote={HIGHEST_NOTE}
              activeNotes={activeNotes}
              onNoteOn={(n) => void handleNoteOn(n)}
              onNoteOff={(n) => void handleNoteOff(n)}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
