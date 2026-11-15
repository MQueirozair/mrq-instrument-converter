#!/usr/bin/env node
/**
 * Teste da lógica pura dos Controles ao Vivo (v0.2.22) —
 * src/audio/rack/liveControls.ts: padrões, limites (clamp), ordenação de
 * faixas, mapeamentos parâmetro→áudio, raiz de referência, faixa do teclado
 * e persistência por instrumento.
 *
 * Rode com: node scripts/test-live-controls.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function compileToNode(entry) {
  const outfile = path.join(
    os.tmpdir(),
    `mrq-live-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile });
  return import(`file://${outfile}`);
}

// localStorage fake (o módulo usa localStorage pra persistir por instrumento).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  LIVE_PARAM_DEFS,
  LIVE_KNOBS_ROW1,
  LIVE_KNOBS_FX,
  LIVE_STEPPERS,
  defaultLiveParams,
  clampLiveParams,
  dbToGain,
  reverbDurationSec,
  reverbColorDb,
  stereoWidth,
  driveParams,
  chorusDepthSec,
  delayFeedbackGain,
  reverbWetGain,
  sustainLevel,
  referenceRootFromZones,
  keyboardRangeFor,
  noteName,
  loadLiveParams,
  saveLiveParams,
  clearLiveParams,
  hasSavedLiveParams,
  savedLiveParamsCount,
} = await compileToNode('src/audio/rack/liveControls.ts');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// --- Definições e padrões ---
test('27 controles definidos, todos com min < max e padrão dentro da faixa', () => {
  const keys = Object.keys(LIVE_PARAM_DEFS);
  assert.equal(keys.length, 27);
  for (const [key, def] of Object.entries(LIVE_PARAM_DEFS)) {
    assert.ok(def.min < def.max, `${key}: min < max`);
    assert.ok(def.default >= def.min && def.default <= def.max, `${key}: padrão dentro da faixa`);
    assert.equal(def.key, key);
  }
});

test('ordem das linhas: 5 steppers + 10 knobs + 12 knobs de FX = 27', () => {
  assert.equal(LIVE_STEPPERS.length, 5);
  assert.equal(LIVE_KNOBS_ROW1.length, 10);
  assert.equal(LIVE_KNOBS_FX.length, 12);
  const all = [...LIVE_STEPPERS, ...LIVE_KNOBS_ROW1, ...LIVE_KNOBS_FX];
  assert.equal(new Set(all).size, 27);
});

test('padrões neutros: volume 0dB, pan centro, sustain 100%, efeitos zerados', () => {
  const p = defaultLiveParams();
  assert.equal(p.volumeDb, 0);
  assert.equal(p.pan, 0);
  assert.equal(p.tuneCents, 0);
  assert.equal(p.sustain, 100);
  assert.equal(p.reverb, 0);
  assert.equal(p.delay, 0);
  assert.equal(p.chorus, 0);
  assert.equal(p.driveDb, 0);
  assert.equal(p.noteMin, 0);
  assert.equal(p.noteMax, 127);
});

// --- Clamp ---
test('clampLiveParams limita cada controle à sua faixa', () => {
  const p = clampLiveParams({ volumeDb: 99, pan: -5, sustain: 250, chorusRateHz: 0, noteMin: -10 });
  assert.equal(p.volumeDb, 12);
  assert.equal(p.pan, -1);
  assert.equal(p.sustain, 100);
  assert.equal(p.chorusRateHz, 0.05);
  assert.equal(p.noteMin, 0);
});

test('clampLiveParams ignora valores inválidos (NaN, string, ausente)', () => {
  const p = clampLiveParams({ volumeDb: NaN, pan: 'x', attackMs: undefined });
  assert.equal(p.volumeDb, 0);
  assert.equal(p.pan, 0);
  assert.equal(p.attackMs, 0);
});

test('clampLiveParams ordena faixas invertidas (nota e velocity)', () => {
  const p = clampLiveParams({ noteMin: 80, noteMax: 20, velMin: 100, velMax: 5 });
  assert.equal(p.noteMin, 20);
  assert.equal(p.noteMax, 80);
  assert.equal(p.velMin, 5);
  assert.equal(p.velMax, 100);
});

// --- Mapeamentos ---
test('dbToGain: 0dB=1, +6dB≈2, -6dB≈0.5, -60dB≈0.001', () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(6) - 1.995) < 0.01);
  assert.ok(Math.abs(dbToGain(-6) - 0.501) < 0.01);
  assert.ok(Math.abs(dbToGain(-60) - 0.001) < 0.0001);
});

test('reverbDurationSec: 10%→0.3s, 100%→5.0s, monótona', () => {
  assert.equal(reverbDurationSec(10), 0.3);
  assert.equal(reverbDurationSec(100), 5.0);
  assert.ok(reverbDurationSec(75) > reverbDurationSec(50));
  assert.ok(reverbDurationSec(50) > reverbDurationSec(25));
});

test('reverbColorDb: 0%→-12dB, 50%→0dB, 100%→+12dB', () => {
  assert.equal(reverbColorDb(0), -12);
  assert.equal(reverbColorDb(50), 0);
  assert.equal(reverbColorDb(100), 12);
});

test('stereoWidth: 0%→0 (mono), 50%→1 (normal), 100%→2 (larga)', () => {
  assert.equal(stereoWidth(0), 0);
  assert.equal(stereoWidth(50), 1);
  assert.equal(stereoWidth(100), 2);
});

test('driveParams: 0dB = bypass; sobe o molhado com o drive', () => {
  assert.deepEqual(driveParams(0), { amount: 0, wet: 0, dry: 1 });
  const low = driveParams(6);
  const high = driveParams(24);
  assert.ok(low.wet > 0 && low.wet < high.wet);
  assert.equal(high.wet, 1);
  assert.ok(high.dry < 1 && high.dry > 0);
});

test('chorusDepthSec: 0%→0, 100%→8ms', () => {
  assert.equal(chorusDepthSec(0), 0);
  assert.equal(chorusDepthSec(100), 0.008);
  assert.equal(chorusDepthSec(50), 0.004);
});

test('delayFeedbackGain / reverbWetGain / sustainLevel', () => {
  assert.equal(delayFeedbackGain(35), 0.35);
  assert.equal(delayFeedbackGain(200), 0.95);
  assert.equal(reverbWetGain(0), 0);
  assert.equal(reverbWetGain(100), 1.25);
  assert.equal(sustainLevel(100), 1);
  assert.equal(sustainLevel(50), 0.5);
  assert.equal(sustainLevel(0), 0);
});

// --- Raiz de referência e teclado ---
test('referenceRootFromZones: raiz mais comum; vazio → 60', () => {
  assert.equal(referenceRootFromZones([]), 60);
  assert.equal(referenceRootFromZones([{ rootNote: 21 }, { rootNote: 21 }, { rootNote: 60 }]), 21);
  assert.equal(referenceRootFromZones([{ rootNote: 48 }, { rootNote: 60 }]), 48); // empate → primeira
});

test('keyboardRangeFor: segue NOTA MIN/MAX limitada a 21..108', () => {
  assert.deepEqual(keyboardRangeFor({ noteMin: 0, noteMax: 127 }), { lowest: 21, highest: 108 });
  assert.deepEqual(keyboardRangeFor({ noteMin: 0, noteMax: 21 }), { lowest: 21, highest: 21 });
  assert.deepEqual(keyboardRangeFor({ noteMin: 40, noteMax: 90 }), { lowest: 40, highest: 90 });
});

test('noteName: 60→C4, 21→A0, 0→C-1, 127→G9', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(21), 'A0');
  assert.equal(noteName(0), 'C-1');
  assert.equal(noteName(127), 'G9');
  assert.equal(noteName(61), 'C#4');
});

// --- Persistência ---
test('persistência: salva, carrega (com clamp) e apaga por instrumento', () => {
  assert.equal(hasSavedLiveParams('/a.mrq'), false);
  assert.equal(savedLiveParamsCount(), 0);
  saveLiveParams('/a.mrq', { ...defaultLiveParams(), volumeDb: -5.8, releaseMs: 554.7, rootKey: 21 });
  assert.equal(hasSavedLiveParams('/a.mrq'), true);
  assert.equal(savedLiveParamsCount(), 1);
  const loaded = loadLiveParams('/a.mrq');
  assert.equal(loaded.volumeDb, -5.8);
  assert.equal(loaded.releaseMs, 554.7);
  assert.equal(loaded.rootKey, 21);
  // instrumento diferente continua nos padrões
  assert.equal(loadLiveParams('/b.mrq').volumeDb, 0);
  clearLiveParams('/a.mrq');
  assert.equal(hasSavedLiveParams('/a.mrq'), false);
  assert.equal(loadLiveParams('/a.mrq').volumeDb, 0);
});

test('persistência: JSON inválido no storage não quebra (volta aos padrões)', () => {
  store.set('mrq.liveControls.v1', '{invalido');
  assert.equal(loadLiveParams('/x.mrq').volumeDb, 0);
  assert.equal(savedLiveParamsCount(), 0);
});

console.log(`\n${passed} teste(s) passaram. Tudo certo.`);
