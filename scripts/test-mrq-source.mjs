#!/usr/bin/env node
/**
 * Regressão da importação de `.mrq` e da escolha de formatos (v0.2.17).
 *
 * Cobre o bug da foto: um `.mrq` gerado pelo app era recusado com
 * "Extensão não reconhecida pelo conversor", e a exportação SF2 falhava
 * com "Ill-formed FLAC stream: invalid block size, must be at least 16".
 * A parte binária do FLAC é testada em Rust (writer.rs/reader.rs); aqui
 * ficam as regras puras de detecção, carregamento e habilitação da UI.
 *
 * Rode: node scripts/test-mrq-source.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function loadTs(entry) {
  const outfile = path.join(
    os.tmpdir(),
    `mrq-source-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
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

const source = await loadTs('src/audio/rack/mrqSource.ts');
const output = await loadTs('src/audio/rack/converterOutputFormat.ts');
const formats = await loadTs('src/audio/rack/converterFormats.ts');

const sampleEntry = {
  id: 'C4',
  relativeOffset: 0,
  length: 1234,
  sha256: 'a'.repeat(64),
  sampleRateHz: 48000,
  channels: 2,
  bitsPerSampleEncoded: 16,
  convertedFromFloat32: false,
  codec: 'flac',
};
const metadata = {
  formatVersion: 1,
  instrument: {
    name: 'Astoria Grand XL 6.1',
    sourceFormat: 'npno',
    importedAt: '2026-10-21T00:00:00Z',
    presets: [{
      id: 'p0',
      name: 'Astoria',
      groups: [{
        id: 'g0',
        name: 'Main',
        zones: [{
          sampleId: 'C4', rootNote: 60, loKey: 0, hiKey: 127, loVel: 0, hiVel: 127,
          tuneCents: 0, volumeDb: 0, pan: 0,
        }],
      }],
    }],
  },
  samples: [sampleEntry],
};

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✔ ${name}`); }
  catch (err) { console.error(`✖ ${name}`); console.error(err); process.exitCode = 1; }
}

check('detecta .mrq em caminhos Unix/Windows e com extensão maiúscula', () => {
  assert.equal(source.isMrqFilePath('/tmp/Astoria Grand XL 6.1.mrq'), true);
  assert.equal(source.isMrqFilePath('C:\\Instrumentos\\Astoria.MRQ'), true);
  assert.equal(source.isMrqFilePath('/tmp/Astoria.sf2'), false);
  assert.equal(source.isMrqFilePath('/tmp/Astoria'), false);
});

check('reconhece a assinatura MRQ1 nos primeiros quatro bytes', () => {
  assert.equal(source.looksLikeMrqHeader(new Uint8Array([77, 82, 81, 49, 0])), true);
  assert.equal(source.looksLikeMrqHeader(new Uint8Array([82, 73, 70, 70])), false);
  assert.equal(source.looksLikeMrqHeader(new Uint8Array([77, 82])), false);
});

check('dispatcher do conversor agora reconhece .mrq e valida a assinatura', () => {
  assert.equal(formats.detectFormatByExtension('/tmp/Astoria Grand XL 6.1.MRQ'), 'mrq');
  assert.equal(formats.FORMAT_LABELS.mrq, 'Instrumento MRQ nativo');
  assert.equal(formats.sniffMagicBytes(new Uint8Array([77, 82, 81, 49])), source.MRQ_MAGIC_LABEL);
  assert.equal(formats.magicBytesConflictWarning('mrq', source.MRQ_MAGIC_LABEL), null);
  assert.match(formats.magicBytesConflictWarning('mrq', 'RIFF/WAVE') ?? '', /extensão está correta/);
});

check('inspeção de .mrq devolve instrumento, metadados e relatório honesto', () => {
  const inspection = source.inspectMrqMetadata(metadata);
  assert.equal(inspection.instrument.name, 'Astoria Grand XL 6.1');
  assert.equal(inspection.nativeMetadata.samples.length, 1);
  assert.equal(inspection.compatibility.preserved.length, 3);
  assert.match(inspection.compatibility.preserved[0].detail, /FLAC/);
  assert.match(inspection.compatibility.unsupported[0].field, /envelope/);
});

check('metadados corrompidos são rejeitados com erro legível', () => {
  assert.throws(() => source.inspectMrqMetadata({ ...metadata, instrument: undefined }), /instrumento válido/);
  assert.throws(() => source.inspectMrqMetadata({ ...metadata, samples: undefined }), /índice de amostras/);
});

check('.mrq importado habilita os TRÊS formatos sem .mrq temporário', () => {
  const c = output.converterOutputChoices({
    status: 'inspected',
    sourceFormat: 'mrq',
    convertedPath: '/tmp/Astoria Grand XL 6.1.mrq',
    hasExportableZones: true,
  });
  assert.equal(c.mrq.enabled, true);
  assert.equal(c.sf2.enabled, true);
  assert.equal(c.sf3.enabled, true);
  assert.equal(c.sf2.requiresTemporaryMrq, false);
  assert.equal(c.sf3.requiresTemporaryMrq, false);
  assert.match(c.mrq.reason, /já é \.mrq/);
});

check('salvar/copiar .mrq usa extensão e filtro corretos', () => {
  const opts = output.outputFormatSaveDialogOptions('mrq', 'Astoria Grand XL 6.1.mrq');
  assert.equal(opts.defaultPath, 'Astoria Grand XL 6.1.mrq');
  assert.deepEqual(opts.filters[0].extensions, ['mrq']);
});

console.log(`\n${passed} teste(s) passaram. Tudo certo.`);
