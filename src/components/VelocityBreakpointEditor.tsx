/**
 * Gráfico de pontos de quebra (breakpoints) de Velocity Response do Auto
 * Sampler — mesmo elemento visual do Logic Pro (ver screenshot da conversa:
 * linhas verticais arrastáveis em 42/77/127 dividindo o eixo 0-127 em
 * camadas coloridas). Em qualquer resposta pré-definida (linear, exp ou log)
 * mostra os pontos de quebra CALCULADOS, só pra leitura (sem alças); ao
 * arrastar uma divisória, o chamador troca pra `velocityResponse: 'custom'`
 * e passa a guardar os pontos em `customVelocityBreakpoints` — o motor
 * (`computeVelocityBreakpoints` em autoSamplerEngine.ts) já sabe consumir
 * esse array, só faltava a tela pra editá-lo.
 *
 * `breakpoints` é sempre um array de `layers + 1` valores 0-127 crescentes
 * (o primeiro é sempre 0 e o último sempre 127 — só as divisórias do MEIO
 * são arrastáveis).
 */
import { useCallback, useRef, useState } from 'react';

const WIDTH = 400;
const HEIGHT = 54;
const BAND_LABEL_Y = 16;
const BAR_Y = 20;
const BAR_H = 26;

const LAYER_COLORS = ['#3a6ea5', '#4f8ac9', '#6aa7de', '#2f5b8a', '#5d9cd1', '#467fb8', '#79b3e6'];

interface Props {
  layers: number;
  breakpoints: number[];
  editable: boolean; // true só quando velocityResponse === 'custom'
  onDrag: (newBreakpoints: number[]) => void;
}

export default function VelocityBreakpointEditor({ layers, breakpoints, editable, onDrag }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const velToX = useCallback((v: number) => (v / 127) * WIDTH, []);
  const clientXToVel = useCallback((clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(127, Math.round(((clientX - rect.left) / rect.width) * 127)));
  }, []);

  function handlePointerDown(e: React.PointerEvent, index: number) {
    if (!editable || index === 0 || index === breakpoints.length - 1) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDraggingIndex(index);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (draggingIndex === null) return;
    const vel = clientXToVel(e.clientX);
    const minV = breakpoints[draggingIndex - 1] + 1;
    const maxV = breakpoints[draggingIndex + 1] - 1;
    const clamped = Math.max(minV, Math.min(maxV, vel));
    const next = breakpoints.slice();
    next[draggingIndex] = clamped;
    onDrag(next);
  }

  function handlePointerUp() {
    setDraggingIndex(null);
  }

  return (
    <div className="as-velocity-editor">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {Array.from({ length: layers }, (_, i) => {
          const x0 = velToX(breakpoints[i]);
          const x1 = velToX(breakpoints[i + 1]);
          return (
            <g key={i}>
              <rect x={x0} y={BAR_Y} width={Math.max(1, x1 - x0)} height={BAR_H} fill={LAYER_COLORS[i % LAYER_COLORS.length]} opacity={0.85} />
              <text x={(x0 + x1) / 2} y={BAR_Y + BAR_H / 2 + 4} textAnchor="middle" className="as-vel-layer-label">
                {i + 1}
              </text>
            </g>
          );
        })}
        {breakpoints.map((v, i) => {
          const isEdge = i === 0 || i === breakpoints.length - 1;
          const x = velToX(v);
          return (
            <g key={i}>
              <line x1={x} y1={BAR_Y} x2={x} y2={BAR_Y + BAR_H} stroke="#fff" strokeWidth={isEdge ? 1 : 2} opacity={isEdge ? 0.4 : 0.95} />
              {!isEdge && (
                <rect
                  x={x - 5}
                  y={BAR_Y - 4}
                  width={10}
                  height={BAR_H + 8}
                  fill="transparent"
                  onPointerDown={(e) => handlePointerDown(e, i)}
                  style={{ cursor: editable ? 'ew-resize' : 'default' }}
                />
              )}
              <text x={x} y={BAND_LABEL_Y} textAnchor="middle" className="as-vel-breakpoint-label">
                {v}
              </text>
            </g>
          );
        })}
      </svg>
      {!editable && <div className="hint">Arraste uma divisória pra trocar automaticamente pra resposta "Custom".</div>}
    </div>
  );
}
