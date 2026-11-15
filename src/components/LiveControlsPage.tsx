/**
 * Controles ao Vivo (v0.2.22) — página com todos os controles globais do
 * instrumento ("INSTRUMENTO INTEIRO"): faixa de notas/velocity, tecla raiz,
 * volume, pan, afinação, envelope, EQ, drive e os efeitos ao vivo (reverb,
 * stereo, delay, chorus).
 *
 * Serve pra pré-escutar, em tempo real, como o som final vai sair quando o
 * instrumento for aberto num rack de instrumentos pra tocar ao vivo: os
 * controles atuam sobre TODAS as amostras/zonas do `.mrq` carregado e podem
 * ser mexidos enquanto toca (teclado na tela, teclado do computador ou
 * teclado USB MIDI via Web MIDI).
 *
 * Os parâmetros ficam salvos por instrumento (localStorage) — reabrir o
 * instrumento depois traz o mesmo ajuste de volta.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, FolderOpen, Loader2, Piano, RotateCcw, Usb } from 'lucide-react';
import { LiveInstrumentEngine } from '../audio/rack/LiveInstrumentEngine';
import {
  LIVE_EFFECTS,
  LIVE_KNOBS_FX,
  LIVE_KNOBS_NEW,
  LIVE_KNOBS_ROW1,
  LIVE_KNOBS_TOOLS,
  LIVE_PARAM_DEFS,
  LIVE_STEPPERS,
  clearLiveBypass,
  clearLiveParams,
  defaultLiveBypass,
  defaultLiveParams,
  effectIdForParam,
  hasSavedLiveParams,
  keyboardRangeFor,
  loadLiveBypass,
  loadLiveParams,
  noteName,
  pressureMacro,
  saveLiveBypass,
  saveLiveParams,
  type LiveBypass,
  type LiveEffectId,
  type LiveParamKey,
  type LiveParams,
} from '../audio/rack/liveControls';
import { loadConvertedInstruments } from '../audio/rack/convertedInstruments';
import { useStore } from '../state/useStore';
import Knob from './Knob';
import PlayableKeyboard from './PlayableKeyboard';

export interface LiveControlsPageProps {
  /** Caminho `.mrq` pra abrir já (vindo do Conversor/Estúdio) — `null` mostra o seletor. */
  initialPath: string | null;
  /** Volta pra tela anterior. */
  onClose: () => void;
}

// Mesmo mapa de teclado do computador do MidiControllerDialog (oitava e meia
// estilo DAW: "a" = nota base, "w"/"s" = semitons vizinhos...).
const COMPUTER_KEY_TO_SEMITONE: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16,
};

