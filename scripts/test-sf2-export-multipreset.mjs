#!/usr/bin/env node
/**
 * Teste de regressão do caminho MULTI-PRESET do escritor de SF2
 * (`buildMultiPresetSf2Binary` em src/audio/rack/sf2Export.ts), usado pelo
 * MRQ Instrument Converter pra exportar instrumentos com mais de um preset
 * (ex.: um banco .sf2 importado com vários instrumentos, ou um banco .syx
 * DX7 de até 32 patches). Gera um .sf2 sintético com DOIS presets
 * independentes (programas MIDI 0 e 1), cada um com uma frequência própria
 * na MESMA tecla (60), e RENDERIZA de verdade com fluidsynth (mesma receita
 * comprovada de scripts/test-sf2-export.mjs: tempo explícito + `-g 1.0 -R 0
 * -C 0`) pra confirmar que cada preset soa só a sua própria amostra, sem
 * vazamento de zonas entre instrumentos.
 *
 * Rode com: node scripts/test-sf2-export-multipreset.mjs
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

async function compileToNode(entry) {
  const outfile = path.join(
    os.tmpdir(),
    `mrq-sf2-export-multi-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile });
  return import(`file://${outfile}`);
}

const { buildMultiPresetSf2Binary } = await compileToNode('src/audio/rack/sf2Export.ts');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (err) {
    console.error(`✖ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const SR = 44100;
function sineMono(freq, seconds, amplitude = 0.8) {
  const n = Math.round(SR * seconds);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amplitude;
  return buf;
}

const NOTE = 60;
const FREQ_A = 220;
const FREQ_B = 880;
const pcmA = sineMono(FREQ_A, 1.0);
const pcmB = sineMono(FREQ_B, 1.0);

const sf2Bytes = buildMultiPresetSf2Binary(
  [
    { name: 'PresetA', program: 0, bank: 0, zones: [{ label: 'A', rootNote: NOTE, loKey: 0, hiKey: 127, loVel: 0, hiVel: 127, interleaved: pcmA, sampleRateHz: SR, channels: 1 }] },
    { name: 'PresetB', program: 1, bank: 0, zones: [{ label: 'B', rootNote: NOTE, loKey: 0, hiKey: 127, loVel: 0, hiVel: 127, interleaved: pcmB, sampleRateHz: SR, channels: 1 }] },
  ],
  'Multi Preset Test'
);

check('buildMultiPresetSf2Binary produz um RIFF/sfbk estruturalmente válido', () => {
  assert.equal(String.fromCharCode(...sf2Bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...sf2Bytes.slice(8, 12)), 'sfbk');
  const declaredSize = new DataView(sf2Bytes.buffer, sf2Bytes.byteOffset).getUint32(4, true);
  assert.equal(declaredSize, sf2Bytes.length - 8, 'tamanho declarado no header RIFF precisa bater com o arquivo real');
});

if (!hasFluidsynth()) {
  console.warn('\n⚠ fluidsynth não encontrado no PATH — pulando a validação de renderização de áudio.');
  console.log(`\n${passed} teste(s) estrutural(is) passaram (validação de áudio pulada).`);
  process.exit(process.exitCode ?? 0);
}

// ---------------------------------------------------------------------------
// Monta um .mid padrão (SMF tipo 0) — mesma receita comprovada de
// scripts/test-sf2-export.mjs (tempo explícito de 120bpm, 480 ticks/quarter).
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
const TEMPO_US_PER_QUARTER = 500000; // 120bpm
const ticksPerSecond = TICKS_PER_QUARTER / (TEMPO_US_PER_QUARTER / 1e6);
function secToTicks(s) {
  return Math.round(s * ticksPerSecond);
}

function buildMidiForProgram(program) {
  const events = [];
  events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, (TEMPO_US_PER_QUARTER >> 16) & 0xff, (TEMPO_US_PER_QUARTER >> 8) & 0xff, TEMPO_US_PER_QUARTER & 0xff] });
  events.push({ tick: 0, bytes: [0xc0, program] }); // Program Change, canal 0
  events.push({ tick: 0, bytes: [0x90, NOTE, 100] }); // Note On
  events.push({ tick: secToTicks(0.6), bytes: [0x80, NOTE, 0] }); // Note Off
  events.push({ tick: secToTicks(0.8), bytes: [0xff, 0x2f, 0x00] }); // End of track
  events.sort((a, b) => a.tick - b.tick);
  const trackBytes = [];
  let lastTick = 0;
  for (const ev of events) {
    trackBytes.push(...vlq(ev.tick - lastTick));
    trackBytes.push(...ev.bytes);
    lastTick = ev.tick;
  }
  const trackChunk = Buffer.concat([
    Buffer.from('MTrk'),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(trackBytes.length, 0);
      return b;
    })(),
    Buffer.from(trackBytes),
  ]);
  const headerChunk = Buffer.concat([Buffer.from('MThd'), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, (TICKS_PER_QUARTER >> 8) & 0xff, TICKS_PER_QUARTER & 0xff])]);
  return Buffer.concat([headerChunk, trackChunk]);
}

function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset < buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitsPerSample: body.readUInt16LE(14) };
    if (id === 'data') data = body;
    offset += 8 + size + (size % 2);
  }
  assert.ok(fmt && data, 'WAV sem fmt/data válidos');
  const frameCount = data.length / 2 / fmt.channels;
  const left = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) left[f] = data.readInt16LE(f * fmt.channels * 2) / 32768;
  return { left, sampleRate: fmt.sampleRate, frameCount };
}

function zeroCrossingFreq(samples, sampleRate, fromFrame, toFrame) {
  let crossings = 0;
  for (let i = Math.max(1, fromFrame); i < Math.min(samples.length, toFrame); i += 1) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
  }
  const seconds = (Math.min(samples.length, toFrame) - Math.max(0, fromFrame)) / sampleRate;
  return crossings / seconds;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrq-sf2-multi-'));
const sf2Path = path.join(tmpDir, 'multi.sf2');
fs.writeFileSync(sf2Path, Buffer.from(sf2Bytes));

function renderProgram(program) {
  const midPath = path.join(tmpDir, `p${program}.mid`);
  const wavPath = path.join(tmpDir, `p${program}.wav`);
  fs.writeFileSync(midPath, buildMidiForProgram(program));
  execFileSync('fluidsynth', ['-ni', '-g', '1.0', '-R', '0', '-C', '0', '-r', String(SR), '-F', wavPath, sf2Path, midPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return readWav(wavPath);
}

check('preset 0 (programa 0) toca a nota do PresetA (~220Hz), não a do PresetB', () => {
  const wav = renderProgram(0);
  const freq = zeroCrossingFreq(wav.left, wav.sampleRate, Math.round(0.1 * wav.sampleRate), Math.round(0.4 * wav.sampleRate));
  assert.ok(Math.abs(freq - FREQ_A) < 40, `frequência detectada ${freq.toFixed(1)}Hz, esperado ~${FREQ_A}Hz`);
});

check('preset 1 (programa 1) toca a nota do PresetB (~880Hz), não a do PresetA', () => {
  const wav = renderProgram(1);
  const freq = zeroCrossingFreq(wav.left, wav.sampleRate, Math.round(0.1 * wav.sampleRate), Math.round(0.4 * wav.sampleRate));
  assert.ok(Math.abs(freq - FREQ_B) < 100, `frequência detectada ${freq.toFixed(1)}Hz, esperado ~${FREQ_B}Hz`);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} teste(s) passaram (incluindo renderização de áudio real via fluidsynth, 2 presets distintos).`);
process.exit(process.exitCode ?? 0);
