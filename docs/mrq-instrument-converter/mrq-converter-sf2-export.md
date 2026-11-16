# Escolher a saída: `.mrq`, `.sf2` ou `.sf3`

A tela do **MRQ Instrument Converter** oferece os três formatos de saída no
mesmo grupo **"Formato de saída"** — útil tanto para o `.mrq` nativo do Rack
quanto para sampler/sintetizador que só lê SoundFont (plugins free, hardware,
DAWs sem suporte a `.mrq`). Desde a v0.2.16, **não é mais necessário salvar
um `.mrq` antes de habilitar SF2/SF3**: os três botões ficam disponíveis
assim que o item está **PRONTO** e tem zonas com amostra.

## Como usar

1. Importe o arquivo de origem e aguarde o status **PRONTO** — qualquer um
   dos formatos suportados (MRQ/SF2/SF3/NPNO/NSMP/SYX/EXS/WAV/AIFF/FLAC/
   MP3/OGG) ou um resultado de Auto Sampler/captura Kontakt. Um `.mrq`
   importado já entra carregado e pronto para escolher `.sf2`/`.sf3`.
2. Clique diretamente em **"Converter para .mrq"**, **"Exportar .sf2"** ou
   **"Exportar .sf3"**. O formato escolhido fica destacado.
3. Escolha onde salvar. Para `.sf3`, confirme o aviso de que o arquivo ainda
   é PCM sem compressão Vorbis.
4. Se escolheu SoundFont sem ter um `.mrq` salvo, o app cria um `.mrq`
   **temporário** nos bastidores, lê as amostras reais dele, monta o
   SoundFont, grava o destino e remove o temporário. Só um "Salvar como"
   aparece para o usuário.

Instrumentos com **múltiplos presets** (ex.: um banco `.sf2` importado com
vários instrumentos, ou um banco `.syx` DX7 com até 32 patches) viram um
SoundFont com **múltiplos presets de verdade** (um programa MIDI por
preset de origem), não um instrumento único misturando tudo.

## Sobre o ".sf3" gerado aqui

**Importante:** o `.sf3` que este conversor gera **não é comprimido**. O
formato SF3 "de verdade" guarda as amostras como Ogg Vorbis (arquivo bem
menor); este app ainda não tem um codificador Vorbis embutido, então o
`.sf3` salvo aqui é, por dentro, exatamente o mesmo PCM 16-bit sem
compressão de um `.sf2` — só com a extensão trocada. Ele **toca
normalmente** em qualquer sintetizador compatível com SF2/SF3 (o conteúdo
real decide o que tocar, nunca a extensão do nome do arquivo), só não fica
menor. O app avisa isso antes de salvar como `.sf3` (diálogo de
confirmação) — se o objetivo é economizar espaço em disco, `.mrq` (que usa
FLAC, com compressão sem perdas de verdade) continua sendo a melhor opção
nativa; adicionar compressão Vorbis real ao `.sf3` fica como possível
melhoria futura (exigiria um codificador Vorbis — nenhuma opção pura-Rust
madura foi encontrada ainda sem adicionar dependência C/FFI ao build).

## O que NÃO é preservado no SF2/SF3 (mesma limitação do Auto Sampler)

O escritor (`src/audio/rack/sf2Export.ts`) grava tecla/velocity/nota-raiz/
loop/estéreo corretamente, mas **não** tem generators pra:

- Afinação fina por zona (`tuneCents`)
- Ganho por zona (`volumeDb`)
- Envelope (ADSR) e filtro por zona/grupo

Ou seja: um round-trip `.sf2 → .mrq → .sf2` (ou qualquer outro formato de
entrada com esses ajustes) toca as notas certas, nas teclas certas, com
loop certo — mas sem o envelope/afinação/ganho fino do instrumento
original. Isso é uma limitação conhecida, não um bug a corrigir
silenciosamente — ampliar os generators suportados é trabalho futuro.

## 8. v0.2.16 — escolha direta do formato (correção da foto)

**Problema:** a foto enviada pelo usuário mostrava o item "PRONTO" com
`Converter para .mrq` amarelo e `Exportar .sf2` / `Exportar .sf3` cinzas. A
causa era a condição `disabled={!item.convertedPath || ...}` na
`PreviewStrip`: o escritor `buildSf2FromMrqInstrument` precisa de um `.mrq`
em disco para chamar `mrq_extract_sample`, então a UI obrigava o usuário a
salvar um `.mrq` primeiro — contrariando a exigência de escolher livremente
entre os três formatos de saída.

**Correção:**

- `src/audio/rack/converterOutputFormat.ts` centraliza a disponibilidade dos
  três formatos, as opções do diálogo "Salvar como", o nome do `.mrq`
  temporário e a limpeza. Um item inspecionado com zonas habilita `.mrq`,
  `.sf2` e `.sf3`; itens já convertidos (inclusive Auto Sampler/captura)
  habilitam os dois SoundFonts mesmo sem formato de origem.
- `PreviewStrip` virou um grupo **"Formato de saída"** com os três botões
  sempre visíveis, `aria-pressed` no selecionado, destaque amarelo, tooltip
  com o motivo quando desabilitado e dica explícita de que SF2/SF3 salvam
  direto.
- `exportItemToSoundFont` agora aceita um item **sem** `convertedPath`: cria
  `mrq-sf-export-<timestamp>-<salt>.mrq` em `tempDir()`, chama `convertAny`
  com `libraryRoot`/`overrideInstrument`, lê `mrqReadMetadata` para usar o
  modelo real resultante (incluindo edições de mapeamento), monta o
  SoundFont e apaga o temporário. Se já existe `.mrq`, reaproveita o arquivo.
