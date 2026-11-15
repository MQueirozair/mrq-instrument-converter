/**
 * Cadeia de efeitos dos Controles ao Vivo (v0.2.22, revista na v0.2.23) —
 * nós Web Audio nativos (sem worklets), seguindo os mesmos padrões da cadeia
 * por camada do RackEngine, dedicada a UM instrumento com os controles
 * globais da página:
 *
 *   entrada → EQ graves/médios/agudos → drive (seco/molhado) → chorus
 *   (seco/molhado) → delay (seco/molhado, com realimentação filtrada)
 *   → largura estéreo (Haas, mono-safe) → ferramentas (LiveToolsChain)
 *   → volume master → pan master → limiter (teto) → saída
 *   (envios paralelos: saída do delay → pré-delay → convolver → cor →
 *   retorno; e shimmer oitava acima → mesmo reverb)
 *
 * Correção v0.2.23: a largura estéreo anterior (dual-mono + mid/side) deixava
 * o canal direito mudo — agora é um alargador Haas (delay curto no canal
 * direito misturado com o direto), que nunca silencia nenhum lado e é
 * seguro pra fonte mono.
 *
 * Todos os parâmetros são ajustáveis ao vivo (setTargetAtTime) — dá pra
 * mexer nos knobs enquanto toca e ouvir na hora.
 */
import { createConstantSourceCompat } from '../audioContextCompat';
import {
  chorusDepthSec,
  dbToGain,
  delayFeedbackGain,
  driveParams,
  ecoVivoFeedback,
  reverbColorDb,
  reverbDurationSec,
  reverbWetGain,
  type LiveParams,
} from './liveControls';
import { LiveToolsChain } from './liveToolsChain';

const SMOOTH = 0.015; // constante de tempo dos setTargetAtTime (sem cliques)
const HAAS_SEC = 0.009; // atraso do alargador Haas (mesmo do Shimmer do RackEngine)

function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + amount * 1.5;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

function makeTriangleCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    curve[i] = 1 - Math.abs(x * 2 - 1);
  }
  return curve;
}

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

/** Pitch shifter granular por modulação de delay (padrão do Shimmer do RackEngine). */
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
    setShift(12);
    return {
      input: inputSum as AudioNode,
      output: sum as AudioNode,
      setShift,
      stop: () => {
        for (const n of [lfoA, lfoB, offsetA, offsetB]) {
          try {
            n.stop();
          } catch {
            /* já parado */
          }
        }
      },
    };
  } catch {
    const passthrough = ctx.createGain();
    return { input: passthrough as AudioNode, output: passthrough as AudioNode, setShift: (_s: number) => {}, stop: () => {} };
  }
}

export class LiveFxChain {
  /** Entrada da cadeia (o gate do envelope conecta aqui). */
  readonly input: GainNode;
  /** Saída final (a página conecta no destination). */
  readonly output: GainNode;

  private ctx: AudioContext;
  private eqLow: BiquadFilterNode;
  private eqMid: BiquadFilterNode;
  private eqHigh: BiquadFilterNode;
  private driveShaper: WaveShaperNode;
  private driveWet: GainNode;
  private driveDry: GainNode;
  private chorusDelay: DelayNode;
  private chorusLfo: OscillatorNode;
  private chorusLfoGain: GainNode;
  private chorusWet: GainNode;
  private chorusDry: GainNode;
  private delayNode: DelayNode;
  private delayFeedback: GainNode;
  private delayWet: GainNode;
  private delayDry: GainNode;
  private delayOut: GainNode;
  private widthDelay: DelayNode;
  private widthRightWet: GainNode;
  private widthRightDry: GainNode;
  private tools: LiveToolsChain;
  private masterGain: GainNode;
  private masterPan: StereoPannerNode;
  private limiter: DynamicsCompressorNode;
  private reverbPredelay: DelayNode;
  private convolver: ConvolverNode;
  private reverbColor: BiquadFilterNode;
  private reverbWet: GainNode;
  private shimmerPair: ReturnType<typeof createGranularPitchShiftPair>;
  private shimmerWet: GainNode;
  private irTimer: ReturnType<typeof setTimeout> | null = null;
  private lastIrSize = -1;
  private lastIrDamp = -1;
  private lastDriveAmount = -1;
  private lastParams: LiveParams;
  private noteDensity = 0;
  private disposed = false;

