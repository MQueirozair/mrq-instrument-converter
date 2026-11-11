/**
 * Gráfico de pontos de quebra (breakpoints) de Velocity Response do Auto
 * Sampler — mesmo elemento visual do Logic Pro (a barra azul da foto com as
 * linhas brancas divisórias em 42/77/127 e as faixas numeradas 1, 2, 3...).
 *
 * v0.2.14 — CORREÇÃO DO ARRASTE: antes `handlePointerDown` só aceitava o
 * arraste quando `velocityResponse === 'custom'`, então clicar na linha num
 * preset (linear/exp/log) não fazia nada, embora o texto de ajuda dissesse
 * "arraste uma divisória pra trocar automaticamente pra Custom". Agora as
 * divisórias são arrastáveis em QUALQUER preset: o primeiro arraste entrega
 * os novos pontos ao chamador, que troca pra `custom` e passa a guardá-los
 * em `customVelocityBreakpoints` (o motor `computeVelocityBreakpoints` já
 * consome esse array). Além disso:
 *   - ALÇA MAIOR (18px) + é possível clicar DENTRO da faixa, perto da linha,
 *     e pegar a divisória (antes só os 10px exatos da alça funcionavam);
 *   - ponteiro capturado no SVG inteiro (o arraste não se perde ao sair da
 *     alça), funciona com mouse e touch;
 *   - pulse/grade visuais e cursor `ew-resize` deixam claro onde clicar.
 *
 * `breakpoints` é sempre um array de `layers + 1` valores 0-127 crescentes
 * (o primeiro é sempre 0 e o último sempre 127 — só as divisórias do MEIO
 * são arrastáveis). A lógica pura está em
 * `src/audio/rack/velocityBreakpointDrag.ts` e tem testes em
 * `scripts/test-velocity-breakpoint-drag.mjs`.
 */
import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  clientXToVelocity,
  moveBreakpoint,
  nearestDraggableDivider,
} from '../audio/rack/velocityBreakpointDrag';

const WIDTH = 400;
const HEIGHT = 54;
const BAND_LABEL_Y = 14;
const BAR_Y = 20;
const BAR_H = 26;
const HANDLE_W = 18; // px no viewBox — área clicável generosa

const LAYER_COLORS = ['#3a6ea5', '#4f8ac9', '#6aa7de', '#2f5b8a', '#5d9cd1', '#467fb8', '#79b3e6'];

interface Props {
  layers: number;
  breakpoints: number[];
  /** Pode arrastar? Falso só durante uma captura em andamento. */
  editable: boolean;
  /** Só muda o texto de ajuda: mostra que o arraste troca pra Custom. */
  custom?: boolean;
  onDrag: (newBreakpoints: number[]) => void;
}

export default function VelocityBreakpointEditor({ layers, breakpoints, editable, custom = false, onDrag }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const velToX = useCallback((v: number) => (v / 127) * WIDTH, []);
  const clientXToVel = useCallback((clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clientXToVelocity(clientX, rect.left, rect.width);
  }, []);

  function startDrag(e: ReactPointerEvent, index: number) {
    if (!editable || index <= 0 || index >= breakpoints.length - 1) return;
    e.preventDefault();
    e.stopPropagation();
    // Captura no SVG inteiro: mesmo saindo da alça fina, o arraste continua.
    try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* navegador sem capture */ }
    dragRef.current = index;
    setDraggingIndex(index);
  }

  function handlePointerDown(e: ReactPointerEvent, index: number) {
    startDrag(e, index);
  }

  /** Clique dentro de uma faixa: se foi perto de uma divisória, pega ela. */
  function handleBandPointerDown(e: ReactPointerEvent) {
    if (!editable) return;
    const near = nearestDraggableDivider(breakpoints, clientXToVel(e.clientX), 8);
    if (near !== null) startDrag(e, near);
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const index = dragRef.current;
    if (index === null) return;
    const next = moveBreakpoint(breakpoints, index, clientXToVel(e.clientX));
    onDrag(next);
  }

  function endDrag(e?: ReactPointerEvent) {
    if (e && svgRef.current?.hasPointerCapture(e.pointerId)) {
      try { svgRef.current.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    }
    dragRef.current = null;
    setDraggingIndex(null);
  }

  return (
    <div className={`as-velocity-editor ${draggingIndex !== null ? 'dragging' : ''}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        style={{ touchAction: 'none' }}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => endDrag(e)}
        onPointerCancel={(e) => endDrag(e)}
        onLostPointerCapture={() => endDrag()}
      >
        {Array.from({ length: layers }, (_, i) => {
          const x0 = velToX(breakpoints[i]);
          const x1 = velToX(breakpoints[i + 1]);
          return (
            <g key={i}>
              <rect
                x={x0} y={BAR_Y} width={Math.max(1, x1 - x0)} height={BAR_H}
                fill={LAYER_COLORS[i % LAYER_COLORS.length]} opacity={0.85}
                onPointerDown={handleBandPointerDown}
                style={{ cursor: editable ? 'ew-resize' : 'default' }}
              />
              <text x={(x0 + x1) / 2} y={BAR_Y + BAR_H / 2 + 4} textAnchor="middle" className="as-vel-layer-label" style={{ pointerEvents: 'none' }}>
                {i + 1}
              </text>
            </g>
          );
        })}
        {breakpoints.map((v, i) => {
          const isEdge = i === 0 || i === breakpoints.length - 1;
          const x = velToX(v);
          const active = draggingIndex === i;
          return (
            <g key={i}>
              <line x1={x} y1={BAR_Y} x2={x} y2={BAR_Y + BAR_H} stroke={active ? '#ffe27a' : '#fff'} strokeWidth={isEdge ? 1 : active ? 3 : 2} opacity={isEdge ? 0.4 : 0.95} style={{ pointerEvents: 'none' }} />
              {!isEdge && editable && (
                <>
                  {/* "puxador" visível no meio da linha */}
                  <rect
                    x={x - 3} y={BAR_Y + BAR_H / 2 - 6} width={6} height={12} rx={2}
                    fill={active ? '#ffe27a' : '#e8f4ff'} opacity={0.95}
                    style={{ pointerEvents: 'none' }}
                  />
                  <rect
                    className="as-vel-handle"
                    x={x - HANDLE_W / 2} y={BAR_Y - 6} width={HANDLE_W} height={BAR_H + 12}
                    fill="transparent"
                    onPointerDown={(e) => handlePointerDown(e, i)}
                    style={{ cursor: 'ew-resize' }}
                  />
                </>
              )}
              <text x={x} y={BAND_LABEL_Y} textAnchor="middle" className={`as-vel-breakpoint-label ${active ? 'active' : ''}`} style={{ pointerEvents: 'none' }}>
                {v}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="hint">
        {!editable
          ? 'Divisórias travadas durante a captura.'
          : custom
            ? 'Clique e arraste as linhas brancas para posicionar cada camada de velocity (0–127).'
            : 'Clique e arraste uma linha branca para ajustar as regiões — muda automaticamente pra resposta “Custom”.'}
      </div>
    </div>
  );
}