- O comando Rust `remove_temp_converter_file` (`fsops.rs`, registrado em
  `lib.rs`) só remove caminhos absolutos cujo nome comece com
  `mrq-sf-export-` e termine em `.mrq` — não é um "apagar arquivo qualquer".
- A Ajuda ganhou a seção **"Escolher o formato de saída"**, com a tela real
  do antes, um comparativo ilustrado e tabela do fluxo de cada formato.
- `scripts/test-converter-output-format.mjs` cobre 9 casos: item PRONTO com
  os três habilitados, item já convertido, Auto Sampler/captura, instrumento
  sem zonas, estados ocupados, origem desconhecida, diálogos/filtros por
  extensão e nomes temporários seguros (`npm run test:converter-output-format`).

O aviso de `.sf3` sem compressão Vorbis continua antes do salvamento; a
exportação SF2/SF3 continua **somente no Instrument Converter**, não foi
adicionada como opção extra na tela do Auto Sampler.

## 9. v0.2.17 — importar/carregar `.mrq` e consertar FLAC curto

**Problema da foto:** `Astoria Grand XL 6.1.mrq` entrava na fila com
`Extensão não reconhecida pelo conversor`; nas tentativas de exportar SF2
aparecia `decodeError: Ill-formed FLAC stream: invalid block size, must be at
least 16`. Eram dois bugs independentes:

1. **`EXTENSION_MAP` não tinha `mrq`.** O formato nativo do app não podia ser
   usado como ORIGEM no Conversor, então não carregava o instrumento nem
   liberava a conversão para SoundFont.
2. **`flacenc` 0.5.1 + `claxon` 0.4.3.** Quando o tamanho de uma amostra
   terminava num último bloco de 1–15 frames (`len % 4096`), o encoder gravava
   esse bloco curto como `min_block_size` do STREAMINFO. O FLAC exige mínimo
   16 e o `claxon` recusava o stream antes de decodificar qualquer amostra.

**Correção:**

- `ConverterFormatId` ganhou `'mrq'`; o seletor de arquivos, os rótulos, a
  checagem de assinatura `MRQ1` e o dispatcher `inspectAny`/`convertAny`
  reconhecem o formato nativo.
- `src/audio/rack/mrqSource.ts` lê `mrq_read_metadata`, devolve o instrumento
  + índice de amostras e monta um relatório de compatibilidade honesto. Ao
  inspecionar, `InstrumentConverter.tsx` marca o próprio arquivo como
  `convertedPath`/`convertedMetadata`: pré-escuta, Mapping Editor e os botões
  `.sf2`/`.sf3` funcionam imediatamente, sem conversão redundante.
- `Converter para .mrq` num `.mrq` importado vira **"Salvar/copiar .mrq"**:
  o comando Rust `copy_converter_file` copia em streaming e recusa origem =
  destino. Nenhum áudio é recodificado.
- `exportItemToSoundFont` usa `editedInstrument` diretamente quando já há um
  `.mrq`: as zonas continuam referenciando os mesmos `sampleId`s, então as
  edições de mapeamento entram no SF2 sem criar outro arquivo temporário.
- `writer.rs` agora força `min == max == block_size` no STREAMINFO depois de
  `encode_with_fixed_block_size`, como exige o modo de bloco fixo do FLAC. O
  último frame curto continua presente e `total_samples` não muda.
- `reader.rs` repara **em memória** o STREAMINFO de `.mrq` antigos antes de
  chamar `claxon`, sem alterar o arquivo e depois da checagem SHA-256. Assim,
  instrumentos já exportados em versões anteriores voltam a abrir/exportar.
- Testes: `scripts/test-mrq-source.mjs` (7 casos: extensão, assinatura,
  dispatcher, metadados, habilitação dos três formatos e diálogo) e novos
  testes Rust em `reader.rs`/`writer.rs` para STREAMINFO inválido e amostras
  de 5 e 4097 frames.

Limitação mantida: `.sf3` ainda é PCM sem compressão Vorbis; o aviso antes de
salvar continua. A exportação SF2/SF3 continua apenas no Instrument Converter.

## 10. v0.2.18 — fim do travamento ("fica só girando, não converte nada")

**Sintoma relatado:** clicar em **Exportar .sf2** (e também converter
SF2→MRQ em bibliotecas grandes) mostrava o spinner para sempre, sem
terminar e sem nenhum progresso visível.

**Causa raiz (exportação SF2):** `buildMultiPresetSf2Binary` escrevia o
PCM no chunk `smpl` com um `ByteWriter.i16()` **por sample point** — cada
chamada alocava um `Uint8Array(2)` e empurrava num array de partes.
Medido antes da correção: 1M de frames estéreo (2M sample points)
levavam 4,5s; 3M de frames estouravam a memória (processo morto). Um
piano multisample real tem dezenas de milhões de frames — a exportação
nunca terminava. Agravantes: cada zona disparava um `mrq_extract_sample`
separado (centenas de invokes sequenciais, cada um reabrindo o `.mrq` e
reparseando o JSON inteiro), todas as amostras eram retidas em Float32
até o fim (dobro da memória), e a escrita do arquivo final serializava
cada byte como número JSON (`Array.from(bytes)`).

**Correção:**

- `sf2Export.ts`: novo `ByteWriter.pushInt16Array` — o PCM inteiro de
  cada amostra é escrito em **uma única alocação**. `Sf2ExportZone`
  agora carrega `pcmInt16` (Int16 intercalado) em vez de Float32, com
  `float32ToInt16Interleaved` exportado pra quem extrai o áudio
  converter na hora e descartar o Float32 (metade da memória retida).
  Medido depois: 5M de frames estéreo montam em ~110ms (antes: OOM).
