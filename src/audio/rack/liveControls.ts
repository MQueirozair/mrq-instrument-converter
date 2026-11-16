/**
 * Controles ao Vivo (v0.2.22) — lógica pura dos controles globais de um
 * instrumento convertido: faixa de notas/velocity, tecla raiz, volume, pan,
 * afinação, envelope (ataque/release/sustain), EQ de 3 bandas, drive e os
 * efeitos ao vivo (reverb, stereo, delay, chorus).
 *
 * Estes controles atuam sobre TODAS as amostras/zonas do instrumento
 * ("INSTRUMENTO INTEIRO") e servem pra pré-escutar, em tempo real, como o
 * som final vai sair quando o instrumento for aberto num rack de
 * instrumentos pra tocar ao vivo. O motor que aplica esses parâmetros é
 * `LiveInstrumentEngine` (usa `MrqLayerVoice` + `LiveFxChain`); este módulo
 * só tem tipos, padrões, limites, persistência por instrumento e os
 * mapeamentos parâmetro→áudio (funções puras, testadas em
 * scripts/test-live-controls.mjs).
 */

export interface LiveParams {
  // --- Faixa / raiz (steppers) ---
  noteMin: number;
  noteMax: number;
  rootKey: number;
  velMin: number;
  velMax: number;
  // --- Linha 1 (knobs) ---
  volumeDb: number;
  pan: number;
  tuneCents: number;
  attackMs: number;
  releaseMs: number;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  driveDb: number;
  sustain: number;
  // --- Efeitos / ao vivo (knobs) ---
  reverb: number;
  reverbSize: number;
  reverbDamp: number;
  reverbPredelayMs: number;
  reverbColor: number;
  stereo: number;
  delay: number;
  delayTimeMs: number;
  delayFeedback: number;
  chorus: number;
  chorusRateHz: number;
  chorusDepth: number;
  // --- Ferramentas raras (v0.2.23) ---
  comp: number;
  phaserRate: number;
  phaserDepth: number;
  phaserMix: number;
  flangerRate: number;
  flangerDepth: number;
  flangerFeedback: number;
  flangerMix: number;
  tremoloRate: number;
  tremoloDepth: number;
  crushBits: number;
  crushRate: number;
  crushMix: number;
  shimmerMix: number;
  octaverMix: number;
  gateThreshold: number;
  vibratoRate: number;
  vibratoDepth: number;
  autopanRate: number;
  autopanDepth: number;
  exciter: number;
  ringFreq: number;
  ringMix: number;
  tape: number;
  arpRate: number;
  arpRange: number;
  velCurve: number;
  // --- Novidades inventadas (v0.2.23) ---
  pressure: number;
  ecoVivo: number;
  // --- Linha MIDI (v0.2.25) — canal, oitava, velocity padrão, modo ---
  midiChannel: number;
  octave: number;
  defaultVelocity: number;
  playMode: number; // 0 = Normal (polifônico), 1 = Mono (uma voz por vez)
  // --- Pan (v0.2.26) — 0 = BALANCE (preserva imagem), 1 = STEREO PAN ---
  panMode: number;
}

export type LiveParamKey = keyof LiveParams;

export interface LiveParamDef {
  key: LiveParamKey;
  label: string;
  min: number;
  max: number;
  /** passo do scroll da roda / setas (knobs são contínuos no arraste). */
  step: number;
  format: (v: number) => string;
  default: number;
  /** Unidade exibida no tooltip/valor (ex.: 'dB', 'ms', '%', 'ct'). */
  unit?: string;
  /** Curva de resposta do controle ('linear' ou 'log' — afeta o arraste). */
  curve?: 'linear' | 'log';
  /** Grupo/painel a que o controle pertence (organização visual). */
  group?: 'midi' | 'amplitude' | 'tonalidade' | 'eq' | 'efeito';
}

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

