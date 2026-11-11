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
   MIDI do Kontakt — **sem isso, a tela "Saída MIDI (para o Kontakt)" só vai
   oferecer portas que não servem pra isso** (ex.: "Microsoft GS Wavetable
   Synth" no Windows, que é o sintetizador interno do Windows — ele só
   *recebe* MIDI pra tocar sozinho, nenhum outro programa consegue "ouvir"
   ele, então escolhê-lo não leva nada até o Kontakt):
   - **Windows**: instale o [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)
     (gratuito, padrão da indústria pra isso — **instale como
     Administrador**), abra o programa e crie uma porta (ex.: "MRQ to
     Kontakt") — ele fica rodando minimizado na bandeja do sistema.
     Depois, no Kontakt, vá em **Options → MIDI → Inputs**: a porta
     criada precisa aparecer do lado de qualquer interface física que já
     esteja listada (ex.: um teclado USB) — clique nela pra ativar.
     Escolha essa mesma porta aqui no app (não a interface física, que é
     só *entrada* de um teclado real, nem o "Microsoft GS Wavetable
     Synth").
     - **Se a porta do loopMIDI não aparecer no Kontakt** (bug conhecido e
       atual do novo stack "Windows MIDI 2.0" do Windows 11, que esconde
       portas virtuais recém-criadas até o serviço de MIDI ser
       reiniciado): abra o **Prompt de Comando como Administrador** e
       rode `net stop midisrv` seguido de `net start midisrv`, ou instale
       o app gratuito **"Windows MIDI Services"** da Microsoft Store (tem
       um botão "Restart MIDI" que resolve na hora). Pode ser necessário
       repetir isso a cada reinicialização do Windows até a Microsoft
       lançar a correção definitiva desse stack.
   - **macOS**: use o "IAC Driver" já embutido no Audio MIDI Setup (Rede
     MIDI) — não precisa instalar nada.
   - **Linux**: crie uma porta virtual com `aconnect`/`a2jmidid` (ALSA) ou
     equivalente, e conecte-a ao Kontakt.
3. **Um driver de loopback de áudio** roteando a SAÍDA de áudio do Kontakt
   até um dispositivo de ENTRADA que apareça pra este app:
   - **macOS**: [BlackHole](https://github.com/ExistentialAudio/BlackHole)
     (gratuito).
   - **Windows**: não precisa instalar cabo virtual! O Auto Sampler já traz
     **Loopback nativo (WASAPI)** embutido e seleciona por padrão
     `Saída de som do sistema — Padrão (loopback nativo)`, que grava direto o
     som que sai no seu fone/alto-falante com medidor VU L/R ao vivo. Basta
     garantir que no Kontakt (**Options → Audio → Driver**) o driver esteja em
     **`WASAPI (Shared Mode)`** (e **não** em `WASAPI (Exclusive Mode)` nem
     `ASIO`, pois o modo exclusivo bloqueia o dispositivo no Windows com o
     erro `0x8889000A`). Opcionalmente, também é possível usar o
     [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) se preferir rotear
     por cabo virtual.
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
   instalados no passo anterior). A opção **"Padrão do sistema"** (sempre
   disponível no topo da lista, igual ao seletor de saída de áudio em
   Configurações) não trava num id de dispositivo específico — usa sempre o
   que estiver configurado como entrada padrão do sistema operacional no
   momento da gravação. É a opção mais robusta se o driver de loopback
   (BlackHole/VB-Audio Virtual Cable/monitor do PulseAudio) estiver
   configurado como entrada padrão do SO; escolha um dispositivo nomeado
   específico só se precisar gravar de uma entrada que NÃO seja a padrão.
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

## "Capturei tudo mas ficou tudo em silêncio" / "o Kontakt não tocou as notas"

O Auto Sampler não tem nenhuma forma de confirmar se o Kontakt respondeu de
verdade a cada nota MIDI — ele só grava fielmente o que chegar pelo
dispositivo de entrada escolhido, durante o tempo configurado, não importa
se isso é música ou silêncio digital puro. Se TODAS (ou a maioria) das
capturas vierem silenciosas, o app agora avisa isso explicitamente ao
final da execução (toast vermelho "as N capturas vieram em SILÊNCIO...").
Nesse caso, confira nesta ordem:

1. **A porta MIDI está certa E o Kontakt está escutando ela?** Abra as
   configurações de MIDI do Kontakt standalone e confirme que a porta
   virtual escolhida no Auto Sampler aparece marcada/ativa lá dentro — ter
   a porta só criada no sistema operacional não é suficiente, o Kontakt
   também precisa estar configurado pra escutar nela. Cuidado em
   particular com o caso em que a tela **Engine > MIDI > Inputs** do
   Kontakt só lista uma interface física (ex.: "UMX 610") e nada mais: se
   a porta escolhida no Auto Sampler for uma porta MIDI virtual (loopMIDI
   no Windows, IAC no macOS, etc.) e essa porta virtual não aparecer
   nessa lista, o Kontakt simplesmente nunca vai ver as notas, mesmo que
   o Auto Sampler esteja mandando tudo certinho. Nesse caso: ou crie/
   habilite a porta virtual para que ela apareça na lista de Inputs do
   Kontakt, ou escolha no Auto Sampler a própria interface física que
   aparece aí (só funciona se a saída MIDI dela estiver fisicamente
   cabeada de volta pra entrada MIDI dela mesma ou do Kontakt).
2. **O canal MIDI bate?** Se o Kontakt (ou um Multi dentro dele) só
   escuta um canal específico, o canal escolhido no Auto Sampler precisa
   ser o mesmo.
3. **A saída de áudio do Kontakt está mesmo roteada pro loopback, e o
   loopback é o dispositivo de entrada escolhido aqui?** Teste tocando uma
   nota manualmente no teclado virtual do Kontakt (ou pelo teclado visual
   do próprio Auto Sampler, clicando numa tecla — ver seção acima) e
   confira se o medidor de nível L/R do Auto Sampler reage.
4. **O monitor de retorno do Kontakt está mutado?** Não afeta a captura em
   si (o loopback captura antes do monitor), mas é um sinal rápido de que a
   rota de áudio está ou não realmente ativa.

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
