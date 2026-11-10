/**
 * "Auto Sampler" — modal do MRQ Instrument Converter que toca
 * automaticamente um instrumento Kontakt STANDALONE (não hospedado dentro
 * deste app — ver docs/mrq-instrument-converter/mrq-auto-sampler.md) por
 * uma porta MIDI real e grava de volta o áudio de uma entrada real, pra
 * montar um instrumento multisample completo sem precisar tocar nada manualmente.
 * Modelado no "Auto Sampler" do Logic Pro (ver referência visual
 * image-12.png da conversa) — mesmos campos (faixa de notas, intervalo de
 * amostragem, sustain, camadas de velocity + resposta, round robin, auto
 * loop com início/fim em %, one-shot, ganho de entrada), adaptados aos dois
 * formatos de saída deste conversor (`.mrq` e SF2/SF3, os dois juntos,
 * nunca um "modo phased" — decisão explícita do usuário).
 *
 * Toda a automação de verdade (MIDI/áudio) mora em
 * `src/audio/rack/autoSampler.ts` (`AutoSamplerSession`) — este componente
 * só é a tela: configura, mostra progresso, permite cancelar, e repassa o
 * resultado pro mesmo formato `onImported` já usado por
 * `KontaktCaptureDialog.tsx` (a fila principal do conversor não precisa
 * saber a diferença entre as duas origens, só que ambas chegam como um
 * `.mrq` já pronto — ver `captureKind` em InstrumentConverter.tsx).
 *
 * Pré-requisitos aceitos explicitamente pelo usuário (não são bugs nem
 * limitações escondidas — ver aviso fixo no topo do modal):
 *  - Um driver de loopback de áudio (BlackHole/VB-Audio Virtual
 *    Cable/monitor do PulseAudio, dependendo do SO) roteando a SAÍDA do
 *    Kontakt pra uma ENTRADA que apareça aqui como "dispositivo de áudio".
 *  - Uma porta MIDI virtual roteando a SAÍDA MIDI deste app pra ENTRADA
 *    MIDI do Kontakt.
 *  - O Kontakt já aberto standalone, com o instrumento carregado e essas
 *    duas rotas configuradas ANTES de apertar "Sample".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Loader2, Mic, Music2, Square, X } from 'lucide-react';
import { basenameOf } from '../audio/rack/converterFormats';
import { midiNoteLabel } from '../audio/rack/midiNoteNames';
import type { MrqCompatibilityReport, MrqFileMetadata, MrqFinishResult, MrqInstrumentModel } from '../audio/rack/mrqFormat';
import {
  computeVelocityBreakpoints,
  estimateAutoSamplerPlan,
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
  previewMidiNote,
  requestAudioInputPermission,
  SYSTEM_DEFAULT_AUDIO_INPUT_ID,
  type AudioInputDeviceInfo,
  type AutoSamplerProgress,
  type MidiPortInfo,
} from '../audio/rack/autoSampler';
import { useInputLevelMeter } from '../audio/rack/useInputLevelMeter';
import SampleNoteRangeKeyboard from './SampleNoteRangeKeyboard';
import VelocityBreakpointEditor from './VelocityBreakpointEditor';
import LevelMeterBar from './LevelMeterBar';
import { useStore } from '../state/useStore';

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

const NOTE_OPTIONS = Array.from({ length: 128 }, (_, n) => n);
const SAMPLE_EVERY_OPTIONS = [1, 2, 3, 4, 6, 12];
const VELOCITY_RESPONSE_OPTIONS: { value: VelocityResponseCurve; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'exp1', label: 'Exponencial 1' },
  { value: 'exp2', label: 'Exponencial 2' },
  { value: 'exp3', label: 'Exponencial 3' },
  { value: 'log1', label: 'Logarítmica 1' },
  { value: 'log2', label: 'Logarítmica 2' },
  { value: 'log3', label: 'Logarítmica 3' },
  { value: 'custom', label: 'Custom' },
];

/** Lista completa do Auto Loop do Logic Pro (ver SoundOnSound: soundonsound.com/techniques/logic-using-auto-sampler).
 *  "Penrose Machine" fica DESABILITADA de propósito — é um algoritmo de
 *  ressíntese proprietário da Apple/Redmatica, nunca documentado
 *  publicamente, então reimplementá-lo seria inventar um comportamento e
 *  fingir paridade que não existe. Preferimos mostrar a opção (pra deixar
 *  claro que sabemos que ela existe) com uma explicação, a escondê-la ou
 *  simular algo parecido por baixo dos panos. */
