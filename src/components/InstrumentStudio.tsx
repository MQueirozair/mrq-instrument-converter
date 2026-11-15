/**
 * Estúdio de Instrumentos Convertidos (v0.2.21) — Gerenciador + Editor de
 * Samples + Estúdio de Teste MIDI, integrados ao MRQ Instrument Converter.
 *
 * O que esta tela faz (sem duplicar nada que já existia):
 *  - ABRE qualquer `.mrq` convertido (da lista "Instrumentos Convertidos"
 *    do Conversor, do seletor de arquivos ou de um caminho vindo de lá) —
 *    pra REABRIR e continuar trabalhando depois.
 *  - EDITA as amostras/zonas: tecla raiz, faixas de tecla/velocity,
 *    afinação, volume, pan, loop (início/fim) e TRIM (corte do áudio).
 *    O Editor de Mapeamento completo (MappingEditor.tsx) abre por cima
 *    pra edição visual das zonas.
 *  - SALVA as edições de volta no `.mrq` via `mrq_rebuild_with_model`
 *    (backend Rust): amostras sem trim são copiadas byte a byte (sem
 *    recodificar); amostras cortadas são decodificadas/cortadas/
 *    recodificadas. Salvar por cima do próprio arquivo é seguro
 *    (escrita atômica com autoconferência no Rust).
 *  - TESTA o timbre tocando o instrumento inteiro (todas as zonas e
 *    velocity layers) com o teclado controlador MIDI USB (Web MIDI API)
 *    e/ou o teclado na tela (PlayableKeyboard), usando o MESMO motor de
 *    reprodução do Rack (MrqLayerVoice) — nunca só uma amostra de preview.
 *
 * Esta tela só roda dentro do Tauri (usa `@tauri-apps/plugin-dialog` e
 * os comandos `mrq_*` diretamente, igual ao InstrumentConverter).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  ArrowLeft,
  AudioWaveform,
  FolderOpen,
  Loader2,
  Music2,
  Piano,
  Save,
  Settings2,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  mrqExtractSample,
  mrqReadMetadata,
  mrqRebuildWithModel,
  type MrqDecodedSample,
  type MrqFileMetadata,
  type MrqInstrumentModel,
  type MrqSampleTrim,
} from '../audio/rack/mrqFormat';
import {
  basenameOfPath,
  clampTrim,
  formatFileSize,
  formatSampleDuration,
  isInstrumentDirty,
  isTrimActive,
  loadConvertedInstruments,
  type ConvertedInstrumentEntry,
} from '../audio/rack/convertedInstruments';
import { MrqLayerVoice } from '../audio/rack/MrqLayerVoice';
import { midiNoteName } from '../audio/rack/midiNoteNames';
import PlayableKeyboard from './PlayableKeyboard';
import MappingEditor from './MappingEditor';
import { useStore } from '../state/useStore';

export interface InstrumentStudioProps {
  /** Caminho `.mrq` pra abrir já (vindo do painel "Instrumentos Convertidos"
   *  do Conversor) — `null` mostra o seletor/lista. */
  initialPath: string | null;
  /** Volta pra tela do Conversor. */
  onClose: () => void;
  /** v0.2.22: abre os Controles ao Vivo com este instrumento. */
  onOpenLiveControls?: (path: string) => void;
}

interface ZoneRef {
  presetIdx: number;
  groupIdx: number;
  zoneIdx: number;
}

function cloneModel(model: MrqInstrumentModel): MrqInstrumentModel {
  return JSON.parse(JSON.stringify(model)) as MrqInstrumentModel;
}

