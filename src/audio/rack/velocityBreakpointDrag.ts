/**
 * Lógica PURA do arraste das divisórias do gráfico "Velocity Response" do
 * Auto Sampler (v0.2.14). Extraída do componente React pra poder ser testada
 * em Node (ver scripts/test-velocity-breakpoint-drag.mjs).
 *
 * Antes, `VelocityBreakpointEditor` só permitia arrastar quando a resposta
 * já estava em "Custom" — o usuário clicava na linha da foto e nada acontecia.
 * Agora o arraste é permitido em QUALQUER preset: o chamador recebe os novos
 * breakpoints e troca automaticamente pra `custom` (o próprio texto de ajuda
 * do componente já prometia isso).
 *
 * `breakpoints` tem `layers + 1` valores crescentes 0..127; o primeiro (0) e
 * o último (127) são fixos — só as divisórias do meio são arrastáveis.
 */
export function clampMidiVelocity(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(127, Math.round(n)));
}

/** Move a divisória `index` até `vel`, sem cruzar os vizinhos. */
export function moveBreakpoint(breakpoints: number[], index: number, vel: number): number[] {
  const bp = breakpoints.slice();
  if (index <= 0 || index >= bp.length - 1) return bp;
  const min = bp[index - 1] + 1;
  const max = bp[index + 1] - 1;
  bp[index] = Math.max(min, Math.min(max, clampMidiVelocity(vel)));
  return bp;
}

/**
 * Acha a divisória arrastável mais próxima de `vel` (tolerância em unidades
 * MIDI). Usado pra permitir clicar DENTRO de uma faixa, perto da linha, e
 * ainda assim pegar a divisória — a alça fina de 2px era difícil de acertar.
 */
export function nearestDraggableDivider(breakpoints: number[], vel: number, tolerance = 8): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (let i = 1; i < breakpoints.length - 1; i += 1) {
    const d = Math.abs(breakpoints[i] - vel);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return bestDist <= tolerance ? best : null;
}

/**
 * Converte a posição horizontal do ponteiro (clientX) em velocity 0..127,
 * dado o retângulo do SVG na tela. Extraído pra ser testado sem DOM real.
 */
export function clientXToVelocity(clientX: number, rectLeft: number, rectWidth: number): number {
  if (rectWidth <= 0) return 0;
  return clampMidiVelocity(((clientX - rectLeft) / rectWidth) * 127);
}