- `mrqToSf2Export.ts` + novo comando Rust `mrq_extract_samples`: as
  amostras únicas são extraídas em **lotes** (metadados lidos uma vez
  só no backend), com `onProgress(done, total)` a cada lote e cessão
  do event loop entre lotes. A UI mostra **"Exportando .sf2…
  128/512 amostras (há 12s)"** com barra de progresso, em vez de um
  spinner cego.
- `sf2.rs`/`npno.rs`: `convert_to_mrq` não reabre nem reparseia mais o
  arquivo uma segunda vez (`inspect_loaded`/`inspect_entity`
  reaproveitam o `SoundFont2`/`Entity` já carregado) — metade do tempo
  e da memória na conversão SF2/NPNO→MRQ.
- `save_binary_file` agora recebe blocos em **base64** (não mais
  `number[]` JSON): payload ~4x menor e parse muito mais rápido em
  SoundFonts de centenas de MB. `writeBinaryFileSafe` e
  `tauriBridge.saveBinaryFile` codificam em base64.
- Testes: novo `scripts/test-sf2-export-large.mjs` (4 casos: conversão
  Int16 com limite, montagem de 5M de frames estéreo em < 5s, RIFF
  válido e PCM conferido byte a byte no chunk `smpl`); o espião de
  `test-mrq-to-sf2-export.mjs` agora cobre o lote `mrq_extract_samples`
  e o callback `onProgress`.

Limitação mantida: `.sf3` ainda é PCM sem compressão Vorbis; o aviso
antes de salvar continua. A exportação SF2/SF3 continua apenas no
Instrument Converter.

## 13. v0.2.21 — Estúdio de Instrumentos Convertidos

Novo fluxo reaproveitando os componentes existentes (nada foi duplicado):

- **Gerenciador** (`convertedInstruments.ts` + painel no Conversor):
  lista persistida em `localStorage` (`mrq.convertedInstruments.v1`, máx.
  200 entradas, dedupe por caminho). Todo `.mrq` convertido entra
  automaticamente; botão mostra/oculta; cada item abre no Estúdio.
- **Editor de Samples** (`InstrumentStudio.tsx`): lista de samples,
  waveform em canvas, trim por frames (início/fim) com validação
  (`clampTrim` rejeita seleções vazias/invertidas), auto-trim de
  silêncio (~-40 dBFS) e edição de zonas (root, teclas, velocity,
  afinação, volume, pan, loop).
- **Salvar sem recomprimir** (Rust `mrq_rebuild_with_model` em
  `writer.rs`): samples sem trim são copiados byte a byte do `.mrq`
  original (mesmo SHA-256); samples com trim são decodificados,
  recortados e re-codificados em FLAC na profundidade original. Loops
  das zonas que referenciam samples recortados são deslocados e
  limitados ao novo tamanho (desativados se ficarem inválidos).
  Escrita atômica com validação de integridade antes da troca.
- **Estúdio de Teste MIDI**: motor `MrqLayerVoice` existente tocando o
  instrumento carregado; teclado USB via Web MIDI
  (`navigator.requestMIDIAccess`) + `PlayableKeyboard` na tela.
  O timbre ouvido no teste é o do arquivo salvo.
- **Reabrir depois**: a lista persiste entre sessões; o Estúdio também
  abre qualquer `.mrq` pelo diálogo de arquivo.
- Testes: `scripts/test-converted-instruments.mjs` (8 casos) + 4 testes
  Rust em `writer.rs` (cópia verbatim, trim com ajuste de loop, loop
  inválido desativado, trim fora do limite falha sem tocar o destino).

## 14. v0.2.22 — Controles ao Vivo

Nova página com os controles globais do instrumento inteiro (escopo
"INSTRUMENTO INTEIRO"), pra pré-escutar o som final como ele vai sair num
rack de instrumentos ao vivo. Reaproveita o motor existente, sem duplicar:

- **Entrada:** botão "Controles ao Vivo" ao lado do "Editar mapeamento"
  (Conversor), no cabeçalho do Estúdio e ícone de sliders na barra lateral.
  Abre já com o `.mrq` selecionado (convertido ou origem `.mrq`).
- **Controles (27):** NOTA MIN/MAX, TECLA RAIZ, VELOCIDADE MIN/MAX
  (steppers) + VOLUME dB, PAN, AFINACAO cents, ATAQUE/RELEASE/SUSTAIN,
  EQ GRAVES/MEDIOS/AGUDOS, DRIVE (knobs) + EFEITOS/AO VIVO: REVERB
  (TAMANHO/DAMP/PRE-DELAY/COR), STEREO, DELAY (TEMPO/FEEDBACK), CHORUS
  (RATE/DEPTH). Knob novo (`Knob.tsx`): arraste vertical, roda do mouse,
  setas do teclado, duplo-clique reseta.
- **Motor:** `LiveInstrumentEngine` = `MrqLayerVoice` (carrega/toca o
  `.mrq`) + gate de envelope global com contagem de notas (o `noteOff` da
  voz é adiado até o gate fechar, então RELEASE longo funciona de verdade)
  + `LiveFxChain` (EQ 3 bandas → drive → chorus → delay com realimentação
  filtrada → largura mid/side mono-safe → master; reverb em envio com IR
  estéreo gerada, pré-delay e cor). TECLA RAIZ transpõe em relação à
  `rootNote` mais comum das zonas; AFINACAO usa o pitch bend da voz
  (afeta notas já soando). O `rackEngine` global (singleton do rack) não
  é usado — engine dedicado, sem interferência.
- **Tocar:** teclado na tela (`PlayableKeyboard`), teclas do computador
  ("A" = tecla raiz, mesmo mapa do MidiControllerDialog) e teclado USB
  MIDI via Web MIDI (mesmo padrão do Estúdio).
