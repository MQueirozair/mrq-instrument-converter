#!/usr/bin/env node
// Integração Web Audio real via OfflineAudioContext. Requer Chromium do Playwright.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const built = await build({stdin: {contents: `export { LiveFxChain } from './src/audio/rack/liveFxChain'; export { defaultLiveParams, applyBypass, defaultLiveBypass } from './src/audio/rack/liveControls';`, resolveDir: process.cwd()}, bundle: true, format: 'iife', globalName: 'MrqTest', platform: 'browser', write: false});
const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Teste de áudio MRQ</title>');
  await page.addScriptTag({content: built.outputFiles[0].text});
  const result = await page.evaluate(async () => {
    const { LiveFxChain, defaultLiveParams, applyBypass, defaultLiveBypass } = window.MrqTest;
    async function render(p, frequency) {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const chain = new LiveFxChain(ctx, p); chain.output.connect(ctx.destination);
      const oscillator = ctx.createOscillator(), volume = ctx.createGain();
      oscillator.frequency.value = frequency; volume.gain.value = 0.025;
      oscillator.connect(volume); volume.connect(chain.input); oscillator.start(); oscillator.stop(0.8);
      const buffer = await ctx.startRendering(); chain.dispose();
      return [0, 1].map(ch => {
        const samples = buffer.getChannelData(ch); let sum = 0;
        for (let i = 24000; i < 36000; i++) sum += samples[i] ** 2;
        return Math.sqrt(sum / 12000);
      });
    }
    const defaults = defaultLiveParams(), data = {};
    for (const [key, freq] of [['limpaGraves', 50], ['clareza', 380], ['salaCurta', 800]]) {
      const value = { ...defaults, [key]: 100 };
      const bypass = { ...defaultLiveBypass(), [key]: true };
      data[key] = { base: await render(defaults, freq), on: await render(value, freq), off: await render(applyBypass(value, bypass), freq) };
    }
    data.presenca = {base: await render(defaults, 2400), on: await render({...defaults, clareza: 100}, 2400)};
    return data;
  });
  for (const key of ['limpaGraves', 'clareza', 'salaCurta']) {
    const {base, on, off} = result[key];
    for (let ch = 0; ch < 2; ch++) {
      assert.ok(on[ch] > 0 && Math.abs(on[ch] - base[ch]) > 0.00005, `${key} deve mudar ambos os canais`);
      assert.ok(Math.abs(off[ch] - base[ch]) < 1e-7, `${key} bypass deve voltar ao neutro`);
    }
    console.log(`ok - ${key}: áudio processado nos dois canais e bypass neutro`);
  }
  assert.ok(result.limpaGraves.on[0] < result.limpaGraves.base[0]);
  assert.ok(result.clareza.on[0] < result.clareza.base[0]);
  assert.ok(result.presenca.on[0] > result.presenca.base[0]);
  console.log('ok - atenuação de graves/médios e reforço de presença');
} finally { await browser.close(); }
