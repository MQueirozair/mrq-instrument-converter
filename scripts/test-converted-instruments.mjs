#!/usr/bin/env node
/**
 * Teste da lógica pura do Gerenciador de Instrumentos Convertidos (v0.2.21)
 * — src/audio/rack/convertedInstruments.ts: lista persistente (add/remove/
 * dedupe), detecção de modelo sujo e validação de trims de amostra.
 *
 * Rode com: node scripts/test-converted-instruments.mjs
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
    `mrq-converted-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile });
  return import(`file://${outfile}`);
}

const {
  loadConvertedInstruments,
  saveConvertedInstruments,
  addConvertedInstrument,
  removeConvertedInstrument,
  isInstrumentDirty,
  clampTrim,
  isTrimActive,
  formatSampleDuration,
  formatFileSize,
  basenameOfPath,
} = await compileToNode('src/audio/rack/convertedInstruments.ts');

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

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

check('load/save round-trip via storage em memória', () => {
  const store = memoryStorage();
  assert.deepEqual(loadConvertedInstruments(store), []);
  saveConvertedInstruments([{ path: '/a/b.mrq', name: 'b.mrq', addedAt: 1 }], store);
  assert.deepEqual(loadConvertedInstruments(store), [{ path: '/a/b.mrq', name: 'b.mrq', addedAt: 1 }]);
});

check('load nunca lança com JSON inválido ou storage nulo', () => {
  const store = memoryStorage();
  store.setItem('mrq.convertedInstruments.v1', '{nao-json');
  assert.deepEqual(loadConvertedInstruments(store), []);
  assert.deepEqual(loadConvertedInstruments(null), []);
  store.setItem('mrq.convertedInstruments.v1', JSON.stringify([{ path: 42 }, { path: '/ok.mrq', name: 'ok.mrq', addedAt: 2 }, null]));
  assert.deepEqual(loadConvertedInstruments(store), [{ path: '/ok.mrq', name: 'ok.mrq', addedAt: 2 }]);
});

check('addConvertedInstrument: adiciona no topo, dedupa por caminho, não muta a entrada', () => {
  const empty = [];
  const one = addConvertedInstrument(empty, '/x/piano.mrq', 100);
  assert.equal(one.length, 1);
  assert.equal(one[0].name, 'piano.mrq');
  assert.equal(one[0].addedAt, 100);
  assert.equal(empty.length, 0, 'a lista original não pode ser mutada');
  const dup = addConvertedInstrument(one, '/x/piano.mrq', 200);
  assert.equal(dup.length, 1, 'mesmo caminho não duplica');
  assert.equal(dup[0].addedAt, 100, 'a entrada original é preservada');
  const two = addConvertedInstrument(one, 'C:\\Musica\\baixo.mrq', 300);
  assert.equal(two.length, 2);
  assert.equal(two[0].name, 'baixo.mrq', 'basename funciona com caminho Windows');
  assert.equal(addConvertedInstrument(one, '').length, 1, 'caminho vazio é ignorado');
});

check('removeConvertedInstrument: remove só o caminho pedido', () => {
  const list = [
    { path: '/a.mrq', name: 'a.mrq', addedAt: 1 },
    { path: '/b.mrq', name: 'b.mrq', addedAt: 2 },
  ];
  assert.deepEqual(removeConvertedInstrument(list, '/a.mrq'), [{ path: '/b.mrq', name: 'b.mrq', addedAt: 2 }]);
  assert.equal(removeConvertedInstrument(list, '/inexistente.mrq').length, 2);
});

const MODEL_A = { name: 'Piano', sourceFormat: 'sf2', importedAt: '2026-01-01T00:00:00Z', presets: [], midi: null };
const MODEL_B = { ...MODEL_A, name: 'Piano Editado' };

check('isInstrumentDirty: detecta edição e igualdade', () => {
  assert.equal(isInstrumentDirty(MODEL_A, MODEL_A), false);
  assert.equal(isInstrumentDirty(MODEL_A, JSON.parse(JSON.stringify(MODEL_A))), false);
  assert.equal(isInstrumentDirty(MODEL_A, MODEL_B), true);
});

check('clampTrim: limita aos limites reais e rejeita corte inválido', () => {
  assert.deepEqual(clampTrim({ sampleId: 's', startFrame: -10, endFrame: 99999 }, 4800), { sampleId: 's', startFrame: 0, endFrame: 4800 });
  assert.deepEqual(clampTrim({ sampleId: 's', startFrame: 100.7, endFrame: 200.2 }, 4800), { sampleId: 's', startFrame: 100, endFrame: 200 });
  assert.equal(clampTrim({ sampleId: 's', startFrame: 5000, endFrame: 6000 }, 4800), null, 'start além do fim não tem corte válido');
  assert.equal(clampTrim({ sampleId: 's', startFrame: 100, endFrame: 100 }, 4800), null, 'start == end não é corte válido');
  assert.equal(clampTrim({ sampleId: 's', startFrame: 0, endFrame: 10 }, 0), null, 'amostra vazia não tem corte');
});

check('isTrimActive: só é ativo quando corta de verdade', () => {
  assert.equal(isTrimActive(null, 4800), false);
  assert.equal(isTrimActive({ sampleId: 's', startFrame: 0, endFrame: 4800 }, 4800), false, 'arquivo inteiro não é corte');
  assert.equal(isTrimActive({ sampleId: 's', startFrame: 100, endFrame: 4800 }, 4800), true);
  assert.equal(isTrimActive({ sampleId: 's', startFrame: 0, endFrame: 4700 }, 4800), true);
});

check('formatSampleDuration / formatFileSize / basenameOfPath', () => {
  assert.equal(formatSampleDuration(44100, 44100), '1,0s');
  assert.equal(formatSampleDuration(22050, 44100), '500ms');
  assert.equal(formatSampleDuration(441, 44100), '10ms');
  assert.equal(formatSampleDuration(100, 0), '—');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1536), '1,5 KB');
  assert.equal(formatFileSize(5 * 1024 * 1024), '5,0 MB');
  assert.equal(basenameOfPath('/a/b/c.mrq'), 'c.mrq');
  assert.equal(basenameOfPath('C:\\x\\y.mrq'), 'y.mrq');
});

console.log(`\n${passed} teste(s) passaram.`);
process.exit(process.exitCode ?? 0);
