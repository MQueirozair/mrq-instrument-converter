/**
 * Editor de Mapeamento — clone funcional do "Mapping Editor" do Kontakt
 * (ver docs/mrq-instrument-converter/mrq-mapping-editor.md para a pesquisa
 * detalhada de cada recurso do original e o que é/não é representável no
 * formato .mrq de hoje).
 *
 * Layout (igual à referência): duas fileiras de controle no topo, barra de
 * status com os parâmetros da zona selecionada, grade bidimensional
 * (teclado no eixo X, velocity 0..127 no eixo Y) com as ZONAS desenhadas
 * como retângulos, teclado clicável embaixo com a nota-raiz em amarelo,
 * painel de grupos à esquerda e List View (planilha) alternativa.
 *
 * Tudo que o Kontakt permite fazer na grade está aqui: selecionar (clique,
 * Shift, laço), mover zona, arrastar bordas (faixa de tecla / faixa de
 * velocity), arrastar a nota-raiz no teclado, atalhos de teclado Ctrl/Shift
 * + setas, Auto-Spread (tecla / via root / velocity), Resolve Overlaps,
 * Auto-Map por nome de arquivo, mover root keys em lote, Solo, Selected
 * Groups Only, Auto Select Group, Lock Zones, Set Key/Velocity Range via
 * MIDI, Select Zone via MIDI, copiar/colar/excluir/trocar amostra, zoom e
 * desfazer/refazer.
 *
 * PRÉ-ESCUTA REAL COM CONTROLADOR USB: `onRackRawMidiNote` entrega nota +
 * velocity do Web MIDI (o mesmo roteador do Rack, sem abrir uma segunda
 * conexão MIDI). Ao tocar uma nota, procura-se a(s) zona(s) que cobrem
 * nota/velocity e toca-se o PCM REAL da amostra — extraído do .mrq já
 * convertido por `mrqExtractSample`, ou decodificado do arquivo de áudio de
 * origem (WAV/AIFF/FLAC/MP3/OGG) por `readFileBytes` + decodeAudioData.
 * A amostra é transposta pela nota-raiz, ajustada por tuneCents/volumeDb/pan
 * e respeita loop. Quando nenhum áudio real está disponível (bancos SF2/SF3
 * etc. ainda não convertidos), a pré-escuta cai num tom de referência e a
 * tela diz isso explicitamente — nunca finge que é o timbre original.
 *
 * HONESTIDADE SOBRE PERSISTÊNCIA: as edições são salvas pela prop `onSave`
 * (o item da fila guarda `editedInstrument`). Só .syx/.exs usam o modelo
 * editado na conversão de hoje; para os demais formatos a conversão roda
 * num comando Rust opaco que reconstrói o mapeamento do arquivo original.
 * O banner `persistNote` (vindo de InstrumentConverter) deixa isso claro.
 * X-Fades são MARKERS VISUAIS locais: o MrqZone atual não tem campo pra
 * isso, então são mostrados na grade/planilha mas não entram no .mrq.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ArrowLeftRight,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  Headphones,
  Info,
  Keyboard as KeyboardIcon,
  Layers,
  List,
  Lock,
  Maximize2,
  MoveHorizontal,
  MoveVertical,
  Music2,
  Play,
  Radio,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Unlock,
  Usb,
  Volume2,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { MrqGroup, MrqInstrumentModel, MrqPreset, MrqZone } from '../audio/rack/mrqFormat';
import { mrqDecodedSampleToAudioBuffer, mrqExtractSample } from '../audio/rack/mrqFormat';
import { midiNoteName, noteNameToMidi } from '../audio/rack/midiNoteNames';
import { readFileBytes } from '../audio/rack/converterFormats';
import { computePeaks } from '../audio/waveform';
import VelocitySplitEditor, { type VelocitySplitPatch, type VelocitySplitSet } from './VelocitySplitEditor';
import {
  initRackMidi,
  isRackMidiSupported,
  listRackMidiInputs,
  onRackMidiDevicesChanged,
  onRackRawMidiNote,
  setRackMidiInput,
} from '../midi/rackMidiRouter';

/** Fonte de áudio real pra pré-escuta. `null` = só tom de referência. */
export interface MappingEditorPlaybackSource {
  kind: 'mrq' | 'audio-file';
  path: string;
}

export interface MappingEditorProps {
  fileName: string;
  formatLabel: string;
  instrument: MrqInstrumentModel;
  canPersist: boolean;
  persistNote: string;
  onClose: () => void;
  onSave: (edited: MrqInstrumentModel) => void;
  playbackSource?: MappingEditorPlaybackSource | null;
}

interface ZoneRef {
  key: string;
  presetIdx: number;
  groupIdx: number;
  zoneIdx: number;
  preset: MrqPreset;
  group: MrqGroup;
  zone: MrqZone;
}

type DragKind = 'move' | 'left' | 'right' | 'top' | 'bottom' | 'root' | 'lasso';
interface DragState {
  kind: DragKind;
  keys: string[];
  startNote: number;
  startVel: number;
  startX: number;
  startY: number;
  /** snapshot dos valores originais das zonas no início do arraste */
  originals: Map<string, MrqZone>;
  lasso?: { x: number; y: number; w: number; h: number };
}

interface Voice {
  node: AudioBufferSourceNode | OscillatorNode;
  gain: GainNode;
}

