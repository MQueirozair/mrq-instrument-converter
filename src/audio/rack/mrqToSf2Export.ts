/**
 * Exportação genérica de QUALQUER instrumento já convertido pra `.mrq`
 * (dentro do MRQ Instrument Converter — `InstrumentConverter.tsx`) de volta
 * pra `.sf2`/`.sf3` — diferente do Auto Sampler (`autoSampler.ts`), que já
 * tem seu próprio caminho de exportação SF2 direto a partir de amostras
 * recém-capturadas em memória, este módulo lê as amostras de um `.mrq` JÁ
 * GRAVADO em disco (`mrqExtractSamples`, mesmo comando usado pela
 * pré-escuta — nunca decodificação de áudio no WebView) e usa o MESMO
 * escritor RIFF (`sf2Export.ts`, `buildMultiPresetSf2Binary`) — um
 * instrumento por `MrqPreset` do modelo de origem, preservando bancos
 * multi-preset (ex.: banco `.sf2` com vários instrumentos, banco `.syx`
 * DX7 com até 32 patches).
 *
 * IMPORTANTE sobre `.sf3`: o escritor (`sf2Export.ts`) NÃO comprime
 * amostra nenhuma — SF3 de verdade usa Ogg Vorbis internamente, e este app
 * não tem (ainda) um codificador Vorbis embutido (ver comentário no topo
 * de `sf2Export.ts`). `exportMrqInstrumentToSf2`/`exportMrqInstrumentToSf3`
 * abaixo geram o MESMO binário PCM 16-bit sem compressão nos dois casos —
 * um `.sf3` gerado aqui toca normalmente em qualquer sintetizador
 * compatível com SF2/SF3 (o conteúdo real decide o que tocar, não a
 * extensão do arquivo), só não fica menor que o `.sf2` equivalente. A UI
 * (`InstrumentConverter.tsx`) avisa isso explicitamente antes de salvar
 * como `.sf3`.
 *
 * LIMITAÇÃO HERDADA do escritor: só tecla/velocity/root-key/loop/estéreo
 * são preservados — `MrqZone.tuneCents`/`volumeDb`/`envelope`/`filter` do
 * modelo de origem não têm generator SF2 equivalente implementado aqui
 * ainda, então se perdem neste export (mesma limitação que já existia pro
 * Auto Sampler).
 *
 * v0.2.18 — extração em LOTE com progresso: antes, cada zona disparava um
 * `mrq_extract_sample` separado (centenas de invokes sequenciais, cada um
 * reabrindo o `.mrq` e reparseando o JSON de metadados inteiro), sem nenhum
 * retorno visual — numa biblioteca grande a exportação parecia travada
 * pra sempre ("fica só girando"). Agora as amostras únicas são extraídas
 * em lotes (`mrq_extract_samples`, metadados lidos uma vez só no Rust),
 * com `onProgress(done, total)` a cada lote e um `setTimeout(0)` entre
 * lotes pra UI pintar o progresso. Cada amostra decodificada é convertida
 * pra Int16 na hora e o Float32 descartado (metade da memória).
 */

import { mrqExtractSamples, type MrqDecodedSample, type MrqInstrumentModel } from './mrqFormat';
import { buildMultiPresetSf2Binary, float32ToInt16Interleaved, type Sf2ExportPreset, type Sf2ExportZone } from './sf2Export';

/** Quantas amostras únicas por chamada em lote ao backend — grande o
 *  bastante pra amortizar o custo do invoke, pequeno o bastante pra cada
 *  lote terminar rápido e o progresso aparecer com frequência. */
const EXTRACT_BATCH_SIZE = 16;

/** `true` quando o modelo tem pelo menos uma zona de amostra em algum preset/grupo — usado pra habilitar/desabilitar o(s) botão(ões) de exportar SF2/SF3 na UI sem precisar tentar montar o SF2 primeiro. */
export function mrqInstrumentHasExportableZones(instrument: MrqInstrumentModel | undefined): boolean {
  if (!instrument) return false;
  return instrument.presets.some((preset) => preset.groups.some((group) => group.zones.length > 0));
}

export interface BuildSf2FromMrqOptions {
  /** Chamado a cada lote extraído: `done` amostras únicas de `total` já
   *  decodificadas. A UI usa isso pra mostrar progresso real (ex.:
   *  "Exportando .sf2… 128/512 amostras") em vez de um spinner cego. */
  onProgress?: (done: number, total: number) => void;
}