- **Persistência:** parâmetros salvos por instrumento em `localStorage`
  (`mrq.liveControls.v1`); sem parâmetros salvos, a tecla raiz padrão é a
  raiz de referência do instrumento (transposição zero). Botão "Padrões"
  restaura e apaga o salvo.
- **Testes:** `scripts/test-live-controls.mjs` (18 casos: definições,
  clamp/ordenação de faixas, mapeamentos dB/IR/largura/drive, raiz de
  referência, faixa do teclado, nomes de nota, persistência).

## 15. v0.2.23 — correção do estéreo + 15 ferramentas + 2 novidades

- **Correção crítica (estéreo):** a largura estéreo da v0.2.22 (dual-mono +
  mid/side) deixava o canal direito mudo — só saía som de um lado.
  Substituída por um alargador **Haas** (cópia do canal direito atrasada
  9ms misturada com o direto): os dois canais sempre funcionam, inclusive
  com fonte mono. STEREO 0% = estéreo normal, 100% = largo.
- **Qualidade:** limiter de teto (−1dB, sempre ativo) na saída contra
  clipping de drive+EQ; IR do reverb com decaimentos diferentes por canal
  (decorrelação estéreo).
- **15 ferramentas raras** (`LiveToolsChain`, nós nativos, pesquisadas no
  que há de moderno em FX ao vivo — openDAW/smplr/bibliotecas Web Audio):
  compressor de cola, phaser (4 allpass + LFO), flanger, tremolo,
  bitcrusher (quantização + lowpass), shimmer (oitava acima no reverb,
  pitch granular do RackEngine), oitavador (oitava abaixo, em paralelo),
  gate (detecção por analyser), vibrato, auto-pan, exciter (agudos
  saturados), ring modulator, tape (wow/flutter pseudo-aleatório com 2
  LFOs), arpejador (engine, a partir da nota mais grave segurada) e curva
  de velocity (engine). Total: 56 controles.
- **2 novidades inventadas:** **PRESSÃO** — macro de caráter de palco
  (um knob ajusta drive + presença + cola + largura + reverb de forma
  coerente, movendo os outros knobs); **ECO VIVO** — delay adaptativo à
  densidade de notas (o engine mede ataques/2s e fecha o feedback tocando
  denso, abre espaçado).
- **Testes:** `test-live-controls` ampliado pra 25 casos (56 controles,
  compressor, curva de velocity, bitcrusher, arpejo, macro Pressão, Eco
  Vivo).

## 16. v0.2.24 — pan corrigido de vez + som plano ao abrir + bypass dos efeitos

- **Correção do pan (um lado só):** a correção Haas da v0.2.23 ainda deixava
  o canal direito mudo com **amostra mono** — o `ChannelSplitter(2)` recebe
  o mono só no canal 0 e silêncio no canal 1. Pesquisa (Web Audio, balance
  node robusto): um `GainNode` com `channelCountMode: 'explicit'`,
  `channelCount: 2` e `channelInterpretation: 'speakers'` antes do splitter
  converte o mono em estéreo (duplica pros dois canais; estéreo passa
  intacto). Adicionado como `stereoUpmix` entre `delayOut` e o splitter —
  PAN e imagem estéreo agora funcionam nos dois canais com qualquer fonte.
  Bônus: o envio do reverb passou a sair do `widthMerger` (estéreo) em vez
  do `delayOut` (mono), então a cauda do reverb também é estéreo.
- **Som plano/original ao abrir:** os padrões de `TREMOLO DEPTH`,
  `VIBRATO DEPTH`, `AUTO-PAN DEPTH` e `STEREO` (largura Haas) saíram de
  50/30/50/50 pra **0** — ao abrir a página, nenhum efeito colore o som
  antes de qualquer toque. `pressureMacro(0)` também virou neutro de
  verdade no desenho Haas (`stereo: 0`, não mais 50).
- **Bypass dos efeitos:** 21 efeitos ganharam botão liga/desliga (painel
  **BYPASS DOS EFEITOS** com chips). `LiveBypass`/`applyBypass` (função pura
  em `liveControls.ts`) neutraliza só os efeitos desligados, preservando o
  ajuste dos knobs — ao religar, o ajuste volta. O engine aplica o bypass
  antes da cadeia (`setBypass` + `applyEffective`); o arpejador respeita o
  bypass. Os knobs do efeito desligado ficam desabilitados (CSS
  `.knob.disabled` já existia). Persistência em chave separada
  (`mrq.liveControls.bypass.v1`), sem quebrar os saves da v0.2.22+.
- **Testes:** `test-live-controls` ampliado pra 33 casos (padrões planos,
  `defaultLiveBypass`/`normalizeLiveBypass`/`applyBypass`/
  `effectIdForParam`, persistência do bypass).

## 17. v0.2.25 — redesign premium + PAN vs BALANCE + sistema universal de controles

Redesign completo da página Controles ao Vivo seguindo a foto de referência
(visual de sampler profissional), com correção arquitetural dos controles:

- **Auditoria (Fase 1):** o pan usava `StereoPannerNode` (pan, não balance;
  deslocava a imagem estéreo) e convivia com o pan por zona do
  `MrqLayerVoice` (duplo processamento potencial); o Knob era básico (sem
  tamanhos, sem edição numérica, sem unidade/curva); não havia registro
  universal de controles nem undo; faltavam medidor de saída e linha MIDI.
- **PAN vs BALANCE (Fase 3, prioridade máxima):** novo `panBalance.ts` — nó
  com upmix mono→estéreo + splitter + ganhos L/R + merger. Lei **balance**
  (um lado em 1.0, o outro atenua — preserva a imagem estéreo) e lei
  **equal-power** (loudness constante, preferida pra mono). Rótulos
  **L100/L50/C/R50/R100** (interno −1..+1, interface −100..+100). É o único
  pan mestre da cadeia. Funções puras `balanceGains`/`equalPowerGains`/
  `panBalanceGains`/`panLabel` testadas nos 5 pontos (−100,−50,0,+50,+100).
