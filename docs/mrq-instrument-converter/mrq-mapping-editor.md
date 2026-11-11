# Editor de Mapeamento (Mapping Editor)

Tela de edição de **zonas** do MRQ Instrument Converter, modelada no
**Mapping Editor do Native Instruments Kontakt** (a tela da foto enviada:
`image-44.png`). Abre pelo botão **"Editar mapeamento"** na faixa de
pré-visualização de qualquer item já inspecionado da fila.

> **Escopo honesto:** não é uma cópia do código nem dos arquivos `.nki` da
> Native Instruments (formato proprietário, sem engenharia reversa — ver
> `mrq-converter-architecture.md` §6). É um **clone funcional da interface e
> do fluxo de trabalho**, operando sobre o `MrqInstrumentModel` aberto deste
> app. Onde o formato `.mrq` de hoje não tem campo equivalente, a tela diz
> isso explicitamente em vez de fingir que salvou.

---

## 1. Pesquisa: o que o Mapping Editor do Kontakt faz

Fontes consultadas:

- Manual oficial Kontakt (Classic view → Mapping Editor):
  https://www.native-instruments.com/ni-tech-manuals/kontakt-manual/en/classic-view
- Manual Kontakt 6.02, cap. 17–18 (Zone grid, control strip, Edit menu,
  Batch tools): https://usermanual.wiki/Pdf/KONTAKT602ManualEnglish.1091117411/html
- ADSR — *The Kontakt Mapping Editor*:
  https://www.adsrsounds.com/kontakt-tutorials/the-kontakt-mapping-editor/
- ADSR — *Creating Kontakt Instruments for Beginners*:
  https://www.adsrsounds.com/kontakt-tutorials/creating-kontakt-instruments-for-beginners/
- Sound On Sound — *Native Instruments Kontakt 3* (auto-mapping por nome de
  arquivo, rubber-band zoom):
  https://www.soundonsound.com/reviews/native-instruments-kontakt-3

### 1.1 Hierarquia

`Sample` (arquivo de áudio) → `Zone` (amostra + faixa de tecla + faixa de
velocity + nota-raiz + volume/pan/tune) → `Group` (conjunto de zonas com
mesmo caminho de sinal) → `Instrument` → `Instrument Bank`.

Uma **Zone** é o retângulo colorido da foto: ela responde quando a nota MIDI
estiver entre `loKey..hiKey` **e** a velocity entre `loVel..hiVel`. A nota-raiz
(`Root Key`) é o pitch original da amostra: nessa tecla não há transposição.

### 1.2 As três áreas da tela

| Área | Função |
| --- | --- |
| **Control strip** (duas fileiras no topo) | Botões e menus que operam sobre as zonas selecionadas: Auto-Spread, Auto-Map, Resolve Overlaps, Set Key/Velocity Range via MIDI, Lock Zones, Zone Solo, Selected Groups Only, Auto Sel Grp, List View, Left View. |
| **Status line** | `Key Range`, `Vel Range`, `Root Key`, `Volume`, `Pan`, `Tune` da zona selecionada; aceita arrastar o valor para cima/baixo ou digitar. À direita, `Sample:` + `EDIT` (abre o Wave Editor). |
| **Zone grid** | Plano 2D: **eixo X = teclado (0..127)**, **eixo Y = velocity (0 embaixo, 127 em cima)**. Teclado clicável embaixo, com a nota-raiz da zona selecionada em **amarelo**. Barras de zoom/scroll. |

Na foto: a zona amarela é a **selecionada** (`B1 – A#2`, `Vel 1–127`,
`Root B2`), as zonas azuis são as demais do mesmo grupo; os nomes das amostras
aparecem escritos na vertical dentro de cada retângulo.

### 1.3 Edição gráfica (o coração da tela)

- Clique na zona = selecionar; **Shift+clique** = seleção múltipla; arraste no
  vazio = **laço** (lasso) de seleção.
