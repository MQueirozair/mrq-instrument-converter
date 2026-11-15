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
  volumeDb: { key: 'volumeDb', label: 'VOLUME dB', min: -60, max: 12, step: 0.5, format: f1, default: 0 },
  pan: { key: 'pan', label: 'PAN', min: -1, max: 1, step: 0.05, format: f2, default: 0 },
  tuneCents: { key: 'tuneCents', label: 'AFINACAO cents', min: -100, max: 100, step: 1, format: f1, default: 0 },
  attackMs: { key: 'attackMs', label: 'ATAQUE ms', min: 0, max: 2000, step: 5, format: f1, default: 0 },
  releaseMs: { key: 'releaseMs', label: 'RELEASE ms', min: 0, max: 5000, step: 10, format: f1, default: 100 },
  eqLowDb: { key: 'eqLowDb', label: 'EQ GRAVES dB', min: -15, max: 15, step: 0.5, format: f1, default: 0 },
  eqMidDb: { key: 'eqMidDb', label: 'EQ MEDIOS dB', min: -15, max: 15, step: 0.5, format: f1, default: 0 },
  eqHighDb: { key: 'eqHighDb', label: 'EQ AGUDOS dB', min: -15, max: 15, step: 0.5, format: f1, default: 0 },
  driveDb: { key: 'driveDb', label: 'DRIVE dB', min: 0, max: 24, step: 0.5, format: f1, default: 0 },
  sustain: { key: 'sustain', label: 'SUSTAIN %', min: 0, max: 100, step: 1, format: f1, default: 100 },
  reverb: { key: 'reverb', label: 'REVERB %', min: 0, max: 100, step: 1, format: f1, default: 0 },
  reverbSize: { key: 'reverbSize', label: 'TAMANHO %', min: 10, max: 100, step: 1, format: f1, default: 75 },
  reverbDamp: { key: 'reverbDamp', label: 'DAMP %', min: 0, max: 100, step: 1, format: f1, default: 50 },
  reverbPredelayMs: { key: 'reverbPredelayMs', label: 'PRE-DELAY ms', min: 0, max: 500, step: 5, format: f1, default: 25 },
  reverbColor: { key: 'reverbColor', label: 'COR %', min: 0, max: 100, step: 1, format: f1, default: 80 },
  stereo: { key: 'stereo', label: 'STEREO %', min: 0, max: 100, step: 1, format: f1, default: 50 },
  delay: { key: 'delay', label: 'DELAY %', min: 0, max: 100, step: 1, format: f1, default: 0 },
  delayTimeMs: { key: 'delayTimeMs', label: 'TEMPO ms', min: 0, max: 2000, step: 10, format: f1, default: 350 },
  delayFeedback: { key: 'delayFeedback', label: 'FEEDBACK %', min: 0, max: 95, step: 1, format: f1, default: 35 },
  chorus: { key: 'chorus', label: 'CHORUS %', min: 0, max: 100, step: 1, format: f1, default: 0 },
  chorusRateHz: { key: 'chorusRateHz', label: 'RATE Hz', min: 0.05, max: 10, step: 0.05, format: f2, default: 0.7 },
  chorusDepth: { key: 'chorusDepth', label: 'DEPTH %', min: 0, max: 100, step: 1, format: f1, default: 50 },
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

/** STEREO % (0..100) → largura mid/side (0 = mono, 50 = normal, 100 = larga). */
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
