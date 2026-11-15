/**
 * Ferramentas raras dos Controles ao Vivo (v0.2.23) — 13 efeitos de inserção
 * com nós Web Audio nativos (sem worklets), pesquisados no que há de mais
 * moderno em FX pra instrumento ao vivo (openDAW, smplr, bibliotecas de
 * efeitos Web Audio) e adaptados do que o próprio RackEngine já prova em
 * produção (phaser em cascata de allpass, pitch shifter granular):
 *
 *   gate → phaser → flanger → tremolo → bitcrusher → exciter → ring mod
 *   → vibrato → tape (wow/flutter) → auto-pan → compressor → saída
 *   (+ oitavador em paralelo: pitch −12 oitava abaixo)
 *
 * Cada ferramenta é independente (mix/depth próprios) e ajustável ao vivo.
 * O shimmer (oitava acima no reverb) fica na LiveFxChain, que detém o
 * reverb; o arpejador e a curva de velocity ficam no LiveInstrumentEngine.
 */
import { createConstantSourceCompat } from '../audioContextCompat';
import {
  bitcrusherSteps,
  compressorParams,
  crushLowpassHz,
  dbToGain,
  type LiveParams,
} from './liveControls';

const SMOOTH = 0.015;

function safeCurve(node: WaveShaperNode, curve: Float32Array<ArrayBuffer>) {
  try {
    node.curve = curve;
  } catch {
    try {
      node.curve = null;
    } catch {
      /* sem curva — o efeito fica neutro */
    }
  }
}

/** Curva de quantização do bitcrusher (passos = 2^bits). */
function makeCrushCurve(bits: number): Float32Array<ArrayBuffer> {
  const steps = bitcrusherSteps(bits);
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

/** Curva de saturação do exciter (tanh normalizada). */
function makeExciterCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + amount * 2;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Envelope triangular pro cross-fade dos grãos do pitch shifter. */
function makeTriangleCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    curve[i] = 1 - Math.abs(x * 2 - 1);
  }
  return curve;
}

/**
 * Pitch shifter granular por modulação de delay (dois grãos defasados 180°,
 * técnica clássica sem AudioWorklet — mesmo padrão do Shimmer do RackEngine).
 */
function createGranularPitchShiftPair(ctx: AudioContext, grainSec: number, phaseOffsetSec: number) {
  try {
    const inputSum = ctx.createGain();
    const delayA = ctx.createDelay(0.2);
    const delayB = ctx.createDelay(0.2);
    inputSum.connect(delayA);
    inputSum.connect(delayB);
    const lfoA = ctx.createOscillator();
    lfoA.type = 'sawtooth';
    lfoA.frequency.value = 1 / grainSec;
    const lfoB = ctx.createOscillator();
    lfoB.type = 'sawtooth';
    lfoB.frequency.value = 1 / grainSec;
    const scaleA = ctx.createGain();
    const scaleB = ctx.createGain();
    const offsetA = createConstantSourceCompat(ctx);
    offsetA.offset.value = grainSec / 2;
    const offsetB = createConstantSourceCompat(ctx);
    offsetB.offset.value = grainSec / 2;
    lfoA.connect(scaleA);
    scaleA.connect(delayA.delayTime);
    offsetA.connect(delayA.delayTime);
    lfoB.connect(scaleB);
    scaleB.connect(delayB.delayTime);
    offsetB.connect(delayB.delayTime);
    const envShaperA = ctx.createWaveShaper();
    safeCurve(envShaperA, makeTriangleCurve());
    const envShaperB = ctx.createWaveShaper();
    safeCurve(envShaperB, makeTriangleCurve());
    const envA = ctx.createGain();
    const envB = ctx.createGain();
    lfoA.connect(envShaperA);
    envShaperA.connect(envA.gain);
    lfoB.connect(envShaperB);
    envShaperB.connect(envB.gain);
    lfoA.start(ctx.currentTime + phaseOffsetSec);
    lfoB.start(ctx.currentTime + grainSec / 2 + phaseOffsetSec);
    offsetA.start();
    offsetB.start();
    const sum = ctx.createGain();
    delayA.connect(envA);
    delayB.connect(envB);
    envA.connect(sum);
    envB.connect(sum);
    function setShift(semitones: number) {
      const ratio = Math.pow(2, semitones / 12);
      const scale = ((1 - ratio) * grainSec) / 2;
      scaleA.gain.value = scale;
      scaleB.gain.value = scale;
    }
    setShift(-12);
    return { input: inputSum as AudioNode, output: sum as AudioNode, setShift, stop: () => {
      try { lfoA.stop(); } catch { /* já parado */ }
      try { lfoB.stop(); } catch { /* já parado */ }
      try { offsetA.stop(); } catch { /* já parado */ }
      try { offsetB.stop(); } catch { /* já parado */ }
    } };
  } catch {
    const passthrough = ctx.createGain();
    return { input: passthrough as AudioNode, output: passthrough as AudioNode, setShift: (_s: number) => {}, stop: () => {} };
  }
}

