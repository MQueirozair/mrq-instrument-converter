/** Editor das respostas MIDI. O pedal usa CC64 como interruptor; não simula meio-pedal. */
import { useEffect, useRef, useState } from 'react';
import { defaultLiveParams, mapLiveVelocity, type LiveParamKey, type LiveParams } from '../audio/rack/liveControls';

type Curve = 'velocity' | 'noteoff' | 'pedal';
export interface MidiSample { serial: number; command: number; number: number; value: number }
interface Props {
  params: LiveParams;
  onChange: (values: Partial<LiveParams>) => void;
  sample: MidiSample | null;
  connected: boolean;
  onConnect: () => void;
  onClose: () => void;
}
const KEYS: Record<Curve, [LiveParamKey, LiveParamKey, LiveParamKey]> = {
  velocity: ['velocityLow', 'velocityMid', 'velocityHigh'],
  noteoff: ['noteOffLow', 'noteOffMid', 'noteOffHigh'],
  pedal: ['pedalLow', 'pedalMid', 'pedalHigh'],
};
const NAMES: Record<Curve, string> = { velocity: 'Velocidade', noteoff: 'Note-off', pedal: 'Pedal' };

export default function MidiCurveEditor({ params, onChange, sample, connected, onConnect, onClose }: Props) {
  const [tab, setTab] = useState<Curve>('velocity');
  const [stage, setStage] = useState<'none' | 'velocity' | 'rest' | 'pressed' | 'review'>('none');
  const [velSamples, setVelSamples] = useState<number[]>([]);
  const [pedalSamples, setPedalSamples] = useState<number[]>([]);
  const [restValue, setRestValue] = useState<number | null>(null);
  const [pressedValue, setPressedValue] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const keys = KEYS[tab];
  const ys = keys.map((key) => params[key]);
  const xs = [0, 64, 127];
  const minVelocity = velSamples.length ? Math.min(...velSamples) : 0;
  const maxVelocity = velSamples.length ? Math.max(...velSamples) : 0;
  const pedalLatest = pedalSamples.length ? pedalSamples[pedalSamples.length - 1] : null;
  const validVelocity = velSamples.length >= 4 && maxVelocity - minVelocity >= 10;
  const validPedal = restValue !== null && pressedValue !== null && Math.abs(restValue - pressedValue) >= 10;

  useEffect(() => {
    if (!sample) return;
    if (stage === 'velocity' && sample.command === 0x90 && sample.value > 0)
      setVelSamples((old) => [...old.slice(-199), sample.value]);
    if ((stage === 'rest' || stage === 'pressed') && sample.command === 0xb0 && sample.number === 64)
      setPedalSamples((old) => [...old.slice(-19), sample.value]);
  }, [sample, stage]);

  function movePoint(index: number, clientY: number) {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect) return;
    const y = (clientY - rect.top) / rect.height * 180;
    onChange({ [keys[index]]: Math.max(0, Math.min(127, Math.round((160 - y) * 127 / 140))) });
  }
  function resetCurve() {
    const defaults = defaultLiveParams();
    const patch: Partial<LiveParams> = {};
    const list: LiveParamKey[] = tab === 'velocity'
      ? [...keys, 'velocityInputLow', 'velocityInputHigh', 'velCurve']
      : tab === 'pedal' ? [...keys, 'pedalInputLow', 'pedalInputHigh', 'pedalReverse', 'pedalThreshold'] : keys;
    list.forEach((k) => { patch[k] = defaults[k]; });
    onChange(patch);
  }
  function applyCalibration() {
    if (!validVelocity) return;
    const patch: Partial<LiveParams> = { velocityInputLow: Math.min(126, minVelocity), velocityInputHigh: Math.max(2, maxVelocity) };
    if (validPedal && restValue !== null && pressedValue !== null) {
      patch.pedalInputLow = Math.min(restValue, pressedValue);
      patch.pedalInputHigh = Math.max(restValue, pressedValue);
      patch.pedalReverse = restValue > pressedValue ? 1 : 0;
    }
    onChange(patch); setStage('none');
  }
  const chartX = (x: number) => 28 + x * 300 / 127;
  const chartY = (y: number) => 160 - y * 140 / 127;
  const poly = xs.map((x, i) => `${chartX(x)},${chartY(ys[i])}`).join(' ');
  const actualVelocity = Array.from({ length: 65 }, (_, i) => {
    const x = i * 127 / 64;
    return `${chartX(x)},${chartY(mapLiveVelocity(Math.max(1, x), params))}`;
  }).join(' ');
  return (
    <div className="midi-curve-overlay">
      <section className="midi-curve-dialog" role="dialog" aria-modal="true" aria-labelledby="midi-curve-title" onKeyDown={(e) => { if (e.key === 'Escape') { if (stage !== 'none') setStage('none'); else onClose(); } }}>
        <header className="midi-curve-head"><div><span className="midi-curve-eyebrow">CONTROLES MIDI</span><h2 id="midi-curve-title">Curvas de resposta</h2></div><button className="btn ghost" type="button" onClick={onClose} autoFocus>Fechar</button></header>
        <nav className="midi-curve-tabs" aria-label="Tipo de curva">
          {(Object.keys(KEYS) as Curve[]).map((t) => <button key={t} type="button" aria-pressed={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{NAMES[t]}</button>)}
        </nav>
        {stage === 'none' ? <>
          <div className="midi-curve-content">
            <div className="midi-curve-chart">
              <svg ref={svg} viewBox="0 0 350 180" role="img" aria-label={`Curva ${NAMES[tab]}; arraste os pontos para ajustar`}
                onPointerMove={(e) => { if (drag.current !== null) movePoint(drag.current, e.clientY); }}
                onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
                {[0, 32, 64, 96, 127].map(v => <g key={v}><line x1="28" y1={chartY(v)} x2="328" y2={chartY(v)} stroke="#26374a" /><line x1={chartX(v)} y1="20" x2={chartX(v)} y2="160" stroke="#26374a" /><text x="4" y={chartY(v)+3} fill="#9bb1ca" fontSize="9">{v}</text><text x={chartX(v)} y="174" textAnchor="middle" fill="#9bb1ca" fontSize="9">{v}</text></g>)}
                <polyline points={poly} fill="none" stroke="#45c9ed" strokeWidth="2.5" />
                {tab === 'velocity' && <polyline points={actualVelocity} fill="none" stroke="#b898ff" strokeWidth="1.5" strokeDasharray="4 3" />}
                {xs.map((x, i) => <circle key={x} cx={chartX(x)} cy={chartY(ys[i])} r="6" fill="#0c1828" stroke="#6fe4ff" strokeWidth="2" style={{ cursor: 'ns-resize', touchAction: 'none' }} onPointerDown={(e) => { e.preventDefault(); drag.current = i; e.currentTarget.setPointerCapture(e.pointerId); }} />)}
              </svg>
              <div className="midi-curve-axis">Entrada → &nbsp; · &nbsp; Saída ↑</div>
            </div>
            <div className="midi-curve-options">
              <h3>{NAMES[tab]}</h3>
              <p>{tab === 'velocity' ? 'Ajusta a força da nota. Roxo tracejado: resultado com calibração e curva existente.' : tab === 'noteoff' ? 'A velocidade de soltura controla o tempo de release: 127 mantém o tempo original.' : 'Adapta a resposta do CC64. O motor usa pedal ligado/desligado, não meio-pedal contínuo.'}</p>
              <div className="midi-curve-presets" aria-label={`Predefinições ${NAMES[tab]}`}>
                <button type="button" onClick={() => onChange({[keys[0]]: tab === 'noteoff' ? 127 : 0, [keys[1]]: tab === 'noteoff' ? 127 : 64, [keys[2]]: 127, ...(tab === 'velocity' ? {velCurve: 0} : {})})}>{tab === 'noteoff' ? 'Original' : 'Linear'}</button>
                <button type="button" onClick={() => onChange({[keys[0]]: tab === 'noteoff' ? 48 : 0, [keys[1]]: tab === 'noteoff' ? 80 : 90, [keys[2]]: 127, ...(tab === 'velocity' ? {velCurve: 0} : {})})}>{tab === 'noteoff' ? 'Release variável' : 'Resposta suave'}</button>
                <button type="button" onClick={() => onChange({[keys[0]]: 0, [keys[1]]: 38, [keys[2]]: 127, ...(tab === 'velocity' ? {velCurve: 0} : {})})}>{tab === 'noteoff' ? 'Release curto' : 'Resposta firme'}</button>
              </div>
              {keys.map((key, i) => <label className="midi-curve-range" key={key}><span>{['Início', 'Centro', 'Final'][i]} <b>{Math.round(params[key])}</b></span><input type="range" min="0" max="127" step="1" value={params[key]} onChange={e => onChange({ [key]: Number(e.target.value) })} aria-label={`${NAMES[tab]} ${['início', 'centro', 'final'][i]}`} /></label>)}
              {tab === 'velocity' && <label className="midi-curve-range"><span>Curva adicional <b>{Math.round(params.velCurve)}</b></span><input type="range" min="-100" max="100" value={params.velCurve} onChange={e => onChange({velCurve:Number(e.target.value)})} aria-label="Curva adicional de velocidade" /></label>}
              {tab === 'pedal' && <><label className="midi-curve-range"><span>Limiar liga/desliga <b>{Math.round(params.pedalThreshold)}</b></span><input type="range" min="1" max="127" value={params.pedalThreshold} onChange={e => onChange({pedalThreshold:Number(e.target.value)})} aria-label="Limiar do pedal" /></label><label><input type="checkbox" checked={params.pedalReverse >= 0.5} onChange={e => onChange({pedalReverse:e.target.checked ? 1 : 0})} /> Pedal invertido</label></>}
              <div className="midi-curve-readout">{tab === 'velocity' ? `Entrada calibrada: ${params.velocityInputLow}–${params.velocityInputHigh}` : tab === 'pedal' ? `Entrada calibrada: ${params.pedalInputLow}–${params.pedalInputHigh}` : 'Sem velocidade de soltura MIDI, usa-se 64.'}</div>
            </div>
          </div>
          <footer className="midi-curve-footer"><button className="btn ghost" type="button" title="Restaura esta curva e sua calibração aos padrões" onClick={resetCurve}>Restaurar curva</button><button className="btn primary" type="button" onClick={() => { setVelSamples([]); setPedalSamples([]); setRestValue(null); setPressedValue(null); setStage('velocity'); }}>Calibrar teclado e pedal</button></footer>
        </> : <div className="midi-calibration">
          <h3>Assistente de calibração</h3>
          <p>Conecte seu teclado MIDI e selecione o canal correto na tela principal. Os ajustes só serão aplicados ao confirmar.</p>
          <div className="midi-calibration-status">{connected ? '● MIDI conectado' : '○ Nenhum dispositivo MIDI conectado'} {!connected && <button type="button" className="btn ghost" onClick={onConnect}>Conectar MIDI</button>}</div>
          {stage === 'velocity' && <><h4>1. Velocidade</h4><p>Toque pelo menos quatro notas, algumas bem suaves e outras fortes. Faixa detectada: {velSamples.length ? `${minVelocity}–${maxVelocity}` : 'aguardando'} · {velSamples.length} notas.</p>{velSamples.length > 0 && !validVelocity && <p>São necessárias ao menos quatro notas e uma diferença de 10 entre suave e forte.</p>}<button className="btn primary" disabled={!validVelocity} onClick={() => { setPedalSamples([]); setStage('rest'); }}>Próximo: pedal</button> <button className="btn ghost" disabled={!validVelocity} onClick={() => setStage('review')}>Pular pedal</button></>}
          {stage === 'rest' && <><h4>2. Pedal solto</h4><p>Solte o pedal e mova-o, se necessário, para enviar o valor CC64. Valor recebido: {pedalLatest ?? 'aguardando'}.</p><button className="btn primary" disabled={pedalLatest === null} onClick={() => { setRestValue(pedalLatest); setPedalSamples([]); setStage('pressed'); }}>Registrar solto</button> <button className="btn ghost" onClick={() => setStage('review')}>Pular pedal</button></>}
          {stage === 'pressed' && <><h4>3. Pedal pressionado</h4><p>Pressione o pedal até o fim. Valor recebido: {pedalLatest ?? 'aguardando'}.</p><button className="btn primary" disabled={pedalLatest === null || restValue === null || Math.abs(pedalLatest - restValue) < 10} onClick={() => {setPressedValue(pedalLatest); setStage('review');}}>Registrar pressionado</button> <button className="btn ghost" onClick={() => {setRestValue(null); setStage('review');}}>Pular pedal</button></>}
          {stage === 'review' && <><h4>4. Confirmar</h4><p>Teclado: {minVelocity}–{maxVelocity}. {validPedal ? `Pedal: solto ${restValue}, pressionado ${pressedValue}${(restValue ?? 0) > (pressedValue ?? 0) ? ' (invertido)' : ''}.` : 'Pedal não será alterado.'}</p><button className="btn primary" onClick={applyCalibration}>Aplicar calibração</button></>}
          <div className="midi-calibration-cancel"><button type="button" className="btn ghost" onClick={() => setStage('none')}>Cancelar sem aplicar</button></div>
        </div>}
      </section>
    </div>
  );
}
