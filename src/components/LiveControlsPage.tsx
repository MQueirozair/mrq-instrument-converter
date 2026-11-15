/**
 * Controles ao Vivo (v0.2.22, redesenhado na v0.2.25) — página com todos os
 * controles globais do instrumento ("INSTRUMENTO INTEIRO"): faixa de
 * notas/velocity, tecla raiz, volume, pan/balance, afinação, envelope, EQ,
 * drive e os efeitos ao vivo (reverb, stereo, delay, chorus + ferramentas).
 *
 * Serve pra pré-escutar, em tempo real, como o som final vai sair quando o
 * instrumento for aberto num rack de instrumentos pra tocar ao vivo: os
 * controles atuam sobre TODAS as amostras/zonas do `.mrq` carregado e podem
 * ser mexidos enquanto toca (teclado na tela, teclado do computador ou
 * teclado USB MIDI via Web MIDI).
 *
 * v0.2.25: visual premium (foto de referência) — knobs novos, módulos de
 * efeito com botão de energia (bypass), linha MIDI (canal/oitava/velocity/
 * modo), medidor de saída, barra de status e lista de instrumentos.
 *
 * Os parâmetros ficam salvos por instrumento (localStorage) — reabrir o
 * instrumento depois traz o mesmo ajuste de volta.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { ArrowLeft, CheckCircle2, Clock3, Download, FolderOpen, GitCompareArrows, Loader2, Piano, Power, Redo2, RotateCcw, Save, Undo2, Usb, Waves } from 'lucide-react';
import { LiveInstrumentEngine } from '../audio/rack/LiveInstrumentEngine';
import { ParamHistory } from '../audio/rack/paramHistory';
import {
  LIVE_EFFECTS,
  LIVE_KNOBS_FX,
  LIVE_KNOBS_NEW,
  LIVE_KNOBS_ROW1,
  LIVE_KNOBS_TOOLS,
  LIVE_MIDI_ROW,
  LIVE_PARAM_DEFS,
  LIVE_STEPPERS,
  applyVelocityCurve,
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
  panDisplayLabel,
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
import EffectModule, { type EffectModuleConfig } from './EffectModule';
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

// v0.2.29: thumbnail/hero do instrumento pela palavra-chave do nome
// (piano, strings, brass, organ, synth, guitar) — só visual, sem efeito no áudio.
function thumbFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('string') || n.includes('violin') || n.includes('corda')) return '/assets/thumb-strings.jpg';
  if (n.includes('brass') || n.includes('tromp') || n.includes('trumpet') || n.includes('metal')) return '/assets/thumb-brass.jpg';
  if (n.includes('organ') || n.includes('órgão') || n.includes('orgao')) return '/assets/thumb-organ.jpg';
  if (n.includes('synth') || n.includes('pad') || n.includes('teclado')) return '/assets/thumb-synth.jpg';
  if (n.includes('guitar') || n.includes('violão') || n.includes('viola')) return '/assets/thumb-guitar.jpg';
  return '/assets/thumb-piano.jpg';
}

function heroFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('string') || n.includes('violin') || n.includes('corda')) return '/assets/thumb-strings.jpg';
  if (n.includes('brass') || n.includes('tromp') || n.includes('trumpet') || n.includes('metal')) return '/assets/thumb-brass.jpg';
  if (n.includes('organ') || n.includes('órgão') || n.includes('orgao')) return '/assets/thumb-organ.jpg';
  if (n.includes('synth') || n.includes('pad') || n.includes('teclado')) return '/assets/thumb-synth.jpg';
  if (n.includes('guitar') || n.includes('violão') || n.includes('viola')) return '/assets/thumb-guitar.jpg';
  return '/assets/grand-piano-hero.jpg';
}

/** Configuração dos módulos de efeito (knob principal + slider + extras). */
const FX_MODULES: Record<string, EffectModuleConfig[]> = {
  efeitos: [
    { effect: LIVE_EFFECTS.find((e) => e.id === 'reverb')!, main: 'reverb', slider: 'reverbSize', extras: ['reverbDamp', 'reverbPredelayMs', 'reverbColor'] },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'stereo')!, main: 'stereo' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'delay')!, main: 'delay', slider: 'delayTimeMs', extras: ['delayFeedback'] },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'chorus')!, main: 'chorus', slider: 'chorusDepth', extras: ['chorusRateHz'] },
  ],
  ferramentas: [
    { effect: LIVE_EFFECTS.find((e) => e.id === 'comp')!, main: 'comp' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'phaser')!, main: 'phaserMix', slider: 'phaserDepth', extras: ['phaserRate'] },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'flanger')!, main: 'flangerMix', slider: 'flangerDepth', extras: ['flangerRate', 'flangerFeedback'] },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'tremolo')!, main: 'tremoloDepth', slider: 'tremoloRate' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'crush')!, main: 'crushMix', slider: 'crushBits', extras: ['crushRate'] },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'shimmer')!, main: 'shimmerMix' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'octaver')!, main: 'octaverMix' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'gate')!, main: 'gateThreshold' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'vibrato')!, main: 'vibratoDepth', slider: 'vibratoRate' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'autopan')!, main: 'autopanDepth', slider: 'autopanRate' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'exciter')!, main: 'exciter' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'ring')!, main: 'ringMix', slider: 'ringFreq' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'tape')!, main: 'tape' },
    { effect: LIVE_EFFECTS.find((e) => e.id === 'arp')!, main: 'arpRate', slider: 'arpRange' },
  ],
  novidades: [
    { effect: LIVE_EFFECTS.find((e) => e.id === 'ecoVivo')!, main: 'ecoVivo' },
  ],
};

