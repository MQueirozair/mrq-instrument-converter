/**
 * Divisórias de Velocity do Editor de Mapeamento (v0.2.13).
 *
 * Mesma ideia visual do VelocityBreakpointEditor do Auto Sampler (a barra
 * azul da foto com as divisórias arrastáveis e a legenda "Arraste uma
 * divisória..."), mas aqui as divisórias NÃO são pontos de uma curva de
 * resposta: elas são as próprias faixas `loVel`/`hiVel` das ZONAS REAIS do
 * instrumento. Arrastar uma divisória escreve direto no modelo — a grade
 * key×velocity do Mapping Editor muda junto, em tempo real, e o som tocado
 * pelo controlador MIDI passa a disparar a amostra certa na nova faixa.
 *
 * Exemplo pedido pelo usuário: 4 amostras em 0–10 / 10–48 / 48–81 / 81–127.
 * Aqui isso vira divisórias internas em 10, 48 e 81 (as faixas MIDI reais
 * ficam 0–9, 10–47, 48–80, 81–127 — sem sobreposição, como no Kontakt).
 * O preset "4 partes · 10 / 48 / 81" aplica exatamente esse exemplo.
 *
 * "Aplicar a todos os conjuntos": num piano multisampleado cada faixa de
 * teclas tem seu próprio grupo de camadas de velocity. Com a opção ligada,
 * UM arraste replica as mesmas divisórias em todos os conjuntos que tenham
 * o mesmo número de camadas — é o comportamento que se espera ao ajustar
 * as camadas de um instrumento inteiro.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { AlignVerticalDistributeCenter, Info, SlidersHorizontal, X } from 'lucide-react';
import {
  deriveEdges,
  edgesToPatches,
  equalEdges,
  moveDivider,
  moveSegment,
  sanitizeEdges,
  stretchEdges,
} from '../audio/rack/velocitySplit';

export interface VelocitySplitZone {
  key: string;
  sampleId: string;
  loVel: number;
  hiVel: number;
  loKey: number;
  hiKey: number;
  groupIdx: number;
  groupName: string;
}

export interface VelocitySplitSet {
  key: string;
  label: string;
  zones: VelocitySplitZone[]; // ordenadas por loVel
}

export interface VelocitySplitPatch {
  key: string;
  loVel: number;
  hiVel: number;
}

interface VelocitySplitEditorProps {
  sets: VelocitySplitSet[];
  activeSetKey: string | null;
  onActiveSetChange: (key: string) => void;
  applyAll: boolean;
  onApplyAllChange: (v: boolean) => void;
  selectedKeys: Set<string>;
  /** Chamado UMA vez no início de cada arraste (empurra o histórico). */
  onBeginEdit: () => void;
  /** Chamado a cada movimento, com as faixas novas de todas as zonas afetadas. */
  onApply: (patches: VelocitySplitPatch[]) => void;
  onSelectZone: (key: string) => void;
  onOpenWave: (key: string) => void;
  onClose: () => void;
}

const LAYER_COLORS = ['#3a6ea5', '#4f8ac9', '#6aa7de', '#2f5b8a', '#5d9cd1', '#467fb8', '#79b3e6', '#35618f'];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

interface SplitDrag {
  kind: 'div' | 'seg';
  index: number;
  startVel: number;
  startEdges: number[];
}

