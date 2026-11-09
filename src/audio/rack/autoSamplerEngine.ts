/**
 * Núcleo PURO (sem I/O, sem Tauri, sem Web MIDI/Web Audio) do "Auto Sampler"
 * do MRQ Instrument Converter — a tela que toca automaticamente as notas de
 * um instrumento Kontakt (ou qualquer fonte MIDI+áudio externa) e grava o
 * resultado pra montar um instrumento multisample, no mesmo espírito do
 * "Auto Sampler" do Logic Pro (ver documentação da Apple em
 * support.apple.com/guide/logicpro/auto-sampler-controls-lgced6eded3c/mac e
 * o guia da Berklee College of Music sobre uso com hardware externo).
 *
 * Este módulo só decide O QUÊ gravar (lista de notas/velocidades/round
 * robins a partir da configuração) e como PROCESSAR o áudio já capturado
 * (corte de silêncio, ganho, detecção de pontos de loop) — nunca manda MIDI
 * nem grava áudio de verdade (isso é `autoSampler.ts`, que faz I/O real via
 * Web MIDI/Web Audio e depois chama as funções puras daqui). Separação
 * deliberada pro mesmo motivo de sempre neste projeto: a parte pura é
 * testável com `node` sem precisar de hardware nenhum
 * (scripts/test-auto-sampler-engine.mjs).
 *
 * Curvas de velocity (Exp1-3/Log1-3): a Apple não documenta publicamente a
 * fórmula exata usada pelo Auto Sampler real — só descreve o EFEITO
 * ("Exp: zonas menores perto da velocity alta"; "Log: zonas menores perto
 * da velocity baixa"). A implementação abaixo usa uma curva de potência
 * simples que reproduz esse efeito qualitativo (mais pontos de quebra perto
 * do extremo relevante), mas não é uma cópia bit-a-bit do algoritmo da
 * Apple — isso é impossível sem o código-fonte deles. Documentado aqui pra
 * não criar a falsa impressão de paridade exata.
 */

import { computeAutoKeyRanges } from './kontaktCapture';

// ---------------------------------------------------------------------------
// Configuração + estimativa (usada tanto pra gerar as tarefas de verdade
// quanto pra mostrar "isso vai gerar N arquivos, ~M minutos" antes de
// começar — mesma ideia do painel "Estimate the job before you press
// Sample" dos guias de uso do Auto Sampler).
// ---------------------------------------------------------------------------

export type VelocityResponseCurve = 'linear' | 'exp1' | 'exp2' | 'exp3' | 'log1' | 'log2' | 'log3' | 'custom';

/** Mesma lista (e mesma ordem) do Auto Sampler do Logic Pro — ver
 *  support.apple.com/guide/logicpro/auto-sampler-controls e o artigo da
 *  Sound On Sound (soundonsound.com/techniques/logic-using-auto-sampler):
 *  "Search" (corte seco no ponto mais parecido, sem crossfade), "Search
 *  With X-Fade" (mesma busca, mas cruza o fim com o início pra suavizar a
 *  emenda), "Search With Rev X-Fade" (cruza com uma cópia invertida no
 *  tempo, preserva mais o timbre do decaimento natural do que um crossfade
 *  comum), e "Bidirectional" (toca o loop alternando pra frente/pra trás —
 *  aqui conseguido GRAVANDO o trecho pra frente seguido do mesmo trecho
 *  invertido como UM loop só, que soa igual ao verdadeiro ping-pong quando
 *  tocado em loop simples pra frente, sem exigir nenhum player com suporte
 *  a loop bidirecional de verdade).
 *
 *  "Penrose Machine" (ressíntese proprietária da Apple/Redmatica) NÃO está
 *  implementado — não é um algoritmo documentado publicamente, reproduzi-lo
 *  de verdade exigiria engenharia reversa de um produto comercial fechado.
 *  Aparece na UI como opção desabilitada, com essa explicação, em vez de
 *  ser escondido (mesma política de transparência do resto do projeto:
 *  nunca fingir que algo foi implementado quando não foi). */
export type AutoLoopMode = 'none' | 'search' | 'search-xfade' | 'search-rev-xfade' | 'bidirectional';

