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

## Estado atual (ENXUGADO ✅)

Este projeto já foi trimado pra abrir DIRETO na tela do conversor, como
app independente:

- `src/App.tsx` reescrito: sem a barra de navegação original (biblioteca,
  setlist, player, Rack, etc.) — só `TitleBar` + o conversor
  (`InstrumentConverter`) + atalho de Ajuda/Configurações.
- Removidos de `src/components/`: todas as telas e widgets exclusivos do
  player de multitracks (`PlayerShell`, `ArrangeEditor`, `TracksView`,
  `TransportBar`, `WaveformCanvas`, `MixerStrip`, `ChordView`,
  `CountInOverlay`, `NextSongPreview`, `PartsGrid`, `SongHeader`,
  `SongNotes`, `TeleprompterOverlay`, `TransitionBanner`,
  `VisualMetronome`, `SetlistPanel`, `LibraryPanel`, `TempoPanel`,
  `OutputsPanel`, `KeyPanel`, `GuideVoicePanel`, `MidiPanel`,
  `MidiBridge`, `AudioWatchdog`, `PadWidget`) e do Rack de instrumentos
  (`InstrumentRack`, `RackFxModule`, `RackKnob`, `RackEqGraph`,
  `IconRail`). De 36 componentes em `src/components/`, sobraram 12.
- **Mantidos de propósito** (compartilhados/genéricos, usados pela
  `TitleBar` ou pelo próprio conversor): `TitleBar`, `SessionTimer`,
  `AudioHealthIndicator`, `ChordIndicator`, `RackMidiPanel`,
  `SettingsModal`, `HelpPanel`, `ErrorBoundary`, e os 4 do conversor em
  si (`InstrumentConverter`, `MrqInstrumentAnalyzer`, `MappingEditor`,
  `KontaktCaptureDialog`).
- **`src/audio/` e `src/midi/` NÃO foram tocados** (decisão deliberada):
  os parsers de formato que o conversor usa (`mrqFormat.ts`,
  `mrqiFormat.ts`, `converterFormats.ts`, `exsImport.ts`, `nkiImport.ts`,
  `syxImport.ts`, `kontaktCapture.ts`, `sf2InfoSanitize.ts`,
  `midiNoteNames.ts`) moram na mesma pasta `src/audio/rack/` que o motor
  de reprodução ao vivo do Rack (`RackEngine.ts`, os `*LayerVoice.ts`).
  Como os dois times/instâncias (Conversor e Rack) vão precisar ler o
  MESMO formato `.mrq`/`.mrqi` mais pra frente (é o Rack que carrega o
  que o Conversor exporta), manter esses arquivos idênticos aqui e no
  projeto do Rack evita divergência — a real deduplicação (um pacote
  compartilhado) é uma tarefa de quando os 3 projetos forem reunidos, não
  antes.
- Branding corrigido: `package.json` (`productName`, `description`,
  `appId` → `com.mrq.instrumentconverter`), `src-tauri/tauri.conf.json`
  (título da janela), `index.html` (`<title>`) — tudo agora diz "MRQ
  Instrument Converter", não mais "MRQ - Multitracks Play".

### Verificação feita (sem compilar nativo nesta sandbox)

- `npx tsc -b --noEmit` → limpo, sem erros.
- `npm run build:renderer` (= `tsc --noEmit && vite build`, o MESMO
  comando que o workflow "Release (Tauri)" roda antes de empacotar) →
  build limpo, ~687 KB de JS (contra ~846 KB do app completo).
- Testes automatizados relevantes ao conversor, todos passando:
  `test:syx`, `test:nki`, `test:exs`, `test:mrq-rack`, `test:sf2-sanitize`,
  `test:kontakt-capture`.
- Smoke-test visual via `vite dev` (preview ao vivo) → app abre, título
  certo, sem crash.
- **Não** foi tentado build nativo Tauri/Rust nesta sandbox (sem
  `cargo`/`rustc`/`webkit2gtk` instalados — decisão já tomada em rodadas
  anteriores). A verificação definitiva do instalador real (Windows/
  macOS/Linux) depende do GitHub Actions deste repo.

## Pendência importante: segredos do GitHub Actions

O workflow `.github/workflows/release-tauri.yml` foi copiado junto (ele
assina os instaladores com `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Esses segredos **não** foram
copiados — eles pertencem ao repositório original e não são legíveis via
API (GitHub nunca deixa ler o valor de um secret, só sobrescrever). Ou
seja: **se alguém rodar o release workflow agora neste repo novo, ele vai
falhar na etapa de assinatura.**

Opções pra resolver (ainda não feitas — decisão a tomar com o usuário):
1. Gerar uma chave de assinatura NOVA só pra este app (`tauri signer
   generate`) e cadastrar como secret deste repo — mais simples, mas os
   updates automáticos (se algum dia existirem) não vão reconhecer builds
   antigas assinadas com a chave do app original (o que é esperado, já
   que virou um produto diferente).
2. Reusar a MESMA chave do `mrq-multitracks-play` original, cadastrando
   o mesmo valor como secret aqui também (precisa que o usuário forneça
   a chave, já que ela não é recuperável via API).

## Próximos passos

1. Resolver a pendência de segredos de CI acima (perguntar ao usuário
   qual opção prefere) antes de confiar no release workflow deste repo.
2. Fazer o mesmo trabalho de enxugamento no `mrq-rack-instrumentos`
   (manter `InstrumentRack` + `RackEngine` + `*LayerVoice.ts`, remover o
   player e o conversor) e no `mrq-multitracks-play2` (manter o player,
   remover Rack e Conversor).
3. Depois que os 3 projetos estiverem cada um 100% funcionando de forma
   independente (instalador próprio rodando via CI de cada repo), o
   usuário pediu pra planejarmos juntar os 3 de volta (como módulos/peças
   de um só produto, se der certo).
