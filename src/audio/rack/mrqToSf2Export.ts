/**
 * Exportação genérica de QUALQUER instrumento já convertido pra `.mrq`
 * (dentro do MRQ Instrument Converter — `InstrumentConverter.tsx`) de volta
 * pra `.sf2`/`.sf3` — diferente do Auto Sampler (`autoSampler.ts`), que já
 * tem seu próprio caminho de exportação SF2 direto a partir de amostras
 * recém-capturadas em memória, este módulo lê as amostras de um `.mrq` JÁ
 * GRAVADO em disco (`mrqExtractSample`, mesmo comando usado pela
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
 */

import { mrqExtractSample, type MrqDecodedSample, type MrqInstrumentModel } from './mrqFormat';
import { buildMultiPresetSf2Binary, type Sf2ExportPreset, type Sf2ExportZone } from './sf2Export';

/** `true` quando o modelo tem pelo menos uma zona de amostra em algum preset/grupo — usado pra habilitar/desabilitar o(s) botão(ões) de exportar SF2/SF3 na UI sem precisar tentar montar o SF2 primeiro. */
export function mrqInstrumentHasExportableZones(instrument: MrqInstrumentModel | undefined): boolean {
  if (!instrument) return false;
  return instrument.presets.some((preset) => preset.groups.some((group) => group.zones.length > 0));
}

/** Monta os `Sf2ExportPreset[]` (um por `MrqPreset` do modelo, com as zonas de TODOS os grupos daquele preset
 *  concatenadas — o SF2 não tem o conceito de "grupo" separado do `MrqInstrumentModel`, só zonas dentro de um
 *  instrumento) lendo o PCM real de cada amostra única referenciada, via `mrqExtractSample(convertedPath, sampleId)`.
 *  Amostras reaproveitadas por várias zonas (ex.: round robin apontando pro mesmo sampleId) são extraídas uma
 *  única vez e reaproveitadas — só o número de ZONAS de saída multiplica, nunca as chamadas ao backend Rust. */
async function buildSf2PresetsFromInstrument(convertedPath: string, instrument: MrqInstrumentModel): Promise<Sf2ExportPreset[]> {
  const sampleCache = new Map<string, MrqDecodedSample>();
  async function decodedFor(sampleId: string): Promise<MrqDecodedSample> {
    const cached = sampleCache.get(sampleId);
    if (cached) return cached;
    const decoded = await mrqExtractSample(convertedPath, sampleId);
    sampleCache.set(sampleId, decoded);
    return decoded;
  }

  const presets: Sf2ExportPreset[] = [];
  for (const preset of instrument.presets) {
    const zones: Sf2ExportZone[] = [];
    for (const group of preset.groups) {
      for (const zone of group.zones) {
        const decoded = await decodedFor(zone.sampleId);
        const interleaved = decoded.interleaved instanceof Float32Array ? decoded.interleaved : Float32Array.from(decoded.interleaved);
        const channels = decoded.channels >= 2 ? 2 : 1;
        const hasLoop = zone.loopEnabled && zone.loopStart != null && zone.loopEnd != null && zone.loopEnd > zone.loopStart;
        zones.push({
          label: zone.sampleId,
          rootNote: zone.rootNote,
          loKey: zone.loKey,
          hiKey: zone.hiKey,
          loVel: zone.loVel,
          hiVel: zone.hiVel,
          interleaved,
          sampleRateHz: decoded.sampleRateHz,
          channels,
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
export async function buildSf2FromMrqInstrument(convertedPath: string, instrument: MrqInstrumentModel): Promise<Uint8Array> {
  const presets = await buildSf2PresetsFromInstrument(convertedPath, instrument);
  if (presets.length === 0) {
    throw new Error('este instrumento não tem nenhuma zona com amostra pra exportar — converta pra .mrq com pelo menos um preset/zona antes.');
  }
  return buildMultiPresetSf2Binary(presets, instrument.name);
}
