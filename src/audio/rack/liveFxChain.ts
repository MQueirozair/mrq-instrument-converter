/**
 * Cadeia de efeitos dos Controles ao Vivo (v0.2.22) — nós Web Audio nativos
 * (sem worklets), seguindo os mesmos padrões da cadeia por camada do
 * RackEngine (EQ → drive → chorus → delay → reverb em envio), mas enxuta e
 * dedicada a UM instrumento com os controles globais da página:
 *
 *   entrada → EQ graves/médios/agudos → drive (seco/molhado) → chorus
 *   (seco/molhado) → delay (seco/molhado, com realimentação filtrada)
 *   → largura estéreo (mid/side, mono-safe) → volume master → pan master
 *   → saída
 *   (envio paralelo: saída do delay → pré-delay → convolver → cor → retorno)
 *
 * Todos os parâmetros são ajustáveis ao vivo (setTargetAtTime) — dá pra
 * mexer nos knobs enquanto toca e ouvir na hora, que é exatamente o uso
 * "ver como vai ficar o som final ao vivo".
 */
import {
  chorusDepthSec,
  dbToGain,
  delayFeedbackGain,
  driveParams,
  reverbColorDb,
  reverbDurationSec,
  reverbWetGain,
  stereoWidth,
  type LiveParams,
} from './liveControls';

const SMOOTH = 0.015; // constante de tempo dos setTargetAtTime (sem cliques)

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
  private widthGains: { l0: GainNode; r0: GainNode; l1: GainNode; r1: GainNode };
  private masterGain: GainNode;
  private masterPan: StereoPannerNode;
  private reverbPredelay: DelayNode;
  private convolver: ConvolverNode;
  private reverbColor: BiquadFilterNode;
  private reverbWet: GainNode;
  private irTimer: ReturnType<typeof setTimeout> | null = null;
  private lastIrSize = -1;
  private lastIrDamp = -1;
  private lastDriveAmount = -1;
  private disposed = false;

  constructor(ctx: AudioContext, initial: LiveParams) {
    this.ctx = ctx;

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

    // --- Largura estéreo (mid/side, mono-safe) ---
    // Primeiro dual-mono (a saída do delay vai pros dois canais) pra fonte
    // mono nunca sair panada; depois mid/side: 0% = mono, 50% = normal,
    // 100% = larga.
    const dualMono = ctx.createChannelMerger(2);
    const splitter = ctx.createChannelSplitter(2);
    dualMono.connect(splitter);
    const widthMerger = ctx.createChannelMerger(2);
    this.widthGains = {
      l0: ctx.createGain(),
      r0: ctx.createGain(),
      l1: ctx.createGain(),
      r1: ctx.createGain(),
    };
    splitter.connect(this.widthGains.l0, 0);
    this.widthGains.l0.connect(widthMerger, 0, 0);
    splitter.connect(this.widthGains.r0, 1);
    this.widthGains.r0.connect(widthMerger, 0, 0);
    splitter.connect(this.widthGains.l1, 0);
    this.widthGains.l1.connect(widthMerger, 0, 1);
    splitter.connect(this.widthGains.r1, 1);
    this.widthGains.r1.connect(widthMerger, 0, 1);

    // --- Master (volume + pan no fim: o que se ouve é o que se ajusta) ---
    this.masterGain = ctx.createGain();
    this.masterPan = ctx.createStereoPanner();
    widthMerger.connect(this.masterGain);
    this.masterGain.connect(this.masterPan);
    this.masterPan.connect(this.output);

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
    this.delayOut.connect(dualMono);

    this.setParams(initial);
  }

  /** Aplica todos os parâmetros (chamado a cada mudança de knob). */
  setParams(p: LiveParams) {
    if (this.disposed) return;
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
      this.driveShaper.curve = makeDriveCurve(drive.amount);
    }
    t(this.driveWet.gain, drive.wet);
    t(this.driveDry.gain, drive.dry);

    // Chorus
    t(this.chorusWet.gain, p.chorus / 100);
    t(this.chorusDry.gain, 1);
    this.chorusLfo.frequency.setTargetAtTime(p.chorusRateHz, now, SMOOTH);
    t(this.chorusLfoGain.gain, chorusDepthSec(p.chorusDepth));

    // Delay
    t(this.delayNode.delayTime, Math.max(0.001, p.delayTimeMs / 1000));
    t(this.delayFeedback.gain, delayFeedbackGain(p.delayFeedback));
    t(this.delayWet.gain, p.delay / 100);
    t(this.delayDry.gain, 1);

    // Reverb
    t(this.reverbPredelay.delayTime, p.reverbPredelayMs / 1000);
    t(this.reverbColor.gain, reverbColorDb(p.reverbColor));
    t(this.reverbWet.gain, reverbWetGain(p.reverb));
    this.scheduleImpulse(p.reverbSize, p.reverbDamp);

    // Largura estéreo (mid/side): outL = L(1+w)/2 + R(1-w)/2, outR = L(1-w)/2 + R(1+w)/2
    const w = stereoWidth(p.stereo);
    t(this.widthGains.l0.gain, (1 + w) / 2);
    t(this.widthGains.r0.gain, (1 - w) / 2);
    t(this.widthGains.l1.gain, (1 - w) / 2);
    t(this.widthGains.r1.gain, (1 + w) / 2);

    // Master
    t(this.masterGain.gain, dbToGain(p.volumeDb));
    t(this.masterPan.pan, p.pan);
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
   * Resposta impulsiva estéreo: ruído com decaimento + amortecimento
   * (one-pole lowpass progressivo) controlado pelo DAMP %.
   */
  private generateImpulse(durationSec: number, dampPct: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * durationSec));
    const buffer = this.ctx.createBuffer(2, length, rate);
    const a = (Math.min(100, Math.max(0, dampPct)) / 100) * 0.92;
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const decay = Math.pow(1 - t, 2.2);
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