- Arraste **dentro** da zona = move a zona inteira pelo teclado.
- Arraste na **borda esquerda/direita** = muda `loKey`/`hiKey`.
- Arraste na **borda superior/inferior** = muda `hiVel`/`loVel`.
- Arraste a **tecla amarela** no teclado = muda `Root Key`.
- **Ctrl+setas** move a faixa (1 nota / 2 velocity); **Ctrl+Shift+setas**
  ajusta só o limite superior.
- **Ctrl+clique** nas bordas cria **crossfades** (X-Fade) entre zonas.
- **Alt+laço** = rubber-band zoom.
- Duplo clique na zona abre o **Wave Editor** (forma de onda + loop).

### 1.4 Mapeamento de samples

- Arrastar 1 sample pra grade cria uma zona: embaixo = 1 tecla, em cima =
  teclado inteiro; a altura do ponteiro define a faixa de teclas.
- Arrastar vários samples cria zonas adjacentes; soltando-os **sobre uma tecla**
  do teclado divide a **velocity** em camadas (velocity switches).
- **Auto-Map**: lê tokens do nome do arquivo (`Piano_C3_v64-95.wav`,
  `Bass_64-100_C2.wav`) e preenche nota/faixa/velocity automaticamente.
  Pode ler root key de metadados embutidos.

### 1.5 Control strip / Edit menu / Batch tools

| Recurso | O que faz |
| --- | --- |
| Auto-Spread Zone Key Ranges | Estica cada zona até encostar na vizinha, preenchendo buracos (ignora root keys). |
| Auto-Spread Key Ranges via Root Key | Mesmo, mas limites nos pontos médios entre notas-raiz (mínima transposição). |
| Auto-Spread Velocity Ranges | Preenche buracos de velocity. |
| Resolve Overlapping Key/Velocity Ranges | Faz o inverso: corta sobreposições. |
| Auto-Map Selected | Aplica o scanner de nomes de arquivo às zonas selecionadas. |
| Set Key Range via MIDI | Próximas **2 notas** tocadas viram `loKey`/`hiKey`. |
| Set Velocity Range via MIDI | Próximas **2 velocities** viram `loVel`/`hiVel`. |
| Select Zone via MIDI | Tocar uma nota seleciona a zona que responde a ela. |
| Auto Select Group | Seleciona/isola o grupo da zona tocada. |
| Zone Solo | Só as zonas selecionadas soam. |
| Selected Groups Only | Mostra apenas grupos das zonas selecionadas. |
| Lock Zones | Protege contra arrastes acidentais. |
| Auto Move Root Key | Ao mover a zona, a raiz acompanha. |
| Edit → Copy / Paste / Delete / Exchange Sample | Área de transferência de zonas; trocar o sample mantendo as faixas. |
| Batch → Auto-Apply X-Fades, Remove X-Fades | Crossfades por key/velocity. |
| Batch → Move Root Key(s) to Lower/Center/Upper Border | Move raízes em lote. |
| List View | Planilha com todas as zonas, útil quando há zonas empilhadas. |

---

## 2. O que foi implementado (v0.2.12)

### Grade e edição — 1:1

- Grade **128 notas × 128 velocities**, linhas de oitava/semitom e régua de
  velocity (127, 112, … 0), teclado clicável embaixo, nota-raiz em amarelo
  com **alça arrastável**.
- Zonas como retângulos com **nome da amostra na vertical**, cor por grupo,
  zona selecionada em amarelo (igual à foto), marcador branco da raiz.
- Arraste: mover, 4 bordas, raiz, laço, Shift+clique; **Ctrl/Shift+setas**;
  desfazer/refazer (Ctrl+Z / Ctrl+Shift+Z); zoom horizontal e vertical.
- **Status line** completa e editável (aceita `C3` ou número MIDI), botão
  **EDIT** abre painel de **forma de onda real** com marcadores de loop e
  botão *Tocar amostra*.
- **List View** com células editáveis (clique, digite, Enter/blur confirma).
- **Left View** com grupos, cores, contagem, olho para mostrar/ocultar.

### Ferramentas — 1:1

