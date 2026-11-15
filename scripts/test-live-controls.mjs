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
  LIVE_KNOBS_TOOLS,
  LIVE_KNOBS_NEW,
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
  compressorParams,
  applyVelocityCurve,
  bitcrusherSteps,
  crushLowpassHz,
  arpNoteOffsets,
  pressureMacro,
  ecoVivoFeedback,
  LIVE_EFFECTS,
  defaultLiveBypass,
  normalizeLiveBypass,
  applyBypass,
  effectIdForParam,
  loadLiveParams,
  saveLiveParams,
  clearLiveParams,
  hasSavedLiveParams,
  savedLiveParamsCount,
  loadLiveBypass,
  saveLiveBypass,
  clearLiveBypass,
  LIVE_MIDI_ROW,
  valueToPosition,
  positionToValue,
  panDisplayLabel,
} = await compileToNode('src/audio/rack/liveControls.ts');

const {
  balanceGains,
  equalPowerGains,
  panBalanceGains,
  panLabel,
} = await compileToNode('src/audio/rack/panBalance.ts');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// --- Definições e padrões ---
test('60 controles definidos, todos com min < max e padrão dentro da faixa', () => {
  const keys = Object.keys(LIVE_PARAM_DEFS);
  assert.equal(keys.length, 60);
  for (const [key, def] of Object.entries(LIVE_PARAM_DEFS)) {
    assert.ok(def.min < def.max, `${key}: min < max`);
    assert.ok(def.default >= def.min && def.default <= def.max, `${key}: padrão dentro da faixa`);
    assert.equal(def.key, key);
  }
});

test('ordem das linhas: 5 steppers + 10 + 12 + 27 ferramentas + 2 novidades + 4 linha MIDI = 60', () => {
  assert.equal(LIVE_STEPPERS.length, 5);
  assert.equal(LIVE_KNOBS_ROW1.length, 10);
  assert.equal(LIVE_KNOBS_FX.length, 12);
  assert.equal(LIVE_KNOBS_TOOLS.length, 27);
  assert.equal(LIVE_KNOBS_NEW.length, 2);
  assert.equal(LIVE_MIDI_ROW.length, 4);
  const all = [...LIVE_STEPPERS, ...LIVE_KNOBS_ROW1, ...LIVE_KNOBS_FX, ...LIVE_KNOBS_TOOLS, ...LIVE_KNOBS_NEW, ...LIVE_MIDI_ROW];
  assert.equal(new Set(all).size, 60);
});

