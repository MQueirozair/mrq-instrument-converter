#!/usr/bin/env node
/**
 * Regressão do RASCUNHO do Auto Sampler (v0.2.15).
 *
 * Cobre o relato: ajustes feitos no assistente não podem sumir ao fechar e
 * reabrir; "Voltar do zero" tem de apagar deliberadamente TUDO que foi salvo.
 * O módulo TS é compilado de verdade com esbuild (mesmo padrão dos outros
 * testes de lógica pura do projeto).
 *
 * Rode com: node scripts/test-auto-sampler-draft.mjs
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
    `mrq-auto-sampler-draft-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile,
  });
  return import(`file://${outfile}`);
}

const {
  AUTO_SAMPLER_DRAFT_KEY,
  createDefaultAutoSamplerDraft,
  normalizeAutoSamplerDraft,
  isAutoSamplerDraftDirty,
  readAutoSamplerDraft,
  writeAutoSamplerDraft,
  clearAutoSamplerDraft,
} = await compileToNode('src/audio/rack/autoSamplerDraft.ts');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✔ ${name}`); }
  catch (err) { console.error(`✖ ${name}`); console.error(err); process.exitCode = 1; }
}

function mockStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

check('default é limpo e começa na conexão', () => {
  const d = createDefaultAutoSamplerDraft();
  assert.equal(d.version, 1);
  assert.equal(d.step, 1);
  assert.equal(d.velocityResponse, 'linear');
  assert.equal(isAutoSamplerDraftDirty(d), false);
});

check('normalização preserva TODOS os ajustes do assistente', () => {
  const raw = {
    version: 1,
    step: 4,
    instrumentName: 'Piano Fazenda',
    rangeStartNote: 36,
    rangeEndNote: 96,
    sampleEverySemitones: 2,
    velocityLayers: 3,
    velocityResponse: 'custom',
    customVelocityBreakpoints: [0, 30, 85, 127],
    roundRobinCount: 2,
    sustainSeconds: 6.5,
    releaseTailSeconds: 2.25,
    autoLoop: 'search-xfade',
    autoLoopStartPct: 20,
    autoLoopEndPct: 80,
    oneShot: true,
    inputGainDb: 3.5,
    midiOutputId: 'loopmidi-1',
    midiOutputLabel: 'loopMIDI Port',
    midiChannel: 7,
    audioInputDeviceId: 'vb-cable',
    audioInputLabel: 'CABLE Output (VB-Audio)',
    midiTested: true,
    audioTested: true,
    outputMrq: true,
    outputSf2: false,
  };
  const d = normalizeAutoSamplerDraft(raw);
  assert.deepEqual(d, raw);
  assert.equal(isAutoSamplerDraftDirty(d), true);
});

check('Custom sem pontos válidos volta para Linear sem perder o resto', () => {
  const d = normalizeAutoSamplerDraft({
    version: 1,
    velocityLayers: 2,
    velocityResponse: 'custom',
    customVelocityBreakpoints: [0, 900],
    instrumentName: 'Meu Pad',
  });
  assert.equal(d.velocityResponse, 'linear');
  assert.equal(d.customVelocityBreakpoints, undefined);
  assert.equal(d.instrumentName, 'Meu Pad');
});

check('JSON corrompido, versão errada e NaN não derrubam o app', () => {
  assert.equal(normalizeAutoSamplerDraft(null), null);
  assert.equal(normalizeAutoSamplerDraft({ version: 99 }), null);
  const d = normalizeAutoSamplerDraft({
    version: 1,
    step: 99,
    midiChannel: 'canal 3',
    sustainSeconds: Number.POSITIVE_INFINITY,
    velocityLayers: -4,
    velocityResponse: 'curva-inexistente',
    autoLoop: 'penrose',
    outputMrq: 'sim',
  });
  assert.equal(d.step, 4);
  assert.equal(d.midiChannel, 1); // "canal 3" não é número: volta ao default
  assert.equal(d.sustainSeconds, 2);
  assert.equal(d.velocityLayers, 1);
  assert.equal(d.velocityResponse, 'linear');
  assert.equal(d.autoLoop, 'none');
  assert.equal(d.outputMrq, true);
});

check('valores fora dos limites são limitados aos limites reais da UI', () => {
  const d = normalizeAutoSamplerDraft({
    version: 1,
    step: 999,
    midiChannel: 999,
    velocityLayers: 999,
    roundRobinCount: -2,
    inputGainDb: 100,
    autoLoopEndPct: 1000,
  });
  assert.equal(d.step, 4);
  assert.equal(d.midiChannel, 16);
  assert.equal(d.velocityLayers, 16);
  assert.equal(d.roundRobinCount, 1);
  assert.equal(d.inputGainDb, 24);
  assert.equal(d.autoLoopEndPct, 100);
});

check('roundtrip: gravar, fechar/reabrir e restaurar exatamente os ajustes', () => {
  const storage = mockStorage();
  const edited = {
    ...createDefaultAutoSamplerDraft(),
    step: 3,
    instrumentName: 'Baixo Synth',
    rangeEndNote: 84,
    velocityLayers: 4,
    velocityResponse: 'custom',
    customVelocityBreakpoints: [0, 20, 55, 90, 127],
    midiOutputId: 'porta-b',
    midiChannel: 12,
    audioInputDeviceId: 'loopback-1',
    audioInputLabel: 'Saída do sistema',
    midiTested: true,
    audioTested: true,
    outputSf2: false,
  };
  assert.equal(writeAutoSamplerDraft(edited, storage), true);
  assert.equal(storage._map.has(AUTO_SAMPLER_DRAFT_KEY), true);
  assert.deepEqual(readAutoSamplerDraft(storage), edited);
});

check('Voltar do zero remove a chave salva, não apenas zera a tela', () => {
  const storage = mockStorage();
  const edited = { ...createDefaultAutoSamplerDraft(), step: 4, instrumentName: 'Rascunho antigo' };
  writeAutoSamplerDraft(edited, storage);
  assert.equal(readAutoSamplerDraft(storage).instrumentName, 'Rascunho antigo');
  assert.equal(clearAutoSamplerDraft(storage), true);
  assert.equal(storage._map.has(AUTO_SAMPLER_DRAFT_KEY), false);
  assert.equal(readAutoSamplerDraft(storage), null);
  // O efeito de persistência do componente também remove a chave quando o
  // estado volta exatamente ao default.
  writeAutoSamplerDraft(createDefaultAutoSamplerDraft(), storage);
  assert.equal(storage._map.has(AUTO_SAMPLER_DRAFT_KEY), false);
});

check('JSON inválido no storage é ignorado com segurança', () => {
  const storage = mockStorage({ [AUTO_SAMPLER_DRAFT_KEY]: '{ não é json' });
  assert.equal(readAutoSamplerDraft(storage), null);
});

check('storage indisponível/que lança exceção não quebra o modal', () => {
  const broken = {
    getItem() { throw new Error('bloqueado'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('bloqueado'); },
  };
  assert.equal(readAutoSamplerDraft(broken), null);
  assert.equal(writeAutoSamplerDraft({ ...createDefaultAutoSamplerDraft(), step: 2 }, broken), false);
  assert.equal(clearAutoSamplerDraft(broken), false);
  assert.equal(readAutoSamplerDraft(null), null);
  assert.equal(writeAutoSamplerDraft(createDefaultAutoSamplerDraft(), null), false);
});

console.log(`\n${passed} teste(s) passaram. Tudo certo.`);
