# Auto Sampler

Toca automaticamente todas as notas/velocidades/round-robins de um
instrumento Kontakt (rodando **standalone**, não hospedado dentro do MRQ
Instrument Converter) e grava o áudio de volta, montando um instrumento
multisample completo sem precisar tocar nada manualmente. Modelado no
"Auto Sampler" do Logic Pro (ver a documentação da Apple em
support.apple.com/guide/logicpro/auto-sampler-controls).

Gera, na mesma execução, os dois formatos suportados pelo conversor:
**`.mrq`** (toca no Rack deste app, com round robin de verdade) e
**SoundFont 2 (`.sf2`)** (toca em qualquer sintetizador compatível com SF2 —
ver limitação de round robin abaixo).

## Pré-requisitos (precisam estar prontos ANTES de abrir o Auto Sampler)

1. **Kontakt aberto standalone**, com o instrumento que você quer amostrar
   já carregado.
2. **Uma porta MIDI virtual** roteando a saída MIDI deste app até a entrada
   MIDI do Kontakt:
   - **Windows**: instale um driver de porta MIDI virtual (ex.: loopMIDI)
     e configure o Kontakt pra escutar nessa porta.
   - **macOS**: use o "IAC Driver" já embutido no Audio MIDI Setup (Rede
     MIDI) — não precisa instalar nada.
   - **Linux**: crie uma porta virtual com `aconnect`/`a2jmidid` (ALSA) ou
     equivalente, e conecte-a ao Kontakt.
3. **Um driver de loopback de áudio** roteando a SAÍDA de áudio do Kontakt
   até um dispositivo de ENTRADA que apareça pra este app:
   - **macOS**: [BlackHole](https://github.com/ExistentialAudio/BlackHole)
     (gratuito).
   - **Windows**: [VB-Audio Virtual Cable](https://vb-audio.com/Cable/)
     (gratuito).
   - **Linux**: o "monitor" de uma sink do PulseAudio/PipeWire já serve
     como entrada de loopback (não precisa instalar nada extra na maioria
     das distros).
4. Configure a SAÍDA de áudio do Kontakt pra ir pro loopback escolhido, e
   deixe o monitor de retorno do Kontakt desligado (ou baixo) se quiser
   evitar ouvir a captura em tempo real.
5. **Windows apenas**: confira em Configurações > Privacidade e segurança >
   Microfone se "Acesso ao microfone" está ligado E se "Permitir que
   aplicativos de área de trabalho acessem seu microfone" também está
   ligado. Sem isso, o pedido de permissão de áudio do Auto Sampler volta
   negado na hora (erro "Permission dismissed"), sem nem chegar a mostrar
   um prompt — não é um bug do app, é um bloqueio de privacidade do próprio
   Windows que se aplica a qualquer app de área de trabalho, não só este.

## Uso

1. Abra "Auto Sampler" na tela do Conversor de Instrumentos.
2. Escolha a porta MIDI de saída e o dispositivo de entrada de áudio nos
   campos correspondentes (populados automaticamente a partir dos drivers
   instalados no passo anterior).
3. Configure faixa de notas, intervalo de amostragem, sustain/release,
   camadas de velocity, round robin, auto loop e ganho de entrada — os
   mesmos campos do Auto Sampler do Logic Pro.
   - **Teclado "Sample Note Range"**: clique em qualquer tecla pra ouvir o
     Kontakt de verdade por MIDI (sem gravar nada); arraste as pontas da
     barra azul acima do teclado pra ajustar Range Start/Range End (os
     mesmos valores dos dois dropdowns, só uma forma visual alternativa de
     mexer neles). Teclas azuis = amostradas de verdade; cinza-claro = dentro
     da faixa mas preenchidas por interpolação (não têm captura própria);
     cinza-escuro = fora da faixa.
   - **Velocity Response "Custom"**: com mais de 1 camada de velocity,
     aparece um gráfico com uma divisória arrastável entre cada camada —
     arrastar qualquer uma troca automaticamente a resposta pra "Custom" e
     passa a usar esses pontos exatos (em vez de uma curva linear/exp/log).
   - **Medidor de nível L/R**: assim que um dispositivo de entrada é
     escolhido, dois medidores de barra mostram o nível de áudio chegando
     de verdade (já com o Input Gain aplicado) — evita ajustar o ganho "no
     escuro". O medidor usa seu PRÓPRIO stream de monitoramento (não o da
     gravação) e é desligado automaticamente assim que "Sample" começa, pra
     não disputar o dispositivo de entrada com a captura de verdade.
4. Escolha se quer gerar `.mrq`, SF2/SF3, ou os dois (marcados por padrão).
5. Clique "Sample". O app toca e grava cada nota automaticamente — o
   progresso aparece no rodapé do modal. "Cancelar" interrompe a qualquer
   momento (nunca espera o sustain/release inteiro da nota atual).
6. Ao final, o `.mrq` (se gerado) entra automaticamente na fila do
   conversor pra inspeção/pré-escuta; o caminho do `.sf2` (se gerado) é
   reportado por um aviso.

## Limitações conhecidas

- **Round robin + SF2**: o formato SoundFont 2 não tem nenhum mecanismo
  nativo de alternância entre variações — cada variação de round robin
  vira uma zona SF2 independente e totalmente sobreposta, que a maioria
  dos sintetizadores SF2 vai tocar **ao mesmo tempo** (empilhada), não
  alternada. O `.mrq`, por outro lado, alterna de verdade (o Rack suporta
  round robin nativamente). Isso não é um bug — é uma limitação real do
  formato SF2 em si, avisada na tela quando Round Robin > 1 e a saída SF2
  está marcada.
- **Camadas de velocity com crossfade**: não modeladas — cada camada tem
  uma faixa de velocity fixa (sem fade entre camadas vizinhas), igual ao
  comportamento padrão (não-crossfade) do Auto Sampler do Logic Pro.
- **Curvas de velocity Exp/Log**: a Apple não documenta a fórmula exata
  usada pelo Auto Sampler real — a implementação aqui usa uma curva de
  potência que reproduz o mesmo EFEITO qualitativo (zonas mais estreitas
  perto do extremo relevante), mas não é uma cópia bit-a-bit do algoritmo
  original (impossível sem o código-fonte da Apple).
- **Pontos de loop automáticos**: estimados por autocorrelação + busca de
  menor descontinuidade na janela configurada — uma aproximação razoável,
  não uma emenda perfeita garantida para todo tipo de timbre. Os modos
  **Search**, **Search With X-Fade**, **Search With Rev X-Fade** e
  **Bidirectional** (lista completa do Logic Pro, ver
  soundonsound.com/techniques/logic-using-auto-sampler) são implementados
  de verdade — o crossfade/a reversão/a alternância forward-reverso são
  "gravados" diretamente no áudio capturado (`bakeAutoLoop` em
  `autoSamplerEngine.ts`), então soam igual tanto no `.mrq` quanto no SF2
  (que só sabe tocar um loop simples pra frente). O modo **Penrose
  Machine** do Logic Pro aparece na lista, mas **desabilitado**: é um
  algoritmo de ressíntese proprietário da Apple/Redmatica, nunca
  documentado publicamente — reimplementá-lo seria inventar um
  comportamento parecido e fingir paridade que não existe de verdade.