export default function LiveControlsPage({ initialPath, onClose }: LiveControlsPageProps) {
  const pushToast = useStore((s) => s.pushToast);

  const [path, setPath] = useState<string | null>(initialPath);
  const [instrumentName, setInstrumentName] = useState('');
  const [presets, setPresets] = useState<{ value: string; label: string }[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('default');
  const [referenceRoot, setReferenceRoot] = useState(60);
  const [params, setParams] = useState<LiveParams>(() => defaultLiveParams());
  const [bypass, setBypass] = useState<LiveBypass>(() => defaultLiveBypass());
  const [activeNotes, setActiveNotes] = useState<ReadonlySet<number>>(new Set());
  const [midiDevices, setMidiDevices] = useState<string[]>([]);
  const [midiConnected, setMidiConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(() => loadConvertedInstruments());

  const ctxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<LiveInstrumentEngine | null>(null);
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const computerKeyNoteRef = useRef<Map<string, number>>(new Map());
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const bypassRef = useRef(bypass);
  bypassRef.current = bypass;
  const pathRef = useRef(path);
  pathRef.current = path;

  const ensureEngine = useCallback((): LiveInstrumentEngine => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    if (!engineRef.current) {
      const engine = new LiveInstrumentEngine(ctxRef.current, paramsRef.current);
      engine.output.connect(ctxRef.current.destination);
      engineRef.current = engine;
    }
    return engineRef.current;
  }, []);

  const resumeAudio = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }, []);

  const loadInstrument = useCallback(
    async (filePath: string) => {
      setLoading(true);
      setError(null);
      try {
        const engine = ensureEngine();
        resumeAudio();
        const result = await engine.load(filePath);
        setPath(filePath);
        setInstrumentName(result.instrumentName);
        setPresets(result.presets);
        setSelectedPreset(result.presets[0]?.value ?? 'default');
        setReferenceRoot(result.referenceRoot);
        // Sem parâmetros salvos, a tecla raiz padrão é a raiz de referência
        // do instrumento (transposição zero — toca na afinação original).
        const saved = loadLiveParams(filePath);
        const next = hasSavedLiveParams(filePath) ? saved : { ...saved, rootKey: result.referenceRoot };
        setParams(next);
        engine.setParams(next);
        // Bypass salvo do instrumento (v0.2.24) — nenhum desligado se não houver.
        const savedBypass = loadLiveBypass(filePath);
        setBypass(savedBypass);
        engine.setBypass(savedBypass);
        setRecent(loadConvertedInstruments());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        pushToast(`Não foi possível abrir o instrumento: ${message}`, 'error');
      } finally {
        setLoading(false);
      }
    },
    [ensureEngine, pushToast, resumeAudio]
  );

  // Abre o instrumento inicial (vindo do Conversor/Estúdio).
  useEffect(() => {
    if (initialPath) void loadInstrument(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Limpeza ao sair da página.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (midiAccessRef.current) {
        midiAccessRef.current.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
      }
      engineRef.current?.dispose();
      engineRef.current = null;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) void ctx.close();
    };
  }, []);

  const updateParam = useCallback((key: LiveParamKey, value: number) => {
    resumeAudio();
    setParams((prev) => {
      let next = { ...prev, [key]: value };
      // NOVIDADE 1 — PRESSÃO: macro de caráter ao vivo. Mexer no knob ajusta
      // drive + presença + cola + largura + reverb de forma coerente (os
      // outros knobs se movem junto, dá pra ajustar depois individualmente).
      if (key === 'pressure') {
        const macro = pressureMacro(value);
        next = { ...next, driveDb: macro.driveDb, eqHighDb: macro.eqHighDb, comp: macro.comp, stereo: macro.stereo, reverb: macro.reverb };
      }
      engineRef.current?.setParams(next);
      const p = pathRef.current;
      if (p) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => saveLiveParams(p, next), 400);
      }
      return next;
    });
  }, [resumeAudio]);

  /** Liga/desliga um efeito (bypass) — o ajuste dos knobs é preservado. */
  const toggleBypass = useCallback(
    (id: LiveEffectId) => {
      resumeAudio();
      setBypass((prev) => {
        const next = { ...prev, [id]: !prev[id] };
        engineRef.current?.setBypass(next);
        const p = pathRef.current;
        if (p) saveLiveBypass(p, next);
        return next;
      });
    },
    [resumeAudio]
  );

  const resetParams = useCallback(() => {
    const next = { ...defaultLiveParams(), rootKey: referenceRoot };
    const nextBypass = defaultLiveBypass();
    setParams(next);
    setBypass(nextBypass);
    engineRef.current?.setParams(next);
    engineRef.current?.setBypass(nextBypass);
    if (pathRef.current) {
      clearLiveParams(pathRef.current);
      clearLiveBypass(pathRef.current);
    }
    pushToast('Controles restaurados aos padrões.');
  }, [pushToast, referenceRoot]);

  const noteOn = useCallback(
    (note: number, velocity = 100) => {
      resumeAudio();
      engineRef.current?.noteOn(note, velocity);
      setActiveNotes((prev) => {
        const next = new Set(prev);
        next.add(note);
        return next;
      });
    },
    [resumeAudio]
  );

  const noteOff = useCallback((note: number) => {
    engineRef.current?.noteOff(note);
    setActiveNotes((prev) => {
      const next = new Set(prev);
      next.delete(note);
      return next;
    });
  }, []);

  // Teclado do computador ("a" toca a tecla raiz).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const key = e.key.toLowerCase();
      const semitone = COMPUTER_KEY_TO_SEMITONE[key];
      if (semitone === undefined) return;
      e.preventDefault();
      const note = paramsRef.current.rootKey + semitone;
      if (note < 0 || note > 127) return;
      computerKeyNoteRef.current.set(key, note);
      noteOn(note);
    }
    function onKeyUp(e: KeyboardEvent) {
      const key = e.key.toLowerCase();
      const note = computerKeyNoteRef.current.get(key);
      if (note === undefined) return;
      computerKeyNoteRef.current.delete(key);
      noteOff(note);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [noteOn, noteOff]);

  async function openFilePicker() {
    try {
      const result = await openDialog({
        title: 'Abrir instrumento convertido (.mrq)',
        multiple: false,
        filters: [{ name: 'Instrumento MRQ', extensions: ['mrq'] }],
      });
      const picked = Array.isArray(result) ? result[0] : result;
      if (picked) void loadInstrument(picked);
    } catch {
      pushToast('Não foi possível abrir o seletor de arquivos.', 'error');
    }
  }

  async function connectMidi() {
    if (!('requestMIDIAccess' in navigator)) {
      pushToast('Este navegador/sistema não suporta Web MIDI. Use o teclado na tela ou o do computador.', 'error');
      return;
    }
    try {
      const requestAccess = navigator.requestMIDIAccess?.bind(navigator);
      if (!requestAccess) throw new Error('Este navegador não suporta Web MIDI.');
      const access = await requestAccess({ sysex: false });
      midiAccessRef.current = access;
      const refresh = () => {
        const names = Array.from(access.inputs.values()).map((i) => i.name ?? 'Dispositivo MIDI');
        setMidiDevices(names);
        setMidiConnected(names.length > 0);
      };
      refresh();
      access.inputs.forEach((input) => {
        input.onmidimessage = (ev: MIDIMessageEvent) => {
          const data = ev.data;
          if (!data || data.length < 2) return;
          const command = data[0] & 0xf0;
          const number = data[1];
          const value = data[2] ?? 0;
          if (command === 0x90 && value > 0) noteOn(number, value);
          else if (command === 0x80 || (command === 0x90 && value === 0)) noteOff(number);
        };
      });
      access.onstatechange = refresh;
      if (access.inputs.size === 0) {
        pushToast('Nenhum teclado MIDI USB encontrado. Conecte o teclado e clique de novo.', 'error');
      } else {
        pushToast('Teclado MIDI conectado — toque para ouvir o som final.');
      }
    } catch {
      pushToast('Acesso MIDI negado. Libere a permissão do navegador e tente de novo.', 'error');
    }
  }

  const kbRange = keyboardRangeFor(params);
  const loaded = path !== null && !loading && !error;

  return (
    <div className="live-page">
      {/* ---------- Cabeçalho ---------- */}
      <div className="live-header">
        <button type="button" className="btn ghost small" onClick={onClose} title="Voltar">
          <ArrowLeft size={14} /> Voltar
        </button>
        <div className="live-title">
          <strong>Controles ao Vivo</strong>
          <span>{loaded ? `${instrumentName} — ${path}` : 'Nenhum instrumento aberto'}</span>
        </div>
        <div className="live-actions">
          {presets.length > 1 && (
            <select
              className="studio-preset-select"
              value={selectedPreset}
              onChange={(e) => {
                setSelectedPreset(e.target.value);
                engineRef.current?.selectPreset(e.target.value);
              }}
              title="Preset do instrumento"
            >
              {presets.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          )}
          <button type="button" className="btn ghost small" onClick={() => void openFilePicker()} title="Abrir outro .mrq">
            <FolderOpen size={14} /> Abrir .mrq…
          </button>
          <button type="button" className="btn ghost small" onClick={() => void connectMidi()} title="Conectar teclado USB MIDI (Web MIDI)">
            <Usb size={14} /> {midiConnected ? `MIDI: ${midiDevices[0] ?? 'conectado'}` : 'Conectar MIDI'}
          </button>
          <button type="button" className="btn ghost small" onClick={resetParams} title="Restaurar todos os controles aos padrões">
            <RotateCcw size={14} /> Padrões
          </button>
        </div>
      </div>

      {loading && (
        <div className="live-loading"><Loader2 size={18} className="mrq-spin" /> Carregando instrumento…</div>
      )}
      {error && <div className="live-error">{error}</div>}

      {!path && !loading && (
        <div className="studio-empty">
          <Piano size={40} />
          <h3>Controles ao Vivo</h3>
          <p>
            Abra um instrumento convertido pra ajustar todos os controles (faixa, envelope, EQ, drive e
            efeitos) sobre todas as amostras e ouvir o som final em tempo real, como vai sair no rack ao vivo.
          </p>
          <button type="button" className="btn primary" onClick={() => void openFilePicker()}>
            <FolderOpen size={15} /> Abrir .mrq…
          </button>
          {recent.length > 0 && (
            <div className="studio-recent">
              <h4>Instrumentos convertidos</h4>
              {recent.slice(0, 8).map((entry) => (
                <button key={entry.path} type="button" className="studio-recent-item" onClick={() => void loadInstrument(entry.path)}>
                  {entry.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {loaded && (
        <>
          {/* ---------- Faixa / raiz (steppers) ---------- */}
          <div className="live-steppers">
            {LIVE_STEPPERS.map((key) => {
              const def = LIVE_PARAM_DEFS[key];
              const value = params[key];
              const showNote = key === 'noteMin' || key === 'noteMax' || key === 'rootKey';
              return (
                <div key={key} className="live-stepper">
                  <span className="live-stepper-label">{def.label}</span>
                  <div className="live-stepper-row">
                    <span className="live-stepper-value">{def.format(value)}</span>
                    <button type="button" onClick={() => updateParam(key, value - def.step)} title="Diminuir">−</button>
                    <button type="button" onClick={() => updateParam(key, value + def.step)} title="Aumentar">+</button>
                  </div>
                  {showNote && <span className="live-stepper-note">{noteName(value)}</span>}
                </div>
              );
            })}
          </div>

          {/* ---------- Linha 1 (knobs) ---------- */}
          <div className="live-knobs">
            {LIVE_KNOBS_ROW1.map((key) => {
              const def = LIVE_PARAM_DEFS[key];
              const fxId = effectIdForParam(key);
              return (
                <Knob
                  key={key}
                  label={def.label}
                  value={params[key]}
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  defaultValue={def.default}
                  format={def.format}
                  onChange={(v) => updateParam(key, v)}
                  disabled={fxId ? bypass[fxId] : false}
                />
              );
            })}
          </div>

          {/* ---------- Efeitos / ao vivo ---------- */}
          <div className="live-fx-head">
            <span className="live-fx-title">EFEITOS / AO VIVO</span>
            <select className="live-scope" value="all" disabled title="Os controles atuam sobre todas as amostras do instrumento">
              <option value="all">INSTRUMENTO INTEIRO</option>
            </select>
          </div>
          <div className="live-knobs">
            {LIVE_KNOBS_FX.map((key) => {
              const def = LIVE_PARAM_DEFS[key];
              const fxId = effectIdForParam(key);
              return (
                <Knob
                  key={key}
                  label={def.label}
                  value={params[key]}
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  defaultValue={def.default}
                  format={def.format}
                  onChange={(v) => updateParam(key, v)}
                  disabled={fxId ? bypass[fxId] : false}
                />
              );
            })}
          </div>

          {/* ---------- Ferramentas raras (v0.2.23) ---------- */}
          <div className="live-fx-head">
            <span className="live-fx-title">FERRAMENTAS</span>
            <span className="live-fx-sub">compressor · phaser · flanger · tremolo · bitcrusher · shimmer · oitavador · gate · vibrato · auto-pan · exciter · ring mod · tape · arpejador · curva de velocity</span>
          </div>
          <div className="live-knobs">
            {LIVE_KNOBS_TOOLS.map((key) => {
              const def = LIVE_PARAM_DEFS[key];
              const fxId = effectIdForParam(key);
              return (
                <Knob
                  key={key}
                  label={def.label}
                  value={params[key]}
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  defaultValue={def.default}
                  format={def.format}
                  onChange={(v) => updateParam(key, v)}
                  disabled={fxId ? bypass[fxId] : false}
                />
              );
            })}
          </div>

          {/* ---------- Novidades (v0.2.23) ---------- */}
          <div className="live-fx-head">
            <span className="live-fx-title">NOVIDADES</span>
            <span className="live-fx-sub">PRESSÃO: macro de caráter de palco (drive + presença + cola + largura + reverb) · ECO VIVO: delay que se fecha tocando denso e abre espaçado</span>
          </div>
          <div className="live-knobs">
            {LIVE_KNOBS_NEW.map((key) => {
              const def = LIVE_PARAM_DEFS[key];
              const fxId = effectIdForParam(key);
              return (
                <Knob
                  key={key}
                  label={def.label}
                  value={params[key]}
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  defaultValue={def.default}
                  format={def.format}
                  onChange={(v) => updateParam(key, v)}
                  disabled={fxId ? bypass[fxId] : false}
                />
              );
            })}
          </div>

          {/* ---------- Bypass dos efeitos (v0.2.24) ---------- */}
          <div className="live-fx-head">
            <span className="live-fx-title">BYPASS DOS EFEITOS</span>
            <span className="live-fx-sub">clique pra tirar/ligar cada efeito — o ajuste dos knobs é guardado</span>
          </div>
          <div className="live-bypass">
            {LIVE_EFFECTS.map((fx) => {
              const off = bypass[fx.id];
              return (
                <button
                  key={fx.id}
                  type="button"
                  className={`live-bypass-chip${off ? ' off' : ''}`}
                  onClick={() => toggleBypass(fx.id)}
                  aria-pressed={off}
                  title={off ? `${fx.label} desligado (bypass) — clique pra ligar` : `${fx.label} ligado — clique pra desligar`}
                >
                  <span className="live-bypass-dot" />
                  {fx.label}
                </button>
              );
            })}
          </div>

          {/* ---------- Teclado ---------- */}
          <div className="live-keyboard">
            <PlayableKeyboard
              lowestNote={kbRange.lowest}
              highestNote={kbRange.highest}
              activeNotes={activeNotes}
              onNoteOn={(note) => noteOn(note)}
              onNoteOff={(note) => noteOff(note)}
            />
            <p className="live-hint">
              Toque no teclado da tela, use as teclas do computador (a tecla <b>A</b> toca a tecla raiz) ou
              conecte o teclado USB MIDI. Os ajustes ficam salvos automaticamente pra este instrumento.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
