/**
 * Auto Sampler — tela que toca automaticamente as notas de um instrumento
 * externo (Kontakt standalone, ou qualquer fonte MIDI+áudio) e grava o
 * resultado pra montar um instrumento multisample (.mrq e/ou .sf2), no
 * mesmo espírito do "Auto Sampler" do Logic Pro.
 *
 * Fluxo em 4 passos (inspirado no "Project Wizard" do SampleRobot):
 *  1. Conexão — MIDI + áudio + teste de nível (checklist de setup).
 *  2. Teclado — presets rápidos + teclado visual com status por nota.
 *  3. Som — velocity, round robin, sustain/release, loop.
 *  4. Captura — saída, progresso ao vivo, resultado por nota e recaptura
 *     só das notas que ficaram ruins (sem regravar tudo).
 *
 * O teclado mostra o estado de cada nota (fora da faixa / na faixa /
 * gravada OK / silenciosa). A barra de status no topo (passos + nota atual
 * + VU L/R) fica sempre visível.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Check, Circle, Loader2, Music, Play, RotateCcw, Square, X } from 'lucide-react';
import { basenameOf } from '../audio/rack/converterFormats';
import { midiNoteLabel } from '../audio/rack/midiNoteNames';
import type { MrqCompatibilityReport, MrqFileMetadata, MrqFinishResult, MrqInstrumentModel } from '../audio/rack/mrqFormat';
import {
  computeVelocityBreakpoints,
  estimateAutoSamplerPlan,
  generateAutoSamplerTasks,
  type AutoSamplerConfig,
  type AutoLoopMode,
  type VelocityResponseCurve,
} from '../audio/rack/autoSamplerEngine';
import {
  AutoSamplerCancelledError,
  AutoSamplerSession,
  isNativeLoopbackDeviceId,
  isNativeLoopbackSupported,
  listAudioInputDevices,
  listMidiOutputs,
  listNativeLoopbackDevices,
  NATIVE_LOOPBACK_DEFAULT_ID,
  openWindowsSoundSettings,
  previewMidiNote,
  requestAudioInputPermission,
  SYSTEM_DEFAULT_AUDIO_INPUT_ID,
  type AudioInputDeviceInfo,
  type AutoSamplerCaptureOutcome,
  type AutoSamplerProgress,
  type AutoSamplerRunResult,
  type MidiPortInfo,
} from '../audio/rack/autoSampler';
import { useInputLevelMeter } from '../audio/rack/useInputLevelMeter';
import { useStore } from '../state/useStore';
import SampleNoteRangeKeyboard from './SampleNoteRangeKeyboard';
import VelocityBreakpointEditor from './VelocityBreakpointEditor';
import LevelMeterBar from './LevelMeterBar';

export interface AutoSamplerResult {
  fileName: string;
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  convertedPath: string;
  convertedFinish: MrqFinishResult;
  convertedMetadata: MrqFileMetadata;
  /** Preenchido só quando o usuário também marcou "gerar .sf2/.sf3" — este
   *  arquivo NÃO entra na fila de pré-visualização do conversor (que só
   *  entende `.mrq`), só é reportado pro usuário por toast/caminho. */
  sf2Path?: string;
}

interface Props {
  onClose: () => void;
  onImported: (result: AutoSamplerResult) => void;
}

const VELOCITY_RESPONSE_OPTIONS: { value: VelocityResponseCurve; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'exp1', label: 'Exponencial 1' },
  { value: 'exp2', label: 'Exponencial 2' },
  { value: 'exp3', label: 'Exponencial 3' },
  { value: 'log1', label: 'Logarítmica 1' },
  { value: 'log2', label: 'Logarítmica 2' },
  { value: 'log3', label: 'Logarítmica 3' },
  { value: 'custom', label: 'Custom (arrastar pontos)' },
];

/** Lista completa do Auto Loop do Logic Pro (ver SoundOnSound). "Penrose
 *  Machine" fica DESABILITADA de propósito — algoritmo proprietário da
 *  Apple/Redmatica, nunca documentado publicamente. */
const AUTO_LOOP_OPTIONS: { value: AutoLoopMode | 'penrose'; label: string; disabled?: boolean; title?: string; hint?: string }[] = [
  { value: 'none', label: 'Nenhum', hint: 'Sem loop — a amostra toca uma vez e para.' },
  { value: 'search', label: 'Search (corte seco no ponto mais parecido)', hint: 'Corte seco no ponto mais parecido encontrado — pode soar como um "pulso" se nenhum ponto perfeito existir.' },
  { value: 'search-xfade', label: 'Search With X-Fade', hint: 'Mesma busca do "Search", com crossfade equal-power gravado na emenda quando não há corte 100% limpo.' },
  { value: 'search-rev-xfade', label: 'Search With Rev X-Fade', hint: 'Crossfade com uma cópia invertida no tempo do próprio loop — preserva melhor o timbre de decay.' },
  { value: 'bidirectional', label: 'Bidirectional', hint: 'Alterna forward/reverso com emendas sempre no mesmo nível — geralmente o loop menos repetitivo (e mais longo).' },
  {
    value: 'penrose',
    label: 'Penrose Machine (indisponível)',
    disabled: true,
    title: 'Algoritmo de ressíntese proprietário da Apple/Redmatica, nunca documentado publicamente — não é possível reimplementá-lo de forma fiel, então não fingimos esse modo aqui.',
    hint: 'Algoritmo de ressíntese proprietário da Apple/Redmatica, nunca documentado publicamente — não é possível reimplementá-lo de forma fiel, então não fingimos esse modo aqui.',
  },
];

