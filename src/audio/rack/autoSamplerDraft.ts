/**
 * Rascunho persistente do Auto Sampler (v0.2.15).
 *
 * O problema relatado: um clique acidental fora do modal desmontava o
 * componente e todas as configurações do assistente voltavam ao zero. Além de
 * impedir o fechamento por clique fora, guardamos um rascunho pequeno e
 * validado em localStorage: assim os ajustes também sobrevivem a um
 * fechamento intencional, a uma troca de tela e até a reiniciar o app.
 *
 * Este módulo é puro (sem React, Tauri ou acesso direto a localStorage na
 * assinatura das funções de normalização), para poder ser testado no Node.
 * Só dados escalares de configuração são salvos — nunca áudio, resultados de
 * captura, streams ou objetos grandes.
 */
import type { AutoLoopMode, VelocityResponseCurve } from './autoSamplerEngine';

export const AUTO_SAMPLER_DRAFT_KEY = 'mrq.autoSampler.draft.v1';
export const AUTO_SAMPLER_DRAFT_VERSION = 1;

/** Mesmo valor de `SYSTEM_DEFAULT_AUDIO_INPUT_ID` (evita puxar o módulo Tauri
 *  inteiro só por uma constante nos testes de lógica pura). */
export const AUTO_SAMPLER_DEFAULT_AUDIO_ID = '__system_default__';

export type AutoSamplerStepId = 1 | 2 | 3 | 4;

export interface AutoSamplerDraft {
  version: typeof AUTO_SAMPLER_DRAFT_VERSION;
  step: AutoSamplerStepId;
  instrumentName: string;
  rangeStartNote: number;
  rangeEndNote: number;
  sampleEverySemitones: number;
  velocityLayers: number;
  velocityResponse: VelocityResponseCurve;
  customVelocityBreakpoints?: number[];
  roundRobinCount: number;
  sustainSeconds: number;
  releaseTailSeconds: number;
  autoLoop: AutoLoopMode;
  autoLoopStartPct: number;
  autoLoopEndPct: number;
  oneShot: boolean;
  inputGainDb: number;
  midiOutputId: string;
  midiOutputLabel: string;
  midiChannel: number;
  audioInputDeviceId: string;
  audioInputLabel: string;
  midiTested: boolean;
  audioTested: boolean;
  outputMrq: boolean;
  outputSf2: boolean;
}

/** Storage mínimo necessário — facilita injetar um mock nos testes. */
export type AutoSamplerDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const VELOCITY_CURVES: VelocityResponseCurve[] = [
  'linear', 'exp1', 'exp2', 'exp3', 'log1', 'log2', 'log3', 'custom',
];
const AUTO_LOOP_MODES: AutoLoopMode[] = [
  'none', 'search', 'search-xfade', 'search-rev-xfade', 'bidirectional',
];

/** Os mesmos valores iniciais que o assistente usava antes da persistência. */
export function createDefaultAutoSamplerDraft(): AutoSamplerDraft {
  return {
    version: AUTO_SAMPLER_DRAFT_VERSION,
    step: 1,
    instrumentName: 'Instrumento Auto Sampler',
    rangeStartNote: 48,
    rangeEndNote: 72,
    sampleEverySemitones: 3,
    velocityLayers: 1,
    velocityResponse: 'linear',
    customVelocityBreakpoints: undefined,
    roundRobinCount: 1,
    sustainSeconds: 2,
    releaseTailSeconds: 1,
    autoLoop: 'none',
    autoLoopStartPct: 40,
    autoLoopEndPct: 90,
    oneShot: false,
    inputGainDb: 0,
    midiOutputId: '',
    midiOutputLabel: '',
    midiChannel: 1,
    audioInputDeviceId: AUTO_SAMPLER_DEFAULT_AUDIO_ID,
    audioInputLabel: 'Microfone / Entrada padrão do sistema',
    midiTested: false,
    audioTested: false,
    outputMrq: true,
    outputSf2: true,
  };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

function shortString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Só aceita pontos que o motor pode consumir: `layers + 1` valores MIDI
 *  inteiros, estritamente crescentes, começando em 0 e terminando em 127. */
function normalizedBreakpoints(value: unknown, layers: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== layers + 1) return undefined;
  const points = value.map((v) => Number(v));
  if (points.some((v) => !Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 127)) return undefined;
  if (points[0] !== 0 || points[points.length - 1] !== 127) return undefined;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i] <= points[i - 1]) return undefined;
  }
  return points;
}

/**
 * Converte qualquer JSON desconhecido num rascunho seguro. Campos corrompidos
 * voltam ao default sem derrubar o restante; uma curva Custom sem pontos
 * válidos volta para Linear em vez de travar a validação da captura.
 */
