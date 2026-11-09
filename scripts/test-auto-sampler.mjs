#!/usr/bin/env node
/**
 * Teste de regressão das partes PURAS/mapeáveis de
 * src/audio/rack/autoSampler.ts — a cola entre as tarefas geradas pelo
 * motor puro (autoSamplerEngine.ts) e os formatos de zona exigidos pelo
 * `.mrq` (MrqZone/MrqInstrumentModel) e pelo SF2 (Sf2ExportZone).
 *
 * O que este teste NÃO cobre (de propósito — exige hardware real, ver
 * AutoSamplerSession em autoSampler.ts): abrir a porta MIDI de verdade,
 * mandar Note On/Off, gravar áudio de uma entrada real, cancelamento
 * durante uma captura em andamento. Isso só pode ser validado pelo usuário
 * na própria máquina, com Kontakt + loopback de áudio + porta MIDI
 * configurados (ver docs/mrq-instrument-converter/mrq-auto-sampler.md).
 *
 * Mesmo padrão de scripts/test-auto-sampler-engine.mjs: compila o módulo TS
 * de verdade com esbuild pra CJS/Node.
 *
 * Rode com: node scripts/test-auto-sampler.mjs
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
    `mrq-auto-sampler-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
    // As únicas chamadas reais de I/O (mrqBuilderBegin/writeFile/invoke)
    // nunca são executadas pelas funções exercitadas por este teste —
    // ficam dentro de buildMrqFromCaptures/buildSf2FromCaptures/
    // AutoSamplerSession, nenhuma das quais é chamada aqui. Então é seguro
    // deixar @tauri-apps/* serem empacotados de verdade (não precisam ser
    // mockados) — eles só precisam CARREGAR sem lançar erro fora do Tauri,
    // o que já é o caso (os wrappers de invoke não tocam `window` no
    // top-level do módulo).
    external: [],
  });
  return import(`file://${outfile}`);
}

const {
  generateAutoSamplerTasks,
  computeAutoSamplerKeyRanges,
} = await compileToNode('src/audio/rack/autoSamplerEngine.ts');

const { buildAutoSamplerMrqModel, buildAutoSamplerSf2Zones, buildAutoSamplerCompatibilityReport } = await compileToNode(
  'src/audio/rack/autoSampler.ts'
);

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
// Config pequena e determinística usada por vários testes abaixo: 2 notas
// (C3=60, D3=62, Sample Every = 2 semitons), 2 camadas de velocity lineares,
// 2 round robins — 2 notas x 2 vel x 2 rr = 8 tarefas.
// ---------------------------------------------------------------------------
const CONFIG = {
  rangeStartNote: 60,
  rangeEndNote: 62,
  sampleEverySemitones: 2,
  velocityLayers: 2,
  velocityResponse: 'linear',
  roundRobinCount: 2,
  sustainSeconds: 1,
  releaseTailSeconds: 0.2,
  autoLoop: 'search',
  autoLoopStartPct: 40,
  autoLoopEndPct: 90,
  oneShot: false,
};

const tasks = generateAutoSamplerTasks(CONFIG);
const notes = [...new Set(tasks.map((t) => t.note))];
const keyRanges = computeAutoSamplerKeyRanges(notes);

check('generateAutoSamplerTasks: 2 notas x 2 vel x 2 rr = 8 tarefas', () => {
  assert.equal(tasks.length, 8);
});

// ---------------------------------------------------------------------------
// buildAutoSamplerMrqModel — forma do MrqInstrumentModel/MrqZone.
// ---------------------------------------------------------------------------

check('buildAutoSamplerMrqModel: uma zona por tarefa, na mesma ordem', () => {
  const model = buildAutoSamplerMrqModel('Teste Auto Sampler', tasks, keyRanges, new Map());
  assert.equal(model.sourceFormat, 'kontakt-capture');
  assert.equal(model.presets.length, 1);
  assert.equal(model.presets[0].groups.length, 1);
  const zones = model.presets[0].groups[0].zones;
  assert.equal(zones.length, tasks.length);
  zones.forEach((z, i) => assert.equal(z.sampleId, tasks[i].id));
});

check('buildAutoSamplerMrqModel: loKey/hiKey preenchem o teclado inteiro sem buracos/sobreposição', () => {
  const model = buildAutoSamplerMrqModel('Teste', tasks, keyRanges, new Map());
  const zones = model.presets[0].groups[0].zones;
  const byNote = new Map();
  for (const z of zones) if (!byNote.has(z.rootNote)) byNote.set(z.rootNote, z);
  const sorted = [...byNote.values()].sort((a, b) => a.rootNote - b.rootNote);
  assert.equal(sorted[0].loKey, 0, 'a nota mais grave começa em 0');
  assert.equal(sorted[sorted.length - 1].hiKey, 127, 'a nota mais aguda termina em 127');
  for (let i = 0; i < sorted.length - 1; i += 1) {
    assert.equal(sorted[i].hiKey + 1, sorted[i + 1].loKey, `sem buraco/sobreposição entre nota ${sorted[i].rootNote} e ${sorted[i + 1].rootNote}`);
  }
});

check('buildAutoSamplerMrqModel: round robin presente quando roundRobinCount > 1', () => {
  const model = buildAutoSamplerMrqModel('Teste', tasks, keyRanges, new Map());
  const zones = model.presets[0].groups[0].zones;
  assert.ok(zones.every((z) => typeof z.roundRobinGroup === 'string' && z.roundRobinGroup.length > 0));
  // As duas variações (rr=0, rr=1) da mesma nota+camada de velocity compartilham o mesmo grupo mas têm índices diferentes.
  const byGroup = new Map();
  for (const z of zones) {
    if (!byGroup.has(z.roundRobinGroup)) byGroup.set(z.roundRobinGroup, []);
    byGroup.get(z.roundRobinGroup).push(z.roundRobinIndex);
  }
  for (const indices of byGroup.values()) {
    assert.deepEqual([...indices].sort(), [0, 1]);
  }
});

check('buildAutoSamplerMrqModel: sem round robin (count=1) não define roundRobinGroup', () => {
  const singleRrTasks = generateAutoSamplerTasks({ ...CONFIG, roundRobinCount: 1 });
  const model = buildAutoSamplerMrqModel('Teste', singleRrTasks, keyRanges, new Map());
  const zones = model.presets[0].groups[0].zones;
  assert.ok(zones.every((z) => z.roundRobinGroup === undefined));
});

check('buildAutoSamplerMrqModel: pontos de loop só aplicados às zonas presentes no mapa', () => {
  const loopPoints = new Map([[tasks[0].id, { loopStartFrame: 1000, loopEndFrame: 5000 }]]);
  const model = buildAutoSamplerMrqModel('Teste', tasks, keyRanges, loopPoints);
  const zones = model.presets[0].groups[0].zones;
  const withLoop = zones.find((z) => z.sampleId === tasks[0].id);
  assert.equal(withLoop.loopEnabled, true);
  assert.equal(withLoop.loopStart, 1000);
  assert.equal(withLoop.loopEnd, 5000);
  const withoutLoop = zones.find((z) => z.sampleId === tasks[1].id);
  assert.equal(withoutLoop.loopEnabled, undefined);
});

// ---------------------------------------------------------------------------
// buildAutoSamplerSf2Zones — forma do Sf2ExportZone a partir de áudio
// sintético (silêncio é suficiente: só testa a FORMA das zonas, não o
// conteúdo do áudio — isso já é coberto por scripts/test-sf2-export.mjs
// com renderização real via fluidsynth).
// ---------------------------------------------------------------------------

function fakeCapture(channels, frames, sampleRateHz = 44100) {
  return { interleaved: new Float32Array(frames * channels), sampleRateHz, channels };
}

check('buildAutoSamplerSf2Zones: pula tarefas sem áudio capturado (ex.: cancelado no meio)', () => {
  const captured = new Map();
  captured.set(tasks[0].id, fakeCapture(2, 100));
  // Só a primeira tarefa tem áudio — simula uma sessão cancelada no meio.
  const zones = buildAutoSamplerSf2Zones(tasks, keyRanges, captured, new Map());
  assert.equal(zones.length, 1);
  assert.equal(zones[0].label, `n${tasks[0].note}v${tasks[0].velocityLayerIndex}`);
});

check('buildAutoSamplerSf2Zones: canal mono normalizado para 1, estéreo/multicanal pra 2', () => {
  const captured = new Map();
  captured.set(tasks[0].id, fakeCapture(1, 100));
  captured.set(tasks[1].id, fakeCapture(2, 100));
  // Só tasks[0]/tasks[1] têm áudio capturado -> zones sai na mesma ordem (ver teste anterior "pula tarefas sem áudio").
  const zones = buildAutoSamplerSf2Zones(tasks, keyRanges, captured, new Map());
  assert.equal(zones.length, 2);
  assert.equal(zones[0].channels, 1, 'mono (1 canal capturado) deve virar channels=1');
  assert.equal(zones[1].channels, 2, 'estéreo (2 canais capturados) deve virar channels=2');
});

check('buildAutoSamplerSf2Zones: loKey/hiKey/loVel/hiVel repassados sem alteração (mesma ordem de `tasks`, já que todas têm áudio capturado)', () => {
  const captured = new Map(tasks.map((t) => [t.id, fakeCapture(2, 50)]));
  const zones = buildAutoSamplerSf2Zones(tasks, keyRanges, captured, new Map());
  assert.equal(zones.length, tasks.length);
  zones.forEach((z, i) => {
    const task = tasks[i];
    const kr = keyRanges.get(task.note);
    assert.equal(z.rootNote, task.note);
    assert.equal(z.loVel, task.loVel);
    assert.equal(z.hiVel, task.hiVel);
    assert.equal(z.loKey, kr.loKey);
    assert.equal(z.hiKey, kr.hiKey);
  });
});

check('buildAutoSamplerSf2Zones: pontos de loop repassados quando presentes, na posição certa (mesma ordem de `tasks`)', () => {
  const captured = new Map(tasks.map((t) => [t.id, fakeCapture(2, 1000)]));
  const loopPoints = new Map([[tasks[2].id, { loopStartFrame: 10, loopEndFrame: 900 }]]);
  const zones = buildAutoSamplerSf2Zones(tasks, keyRanges, captured, loopPoints);
  assert.equal(zones[2].loopStartFrame, 10);
  assert.equal(zones[2].loopEndFrame, 900);
  zones.forEach((z, i) => {
    if (i === 2) return;
    assert.equal(z.loopStartFrame, undefined);
    assert.equal(z.loopEndFrame, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildAutoSamplerCompatibilityReport
// ---------------------------------------------------------------------------

check('buildAutoSamplerCompatibilityReport: menciona round robin só quando roundRobinCount > 1', () => {
  const withRr = buildAutoSamplerCompatibilityReport({ ...CONFIG, roundRobinCount: 2 });
  const withoutRr = buildAutoSamplerCompatibilityReport({ ...CONFIG, roundRobinCount: 1 });
  assert.ok(withRr.approximated.some((a) => a.field === 'Round robin'));
  assert.ok(!withoutRr.approximated.some((a) => a.field === 'Round robin'));
});

check('buildAutoSamplerCompatibilityReport: menciona pontos de loop só quando autoLoop !== "none"', () => {
  const withLoop = buildAutoSamplerCompatibilityReport({ ...CONFIG, autoLoop: 'search' });
  const withoutLoop = buildAutoSamplerCompatibilityReport({ ...CONFIG, autoLoop: 'none' });
  assert.ok(withLoop.approximated.some((a) => a.field === 'Pontos de loop'));
  assert.ok(!withoutLoop.approximated.some((a) => a.field === 'Pontos de loop'));
});

check('buildAutoSamplerCompatibilityReport: sempre declara o áudio como preservado/gravado ao vivo', () => {
  const report = buildAutoSamplerCompatibilityReport(CONFIG);
  assert.ok(report.preserved.some((p) => p.field === 'Áudio'));
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.error('\nFALHOU.');
} else {
  console.log('\nTudo certo.');
}