/** Presets rápidos (estilo "templates" do SampleRobot) — ajustam faixa, passo, velocity e tempos de uma vez. */
interface SamplerPreset {
  id: string;
  name: string;
  hint: string;
  config: Partial<AutoSamplerConfig>;
}

const SAMPLER_PRESETS: SamplerPreset[] = [
  {
    id: 'piano',
    name: 'Piano / Teclado',
    hint: 'C2–C6, a cada 2 semitons, 3 velocities, sustain longo',
    config: {
      rangeStartNote: 36, rangeEndNote: 84, sampleEverySemitones: 2,
      velocityLayers: 3, velocityResponse: 'linear', roundRobinCount: 1,
      sustainSeconds: 4, releaseTailSeconds: 1.5, oneShot: false, autoLoop: 'none',
    },
  },
  {
    id: 'pads',
    name: 'Pads / Sustained',
    hint: 'C3–C5, a cada 3 semitons, 2 velocities, loop automático',
    config: {
      rangeStartNote: 48, rangeEndNote: 72, sampleEverySemitones: 3,
      velocityLayers: 2, velocityResponse: 'linear', roundRobinCount: 1,
      sustainSeconds: 6, releaseTailSeconds: 2, oneShot: false,
      autoLoop: 'search-xfade', autoLoopStartPct: 20, autoLoopEndPct: 80,
    },
  },
  {
    id: 'percussion',
    name: 'Percussão / One-shot',
    hint: 'C2–C4, cromático, 4 velocities, corta no silêncio',
    config: {
      rangeStartNote: 36, rangeEndNote: 60, sampleEverySemitones: 1,
      velocityLayers: 4, velocityResponse: 'linear', roundRobinCount: 2,
      sustainSeconds: 2, releaseTailSeconds: 0.5, oneShot: true, autoLoop: 'none',
    },
  },
  {
    id: 'chromatic',
    name: 'Cromático rápido',
    hint: 'C3–C5, toda tecla, 1 velocity, tempos curtos',
    config: {
      rangeStartNote: 48, rangeEndNote: 72, sampleEverySemitones: 1,
      velocityLayers: 1, velocityResponse: 'linear', roundRobinCount: 1,
      sustainSeconds: 1.5, releaseTailSeconds: 0.5, oneShot: false, autoLoop: 'none',
    },
  },
];

type StepId = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<StepId, string> = {
  1: 'Conexão',
  2: 'Teclado',
  3: 'Som',
  4: 'Captura',
};

