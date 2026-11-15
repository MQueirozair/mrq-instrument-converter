/**
 * Pan / Balance profissional (v0.2.25) — distingue PAN de BALANCE:
 *
 *  - Fonte MONO: lei de panorâmica equal-power (loudness constante) — o
 *    sinal é posicionado na imagem sem cair de volume no centro.
 *  - Fonte ESTÉREO: lei de BALANCE — um lado fica em 1.0 e o outro atenua,
 *    preservando a imagem estéreo original (não desloca a imagem, só
 *    equilibra L/R).
 *
 * O nó recebe qualquer entrada (mono ou estéreo): um upmixer força a saída
 * em estéreo (mono é duplicado pros dois canais; estéreo passa intacto),
 * então o divisor sempre recebe L e R de verdade — nunca um lado mudo.
 *
 * A lei é escolhida por `mode`:
 *  - 'balance' (padrão): preserva a imagem estéreo; em mono, posiciona o
 *    sinal atenuando um lado (centro em nível cheio).
 *  - 'pan': equal-power nos dois casos (desloca a imagem estéreo).
 *
 * Não há duplo processamento: este é o ÚNICO pan/balance mestre da cadeia
 * (o pan por zona do MrqLayerVoice é parte da definição do instrumento).
 */

export type PanBalanceMode = 'balance' | 'pan';

/**
 * Ganhos L/R da lei de BALANCE (pura, testável).
 * pan -1 (L100) → L=1,R=0 · 0 (C) → L=1,R=1 · +1 (R100) → L=0,R=1.
 * Um lado fica sempre em 1.0 (a imagem estéreo é preservada).
 */
export function balanceGains(pan: number): { left: number; right: number } {
  const p = Math.min(1, Math.max(-1, pan));
  return {
    left: p <= 0 ? 1 : 1 - p,
    right: p >= 0 ? 1 : 1 + p,
  };
}

/**
 * Ganhos L/R da lei EQUAL-POWER (pura, testável) — panorâmica com loudness
 * constante: L = cos((pan+1)·π/4), R = sin((pan+1)·π/4).
 * pan -1 → L=1,R=0 · 0 → L=R=0.707 · +1 → L=0,R=1.
 */
export function equalPowerGains(pan: number): { left: number; right: number } {
  const p = Math.min(1, Math.max(-1, pan));
  const angle = ((p + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/** Ganhos L/R conforme o modo ('balance' ou 'pan'/equal-power). */
export function panBalanceGains(pan: number, mode: PanBalanceMode): { left: number; right: number } {
  return mode === 'pan' ? equalPowerGains(pan) : balanceGains(pan);
}

/**
 * Rótulo L/C/R do pan (interface -100..+100): L100, L50, C, R50, R100.
 * pan é o valor interno normalizado (-1..+1).
 */
export function panLabel(pan: number): string {
  const v = Math.round(Math.min(1, Math.max(-1, pan)) * 100);
  if (v === 0) return 'C';
  return v < 0 ? `L${-v}` : `R${v}`;
}

export interface PanBalanceNode {
  input: GainNode;
  output: GainNode;
  setPan: (pan: number) => void;
  setMode: (mode: PanBalanceMode) => void;
}

/**
 * Cria o nó pan/balance: entrada → upmix estéreo → splitter → ganhos L/R
 * → merger → saída. `setPan`/`setMode` usam setTargetAtTime (sem cliques).
 */
export function createPanBalanceNode(ctx: AudioContext, initialPan = 0, initialMode: PanBalanceMode = 'balance'): PanBalanceNode {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // Upmix mono→estéreo (mesma correção da v0.2.24): garante 2 canais pro
  // splitter — mono duplicado, estéreo intacto.
  const upmix = ctx.createGain();
  upmix.channelCount = 2;
  upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';

  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const leftGain = ctx.createGain();
  const rightGain = ctx.createGain();

  input.connect(upmix);
  upmix.connect(splitter);
  splitter.connect(leftGain, 0);
  splitter.connect(rightGain, 1);
  leftGain.connect(merger, 0, 0);
  rightGain.connect(merger, 0, 1);
  merger.connect(output);

  let mode: PanBalanceMode = initialMode;
  let pan = Math.min(1, Math.max(-1, initialPan));

  function apply() {
    const g = panBalanceGains(pan, mode);
    const now = ctx.currentTime;
    leftGain.gain.setTargetAtTime(g.left, now, 0.015);
    rightGain.gain.setTargetAtTime(g.right, now, 0.015);
  }
  apply();

  return {
    input,
    output,
    setPan: (value: number) => {
      pan = Math.min(1, Math.max(-1, value));
      apply();
    },
    setMode: (next: PanBalanceMode) => {
      // v0.2.26: se o modo não mudou, não reaplica (evita rampa redundante).
      if (next === mode) return;
      mode = next;
      apply();
    },
  };
}