- **Sistema universal de controles (Fase 2):** `LiveParamDef` ganhou
  `unit`, `curve` ('linear'|'log') e `group`; helpers `valueToPosition`/
  `positionToValue` (curvas reversíveis, blindadas contra NaN) e
  `panDisplayLabel`. Uma única fonte de verdade — os controles leem/escrevem
  pelo registro.
- **Knobs premium (Fase 4):** `Knob.tsx` redesenhado — corpo circular com
  profundidade, arco luminoso azul/ciano com glow, ponteiro de precisão,
  3 tamanhos (sm/md/lg), valor clicável pra digitar, tooltip com
  nome/valor/unidade, duplo-clique reseta, setas do teclado.
- **Linha MIDI (Fase 5):** 4 parâmetros reais novos — **CANAL MIDI** (1–16,
  filtra a entrada Web MIDI), **OITAVA** (−2..+2, transposição), **VELOCIDADE
  PADRÃO** (velocity do teclado na tela/computador) e **MODO DE REPRODUÇÃO**
  (Normal polifônico / Mono uma voz). Total: 60 controles.
- **Módulos de efeito (Fase 5):** cada efeito virou um módulo (nome + botão
  de energia/bypass + knob principal + slider vertical + knobs extras),
  organizados em abas **Efeitos / Ao Vivo · Ferramentas · Novidades** (foto).
  EQ e Drive ganharam botões de energia na linha principal. Novos
  componentes: `VerticalSlider.tsx`, `EffectModule.tsx`.
- **Página (Fase 5):** barra lateral com os instrumentos convertidos
  (clique pra trocar), cabeçalho com status (Pronto / Polifonia 128 /
  Latência real do contexto), **medidor de saída** (analyser + rAF, sem
  re-render), gráfico da **Curva de Velocidade** (SVG espelhando
  `applyVelocityCurve`) e barra de status (MIDI / driver / sistema).
- **Persistência (Fase 6):** os 4 parâmetros novos entram no
  `mrq.liveControls.v1` existente (clamp/default automáticos); bypass segue
  na chave separada.
- **Testes (Fase 7):** `test-live-controls` ampliado pra 39 casos (leis de
  pan/balance nos 5 pontos, loudness constante do equal-power, curvas
  reversíveis sem NaN, linha MIDI, 60 controles). Bateria completa do
  projeto passando; build e lint OK.

## 18. v0.2.26 — Undo/Redo + seletor de modo de pan (incremental)

Atualização incremental sobre a v0.2.25 — nenhum sistema reconstruído, nenhum
dado de instrumento/sample tocado (só parâmetros em memória + localStorage).

- **Undo/Redo (`paramHistory.ts`, novo):** classe pura `ParamHistory` com
  pilhas de undo/redo e "gesto pendente". `record()` acumula as mudanças de
  um gesto (arraste de knob = **uma** operação, com `before` do início e
  `after` do fim); `commit()` (debounce de 700ms na página) confirma o
  gesto; uma macro (PRESSÃO, 5 knobs) vira **uma** entrada. Atalhos
  **Ctrl+Z/Ctrl+Y** (Windows) e **Cmd+Z/Cmd+Shift+Z** (macOS) + botões
  Desfazer/Refazer no cabeçalho. **Histórico separado por instrumento**
  (mapa na sessão — trocar de instrumento preserva o de cada um). A
  restauração usa `applyParams(next, false)`, que **não registra** — sem
  loop de callbacks; interface e DSP atualizam juntos. `Padrões` limpa o
  histórico do instrumento.
- **Seletor de pan (`panMode`, novo parâmetro):** **BALANCE** (0, padrão —
  compatível com instrumentos estéreo existentes) | **STEREO PAN** (1,
  equal-power, desloca a imagem). O `liveFxChain` chama
  `masterPan.setMode(...)` (o `setMode` ignora modo repetido — sem rampa
  redundante nem estalo; a troca de nível é gradual via `setTargetAtTime`).
  Seletor segmentado ao lado do knob PAN, com L/C/R no próprio knob. O modo
  persiste no `mrq.liveControls.v1` (saves antigos sem `panMode` caem no
  padrão BALANCE via clamp — migração retrocompatível, sem backup
  necessário).
- **Proteção de dados:** nenhuma amostra, instrumento convertido, projeto ou
  mapeamento é modificado — só parâmetros em memória/localStorage.
- **Testes:** `test-live-controls` ampliado pra 46 casos (undo/redo de
  volume e pan, agrupamento de gesto, macro multi-parâmetro, invalidação de
  redo, mudança líquida zero, clear, panMode padrão/clamp/persistência).
  Bateria completa do projeto passando; build e lint OK.

## 19. v0.2.27 — Clone visual 1:1 da página de Controles ao Vivo (foto de referência)

Rebuild visual da página `LiveControlsPage` seguindo a foto de referência
(imagem 1) — **nenhum parâmetro, efeito ou integração de áudio foi alterado**;
só o front-end (layout, CSS e os botões Salvar/Salvar como/Comparar/Exportar).

- **Design system MRQ** (`theme.css`): variáveis centrais `--mrq-bg:#080b11`,
  `--mrq-panel:#101722`, `--mrq-panel-alt:#151e2a`, `--mrq-border:#273447`,
  `--mrq-cyan:#42d9ff`, `--mrq-blue:#238bff`, `--mrq-purple:#8665ff`,
  `--mrq-text:#f0f5ff`, `--mrq-muted:#8291a8`, `--mrq-radius:12px`,
  `--mrq-gap:16px`. Todos os painéis da página usam o mesmo sistema.
