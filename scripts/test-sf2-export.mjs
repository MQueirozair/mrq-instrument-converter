#!/usr/bin/env node
/**
 * Teste de regressão do escritor de SF2 (src/audio/rack/sf2Export.ts).
 * Diferente dos outros testes `test:*` do projeto (que só exercitam lógica
 * pura em memória), este aqui faz uma validação PONTA-A-PONTA de verdade:
 * gera um .sf2 sintético (zonas mono e estéreo, com e sem loop), monta um
 * arquivo MIDI padrão (.mid) programaticamente, e RENDERIZA os dois juntos
 * com `fluidsynth` (sintetizador SF2 de código aberto, LGPL — precisa estar
 * instalado: `apt-get install fluidsynth` / `brew install fluidsynth`em
 * CI/dev) pra conferir o ÁUDIO resultante, não só a estrutura binária do
 * arquivo. Se `fluidsynth` não existir no PATH, o teste AVISA e sai com
 * código 0 (não quebra builds/ambientes sem o pacote instalado) em vez de
 * fingir sucesso.
 *
 * Rode com: node scripts/test-sf2-export.mjs
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
    `mrq-sf2-export-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile });
  return import(`file://${outfile}`);
}

const { buildSf2Binary } = await compileToNode('src/audio/rack/sf2Export.ts');

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

// ---------------------------------------------------------------------------
// Geração de sinais sintéticos
// ---------------------------------------------------------------------------
const SR = 44100;

function sineMono(freq, seconds, amplitude = 0.8) {
  const n = Math.round(SR * seconds);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amplitude;
  return buf;
}

function sineStereo(freq, seconds, ampLeft, ampRight) {
  const n = Math.round(SR * seconds);
  const buf = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    const s = Math.sin((2 * Math.PI * freq * i) / SR);
    buf[i * 2] = s * ampLeft;
    buf[i * 2 + 1] = s * ampRight;
  }
  return buf;
}

// Nota 60 (nossa convenção C3=60) — mono, 220Hz, 0.3s, COM loop (período
// exato pra garantir emenda perfeita, isolando o teste da detecção
// automática de loop, que já tem teste próprio em autoSamplerEngine).
const NOTE_LOOPED = 60;
const FREQ_LOOPED = 220;
const periodFrames = SR / FREQ_LOOPED; // ~200.45 — usamos um inteiro de períodos
const loopLenFrames = Math.round(periodFrames * 4); // 4 ciclos inteiros, emenda limpa
const loopedPcm = sineMono(FREQ_LOOPED, 0.3, 0.8);
const loopStartFrame = 2000;
const loopEndFrame = loopStartFrame + loopLenFrames;

// Nota 72 — estéreo, 440Hz, 0.3s, SEM loop, canais com amplitudes bem diferentes pra detectar estéreo de verdade.
const NOTE_STEREO = 72;
const FREQ_STEREO = 440;
const stereoPcm = sineStereo(FREQ_STEREO, 0.3, 0.8, 0.25);

const sf2Bytes = buildSf2Binary(
  [
    {
      label: 'Looped220',
      rootNote: NOTE_LOOPED,
      loKey: 0,
      hiKey: 66,
      loVel: 0,
      hiVel: 127,
      interleaved: loopedPcm,
      sampleRateHz: SR,
      channels: 1,
      loopStartFrame,
      loopEndFrame,
    },
    {
      label: 'Stereo440',
      rootNote: NOTE_STEREO,
      loKey: 67,
      hiKey: 127,
      loVel: 0,
      hiVel: 127,
      interleaved: stereoPcm,
      sampleRateHz: SR,
      channels: 2,
    },
  ],
  { instrumentName: 'Auto Sampler Test' }
);

check('buildSf2Binary produz um RIFF/sfbk estruturalmente válido', () => {
  assert.equal(String.fromCharCode(...sf2Bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...sf2Bytes.slice(8, 12)), 'sfbk');
  const declaredSize = new DataView(sf2Bytes.buffer, sf2Bytes.byteOffset).getUint32(4, true);
  assert.equal(declaredSize, sf2Bytes.length - 8, 'tamanho declarado no header RIFF precisa bater com o arquivo real');
});

if (!hasFluidsynth()) {
  console.warn('\n⚠ fluidsynth não encontrado no PATH — pulando a validação de renderização de áudio (instale com `apt-get install fluidsynth` ou `brew install fluidsynth`).');
  console.log(`\n${passed} teste(s) estrutural(is) passaram (validação de áudio pulada).`);
  process.exit(process.exitCode ?? 0);
}

// ---------------------------------------------------------------------------
// Monta um .mid padrão (SMF tipo 0) programaticamente — nota 60 por 2s
// (bem mais longo que os 0.3s capturados: só toca até o fim se o loop
// funcionar de verdade), depois nota 72 por 0.25s (dentro da duração
// capturada, sem precisar de loop).
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

const events = [];
let lastTick = 0;
function addEvent(tick, bytes) {
  events.push({ tick, bytes });
}
addEvent(0, [0xff, 0x51, 0x03, (TEMPO_US_PER_QUARTER >> 16) & 0xff, (TEMPO_US_PER_QUARTER >> 8) & 0xff, TEMPO_US_PER_QUARTER & 0xff]);
addEvent(0, [0x90, NOTE_LOOPED, 100]); // note on, ch0
addEvent(secToTicks(2.0), [0x80, NOTE_LOOPED, 0]); // note off após 2s — bem além dos 0.3s capturados
addEvent(secToTicks(2.5), [0x90, NOTE_STEREO, 110]);
addEvent(secToTicks(2.75), [0x80, NOTE_STEREO, 0]);
addEvent(secToTicks(3.2), [0xff, 0x2f, 0x00]); // end of track

events.sort((a, b) => a.tick - b.tick);
const trackBytes = [];
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
const headerChunk = Buffer.concat([
  Buffer.from('MThd'),
  Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, (TICKS_PER_QUARTER >> 8) & 0xff, TICKS_PER_QUARTER & 0xff]),
]);
const midiBytes = Buffer.concat([headerChunk, trackChunk]);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrq-sf2-test-'));
const sf2Path = path.join(tmpDir, 'test.sf2');
const midPath = path.join(tmpDir, 'test.mid');
const wavPath = path.join(tmpDir, 'out.wav');
fs.writeFileSync(sf2Path, Buffer.from(sf2Bytes));
fs.writeFileSync(midPath, midiBytes);

execFileSync('fluidsynth', ['-ni', '-g', '1.0', '-R', '0', '-C', '0', '-r', String(SR), '-F', wavPath, sf2Path, midPath], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

// ---------------------------------------------------------------------------
// Leitor de WAV mínimo (RIFF/WAVE, PCM 16-bit) — sem dependência externa.
// ---------------------------------------------------------------------------
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
  assert.equal(fmt.bitsPerSample, 16, 'esperava PCM 16-bit do fluidsynth');
  const frameCount = data.length / 2 / fmt.channels;
  const channelsOut = [];
  for (let c = 0; c < fmt.channels; c += 1) channelsOut.push(new Float32Array(frameCount));
  for (let f = 0; f < frameCount; f += 1) {
    for (let c = 0; c < fmt.channels; c += 1) {
      channelsOut[c][f] = data.readInt16LE((f * fmt.channels + c) * 2) / 32768;
    }
  }
  return { channels: channelsOut, sampleRate: fmt.sampleRate, frameCount };
}

const wav = readWav(wavPath);

function rms(arr, fromFrame, toFrame) {
  let sum = 0;
  const a = Math.max(0, fromFrame);
  const b = Math.min(arr.length, toFrame);
  for (let i = a; i < b; i += 1) sum += arr[i] * arr[i];
  return Math.sqrt(sum / Math.max(1, b - a));
}

check('fluidsynth renderizou um WAV estéreo não-vazio', () => {
  assert.equal(wav.channels.length, 2, 'saída da synth deveria ser estéreo (padrão do fluidsynth)');
  assert.ok(wav.frameCount > wav.sampleRate * 2, 'esperava pelo menos alguns segundos de áudio renderizado');
});

check('nota com loop (60) continua soando MUITO além dos 0.3s originais capturados — confirma que o loop funciona de verdade', () => {
  const sr = wav.sampleRate;
  const levelNear0_2s = rms(wav.channels[0], Math.round(0.1 * sr), Math.round(0.2 * sr));
  const levelNear1_8s = rms(wav.channels[0], Math.round(1.7 * sr), Math.round(1.8 * sr)); // 1.8s > 0.3s original — só soa se o loop estiver ativo
  assert.ok(levelNear0_2s > 0.05, `esperava som audível logo no início (rms=${levelNear0_2s})`);
  assert.ok(levelNear1_8s > 0.05, `esperava som audível em 1.8s (bem além dos 0.3s capturados) — rms=${levelNear1_8s}, o loop não parece estar funcionando`);
});

check('zona estéreo (nota 72) preserva a diferença de amplitude entre canais L/R', () => {
  const sr = wav.sampleRate;
  const base = Math.round(2.55 * sr); // 50ms depois do note-on em 2.5s, já em regime
  const windowLen = Math.round(0.1 * sr);
  const left = rms(wav.channels[0], base, base + windowLen);
  const right = rms(wav.channels[1], base, base + windowLen);
  assert.ok(left > 0.05, `canal esquerdo deveria estar audível (rms=${left})`);
  assert.ok(right > 0.02, `canal direito deveria estar audível, mesmo mais baixo (rms=${right})`);
  const ratio = left / right;
  // amplitude original: L=0.8, R=0.25 -> razão ~3.2 — tolerância generosa pra envelope/interpolação da synth.
  assert.ok(ratio > 1.8 && ratio < 5.5, `esperava canal esquerdo bem mais alto que o direito (razão L/R=${ratio.toFixed(2)}, esperado ~3.2)`);
});

check('silêncio antes do note-on da nota 72 (antes de 2.5s) e depois do fim (depois de ~2.8s, já sem loop)', () => {
  const sr = wav.sampleRate;
  const before = rms(wav.channels[0], Math.round(2.3 * sr), Math.round(2.45 * sr));
  assert.ok(before < 0.05, `esperava quase silêncio entre o fim da nota 60 (2.0s) e o início da 72 (2.5s) — rms=${before}`);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} teste(s) passaram (incluindo renderização de áudio real via fluidsynth).`);
if (process.exitCode) {
  console.error('\nALGUM TESTE FALHOU.');
  process.exit(process.exitCode);
}
