/**
 * Motor dos Controles ao Vivo (v0.2.22) — toca UM instrumento `.mrq` com os
 * controles globais da página aplicados a TODAS as amostras/zonas
 * ("INSTRUMENTO INTEIRO"), pra pré-escutar o som final como ele vai sair
 * num rack de instrumentos ao vivo.
 *
 * Reaproveita o que já existe, sem duplicar:
 *  - `MrqLayerVoice`: carrega o `.mrq` (decodifica as amostras pelo backend
 *    Rust) e toca as zonas (round robin, pan estéreo, loops, pitch bend);
 *  - `LiveFxChain`: EQ, drive, chorus, delay, reverb, largura estéreo e
 *    master (volume/pan) com nós Web Audio nativos.
 *
 * O que este engine adiciona por cima:
 *  - gate de envelope global (ATAQUE/RELEASE/SUSTAIN) com contagem de notas
 *    seguradas — o release longo funciona de verdade porque o `noteOff` da
 *    voz é adiado até o gate terminar de fechar (a voz sozinha cortaria em
 *    ~120ms);
 *  - NOTA MIN/MAX e VELOCIDADE MIN/MAX como filtros de entrada;
 *  - TECLA RAIZ como transposição global em relação à raiz de referência do
 *    instrumento (a `rootNote` mais comum entre as zonas);
 *  - AFINACAO via pitch bend da voz (afeta notas já soando, sem reatacar).
 */
import type { RackPresetOption } from '../../../shared/types';
import { MrqLayerVoice } from './MrqLayerVoice';
import { LiveFxChain } from './liveFxChain';
import {
  clampLiveParams,
  referenceRootFromZones,
  sustainLevel,
  type LiveParams,
} from './liveControls';
import { mrqReadMetadata } from './mrqFormat';

export interface LiveLoadResult {
  presets: RackPresetOption[];
  /** Tecla que toca o sample na afinação original (raiz mais comum). */
  referenceRoot: number;
  instrumentName: string;
}

export class LiveInstrumentEngine {
  /** Saída final da cadeia (a página conecta no destination). */
  readonly output: GainNode;

  private ctx: AudioContext;
  private voice: MrqLayerVoice;
  private chain: LiveFxChain;
  private gate: GainNode;
  private params: LiveParams;
  /** nota original (a que a página mandou) → nota transposta (a da voz). */
  private heldNotes = new Map<number, number>();
  private pendingRelease = new Map<number, ReturnType<typeof setTimeout>>();
  private referenceRoot = 60;
  private loaded = false;
  private disposed = false;

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
    this.chain.setParams(this.params);
    this.applyTune();
  }

  private applyTune() {
    // AFINACAO cents → pitch bend em semitons (afeta notas já soando).
    this.voice.setPitchBend(this.params.tuneCents / 100);
  }

  private transpose(note: number): number {
    return note + (Math.round(this.params.rootKey) - this.referenceRoot);
  }

  noteOn(note: number, velocity: number) {
    if (!this.loaded || this.disposed) return;
    const vel = Math.round(velocity);
    if (vel < this.params.velMin || vel > this.params.velMax) return;
    const original = Math.round(note);
    const transposed = this.transpose(original);
    if (transposed < 0 || transposed > 127) return;
    // Re-toque durante o release desta mesma nota: cancela o noteOff
    // pendente pra ele não matar a voz nova.
    const pending = this.pendingRelease.get(transposed);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingRelease.delete(transposed);
    }
    if (this.heldNotes.size === 0) this.triggerAttack();
    this.heldNotes.set(original, transposed);
    this.voice.noteOn(transposed, vel);
  }

  noteOff(note: number) {
    if (this.disposed) return;
    const original = Math.round(note);
    const transposed = this.heldNotes.get(original);
    if (transposed === undefined) return;
    this.heldNotes.delete(original);
    if (this.heldNotes.size === 0) {
      this.triggerRelease();
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
  }

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
    const now = this.ctx.currentTime;
    const g = this.gate.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.05);
    this.voice.allNotesOff();
  }

  dispose() {
    this.disposed = true;
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
