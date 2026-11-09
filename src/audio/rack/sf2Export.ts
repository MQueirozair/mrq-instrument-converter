/**
 * Escritor de SoundFont 2 (`.sf2`) — NOVO neste app: até aqui o conversor só
 * LIA sf2/sf3 (`src-tauri/src/importers/sf2.rs`, biblioteca `soundfont`,
 * Rust), nunca escrevia um. Usado pelo Auto Sampler
 * (`autoSampler.ts`/`AutoSamplerDialog.tsx`) pra oferecer `.sf2` como
 * formato de saída além do `.mrq` nativo — a partir das MESMAS amostras já
 * capturadas (PCM Float32, já processado por `autoSamplerEngine.ts`:
 * ganho/corte de silêncio/loop aplicados) — e também pelo MRQ Instrument
 * Converter (`InstrumentConverter.tsx`/`mrqToSf2Export.ts`) pra exportar
 * QUALQUER instrumento já convertido pra `.mrq` de volta pra `.sf2`,
 * inclusive quando o modelo tem MÚLTIPLOS presets (ex.: um banco `.sf2`
 * importado com vários instrumentos, ou um banco `.syx` DX7 com até 32
 * patches — `syxImport.ts` cria um `MrqPreset` por voice) — por isso o
 * formato interno deste módulo sempre foi multi-preset
 * (`buildMultiPresetSf2Binary`); `buildSf2Binary` é só o caso de
 * conveniência de 1 preset só, mantido por compatibilidade com o Auto
 * Sampler e com `scripts/test-sf2-export.mjs`.
 *
 * Implementado 100% em TypeScript (sem depender do backend Rust pra isso):
 * o formato SF2 é um RIFF binário bem documentado e público (ao contrário
 * do Kontakt/.nki — ver converterFormats.ts), então não há o mesmo
 * problema legal de engenharia reversa. Referência normativa usada:
 * "SoundFont Technical Specification" v2.01/2.1 (E-mu Systems/Creative
 * Labs), seções 5 (INFO-list), 6 (sdta-list) e 7 (pdta-list/"hydra") —
 * synthfont.com/SFSPEC21.PDF é uma cópia amplamente citada do documento
 * original. Testado de verdade (não só "parece certo"): o
 * scripts/test-sf2-export.mjs gera um .sf2 sintético e RENDERIZA de
 * verdade com `fluidsynth` (sintetizador SF2 de código aberto), checando o
 * áudio resultante — não é só validação estrutural do binário.
 *
 * Suporta amostras mono e estéreo (par de amostras mono linkadas via
 * `wSampleLink`/`sfSampleType`, convenção padrão do formato pra estéreo —
 * ver §7.9/§8.1.2 do spec). NÃO comprime amostra nenhuma (isso é o SF3,
 * formato não-oficial que usa Ogg Vorbis — ver fluidsynth.org/wiki/
 * SoundFont3Format — ainda não implementado aqui; todo arquivo gerado por
 * este módulo, mesmo salvo com extensão `.sf3`, é PCM 16-bit sem
 * compressão, universalmente compatível mas do mesmo tamanho de um `.sf2`
 * — ver `mrqToSf2Export.ts` pro aviso que isso gera na UI do conversor).
 *
 * LIMITAÇÃO CONHECIDA (igual já era antes desta extensão multi-preset):
 * só os generators de tecla/velocity/root-key/loop/pan são escritos — nada
 * de `MrqZone.tuneCents`/`volumeDb`/`envelope`/`filter` é carregado pro
 * SF2 (o formato suporta isso via mais generators, mas não está
 * implementado aqui ainda). Round-trips (ex.: importar um `.sf2` com
 * envelope customizado, converter pra `.mrq`, exportar de volta pra
 * `.sf2`) perdem esses ajustes finos — o resultado toca as notas certas,
 * nas teclas certas, com os loops certos, mas sem o envelope/tune/ganho
 * originais.
 */

// ---------------------------------------------------------------------------
// Builder binário genérico — concatena Uint8Array em vez de usar um buffer
// crescente manual, mais simples de auditar (cada `push*` devolve void, o
// array final é montado uma vez só no fim).
// ---------------------------------------------------------------------------

class ByteWriter {
  private parts: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  u8(v: number): void {
    this.push(Uint8Array.of(v & 0xff));
  }

