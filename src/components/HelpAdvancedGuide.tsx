/**
 * Manual ilustrado e detalhado do Auto Sampler + recursos avançados do
 * Conversor (v0.2.15).
 *
 * Mantido em componente separado para o HelpPanel não virar um arquivo único
 * impossível de revisar. Todas as figuras são arquivos locais em `public/help`
 * (SVG sem recursos externos + uma tela real anotada em PNG); funcionam
 * offline no Tauri e no preview sandboxed.
 */
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  AudioWaveform,
  CheckSquare,
  Database,
  FileText,
  Info,
  KeyboardMusic as KeyboardMusicIcon,
  Library,
  Piano,
  RefreshCw,
  Replace,
  Split,
} from 'lucide-react';

const BASE = import.meta.env.BASE_URL;

function Figure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="help-figure">
      <img src={`${BASE}help/${src}`} alt={alt} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function SectionHead({ icon: Icon, title, purpose }: { icon: typeof Library; title: string; purpose: string }) {
  return (
    <div className="help-section-head">
      <div className="help-section-icon">
        <Icon size={17} />
      </div>
      <div>
        <h2>{title}</h2>
        <p className="help-section-purpose">{purpose}</p>
      </div>
    </div>
  );
}

function Note({ children, kind = 'tip' }: { children: ReactNode; kind?: 'tip' | 'warn' | 'info' }) {
  return <div className={`help-callout ${kind === 'info' ? '' : kind}`}>{children}</div>;
}