- **Knob premium** (`Knob.tsx`): anel de progresso `conic-gradient` (arco de
  270°, de −135° a +135°), corpo circular metálico escuro com profundidade,
  ponteiro central com glow cyan, valor numérico + unidade abaixo, tooltip,
  arraste vertical, roda do mouse, duplo-clique (padrão), digitação direta,
  navegação por teclado. Tamanhos Small (46px) / Medium (64px) / Large (78px);
  knobs principais em Large.
- **Layout** (CSS Grid + Flexbox, sem posicionamento absoluto pra elementos
  importantes): barra superior (nome do instrumento, preset, indicador de
  carregado, Desfazer/Refazer, Salvar, Salvar como, Comparar, Exportar,
  Padrões, Abrir .mrq, Conectar MIDI); barra lateral (instrumentos
  convertidos, abrir instrumento, informações, raiz de referência, presets,
  integridade, estado do arquivo); painel principal 1 (nota min/max, tecla
  raiz, velocidade min/max); painel principal 2 (volume, pan, BALANCE |
  STEREO PAN, afinação, ataque, release, EQ graves/médios/agudos, drive,
  sustain, curva de velocidade); painel de efeitos (Efeitos/Ao Vivo,
  Ferramentas, Novidades) com módulos consistentes (knob principal + slider
  vertical + knobs extras + botão de energia/bypass); teclado MIDI virtual
  completo (largura total, oitavas, notas pressionadas, velocidade, USB MIDI,
  mouse, responsivo); barra de status fixa (dispositivo MIDI, driver de
  áudio, latência, estado do engine, atividade MIDI, estado do áudio).
- **Botões novos no cabeçalho:** Salvar (grava as configurações na hora),
  Salvar como (arquivo `.json` via diálogo nativo), Comparar (A/B — alterna
  entre o som atual e o original seco, com todos os efeitos em bypass) e
  Exportar (baixa as configurações `.json` direto). Todos usam o estado real
  dos parâmetros e do bypass — nenhum controle decorativo.
- **Validação visual:** página real renderizada no navegador (Playwright +
  mock mínimo do runtime Tauri) e comparada com a foto de referência —
  proporções, espaçamentos, tamanhos, alinhamentos e cores ajustados até
  fidelidade máxima. Testes automatizados (46/46) e build/lint passando.

## 20. v0.2.29 — Rebuild responsivo premium da página de Controles ao Vivo

A v0.2.27/28 quebrou em janelas menores (cabeçalho sobreposto, knobs
cortados). Esta versão reconstrói o layout pra funcionar em qualquer
tamanho (1280×720 até 1920×1080) com o visual premium da foto de
referência — **nenhum parâmetro ou integração de áudio foi alterado**.

- **Cabeçalho sem sobreposição:** banner do instrumento (imagem hero +
  nome + "Instrumento Convertido") + status (Pronto para tocar, Polifonia,
  Latência) + ações com `flex-wrap` — em telas estreitas as ações vão pra
  linha de baixo em vez de sobrepor o título.
- **Knobs em 1 linha em 1280px:** knobs `md` (64px), rótulos em 9px,
  seletor BALANCE|STEREO PAN compacto, curva de velocidade estreita e
  sidebar de 188px — os 10 knobs + curva cabem numa linha só (medido via
  Playwright: 977px de conteúdo em 1052px de painel).
- **Visual premium:** brilho azul/roxo (`--mrq-glow`) em todos os painéis,
  knobs com anel cyan brilhante, medidor de saída **segmentado** (18
  segmentos verde→amarelo→vermelho), banner com foto do instrumento.
- **Sidebar com thumbnails:** foto por tipo de instrumento (piano, strings,
  brass, organ, synth, guitar — detectado pela palavra-chave do nome) +
  busca funcional que filtra a lista + botões Atualizar Lista/Abrir Pasta.
- **Teclado com controles:** oitava (parâmetro real `octave`) e display de
  velocity da última nota tocada (dado real do `noteOn`).
- **Imagens:** `public/assets/` com hero do piano + 6 thumbnails gerados.
- **Validação:** screenshots reais (Playwright) em 1280×720, 1366×768,
  1600×900 e 1920×1080 — layout íntegro em todos. 46/46 testes, build e
  lint passando.

## 21. v0.2.30 — Fidelidade máxima à foto de referência (image-55)

Ajuste fino da página de Controles ao Vivo pra espelhar a foto de
referência pixel a pixel — **nenhum DSP foi alterado** (só metadado de
exibição `unit` nas definições de parâmetro, campo já previsto na
interface).

- **Unidades nos knobs:** o valor exibido agora mostra a unidade
  (`0.0 dB`, `5.0 ms`, `100.0%`, `0.0 ct`, `Hz`, `bits`...) — antes só
  aparecia no tooltip. Campo `unit` adicionado às 49 definições de
  `LIVE_PARAM_DEFS` (display-only, zero impacto no áudio) e exibido pelo
  `Knob` (com `%` colado ao número, como na foto).
- **6 módulos FX da foto:** Reverb, Chorus, Delay, Compressor,
  Distortion e EQ Paramétrico (com gráfico de resposta) — extras
  deslocados pra aba Ferramentas.
- **Abas de informação:** Camadas, Grupos, Samples e Mapeamento com
  metadados reais do instrumento carregado.
- **Faixa de notas/velocidades movida pra aba Mapeamento:** a linha
  "Nota Min/Nota Max/Tecla Raiz/Velocidade Min/Velocidade Max" não
  existe na foto — os 5 steppers (controles reais, ainda ligados ao DSP)
  agora vivem na aba **Mapeamento**, junto dos metadados do instrumento.
