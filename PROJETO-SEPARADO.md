# MRQ Instrument Converter — projeto separado

Criado a pedido do usuário: dividir o app original (`mrq-multitracks-play`,
que **continua intocado** em `github.com/MQueirozair/mrq-multitracks-play`)
em 3 projetos independentes, cada um instalável/testável sozinho:

1. **MRQ Multitracks Play2** (`mrq-multitracks-play2`) — o player de
   multitracks.
2. **MRQ Rack de Instrumentos** (`mrq-rack-instrumentos`) — o rack de
   instrumentos virtuais (SF2/NKI/EXS24/DX7/.mrq, efeitos, pads).
3. **MRQ Instrument Converter** (este projeto) — o conversor de formatos
   de instrumento (SF2/NKI/EXS24/DX7/Kontakt) pro formato próprio `.mrq`.

## Estado atual

Isto é uma **cópia completa** do código do `mrq-multitracks-play` na
versão v0.2.48 (nenhum código removido ainda) — ponto de partida seguro
combinado com o usuário antes de começar a enxugar. O conversor hoje vive
no "Conversor de Instrumentos" da navegação principal + nos importadores
em `src/audio/import/` (SF2/NKI/EXS24/DX7/Kontakt → `.mrq`) — o resto do
app (multitracks, Rack, etc.) ainda está todo aqui também.

## Próximo passo (ainda não feito)

Remover do código/UI deste projeto tudo que NÃO é o conversor de
instrumentos (o player de multitracks, o Rack, etc. — que vão virar os
outros 2 projetos), deixando este projeto abrir direto na tela de
conversão como app independente, até ficar 100% funcional sozinho
(instalador próprio, sem depender de nenhuma outra tela do app original).
Depois que os 3 projetos estiverem cada um 100% funcionando de forma
independente, o usuário pediu pra planejarmos juntar os 3 de volta (como
módulos/peças de um só produto, se der certo).