function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}min${rem > 0 ? ` ${rem}s` : ''}`;
}

function formatDbfs(peak: number): string {
  if (peak <= 0) return '−∞ dB';
  const db = 20 * Math.log10(peak);
  return `${db.toFixed(1)} dB`;
}

export default function AutoSamplerDialog({ onClose, onImported }: Props) {
  const pushToast = useStore((s) => s.pushToast);
  const [step, setStep] = useState<StepId>(1);

  // --- configuração da captura ---
  const [instrumentName, setInstrumentName] = useState('Instrumento Auto Sampler');
  const [rangeStartNote, setRangeStartNote] = useState(48); // C3
  const [rangeEndNote, setRangeEndNote] = useState(72); // C5
  const [sampleEverySemitones, setSampleEverySemitones] = useState(3);
  const [roundRobinCount, setRoundRobinCount] = useState(1);
  const [sustainSeconds, setSustainSeconds] = useState(2);
  const [releaseTailSeconds, setReleaseTailSeconds] = useState(1);
  const [velocityLayers, setVelocityLayers] = useState(1);
  const [velocityResponse, setVelocityResponse] = useState<VelocityResponseCurve>('linear');
  const [customVelocityBreakpoints, setCustomVelocityBreakpoints] = useState<number[] | undefined>(undefined);
  const [autoLoop, setAutoLoop] = useState<AutoLoopMode>('none');
  const [autoLoopStartPct, setAutoLoopStartPct] = useState(40);
  const [autoLoopEndPct, setAutoLoopEndPct] = useState(90);
  const [oneShot, setOneShot] = useState(false);
  const [inputGainDb, setInputGainDb] = useState(0);

  // --- dispositivos (MIDI + áudio) ---
  const [midiOutputs, setMidiOutputs] = useState<MidiPortInfo[]>([]);
  const [midiOutputId, setMidiOutputId] = useState<string>('');
  const [midiChannel, setMidiChannel] = useState(1); // 1-16, exibido pro usuário; convertido pra 0-based só na hora de enviar.
  const [audioInputs, setAudioInputs] = useState<AudioInputDeviceInfo[]>([]);
  /** Só vira `true` no Windows (ver `isNativeLoopbackSupported`/loopback_audio.rs) — controla se os dispositivos de loopback nativo entram na lista, como alternativa ao cabo de áudio virtual. */
  const [nativeLoopbackSupported, setNativeLoopbackSupported] = useState(false);
  const [audioInputDeviceId, setAudioInputDeviceId] = useState<string>(SYSTEM_DEFAULT_AUDIO_INPUT_ID);

  // MIDI e áudio são carregados/tratados INDEPENDENTEMENTE — uma falha num
  // não pode esconder nem bloquear o outro.
  const [midiLoading, setMidiLoading] = useState(true);
  const [midiError, setMidiError] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [midiTested, setMidiTested] = useState(false);
  const [audioTested, setAudioTested] = useState(false);

  // --- saída ---
  const [outputMrq, setOutputMrq] = useState(true);
  const [outputSf2, setOutputSf2] = useState(true);

  // --- execução ---
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AutoSamplerProgress | null>(null);
  const [result, setResult] = useState<AutoSamplerRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<AutoSamplerCaptureOutcome[]>([]);
  const sessionRef = useRef<AutoSamplerSession | null>(null);

  async function loadMidiOutputs() {
    setMidiLoading(true);
    setMidiError(null);
    try {
      const outs = await listMidiOutputs();
      setMidiOutputs(outs);
      setMidiOutputId((prev) => (outs.some((o) => o.id === prev) ? prev : outs[0]?.id ?? ''));
      if (outs.length === 0) {
        setMidiError(
          'Nenhuma porta MIDI de saída encontrada. Crie/ative uma porta MIDI virtual roteada até o Kontakt (IAC Driver no macOS, loopMIDI no Windows, aconnect/a2jmidid no Linux — ver docs/mrq-instrument-converter/mrq-auto-sampler.md) e clique em "Atualizar portas MIDI".'
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMidiError(`Não foi possível listar as portas MIDI: ${message}`);
    } finally {
      setMidiLoading(false);
    }
  }

  /** Pede a permissão de áudio (gesto explícito do usuário — nunca só
   *  automático ao abrir o modal), porque no WebView2 do Windows um pedido
   *  de getUserMedia automático pode ser descartado sem nem mostrar o prompt. */
  async function loadAudioInputs() {
    setAudioLoading(true);
    setAudioError(null);
    // Loopback nativo e getUserMedia são buscados INDEPENDENTEMENTE — o
    // nativo não precisa de nenhuma permissão de SO.
    const combined: AudioInputDeviceInfo[] = [];
    if (nativeLoopbackSupported) {
      try {
        combined.push(...(await listNativeLoopbackDevices()));
      } catch {
        /* lista nativa é só um complemento — uma falha aqui não deveria impedir o getUserMedia normal. */
      }
    }
    try {
      await requestAudioInputPermission();
      const ins = await listAudioInputDevices();
      combined.push(...ins);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (combined.length === 0) {
        setAudioError(
          `Permissão de microfone/entrada de áudio negada ou descartada pelo sistema (${message}). No Windows: abra Configurações > Privacidade e segurança > Microfone e confira se "Acesso ao microfone" e "Permitir que aplicativos de área de trabalho acessem seu microfone" estão LIGADOS — sem isso, o WebView nem chega a mostrar o pedido de permissão, ele já volta negado. No macOS/Linux, confira as permissões de microfone do sistema para este app. Depois, clique em "Tentar de novo".`
        );
      }
    }
    setAudioInputs(combined);
    setAudioLoading(false);
  }

  useEffect(() => {
    void loadMidiOutputs();
    // No Windows, carrega IMEDIATAMENTE os dispositivos de saída via loopback
    // nativo (WASAPI) ao abrir o modal — eles não precisam de permissão de
    // microfone do navegador e já gravam direto a saída de som do sistema
    // onde o Kontakt está tocando.
    void (async () => {
      const supported = await isNativeLoopbackSupported();
      setNativeLoopbackSupported(supported);
      if (supported) {
        try {
          const nativeDevs = await listNativeLoopbackDevices();
          setAudioInputs((prev) => {
            const nonNative = prev.filter((d) => !isNativeLoopbackDeviceId(d.id));
            return [...nativeDevs, ...nonNative];
          });
          setAudioInputDeviceId((prev) =>
            prev === SYSTEM_DEFAULT_AUDIO_INPUT_ID ? NATIVE_LOOPBACK_DEFAULT_ID : prev
          );
        } catch {
          /* se falhar, o botão manual continua disponível abaixo */
        }
      }
      setAudioLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Muda o número de camadas invalida qualquer breakpoint customizado
  // anterior (o motor exige exatamente layers+1 pontos) — melhor recomeçar
  // do zero numa curva padrão do que arriscar mandar um array com o
  // tamanho errado pro motor.
  useEffect(() => {
    setCustomVelocityBreakpoints(undefined);
    setVelocityResponse((prev) => (prev === 'custom' ? 'linear' : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [velocityLayers]);

  const velocityBreakpoints = useMemo(() => {
    try {
      return computeVelocityBreakpoints(velocityLayers, velocityResponse, customVelocityBreakpoints);
    } catch {
      return computeVelocityBreakpoints(velocityLayers, 'linear');
    }
  }, [velocityLayers, velocityResponse, customVelocityBreakpoints]);

  function handleDragVelocityBreakpoints(next: number[]) {
    setVelocityResponse('custom');
    setCustomVelocityBreakpoints(next);
  }

  function handlePreviewNote(note: number) {
    if (!midiOutputId) return;
    void previewMidiNote(midiOutputId, midiChannel - 1, note);
  }

  const handleTestMidi = useCallback(() => {
    if (!midiOutputId) return;
    // Toca C4 (60) pra confirmar que o Kontakt responde — o usuário ouve o som.
    void previewMidiNote(midiOutputId, midiChannel - 1, 60, 100, 600);
    setMidiTested(true);
  }, [midiOutputId, midiChannel]);

  // O medidor VU L/R ao vivo funciona tanto para entradas getUserMedia quanto
  // para o loopback nativo — nunca some da tela. No loopback nativo ele
  // compartilha a mesma sessão Rust e continua medindo inclusive durante a
  // captura (`running === true`).
  const usingNativeLoopbackUi = isNativeLoopbackDeviceId(audioInputDeviceId);
  const levelMeterEnabled = audioInputDeviceId !== '' && (usingNativeLoopbackUi || !running);
  const { levels: meterLevels, error: meterError, retryNow: retryMeter } = useInputLevelMeter(
    audioInputDeviceId,
    levelMeterEnabled,
    inputGainDb
  );

  const loadingDevices = midiLoading || audioLoading;
  const hasMicDevicesListed = audioInputs.some((d) => !isNativeLoopbackDeviceId(d.id));
  const audioPermissionRequested = audioInputs.length > 0 || audioError !== null;

  const config: AutoSamplerConfig = useMemo(
    () => ({
      rangeStartNote,
      rangeEndNote,
      sampleEverySemitones,
      velocityLayers,
      velocityResponse,
      customVelocityBreakpoints: velocityResponse === 'custom' ? customVelocityBreakpoints : undefined,
      roundRobinCount,
      sustainSeconds,
      releaseTailSeconds,
      autoLoop,
      autoLoopStartPct,
      autoLoopEndPct,
      oneShot,
    }),
    [
      rangeStartNote, rangeEndNote, sampleEverySemitones, velocityLayers, velocityResponse,
      customVelocityBreakpoints, roundRobinCount, sustainSeconds, releaseTailSeconds,
      autoLoop, autoLoopStartPct, autoLoopEndPct, oneShot,
    ]
  );

  const estimate = useMemo(() => {
    try {
      return estimateAutoSamplerPlan(config);
    } catch {
      return null;
    }
  }, [config]);

  function validateBeforeStart(): string | null {
    if (rangeEndNote < rangeStartNote) return 'Range End precisa ser >= Range Start.';
    if (!midiOutputId) return 'Escolha uma porta MIDI de saída (roteada até a entrada MIDI do Kontakt).';
    if (!audioPermissionRequested) {
      return 'Clique em "Conceder permissão de áudio" antes de começar (necessário mesmo escolhendo "Padrão do sistema").';
    }
    if (!audioInputDeviceId) return 'Escolha um dispositivo de entrada de áudio (roteado da saída do Kontakt, via loopback).';
    if (!outputMrq && !outputSf2) return 'Escolha pelo menos um formato de saída (.mrq e/ou .sf2).';
    if (autoLoop !== 'none' && (autoLoopStartPct < 0 || autoLoopStartPct >= autoLoopEndPct || autoLoopEndPct > 100)) {
      return 'Auto Loop Start/End precisam satisfazer 0 <= início < fim <= 100.';
    }
    if (velocityResponse === 'custom' && (!customVelocityBreakpoints || customVelocityBreakpoints.length !== velocityLayers + 1)) {
      return 'Arraste os pontos de quebra de Velocity Response (Custom) antes de começar — faltam pontos definidos.';
    }
    return null;
  }

  const applyPreset = useCallback((preset: SamplerPreset) => {
    const c = preset.config;
    if (c.rangeStartNote !== undefined) setRangeStartNote(c.rangeStartNote);
    if (c.rangeEndNote !== undefined) setRangeEndNote(c.rangeEndNote);
    if (c.sampleEverySemitones !== undefined) setSampleEverySemitones(c.sampleEverySemitones);
    if (c.velocityLayers !== undefined) setVelocityLayers(c.velocityLayers);
    if (c.velocityResponse !== undefined) setVelocityResponse(c.velocityResponse);
    if (c.roundRobinCount !== undefined) setRoundRobinCount(c.roundRobinCount);
    if (c.sustainSeconds !== undefined) setSustainSeconds(c.sustainSeconds);
    if (c.releaseTailSeconds !== undefined) setReleaseTailSeconds(c.releaseTailSeconds);
    if (c.oneShot !== undefined) setOneShot(c.oneShot);
    if (c.autoLoop !== undefined) setAutoLoop(c.autoLoop);
    if (c.autoLoopStartPct !== undefined) setAutoLoopStartPct(c.autoLoopStartPct);
    if (c.autoLoopEndPct !== undefined) setAutoLoopEndPct(c.autoLoopEndPct);
    setCustomVelocityBreakpoints(undefined);
  }, []);

  async function handleSample(onlyTaskIds?: Set<string>) {
    setError(null);
    const validationError = validateBeforeStart();
    if (validationError) {
      setError(validationError);
      return;
    }

    const suggestedName = (instrumentName.trim() || 'Instrumento Auto Sampler').replace(/[\\/:*?"<>|]/g, '_');
    let mrqPath: string | null = null;
    let sf2Path: string | null = null;
    try {
      if (outputMrq) {
        mrqPath = await saveDialog({ title: 'Salvar instrumento .mrq', defaultPath: `${suggestedName}.mrq`, filters: [{ name: 'MRQ Instrument (.mrq)', extensions: ['mrq'] }] });
        if (!mrqPath) return;
      }
      if (outputSf2) {
        sf2Path = await saveDialog({ title: 'Salvar SoundFont .sf2', defaultPath: `${suggestedName}.sf2`, filters: [{ name: 'SoundFont 2 (.sf2)', extensions: ['sf2'] }] });
        if (!sf2Path) return;
      }
    } catch {
      pushToast('Não foi possível abrir o seletor de destino.', 'error');
      return;
    }

    const session = new AutoSamplerSession();
    sessionRef.current = session;
    setRunning(true);
    setProgress(null);
    setResult(null);
    if (!onlyTaskIds) setOutcomes([]);
    try {
      const result = await session.run(
        {
          config,
          instrumentName: instrumentName.trim() || 'Instrumento Auto Sampler',
          midiOutputId,
          midiChannel: midiChannel - 1,
          audioInputDeviceId,
          inputGainDb,
          outputs: {
            mrq: mrqPath ? { destPath: mrqPath } : undefined,
            sf2: sf2Path ? { destPath: sf2Path } : undefined,
          },
          onlyTaskIds,
        },
        (p) => {
          setProgress(p);
          if (p.lastOutcome) {
            setOutcomes((prev) => [...prev.filter((o) => o.taskId !== p.lastOutcome!.taskId), p.lastOutcome!]);
          }
        }
      );
      setResult(result);
      // Na recaptura parcial, mescla os novos resultados com os anteriores
      // (as notas OK continuam OK no teclado/lista) em vez de substituí-los.
      if (onlyTaskIds) {
        setOutcomes((prev) => [...prev.filter((o) => !onlyTaskIds.has(o.taskId)), ...result.outcomes]);
      } else {
        setOutcomes(result.outcomes);
      }

      pushToast(`Auto Sampler concluído: ${result.capturedCount} amostra(s) capturada(s).`);
      if (result.silentCaptureCount > 0) {
        const todasSilenciosas = result.silentCaptureCount === result.capturedCount;
        pushToast(
          todasSilenciosas
            ? `Atenção: as ${result.capturedCount} capturas vieram em SILÊNCIO (nenhum sinal de áudio acima do ruído de piso). O Kontakt provavelmente não recebeu as notas MIDI (confira a porta/canal MIDI e se o Kontakt está escutando essa porta) OU a entrada de áudio escolhida não está roteada de verdade pra saída do Kontakt (confira o driver de loopback). O arquivo gerado existe, mas só tem zonas mudas.`
            : `Atenção: ${result.silentCaptureCount} de ${result.capturedCount} capturas vieram em silêncio — confira se o Kontakt respondeu a essas notas específicas e se a rota de áudio (loopback) ficou estável durante toda a gravação.`,
          'error'
        );
      }
      if (result.sf2Path && roundRobinCount > 1) {
        pushToast(
          'Aviso: o formato SF2 não tem alternância de round robin nativa — as variações geradas vão tocar todas sobrepostas ao mesmo tempo na maioria dos sintetizadores SF2 (o .mrq, se gerado, alterna normalmente no Rack).',
          'error'
        );
      }
      if (result.mrq) {
        onImported({
          fileName: basenameOf(result.mrq.finish.path),
          instrument: result.mrq.instrument,
          compatibility: result.mrq.compatibility,
          convertedPath: result.mrq.finish.path,
          convertedFinish: result.mrq.finish,
          convertedMetadata: result.mrq.metadata,
          sf2Path: result.sf2Path,
        });
      } else if (result.sf2Path) {
        pushToast(`SoundFont gerado: ${basenameOf(result.sf2Path)}`);
        onClose();
      }
    } catch (err) {
      if (err instanceof AutoSamplerCancelledError) {
        pushToast('Auto Sampler cancelado.');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        pushToast(`Falha no Auto Sampler: ${message}`, 'error');
      }
    } finally {
      setRunning(false);
      setProgress(null);
      sessionRef.current = null;
    }
  }

  function handleCancel() {
    sessionRef.current?.cancel();
  }

  function handleClose() {
    if (running) {
      sessionRef.current?.cancel();
      return;
    }
    onClose();
  }

  // --- status por nota (pro teclado colorir) ---
  const noteStatus = useMemo(() => {
    const map = new Map<number, 'ok' | 'silent'>();
    for (const o of outcomes) {
      // Se qualquer captura da nota foi silenciosa, a nota fica "ruim" — a
      // menos que uma captura posterior da mesma nota tenha sido OK.
      const prev = map.get(o.note);
      if (o.silent) map.set(o.note, 'silent');
      else if (prev !== 'silent') map.set(o.note, 'ok');
    }
    return map;
  }, [outcomes]);

  const badNotes = useMemo(() => {
    const bad = new Set<number>();
    for (const [note, status] of noteStatus) if (status === 'silent') bad.add(note);
    return [...bad].sort((a, b) => a - b);
  }, [noteStatus]);

  function handleRecaptureBad() {
    if (badNotes.length === 0) return;
    const badSet = new Set(badNotes);
    const ids = new Set(generateAutoSamplerTasks(config).filter((t) => badSet.has(t.note)).map((t) => t.id));
    void handleSample(ids);
  }

  const currentNoteName = progress?.currentTask ? midiNoteLabel(progress.currentTask.note) : null;
  const progressPct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // --- checklist de setup (passo 1) ---
  const checklist = [
    { label: 'Porta MIDI escolhida', done: Boolean(midiOutputId), hint: midiOutputs.find((m) => m.id === midiOutputId)?.name },
    { label: 'Entrada de áudio escolhida', done: Boolean(audioInputDeviceId), hint: audioInputDeviceId === SYSTEM_DEFAULT_AUDIO_INPUT_ID ? 'Padrão do sistema' : audioInputs.find((d) => d.id === audioInputDeviceId)?.label },
    { label: 'Nível de entrada visível', done: !meterError && audioInputDeviceId !== '', hint: meterError ? 'erro no medidor' : 'VU L/R ao vivo' },
  ];
  const setupReady = checklist.every((c) => c.done) && !loadingDevices;

  const phaseLabel: Record<AutoSamplerProgress['phase'], string> = {
    capturing: 'Gravando notas…',
    'building-mrq': 'Montando .mrq…',
    'building-sf2': 'Montando .sf2…',
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal as-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860, width: 'min(860px, 94vw)' }}>
        <div className="modal-header">
          <h3>
            <Music size={16} /> Auto Sampler
          </h3>
          <button className="btn-icon" onClick={handleClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </div>

        {/* Barra de status sempre visível: passos + nota atual + VU L/R */}
        <div className="as-statusbar">
          <div className="as-steps">
            {([1, 2, 3, 4] as StepId[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`as-step${s === step ? ' active' : ''}${s < step ? ' done' : ''}`}
                onClick={() => !running && setStep(s)}
                disabled={running}
              >
                <span className="as-step-num">{s < step ? <Check size={12} /> : s}</span>
                {STEP_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="as-statusbar-right">
            {running && currentNoteName && (
              <span className="as-current-note">
                <Loader2 size={13} className="mrq-spin" /> {currentNoteName}
              </span>
            )}
            <div className="as-level-meters" style={{ margin: 0, minWidth: 180 }}>
              <LevelMeterBar label="L" db={meterLevels.l} />
              <LevelMeterBar label="R" db={meterLevels.r} />
            </div>
          </div>
        </div>

        {running && progress && (
          <div className="as-progress">
            <div className="as-progress-track">
              <div className="as-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="as-progress-label">
              {phaseLabel[progress.phase]} {progress.done}/{progress.total} ({progressPct}%)
            </span>
          </div>
        )}

        <div className="modal-body">
          {step === 1 && (
            <div className="as-step-panel">
              <p className="as-step-intro">
                Conecte o instrumento: o Auto Sampler manda notas MIDI pra ele e grava o áudio que volta.
                No Windows, o <strong>loopback nativo</strong> captura a saída do sistema sem cabo virtual.
              </p>

              <div className="as-checklist">
                {checklist.map((c) => (
                  <div key={c.label} className={`as-check-item${c.done ? ' done' : ''}`}>
                    {c.done ? <Check size={14} /> : <Circle size={14} />}
                    <span>{c.label}</span>
                    {c.hint && <span className="as-check-hint">{c.hint}</span>}
                  </div>
                ))}
              </div>

              <div className="as-grid">
                <section className="as-section">
                  <h4>MIDI — saída pro instrumento</h4>
                  <div className="field-row">
                    <div className="label">Porta MIDI</div>
                    <select value={midiOutputId} onChange={(e) => { setMidiOutputId(e.target.value); setMidiTested(false); }} disabled={running || midiLoading}>
                      {midiOutputs.length === 0 && <option value="">Nenhuma porta encontrada</option>}
                      {midiOutputs.map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field-row">
                    <div className="label">Canal MIDI</div>
                    <select value={midiChannel} onChange={(e) => setMidiChannel(Number(e.target.value))} disabled={running}>
                      {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => (
                        <option key={c} value={c}>Canal {c}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field-row">
                    <button type="button" className="btn btn-secondary" onClick={handleTestMidi} disabled={!midiOutputId || running}>
                      <Play size={13} /> Testar MIDI (toca C4)
                    </button>
                    {midiTested && <span className="as-test-ok">Ouviu o C4 no instrumento? Então o MIDI está OK.</span>}
                  </div>
                  {midiError && (
                    <div className="as-device-error">
                      <AlertTriangle size={13} />
                      <div>{midiError}</div>
                    </div>
                  )}
                  <button type="button" className="btn ghost small" onClick={() => void loadMidiOutputs()} disabled={running || midiLoading} style={{ marginTop: 6 }}>
                    {midiLoading ? <Loader2 size={12} className="mrq-spin" /> : null} Atualizar portas MIDI
                  </button>
                </section>

                <section className="as-section">
                  <h4>Áudio — entrada (o que o instrumento toca)</h4>
                  {!hasMicDevicesListed && !audioLoading && (
                    <div className="hint" style={{ marginBottom: 6 }}>
                      {nativeLoopbackSupported
                        ? 'As opções "(loopback nativo)" já estão prontas abaixo e gravam direto da saída de som do sistema onde o Kontakt está tocando (não usam microfone nem precisam de VB-Cable). Se quiser listar também entradas de microfone/cabo virtual, clique no botão abaixo.'
                        : 'Clique abaixo pra pedir permissão de entrada de áudio ao sistema e listar os dispositivos disponíveis.'}
                    </div>
                  )}
                  <div className="field-row">
                    <div className="label">Dispositivo</div>
                    <select value={audioInputDeviceId} onChange={(e) => { setAudioInputDeviceId(e.target.value); setAudioTested(false); }} disabled={running || audioLoading}>
                      {audioInputs.some((d) => isNativeLoopbackDeviceId(d.id)) && (
                        <optgroup label="Saída de som do sistema — Loopback nativo (grava o que sai no PC)">
                          {audioInputs.filter((d) => isNativeLoopbackDeviceId(d.id)).map((d) => (
                            <option key={d.id} value={d.id}>{d.label}</option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Entradas de microfone / cabo virtual (getUserMedia)">
                        <option value={SYSTEM_DEFAULT_AUDIO_INPUT_ID}>Microfone / Entrada padrão do sistema</option>
                        {audioInputs.filter((d) => !isNativeLoopbackDeviceId(d.id)).map((d) => (
                          <option key={d.id} value={d.id}>{d.label}</option>
                        ))}
                      </optgroup>
                    </select>
                  </div>
                  <div className="field-row">
                    <div className="label">Input Gain</div>
                    <input type="range" min={-24} max={24} step={0.5} value={inputGainDb} disabled={running} onChange={(e) => setInputGainDb(Number(e.target.value))} />
                    <div className="hint" style={{ minWidth: 48, textAlign: 'right' }}>{inputGainDb > 0 ? '+' : ''}{inputGainDb.toFixed(1)}dB</div>
                  </div>
                  <div className="field-row">
                    <button type="button" className="btn btn-secondary" onClick={() => setAudioTested(true)} disabled={running}>
                      <Play size={13} /> Testar áudio
                    </button>
                    {audioTested && <span className="as-test-ok">Toque uma nota no instrumento e veja o VU L/R mexer acima.</span>}
                  </div>
                  {meterError && (
                    <div className="as-device-error" style={{ marginTop: 6 }}>
                      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                      <div>
                        <div>{meterError}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          <button type="button" className="btn ghost small" onClick={retryMeter}>
                            Testar novamente agora
                          </button>
                          {nativeLoopbackSupported && (
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={() => {
                                void openWindowsSoundSettings().catch(() => {});
                              }}
                            >
                              Abrir Painel de Som do Windows (mmsys.cpl)
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {audioError && (
                    <div className="as-device-error">
                      <AlertTriangle size={13} />
                      <div>{audioError}</div>
                    </div>
                  )}
                  <button type="button" className={`btn ${hasMicDevicesListed || nativeLoopbackSupported ? 'ghost' : 'primary'} small`} onClick={() => void loadAudioInputs()} disabled={running || audioLoading} style={{ marginTop: 6 }}>
                    {audioLoading ? <Loader2 size={12} className="mrq-spin" /> : null}{' '}
                    {!hasMicDevicesListed
                      ? nativeLoopbackSupported
                        ? 'Listar também microfones / cabos virtuais (VB-Cable)'
                        : 'Conceder permissão de áudio'
                      : audioError
                        ? 'Tentar de novo'
                        : 'Atualizar dispositivos de áudio'}
                  </button>
                </section>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="as-step-panel">
              <p className="as-step-intro">
                Escolha um preset ou ajuste a faixa de notas. Arraste as alças do teclado pra mudar a faixa;
                clique numa tecla pra pré-ouvir. As teclas mudam de cor conforme o estado de cada nota.
              </p>

              <div className="as-presets">
                {SAMPLER_PRESETS.map((p) => (
                  <button key={p.id} type="button" className="as-preset" onClick={() => applyPreset(p)} disabled={running}>
                    <strong>{p.name}</strong>
                    <span>{p.hint}</span>
                  </button>
                ))}
              </div>

              <SampleNoteRangeKeyboard
                rangeStartNote={rangeStartNote}
                rangeEndNote={rangeEndNote}
                sampleEverySemitones={sampleEverySemitones}
                onChangeRange={(s, e) => {
                  setRangeStartNote(s);
                  setRangeEndNote(e);
                }}
                onPreviewNote={handlePreviewNote}
                noteStatus={noteStatus}
                disabled={running}
              />

              <div className="as-grid">
                <section className="as-section">
                  <h4>Faixa de notas</h4>
                  <div className="field-row">
                    <div className="label">Range Start</div>
                    <input type="number" min={0} max={127} value={rangeStartNote} onChange={(e) => setRangeStartNote(Number(e.target.value))} disabled={running} />
                    <span className="as-note-name">{midiNoteLabel(rangeStartNote)}</span>
                  </div>
                  <div className="field-row">
                    <div className="label">Range End</div>
                    <input type="number" min={0} max={127} value={rangeEndNote} onChange={(e) => setRangeEndNote(Number(e.target.value))} disabled={running} />
                    <span className="as-note-name">{midiNoteLabel(rangeEndNote)}</span>
                  </div>
                  <div className="field-row">
                    <div className="label">Sample Every (semitons)</div>
                    <input type="number" min={1} max={24} value={sampleEverySemitones} onChange={(e) => setSampleEverySemitones(Number(e.target.value))} disabled={running} />
                  </div>
                </section>

                <section className="as-section">
                  <h4>Estimativa</h4>
                  {estimate ? (
                    <div className="as-estimate">
                      <div><span>Notas amostradas</span><strong>{estimate.sampledNoteCount}</strong></div>
                      <div><span>Capturas totais</span><strong>{estimate.totalCaptures}</strong></div>
                      <div><span>Tempo estimado</span><strong>{formatDuration(estimate.estimatedTotalSeconds)}</strong></div>
                      <div><span>Tamanho aprox.</span><strong>~{Math.round((estimate.totalCaptures * (sustainSeconds + releaseTailSeconds) * 44100 * 2 * 4) / 1024 / 1024)} MB</strong></div>
                    </div>
                  ) : (
                    <p className="as-hint">Configuração inválida — confira faixa e passo.</p>
                  )}
                </section>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="as-step-panel">
              <p className="as-step-intro">
                Como cada nota é tocada: quantas camadas de velocity, quantas variações (round robin),
                quanto tempo segura e se o loop é automático.
              </p>

              <div className="as-grid">
                <section className="as-section">
                  <h4>Velocity</h4>
                  <div className="field-row">
                    <div className="label">Velocity Layers</div>
                    <input type="number" min={1} max={16} value={velocityLayers} onChange={(e) => setVelocityLayers(Number(e.target.value))} disabled={running} />
                  </div>
                  <div className="field-row">
                    <div className="label">Velocity Response</div>
                    <select value={velocityResponse} onChange={(e) => setVelocityResponse(e.target.value as VelocityResponseCurve)} disabled={running}>
                      {VELOCITY_RESPONSE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <VelocityBreakpointEditor
                    layers={velocityLayers}
                    breakpoints={velocityBreakpoints}
                    editable={!running}
                    custom={velocityResponse === 'custom'}
                    onDrag={handleDragVelocityBreakpoints}
                  />
                  <div className="field-row">
                    <div className="label">Round Robin</div>
                    <input type="number" min={1} max={8} value={roundRobinCount} onChange={(e) => setRoundRobinCount(Number(e.target.value))} disabled={running} />
                  </div>
                </section>

                <section className="as-section">
                  <h4>Tempos</h4>
                  <div className="field-row">
                    <div className="label">Sustain (s)</div>
                    <input type="number" min={0.1} step={0.1} value={sustainSeconds} onChange={(e) => setSustainSeconds(Number(e.target.value))} disabled={running} />
                  </div>
                  <div className="field-row">
                    <div className="label">Release tail (s)</div>
                    <input type="number" min={0} step={0.1} value={releaseTailSeconds} onChange={(e) => setReleaseTailSeconds(Number(e.target.value))} disabled={running} />
                  </div>
                  <div className="field-row">
                    <label className="as-check-label">
                      <input type="checkbox" checked={oneShot} onChange={(e) => setOneShot(e.target.checked)} disabled={running} />
                      One-shot (corta no silêncio — percussão/sons curtos)
                    </label>
                  </div>
                </section>

                <section className="as-section">
                  <h4>Auto Loop</h4>
                  <div className="field-row">
                    <div className="label">Modo</div>
                    <select value={autoLoop} onChange={(e) => setAutoLoop(e.target.value as AutoLoopMode)} disabled={running}>
                      {AUTO_LOOP_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <p className="as-hint">{AUTO_LOOP_OPTIONS.find((o) => o.value === autoLoop)?.hint}</p>
                  {autoLoop !== 'none' && (
                    <>
                      <div className="field-row">
                        <div className="label">Auto Loop Start</div>
                        <input type="number" min={0} max={99} value={autoLoopStartPct} disabled={running} onChange={(e) => setAutoLoopStartPct(Number(e.target.value))} /> %
                      </div>
                      <div className="field-row">
                        <div className="label">Auto Loop End</div>
                        <input type="number" min={1} max={100} value={autoLoopEndPct} disabled={running} onChange={(e) => setAutoLoopEndPct(Number(e.target.value))} /> %
                      </div>
                    </>
                  )}
                </section>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="as-step-panel">
              <p className="as-step-intro">
                Revise a saída e comece. Durante a captura, o teclado mostra o estado de cada nota —
                se alguma ficar silenciosa, você pode recapturar só ela depois.
              </p>

              <div className="as-grid">
                <section className="as-section">
                  <h4>Instrumento e formatos de saída</h4>
                  <div className="field-row">
                    <div className="label">Nome do instrumento</div>
                    <input type="text" value={instrumentName} disabled={running} onChange={(e) => setInstrumentName(e.target.value)} style={{ minWidth: 220 }} />
                  </div>
                  <div className="field-row">
                    <div className="label">Gerar .mrq</div>
                    <input type="checkbox" checked={outputMrq} disabled={running} onChange={(e) => setOutputMrq(e.target.checked)} />
                  </div>
                  <div className="field-row">
                    <div className="label">Gerar SF2/SF3</div>
                    <input type="checkbox" checked={outputSf2} disabled={running} onChange={(e) => setOutputSf2(e.target.checked)} />
                  </div>
                  {roundRobinCount > 1 && outputSf2 && (
                    <p className="as-hint">
                      Aviso: SF2 não tem round robin nativo — as variações vão empilhar em vez de alternar.
                    </p>
                  )}
                </section>

                <section className="as-section">
                  <h4>Resumo</h4>
                  {estimate ? (
                    <div className="as-estimate">
                      <div><span>Faixa</span><strong>{midiNoteLabel(rangeStartNote)}–{midiNoteLabel(rangeEndNote)}</strong></div>
                      <div><span>Notas</span><strong>{estimate.sampledNoteCount}</strong></div>
                      <div><span>Capturas</span><strong>{estimate.totalCaptures}</strong></div>
                      <div><span>Tempo</span><strong>{formatDuration(estimate.estimatedTotalSeconds)}</strong></div>
                    </div>
                  ) : (
                    <p className="as-hint">Configuração inválida.</p>
                  )}
                </section>
              </div>

              {outcomes.length > 0 && (
                <section className="as-section as-results">
                  <h4>Resultado por nota</h4>
                  <div className="as-results-list">
                    {[...outcomes]
                      .sort((a, b) => a.note - b.note)
                      .map((o) => (
                        <div key={o.taskId} className={`as-result-item${o.silent ? ' silent' : ''}`}>
                          <span className="as-result-note">{midiNoteLabel(o.note)}</span>
                          <span className="as-result-status">{o.silent ? 'silenciosa' : 'OK'}</span>
                          <span className="as-result-peak">{formatDbfs(o.peak)}</span>
                        </div>
                      ))}
                  </div>
                  {badNotes.length > 0 && !running && (
                    <div className="as-recapture">
                      <p className="as-hint">
                        {badNotes.length} nota(s) silenciosa(s): {badNotes.map((n) => midiNoteLabel(n)).join(', ')}.
                        Recapture só elas, sem regravar tudo (o arquivo novo vai conter só essas notas).
                      </p>
                      <button type="button" className="btn btn-secondary" onClick={handleRecaptureBad}>
                        <RotateCcw size={13} /> Recapturar só as ruins
                      </button>
                    </div>
                  )}
                </section>
              )}

              {result && (
                <div className="as-result-ok">
                  <Check size={15} />
                  <span>
                    Concluído: {result.capturedCount} captura(s)
                    {result.silentCaptureCount > 0 && `, ${result.silentCaptureCount} silenciosa(s)`}
                    {result.mrq ? ` — .mrq em ${result.mrq.finish.path}` : ''}
                    {result.sf2Path ? ` — .sf2 em ${result.sf2Path}` : ''}
                  </span>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="as-device-error">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="kc-footer">
          <div>
            {step > 1 && (
              <button type="button" className="btn btn-secondary" onClick={() => setStep((s) => (s - 1) as StepId)} disabled={running}>
                Voltar
              </button>
            )}
          </div>
          <div className="as-footer-actions">
            {running ? (
              <button type="button" className="btn btn-danger" onClick={handleCancel}>
                <Square size={13} /> Cancelar captura
              </button>
            ) : step < 4 ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep((s) => (s + 1) as StepId)}
                disabled={step === 1 && !setupReady}
              >
                Continuar
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void handleSample()} disabled={!setupReady || !estimate}>
                <Play size={13} /> Iniciar captura
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