  u16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    this.push(b);
  }

  i16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, v, true);
    this.push(b);
  }

  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }

  /** String ASCII de tamanho FIXO `len`, truncada/preenchida com zero. Usada pra achSampleName/achInstName/achPresetName (20 bytes) e achInstName (idem). */
  fixedStr(s: string, len: number): void {
    const b = new Uint8Array(len);
    const ascii = toAscii(s);
    for (let i = 0; i < len; i += 1) b[i] = i < ascii.length ? ascii.charCodeAt(i) : 0;
    this.push(b);
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const p of this.parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  get byteLength(): number {
    return this.length;
  }
}

/** RIFF só aceita ASCII de 1 byte por caractere — troca qualquer coisa fora de 0x20-0x7e por `_` em vez de deixar passar lixo binário (nomes de instrumento podem vir de arquivos do usuário, com acento etc.). */
function toAscii(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0x5f;
    out += code >= 0x20 && code <= 0x7e ? ch : '_';
  }
  return out;
}

/** Monta um chunk RIFF (`id` + tamanho LE + dados + pad de 1 byte se ímpar). `id` precisa ter exatamente 4 caracteres ASCII. */
function riffChunk(id: string, data: Uint8Array): Uint8Array {
  if (id.length !== 4) throw new Error(`id de chunk RIFF precisa ter 4 caracteres: "${id}"`);
  const padded = data.length % 2 === 1;
  const out = new Uint8Array(8 + data.length + (padded ? 1 : 0));
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) out[i] = id.charCodeAt(i);
  view.setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/** Monta um chunk LIST (`LIST` + tamanho + "tipo" de 4 letras + sub-chunks concatenados). */
function riffList(listType: string, subChunks: Uint8Array[]): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) typeBytes[i] = listType.charCodeAt(i);
  let total = 4;
  for (const c of subChunks) total += c.length;
  const data = new Uint8Array(total);
  data.set(typeBytes, 0);
  let offset = 4;
  for (const c of subChunks) {
    data.set(c, offset);
    offset += c.length;
  }
  return riffChunk('LIST', data);
}

// ---------------------------------------------------------------------------
// Enumerações do formato — só os generators/valores realmente usados aqui
// (ver §8.1.2 "Generator Enumerators Table" do spec pros números completos).
// ---------------------------------------------------------------------------

const GEN_PAN = 17;
const GEN_INSTRUMENT = 41;
const GEN_KEY_RANGE = 43;
const GEN_VEL_RANGE = 44;
const GEN_SAMPLE_ID = 53;
const GEN_SAMPLE_MODES = 54;
const GEN_OVERRIDING_ROOT_KEY = 58;

const SAMPLE_MODE_NO_LOOP = 0;
const SAMPLE_MODE_LOOP_CONTINUOUSLY = 1;

/** `sfSampleType` em SHDR — ver §7.10. */
const SAMPLE_TYPE_MONO = 1;
const SAMPLE_TYPE_RIGHT = 2;
const SAMPLE_TYPE_LEFT = 4;

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface Sf2ExportZone {
  /** Só pra depuração/nome de amostra — não precisa ser único (SHDR trunca em 20 chars de qualquer forma). */
  label: string;
  rootNote: number;
  loKey: number;
  hiKey: number;
  loVel: number;
  hiVel: number;
  /** PCM Float32 intercalado, -1.0..1.0 — mesmo formato usado por mrqBuilderAddSample (ver mrqFormat.ts). */
  interleaved: Float32Array;
  sampleRateHz: number;
  channels: 1 | 2;
  /** Frames (não bytes, não amostras intercaladas) relativos ao INÍCIO deste buffer — ambos precisam vir juntos ou nenhum. */
  loopStartFrame?: number;
  loopEndFrame?: number;
}

export interface BuildSf2Options {
  /** Nome do instrumento/preset (até 20 chars ASCII — truncado se maior). */
  instrumentName: string;
  bank?: number; // default 0
  program?: number; // default 0
}

/** Um preset completo dentro do SF2 — ver `buildMultiPresetSf2Binary`. Cada
 *  preset vira seu próprio par PHDR+INST no arquivo final (nunca
 *  mesclado/achatado com os de outros presets), preservando a separação
 *  que o `MrqInstrumentModel` de origem já tinha (`presets[]`). */
export interface Sf2ExportPreset {
  /** Nome do preset/instrumento (até 20 chars ASCII — truncado se maior). */
  name: string;
  /** Banco MIDI (0-127). Default: 0. */
  bank?: number;
  /** Programa MIDI (0-127). Default: índice do preset na lista (clampado em 127) — assim cada preset de um banco multi-preset (ex.: 32 patches de um .syx DX7) fica num número de programa diferente e selecionável. */
  program?: number;
  zones: Sf2ExportZone[];
}

