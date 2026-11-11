#!/usr/bin/env node
/**
 * Teste de regressão do ARRASTE das divisórias do "Velocity Response" do
 * Auto Sampler (v0.2.14). Cobre o bug relatado pelo usuário: ele clicava na
 * linha da foto num preset (linear/exp/log) e nada acontecia, porque o
 * componente só permitia arrastar quando a resposta já era "Custom".
 *
 * Compila os módulos TS de verdade com esbuild pra CJS/Node (mesmo padrão de
 * test-auto-sampler-engine.mjs) e valida a lógica pura + a integração com
 * computeVelocityBreakpoints (o motor que consome os pontos customizados).
 *
 * Rode com: node scripts/test-velocity-breakpoint-drag.mjs
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
    `mrq-vel-drag-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile,
  });
  return import(`file://${outfile}`);
}

const { clampMidiVelocity, moveBreakpoint, nearestDraggableDivider, clientXToVelocity } =
  await compileToNode('src/audio/rack/velocityBreakpointDrag.ts');
const { computeVelocityBreakpoints } = await compileToNode('src/audio/rack/autoSamplerEngine.ts');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✔ ${name}`); }
  catch (err) { console.error(`✖ ${name}`); console.error(err); process.exitCode = 1; }
}

check('clampMidiVelocity limita 0..127 e arredonda', () => {
  assert.equal(clampMidiVelocity(10.6), 11);
  assert.equal(clampMidiVelocity(-5), 0);
  assert.equal(clampMidiVelocity(999), 127);
  assert.equal(clampMidiVelocity(NaN), 0);
});

check('breakpoints lineares de 3 camadas (o caso da foto)', () => {
  assert.deepEqual(computeVelocityBreakpoints(3, 'linear'), [0, 42, 85, 127]);
});

check('arrastar a 1ª divisória de um preset linear gera pontos customizados válidos', () => {
  const preset = computeVelocityBreakpoints(3, 'linear');       // [0,42,85,127]
  const dragged = moveBreakpoint(preset, 1, 30);                // clique+arraste na linha
  assert.deepEqual(dragged, [0, 30, 85, 127]);
  // o chamador troca pra 'custom' e o motor devolve exatamente esses pontos
  assert.deepEqual(computeVelocityBreakpoints(3, 'custom', dragged), dragged);
  assert.notDeepEqual(dragged, preset);
});

check('arrastar a 2ª divisória também funciona em preset exp/log', () => {
  for (const curve of ['exp1', 'exp2', 'log1', 'log3']) {
    const bp = computeVelocityBreakpoints(4, curve);
    const dragged = moveBreakpoint(bp, 2, 70);
    assert.deepEqual(computeVelocityBreakpoints(4, 'custom', dragged), dragged);
    // 70 pode estar além do vizinho direito em curvas extremas: o arraste
    // é limitado (nunca cruza), mas ainda assim gera um custom válido.
    assert.equal(dragged[2], Math.max(bp[1] + 1, Math.min(bp[3] - 1, 70)));
    assert.ok(dragged[2] > dragged[1] && dragged[2] < dragged[3]);
  }
});

check('moveBreakpoint nunca cruza os vizinhos', () => {
  const bp = [0, 42, 85, 127];
  assert.deepEqual(moveBreakpoint(bp, 1, 999), [0, 84, 85, 127]);
  assert.deepEqual(moveBreakpoint(bp, 1, -999), [0, 1, 85, 127]);
  assert.deepEqual(moveBreakpoint(bp, 2, -999), [0, 42, 43, 127]);
  assert.deepEqual(moveBreakpoint(bp, 2, 999), [0, 42, 126, 127]);
});

check('pontas 0 e 127 são fixas (não arrastáveis)', () => {
  const bp = [0, 42, 85, 127];
  assert.deepEqual(moveBreakpoint(bp, 0, 60), bp);
  assert.deepEqual(moveBreakpoint(bp, 3, 60), bp);
});

check('clientXToVelocity mapeia a largura do SVG para 0..127', () => {
  assert.equal(clientXToVelocity(100, 100, 400), 0);
  assert.equal(clientXToVelocity(300, 100, 400), 64);
  assert.equal(clientXToVelocity(500, 100, 400), 127);
  assert.equal(clientXToVelocity(999, 100, 400), 127);
  assert.equal(clientXToVelocity(50, 100, 400), 0);
  assert.equal(clientXToVelocity(200, 100, 0), 0);
});

check('clique DENTRO da faixa, perto da linha, pega a divisória', () => {
  const bp = [0, 42, 85, 127];
  assert.equal(nearestDraggableDivider(bp, 40, 8), 1);
  assert.equal(nearestDraggableDivider(bp, 88, 8), 2);
  assert.equal(nearestDraggableDivider(bp, 60, 8), null); // longe das duas
  assert.equal(nearestDraggableDivider([0, 127], 60, 8), null); // sem divisórias internas
});

check('tolerância é configurável e escolhe sempre a mais próxima', () => {
  const bp = [0, 42, 85, 127];
  assert.equal(nearestDraggableDivider(bp, 40, 2), 1);
  assert.equal(nearestDraggableDivider(bp, 45, 1), null);
  assert.equal(nearestDraggableDivider(bp, 64, 30), 2); // 85 está a 21, 42 a 22
});

check('arraste sequencial mantém ordem estrita (vários pointermoves)', () => {
  let bp = computeVelocityBreakpoints(4, 'linear');
  for (const v of [10, 20, 35, 48, 60, 77, 95, 110]) {
    bp = moveBreakpoint(bp, 2, v);
    for (let i = 1; i < bp.length; i += 1) assert.ok(bp[i] > bp[i - 1]);
    assert.deepEqual(computeVelocityBreakpoints(4, 'custom', bp), bp);
  }
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) console.error('Falha em um ou mais testes.');
else console.log('Tudo certo.');