export function normalizeAutoSamplerDraft(raw: unknown): AutoSamplerDraft | null {
  const obj = objectOrNull(raw);
  if (!obj || obj.version !== AUTO_SAMPLER_DRAFT_VERSION) return null;
  const d = createDefaultAutoSamplerDraft();
  const layers = finiteNumber(obj.velocityLayers, d.velocityLayers, 1, 16, true);
  let curve = oneOf<VelocityResponseCurve>(obj.velocityResponse, VELOCITY_CURVES, d.velocityResponse);
  const breakpoints = curve === 'custom' ? normalizedBreakpoints(obj.customVelocityBreakpoints, layers) : undefined;
  if (curve === 'custom' && !breakpoints) curve = 'linear';

  return {
    version: AUTO_SAMPLER_DRAFT_VERSION,
    step: finiteNumber(obj.step, d.step, 1, 4, true) as AutoSamplerStepId,
    instrumentName: shortString(obj.instrumentName, d.instrumentName, 120),
    rangeStartNote: finiteNumber(obj.rangeStartNote, d.rangeStartNote, 0, 127, true),
    rangeEndNote: finiteNumber(obj.rangeEndNote, d.rangeEndNote, 0, 127, true),
    sampleEverySemitones: finiteNumber(obj.sampleEverySemitones, d.sampleEverySemitones, 1, 24, true),
    velocityLayers: layers,
    velocityResponse: curve,
    customVelocityBreakpoints: breakpoints,
    roundRobinCount: finiteNumber(obj.roundRobinCount, d.roundRobinCount, 1, 8, true),
    sustainSeconds: finiteNumber(obj.sustainSeconds, d.sustainSeconds, 0.1, 60),
    releaseTailSeconds: finiteNumber(obj.releaseTailSeconds, d.releaseTailSeconds, 0, 60),
    autoLoop: oneOf<AutoLoopMode>(obj.autoLoop, AUTO_LOOP_MODES, d.autoLoop),
    autoLoopStartPct: finiteNumber(obj.autoLoopStartPct, d.autoLoopStartPct, 0, 100),
    autoLoopEndPct: finiteNumber(obj.autoLoopEndPct, d.autoLoopEndPct, 0, 100),
    oneShot: booleanOr(obj.oneShot, d.oneShot),
    inputGainDb: finiteNumber(obj.inputGainDb, d.inputGainDb, -24, 24),
    midiOutputId: shortString(obj.midiOutputId, d.midiOutputId, 300),
    midiOutputLabel: shortString(obj.midiOutputLabel, d.midiOutputLabel, 160),
    midiChannel: finiteNumber(obj.midiChannel, d.midiChannel, 1, 16, true),
    audioInputDeviceId: shortString(obj.audioInputDeviceId, d.audioInputDeviceId, 300),
    audioInputLabel: shortString(obj.audioInputLabel, d.audioInputLabel, 160),
    midiTested: booleanOr(obj.midiTested, d.midiTested),
    audioTested: booleanOr(obj.audioTested, d.audioTested),
    outputMrq: booleanOr(obj.outputMrq, d.outputMrq),
    outputSf2: booleanOr(obj.outputSf2, d.outputSf2),
  };
}

/** Verdadeiro quando existe algo diferente do estado inicial para preservar. */
export function isAutoSamplerDraftDirty(draft: AutoSamplerDraft): boolean {
  const normalized = normalizeAutoSamplerDraft(draft) ?? createDefaultAutoSamplerDraft();
  return JSON.stringify(normalized) !== JSON.stringify(createDefaultAutoSamplerDraft());
}

function resolveStorage(explicit: AutoSamplerDraftStorage | null | undefined): AutoSamplerDraftStorage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readAutoSamplerDraft(storage?: AutoSamplerDraftStorage | null): AutoSamplerDraft | null {
  try {
    const s = resolveStorage(storage);
    const raw = s?.getItem(AUTO_SAMPLER_DRAFT_KEY);
    if (!raw) return null;
    return normalizeAutoSamplerDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Grava o rascunho; um rascunho igual ao default REMOVE a chave, para que
 *  "Voltar do zero" signifique literalmente não sobrar nada salvo. */
export function writeAutoSamplerDraft(draft: AutoSamplerDraft, storage?: AutoSamplerDraftStorage | null): boolean {
  try {
    const s = resolveStorage(storage);
    if (!s) return false;
    if (!isAutoSamplerDraftDirty(draft)) {
      s.removeItem(AUTO_SAMPLER_DRAFT_KEY);
      return true;
    }
    const normalized = normalizeAutoSamplerDraft(draft);
    if (!normalized) return false;
    s.setItem(AUTO_SAMPLER_DRAFT_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function clearAutoSamplerDraft(storage?: AutoSamplerDraftStorage | null): boolean {
  try {
    const s = resolveStorage(storage);
    if (!s) return false;
    s.removeItem(AUTO_SAMPLER_DRAFT_KEY);
    return true;
  } catch {
    return false;
  }
}
