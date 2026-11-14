#!/usr/bin/env node
/**
 * Teste de regressão do TRAVAMENTO da exportação SF2 em bibliotecas grandes
 * (v0.2.18) — o bug relatado como "fica só girando, não converte nada".
 *
 * Causa raiz: `buildMultiPresetSf2Binary` escrevia o PCM no chunk `smpl`
 * com um `ByteWriter.i16()` POR SAMPLE POINT (cada chamada alocava um
 * `Uint8Array(2)` e empurrava num array de partes). Medido antes da
 * correção: 1M de frames estéreo (2M sample points) levava 4,5s; 3M de
 * frames estourava a memória (processo morto). Um piano multisample real
 * tem dezenas de milhões de frames — a exportação nunca terminava.
 *
 * Este teste monta um SF2 com uma amostra GRANDE (5M frames estéreo =
 * 10M sample points, ~20MB de PCM) e exige que termine rápido (< 5s) e
 * com o conteúdo PCM correto no chunk `smpl`. Com o código antigo, este
 * teste demoraria dezenas de segundos ou seria morto por OOM.
 *
 * Rode com: node scripts/test-sf2-export-large.mjs
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
    `mrq-sf2-export-large-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', target: 'es2020', outfile });
  return import(`file://${outfile}`);
}

const { buildMultiPresetSf2Binary, float32ToInt16Interleaved } = await compileToNode('src/audio/rack/sf2Export.ts');

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

const SR = 44100;
const FRAMES = 5_000_000; // 5M frames estéreo = 10M sample points (~20 MB de PCM16 por canal)

check('float32ToInt16Interleaved: converte e limita em [-32767, 32767]', () => {
  const out = float32ToInt16Interleaved(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
  // Math.round(-16383.5) === -16383 (metade arredonda pra +∞) — valor esperado é esse mesmo.
  assert.deepEqual(Array.from(out), [0, 16384, -16383, 32767, -32767, 32767, -32767]);
});

// Amostra grande: seno 220Hz estéreo com canais diferentes (L=0.8, R=0.25),
// igual à receita dos outros testes SF2 — permite conferir o PCM no `smpl`.
const pcmFloat = new Float32Array(FRAMES * 2);
for (let i = 0; i < FRAMES; i += 1) {
  const s = Math.sin((2 * Math.PI * 220 * i) / SR);
  pcmFloat[i * 2] = s * 0.8;
  pcmFloat[i * 2 + 1] = s * 0.25;
}
const pcmInt16 = float32ToInt16Interleaved(pcmFloat);

const t0 = Date.now();
const sf2Bytes = buildMultiPresetSf2Binary(
  [
    {
      name: 'Piano Grande',
      zones: [
        {
          label: 'big', rootNote: 60, loKey: 0, hiKey: 127, loVel: 0, hiVel: 127,
          pcmInt16, sampleRateHz: SR, channels: 2,
        },
      ],
    },
  ],
  'Large Sample Test'
);
const elapsedMs = Date.now() - t0;
console.log(`   (5M frames estéreo montados em ${elapsedMs}ms, SF2 final com ${sf2Bytes.length} bytes)`);

check('amostra grande (5M frames estéreo) monta em menos de 5s — sem o travamento v0.2.18', () => {
  assert.ok(elapsedMs < 5000, `demorou ${elapsedMs}ms — o ByteWriter por-sample-point antigo levava dezenas de segundos/OOM aqui`);
});

check('RIFF/sfbk válido e tamanho declarado bate com o arquivo real', () => {
  assert.equal(String.fromCharCode(...sf2Bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...sf2Bytes.slice(8, 12)), 'sfbk');
  const declaredSize = new DataView(sf2Bytes.buffer, sf2Bytes.byteOffset).getUint32(4, true);
  assert.equal(declaredSize, sf2Bytes.length - 8);
});

/** Localiza o chunk `smpl` dentro do LIST `sdta` e devolve o offset dos dados PCM. */
function findSmplDataOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  // RIFF(12) + LIST INFO(...) + LIST sdta: procura "smpl" varrendo os chunks.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'LIST') {
      const listType = String.fromCharCode(...bytes.slice(offset + 8, offset + 12));
      if (listType === 'sdta') {
        let sub = offset + 12;
        while (sub + 8 <= offset + 8 + size) {
          const subId = String.fromCharCode(...bytes.slice(sub, sub + 4));
          const subSize = view.getUint32(sub + 4, true);
          if (subId === 'smpl') return sub + 8;
          sub += 8 + subSize + (subSize % 2);
        }
      }
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('chunk smpl não encontrado no SF2 gerado');
}

check('PCM no chunk smpl confere com a amostra de entrada (canal L e R, início e fim)', () => {
  const smplOffset = findSmplDataOffset(sf2Bytes);
  const view = new DataView(sf2Bytes.buffer, sf2Bytes.byteOffset);
  // Estéreo vira 2 amostras físicas: L primeiro, depois R (cada uma com
  // padding de 46 zeros). O canal L começa no offset do smpl.
  const expectedL0 = pcmInt16[0];
  const expectedL1000 = pcmInt16[1000 * 2];
  const expectedLEnd = pcmInt16[(FRAMES - 1) * 2];
  assert.equal(view.getInt16(smplOffset, true), expectedL0, 'primeiro sample do canal L');
  assert.equal(view.getInt16(smplOffset + 1000 * 2, true), expectedL1000, 'sample 1000 do canal L');
  assert.equal(view.getInt16(smplOffset + (FRAMES - 1) * 2, true), expectedLEnd, 'último sample do canal L');
  // Canal R começa logo após L + padding de 46 sample points.
  const rOffset = smplOffset + FRAMES * 2 + 46 * 2;
  assert.equal(view.getInt16(rOffset, true), pcmInt16[1], 'primeiro sample do canal R');
  assert.equal(view.getInt16(rOffset + (FRAMES - 1) * 2, true), pcmInt16[(FRAMES - 1) * 2 + 1], 'último sample do canal R');
});

console.log(`\n${passed} teste(s) passaram.`);
process.exit(process.exitCode ?? 0);
