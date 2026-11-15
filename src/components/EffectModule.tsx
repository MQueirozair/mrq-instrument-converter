/**
 * Módulo de efeito (v0.2.25) — visual da foto de referência: nome + botão
 * de energia (bypass) no topo, knob principal grande, slider vertical
 * secundário e knobs pequenos extras. O botão de energia liga/desliga o
 * efeito (bypass) sem perder o ajuste; desligado, os controles apagam.
 */
import { Power } from 'lucide-react';
import Knob from './Knob';
import VerticalSlider from './VerticalSlider';
import { LIVE_PARAM_DEFS, type LiveEffectDef, type LiveParamKey, type LiveParams } from '../audio/rack/liveControls';

export interface EffectModuleConfig {
  effect: LiveEffectDef;
  /** Knob principal (mix/quantidade). */
  main: LiveParamKey;
  /** Parâmetro do slider vertical (opcional). */
  slider?: LiveParamKey;
  /** Knobs pequenos extras. */
  extras?: LiveParamKey[];
}

interface EffectModuleProps {
  config: EffectModuleConfig;
  params: LiveParams;
  bypassed: boolean;
  onParam: (key: LiveParamKey, value: number) => void;
  onToggleBypass: () => void;
}

export default function EffectModule({ config, params, bypassed, onParam, onToggleBypass }: EffectModuleProps) {
  const { effect, main, slider, extras } = config;
  const mainDef = LIVE_PARAM_DEFS[main];
  const sliderDef = slider ? LIVE_PARAM_DEFS[slider] : null;

  return (
    <div className={`fx-module${bypassed ? ' bypassed' : ''}`}>
      <div className="fx-module-head">
        <span className="fx-module-name">{effect.label}</span>
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
          onChange={(v) => onParam(main, v)}
          disabled={bypassed}
          size="lg"
        />
        {sliderDef && slider && (
          <VerticalSlider
            label={sliderDef.label}
            value={params[slider]}
            min={sliderDef.min}
            max={sliderDef.max}
            step={sliderDef.step}
            defaultValue={sliderDef.default}
            format={sliderDef.format}
            onChange={(v) => onParam(slider, v)}
            disabled={bypassed}
          />
        )}
      </div>
      {extras && extras.length > 0 && (
        <div className="fx-module-extras">
          {extras.map((key) => {
            const def = LIVE_PARAM_DEFS[key];
            return (
              <Knob
                key={key}
                label={def.label}
                value={params[key]}
                min={def.min}
                max={def.max}
                step={def.step}
                defaultValue={def.default}
                format={def.format}
                onChange={(v) => onParam(key, v)}
                disabled={bypassed}
                size="sm"
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
