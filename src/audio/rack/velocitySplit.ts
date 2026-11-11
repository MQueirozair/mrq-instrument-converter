/**
 * Lógica PURA das divisórias de velocity do Editor de Mapeamento (v0.2.13).
 *
 * Extraída do componente React pra poder ser testada em Node (ver
 * scripts/test-velocity-split.mjs) sem Web MIDI/Web Audio/Tauri.
 *
 * Modelo: `edges` tem `n + 1` valores crescentes. A parte `i` vai de
 * `edges[i]` até `edges[i+1] - 1` (velocity MIDI inclusiva). O último valor
 * é 128 quando a última parte termina em 127. As pontas podem ser > 0 / < 128:
 * nesse caso existem "buracos" sem amostra, desenhados em cinza na barra.
 *
 * Exemplo pedido pelo usuário — 4 amostras em "0 a 10 / 10 a 48 /
 * 48 a 81 / 81 a 127" — vira edges [0, 10, 48, 81, 128], produzindo as
 * faixas REAIS (sem sobreposição, como no Kontakt):
 *   0–9, 10–47, 48–80, 81–127.
 */
export interface VelocityRange {
  loVel: number;
  hiVel: number;
}

export interface VelocityZonePatch extends VelocityRange {
  key: string;
}

export function clampVelocity(n: number, lo = 0, hi = 128): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** Bordas atuais derivadas das zonas de um conjunto (ordenadas por loVel). */
export function deriveEdges(zones: { loVel: number; hiVel: number }[]): number[] {
  if (zones.length < 2) return [0, 128];
  const lo = zones.map((z) => clampVelocity(z.loVel, 0, 127));
  const lastHi = clampVelocity(zones[zones.length - 1].hiVel, 0, 127);
  return sanitizeEdges([lo[0], ...lo.slice(1), lastHi + 1]);
}

/** Garante 0..128, estritamente crescente e com pelo menos 1 velocity por parte. */
export function sanitizeEdges(edges: number[]): number[] {
  if (edges.length < 2) return [0, 128];
  const e = edges.map((v) => clampVelocity(v, 0, 128));
  const last = e.length - 1;
  for (let i = 1; i <= last; i += 1) e[i] = Math.max(e[i], e[i - 1] + 1);
  if (e[last] > 128) {
    // Entrada impossível (várias divisórias coladas no 128): ancora o fim em
    // 128 e comprime as internas de trás pra frente, mantendo a ordem estrita.
    e[last] = 128;
    for (let i = last - 1; i >= 0; i -= 1) e[i] = Math.min(e[i], e[i + 1] - 1);
    e[0] = Math.max(0, e[0]);
    for (let i = 1; i <= last; i += 1) e[i] = Math.max(e[i], e[i - 1] + 1);
  }
  return e;
}

/** Faixas (loVel/hiVel) de cada parte, prontas pra escrever nas zonas. */
export function edgesToRanges(edges: number[]): VelocityRange[] {
  const e = sanitizeEdges(edges);
  return e.slice(0, -1).map((lo, i) => ({
    loVel: clampVelocity(lo, 0, 127),
    hiVel: clampVelocity(e[i + 1] - 1, 0, 127),
  }));
}

/** Converte bordas em patches para as chaves de zona de UM conjunto. */
export function edgesToPatches(zoneKeys: string[], edges: number[]): VelocityZonePatch[] {
  const ranges = edgesToRanges(edges);
  return zoneKeys.map((key, i) => ({ key, ...ranges[Math.min(i, ranges.length - 1)] }));
}

/** Arraste de uma divisória INTERNA (index 1..n-1) até a velocity `vel`. */
export function moveDivider(edges: number[], index: number, vel: number): number[] {
  const e = sanitizeEdges(edges);
  if (index <= 0 || index >= e.length - 1) return e;
  e[index] = clampVelocity(vel, e[index - 1] + 1, e[index + 1] - 1);
  return e;
}

/** Arraste do CORPO da parte `index`: as duas bordas andam juntas. */
export function moveSegment(edges: number[], index: number, delta: number): number[] {
  const e = sanitizeEdges(edges);
  const n = e.length - 1;
  if (index < 0 || index >= n) return e;
  const minDelta = index > 0 ? e[index - 1] + 1 - e[index] : -e[index];
  const maxDelta = index + 1 < n ? e[index + 2] - 1 - e[index + 1] : 128 - e[index + 1];
  const d = clampVelocity(delta, minDelta, maxDelta);
  e[index] += d;
  e[index + 1] += d;
  return sanitizeEdges(e);
}

/** Divide 0–127 em `n` partes iguais. */
export function equalEdges(n: number): number[] {
  if (n < 1) return [0, 128];
  return Array.from({ length: n + 1 }, (_, i) => Math.round((i * 128) / n));
}

/** Faz a primeira parte começar em 0 e a última terminar em 127. */
export function stretchEdges(edges: number[]): number[] {
  const e = sanitizeEdges(edges);
  return sanitizeEdges([0, ...e.slice(1, -1), 128]);
}