const AUTO_LOOP_OPTIONS: { value: AutoLoopMode | 'penrose'; label: string; disabled?: boolean; title?: string }[] = [
  { value: 'none', label: 'Nenhum' },
  { value: 'search', label: 'Search (corte seco no ponto mais parecido)' },
  { value: 'search-xfade', label: 'Search With X-Fade' },
  { value: 'search-rev-xfade', label: 'Search With Rev X-Fade' },
  { value: 'bidirectional', label: 'Bidirectional' },
  {
    value: 'penrose',
    label: 'Penrose Machine (indisponível)',
    disabled: true,
    title: 'Algoritmo de ressíntese proprietário da Apple/Redmatica, nunca documentado publicamente — não é possível reimplementá-lo de forma fiel, então não fingimos esse modo aqui.',
  },
];

function formatSeconds(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}min${rem > 0 ? ` ${rem}s` : ''}`;
}

export default function AutoSamplerDialog({ onClose, onImported }: Props) {
  const pushToast = useStore((s) => s.pushToast);

  const [instrumentName, setInstrumentName] = useState('Instrumento Auto Sampler');
  const [rangeStartNote, setRangeStartNote] = useState(48); // C2
  const [rangeEndNote, setRangeEndNote] = useState(72); // C4
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

  const [midiOutputs, setMidiOutputs] = useState<MidiPortInfo[]>([]);
  const [midiOutputId, setMidiOutputId] = useState<string>('');
  const [midiChannel, setMidiChannel] = useState(1); // 1-16, exibido pro usuário; convertido pra 0-based só na hora de enviar.
  const [audioInputs, setAudioInputs] = useState<AudioInputDeviceInfo[]>([]);
  /** Só vira `true` no Windows (ver `isNativeLoopbackSupported`/loopback_audio.rs) — controla se os dispositivos de loopback nativo entram na lista de "Dispositivo" abaixo, como alternativa ao cabo de áudio virtual (BlackHole/VB-Audio Virtual Cable). */
  const [nativeLoopbackSupported, setNativeLoopbackSupported] = useState(false);
  const [audioInputDeviceId, setAudioInputDeviceId] = useState<string>(SYSTEM_DEFAULT_AUDIO_INPUT_ID);

  // MIDI e áudio são carregados/tratados INDEPENDENTEMENTE um do outro — uma
  // falha num não pode esconder nem bloquear o outro (ver bug real: MIDI
  // funcionando com a porta encontrada enquanto a permissão de áudio foi
  // negada pelo WebView, e a tela antiga mostrava um único erro genérico
  // que não deixava reexplorar nenhum dos dois sem fechar o modal).
  const [midiLoading, setMidiLoading] = useState(true);
  const [midiError, setMidiError] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);

  const [outputMrq, setOutputMrq] = useState(true);
  const [outputSf2, setOutputSf2] = useState(true);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AutoSamplerProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          'Nenhuma porta MIDI de saída encontrada. Crie/ative uma porta MIDI virtual roteada até o Kontakt (IAC Driver no macOS, loopMIDI no Windows, aconnect/a2jmidid no Linux — ver docs/mrq-instrument-converter/mrq-auto-sampler.md) e clique em "Tentar de novo".'
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMidiError(`Não foi possível listar as portas MIDI: ${message}`);
    } finally {
      setMidiLoading(false);
    }
  }

  /** Pede a permissão de áudio (gesto explícito do usuário no botão "Tentar
   *  de novo"/"Conceder permissão" — nunca só automático ao abrir o modal),
   *  porque no WebView2 do Windows um pedido de getUserMedia feito
   *  automaticamente ao montar a tela pode aparecer e desaparecer rápido
   *  demais (ou ser bloqueado pela configuração de privacidade do Windows
   *  sem nem mostrar o prompt) e sair como "Permission dismissed" sem o
   *  usuário ter clicado em nada — ver aviso explicado em `audioError`
   *  abaixo. Um clique explícito garante que o prompt do sistema realmente
   *  tem a chance de aparecer em primeiro plano. */
  async function loadAudioInputs() {
    setAudioLoading(true);
    setAudioError(null);
    // Loopback nativo e getUserMedia sao buscados INDEPENDENTEMENTE -- o
    // nativo nao precisa (nem pede) nenhuma permissao de SO, entao uma
    // permissao de microfone negada nao pode esconder as opcoes nativas que
    // ja funcionariam sem instalar nada (ver NATIVE_LOOPBACK_PREFIX em
    // autoSampler.ts).
    const combined: AudioInputDeviceInfo[] = [];
    if (nativeLoopbackSupported) {
      try {
        combined.push(...(await listNativeLoopbackDevices()));
      } catch {
        /* lista nativa e so um complemento -- uma falha aqui nao deveria impedir de tentar o getUserMedia normal abaixo. */
      }
    }
    try {
      await requestAudioInputPermission();
      const ins = await listAudioInputDevices();
      combined.push(...ins);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // So trava com erro se nao sobrou NENHUMA opcao (nem nativa, nem
      // getUserMedia) -- com loopback nativo disponivel, a permissao de
      // microfone negada deixa de ser bloqueante.
      if (combined.length === 0) {
        setAudioError(
          `Permissão de microfone/entrada de áudio negada ou descartada pelo sistema (${message}). No Windows: abra Configurações > Privacidade e segurança > Microfone e confira se "Acesso ao microfone" e "Permitir que aplicativos de área de trabalho acessem seu microfone" estão LIGADOS — sem isso, o WebView nem chega a mostrar o pedido de permissão, ele já volta negado. No macOS/Linux, confira as permissões de microfone do sistema para este app. Depois, clique em "Tentar de novo".`
        );
      }
    }
    setAudioInputs(combined);
    setAudioInputDeviceId((prev) =>
      prev === SYSTEM_DEFAULT_AUDIO_INPUT_ID || combined.some((d) => d.id === prev) ? prev : SYSTEM_DEFAULT_AUDIO_INPUT_ID
    );
    if (combined.length === 0 && !audioError) {
      setAudioError('Permissão concedida, mas nenhum dispositivo de entrada de áudio foi encontrado. Confira se o driver de loopback (BlackHole/VB-Audio Virtual Cable/monitor do PulseAudio) está instalado.');
    }
    setAudioLoading(false);
  }

  useEffect(() => {
    void loadMidiOutputs();
    // A permissão de áudio NÃO é pedida automaticamente ao abrir o modal —
    // só quando o usuário clica em "Conceder permissão de áudio" (ver botão
    // abaixo). No WebView2 do Windows, um pedido de getUserMedia disparado
    // automaticamente ao montar a tela pode voltar "Permission dismissed"
    // na hora (sem mostrar prompt nenhum pro usuário), especialmente se a
    // configuração de privacidade do Windows ainda não liberou microfone
    // pra apps de área de trabalho — um clique explícito garante que o
    // pedido realmente tem a chance de aparecer em primeiro plano, e dá um
    // sinal claro de causa quando falha mesmo assim.
    setAudioLoading(false);
    // Checagem silenciosa (não pede permissão nenhuma, não lança erro
    // visível) — `isNativeLoopbackSupported` já devolve `false` em qualquer
    // SO sem suporte (ver autoSampler.ts), então só precisa decidir se a
    // lista de dispositivos nativos entra ou não quando o usuário clicar em
    // "Conceder permissão de áudio"/"Atualizar dispositivos de áudio".
    void isNativeLoopbackSupported().then(setNativeLoopbackSupported);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Muda o número de camadas invalida qualquer breakpoint customizado
  // anterior (o motor exige exatamente layers+1 pontos — ver
  // computeVelocityBreakpoints em autoSamplerEngine.ts) — melhor recomeçar
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

  // Loopback nativo não passa por `getUserMedia` (ver NATIVE_LOOPBACK_PREFIX
  // em autoSampler.ts) — o medidor ao vivo normal não tem como abrir um
  // segundo stream pra um id que nem é um MediaDeviceInfo de verdade, então
  // fica desligado pra essas entradas (o Input Gain continua funcionando
  // normalmente na captura de qualquer forma).
  const usingNativeLoopbackUi = isNativeLoopbackDeviceId(audioInputDeviceId);
  const levelMeterEnabled = !running && audioInputDeviceId !== '' && !usingNativeLoopbackUi;
  const { levels: meterLevels, error: meterError } = useInputLevelMeter(audioInputDeviceId, levelMeterEnabled, inputGainDb);

  const loadingDevices = midiLoading || audioLoading;
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
      rangeStartNote,
      rangeEndNote,
      sampleEverySemitones,
      velocityLayers,
      velocityResponse,
      customVelocityBreakpoints,
      roundRobinCount,
      sustainSeconds,
      releaseTailSeconds,
      autoLoop,
      autoLoopStartPct,
      autoLoopEndPct,
      oneShot,
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

  async function handleSample() {
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
        },
        (p) => setProgress(p)
      );

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

  const phaseLabel: Record<AutoSamplerProgress['phase'], string> = {
    capturing: 'Gravando',
    'building-mrq': 'Montando .mrq',
    'building-sf2': 'Montando .sf2',
  };

  return (
    <div className="modal-overlay" onClick={running ? undefined : onClose}>
      <div className="modal wide as-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Auto Sampler</h2>
          <button className="icon-btn" onClick={onClose} disabled={running}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="kc-disclaimer">
            <AlertTriangle size={16} />
            <div>
              Toca de verdade cada nota/velocidade/round-robin por MIDI num Kontakt <strong>standalone</strong> (não hospedado
              aqui) e grava a saída de áudio real dele por um dispositivo de entrada roteado por um{' '}
              <strong>driver de loopback de áudio</strong> (BlackHole, VB-Audio Virtual Cable, monitor do PulseAudio, etc.).
              Abra o Kontakt, carregue o instrumento, e configure as duas rotas (MIDI e áudio) antes de apertar "Sample" — ver
              docs/mrq-instrument-converter/mrq-auto-sampler.md.
            </div>
          </div>

          <section className="as-section as-keyboard-section">
            <h4>Sample Note Range — clique numa tecla pra ouvir, arraste as pontas da barra azul pra ajustar a faixa</h4>
            <SampleNoteRangeKeyboard
              rangeStartNote={rangeStartNote}
              rangeEndNote={rangeEndNote}
              sampleEverySemitones={sampleEverySemitones}
              onChangeRange={(start, end) => {
                setRangeStartNote(start);
                setRangeEndNote(end);
              }}
              onPreviewNote={handlePreviewNote}
              disabled={running}
            />
            <div className="as-keyboard-legend">
              <span><i className="as-kb-legend-swatch as-kb-legend-sampled" /> amostrada de verdade</span>
              <span><i className="as-kb-legend-swatch as-kb-legend-in" /> dentro da faixa (preenchida por interpolação)</span>
              <span><i className="as-kb-legend-swatch as-kb-legend-out" /> fora da faixa</span>
            </div>
          </section>

          <div className="as-grid">
            <section className="as-section">
              <h4>Faixa de notas</h4>
              <div className="field-row">
                <div className="label">Range Start</div>
                <select value={rangeStartNote} onChange={(e) => setRangeStartNote(Number(e.target.value))} disabled={running}>
                  {NOTE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{midiNoteLabel(n)}</option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="label">Range End</div>
                <select value={rangeEndNote} onChange={(e) => setRangeEndNote(Number(e.target.value))} disabled={running}>
                  {NOTE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{midiNoteLabel(n)}</option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="label">Sample Every</div>
                <select value={sampleEverySemitones} onChange={(e) => setSampleEverySemitones(Number(e.target.value))} disabled={running}>
                  {SAMPLE_EVERY_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n} semitom{n > 1 ? 's' : ''}</option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="label">Round Robin</div>
                <select value={roundRobinCount} onChange={(e) => setRoundRobinCount(Number(e.target.value))} disabled={running}>
                  <option value={1}>Não</option>
                  {[2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>{n} variações</option>
                  ))}
                </select>
              </div>
            </section>

            <section className="as-section">
              <h4>Timing e velocity</h4>
              <div className="field-row">
                <div className="label">Sustain</div>
                <input type="number" min={0.1} max={60} step={0.1} value={sustainSeconds} disabled={running} onChange={(e) => setSustainSeconds(Math.max(0.1, Number(e.target.value)))} />
              </div>
              <div className="field-row">
                <div className="label">Release tail</div>
                <input type="number" min={0} max={30} step={0.1} value={releaseTailSeconds} disabled={running} onChange={(e) => setReleaseTailSeconds(Math.max(0, Number(e.target.value)))} />
              </div>
              <div className="field-row">
                <div className="label">Velocity Layers</div>
                <select value={velocityLayers} onChange={(e) => setVelocityLayers(Number(e.target.value))} disabled={running}>
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="label">Velocity Response</div>
                <select value={velocityResponse} onChange={(e) => setVelocityResponse(e.target.value as VelocityResponseCurve)} disabled={running || velocityLayers <= 1}>
                  {VELOCITY_RESPONSE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              {velocityLayers > 1 && (
                <VelocityBreakpointEditor
                  layers={velocityLayers}
                  breakpoints={velocityBreakpoints}
                  editable={!running && velocityResponse === 'custom'}
                  onDrag={handleDragVelocityBreakpoints}
                />
              )}
            </section>

            <section className="as-section">
              <h4>Auto Loop</h4>
              <div className="field-row">
                <div className="label">Auto Loop</div>
                <select value={autoLoop} onChange={(e) => setAutoLoop(e.target.value as AutoLoopMode)} disabled={running}>
                  {AUTO_LOOP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>{o.label}</option>
                  ))}
                </select>
              </div>
              {autoLoop !== 'none' && (
                <div className="hint" style={{ marginTop: -2, marginBottom: 4 }}>
                  {autoLoop === 'search' && 'Corte seco no ponto mais parecido encontrado — pode soar como um "pulso" se nenhum ponto perfeito existir.'}
                  {autoLoop === 'search-xfade' && 'Mesma busca do "Search", com crossfade equal-power gravado na emenda quando não há corte 100% limpo.'}
                  {autoLoop === 'search-rev-xfade' && 'Crossfade com uma cópia invertida no tempo do próprio loop — preserva melhor o timbre de decay (preferência do autor do artigo da Sound On Sound junto com Bidirectional).'}
                  {autoLoop === 'bidirectional' && 'Alterna forward/reverso com emendas sempre no mesmo nível — geralmente o loop menos repetitivo (e mais longo).'}
                </div>
              )}
              <div className="field-row">
                <div className="label">Auto Loop Start</div>
                <input type="number" min={0} max={99} value={autoLoopStartPct} disabled={running || autoLoop === 'none'} onChange={(e) => setAutoLoopStartPct(Number(e.target.value))} /> %
              </div>
              <div className="field-row">
                <div className="label">Auto Loop End</div>
                <input type="number" min={1} max={100} value={autoLoopEndPct} disabled={running || autoLoop === 'none'} onChange={(e) => setAutoLoopEndPct(Number(e.target.value))} /> %
              </div>
              <div className="field-row">
                <div className="label">One Shot</div>
                <input type="checkbox" checked={oneShot} disabled={running} onChange={(e) => setOneShot(e.target.checked)} />
              </div>
            </section>
          </div>

          <div className="as-grid">
            <section className="as-section">
              <h4><Music2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Saída MIDI (para o Kontakt)</h4>
              <div className="field-row">
                <div className="label">Porta MIDI</div>
                <select value={midiOutputId} onChange={(e) => setMidiOutputId(e.target.value)} disabled={running || midiLoading}>
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
              {midiError && (
                <div className="as-device-error">
                  <AlertTriangle size={13} />
                  <div>{midiError}</div>
                </div>
              )}
              <button className="btn ghost small" onClick={() => void loadMidiOutputs()} disabled={running || midiLoading} style={{ marginTop: 6 }}>
                {midiLoading ? <Loader2 size={12} className="mrq-spin" /> : null} Atualizar portas MIDI
              </button>
            </section>

            <section className="as-section">
              <h4><Mic size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Entrada de áudio (do Kontakt, via loopback)</h4>
              {!audioPermissionRequested && !audioLoading && (
                <div className="hint" style={{ marginBottom: 6 }}>
                  Clique abaixo pra pedir permissão de microfone/entrada de áudio ao sistema e listar os dispositivos disponíveis.
                  {nativeLoopbackSupported && ' As opções "(loopback nativo)" não precisam de cabo de áudio virtual nenhum (BlackHole/VB-Audio Virtual Cable) — gravam direto do dispositivo de saída escolhido.'}
                </div>
              )}
              <div className="field-row">
                <div className="label">Dispositivo</div>
                <select value={audioInputDeviceId} onChange={(e) => setAudioInputDeviceId(e.target.value)} disabled={running || audioLoading}>
                  {/* "Padrão do sistema" sempre disponível (não depende de enumerateDevices ter achado nada com label) — ver SYSTEM_DEFAULT_AUDIO_INPUT_ID em autoSampler.ts e o mesmo padrão já usado no seletor de saída em SettingsModal.tsx. */}
                  <option value={SYSTEM_DEFAULT_AUDIO_INPUT_ID}>Padrão do sistema</option>
                  {audioInputs.filter((d) => !isNativeLoopbackDeviceId(d.id)).map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                  {audioInputs.some((d) => isNativeLoopbackDeviceId(d.id)) && (
                    <optgroup label="Loopback nativo (sem instalar nada)">
                      {audioInputs.filter((d) => isNativeLoopbackDeviceId(d.id)).map((d) => (
                        <option key={d.id} value={d.id}>{d.label}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              <div className="field-row">
                <div className="label">Input Gain</div>
                <input type="range" min={-24} max={24} step={0.5} value={inputGainDb} disabled={running} onChange={(e) => setInputGainDb(Number(e.target.value))} />
                <div className="hint" style={{ minWidth: 48, textAlign: 'right' }}>{inputGainDb > 0 ? '+' : ''}{inputGainDb.toFixed(1)}dB</div>
              </div>
              {usingNativeLoopbackUi ? (
                <div className="hint" style={{ marginTop: 4 }}>
                  Medidor ao vivo não disponível pro loopback nativo (o Input Gain continua funcionando normalmente na captura) — toque uma nota no Kontakt e confira pelo "Voices" dele que está soando.
                </div>
              ) : (
                audioInputDeviceId && !running && (
                  <div className="as-level-meters">
                    <LevelMeterBar label="L" db={meterLevels.l} />
                    <LevelMeterBar label="R" db={meterLevels.r} />
                  </div>
                )
              )}
              {meterError && !usingNativeLoopbackUi && (
                <div className="hint" style={{ color: '#e0b84a' }}>{meterError} (o Input Gain ainda funciona normalmente na captura — só o medidor ao vivo não abriu.)</div>
              )}
              {audioError && (
                <div className="as-device-error">
                  <AlertTriangle size={13} />
                  <div>{audioError}</div>
                </div>
              )}
              <button className={`btn ${audioPermissionRequested ? 'ghost' : 'primary'} small`} onClick={() => void loadAudioInputs()} disabled={running || audioLoading} style={{ marginTop: 6 }}>
                {audioLoading ? <Loader2 size={12} className="mrq-spin" /> : null}{' '}
                {!audioPermissionRequested ? 'Conceder permissão de áudio' : audioError ? 'Tentar de novo' : 'Atualizar dispositivos de áudio'}
              </button>
            </section>
          </div>

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
            </section>

            {estimate && (
              <section className="as-section">
                <h4>Estimativa</h4>
                <div className="field-row">
                  <div className="label">Notas amostradas</div>
                  <div className="hint">{estimate.sampledNoteCount}</div>
                </div>
                <div className="field-row">
                  <div className="label">Total de capturas</div>
                  <div className="hint">{estimate.totalCaptures}</div>
                </div>
                <div className="field-row">
                  <div className="label">Tempo estimado</div>
                  <div className="hint">~{formatSeconds(estimate.estimatedTotalSeconds)}</div>
                </div>
              </section>
            )}
          </div>
        </div>

        <div className="kc-footer">
          <div>
            {error && <span className="kc-footer-error">{error}</span>}
            {progress && (
              <span className="kc-footer-progress">
                <Loader2 size={14} className="mrq-spin" /> {phaseLabel[progress.phase]}
                {progress.phase === 'capturing' && ` — ${midiNoteLabel(progress.currentTask.note)} vel ${progress.currentTask.velocity} (${progress.done}/${progress.total})`}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running ? (
              <button className="btn danger" onClick={handleCancel}>
                <Square size={14} /> Cancelar
              </button>
            ) : (
              <button className="btn ghost" onClick={onClose}>Fechar</button>
            )}
            <button className="btn primary" onClick={() => void handleSample()} disabled={running || loadingDevices}>
              {running ? <Loader2 size={14} className="mrq-spin" /> : <Music2 size={14} />} Sample
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