/** Definições de cada controle, na ordem em que aparecem na página. */
export const LIVE_PARAM_DEFS: Record<LiveParamKey, LiveParamDef> = {
  noteMin: { key: 'noteMin', label: 'NOTA MIN', min: 0, max: 127, step: 1, format: (v) => String(Math.round(v)), default: 0 },
  noteMax: { key: 'noteMax', label: 'NOTA MAX', min: 0, max: 127, step: 1, format: (v) => String(Math.round(v)), default: 127 },
  rootKey: { key: 'rootKey', label: 'TECLA RAIZ', min: 0, max: 127, step: 1, format: (v) => String(Math.round(v)), default: 60 },
  velMin: { key: 'velMin', label: 'VELOCIDADE MIN', min: 1, max: 127, step: 1, format: (v) => String(Math.round(v)), default: 1 },
  velMax: { key: 'velMax', label: 'VELOCIDADE MAX', min: 1, max: 127, step: 1, format: (v) => String(Math.round(v)), default: 127 },
  volumeDb: { key: 'volumeDb', label: 'VOLUME dB', min: -60, max: 12, step: 0.5, format: f1, unit: 'dB', default: 0 },
  pan: { key: 'pan', label: 'PAN', min: -1, max: 1, step: 0.05, format: f2, default: 0 },
  tuneCents: { key: 'tuneCents', label: 'AFINACAO cents', min: -100, max: 100, step: 1, format: f1, unit: 'ct', default: 0 },
  attackMs: { key: 'attackMs', label: 'ATAQUE ms', min: 0, max: 2000, step: 5, format: f1, unit: 'ms', default: 0 },
  releaseMs: { key: 'releaseMs', label: 'RELEASE ms', min: 0, max: 5000, step: 10, format: f1, unit: 'ms', default: 100 },
  eqLowDb: { key: 'eqLowDb', label: 'EQ GRAVES dB', min: -15, max: 15, step: 0.5, format: f1, unit: 'dB', default: 0 },
  eqMidDb: { key: 'eqMidDb', label: 'EQ MEDIOS dB', min: -15, max: 15, step: 0.5, format: f1, unit: 'dB', default: 0 },
  eqHighDb: { key: 'eqHighDb', label: 'EQ AGUDOS dB', min: -15, max: 15, step: 0.5, format: f1, unit: 'dB', default: 0 },
  driveDb: { key: 'driveDb', label: 'DRIVE dB', min: 0, max: 24, step: 0.5, format: f1, unit: 'dB', default: 0 },
  sustain: { key: 'sustain', label: 'SUSTAIN %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 100 },
  reverb: { key: 'reverb', label: 'REVERB %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  reverbSize: { key: 'reverbSize', label: 'TAMANHO %', min: 10, max: 100, step: 1, format: f1, unit: '%', default: 75 },
  reverbDamp: { key: 'reverbDamp', label: 'DAMP %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 50 },
  reverbPredelayMs: { key: 'reverbPredelayMs', label: 'PRE-DELAY ms', min: 0, max: 500, step: 5, format: f1, unit: 'ms', default: 25 },
  reverbColor: { key: 'reverbColor', label: 'COR %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 80 },
  stereo: { key: 'stereo', label: 'STEREO %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  delay: { key: 'delay', label: 'DELAY %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  delayTimeMs: { key: 'delayTimeMs', label: 'TEMPO ms', min: 0, max: 2000, step: 10, format: f1, unit: 'ms', default: 350 },
  delayFeedback: { key: 'delayFeedback', label: 'FEEDBACK %', min: 0, max: 95, step: 1, format: f1, unit: '%', default: 35 },
  chorus: { key: 'chorus', label: 'CHORUS %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  chorusRateHz: { key: 'chorusRateHz', label: 'RATE Hz', min: 0.05, max: 10, step: 0.05, format: f2, unit: 'Hz', default: 0.7 },
  chorusDepth: { key: 'chorusDepth', label: 'DEPTH %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 50 },
  // --- Ferramentas raras (v0.2.23) ---
  comp: { key: 'comp', label: 'COMP %', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  phaserRate: { key: 'phaserRate', label: 'PHASER RATE', min: 0.05, max: 10, step: 0.05, format: f2, unit: 'Hz', default: 0.5 },
  phaserDepth: { key: 'phaserDepth', label: 'PHASER DEPTH', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 50 },
  phaserMix: { key: 'phaserMix', label: 'PHASER MIX', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  flangerRate: { key: 'flangerRate', label: 'FLANGER RATE', min: 0.05, max: 10, step: 0.05, format: f2, unit: 'Hz', default: 0.3 },
  flangerDepth: { key: 'flangerDepth', label: 'FLANGER DEPTH', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 50 },
  flangerFeedback: { key: 'flangerFeedback', label: 'FLANGER FB', min: 0, max: 90, step: 1, format: f1, unit: '%', default: 40 },
  flangerMix: { key: 'flangerMix', label: 'FLANGER MIX', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  tremoloRate: { key: 'tremoloRate', label: 'TREMOLO RATE', min: 0.5, max: 20, step: 0.1, format: f1, unit: 'Hz', default: 5 },
  tremoloDepth: { key: 'tremoloDepth', label: 'TREMOLO DEPTH', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  crushBits: { key: 'crushBits', label: 'CRUSH BITS', min: 2, max: 16, step: 1, format: (v) => String(Math.round(v)), unit: 'bits', default: 8 },
  crushRate: { key: 'crushRate', label: 'CRUSH TAXA', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 50 },
  crushMix: { key: 'crushMix', label: 'CRUSH MIX', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  shimmerMix: { key: 'shimmerMix', label: 'SHIMMER', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  octaverMix: { key: 'octaverMix', label: 'OCTAVER', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  gateThreshold: { key: 'gateThreshold', label: 'GATE dB', min: -80, max: 0, step: 1, format: f1, unit: 'dB', default: -80 },
  vibratoRate: { key: 'vibratoRate', label: 'VIBRATO RATE', min: 0.5, max: 12, step: 0.1, format: f1, unit: 'Hz', default: 5.5 },
  vibratoDepth: { key: 'vibratoDepth', label: 'VIBRATO DEPTH', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  autopanRate: { key: 'autopanRate', label: 'AUTO-PAN RATE', min: 0.05, max: 10, step: 0.05, format: f2, unit: 'Hz', default: 0.5 },
  autopanDepth: { key: 'autopanDepth', label: 'AUTO-PAN DEPTH', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  exciter: { key: 'exciter', label: 'EXCITER', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  ringFreq: { key: 'ringFreq', label: 'RING FREQ', min: 0.5, max: 200, step: 0.5, format: f1, unit: 'Hz', default: 30 },
  ringMix: { key: 'ringMix', label: 'RING MIX', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  tape: { key: 'tape', label: 'TAPE', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  arpRate: { key: 'arpRate', label: 'ARP TAXA ms', min: 0, max: 1000, step: 10, format: f1, unit: 'ms', default: 0 },
  arpRange: { key: 'arpRange', label: 'ARP ALCANCE', min: 0, max: 24, step: 1, format: (v) => String(Math.round(v)), unit: 'st', default: 12 },
  velCurve: { key: 'velCurve', label: 'VELOCIDADE CURVA', min: -100, max: 100, step: 1, format: f1, default: 0 },
  // --- Novidades inventadas (v0.2.23) ---
  pressure: { key: 'pressure', label: 'PRESSÃO', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  ecoVivo: { key: 'ecoVivo', label: 'ECO VIVO', min: 0, max: 100, step: 1, format: f1, unit: '%', default: 0 },
  // --- Linha MIDI (v0.2.25) ---
  midiChannel: { key: 'midiChannel', label: 'CANAL MIDI', min: 1, max: 16, step: 1, format: (v) => String(Math.round(v)), default: 1 },
  octave: { key: 'octave', label: 'OITAVA', min: -2, max: 2, step: 1, format: (v) => String(Math.round(v)), default: 0 },
  defaultVelocity: { key: 'defaultVelocity', label: 'VELOCIDADE PADRÃO', min: 1, max: 127, step: 1, format: (v) => String(Math.round(v)), default: 100 },
  playMode: { key: 'playMode', label: 'MODO DE REPRODUÇÃO', min: 0, max: 1, step: 1, format: (v) => (Math.round(v) === 1 ? 'Mono' : 'Normal'), default: 0 },
  // --- Pan (v0.2.26) — BALANCE é o padrão (compatível com instrumentos estéreo) ---
  panMode: { key: 'panMode', label: 'MODO DE PAN', min: 0, max: 1, step: 1, format: (v) => (Math.round(v) === 1 ? 'Stereo Pan' : 'Balance'), default: 0 },
};

/** Ordem dos knobs da linha 1 (depois dos steppers). */
export const LIVE_KNOBS_ROW1: LiveParamKey[] = [
  'volumeDb', 'pan', 'tuneCents', 'attackMs', 'releaseMs',
  'eqLowDb', 'eqMidDb', 'eqHighDb', 'driveDb', 'sustain',
];

/** Ordem dos knobs de "EFEITOS / AO VIVO". */
export const LIVE_KNOBS_FX: LiveParamKey[] = [
  'reverb', 'reverbSize', 'reverbDamp', 'reverbPredelayMs', 'reverbColor', 'stereo',
  'delay', 'delayTimeMs', 'delayFeedback', 'chorus', 'chorusRateHz', 'chorusDepth',
];

/** Ordem dos steppers (faixa/raiz). */
export const LIVE_STEPPERS: LiveParamKey[] = ['noteMin', 'noteMax', 'rootKey', 'velMin', 'velMax'];

/** Knobs das 15 ferramentas raras (v0.2.23). */
export const LIVE_KNOBS_TOOLS: LiveParamKey[] = [
  'comp',
  'phaserRate', 'phaserDepth', 'phaserMix',
  'flangerRate', 'flangerDepth', 'flangerFeedback', 'flangerMix',
  'tremoloRate', 'tremoloDepth',
  'crushBits', 'crushRate', 'crushMix',
  'shimmerMix', 'octaverMix',
  'gateThreshold',
  'vibratoRate', 'vibratoDepth',
  'autopanRate', 'autopanDepth',
  'exciter',
  'ringFreq', 'ringMix',
  'tape',
  'arpRate', 'arpRange',
  'velCurve',
];

/** Knobs das 2 novidades inventadas (v0.2.23). */
export const LIVE_KNOBS_NEW: LiveParamKey[] = ['pressure', 'ecoVivo'];

/** Controles da linha MIDI (v0.2.25) — seletores/steppers, não knobs. */
export const LIVE_MIDI_ROW: LiveParamKey[] = ['midiChannel', 'octave', 'defaultVelocity', 'playMode'];

export function defaultLiveParams(): LiveParams {
  const out = {} as LiveParams;
  for (const key of Object.keys(LIVE_PARAM_DEFS) as LiveParamKey[]) {
    out[key] = LIVE_PARAM_DEFS[key].default;
  }
  return out;
}

export function clampLiveParams(input: Partial<LiveParams>): LiveParams {
  const out = defaultLiveParams();
  for (const key of Object.keys(LIVE_PARAM_DEFS) as LiveParamKey[]) {
    const def = LIVE_PARAM_DEFS[key];
    const raw = input[key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : def.default;
    out[key] = Math.min(def.max, Math.max(def.min, value));
  }
  // Faixas sempre ordenadas (min <= max) — evita faixa vazia por acidente.
  if (out.noteMin > out.noteMax) [out.noteMin, out.noteMax] = [out.noteMax, out.noteMin];
  if (out.velMin > out.velMax) [out.velMin, out.velMax] = [out.velMax, out.velMin];
  return out;
}

// ---------------------------------------------------------------------------
// Mapeamentos parâmetro → áudio (puros, testáveis)
// ---------------------------------------------------------------------------

/** dB → ganho linear (volume, EQ, drive). */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** TAMANHO % (10..100) → duração da resposta do reverb em segundos (0.3..5.0). */
export function reverbDurationSec(sizePct: number): number {
  const t = (Math.min(100, Math.max(10, sizePct)) - 10) / 90;
  return 0.3 + t * 4.7;
}

/** COR % (0..100) → ganho do agudo do retorno do reverb em dB (-12..+12). */
export function reverbColorDb(colorPct: number): number {
  return ((Math.min(100, Math.max(0, colorPct)) - 50) / 50) * 12;
}

/**
 * STEREO % (0..100) → largura mid/side (0 = mono, 50 = normal, 100 = larga).
 * NOTA: a cadeia atual usa alargador Haas (k = STEREO/100 direto), onde
 * 0% = estéreo normal e 100% = largo — esta função fica como referência do
 * mapeamento mid/side original.
 */
export function stereoWidth(stereoPct: number): number {
  return Math.min(100, Math.max(0, stereoPct)) / 50;
}

/** DRIVE dB (0..24) → intensidade da curva + mistura seco/molhado. */
export function driveParams(driveDb: number): { amount: number; wet: number; dry: number } {
  const amount = Math.min(24, Math.max(0, driveDb));
  if (amount <= 0) return { amount: 0, wet: 0, dry: 1 };
  const wet = Math.min(1, 0.25 + amount / 24);
  return { amount, wet, dry: 1 - wet * 0.5 };
}

/** DEPTH % (0..100) → profundidade da modulação do chorus em segundos (0..8ms). */
export function chorusDepthSec(depthPct: number): number {
  return (Math.min(100, Math.max(0, depthPct)) / 100) * 0.008;
}

/** FEEDBACK % (0..95) → ganho realimentado do delay (0..0.95). */
export function delayFeedbackGain(feedbackPct: number): number {
  return Math.min(95, Math.max(0, feedbackPct)) / 100;
}

/** REVERB % (0..100) → ganho do retorno molhado (0..1.25). */
export function reverbWetGain(reverbPct: number): number {
  return (Math.min(100, Math.max(0, reverbPct)) / 100) * 1.25;
}

/** SUSTAIN % (0..100) → nível de sustentação do envelope (0..1). */
export function sustainLevel(sustainPct: number): number {
  return Math.min(100, Math.max(0, sustainPct)) / 100;
}

/**
 * Tecla raiz de referência do instrumento: a `rootNote` mais comum entre as
 * zonas (empate → a primeira encontrada). É a tecla que toca o sample na
 * afinação original — o controle TECLA RAIZ desloca tudo em relação a ela.
 */
export function referenceRootFromZones(zones: { rootNote: number }[]): number {
  if (zones.length === 0) return 60;
  const counts = new Map<number, number>();
  for (const z of zones) counts.set(z.rootNote, (counts.get(z.rootNote) ?? 0) + 1);
  let best = zones[0].rootNote;
  let bestCount = -1;
  for (const [root, count] of counts) {
    if (count > bestCount) {
      best = root;
      bestCount = count;
    }
  }
  return best;
}

/** Faixa do teclado na tela a partir de NOTA MIN/MAX (limitada a 21..108). */
export function keyboardRangeFor(params: LiveParams): { lowest: number; highest: number } {
  const lowest = Math.max(21, Math.min(108, Math.round(params.noteMin)));
  const highest = Math.max(lowest, Math.min(108, Math.round(params.noteMax)));
  return { lowest, highest };
}

/** Nome da nota MIDI (ex.: 60 → "C4", 21 → "A0"). */
export function noteName(note: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const n = Math.round(note);
  return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

// ---------------------------------------------------------------------------
// Sistema universal de controles (v0.2.25) — conversão valor↔posição (curvas)
// e rótulos. Uma única fonte de verdade: os controles leem/escrevem aqui.
// ---------------------------------------------------------------------------

/**
 * Valor real → posição normalizada (0..1) do controle, conforme a curva.
 * 'log' distribui o arraste (útil em tempos/frequências).
 */
export function valueToPosition(value: number, min: number, max: number, curve: 'linear' | 'log' = 'linear'): number {
  if (max <= min) return 0;
  const clamped = Math.min(max, Math.max(min, value));
  const t = (clamped - min) / (max - min);
  if (curve === 'log') {
    // log sobre a faixa deslocada (evita log de 0/negativo); faixa travada
    // em >= 0 pra nunca gerar NaN.
    const lo = Math.log10(1 + Math.max(0, min));
    const hi = Math.log10(1 + Math.max(0, max));
    const v = Math.log10(1 + Math.max(0, clamped));
    return hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : t;
  }
  return t;
}

/** Posição normalizada (0..1) → valor real, conforme a curva. */
export function positionToValue(position: number, min: number, max: number, curve: 'linear' | 'log' = 'linear'): number {
  const t = Math.min(1, Math.max(0, position));
  if (curve === 'log') {
    const lo = Math.log10(1 + Math.max(0, min));
    const hi = Math.log10(1 + Math.max(0, max));
    return Math.min(max, Math.max(min, Math.pow(10, lo + t * (hi - lo)) - 1));
  }
  return min + t * (max - min);
}

/**
 * Rótulo L/C/R do PAN (interface -100..+100): L100, L50, C, R50, R100.
 * `pan` é o valor interno normalizado (-1..+1).
 */
export function panDisplayLabel(pan: number): string {
  const v = Math.round(Math.min(1, Math.max(-1, pan)) * 100);
  if (v === 0) return 'C';
  return v < 0 ? `L${-v}` : `R${v}`;
}

// ---------------------------------------------------------------------------
// Mapeamentos das ferramentas raras e novidades (v0.2.23)
// ---------------------------------------------------------------------------

/** COMP % (0..100) → parâmetros do compressor master (cola). */
export function compressorParams(compPct: number): { thresholdDb: number; ratio: number; makeupDb: number; attackSec: number; releaseSec: number } {
  const t = Math.min(100, Math.max(0, compPct)) / 100;
  return {
    thresholdDb: -6 - t * 30, // 0% → -6dB (quase nada), 100% → -36dB
    ratio: 1 + t * 9, // 0% → 1:1 (bypass), 100% → 10:1
    makeupDb: t * 12, // compensação de nível
    attackSec: 0.01,
    releaseSec: 0.15,
  };
}

/**
 * Curva de velocity (VELOCIDADE CURVA -100..+100, 0 = linear): positivo
 * enfatiza as notas fortes (expande), negativo equaliza (comprime as
 * suaves pra cima). v' = 127 * (v/127)^gamma, gamma em [0.3, 3].
 */
export function applyVelocityCurve(velocity: number, curve: number): number {
  const v = Math.min(127, Math.max(1, velocity)) / 127;
  const gamma = Math.min(3, Math.max(0.3, 1 + curve / 50));
  return Math.min(127, Math.max(1, Math.round(127 * Math.pow(v, gamma))));
}

/**
 * Curva de quantização do bitcrusher: BITS (2..16) → passos de quantização.
 * 16 bits = ~transparente; 2 bits = bem degradado.
 */
export function bitcrusherSteps(bits: number): number {
  const b = Math.min(16, Math.max(2, Math.round(bits)));
  return Math.pow(2, b);
}

/** CRUSH TAXA % (0..100) → corte do lowpass do bitcrusher (500Hz..18kHz). */
export function crushLowpassHz(ratePct: number): number {
  const t = Math.min(100, Math.max(0, ratePct)) / 100;
  return 500 + t * 17500;
}

/**
 * Padrão do arpejador (sobe e desce): offsets em semitons a partir da nota
 * tocada, cobrindo ARP ALCANCE. Ex.: alcance 12 → [0, 7, 12, 7].
 */
export function arpNoteOffsets(rangeSemitones: number): number[] {
  const range = Math.min(24, Math.max(0, Math.round(rangeSemitones)));
  if (range <= 0) return [0];
  const fifth = Math.min(7, range);
  const offsets = [0, fifth];
  if (range > fifth) offsets.push(range, fifth);
  return offsets;
}

/**
 * NOVIDADE 1 — PRESSÃO: macro de caráter ao vivo. Um knob só que ajusta
 * drive + presença (EQ agudos) + cola (compressor) + largura + cauda de
 * reverb de forma musicalmente coerente, como um "master de palco".
 * Devolve os valores absolutos que os outros controles assumem.
 */
export function pressureMacro(pressurePct: number): { driveDb: number; eqHighDb: number; comp: number; stereo: number; reverb: number } {
  const t = Math.min(100, Math.max(0, pressurePct)) / 100;
  return {
    driveDb: t * 10, // 0 → 10dB de saturação
    eqHighDb: t * 6, // presença
    comp: t * 70, // cola
    stereo: t * 90, // abre a imagem (Haas: 0 = normal, 90 = bem largo)
    reverb: t * 35, // cauda de palco
  };
}

/**
 * NOVIDADE 2 — ECO VIVO: o feedback efetivo do delay em função da densidade
 * de notas tocadas (0..1). Tocando denso, o eco se fecha (não enlama);
 * tocando espaçado, abre espaço. `ecoVivoPct` é a força do comportamento.
 */
export function ecoVivoFeedback(baseFeedbackPct: number, ecoVivoPct: number, density: number): number {
  const base = Math.min(95, Math.max(0, baseFeedbackPct));
  const strength = Math.min(100, Math.max(0, ecoVivoPct)) / 100;
  const d = Math.min(1, Math.max(0, density));
  return base * (1 - strength * d * 0.8);
}

// ---------------------------------------------------------------------------
// Bypass dos efeitos (v0.2.24) — cada efeito pode ser tirado do caminho de
// áudio sem perder o ajuste dos knobs (ao religar, o ajuste volta).
// ---------------------------------------------------------------------------

/** Identificador de cada efeito com botão de bypass. */
export type LiveEffectId =
  | 'eq' | 'drive' | 'chorus' | 'delay' | 'stereo' | 'reverb' | 'shimmer'
  | 'comp' | 'phaser' | 'flanger' | 'tremolo' | 'crush' | 'octaver' | 'gate'
  | 'vibrato' | 'autopan' | 'exciter' | 'ring' | 'tape' | 'arp' | 'ecoVivo';

/** Estado de bypass: `true` = efeito fora do caminho de áudio. */
export type LiveBypass = Record<LiveEffectId, boolean>;

export interface LiveEffectDef {
  id: LiveEffectId;
  label: string;
  /** Knobs que pertencem a este efeito (ficam desabilitados no bypass). */
  paramKeys: LiveParamKey[];
}

/** Efeitos com bypass, na ordem em que aparecem na página. */
export const LIVE_EFFECTS: LiveEffectDef[] = [
  { id: 'eq', label: 'EQ', paramKeys: ['eqLowDb', 'eqMidDb', 'eqHighDb'] },
  { id: 'drive', label: 'DRIVE', paramKeys: ['driveDb'] },
  { id: 'reverb', label: 'REVERB', paramKeys: ['reverb', 'reverbSize', 'reverbDamp', 'reverbPredelayMs', 'reverbColor'] },
  { id: 'stereo', label: 'STEREO', paramKeys: ['stereo'] },
  { id: 'delay', label: 'DELAY', paramKeys: ['delay', 'delayTimeMs', 'delayFeedback'] },
  { id: 'chorus', label: 'CHORUS', paramKeys: ['chorus', 'chorusRateHz', 'chorusDepth'] },
  { id: 'comp', label: 'COMP', paramKeys: ['comp'] },
  { id: 'phaser', label: 'PHASER', paramKeys: ['phaserRate', 'phaserDepth', 'phaserMix'] },
  { id: 'flanger', label: 'FLANGER', paramKeys: ['flangerRate', 'flangerDepth', 'flangerFeedback', 'flangerMix'] },
  { id: 'tremolo', label: 'TREMOLO', paramKeys: ['tremoloRate', 'tremoloDepth'] },
  { id: 'crush', label: 'BITCRUSHER', paramKeys: ['crushBits', 'crushRate', 'crushMix'] },
  { id: 'shimmer', label: 'SHIMMER', paramKeys: ['shimmerMix'] },
  { id: 'octaver', label: 'OCTAVER', paramKeys: ['octaverMix'] },
  { id: 'gate', label: 'GATE', paramKeys: ['gateThreshold'] },
  { id: 'vibrato', label: 'VIBRATO', paramKeys: ['vibratoRate', 'vibratoDepth'] },
  { id: 'autopan', label: 'AUTO-PAN', paramKeys: ['autopanRate', 'autopanDepth'] },
  { id: 'exciter', label: 'EXCITER', paramKeys: ['exciter'] },
  { id: 'ring', label: 'RING MOD', paramKeys: ['ringFreq', 'ringMix'] },
  { id: 'tape', label: 'TAPE', paramKeys: ['tape'] },
  { id: 'arp', label: 'ARPEJADOR', paramKeys: ['arpRate', 'arpRange'] },
  { id: 'ecoVivo', label: 'ECO VIVO', paramKeys: ['ecoVivo'] },
];

/** Mapa parâmetro → efeito (pra desabilitar os knobs do efeito em bypass). */
const EFFECT_BY_PARAM: Partial<Record<LiveParamKey, LiveEffectId>> = (() => {
  const map: Partial<Record<LiveParamKey, LiveEffectId>> = {};
  for (const fx of LIVE_EFFECTS) {
    for (const key of fx.paramKeys) map[key] = fx.id;
  }
  return map;
})();

/** Efeito dono de um parâmetro (ou `undefined` se não é de nenhum efeito). */
export function effectIdForParam(key: LiveParamKey): LiveEffectId | undefined {
  return EFFECT_BY_PARAM[key];
}

/** Bypass padrão: nenhum efeito desligado. */
export function defaultLiveBypass(): LiveBypass {
  const out = {} as LiveBypass;
  for (const fx of LIVE_EFFECTS) out[fx.id] = false;
  return out;
}

/** Normaliza um bypass parcial (ex.: vindo do localStorage) — nunca lança. */
export function normalizeLiveBypass(input: Partial<LiveBypass> | undefined | null): LiveBypass {
  const out = defaultLiveBypass();
  if (input && typeof input === 'object') {
    for (const fx of LIVE_EFFECTS) {
      const value: unknown = input[fx.id];
      if (typeof value === 'boolean') out[fx.id] = value;
    }
  }
  return out;
}

/**
 * Aplica o bypass: devolve uma CÓPIA dos parâmetros com cada efeito em
 * bypass neutralizado (o ajuste original dos knobs é preservado — ao religar
 * o efeito, o ajuste volta a valer). Função pura, testável.
 */
export function applyBypass(p: LiveParams, bypass: LiveBypass): LiveParams {
  const anyBypassed = LIVE_EFFECTS.some((fx) => bypass[fx.id]);
  if (!anyBypassed) return p;
  const out = { ...p };
  if (bypass.eq) { out.eqLowDb = 0; out.eqMidDb = 0; out.eqHighDb = 0; }
  if (bypass.drive) out.driveDb = 0;
  if (bypass.chorus) out.chorus = 0;
  if (bypass.delay) out.delay = 0;
  if (bypass.stereo) out.stereo = 0;
  if (bypass.reverb) out.reverb = 0;
  if (bypass.shimmer) out.shimmerMix = 0;
  if (bypass.comp) out.comp = 0;
  if (bypass.phaser) out.phaserMix = 0;
  if (bypass.flanger) out.flangerMix = 0;
  if (bypass.tremolo) out.tremoloDepth = 0;
  if (bypass.crush) out.crushMix = 0;
  if (bypass.octaver) out.octaverMix = 0;
  if (bypass.gate) out.gateThreshold = -80; // mínimo = gate sempre aberto
  if (bypass.vibrato) out.vibratoDepth = 0;
  if (bypass.autopan) out.autopanDepth = 0;
  if (bypass.exciter) out.exciter = 0;
  if (bypass.ring) out.ringMix = 0;
  if (bypass.tape) out.tape = 0;
  if (bypass.arp) out.arpRate = 0;
  if (bypass.ecoVivo) out.ecoVivo = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Persistência por instrumento (localStorage — nunca lança)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'mrq.liveControls.v1';

type LiveParamsByPath = Record<string, LiveParams>;

function readStore(): LiveParamsByPath {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as LiveParamsByPath;
  } catch {
    return {};
  }
}

function writeStore(store: LiveParamsByPath) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* localStorage cheio/indisponível — os controles continuam em memória */
  }
}

/** Parâmetros salvos pra um instrumento (padrões + o que foi salvo). */
export function loadLiveParams(path: string): LiveParams {
  const saved = readStore()[path];
  return clampLiveParams(saved ?? {});
}

/** Salva os parâmetros de um instrumento (merge com o que já havia). */
export function saveLiveParams(path: string, params: LiveParams) {
  const store = readStore();
  store[path] = clampLiveParams(params);
  writeStore(store);
}

/** Apaga os parâmetros salvos de um instrumento (volta aos padrões). */
export function clearLiveParams(path: string) {
  const store = readStore();
  if (path in store) {
    delete store[path];
    writeStore(store);
  }
}

/** Quantos instrumentos têm parâmetros salvos (pro teste de persistência). */
export function savedLiveParamsCount(): number {
  return Object.keys(readStore()).length;
}

/** Se já existem parâmetros salvos pra este instrumento. */
export function hasSavedLiveParams(path: string): boolean {
  return path in readStore();
}

// --- Persistência do bypass (chave separada — não quebra os saves v0.2.22+) ---

const BYPASS_STORAGE_KEY = 'mrq.liveControls.bypass.v1';

type LiveBypassByPath = Record<string, LiveBypass>;

function readBypassStore(): LiveBypassByPath {
  try {
    const raw = localStorage.getItem(BYPASS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as LiveBypassByPath;
  } catch {
    return {};
  }
}

function writeBypassStore(store: LiveBypassByPath) {
  try {
    localStorage.setItem(BYPASS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* localStorage cheio/indisponível — o bypass continua em memória */
  }
}

/** Bypass salvo pra um instrumento (padrão: nenhum efeito desligado). */
export function loadLiveBypass(path: string): LiveBypass {
  return normalizeLiveBypass(readBypassStore()[path]);
}

/** Salva o bypass de um instrumento (merge com o que já havia). */
export function saveLiveBypass(path: string, bypass: LiveBypass) {
  const store = readBypassStore();
  store[path] = normalizeLiveBypass(bypass);
  writeBypassStore(store);
}

/** Apaga o bypass salvo de um instrumento (volta a nenhum desligado). */
export function clearLiveBypass(path: string) {
  const store = readBypassStore();
  if (path in store) {
    delete store[path];
    writeBypassStore(store);
  }
}