/** Monta os `Sf2ExportPreset[]` (um por `MrqPreset` do modelo, com as zonas de TODOS os grupos daquele preset
 *  concatenadas — o SF2 não tem o conceito de "grupo" separado do `MrqInstrumentModel`, só zonas dentro de um
 *  instrumento) lendo o PCM real de cada amostra única referenciada, via `mrqExtractSamples(convertedPath, ids)`
 *  em lotes. Amostras reaproveitadas por várias zonas (ex.: round robin apontando pro mesmo sampleId) são
 *  extraídas uma única vez — só o número de ZONAS de saída multiplica, nunca as chamadas ao backend Rust. */
async function buildSf2PresetsFromInstrument(
  convertedPath: string,
  instrument: MrqInstrumentModel,
  options?: BuildSf2FromMrqOptions
): Promise<Sf2ExportPreset[]> {
  // Amostras únicas, na ordem em que aparecem pela primeira vez — é essa a
  // lista que o progresso conta ("done/total amostras").
  const uniqueSampleIds: string[] = [];
  const seen = new Set<string>();
  for (const preset of instrument.presets) {
    for (const group of preset.groups) {
      for (const zone of group.zones) {
        if (!seen.has(zone.sampleId)) {
          seen.add(zone.sampleId);
          uniqueSampleIds.push(zone.sampleId);
        }
      }
    }
  }

  // Extrai em lotes, convertendo cada amostra pra Int16 na hora (o Float32
  // decodificado é descartado logo em seguida — metade da memória retida).
  const decodedById = new Map<string, { pcmInt16: Int16Array; sampleRateHz: number; channels: 1 | 2 }>();
  for (let offset = 0; offset < uniqueSampleIds.length; offset += EXTRACT_BATCH_SIZE) {
    const batchIds = uniqueSampleIds.slice(offset, offset + EXTRACT_BATCH_SIZE);
    const decodedBatch: MrqDecodedSample[] = await mrqExtractSamples(convertedPath, batchIds);
    for (const decoded of decodedBatch) {
      const interleaved = decoded.interleaved instanceof Float32Array ? decoded.interleaved : Float32Array.from(decoded.interleaved);
      decodedById.set(decoded.sampleId, {
        pcmInt16: float32ToInt16Interleaved(interleaved),
        sampleRateHz: decoded.sampleRateHz,
        channels: decoded.channels >= 2 ? 2 : 1,
      });
    }
    options?.onProgress?.(Math.min(offset + batchIds.length, uniqueSampleIds.length), uniqueSampleIds.length);
    // Cede o event loop entre lotes pra UI pintar o progresso (sem isso, um
    // lote grande de decodificação pode bloquear o paint por um tempo).
    if (offset + batchIds.length < uniqueSampleIds.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const presets: Sf2ExportPreset[] = [];
  for (const preset of instrument.presets) {
    const zones: Sf2ExportZone[] = [];
    for (const group of preset.groups) {
      for (const zone of group.zones) {
        const decoded = decodedById.get(zone.sampleId);
        if (!decoded) continue;
        const hasLoop = zone.loopEnabled && zone.loopStart != null && zone.loopEnd != null && zone.loopEnd > zone.loopStart;
        zones.push({
          label: zone.sampleId,
          rootNote: zone.rootNote,
          loKey: zone.loKey,
          hiKey: zone.hiKey,
          loVel: zone.loVel,
          hiVel: zone.hiVel,
          pcmInt16: decoded.pcmInt16,
          sampleRateHz: decoded.sampleRateHz,
          channels: decoded.channels,
          loopStartFrame: hasLoop ? zone.loopStart! : undefined,
          loopEndFrame: hasLoop ? zone.loopEnd! : undefined,
        });
      }
    }
    if (zones.length > 0) presets.push({ name: preset.name || instrument.name, zones });
  }
  return presets;
}

/** Monta o `.sf2`/`.sf3` binário (mesmo formato nos dois casos — ver aviso no topo deste arquivo) a partir de um
 *  instrumento já convertido. Lança erro se o modelo não tiver nenhuma zona com amostra (ex.: instrumento vazio). */
export async function buildSf2FromMrqInstrument(
  convertedPath: string,
  instrument: MrqInstrumentModel,
  options?: BuildSf2FromMrqOptions
): Promise<Uint8Array> {
  const presets = await buildSf2PresetsFromInstrument(convertedPath, instrument, options);
  if (presets.length === 0) {
    throw new Error('este instrumento não tem nenhuma zona com amostra pra exportar — converta pra .mrq com pelo menos um preset/zona antes.');
  }
  return buildMultiPresetSf2Binary(presets, instrument.name);
}
