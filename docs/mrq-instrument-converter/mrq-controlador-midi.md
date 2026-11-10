# Controlador MIDI (diagnóstico de roteamento)

Ferramenta de teste/diagnóstico dentro do MRQ Instrument Converter — um
teclado na tela que manda notas MIDI **de verdade** (apertar e segurar =
Note On sustentado, soltar = Note Off), numa porta e canal escolhidos por
você. Serve pra responder uma pergunta bem específica sem precisar montar
uma sessão inteira de Auto Sampler: **"a porta MIDI que eu escolhi está
mesmo chegando no Kontakt?"**

Abra em **Importar → Controlador MIDI (tocar o Kontakt manualmente)…**, na
tela principal do conversor.

## Como usar

1. Deixe o Kontakt aberto **standalone**, com um instrumento carregado.
2. No Controlador MIDI, escolha a **mesma porta MIDI** que você configurou
   como entrada no Kontakt, e o mesmo **canal**.
3. Clique e segure uma tecla do teclado na tela (ou use o teclado do
   computador — teclas **A S D F G H J K** tocam as teclas brancas e
   **W E T Y U** as pretas, a partir da oitava escolhida em "Oitava (tecla
   'a')"). Arrastar o mouse/dedo de uma tecla pra outra com o botão
   pressionado faz um glissando (solta a nota anterior e toca a nova).
4. Se o Kontakt tocar o som, a porta/canal estão certos — o problema
   relatado (notas do conversor não chegando) está em outro lugar (ex.:
   canal MIDI diferente configurado no Auto Sampler, ou o instrumento
   carregado não responde nesse canal). Se o Kontakt **não** tocar nada,
   o problema é roteamento da porta MIDI, não o conversor.

## Onde conferir no Kontakt

Na janela do Kontakt, abra a página **MIDI Inputs** (Panel de opções do
instrumento/multi). A porta escolhida aqui no Controlador MIDI precisa
aparecer **marcada** ali. Se o Kontakt só lista uma interface física (ex.:
um controlador USB como "UMX 610") e nenhuma porta virtual, isso explica
por que nenhuma nota chega: é preciso criar/rotear uma porta MIDI virtual
primeiro — ver o passo a passo por sistema operacional na seção
"Pré-requisitos" de [`mrq-auto-sampler.md`](./mrq-auto-sampler.md)
(IAC Driver no macOS, loopMIDI no Windows, aconnect/a2jmidid no Linux).

## Botão "Pânico"

Manda **All Notes Off** + **All Sound Off** nos 16 canais MIDI da porta
escolhida. Use se alguma nota ficar presa tocando (ex.: trocou de porta ou
canal com uma tecla ainda segurada). O mesmo acontece automaticamente ao
fechar o modal, se alguma nota ainda estiver ativa.

## Diferença para o clique de pré-escuta do Auto Sampler

O teclado clicável dentro do Auto Sampler (pra escolher a faixa de notas a
amostrar) manda uma nota curta de duração fixa (350&nbsp;ms), só pra você
ouvir o timbre do instrumento enquanto ajusta a faixa — não serve pra
testar roteamento de verdade porque qualquer falha no envio é ignorada
silenciosamente (não deveria travar a tela de configuração). O Controlador
MIDI, ao contrário, **mostra o erro na tela** se o envio falhar, porque é
essa a função dele: ser confiável como ferramenta de diagnóstico.
