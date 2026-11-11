#!/usr/bin/env python3
"""
Gera as ilustrações SVG locais do manual de Ajuda (v0.2.15) e a figura
anotada a partir da tela real enviada pelo usuário.

Tudo é embedado/local: nenhum SVG usa fonte, script ou imagem externa. Rode:
    python3 scripts/generate-help-illustrations.py
Opcional: passe o caminho da foto real como primeiro argumento; se ausente,
apenas os SVGs são (re)gerados.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'help'
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1120, 620
BG = '#0e1014'
PANEL = '#191d24'
PANEL2 = '#20252e'
BORDER = '#343b47'
TEXT = '#e7ebf2'
MUTED = '#98a3b3'
ACCENT = '#e8d34a'
CYAN = '#54c9ef'
GREEN = '#57d38c'
RED = '#ff6b7f'
BLUE1 = '#2361ad'
BLUE2 = '#2f79cf'
BLUE3 = '#3f91e8'


def e(s: object) -> str:
    return escape(str(s))


def txt(x, y, s, size=16, fill=TEXT, weight='400', anchor='start', extra=''):
    return (f'<text x="{x}" y="{y}" fill="{fill}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{anchor}" '
            f'font-family="DejaVu Sans, Arial, sans-serif" {extra}>{e(s)}</text>')


def r(x, y, w, h, fill=PANEL, stroke=BORDER, rx=10, sw=1, opacity=None):
    o = f' opacity="{opacity}"' if opacity is not None else ''
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{o}/>')


def line(x1, y1, x2, y2, stroke=BORDER, sw=1.5, dash=None, arrow=False):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    a = ' marker-end="url(#arrow)"' if arrow else ''
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="{stroke}" stroke-width="{sw}"{d}{a}/>')


def circle(x, y, rad, fill=ACCENT, stroke=None, sw=1):
    s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
    return f'<circle cx="{x}" cy="{y}" r="{rad}" fill="{fill}"{s}/>'


def label(x, y, w, text, fill=PANEL2, color=TEXT, size=13, h=30):
    return r(x, y, w, h, fill, BORDER, 7) + txt(x + 12, y + 20, text, size, color, '600')


def callout(x, y, number, title, body, w=250, h=70, color=ACCENT):
    out = [r(x, y, w, h, '#15191f', color, 10, 1.5)]
    cy = y + h / 2
    rad = min(14, h / 2 - 2)
    out.append(circle(x + rad + 8, cy, rad, color))
    out.append(txt(x + rad + 8, cy + 5, number, 12 if h < 50 else 14, '#111318', '800', 'middle'))
    if h < 50:
        # versão compacta: uma linha só, sem texto fora da caixa
        out.append(txt(x + rad * 2 + 20, cy + 4, f'{title} — {body}', 10.5, TEXT, '700'))
    else:
        out.append(txt(x + 45, y + 23, title, 13.5, TEXT, '700'))
        out.append(txt(x + 45, y + 45, body, 11.5, MUTED))
    return ''.join(out)


def header(title, subtitle, badge='GUIA ILUSTRADO'):
    return (
        r(0, 0, W, H, BG, BG, 0, 0)
        + r(28, 24, W - 56, 66, PANEL, BORDER, 12)
        + txt(50, 52, title, 21, TEXT, '800')
        + txt(50, 76, subtitle, 12.5, MUTED)
        + r(W - 205, 40, 155, 30, '#2d2918', ACCENT, 15)
        + txt(W - 127, 60, badge, 11, ACCENT, '800', 'middle')
    )


def svg(title, subtitle, body, badge='GUIA ILUSTRADO'):
    defs = (
        '<defs>'
        '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        'markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#e8d34a"/></marker>'
        '<linearGradient id="blueBar" x1="0" x2="1"><stop offset="0" stop-color="#2361ad"/>'
        '<stop offset="0.5" stop-color="#2f79cf"/><stop offset="1" stop-color="#3f91e8"/></linearGradient>'
        '<pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
        '<line x1="0" y1="0" x2="0" y2="12" stroke="#313845" stroke-width="3"/></pattern>'
        '</defs>'
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
            f'viewBox="0 0 {W} {H}" role="img" aria-label="{e(title)}">{defs}'
            + header(title, subtitle, badge) + body + '</svg>')


def step_chips(active=1, y=112):
    out = []
    names = ['1  Conexão', '2  Teclado', '3  Som', '4  Captura']
    for i, name in enumerate(names, 1):
        x = 72 + (i - 1) * 176
        fill = '#173b4a' if i == active else PANEL2
        stroke = CYAN if i == active else BORDER
        out.append(r(x, y, 158, 34, fill, stroke, 17))
        out.append(txt(x + 79, y + 22, name, 12.5, TEXT if i == active else MUTED, '700', 'middle'))
    return ''.join(out)


def write(name, content):
    (OUT / name).write_text(content, encoding='utf-8')
    print(f'✔ {name}')


# ---------------------------------------------------------------------------
# 1) Conexão — tela esquemática com a proteção contra clique fora
# ---------------------------------------------------------------------------
body = [step_chips(1)]
# área externa hachurada + moldura do modal
body.append(r(40, 162, 1040, 420, 'url(#hatch)', '#3e4654', 14, 1.5, 0.34))
body.append(r(72, 178, 976, 388, PANEL, '#596273', 12, 2))
body.append(txt(52, 166, 'ÁREA EXTERNA — clique NÃO fecha', 10.5, GREEN, '700'))
# header
body.append(txt(96, 212, '♪  Auto Sampler', 17, TEXT, '800'))
body.append(r(1004, 190, 28, 28, '#343b47', '#6d7787', 6))
body.append(txt(1018, 210, '×', 20, TEXT, '800', 'middle'))
body.append(txt(960, 210, 'X fecha e mantém o rascunho', 10.5, GREEN, '700', 'end'))
# checklist
body.append(txt(100, 250, '✓  Porta MIDI escolhida     ✓  Entrada de áudio escolhida     ✓  VU L/R ao vivo', 12, GREEN, '700'))
# cards
body.append(r(96, 270, 430, 250, PANEL2, BORDER, 10))
body.append(r(548, 270, 476, 250, PANEL2, BORDER, 10))
body.append(txt(116, 298, 'MIDI — saída pro instrumento', 14, TEXT, '700'))
body.append(txt(568, 298, 'Áudio — entrada (o que o instrumento toca)', 14, TEXT, '700'))
body.append(label(116, 316, 390, 'Porta MIDI     loopMIDI → Kontakt', h=34))
body.append(label(116, 362, 390, 'Canal MIDI     Canal 1', h=34))
body.append(label(116, 408, 220, '▶ Testar MIDI (C4)', '#242c36', CYAN, 12, 34))
body.append(label(116, 458, 390, '↻ Atualizar portas MIDI', h=30))
body.append(label(568, 316, 436, 'Dispositivo     Saída do sistema — loopback nativo', h=34))
body.append(label(568, 362, 436, 'Input Gain     ├────●────┤   0.0 dB', h=34))
body.append(label(568, 408, 190, '▶ Testar áudio', '#242c36', CYAN, 12, 34))
body.append(label(568, 458, 436, 'Listar também microfones / VB-Cable', h=30))
body.append(r(780, 404, 220, 38, '#121820', BORDER, 7))
body.append(txt(794, 420, 'VU', 10, MUTED, '700'))
body.append(r(822, 412, 160, 6, '#313845', 'none', 3, 0))
body.append(r(822, 412, 104, 6, GREEN, 'none', 3, 0))
body.append(r(822, 426, 160, 6, '#313845', 'none', 3, 0))
body.append(r(822, 426, 92, 6, CYAN, 'none', 3, 0))
# footer
body.append(line(96, 532, 1024, 532, BORDER))
body.append(label(100, 542, 260, '↻ Limpar tudo / Voltar do zero', '#2a2118', ACCENT, 11, 26))
body.append(label(866, 542, 150, 'Continuar →', '#17465a', CYAN, 12, 26))
# callouts
body.append(callout(40, 580, '1', 'MIDI', 'Porta, canal e teste C4', 345, 34, CYAN))
body.append(callout(395, 580, '2', 'Áudio', 'Loopback nativo ou VB-Cable', 345, 34, CYAN))
body.append(callout(750, 580, '3', 'Clique fora', 'não fecha · VU ao vivo', 330, 34, GREEN))
write('help-auto-sampler-conexao.svg', svg(
    'Auto Sampler — passo 1: Conexão',
    'MIDI toca o instrumento; o áudio volta pelo loopback. O clique fora foi protegido e o rascunho é salvo.',
    ''.join(body), 'PASSO 1 / 4'))

# ---------------------------------------------------------------------------
# 2) Roteamento de sinal
# ---------------------------------------------------------------------------
body = []
boxes = [
    (60, 180, 210, 116, 'Auto Sampler', 'Gera as notas MIDI\ngrava o áudio', '#173b4a', CYAN),
    (330, 120, 220, 116, 'Porta MIDI virtual', 'loopMIDI / IAC Driver\nCanal 1–16', PANEL2, BORDER),
    (620, 120, 220, 116, 'Instrumento externo', 'Kontakt standalone,\nteclado ou synth', PANEL2, BORDER),
    (900, 120, 170, 116, 'Saída de som', 'O que você ouve\nno computador', PANEL2, BORDER),
    (620, 370, 220, 116, 'Loopback nativo', 'Windows / WASAPI\nsem cabo virtual', '#173b4a', CYAN),
    (330, 370, 220, 116, 'VB-Cable (opcional)', 'Saída do instrumento\n→ CABLE Input', '#242c36', BORDER),
    (60, 370, 210, 116, 'Arquivos gerados', '.mrq  +  .sf2 / .sf3', '#2d2918', ACCENT),
]
for x, y, w, h, title, sub, fill, stroke in boxes:
    body.append(r(x, y, w, h, fill, stroke, 12, 2))
    body.append(txt(x + w / 2, y + 38, title, 15, TEXT, '800', 'middle'))
    for i, ln in enumerate(sub.split('\n')):
        body.append(txt(x + w / 2, y + 64 + i * 22, ln, 11.5, MUTED, '400', 'middle'))
body.append(line(270, 210, 325, 178, ACCENT, 2.5, arrow=True))
body.append(txt(298, 164, 'MIDI', 10.5, ACCENT, '700', 'middle'))
body.append(line(550, 178, 615, 178, ACCENT, 2.5, arrow=True))
body.append(line(840, 178, 895, 178, ACCENT, 2.5, arrow=True))
body.append(line(985, 236, 985, 320, ACCENT, 2.5, arrow=True))
body.append(line(985, 320, 840, 410, ACCENT, 2.5, arrow=True))
body.append(line(985, 320, 550, 410, BORDER, 2, '6 5', arrow=True))
body.append(txt(790, 336, 'cabo virtual alternativo', 10.5, MUTED))
body.append(line(620, 428, 555, 428, ACCENT, 2.5, arrow=True))
body.append(line(330, 428, 275, 428, ACCENT, 2.5, arrow=True))
body.append(txt(560, 286, 'Áudio', 12, ACCENT, '700', 'middle'))
body.append(callout(70, 520, '!', 'Checklist antes de gravar', 'Testar MIDI → ouvir C4; VU L/R mexendo; ganho sem clipar', 470, 70, GREEN))
body.append(callout(570, 520, '✓', 'Sem som?', 'Confira canal MIDI, dispositivo de entrada e volume do instrumento', 470, 70, CYAN))
write('help-auto-sampler-roteamento.svg', svg(
    'Auto Sampler — caminho completo do sinal',
    'Entenda para onde vai cada cabo/uso: uma seta MIDI e uma seta de áudio, com o loopback nativo ou VB-Cable.',
    ''.join(body), 'COMO FUNCIONA'))

# ---------------------------------------------------------------------------
# 3) Teclado / presets
# ---------------------------------------------------------------------------
body = [step_chips(2)]
body.append(txt(72, 178, 'Presets rápidos — clique e depois ajuste os números se quiser', 13, MUTED))
presets = [('Piano / Teclado', 'C2–C6 · 2 ST · 3 vel'), ('Pads / Sustained', 'C3–C5 · 3 ST · loop'),
           ('Percussão', 'C2–C4 · 1 ST · one-shot'), ('Cromático rápido', 'toda tecla · 1 vel')]
for i, (name, hint) in enumerate(presets):
    x = 72 + i * 250
    body.append(r(x, 196, 232, 68, '#24291f' if i == 0 else PANEL2, ACCENT if i == 0 else BORDER, 10, 2))
    body.append(txt(x + 14, 224, name, 13, TEXT, '700'))
    body.append(txt(x + 14, 246, hint, 11, MUTED))
body.append(r(72, 292, 976, 208, PANEL, BORDER, 12))
body.append(txt(94, 320, 'Faixa de notas e teclas que serão gravadas', 14, TEXT, '700'))
body.append(label(760, 300, 132, 'Start 48 / C3', h=28))
body.append(label(902, 300, 126, 'End 72 / C5', h=28))
# keyboard
kx, ky, kw, kh = 96, 348, 928, 104
white = 25
ww = kw / white
for i in range(white):
    x = kx + i * ww
    body.append(r(x, ky, ww - 2, kh, '#e9edf4', '#7c8695', 2, 1))
    if i % 7 in (0, 1, 3, 4, 5):
        body.append(r(x + ww - 9, ky, 18, kh * 0.62, '#171b22', '#050608', 2, 1))
# sampled notes: every 3 semitons highlighted as yellow dots and outlines
for i in range(0, white, 2):
    x = kx + i * ww + ww / 2
    body.append(circle(x, ky - 16, 7, ACCENT))
    body.append(r(x - 3, ky, 6, kh, ACCENT, ACCENT, 2, 0, 0.75))
body.append(txt(kx + 4, ky + kh + 24, 'C3', 11, MUTED, '700'))
body.append(txt(kx + kw / 2, ky + kh + 24, 'C4', 11, MUTED, '700', 'middle'))
body.append(txt(kx + kw - 20, ky + kh + 24, 'C5', 11, MUTED, '700'))
body.append(callout(72, 515, '1', 'Alças / campos', 'Arraste as alças ou digite o intervalo', 300, 72, ACCENT))
body.append(callout(392, 515, '2', 'Pontos amarelos', 'Notas realmente gravadas neste exemplo', 320, 72, ACCENT))
body.append(callout(732, 515, '✓', 'Status por nota', 'Verde = OK · vermelho = silenciosa · cinza = fora da faixa', 316, 72, GREEN))
write('help-auto-sampler-teclado.svg', svg(
    'Auto Sampler — passo 2: Teclado',
    'Presets, faixa de notas, intervalo em semitons e o teclado com status de cada nota após a captura.',
    ''.join(body), 'PASSO 2 / 4'))

# ---------------------------------------------------------------------------
# 4) Som / response bar
# ---------------------------------------------------------------------------
body = [step_chips(3)]
body.append(r(72, 168, 976, 190, PANEL, BORDER, 12))
body.append(txt(94, 196, 'Velocity Response — arraste as linhas brancas para mudar cada camada', 14, TEXT, '700'))
# blue bar
bar_x, bar_y, bar_w, bar_h = 110, 220, 900, 76
# Três retângulos azuis sólidos: alguns renderizadores de <img src=*.svg>
# ignoram linearGradient, e a barra não pode ficar preta.
for start, end, color in [(0, 42, BLUE1), (42, 85, BLUE2), (85, 127, BLUE3)]:
    sx = bar_x + bar_w * start / 127
    sw = bar_w * (end - start) / 127
    body.append(r(sx, bar_y, sw, bar_h, color, 'none', 0, 0))
body.append(r(bar_x, bar_y, bar_w, bar_h, 'none', '#6aa7e8', 5, 2))
for pos in (42 / 127, 85 / 127):
    x = bar_x + bar_w * pos
    body.append(line(x, bar_y - 8, x, bar_y + bar_h + 8, '#ffffff', 3))
    body.append(r(x - 9, bar_y - 14, 18, 12, '#f6f8fb', '#ffffff', 3))
body.append(txt(bar_x + 18, bar_y + 46, '0', 18, '#ffffff', '800'))
body.append(txt(bar_x + 290, bar_y + 46, '42', 18, '#ffffff', '800'))
body.append(txt(bar_x + 595, bar_y + 46, '85', 18, '#ffffff', '800'))
body.append(txt(bar_x + bar_w - 42, bar_y + 46, '127', 18, '#ffffff', '800'))
body.append(txt(bar_x + 150, bar_y + 24, 'CAMADA 1', 10.5, '#dcecff', '700'))
body.append(txt(bar_x + 410, bar_y + 24, 'CAMADA 2', 10.5, '#dcecff', '700'))
body.append(txt(bar_x + 700, bar_y + 24, 'CAMADA 3', 10.5, '#dcecff', '700'))
x42 = bar_x + bar_w * 42 / 127
x30 = bar_x + bar_w * 30 / 127
body.append(
    f'<path d="M {x42:.1f} 210 C {x42 - 20:.1f} 190, {x30 + 20:.1f} 190, {x30:.1f} 210" '
    'fill="none" stroke="#e8d34a" stroke-width="3" marker-end="url(#arrow)"/>'
)
body.append(callout(840, 110, '↔', 'Primeiro arraste', 'Ativa “Custom” automaticamente', 260, 52, ACCENT))
body.append(txt(94, 326, '0–41       ·       42–84       ·       85–127  →  ao arrastar para 30:  0–29 / 30–84 / 85–127', 12, MUTED, '600'))
# controls
controls = [
    (72, 382, 'Velocity Layers', '3'), (320, 382, 'Round Robin', '2'),
    (568, 382, 'Sustain', '4.0 s'), (816, 382, 'Release tail', '1.5 s'),
    (72, 470, 'Auto Loop', 'Search + X-Fade'), (320, 470, 'Loop Start / End', '20% / 80%'),
    (568, 470, 'One Shot', 'Desligado'), (816, 470, 'Input Gain', '0.0 dB'),
]
for x, y, name, value in controls:
    body.append(r(x, y, 232, 72, PANEL2, BORDER, 9))
    body.append(txt(x + 14, y + 24, name, 11.5, MUTED, '700'))
    body.append(txt(x + 14, y + 52, value, 16, TEXT, '800'))
body.append(callout(72, 560, 'i', 'Clique perto da divisória', 'Até 8 valores MIDI de distância já puxa a linha', 440, 52, CYAN))
body.append(callout(532, 560, '✓', 'Tudo entra no arquivo', 'As faixas de velocity e tempos são usados na captura', 516, 52, GREEN))
write('help-auto-sampler-som.svg', svg(
    'Auto Sampler — passo 3: Som',
    'Divisórias arrastáveis da resposta de velocity, camadas, round robin, sustain, release, loop e ganho.',
    ''.join(body), 'PASSO 3 / 4'))

# ---------------------------------------------------------------------------
# 5) Captura / recaptura
# ---------------------------------------------------------------------------
body = [step_chips(4)]
body.append(r(72, 168, 976, 110, PANEL, BORDER, 12))
body.append(txt(94, 198, 'Gravando notas…  7 / 12  (58%)', 15, TEXT, '800'))
body.append(r(94, 214, 932, 18, '#2b313b', BORDER, 9))
body.append(r(94, 214, 540, 18, CYAN, CYAN, 9))
body.append(txt(94, 258, 'Nota atual: D#4   ·   VU L/R ao vivo   ·   Cancelar captura interrompe sem apagar o rascunho', 11.5, MUTED))
body.append(r(72, 296, 610, 214, PANEL, BORDER, 12))
body.append(txt(94, 324, 'Resultado por nota', 14, TEXT, '700'))
notes = [('C4', 'OK', GREEN), ('C#4', 'RUIM', RED), ('D4', 'OK', GREEN), ('D#4', 'OK', GREEN),
         ('E4', 'OK', GREEN), ('F4', 'RUIM', RED), ('F#4', 'OK', GREEN), ('G4', 'OK', GREEN)]
for i, (n, status, color) in enumerate(notes):
    x = 94 + (i % 4) * 142
    y = 342 + (i // 4) * 62
    body.append(r(x, y, 126, 46, '#121c18' if status == 'OK' else '#251719', color, 8))
    body.append(txt(x + 12, y + 20, n, 13, TEXT, '800'))
    body.append(txt(x + 12, y + 38, status, 10, color, '800'))
body.append(label(94, 470, 300, '↻ Recapturar só as ruins (C#4, F4)', '#2d2918', ACCENT, 11.5, 30))
body.append(r(702, 296, 346, 214, PANEL, BORDER, 12))
body.append(txt(724, 324, 'Saída e arquivos', 14, TEXT, '700'))
body.append(txt(724, 356, '☑  Instrumento .mrq', 13, TEXT, '700'))
body.append(txt(724, 386, '☑  SoundFont .sf2 / .sf3', 13, TEXT, '700'))
body.append(txt(724, 420, 'O app pergunta onde salvar cada arquivo antes de iniciar.', 11.5, MUTED))
body.append(label(724, 446, 300, '▶ Iniciar captura', '#17465a', CYAN, 12, 34))
body.append(callout(72, 528, '1', 'Acompanhe ao vivo', 'Barra de progresso, nota atual e VU', 300, 64, CYAN))
body.append(callout(392, 528, '2', 'Notas ruins', 'Vermelho = silenciosa; corrija o setup', 310, 64, RED))
body.append(callout(722, 528, '3', 'Recapture só elas', 'Não precisa regravar tudo de novo', 326, 64, GREEN))
write('help-auto-sampler-captura.svg', svg(
    'Auto Sampler — passo 4: Captura',
    'Progresso ao vivo, qualidade por nota, recaptura somente das notas ruins e escolha dos formatos de saída.',
    ''.join(body), 'PASSO 4 / 4'))

# ---------------------------------------------------------------------------
# 6) Rascunho / reset
# ---------------------------------------------------------------------------
body = []
cards = [
    (52, 160, 310, 300, '1. Ajustar e clicar fora', '#173b4a', CYAN,
     ['Porta MIDI, canal, notas,', 'velocity, loop, ganho…', '', 'Clique na área escura:', 'NADA fecha ou se perde.']),
    (405, 160, 310, 300, '2. Fechar no X e reabrir', '#173b4a', CYAN,
     ['O modal continua montado.', 'O rascunho também fica no', 'armazenamento local.', '', 'Mesmo passo e mesmos valores,', 'até após reiniciar o app.']),
    (758, 160, 310, 300, '3. Voltar do zero', '#2d2118', ACCENT,
     ['Botão explícito no rodapé:', '“Limpar tudo / Voltar do zero”.', '', 'Pede confirmação e apaga', 'o rascunho salvo por completo.']),
]
for x, y, w, h, title, fill, color, lines in cards:
    body.append(r(x, y, w, h, fill, color, 14, 2))
    body.append(txt(x + 20, y + 38, title, 15, TEXT, '800'))
    for i, ln in enumerate(lines):
        body.append(txt(x + 20, y + 78 + i * 25, ln, 12, MUTED))
body.append(line(365, 310, 400, 310, ACCENT, 2.5, arrow=True))
body.append(line(718, 310, 753, 310, ACCENT, 2.5, arrow=True))
body.append(r(52, 492, 1016, 92, PANEL, BORDER, 12))
body.append(txt(76, 522, 'O que é preservado', 13, TEXT, '800'))
body.append(txt(76, 550, 'Passo atual · nome · faixa de notas · velocity e divisórias · round robin · sustain/release · loop · ganho · portas/canal · testes · formatos', 11.5, MUTED))
body.append(txt(76, 570, 'O que NÃO é preservado', 11.5, RED, '800'))
body.append(txt(246, 570, 'áudio capturado, progresso de uma captura em andamento, arquivos já exportados', 11.5, MUTED))
write('help-auto-sampler-rascunho.svg', svg(
    'Rascunho automático e “Voltar do zero”',
    'Três comportamentos separados: clique fora não fecha, X guarda tudo, reset apaga tudo só com confirmação.',
    ''.join(body), 'SEGURANÇA'))

# ---------------------------------------------------------------------------
# 7) Tela inicial do Conversor
# ---------------------------------------------------------------------------
body = []
body.append(r(52, 120, 230, 460, PANEL, BORDER, 12))
body.append(txt(74, 152, 'COLUNA ESQUERDA', 11, MUTED, '800'))
for i, (name, color) in enumerate([('Auto Sampler', CYAN), ('Instrumento renderizado', MUTED),
                                   ('Controlador MIDI', MUTED), ('Arquivos recentes', MUTED)]):
    body.append(r(70, 174 + i * 76, 194, 58, PANEL2, color if i == 0 else BORDER, 9))
    body.append(txt(84, 207 + i * 76, name, 12.5, TEXT, '700'))
body.append(txt(72, 518, 'SF2 / SF3: exportação', 11.5, ACCENT, '800'))
body.append(txt(72, 540, 'somente no Conversor', 11.5, ACCENT, '700'))
body.append(txt(320, 140, 'Fluxo em 3 passos', 16, TEXT, '800'))
flow = [
    (320, 170, '1', 'Escolher arquivos', '.exs · .sf2/.sf3 · .syx · .wav · .nsmp', CYAN),
    (580, 170, '2', 'Revisar / editar', 'Inspetor, compatibilidade, Editor de Mapeamento', CYAN),
    (840, 170, '3', 'Converter', '.mrq nativo + opcional .sf2 / .sf3', ACCENT),
]
for x, y, n, title, sub, color in flow:
    body.append(r(x, y, 230, 150, PANEL2, color, 12, 2))
    body.append(circle(x + 28, y + 30, 16, color))
    body.append(txt(x + 28, y + 35, n, 15, '#101318', '800', 'middle'))
    body.append(txt(x + 16, y + 76, title, 14, TEXT, '800'))
    for i, ln in enumerate([sub[:34], sub[34:]]):
        if ln:
            body.append(txt(x + 16, y + 104 + i * 20, ln, 10.5, MUTED))
body.append(line(554, 245, 575, 245, ACCENT, 2.5, arrow=True))
body.append(line(814, 245, 835, 245, ACCENT, 2.5, arrow=True))
# mini inspector grid
body.append(r(320, 350, 750, 230, PANEL, BORDER, 12))
body.append(txt(342, 380, 'Pré-visualização: grupos, zonas e compatibilidade', 13, TEXT, '700'))
for i in range(12):
    x = 342 + (i % 6) * 112
    y = 400 + (i // 6) * 58
    body.append(r(x, y, 100, 46, ['#275f7e', '#2d6f5d', '#6b5631', '#37568d'][i % 4], '#617083', 5))
    body.append(txt(x + 8, y + 27, f'Z{i + 1:02d}', 11, TEXT, '700'))
body.append(txt(342, 548, 'Cada zona = amostra + teclas + velocity + raiz + volume/pan', 11.5, MUTED))
body.append(callout(52, 580, 'i', 'Dica', 'Clique em “Editar mapeamento” antes de converter para ajustar as zonas', 1016, 34, CYAN))
write('help-converter-inicio.svg', svg(
    'Conversor de instrumentos — visão geral',
    'Tela inicial em 1-2-3, formatos aceitos, fila de conversão e exportação opcional para SoundFont.',
    ''.join(body), 'CONVERSOR'))

# ---------------------------------------------------------------------------
# 8) Mapping Editor / divisão de velocity
# ---------------------------------------------------------------------------
body = []
body.append(r(52, 118, 190, 450, PANEL, BORDER, 12))
body.append(txt(72, 146, 'GRUPOS', 11, MUTED, '800'))
for i, name in enumerate(['Piano mf', 'Piano f', 'Piano ff', 'Release']):
    body.append(r(68, 164 + i * 48, 158, 36, '#173b4a' if i == 0 else PANEL2, CYAN if i == 0 else BORDER, 6))
    body.append(txt(82, 188 + i * 48, name, 12, TEXT, '700'))
body.append(txt(72, 390, 'ZONA SELECIONADA', 11, MUTED, '800'))
for i, (k, v) in enumerate([('Root', 'C4 / 60'), ('Tune', '+0 cents'), ('Keys', '48–72'), ('Vel', '10–47'), ('Vol', '−2.0 dB')]):
    body.append(txt(72, 418 + i * 28, k, 11, MUTED, '700'))
    body.append(txt(155, 418 + i * 28, v, 11, TEXT, '700', 'end'))
body.append(r(262, 118, 500, 450, PANEL, BORDER, 12))
body.append(txt(284, 146, 'Grade: teclas (horizontal) × velocity (vertical)', 12.5, TEXT, '700'))
# grid zones stacked
vel_bands = [(160, 55, '#3f91e8', '81–127'), (215, 70, '#2f79cf', '48–80'),
             (285, 60, '#2361ad', '10–47'), (345, 45, '#1c447c', '0–9')]
for y, h, color, lab in vel_bands:
    for j in range(4):
        x = 284 + j * 112
        body.append(r(x, y, 104, h - 4, color, '#80a7cf', 4))
    body.append(txt(742, y + h / 2, lab, 10.5, MUTED, '700', 'end'))
# keyboard strip
for i in range(16):
    x = 284 + i * 28
    body.append(r(x, 410, 26, 70, '#e9edf4', '#7c8695', 2, 1))
    if i % 7 in (0, 1, 3, 4, 5):
        body.append(r(x + 19, 410, 12, 42, '#171b22', '#050608', 1, 1))
body.append(txt(284, 502, 'C3', 10.5, MUTED, '700'))
body.append(txt(500, 502, 'C4', 10.5, MUTED, '700', 'middle'))
body.append(txt(720, 502, 'C5', 10.5, MUTED, '700', 'end'))
# split editor
body.append(r(782, 118, 286, 450, PANEL, BORDER, 12))
body.append(txt(804, 146, 'DIVISÃO DE VELOCITY', 12.5, TEXT, '700'))
for start, end, color in [(0, 10, '#1c447c'), (10, 48, BLUE1), (48, 81, BLUE2), (81, 127, BLUE3)]:
    sx = 804 + 242 * start / 127
    sw = 242 * (end - start) / 127
    body.append(r(sx, 170, sw, 58, color, 'none', 0, 0))
body.append(r(804, 170, 242, 58, 'none', '#6aa7e8', 5, 2))
for value in (10, 48, 81):
    x = 804 + 242 * value / 127
    body.append(line(x, 162, x, 236, '#ffffff', 3))
    body.append(r(x - 7, 158, 14, 10, '#ffffff', '#ffffff', 2))
body.append(txt(812, 208, '0', 11, '#ffffff', '800'))
body.append(txt(1020, 208, '127', 11, '#ffffff', '800', 'end'))
for i, (n, lab) in enumerate([(10, '0–9'), (48, '10–47'), (81, '48–80')]):
    y = 250 + i * 44
    body.append(label(804, y, 100, str(n), h=32))
    body.append(txt(920, y + 21, lab, 11.5, MUTED, '700'))
body.append(txt(920, 382, '81–127', 11.5, MUTED, '700'))
body.append(label(804, 410, 242, 'Preset 10 / 48 / 81', '#242c36', CYAN, 11, 32))
body.append(label(804, 450, 116, 'Equalizar', h=30))
body.append(label(930, 450, 116, 'Esticar', h=30))
body.append(txt(804, 510, '☑ Aplicar a todos os conjuntos', 11, TEXT, '700'))
body.append(txt(804, 536, 'Arraste ou digite os limites', 10.5, MUTED))
body.append(callout(52, 578, '↔', 'Arrastar a linha', 'Muda loVel/hiVel reais e a grade responde na hora', 480, 34, CYAN))
body.append(callout(552, 578, '✓', 'Exemplo do usuário', '0–9 / 10–47 / 48–80 / 81–127', 516, 34, GREEN))
write('help-mapping-editor-split.svg', svg(
    'Editor de Mapeamento — divisão exata de velocity',
    'Arraste as linhas ou digite 10 / 48 / 81; cada parte vira uma faixa real de velocity na grade e no arquivo.',
    ''.join(body), 'MAPEAMENTO'))

# ---------------------------------------------------------------------------
# 9) USB MIDI playback
# ---------------------------------------------------------------------------
body = []
body.append(r(70, 160, 300, 220, PANEL, BORDER, 14))
body.append(txt(94, 192, 'Controlador USB MIDI', 15, TEXT, '800'))
for i in range(14):
    x = 94 + i * 20
    body.append(r(x, 224, 18, 92, '#e9edf4', '#7c8695', 2, 1))
    if i % 7 in (0, 1, 3, 4, 5):
        body.append(r(x + 12, 224, 11, 56, '#171b22', '#050608', 1, 1))
body.append(circle(144, 224, 8, ACCENT))
body.append(txt(94, 348, 'Tocar C4 (velocity 92)', 11.5, MUTED))
body.append(line(372, 270, 450, 270, ACCENT, 3, arrow=True))
body.append(txt(411, 250, 'USB MIDI', 11, ACCENT, '700', 'middle'))
body.append(r(452, 160, 270, 220, '#173b4a', CYAN, 14, 2))
body.append(txt(476, 192, 'MRQ — Conversor', 15, TEXT, '800'))
body.append(txt(476, 228, '1. Porta MIDI ativa', 12, MUTED))
body.append(txt(476, 256, '2. Nota recebida: C4', 12, MUTED))
body.append(txt(476, 284, '3. Velocity: 92', 12, MUTED))
body.append(txt(476, 320, '→ localiza a zona', 13, CYAN, '800'))
body.append(line(724, 270, 802, 270, ACCENT, 3, arrow=True))
body.append(r(804, 160, 250, 220, PANEL, BORDER, 14))
body.append(txt(828, 192, 'Grade de zonas', 15, TEXT, '800'))
for i, (y, h, color) in enumerate([(220, 42, '#2b6cc0'), (266, 42, '#2f79cf'), (312, 42, '#3f91e8')]):
    body.append(r(828, y, 200, h, color, '#8ab5e7', 5))
body.append(r(828, 266, 200, 42, ACCENT, ACCENT, 5, 3))
body.append(txt(838, 294, 'ZONA ACESA — C4 / vel 92', 11, '#111318', '800'))
body.append(txt(828, 356, 'e toca a amostra', 11.5, MUTED))
body.append(callout(70, 420, '1', 'Configurar', 'Escolha a porta do controlador em “Controlador MIDI”', 450, 72, CYAN))
body.append(callout(540, 420, '2', 'Pré-ouvir', 'Toque uma tecla: a zona correspondente acende', 510, 72, CYAN))
body.append(r(70, 520, 984, 66, PANEL2, BORDER, 10))
body.append(txt(92, 548, 'Serve para conferir o mapeamento real sem precisar exportar e abrir o instrumento em outro programa.', 12.5, TEXT, '700'))
body.append(txt(92, 570, 'A nota e a velocity recebidas selecionam a zona na grade key × velocity.', 11.5, MUTED))
write('help-converter-usb-midi.svg', svg(
    'Conversor — pré-escuta com controlador USB MIDI',
    'Ao tocar uma nota no teclado físico, o MRQ mostra qual zona soaria, usando nota e velocity reais.',
    ''.join(body), 'PRÉ-ESCUTA'))


def generate_real_screen(source: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont
    im = Image.open(source).convert('RGBA')
    overlay = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # escurece tudo que fica fora da janela do Auto Sampler
    d.rectangle((0, 0, im.width, im.height), fill=(4, 6, 10, 105))
    # recorta a região da janela limpa
    overlay.paste((0, 0, 0, 0), (115, 78, 832, 742))
    d = ImageDraw.Draw(overlay)
    d.rounded_rectangle((115, 78, 832, 742), radius=10, outline=(87, 211, 140, 255), width=3)
    # moldura da área externa e chamada principal
    d.rounded_rectangle((14, 612, 105, 770), radius=12, fill=(9, 32, 22, 235), outline=(87, 211, 140, 255), width=2)
    font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    bold_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
    f_small = ImageFont.truetype(font_path, 13)
    f_bold = ImageFont.truetype(bold_path, 16)
    d.text((25, 632), 'FORA', font=f_bold, fill=(87, 211, 140, 255))
    d.text((25, 655), 'DA', font=f_bold, fill=(87, 211, 140, 255))
    d.text((25, 678), 'JANELA', font=f_bold, fill=(87, 211, 140, 255))
    d.text((25, 712), 'clique', font=f_small, fill=(220, 230, 240, 255))
    d.text((25, 730), 'não fecha', font=f_small, fill=(220, 230, 240, 255))
    # etiquetas numeradas em pontos reais da tela
    marks = [
        (795, 119, '1', 'X fecha, rascunho fica'),
        (310, 386, '2', 'Porta / canal MIDI'),
        (610, 482, '3', 'Entrada de áudio'),
        (470, 188, '4', 'VU L/R'),
        (785, 712, '5', 'Continuar'),
    ]
    for x, y, num, caption in marks:
        d.ellipse((x - 15, y - 15, x + 15, y + 15), fill=(232, 211, 74, 255), outline=(10, 12, 16, 255), width=2)
        d.text((x, y - 9), num, font=f_bold, fill=(15, 17, 20, 255), anchor='mm')
        tw = d.textlength(caption, font=f_small)
        bx = min(max(8, x - tw / 2 - 8), im.width - tw - 24)
        by = y + 20 if y < 650 else y - 42
        d.rounded_rectangle((bx, by, bx + tw + 16, by + 24), radius=6, fill=(12, 16, 22, 235), outline=(80, 90, 105, 255))
        d.text((bx + 8, by + 5), caption, font=f_small, fill=(235, 240, 248, 255))
    out = Image.alpha_composite(im, overlay).convert('RGB')
    out.save(OUT / 'help-auto-sampler-tela-real.png', optimize=True)
    print('✔ help-auto-sampler-tela-real.png')


if __name__ == '__main__':
    candidate = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/home/user/uploads/image-48.png')
    if candidate.exists():
        generate_real_screen(candidate)
    else:
        print(f'Foto real não encontrada em {candidate}; SVGs gerados mesmo assim.')