- **Botão Hold no teclado:** pedal de sustain real — com Hold ligado,
  soltar a tecla não desliga a nota (o `noteOff` fica retido); ao
  desligar, todas as notas presas são liberadas. Vale pra teclado da
  tela, teclado do computador e MIDI USB.
- **Gráfico do EQ Paramétrico:** curva com nós em todos os pontos de
  controle (graves/médios/agudos reais), como na foto.
- **Sidebar com Data:** campo "Data" (dd/mm/aaaa) real, vindo de
  `addedAt` da entrada na lista de instrumentos convertidos.
- **Validação:** screenshots Playwright em 1280×720, 1366×768, 1600×900
  e 1920×1080 — 6 módulos FX em 1 linha em todos os tamanhos, sem
  sobreposição nem overflow. lint + build + 46/46 testes passando.

## 22. v0.2.31 — Envelope AHDSR completo com Hold real no DSP

O envelope dos Controles ao Vivo era ADS (Attack/Decay fixo de 250ms/
Sustain/Release) — **não havia estágio Hold**. Esta versão implementa um
AHDSR de 5 estágios funcionais no DSP, com o Hold controlando de verdade
a amplitude do áudio.

- **Novos parâmetros:** `holdMs` (0–5000ms, padrão 0) e `decayMs`
  (0–5000ms, padrão 250ms — o valor que era fixo no código). Grupo
  `amplitude`. Compatibilidade total: `clampLiveParams` aplica os padrões
  a projetos antigos sem esses campos (hold=0 = ADSR clássico, som
  inalterado).
- **DSP real (LiveInstrumentEngine):** o gate agora agenda os 5 estágios
  com ramps do Web Audio (sample-accurate, sem timer de jitter):
  Attack → pico, **Hold → pico plano por holdMs**, Decay → nível de
  sustain, Sustain → mantém, Release → 0. Note Off durante Attack/Hold/
  Decay parte do nível atual (sem salto).
- **Pedal de sustain CC64:** `setSustainPedal()` — com o pedal pressionado,
  soltar as teclas não fecha o gate (vozes sustentadas); ao liberar o
  pedal, o Release começa. Distinto do Hold do envelope. Re-trigger de
  nota pedal-segurada volta a ser "tecla". Sem notas presas.
- **Interface:** knobs Ataque/Hold/Decay/Sustain/Release agrupados na
  seção Amplitude + **gráfico AHDSR** (SVG, 5 estágios com nós) que
  espelha os valores reais via `ahdsrCurvePoints()`.
- **Funções puras testáveis:** `ahdsrCurvePoints()` e `ahdsrLevelAt()`
  em `liveControls.ts` — a mesma matemática que o engine agenda.
- **Testes:** 13 novos (59/59 no total) cobrindo os 12 cenários pedidos:
  attack/hold 0, attack 500/hold 1000, attack 100/hold 3000, hold 0
  (compat), noteOff em cada estágio, CC64, polifonia, curva e
  persistência.

## 23. v0.2.32 — Layout compacto: tudo visível sem scroll

Correção do layout da página de Controles ao Vivo: a barra de status
parecia flutuar sobre os controles, os knobs estavam gigantes e o
conteúdo (1032px) não cabia na janela (720px), exigindo scroll.

- **Knobs menores:** corpos sm 34 / md 44 / lg 54px (antes 46/64/78),
  rótulos em 8px, caixas de valor mais estreitas — a linha principal
  agora cabe em **1 linha em 1280px** (12 knobs + panmode + 2 gráficos).
- **Altura total 720px em 1280×720** (antes 1032px): header, linha MIDI,
  knobs, abas, 6 módulos FX, teclado e barra de status — **tudo visível
  de cima a baixo, sem scroll**. Teclas do teclado mais curtas (40px),
  sliders verticais mais curtos (62px), paddings/gaps reduzidos.
- **Barra de status limpa** no rodapé, sem sobreposição.
- **Validação:** screenshots Playwright em 1280×720, 1366×768, 1600×900
  e 1920×1080 — layout íntegro, sem overflow, em todos. lint + build +
  59/59 testes passando. Nenhum DSP alterado.

## 24. v0.2.33 — Linha de knobs em 1 linha com folga (1150px+)

A "Curva de Velocidade" caía para a 2ª linha em janelas menores,
quebrando o alinhamento. Compactação adicional para garantir 1 linha
com folga:

- **Knobs menores ainda:** corpos sm 30 / md 40 / lg 48px, rótulos
  7.5px, min-widths reduzidos — a linha principal (12 knobs + panmode +
  gráficos AHDSR/velocidade) agora cabe em **1 linha a partir de
  1150px** de largura (antes só em 1280px+).
- **Gráficos mais estreitos:** AHDSR 60px, velocidade 48px (SVGs
  ajustados para não estourar o container).
- **EQ/Drive em sm** (agrupados com botões de bypass), panmode e gaps
  mais justos.
- **Altura total 693px em 1280×720** — tudo visível sem scroll, com
  folga. Validado em 1150/1200/1280/1366/1920px. lint + build + 59/59
  testes OK. Nenhum DSP alterado.

## 25. v0.2.34 — Aba Ferramentas e botões da sidebar cabem na tela

Dois problemas visuais reportados: (1) os botões "Atualizar Lista" /
"Abrir Pasta" da sidebar estavam grandes demais (48px de altura e
somando 191px numa sidebar de 188px — "Abrir Pasta" era cortado);
(2) a aba **Ferramentas** (17 módulos) estourava a altura da tela em
~400px, e a barra de status ficava sobreposta aos módulos.

Correções:

- **Sidebar:** botões compactos (23px de altura, fonte 11px, sem quebra
  de linha) — cabem folgados na sidebar de 188px.
