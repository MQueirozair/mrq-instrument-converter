/**
 * Lógica pura do Gerenciador de Instrumentos Convertidos (v0.2.21) —
 * lista persistente de arquivos `.mrq` convertidos (pra reabrir depois),
 * detecção de "modelo sujo" (edições não salvas) e validação de trims de
 * amostra. Sem React, sem Tauri, sem DOM — testável em Node puro (ver
 * scripts/test-converted-instruments.mjs).
 *
 * O painel "INSTRUMENTOS CONVERTIDOS" do InstrumentConverter usa isto pra
 * mostrar/esconder a lista; o Estúdio (InstrumentStudio.tsx) usa pra
 * saber se há edições pendentes antes de salvar.
 */

import type { MrqInstrumentModel, MrqSampleTrim } from './mrqFormat';

export interface ConvertedInstrumentEntry {
  /** Caminho absoluto do arquivo `.mrq` no disco. */
  path: string;
  /** Nome de exibição (nome do arquivo, sem caminho). */
  name: string;
  /** Quando entrou na lista (epoch ms). */
  addedAt: number;
}

const STORAGE_KEY = 'mrq.convertedInstruments.v1';
const MAX_ENTRIES = 200;

/** Lê a lista persistida (localStorage). Nunca lança: storage indisponível
 *  ou JSON inválido vira lista vazia. */
export function loadConvertedInstruments(storage?: Pick<Storage, 'getItem'> | null): ConvertedInstrumentEntry[] {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    const raw = store?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ConvertedInstrumentEntry =>
        typeof e === 'object' && e !== null && typeof (e as ConvertedInstrumentEntry).path === 'string' && (e as ConvertedInstrumentEntry).path.length > 0
    );
  } catch {
    return [];
  }
}

/** Persiste a lista (localStorage). Falha silenciosa de propósito — a lista
 *  é conveniência, nunca pode quebrar o fluxo principal do app. */
export function saveConvertedInstruments(entries: ConvertedInstrumentEntry[], storage?: Pick<Storage, 'setItem'> | null): void {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    store?.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage cheio/indisponível — ignora */
  }
}

export function basenameOfPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Adiciona um caminho à lista (sem duplicar — compara por caminho exato).
 *  Devolve a NOVA lista (não muta a entrada). */
export function addConvertedInstrument(entries: ConvertedInstrumentEntry[], path: string, now = Date.now()): ConvertedInstrumentEntry[] {
  if (!path) return entries;
  if (entries.some((e) => e.path === path)) return entries;
  return [{ path, name: basenameOfPath(path), addedAt: now }, ...entries].slice(0, MAX_ENTRIES);
}

/** Remove um caminho da lista. Devolve a NOVA lista. */
export function removeConvertedInstrument(entries: ConvertedInstrumentEntry[], path: string): ConvertedInstrumentEntry[] {
  return entries.filter((e) => e.path !== path);
}

/** `true` quando o modelo editado difere do original (edições não salvas).
 *  Compara por serialização estável — os dois modelos vêm do mesmo
 *  `mrq_read_metadata`, então a ordem das chaves é a mesma dos dois lados. */
export function isInstrumentDirty(original: MrqInstrumentModel, edited: MrqInstrumentModel): boolean {
  return JSON.stringify(original) !== JSON.stringify(edited);
}

/** Valida/limita um trim contra o tamanho real da amostra (em frames).
 *  Devolve o trim corrigido, ou `null` quando não há corte válido
 *  (start >= end depois de limitar, ou amostra vazia). */
export function clampTrim(trim: MrqSampleTrim, totalFrames: number): MrqSampleTrim | null {
  if (totalFrames <= 0) return null;
  // Início além do fim da amostra: não há corte válido (não "prende" no
  // último frame — isso geraria uma amostra degenerada de 1 frame).
  if (trim.startFrame >= totalFrames) return null;
  const startFrame = Math.max(0, Math.floor(trim.startFrame));
  const endFrame = Math.min(Math.floor(trim.endFrame), totalFrames);
  // Seleção vazia/invertida (start >= end) não é corte válido — não
  // "corrige" pra 1 frame, que seria uma amostra degenerada.
  if (endFrame <= startFrame) return null;
  return { sampleId: trim.sampleId, startFrame, endFrame };
}

/** `true` quando o trim realmente corta algo (não é o arquivo inteiro). */
export function isTrimActive(trim: MrqSampleTrim | null | undefined, totalFrames: number): boolean {
  if (!trim || totalFrames <= 0) return false;
  return trim.startFrame > 0 || trim.endFrame < totalFrames;
}

/** Duração legível de uma amostra: "3,2s" / "450ms". */
export function formatSampleDuration(frames: number, sampleRateHz: number): string {
  if (sampleRateHz <= 0) return '—';
  const seconds = frames / sampleRateHz;
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(1).replace('.', ',')}s`;
}

/** Tamanho legível de arquivo: "1,2 GB" / "340 MB" / "12 KB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1).replace('.', ',')} ${units[unit]}`;
}
