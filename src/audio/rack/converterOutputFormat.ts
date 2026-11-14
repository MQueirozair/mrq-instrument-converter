/**
 * Escolha do formato de saída do Instrument Converter (v0.2.16).
 *
 * Antes, `.sf2`/`.sf3` só ficavam habilitados DEPOIS de o usuário salvar um
 * `.mrq`; a foto enviada mostra os dois botões cinzas mesmo com o item
 * "PRONTO". Agora os três formatos são escolhas reais: SoundFont é salvo
 * diretamente, com uma conversão temporária automática para `.mrq` quando
 * necessária (o escritor SF2 precisa ler as amostras de um `.mrq` em disco).
 *
 * Módulo puro, sem React/Tauri, para as regras de habilitação e os diálogos
 * serem testáveis no Node.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ConverterFormatId } from './converterFormats';

export type ConverterOutputFormat = 'mrq' | 'sf2' | 'sf3';
export type SoundFontOutputFormat = Extract<ConverterOutputFormat, 'sf2' | 'sf3'>;

export interface ConverterOutputChoice {
  enabled: boolean;
  reason: string;
  /** SF2/SF3 sem `.mrq` salvo: o app gera um `.mrq` temporário nos bastidores. */
  requiresTemporaryMrq: boolean;
}

export type ConverterOutputChoices = Record<ConverterOutputFormat, ConverterOutputChoice>;

export interface ConverterOutputAvailabilityInput {
  status: string;
  sourceFormat: ConverterFormatId | null;
  convertedPath?: string;
  captureKind?: 'kontakt-audio' | 'auto-sampler' | null;
  /** `mrqInstrumentHasExportableZones(editedInstrument ?? instrument)`. */
  hasExportableZones: boolean;
  exportingSoundFont?: SoundFontOutputFormat;
}

const BUSY_STATUSES = new Set(['pending', 'inspecting', 'converting']);

function disabled(reason: string, requiresTemporaryMrq = false): ConverterOutputChoice {
  return { enabled: false, reason, requiresTemporaryMrq };
}

/**
 * Um item "PRONTO" e inspecionado pode escolher QUALQUER um dos três formatos.
 * `.mrq` exige um formato de origem reconhecido; SF2/SF3 também aceitam um
 * item que já nasceu convertido (Auto Sampler / captura Kontakt).
 */
export function converterOutputChoices(input: ConverterOutputAvailabilityInput): ConverterOutputChoices {
  const busyReason = input.exportingSoundFont
    ? `Aguarde a exportação .${input.exportingSoundFont} terminar.`
    : BUSY_STATUSES.has(input.status)
      ? 'Aguarde a análise/conversão atual terminar.'
      : '';
  const hasSource = Boolean(input.sourceFormat);
  const hasMrq = Boolean(input.convertedPath);
  const needsTemporaryMrq = !hasMrq && hasSource;

  let mrq: ConverterOutputChoice;
  if (busyReason) mrq = disabled(busyReason);
  else if (input.captureKind) mrq = disabled('Este item já nasceu como .mrq (Auto Sampler / captura Kontakt).');
  else if (!hasSource) mrq = disabled('Formato de origem não reconhecido — não há como converter para .mrq.');
  else mrq = { enabled: true, reason: 'Salvar como instrumento nativo .mrq.', requiresTemporaryMrq: false };

  const soundFontBase: Omit<ConverterOutputChoice, 'reason'> = {
    enabled: !busyReason && input.hasExportableZones && (hasSource || hasMrq),
    requiresTemporaryMrq: needsTemporaryMrq,
  };
  let soundFontReason: string;
  if (busyReason) soundFontReason = busyReason;
  else if (!input.hasExportableZones) soundFontReason = 'O instrumento analisado não tem zonas com amostra para exportar.';
  else if (!hasSource && !hasMrq) soundFontReason = 'Analise um instrumento antes de escolher o formato de saída.';
  else if (needsTemporaryMrq) soundFontReason = 'Salvar diretamente em SoundFont — o app faz uma conversão temporária para .mrq nos bastidores.';
  else soundFontReason = 'Salvar diretamente em SoundFont usando o .mrq já gerado.';

  return {
    mrq,
    sf2: { ...soundFontBase, reason: soundFontReason },
    sf3: { ...soundFontBase, reason: soundFontReason },
  };
}

/** Opções do diálogo "Salvar como" para cada formato — centraliza extensão,
 *  nome sugerido e filtro para nunca salvar `.sf3` com filtro de `.sf2`. */
export function outputFormatSaveDialogOptions(format: ConverterOutputFormat, fileName: string): {
  title: string;
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
} {
  const base = fileName.replace(/\.[^.]+$/, '') || 'instrumento';
  if (format === 'mrq') {
    return {
      title: 'Salvar instrumento MRQ',
      defaultPath: `${base}.mrq`,
      filters: [{ name: 'MRQ Instrument (.mrq)', extensions: ['mrq'] }],
    };
  }
  const label = format === 'sf2' ? 'SoundFont 2 (.sf2)' : 'SoundFont 3 (.sf3)';
  return {
    title: format === 'sf2' ? 'Salvar SoundFont 2 (.sf2)' : 'Salvar SoundFont 3 (.sf3)',
    defaultPath: `${base}.${format}`,
    filters: [{ name: label, extensions: [format] }],
  };
}

export const TEMPORARY_MRQ_PREFIX = 'mrq-sf-export-';

/** Nome previsível e restrito: o comando Rust de limpeza só aceita EXATAMENTE
 *  este prefixo + `.mrq`, para não virar um "apagar arquivo qualquer". */
export function temporaryMrqFileName(now: number, salt: string): string {
  const safeSalt = String(salt).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || '0';
  const safeNow = Number.isFinite(now) ? Math.max(0, Math.round(now)) : 0;
  return `${TEMPORARY_MRQ_PREFIX}${safeNow}-${safeSalt}.mrq`;
}

export function isTemporaryMrqFileName(fileName: string): boolean {
  return /^mrq-sf-export-[A-Za-z0-9_-]+\.mrq$/.test(fileName);
}

/** Remove somente o `.mrq` temporário criado por esta exportação. */
export async function removeTemporaryMrqFile(path: string): Promise<void> {
  await invoke('remove_temp_converter_file', { path });
}
