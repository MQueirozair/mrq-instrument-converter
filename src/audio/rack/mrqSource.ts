/**
 * Suporte puro à importação de um `.mrq` nativo no Instrument Converter
 * (v0.2.17). Sem React/Tauri: só regras de nome, relatório de compatibilidade
 * e montagem da inspeção, para serem testáveis no Node.
 *
 * Um `.mrq` já contém o instrumento E as amostras FLAC. Ele não precisa ser
 * "convertido para .mrq" de novo: ao importar, marcamos o próprio arquivo
 * como `convertedPath`, liberando pré-escuta, Editor de Mapeamento e exportação
 * direta para `.sf2`/`.sf3`.
 */
import type { MrqCompatibilityReport, MrqFileMetadata, MrqInstrumentModel } from './mrqFormat';

export const MRQ_SOURCE_EXTENSION = 'mrq';
export const MRQ_MAGIC = 'MRQ1';
export const MRQ_MAGIC_LABEL = 'MRQ1 (Instrumento MRQ)';

export function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isMrqFilePath(path: string): boolean {
  const name = basenameOf(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 && name.slice(dot + 1).toLowerCase() === MRQ_SOURCE_EXTENSION;
}

export function looksLikeMrqHeader(header: Uint8Array | number[]): boolean {
  return header.length >= 4
    && header[0] === 'M'.charCodeAt(0)
    && header[1] === 'R'.charCodeAt(0)
    && header[2] === 'Q'.charCodeAt(0)
    && header[3] === '1'.charCodeAt(0);
}

/** Relatório honesto: o `.mrq` é a origem mais fiel possível; a perda está
 *  apenas nos parâmetros que o escritor SoundFont ainda não representa. */
export function buildMrqSourceCompatibilityReport(metadata: MrqFileMetadata): MrqCompatibilityReport {
  const zoneCount = metadata.instrument.presets.reduce(
    (count, preset) => count + preset.groups.reduce((n, group) => n + group.zones.length, 0),
    0
  );
  return {
    preserved: [
      {
        field: 'Áudio',
        detail: `${metadata.samples.length} amostra(s) FLAC lossless lidas diretamente do arquivo .mrq, sem recodificar a origem.`,
      },
      {
        field: 'Mapeamento',
        detail: `${metadata.instrument.presets.length} preset(s), ${zoneCount} zona(s), faixas de tecla/velocity, nota raiz e pontos de loop preservados do .mrq.`,
      },
      {
        field: 'Round robin',
        detail: 'Quando existir, o agrupamento do .mrq é mantido no instrumento carregado; no Rack ele alterna normalmente.',
      },
    ],
    approximated: [],
    unsupported: [
      {
        field: 'Afinação fina, volume, envelope e filtro no SF2/SF3',
        detail: 'O exportador SoundFont atual preserva tecla, velocity, nota raiz, loop e estéreo, mas ainda não grava generators para tuneCents/volumeDb/ADSR/filtro. O .mrq original continua com esses dados.',
      },
    ],
  };
}

export interface MrqSourceInspection {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  nativeMetadata: MrqFileMetadata;
}

export function inspectMrqMetadata(metadata: MrqFileMetadata): MrqSourceInspection {
  if (!metadata.instrument || !Array.isArray(metadata.instrument.presets)) {
    throw new Error('O arquivo .mrq não contém um instrumento válido.');
  }
  if (!Array.isArray(metadata.samples)) {
    throw new Error('O arquivo .mrq não contém um índice de amostras válido.');
  }
  return {
    instrument: metadata.instrument,
    compatibility: buildMrqSourceCompatibilityReport(metadata),
    nativeMetadata: metadata,
  };
}