Auto-Map por nome (notas, faixas `C3-D4`, pares de velocity `v1-64`,
marcas `pp/mf/ff`), os três Auto-Spread, os dois Resolve, copiar/colar/excluir/
selecionar todas/trocar amostra, Auto Move Root Key, os três "Move Root em
lote", Zone Solo, Selected Groups Only, Auto Sel Grp, Lock Zones, X-Fades
(ver §3), **Set Key/Velocity Range via MIDI** e **Select Zone via MIDI**.

### Pré-escuta com controlador MIDI USB — o pedido principal

O editor assina `onRackRawMidiNote`, adicionado ao roteador Web MIDI que o
Rack já usa (não abre uma segunda conexão, não sobrescreve
`input.onmidimessage`). Ao tocar uma nota no teclado USB:

1. Procura as zonas cuja faixa de tecla **e** de velocity cobrem nota/velocity.
2. Toca o **PCM real** da amostra: `mrqExtractSample` no `.mrq` já convertido,
   ou `readFileBytes` + `decodeAudioData` no arquivo de áudio de origem
   (WAV/AIFF/FLAC/MP3/OGG). O áudio fica em cache por `sampleId`.
3. Aplica `playbackRate = 2^((nota - root + tuneCents/100)/12)`,
   `10^(volumeDb/20)`, pan estéreo, escala por velocity e loop (quando houver).
4. Acende a coluna da nota na grade, pisca as zonas disparadas, destaca a
   tecla no teclado e mostra buracos: *"nenhuma zona nesta região"*.
5. `note-off` encerra as vozes com release curto.

Há também **teclado na tela** clicável, com slider de velocity (1–127), e um
seletor da entrada MIDI na segunda fileira ("Todas as entradas" ou um
dispositivo USB específico). Badge **"amostra real"** × **"tom de referência"**
deixa claro quando o timbre é o original e quando é o fallback sintético
(triangle) — usado quando o item ainda não foi convertido e a origem é um
banco (SF2/SF3/NPNO/NSMP etc.) cujas amostras internas o WebView não consegue
decodificar isoladamente.

### Adaptações conscientes

| Kontakt | Aqui |
| --- | --- |
| Arrastar samples do Browser/SO pra criar zonas | A janela Tauri roda com `dragDropEnabled: false` (motivo em `InstrumentConverter.tsx`); a criação de zonas é feita por **Colar** (+12 semitons), **Auto-Map** e importação normal. |
| Ctrl+arraste nas bordas = crossfade de áudio | Marcador **visual** (borda tracejada + gradiente + coluna `XF` na List View). O `MrqZone` não tem campo de crossfade hoje; a tela avisa no banner. |
| Exchange Sample abre seletor de arquivo | Diálogo com as amostras já presentes no instrumento (mantém faixas e parâmetros). |
| Alt+laço = zoom | Botões de zoom +/− na segunda fileira. |
| Grupos com sinal/módulos próprios | Grupos são contêineres de zonas no modelo MRQ; sem cadeia de sinal por grupo. |

### Persistência (inalterada e documentada)

As edições são salvas no item da fila (`editedInstrument`) pelo botão
**Salvar edições**. Para `.syx` (DX7) e `.exs` (EXS24) a conversão roda
inteiramente no WebView e **usa o modelo editado de verdade**. Para os demais
formatos a conversão é um comando Rust opaco que reconstrói o mapeamento do
arquivo de origem; as edições ficam guardadas na sessão, e o banner amarelo
no topo diz isso claramente.

---

## 3. Tela principal (foto 2)

O problema apontado: com a fila vazia, a área principal era um retângulo
preto com duas frases soltas e quatro botões empilhados sem hierarquia.

O que mudou:

- **Coluna esquerda**: botão laranja grande "Escolher arquivos…", dropzone
  com formatos, seção **"Do Kontakt / ao vivo"** com três cartões (Auto
  Sampler, Instrumento renderizado, Controlador MIDI) cada um com ícone,
  título e uma linha explicando o que faz; seção **"2. Fila de conversão"**
  com contadores de arquivos/convertidos/erros.
- **Área principal**: novo `ConverterHome` — título com proposta de valor,
  fluxo numerado **1 Importe → 2 Inspecione e edite → 3 Converta**, quatro
  cartões de ação, arquivos recentes clicáveis, lista de formatos aceitos e
  uma dica que explica onde ficam os botões de Converter / Editor de
  Mapeamento / Exportar SF2-SF3 depois de importar.