type FxTab = keyof typeof FX_MODULES;

export default function LiveControlsPage({ initialPath, onClose }: LiveControlsPageProps) {
  const pushToast = useStore((s) => s.pushToast);

  const [path, setPath] = useState<string | null>(initialPath);
  const [instrumentName, setInstrumentName] = useState('');
  const [presets, setPresets] = useState<{ value: string; label: string }[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('default');
  const [referenceRoot, setReferenceRoot] = useState(60);
  const [params, setParams] = useState<LiveParams>(() => defaultLiveParams());
  const [bypass, setBypass] = useState<LiveBypass>(() => defaultLiveBypass());
  const [fxTab, setFxTab] = useState<FxTab>('efeitos');
  const [activeNotes, setActiveNotes] = useState<ReadonlySet<number>>(new Set());
  const [midiDevices, setMidiDevices] = useState<string[]>([]);
  const [midiConnected, setMidiConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(() => loadConvertedInstruments());
  const [latencyMs, setLatencyMs] = useState(0);
  // v0.2.26: estado dos botões Desfazer/Refazer (atualizado a cada operação).
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // v0.2.27: Comparar (A/B) — quando ativo, todos os efeitos em bypass.
  const [compare, setCompare] = useState(false);
  // v0.2.29: busca da lista de instrumentos + velocity da última nota tocada.
  const [search, setSearch] = useState('');
  const [lastVelocity, setLastVelocity] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<LiveInstrumentEngine | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const computerKeyNoteRef = useRef<Map<string, number>>(new Map());
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const bypassRef = useRef(bypass);
  bypassRef.current = bypass;
  const pathRef = useRef(path);
  pathRef.current = path;
  // v0.2.26: histórico de edição por instrumento (sessão) + debounce do commit.
  const historyByPathRef = useRef<Map<string, ParamHistory>>(new Map());
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Histórico do instrumento atual (cria se ainda não existe). */
  const currentHistory = useCallback((): ParamHistory => {
    const p = pathRef.current;
    if (!p) {
      // Sem instrumento: histórico descartável (nunca usado de verdade).
      return new ParamHistory();
    }
    let h = historyByPathRef.current.get(p);
    if (!h) {
      h = new ParamHistory();
      historyByPathRef.current.set(p, h);
    }
    return h;
  }, []);

  /** Atualiza os botões Desfazer/Refazer conforme o histórico atual. */
  const refreshHistButtons = useCallback(() => {
    const h = currentHistory();
    setCanUndo(h.canUndo());
    setCanRedo(h.canRedo());
  }, [currentHistory]);

  const ensureEngine = useCallback((): LiveInstrumentEngine => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
      const ctx = ctxRef.current;
      setLatencyMs(Math.round(((ctx.outputLatency || ctx.baseLatency || 0) * 1000) * 10) / 10);
    }
    if (!engineRef.current) {
      const engine = new LiveInstrumentEngine(ctxRef.current, paramsRef.current);
      engine.output.connect(ctxRef.current.destination);
      // Medidor de saída (analyser no barramento final).
      const analyser = ctxRef.current.createAnalyser();
      analyser.fftSize = 512;
      engine.output.connect(analyser);
      analyserRef.current = analyser;
      engineRef.current = engine;
    }
    return engineRef.current;
  }, []);

  const resumeAudio = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }, []);

  // Medidor de saída (rAF, sem re-render do React).
  useEffect(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      peak = Math.max(rms, peak * 0.92);
      const el = meterRef.current;
      if (el) {
        // v0.2.29: medidor segmentado (18 segmentos) — verde → amarelo → vermelho.
        const pct = Math.min(100, peak * 140);
        const lit = Math.round((pct / 100) * 18);
        const segs = el.children;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i] as HTMLElement;
          if (i < lit) {
            seg.className = `seg on ${i >= 15 ? 'r' : i >= 12 ? 'y' : 'g'}`;
          } else {
            seg.className = 'seg';
          }
        }
      }
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (meterRafRef.current !== null) cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    };
  }, [path]);

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
        paramsRef.current = next;
        setParams(next);
        engine.setParams(next);
        // Bypass salvo do instrumento (v0.2.24) — nenhum desligado se não houver.
        const savedBypass = loadLiveBypass(filePath);
        setBypass(savedBypass);
        engine.setBypass(savedBypass);
        // v0.2.26: o histórico é por instrumento — trocar de instrumento
        // preserva o de cada um (mapa na sessão); atualiza os botões.
        refreshHistButtons();
        setRecent(loadConvertedInstruments());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        pushToast(`Não foi possível abrir o instrumento: ${message}`, 'error');
      } finally {
        setLoading(false);
      }
    },
    [ensureEngine, pushToast, refreshHistButtons, resumeAudio]
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
      if (meterRafRef.current !== null) cancelAnimationFrame(meterRafRef.current);
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

  /**
   * Aplica um conjunto completo de parâmetros (fonte única): atualiza o
   * ref + estado + DSP + salvamento. Com `recordHistory`, registra no
   * histórico (agrupando o gesto via debounce). Sem ele (undo/redo/load),
   * NÃO registra — assim a restauração nunca gera loop de callbacks.
   */
  const applyParams = useCallback(
    (next: LiveParams, recordHistory: boolean) => {
      const prev = paramsRef.current;
      if (recordHistory) {
        const h = currentHistory();
        for (const k of Object.keys(next) as LiveParamKey[]) {
          if (next[k] !== prev[k]) h.record(k, prev[k], next[k]);
        }
        // Agrupa movimentos contínuos: confirma o gesto 700ms após parar.
        if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
        commitTimerRef.current = setTimeout(() => {
          commitTimerRef.current = null;
          currentHistory().commit();
          refreshHistButtons();
        }, 700);
      }
      paramsRef.current = next;
      setParams(next);
      engineRef.current?.setParams(next);
      const p = pathRef.current;
      if (p) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => saveLiveParams(p, next), 400);
      }
    },
    [currentHistory, refreshHistButtons]
  );

  const updateParam = useCallback(
    (key: LiveParamKey, value: number) => {
      resumeAudio();
      let next = { ...paramsRef.current, [key]: value };
      // NOVIDADE 1 — PRESSÃO: macro de caráter ao vivo. Mexer no knob ajusta
      // drive + presença + cola + largura + reverb de forma coerente (os
      // outros knobs se movem junto, dá pra ajustar depois individualmente).
      if (key === 'pressure') {
        const macro = pressureMacro(value);
        next = { ...next, driveDb: macro.driveDb, eqHighDb: macro.eqHighDb, comp: macro.comp, stereo: macro.stereo, reverb: macro.reverb };
      }
      applyParams(next, true);
    },
    [applyParams, resumeAudio]
  );

  /** Desfaz a última alteração (restaura before, sem registrar de novo). */
  const doUndo = useCallback(() => {
    resumeAudio();
    const entry = currentHistory().undo();
    if (!entry) return;
    const next = { ...paramsRef.current };
    for (const change of entry.changes) next[change.key] = change.before;
    applyParams(next, false);
    refreshHistButtons();
  }, [applyParams, currentHistory, refreshHistButtons, resumeAudio]);

  /** Refaz a última alteração desfeita (restaura after, sem registrar). */
  const doRedo = useCallback(() => {
    resumeAudio();
    const entry = currentHistory().redo();
    if (!entry) return;
    const next = { ...paramsRef.current };
    for (const change of entry.changes) next[change.key] = change.after;
    applyParams(next, false);
    refreshHistButtons();
  }, [applyParams, currentHistory, refreshHistButtons, resumeAudio]);

  /** Liga/desliga um efeito (bypass) — o ajuste dos knobs é preservado. */
  const toggleBypass = useCallback(
    (id: LiveEffectId) => {
      resumeAudio();
      setBypass((prev) => {
        const next = { ...prev, [id]: !prev[id] };
        // v0.2.27: respeita o modo Comparar (A/B) — se ativo, tudo bypassado.
        if (!compareRef.current) engineRef.current?.setBypass(next);
        const p = pathRef.current;
        if (p) saveLiveBypass(p, next);
        return next;
      });
    },
    [resumeAudio]
  );

  // v0.2.27: Comparar (A/B) — alterna entre o som atual e o original seco.
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const toggleCompare = useCallback(() => {
    resumeAudio();
    setCompare((prev) => {
      const next = !prev;
      if (next) {
        const all = defaultLiveBypass();
        for (const fx of LIVE_EFFECTS) all[fx.id] = true;
        engineRef.current?.setBypass(all);
      } else {
        engineRef.current?.setBypass(bypassRef.current);
      }
      return next;
    });
  }, [resumeAudio]);

  /** JSON das configurações atuais (pra Salvar como / Exportar). */
  const settingsJson = useCallback(
    () =>
      JSON.stringify(
        {
          app: 'MRQ Instrument Converter',
          version: '0.2.27',
          instrument: pathRef.current,
          params: paramsRef.current,
          bypass: bypassRef.current,
        },
        null,
        2
      ),
    []
  );

  /** Salvar: grava as configurações atuais na hora (além do autosave). */
  const saveSettings = useCallback(() => {
    const p = pathRef.current;
    if (!p) return;
    saveLiveParams(p, paramsRef.current);
    saveLiveBypass(p, bypassRef.current);
    pushToast('Configurações salvas.');
  }, [pushToast]);

  /** Salvar como: escolhe o arquivo e grava as configurações (.json). */
  const saveSettingsAs = useCallback(async () => {
    try {
      const picked = await saveDialog({
        title: 'Salvar configurações (.json)',
        defaultPath: 'mrq-live-settings.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!picked) return;
      await writeTextFile(picked, settingsJson());
      pushToast('Configurações salvas.');
    } catch {
      pushToast('Não foi possível salvar o arquivo.', 'error');
    }
  }, [pushToast, settingsJson]);

  /** Exportar: baixa as configurações (.json) direto. */
  const exportSettings = useCallback(() => {
    try {
      const blob = new Blob([settingsJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mrq-live-settings.json';
      a.click();
      URL.revokeObjectURL(url);
      pushToast('Configurações exportadas.');
    } catch {
      pushToast('Não foi possível exportar.', 'error');
    }
  }, [pushToast, settingsJson]);

  const resetParams = useCallback(() => {
    const next = { ...defaultLiveParams(), rootKey: referenceRoot };
    const nextBypass = defaultLiveBypass();
    // v0.2.26: restaurar padrões limpa o histórico do instrumento.
    currentHistory().clear();
    paramsRef.current = next;
    setParams(next);
    setBypass(nextBypass);
    engineRef.current?.setParams(next);
    engineRef.current?.setBypass(nextBypass);
    if (pathRef.current) {
      clearLiveParams(pathRef.current);
      clearLiveBypass(pathRef.current);
    }
    refreshHistButtons();
    pushToast('Controles restaurados aos padrões.');
  }, [currentHistory, pushToast, referenceRoot, refreshHistButtons]);

  const noteOn = useCallback(
    (note: number, velocity?: number) => {
      resumeAudio();
      const vel = velocity ?? paramsRef.current.defaultVelocity;
      engineRef.current?.noteOn(note, vel);
      setLastVelocity(vel);
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

  // v0.2.26: atalhos de Desfazer/Refazer — Ctrl+Z / Ctrl+Y (Windows) e
  // Cmd+Z / Cmd+Shift+Z (macOS). Ignora quando digitando num campo.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if ((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [doUndo, doRedo]);

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
          // v0.2.25: CANAL MIDI filtra a entrada (status baixo nibble = canal).
          const channel = (data[0] & 0x0f) + 1;
          if (channel !== Math.round(paramsRef.current.midiChannel)) return;
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

  /** Knob genérico da linha principal (com bypass desabilitando). */
  function renderKnob(key: LiveParamKey, size: 'sm' | 'md' | 'lg' = 'md') {
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
        format={key === 'pan' ? (v) => panDisplayLabel(v) : def.format}
        onChange={(v) => updateParam(key, v)}
        disabled={fxId ? bypass[fxId] : false}
        size={size}
      />
    );
  }

  /** Botão de energia (bypass) compacto pra efeitos da linha principal. */
  function renderPower(id: LiveEffectId, label: string) {
    const off = bypass[id];
    return (
      <button
        type="button"
        className={`live-power${off ? ' off' : ''}`}
        onClick={() => toggleBypass(id)}
        aria-pressed={off}
        title={off ? `${label} desligado (bypass) — clique pra ligar` : `${label} ligado — clique pra desligar (bypass)`}
      >
        <Power size={12} />
      </button>
    );
  }

  /** Gráfico da curva de velocity (SVG) — espelha applyVelocityCurve. */
  function renderVelocityCurve() {
    const curve = params.velCurve;
    const pts: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const v = 1 + (i / 24) * 126;
      const shaped = applyVelocityCurve(v, curve);
      const x = 4 + (i / 24) * 92;
      const y = 44 - ((shaped - 1) / 126) * 40;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return (
      <div className="live-velcurve">
        <span className="knob-label">CURVA DE VELOCIDADE</span>
        <svg viewBox="0 0 100 48" width="100" height="48" aria-hidden="true">
          <line x1="4" y1="44" x2="96" y2="44" stroke="#2a313b" strokeWidth="1" />
          <line x1="4" y1="44" x2="4" y2="4" stroke="#2a313b" strokeWidth="1" />
          <polyline points={pts.join(' ')} fill="none" stroke="#54c9ef" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <span className="live-velcurve-val">{curve > 0 ? `+${curve}` : curve} · {curve === 0 ? 'Linear' : curve > 0 ? 'Expande' : 'Equaliza'}</span>
      </div>
    );
  }

  return (
    <div className="live-page">
      <div className="live-layout">
        {/* ---------- Barra lateral: instrumentos convertidos ---------- */}
        <aside className="live-sidebar">
          <div className="live-side-head">
            <span>Instrumentos Convertidos</span>
          </div>
          <div className="live-side-search">
            <input
              type="text"
              placeholder="Pesquisar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Pesquisar instrumentos"
            />
          </div>
          <div className="live-side-list">
            {recent.length === 0 && <p className="live-side-empty">Nenhum instrumento convertido ainda.</p>}
            {recent
              .filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase()))
              .map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`live-side-item${entry.path === path ? ' active' : ''}`}
                  onClick={() => void loadInstrument(entry.path)}
                  title={entry.path}
                >
                  <img className="live-side-thumb" src={thumbFor(entry.name)} alt="" />
                  <span className="live-side-text">
                    <span className="live-side-name">{entry.name}</span>
                    <span className="live-side-sub">{entry.path.split(/[\\/]/).pop() ?? ''}</span>
                  </span>
                  <span className="live-side-dot" />
                </button>
              ))}
          </div>
          <div className="live-side-btns">
            <button type="button" className="btn ghost small" onClick={() => setRecent(loadConvertedInstruments())} title="Recarregar a lista de instrumentos convertidos">
              <RotateCcw size={13} /> Atualizar Lista
            </button>
            <button type="button" className="btn ghost small" onClick={() => void openFilePicker()}>
              <FolderOpen size={13} /> Abrir Pasta
            </button>
          </div>
          <div className="live-side-info">
            <span className="live-side-info-title">Informações</span>
            <dl>
              <div><dt>Instrumento</dt><dd>{instrumentName || '—'}</dd></div>
              <div><dt>Raiz de referência</dt><dd>{loaded ? `${referenceRoot} (${noteName(referenceRoot)})` : '—'}</dd></div>
              <div><dt>Presets</dt><dd>{presets.length || '—'}</dd></div>
              <div><dt>Integridade</dt><dd>{loaded ? 'OK' : '—'}</dd></div>
            </dl>
          </div>
        </aside>

        {/* ---------- Conteúdo principal ---------- */}
        <div className="live-main">
          {/* Cabeçalho: banner do instrumento + status + ações */}
          <div className="live-header">
            <button type="button" className="btn ghost small live-back" onClick={onClose} title="Voltar">
              <ArrowLeft size={14} /> Voltar
            </button>
            <div className="live-banner">
              <img className="live-hero" src={heroFor(instrumentName)} alt="" />
              <div className="live-banner-text">
                <strong>{instrumentName || 'Controles ao Vivo'}</strong>
                <span>{loaded ? 'Instrumento Convertido' : 'Nenhum instrumento aberto'}</span>
              </div>
            </div>
            <div className="live-status">
              <span className="live-status-item ok"><CheckCircle2 size={16} /> <span><b>Pronto</b> para tocar</span></span>
              <span className="live-status-item"><Waves size={16} /> <span><b>Polifonia</b> 128 vozes</span></span>
              <span className="live-status-item"><Clock3 size={16} /> <span><b>Latência</b> {latencyMs ? `${latencyMs} ms` : '—'}</span></span>
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
              <button type="button" className="btn ghost small" onClick={() => void connectMidi()} title="Conectar teclado USB MIDI (Web MIDI)">
                <Usb size={14} /> {midiConnected ? `MIDI: ${midiDevices[0] ?? 'conectado'}` : 'Conectar MIDI'}
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={doUndo}
                disabled={!canUndo}
                title="Desfazer (Ctrl+Z / Cmd+Z)"
              >
                <Undo2 size={14} /> Desfazer
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={doRedo}
                disabled={!canRedo}
                title="Refazer (Ctrl+Y / Cmd+Shift+Z)"
              >
                <Redo2 size={14} /> Refazer
              </button>
              <button type="button" className="btn ghost small" onClick={saveSettings} title="Salvar as configurações deste instrumento">
                <Save size={14} /> Salvar
              </button>
              <button type="button" className="btn ghost small" onClick={() => void saveSettingsAs()} title="Salvar as configurações em um arquivo (.json)">
                <Save size={14} /> Salvar como
              </button>
              <button
                type="button"
                className={`btn ghost small${compare ? ' active' : ''}`}
                onClick={toggleCompare}
                aria-pressed={compare}
                title="Comparar: alterna entre o som atual e o original (sem efeitos)"
              >
                <GitCompareArrows size={14} /> Comparar
              </button>
              <button type="button" className="btn ghost small" onClick={exportSettings} title="Exportar as configurações (.json)">
                <Download size={14} /> Exportar
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
            </div>
          )}

          {loaded && (
            <>
              {/* ---------- Linha MIDI + medidor + volume master ---------- */}
              <div className="live-midi-row">
                {LIVE_MIDI_ROW.map((key) => {
                  const def = LIVE_PARAM_DEFS[key];
                  const value = params[key];
                  if (key === 'playMode') {
                    return (
                      <label key={key} className="live-midi-field">
                        <span>{def.label}</span>
                        <select
                          value={Math.round(value)}
                          onChange={(e) => updateParam(key, Number(e.target.value))}
                          title={def.label}
                        >
                          <option value={0}>Normal</option>
                          <option value={1}>Mono</option>
                        </select>
                      </label>
                    );
                  }
                  return (
                    <label key={key} className="live-midi-field">
                      <span>{def.label}</span>
                      <span className="live-midi-stepper">
                        <button type="button" onClick={() => updateParam(key, value - def.step)} title="Diminuir">−</button>
                        <b>{def.format(value)}</b>
                        <button type="button" onClick={() => updateParam(key, value + def.step)} title="Aumentar">+</button>
                      </span>
                    </label>
                  );
                })}
                <div className="live-midi-field live-meter-field">
                  <span>NÍVEL DE SAÍDA</span>
                  <div className="live-meter-seg" ref={meterRef}>
                    {Array.from({ length: 18 }, (_, i) => (
                      <span key={i} className="seg" />
                    ))}
                  </div>
                </div>
                <div className="live-midi-field live-master-field">
                  <span>VOLUME MASTER</span>
                  {renderKnob('volumeDb', 'sm')}
                </div>
              </div>

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

              {/* ---------- Linha principal de knobs (foto) ---------- */}
              <div className="live-knobs live-knobs-main">
                {renderKnob('volumeDb')}
                {renderKnob('pan')}
                {/* v0.2.26: seletor de modo de pan — BALANCE (padrão) | STEREO PAN */}
                <div className="live-panmode">
                  <span className="live-panmode-label">MODO DE PAN</span>
                  <div className="live-panmode-btns" role="group" aria-label="Modo de pan">
                    <button
                      type="button"
                      className={Math.round(params.panMode) === 0 ? 'active' : ''}
                      onClick={() => updateParam('panMode', 0)}
                      title="BALANCE: preserva a imagem estéreo (padrão)"
                    >
                      BALANCE
                    </button>
                    <button
                      type="button"
                      className={Math.round(params.panMode) === 1 ? 'active' : ''}
                      onClick={() => updateParam('panMode', 1)}
                      title="STEREO PAN: panorâmica estéreo real (desloca a imagem)"
                    >
                      STEREO PAN
                    </button>
                  </div>
                </div>
                {renderKnob('tuneCents')}
                {renderKnob('attackMs')}
                {renderKnob('releaseMs')}
                <div className="live-knob-group">
                  {renderPower('eq', 'EQ')}
                  {renderKnob('eqLowDb')}
                  {renderKnob('eqMidDb')}
                  {renderKnob('eqHighDb')}
                </div>
                <div className="live-knob-group">
                  {renderPower('drive', 'DRIVE')}
                  {renderKnob('driveDb')}
                </div>
                {renderKnob('sustain')}
                {renderVelocityCurve()}
              </div>

              {/* ---------- Abas de efeitos ---------- */}
              <div className="live-fx-tabs">
                <button type="button" className={fxTab === 'efeitos' ? 'active' : ''} onClick={() => setFxTab('efeitos')}>Efeitos / Ao Vivo</button>
                <button type="button" className={fxTab === 'ferramentas' ? 'active' : ''} onClick={() => setFxTab('ferramentas')}>Ferramentas</button>
                <button type="button" className={fxTab === 'novidades' ? 'active' : ''} onClick={() => setFxTab('novidades')}>Novidades</button>
                <span className="live-fx-scope">INSTRUMENTO INTEIRO</span>
              </div>

              {/* ---------- Módulos de efeito ---------- */}
              <div className="live-fx-modules">
                {FX_MODULES[fxTab].map((config) => (
                  <EffectModule
                    key={config.effect.id}
                    config={config}
                    params={params}
                    bypassed={bypass[config.effect.id]}
                    onParam={updateParam}
                    onToggleBypass={() => toggleBypass(config.effect.id)}
                  />
                ))}
                {fxTab === 'novidades' && (
                  <div className="fx-module">
                    <div className="fx-module-head"><span className="fx-module-name">PRESSÃO</span></div>
                    <div className="fx-module-body">
                      {renderKnob('pressure', 'lg')}
                    </div>
                    <p className="fx-module-note">Macro de palco: drive + presença + cola + largura + reverb.</p>
                  </div>
                )}
              </div>

              {/* ---------- Teclado ---------- */}
              <div className="live-keyboard">
                <div className="live-kb-row">
                  <div className="live-kb-octave">
                    <span className="live-kb-label">Oitava</span>
                    <div className="live-kb-octave-ctrl">
                      <button type="button" onClick={() => updateParam('octave', params.octave - 1)} title="Oitava abaixo">‹</button>
                      <b>{params.octave > 0 ? `+${params.octave}` : params.octave}</b>
                      <button type="button" onClick={() => updateParam('octave', params.octave + 1)} title="Oitava acima">›</button>
                    </div>
                  </div>
                  <div className="live-kb-keys">
                    <PlayableKeyboard
                      lowestNote={kbRange.lowest}
                      highestNote={kbRange.highest}
                      activeNotes={activeNotes}
                      onNoteOn={(note) => noteOn(note)}
                      onNoteOff={(note) => noteOff(note)}
                    />
                  </div>
                  <div className="live-kb-velocity">
                    <span className="live-kb-label">Velocity</span>
                    <div className="live-kb-vel-bar"><span style={{ width: `${(lastVelocity / 127) * 100}%` }} /></div>
                    <b>{lastVelocity || '—'}</b>
                  </div>
                </div>
                <p className="live-hint">
                  Toque no teclado da tela, use as teclas do computador (a tecla <b>A</b> toca a tecla raiz) ou
                  conecte o teclado USB MIDI. Os ajustes ficam salvos automaticamente pra este instrumento.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------- Barra de status ---------- */}
      <div className="live-statusbar">
        <span className="live-statusbar-item">
          <Usb size={13} /> Dispositivo MIDI: {midiConnected ? midiDevices[0] ?? 'conectado' : 'nenhum (use Conectar MIDI)'}
        </span>
        <span className="live-statusbar-item">Driver: Web Audio (Baixa Latência)</span>
        <span className="live-statusbar-item ok"><CheckCircle2 size={13} /> Sistema Pronto</span>
        <span className="live-statusbar-brand">MRQ — Tecnologia que Inspira sua Música</span>
      </div>
    </div>
  );
}
