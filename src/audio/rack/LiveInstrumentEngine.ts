/**
 * Motor dos Controles ao Vivo (v0.2.22, estendido na v0.2.23) — toca UM
 * instrumento `.mrq` com os controles globais da página aplicados a TODAS
 * as amostras/zonas ("INSTRUMENTO INTEIRO"), pra pré-escutar o som final
 * como ele vai sair num rack de instrumentos ao vivo.
 *
 * Reaproveita o que já existe, sem duplicar:
 *  - `MrqLayerVoice`: carrega o `.mrq` (decodifica as amostras pelo backend
 *    Rust) e toca as zonas (round robin, pan estéreo, loops, pitch bend);
 *  - `LiveFxChain` (+ `LiveToolsChain`): EQ, drive, chorus, delay, reverb,
 *    largura estéreo, ferramentas raras e master com nós Web Audio nativos.
 *
 * O que este engine adiciona por cima:
 *  - gate de envelope global (ATAQUE/RELEASE/SUSTAIN) com contagem de notas
 *    seguradas — o release longo funciona de verdade porque o `noteOff` da
 *    voz é adiado até o gate terminar de fechar;
 *  - NOTA MIN/MAX e VELOCIDADE MIN/MAX como filtros de entrada;
 *  - TECLA RAIZ como transposição global em relação à raiz de referência do
 *    instrumento (a `rootNote` mais comum entre as zonas);
 *  - AFINACAO via pitch bend da voz (afeta notas já soando, sem reatacar);
 *  - arpejador (ARP TAXA/ALCANCE) a partir da nota mais grave segurada;
 *  - curva de velocity (VELOCIDADE CURVA) antes do disparo;
 *  - densidade de notas pro Eco Vivo (o delay se fecha tocando denso).
 */
import type { RackPresetOption } from '../../../shared/types';
import { MrqLayerVoice } from './MrqLayerVoice';
import { LiveFxChain } from './liveFxChain';
import {
  applyBypass,
  applyVelocityCurve,
  arpNoteOffsets,
  clampLiveParams,
  defaultLiveBypass,
  referenceRootFromZones,
  sustainLevel,
  type LiveBypass,
  type LiveParams,
} from './liveControls';
import { mrqReadMetadata } from './mrqFormat';

export interface LiveLoadResult {
  presets: RackPresetOption[];
  /** Tecla que toca o sample na afinação original (raiz mais comum). */
  referenceRoot: number;
  instrumentName: string;
}

interface HeldNote {
  transposed: number;
  velocity: number;
}

export class LiveInstrumentEngine {
  /** Saída final da cadeia (a página conecta no destination). */
  readonly output: GainNode;