- Quando há item selecionado mas ainda sem inspeção, aparece um estado
  intermediário explicativo em vez de um vazio sem contexto.

Nenhuma lógica de conversão foi movida: `ConverterHome` é puramente
apresentacional e recebe callbacks de `InstrumentConverter`.

---

## 4. Como testar

1. Importe um instrumento (ou gere um pelo Auto Sampler) e **converta** para
   `.mrq` — assim a pré-escuta usa a amostra real.
2. Selecione o item e clique **"Editar mapeamento"**.
3. Conecte o controlador MIDI USB, escolha a entrada na 2ª fileira e clique
   no botão ▶ (Ativar áudio) se o navegador exigir gesto.
4. Toque notas: veja a coluna acender, as zonas piscarem e ouça o timbre com
   a afinação/volume/pan da zona.
5. Arraste as bordas de uma zona, a alça amarela da raiz, use o laço,
   Ctrl+setas; teste Auto-Spread / Auto-Map / Set Key Range via MIDI.
6. Dê duplo clique numa zona para ver a forma de onda; **Salvar edições**
   guarda tudo no item da fila.

---

## 5. Divisórias de Velocity (v0.2.13) — ajuste com o mouse, posição exata de cada amostra

Pedido do usuário, a partir da foto do `VelocityBreakpointEditor` do Auto
Sampler (barra azul com alças arrastáveis e a legenda *"Arraste uma divisória
..."*): **"consegue fazer com que eu ajuste com o mouse as regiões de velocity
que quero mover, o lugar ou posição certa de cada amostra — tipo 0 a 10 parte
1, 10 a 48 parte 2, 48 a 81 parte 3, 81 a 127"**.

A barra foi levada para o Editor de Mapeamento com uma diferença importante:
no Auto Sampler ela edita os pontos de quebra de uma *curva de resposta*;
aqui ela edita **as faixas `loVel`/`hiVel` das zonas reais**. Arrastar uma
divisória escreve no modelo, e a grade key×velocity muda junto, em tempo real
— o som tocado pelo controlador MIDI USB passa a disparar a amostra certa na
nova faixa.

### Como abrir

Botão **"Divisórias de Velocity"** na 2ª fileira do control strip, ou
`Edit → Abrir divisórias de Velocity…`.

### O que dá pra fazer

| Ação | Efeito |
| --- | --- |
| Arrastar uma **divisória** (alça amarela com o número) | Muda `hiVel` da parte à esquerda e `loVel` da parte à direita, sem nunca inverter a ordem nem deixar uma parte com menos de 1 velocity. |
| Arrastar o **corpo** de uma parte | Desloca a camada inteira: as duas bordas andam juntas (útil para reposicionar uma amostra). |
| Clicar numa parte / no cartão abaixo | Seleciona a zona (a grade e a status line acompanham). |
| Duplo clique | Abre o Wave Editor da amostra. |
| **Distribuir igualmente** | Divide 0–127 em N partes iguais. |
| **Esticar pontas 0–127** | Faz a 1ª parte começar em 0 e a última terminar em 127, mantendo as divisórias internas. |
| Preset **4 partes · 10 / 48 / 81** | Aplica exatamente o exemplo pedido. |
| Campo **"Divisórias exatas"** | Digite `10, 48, 81` (ou qualquer lista com N−1 valores) e clique Aplicar/Enter. |
| **Aplicar a todos os conjuntos** | Num piano multisampleado cada faixa de teclas tem sua própria pilha de camadas. Um único arraste replica as mesmas divisórias em todos os conjuntos com o mesmo número de camadas. |
| Seletor **"Conjunto de camadas"** | Escolhe qual pilha (grupo + faixa de teclas) está sendo editada. |

### Convenção dos números (importante)

As faixas **não se sobrepõem** (como no Kontakt). O número mostrado na
divisória é o **início da parte seguinte**. Então divisórias em
**10 / 48 / 81** produzem:

| Parte | Amostra | Faixa MIDI real |
| --- | --- | --- |
| 1 | amostra mais suave | `0–9` |
| 2 | ... | `10–47` |
| 3 | ... | `48–80` |
| 4 | amostra mais forte | `81–127` |

É exatamente o "0 a 10 / 10 a 48 / 48 a 81 / 81 a 127" da foto, só sem
repetir o valor de fronteira dentro de duas zonas ao mesmo tempo. Áreas
**cinzas** na barra indicam buracos (velocity sem nenhuma amostra); o botão
*Esticar pontas* remove esses buracos.

### Implementação

- `src/audio/rack/velocitySplit.ts` — lógica **pura** e testável:
  `deriveEdges`, `sanitizeEdges`, `edgesToRanges`, `edgesToPatches`,
  `moveDivider`, `moveSegment`, `equalEdges`, `stretchEdges`.
- `src/components/VelocitySplitEditor.tsx` — barra com `PointerEvent` +
  `setPointerCapture` (funciona com mouse e touch), réguas 0/16/…/127,
  cartões por amostra, presets e campo de valores exatos.
- `src/components/MappingEditor.tsx` — agrupa as zonas visíveis por
  `grupo + loKey + hiKey` para montar os "conjuntos de camadas", aplica os
  patches via `applyPatches` (com histórico/Desfazer) e mantém a grade
  sincronizada.
- `scripts/test-velocity-split.mjs` — 14 testes de regressão, incluindo o
  exemplo `10/48/81`, arrastes com clamp, distribuição igual, esticar pontas
  e replicação em vários conjuntos. Rode com `npm run test:velocity-split`.

---

## 6. v0.2.14 — "clicar aqui e mover as linhas da região"

A foto seguinte (`image-47.png`) é a barra **Velocity Response do Auto
Sampler** (faixas azuis 1/2/3 com linhas brancas). O usuário queria clicar
ali e mover as linhas com o mouse — e não conseguia.

**Causa real:** `VelocityBreakpointEditor.handlePointerDown` começava com
`if (!editable ...) return`, e `AutoSamplerDialog` passava
`editable={velocityResponse === 'custom'}`. Ou seja, no preset padrão
(linear) as divisórias eram **somente leitura** — o texto de ajuda até
dizia "arraste uma divisória pra trocar automaticamente pra Custom", mas o
código bloqueava o arraste. Contradição entre UI e comportamento.

**Correção:**

- `editable` agora significa "pode arrastar" (falso só durante a captura).
  O primeiro arraste entrega os novos pontos a
  `handleDragVelocityBreakpoints`, que já trocava pra `custom` e guardava
  `customVelocityBreakpoints` — o motor `computeVelocityBreakpoints` já
  consumia esse array, só faltava liberar o gesto.
- Alça clicável de **18 px** (antes 10), com "puxador" branco visível no
  meio da linha, cursor `ew-resize`, destaque amarelo durante o arraste e
  número do valor MIDI acima de cada linha.
- Dá para clicar **dentro** de uma faixa, perto da linha (tolerância de 8
  unidades MIDI), e pegar a divisória — `nearestDraggableDivider`.
- Ponteiro capturado no SVG inteiro (`setPointerCapture`), então o arraste
  não se perde ao sair da alça; funciona com mouse e touch
  (`touch-action: none`).
- Lógica pura extraída em `src/audio/rack/velocityBreakpointDrag.ts`
  (`moveBreakpoint`, `nearestDraggableDivider`, `clientXToVelocity`) com
  **10 testes** em `scripts/test-velocity-breakpoint-drag.mjs`
  (`npm run test:velocity-breakpoint-drag`), incluindo "arrastar num preset
  linear gera pontos customizados válidos".

**No Editor de Mapeamento**, a mesma ideia foi aplicada à barra de
divisórias de velocity da §5: clicar dentro de uma parte, a até 4 unidades
de uma divisória, agora move a **linha** (não a camada inteira). Além disso
o painel de divisórias **abre automaticamente** quando o instrumento tem
camadas empilhadas (respeitando se o usuário o fechou), para a barra estar
visível no lugar esperado sem precisar procurar o botão.