test('padrões das ferramentas: tudo desligado/neutro por padrão', () => {
  const p = defaultLiveParams();
  assert.equal(p.comp, 0);
  assert.equal(p.phaserMix, 0);
  assert.equal(p.flangerMix, 0);
  assert.equal(p.crushMix, 0);
  assert.equal(p.shimmerMix, 0);
  assert.equal(p.octaverMix, 0);
  assert.equal(p.gateThreshold, -80);
  assert.equal(p.exciter, 0);
  assert.equal(p.ringMix, 0);
  assert.equal(p.tape, 0);
  assert.equal(p.arpRate, 0);
  assert.equal(p.velCurve, 0);
  assert.equal(p.pressure, 0);
  assert.equal(p.ecoVivo, 0);
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

test('v0.2.24 — som plano/original ao abrir: modulações e largura zeradas por padrão', () => {
  const p = defaultLiveParams();
  // Sem isso, tremolo/vibrato/auto-pan/Haas colorem o som antes de qualquer toque.
  assert.equal(p.tremoloDepth, 0, 'tremolo não pulsa ao abrir');
  assert.equal(p.vibratoDepth, 0, 'vibrato não desafina ao abrir');
  assert.equal(p.autopanDepth, 0, 'auto-pan não move a imagem ao abrir');
  assert.equal(p.stereo, 0, 'largura Haas zerada = estéreo normal ao abrir');
  assert.equal(p.eqLowDb, 0);
  assert.equal(p.eqMidDb, 0);
  assert.equal(p.eqHighDb, 0);
  assert.equal(p.attackMs, 0);
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

// --- Mapeamentos das ferramentas e novidades (v0.2.23) ---
test('compressorParams: 0% ≈ bypass (1:1), 100% = cola forte (10:1)', () => {
  const off = compressorParams(0);
  assert.equal(off.ratio, 1);
  assert.equal(off.thresholdDb, -6);
  assert.equal(off.makeupDb, 0);
  const full = compressorParams(100);
  assert.equal(full.ratio, 10);
  assert.equal(full.thresholdDb, -36);
  assert.equal(full.makeupDb, 12);
  const mid = compressorParams(50);
  assert.ok(mid.ratio > off.ratio && mid.ratio < full.ratio);
});

test('applyVelocityCurve: 0 = linear; + enfatiza fortes, − equaliza', () => {
  assert.equal(applyVelocityCurve(64, 0), 64);
  assert.equal(applyVelocityCurve(127, 0), 127);
  // curva positiva (expande): nota média fica mais fraca
  assert.ok(applyVelocityCurve(64, 100) < 64);
  // curva negativa (comprime): nota média fica mais forte
  assert.ok(applyVelocityCurve(64, -100) > 64);
  // extremos nunca saem de 1..127
  assert.ok(applyVelocityCurve(1, 100) >= 1);
  assert.ok(applyVelocityCurve(127, -100) <= 127);
});

test('bitcrusherSteps / crushLowpassHz', () => {
  assert.equal(bitcrusherSteps(2), 4);
  assert.equal(bitcrusherSteps(16), 65536);
  assert.equal(bitcrusherSteps(8), 256);
  assert.equal(crushLowpassHz(0), 500);
  assert.equal(crushLowpassHz(100), 18000);
  assert.ok(crushLowpassHz(50) > crushLowpassHz(10));
});

test('arpNoteOffsets: alcance 0 = [0]; 12 = [0,7,12,7]; limitado a 24', () => {
  assert.deepEqual(arpNoteOffsets(0), [0]);
  assert.deepEqual(arpNoteOffsets(12), [0, 7, 12, 7]);
  assert.deepEqual(arpNoteOffsets(5), [0, 5]);
  assert.deepEqual(arpNoteOffsets(99), [0, 7, 24, 7]);
});

test('pressureMacro: 0 = neutro (Haas: stereo 0); 100 = drive+presença+cola+largura+reverb', () => {
  assert.deepEqual(pressureMacro(0), { driveDb: 0, eqHighDb: 0, comp: 0, stereo: 0, reverb: 0 });
  const full = pressureMacro(100);
  assert.equal(full.driveDb, 10);
  assert.equal(full.eqHighDb, 6);
  assert.equal(full.comp, 70);
  assert.equal(full.stereo, 90);
  assert.equal(full.reverb, 35);
  const mid = pressureMacro(50);
  assert.equal(mid.driveDb, 5);
  assert.equal(mid.stereo, 45);
});

test('ecoVivoFeedback: densidade alta fecha o feedback; ecoVivo 0 = base', () => {
  // sem Eco Vivo, feedback é o da base
  assert.equal(ecoVivoFeedback(35, 0, 1), 35);
  // densidade 0 (espaçado): feedback cheio
  assert.equal(ecoVivoFeedback(35, 100, 0), 35);
  // densidade 1 (denso) com Eco Vivo cheio: fecha 80%
  assert.ok(Math.abs(ecoVivoFeedback(35, 100, 1) - 7) < 0.001);
  // densidade média: meio do caminho
  assert.ok(Math.abs(ecoVivoFeedback(35, 100, 0.5) - 21) < 0.001);
});

// --- Bypass dos efeitos (v0.2.24) ---
test('defaultLiveBypass: 21 efeitos, nenhum desligado', () => {
  const b = defaultLiveBypass();
  assert.equal(LIVE_EFFECTS.length, 21);
  for (const fx of LIVE_EFFECTS) assert.equal(b[fx.id], false, `${fx.id} ligado por padrão`);
});

test('normalizeLiveBypass: parcial/inválido vira padrão sem lançar', () => {
  assert.deepEqual(normalizeLiveBypass(undefined), defaultLiveBypass());
  assert.deepEqual(normalizeLiveBypass(null), defaultLiveBypass());
  const b = normalizeLiveBypass({ reverb: true, delay: 'sim', bogus: true });
  assert.equal(b.reverb, true);
  assert.equal(b.delay, false, 'valor não-booleano é ignorado');
  assert.equal(b.chorus, false);
});

test('applyBypass sem bypass devolve os mesmos parâmetros', () => {
  const p = defaultLiveParams();
  p.reverb = 60; p.delay = 40; p.tremoloDepth = 70;
  const out = applyBypass(p, defaultLiveBypass());
  assert.equal(out.reverb, 60);
  assert.equal(out.delay, 40);
  assert.equal(out.tremoloDepth, 70);
});

test('applyBypass neutraliza só os efeitos desligados e preserva o resto', () => {
  const p = defaultLiveParams();
  p.reverb = 60; p.delay = 40; p.chorus = 30; p.tremoloDepth = 70;
  p.eqLowDb = 5; p.driveDb = 12; p.stereo = 80; p.arpRate = 200; p.ecoVivo = 90;
  p.gateThreshold = -30; p.vibratoDepth = 55; p.autopanDepth = 65; p.tape = 45;
  const bypass = { ...defaultLiveBypass(), reverb: true, tremolo: true, eq: true, arp: true, gate: true };
  const out = applyBypass(p, bypass);
  // desligados → neutros
  assert.equal(out.reverb, 0);
  assert.equal(out.tremoloDepth, 0);
  assert.equal(out.eqLowDb, 0);
  assert.equal(out.arpRate, 0);
  assert.equal(out.gateThreshold, -80);
  // ligados → preservados
  assert.equal(out.delay, 40);
  assert.equal(out.chorus, 30);
  assert.equal(out.driveDb, 12);
  assert.equal(out.stereo, 80);
  assert.equal(out.ecoVivo, 90);
  assert.equal(out.vibratoDepth, 55);
  assert.equal(out.autopanDepth, 65);
  assert.equal(out.tape, 45);
  // não muta o original
  assert.equal(p.reverb, 60);
  assert.equal(p.tremoloDepth, 70);
});

test('applyBypass: todos os efeitos desligados = som limpo', () => {
  const p = defaultLiveParams();
  // "sujeira" em tudo
  p.eqHighDb = 9; p.driveDb = 20; p.chorus = 80; p.delay = 70; p.stereo = 100;
  p.reverb = 90; p.shimmerMix = 60; p.comp = 80; p.phaserMix = 70; p.flangerMix = 70;
  p.tremoloDepth = 90; p.crushMix = 60; p.octaverMix = 50; p.gateThreshold = -20;
  p.vibratoDepth = 80; p.autopanDepth = 90; p.exciter = 70; p.ringMix = 60;
  p.tape = 80; p.arpRate = 300; p.ecoVivo = 100;
  const allOff = {};
  for (const fx of LIVE_EFFECTS) allOff[fx.id] = true;
  const out = applyBypass(p, allOff);
  assert.equal(out.eqHighDb, 0);
  assert.equal(out.driveDb, 0);
  assert.equal(out.chorus, 0);
  assert.equal(out.delay, 0);
  assert.equal(out.stereo, 0);
  assert.equal(out.reverb, 0);
  assert.equal(out.shimmerMix, 0);
  assert.equal(out.comp, 0);
  assert.equal(out.phaserMix, 0);
  assert.equal(out.flangerMix, 0);
  assert.equal(out.tremoloDepth, 0);
  assert.equal(out.crushMix, 0);
  assert.equal(out.octaverMix, 0);
  assert.equal(out.gateThreshold, -80);
  assert.equal(out.vibratoDepth, 0);
  assert.equal(out.autopanDepth, 0);
  assert.equal(out.exciter, 0);
  assert.equal(out.ringMix, 0);
  assert.equal(out.tape, 0);
  assert.equal(out.arpRate, 0);
  assert.equal(out.ecoVivo, 0);
});

test('effectIdForParam: cada knob de efeito aponta pro efeito certo', () => {
  assert.equal(effectIdForParam('reverb'), 'reverb');
  assert.equal(effectIdForParam('reverbSize'), 'reverb');
  assert.equal(effectIdForParam('eqLowDb'), 'eq');
  assert.equal(effectIdForParam('driveDb'), 'drive');
  assert.equal(effectIdForParam('stereo'), 'stereo');
  assert.equal(effectIdForParam('phaserMix'), 'phaser');
  assert.equal(effectIdForParam('arpRate'), 'arp');
  assert.equal(effectIdForParam('ecoVivo'), 'ecoVivo');
  // controles que não são efeito não têm dono
  assert.equal(effectIdForParam('volumeDb'), undefined);
  assert.equal(effectIdForParam('pan'), undefined);
  assert.equal(effectIdForParam('velCurve'), undefined);
  assert.equal(effectIdForParam('pressure'), undefined);
});

test('persistência do bypass: salva, carrega e apaga por instrumento', () => {
  const path = '/musica/piano.mrq';
  assert.deepEqual(loadLiveBypass(path), defaultLiveBypass());
  saveLiveBypass(path, { ...defaultLiveBypass(), delay: true, gate: true });
  const loaded = loadLiveBypass(path);
  assert.equal(loaded.delay, true);
  assert.equal(loaded.gate, true);
  assert.equal(loaded.reverb, false);
  clearLiveBypass(path);
  assert.deepEqual(loadLiveBypass(path), defaultLiveBypass());
});

// --- Pan / Balance (v0.2.25) ---
test('balanceGains: L100/C/R100 e meio — um lado sempre em 1.0 (imagem preservada)', () => {
  assert.deepEqual(balanceGains(-1), { left: 1, right: 0 });
  assert.deepEqual(balanceGains(0), { left: 1, right: 1 });
  assert.deepEqual(balanceGains(1), { left: 0, right: 1 });
  assert.deepEqual(balanceGains(-0.5), { left: 1, right: 0.5 });
  assert.deepEqual(balanceGains(0.5), { left: 0.5, right: 1 });
  // clamp fora da faixa
  assert.deepEqual(balanceGains(-5), { left: 1, right: 0 });
  assert.deepEqual(balanceGains(5), { left: 0, right: 1 });
});

test('equalPowerGains: loudness constante — centro em 0.707 nos dois lados', () => {
  const c = equalPowerGains(0);
  assert.ok(Math.abs(c.left - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(c.right - Math.SQRT1_2) < 1e-9);
  const l = equalPowerGains(-1);
  assert.ok(Math.abs(l.left - 1) < 1e-9 && Math.abs(l.right) < 1e-9);
  const r = equalPowerGains(1);
  assert.ok(Math.abs(r.left) < 1e-9 && Math.abs(r.right - 1) < 1e-9);
  // soma de potências constante (loudness constante)
  for (const p of [-0.75, -0.25, 0.25, 0.75]) {
    const g = equalPowerGains(p);
    assert.ok(Math.abs(g.left * g.left + g.right * g.right - 1) < 1e-9, `pan ${p}: potência constante`);
  }
});

test('panBalanceGains: modo balance vs pan', () => {
  assert.deepEqual(panBalanceGains(0.5, 'balance'), { left: 0.5, right: 1 });
  assert.deepEqual(panBalanceGains(0.5, 'pan'), equalPowerGains(0.5));
});

test('panLabel / panDisplayLabel: L100, L50, C, R50, R100', () => {
  assert.equal(panLabel(-1), 'L100');
  assert.equal(panLabel(-0.5), 'L50');
  assert.equal(panLabel(0), 'C');
  assert.equal(panLabel(0.5), 'R50');
  assert.equal(panLabel(1), 'R100');
  assert.equal(panDisplayLabel(-1), 'L100');
  assert.equal(panDisplayLabel(0.3), 'R30');
  assert.equal(panDisplayLabel(0), 'C');
});

// --- Sistema universal de controles (v0.2.25) ---
test('valueToPosition/positionToValue: linear é identidade; log é reversível', () => {
  assert.equal(valueToPosition(50, 0, 100, 'linear'), 0.5);
  assert.equal(positionToValue(0.5, 0, 100, 'linear'), 50);
  assert.equal(valueToPosition(0, 0, 100, 'linear'), 0);
  assert.equal(valueToPosition(100, 0, 100, 'linear'), 1);
  // log: ida e volta preservam o valor (sem NaN)
  for (const v of [1, 10, 50, 200, 1000, 5000]) {
    const pos = valueToPosition(v, 0, 5000, 'log');
    const back = positionToValue(pos, 0, 5000, 'log');
    assert.ok(Number.isFinite(back), `log reversível em ${v}`);
    assert.ok(Math.abs(back - v) < 1e-6, `log ida/volta ${v} → ${back}`);
  }
  // limites: nunca NaN/infinito
  assert.ok(Number.isFinite(valueToPosition(-50, 0, 100, 'log')));
  assert.ok(Number.isFinite(positionToValue(2, 0, 100, 'log')));
});

test('linha MIDI (v0.2.25): canal 1-16, oitava -2..2, velocity padrão, modo', () => {
  const p = defaultLiveParams();
  assert.equal(p.midiChannel, 1);
  assert.equal(p.octave, 0);
  assert.equal(p.defaultVelocity, 100);
  assert.equal(p.playMode, 0);
  const clamped = clampLiveParams({ midiChannel: 99, octave: -9, defaultVelocity: 0, playMode: 5 });
  assert.equal(clamped.midiChannel, 16);
  assert.equal(clamped.octave, -2);
  assert.equal(clamped.defaultVelocity, 1);
  assert.equal(clamped.playMode, 1);
});

console.log(`\n${passed} teste(s) passaram. Tudo certo.`);