  private ctx: AudioContext;
  private voice: MrqLayerVoice;
  private chain: LiveFxChain;
  private gate: GainNode;
  private params: LiveParams;
  /** Bypass dos efeitos (v0.2.24) — aplicado sobre `params` antes da cadeia. */
  private bypass: LiveBypass = defaultLiveBypass();
  /** nota original (a que a página mandou) → nota transposta + velocity. */
  private heldNotes = new Map<number, HeldNote>();
  private pendingRelease = new Map<number, ReturnType<typeof setTimeout>>();
  private referenceRoot = 60;
  private loaded = false;
  private disposed = false;
  // Arpejador
  private arpTimer: ReturnType<typeof setInterval> | null = null;
  private arpStep = 0;
  private arpNoteOffTimers = new Set<ReturnType<typeof setTimeout>>();
  // Densidade de notas (Eco Vivo)
  private noteOnTimes: number[] = [];
  private densityTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: AudioContext, initial: LiveParams) {
    this.ctx = ctx;
    this.params = clampLiveParams(initial);
    this.voice = new MrqLayerVoice(ctx);
    this.chain = new LiveFxChain(ctx, this.params);
    this.gate = ctx.createGain();
    this.voice.output.connect(this.gate);
    this.gate.connect(this.chain.input);
    this.output = this.chain.output;
    this.applyTune();
    // A densidade decai com o tempo mesmo sem notas novas (pro Eco Vivo).
    this.densityTimer = setInterval(() => this.refreshDensity(), 400);
  }

  async load(path: string): Promise<LiveLoadResult> {
    const metadata = await mrqReadMetadata(path);
    const zones = metadata.instrument.presets.flatMap((p) => p.groups.flatMap((g) => g.zones));
    this.referenceRoot = referenceRootFromZones(zones);
    const presets = await this.voice.load(new ArrayBuffer(0), path);
    this.loaded = true;
    return { presets, referenceRoot: this.referenceRoot, instrumentName: this.voice.name };
  }

  selectPreset(value: string) {
    this.voice.selectPreset(value);
  }

  setParams(params: LiveParams) {
    if (this.disposed) return;
    this.params = clampLiveParams(params);
    this.applyEffective();
    this.applyTune();
  }

  /** Define o bypass dos efeitos (v0.2.24) — reaplica a cadeia na hora. */
  setBypass(bypass: LiveBypass) {
    if (this.disposed) return;
    this.bypass = bypass;
    this.applyEffective();
  }

  /** Parâmetros efetivos (com o bypass aplicado) que a cadeia realmente usa. */
  private effectiveParams(): LiveParams {
    return applyBypass(this.params, this.bypass);
  }

  private applyEffective() {
    const eff = this.effectiveParams();
    this.chain.setParams(eff);
    // Se o arpejador foi desligado (ou está em bypass), para na hora.
    if (eff.arpRate <= 0) this.stopArp();
  }

  private applyTune() {
    // AFINACAO cents → pitch bend em semitons (afeta notas já soando).
    this.voice.setPitchBend(this.params.tuneCents / 100);
  }

  private transpose(note: number): number {
    // v0.2.25: OITAVA desloca em oitavas inteiras (12 semitons cada).
    return note + (Math.round(this.params.rootKey) - this.referenceRoot) + Math.round(this.params.octave) * 12;
  }

  noteOn(note: number, velocity: number) {
    if (!this.loaded || this.disposed) return;
    const vel = Math.round(velocity);
    if (vel < this.params.velMin || vel > this.params.velMax) return;
    const original = Math.round(note);
    const transposed = this.transpose(original);
    if (transposed < 0 || transposed > 127) return;
    // v0.2.25: MODO MONO — uma voz por vez (a nota nova mata as anteriores).
    if (Math.round(this.params.playMode) === 1 && this.heldNotes.size > 0) {
      this.allNotesOff();
    }
    // Curva de velocity (VELOCIDADE CURVA) antes do disparo.
    const shaped = applyVelocityCurve(vel, this.params.velCurve);
    // Re-toque durante o release desta mesma nota: cancela o noteOff
    // pendente pra ele não matar a voz nova.
    const pending = this.pendingRelease.get(transposed);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingRelease.delete(transposed);
    }
    if (this.heldNotes.size === 0) this.triggerAttack();
    this.heldNotes.set(original, { transposed, velocity: shaped });
    this.voice.noteOn(transposed, shaped);
    this.trackDensity();
    this.startArp();
  }

  noteOff(note: number) {
    if (this.disposed) return;
    const original = Math.round(note);
    const held = this.heldNotes.get(original);
    if (!held) return;
    this.heldNotes.delete(original);
    const transposed = held.transposed;
    if (this.heldNotes.size === 0) {
      this.triggerRelease();
      this.stopArp();
      // A voz continua soando durante o release do gate — sem isso, o
      // release longo (ex.: 554ms) seria cortado pelo release curto (~120ms)
      // da própria voz.
      const releaseMs = Math.max(0, this.params.releaseMs);
      const id = setTimeout(() => {
        this.pendingRelease.delete(transposed);
        this.voice.noteOff(transposed);
      }, releaseMs);
      this.pendingRelease.set(transposed, id);
    } else {
      this.voice.noteOff(transposed);
    }
    this.refreshDensity();
  }

  // --- Arpejador -----------------------------------------------------------

  private startArp() {
    // v0.2.24: usa a taxa efetiva (com bypass) — arpejador em bypass não toca.
    const stepMs = this.effectiveParams().arpRate;
    if (this.arpTimer !== null || stepMs <= 0) return;
    this.arpStep = 0;
    this.arpTimer = setInterval(() => {
      if (this.heldNotes.size === 0) {
        this.stopArp();
        return;
      }
      // Base = nota transposta mais grave segurada (com a velocity dela).
      let base = 127;
      let baseVel = 100;
      for (const held of this.heldNotes.values()) {
        if (held.transposed < base) {
          base = held.transposed;
          baseVel = held.velocity;
        }
      }
      const offsets = arpNoteOffsets(this.params.arpRange);
      const off = offsets[this.arpStep % offsets.length];
      this.arpStep += 1;
      const note = base + off;
      if (note < 0 || note > 127) return;
      this.voice.noteOn(note, baseVel);
      const id = setTimeout(() => {
        this.arpNoteOffTimers.delete(id);
        this.voice.noteOff(note);
      }, stepMs * 0.85);
      this.arpNoteOffTimers.add(id);
    }, stepMs);
  }

  private stopArp() {
    if (this.arpTimer !== null) {
      clearInterval(this.arpTimer);
      this.arpTimer = null;
    }
    for (const id of this.arpNoteOffTimers) clearTimeout(id);
    this.arpNoteOffTimers.clear();
  }

  // --- Densidade de notas (Eco Vivo) ---------------------------------------

  private trackDensity() {
    const now = performance.now();
    this.noteOnTimes.push(now);
    this.refreshDensity();
  }

  private refreshDensity() {
    if (this.disposed) return;
    const cutoff = performance.now() - 2000;
    while (this.noteOnTimes.length > 0 && this.noteOnTimes[0] < cutoff) this.noteOnTimes.shift();
    // 8 ataques em 2s = densidade máxima.
    const density = Math.min(1, this.noteOnTimes.length / 8);
    this.chain.setNoteDensity(density);
  }

  // --- Envelope (gate global) ----------------------------------------------

  private triggerAttack() {
    const now = this.ctx.currentTime;
    const attackSec = Math.max(0.001, this.params.attackMs / 1000);
    const sustain = sustainLevel(this.params.sustain);
    const g = this.gate.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + attackSec);
    if (sustain < 0.999) {
      g.linearRampToValueAtTime(sustain, now + attackSec + 0.25);
    }
  }

  private triggerRelease() {
    const now = this.ctx.currentTime;
    const releaseSec = Math.max(0.001, this.params.releaseMs / 1000);
    const g = this.gate.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + releaseSec);
  }

  allNotesOff() {
    for (const id of this.pendingRelease.values()) clearTimeout(id);
    this.pendingRelease.clear();
    this.heldNotes.clear();
    this.stopArp();
    const now = this.ctx.currentTime;
    const g = this.gate.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.05);
    this.voice.allNotesOff();
  }

  dispose() {
    this.disposed = true;
    if (this.densityTimer !== null) {
      clearInterval(this.densityTimer);
      this.densityTimer = null;
    }
    this.allNotesOff();
    this.voice.dispose();
    this.chain.dispose();
    try {
      this.gate.disconnect();
    } catch {
      /* já desconectado */
    }
  }
}