export interface AutoSamplerConfig {
  /** Nota MIDI mais grave a amostrar (convenção C3=60, igual ao resto do app — ver midiNoteNames.ts). */
  rangeStartNote: number;
  /** Nota MIDI mais aguda a amostrar (inclusive, se cair exatamente num múltiplo de sampleEverySemitones). */
  rangeEndNote: number;
  /** Intervalo em semitons entre notas gravadas — 1 = cromático (grava toda tecla), valores maiores pulam teclas (preenchidas depois por pitch-shift, igual a qualquer sampler). */
  sampleEverySemitones: number;
  /** Quantas camadas de velocity gravar (1 = patch sem variação de timbre por velocity). */
  velocityLayers: number;
  velocityResponse: VelocityResponseCurve;
  /** Só usado quando velocityResponse === 'custom' — pontos de quebra 0-127 em ordem crescente, length === velocityLayers + 1 (primeiro sempre 0, último sempre 127). */
  customVelocityBreakpoints?: number[];
  /** Quantas variações gravar por nota+velocity (1 = sem round robin). */
  roundRobinCount: number;
  /** Duração em segundos que a nota fica pressionada antes do note-off. */
  sustainSeconds: number;
  /** Quanto tempo gravar DEPOIS do note-off, pra capturar a cauda de release. */
  releaseTailSeconds: number;
  autoLoop: AutoLoopMode;
  /** % (0-100) da amostra (contada a partir do início do sustain) onde a busca de loop pode COMEÇAR. */
  autoLoopStartPct: number;
  /** % (0-100) onde a busca de loop pode TERMINAR. */
  autoLoopEndPct: number;
  /** Corta a amostra assim que o nível cai abaixo do limiar de silêncio em vez de manter sustain+release inteiro — pra percussão/sons curtos (ver "Sustain field" na doc da Apple: "Percussion ... are shortened after sampling if the end contains complete silence"). */
  oneShot: boolean;
}

export interface VelocityLayerPlan {
  /** Índice 0-based da camada, da mais grave pra mais aguda. */
  index: number;
  /** Velocity MIDI (1-127) realmente enviada ao instrumento pra essa camada. */
  sampleVelocity: number;
  /** Faixa de velocity (inclusive nos dois lados) que esta camada cobre no instrumento final. */
  loVel: number;
  hiVel: number;
}

const MIN_VEL = 1;
const MAX_VEL = 127;

function clampVel(v: number): number {
  return Math.max(MIN_VEL, Math.min(MAX_VEL, Math.round(v)));
}

/** Gamma da curva de potência usada por cada resposta (ver comentário de topo sobre a aproximação). Exp* (<1): zonas mais estreitas perto do topo. Log* (>1): zonas mais estreitas perto da base. */
const RESPONSE_GAMMA: Record<Exclude<VelocityResponseCurve, 'linear' | 'custom'>, number> = {
  exp1: 0.66,
  exp2: 0.45,
  exp3: 0.3,
  log1: 1.5,
  log2: 2.2,
  log3: 3.2,
};

/** Calcula os pontos de quebra (length === layers+1, 0..127) pra uma curva dada. */
export function computeVelocityBreakpoints(layers: number, response: VelocityResponseCurve, custom?: number[]): number[] {
  const n = Math.max(1, Math.floor(layers));
  if (response === 'custom') {
    if (!custom || custom.length !== n + 1) {
      throw new Error(`velocityResponse 'custom' precisa de exatamente ${n + 1} pontos de quebra (recebeu ${custom?.length ?? 0}).`);
    }
    for (let i = 1; i < custom.length; i += 1) {
      if (custom[i] <= custom[i - 1]) throw new Error('pontos de quebra customizados precisam ser estritamente crescentes.');
    }
    return custom.slice();
  }
  const breakpoints: number[] = [];
  const gamma = response === 'linear' ? 1 : RESPONSE_GAMMA[response];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const shaped = gamma === 1 ? t : Math.pow(t, gamma);
    breakpoints.push(Math.round(shaped * 127));
  }
  breakpoints[0] = 0;
  breakpoints[n] = 127;
  // Garante estritamente crescente mesmo com arredondamento em curvas extremas
  // (nunca deixa duas camadas colidirem na mesma velocity) — empurra pra
  // frente qualquer empate, preservando a ordem e o teto de 127.
  for (let i = 1; i < breakpoints.length; i += 1) {
    if (breakpoints[i] <= breakpoints[i - 1]) breakpoints[i] = breakpoints[i - 1] + 1;
  }
  if (breakpoints[breakpoints.length - 1] > 127) {
    throw new Error(`${n} camadas de velocity não cabem em 0-127 com essa curva — reduza o número de camadas.`);
  }
  return breakpoints;
}

