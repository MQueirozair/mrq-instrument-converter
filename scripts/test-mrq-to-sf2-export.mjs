#!/usr/bin/env node
/**
 * Teste de regressão de ponta-a-ponta do `mrqToSf2Export.ts` — o caminho
 * novo usado pelo MRQ Instrument Converter (`InstrumentConverter.tsx`,
 * botões "Exportar .sf2"/"Exportar .sf3") pra reexportar um instrumento JÁ
 * CONVERTIDO pra `.mrq` de volta pra SoundFont. Simula `mrq_extract_sample`
 * (via um módulo-espião no lugar de `@tauri-apps/api/core`, mesma técnica
 * de scripts/test-mrq-format-invoke-serialization.mjs) devolvendo PCM
 * sintético por `sampleId`, monta um `MrqInstrumentModel` com DOIS presets
 * (simulando um banco multi-preset, ex.: `.syx` DX7 ou `.sf2` com vários
 * instrumentos) e confere que o `.sf2` resultante é estruturalmente válido
 * e, com `fluidsynth` disponível, que cada preset realmente toca a sua
 * própria amostra.
 *
 * Rode com: node scripts/test-mrq-to-sf2-export.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function hasFluidsynth() {
  try {
    execFileSync('fluidsynth', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SR = 44100;
function sineMono(freq, seconds, amplitude = 0.8) {
  const n = Math.round(SR * seconds);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amplitude;
  return Array.from(buf); // simula o round-trip JSON do IPC real (vira array plano, nunca Float32Array de verdade do outro lado).
}

const FREQ_A = 220;
const FREQ_B = 880;

// Módulo-espião: substitui '@tauri-apps/api/core' dentro do bundle — resolve 'mrq_extract_sample' com PCM sintético
// por sampleId, sem precisar de um runtime Tauri real nem de um .mrq de verdade em disco.
const spyModulePath = path.join(os.tmpdir(), `mrq-to-sf2-invoke-spy-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
fs.writeFileSync(
  spyModulePath,
  `
  const SAMPLES = {
    sampleA: { sampleId: 'sampleA', interleaved: ${JSON.stringify(sineMono(FREQ_A, 1.0))}, sampleRateHz: ${SR}, channels: 1, bitsPerSampleEncoded: 16 },
    sampleB: { sampleId: 'sampleB', interleaved: ${JSON.stringify(sineMono(FREQ_B, 1.0))}, sampleRateHz: ${SR}, channels: 1, bitsPerSampleEncoded: 16 },
  };
  // Usa globalThis (não uma variável de módulo) pelo mesmo motivo documentado em
  // test-mrq-format-invoke-serialization.mjs: o require() de dentro do bundle da esbuild e o
  // import() feito direto pelo Node abaixo acabam sendo DUAS instâncias de módulo diferentes.
  globalThis.__mrqToSf2SpyCalls = 0;
  function invoke(cmd, args) {
    globalThis.__mrqToSf2SpyCalls += 1;
    if (cmd === 'mrq_extract_sample') {
      const sample = SAMPLES[args.sampleId];
      if (!sample) return Promise.reject(new Error('sampleId desconhecido no espião: ' + args.sampleId));
      return Promise.resolve(sample);
    }
    return Promise.reject(new Error('comando inesperado no espião: ' + cmd));
  }
  function getCallCount() { return globalThis.__mrqToSf2SpyCalls; }
  module.exports = { invoke, getCallCount };
  `
);

async function compileToNode(entry) {
  const outfile = path.join(
    os.tmpdir(),
    `mrq-to-sf2-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
    alias: { '@tauri-apps/api/core': spyModulePath },
  });
  return import(`file://${outfile}`);
}

const { buildSf2FromMrqInstrument, mrqInstrumentHasExportableZones } = await compileToNode('src/audio/rack/mrqToSf2Export.ts');
const { getCallCount } = await import(`file://${spyModulePath}`);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (err) {
    console.error(`✖ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

/** @type {import('../src/audio/rack/mrqFormat').MrqInstrumentModel} */
const instrument = {
  name: 'Banco de Teste',
  sourceFormat: 'syx',
  importedAt: new Date().toISOString(),
  presets: [
    {
      id: 'preset-a',
      name: 'PresetA',
      groups: [
        {
          id: 'group-a',
          name: 'Grupo A',
          zones: [
            { sampleId: 'sampleA', rootNote: 60, loKey: 0, hiKey: 127, loVel: 0, hiVel: 127, tuneCents: 0, volumeDb: 0, pan: 0 },
          ],
        },
      ],
    },
    {
      id: 'preset-b',
      name: 'PresetB',
      groups: [
        {
          id: 'group-b',
          name: 'Grupo B',
          zones: [
            // 2 zonas que apontam pro MESMO sampleId (simula round robin reaproveitando a amostra) — confere que o
            // extrator só é chamado 1x por sampleId único, mesmo com várias zonas referenciando o mesmo id.
            { sampleId: 'sampleB', rootNote: 60, loKey: 0, hiKey: 63, loVel: 0, hiVel: 127, tuneCents: 0, volumeDb: 0, pan: 0 },
            { sampleId: 'sampleB', rootNote: 60, loKey: 64, hiKey: 127, loVel: 0, hiVel: 127, tuneCents: 0, volumeDb: 0, pan: 0 },
          ],
        },
      ],
    },
  ],
};

await check('mrqInstrumentHasExportableZones: true pra um instrumento com zonas', () => {
  assert.equal(mrqInstrumentHasExportableZones(instrument), true);
});

await check('mrqInstrumentHasExportableZones: false pra undefined e pra instrumento sem zonas', () => {
  assert.equal(mrqInstrumentHasExportableZones(undefined), false);
  assert.equal(mrqInstrumentHasExportableZones({ ...instrument, presets: [] }), false);
});

