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

## Uso

1. Abra "Auto Sampler" na tela do Conversor de Instrumentos.
2. Escolha a porta MIDI de saída e o dispositivo de entrada de áudio nos
   campos correspondentes (populados automaticamente a partir dos drivers
   instalados no passo anterior).
3. Configure faixa de notas, intervalo de amostragem, sustain/release,
   camadas de velocity, round robin, auto loop e ganho de entrada — os
   mesmos campos do Auto Sampler do Logic Pro.
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
  não uma emenda perfeita garantida para todo tipo de timbre.