/** Monta o plano de camadas de velocity (faixa + velocity MIDI representativa, enviada de verdade na captura) a partir da config. A velocity enviada é o PONTO MÉDIO de cada faixa (arredondado), igual à convenção descrita nos guias de uso do Auto Sampler pra curvas Custom. */
export function computeVelocityLayers(layers: number, response: VelocityResponseCurve, custom?: number[]): VelocityLayerPlan[] {
  const breakpoints = computeVelocityBreakpoints(layers, response, custom);
  const plans: VelocityLayerPlan[] = [];
  for (let i = 0; i < breakpoints.length - 1; i += 1) {
    const loVel = clampVel(i === 0 ? MIN_VEL : breakpoints[i] + 1);
    const hiVel = clampVel(breakpoints[i + 1]);
    const sampleVelocity = clampVel((loVel + hiVel) / 2);
    plans.push({ index: i, loVel: Math.min(loVel, hiVel), hiVel: Math.max(loVel, hiVel), sampleVelocity });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Geração das tarefas de captura — nota x camada de velocity x round robin.
// ---------------------------------------------------------------------------

export interface AutoSamplerTask {
  /** Identificador estável — usado como `sampleId` no .mrq/zona do SF2. */
  id: string;
  note: number;
  velocityLayerIndex: number;
  /** Velocity MIDI enviada de verdade ao tocar esta tarefa. */
  velocity: number;
  loVel: number;
  hiVel: number;
  roundRobinIndex: number;
  /** Só definido quando roundRobinCount > 1 — agrupa as variações desta nota+velocity pra tocarem alternadas, igual ao resto do conversor (ver computeAutoVelocityAndRoundRobin em kontaktCapture.ts). */
  roundRobinGroup?: string;
}

function validateConfig(config: AutoSamplerConfig): void {
  if (config.rangeEndNote < config.rangeStartNote) throw new Error('Range End precisa ser >= Range Start.');
  if (config.sampleEverySemitones < 1) throw new Error('Sample Every precisa ser pelo menos 1 semitom.');
  if (config.velocityLayers < 1) throw new Error('precisa de pelo menos 1 camada de velocity.');
  if (config.roundRobinCount < 1) throw new Error('Round Robin precisa ser pelo menos 1 (sem round robin = 1).');
  if (config.sustainSeconds <= 0) throw new Error('Sustain precisa ser maior que zero.');
  if (config.releaseTailSeconds < 0) throw new Error('Release tail não pode ser negativo.');
  if (config.autoLoop !== 'none') {
    if (config.autoLoopStartPct < 0 || config.autoLoopStartPct >= config.autoLoopEndPct || config.autoLoopEndPct > 100) {
      throw new Error('Auto Loop Start/End precisam satisfazer 0 <= start < end <= 100.');
    }
  }
}

/** Lista as notas MIDI que serão de fato tocadas/gravadas (sem velocity/round robin ainda) — início inclusive, step fixo, descarta o resto final que não cai num múltiplo exato (mesma convenção dos guias de uso: "A C2–C6 range ... sampling every three semitones gives about 17 sampled notes", não arredonda pra incluir a última nota fora do passo). */
export function listSampledNotes(config: Pick<AutoSamplerConfig, 'rangeStartNote' | 'rangeEndNote' | 'sampleEverySemitones'>): number[] {
  const notes: number[] = [];
  for (let n = config.rangeStartNote; n <= config.rangeEndNote; n += config.sampleEverySemitones) notes.push(n);
  return notes;
}

export function generateAutoSamplerTasks(config: AutoSamplerConfig): AutoSamplerTask[] {
  validateConfig(config);
  const notes = listSampledNotes(config);
  const velocityLayers = computeVelocityLayers(config.velocityLayers, config.velocityResponse, config.customVelocityBreakpoints);
  const tasks: AutoSamplerTask[] = [];
  for (const note of notes) {
    for (const layer of velocityLayers) {
      const rrGroup = config.roundRobinCount > 1 ? `rr-n${note}-v${layer.index}` : undefined;
      for (let rr = 0; rr < config.roundRobinCount; rr += 1) {
        tasks.push({
          id: `n${note}-v${layer.index}-rr${rr}`,
          note,
          velocityLayerIndex: layer.index,
          velocity: layer.sampleVelocity,
          loVel: layer.loVel,
          hiVel: layer.hiVel,
          roundRobinIndex: rr,
          roundRobinGroup: rrGroup,
        });
      }
    }
  }
  return tasks;
}

export interface AutoSamplerEstimate {
  sampledNoteCount: number;
  velocityLayerCount: number;
  totalCaptures: number;
  /** Segundos por captura (sustain + release tail + um pequeno intervalo entre notas). */
  perCaptureSeconds: number;
  estimatedTotalSeconds: number;
}

/** Intervalo de silêncio entre uma captura e a próxima, pra garantir que o release de uma nota não vaze na gravação da seguinte (mesmo motivo que qualquer auto sampler de verdade espera entre notas). */
export const INTER_TASK_GAP_SECONDS = 0.35;

export function estimateAutoSamplerPlan(config: AutoSamplerConfig): AutoSamplerEstimate {
  validateConfig(config);
  const notes = listSampledNotes(config);
  const perCaptureSeconds = config.sustainSeconds + config.releaseTailSeconds + INTER_TASK_GAP_SECONDS;
  const totalCaptures = notes.length * config.velocityLayers * config.roundRobinCount;
  return {
    sampledNoteCount: notes.length,
    velocityLayerCount: config.velocityLayers,
    totalCaptures,
    perCaptureSeconds,
    estimatedTotalSeconds: totalCaptures * perCaptureSeconds,
  };
}

/** Faixa de teclado (loKey/hiKey) de cada nota amostrada, preenchendo o teclado inteiro (0-127) nos pontos médios entre notas vizinhas — reaproveita a MESMA função já usada pelo Kontakt Audio Capture pra mapeamento manual (computeAutoKeyRanges), só que aqui a entrada já vem com nota exata conhecida (nenhuma heurística de nome de arquivo envolvida). */
export function computeAutoSamplerKeyRanges(notes: number[]): Map<number, { loKey: number; hiKey: number }> {
  const unique = [...new Set(notes)];
  const input = unique.map((n) => ({ id: String(n), group: 'auto-sampler', rootNote: n }));
  const byId = computeAutoKeyRanges(input);
  const result = new Map<number, { loKey: number; hiKey: number }>();
  for (const n of unique) {
    const r = byId.get(String(n));
    if (r) result.set(n, r);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pós-processamento de áudio já capturado — tudo em PCM Float32 intercalado
// (mesmo formato que `mrqBuilderAddSample` já aceita, ver mrqFormat.ts), sem
// nenhuma dependência de Web Audio/Tauri (recebe o buffer já pronto).
// ---------------------------------------------------------------------------

export function applyGainDb(interleaved: Float32Array, db: number): Float32Array {
  if (db === 0) return interleaved;
  const gain = Math.pow(10, db / 20);
  const out = new Float32Array(interleaved.length);
  for (let i = 0; i < interleaved.length; i += 1) out[i] = Math.max(-1, Math.min(1, interleaved[i] * gain));
  return out;
}

/** Amplitude de pico (0..1) dentro de um frame (todos os canais), usada pelas funções de corte de silêncio abaixo. */
function frameAbsMax(interleaved: Float32Array, channels: number, frame: number): number {
  let max = 0;
  const base = frame * channels;
  for (let c = 0; c < channels; c += 1) max = Math.max(max, Math.abs(interleaved[base + c]));
  return max;
}

/** Remove silêncio do INÍCIO (até o primeiro frame acima do limiar), preservando `keepBeforeFrames` frames antes dele como "ataque" (nunca corta em cima do próprio transiente). Devolve o buffer já realinhado — se tudo for silêncio, devolve o buffer original sem alteração (nunca gera uma amostra vazia por engano). */
export function trimLeadingSilence(
  interleaved: Float32Array,
  channels: number,
  thresholdLinear = 0.003,
  keepBeforeFrames = 8
): Float32Array {
  const frameCount = interleaved.length / channels;
  let firstLoud = -1;
  for (let f = 0; f < frameCount; f += 1) {
    if (frameAbsMax(interleaved, channels, f) >= thresholdLinear) {
      firstLoud = f;
      break;
    }
  }
  if (firstLoud <= 0) return interleaved;
  const start = Math.max(0, firstLoud - keepBeforeFrames);
  if (start === 0) return interleaved;
  return interleaved.slice(start * channels);
}

/** Remove silêncio do FIM (depois do último frame acima do limiar), preservando `keepAfterFrames` de cauda — usado só quando `oneShot` está marcado (percussão/sons curtos; ver AutoSamplerConfig.oneShot). */
export function trimTrailingSilence(
  interleaved: Float32Array,
  channels: number,
  thresholdLinear = 0.003,
  keepAfterFrames = 2205 // 50ms @ 44.1kHz de cauda extra, suficiente pra não cortar em cima de uma reverberação curta
): Float32Array {
  const frameCount = interleaved.length / channels;
  let lastLoud = -1;
  for (let f = frameCount - 1; f >= 0; f -= 1) {
    if (frameAbsMax(interleaved, channels, f) >= thresholdLinear) {
      lastLoud = f;
      break;
    }
  }
  if (lastLoud < 0 || lastLoud >= frameCount - 1) return interleaved;
  const end = Math.min(frameCount, lastLoud + 1 + keepAfterFrames);
  if (end >= frameCount) return interleaved;
  return interleaved.slice(0, end * channels);
}

// ---------------------------------------------------------------------------
// Detecção automática de pontos de loop ("Auto Loop" / modo "Search" — ver
// comentário de AutoLoopMode). Algoritmo: 1) estima o período fundamental
// por autocorrelação normalizada dentro da janela pedida; 2) dado esse
// período, varre posições candidatas de início de loop procurando o ponto
// onde a descontinuidade (diferença entre a vizinhança do fim do loop e a
// vizinhança do início) é mínima; 3) ajusta pro zero-crossing mais próximo
// com a mesma inclinação, pra suavizar ainda mais a emenda.
// ---------------------------------------------------------------------------

export interface LoopPointResult {
  loopStartFrame: number;
  loopEndFrame: number;
  /** Diferença RMS normalizada na emenda (0 = perfeita, quanto menor melhor) — só informativo, pra UI/testes. */
  discontinuity: number;
}

/** Mixagem mono (média dos canais) só pra análise — os pontos de loop encontrados se aplicam a TODOS os canais do buffer original. */
function toMonoEnvelope(interleaved: Float32Array, channels: number): Float32Array {
  if (channels === 1) return interleaved;
  const frameCount = interleaved.length / channels;
  const mono = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += interleaved[f * channels + c];
    mono[f] = sum / channels;
  }
  return mono;
}

function sampleAt(interleaved: Float32Array, channels: number, frame: number, channel: number): number {
  return interleaved[frame * channels + channel];
}

export function findLoopPoints(
  interleaved: Float32Array,
  channels: number,
  sampleRateHz: number,
  searchStartPct: number,
  searchEndPct: number
): LoopPointResult | null {
  const frameCount = Math.floor(interleaved.length / channels);
  const winStart = Math.floor((searchStartPct / 100) * frameCount);
  const winEnd = Math.floor((searchEndPct / 100) * frameCount);
  const minLag = Math.max(8, Math.floor(sampleRateHz / 2000)); // ~2kHz (período mais curto que vale a pena procurar)
  const maxLag = Math.floor(sampleRateHz / 40); // ~40Hz (período mais longo — abaixo disso não cabe janela suficiente em notas curtas)
  if (winEnd - winStart < maxLag * 2) return null; // janela pequena demais pra conter 2 ciclos do período mais longo buscado

  const mono = toMonoEnvelope(interleaved, channels);

  // 1) autocorrelação normalizada pra achar o período dominante dentro da janela.
  const analysisLen = Math.min(winEnd - winStart, sampleRateHz * 2); // no máx. 2s de análise, suficiente e barato
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= Math.min(maxLag, analysisLen - 1); lag += 1) {
    let num = 0;
    let denomA = 0;
    let denomB = 0;
    const count = analysisLen - lag;
    for (let i = 0; i < count; i += 1) {
      const a = mono[winStart + i];
      const b = mono[winStart + i + lag];
      num += a * b;
      denomA += a * a;
      denomB += b * b;
    }
    const denom = Math.sqrt(denomA * denomB);
    const score = denom > 1e-9 ? num / denom : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestScore < 0.1) return null; // sinal sem periodicidade clara o suficiente nessa janela (ex.: ruído/transiente)

  // 2) varre posições candidatas de início de loop (passo de alguns frames pra manter o custo baixo em notas longas) procurando a menor descontinuidade de emenda.
  const neighborhood = 24; // frames comparados de cada lado da emenda
  const step = Math.max(1, Math.floor(bestLag / 32));
  let bestStart = -1;
  let bestCost = Infinity;
  for (let start = winStart; start + bestLag + neighborhood < winEnd; start += step) {
    const end = start + bestLag;
    let cost = 0;
    for (let k = -neighborhood; k < neighborhood; k += 1) {
      const a = mono[start + k] ?? 0;
      const b = mono[end + k] ?? 0;
      cost += (a - b) * (a - b);
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestStart = start;
    }
  }
  if (bestStart < 0) return null;

  // 3) ajusta pro zero-crossing ascendente mais próximo (dentro de +-bestLag/8), igual nos dois pontos, pra suavizar ainda mais.
  function snapToZeroCrossing(frame: number, maxShift: number): number {
    for (let shift = 0; shift <= maxShift; shift += 1) {
      for (const candidate of [frame + shift, frame - shift]) {
        if (candidate <= 0 || candidate >= mono.length - 1) continue;
        if (mono[candidate] <= 0 && mono[candidate + 1] > 0) return candidate;
      }
    }
    return frame;
  }
  const snapShift = Math.max(1, Math.floor(bestLag / 8));
  const loopStartFrame = snapToZeroCrossing(bestStart, snapShift);
  const loopEndFrame = loopStartFrame + bestLag;

  const rms = Math.sqrt(bestCost / (neighborhood * 2)) || 0;
  let peak = 0;
  for (let i = winStart; i < winEnd; i += 1) peak = Math.max(peak, Math.abs(mono[i]));
  const discontinuity = peak > 1e-6 ? rms / peak : rms;

  return { loopStartFrame, loopEndFrame, discontinuity };
}

// ---------------------------------------------------------------------------
// "Bake" do modo de Auto Loop escolhido — transforma o ponto de loop seco
// encontrado por `findLoopPoints` (sempre um corte duro, modo "Search") no
// resultado que os outros modos do Logic produzem, mas gravando o efeito
// DIRETO no áudio em vez de depender de o player (Rack/SF2) suportar
// crossfade ou loop bidirecional nativamente — assim os dois formatos de
// saída (.mrq e SF2) soam igual, mesmo o SF2 só suportando loop "forward"
// simples. Ver comentário de `AutoLoopMode` pra que cada modo representa.
// ---------------------------------------------------------------------------

export interface BakedLoop {
  interleaved: Float32Array;
  loopStartFrame: number;
  loopEndFrame: number;
}

/** Curva de crossfade de potência constante (equal-power) — mesma curva usada em qualquer crossfade de áudio decente, evita o "buraco" de volume no meio de um crossfade linear comum. */
function equalPowerCrossfade(t: number): { fadeOut: number; fadeIn: number } {
  const angle = t * (Math.PI / 2);
  return { fadeOut: Math.cos(angle), fadeIn: Math.sin(angle) };
}

/** "Search With X-Fade": funde os últimos `xfadeFrames` antes de `loopEndFrame`
 *  com os `xfadeFrames` que vêm logo depois de `loopStartFrame` — a região
 *  final do loop passa a já conter uma mistura suave do começo do loop, então
 *  quando o player faz o corte seco de volta pro `loopStartFrame`, a emenda
 *  já foi pré-suavizada no próprio áudio (técnica padrão de "pre-blended
 *  crossfade loop", funciona em qualquer player, mesmo sem suporte nativo a
 *  crossfade de loop). */
function bakeSearchXfade(interleaved: Float32Array, channels: number, loop: LoopPointResult, xfadeFrames: number): BakedLoop {
  const out = interleaved.slice();
  const frames = Math.min(xfadeFrames, loop.loopEndFrame - loop.loopStartFrame - 1, loop.loopStartFrame);
  for (let i = 0; i < frames; i += 1) {
    const t = (i + 1) / frames;
    const { fadeOut, fadeIn } = equalPowerCrossfade(t);
    const tailFrame = loop.loopEndFrame - frames + i;
    const headFrame = loop.loopStartFrame + i;
    for (let c = 0; c < channels; c += 1) {
      const tail = interleaved[tailFrame * channels + c];
      const head = interleaved[headFrame * channels + c];
      out[tailFrame * channels + c] = tail * fadeOut + head * fadeIn;
    }
  }
  return { interleaved: out, loopStartFrame: loop.loopStartFrame, loopEndFrame: loop.loopEndFrame };
}

/** "Search With Rev X-Fade": igual ao X-Fade acima, mas em vez de misturar
 *  com uma cópia direta do começo do loop, mistura com uma cópia INVERTIDA
 *  no tempo do próprio fim do loop — preserva mais a característica
 *  timbrística do decaimento natural do som na emenda (mesma ideia descrita
 *  no artigo da Sound On Sound: "adds in a reversed version of the loop on
 *  top of the forward version"). */
function bakeSearchRevXfade(interleaved: Float32Array, channels: number, loop: LoopPointResult, xfadeFrames: number): BakedLoop {
  const out = interleaved.slice();
  const frames = Math.min(xfadeFrames, loop.loopEndFrame - loop.loopStartFrame - 1, loop.loopStartFrame);
  for (let i = 0; i < frames; i += 1) {
    const t = (i + 1) / frames;
    const { fadeOut, fadeIn } = equalPowerCrossfade(t);
    const tailFrame = loop.loopEndFrame - frames + i;
    // Cópia invertida no tempo da própria região final do loop (em vez do começo).
    const reversedFrame = loop.loopEndFrame - 1 - i;
    for (let c = 0; c < channels; c += 1) {
      const tail = interleaved[tailFrame * channels + c];
      const reversed = interleaved[reversedFrame * channels + c];
      out[tailFrame * channels + c] = tail * fadeOut + reversed * fadeIn;
    }
  }
  return { interleaved: out, loopStartFrame: loop.loopStartFrame, loopEndFrame: loop.loopEndFrame };
}

/** "Bidirectional": concatena o trecho do loop tocado pra frente com o MESMO
 *  trecho invertido no tempo, formando um loop (forward+reverse) com o
 *  DOBRO do comprimento original — tocado em loop simples pra frente
 *  (suportado por qualquer player, .mrq ou SF2), isso é matematicamente
 *  equivalente a um ping-pong de verdade (forward, backward, forward,
 *  backward, ...), porque o ciclo forward+reverse se repete de forma
 *  idêntica a cada volta. Aplica um pequeno crossfade equal-power nas duas
 *  emendas (início↔fim do trecho invertido, e fim do trecho invertido↔início
 *  do próximo forward) pra evitar o clique no ponto de inversão exata. */
function bakeBidirectional(interleaved: Float32Array, channels: number, loop: LoopPointResult, xfadeFrames: number): BakedLoop {
  const loopFrameCount = loop.loopEndFrame - loop.loopStartFrame;
  const prefixFrames = loop.loopStartFrame;
  const suffixFrames = Math.floor(interleaved.length / channels) - loop.loopEndFrame;
  const totalFrames = prefixFrames + loopFrameCount * 2 + suffixFrames;
  const out = new Float32Array(totalFrames * channels);

  // Prefixo (tudo antes do loop) sem alteração.
  out.set(interleaved.subarray(0, prefixFrames * channels), 0);

  // Trecho forward (o loop original, sem alteração).
  const forwardOffset = prefixFrames * channels;
  out.set(interleaved.subarray(loop.loopStartFrame * channels, loop.loopEndFrame * channels), forwardOffset);

  // Trecho reverse (o mesmo loop, invertido quadro a quadro).
  const reverseOffset = (prefixFrames + loopFrameCount) * channels;
  for (let f = 0; f < loopFrameCount; f += 1) {
    const srcFrame = loop.loopEndFrame - 1 - f;
    for (let c = 0; c < channels; c += 1) out[reverseOffset + f * channels + c] = interleaved[srcFrame * channels + c];
  }

  // Sufixo (release tail gravado depois do ponto de loop) sem alteração.
  const suffixOffset = (prefixFrames + loopFrameCount * 2) * channels;
  out.set(interleaved.subarray(loop.loopEndFrame * channels), suffixOffset);

  // Crossfade equal-power nas duas emendas do ciclo forward+reverse (início
  // do forward ↔ fim do reverse, já que esse ciclo se repete infinitamente).
  const fadeFrames = Math.min(xfadeFrames, Math.floor(loopFrameCount / 4));
  if (fadeFrames > 0) {
    for (let i = 0; i < fadeFrames; i += 1) {
      const t = (i + 1) / fadeFrames;
      const { fadeOut, fadeIn } = equalPowerCrossfade(t);
      const headFrame = prefixFrames + i; // começo do trecho forward
      const tailFrame = prefixFrames + loopFrameCount * 2 - fadeFrames + i; // fim do trecho reverse
      for (let c = 0; c < channels; c += 1) {
        const head = out[headFrame * channels + c];
        const tail = out[tailFrame * channels + c];
        const blended = tail * fadeOut + head * fadeIn;
        out[tailFrame * channels + c] = blended;
      }
    }
  }

  return { interleaved: out, loopStartFrame: prefixFrames, loopEndFrame: prefixFrames + loopFrameCount * 2 };
}

/** Aplica o modo de Auto Loop escolhido sobre um ponto de loop já encontrado
 *  por `findLoopPoints` — PURO, sem nenhuma dependência de Web Audio/Tauri,
 *  testável com buffers sintéticos (ver scripts/test-auto-sampler-engine.mjs).
 *  `crossfadeMs` default de 25ms é um valor comum pra crossfade de loop (nem
 *  curto a ponto de ainda clicar, nem longo a ponto de borrar o timbre). */
export function bakeAutoLoop(
  interleaved: Float32Array,
  channels: number,
  sampleRateHz: number,
  loop: LoopPointResult,
  mode: AutoLoopMode,
  crossfadeMs = 25
): BakedLoop {
  const xfadeFrames = Math.max(1, Math.round((crossfadeMs / 1000) * sampleRateHz));
  switch (mode) {
    case 'search':
      return { interleaved, loopStartFrame: loop.loopStartFrame, loopEndFrame: loop.loopEndFrame };
    case 'search-xfade':
      return bakeSearchXfade(interleaved, channels, loop, xfadeFrames);
    case 'search-rev-xfade':
      return bakeSearchRevXfade(interleaved, channels, loop, xfadeFrames);
    case 'bidirectional':
      return bakeBidirectional(interleaved, channels, loop, xfadeFrames);
    case 'none':
      throw new Error("bakeAutoLoop não deveria ser chamado com mode 'none' — nenhum loop foi pedido.");
    default: {
      const exhaustive: never = mode;
      throw new Error(`modo de Auto Loop desconhecido: ${exhaustive}`);
    }
  }
}

// re-exporta pra quem só importa daqui (evita ter que saber que a função mora em kontaktCapture.ts).
export { computeAutoKeyRanges };
export { sampleAt as __sampleAtForTests };