export default function VelocitySplitEditor({
  sets,
  activeSetKey,
  onActiveSetChange,
  applyAll,
  onApplyAllChange,
  selectedKeys,
  onBeginEdit,
  onApply,
  onSelectZone,
  onOpenWave,
  onClose,
}: VelocitySplitEditorProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<SplitDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [customText, setCustomText] = useState('');

  const active = sets.find((s) => s.key === activeSetKey) ?? sets[0] ?? null;
  const zones = active?.zones ?? [];
  const n = zones.length;

  /** Bordas das partes: n+1 valores, edges[i] = início da parte i,
   *  edges[n] = fim exclusivo (127 vira 128). Sempre crescentes. */
  const edges = useMemo(() => deriveEdges(zones), [activeSetKey, sets]);

  const targetSets = useMemo(
    () => (applyAll ? sets.filter((s) => s.zones.length === n) : active ? [active] : []),
    [applyAll, sets, active, n]
  );

  function applyEdges(nextEdges: number[]) {
    if (!active || n < 2) return;
    const clean = sanitizeEdges(nextEdges);
    const patches: VelocitySplitPatch[] = [];
    targetSets.forEach((set) => {
      patches.push(...edgesToPatches(set.zones.map((z) => z.key), clean));
    });
    onApply(patches);
  }

  function velFromClientX(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * 128, 0, 128);
  }

  function beginDrag(e: ReactPointerEvent, kind: 'div' | 'seg', index: number) {
    if (n < 2) return;
    e.preventDefault();
    e.stopPropagation();
    onBeginEdit();
    trackRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = { kind, index, startVel: velFromClientX(e.clientX), startEdges: [...edges] };
    setDragging(true);
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const d = dragRef.current;
    if (!d || n < 2) return;
    const v = velFromClientX(e.clientX);
    const base = d.startEdges;
    const next = d.kind === 'div'
      ? moveDivider(base, d.index, v)
      : moveSegment(base, d.index, v - d.startVel);
    applyEdges(next);
  }

  function endDrag(e?: ReactPointerEvent) {
    if (e && trackRef.current?.hasPointerCapture(e.pointerId)) trackRef.current.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setDragging(false);
  }

  function preset(list: number[]) {
    if (n < 2) return;
    if (list.length !== n - 1) return;
    onBeginEdit();
    applyEdges([0, ...list.map((v) => clamp(v, 1, 127)), 128]);
  }

  function equalize() {
    if (n < 2) return;
    onBeginEdit();
    applyEdges(equalEdges(n));
  }

  function stretchEnds() {
    if (n < 2) return;
    onBeginEdit();
    applyEdges(stretchEdges(edges));
  }

  function applyCustom() {
    const list = customText.split(/[^0-9]+/).filter(Boolean).map(Number);
    if (list.length !== n - 1) return;
    preset(list);
  }

  const pct = (v: number) => `${(v / 128) * 100}%`;
  const presets = n === 2 ? [{ label: '2 partes · 64', v: [64] }]
    : n === 3 ? [{ label: '3 partes · 42 / 84', v: [42, 84] }]
      : n === 4 ? [{ label: '4 partes · 10 / 48 / 81', v: [10, 48, 81] }, { label: '4 partes · 32 / 64 / 96', v: [32, 64, 96] }]
        : [];

  return (
    <div className="vse">
      <div className="vse-head">
        <span className="vse-title"><SlidersHorizontal size={13} /> Divisórias de Velocity</span>
        <label className="vse-set">
          Conjunto de camadas:
          <select value={active?.key ?? ''} onChange={(e) => onActiveSetChange(e.target.value)}>
            {sets.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label className="vse-check">
          <input type="checkbox" checked={applyAll} onChange={(e) => onApplyAllChange(e.target.checked)} />
          Aplicar a todos os conjuntos ({targetSets.length}/{sets.length})
        </label>
        <span className="vse-grow" />
        <span className="vse-hint"><Info size={11} /> Arraste uma divisória para mudar as faixas das amostras em tempo real</span>
        <button className="zm-close" onClick={onClose} title="Fechar painel"><X size={15} /></button>
      </div>

      <div
        ref={trackRef}
        className={`vse-track ${dragging ? 'dragging' : ''}`}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => endDrag(e)}
        onPointerCancel={(e) => endDrag(e)}
      >
        {/* buracos (sem amostra) nas pontas */}
        {edges[0] > 0 && <div className="vse-hole" style={{ left: 0, width: pct(edges[0]) }} title={`Sem amostra de 0 a ${edges[0] - 1}`} />}
        {edges[n] < 128 && <div className="vse-hole" style={{ left: pct(edges[n]), width: pct(128 - edges[n]) }} title={`Sem amostra de ${edges[n]} a 127`} />}

        {zones.map((z, i) => {
          const lo = edges[i];
          const hiExclusive = edges[i + 1];
          const sel = selectedKeys.has(z.key);
          return (
            <div
              key={z.key}
              className={`vse-seg ${sel ? 'sel' : ''}`}
              style={{ left: pct(lo), width: pct(Math.max(1, hiExclusive - lo)), background: LAYER_COLORS[i % LAYER_COLORS.length] }}
              title={`Parte ${i + 1}: ${z.sampleId}\nVelocity ${lo}–${hiExclusive - 1}\nArraste o corpo para mover a camada · duplo clique abre a onda`}
              onPointerDown={(e) => {
                onSelectZone(z.key);
                // Clicou perto de uma divisória (mesmo dentro da faixa)?
                // pega a DIVISÓRIA em vez de mover a camada inteira —
                // facilita "clicar aqui e mover a linha da região".
                const rect = trackRef.current?.getBoundingClientRect();
                const vel = rect && rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * 128 : 0;
                let near: number | null = null;
                let best = Infinity;
                for (let j = 1; j < n; j += 1) {
                  const d = Math.abs(edges[j] - vel);
                  if (d < best) { best = d; near = j; }
                }
                if (near !== null && best <= 4) beginDrag(e, 'div', near);
                else beginDrag(e, 'seg', i);
              }}
              onDoubleClick={(e) => { e.stopPropagation(); onOpenWave(z.key); }}
            >
              <span className="vse-seg-num">{i + 1}</span>
              <span className="vse-seg-range">{lo}–{hiExclusive - 1}</span>
            </div>
          );
        })}

        {/* régua 0..127 */}
        {[0, 16, 32, 48, 64, 80, 96, 112, 127].map((v) => (
          <span key={v} className="vse-tick" style={{ left: pct(v) }}>{v}</span>
        ))}

        {/* alças das divisórias internas */}
        {edges.slice(1, n).map((v, idx) => (
          <div
            key={`div-${idx}`}
            className="vse-div"
            style={{ left: pct(v) }}
            title={`Divisória em ${v} — arraste para ajustar`}
            onPointerDown={(e) => beginDrag(e, 'div', idx + 1)}
          >
            <span className="vse-div-num">{v}</span>
            <span className="vse-div-grip" />
          </div>
        ))}
      </div>

      <div className="vse-parts">
        {zones.map((z, i) => (
          <button
            key={z.key}
            className={`vse-part ${selectedKeys.has(z.key) ? 'sel' : ''}`}
            onClick={() => onSelectZone(z.key)}
            onDoubleClick={() => onOpenWave(z.key)}
            title={`${z.sampleId} · velocity ${edges[i]}–${edges[i + 1] - 1}`}
          >
            <span className="vse-part-num" style={{ background: LAYER_COLORS[i % LAYER_COLORS.length] }}>{i + 1}</span>
            <span className="vse-part-range">{edges[i]}–{edges[i + 1] - 1}</span>
            <span className="vse-part-name">{z.sampleId}</span>
          </button>
        ))}
      </div>

      <div className="vse-tools">
        <button className="zm-tbtn" onClick={equalize} title="Divide 0–127 em partes iguais"><AlignVerticalDistributeCenter size={12} /> Distribuir igualmente</button>
        <button className="zm-tbtn" onClick={stretchEnds} title="Faz a primeira parte começar em 0 e a última terminar em 127">Esticar pontas 0–127</button>
        {presets.map((p) => <button key={p.label} className="zm-tbtn" onClick={() => preset(p.v)}>{p.label}</button>)}
        <span className="vse-grow" />
        <span className="vse-custom">
          Divisórias exatas:
          <input
            value={customText}
            placeholder={n === 4 ? '10, 48, 81' : Array.from({ length: Math.max(0, n - 1) }, (_, i) => Math.round(((i + 1) * 128) / n)).join(', ')}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyCustom(); }}
          />
          <button className="zm-tbtn" onClick={applyCustom} disabled={customText.trim() === ''}>Aplicar</button>
        </span>
        <span className="vse-footnote">{n} parte(s) · {targetSets.length} conjunto(s) afetado(s)</span>
        <div className="vse-note">
          <Info size={11} />
          <span>
            O número da divisória é o <b>início</b> da parte seguinte — as faixas não se sobrepõem (como no Kontakt):
            divisórias <b>10 / 48 / 81</b> → parte 1 = 0–9, parte 2 = 10–47, parte 3 = 48–80, parte 4 = 81–127.
            Arraste o <b>corpo</b> de uma parte para deslocar a camada inteira; áreas cinzas = buracos sem amostra.
          </span>
        </div>
      </div>
    </div>
  );
}