- **Ferramentas em modo compacto:** knob principal `sm`, extras inline
  na linha do corpo (sem linha extra abaixo), slider vertical de 44px
  (nova prop `trackHeight` no `VerticalSlider`), labels curtas
  (PRE-DELAY, COR, RATE, FB, TAXA, Depth, Bits, Freq, Alcance — o
  tooltip do knob mostra o rótulo e valor).
- **Grid fixo de 6 colunas** na aba Ferramentas — 17 módulos sempre em
  3 linhas (o flex-wrap quebrava em 4 linhas abaixo de 1280px).
- **Header em linha única:** Polifonia/Latência saíram do header e foram
  para a barra de status (que já tinha "Sistema Pronto"); banner sem
  flex-grow e ações menores, com media query compacta até 1220px.
- **Barra de status em linha única** (sem wrap) e dica do teclado em
  1 linha.
- **Resultado: página inteira em 720px exatos** (1280×720 e 1150×720),
  nas abas Efeitos e Ferramentas — tudo visível, sem scroll e sem
  sobreposição. lint + build + 59/59 testes OK. Nenhum DSP alterado.


## 26. v0.2.35 — Evitar sobreposição da barra de status

A verificação anterior usava apenas `scrollHeight`, que não detectava a
sobreposição causada por um contêiner flexível encolhido. A barra de status
podia cobrir até 9px do painel de teclado. O layout agora respeita a altura
mínima de seu conteúdo; se uma janela não tiver espaço suficiente, permite
rolagem em vez de sobrepor. Os módulos compactos e o teclado foram ajustados
para manter a folga nas dimensões testadas.

Validação em navegador com instrumento sintético: todas as sete abas em
1150, 1280, 1366 e 1920px por 720px; sem rolagem, sem sobreposição da
barra e sem overflow nos corpos dos módulos de Ferramentas. Bypass do Phaser
testado alternando e restaurando o estado. Sem alteração do DSP.


## 27. v0.2.36 — Rótulos e ajustes das curvas

Rótulos e resumos dos gráficos sobrepunham controles vizinhos. As curvas agora
têm títulos dimensionados em seus próprios contêineres, e os knobs da linha
principal usam rótulos compactos, preservando nomes completos nos tooltips e
no leitor de tela. Cada gráfico oferece um botão Ajustar: no envelope, a
janela contém controles Attack, Hold, Decay, Sustain e Release; na velocidade,
contém o controle da curva. Os gráficos ampliados refletem os mesmos parâmetros
existentes, que alimentam o motor e são salvos por instrumento. Não houve
alteração no DSP; os gráficos não são arrastáveis nesta versão.

Verificações em navegador com instrumento sintético: sete abas em 1150, 1280,
1366, 1600 e 1920 por 720px, sem colisão de rótulos, sem rolagem vertical e
sem sobreposição da barra; alterações de envelope/velocidade por teclado,
redesenho da curva e persistência ao reabrir. Lint, build e 59 testes de
controles ao vivo passaram.


## 28. v0.2.37 — Curvas MIDI e calibração

O botão Ajustar da curva de velocidade abre um editor com abas Velocidade,
Note-off e Pedal. Cada aba tem três pontos verticais arrastáveis e sliders
acessíveis, predefinições e restauração independente. Na velocidade, a linha
tracejada mostra o resultado com calibração e a curva adicional antiga.

O assistente coleta ao menos quatro notas suaves/fortes no canal MIDI
selecionado, exige variação mínima e, opcionalmente, captura o valor CC64 do
pedal solto e pressionado, detectando polaridade inversa. Mostra os resultados
antes de aplicá-los; cancelar não modifica os ajustes. Os parâmetros seguem o
mesmo histórico de desfazer/refazer e armazenamento por instrumento.

- Velocity: calibração de entrada, interpolação dos três pontos e curva
  anterior; defaults preservam exatamente o comportamento anterior.
- Note-off: a velocidade do MIDI 0x80 modula a duração do release (127 é
  duração original). Note-on com velocity zero e teclado virtual usam 64.
  No motor atual o release da última nota atua no gate global; outras notas
  têm release individual. Não cria amostras de soltura inexistentes.
- Pedal: CC64 é calibrado, pode ser invertido e passa pela curva e limiar. O
  motor ainda é binário (sustain ligado/desligado), não implementa meio-pedal
  contínuo. Todas as notas soltas sob o pedal são mantidas até ele subir.

Testes: compatibilidade da curva antiga em todas as velocities, interpolação,
calibração, polaridade, persistência e limites; simulação do motor com vozes
e relógio fake; testes de UI com MIDI simulado, arraste, desfazer e sete abas
em 1150/1280/1366/1600/1920 × 720. Hardware físico não foi testado.

## 29. Três ferramentas na aba Novidades (v0.2.38)

- **Limpa Graves:** low shelf em 100 Hz, até −12 dB. Atenua, não elimina frequências e não é filtro passa-altas.
- **Clareza:** peaking em 380 Hz (até −5 dB) mais 2,4 kHz (até +3 dB); filtros próprios independentes do EQ.
- **Sala Curta:** duas cópias atrasadas em 29 e 53 ms, sem feedback, retorno paralelo ao caminho de Ferramentas, antes do volume, pan e limitador master. Não é reverb por convolução nem modelagem física; pode alterar nível e resposta em frequência, inclusive em mono.
- Começam em 0%, inclusive em instrumentos antigos. Bypass independente mantém o ajuste, salvo por caminho de instrumento no armazenamento local; não é gravado no arquivo de instrumento exportado. Controle com undo/redo igual aos demais. Todos atuam na pré-escuta de Controles ao Vivo, não no processamento do arquivo exportado.