let sf2Bytes;
await check('buildSf2FromMrqInstrument monta um RIFF/sfbk válido a partir de um modelo com 2 presets', async () => {
  sf2Bytes = await buildSf2FromMrqInstrument('/fake/path.mrq', instrument);
  assert.equal(String.fromCharCode(...sf2Bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...sf2Bytes.slice(8, 12)), 'sfbk');
  const declaredSize = new DataView(sf2Bytes.buffer, sf2Bytes.byteOffset).getUint32(4, true);
  assert.equal(declaredSize, sf2Bytes.length - 8);
});

await check('mrq_extract_sample foi chamado só 3x (sampleA 1x + sampleB 1x, reaproveitado nas 2 zonas do PresetB) — nunca 1x por ZONA', () => {
  // 1 chamada pra sampleA (preset A, 1 zona) + 1 chamada pra sampleB (preset B, cacheada entre as 2 zonas que a usam) = 2.
  assert.equal(getCallCount(), 2, `esperava 2 chamadas a mrq_extract_sample (dedupe por sampleId), recebeu ${getCallCount()}`);
});

if (!hasFluidsynth()) {
  console.warn('\n⚠ fluidsynth não encontrado no PATH — pulando a validação de renderização de áudio.');
  console.log(`\n${passed} teste(s) estrutural(is) passaram (validação de áudio pulada).`);
  process.exit(process.exitCode ?? 0);
}

// ---------------------------------------------------------------------------
// Mesma receita de MIDI/WAV comprovada de scripts/test-sf2-export-multipreset.mjs.
// ---------------------------------------------------------------------------
function vlq(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}
const TICKS_PER_QUARTER = 480;
const TEMPO_US_PER_QUARTER = 500000;
const ticksPerSecond = TICKS_PER_QUARTER / (TEMPO_US_PER_QUARTER / 1e6);
function secToTicks(s) {
  return Math.round(s * ticksPerSecond);
}
function buildMidiForProgram(program, note) {
  const events = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, (TEMPO_US_PER_QUARTER >> 16) & 0xff, (TEMPO_US_PER_QUARTER >> 8) & 0xff, TEMPO_US_PER_QUARTER & 0xff] },
    { tick: 0, bytes: [0xc0, program] },
    { tick: 0, bytes: [0x90, note, 100] },
    { tick: secToTicks(0.6), bytes: [0x80, note, 0] },
    { tick: secToTicks(0.8), bytes: [0xff, 0x2f, 0x00] },
  ];
  const trackBytes = [];
  let lastTick = 0;
  for (const ev of events) {
    trackBytes.push(...vlq(ev.tick - lastTick));
    trackBytes.push(...ev.bytes);
    lastTick = ev.tick;
  }
  const trackChunk = Buffer.concat([Buffer.from('MTrk'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(trackBytes.length, 0); return b; })(), Buffer.from(trackBytes)]);
  const headerChunk = Buffer.concat([Buffer.from('MThd'), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, (TICKS_PER_QUARTER >> 8) & 0xff, TICKS_PER_QUARTER & 0xff])]);
  return Buffer.concat([headerChunk, trackChunk]);
}
function readWavLeft(filePath) {
  const buf = fs.readFileSync(filePath);
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset < buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4) };
    if (id === 'data') data = body;
    offset += 8 + size + (size % 2);
  }
  const frameCount = data.length / 2 / fmt.channels;
  const left = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) left[f] = data.readInt16LE(f * fmt.channels * 2) / 32768;
  return { left, sampleRate: fmt.sampleRate };
}
function zeroCrossingFreq(samples, sampleRate, fromFrame, toFrame) {
  let crossings = 0;
  for (let i = Math.max(1, fromFrame); i < Math.min(samples.length, toFrame); i += 1) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
  }
  const seconds = (Math.min(samples.length, toFrame) - Math.max(0, fromFrame)) / sampleRate;
  return crossings / seconds;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrq-to-sf2-'));
const sf2Path = path.join(tmpDir, 'out.sf2');
fs.writeFileSync(sf2Path, Buffer.from(sf2Bytes));

function renderProgram(program) {
  const midPath = path.join(tmpDir, `p${program}.mid`);
  const wavPath = path.join(tmpDir, `p${program}.wav`);
  fs.writeFileSync(midPath, buildMidiForProgram(program, 60));
  execFileSync('fluidsynth', ['-ni', '-g', '1.0', '-R', '0', '-C', '0', '-r', String(SR), '-F', wavPath, sf2Path, midPath], { stdio: ['ignore', 'ignore', 'inherit'] });
  return readWavLeft(wavPath);
}

await check('preset A (programa 0) toca a amostra A (~220Hz)', () => {
  const wav = renderProgram(0);
  const freq = zeroCrossingFreq(wav.left, wav.sampleRate, Math.round(0.1 * wav.sampleRate), Math.round(0.4 * wav.sampleRate));
  assert.ok(Math.abs(freq - FREQ_A) < 40, `frequência detectada ${freq.toFixed(1)}Hz, esperado ~${FREQ_A}Hz`);
});

await check('preset B (programa 1) toca a amostra B (~880Hz), reaproveitada por 2 zonas', () => {
  const wav = renderProgram(1);
  const freq = zeroCrossingFreq(wav.left, wav.sampleRate, Math.round(0.1 * wav.sampleRate), Math.round(0.4 * wav.sampleRate));
  assert.ok(Math.abs(freq - FREQ_B) < 100, `frequência detectada ${freq.toFixed(1)}Hz, esperado ~${FREQ_B}Hz`);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} teste(s) passaram (incluindo renderização de áudio real via fluidsynth).`);
process.exit(process.exitCode ?? 0);
