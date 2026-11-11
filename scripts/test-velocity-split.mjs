#!/usr/bin/env node
/**
 * Teste de regressão das DIVISÓRIAS DE VELOCITY do Editor de Mapeamento
 * (src/audio/rack/velocitySplit.ts). Mesmo padrão de
 * test-auto-sampler-engine.mjs: compila o módulo TS de verdade com esbuild
 * pra CJS/Node e testa as funções puras — sem React/Web MIDI/Tauri.
 *
 * Rode com: node scripts/test-velocity-split.mjs
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
    `mrq-velocity-split-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
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
  deriveEdges,
  sanitizeEdges,
  edgesToRanges,
  edgesToPatches,
  moveDivider,
  moveSegment,
  equalEdges,
  stretchEdges,
  clampVelocity,
} = await compileToNode('src/audio/rack/velocitySplit.ts');

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
check('clampVelocity limita 0..128 e arredonda', () => {
  assert.equal(clampVelocity(10.6), 11);
  assert.equal(clampVelocity(-5), 0);
  assert.equal(clampVelocity(999), 128);
  assert.equal(clampVelocity(NaN), 0);
});

check('exemplo do usuário: divisórias 10/48/81 → 0–9, 10–47, 48–80, 81–127', () => {
  const edges = sanitizeEdges([0, 10, 48, 81, 128]);
  assert.deepEqual(edges, [0, 10, 48, 81, 128]);
  assert.deepEqual(edgesToRanges(edges), [
    { loVel: 0, hiVel: 9 },
    { loVel: 10, hiVel: 47 },
    { loVel: 48, hiVel: 80 },
    { loVel: 81, hiVel: 127 },
  ]);
});

check('as faixas nunca se sobrepõem e cobrem exatamente 0..127', () => {
  const ranges = edgesToRanges([0, 10, 48, 81, 128]);
  for (let i = 0; i < ranges.length - 1; i += 1) {
    assert.equal(ranges[i].hiVel + 1, ranges[i + 1].loVel);
  }
  assert.equal(ranges[0].loVel, 0);
  assert.equal(ranges[ranges.length - 1].hiVel, 127);
});

check('edgesToPatches gera um patch por zona, na ordem das camadas', () => {
  const patches = edgesToPatches(['z1', 'z2', 'z3', 'z4'], [0, 10, 48, 81, 128]);
  assert.equal(patches.length, 4);
  assert.deepEqual(patches[0], { key: 'z1', loVel: 0, hiVel: 9 });
  assert.deepEqual(patches[3], { key: 'z4', loVel: 81, hiVel: 127 });
});

check('deriveEdges lê loVel/hiVel reais das zonas (com buracos nas pontas)', () => {
  const zones = [
    { loVel: 20, hiVel: 45 },
    { loVel: 46, hiVel: 90 },
    { loVel: 91, hiVel: 110 },
  ];
  assert.deepEqual(deriveEdges(zones), [20, 46, 91, 111]);
  assert.deepEqual(edgesToRanges(deriveEdges(zones)), [
    { loVel: 20, hiVel: 45 },
    { loVel: 46, hiVel: 90 },
    { loVel: 91, hiVel: 110 },
  ]);
});

check('deriveEdges de 1 zona (ou nenhuma) devolve o eixo inteiro', () => {
  assert.deepEqual(deriveEdges([]), [0, 128]);
  assert.deepEqual(deriveEdges([{ loVel: 40, hiVel: 80 }]), [0, 128]);
});

check('sanitizeEdges corrige valores fora de ordem e fora do intervalo', () => {
  assert.deepEqual(sanitizeEdges([0, 80, 20, 128]), [0, 80, 81, 128]);
  assert.deepEqual(sanitizeEdges([-10, 200, 300, 999]), [0, 126, 127, 128]);
  assert.deepEqual(sanitizeEdges([0, 0, 0, 128]), [0, 1, 2, 128]);
});

check('moveDivider respeita os vizinhos (nunca inverte nem esmaga)', () => {
  const e = [0, 10, 48, 81, 128];
  assert.deepEqual(moveDivider(e, 1, 30), [0, 30, 48, 81, 128]);
  assert.deepEqual(moveDivider(e, 2, 200), [0, 10, 80, 81, 128]);
  assert.deepEqual(moveDivider(e, 2, -50), [0, 10, 11, 81, 128]);
  // pontas não são arrastáveis
  assert.deepEqual(moveDivider(e, 0, 50), e);
  assert.deepEqual(moveDivider(e, 4, 50), e);
});

check('arrastar a 1ª divisória muda as DUAS faixas adjacentes', () => {
  const patches = edgesToPatches(['a', 'b', 'c', 'd'], moveDivider([0, 10, 48, 81, 128], 1, 20));
  assert.deepEqual(patches[0], { key: 'a', loVel: 0, hiVel: 19 });
  assert.deepEqual(patches[1], { key: 'b', loVel: 20, hiVel: 47 });
  assert.deepEqual(patches[2], { key: 'c', loVel: 48, hiVel: 80 });
});

check('moveSegment desloca a camada inteira (as duas bordas andam juntas)', () => {
  const e = [0, 10, 48, 81, 128];
  assert.deepEqual(moveSegment(e, 1, 5), [0, 15, 53, 81, 128]);
  assert.deepEqual(moveSegment(e, 2, -20), [0, 10, 28, 61, 128]);
});

check('moveSegment não deixa a camada cruzar os vizinhos', () => {
  const e = [0, 10, 48, 81, 128];
  const tooFar = moveSegment(e, 1, 500);
  assert.ok(tooFar[2] < tooFar[3]);
  assert.deepEqual(edgesToRanges(tooFar).map((r) => r.hiVel - r.loVel + 1).every((w) => w >= 1), true);
  const tooLeft = moveSegment(e, 2, -500);
  assert.ok(tooLeft[1] < tooLeft[2]);
});

check('equalEdges divide 0–127 em partes iguais', () => {
  assert.deepEqual(equalEdges(2), [0, 64, 128]);
  assert.deepEqual(equalEdges(4), [0, 32, 64, 96, 128]);
  assert.deepEqual(equalEdges(3), [0, 43, 85, 128]);
});

check('stretchEdges preenche as pontas 0 e 127 sem mexer nas divisórias internas', () => {
  assert.deepEqual(stretchEdges([20, 48, 81, 111]), [0, 48, 81, 128]);
  assert.deepEqual(edgesToRanges(stretchEdges([20, 48, 81, 111])), [
    { loVel: 0, hiVel: 47 },
    { loVel: 48, hiVel: 80 },
    { loVel: 81, hiVel: 127 },
  ]);
});

check('aplicar a todos: 4 conjuntos de 4 camadas recebem as mesmas faixas', () => {
  const edges = sanitizeEdges([0, 10, 48, 81, 128]);
  const sets = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'].map((k) => k);
  const patches = [...edgesToPatches(sets.slice(0, 4), edges), ...edgesToPatches(sets.slice(4), edges)];
  assert.equal(patches.length, 8);
  assert.deepEqual(patches[0], { key: 'a1', loVel: 0, hiVel: 9 });
  assert.deepEqual(patches[4], { key: 'b1', loVel: 0, hiVel: 9 });
  assert.deepEqual(patches[7], { key: 'b4', loVel: 81, hiVel: 127 });
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) console.error('Falha em um ou mais testes.');
else console.log('Tudo certo.');
