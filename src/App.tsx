import { useEffect, useState } from 'react';
import { Settings, HelpCircle } from 'lucide-react';
import { useStore } from './state/useStore';
import TitleBar from './components/TitleBar';
import InstrumentConverter from './components/InstrumentConverter';
import HelpPanel from './components/HelpPanel';
import SettingsModal from './components/SettingsModal';

/**
 * App.tsx do projeto separado "MRQ Instrument Converter" — ver
 * PROJETO-SEPARADO.md na raiz. Isto é uma versão enxugada do App.tsx
 * original (extraído de mrq-multitracks-play v0.2.48, que continua
 * intocado): em vez da barra de navegação inteira (biblioteca, setlist,
 * player de multitracks, Rack de instrumentos, etc.), este app abre DIRETO
 * na tela do conversor de formatos de instrumento (.sf2/.nki/.exs/.syx/
 * Kontakt -> .mrq), que é o único propósito deste projeto.
 *
 * TitleBar, SettingsModal, HelpPanel e o sistema de toasts foram mantidos
 * como estavam (são genéricos/compartilhados e não vale a pena reescrever
 * agora) — só a navegação por abas e as telas exclusivas do player/Rack
 * foram removidas. Ver os outros arquivos deletados em src/components/
 * (não existem mais nesta cópia) pra a lista completa do que saiu.
 */
export default function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) {
    return (
      <div className="app-shell">
        <TitleBar />
        <div className="empty-state" style={{ flex: 1 }}>Carregando…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="main-body">
        <div className="rail">
          <div className="rail-spacer" />
          <button className={`rail-btn ${helpOpen ? 'active' : ''}`} title="Ajuda / Sobre o MRQ" onClick={() => setHelpOpen((v) => !v)}>
            <HelpCircle size={19} strokeWidth={2} />
          </button>
          <button className="rail-btn" title="Configurações" onClick={() => setSettingsOpen(true)}>
            <Settings size={19} strokeWidth={2} />
          </button>
        </div>
        <div className="content-area">
          <div className="content-main">{helpOpen ? <HelpPanel /> : <InstrumentConverter />}</div>
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