export class LiveToolsChain {
  readonly input: GainNode;
  readonly output: GainNode;

  private ctx: AudioContext;
  private oscillators: OscillatorNode[] = [];
  private gateGain: GainNode;
  private gateAnalyser: AnalyserNode;
  private gateTimer: ReturnType<typeof setInterval> | null = null;
  private gateOpen = true;
  private gateThresholdDb = -80;
  private phaserStages: BiquadFilterNode[] = [];
  private phaserLfo: OscillatorNode;
  private phaserLfoGain: GainNode;
  private phaserWet: GainNode;
  private phaserDry: GainNode;
  private flangerDelay: DelayNode;
  private flangerLfo: OscillatorNode;
  private flangerLfoGain: GainNode;
  private flangerFb: GainNode;
  private flangerWet: GainNode;
  private flangerDry: GainNode;
  private tremoloGain: GainNode;
  private tremoloLfo: OscillatorNode;
  private tremoloLfoGain: GainNode;
  private crushShaper: WaveShaperNode;
  private crushFilter: BiquadFilterNode;
  private crushWet: GainNode;
  private crushDry: GainNode;
  private lastCrushBits = -1;
  private exciterShaper: WaveShaperNode;
  private exciterWet: GainNode;
  private exciterDry: GainNode;
  private lastExciter = -1;
  private ringGain: GainNode;
  private ringOsc: OscillatorNode;
  private ringWet: GainNode;
  private ringDry: GainNode;
  private vibratoDelay: DelayNode;
  private vibratoLfo: OscillatorNode;
  private vibratoLfoGain: GainNode;
  private tapeDelay: DelayNode;
  private tapeLfoA: OscillatorNode;
  private tapeLfoB: OscillatorNode;
  private tapeGainA: GainNode;
  private tapeGainB: GainNode;
  private autopan: StereoPannerNode;
  private autopanLfo: OscillatorNode;
  private autopanLfoGain: GainNode;
  private compNode: DynamicsCompressorNode;
  private compMakeup: GainNode;
  private octPair: ReturnType<typeof createGranularPitchShiftPair>;
  private octWet: GainNode;
  private disposed = false;

  constructor(ctx: AudioContext, initial: LiveParams) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const track = (osc: OscillatorNode) => {
      this.oscillators.push(osc);
      return osc;
    };

    // --- Gate (limpa o silêncio antes das modulações) ---
    this.gateAnalyser = ctx.createAnalyser();
    this.gateAnalyser.fftSize = 512;
    this.gateGain = ctx.createGain();
    this.input.connect(this.gateAnalyser);
    this.input.connect(this.gateGain);
    this.gateTimer = setInterval(() => this.updateGate(), 30);

