#!/usr/bin/env node
/**
 * Teste de regressão do motor puro do Auto Sampler
 * (src/audio/rack/autoSamplerEngine.ts). Mesmo padrão de
 * scripts/test-kontakt-capture.mjs: compila o módulo TS de verdade com
 * esbuild pra CJS/Node e testa as funções exportadas diretamente — nenhuma
 * dependência de Web MIDI/Web Audio/Tauri aqui (a orquestração real de
 * captura mora em autoSampler.ts e só pode ser validada com hardware de
 * verdade, pelo usuário).
 *
 * Rode com: node scripts/test-auto-sampler-engine.mjs
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
    `mrq-auto-sampler-engine-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
  });
  return import(`file://${outfile}`);
}

const {
  computeVelocityBreakpoints,
  computeVelocityLayers,
  listSampledNotes,
  generateAutoSamplerTasks,
  estimateAutoSamplerPlan,
  computeAutoSamplerKeyRanges,
  applyGainDb,
  trimLeadingSilence,
  trimTrailingSilence,
  findLoopPoints,
  bakeAutoLoop,
} = await compileToNode('src/audio/rack/autoSamplerEngine.ts');

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
// listSampledNotes / estimateAutoSamplerPlan — confere contra o exemplo real
// dos guias de uso do Auto Sampler: "A C2–C6 range contains 49 MIDI notes
// ... Sampling every three semitones gives about 17 sampled notes. Two
// velocity layers and two round robins turn that into roughly 68
// recordings." (C2=36, C6=84 na convenção C3=60 deste projeto.)
// ---------------------------------------------------------------------------
check('listSampledNotes: C2-C6 a cada 3 semitons dá 17 notas', () => {
  const notes = listSampledNotes({ rangeStartNote: 36, rangeEndNote: 84, sampleEverySemitones: 3 });
  assert.equal(notes.length, 17);
  assert.equal(notes[0], 36);
  assert.ok(notes[notes.length - 1] <= 84);
});

check('estimateAutoSamplerPlan: 17 notas x 2 velocity x 2 round robin = 68 capturas', () => {
  const est = estimateAutoSamplerPlan({
    rangeStartNote: 36,
    rangeEndNote: 84,
    sampleEverySemitones: 3,
    velocityLayers: 2,
    velocityResponse: 'linear',
    roundRobinCount: 2,
    sustainSeconds: 10,
    releaseTailSeconds: 1,
    autoLoop: 'none',
    autoLoopStartPct: 0,
    autoLoopEndPct: 100,
    oneShot: false,
  });
  assert.equal(est.totalCaptures, 68);
  assert.equal(est.sampledNoteCount, 17);
});

// ---------------------------------------------------------------------------
// Curvas de velocity
// ---------------------------------------------------------------------------
check('computeVelocityBreakpoints linear com 4 camadas é igualmente espaçado', () => {
  const bp = computeVelocityBreakpoints(4, 'linear');
  assert.deepEqual(bp, [0, 32, 64, 95, 127]);
});

check('computeVelocityLayers linear cobre 1-127 sem buraco nem overlap', () => {
  const layers = computeVelocityLayers(4, 'linear');
  assert.equal(layers.length, 4);
  assert.equal(layers[0].loVel, 1);
  assert.equal(layers[layers.length - 1].hiVel, 127);
  for (let i = 1; i < layers.length; i += 1) {
    assert.equal(layers[i].loVel, layers[i - 1].hiVel + 1, 'faixas devem ser contíguas sem overlap');
  }
});

check('computeVelocityLayers exp3 tem zonas mais ESTREITAS perto do topo (velocity alta)', () => {
  const layers = computeVelocityLayers(4, 'exp3');
  const widthFirst = layers[0].hiVel - layers[0].loVel;
  const widthLast = layers[layers.length - 1].hiVel - layers[layers.length - 1].loVel;
  assert.ok(widthLast < widthFirst, `esperava faixa final (${widthLast}) mais estreita que a inicial (${widthFirst})`);
});

check('computeVelocityLayers log3 tem zonas mais ESTREITAS perto da base (velocity baixa)', () => {
  const layers = computeVelocityLayers(4, 'log3');
  const widthFirst = layers[0].hiVel - layers[0].loVel;
  const widthLast = layers[layers.length - 1].hiVel - layers[layers.length - 1].loVel;
  assert.ok(widthFirst < widthLast, `esperava faixa inicial (${widthFirst}) mais estreita que a final (${widthLast})`);
});

check('computeVelocityLayers custom respeita os pontos de quebra exatos', () => {
  const layers = computeVelocityLayers(4, 'custom', [0, 12, 31, 53, 127]);
  assert.deepEqual(
    layers.map((l) => [l.loVel, l.hiVel]),
    [
      [1, 12],
      [13, 31],
      [32, 53],
      [54, 127],
    ]
  );
});

check('computeVelocityBreakpoints custom rejeita quantidade errada de pontos', () => {
  assert.throws(() => computeVelocityBreakpoints(4, 'custom', [0, 64, 127]));
});

// ---------------------------------------------------------------------------
// Geração de tarefas — note-major, depois velocity, depois round robin;
// round robin group só aparece quando roundRobinCount > 1.
// ---------------------------------------------------------------------------
check('generateAutoSamplerTasks: contagem e ids batem com a estimativa, sem round robin', () => {
  const config = {
    rangeStartNote: 60,
    rangeEndNote: 64,
    sampleEverySemitones: 2,
    velocityLayers: 2,
    velocityResponse: 'linear',
    roundRobinCount: 1,
    sustainSeconds: 2,
    releaseTailSeconds: 0.5,
    autoLoop: 'none',
    autoLoopStartPct: 0,
    autoLoopEndPct: 100,
    oneShot: false,
  };
  const tasks = generateAutoSamplerTasks(config);
  const est = estimateAutoSamplerPlan(config);
  assert.equal(tasks.length, est.totalCaptures);
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length, 'todo id de tarefa precisa ser único');
  assert.ok(tasks.every((t) => t.roundRobinGroup === undefined), 'sem round robin não deve ter roundRobinGroup');
});

check('generateAutoSamplerTasks: com round robin > 1, agrupa por nota+camada de velocity', () => {
  const tasks = generateAutoSamplerTasks({
    rangeStartNote: 60,
    rangeEndNote: 60,
    sampleEverySemitones: 1,
    velocityLayers: 1,
    velocityResponse: 'linear',
    roundRobinCount: 3,
    sustainSeconds: 1,
    releaseTailSeconds: 0,
    autoLoop: 'none',
    autoLoopStartPct: 0,
    autoLoopEndPct: 100,
    oneShot: false,
  });
  assert.equal(tasks.length, 3);
  const groups = new Set(tasks.map((t) => t.roundRobinGroup));
  assert.equal(groups.size, 1, 'as 3 variações da mesma nota+velocity devem compartilhar o mesmo grupo de round robin');
  assert.deepEqual(
    tasks.map((t) => t.roundRobinIndex),
    [0, 1, 2]
  );
});

check('generateAutoSamplerTasks rejeita range inválido', () => {
  assert.throws(() =>
    generateAutoSamplerTasks({
      rangeStartNote: 64,
      rangeEndNote: 60,
      sampleEverySemitones: 1,
      velocityLayers: 1,
      velocityResponse: 'linear',
      roundRobinCount: 1,
      sustainSeconds: 1,
      releaseTailSeconds: 0,
      autoLoop: 'none',
      autoLoopStartPct: 0,
      autoLoopEndPct: 100,
      oneShot: false,
    })
  );
});

// ---------------------------------------------------------------------------
// Faixa de teclado automática — primeira nota cobre até 0, última até 127.
// ---------------------------------------------------------------------------
check('computeAutoSamplerKeyRanges preenche o teclado inteiro sem buraco', () => {
  const notes = [36, 48, 60, 72, 84];
  const ranges = computeAutoSamplerKeyRanges(notes);
  assert.equal(ranges.get(36).loKey, 0);
  assert.equal(ranges.get(84).hiKey, 127);
  const sorted = [...ranges.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.equal(sorted[i][1].loKey, sorted[i - 1][1].hiKey + 1, 'faixas de tecla vizinhas devem ser contíguas sem buraco');
  }
});

// ---------------------------------------------------------------------------
// Ganho / corte de silêncio
// ---------------------------------------------------------------------------
check('applyGainDb +6dB dobra a amplitude (aprox.) e satura em +-1', () => {
  const buf = Float32Array.from([0.1, -0.1, 0.9, -0.9]);
  const out = applyGainDb(buf, 6.02); // 6.02dB ~ fator 2x
  assert.ok(Math.abs(out[0] - 0.2) < 0.01);
  assert.ok(Math.abs(out[2] - 1) < 0.01, 'deve saturar em 1.0, nunca passar de 1.0');
});

check('trimLeadingSilence corta silêncio inicial preservando alguns frames antes do transiente', () => {
  const silence = new Array(100).fill(0);
  const loud = new Array(50).fill(0.5);
  const buf = Float32Array.from([...silence, ...loud]);
  const out = trimLeadingSilence(buf, 1, 0.01, 4);
  assert.ok(out.length < buf.length);
  assert.ok(out.length >= 50 + 4 - 1 && out.length <= 50 + 4 + 1);
});

check('trimTrailingSilence corta silêncio final preservando uma cauda curta', () => {
  const loud = new Array(50).fill(0.5);
  const silence = new Array(200).fill(0);
  const buf = Float32Array.from([...loud, ...silence]);
  const out = trimTrailingSilence(buf, 1, 0.01, 10);
  assert.ok(out.length < buf.length);
  assert.ok(out.length >= 50 + 10 - 1 && out.length <= 50 + 10 + 1);
});

// ---------------------------------------------------------------------------
// Detecção de pontos de loop — onda periódica sintética com período conhecido.
// ---------------------------------------------------------------------------
check('findLoopPoints acha um período próximo do real numa senoide sintética', () => {
  const sr = 44100;
  const freq = 220; // período exato: sr/freq = 200.4545... frames
  const expectedPeriod = sr / freq;
  const durationSec = 1.5;
  const n = Math.floor(sr * durationSec);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = Math.sin((2 * Math.PI * freq * i) / sr) * 0.8;
  const result = findLoopPoints(buf, 1, sr, 10, 90);
  assert.ok(result, 'esperava encontrar um ponto de loop numa senoide limpa');
  const loopLen = result.loopEndFrame - result.loopStartFrame;
  // aceita múltiplos inteiros do período fundamental (1x, 2x, 3x...) — a
  // autocorrelação pode travar num harmônico, o que ainda produz um loop
  // artefact-free (o período real cabe um número inteiro de vezes nele).
  const ratio = loopLen / expectedPeriod;
  const nearestInt = Math.round(ratio);
  assert.ok(nearestInt >= 1 && Math.abs(ratio - nearestInt) < 0.05, `período encontrado (${loopLen}) não é múltiplo limpo do período real (${expectedPeriod})`);
  assert.ok(result.discontinuity < 0.05, `emenda deveria ser quase perfeita numa senoide pura (discontinuity=${result.discontinuity})`);
});

check('findLoopPoints devolve null quando a janela de busca é pequena demais', () => {
  const sr = 44100;
  const buf = new Float32Array(100).fill(0.5);
  const result = findLoopPoints(buf, 1, sr, 0, 100);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// bakeAutoLoop — os 4 modos de Auto Loop do Logic Pro (Search/X-Fade/Rev
// X-Fade/Bidirectional), gravados diretamente no áudio (ver comentário de
// AutoLoopMode em autoSamplerEngine.ts). Buffer estéreo sintético: canal L
// é uma rampa crescente, canal R uma rampa decrescente — dá pra conferir
// que os dois canais são tratados de forma independente e consistente.
// ---------------------------------------------------------------------------

const SR = 44100;
function makeStereoRamp(frames) {
  const buf = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f += 1) {
    buf[f * 2] = f / frames; // L: 0 -> ~1
    buf[f * 2 + 1] = 1 - f / frames; // R: ~1 -> 0
  }
  return buf;
}
const RAMP_FRAMES = 2000;
const RAMP = makeStereoRamp(RAMP_FRAMES);
const SYNTH_LOOP = { loopStartFrame: 300, loopEndFrame: 1700, discontinuity: 0.5 };

check('bakeAutoLoop "search": devolve os mesmos pontos de loop e NÃO altera o áudio', () => {
  const baked = bakeAutoLoop(RAMP, 2, SR, SYNTH_LOOP, 'search');
  assert.equal(baked.loopStartFrame, SYNTH_LOOP.loopStartFrame);
  assert.equal(baked.loopEndFrame, SYNTH_LOOP.loopEndFrame);
  assert.equal(baked.interleaved, RAMP, 'modo "search" não deveria copiar/alterar o buffer');
});

check('bakeAutoLoop "none" lança erro (não deveria nunca ser chamado com esse modo)', () => {
  assert.throws(() => bakeAutoLoop(RAMP, 2, SR, SYNTH_LOOP, 'none'));
});

check('bakeAutoLoop "search-xfade": mesmo comprimento/pontos de loop, mas a região antes do fim do loop muda de verdade', () => {
  const baked = bakeAutoLoop(RAMP, 2, SR, SYNTH_LOOP, 'search-xfade', 10);
  assert.equal(baked.loopStartFrame, SYNTH_LOOP.loopStartFrame);
  assert.equal(baked.loopEndFrame, SYNTH_LOOP.loopEndFrame);
  assert.equal(baked.interleaved.length, RAMP.length);
  // Frame logo antes do loopEndFrame: no original é quase puro "tail" (rampa
  // original); depois do crossfade deve ter se misturado com o começo do
  // loop (valor diferente do original, mas ainda dentro da faixa [0,1]).
  const frame = SYNTH_LOOP.loopEndFrame - 1;
  const originalL = RAMP[frame * 2];
  const bakedL = baked.interleaved[frame * 2];
  assert.notEqual(bakedL, originalL, 'a amostra bem antes do fim do loop deveria ter sido alterada pelo crossfade');
  assert.ok(bakedL >= -1 && bakedL <= 1, 'crossfade equal-power não deveria estourar a faixa [-1,1] numa rampa [0,1]');
  // Frames bem longe da emenda (início do buffer) não deveriam ter sido tocados.
  assert.equal(baked.interleaved[0], RAMP[0]);
});

check('bakeAutoLoop "search-rev-xfade": mesmo comprimento/pontos de loop, região final muda e usa uma mistura com o próprio trecho invertido', () => {
  const baked = bakeAutoLoop(RAMP, 2, SR, SYNTH_LOOP, 'search-rev-xfade', 10);
  assert.equal(baked.loopStartFrame, SYNTH_LOOP.loopStartFrame);
  assert.equal(baked.loopEndFrame, SYNTH_LOOP.loopEndFrame);
  assert.equal(baked.interleaved.length, RAMP.length);
  const frame = SYNTH_LOOP.loopEndFrame - 1;
  assert.notEqual(baked.interleaved[frame * 2], RAMP[frame * 2]);
  // Rev X-Fade e X-Fade devem produzir resultados DIFERENTES entre si (uma usa o começo do loop, a outra usa o próprio fim invertido).
  const xfade = bakeAutoLoop(RAMP, 2, SR, SYNTH_LOOP, 'search-xfade', 10);
  assert.notEqual(baked.interleaved[frame * 2], xfade.interleaved[frame * 2]);
});

check('bakeAutoLoop "bidirectional": dobra o trecho do loop (forward + reverso) e preserva prefixo/sufixo', () => {
  const baked = bakeAutoLoop(RAMP, 2, SR, SYNTH_LOOP, 'bidirectional', 10);
  const loopFrameCount = SYNTH_LOOP.loopEndFrame - SYNTH_LOOP.loopStartFrame;
  const prefixFrames = SYNTH_LOOP.loopStartFrame;
  const suffixFrames = RAMP_FRAMES - SYNTH_LOOP.loopEndFrame;
  const expectedTotalFrames = prefixFrames + loopFrameCount * 2 + suffixFrames;

  assert.equal(baked.interleaved.length, expectedTotalFrames * 2);
  assert.equal(baked.loopStartFrame, prefixFrames);
  assert.equal(baked.loopEndFrame, prefixFrames + loopFrameCount * 2);

  // Prefixo intacto.
  for (let f = 0; f < prefixFrames; f += 10) {
    assert.equal(baked.interleaved[f * 2], RAMP[f * 2]);
  }
  // Meio do trecho forward (longe das emendas com crossfade) bate com o original.
  const midForwardOffset = prefixFrames + Math.floor(loopFrameCount / 2);
  const midForwardOriginal = SYNTH_LOOP.loopStartFrame + Math.floor(loopFrameCount / 2);
  assert.equal(baked.interleaved[midForwardOffset * 2], RAMP[midForwardOriginal * 2]);
  // Meio do trecho reverso bate com o original invertido no tempo.
  const midReverseOffset = prefixFrames + loopFrameCount + Math.floor(loopFrameCount / 2);
  const midReverseOriginal = SYNTH_LOOP.loopEndFrame - 1 - Math.floor(loopFrameCount / 2);
  assert.equal(baked.interleaved[midReverseOffset * 2], RAMP[midReverseOriginal * 2]);
  // Sufixo intacto (começa logo depois do trecho dobrado).
  const suffixOffset = prefixFrames + loopFrameCount * 2;
  assert.equal(baked.interleaved[suffixOffset * 2], RAMP[SYNTH_LOOP.loopEndFrame * 2]);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.error('\nALGUM TESTE FALHOU.');
  process.exit(process.exitCode);
}
