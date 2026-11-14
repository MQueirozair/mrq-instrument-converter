#!/usr/bin/env node
/**
 * Regressão da escolha de formato de saída (v0.2.16).
 *
 * Cobre o bug da foto: item "PRONTO", sem .mrq salvo, com os botões
 * "Exportar .sf2"/"Exportar .sf3" cinzas. Agora os três formatos devem ser
 * escolhas habilitadas, e SoundFont deve funcionar direto (com .mrq
 * temporário nos bastidores) sem obrigar a salvar .mrq antes.
 *
 * Rode com: node scripts/test-converter-output-format.mjs
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
    `mrq-output-format-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile,
  });
  return import(`file://${outfile}`);
}

const {
  converterOutputChoices,
  outputFormatSaveDialogOptions,
  temporaryMrqFileName,
  isTemporaryMrqFileName,
} = await compileToNode('src/audio/rack/converterOutputFormat.ts');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✔ ${name}`); }
  catch (err) { console.error(`✖ ${name}`); console.error(err); process.exitCode = 1; }
}

const readyItem = {
  status: 'inspected',
  sourceFormat: 'sf2',
  hasExportableZones: true,
};

check('item PRONTO habilita os TRÊS formatos, inclusive SF2/SF3 sem .mrq salvo', () => {
  const c = converterOutputChoices(readyItem);
  assert.equal(c.mrq.enabled, true);
  assert.equal(c.sf2.enabled, true);
  assert.equal(c.sf3.enabled, true);
  assert.equal(c.sf2.requiresTemporaryMrq, true);
  assert.equal(c.sf3.requiresTemporaryMrq, true);
  assert.match(c.sf2.reason, /temporária/i);
});

check('item já convertido exporta SF2/SF3 direto do .mrq existente', () => {
  const c = converterOutputChoices({ ...readyItem, status: 'converted', convertedPath: '/tmp/instrumento.mrq' });
  assert.equal(c.sf2.enabled, true);
  assert.equal(c.sf3.enabled, true);
  assert.equal(c.sf2.requiresTemporaryMrq, false);
  assert.match(c.sf3.reason, /já gerado/i);
});

check('Auto Sampler/captura já convertida também permite escolher SF2/SF3', () => {
  const c = converterOutputChoices({
    status: 'converted',
    sourceFormat: null,
    convertedPath: '/tmp/captura.mrq',
    captureKind: 'auto-sampler',
    hasExportableZones: true,
  });
  assert.equal(c.mrq.enabled, false);
  assert.equal(c.sf2.enabled, true);
  assert.equal(c.sf3.enabled, true);
  assert.equal(c.sf2.requiresTemporaryMrq, false);
});

check('instrumento sem zonas desabilita só SoundFont, não .mrq', () => {
  const c = converterOutputChoices({ ...readyItem, hasExportableZones: false });
  assert.equal(c.mrq.enabled, true);
  assert.equal(c.sf2.enabled, false);
  assert.equal(c.sf3.enabled, false);
  assert.match(c.sf2.reason, /zonas/i);
});

check('análise/conversão/exportação em andamento desabilita escolhas concorrentes', () => {
  for (const status of ['pending', 'inspecting', 'converting']) {
    const c = converterOutputChoices({ ...readyItem, status });
    assert.equal(c.mrq.enabled, false, status);
    assert.equal(c.sf2.enabled, false, status);
    assert.equal(c.sf3.enabled, false, status);
  }
  const c = converterOutputChoices({ ...readyItem, exportingSoundFont: 'sf3' });
  assert.equal(c.sf2.enabled, false);
  assert.equal(c.mrq.enabled, false);
});

check('sem origem reconhecida e sem .mrq, nenhum formato é habilitado', () => {
  const c = converterOutputChoices({ status: 'inspect-error', sourceFormat: null, hasExportableZones: false });
  assert.deepEqual([c.mrq.enabled, c.sf2.enabled, c.sf3.enabled], [false, false, false]);
});

check('diálogo de salvar usa a extensão e o filtro corretos para cada formato', () => {
  const mrq = outputFormatSaveDialogOptions('mrq', 'Piano Grande.exs');
  assert.equal(mrq.defaultPath, 'Piano Grande.mrq');
  assert.deepEqual(mrq.filters[0].extensions, ['mrq']);
  const sf2 = outputFormatSaveDialogOptions('sf2', 'Piano Grande.exs');
  assert.equal(sf2.defaultPath, 'Piano Grande.sf2');
  assert.deepEqual(sf2.filters[0].extensions, ['sf2']);
  const sf3 = outputFormatSaveDialogOptions('sf3', 'Piano Grande.exs');
  assert.equal(sf3.defaultPath, 'Piano Grande.sf3');
  assert.deepEqual(sf3.filters[0].extensions, ['sf3']);
  assert.match(sf3.title, /SoundFont 3/);
});

check('nome temporário é restrito, único e aceito pelo validador', () => {
  const a = temporaryMrqFileName(1730000000000, 'abc123');
  const b = temporaryMrqFileName(1730000000001, 'abc123');
  assert.equal(a, 'mrq-sf-export-1730000000000-abc123.mrq');
  assert.notEqual(a, b);
  assert.equal(isTemporaryMrqFileName(a), true);
  assert.equal(isTemporaryMrqFileName('piano.mrq'), false);
  assert.equal(isTemporaryMrqFileName('mrq-sf-export-x/../../piano.mrq'), false);
});

check('salt com caracteres inválidos não cria nome perigoso', () => {
  const name = temporaryMrqFileName(1, '../../evil');
  assert.equal(isTemporaryMrqFileName(name), true);
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('..'), false);
});

console.log(`\n${passed} teste(s) passaram. Tudo certo.`);
