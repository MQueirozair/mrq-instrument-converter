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
  mapLiveVelocity,
  noteOffReleaseFactor,
  mapPedalValue,
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
    const shaped = mapLiveVelocity(vel, this.params);
    // Re-toque durante o release desta mesma nota: cancela o noteOff
    // pendente pra ele não matar a voz nova.
    const pending = this.pendingRelease.get(transposed);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingRelease.delete(transposed);
    }
    // Re-toque de uma nota segurada pelo pedal: ela volta a ser "tecla".
    this.pedalHeldVoices.delete(transposed);
    if (this.heldNotes.size === 0) this.triggerAttack();
    this.heldNotes.set(original, { transposed, velocity: shaped });
    this.voice.noteOn(transposed, shaped);
    this.trackDensity();
    this.startArp();
  }

  /** Note-off 0x80 pode transportar velocidade; 0x90/0 usa o padrão 64. */
  noteOff(note: number, releaseVelocity = 64) {
    if (this.disposed) return;
    const original = Math.round(note);
    const held = this.heldNotes.get(original);
    if (!held) return;
    this.heldNotes.delete(original);
    const transposed = held.transposed;
    const factor = noteOffReleaseFactor(releaseVelocity, this.params);
    const releaseMs = Math.max(0, this.params.releaseMs * factor);
    if (this.sustainPedalDown) {
      // Todas as notas soltas sob o pedal são mantidas, não apenas a última.
      this.pedalHeldVoices.set(transposed, { factor, releaseMs });
    } else if (this.heldNotes.size === 0) {
      this.triggerRelease(releaseMs);
      this.stopArp();
      this.scheduleVoiceOff(transposed, releaseMs);
    } else {
      this.voice.noteOff(transposed, factor);
    }
    this.refreshDensity();
  }

  /** Mantém a amostra durante o release do gate global. */
  private scheduleVoiceOff(transposed: number, releaseMs = this.params.releaseMs) {
    const id = setTimeout(() => {
      this.pendingRelease.delete(transposed);
      this.voice.noteOff(transposed);
    }, Math.max(0, releaseMs));
    this.pendingRelease.set(transposed, id);
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

  // --- Envelope AHDSR (gate global, v0.2.31) --------------------------------
  //
  // Cinco estágios reais no DSP, agendados com ramps do Web Audio
  // (sample-accurate — o renderizador de áudio interpola em resolução de
  // amostra, sem jitter de timer):
  //   ATTACK  → rampa até o pico (1.0) em attackMs
  //   HOLD    → mantém o pico por holdMs (o estágio novo — antes não existia)
  //   DECAY   → rampa do pico até o nível de sustain em decayMs
  //   SUSTAIN → mantém o nível de sustain enquanto houver tecla/pedal
  //   RELEASE → rampa até 0 em releaseMs no noteOff (ou fim do pedal CC64)
  //
  // O gate é global ("INSTRUMENTO INTEIRO", como o resto dos controles):
  // abre no primeiro noteOn e fecha quando a última nota/pedal libera.
  // Se a tecla for solta durante Attack/Hold/Decay, o Release parte do
  // nível atual (sem salto). O pedal CC64 (sustain) segura o gate aberto
  // mesmo com todas as teclas soltas.

  /** Pedal de sustain MIDI (CC64) — enquanto down, o gate não fecha. */
  private sustainPedalDown = false;
  /** Vozes (transpostas) soltas da tecla mas seguradas pelo pedal CC64. */
  private pedalHeldVoices = new Map<number, { factor: number; releaseMs: number }>();

  private triggerAttack() {
    const now = this.ctx.currentTime;
    const attackSec = Math.max(0.0005, this.params.attackMs / 1000);
    const holdSec = Math.max(0, this.params.holdMs / 1000);
    const decaySec = Math.max(0.0005, this.params.decayMs / 1000);
    const sustain = sustainLevel(this.params.sustain);
    const g = this.gate.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    // ATTACK: sobe até o pico.
    g.linearRampToValueAtTime(1, now + attackSec);
    // HOLD: segura o pico até (attack + hold) — o ramp de decay só começa
    // depois, então o pico fica plano durante o hold (sem timer, tudo no
    // relógio de áudio).
    const decayStart = now + attackSec + holdSec;
    g.setValueAtTime(1, decayStart);
    // DECAY: desce do pico até o nível de sustain.
    g.linearRampToValueAtTime(sustain, decayStart + decaySec);
    // SUSTAIN: o valor final permanece (nenhum ramp posterior).
  }

  private triggerRelease(releaseMs = this.params.releaseMs) {
    const now = this.ctx.currentTime;
    const releaseSec = Math.max(0.0005, releaseMs / 1000);
    const g = this.gate.gain;
    g.cancelScheduledValues(now);
    // Parte do nível atual (pode estar em Attack/Hold/Decay/Sustain) — sem
    // salto de amplitude.
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + releaseSec);
  }

  /**
   * Pedal de sustain MIDI (CC64). Com o pedal pressionado, soltar todas as
   * teclas NÃO fecha o gate; ao soltar o pedal (sem teclas), o Release
   * começa. Distinto do Hold do envelope (estágio automático pós-attack).
   */
  setSustainPedal(down: boolean) {
    if (this.disposed) return;
    const was = this.sustainPedalDown;
    this.sustainPedalDown = down;
    if (was && !down) {
      const lastRelease = [...this.pedalHeldVoices.values()].reduce((max, v) => Math.max(max, v.releaseMs), 0);
      if (this.heldNotes.size === 0) {
        this.triggerRelease(this.pedalHeldVoices.size ? lastRelease : this.params.releaseMs);
        this.stopArp();
      }
      for (const [transposed, release] of this.pedalHeldVoices) {
        if (this.heldNotes.size === 0) this.scheduleVoiceOff(transposed, lastRelease);
        else this.voice.noteOff(transposed, release.factor);
      }
      this.pedalHeldVoices.clear();
    }
  }

  /** CC64 é um interruptor neste motor; a curva determina o limiar efetivo. */
  setSustainPedalValue(value: number) {
    this.setSustainPedal(mapPedalValue(value, this.params) >= this.params.pedalThreshold);
  }

  allNotesOff() {
    for (const id of this.pendingRelease.values()) clearTimeout(id);
    this.pendingRelease.clear();
    this.heldNotes.clear();
    this.pedalHeldVoices.clear();
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