  constructor(ctx: AudioContext, initial: LiveParams) {
    this.ctx = ctx;
    this.lastParams = initial;

    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // --- EQ 3 bandas ---
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 200;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.9;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;

    // --- Drive (seco/molhado) ---
    const drivePre = ctx.createGain();
    this.driveShaper = ctx.createWaveShaper();
    this.driveShaper.oversample = '2x';
    this.driveWet = ctx.createGain();
    this.driveDry = ctx.createGain();

    // --- Chorus (delay modulado por LFO) ---
    this.chorusDelay = ctx.createDelay(0.05);
    this.chorusDelay.delayTime.value = 0.015;
    this.chorusLfo = ctx.createOscillator();
    this.chorusLfo.type = 'sine';
    this.chorusLfoGain = ctx.createGain();
    this.chorusLfo.connect(this.chorusLfoGain);
    this.chorusLfoGain.connect(this.chorusDelay.delayTime);
    this.chorusLfo.start();
    this.chorusWet = ctx.createGain();
    this.chorusDry = ctx.createGain();

    // --- Delay (com realimentação filtrada, "analógico") ---
    this.delayNode = ctx.createDelay(2.0);
    const delayFilter = ctx.createBiquadFilter();
    delayFilter.type = 'lowpass';
    delayFilter.frequency.value = 4000;
    this.delayFeedback = ctx.createGain();
    this.delayWet = ctx.createGain();
    this.delayDry = ctx.createGain();
    this.delayOut = ctx.createGain();
    this.delayNode.connect(delayFilter);
    delayFilter.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);
    this.delayWet.connect(this.delayOut);
    this.delayDry.connect(this.delayOut);

    // --- Largura estéreo (Haas, mono-safe) ---
    // Canal esquerdo direto; canal direito = direto misturado com uma cópia
    // atrasada 9ms (decorrelação). STEREO 0% = estéreo normal, 100% = largo.
    // Nunca silencia nenhum lado — nem com fonte mono.
    const widthSplitter = ctx.createChannelSplitter(2);
    const widthMerger = ctx.createChannelMerger(2);
    this.widthDelay = ctx.createDelay(0.03);
    this.widthDelay.delayTime.value = HAAS_SEC;
    this.widthRightWet = ctx.createGain();
    this.widthRightDry = ctx.createGain();
    this.delayOut.connect(widthSplitter);
    widthSplitter.connect(widthMerger, 0, 0); // L direto
    widthSplitter.connect(this.widthDelay, 1); // R → atraso
    this.widthDelay.connect(this.widthRightWet);
    this.widthRightWet.connect(widthMerger, 0, 1);
    widthSplitter.connect(this.widthRightDry, 1); // R direto
    this.widthRightDry.connect(widthMerger, 0, 1);

    // --- Ferramentas raras (gate, phaser, flanger, ..., compressor) ---
    this.tools = new LiveToolsChain(ctx, initial);
    widthMerger.connect(this.tools.input);

    // --- Master (volume + pan) + limiter de teto (segurança anti-clipping) ---
    this.masterGain = ctx.createGain();
    this.masterPan = ctx.createStereoPanner();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.0;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;
    this.tools.output.connect(this.masterGain);
    this.masterGain.connect(this.masterPan);
    this.masterPan.connect(this.limiter);
    this.limiter.connect(this.output);

    // --- Reverb (envio paralelo a partir da saída do delay) ---
    const reverbSend = ctx.createGain();
    this.reverbPredelay = ctx.createDelay(0.5);
    this.convolver = ctx.createConvolver();
    this.reverbColor = ctx.createBiquadFilter();
    this.reverbColor.type = 'highshelf';
    this.reverbColor.frequency.value = 4000;
    this.reverbWet = ctx.createGain();
    this.delayOut.connect(reverbSend);
    reverbSend.connect(this.reverbPredelay);
    this.reverbPredelay.connect(this.convolver);
    this.convolver.connect(this.reverbColor);
    this.reverbColor.connect(this.reverbWet);
    this.reverbWet.connect(this.masterGain);

    // --- Shimmer (oitava acima, pitch granular, no mesmo reverb) ---
    this.shimmerPair = createGranularPitchShiftPair(ctx, 0.06, 0.01);
    this.shimmerWet = ctx.createGain();
    widthMerger.connect(this.shimmerPair.input);
    this.shimmerPair.output.connect(this.shimmerWet);
    this.shimmerWet.connect(reverbSend);

    // --- Liga a cadeia principal ---
    this.input.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(drivePre);
    drivePre.connect(this.driveDry);
    drivePre.connect(this.driveShaper);
    this.driveShaper.connect(this.driveWet);
    this.driveDry.connect(this.chorusDry);
    this.driveWet.connect(this.chorusDry);
    this.chorusDry.connect(this.delayDry);
    this.chorusDry.connect(this.delayNode);
    this.chorusDelay.connect(this.chorusWet);
    this.chorusWet.connect(this.delayDry);
    this.chorusWet.connect(this.delayNode);

