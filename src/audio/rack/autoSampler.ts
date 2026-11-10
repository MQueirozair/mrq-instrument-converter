/**
 * Orquestração REAL do Auto Sampler — manda MIDI de verdade pro Kontakt
 * (standalone, via uma porta MIDI de saída que o usuário tenha roteado até
 * ele — ver docs/mrq-instrument-converter/mrq-auto-sampler.md) e grava de
 * volta o áudio que ele produz (via um dispositivo de ENTRADA de áudio que
 * o usuário tenha roteado da saída do Kontakt pra cá — normalmente um
 * "cabo de áudio virtual" tipo BlackHole/VB-Audio Virtual Cable/o monitor
 * do PulseAudio, dependendo do sistema operacional).
 *
 * Só usa APIs padrão do navegador — Web MIDI (`navigator.requestMIDIAccess`,
 * polyfillada em todo SO por `tauri-plugin-midi`, ver comentário em
 * src-tauri/src/lib.rs) e Web Audio/`getUserMedia` (no Linux precisa da
 * liberação explícita em src-tauri/src/linux_media.rs; no macOS, da chave
 * NSMicrophoneUsageDescription em src-tauri/Info.plist) — nenhum comando
 * Tauri novo foi criado só pra isso.
 *
 * Decisão de arquitetura: o Converter é um app standalone, não um host de
 * plugins VST/AU — então "tocar" o Kontakt significa necessariamente sair
 * por uma porta MIDI real (não existe um jeito de mandar MIDI "dentro do
 * processo" pra outro aplicativo) e gravar de volta por uma entrada de
 * áudio real. Isso é o MESMO modelo que o guia da Berklee usa pra "Sampling
 * A Hardware Synthesizer" com o Auto Sampler do Logic — só que aqui o
 * "hardware" é o Kontakt rodando no mesmo computador.
 *
 * Separação de responsabilidades (mesmo padrão do resto do projeto):
 *  - `autoSamplerEngine.ts`: toda a lógica PURA (o que gravar, como
 *    processar depois) — testável sem hardware nenhum.
 *  - Este arquivo: só I/O de verdade (MIDI/áudio/Tauri fs) — não pode ser
 *    testado automaticamente aqui, só pelo usuário na própria máquina.
 */

import { invoke } from '@tauri-apps/api/core';
import { writeFile } from '@tauri-apps/plugin-fs';
import {
  mrqBuilderAbort,
  mrqBuilderAddSample,
  mrqBuilderBegin,
  mrqBuilderFinish,
  mrqReadMetadata,
  type MrqCompatibilityReport,
  type MrqFileMetadata,
  type MrqFinishResult,
  type MrqInstrumentModel,
  type MrqZone,
} from './mrqFormat';
import { buildSf2Binary, type Sf2ExportZone } from './sf2Export';
import {
  applyGainDb,
  bakeAutoLoop,
  computeAutoSamplerKeyRanges,
  findLoopPoints,
  generateAutoSamplerTasks,
  isCaptureSilent,
  trimLeadingSilence,
  trimTrailingSilence,
  INTER_TASK_GAP_SECONDS,
  type AutoSamplerConfig,
  type AutoSamplerTask,
} from './autoSamplerEngine';

// ---------------------------------------------------------------------------
// Descoberta de dispositivos — MIDI (Web MIDI) e áudio (mediaDevices).
// ---------------------------------------------------------------------------

export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer?: string;
}

let cachedMidiAccess: MIDIAccess | null = null;

async function getMidiAccess(): Promise<MIDIAccess> {
  if (cachedMidiAccess) return cachedMidiAccess;
  if (!navigator.requestMIDIAccess) {
    throw new Error(
      'Web MIDI não está disponível neste sistema — isso não deveria acontecer dentro do app (ver tauri-plugin-midi em src-tauri/src/lib.rs); reinicie o app e tente de novo.'
    );
  }
  cachedMidiAccess = await navigator.requestMIDIAccess({ sysex: false });
  return cachedMidiAccess;
}

/** Lista as portas MIDI de SAÍDA disponíveis — a que o usuário escolher precisa estar roteada até a entrada MIDI do Kontakt (ver docs/mrq-instrument-converter/mrq-auto-sampler.md pro passo a passo por sistema operacional). */
export async function listMidiOutputs(): Promise<MidiPortInfo[]> {
  const access = await getMidiAccess();
  return [...access.outputs.values()].map((o) => ({ id: o.id, name: o.name || o.id, manufacturer: o.manufacturer || undefined }));
}

/**
 * Toca uma nota curta por MIDI pra pré-ouvir o instrumento — mesmo
 * comportamento do teclado visual do Auto Sampler do Logic Pro ("click on
 * the keyboard and a MIDI note is sent so you can hear the instrument you
 * plan to sample", ver referência em SampleNoteRangeKeyboard.tsx). NÃO usa
 * `AutoSamplerSession` nem grava nada — é só um atalho pra ouvir, então não
 * precisa de dispositivo de entrada de áudio configurado, só da porta MIDI.
 * Falhas são ignoradas silenciosamente (preview é um "nice to have"; um erro
 * aqui nunca deveria interromper o usuário mexendo na tela de configuração).
 */