function floatTo16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped * 32767);
}

/** Extrai um canal de um buffer intercalado como array de inteiros 16-bit (sem normalização adicional — já deve vir em -1..1). */
function extractChannelInt16(interleaved: Float32Array, channels: number, channelIndex: number): Int16Array {
  const frameCount = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) out[f] = floatTo16(interleaved[f * channels + channelIndex]);
  return out;
}

/** Cada "sample físico" (um canal mono de uma zona) que vai virar um registro SHDR + um ponto de dado no pool `smpl`. Compartilhado GLOBALMENTE entre todos os presets do arquivo (índices únicos no arquivo inteiro, não por preset). */
interface PhysicalSample {
  name: string;
  pcm: Int16Array;
  sampleRateHz: number;
  rootNote: number;
  loopStartFrame?: number;
  loopEndFrame?: number;
  sampleType: number; // SAMPLE_TYPE_*
  /** Índice (0-based, preenchido depois) do outro canal, só pra pares estéreo. */
  linkedIndex?: number;
}

/** Uma "zona de instrumento" lógica — pode corresponder a 1 sample físico (mono) ou 2 (estéreo, par L/R). */
interface InstrumentZoneSpec {
  loKey: number;
  hiKey: number;
  loVel: number;
  hiVel: number;
  rootNote: number;
  sampleIndex: number; // índice GLOBAL em physicalSamples
  /** Só usado em pares estéreo (ver GEN_PAN) — -500 (esquerda) / +500 (direita); ausente = usa o default do sintetizador (centro). */
  panTenthPercent?: number;
}

/** Um instrumento SF2 (INST) — 1:1 com cada `Sf2ExportPreset` de entrada (mesma convenção já usada antes desta extensão: "preset com uma zona global apontando pro instrumento que carrega a distribuição real de tecla/velocity/sample"). */
interface InstrumentSpec {
  name: string;
  zones: InstrumentZoneSpec[];
}

const MIN_PAD_SAMPLES = 46; // ver §6.1 — mínimo de zero-samples exigido depois de cada amostra.

/** Monta um `.sf2` binário com UM OU MAIS presets — cada um com seu próprio
 *  instrumento/conjunto de zonas, todos compartilhando o mesmo pool global
 *  de amostras físicas (`sdta`/`shdr`). É a função "de verdade"; `buildSf2Binary`
 *  abaixo é só a variante de conveniência pra 1 preset só. */
