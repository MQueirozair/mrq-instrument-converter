# Exportar um instrumento convertido pra SoundFont (.sf2/.sf3)

Além de `.mrq` (o formato nativo do app), a tela do **MRQ Instrument
Converter** agora também exporta qualquer instrumento já convertido de
volta pra `.sf2`/`.sf3` — útil pra usar o resultado num sampler/sintetizador
que só lê SoundFont (ex.: muitos plugins free, hardware, DAWs sem suporte a
`.mrq`).

## Como usar

1. Importe e **converta** o arquivo de origem pra `.mrq` normalmente
   (botão "Converter para .mrq" na faixa de pré-visualização) — qualquer um
   dos formatos de entrada suportados (SF2/SF3/NPNO/NSMP/SYX/EXS/WAV/AIFF/
   FLAC/MP3/OGG/captura de áudio do Kontakt) funciona, porque a exportação
   lê as amostras de volta do `.mrq` recém-gravado, não do arquivo
   original.
2. Com o item já convertido, dois novos botões aparecem na mesma faixa:
   **"Exportar .sf2"** e **"Exportar .sf3"**.
3. Escolha onde salvar — o app monta o SoundFont na hora e grava.

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