    // --- Phaser (4 allpass em cascata, LFO nas frequências) ---
    this.phaserWet = ctx.createGain();
    this.phaserDry = ctx.createGain();
    let phaserTail: AudioNode = this.gateGain;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = 600;
      ap.Q.value = 0.7;
      phaserTail.connect(ap);
      phaserTail = ap;
      this.phaserStages.push(ap);
    }
    phaserTail.connect(this.phaserWet);
    this.gateGain.connect(this.phaserDry);
    this.phaserLfo = track(ctx.createOscillator());
    this.phaserLfo.type = 'sine';
    this.phaserLfoGain = ctx.createGain();
    this.phaserLfo.connect(this.phaserLfoGain);
    for (const ap of this.phaserStages) this.phaserLfoGain.connect(ap.frequency);
    this.phaserLfo.start();

    // --- Flanger (delay curto modulado + realimentação; seco/molhado) ---
    this.flangerDelay = ctx.createDelay(0.02);
    this.flangerDelay.delayTime.value = 0.003;
    this.flangerLfo = track(ctx.createOscillator());
    this.flangerLfo.type = 'sine';
    this.flangerLfoGain = ctx.createGain();
    this.flangerLfo.connect(this.flangerLfoGain);
    this.flangerLfoGain.connect(this.flangerDelay.delayTime);
    this.flangerLfo.start();
    this.flangerFb = ctx.createGain();
    this.flangerDelay.connect(this.flangerFb);
    this.flangerFb.connect(this.flangerDelay);
    this.flangerWet = ctx.createGain();
    this.flangerDry = ctx.createGain();
    // entrada do flanger → caminho seco (direto) e caminho molhado (delay)
    this.phaserWet.connect(this.flangerDry);
    this.phaserDry.connect(this.flangerDry);
    this.phaserWet.connect(this.flangerDelay);
    this.phaserDry.connect(this.flangerDelay);
    this.flangerDelay.connect(this.flangerWet);

    // --- Tremolo (LFO de amplitude) ---
    this.tremoloGain = ctx.createGain();
    this.tremoloLfo = track(ctx.createOscillator());
    this.tremoloLfo.type = 'sine';
    this.tremoloLfoGain = ctx.createGain();
    this.tremoloLfo.connect(this.tremoloLfoGain);
    this.tremoloLfoGain.connect(this.tremoloGain.gain);
    this.tremoloLfo.start();
    // seco + molhado do flanger se somam na entrada do tremolo
    this.flangerDry.connect(this.tremoloGain);
    this.flangerWet.connect(this.tremoloGain);

    // --- Bitcrusher (quantização + lowpass) ---
    this.crushShaper = ctx.createWaveShaper();
    this.crushShaper.oversample = 'none';
    this.crushFilter = ctx.createBiquadFilter();
    this.crushFilter.type = 'lowpass';
    this.crushWet = ctx.createGain();
    this.crushDry = ctx.createGain();
    this.tremoloGain.connect(this.crushDry);
    this.tremoloGain.connect(this.crushShaper);
    this.crushShaper.connect(this.crushFilter);
    this.crushFilter.connect(this.crushWet);

    // --- Exciter (agudos saturados em paralelo) ---
    const exciterHp = ctx.createBiquadFilter();
    exciterHp.type = 'highpass';
    exciterHp.frequency.value = 4000;
    this.exciterShaper = ctx.createWaveShaper();
    this.exciterShaper.oversample = '2x';
    this.exciterWet = ctx.createGain();
    this.exciterDry = ctx.createGain();
    this.crushWet.connect(this.exciterDry);
    this.crushDry.connect(this.exciterDry);
    this.exciterDry.connect(exciterHp);
    exciterHp.connect(this.exciterShaper);
    this.exciterShaper.connect(this.exciterWet);

    // --- Ring modulator (portadora × sinal) ---
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0;
    this.ringOsc = track(ctx.createOscillator());
    this.ringOsc.type = 'sine';
    this.ringOsc.connect(this.ringGain.gain);
    this.ringOsc.start();
    this.ringWet = ctx.createGain();
    this.ringDry = ctx.createGain();
    // entrada do ring mod → caminho seco (direto) e caminho molhado (portadora)
    this.exciterWet.connect(this.ringDry);
    this.exciterDry.connect(this.ringDry);
    this.ringDry.connect(this.ringGain);
    this.ringGain.connect(this.ringWet);

    // --- Vibrato (delay modulado — pitch wobble pós-mix) ---
    this.vibratoDelay = ctx.createDelay(0.05);
    this.vibratoDelay.delayTime.value = 0.008;
    this.vibratoLfo = track(ctx.createOscillator());
    this.vibratoLfo.type = 'sine';
    this.vibratoLfoGain = ctx.createGain();
    this.vibratoLfo.connect(this.vibratoLfoGain);
    this.vibratoLfoGain.connect(this.vibratoDelay.delayTime);
    this.vibratoLfo.start();
    // seco + molhado do ring mod se somam na entrada do vibrato
    this.ringDry.connect(this.vibratoDelay);
    this.ringWet.connect(this.vibratoDelay);

    // --- Tape (wow/flutter pseudo-aleatório: 2 LFOs desafinados) ---
    this.tapeDelay = ctx.createDelay(0.05);
    this.tapeDelay.delayTime.value = 0.015;
    this.tapeLfoA = track(ctx.createOscillator());
    this.tapeLfoA.type = 'sine';
    this.tapeLfoA.frequency.value = 0.13;
    this.tapeLfoB = track(ctx.createOscillator());
    this.tapeLfoB.type = 'sine';
    this.tapeLfoB.frequency.value = 0.071;
    this.tapeGainA = ctx.createGain();
    this.tapeGainB = ctx.createGain();
    this.tapeLfoA.connect(this.tapeGainA);
    this.tapeGainA.connect(this.tapeDelay.delayTime);
    this.tapeLfoB.connect(this.tapeGainB);
    this.tapeGainB.connect(this.tapeDelay.delayTime);
    this.tapeLfoA.start();
    this.tapeLfoB.start();
    this.vibratoDelay.connect(this.tapeDelay);

    // --- Auto-pan (LFO estéreo) ---
    this.autopan = ctx.createStereoPanner();
    this.autopanLfo = track(ctx.createOscillator());
    this.autopanLfo.type = 'sine';
    this.autopanLfoGain = ctx.createGain();
    this.autopanLfo.connect(this.autopanLfoGain);
    this.autopanLfoGain.connect(this.autopan.pan);
    this.autopanLfo.start();
    this.tapeDelay.connect(this.autopan);

    // --- Compressor (cola master) ---
    this.compNode = ctx.createDynamicsCompressor();
    this.compMakeup = ctx.createGain();
    this.autopan.connect(this.compNode);
    this.compNode.connect(this.compMakeup);
    this.compMakeup.connect(this.output);

    // --- Oitavador em paralelo (oitava abaixo, pitch granular) ---
    this.octPair = createGranularPitchShiftPair(ctx, 0.05, 0.02);
    this.octWet = ctx.createGain();
    this.input.connect(this.octPair.input);
    this.octPair.output.connect(this.octWet);
    this.octWet.connect(this.output);

    this.setParams(initial);
  }

  private updateGate() {
    if (this.disposed) return;
    const data = new Float32Array(this.gateAnalyser.fftSize);
    this.gateAnalyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const threshold = dbToGain(this.gateThresholdDb);
    const now = this.ctx.currentTime;
    if (rms > threshold * 1.25) {
      if (!this.gateOpen) {
        this.gateOpen = true;
        this.gateGain.gain.setTargetAtTime(1, now, 0.004);
      }
    } else if (rms < threshold * 0.75) {
      if (this.gateOpen) {
        this.gateOpen = false;
        this.gateGain.gain.setTargetAtTime(0, now, 0.008);
      }
    }
  }

  setParams(p: LiveParams) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const t = (param: AudioParam, value: number) => param.setTargetAtTime(value, now, SMOOTH);

    // Gate
    this.gateThresholdDb = p.gateThreshold;

    // Phaser
    this.phaserLfo.frequency.setTargetAtTime(p.phaserRate, now, SMOOTH);
    t(this.phaserLfoGain.gain, (p.phaserDepth / 100) * 800);
    t(this.phaserWet.gain, p.phaserMix / 100);
    t(this.phaserDry.gain, 1);

    // Flanger
    this.flangerLfo.frequency.setTargetAtTime(p.flangerRate, now, SMOOTH);
    t(this.flangerLfoGain.gain, (p.flangerDepth / 100) * 0.004);
    t(this.flangerFb.gain, p.flangerFeedback / 100);
    t(this.flangerWet.gain, p.flangerMix / 100);
    t(this.flangerDry.gain, 1);

    // Tremolo
    this.tremoloLfo.frequency.setTargetAtTime(p.tremoloRate, now, SMOOTH);
    const tremDepth = p.tremoloDepth / 100;
    t(this.tremoloGain.gain, 1 - tremDepth / 2);
    t(this.tremoloLfoGain.gain, tremDepth / 2);

    // Bitcrusher
    if (Math.abs(p.crushBits - this.lastCrushBits) > 0.1) {
      this.lastCrushBits = p.crushBits;
      safeCurve(this.crushShaper, makeCrushCurve(p.crushBits));
    }
    t(this.crushFilter.frequency, crushLowpassHz(p.crushRate));
    t(this.crushWet.gain, p.crushMix / 100);
    t(this.crushDry.gain, 1);

    // Exciter
    if (Math.abs(p.exciter - this.lastExciter) > 0.5) {
      this.lastExciter = p.exciter;
      safeCurve(this.exciterShaper, makeExciterCurve(p.exciter / 100));
    }
    t(this.exciterWet.gain, p.exciter / 100);
    t(this.exciterDry.gain, 1);

    // Ring mod
    this.ringOsc.frequency.setTargetAtTime(p.ringFreq, now, SMOOTH);
    t(this.ringWet.gain, p.ringMix / 100);
    t(this.ringDry.gain, 1);

    // Vibrato
    this.vibratoLfo.frequency.setTargetAtTime(p.vibratoRate, now, SMOOTH);
    t(this.vibratoLfoGain.gain, (p.vibratoDepth / 100) * 0.004);

    // Tape (wow/flutter)
    const tapeDepth = (p.tape / 100) * 0.003;
    t(this.tapeGainA.gain, tapeDepth);
    t(this.tapeGainB.gain, tapeDepth * 0.7);

    // Auto-pan
    this.autopanLfo.frequency.setTargetAtTime(p.autopanRate, now, SMOOTH);
    t(this.autopanLfoGain.gain, p.autopanDepth / 100);

    // Compressor (cola)
    const comp = compressorParams(p.comp);
    this.compNode.threshold.setTargetAtTime(comp.thresholdDb, now, SMOOTH);
    this.compNode.ratio.setTargetAtTime(comp.ratio, now, SMOOTH);
    this.compNode.attack.setTargetAtTime(comp.attackSec, now, SMOOTH);
    this.compNode.release.setTargetAtTime(comp.releaseSec, now, SMOOTH);
    this.compNode.knee.setTargetAtTime(12, now, SMOOTH);
    t(this.compMakeup.gain, dbToGain(comp.makeupDb));

    // Oitavador
    t(this.octWet.gain, p.octaverMix / 100);
  }

  dispose() {
    this.disposed = true;
    if (this.gateTimer !== null) {
      clearInterval(this.gateTimer);
      this.gateTimer = null;
    }
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        /* já parado */
      }
    }
    this.octPair.stop();
    try {
      this.input.disconnect();
    } catch {
      /* já desconectado */
    }
    try {
      this.output.disconnect();
    } catch {
      /* já desconectado */
    }
  }
}
