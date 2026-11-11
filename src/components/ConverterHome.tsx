/**
 * Painel inicial do Instrument Converter (v0.2.12).
 *
 * Antes, quando não havia item selecionado, a área principal era um retângulo
 * preto quase vazio com duas frases soltas — era a "tela principal confusa"
 * apontada pelo usuário. Agora a área explica o fluxo completo, oferece os
 * mesmos três caminhos de entrada em cartões grandes e mostra o estado da
 * sessão (fila, convertidos, erros, arquivos recentes).
 *
 * É puramente apresentacional: todas as ações são callbacks passados por
 * InstrumentConverter, então nenhuma lógica de conversão foi duplicada.
 */
import {
  ArrowRight,
  AudioLines,
  FileAudio,
  FolderOpen,
  Info,
  ListMusic,
  Piano,
  Sparkles,
  Wand2,
} from 'lucide-react';

export interface ConverterHomeRecentItem {
  id: string;
  fileName: string;
  status: string;
}

export interface ConverterHomeProps {
  onPickFiles: () => void;
  onOpenCapture: () => void;
  onOpenAutoSampler: () => void;
  onOpenMidi: () => void;
  queueCount: number;
  convertedCount: number;
  errorCount: number;
  recent: ConverterHomeRecentItem[];
  onSelectRecent: (id: string) => void;
  /** Nome do item selecionado que ainda não tem inspeção pronta (analisando/erro sem modelo). */
  pendingName?: string | null;
  pendingMessage?: string | null;
}

const FORMATS = ['SF2', 'SF3', 'NPNO', 'NSMP', 'SYX (DX7)', 'EXS', 'WAV', 'AIFF', 'FLAC', 'MP3', 'OGG'];

export default function ConverterHome({
  onPickFiles,
  onOpenCapture,
  onOpenAutoSampler,
  onOpenMidi,
  queueCount,
  convertedCount,
  errorCount,
  recent,
  onSelectRecent,
  pendingName,
  pendingMessage,
}: ConverterHomeProps) {
  if (pendingName) {
    return (
      <div className="cv-home-selected-hint">
        <ListMusic size={30} color="var(--mrq-cyan)" />
        <h3>{pendingName}</h3>
        <p>{pendingMessage ?? 'Este item ainda não tem um mapeamento inspecionado. Aguarde a análise ou clique nele na fila para ver os detalhes.'}</p>
      </div>
    );
  }

  return (
    <div className="cv-home">
      <div className="cv-home-hero">
        <span className="cv-home-eyebrow">MRQ · Instrument Converter</span>
        <h2>Transforme qualquer instrumento em <span style={{ color: 'var(--mrq-cyan)' }}>.mrq</span></h2>
        <p>
          Importe um banco de samples, confira o mapeamento nota a nota, edite as zonas no Editor de Mapeamento e
          converta para tocar no Rack. Tudo no mesmo lugar — sem precisar adivinhar onde clicar.
        </p>
        <div className="cv-home-cta">
          <button className="btn primary" onClick={onPickFiles}><FolderOpen size={14} /> Escolher arquivos</button>
          <button className="btn ghost" onClick={onOpenAutoSampler}><Sparkles size={14} /> Abrir Auto Sampler</button>
        </div>
      </div>

      <div className="cv-home-steps">
        <div className="cv-step">
          <span className="cv-step-num">1</span>
          <div><strong>Importe</strong><p>Arquivos de instrumento, áudio solto, uma captura do Kontakt ou uma gravação automática pelo Auto Sampler.</p></div>
        </div>
        <div className="cv-step">
          <span className="cv-step-num">2</span>
          <div><strong>Inspecione e edite</strong><p>Veja zonas, velocity, amostras e compatibilidade. Abra o Editor de Mapeamento para ajustar regiões e testar com seu teclado MIDI USB.</p></div>
        </div>
        <div className="cv-step">
          <span className="cv-step-num">3</span>
          <div><strong>Converta</strong><p>Gere o <code>.mrq</code> (e opcionalmente <code>.sf2</code>/<code>.sf3</code>), pré-escute a amostra real e leve o instrumento para o Rack.</p></div>
        </div>
      </div>

      <section>
        <h4 className="cv-home-section-title">Como quer começar?</h4>
        <div className="cv-home-cards">
          <button className="cv-home-card" onClick={onPickFiles}>
            <FileAudio size={20} />
            <strong>Arquivos do computador</strong>
            <span>SoundFonts, bancos NPNO/NSMP, SYX de DX7, EXS e arquivos de áudio. Aceita vários de uma vez.</span>
            <small>Abrir seletor <ArrowRight size={11} /></small>
          </button>
          <button className="cv-home-card" onClick={onOpenAutoSampler}>
            <Wand2 size={20} />
            <strong>Auto Sampler</strong>
            <span>O app toca e grava o Kontakt sozinho, nota por nota, com presets e recaptura só das notas ruins.</span>
            <small>Abrir assistente <ArrowRight size={11} /></small>
          </button>
          <button className="cv-home-card" onClick={onOpenCapture}>
            <AudioLines size={20} />
            <strong>Renderizar pelo Kontakt</strong>
            <span>Importe WAVs já renderizados pelo Kontakt e monte o instrumento a partir deles.</span>
            <small>Importar captura <ArrowRight size={11} /></small>
          </button>
          <button className="cv-home-card" onClick={onOpenMidi}>
            <Piano size={20} />
            <strong>Tocar manualmente</strong>
            <span>Use o controlador MIDI para tocar o Kontakt nota a nota e gravar o resultado.</span>
            <small>Abrir controlador <ArrowRight size={11} /></small>
          </button>
        </div>
      </section>

      {recent.length > 0 && (
        <section>
          <h4 className="cv-home-section-title">Arquivos desta sessão · {queueCount} na fila · {convertedCount} convertidos{errorCount > 0 ? ` · ${errorCount} com erro` : ''}</h4>
          <div className="cv-home-recent">
            {recent.map((r) => (
              <button key={r.id} onClick={() => onSelectRecent(r.id)}>
                <FileAudio size={13} color="var(--mrq-cyan)" /> {r.fileName}
                <span>{r.status}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4 className="cv-home-section-title">Formatos aceitos</h4>
        <div className="cv-home-formats">{FORMATS.map((f) => <span key={f}>{f}</span>)}</div>
      </section>

      <div className="cv-home-hint">
        <Info size={14} />
        <span>
          Dica: depois de importar, clique no arquivo na coluna da esquerda. O painel acima mostra o resumo e os botões de
          <strong> Converter</strong>, <strong>Editor de Mapeamento</strong> e <strong>Exportar SF2/SF3</strong>. No Editor de
          Mapeamento você pode tocar cada zona com o controlador MIDI USB e arrastar as bordas para mudar as regiões.
        </span>
      </div>
    </div>
  );
}
