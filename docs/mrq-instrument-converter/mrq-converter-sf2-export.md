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
