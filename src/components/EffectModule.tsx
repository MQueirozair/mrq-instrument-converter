/**
 * Módulo de efeito (v0.2.25, ajustado na v0.2.30) — visual da foto de
 * referência: nome + botão de energia (bypass) no topo, knob principal
 * grande com valor abaixo, slider vertical secundário com rótulo abaixo
 * (ou gráfico, no EQ Paramétrico) e knobs pequenos extras. O botão de
 * energia liga/desliga o efeito (bypass) sem perder o ajuste; desligado,
 * os controles apagam.
 */
import { Power } from 'lucide-react';
import Knob from './Knob';
import VerticalSlider from './VerticalSlider';
import { LIVE_PARAM_DEFS, type LiveEffectDef, type LiveParamKey, type LiveParams } from '../audio/rack/liveControls';

export interface EffectModuleConfig {
  effect: LiveEffectDef;
  /** Título exibido no módulo (padrão: effect.label) — v0.2.30. */
  title?: string;
  /** Knob principal (mix/quantidade). */
  main: LiveParamKey;
  /** Parâmetro do slider vertical (opcional). */
  slider?: LiveParamKey;
  /** Rótulo curto do slider (Wet, Depth, Time...) — v0.2.30. */
  sliderLabel?: string;
  /** Gráfico à direita do knob (EQ Paramétrico) — v0.2.30. */
  graph?: 'eq';
  /** Knobs pequenos extras. */
  extras?: LiveParamKey[];
}

interface EffectModuleProps {
  config: EffectModuleConfig;
  params: LiveParams;
  bypassed: boolean;
  onParam: (key: LiveParamKey, value: number) => void;
  onToggleBypass: () => void;
  /** v0.2.34: modo compacto (aba Ferramentas) — knob principal `sm`,
   *  extras inline na linha do corpo (sem linha extra abaixo), pra caber
   *  17 módulos em 3 linhas sem estourar a altura da tela. */
  compact?: boolean;
}

/** Curva de resposta do EQ de 3 bandas (graves/médios/agudos) em SVG —
 *  espelha as 3 bandas reais (low/mid/high) com nós nos pontos de controle,
 *  como na foto de referência. */
function EqGraph({ params }: { params: LiveParams }) {
  const low = params.eqLowDb;
  const mid = params.eqMidDb;
  const high = params.eqHighDb;
  // Pontos de controle (x: 0..100, y: ganho -15..+15 → 8..52 invertido).
  const y = (db: number) => 30 - (db / 15) * 22;
  const nodes: Array<[number, number]> = [
    [2, y(low)],
    [18, y(low * 0.85)],
    [34, y(mid * 0.7)],
    [50, y(mid)],
    [66, y(mid * 0.7)],
    [82, y(high * 0.85)],
    [98, y(high)],
  ];
  const pts = nodes.map(([x, yy]) => `${x},${yy.toFixed(1)}`).join(' ');
  return (
    <div className="fx-eq-graph">
      <svg viewBox="0 0 100 60" width="100%" height="86" aria-hidden="true">
        <line x1="0" y1="30" x2="100" y2="30" stroke="#273447" strokeWidth="1" />
        <polyline points={pts} fill="none" stroke="#42d9ff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {nodes.map(([x, yy], i) => (
          <circle key={i} cx={x} cy={yy} r="2.6" fill="#0c1220" stroke="#42d9ff" strokeWidth="1.6" />
        ))}
      </svg>
      <span className="vslider-label">RESPOSTA</span>
    </div>
  );
}

/** Labels curtas dos extras no modo compacto (v0.2.34) — cabem na célula
 *  do grid sem estourar a largura do módulo. */
const SHORT_EXTRA_LABELS: Partial<Record<LiveParamKey, string>> = {
  reverbPredelayMs: 'PRE-DELAY',
  reverbColor: 'COR',
  phaserRate: 'RATE',
  flangerRate: 'RATE',
  flangerFeedback: 'FB',
  crushRate: 'TAXA',
};

export default function EffectModule({ config, params, bypassed, onParam, onToggleBypass, compact }: EffectModuleProps) {
  const { effect, title, main, slider, sliderLabel, graph, extras } = config;
  const mainDef = LIVE_PARAM_DEFS[main];
  const sliderDef = slider ? LIVE_PARAM_DEFS[slider] : null;

  const renderExtra = (key: LiveParamKey) => {
    const def = LIVE_PARAM_DEFS[key];
    // v0.2.34: no modo compacto, labels curtas (o nome do módulo já diz o
    // efeito; o tooltip do knob mostra o nome completo).
    const label = compact ? (SHORT_EXTRA_LABELS[key] ?? def.label) : def.label;
    return (
      <Knob
        key={key}
        label={label}
        value={params[key]}
        min={def.min}
        max={def.max}
        step={def.step}
        defaultValue={def.default}
        format={def.format}
        unit={def.unit}
        onChange={(v) => onParam(key, v)}
        disabled={bypassed}
        size="sm"
      />
    );
  };

  return (
    <div className={`fx-module${bypassed ? ' bypassed' : ''}${compact ? ' compact' : ''}`}>
      <div className="fx-module-head">
        <span className="fx-module-name">{title ?? effect.label}</span>
        <button
          type="button"
          className={`fx-power${bypassed ? ' off' : ''}`}
          onClick={onToggleBypass}
          aria-pressed={bypassed}
          title={bypassed ? `${effect.label} desligado (bypass) — clique pra ligar` : `${effect.label} ligado — clique pra desligar (bypass)`}
        >
          <Power size={13} />
        </button>
      </div>
      <div className="fx-module-body">
        <Knob
          label={mainDef.label}
          value={params[main]}
          min={mainDef.min}
          max={mainDef.max}
          step={mainDef.step}
          defaultValue={mainDef.default}
          format={mainDef.format}
          unit={mainDef.unit}
          onChange={(v) => onParam(main, v)}
          disabled={bypassed}
          size={compact ? 'sm' : 'md'}
          hideLabel
        />
        {sliderDef && slider && (
          <VerticalSlider
            label={sliderLabel ?? sliderDef.label}
            value={params[slider]}
            min={sliderDef.min}
            max={sliderDef.max}
            step={sliderDef.step}
            defaultValue={sliderDef.default}
            format={sliderDef.format}
            onChange={(v) => onParam(slider, v)}
            disabled={bypassed}
            trackHeight={compact ? 44 : undefined}
          />
        )}
        {graph === 'eq' && <EqGraph params={params} />}
        {/* v0.2.34: no modo compacto os extras ficam inline (sem linha
            extra) pra não aumentar a altura do módulo. */}
        {compact && extras && extras.length > 0 && extras.map(renderExtra)}
      </div>
      {!compact && extras && extras.length > 0 && (
        <div className="fx-module-extras">
          {extras.map(renderExtra)}
        </div>
      )}
    </div>
  );
}