    this.setParams(initial);
  }

  /** Aplica todos os parâmetros (chamado a cada mudança de knob). */
  setParams(p: LiveParams) {
    if (this.disposed) return;
    this.lastParams = p;
    const now = this.ctx.currentTime;
    const t = (param: AudioParam, value: number) => param.setTargetAtTime(value, now, SMOOTH);

    // EQ
    t(this.eqLow.gain, p.eqLowDb);
    t(this.eqMid.gain, p.eqMidDb);
    t(this.eqHigh.gain, p.eqHighDb);

    // Drive (curva só é recalculada quando a intensidade muda de verdade)
    const drive = driveParams(p.driveDb);
    if (Math.abs(drive.amount - this.lastDriveAmount) > 0.05) {
      this.lastDriveAmount = drive.amount;
      safeCurve(this.driveShaper, makeDriveCurve(drive.amount));
    }
    t(this.driveWet.gain, drive.wet);
    t(this.driveDry.gain, drive.dry);

    // Chorus
    t(this.chorusWet.gain, p.chorus / 100);
    t(this.chorusDry.gain, 1);
    this.chorusLfo.frequency.setTargetAtTime(p.chorusRateHz, now, SMOOTH);
    t(this.chorusLfoGain.gain, chorusDepthSec(p.chorusDepth));

    // Delay (feedback efetivo leva em conta o Eco Vivo + densidade de notas)
    t(this.delayNode.delayTime, Math.max(0.001, p.delayTimeMs / 1000));
    t(this.delayFeedback.gain, delayFeedbackGain(ecoVivoFeedback(p.delayFeedback, p.ecoVivo, this.noteDensity)));
    t(this.delayWet.gain, p.delay / 100);
    t(this.delayDry.gain, 1);

    // Largura Haas: mistura do canal direito atrasado (0% = normal, 100% = largo)
    const k = Math.min(100, Math.max(0, p.stereo)) / 100;
    t(this.widthRightWet.gain, k);
    t(this.widthRightDry.gain, 1 - k);

    // Ferramentas raras
    this.tools.setParams(p);

    // Reverb
    t(this.reverbPredelay.delayTime, p.reverbPredelayMs / 1000);
    t(this.reverbColor.gain, reverbColorDb(p.reverbColor));
    t(this.reverbWet.gain, reverbWetGain(p.reverb));
    this.scheduleImpulse(p.reverbSize, p.reverbDamp);

    // Shimmer (oitava acima no reverb)
    t(this.shimmerWet.gain, p.shimmerMix / 100);

    // Master
    t(this.masterGain.gain, dbToGain(p.volumeDb));
    t(this.masterPan.pan, p.pan);
  }

  /**
   * NOVIDADE 2 — ECO VIVO: densidade de notas tocadas (0..1), alimentada pelo
   * engine. Recalcula só o feedback do delay (o eco se fecha tocando denso).
   */
  setNoteDensity(density: number) {
    if (this.disposed) return;
    this.noteDensity = Math.min(1, Math.max(0, density));
    const p = this.lastParams;
    this.delayFeedback.gain.setTargetAtTime(
      delayFeedbackGain(ecoVivoFeedback(p.delayFeedback, p.ecoVivo, this.noteDensity)),
      this.ctx.currentTime,
      SMOOTH
    );
  }

  /** Regenera a resposta do reverb quando TAMANHO/DAMP mudam (com debounce). */
  private scheduleImpulse(sizePct: number, dampPct: number) {
    if (Math.abs(sizePct - this.lastIrSize) < 0.5 && Math.abs(dampPct - this.lastIrDamp) < 0.5) return;
    this.lastIrSize = sizePct;
    this.lastIrDamp = dampPct;
    if (this.irTimer !== null) clearTimeout(this.irTimer);
    this.irTimer = setTimeout(() => {
      this.irTimer = null;
      if (this.disposed) return;
      this.convolver.buffer = this.generateImpulse(reverbDurationSec(sizePct), dampPct);
    }, 180);
  }

  /**
   * Resposta impulsiva estéreo: ruído com decaimento suave + amortecimento
   * (one-pole lowpass progressivo) controlado pelo DAMP %, com leve
   * decorrelação entre os canais (decaimentos diferentes).
   */
  private generateImpulse(durationSec: number, dampPct: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * durationSec));
    const buffer = this.ctx.createBuffer(2, length, rate);
    const a = (Math.min(100, Math.max(0, dampPct)) / 100) * 0.92;
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      const decayPow = ch === 0 ? 2.0 : 2.3;
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const decay = Math.pow(1 - t, decayPow);
        const noise = Math.random() * 2 - 1;
        lp = lp * a + noise * (1 - a);
        data[i] = lp * decay * 0.9;
      }
    }
    return buffer;
  }

  dispose() {
    this.disposed = true;
    if (this.irTimer !== null) {
      clearTimeout(this.irTimer);
      this.irTimer = null;
    }
    try {
      this.chorusLfo.stop();
    } catch {
      /* já parado */
    }
    this.shimmerPair.stop();
    this.tools.dispose();
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