export default function InstrumentStudio({ initialPath, onClose, onOpenLiveControls }: InstrumentStudioProps) {
  const pushToast = useStore((s) => s.pushToast);

  const [path, setPath] = useState<string | null>(initialPath);
  const [metadata, setMetadata] = useState<MrqFileMetadata | null>(null);
  const [original, setOriginal] = useState<MrqInstrumentModel | null>(null);
  const [edited, setEdited] = useState<MrqInstrumentModel | null>(null);
  const [trims, setTrims] = useState<Map<string, MrqSampleTrim>>(new Map());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const [selectedZoneIdx, setSelectedZoneIdx] = useState(0);
  const [decoded, setDecoded] = useState<MrqDecodedSample | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [convertedList, setConvertedList] = useState<ConvertedInstrumentEntry[]>(() => loadConvertedInstruments());

  // --- Motor de teste (MrqLayerVoice) ---
  const audioCtxRef = useRef<AudioContext | null>(null);
  const voiceRef = useRef<MrqLayerVoice | null>(null);
  const [engineState, setEngineState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [presetOptions, setPresetOptions] = useState<{ value: string; label: string }[]>([]);
  const [presetValue, setPresetValue] = useState('default');
  const [activeNotes, setActiveNotes] = useState<ReadonlySet<number>>(new Set());

  // --- MIDI USB (Web MIDI API) ---
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const [midiDevices, setMidiDevices] = useState<string[]>([]);
  const [midiConnected, setMidiConnected] = useState(false);
  const [lastNote, setLastNote] = useState<string>('');

  const dirty = useMemo(
    () => Boolean(original && edited && (isInstrumentDirty(original, edited) || trims.size > 0)),
    [original, edited, trims]
  );

  const loadInstrument = useCallback(
    async (filePath: string) => {
      setLoading(true);
      try {
        const meta = await mrqReadMetadata(filePath);
        setPath(filePath);
        setMetadata(meta);
        setOriginal(meta.instrument);
        setEdited(cloneModel(meta.instrument));
        setTrims(new Map());
        setSelectedSampleId(meta.samples[0]?.id ?? null);
        setSelectedZoneIdx(0);
        setDecoded(null);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        pushToast(`Não foi possível abrir "${basenameOfPath(filePath)}": ${e.message}`, 'error');
      } finally {
        setLoading(false);
      }
    },
    [pushToast]
  );

  useEffect(() => {
    if (initialPath) void loadInstrument(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  // --- Carrega o motor de teste sempre que o caminho muda ---
  useEffect(() => {
    if (!path) {
      setEngineState('idle');
      return;
    }
    let cancelled = false;
    setEngineState('loading');
    (async () => {
      try {
        if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') await ctx.resume();
        voiceRef.current?.dispose();
        const voice = new MrqLayerVoice(ctx);
        voiceRef.current = voice;
        const options = await voice.load(new ArrayBuffer(0), path);
        if (cancelled) return;
        voice.output.connect(ctx.destination);
        setPresetOptions(options);
        setPresetValue(options[0]?.value ?? 'default');
        setEngineState('ready');
      } catch (err) {
        if (cancelled) return;
        const e = err instanceof Error ? err : new Error(String(err));
        console.error('[studio] falha ao carregar motor de teste', e);
        setEngineState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  // --- Limpeza ao sair ---
  useEffect(() => {
    return () => {
      voiceRef.current?.dispose();
      if (midiAccessRef.current) {
        midiAccessRef.current.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
      }
      void audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // --- Decodifica a amostra selecionada (forma de onda + frames) ---
  useEffect(() => {
    if (!path || !selectedSampleId) {
      setDecoded(null);
      return;
    }
    let cancelled = false;
    setDecoding(true);
    mrqExtractSample(path, selectedSampleId)
      .then((d) => {
        if (!cancelled) setDecoded(d);
      })
      .catch(() => {
        if (!cancelled) setDecoded(null);
      })
      .finally(() => {
        if (!cancelled) setDecoding(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, selectedSampleId]);

  const selectedEntry = useMemo(
    () => metadata?.samples.find((s) => s.id === selectedSampleId) ?? null,
    [metadata, selectedSampleId]
  );

  const totalFrames = useMemo(() => {
    if (!decoded) return 0;
    return Math.floor(decoded.interleaved.length / Math.max(1, decoded.channels));
  }, [decoded]);

  const zoneRefs: ZoneRef[] = useMemo(() => {
    if (!edited || !selectedSampleId) return [];
    const refs: ZoneRef[] = [];
    edited.presets.forEach((preset, presetIdx) => {
      preset.groups.forEach((group, groupIdx) => {
        group.zones.forEach((zone, zoneIdx) => {
          if (zone.sampleId === selectedSampleId) refs.push({ presetIdx, groupIdx, zoneIdx });
        });
      });
    });
    return refs;
  }, [edited, selectedSampleId]);

  const selectedZone = useMemo(() => {
    if (!edited || zoneRefs.length === 0) return null;
    const ref = zoneRefs[Math.min(selectedZoneIdx, zoneRefs.length - 1)];
    return edited.presets[ref.presetIdx]?.groups[ref.groupIdx]?.zones[ref.zoneIdx] ?? null;
  }, [edited, zoneRefs, selectedZoneIdx]);

  const selectedTrim = selectedSampleId ? trims.get(selectedSampleId) ?? null : null;

  function updateSelectedZone(patch: Partial<NonNullable<typeof selectedZone>>) {
    if (!edited || !selectedZone) return;
    const ref = zoneRefs[Math.min(selectedZoneIdx, zoneRefs.length - 1)];
    const next = cloneModel(edited);
    const zone = next.presets[ref.presetIdx].groups[ref.groupIdx].zones[ref.zoneIdx];
    Object.assign(zone, patch);
    setEdited(next);
  }

  function updateTrim(startFrame: number, endFrame: number) {
    if (!selectedSampleId) return;
    const clamped = clampTrim({ sampleId: selectedSampleId, startFrame, endFrame }, totalFrames);
    setTrims((prev) => {
      const next = new Map(prev);
      if (clamped && isTrimActive(clamped, totalFrames)) next.set(selectedSampleId, clamped);
      else next.delete(selectedSampleId);
      return next;
    });
  }

  function autoTrimSilence() {
    if (!decoded || !selectedSampleId) return;
    const channels = Math.max(1, decoded.channels);
    const frames = Math.floor(decoded.interleaved.length / channels);
    const threshold = 0.01; // ~-40 dBFS
    let first = 0;
    for (let f = 0; f < frames; f += 1) {
      let peak = 0;
      for (let c = 0; c < channels; c += 1) peak = Math.max(peak, Math.abs(decoded.interleaved[f * channels + c]));
      if (peak > threshold) {
        first = f;
        break;
      }
    }
    if (first > 0) updateTrim(first, frames);
    else pushToast('Nenhum silêncio no início desta amostra.', 'info');
  }

  async function handleSave(overwrite: boolean) {
    if (!path || !edited || !original) return;
    let destPath = path;
    if (!overwrite) {
      try {
        const chosen = await saveDialog({
          title: 'Salvar instrumento editado',
          defaultPath: basenameOfPath(path),
          filters: [{ name: 'Instrumento MRQ', extensions: ['mrq'] }],
        });
        if (!chosen) return;
        destPath = chosen;
      } catch {
        pushToast('Não foi possível abrir o seletor de destino.', 'error');
        return;
      }
    }
    setSaving(true);
    try {
      // Valida os trims contra o tamanho real de cada amostra (só a
      // selecionada já foi decodificada; as demais são decodificadas aqui).
      const activeTrims: MrqSampleTrim[] = [];
      for (const [sampleId, trim] of trims) {
        let frames = sampleId === selectedSampleId ? totalFrames : 0;
        if (frames <= 0) {
          const d = await mrqExtractSample(path, sampleId);
          frames = Math.floor(d.interleaved.length / Math.max(1, d.channels));
        }
        const clamped = clampTrim(trim, frames);
        if (clamped && isTrimActive(clamped, frames)) activeTrims.push(clamped);
      }
      await mrqRebuildWithModel(path, destPath, edited, activeTrims);
      const meta = await mrqReadMetadata(destPath);
      setPath(destPath);
      setMetadata(meta);
      setOriginal(meta.instrument);
      setEdited(cloneModel(meta.instrument));
      setTrims(new Map());
      pushToast(`"${basenameOfPath(destPath)}" salvo com as edições.`);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      pushToast(`Falha ao salvar: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function pickInstrument() {
    try {
      const result = await openDialog({
        title: 'Abrir instrumento convertido (.mrq)',
        multiple: false,
        filters: [{ name: 'Instrumento MRQ', extensions: ['mrq'] }],
      });
      const picked = Array.isArray(result) ? result[0] : result;
      if (picked) void loadInstrument(picked);
    } catch {
      pushToast('Não foi possível abrir o seletor de arquivos.', 'error');
    }
  }

  // --- Notas (teclado na tela + MIDI USB) ---
  const noteOn = useCallback((note: number, velocity: number) => {
    const ctx = audioCtxRef.current;
    const voice = voiceRef.current;
    if (!ctx || !voice || engineState !== 'ready') return;
    if (ctx.state === 'suspended') void ctx.resume();
    voice.noteOn(note, velocity);
    setActiveNotes((prev) => new Set(prev).add(note));
    setLastNote(`${midiNoteName(note)} · vel ${velocity}`);
  }, [engineState]);

  const noteOff = useCallback((note: number) => {
    voiceRef.current?.noteOff(note);
    setActiveNotes((prev) => {
      const next = new Set(prev);
      next.delete(note);
      return next;
    });
  }, []);

  async function connectMidi() {
    if (!('requestMIDIAccess' in navigator)) {
      pushToast('Este navegador/sistema não suporta Web MIDI. Use o teclado na tela.', 'error');
      return;
    }
    try {
      const requestAccess = navigator.requestMIDIAccess?.bind(navigator);
      if (!requestAccess) throw new Error('Este navegador não suporta Web MIDI.');
      const access = await requestAccess({ sysex: false });
      midiAccessRef.current = access;
      const refresh = () => {
        const names = Array.from(access.inputs.values()).map((i) => i.name ?? 'Dispositivo MIDI');
        setMidiDevices(names);
        setMidiConnected(names.length > 0);
      };
      refresh();
      access.inputs.forEach((input) => {
        input.onmidimessage = (ev: MIDIMessageEvent) => {
          const data = ev.data;
          if (!data || data.length < 2) return;
          const status = data[0];
          const command = status & 0xf0;
          const number = data[1];
          const value = data[2] ?? 0;
          if (command === 0x90 && value > 0) noteOn(number, value);
          else if (command === 0x80 || (command === 0x90 && value === 0)) noteOff(number);
          else if (command === 0xe0) {
            const bend = (((value << 7) | number) - 8192) / 8192;
            voiceRef.current?.setPitchBend(bend * 2);
          }
        };
      });
      access.onstatechange = refresh;
      if (midiDevices.length === 0 && access.inputs.size === 0) {
        pushToast('Nenhum teclado MIDI USB encontrado. Conecte o teclado e clique de novo.', 'error');
      } else {
        pushToast('Teclado MIDI conectado — toque para testar o timbre.');
      }
    } catch {
      pushToast('Acesso MIDI negado. Libere a permissão do navegador e tente de novo.', 'error');
    }
  }

  // --- Forma de onda ---
  const waveformRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas || !decoded) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx2d.clearRect(0, 0, width, height);
    const channels = Math.max(1, decoded.channels);
    const frames = Math.floor(decoded.interleaved.length / channels);
    if (frames === 0) return;
    // Região do trim (fora = escurecida).
    if (selectedTrim) {
      const x0 = (selectedTrim.startFrame / frames) * width;
      const x1 = (selectedTrim.endFrame / frames) * width;
      ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
      ctx2d.fillRect(0, 0, x0, height);
      ctx2d.fillRect(x1, 0, width - x1, height);
      ctx2d.strokeStyle = 'var(--accent)';
      ctx2d.strokeRect(x0, 0.5, x1 - x0, height - 1);
    }
    ctx2d.strokeStyle = '#84e1ad';
    ctx2d.beginPath();
    for (let x = 0; x < width; x += 1) {
      const start = Math.floor((x / width) * frames);
      const end = Math.max(start + 1, Math.floor(((x + 1) / width) * frames));
      let peak = 0;
      for (let f = start; f < end; f += 1) {
        for (let c = 0; c < channels; c += 1) {
          peak = Math.max(peak, Math.abs(decoded.interleaved[f * channels + c]));
        }
      }
      const y = peak * (height / 2);
      ctx2d.moveTo(x + 0.5, height / 2 - y);
      ctx2d.lineTo(x + 0.5, height / 2 + y);
    }
    ctx2d.stroke();
  }, [decoded, selectedTrim]);

  if (loading) {
    return (
      <div className="studio-empty">
        <Loader2 size={22} className="mrq-spin" />
        <p>Abrindo instrumento…</p>
      </div>
    );
  }

  if (!path || !metadata || !edited) {
    return (
      <div className="studio-empty">
        <Music2 size={34} color="var(--mrq-cyan)" />
        <h3>Estúdio de Instrumentos Convertidos</h3>
        <p>
          Abra um <code>.mrq</code> convertido para editar as amostras/zonas, salvar as alterações e testar o timbre
          com seu teclado MIDI USB — e reabrir depois, quando quiser.
        </p>
        <button className="btn primary" onClick={() => void pickInstrument()}>
          <FolderOpen size={14} /> Escolher arquivo .mrq
        </button>
        {convertedList.length > 0 && (
          <div className="studio-recent">
            <h4>Instrumentos convertidos</h4>
            {convertedList.map((entry) => (
              <button key={entry.path} className="studio-recent-item" onClick={() => void loadInstrument(entry.path)}>
                <Music2 size={13} /> {entry.name}
              </button>
            ))}
          </div>
        )}
        <button className="btn ghost" onClick={onClose}>
          <ArrowLeft size={13} /> Voltar ao Conversor
        </button>
      </div>
    );
  }

  return (
    <div className="studio">
      <header className="studio-header">
        <button className="btn ghost small" onClick={onClose} title="Voltar ao Conversor">
          <ArrowLeft size={13} /> Conversor
        </button>
        <div className="studio-title">
          <strong>{edited.name || basenameOfPath(path)}</strong>
          <span title={path}>{basenameOfPath(path)}</span>
          {dirty && <span className="studio-dirty" title="Edições não salvas">● não salvo</span>}
        </div>
        <div className="studio-actions">
          <button className="btn ghost small" onClick={() => setMappingOpen(true)} title="Abrir o Editor de Mapeamento (zonas visuais)">
            <Settings2 size={13} /> Editor de Mapeamento
          </button>
          <button
            className="btn ghost small"
            disabled={!onOpenLiveControls}
            title="Abrir os Controles ao Vivo — controles globais do instrumento inteiro e pré-escuta do som final"
            onClick={() => onOpenLiveControls?.(path)}
          >
            <SlidersHorizontal size={13} /> Controles ao Vivo
          </button>
          <button className="btn ghost small" onClick={() => void handleSave(false)} disabled={saving || !dirty} title="Salvar as edições num arquivo novo">
            <Save size={13} /> Salvar como…
          </button>
          <button className="btn primary small" onClick={() => void handleSave(true)} disabled={saving || !dirty} title="Salvar as edições por cima deste arquivo">
            {saving ? <Loader2 size={13} className="mrq-spin" /> : <Save size={13} />} Salvar
          </button>
        </div>
      </header>

      <div className="studio-body">
        <aside className="studio-samples">
          <h4>Amostras · {metadata.samples.length}</h4>
          <div className="studio-sample-list">
            {metadata.samples.map((entry) => (
              <button
                key={entry.id}
                className={`studio-sample-item ${entry.id === selectedSampleId ? 'selected' : ''} ${trims.has(entry.id) ? 'trimmed' : ''}`}
                onClick={() => {
                  setSelectedSampleId(entry.id);
                  setSelectedZoneIdx(0);
                }}
              >
                <span className="studio-sample-id">{entry.id}</span>
                <span className="studio-sample-meta">
                  {entry.sampleRateHz} Hz · {entry.channels}ch · {formatFileSize(entry.length)}
                  {trims.has(entry.id) ? ' · cortada' : ''}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="studio-editor">
          {selectedEntry && selectedZone ? (
            <>
              <div className="studio-wave-wrap">
                <canvas ref={waveformRef} width={720} height={110} className="studio-wave" />
                <div className="studio-wave-meta">
                  {decoding ? (
                    <span><Loader2 size={11} className="mrq-spin" /> decodificando…</span>
                  ) : decoded ? (
                    <span>
                      {formatSampleDuration(totalFrames, decoded.sampleRateHz)} · {totalFrames.toLocaleString('pt-BR')} frames ·{' '}
                      {decoded.sampleRateHz} Hz · {decoded.channels} canal(is)
                      {selectedTrim ? ` · corte: ${selectedTrim.startFrame.toLocaleString('pt-BR')}–${selectedTrim.endFrame.toLocaleString('pt-BR')}` : ''}
                    </span>
                  ) : (
                    <span>amostra indisponível</span>
                  )}
                </div>
              </div>

              {zoneRefs.length > 1 && (
                <div className="studio-zone-tabs">
                  {zoneRefs.map((_, i) => (
                    <button key={i} className={i === selectedZoneIdx ? 'selected' : ''} onClick={() => setSelectedZoneIdx(i)}>
                      Zona {i + 1}
                    </button>
                  ))}
                </div>
              )}

              <div className="studio-fields">
                <Field label="Tecla raiz" value={selectedZone.rootNote} min={0} max={127} onChange={(v) => updateSelectedZone({ rootNote: v })} />
                <Field label="Tecla mín." value={selectedZone.loKey} min={0} max={127} onChange={(v) => updateSelectedZone({ loKey: Math.min(v, selectedZone.hiKey) })} />
                <Field label="Tecla máx." value={selectedZone.hiKey} min={0} max={127} onChange={(v) => updateSelectedZone({ hiKey: Math.max(v, selectedZone.loKey) })} />
                <Field label="Velocity mín." value={selectedZone.loVel} min={0} max={127} onChange={(v) => updateSelectedZone({ loVel: Math.min(v, selectedZone.hiVel) })} />
                <Field label="Velocity máx." value={selectedZone.hiVel} min={0} max={127} onChange={(v) => updateSelectedZone({ hiVel: Math.max(v, selectedZone.loVel) })} />
                <Field label="Afinação (cents)" value={Math.round(selectedZone.tuneCents)} min={-100} max={100} onChange={(v) => updateSelectedZone({ tuneCents: v })} />
                <Field label="Volume (dB)" value={Math.round(selectedZone.volumeDb * 10) / 10} min={-24} max={12} step={0.5} onChange={(v) => updateSelectedZone({ volumeDb: v })} />
                <Field label="Pan (-1..1)" value={Math.round(selectedZone.pan * 100) / 100} min={-1} max={1} step={0.05} onChange={(v) => updateSelectedZone({ pan: v })} />
              </div>

              <div className="studio-loop">
                <label className="studio-check">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedZone.loopEnabled)}
                    onChange={(e) => {
                      const on = e.target.checked;
                      updateSelectedZone({
                        loopEnabled: on,
                        loopStart: on ? (selectedZone.loopStart ?? 0) : selectedZone.loopStart,
                        loopEnd: on ? (selectedZone.loopEnd ?? Math.min(totalFrames, 1000)) : selectedZone.loopEnd,
                      });
                    }}
                  />
                  Loop ligado
                </label>
                {selectedZone.loopEnabled && (
                  <>
                    <Field label="Loop início (frames)" value={selectedZone.loopStart ?? 0} min={0} max={totalFrames} onChange={(v) => updateSelectedZone({ loopStart: v })} />
                    <Field label="Loop fim (frames)" value={selectedZone.loopEnd ?? 0} min={0} max={totalFrames} onChange={(v) => updateSelectedZone({ loopEnd: v })} />
                  </>
                )}
              </div>

              <div className="studio-trim">
                <h5>Corte da amostra (trim)</h5>
                <Field
                  label="Início (frames)"
                  value={selectedTrim?.startFrame ?? 0}
                  min={0}
                  max={totalFrames}
                  onChange={(v) => updateTrim(v, selectedTrim?.endFrame ?? totalFrames)}
                />
                <Field
                  label="Fim (frames)"
                  value={selectedTrim?.endFrame ?? totalFrames}
                  min={0}
                  max={totalFrames}
                  onChange={(v) => updateTrim(selectedTrim?.startFrame ?? 0, v)}
                />
                <button className="btn ghost small" onClick={autoTrimSilence} disabled={!decoded || totalFrames === 0}>
                  <AudioWaveform size={13} /> Remover silêncio do início
                </button>
                {selectedTrim && (
                  <button
                    className="btn ghost small"
                    onClick={() => {
                      if (selectedSampleId) {
                        setTrims((prev) => {
                          const next = new Map(prev);
                          next.delete(selectedSampleId);
                          return next;
                        });
                      }
                    }}
                  >
                    <X size={13} /> Limpar corte
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="studio-hint">Selecione uma amostra à esquerda para editar.</p>
          )}
        </section>
      </div>

      <footer className="studio-test">
        <div className="studio-test-head">
          <h4><Piano size={15} /> Estúdio de Teste — toque com seu teclado MIDI USB ou na tela</h4>
          <div className="studio-test-controls">
            {presetOptions.length > 1 && (
              <select value={presetValue} onChange={(e) => { setPresetValue(e.target.value); voiceRef.current?.selectPreset(e.target.value); }} className="studio-preset-select" title="Preset do instrumento">
                {presetOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            )}
            <button className="btn ghost small" onClick={() => void connectMidi()}>
              <Piano size={13} /> {midiConnected ? `MIDI: ${midiDevices.join(', ')}` : 'Conectar teclado MIDI USB'}
            </button>
            {engineState === 'loading' && <span className="studio-engine-status"><Loader2 size={12} className="mrq-spin" /> carregando amostras…</span>}
            {engineState === 'error' && <span className="studio-engine-status bad">falha ao carregar o motor de teste</span>}
            {engineState === 'ready' && <span className="studio-engine-status ok">pronto para tocar{lastNote ? ` · última nota: ${lastNote}` : ''}</span>}
          </div>
        </div>
        <PlayableKeyboard
          lowestNote={21}
          highestNote={108}
          activeNotes={activeNotes}
          disabled={engineState !== 'ready'}
          onNoteOn={(note) => noteOn(note, 100)}
          onNoteOff={noteOff}
        />
      </footer>

      {mappingOpen && edited && (
        <MappingEditor
          fileName={basenameOfPath(path)}
          formatLabel="Instrumento MRQ nativo"
          instrument={edited}
          canPersist={false}
          persistNote="As edições feitas aqui entram no modelo do Estúdio — use Salvar no Estúdio para gravar tudo de uma vez no .mrq."
          playbackSource={{ kind: 'mrq', path }}
          onClose={() => setMappingOpen(false)}
          onSave={(model) => {
            setEdited(model);
            setMappingOpen(false);
            pushToast('Mapeamento atualizado no Estúdio (use Salvar para gravar no .mrq).');
          }}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="studio-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
      />
    </label>
  );
}