export async function previewMidiNote(outputId: string, channel: number, note: number, velocity = 100, durationMs = 350): Promise<void> {
  try {
    const access = await getMidiAccess();
    const output = access.outputs.get(outputId);
    if (!output) return;
    const ch = channel & 0x0f;
    const clampedNote = Math.max(0, Math.min(127, Math.round(note)));
    output.send([0x90 | ch, clampedNote, velocity]);
    setTimeout(() => {
      try {
        output.send([0x80 | ch, clampedNote, 0]);
      } catch {
        /* porta pode ter sido desconectada entre o note-on e o note-off — sem problema, é só um preview. */
      }
    }, durationMs);
  } catch {
    /* ver comentário da função — preview nunca deve travar/quebrar a tela de configuração. */
  }
}

/**
 * Note on/off DE VERDADE (sustentada, sem duração fixa) — base do
 * "Controlador MIDI" (ver MidiControllerDialog.tsx), um teclado que o
 * usuário pode tocar/segurar de verdade pra testar, ao vivo, se a porta
 * MIDI escolhida está mesmo chegando no Kontakt (diagnóstico direto pro
 * problema "o Kontakt não toca as notas" — complementa o aviso de
 * silêncio do Auto Sampler e o guia de roteamento em
 * docs/mrq-instrument-converter/mrq-auto-sampler.md, mas sem precisar
 * configurar uma sessão de captura inteira só pra testar a porta).
 * Diferente de `previewMidiNote` (nota curta, duração fixa, usada só pra
 * pré-ouvir o instrumento no seletor de faixa), estas aqui propagam o erro
 * pro chamador em vez de engolir silenciosamente — o Controlador MIDI
 * PRECISA saber se o send falhou, pra mostrar isso na tela (é a
 * ferramenta de diagnóstico, não teria sentido ela mascarar falhas).
 */
export async function sendMidiNoteOn(outputId: string, channel: number, note: number, velocity = 100): Promise<void> {
  const access = await getMidiAccess();
  const output = access.outputs.get(outputId);
  if (!output) throw new Error('porta MIDI não encontrada — pode ter sido desconectada.');
  const ch = channel & 0x0f;
  const clampedNote = Math.max(0, Math.min(127, Math.round(note)));
  const clampedVel = Math.max(1, Math.min(127, Math.round(velocity)));
  output.send([0x90 | ch, clampedNote, clampedVel]);
}

export async function sendMidiNoteOff(outputId: string, channel: number, note: number): Promise<void> {
  const access = await getMidiAccess();
  const output = access.outputs.get(outputId);
  if (!output) return; // já era — não faz sentido falhar um note-off de limpeza.
  const ch = channel & 0x0f;
  const clampedNote = Math.max(0, Math.min(127, Math.round(note)));
  output.send([0x80 | ch, clampedNote, 0]);
}

/** "Pânico" — manda All Notes Off (CC 123) + All Sound Off (CC 120) nos 16 canais MIDI, não só no canal selecionado
 *  (cobre o caso de o usuário ter trocado de canal no meio de uma nota segurada, ou de alguma nota ter ficado presa
 *  por causa de uma troca de porta/desconexão). Nunca lança — é um botão de emergência, precisa sempre "funcionar"
 *  silenciosamente mesmo se a porta já não existir mais. */
export async function sendMidiAllNotesOff(outputId: string): Promise<void> {
  try {
    const access = await getMidiAccess();
    const output = access.outputs.get(outputId);
    if (!output) return;
    for (let ch = 0; ch < 16; ch += 1) {
      try {
        output.send([0xb0 | ch, 123, 0]);
        output.send([0xb0 | ch, 120, 0]);
      } catch {
        /* segue tentando os outros canais mesmo se um falhar. */
      }
    }
  } catch {
    /* botão de pânico — nunca deve ele mesmo precisar de tratamento de erro na UI. */
  }
}

export interface AudioInputDeviceInfo {
  id: string;
  label: string;
}

/**
 * Valor sentinela pra "Padrão do sistema" no seletor de entrada de áudio —
 * mesma ideia já usada pro seletor de saída em SettingsModal.tsx (`<option
 * value="">Padrão do sistema</option>`), só que aqui não dá pra reusar uma
 * string vazia porque `''` já significa "nenhum dispositivo escolhido
 * ainda" em `AutoSamplerDialog.tsx` (estado inicial antes da permissão ser
 * concedida/da lista carregar). Com um dispositivo específico (`{ exact:
 * deviceId }`), o Auto Sampler quebra se o usuário trocar o cabo/driver de
 * loopback entre sessões e o id mudar; com este valor, a captura simplesmente
 * pede `audio: true` sem restrição de deviceId, deixando o sistema
 * operacional escolher o dispositivo de entrada padrão atual — mais robusto
 * pro fluxo real de loopback (BlackHole/VB-Audio Virtual Cable/monitor do
 * PulseAudio), que não raro é também configurado como entrada padrão do SO.
 */
