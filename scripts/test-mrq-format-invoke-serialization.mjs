#!/usr/bin/env node
/**
 * Teste de regressão pro bug real reportado pelo usuário: "invalid args
 * `source` for command `mrq_builder_add_sample`: invalid type: map,
 * expected a sequence". Causa raiz: `invoke()` do Tauri serializa os
 * argumentos como JSON puro — e `JSON.stringify` de um Float32Array ou
 * Int32Array (QUALQUER TypedArray que não seja Uint8Array) não vira um
 * array JSON, vira um objeto tipo `{"0":1,"1":2,...}` — que o lado Rust
 * (serde, esperando `Vec<f32>`/`Vec<i32>`) rejeita. Isso afetava o Auto
 * Sampler (`autoSampler.ts`, `raw.interleaved` é um Float32Array de
 * verdade vindo de captura de áudio real) e os importadores EXS24/SYX, que
 * também passam Float32Array direto.
 *
 * `mrqBuilderAddSample` em mrqFormat.ts agora normaliza SEMPRE pra array
 * plano antes de chamar `invoke` — este teste verifica isso simulando
 * exatamente a serialização real que o Tauri faz (`JSON.stringify` +
 * `JSON.parse`, o jeito mais simples de provar que o que seria mandado por
 * cima do IPC chega como sequência, não como mapa).
 *
 * Rode com: node scripts/test-mrq-format-invoke-serialization.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`✘ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// Módulo-espião que substitui '@tauri-apps/api/core' dentro do bundle —
// captura os argumentos exatos que `mrqBuilderAddSample` passaria pro
// `invoke` real, sem precisar de um runtime Tauri de verdade.
const spyModulePath = path.join(os.tmpdir(), `mrq-invoke-spy-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
// Usa uma chave em `globalThis` (não uma variável de módulo) porque o
// esbuild faz BUNDLE do alias direto dentro do arquivo compilado de
// mrqFormat.ts — ou seja, o `require(spyModulePath)` de dentro do bundle e
// o `import(spyModulePath)` feito aqui embaixo, direto pelo Node, acabam
// sendo DUAS instâncias de módulo diferentes, cada uma com seu próprio
// `lastCall` se ele fosse uma variável local. `globalThis` é compartilhado
// pelas duas de verdade.
fs.writeFileSync(
  spyModulePath,
  `
  function invoke(cmd, args) {
    globalThis.__mrqInvokeSpyLastCall = { cmd, args };
    return Promise.resolve({});
  }
  function getLastInvokeCall() { return globalThis.__mrqInvokeSpyLastCall ?? null; }
  module.exports = { invoke, getLastInvokeCall };
  `
);

async function compileToNode(entry) {
  const outfile = path.join(
    os.tmpdir(),
    `mrq-format-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
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

const { mrqBuilderAddSample } = await compileToNode('src/audio/rack/mrqFormat.ts');
const { getLastInvokeCall } = await import(`file://${spyModulePath}`);

/** Simula a serialização real do IPC do Tauri (JSON puro) e devolve o que chegaria do outro lado, em Rust. */
function simulateTauriIpcRoundTrip(args) {
  return JSON.parse(JSON.stringify(args));
}

await check('mrqBuilderAddSample normaliza um Float32Array em array plano antes do invoke (kind=float32)', async () => {
  const interleaved = new Float32Array([0.1, -0.2, 0.3, -0.4]);
  await mrqBuilderAddSample('session-1', 'sample-1', { kind: 'float32', interleaved }, 44100, 2);
  const call = getLastInvokeCall();
  assert.equal(call.cmd, 'mrq_builder_add_sample');
  assert.ok(Array.isArray(call.args.source.interleaved), 'interleaved deveria já ser um array plano ANTES mesmo de serializar');
  const roundTripped = simulateTauriIpcRoundTrip(call.args);
  assert.ok(Array.isArray(roundTripped.source.interleaved), 'depois do round-trip JSON (simulando o IPC real do Tauri), interleaved precisa continuar uma sequência, nunca um mapa {"0":..,"1":..}');
  assert.deepEqual(roundTripped.source.interleaved, [0.1, -0.2, 0.3, -0.4].map((v) => Math.fround(v)));
});

await check('mrqBuilderAddSample normaliza um Int32Array em array plano antes do invoke (kind=integerPcm)', async () => {
  const interleaved = new Int32Array([100, -200, 300, -400]);
  await mrqBuilderAddSample('session-2', 'sample-2', { kind: 'integerPcm', bitsPerSample: 24, interleaved }, 48000, 2);
  const call = getLastInvokeCall();
  assert.ok(Array.isArray(call.args.source.interleaved));
  const roundTripped = simulateTauriIpcRoundTrip(call.args);
  assert.ok(Array.isArray(roundTripped.source.interleaved), 'mesma checagem pro caminho integerPcm (Int32Array), usado por outras partes do app');
  assert.deepEqual(roundTripped.source.interleaved, [100, -200, 300, -400]);
});

await check('mrqBuilderAddSample aceita um array plano normal sem quebrar nada (caminho já correto antes do fix)', async () => {
  const interleaved = [1, 2, 3];
  await mrqBuilderAddSample('session-3', 'sample-3', { kind: 'float32', interleaved }, 44100, 1);
  const call = getLastInvokeCall();
  assert.ok(Array.isArray(call.args.source.interleaved));
  assert.deepEqual(call.args.source.interleaved, [1, 2, 3]);
});

await check('reproduz o bug original fora do fix: JSON.stringify de um TypedArray cru vira mapa, não sequência (prova da causa raiz)', () => {
  const raw = { interleaved: new Float32Array([1, 2, 3]) };
  const serialized = JSON.parse(JSON.stringify(raw));
  assert.ok(!Array.isArray(serialized.interleaved), 'esperado reproduzir o bug: sem a normalização, um TypedArray cru vira {"0":1,"1":2,"2":3} depois do JSON.stringify — exatamente o "invalid type: map, expected a sequence" que o Rust reportou.');
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.error('\nALGUM TESTE FALHOU.');
  process.exit(process.exitCode);
}