const NOTE_LO = 0;
const NOTE_HI = 127;
const KEY_W_BASE = 13;
const VEL_H_BASE = 272;
const PIANO_H = 52;
const EDGE_PX = 6;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function cloneModel(m: MrqInstrumentModel): MrqInstrumentModel {
  return JSON.parse(JSON.stringify(m)) as MrqInstrumentModel;
}
function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
function isWhiteKey(note: number): boolean {
  return ![1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
}
function noteLabel(note: number): string {
  return midiNoteName(clamp(note, 0, 127));
}
/** Aceita nome de nota ("C3", "A#-1") ou número MIDI puro. */
function parseNoteField(raw: string, fallback: number): number {
  const t = raw.trim();
  if (/^-?\d+$/.test(t)) return clamp(Number(t), 0, 127);
  const parsed = noteNameToMidi(t);
  return parsed === null ? fallback : parsed;
}

/** Extrai nota/velocity de nomes de amostra (Auto-Map do Kontakt). */
function autoMapFromName(sampleId: string): Partial<MrqZone> {
  const tokens = sampleId.split(/[^A-Za-z0-9#-]+/).filter(Boolean);
  let root: number | null = null;
  let loKey: number | null = null;
  let hiKey: number | null = null;
  for (const tok of tokens) {
    const range = /^([A-Ga-g][#bs]?-?\d{1,2})[-_]([A-Ga-g][#bs]?-?\d{1,2})$/.exec(tok);
    if (range) {
      const a = noteNameToMidi(range[1]);
      const b = noteNameToMidi(range[2]);
      if (a !== null && b !== null) {
        loKey = Math.min(a, b);
        hiKey = Math.max(a, b);
        if (root === null) root = a;
      }
      continue;
    }
    const n = noteNameToMidi(tok);
    if (n !== null && root === null) root = n;
  }
  let loVel: number | null = null;
  let hiVel: number | null = null;
  const velPair = /(?:^|[^0-9])(?:v|vel|velocity)?[-_]?(\d{1,3})[-_](\d{1,3})(?:$|[^0-9])/i.exec(sampleId);
  if (velPair) {
    const a = clamp(Number(velPair[1]), 0, 127);
    const b = clamp(Number(velPair[2]), 0, 127);
    loVel = Math.min(a, b);
    hiVel = Math.max(a, b);
  } else {
    const dyn = /(?:^|[^a-z])(ppp|pp|p|mp|mf|f|ff|fff)(?:$|[^a-z])/i.exec(sampleId);
    if (dyn) {
      const table: Record<string, [number, number]> = {
        ppp: [1, 30], pp: [1, 50], p: [1, 64], mp: [45, 85], mf: [65, 100], f: [90, 120], ff: [105, 127], fff: [115, 127],
      };
      const r = table[dyn[1].toLowerCase()];
      if (r) [loVel, hiVel] = r;
    }
  }
  const patch: Partial<MrqZone> = {};
  if (root !== null) {
    patch.rootNote = root;
    patch.loKey = loKey ?? root;
    patch.hiKey = hiKey ?? root;
  } else if (loKey !== null && hiKey !== null) {
    patch.loKey = loKey;
    patch.hiKey = hiKey;
    patch.rootNote = loKey;
  }
  if (loVel !== null && hiVel !== null) {
    patch.loVel = loVel;
    patch.hiVel = hiVel;
  }
  return patch;
}

/** Campo editável da List View: só confirma no Enter/blur (não dispara
 *  histórico a cada tecla) e aceita tanto nome de nota quanto número. */
function CellInput({
  value, parse, onCommit, width = 44,
}: {
  value: string;
  parse: (raw: string) => number;
  onCommit: (n: number) => void;
  width?: number;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="zm-cell-input"
      style={{ width }}
      value={text}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onBlur={() => {
        const n = parse(text);
        if (Number.isFinite(n)) onCommit(n);
        else setText(value);
      }}
    />
  );
}

export default function MappingEditor({
  fileName,
  formatLabel,
  instrument,
  canPersist,
  persistNote,
  onClose,
  onSave,
  playbackSource = null,
}: MappingEditorProps) {
  const original = useMemo(() => instrument, [instrument]);
  const [model, setModel] = useState<MrqInstrumentModel>(() => cloneModel(instrument));
  const [dirty, setDirty] = useState(false);
  const [past, setPast] = useState<MrqInstrumentModel[]>([]);
  const [future, setFuture] = useState<MrqInstrumentModel[]>([]);
  const [presetIdx, setPresetIdx] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [hiddenGroups, setHiddenGroups] = useState<Set<number>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [listView, setListView] = useState(false);
  const [leftView, setLeftView] = useState(true);
  const [zoomX, setZoomX] = useState(1);
  const [zoomY, setZoomY] = useState(1);
  const [lockZones, setLockZones] = useState(false);
  const [autoMoveRoot, setAutoMoveRoot] = useState(false);
  const [zoneSolo, setZoneSolo] = useState(false);
  const [selectedGroupsOnly, setSelectedGroupsOnly] = useState(false);
  const [autoSelGroup, setAutoSelGroup] = useState(false);
  const [midiTool, setMidiTool] = useState<'key' | 'vel' | null>(null);
  const [midiPending, setMidiPending] = useState<number[]>([]);
  const [selectViaMidi, setSelectViaMidi] = useState(false);
  const [xfades, setXfades] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [activeNotes, setActiveNotes] = useState<Map<number, number>>(new Map());
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set());
  const [waveZoneKey, setWaveZoneKey] = useState<string | null>(null);
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [onScreenVel, setOnScreenVel] = useState(100);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitSetKey, setSplitSetKey] = useState<string | null>(null);
  const [splitApplyAll, setSplitApplyAll] = useState(true);

  const [midiInputs, setMidiInputs] = useState<{ id: string; name: string }[]>([]);
  const [midiInputId, setMidiInputId] = useState<string>('');
  const [midiReady, setMidiReady] = useState(false);
  const [audioKind, setAudioKind] = useState<'real' | 'synth' | 'loading'>('loading');

  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const clipboardRef = useRef<MrqZone[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Map<string, AudioBuffer | null>>(new Map());
  const voicesRef = useRef<Map<number, Voice[]>>(new Map());
  const noticeTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const handlersRef = useRef<{
    dragMove: (x: number, y: number) => void;
    dragEnd: () => void;
    keyDown: (e: KeyboardEvent) => void;
    noteOn: (note: number, velocity: number, channel: number) => void;
    noteOff: (note: number) => void;
  } | null>(null);

  const keyW = KEY_W_BASE * zoomX;
  const gridW = 128 * keyW;
  const velH = VEL_H_BASE * zoomY;

  const preset = model.presets[presetIdx] as MrqPreset | undefined;

  const allZoneRefs: ZoneRef[] = useMemo(() => {
    if (!preset) return [];
    const out: ZoneRef[] = [];
    preset.groups.forEach((group, groupIdx) => {
      group.zones.forEach((zone, zoneIdx) => {
        out.push({
          key: `${presetIdx}::${groupIdx}::${zoneIdx}`,
          presetIdx, groupIdx, zoneIdx, preset, group, zone,
        });
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, presetIdx, model]);

  const zoneRefs = useMemo(
    () => allZoneRefs.filter((z) => !hiddenGroups.has(z.groupIdx) && (!selectedGroupsOnly || selectedKeys.size === 0 || [...selectedKeys].some((k) => allZoneRefs.find((a) => a.key === k)?.groupIdx === z.groupIdx))),
    [allZoneRefs, hiddenGroups, selectedGroupsOnly, selectedKeys]
  );
  const primary = allZoneRefs.find((z) => selectedKeys.has(z.key)) ?? null;
  const selectedRefs = allZoneRefs.filter((z) => selectedKeys.has(z.key));
  const waveZone = allZoneRefs.find((z) => z.key === waveZoneKey) ?? null;

  /** Conjuntos de camadas de velocity: zonas que compartilham o MESMO grupo
   *  e a MESMA faixa de teclas. Cada conjunto é uma "pilha" de amostras que
   *  se dividem por velocity (ex.: piano com 4 dinâmicas em cada região).
   *  Só conjuntos com 2+ zonas aparecem no editor de divisórias. */
  const splitSets: VelocitySplitSet[] = useMemo(() => {
    const buckets = new Map<string, ZoneRef[]>();
    zoneRefs.forEach((r) => {
      const k = `${r.groupIdx}::${r.zone.loKey}::${r.zone.hiKey}`;
      buckets.set(k, [...(buckets.get(k) ?? []), r]);
    });
    return [...buckets.entries()]
      .filter(([, refs]) => refs.length >= 2)
      .map(([k, refs]) => {
        const sorted = [...refs].sort((a, b) => a.zone.loVel - b.zone.loVel || a.zone.loKey - b.zone.loKey);
        return {
          key: k,
          label: `${sorted[0].group.name} · ${noteLabel(sorted[0].zone.loKey)}–${noteLabel(sorted[0].zone.hiKey)} (${sorted.length} amostras)`,
          zones: sorted.map((r) => ({
            key: r.key,
            sampleId: r.zone.sampleId,
            loVel: r.zone.loVel,
            hiVel: r.zone.hiVel,
            loKey: r.zone.loKey,
            hiKey: r.zone.hiKey,
            groupIdx: r.groupIdx,
            groupName: r.group.name,
          })),
        };
      })
      .sort((a, b) => b.zones.length - a.zones.length || a.label.localeCompare(b.label));
  }, [zoneRefs]);

  const defaultSplitSetKey = useMemo(() => {
    const withSelection = splitSets.find((s) => s.zones.some((z) => selectedKeys.has(z.key)));
    return withSelection?.key ?? splitSets[0]?.key ?? null;
  }, [splitSets, selectedKeys]);

  function applySplitPatches(patches: VelocitySplitPatch[]) {
    const map = new Map<string, Partial<MrqZone>>();
    patches.forEach((p) => map.set(p.key, { loVel: p.loVel, hiVel: p.hiVel }));
    applyPatches(map, false);
  }

  function notify(msg: string) {
    setNotice(msg);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3600);
  }

  function pushHistory() {
    setPast((p) => [...p.slice(-29), cloneModel(model)]);
    setFuture([]);
  }

  function applyPatches(patches: Map<string, Partial<MrqZone>>, withHistory = true) {
    if (patches.size === 0) return;
    if (withHistory) pushHistory();
    setModel((prev) => {
      const next = cloneModel(prev);
      patches.forEach((patch, key) => {
        const [pi, gi, zi] = key.split('::').map(Number);
        const zone = next.presets[pi]?.groups[gi]?.zones[zi];
        if (zone) Object.assign(zone, patch);
      });
      return next;
    });
    setDirty(true);
  }

  function patchSelected(patch: (z: MrqZone) => Partial<MrqZone>, refs: ZoneRef[] = selectedRefs, withHistory = true) {
    const map = new Map<string, Partial<MrqZone>>();
    refs.forEach((r) => map.set(r.key, patch(r.zone)));
    applyPatches(map, withHistory);
  }

  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setFuture((f) => [cloneModel(model), ...f].slice(0, 30));
    setPast((p) => p.slice(0, -1));
    setModel(prev);
    setDirty(true);
  }
  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p.slice(-29), cloneModel(model)]);
    setFuture((f) => f.slice(1));
    setModel(next);
    setDirty(true);
  }
  function resetAll() {
    pushHistory();
    setModel(cloneModel(original));
    setSelectedKeys(new Set());
    setDirty(false);
    notify('Mapeamento restaurado ao original.');
  }

  function selectZones(keys: string[], additive = false) {
    setSelectedKeys((prev) => {
      if (!additive) return new Set(keys);
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  }

  // -------------------------- grade: coordenadas --------------------------
  function pointFromClient(clientX: number, clientY: number) {
    const r = gridRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  }
  function noteAtX(x: number) {
    return clamp(Math.floor(x / keyW), 0, 127);
  }
  function velAtY(y: number) {
    return clamp(127 - Math.round((y / velH) * 127), 0, 127);
  }

  function beginDrag(e: ReactMouseEvent, kind: DragKind, ref?: ZoneRef) {
    if (kind !== 'lasso' && (!ref || (lockZones && kind !== 'root'))) {
      if (lockZones && kind !== 'root') notify('Zonas travadas — desative "Travar zonas" para editar pela grade.');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const p = pointFromClient(e.clientX, e.clientY);
    let keys: string[] = [];
    if (kind === 'lasso') {
      dragRef.current = {
        kind, keys: [], startNote: 0, startVel: 0,
        startX: p.x, startY: p.y, originals: new Map(),
        lasso: { x: p.x, y: p.y, w: 0, h: 0 },
      };
      if (!e.shiftKey) selectZones([]);
      return;
    }
    if (!ref) return;
    if (kind === 'root') {
      keys = [ref.key];
      selectZones([ref.key], false);
    } else {
      if (selectedKeys.has(ref.key)) keys = [...selectedKeys];
      else {
        keys = [ref.key];
        selectZones([ref.key], e.shiftKey);
      }
    }
    const originals = new Map<string, MrqZone>();
    allZoneRefs.filter((z) => keys.includes(z.key)).forEach((z) => originals.set(z.key, { ...z.zone }));
    pushHistory();
    dragRef.current = {
      kind, keys,
      startNote: p.x / keyW,
      startVel: 127 - (p.y / velH) * 127,
      startX: p.x, startY: p.y, originals,
    };
  }

  function handleDragMove(clientX: number, clientY: number) {
    const d = dragRef.current;
    if (!d) return;
    const p = pointFromClient(clientX, clientY);
    if (d.kind === 'lasso') {
      d.lasso = {
        x: Math.min(d.startX, p.x), y: Math.min(d.startY, p.y),
        w: Math.abs(p.x - d.startX), h: Math.abs(p.y - d.startY),
      };
      // força re-render do retângulo de seleção
      setLassoRect({ ...d.lasso });
      return;
    }
    const noteNow = p.x / keyW;
    const velNow = 127 - (p.y / velH) * 127;
    const dNote = Math.round(noteNow - d.startNote);
    const dVel = Math.round(velNow - d.startVel);
    const patches = new Map<string, Partial<MrqZone>>();
    d.originals.forEach((o, key) => {
      switch (d.kind) {
        case 'move': {
          const width = o.hiKey - o.loKey;
          const lo = clamp(o.loKey + dNote, 0, 127 - width);
          const height = o.hiVel - o.loVel;
          const loV = clamp(o.loVel + dVel, 0, 127 - height);
          patches.set(key, {
            loKey: lo, hiKey: lo + width, loVel: loV, hiVel: loV + height,
            ...(autoMoveRoot ? { rootNote: clamp(o.rootNote + dNote, 0, 127) } : {}),
          });
          break;
        }
        case 'left':
          patches.set(key, { loKey: clamp(noteAtX(p.x), 0, o.hiKey), hiKey: o.hiKey });
          break;
        case 'right':
          patches.set(key, { loKey: o.loKey, hiKey: clamp(noteAtX(p.x), o.loKey, 127) });
          break;
        case 'top':
          patches.set(key, { hiVel: clamp(velAtY(p.y), o.loVel, 127), loVel: o.loVel });
          break;
        case 'bottom':
          patches.set(key, { loVel: clamp(velAtY(p.y), 0, o.hiVel), hiVel: o.hiVel });
          break;
        case 'root':
          patches.set(key, { rootNote: noteAtX(p.x) });
          break;
        default:
          break;
      }
    });
    applyPatches(patches, false);
  }

  function handleDragEnd() {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'lasso' && d.lasso && d.lasso.w > 3 && d.lasso.h > 3) {
      const r = d.lasso;
      const hits = zoneRefs.filter((z) => {
        const left = z.zone.loKey * keyW;
        const right = (z.zone.hiKey + 1) * keyW;
        const top = ((127 - z.zone.hiVel) / 128) * velH;
        const bottom = ((128 - z.zone.loVel) / 128) * velH;
        return left < r.x + r.w && right > r.x && top < r.y + r.h && bottom > r.y;
      }).map((z) => z.key);
      selectZones(hits);
      notify(`${hits.length} zona(s) selecionada(s) pelo laço.`);
    }
    dragRef.current = null;
    setLassoRect(null);
  }

  const [lassoRect, setLassoRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // ------------------------- ferramentas de lote -------------------------
  function toolTargets(): ZoneRef[] {
    return selectedRefs.length > 0 ? selectedRefs : zoneRefs;
  }

  function runTool(id: string) {
    setMenuOpen(false);
    if (id === 'vel-split') {
      if (splitSets.length === 0) { notify('Este instrumento não tem 2+ amostras na mesma faixa de teclas para dividir por velocity.'); return; }
      setSplitSetKey(defaultSplitSetKey);
      setSplitOpen(true);
      return;
    }
    const targets = toolTargets();
    if (targets.length === 0) {
      notify('Selecione ao menos uma zona.');
      return;
    }
    if (id === 'copy') {
      clipboardRef.current = targets.map((t) => ({ ...t.zone }));
      notify(`${targets.length} zona(s) copiada(s).`);
      return;
    }
    if (id === 'paste') {
      if (clipboardRef.current.length === 0) { notify('Área de transferência vazia.'); return; }
      pushHistory();
      setModel((prev) => {
        const next = cloneModel(prev);
        const g = next.presets[presetIdx]?.groups[targets[0].groupIdx];
        if (g) g.zones.push(...clipboardRef.current.map((z) => ({ ...z, loKey: clamp(z.loKey + 12, 0, 127), hiKey: clamp(z.hiKey + 12, 0, 127), rootNote: clamp(z.rootNote + 12, 0, 127) })));
        return next;
      });
      setDirty(true);
      notify('Zona(s) colada(s) +12 semitons no mesmo grupo.');
      return;
    }
    if (id === 'delete') {
      pushHistory();
      const byGroup = new Map<number, number[]>();
      targets.forEach((t) => byGroup.set(t.groupIdx, [...(byGroup.get(t.groupIdx) ?? []), t.zoneIdx]));
      setModel((prev) => {
        const next = cloneModel(prev);
        byGroup.forEach((idxs, gi) => {
          const g = next.presets[presetIdx]?.groups[gi];
          if (g) g.zones = g.zones.filter((_, i) => !idxs.includes(i));
        });
        return next;
      });
      setSelectedKeys(new Set());
      setDirty(true);
      notify(`${targets.length} zona(s) excluída(s).`);
      return;
    }
    if (id === 'select-all') { selectZones(zoneRefs.map((z) => z.key)); return; }
    if (id === 'auto-move-root') { setAutoMoveRoot((v) => !v); return; }
    if (id === 'undo') { undo(); return; }
    if (id === 'redo') { redo(); return; }
    if (id === 'lock') { setLockZones((v) => !v); return; }
    if (id === 'exchange') { setExchangeOpen(true); return; }
    if (id === 'xfade-apply') {
      setXfades(new Set(targets.map((t) => t.key)));
      notify('X-Fades marcados nas zonas selecionadas (visual — o .mrq ainda não armazena crossfade).');
      return;
    }
    if (id === 'xfade-remove') { setXfades(new Set()); notify('X-Fades removidos.'); return; }
    if (id === 'root-lo' || id === 'root-center' || id === 'root-hi') {
      patchSelected((z) => ({ rootNote: id === 'root-lo' ? z.loKey : id === 'root-hi' ? z.hiKey : Math.round((z.loKey + z.hiKey) / 2) }), targets);
      notify('Notas-raiz movidas em lote.');
      return;
    }
    if (id === 'auto-map') {
      const map = new Map<string, Partial<MrqZone>>();
      targets.forEach((t) => {
        const p = autoMapFromName(t.zone.sampleId);
        if (Object.keys(p).length > 0) map.set(t.key, p);
      });
      applyPatches(map);
      notify(`Auto-Map: ${map.size} de ${targets.length} zona(s) tinham nota/velocity no nome.`);
      return;
    }
    const axisIsKey = id.startsWith('key');
    const sorted = [...targets].sort((a, b) =>
      axisIsKey ? a.zone.loKey - b.zone.loKey || a.zone.loVel - b.zone.loVel : a.zone.loVel - b.zone.loVel || a.zone.loKey - b.zone.loKey
    );
    const loOf = (z: MrqZone) => (axisIsKey ? z.loKey : z.loVel);
    const hiOf = (z: MrqZone) => (axisIsKey ? z.hiKey : z.hiVel);
    const map = new Map<string, Partial<MrqZone>>();
    if (id === 'key-spread' || id === 'key-spread-root' || id === 'vel-spread') {
      for (let i = 0; i < sorted.length; i += 1) {
        const z = sorted[i].zone;
        const prev = sorted[i - 1]?.zone;
        const next = sorted[i + 1]?.zone;
        let lo = loOf(z);
        let hi = hiOf(z);
        if (i > 0 && prev) {
          const boundary = id === 'key-spread-root'
            ? Math.floor((prev.rootNote + z.rootNote) / 2)
            : Math.floor((hiOf(prev) + loOf(z)) / 2);
          lo = clamp(boundary + 1, 0, 127);
        }
        if (i < sorted.length - 1 && next) {
          const boundary = id === 'key-spread-root'
            ? Math.floor((z.rootNote + next.rootNote) / 2)
            : Math.floor((hiOf(z) + loOf(next)) / 2);
          hi = clamp(boundary, 0, 127);
        }
        if (hi < lo) hi = lo;
        map.set(sorted[i].key, axisIsKey ? { loKey: lo ?? z.loKey, hiKey: hi ?? z.hiKey } : { loVel: lo ?? z.loVel, hiVel: hi ?? z.hiVel });
      }
      notify(id === 'key-spread-root' ? 'Faixas espalhadas pelos pontos médios entre notas-raiz.' : 'Buracos entre zonas preenchidos.');
    } else if (id === 'key-resolve' || id === 'vel-resolve') {
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const a = sorted[i].zone;
        const b = sorted[i + 1].zone;
        if (hiOf(a) >= loOf(b)) {
          const cut = Math.floor((hiOf(a) + loOf(b)) / 2);
          if (axisIsKey) {
            map.set(sorted[i].key, { hiKey: cut, loKey: a.loKey });
            map.set(sorted[i + 1].key, { loKey: cut + 1, hiKey: b.hiKey });
          } else {
            map.set(sorted[i].key, { hiVel: cut, loVel: a.loVel });
            map.set(sorted[i + 1].key, { loVel: cut + 1, hiVel: b.hiVel });
          }
        }
      }
      notify('Sobreposições cortadas no ponto médio.');
    }
    applyPatches(map);
  }

  // --------------------------- pré-escuta de áudio ---------------------------
  async function ensureAudio(): Promise<AudioContext | null> {
    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtxRef.current = new Ctor();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* precisa de gesto do usuário */ }
    }
    return ctx;
  }

  async function loadBuffer(ctx: AudioContext, sampleId: string): Promise<AudioBuffer | null> {
    if (buffersRef.current.has(sampleId)) return buffersRef.current.get(sampleId) ?? null;
    let buffer: AudioBuffer | null = null;
    try {
      if (playbackSource?.kind === 'mrq') {
        const decoded = await mrqExtractSample(playbackSource.path, sampleId);
        buffer = mrqDecodedSampleToAudioBuffer(ctx, decoded);
      } else if (playbackSource?.kind === 'audio-file') {
        const bytes = await readFileBytes(playbackSource.path);
        buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      }
    } catch (err) {
      console.warn('[mapping-editor] falha ao decodificar amostra', sampleId, err);
    }
    buffersRef.current.set(sampleId, buffer);
    setAudioKind(buffer ? 'real' : 'synth');
    return buffer;
  }

  function stopNote(note: number) {
    const list = voicesRef.current.get(note);
    if (!list) return;
    const ctx = audioCtxRef.current;
    list.forEach((v) => {
      try {
        if (ctx) v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
        v.node.stop((ctx?.currentTime ?? 0) + 0.12);
      } catch { /* já parado */ }
    });
    voicesRef.current.delete(note);
    setActiveNotes((prev) => { const n = new Map(prev); n.delete(note); return n; });
  }

  function playNote(note: number, velocity: number, channel = 1) {
    const st = handlersRef.current;
    if (!st) return;
    const candidates = zoneRefs.filter((z) => {
      if (hiddenGroups.has(z.groupIdx)) return false;
      if (zoneSolo && !selectedKeys.has(z.key)) return false;
      return note >= z.zone.loKey && note <= z.zone.hiKey && velocity >= z.zone.loVel && velocity <= z.zone.hiVel;
    });
    setActiveNotes((prev) => new Map(prev).set(note, velocity));
    if (candidates.length === 0) {
      notify(`${noteLabel(note)} · vel ${velocity}: nenhuma zona nesta região (buraco no mapeamento).`);
      return;
    }
    setFlashKeys(new Set(candidates.map((z) => z.key)));
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashKeys(new Set()), 260);
    if (selectViaMidi) {
      selectZones(candidates.map((z) => z.key));
      if (autoSelGroup) {
        const gi = candidates[0].groupIdx;
        setHiddenGroups(new Set(preset?.groups.map((_, i) => i).filter((i) => i !== gi) ?? []));
      }
    }
    void (async () => {
      const ctx = await ensureAudio();
      if (!ctx) return;
      for (const ref of candidates) {
        const z = ref.zone;
        const buffer = playbackSource ? await loadBuffer(ctx, z.sampleId) : null;
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner();
        const vol = Math.min(2, Math.max(0, Math.pow(10, z.volumeDb / 20) * (0.35 + 0.65 * (velocity / 127))));
        gain.gain.value = vol;
        panner.pan.value = clamp(z.pan, -1, 1);
        gain.connect(panner).connect(ctx.destination);
        let node: AudioBufferSourceNode | OscillatorNode;
        if (buffer) {
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.playbackRate.value = Math.pow(2, (note - z.rootNote + z.tuneCents / 100) / 12);
          if (z.loopEnabled && z.loopStart !== undefined && z.loopEnd !== undefined && z.loopEnd > z.loopStart) {
            src.loop = true;
            src.loopStart = z.loopStart / buffer.sampleRate;
            src.loopEnd = Math.min(buffer.duration, z.loopEnd / buffer.sampleRate);
          }
          node = src;
        } else {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = 440 * Math.pow(2, (note - 69 + z.tuneCents / 100) / 12);
          gain.gain.value = Math.min(0.18, vol * 0.16);
          node = osc;
        }
        node.connect(gain);
        node.start();
        const list = voicesRef.current.get(note) ?? [];
        list.push({ node, gain });
        voicesRef.current.set(note, list);
        node.onended = () => {
          const cur = voicesRef.current.get(note);
          if (cur) voicesRef.current.set(note, cur.filter((v) => v.node !== node));
        };
      }
      if (!playbackSource) setAudioKind('synth');
    })();
  }

  function handleMidiNoteOn(note: number, velocity: number, channel: number) {
    if (midiTool) {
      const next = [...midiPending, midiTool === 'key' ? note : velocity].slice(-2);
      setMidiPending(next);
      if (next.length === 2) {
        const lo = Math.min(next[0], next[1]);
        const hi = Math.max(next[0], next[1]);
        const refs = toolTargets();
        patchSelected(() => (midiTool === 'key' ? { loKey: lo, hiKey: hi } : { loVel: lo, hiVel: hi }), refs);
        notify(midiTool === 'key' ? `Faixa de tecla definida via MIDI: ${noteLabel(lo)}–${noteLabel(hi)}` : `Faixa de velocity definida via MIDI: ${lo}–${hi}`);
        setMidiTool(null);
        setMidiPending([]);
      } else {
        notify(`MIDI: aguardando a 2ª nota (1/2 recebida)…`);
      }
      return;
    }
    playNote(note, clamp(velocity, 1, 127), channel);
  }

  // ------------------------------ efeitos globais ------------------------------
  handlersRef.current = { dragMove: handleDragMove, dragEnd: handleDragEnd, keyDown: onKeyDown, noteOn: handleMidiNoteOn, noteOff: stopNote };

  useEffect(() => {
    const onMove = (e: MouseEvent) => handlersRef.current?.dragMove(e.clientX, e.clientY);
    const onUp = () => handlersRef.current?.dragEnd();
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      handlersRef.current?.keyDown(e);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
      voicesRef.current.forEach((_, note) => stopNote(note));
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) setMidiInputs(listRackMidiInputs()); };
    const offChanged = onRackMidiDevicesChanged(refresh);
    const offNote = onRackRawMidiNote((note, velocity, isOn, channel) => {
      if (isOn) handlersRef.current?.noteOn(note, velocity, channel);
      else handlersRef.current?.noteOff(note);
    });
    void initRackMidi().then((ok) => {
      if (!alive) return;
      setMidiReady(ok);
      refresh();
      setAudioKind(playbackSource ? 'real' : 'synth');
    });
    return () => { alive = false; offChanged(); offNote(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); selectZones(zoneRefs.map((z) => z.key)); return; }
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); runTool('copy'); return; }
    if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); runTool('paste'); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); runTool('delete'); return; }
    if (e.key === 'Escape') { setMenuOpen(false); setSelectedKeys(new Set()); return; }
    if (!ctrl || !e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1;
    const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    const step = horizontal ? 1 : 2;
    const refs = toolTargets();
    patchSelected((z) => {
      if (horizontal) {
        if (e.shiftKey) return { hiKey: clamp(z.hiKey + dir * step, z.loKey, 127) };
        const w = z.hiKey - z.loKey;
        const lo = clamp(z.loKey + dir * step, 0, 127 - w);
        return { loKey: lo, hiKey: lo + w, ...(autoMoveRoot ? { rootNote: clamp(z.rootNote + dir * step, 0, 127) } : {}) };
      }
      if (e.shiftKey) return { hiVel: clamp(z.hiVel + dir * step, z.loVel, 127) };
      const h = z.hiVel - z.loVel;
      const lo = clamp(z.loVel + dir * step, 0, 127 - h);
      return { loVel: lo, hiVel: lo + h };
    }, refs);
  }

  function applyStatusPatch(patch: Partial<MrqZone>) {
    patchSelected(() => patch);
  }

  // ------------------------------- renderização -------------------------------
  const statusZone = primary?.zone ?? null;
  const selectedCount = selectedKeys.size;

  function ToolButton({ active, onClick, title, icon, children }: { active?: boolean; onClick: () => void; title: string; icon: ReactNode; children?: ReactNode }) {
    return (
      <button className={`zm-tbtn ${active ? 'on' : ''}`} onClick={onClick} title={title}>
        {icon}<span>{children}</span>
      </button>
    );
  }
  function MenuItem({ id, label, hint, active }: { id: string; label: string; hint?: string; active?: boolean }) {
    return (
      <button className="zm-menu-item" onClick={() => runTool(id)} title={hint ?? label}>
        <span className="zm-menu-check">{active ? <Check size={12} /> : null}</span>
        {label}
      </button>
    );
  }

  return (
    <div className="zm-overlay">
      <div className="zm-panel">
        {/* ---------- cabeçalho ---------- */}
        <div className="zm-header">
          <div className="zm-header-title">
            <span className="zm-kontakt-badge">MAPEAMENTO</span>
            <strong>{fileName}</strong>
            <span className="zm-chip">{formatLabel}</span>
            <span className="zm-chip">{preset?.name ?? '—'}</span>
          </div>
          <div className="zm-header-actions">
            <button className="btn ghost small" onClick={resetAll} disabled={!dirty && past.length === 0} title="Voltar ao mapeamento original (com desfazer)"><RotateCcw size={13} /> Reverter</button>
            <button className="btn ghost small" onClick={undo} disabled={past.length === 0} title="Desfazer (Ctrl+Z)"><Undo2 size={13} /></button>
            <button className="btn ghost small" onClick={redo} disabled={future.length === 0} title="Refazer (Ctrl+Shift+Z)"><Redo2 size={13} /></button>
            <button className="btn primary small" onClick={() => { onSave(model); setDirty(false); notify('Mapeamento salvo no item da fila.'); }}><Save size={13} /> Salvar edições{dirty ? ' •' : ''}</button>
            <button className="zm-close" onClick={onClose} title="Fechar (Esc)"><X size={17} /></button>
          </div>
        </div>

        {/* ---------- fileira 1 de controles (Kontakt control strip) ---------- */}
        <div className="zm-strip">
          <div className="zm-menu-wrap">
            <button className={`zm-tbtn ${menuOpen ? 'on' : ''}`} onClick={() => setMenuOpen((v) => !v)} title="Menu Edit — todas as ferramentas de zona">
              <Settings2 size={13} /><span>Edit</span><ChevronDown size={11} />
            </button>
            {menuOpen && (
              <div className="zm-menu">
                <div className="zm-menu-group">ÁREA DE TRANSFERÊNCIA</div>
                <MenuItem id="copy" label="Copiar zona(s)" hint="Ctrl+C" />
                <MenuItem id="paste" label="Colar zona(s) (+12 semitons)" hint="Ctrl+V" />
                <MenuItem id="delete" label="Excluir zona(s)" hint="Delete" />
                <MenuItem id="select-all" label="Selecionar todas" hint="Ctrl+A" />
                <MenuItem id="exchange" label="Trocar amostra…" hint="Substitui a referência de sample mantendo as faixas" />
                <div className="zm-menu-group">AUTO-MAP / ESPALHAMENTO</div>
                <MenuItem id="auto-map" label="Auto-Map pelo nome do arquivo" hint="Lê nota, faixa e velocity de nomes como Piano_C3_v1-64.wav" />
                <MenuItem id="key-spread" label="Auto-Spread faixas de tecla" hint="Preenche buracos esticando até encostar no vizinho" />
                <MenuItem id="key-spread-root" label="Auto-Spread via Root Key" hint="Limites nos pontos médios entre notas-raiz" />
                <MenuItem id="vel-spread" label="Auto-Spread faixas de velocity" />
                <MenuItem id="key-resolve" label="Resolver sobreposições de tecla" />
                <MenuItem id="vel-resolve" label="Resolver sobreposições de velocity" />
                <MenuItem id="vel-split" label="Abrir divisórias de Velocity…" hint="Barra com alças arrastáveis 0–127 ligada às zonas reais" />
                <div className="zm-menu-group">OPÇÕES / LOTE</div>
                <MenuItem id="auto-move-root" label="Auto Move Root Key" active={autoMoveRoot} hint="Ao mover a zona, a nota-raiz acompanha" />
                <MenuItem id="root-lo" label="Mover root para borda grave" />
                <MenuItem id="root-center" label="Mover root para o centro" />
                <MenuItem id="root-hi" label="Mover root para borda aguda" />
                <MenuItem id="xfade-apply" label="Auto-Apply X-Fades (visual)" hint="Marca crossfade nas zonas; o .mrq ainda não armazena esse campo" />
                <MenuItem id="xfade-remove" label="Remover X-Fades" />
                <MenuItem id="lock" label="Travar zonas" active={lockZones} />
              </div>
            )}
          </div>
          <ToolButton onClick={() => runTool('auto-map')} title="Auto-Map: lê nota/velocity do nome da amostra" icon={<Wand2 size={13} />}>Auto</ToolButton>
          <ToolButton onClick={() => runTool('key-spread')} title="Auto-Spread Zone Key Ranges" icon={<AlignHorizontalDistributeCenter size={13} />}>Spread Key</ToolButton>
          <ToolButton onClick={() => runTool('key-spread-root')} title="Auto-Spread Key Ranges via Root Key" icon={<Crosshair size={13} />}>Root</ToolButton>
          <ToolButton onClick={() => runTool('vel-spread')} title="Auto-Spread Velocity Ranges" icon={<AlignVerticalDistributeCenter size={13} />}>Spread Vel</ToolButton>
          <span className="zm-strip-sep" />
          <ToolButton active={zoneSolo} onClick={() => setZoneSolo((v) => !v)} title="Zone Solo — só as zonas selecionadas tocam" icon={<Headphones size={13} />}>Zone Solo</ToolButton>
          <ToolButton active={selectedGroupsOnly} onClick={() => setSelectedGroupsOnly((v) => !v)} title="Selected Groups Only — mostra só os grupos das zonas selecionadas" icon={<Eye size={13} />}>Selected Groups Only</ToolButton>
          <ToolButton active={autoSelGroup} onClick={() => setAutoSelGroup((v) => !v)} title="Auto Select Group — ao tocar MIDI, isola o grupo da zona" icon={<Layers size={13} />}>Auto Sel Grp</ToolButton>
          <span className="zm-strip-grow" />
          <span className="zm-sample-label">Sample: <strong>{statusZone?.sampleId ?? '—'}</strong></span>
          <button className="zm-edit-wave" onClick={() => setWaveZoneKey(primary?.key ?? (zoneRefs[0]?.key ?? null))} title="Abrir forma de onda da amostra">EDIT</button>
        </div>

        {/* ---------- fileira 2 ---------- */}
        <div className="zm-strip second">
          <ToolButton active={leftView} onClick={() => setLeftView((v) => !v)} title="Left View — painel de grupos" icon={<ChevronRight size={13} />}>Left View</ToolButton>
          <ToolButton active={selectViaMidi} onClick={() => setSelectViaMidi((v) => !v)} title="Select Zone by MIDI — toque uma nota para selecionar a zona" icon={<Usb size={13} />}>Select Zone by MIDI</ToolButton>
          <ToolButton active={midiTool === 'key'} onClick={() => { setMidiTool(midiTool === 'key' ? null : 'key'); setMidiPending([]); }} title="Set Key Range via MIDI — toque duas notas para definir a faixa" icon={<ArrowLeftRight size={13} />}>Key via MIDI</ToolButton>
          <ToolButton active={midiTool === 'vel'} onClick={() => { setMidiTool(midiTool === 'vel' ? null : 'vel'); setMidiPending([]); }} title="Set Velocity Range via MIDI — toque duas notas; as velocities viram os limites" icon={<ArrowUpDown size={13} />}>Vel via MIDI</ToolButton>
          <ToolButton active={lockZones} onClick={() => setLockZones((v) => !v)} title="Lock Zones — protege contra arrastes na grade" icon={lockZones ? <Lock size={13} /> : <Unlock size={13} />}>Lock</ToolButton>
          <ToolButton active={listView} onClick={() => setListView((v) => !v)} title="List View — planilha de zonas" icon={listView ? <Music2 size={13} /> : <List size={13} />}>{listView ? 'Grid View' : 'List View'}</ToolButton>
          <ToolButton
            active={splitOpen}
            onClick={() => {
              if (splitOpen) setSplitOpen(false);
              else { setSplitSetKey(defaultSplitSetKey); setSplitOpen(true); }
            }}
            title="Divisórias de Velocity — arraste com o mouse para posicionar cada amostra entre 0 e 127"
            icon={<AlignVerticalDistributeCenter size={13} />}
          >Divisórias de Velocity</ToolButton>
          <span className="zm-strip-sep" />
          <div className="zm-midi-box">
            <Radio size={12} className={midiReady ? 'zm-midi-on' : ''} />
            <select
              value={midiInputId}
              onChange={(e) => { setMidiInputId(e.target.value); setRackMidiInput(e.target.value || null); }}
              title="Entrada MIDI USB usada para tocar as zonas"
            >
              <option value="">{midiReady ? `Todas as entradas (${midiInputs.length})` : isRackMidiSupported() ? 'MIDI: aguardando permissão…' : 'Web MIDI indisponível'}</option>
              {midiInputs.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <span className={`zm-audio-badge ${audioKind}`}>
              {audioKind === 'real' ? <Volume2 size={11} /> : <Info size={11} />}
              {audioKind === 'real' ? 'amostra real' : audioKind === 'synth' ? 'tom de referência' : '…'}
            </span>
            <button className="zm-icon-btn" onClick={() => void ensureAudio()} title="Ativar áudio (necessário após abrir a tela, por política do navegador)"><Play size={12} /></button>
          </div>
          <span className="zm-strip-grow" />
          <div className="zm-zoom">
            <button className="zm-icon-btn" onClick={() => setZoomX((v) => Math.max(0.55, +(v - 0.2).toFixed(2)))} title="Zoom horizontal −"><ZoomOut size={12} /></button>
            <span>{Math.round(zoomX * 100)}%</span>
            <button className="zm-icon-btn" onClick={() => setZoomX((v) => Math.min(2.6, +(v + 0.2).toFixed(2)))} title="Zoom horizontal +"><ZoomIn size={12} /></button>
            <button className="zm-icon-btn" onClick={() => setZoomY((v) => Math.min(2.2, +(v + 0.25).toFixed(2)))} title="Zoom vertical +"><Maximize2 size={12} /></button>
          </div>
        </div>

        {/* ---------- barra de status (parâmetros da zona) ---------- */}
        <div className="zm-statusbar">
          <span className="zm-status-field wide"><label>Key Range:</label>
            <input value={statusZone ? noteLabel(statusZone.loKey) : '—'} onChange={(e) => statusZone && applyStatusPatch({ loKey: Math.min(parseNoteField(e.target.value, statusZone.loKey), statusZone.hiKey) })} title="Tecla grave — aceita nome (C3) ou número MIDI" />
            <span>–</span>
            <input value={statusZone ? noteLabel(statusZone.hiKey) : '—'} onChange={(e) => statusZone && applyStatusPatch({ hiKey: Math.max(parseNoteField(e.target.value, statusZone.hiKey), statusZone.loKey) })} title="Tecla aguda" />
          </span>
          <span className="zm-status-field"><label>Vel Range:</label>
            <input type="number" min={0} max={127} value={statusZone?.loVel ?? 0} onChange={(e) => statusZone && applyStatusPatch({ loVel: clamp(Number(e.target.value), 0, statusZone.hiVel) })} />
            <span>–</span>
            <input type="number" min={0} max={127} value={statusZone?.hiVel ?? 127} onChange={(e) => statusZone && applyStatusPatch({ hiVel: clamp(Number(e.target.value), statusZone.loVel, 127) })} />
          </span>
          <span className="zm-status-field"><label>Root Key:</label>
            <input value={statusZone ? noteLabel(statusZone.rootNote) : '—'} onChange={(e) => statusZone && applyStatusPatch({ rootNote: parseNoteField(e.target.value, statusZone.rootNote) })} />
          </span>
          <span className="zm-status-field"><label>Volume:</label>
            <input type="number" step={0.1} value={statusZone?.volumeDb ?? 0} onChange={(e) => statusZone && applyStatusPatch({ volumeDb: clamp(Number(e.target.value), -96, 12) })} /><em>dB</em>
          </span>
          <span className="zm-status-field"><label>Pan:</label>
            <input type="number" step={0.01} value={statusZone?.pan ?? 0} onChange={(e) => statusZone && applyStatusPatch({ pan: Math.max(-1, Math.min(1, Number(e.target.value))) })} />
          </span>
          <span className="zm-status-field"><label>Tune:</label>
            <input type="number" step={1} value={statusZone?.tuneCents ?? 0} onChange={(e) => statusZone && applyStatusPatch({ tuneCents: clamp(Number(e.target.value), -2400, 2400) })} /><em>ct</em>
          </span>
          <span className="zm-status-count">{selectedCount > 1 ? `${selectedCount} zonas` : statusZone ? '1 zona' : 'nenhuma zona'}</span>
        </div>

        {/* ---------- banner de honestidade ---------- */}
        <div className={`zm-banner ${canPersist ? 'ok' : 'warn'}`}>
          {canPersist ? <Check size={12} /> : <Info size={12} />}
          <span>{persistNote}</span>
          <span className="zm-banner-extra">X-Fades são marcadores visuais (o .mrq não tem esse campo). Pré-escuta real exige o .mrq convertido ou arquivo de áudio de origem.</span>
        </div>

        {/* ---------- divisórias de velocity (barra arrastável 0–127) ---------- */}
        {splitOpen && (splitSets.length > 0 ? (
          <VelocitySplitEditor
            sets={splitSets}
            activeSetKey={splitSetKey ?? defaultSplitSetKey}
            onActiveSetChange={(k) => setSplitSetKey(k)}
            applyAll={splitApplyAll}
            onApplyAllChange={setSplitApplyAll}
            selectedKeys={selectedKeys}
            onBeginEdit={pushHistory}
            onApply={applySplitPatches}
            onSelectZone={(k) => selectZones([k])}
            onOpenWave={(k) => { setWaveZoneKey(k); notify('Forma de onda aberta abaixo.'); }}
            onClose={() => setSplitOpen(false)}
          />
        ) : (
          <div className="vse-empty">
            <Info size={13} /> Nenhum conjunto com 2+ amostras na mesma faixa de teclas. As divisórias de velocity aparecem quando há camadas empilhadas (ex.: piano com várias dinâmicas por nota).
            <button className="zm-close" onClick={() => setSplitOpen(false)}><X size={14} /></button>
          </div>
        ))}

        {/* ---------- corpo ---------- */}
        <div className="zm-body">
          {leftView && (
            <aside className="zm-groups">
              <div className="zm-groups-head"><Layers size={12} /> GRUPOS</div>
              <button className={`zm-group-row ${hiddenGroups.size === 0 ? 'active' : ''}`} onClick={() => { setHiddenGroups(new Set()); setSelectedGroupsOnly(false); }}>
                <Eye size={12} /> Todos <span className="zm-group-count">{preset?.groups.reduce((n, g) => n + g.zones.length, 0) ?? 0}</span>
              </button>
              {preset?.groups.map((g, i) => (
                <div key={g.id} className={`zm-group-row ${hiddenGroups.has(i) ? 'hidden' : ''} ${selectedRefs.some((z) => z.groupIdx === i) ? 'active' : ''}`}>
                  <button className="zm-group-eye" onClick={() => setHiddenGroups((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })} title={hiddenGroups.has(i) ? 'Mostrar grupo' : 'Ocultar grupo'}>
                    {hiddenGroups.has(i) ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button className="zm-group-name" onClick={() => selectZones(allZoneRefs.filter((z) => z.groupIdx === i).map((z) => z.key))}>
                    <span className="zm-swatch" style={{ background: `hsl(${hashHue(g.id)}, 58%, 52%)` }} />
                    {g.name}
                  </button>
                  <span className="zm-group-count">{g.zones.length}</span>
                </div>
              ))}
              <div className="zm-groups-foot">
                <p><strong>Arraste na grade:</strong> centro = mover · bordas esq/dir = teclas · bordas cima/baixo = velocity.</p>
                <p><strong>Shift+clique</strong> seleciona várias · arraste no vazio = laço · <strong>Ctrl+setas</strong> move · <strong>Ctrl+Shift+setas</strong> ajusta o limite.</p>
              </div>
            </aside>
          )}

          <div className="zm-main">
            {listView ? (
              <div className="zm-list-scroll">
                <table className="zm-list">
                  <thead><tr><th>#</th><th>Grupo</th><th>Amostra</th><th>Key Range</th><th>Vel Range</th><th>Root</th><th>Vol</th><th>Pan</th><th>Tune</th><th>XF</th></tr></thead>
                  <tbody>
                    {zoneRefs.map((r, i) => {
                      const z = r.zone;
                      const one = (patch: Partial<MrqZone>) => applyPatches(new Map([[r.key, patch]]));
                      return (
                        <tr key={r.key} className={selectedKeys.has(r.key) ? 'sel' : ''} onClick={() => selectZones([r.key])}>
                          <td>{i + 1}</td>
                          <td><span className="zm-swatch" style={{ background: `hsl(${hashHue(r.group.id)}, 58%, 52%)` }} /> {r.group.name}</td>
                          <td className="zm-list-sample" title={z.sampleId}>{z.sampleId}</td>
                          <td>
                            <CellInput value={noteLabel(z.loKey)} parse={(t) => parseNoteField(t, z.loKey)} onCommit={(n) => one({ loKey: Math.min(n, z.hiKey) })} width={44} />
                            <span className="zm-cell-sep">–</span>
                            <CellInput value={noteLabel(z.hiKey)} parse={(t) => parseNoteField(t, z.hiKey)} onCommit={(n) => one({ hiKey: Math.max(n, z.loKey) })} width={44} />
                          </td>
                          <td>
                            <CellInput value={String(z.loVel)} parse={(t) => clamp(Number(t), 0, z.hiVel)} onCommit={(n) => one({ loVel: n })} width={34} />
                            <span className="zm-cell-sep">–</span>
                            <CellInput value={String(z.hiVel)} parse={(t) => clamp(Number(t), z.loVel, 127)} onCommit={(n) => one({ hiVel: n })} width={34} />
                          </td>
                          <td><CellInput value={noteLabel(z.rootNote)} parse={(t) => parseNoteField(t, z.rootNote)} onCommit={(n) => one({ rootNote: n })} width={44} /></td>
                          <td><CellInput value={z.volumeDb.toFixed(1)} parse={(t) => clamp(Number(t), -96, 12)} onCommit={(n) => one({ volumeDb: n })} width={44} /></td>
                          <td><CellInput value={z.pan.toFixed(2)} parse={(t) => Math.max(-1, Math.min(1, Number(t)))} onCommit={(n) => one({ pan: n })} width={44} /></td>
                          <td><CellInput value={String(z.tuneCents)} parse={(t) => clamp(Number(t), -2400, 2400)} onCommit={(n) => one({ tuneCents: n })} width={44} /></td>
                          <td>{xfades.has(r.key) ? '✓' : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                <div className="zm-grid-scroll">
                  <div className="zm-grid-shell" style={{ width: gridW + 46 }}>
                    <div className="zm-vel-ruler" style={{ height: velH + PIANO_H + 2 }}>
                      {[127, 112, 96, 80, 64, 48, 32, 16, 0].map((v) => (
                        <span key={v} style={{ top: ((127 - v) / 128) * velH }}>{v}</span>
                      ))}
                    </div>
                    <div className="zm-grid-area">
                      <div
                        ref={gridRef}
                        className="zm-grid"
                        style={{ width: gridW, height: velH }}
                        onMouseDown={(e) => { if (e.target === e.currentTarget) beginDrag(e, 'lasso'); }}
                      >
                        {/* linhas de grade */}
                        <svg className="zm-grid-lines" width={gridW} height={velH}>
                          {Array.from({ length: 128 }, (_, n) => (
                            <line key={`v${n}`} x1={n * keyW} x2={n * keyW} y1={0} y2={velH} className={n % 12 === 0 ? 'octave' : ''} />
                          ))}
                          {[0, 16, 32, 48, 64, 80, 96, 112, 127].map((v) => (
                            <line key={`h${v}`} x1={0} x2={gridW} y1={((127 - v) / 128) * velH} y2={((127 - v) / 128) * velH} />
                          ))}
                          {/* coluna da nota tocada ao vivo */}
                          {[...activeNotes.keys()].map((n) => (
                            <rect key={`live${n}`} x={n * keyW} y={0} width={keyW} height={velH} className="zm-live-col" />
                          ))}
                        </svg>

                        {/* zonas */}
                        {zoneRefs.map((r) => {
                          const z = r.zone;
                          const left = z.loKey * keyW;
                          const width = Math.max(keyW * 0.8, (z.hiKey - z.loKey + 1) * keyW - 1);
                          const top = ((127 - z.hiVel) / 128) * velH;
                          const height = Math.max(9, ((z.hiVel - z.loVel + 1) / 128) * velH - 1);
                          const hue = hashHue(r.group.id);
                          const isSel = selectedKeys.has(r.key);
                          const dim = (zoneSolo && !isSel) || (selectedGroupsOnly && !selectedRefs.some((s) => s.groupIdx === r.groupIdx));
                          const flash = flashKeys.has(r.key);
                          const rootX = z.rootNote * keyW - left;
                          return (
                            <div
                              key={r.key}
                              className={`zm-zone ${isSel ? 'sel' : ''} ${dim ? 'dim' : ''} ${flash ? 'flash' : ''} ${xfades.has(r.key) ? 'xfade' : ''}`}
                              style={{
                                left, top, width, height,
                                background: isSel ? 'linear-gradient(180deg,#d8bb35,#a68a1d)' : `hsl(${hue}, 46%, 33%)`,
                                borderColor: isSel ? '#ffe27a' : `hsl(${hue}, 55%, 55%)`,
                              }}
                              onMouseDown={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const px = e.clientX - rect.left;
                                const py = e.clientY - rect.top;
                                let kind: DragKind = 'move';
                                if (py <= EDGE_PX) kind = 'top';
                                else if (py >= rect.height - EDGE_PX) kind = 'bottom';
                                else if (px <= EDGE_PX) kind = 'left';
                                else if (px >= rect.width - EDGE_PX) kind = 'right';
                                if (e.shiftKey && kind === 'move') { selectZones([r.key], true); return; }
                                beginDrag(e, kind, r);
                              }}
                              onDoubleClick={() => { setWaveZoneKey(r.key); notify(`Forma de onda: ${z.sampleId}`); }}
                              title={`${z.sampleId}\nTeclas ${noteLabel(z.loKey)}–${noteLabel(z.hiKey)} · Velocity ${z.loVel}–${z.hiVel} · Raiz ${noteLabel(z.rootNote)}\nDuplo clique = forma de onda`}
                            >
                              <span className="zm-zone-name">{z.sampleId}</span>
                              {rootX >= 0 && rootX <= width && <span className="zm-zone-root" style={{ left: rootX }} title={`Raiz ${noteLabel(z.rootNote)}`} />}
                              {xfades.has(r.key) && <span className="zm-zone-xf" />}
                            </div>
                          );
                        })}
                        {lassoRect && <div className="zm-lasso" style={{ left: lassoRect.x, top: lassoRect.y, width: lassoRect.w, height: lassoRect.h }} />}
                        {zoneRefs.length === 0 && <div className="zm-grid-empty">Nenhuma zona visível. Mostre um grupo na coluna à esquerda ou desative “Selected Groups Only”.</div>}
                      </div>

                      {/* teclado */}
                      <div className="zm-piano-scroll">
                        <svg width={gridW} height={PIANO_H} className="zm-piano">
                          {Array.from({ length: 128 }, (_, n) => isWhiteKey(n)).map((white, n) =>
                            white ? (
                              <rect key={`w${n}`} x={n * keyW} y={0} width={keyW - 1} height={PIANO_H} fill={activeNotes.has(n) ? '#ffe27a' : '#e8e9ea'} stroke="#15161a" strokeWidth={1} />
                            ) : null
                          )}
                          {primary && <rect x={primary.zone.rootNote * keyW} y={0} width={keyW - 1} height={PIANO_H} fill="#d9b521" opacity={0.92} className="zm-root-key" />}
                          {Array.from({ length: 128 }, (_, n) => !isWhiteKey(n)).map((black, n) =>
                            black ? (
                              <rect key={`b${n}`} x={n * keyW - keyW * 0.32} y={0} width={keyW * 0.64} height={PIANO_H * 0.62} fill={activeNotes.has(n) ? '#c8a12a' : '#101114'} stroke="#000" />
                            ) : null
                          )}
                          {Array.from({ length: 11 }, (_, oct) => (
                            <text key={`t${oct}`} x={oct * 12 * keyW + 2} y={PIANO_H - 4} fontSize={8} fill="#333">{noteLabel(oct * 12)}</text>
                          ))}
                        </svg>
                        {/* camada clicável + nota-raiz arrastável */}
                        <div className="zm-piano-hit" style={{ width: gridW, height: PIANO_H }}>
                          {Array.from({ length: 128 }, (_, n) => (
                            <div
                              key={n}
                              className="zm-piano-key"
                              style={{ left: n * keyW, width: keyW }}
                              onMouseDown={(e) => {
                                if (primary && e.shiftKey) { beginDrag(e, 'root', primary); return; }
                                playNote(n, onScreenVel);
                              }}
                              onMouseUp={() => stopNote(n)}
                              onMouseLeave={() => { if (activeNotes.has(n)) stopNote(n); }}
                              title={`${noteLabel(n)} — clique para tocar · Shift+arraste define a raiz`}
                            />
                          ))}
                          {primary && (
                            <div
                              className="zm-root-handle"
                              style={{ left: primary.zone.rootNote * keyW, width: Math.max(8, keyW) }}
                              onMouseDown={(e) => beginDrag(e, 'root', primary)}
                              title={`Nota-raiz ${noteLabel(primary.zone.rootNote)} — arraste horizontalmente para mudar (igual ao Kontakt)`}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="zm-grid-footer">
                  <span><KeyboardIcon size={12} /> Velocity do teclado na tela:
                    <input type="range" min={1} max={127} value={onScreenVel} onChange={(e) => setOnScreenVel(Number(e.target.value))} />
                    <strong>{onScreenVel}</strong>
                  </span>
                  <span className="zm-strip-grow" />
                  {midiTool && <span className="zm-midi-pending"><Radio size={12} /> Ouvindo MIDI: {midiPending.length}/2 notas — toque a {midiPending.length === 0 ? '1ª' : '2ª'} nota</span>}
                  {notice && <span className="zm-notice"><Info size={12} /> {notice}</span>}
                  <span className="zm-zone-count">{zoneRefs.length} zona(s) · {preset?.groups.length ?? 0} grupo(s)</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ---------- editor de forma de onda (duplo clique na zona) ---------- */}
        {waveZone && (
          <WavePanel
            zone={waveZone.zone}
            groupName={waveZone.group.name}
            playbackSource={playbackSource}
            buffersRef={buffersRef}
            ensureAudio={ensureAudio}
            loadBuffer={loadBuffer}
            onClose={() => setWaveZoneKey(null)}
          />
        )}

        {/* ---------- trocar amostra ---------- */}
        {exchangeOpen && (
          <div className="zm-mini-overlay" onClick={() => setExchangeOpen(false)}>
            <div className="zm-mini" onClick={(e) => e.stopPropagation()}>
              <strong>Trocar amostra das {selectedRefs.length} zona(s)</strong>
              <p>As faixas de tecla/velocity e os demais parâmetros são mantidos; só a referência <code>sampleId</code> muda.</p>
              <div className="zm-mini-list">
                {[...new Set(allZoneRefs.map((z) => z.zone.sampleId))].slice(0, 60).map((id) => (
                  <button key={id} onClick={() => {
                    patchSelected(() => ({ sampleId: id }));
                    buffersRef.current.delete(id);
                    setExchangeOpen(false);
                    notify(`Amostra trocada para ${id}.`);
                  }}>{id}</button>
                ))}
              </div>
              <button className="btn ghost small" onClick={() => setExchangeOpen(false)}>Cancelar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Painel de forma de onda da amostra (equivalente ao Wave Editor do Kontakt). */
function WavePanel({
  zone, groupName, playbackSource, buffersRef, ensureAudio, loadBuffer, onClose,
}: {
  zone: MrqZone;
  groupName: string;
  playbackSource: MappingEditorPlaybackSource | null;
  buffersRef: React.MutableRefObject<Map<string, AudioBuffer | null>>;
  ensureAudio: () => Promise<AudioContext | null>;
  loadBuffer: (ctx: AudioContext, sampleId: string) => Promise<AudioBuffer | null>;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [info, setInfo] = useState<string>('Carregando…');
  const [playing, setPlaying] = useState(false);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ctx = await ensureAudio();
      if (!ctx) { if (!cancelled) setInfo('Áudio indisponível neste ambiente.'); return; }
      const buffer = playbackSource ? await loadBuffer(ctx, zone.sampleId) : null;
      if (cancelled) return;
      if (!buffer) { setInfo('Sem PCM decodificado: converta o instrumento para .mrq (ou use um arquivo WAV/MP3 de origem) para ver a onda real.'); return; }
      setInfo(`${buffer.duration.toFixed(2)} s · ${buffer.sampleRate} Hz · ${buffer.numberOfChannels === 1 ? 'mono' : 'estéreo'}${zone.loopEnabled ? ' · loop' : ''}`);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const peaks = computePeaks(buffer, 600);
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.fillStyle = '#0c1114';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      ctx2d.strokeStyle = '#1d2a30';
      ctx2d.beginPath(); ctx2d.moveTo(0, canvas.height / 2); ctx2d.lineTo(canvas.width, canvas.height / 2); ctx2d.stroke();
      ctx2d.strokeStyle = '#e0b634';
      ctx2d.beginPath();
      peaks.forEach((p, i) => {
        const x = (i / peaks.length) * canvas.width;
        const h = Math.max(1, p * canvas.height * 0.46);
        ctx2d.moveTo(x, canvas.height / 2 - h);
        ctx2d.lineTo(x, canvas.height / 2 + h);
      });
      ctx2d.stroke();
      if (zone.loopEnabled && zone.loopStart !== undefined && zone.loopEnd !== undefined) {
        const x1 = (zone.loopStart / (buffer.sampleRate * buffer.duration)) * canvas.width;
        const x2 = (zone.loopEnd / (buffer.sampleRate * buffer.duration)) * canvas.width;
        ctx2d.strokeStyle = '#22d3ee';
        [x1, x2].forEach((x) => { ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, canvas.height); ctx2d.stroke(); });
      }
    })();
    return () => { cancelled = true; try { nodeRef.current?.stop(); } catch { /* ok */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone.sampleId]);

  async function togglePlay() {
    const ctx = await ensureAudio();
    if (!ctx) return;
    if (playing) { try { nodeRef.current?.stop(); } catch { /* ok */ } nodeRef.current = null; setPlaying(false); return; }
    const buffer = playbackSource ? await loadBuffer(ctx, zone.sampleId) : null;
    if (!buffer) return;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = Math.pow(2, zone.tuneCents / 1200);
    if (zone.loopEnabled && zone.loopStart !== undefined && zone.loopEnd !== undefined && zone.loopEnd > zone.loopStart) {
      node.loop = true;
      node.loopStart = zone.loopStart / buffer.sampleRate;
      node.loopEnd = Math.min(buffer.duration, zone.loopEnd / buffer.sampleRate);
    }
    node.connect(ctx.destination);
    node.onended = () => setPlaying(false);
    node.start();
    nodeRef.current = node;
    setPlaying(true);
  }

  return (
    <div className="zm-wave">
      <div className="zm-wave-head">
        <strong>Wave Editor — {groupName} · <code>{zone.sampleId}</code></strong>
        <span>{info}</span>
        <button className="btn ghost small" onClick={() => void togglePlay()}><Play size={12} /> {playing ? 'Parar' : 'Tocar amostra'}</button>
        <button className="zm-close" onClick={onClose}><X size={15} /></button>
      </div>
      <canvas ref={canvasRef} width={900} height={120} />
    </div>
  );
}