export default function HelpAdvancedGuide({ goTo }: { goTo: (id: string) => void }) {
  return (
    <>
      {/* ---------------- AUTO SAMPLER ILUSTRADO ---------------- */}
      <section className="help-section" id="auto-sampler">
        <SectionHead
          icon={AudioWaveform}
          title="Auto Sampler — guia ilustrado passo a passo"
          purpose="Gravar automaticamente um instrumento externo nota por nota e transformá-lo em .mrq e/ou SoundFont, em 4 passos"
        />
        <p>
          O <b>Auto Sampler</b> toca notas MIDI no seu instrumento externo (Kontakt standalone, teclado, sintetizador
          ou outro software), grava o áudio que volta e monta um instrumento multisample. Ele fica na tela{' '}
          <b>Conversor de instrumentos</b>, no card <b>Auto Sampler</b> da coluna esquerda. Não lê <code>.nki</code>{' '}
          nem precisa de nenhum formato fechado: o que ele usa é o som que o próprio instrumento tocou.
        </p>
        <Note kind="info">
          <b>Ideia central:</b> existe um caminho de <b>MIDI saindo</b> do MRQ e um caminho de <b>áudio voltando</b>{' '}
          para o MRQ. Se qualquer um dos dois estiver errado, a captura fica silenciosa. A imagem de roteamento abaixo
          mostra os dois caminhos e onde entram o loopback nativo do Windows e o VB-Cable.
        </Note>

        <Figure
          src="help-auto-sampler-tela-real.png"
          alt="Tela real do Auto Sampler no passo 1, com chamadas numeradas para o X, porta MIDI, entrada de áudio, VU e botão Continuar"
          caption="Tela real — passo 1 (Conexão). A área verde é a janela; a área escura à esquerda representa um clique fora, que agora NÃO fecha a janela."
        />
        <Figure
          src="help-auto-sampler-roteamento.svg"
          alt="Diagrama do caminho do sinal: Auto Sampler envia MIDI por porta virtual ao instrumento, o áudio volta por loopback nativo ou VB-Cable e vira arquivos .mrq e .sf2/.sf3"
          caption="Caminho completo do sinal: uma seta MIDI (amarela) e uma seta de áudio. O VB-Cable é alternativo ao loopback nativo, não obrigatório no Windows."
        />

        <h3 className="help-subhead"><span>1</span> Conexão — MIDI, áudio e nível</h3>
        <Figure
          src="help-auto-sampler-conexao.svg"
          alt="Ilustração do passo 1 com seleção de porta MIDI, canal, teste de C4, dispositivo de áudio, ganho, VU L/R, botão Continuar e aviso de que clique fora não fecha"
          caption="Passo 1 em detalhes: escolha a porta MIDI, o canal, a entrada de áudio e confirme o sinal antes de avançar."
        />
        <ol>
          <li>
            <b>Porta MIDI:</b> escolha uma saída virtual roteada até a entrada MIDI do instrumento —{' '}
            <code>loopMIDI</code> no Windows, <b>IAC Driver</b> no macOS, <code>aconnect</code>/<code>a2jmidid</code>{' '}
            no Linux. Se a porta não aparecer, clique em <b>Atualizar portas MIDI</b>.
          </li>
          <li>
            <b>Canal MIDI:</b> use o mesmo canal em que o instrumento está escutando (1 a 16; na maioria dos casos é
            o 1). O app converte internamente para o número 0-based exigido pela mensagem MIDI.
          </li>
          <li>
            <b>Testar MIDI (toca C4):</b> o MRQ envia uma nota curta. Se você ouvir o C4 no instrumento, o caminho
            MIDI está correto.
          </li>
          <li>
            <b>Dispositivo de áudio:</b> no Windows, as opções <b>“Saída de som do sistema — loopback nativo”</b>{' '}
            gravam direto o que está saindo no PC, sem microfone e sem VB-Cable. Se preferir cabo virtual ou estiver
            em macOS/Linux, clique em <b>Listar também microfones / cabos virtuais (VB-Cable)</b>, conceda a
            permissão e selecione <code>CABLE Output</code> (ou a entrada equivalente).
          </li>
          <li>
            <b>Input Gain e VU L/R:</b> toque uma nota no instrumento e veja as barras L/R se moverem no topo.
            Ajuste o ganho para ter sinal claro sem encostar em 0 dBFS/clipping. <b>Testar áudio</b> marca esta
            verificação como feita; o VU continua ao vivo inclusive durante a captura no loopback nativo.
          </li>
          <li>
            O botão <b>Continuar</b> só libera o passo 2 quando porta MIDI, entrada de áudio e VU estão OK.
          </li>
        </ol>
        <Note kind="tip">
          <b>Novidade de segurança:</b> clicar na área escura fora do quadro não fecha mais nem descarta nada. Para
          sair, use o <b>X</b>; o rascunho continua salvo. Veja a seção{' '}
          <button type="button" className="help-inline-link" onClick={() => goTo('auto-sampler-rascunho')}>
            Rascunho / Voltar do zero
          </button>
          .
        </Note>

        <h3 className="help-subhead"><span>2</span> Teclado — faixa, intervalo e presets</h3>
        <Figure
          src="help-auto-sampler-teclado.svg"
          alt="Ilustração do passo 2 com quatro presets, campos de nota inicial e final, teclado C3 a C5 e pontos amarelos marcando notas amostradas"
          caption="Passo 2: presets, limites da faixa, pontos amarelos das notas que serão gravadas e legenda de status por nota."
        />
        <ul>
          <li><b>Presets:</b> Piano / Teclado, Pads / Sustained, Percussão / One-shot e Cromático rápido. Um clique preenche faixa, intervalo, velocities, sustain/release e loop de uma vez; depois você ainda pode editar cada número.</li>
          <li><b>Range Start / Range End:</b> primeira e última nota MIDI da faixa. O exemplo padrão é 48 (C3) até 72 (C5).</li>
          <li><b>Sample Every:</b> intervalo em semitons. <code>1</code> grava cromaticamente; <code>3</code> grava de 3 em 3 e as notas intermediárias são preenchidas por pitch-shift. Menos notas = captura mais rápida e arquivo menor.</li>
          <li><b>Teclado:</b> arraste as alças ou use os campos numéricos. Clicar numa tecla pré-ouve a nota pela porta MIDI. Cinza = fora da faixa; azul = na faixa; verde = gravada OK; vermelho = silenciosa/ruim.</li>
          <li><b>Estimativa:</b> o painel mostra quantas notas, quantas capturas (notas × velocities × round robin), tempo aproximado e tamanho estimado antes de gravar.</li>
        </ul>

        <h3 className="help-subhead"><span>3</span> Som — velocity, tempos, loop e ganho</h3>
        <Figure
          src="help-auto-sampler-som.svg"
          alt="Ilustração do passo 3 com barra azul de Velocity Response de três camadas, linhas brancas arrastáveis nos valores 42 e 85 e campos de round robin, sustain, release, loop, one-shot e ganho"
          caption="Passo 3: a barra azul tem divisórias brancas arrastáveis. O primeiro arraste já muda a resposta para Custom e grava os novos limites."
        />
        <p>
          A <b>Velocity Response</b> define em quantas faixas de intensidade o instrumento será gravado. Você pode
          escolher Linear, Exponencial 1–3, Logarítmica 1–3 ou <b>Custom</b>. Mesmo vindo de um preset, basta clicar
          perto de uma linha branca e arrastar: o app cria automaticamente os pontos Custom e a resposta passa a ser
          usada de verdade pelo motor. Clicar até 8 valores MIDI de distância da linha já seleciona a divisória.
        </p>
        <div className="help-example">
          <b>Exemplo numérico:</b> com 3 camadas lineares os pontos são <code>0 · 42 · 85 · 127</code>, produzindo as
          faixas <code>0–41</code>, <code>42–84</code> e <code>85–127</code>. Arrastar a primeira linha de 42 para 30
          resulta em <code>0–29</code>, <code>30–84</code> e <code>85–127</code>. O número mostrado na linha é o
          início da faixa seguinte, não o fim da anterior.
        </div>
        <div className="help-table-wrap">
          <table className="help-table">
            <thead><tr><th>Controle</th><th>O que faz</th><th>Exemplo / efeito prático</th></tr></thead>
            <tbody>
              <tr><td><b>Velocity Layers</b></td><td>Quantas intensidades diferentes serão gravadas por nota.</td><td>3 = piano, mezzo e forte; multiplica o total de capturas por 3.</td></tr>
              <tr><td><b>Round Robin</b></td><td>Variações diferentes da mesma nota+velocity, alternadas a cada toque.</td><td>2 = duas tomadas por nota; soa menos repetitivo. No .mrq alterna; em SF2 a maioria dos players sobrepõe as variações.</td></tr>
              <tr><td><b>Sustain</b></td><td>Tempo que a nota fica pressionada antes do note-off.</td><td>4 s para piano; 1,5 s para sons curtos.</td></tr>
              <tr><td><b>Release Tail</b></td><td>Tempo extra gravado depois de soltar a nota.</td><td>1–2 s preserva a cauda natural do instrumento.</td></tr>
              <tr><td><b>Auto Loop</b></td><td>Procura pontos parecidos e prepara um loop sustentado.</td><td>Search, X-Fade, Reverse X-Fade e Bidirectional; Start/End limitam a busca em % da amostra.</td></tr>
              <tr><td><b>One Shot</b></td><td>Corta a gravação quando o som cai ao silêncio.</td><td>Ideal para percussão; evita segundos de silêncio no arquivo.</td></tr>
              <tr><td><b>Input Gain</b></td><td>Ganho aplicado ao medidor/captura, de −24 a +24 dB.</td><td>Use o VU para subir sinal baixo sem clipar.</td></tr>
            </tbody>
          </table>
        </div>

        <h3 className="help-subhead"><span>4</span> Captura — progresso, resultados e recaptura</h3>
        <Figure
          src="help-auto-sampler-captura.svg"
          alt="Ilustração do passo 4 com barra de progresso 7 de 12, resultados por nota, notas ruins em vermelho, botão de recapturar só as ruins e opções de saída .mrq e .sf2/.sf3"
          caption="Passo 4: acompanhe a nota atual, identifique notas silenciosas e recapture somente elas — sem refazer a captura inteira."
        />
        <ol>
          <li>Marque <b>.mrq</b>, <b>.sf2/.sf3</b> ou ambos e clique em <b>Iniciar captura</b>. O app abre um diálogo de salvamento para cada formato escolhido antes de começar.</li>
          <li>A barra mostra fase (gravando, montando .mrq, montando .sf2), nota atual, nota/total, porcentagem e VU L/R.</li>
          <li>Ao terminar, cada nota capturada aparece com pico e status. <b>Verde</b> = áudio detectado; <b>vermelho</b> = silenciosa/ruim.</li>
          <li><b>Recapturar só as ruins</b> regrava apenas as notas vermelhas (por exemplo C#4 e F4) e mescla o resultado com as boas, sem perder o que já deu certo.</li>
          <li>Se o .mrq foi gerado, ele entra na pré-visualização/fila do Conversor; o SoundFont é reportado com o caminho salvo.</li>
        </ol>
        <Note kind="warn">
          <b>Round Robin em SF2:</b> o formato SoundFont não alterna variações nativamente. Se você gravar 2 ou mais
          round robins e gerar SF2, boa parte dos players toca todas as variações sobrepostas. O <code>.mrq</code>{' '}
          gerado no mesmo processo alterna normalmente no Rack.
        </Note>
      </section>

      {/* ---------------- RASCUNHO E RESET ---------------- */}
      <section className="help-section" id="auto-sampler-rascunho">
        <SectionHead
          icon={RefreshCw}
          title="Rascunho automático e “Voltar do zero”"
          purpose="Nunca perder ajustes por um clique acidental — e apagar tudo apenas quando você quiser, com confirmação"
        />
        <Figure
          src="help-auto-sampler-rascunho.svg"
          alt="Três cartões explicando clique fora, fechar no X e reabrir com rascunho preservado, e o botão Voltar do zero com confirmação"
          caption="Três ações diferentes: clique fora não fecha; X esconde e guarda; “Voltar do zero” apaga o rascunho depois de confirmar."
        />
        <p>
          O assistente salva automaticamente um <b>rascunho pequeno</b> a cada alteração. Além disso, quando você
          fecha no <b>X</b>, a janela não é desmontada: ela fica apenas escondida. Por isso, reabrir o Auto Sampler
          devolve exatamente o passo, as portas, o canal, as notas, a velocity, os tempos, o loop, o ganho, os testes
          e os formatos de saída. O rascunho em armazenamento local cobre também trocar de tela ou reiniciar o app.
        </p>
        <div className="help-table-wrap">
          <table className="help-table">
            <thead><tr><th>Ação</th><th>O que acontece</th></tr></thead>
            <tbody>
              <tr><td><b>Clicar fora do quadro</b></td><td>Nada. A janela continua aberta — era exatamente o caso que fazia perder todos os ajustes.</td></tr>
              <tr><td><b>Fechar no X</b></td><td>Esconde a janela; todos os ajustes e dispositivos já descobertos continuam disponíveis ao reabrir.</td></tr>
              <tr><td><b>Reabrir o Auto Sampler</b></td><td>Volta no mesmo passo com os mesmos valores. Se um dispositivo salvo estiver desconectado, o nome dele continua visível na lista para você reconectar/atualizar.</td></tr>
              <tr><td><b>Limpar tudo / Voltar do zero</b></td><td>Botão explícito no rodapé. Pede confirmação, apaga o rascunho salvo, limpa resultados da tela e volta ao passo 1 com todos os defaults.</td></tr>
              <tr><td><b>Cancelar captura / X durante captura</b></td><td>Interrompe a gravação em andamento, mas mantém as configurações para tentar de novo.</td></tr>
            </tbody>
          </table>
        </div>
        <Note kind="tip">
          <b>O que é guardado:</b> passo atual, nome do instrumento, faixa/intervalo de notas, divisórias de
          velocity, round robin, sustain/release, loop, one-shot, ganho, porta e canal MIDI, entrada de áudio,
          estado dos testes e formatos de saída. <b>Não é guardado:</b> áudio capturado em si, progresso de uma
          captura interrompida, nem os arquivos já exportados — esses continuam no disco.
        </Note>
        <Note kind="warn">
          <b>Dispositivo desconectado depois de reiniciar:</b> o nome salvo aparece na lista como “dispositivo do
          rascunho”. Reconecte o equipamento e clique em <b>Atualizar portas MIDI</b> ou{' '}
          <b>Atualizar dispositivos de áudio</b>. No macOS/Linux, o sistema pode pedir novamente a permissão de
          microfone/entrada; isso é uma regra de privacidade do sistema, não perda do rascunho.
        </Note>
      </section>

      {/* ---------------- CONVERSOR AVANÇADO ---------------- */}
      <section className="help-section" id="conversor-avancado">
        <SectionHead
          icon={Replace}
          title="Conversor avançado — fluxo, formatos e exportação SF2/SF3"
          purpose="Entender a tela inicial em 1-2-3, o inspetor, a compatibilidade honesta e onde nasce cada arquivo"
        />
        <Figure
          src="help-converter-inicio.svg"
          alt="Ilustração da tela inicial do Conversor com coluna de ações, fluxo de três passos, formatos aceitos e mini grade de zonas"
          caption="Visão geral: 1) escolher arquivos, 2) revisar/editar mapeamento, 3) converter. A exportação SF2/SF3 fica somente nesta tela."
        />
        <ol>
          <li>
            <b>Escolher arquivos:</b> use <b>Escolher arquivos…</b> ou a ação <b>Importar instrumento renderizado
            pelo Kontakt…</b>. Formatos aceitos incluem <code>.exs</code>, <code>.sf2</code>, <code>.sf3</code>,{' '}
            <code>.npno</code>, <code>.nsmp</code>, <code>.syx</code>, <code>.wav</code>, <code>.aiff</code>,{' '}
            <code>.flac</code>, <code>.mp3</code>, <code>.ogg</code> e pastas com amostras nomeadas por nota.
          </li>
          <li>
            <b>Revisar:</b> o inspetor mostra presets, grupos, zonas, amostras únicas, faixa de notas/velocity e
            amostras faltando. A aba <b>Compatibilidade</b> separa <b>Preservado</b>, <b>Aproximado</b> e{' '}
            <b>Não suportado</b> — scripts, efeitos e modulação de Kontakt não são reimplementados e isso nunca é
            escondido.
          </li>
          <li>
            <b>Editar mapeamento:</b> abre a grade key × velocity para ajustar nota raiz, afinação, faixa de teclas,
            faixa de velocity, volume e pan por zona. Clique numa tecla do teclado desenhado para definir limites sem
            decorar números MIDI.
          </li>
          <li>
            <b>Converter:</b> gere o <code>.mrq</code> nativo, leve e pronto para o Rack. A exportação adicional de{' '}
            <code>.sf2</code> e <code>.sf3</code> pertence <b>somente ao Instrument Converter</b>; o Auto Sampler
            também pode gerar SoundFont como saída da captura, mas não adiciona essa opção à tela do Auto Sampler.
          </li>
        </ol>
        <Note kind="info">
          <b>Kontakt e arquivos .nki:</b> o formato é proprietário e não é lido diretamente. O caminho suportado é
          renderizar/tocar as notas no seu Kontakt licenciado, exportar os áudios e deixar o Conversor montar o{' '}
          <code>.mrq</code> a partir deles. Isso funciona com qualquer versão do Kontakt, inclusive bibliotecas
          protegidas, porque só o áudio que você mesmo gerou é usado.
        </Note>
        <div className="help-example">
          <b>Arquivos grandes:</b> a escrita de SF2/SF3 e a leitura de SoundFont grandes são feitas em blocos e com
          checagem prévia de tamanho, para não estourar a memória fixa do motor WebAssembly nem fechar o app.
        </div>
      </section>

      {/* ---------------- DIVISÃO DE VELOCITY ---------------- */}
      <section className="help-section" id="mapeador-velocity">
        <SectionHead
          icon={Split}
          title="Editor de Mapeamento — divisão exata de velocity"
          purpose="Ajustar com mouse ou número onde começa e termina cada camada, e ver a grade/USB MIDI reagirem na hora"
        />
        <Figure
          src="help-mapping-editor-split.svg"
          alt="Editor de Mapeamento com lista de grupos, grade de zonas azuis sobre teclado, painel de divisão de velocity nos valores 10, 48 e 81 e botões Equalizar, Esticar e aplicar a todos"
          caption="Divisão de velocity: arraste as linhas brancas ou digite 10 / 48 / 81; a grade e os números de cada zona acompanham em tempo real."
        />
        <p>
          O Editor de Mapeamento organiza cada amostra como uma <b>zona</b>: áudio + faixa de teclas + faixa de
          velocity + nota raiz + afinação + volume + pan. O eixo horizontal da grade é a tecla; o vertical é a
          velocity. O painel <b>Divisão de Velocity</b> controla as linhas horizontais de um conjunto de camadas.
        </p>
        <div className="help-example">
          <b>Exemplo que motivou esta tela:</b> arestas internas <code>[0, 10, 48, 81, 128]</code> produzem quatro
          faixas sem sobreposição: <code>0–9</code>, <code>10–47</code>, <code>48–80</code> e <code>81–127</code>.
          O número numa linha é o <b>primeiro valor MIDI da parte seguinte</b>; 128 é uma borda técnica exclusiva,
          por isso a última faixa termina em 127.
        </div>
        <ul>
          <li><b>Arrastar uma divisória:</b> muda os limites reais <code>loVel</code>/<code>hiVel</code> das zonas; a grade colorida e a pré-escuta MIDI acompanham imediatamente.</li>
          <li><b>Campo numérico:</b> digite o valor exato de cada borda (por exemplo 10, 48, 81). O editor impede bordas iguais, invertidas ou fora de 0–127.</li>
          <li><b>Preset 10 / 48 / 81:</b> volta ao exemplo acima com um clique. <b>Equalizar</b> distribui as partes em tamanhos iguais; <b>Esticar</b> reparte proporcionalmente o espaço disponível.</li>
          <li><b>Arrastar uma parte inteira:</b> clique no meio de um segmento para mover o bloco, preservando a largura da faixa quando os vizinhos permitirem.</li>
          <li><b>Aplicar a todos os conjuntos:</b> replica as mesmas bordas nos empilhamentos de camadas que tenham a mesma quantidade de partes, sem precisar repetir o ajuste em cada faixa de teclas.</li>
          <li><b>Restaurar zona / Reverter tudo:</b> o primeiro desfaz só a zona selecionada; o segundo descarta as edições feitas na tela antes de converter.</li>
        </ul>
        <Figure
          src="help-auto-sampler-som.svg"
          alt="Barra azul de Velocity Response com linhas brancas arrastáveis nos valores 42 e 85, usada também como referência visual das divisórias"
          caption="A mesma ideia de “linha branca arrastável” aparece na Response do Auto Sampler: clicar perto da linha já permite puxá-la, e o primeiro arraste ativa Custom."
        />
        <Note kind="tip">
          <b>Edições que entram no arquivo:</b> para instrumentos vindos de <code>.syx</code> e <code>.exs</code>,
          nota raiz, afinação, faixas, volume e pan ajustados na tela são gravados de verdade no <code>.mrq</code>{' '}
          exportado. Nos demais formatos, a revisão visual funciona durante a sessão; loops, fades e recorte de
          início/fim de amostra ainda não estão nesta tela e são indicados como limitação, não simulados.
        </Note>
      </section>

      {/* ---------------- PRÉ-ESCUTA USB MIDI ---------------- */}
      <section className="help-section" id="conversor-midi">
        <SectionHead
          icon={KeyboardMusicIcon}
          title="Pré-escuta com controlador USB MIDI"
          purpose="Tocar uma nota no teclado físico e ver exatamente qual zona do mapa seria acionada"
        />
        <Figure
          src="help-converter-usb-midi.svg"
          alt="Diagrama de um controlador USB MIDI enviando C4 com velocity 92 ao Conversor, que acende a zona correspondente na grade de zonas"
          caption="Controlador → nota/velocity recebidas → zona acesa na grade → amostra tocada. Serve para conferir mapeamento sem exportar antes."
        />
        <ol>
          <li>Abra <b>Controlador MIDI</b> na coluna esquerda do Conversor e selecione a porta USB do seu teclado/controlador.</li>
          <li>Deixe o instrumento/grupo desejado visível no Editor de Mapeamento ou na pré-visualização.</li>
          <li>Toque uma nota. O MRQ usa a <b>nota</b> e a <b>velocity</b> recebidas para localizar a zona correspondente na grade key × velocity e a destaca.</li>
          <li>Se nenhuma zona acender, confira a faixa de teclas, a faixa de velocity e o canal MIDI. A divisão de velocity explicada na seção anterior é o lugar exato para corrigir limites como 10/48/81.</li>
        </ol>
        <Note kind="info">
          <Info size={13} /> A pré-escuta é uma conferência do mapeamento: não altera o arquivo original nem exige
          que o instrumento já tenha sido convertido.
        </Note>
      </section>

      {/* ---------------- PROBLEMAS COMUNS ---------------- */}
      <section className="help-section" id="auto-sampler-problemas">
        <SectionHead
          icon={AlertTriangle}
          title="Auto Sampler e Conversor — problemas comuns"
          purpose="Diagnóstico rápido: sem MIDI, sem áudio, permissão negada, notas silenciosas, loopback ocupado e rascunho"
        />
        <div className="help-table-wrap">
          <table className="help-table">
            <thead><tr><th>Sintoma</th><th>Causa provável</th><th>O que fazer</th></tr></thead>
            <tbody>
              <tr><td><b>Nenhuma porta MIDI aparece</b></td><td>Porta virtual não criada/ativada ou instrumento não está escutando nela.</td><td>Crie loopMIDI / IAC Driver, abra o instrumento standalone, selecione essa entrada MIDI nele e clique em Atualizar portas MIDI.</td></tr>
              <tr><td><b>Testar MIDI não produz som</b></td><td>Canal diferente, volume do instrumento zerado ou roteamento MIDI errado.</td><td>Confira o canal 1–16, teste o instrumento com o teclado do próprio computador e revise a entrada MIDI do Kontakt/synth.</td></tr>
              <tr><td><b>VU L/R não mexe</b></td><td>Dispositivo de entrada errado, permissão de microfone negada ou saída do instrumento em outro dispositivo.</td><td>No Windows prefira “Saída de som do sistema (loopback nativo)”. Com VB-Cable, selecione CABLE Output. Clique em Testar novamente agora / Conceder permissão de áudio.</td></tr>
              <tr><td><b>Erro 0x8889000A / dispositivo em uso</b></td><td><code>AUDCLNT_E_DEVICE_IN_USE</code>: outro programa abriu a saída em modo exclusivo.</td><td>Feche o app que está usando exclusividade, desative “Modo exclusivo” nas Propriedades do dispositivo do Windows e tente o loopback nativo de novo.</td></tr>
              <tr><td><b>Notas vermelhas / silenciosas</b></td><td>Instrumento sem patch naquela nota, volume baixo, canal errado ou release curto demais.</td><td>Corrija a causa e use Recapturar só as ruins; as verdes permanecem.</td></tr>
              <tr><td><b>Áudio com clipping</b></td><td>Ganho ou volume do instrumento alto demais.</td><td>Reduza Input Gain/volume até o VU ficar abaixo de 0 dBFS e recapture as notas afetadas.</td></tr>
              <tr><td><b>Arquivo SF2 muito grande fecha o app</b></td><td>Motor WebAssembly com teto de memória fixo.</td><td>A versão atual valida o tamanho e escreve em blocos; se ainda falhar, converta menos presets/velocidades por vez.</td></tr>
              <tr><td><b>Dispositivo salvo sumiu ao reiniciar</b></td><td>Hardware desconectado ou nova sessão de permissão do sistema.</td><td>O nome continua no rascunho; reconecte, atualize a lista e reconfirme a permissão de áudio no macOS/Linux.</td></tr>
              <tr><td><b>Quero recomeçar do zero</b></td><td>Rascunho antigo continua salvo de propósito.</td><td>Use Limpar tudo / Voltar do zero e confirme. Os arquivos já exportados não são apagados.</td></tr>
            </tbody>
          </table>
        </div>
        <div className="help-usecases">
          <div className="help-usecase-card">
            <h3><CheckSquare size={15} /> Antes de iniciar</h3>
            <ul><li>Ouviu o C4 no teste MIDI?</li><li>VU L/R mexeu sem clipar?</li><li>Conferiu número de notas, tempo e tamanho estimados?</li><li>Escolheu onde salvar .mrq/.sf2?</li></ul>
          </div>
          <div className="help-usecase-card">
            <h3><Piano size={15} /> Para instrumentos acústicos</h3>
            <p>Use mais velocities, sustain longo e release generoso. Intervalos de 2 ou 3 semitons equilibram qualidade e tempo; cromático é mais fiel, porém bem maior.</p>
          </div>
          <div className="help-usecase-card">
            <h3><AudioWaveform size={15} /> Para percussão</h3>
            <p>Preset Percussão / One-shot, release curto, one-shot ligado e round robin se quiser variações naturais de cada golpe.</p>
          </div>
          <div className="help-usecase-card">
            <h3><Database size={15} /> Para bibliotecas grandes</h3>
            <p>Comece com menos notas/velocidades, valide o roteamento e aumente a faixa depois. O rascunho permite parar, ajustar e continuar sem refazer tudo.</p>
          </div>
          <div className="help-usecase-card">
            <h3><FileText size={15} /> Documentação técnica</h3>
            <p>Os detalhes de implementação ficam em <code>docs/mrq-instrument-converter/</code>: <code>mrq-auto-sampler.md</code>, <code>mrq-mapping-editor.md</code> e <code>mrq-converter-sf2-export.md</code>.</p>
          </div>
        </div>
      </section>
    </>
  );
}