export function buildMultiPresetSf2Binary(presets: Sf2ExportPreset[], soundFontName = 'MRQ Instrument Converter'): Uint8Array {
  const nonEmpty = presets.filter((p) => p.zones.length > 0);
  if (nonEmpty.length === 0) throw new Error('nenhuma zona pra gerar o SF2 — converta ou capture pelo menos uma amostra antes.');

  // 1) Monta o pool GLOBAL de "samples físicos" (1 por zona mono, 2 por zona estéreo, de TODOS os presets juntos)
  //    +, por preset, a lista de zonas de instrumento que os referenciam (índices globais).
  const physicalSamples: PhysicalSample[] = [];
  const instruments: InstrumentSpec[] = [];

  nonEmpty.forEach((preset, presetIdx) => {
    const instrumentZones: InstrumentZoneSpec[] = [];
    preset.zones.forEach((zone, zoneIdx) => {
      const label = zone.label || `smp${presetIdx}_${zoneIdx}`;
      if (zone.channels === 1) {
        const idx = physicalSamples.length;
        physicalSamples.push({
          name: `${label}_${zoneIdx}`,
          pcm: extractChannelInt16(zone.interleaved, 1, 0),
          sampleRateHz: zone.sampleRateHz,
          rootNote: zone.rootNote,
          loopStartFrame: zone.loopStartFrame,
          loopEndFrame: zone.loopEndFrame,
          sampleType: SAMPLE_TYPE_MONO,
        });
        instrumentZones.push({ loKey: zone.loKey, hiKey: zone.hiKey, loVel: zone.loVel, hiVel: zone.hiVel, rootNote: zone.rootNote, sampleIndex: idx });
      } else {
        const leftIdx = physicalSamples.length;
        const rightIdx = leftIdx + 1;
        physicalSamples.push({
          name: `${label}_${zoneIdx}L`,
          pcm: extractChannelInt16(zone.interleaved, 2, 0),
          sampleRateHz: zone.sampleRateHz,
          rootNote: zone.rootNote,
          loopStartFrame: zone.loopStartFrame,
          loopEndFrame: zone.loopEndFrame,
          sampleType: SAMPLE_TYPE_LEFT,
          linkedIndex: rightIdx,
        });
        physicalSamples.push({
          name: `${label}_${zoneIdx}R`,
          pcm: extractChannelInt16(zone.interleaved, 2, 1),
          sampleRateHz: zone.sampleRateHz,
          rootNote: zone.rootNote,
          loopStartFrame: zone.loopStartFrame,
          loopEndFrame: zone.loopEndFrame,
          sampleType: SAMPLE_TYPE_RIGHT,
          linkedIndex: leftIdx,
        });
        // Duas zonas de instrumento (uma por canal) com a MESMA faixa de tecla/velocity. O par wSampleLink/sfSampleType
        // identifica QUAL amostra é a outra metade do par estéreo (exigido pelo spec, §7.9/§7.10), mas na prática
        // testada aqui (fluidsynth 2.4) isso sozinho não direciona o áudio pro canal certo — é preciso também o
        // generator de Pan explícito (-500 = 100% esquerda, +500 = 100% direita, ver §8.1.3) em cada zona, senão as
        // duas tocam centralizadas e se somam nos dois canais (confirmado por scripts/test-sf2-export.mjs, que
        // renderiza de verdade e checa que L/R saem diferentes).
        instrumentZones.push({ loKey: zone.loKey, hiKey: zone.hiKey, loVel: zone.loVel, hiVel: zone.hiVel, rootNote: zone.rootNote, sampleIndex: leftIdx, panTenthPercent: -500 });
        instrumentZones.push({ loKey: zone.loKey, hiKey: zone.hiKey, loVel: zone.loVel, hiVel: zone.hiVel, rootNote: zone.rootNote, sampleIndex: rightIdx, panTenthPercent: 500 });
      }
    });
    instruments.push({ name: preset.name || `Preset ${presetIdx + 1}`, zones: instrumentZones });
  });

  // 2) sdta: concatena o PCM de TODOS os samples físicos (de todos os presets), com padding de zeros entre cada um
  //    (e no final) — guarda o offset (em SAMPLE POINTS, não bytes) de início/fim de cada um pra preencher o SHDR depois.
  const smplWriter = new ByteWriter();
  const sampleOffsets: { start: number; end: number }[] = [];
  for (const sample of physicalSamples) {
    const start = smplWriter.byteLength / 2;
    for (let i = 0; i < sample.pcm.length; i += 1) smplWriter.i16(sample.pcm[i]);
    const end = smplWriter.byteLength / 2;
    for (let i = 0; i < MIN_PAD_SAMPLES; i += 1) smplWriter.i16(0);
    sampleOffsets.push({ start, end });
  }

  // 3) shdr — um registro por sample físico (de TODOS os presets) + 1 terminal ("EOS").
  const shdrWriter = new ByteWriter();
  physicalSamples.forEach((sample, i) => {
    const { start, end } = sampleOffsets[i];
    shdrWriter.fixedStr(sample.name, 20);
    shdrWriter.u32(start);
    shdrWriter.u32(end);
    const hasLoop = sample.loopStartFrame !== undefined && sample.loopEndFrame !== undefined;
    shdrWriter.u32(hasLoop ? start + (sample.loopStartFrame as number) : start);
    shdrWriter.u32(hasLoop ? start + (sample.loopEndFrame as number) : end);
    shdrWriter.u32(Math.round(sample.sampleRateHz));
    shdrWriter.u8(Math.max(0, Math.min(127, Math.round(sample.rootNote)))); // byOriginalPitch
    shdrWriter.u8(0); // chPitchCorrection (nenhuma correção fina — a nota raiz já é exata)
    shdrWriter.u16(sample.linkedIndex ?? 0); // wSampleLink
    shdrWriter.u16(sample.sampleType); // sfSampleType
  });
  // terminal "EOS"
  shdrWriter.fixedStr('EOS', 20);
  for (let i = 0; i < 5; i += 1) shdrWriter.u32(0);
  shdrWriter.u8(0);
  shdrWriter.u8(0);
  shdrWriter.u16(0);
  shdrWriter.u16(0);

  // 4) inst/ibag/imod/igen — UM instrumento por preset de entrada, cada um com suas próprias zonas (todas concatenadas
  //    num único ibag/igen globais, como o spec exige — ver §7.2: "all the instrument zones... are stored
  //    contiguously").
  const igenWriter = new ByteWriter();
  const ibagWriter = new ByteWriter();
  let igenCount = 0;

  function pushGenU16(gen: number, amount: number) {
    igenWriter.u16(gen);
    igenWriter.u16(amount & 0xffff);
    igenCount += 1;
  }
  function pushGenRange(gen: number, lo: number, hi: number) {
    igenWriter.u16(gen);
    igenWriter.u8(Math.max(0, Math.min(127, lo)));
    igenWriter.u8(Math.max(0, Math.min(127, hi)));
    igenCount += 1;
  }

  const instBagStart: number[] = []; // wInstBagNdx de cada instrumento, na ordem

  instruments.forEach((inst) => {
    instBagStart.push(ibagWriter.byteLength / 4); // cada registro ibag tem 4 bytes (2x u16)
    inst.zones.forEach((z) => {
      ibagWriter.u16(igenCount); // wInstGenNdx — início dos generators desta zona
      ibagWriter.u16(0); // wInstModNdx — sem modulators
      // Ordem exigida pelo spec (§7.5/§7.9): keyRange primeiro, depois velRange, só então os demais — sampleID por último.
      if (z.loKey !== 0 || z.hiKey !== 127) pushGenRange(GEN_KEY_RANGE, z.loKey, z.hiKey);
      if (z.loVel !== 0 || z.hiVel !== 127) pushGenRange(GEN_VEL_RANGE, z.loVel, z.hiVel);
      const sample = physicalSamples[z.sampleIndex];
      if (z.panTenthPercent !== undefined) pushGenU16(GEN_PAN, z.panTenthPercent);
      pushGenU16(GEN_OVERRIDING_ROOT_KEY, Math.max(0, Math.min(127, Math.round(z.rootNote))));
      if (sample.loopStartFrame !== undefined && sample.loopEndFrame !== undefined) {
        pushGenU16(GEN_SAMPLE_MODES, SAMPLE_MODE_LOOP_CONTINUOUSLY);
      } else {
        pushGenU16(GEN_SAMPLE_MODES, SAMPLE_MODE_NO_LOOP);
      }
      pushGenU16(GEN_SAMPLE_ID, z.sampleIndex); // sempre o ÚLTIMO generator da zona — exigido pelo spec.
    });
  });
  const totalInstZones = ibagWriter.byteLength / 4;
  // terminal ibag (comum a todos os instrumentos — marca o fim do último)
  ibagWriter.u16(igenCount);
  ibagWriter.u16(0);

  const instWriter = new ByteWriter();
  instruments.forEach((inst, i) => {
    instWriter.fixedStr(inst.name, 20);
    instWriter.u16(instBagStart[i]);
  });
  // terminal "EOI" — o valor aqui é a CONTAGEM TOTAL DE ZONAS REAIS de todos os instrumentos (não +1): o
  // tamanho do IBAG em bytes é "4 * wInstBagNdx do terminal + 4" (ver §7.7 do spec, mesma fórmula/raciocínio do
  // wPresetBagNdx terminal do PHDR logo abaixo) — não é "quantos registros existem no total".
  instWriter.fixedStr('EOI', 20);
  instWriter.u16(totalInstZones);

  // imod: sem modulators — só o registro terminal, todo zero (ver §7.4/§7.8).
  const imodWriter = new ByteWriter();
  for (let i = 0; i < 5; i += 1) imodWriter.u16(0);

  // 5) phdr/pbag/pmod/pgen — UM preset de SAÍDA por preset de entrada, cada um com UMA zona global apontando pro seu
  //    instrumento correspondente (sem restrição de tecla/velocity no nível do preset — toda a distribuição já está
  //    nas zonas do instrumento, igual já era antes desta extensão).
  const pgenWriter = new ByteWriter();
  const pbagWriter = new ByteWriter();
  nonEmpty.forEach((preset, i) => {
    pbagWriter.u16(pgenWriter.byteLength / 4); // wGenNdx — cada registro pgen tem 4 bytes (2x u16)
    pbagWriter.u16(0); // wModNdx
    pgenWriter.u16(GEN_INSTRUMENT);
    pgenWriter.u16(i); // aponta pro instrumento #i (1:1 com os presets de entrada, nesta mesma ordem)
  });
  const totalPresetZones = pbagWriter.byteLength / 4;
  // terminal pbag
  pbagWriter.u16(pgenWriter.byteLength / 4);
  pbagWriter.u16(0);

  const pmodWriter = new ByteWriter();
  for (let i = 0; i < 5; i += 1) pmodWriter.u16(0);

  const phdrWriter = new ByteWriter();
  nonEmpty.forEach((preset, i) => {
    phdrWriter.fixedStr(preset.name || `Preset ${i + 1}`, 20);
    phdrWriter.u16(preset.program ?? Math.min(127, i));
    phdrWriter.u16(preset.bank ?? 0);
    phdrWriter.u16(i); // wPresetBagNdx — 1 zona de preset por preset, na mesma ordem
    phdrWriter.u32(0);
    phdrWriter.u32(0);
    phdrWriter.u32(0);
  });
  // terminal "EOP"
  phdrWriter.fixedStr('EOP', 20);
  phdrWriter.u16(0);
  phdrWriter.u16(0);
  phdrWriter.u16(totalPresetZones); // contagem de zonas REAIS de todos os presets (sempre 1 por preset), não "total de registros incluindo terminal".
  phdrWriter.u32(0);
  phdrWriter.u32(0);
  phdrWriter.u32(0);

  // 6) Monta os chunks RIFF, na ORDEM fixa exigida pelo spec (§3.2/§4).
  const now = new Date();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const icrd = `${monthNames[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`;

  function zstrChunk(id: string, s: string): Uint8Array {
    const ascii = toAscii(s);
    const withNul = ascii + '\0';
    const padded = withNul.length % 2 === 1 ? withNul + '\0' : withNul;
    const bytes = new Uint8Array(padded.length);
    for (let i = 0; i < padded.length; i += 1) bytes[i] = padded.charCodeAt(i);
    return riffChunk(id, bytes);
  }

  const ifilData = new Uint8Array(4);
  new DataView(ifilData.buffer).setUint16(0, 2, true);
  new DataView(ifilData.buffer).setUint16(2, 1, true);
  const ifilChunk = riffChunk('ifil', ifilData);

  const infoList = riffList('INFO', [
    ifilChunk,
    zstrChunk('isng', 'EMU8000'),
    zstrChunk('INAM', soundFontName || 'MRQ Instrument Converter'),
    zstrChunk('ISFT', 'MRQ Instrument Converter'),
    zstrChunk('ICRD', icrd),
  ]);

  const sdtaList = riffList('sdta', [riffChunk('smpl', smplWriter.toUint8Array())]);

  const pdtaList = riffList('pdta', [
    riffChunk('phdr', phdrWriter.toUint8Array()),
    riffChunk('pbag', pbagWriter.toUint8Array()),
    riffChunk('pmod', pmodWriter.toUint8Array()),
    riffChunk('pgen', pgenWriter.toUint8Array()),
    riffChunk('inst', instWriter.toUint8Array()),
    riffChunk('ibag', ibagWriter.toUint8Array()),
    riffChunk('imod', imodWriter.toUint8Array()),
    riffChunk('igen', igenWriter.toUint8Array()),
    riffChunk('shdr', shdrWriter.toUint8Array()),
  ]);

  const riffData = new Uint8Array(4 + infoList.length + sdtaList.length + pdtaList.length);
  for (let i = 0; i < 4; i += 1) riffData[i] = 'sfbk'.charCodeAt(i);
  let off = 4;
  riffData.set(infoList, off);
  off += infoList.length;
  riffData.set(sdtaList, off);
  off += sdtaList.length;
  riffData.set(pdtaList, off);

  return riffChunk('RIFF', riffData);
}

/** Variante de conveniência pra UM preset só (uso original: Auto Sampler, que
 *  sempre captura um único instrumento por sessão) — delega inteiramente pra
 *  `buildMultiPresetSf2Binary` com uma lista de 1 elemento, preservando a
 *  assinatura e o comportamento de antes desta extensão. */
export function buildSf2Binary(zones: Sf2ExportZone[], options: BuildSf2Options): Uint8Array {
  if (zones.length === 0) throw new Error('nenhuma zona pra gerar o SF2 — capture pelo menos uma amostra antes.');
  return buildMultiPresetSf2Binary(
    [{ name: options.instrumentName || 'Auto Sampler', bank: options.bank, program: options.program, zones }],
    options.instrumentName || 'Auto Sampler'
  );
}