export const SYSTEM_DEFAULT_AUDIO_INPUT_ID = '__system_default__';

/** Pede permissão de entrada de áudio UMA vez (sem manter nada aberto) — necessário antes de `listAudioInputDevices` devolver nomes reais de dispositivo (por privacidade, o navegador/WebView só revela `label` depois de uma permissão concedida). */
export async function requestAudioInputPermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}

export async function listAudioInputDevices(): Promise<AudioInputDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Entrada de áudio ${i + 1}` }));
}

// ---------------------------------------------------------------------------
// Loopback de áudio NATIVO (ver src-tauri/src/loopback_audio.rs) — grava
// diretamente o que um dispositivo de SAÍDA de áudio está tocando via WASAPI
// (só Windows por enquanto), sem precisar de nenhum cabo de áudio virtual
// (BlackHole/VB-Audio Virtual Cable) nem de `getUserMedia`. Representado na
// UI como entradas a mais no MESMO seletor de "dispositivo de entrada" (ver
// AutoSamplerDialog.tsx) — por isso usam o mesmo tipo `AudioInputDeviceInfo`,
// só com o `id` prefixado por `NATIVE_LOOPBACK_PREFIX` pra `AutoSamplerSession`
// saber, em `setupAudio`, que precisa tomar o caminho nativo em vez do
// `getUserMedia` normal.
// ---------------------------------------------------------------------------

/** Prefixo que marca um `AudioInputDeviceInfo.id` como loopback nativo (o resto do id, depois do prefixo, é o nome do dispositivo de SAÍDA a capturar — vazio = dispositivo de saída padrão do sistema). Ver `isNativeLoopbackDeviceId`/`nativeLoopbackDeviceNameFromId`. */
export const NATIVE_LOOPBACK_PREFIX = '__native_loopback__:';

export function isNativeLoopbackDeviceId(id: string): boolean {
  return id.startsWith(NATIVE_LOOPBACK_PREFIX);
}

function nativeLoopbackDeviceNameFromId(id: string): string | undefined {
  const name = id.slice(NATIVE_LOOPBACK_PREFIX.length);
  return name.length > 0 ? name : undefined;
}

/** Só Windows por enquanto — ver `loopback_is_supported` em loopback_audio.rs (no macOS/Linux sempre devolve `false`, sem lançar erro, pra UI simplesmente esconder a opção). */
export async function isNativeLoopbackSupported(): Promise<boolean> {
  try {
    return await invoke<boolean>('loopback_is_supported');
  } catch {
    return false;
  }
}

/** Lista os dispositivos de SAÍDA de áudio disponíveis pra capturar por loopback nativo — já no formato `AudioInputDeviceInfo` (id prefixado, ver `NATIVE_LOOPBACK_PREFIX`), pronto pra entrar na mesma lista/seletor dos dispositivos de entrada normais. Chame só depois de confirmar `isNativeLoopbackSupported()` — em SOs sem suporte, rejeita com a mensagem de erro de `loopback_list_devices`. */
export async function listNativeLoopbackDevices(): Promise<AudioInputDeviceInfo[]> {
  const names = await invoke<string[]>('loopback_list_devices');
  return names.map((name) => ({ id: NATIVE_LOOPBACK_PREFIX + name, label: `${name} (loopback nativo)` }));
}

// ---------------------------------------------------------------------------
// Execução da sessão de captura
// ---------------------------------------------------------------------------

export interface AutoSamplerOutputRequest {
  mrq?: { destPath: string };
  sf2?: { destPath: string };
}

export interface AutoSamplerRunOptions {
  config: AutoSamplerConfig;
  instrumentName: string;
  midiOutputId: string;
  /** 0-based (0-15) — a UI mostra "Canal 1-16" pro usuário, a conversão pra 0-based é responsabilidade de quem chama. */
  midiChannel: number;
  audioInputDeviceId: string;
  inputGainDb: number;
  outputs: AutoSamplerOutputRequest;
}

export type AutoSamplerPhase = 'capturing' | 'building-mrq' | 'building-sf2';

export interface AutoSamplerProgress {
  done: number;
  total: number;
  currentTask: AutoSamplerTask;
  phase: AutoSamplerPhase;
}

export interface AutoSamplerMrqOutput {
  finish: MrqFinishResult;
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  metadata: MrqFileMetadata;
}

export interface AutoSamplerRunResult {
  capturedCount: number;
  /** Quantas das capturas vieram silenciosas (pico < -50dBFS a captura
   *  inteira) — ver `isCaptureSilent` em autoSamplerEngine.ts. O Auto
   *  Sampler não tem como confirmar se o Kontakt respondeu de verdade ao
   *  MIDI; isso é o sinal indireto mais confiável de "a nota não tocou" ou
   *  "a entrada de áudio não está recebendo nada do Kontakt". */
  silentCaptureCount: number;
  mrq?: AutoSamplerMrqOutput;
  sf2Path?: string;
}

/** Relatório de compatibilidade do Auto Sampler — mesmo espírito do
 *  construído em `buildCaptureInstrumentModel` (kontaktCapture.ts), mas o
 *  áudio aqui é mais "real" ainda (tocado e gravado ao vivo, não um arquivo
 *  pré-renderizado escolhido pelo usuário); o que continua sendo uma
 *  APROXIMAÇÃO é só o mapeamento de tecla/velocidade — gerado pela própria
 *  configuração do Auto Sampler, não extraído de nenhum patch original
 *  (não existe "patch original" aqui: o Kontakt é só o instrumento tocado). */
export function buildAutoSamplerCompatibilityReport(config: AutoSamplerConfig): MrqCompatibilityReport {
  const report: MrqCompatibilityReport = { preserved: [], approximated: [], unsupported: [] };
  report.preserved.push({
    field: 'Áudio',
    detail:
      'gravado ao vivo da saída de áudio real do Kontakt (via o dispositivo de entrada escolhido) enquanto o Auto Sampler tocava cada nota/velocidade/round-robin por MIDI — recodificado em FLAC lossless dentro do .mrq, sem decodificar nem ler o patch .nki original em nenhum momento.',
  });
  report.approximated.push({
    field: 'Nota raiz / faixa de teclado / faixa de velocidade',
    detail: 'geradas pela própria configuração do Auto Sampler (Range Start/End, Sample Every, Velocity Layers/Response) — preenchem o teclado inteiro por interpolação entre as notas de fato amostradas, igual a qualquer auto sampler.',
  });
  if (config.roundRobinCount > 1) {
    report.approximated.push({
      field: 'Round robin',
      detail: `${config.roundRobinCount} variações gravadas por nota+velocidade e alternadas na reprodução (o Rack já suporta round robin em camadas .mrq) — cada variação é uma captura de áudio independente, não uma cópia da mesma gravação.`,
    });
  }
  if (config.autoLoop !== 'none') {
    const modeLabel: Record<Exclude<AutoSamplerConfig['autoLoop'], 'none'>, string> = {
      search: 'Search (corte seco no ponto mais parecido encontrado)',
      'search-xfade': 'Search With X-Fade (crossfade equal-power gravado na emenda)',
      'search-rev-xfade': 'Search With Rev X-Fade (crossfade com cópia invertida no tempo gravado na emenda)',
      bidirectional: 'Bidirectional (trecho forward+reverso concatenado, equivalente a ping-pong quando tocado em loop simples)',
    };
    report.approximated.push({
      field: 'Pontos de loop',
      detail: `modo "${modeLabel[config.autoLoop]}" — ponto de loop encontrado por autocorrelação dentro da janela ${config.autoLoopStartPct}%-${config.autoLoopEndPct}% de cada amostra (ver findLoopPoints/bakeAutoLoop em autoSamplerEngine.ts); uma estimativa automática, não um ponto de loop ajustado manualmente por um engenheiro de áudio. O modo "Penrose Machine" do Logic Pro (ressíntese proprietária) não está disponível aqui — não é um algoritmo documentado publicamente.`,
    });
  }
  return report;
}

export class AutoSamplerCancelledError extends Error {
  constructor() {
    super('Auto Sampler cancelado pelo usuário.');
    this.name = 'AutoSamplerCancelledError';
  }
}

/** Tamanho do buffer do ScriptProcessorNode — potência de 2 entre 256 e 16384 (único intervalo aceito pelo spec). 4096 é um bom equilíbrio entre overhead de callback e latência de resposta ao cancelamento. */
const CAPTURE_BUFFER_SIZE = 4096;
/** Sempre grava em 2 canais (ver `setupAudio`) — uma entrada mono é automaticamente upmixada pelo Web Audio ao conectar numa origem que pede 2 canais; mantém o pipeline de pós-processamento/exportação uniforme (não precisa decidir mono vs. estéreo em tempo de execução). */
const CAPTURE_CHANNELS = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Controla uma sessão de Auto Sampler do início (abrir MIDI+áudio) até o fim (montar .mrq/.sf2) — uma instância por execução. `cancel()` pode ser chamado de fora (ex.: botão "Cancelar" na UI) a qualquer momento; o cancelamento é verificado a cada ~100ms (nunca espera o sustain/release inteiro de uma nota em andamento) e sempre manda All Notes Off antes de encerrar. */
export class AutoSamplerSession {
  private cancelled = false;
  private midiOutput: MIDIOutput | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private recording = false;
  private recordedChunks: Float32Array[][] = [];
  /** `true` quando `setupAudio` tomou o caminho de loopback nativo (ver NATIVE_LOOPBACK_PREFIX) em vez de `getUserMedia` — muda o comportamento de `captureOneTask`/`teardownAudio` pros comandos Tauri `loopback_*` em vez do grafo Web Audio normal. */
  private usingNativeLoopback = false;
  private nativeLoopbackInfo: { sampleRateHz: number; channels: number } | null = null;

  cancel(): void {
    this.cancelled = true;
  }

  async run(options: AutoSamplerRunOptions, onProgress?: (p: AutoSamplerProgress) => void): Promise<AutoSamplerRunResult> {
    if (!options.outputs.mrq && !options.outputs.sf2) {
      throw new Error('escolha pelo menos um formato de saída (.mrq e/ou .sf2) antes de começar.');
    }
    const tasks = generateAutoSamplerTasks(options.config);
    if (tasks.length === 0) throw new Error('nenhuma nota/velocity/round-robin gerado — confira a configuração.');

    await this.setupMidi(options.midiOutputId);
    await this.setupAudio(options.audioInputDeviceId);

    const captured = new Map<string, { interleaved: Float32Array; sampleRateHz: number; channels: number }>();
    try {
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i];
        const raw = await this.captureOneTask(task, options);
        captured.set(task.id, raw);
        onProgress?.({ done: i + 1, total: tasks.length, currentTask: task, phase: 'capturing' });
      }
    } finally {
      this.panicAllNotesOff(options.midiChannel);
      this.teardownAudio();
    }

    const notes = [...new Set(tasks.map((t) => t.note))];
    const keyRanges = computeAutoSamplerKeyRanges(notes);

    const loopPoints = new Map<string, { loopStartFrame: number; loopEndFrame: number }>();
    if (options.config.autoLoop !== 'none') {
      for (const task of tasks) {
        const raw = captured.get(task.id);
        if (!raw) continue;
        const found = findLoopPoints(raw.interleaved, raw.channels, raw.sampleRateHz, options.config.autoLoopStartPct, options.config.autoLoopEndPct);
        if (!found) continue;
        // "Bake" o modo escolhido (Search/X-Fade/Rev X-Fade/Bidirectional)
        // DIRETO no áudio — ver bakeAutoLoop em autoSamplerEngine.ts. Faz os
        // dois formatos de saída (.mrq e SF2, que só sabe tocar loop
        // "forward" simples) soarem igual, sem depender de suporte nativo a
        // crossfade/loop bidirecional em nenhum dos dois players.
        const baked = bakeAutoLoop(raw.interleaved, raw.channels, raw.sampleRateHz, found, options.config.autoLoop);
        captured.set(task.id, { ...raw, interleaved: baked.interleaved });
        loopPoints.set(task.id, { loopStartFrame: baked.loopStartFrame, loopEndFrame: baked.loopEndFrame });
      }
    }

    let silentCaptureCount = 0;
    for (const raw of captured.values()) {
      if (isCaptureSilent(raw.interleaved)) silentCaptureCount += 1;
    }

    const result: AutoSamplerRunResult = { capturedCount: captured.size, silentCaptureCount };
    const lastTask = tasks[tasks.length - 1];

    if (options.outputs.mrq) {
      onProgress?.({ done: tasks.length, total: tasks.length, currentTask: lastTask, phase: 'building-mrq' });
      result.mrq = await buildMrqFromCaptures(options, tasks, keyRanges, captured, loopPoints);
    }
    if (options.outputs.sf2) {
      onProgress?.({ done: tasks.length, total: tasks.length, currentTask: lastTask, phase: 'building-sf2' });
      result.sf2Path = await buildSf2FromCaptures(options, tasks, keyRanges, captured, loopPoints);
    }
    return result;
  }

  private async setupMidi(outputId: string): Promise<void> {
    const access = await getMidiAccess();
    const output = access.outputs.get(outputId);
    if (!output) throw new Error('a porta MIDI de saída selecionada não foi encontrada — reabra o Auto Sampler e escolha de novo (pode ter sido desconectada).');
    this.midiOutput = output;
  }

  private async setupAudio(deviceId: string): Promise<void> {
    if (isNativeLoopbackDeviceId(deviceId)) {
      const deviceName = nativeLoopbackDeviceNameFromId(deviceId);
      const info = await invoke<{ sampleRateHz: number; channels: number; deviceName: string }>('loopback_start', { deviceName });
      this.usingNativeLoopback = true;
      this.nativeLoopbackInfo = { sampleRateHz: info.sampleRateHz, channels: info.channels };
      return;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // "Padrão do sistema" (ver SYSTEM_DEFAULT_AUDIO_INPUT_ID) não manda
        // restrição nenhuma de deviceId — deixa o SO escolher o dispositivo
        // de entrada padrão atual, em vez de travar num id específico que
        // pode nem existir mais (driver de loopback reinstalado, outra
        // porta USB, etc.).
        ...(deviceId === SYSTEM_DEFAULT_AUDIO_INPUT_ID ? {} : { deviceId: { exact: deviceId } }),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: CAPTURE_CHANNELS },
      },
    });
    this.audioCtx = new AudioContext();
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    // Ver comentário de CAPTURE_BUFFER_SIZE — ScriptProcessorNode é
    // formalmente depreciado (substituído por AudioWorklet) mas continua
    // implementado em toda engine de WebView usada pelo Tauri; usado aqui
    // de propósito porque a captura não é interativa em tempo real (nada
    // toca de volta "ao vivo" pro usuário — só acumula buffer), então a
    // latência/jitter que motivou a depreciação não afeta este uso.
    this.processorNode = this.audioCtx.createScriptProcessor(CAPTURE_BUFFER_SIZE, CAPTURE_CHANNELS, 1);
    this.silentGain = this.audioCtx.createGain();
    this.silentGain.gain.value = 0; // nunca solta o que foi gravado no alto-falante local — evita duplicar o som do Kontakt (que o usuário já ouve direto) e qualquer risco de realimentação.
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silentGain);
    this.silentGain.connect(this.audioCtx.destination);
  }

  private teardownAudio(): void {
    if (this.usingNativeLoopback) {
      this.usingNativeLoopback = false;
      this.nativeLoopbackInfo = null;
      // Fire-and-forget de propósito: se a sessão nativa já caiu sozinha
      // (ex.: dispositivo desconectado no meio da captura) não há nada de
      // útil a fazer aqui além de tentar limpar o estado do lado Rust —
      // nunca deixa um erro de "parar" mascarar o resultado de verdade da
      // sessão (que já terminou de capturar quando chegamos aqui).
      invoke('loopback_stop').catch(() => {
        /* ver comentário acima. */
      });
      return;
    }
    try {
      this.processorNode?.disconnect();
    } catch {
      /* nó já pode estar desconectado — não é um erro que importa aqui. */
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* idem. */
    }
    try {
      this.silentGain?.disconnect();
    } catch {
      /* idem. */
    }
    if (this.processorNode) this.processorNode.onaudioprocess = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close().catch(() => {});
    this.processorNode = null;
    this.sourceNode = null;
    this.silentGain = null;
    this.stream = null;
    this.audioCtx = null;
  }

  private panicAllNotesOff(channel: number): void {
    if (!this.midiOutput) return;
    const ch = channel & 0x0f;
    try {
      this.midiOutput.send([0xb0 | ch, 123, 0]); // All Notes Off
      this.midiOutput.send([0xb0 | ch, 120, 0]); // All Sound Off
    } catch {
      /* a porta pode já ter sido desconectada no meio da sessão — nunca deixa isso mascarar o erro original do caller. */
    }
  }

  /** Espera `ms` verificando cancelamento a cada 100ms (nunca trava o botão "Cancelar" esperando o sustain/release inteiro da nota atual). */
  private async cancellableDelay(ms: number): Promise<void> {
    const stepMs = 100;
    let elapsed = 0;
    while (elapsed < ms) {
      if (this.cancelled) throw new AutoSamplerCancelledError();
      const step = Math.min(stepMs, ms - elapsed);
      await delay(step);
      elapsed += step;
    }
  }

  private async captureOneTask(
    task: AutoSamplerTask,
    options: AutoSamplerRunOptions
  ): Promise<{ interleaved: Float32Array; sampleRateHz: number; channels: number }> {
    if (this.usingNativeLoopback) return this.captureOneTaskNative(task, options);
    if (!this.processorNode || !this.midiOutput || !this.audioCtx) {
      throw new Error('sessão de Auto Sampler não inicializada corretamente (MIDI/áudio).');
    }
    if (this.cancelled) throw new AutoSamplerCancelledError();

    this.recordedChunks = [];
    this.recording = true;
    this.processorNode.onaudioprocess = (ev) => {
      if (!this.recording) return;
      const chunk: Float32Array[] = [];
      for (let c = 0; c < ev.inputBuffer.numberOfChannels; c += 1) chunk.push(ev.inputBuffer.getChannelData(c).slice());
      this.recordedChunks.push(chunk);
    };

    const channel = options.midiChannel & 0x0f;
    try {
      this.midiOutput.send([0x90 | channel, task.note, task.velocity]);
      await this.cancellableDelay(options.config.sustainSeconds * 1000);
      this.midiOutput.send([0x80 | channel, task.note, 0]);
      await this.cancellableDelay(options.config.releaseTailSeconds * 1000);
    } finally {
      this.recording = false;
      this.processorNode.onaudioprocess = null;
    }

    await this.cancellableDelay(INTER_TASK_GAP_SECONDS * 1000);

    const channelCount = this.recordedChunks[0]?.length ?? CAPTURE_CHANNELS;
    const totalFrames = this.recordedChunks.reduce((acc, chunk) => acc + (chunk[0]?.length ?? 0), 0);
    const interleaved = new Float32Array(totalFrames * channelCount);
    let frameOffset = 0;
    for (const chunk of this.recordedChunks) {
      const frames = chunk[0]?.length ?? 0;
      for (let f = 0; f < frames; f += 1) {
        for (let c = 0; c < channelCount; c += 1) interleaved[(frameOffset + f) * channelCount + c] = chunk[c][f];
      }
      frameOffset += frames;
    }
    this.recordedChunks = [];

    let processed = applyGainDb(interleaved, options.inputGainDb);
    processed = trimLeadingSilence(processed, channelCount);
    if (options.config.oneShot) processed = trimTrailingSilence(processed, channelCount);

    return { interleaved: processed, sampleRateHz: this.audioCtx.sampleRate, channels: channelCount };
  }

  /** Mesmo papel/timing de `captureOneTask`, só que pelo caminho de loopback nativo (ver NATIVE_LOOPBACK_PREFIX/setupAudio) — "gravar" vira `loopback_set_recording(true/false)` em volta do mesmo note-on/sustain/note-off/release por MIDI, e o buffer acumulado do lado Rust (não um `ScriptProcessorNode`) é drenado no final via `loopback_take_recorded`, já intercalado (o Rust acumula `&[f32]` intercalado igual o `Data`/`InputCallbackInfo` do cpal entrega), então não precisa do laço de "desintercalar por canal" que o caminho getUserMedia usa. */
  private async captureOneTaskNative(
    task: AutoSamplerTask,
    options: AutoSamplerRunOptions
  ): Promise<{ interleaved: Float32Array; sampleRateHz: number; channels: number }> {
    if (!this.midiOutput || !this.nativeLoopbackInfo) {
      throw new Error('sessão de Auto Sampler não inicializada corretamente (MIDI/loopback nativo).');
    }
    if (this.cancelled) throw new AutoSamplerCancelledError();

    await invoke('loopback_set_recording', { recording: true });

    const channel = options.midiChannel & 0x0f;
    try {
      this.midiOutput.send([0x90 | channel, task.note, task.velocity]);
      await this.cancellableDelay(options.config.sustainSeconds * 1000);
      this.midiOutput.send([0x80 | channel, task.note, 0]);
      await this.cancellableDelay(options.config.releaseTailSeconds * 1000);
    } finally {
      await invoke('loopback_set_recording', { recording: false }).catch(() => {
        /* se a sessão nativa já caiu sozinha, não há nada de útil a fazer aqui — o erro de verdade (se houver) já veio do bloco try acima. */
      });
    }

    await this.cancellableDelay(INTER_TASK_GAP_SECONDS * 1000);

    const samples = await invoke<number[]>('loopback_take_recorded');
    const channelCount = this.nativeLoopbackInfo.channels;
    const interleaved = Float32Array.from(samples);

    let processed = applyGainDb(interleaved, options.inputGainDb);
    processed = trimLeadingSilence(processed, channelCount);
    if (options.config.oneShot) processed = trimTrailingSilence(processed, channelCount);

    return { interleaved: processed, sampleRateHz: this.nativeLoopbackInfo.sampleRateHz, channels: channelCount };
  }
}

// ---------------------------------------------------------------------------
// Montagem dos arquivos finais a partir do que foi capturado — funções
// soltas (não precisam de `this`) pra ficar claro que não dependem de
// estado de sessão nenhum, só dos dados já em mãos.
// ---------------------------------------------------------------------------

type CapturedAudio = { interleaved: Float32Array; sampleRateHz: number; channels: number };
type LoopPointsById = Map<string, { loopStartFrame: number; loopEndFrame: number }>;

/** Monta a lista de `MrqZone` + o `MrqInstrumentModel` a partir das tarefas geradas e das faixas de tecla já calculadas — PURO (sem I/O), testável em `node` (ver scripts/test-auto-sampler.mjs) mesmo sem nenhum dado de áudio de verdade (`captured`/`loopPoints` só decidem `loopEnabled`/`loopStart`/`loopEnd`, a forma das zonas em si não depende do conteúdo do áudio). */
export function buildAutoSamplerMrqModel(
  instrumentName: string,
  tasks: AutoSamplerTask[],
  keyRanges: Map<number, { loKey: number; hiKey: number }>,
  loopPoints: LoopPointsById
): MrqInstrumentModel {
  const zones: MrqZone[] = tasks.map((task) => {
    const kr = keyRanges.get(task.note) ?? { loKey: 0, hiKey: 127 };
    const loop = loopPoints.get(task.id);
    const zone: MrqZone = {
      sampleId: task.id,
      rootNote: task.note,
      loKey: kr.loKey,
      hiKey: kr.hiKey,
      loVel: task.loVel,
      hiVel: task.hiVel,
      roundRobinGroup: task.roundRobinGroup,
      roundRobinIndex: task.roundRobinGroup ? task.roundRobinIndex : undefined,
      tuneCents: 0,
      volumeDb: 0,
      pan: 0,
    };
    if (loop) {
      zone.loopEnabled = true;
      zone.loopStart = loop.loopStartFrame;
      zone.loopEnd = loop.loopEndFrame;
    }
    return zone;
  });

  return {
    name: instrumentName,
    // Reaproveita a MESMA categoria de proveniência do "Kontakt Audio
    // Capture" manual (ver kontaktCapture.ts) — as duas telas nunca leem o
    // .nki original, só áudio já renderizado/soado pelo Kontakt do usuário.
    sourceFormat: 'kontakt-capture',
    importedAt: new Date().toISOString(),
    presets: [{ id: 'preset-0', name: instrumentName, groups: [{ id: 'group-0', name: 'Auto Sampler', zones }] }],
  };
}

/** Monta a lista de `Sf2ExportZone` a partir das tarefas + áudio já capturado + faixas de tecla/loop — PURO exceto por receber os buffers de áudio já prontos (não faz nenhuma chamada de I/O aqui dentro); testável com buffers sintéticos.
 *
 * LIMITAÇÃO CONHECIDA (round robin + SF2): o formato SoundFont 2 não tem
 * nenhum mecanismo nativo de "alternar entre variações" — diferente do
 * `.mrq` (onde o Rack escolhe de verdade uma variação por vez, ver
 * `roundRobinGroup`/`roundRobinIndex` em `MrqZone`), aqui cada variação de
 * round robin vira uma zona SF2 INDEPENDENTE e totalmente sobreposta
 * (mesma `loKey`/`hiKey`/`loVel`/`hiVel`) — a maioria dos sintetizadores
 * SF2 vai tocar TODAS elas ao mesmo tempo quando a tecla for pressionada
 * (empilhadas, não alternadas), em vez de escolher uma por vez. Isso é
 * avisado ao usuário (ver AutoSamplerDialog.tsx) quando Round Robin > 1 e
 * a saída SF2 está marcada — não é um bug deste exportador, é uma
 * limitação real e documentada do formato SF2 em si. */
export function buildAutoSamplerSf2Zones(
  tasks: AutoSamplerTask[],
  keyRanges: Map<number, { loKey: number; hiKey: number }>,
  captured: Map<string, CapturedAudio>,
  loopPoints: LoopPointsById
): Sf2ExportZone[] {
  return tasks
    .map((task) => {
      const raw = captured.get(task.id);
      if (!raw) return null;
      const kr = keyRanges.get(task.note) ?? { loKey: 0, hiKey: 127 };
      const loop = loopPoints.get(task.id);
      const zone: Sf2ExportZone = {
        label: `n${task.note}v${task.velocityLayerIndex}`,
        rootNote: task.note,
        loKey: kr.loKey,
        hiKey: kr.hiKey,
        loVel: task.loVel,
        hiVel: task.hiVel,
        interleaved: raw.interleaved,
        sampleRateHz: raw.sampleRateHz,
        channels: raw.channels === 1 ? 1 : 2,
        loopStartFrame: loop?.loopStartFrame,
        loopEndFrame: loop?.loopEndFrame,
      };
      return zone;
    })
    .filter((z): z is Sf2ExportZone => z !== null);
}

async function buildMrqFromCaptures(
  options: AutoSamplerRunOptions,
  tasks: AutoSamplerTask[],
  keyRanges: Map<number, { loKey: number; hiKey: number }>,
  captured: Map<string, CapturedAudio>,
  loopPoints: LoopPointsById
): Promise<AutoSamplerMrqOutput> {
  const instrument = buildAutoSamplerMrqModel(options.instrumentName, tasks, keyRanges, loopPoints);

  const sessionId = await mrqBuilderBegin(options.outputs.mrq!.destPath, instrument);
  try {
    for (const task of tasks) {
      const raw = captured.get(task.id);
      if (!raw) continue;
      await mrqBuilderAddSample(sessionId, task.id, { kind: 'float32', interleaved: raw.interleaved }, raw.sampleRateHz, raw.channels);
    }
  } catch (err) {
    await mrqBuilderAbort(sessionId).catch(() => {
      /* já estamos no caminho de erro — não deixa um segundo erro esconder o primeiro. */
    });
    throw err;
  }
  const finish = await mrqBuilderFinish(sessionId);
  const metadata = await mrqReadMetadata(finish.path);
  const compatibility = buildAutoSamplerCompatibilityReport(options.config);
  return { finish, instrument, compatibility, metadata };
}

async function buildSf2FromCaptures(
  options: AutoSamplerRunOptions,
  tasks: AutoSamplerTask[],
  keyRanges: Map<number, { loKey: number; hiKey: number }>,
  captured: Map<string, CapturedAudio>,
  loopPoints: LoopPointsById
): Promise<string> {
  const zones = buildAutoSamplerSf2Zones(tasks, keyRanges, captured, loopPoints);
  const bytes = buildSf2Binary(zones, { instrumentName: options.instrumentName });
  await writeFile(options.outputs.sf2!.destPath, bytes);
  return options.outputs.sf2!.destPath;
}
