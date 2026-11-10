//! Captura de áudio por "loopback" nativo (WASAPI, só Windows por enquanto)
//! — grava diretamente o que um dispositivo de SAÍDA de áudio está
//! tocando, sem precisar de nenhum cabo de áudio virtual (ex.: VB-Audio
//! Virtual Cable) nem reconfigurar o driver de áudio do programa que você
//! quer gravar (ex.: Kontakt). Alternativa mais simples ao fluxo
//! existente baseado em driver de loopback + `getUserMedia` (ver
//! "Entrada de áudio (do Kontakt, via loopback)" em
//! src/audio/rack/autoSampler.ts e docs/mrq-instrument-converter/mrq-auto-sampler.md).
//!
//! Só funciona se o programa que toca o som estiver usando WASAPI
//! (compartilhado) — ou MME/DirectSound, que no Windows acabam passando
//! pelo mesmo "mixer" do sistema — apontando pro MESMO dispositivo de
//! saída escolhido aqui. NÃO funciona se ele estiver em modo ASIO
//! puro/exclusivo direto numa interface de áudio dedicada, porque nesse
//! caso o áudio nunca passa pelo mixer do Windows (não tem o que
//! "escutar" por fora) — nesse cenário ainda é preciso usar o cabo de
//! áudio virtual (ver doc acima).
//!
//! Técnica: no backend WASAPI do `cpal`, construir um *input stream* a
//! partir de um dispositivo de SAÍDA liga automaticamente a flag
//! `AUDCLNT_STREAMFLAGS_LOOPBACK` da API do Windows — a mesma técnica
//! usada pelo OBS Studio ("Captura de Áudio da Área de Trabalho") e pelo
//! Audacity (host "Windows WASAPI" + dispositivo "(loopback)"). Isso
//! PRECISA ser nativo (Rust) porque o `MediaStream`/`getUserMedia` do
//! WebView não expõe loopback de saída por padrão — por design, uma
//! página comum não deveria conseguir gravar "o que está tocando nas
//! caixas de som" sem uma API explícita de sistema operacional pra isso.

#[cfg(target_os = "windows")]
mod imp {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use serde::Serialize;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    #[derive(Serialize)]
    pub struct LoopbackStartInfo {
        pub sample_rate_hz: u32,
        pub channels: u16,
        pub device_name: String,
    }

    /// Mantém viva a thread dedicada que possui o `cpal::Stream` (o stream
    /// em si nunca atravessa threads — só o buffer e a flag de
    /// "gravando agora" são compartilhados, via `Arc`). Ao ser derrubada
    /// (`Drop`), avisa a thread pra desligar e espera ela terminar —
    /// garante que a captura sempre para de verdade, mesmo se o chamador
    /// esquecer de parar explicitamente.
    pub struct LoopbackSession {
        shutdown_tx: mpsc::Sender<()>,
        join_handle: Option<JoinHandle<()>>,
        buffer: Arc<Mutex<Vec<f32>>>,
        recording: Arc<AtomicBool>,
    }

    impl Drop for LoopbackSession {
        fn drop(&mut self) {
            let _ = self.shutdown_tx.send(());
            if let Some(h) = self.join_handle.take() {
                let _ = h.join();
            }
        }
    }

    impl LoopbackSession {
        pub fn set_recording(&self, recording: bool) {
            self.recording.store(recording, Ordering::Relaxed);
        }

        /// Esvazia e devolve tudo que foi capturado desde a última chamada
        /// (ou desde o início, na primeira vez) — mesmo padrão de
        /// "começar a gravar / parar / pegar o que gravou" já usado em
        /// `AutoSamplerSession.captureOneTask` (ver autoSampler.ts), só
        /// que aqui o buffer vive no lado nativo em vez de um
        /// `ScriptProcessorNode`.
        pub fn take_recorded(&self) -> Vec<f32> {
            match self.buffer.lock() {
                Ok(mut buf) => std::mem::take(&mut *buf),
                Err(_) => Vec::new(),
            }
        }
    }

    pub fn is_supported() -> bool {
        true
    }

    pub fn list_devices() -> Result<Vec<String>, String> {
        let host = cpal::default_host();
        let devices = host
            .output_devices()
            .map_err(|e| format!("não foi possível listar os dispositivos de saída de áudio: {e}"))?;
        Ok(devices.filter_map(|d| d.name().ok()).collect())
    }

    pub fn start(device_name: Option<String>) -> Result<(LoopbackSession, LoopbackStartInfo), String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u16, String), String>>();
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
        let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let recording = Arc::new(AtomicBool::new(false));

        let buffer_thread = Arc::clone(&buffer);
        let recording_thread = Arc::clone(&recording);

        let join_handle = std::thread::Builder::new()
            .name("mrq-loopback-capture".into())
            .spawn(move || {
                let built = (|| -> Result<(cpal::Stream, u32, u16, String), String> {
                    let host = cpal::default_host();
                    let device = match &device_name {
                        Some(name) => host
                            .output_devices()
                            .map_err(|e| e.to_string())?
                            .find(|d| d.name().map(|n| &n == name).unwrap_or(false))
                            .ok_or_else(|| {
                                format!(
                                    "dispositivo de saída \"{name}\" não encontrado (pode ter sido desconectado) — atualize a lista e escolha de novo."
                                )
                            })?,
                        None => host.default_output_device().ok_or_else(|| {
                            "nenhum dispositivo de saída de áudio padrão encontrado.".to_string()
                        })?,
                    };
                    let found_name = device.name().unwrap_or_else(|_| "dispositivo desconhecido".to_string());
                    let supported = device.default_output_config().map_err(|e| {
                        format!("não foi possível ler o formato de áudio do dispositivo \"{found_name}\": {e}")
                    })?;
                    let sample_format = supported.sample_format();
                    let config: cpal::StreamConfig = supported.config();
                    let sample_rate_hz = config.sample_rate.0;
                    let channels = config.channels;

                    let err_fn = |err: cpal::StreamError| {
                        eprintln!("[mrq-loopback] erro no stream de captura: {err}");
                    };

                    let stream = match sample_format {
                        cpal::SampleFormat::F32 => {
                            let buf_cb = Arc::clone(&buffer_thread);
                            let rec_cb = Arc::clone(&recording_thread);
                            device.build_input_stream(
                                &config,
                                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                    if rec_cb.load(Ordering::Relaxed) {
                                        if let Ok(mut buf) = buf_cb.lock() {
                                            buf.extend_from_slice(data);
                                        }
                                    }
                                },
                                err_fn,
                                None,
                            )
                        }
                        cpal::SampleFormat::I16 => {
                            let buf_cb = Arc::clone(&buffer_thread);
                            let rec_cb = Arc::clone(&recording_thread);
                            device.build_input_stream(
                                &config,
                                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                    if rec_cb.load(Ordering::Relaxed) {
                                        if let Ok(mut buf) = buf_cb.lock() {
                                            buf.extend(data.iter().map(|s| *s as f32 / i16::MAX as f32));
                                        }
                                    }
                                },
                                err_fn,
                                None,
                            )
                        }
                        cpal::SampleFormat::U16 => {
                            let buf_cb = Arc::clone(&buffer_thread);
                            let rec_cb = Arc::clone(&recording_thread);
                            device.build_input_stream(
                                &config,
                                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                                    if rec_cb.load(Ordering::Relaxed) {
                                        if let Ok(mut buf) = buf_cb.lock() {
                                            buf.extend(data.iter().map(|s| (*s as f32 / u16::MAX as f32) * 2.0 - 1.0));
                                        }
                                    }
                                },
                                err_fn,
                                None,
                            )
                        }
                        other => {
                            return Err(format!(
                                "formato de amostra de áudio não suportado pela captura de loopback: {other:?}"
                            ))
                        }
                    }
                    .map_err(|e| format!("não foi possível abrir a captura de loopback em \"{found_name}\": {e}"))?;

                    stream
                        .play()
                        .map_err(|e| format!("não foi possível iniciar a captura de loopback: {e}"))?;
                    Ok((stream, sample_rate_hz, channels, found_name))
                })();

                match built {
                    Ok((stream, sample_rate_hz, channels, found_name)) => {
                        if ready_tx.send(Ok((sample_rate_hz, channels, found_name))).is_err() {
                            return; // chamador desistiu antes da gente responder — nada a fazer.
                        }
                        // Mantém a thread (e o stream, que não pode atravessar threads)
                        // viva até mandarem desligar — é assim que a captura continua
                        // rodando em segundo plano entre as chamadas de
                        // start/set_recording/take_recorded/stop vindas do frontend.
                        let _ = shutdown_rx.recv();
                        drop(stream);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| format!("não foi possível iniciar a thread de captura de áudio: {e}"))?;

        match ready_rx.recv() {
            Ok(Ok((sample_rate_hz, channels, device_name))) => Ok((
                LoopbackSession {
                    shutdown_tx,
                    join_handle: Some(join_handle),
                    buffer,
                    recording,
                },
                LoopbackStartInfo {
                    sample_rate_hz,
                    channels,
                    device_name,
                },
            )),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("a thread de captura de áudio encerrou inesperadamente antes de responder.".to_string()),
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use serde::Serialize;

    #[derive(Serialize)]
    pub struct LoopbackStartInfo {
        pub sample_rate_hz: u32,
        pub channels: u16,
        pub device_name: String,
    }

    pub struct LoopbackSession;

    impl LoopbackSession {
        pub fn set_recording(&self, _recording: bool) {}
        pub fn take_recorded(&self) -> Vec<f32> {
            Vec::new()
        }
    }

    pub fn is_supported() -> bool {
        false
    }

    const UNSUPPORTED_MSG: &str = "captura de loopback nativa só está disponível no Windows por enquanto — no macOS use o IAC Driver (MIDI) + BlackHole (áudio); no Linux, o \"monitor\" de uma sink do PulseAudio/PipeWire já funciona como entrada de áudio normal, sem precisar desta função. Ver docs/mrq-instrument-converter/mrq-auto-sampler.md.";

    pub fn list_devices() -> Result<Vec<String>, String> {
        Err(UNSUPPORTED_MSG.to_string())
    }

    pub fn start(_device_name: Option<String>) -> Result<(LoopbackSession, LoopbackStartInfo), String> {
        Err(UNSUPPORTED_MSG.to_string())
    }
}

pub use imp::{is_supported, list_devices, start, LoopbackSession, LoopbackStartInfo};
use std::sync::{Arc, Mutex};

/// Estado gerenciado pelo Tauri — só uma captura de loopback por vez (não
/// há caso de uso pra mais de uma simultânea neste app).
pub type LoopbackState = Arc<Mutex<Option<LoopbackSession>>>;

pub fn new_state() -> LoopbackState {
    Arc::new(Mutex::new(None))
}

#[tauri::command]
pub fn loopback_is_supported() -> bool {
    is_supported()
}

#[tauri::command]
pub fn loopback_list_devices() -> Result<Vec<String>, String> {
    list_devices()
}

#[tauri::command]
pub fn loopback_start(
    state: tauri::State<'_, LoopbackState>,
    device_name: Option<String>,
) -> Result<LoopbackStartInfo, String> {
    let mut guard = state
        .lock()
        .map_err(|_| "estado de captura de loopback corrompido.".to_string())?;
    if guard.is_some() {
        return Err("já existe uma captura de loopback em andamento — pare ela antes de iniciar outra.".to_string());
    }
    let (session, info) = start(device_name)?;
    *guard = Some(session);
    Ok(info)
}

#[tauri::command]
pub fn loopback_set_recording(state: tauri::State<'_, LoopbackState>, recording: bool) -> Result<(), String> {
    let guard = state
        .lock()
        .map_err(|_| "estado de captura de loopback corrompido.".to_string())?;
    match guard.as_ref() {
        Some(session) => {
            session.set_recording(recording);
            Ok(())
        }
        None => Err("nenhuma captura de loopback iniciada — chame loopback_start primeiro.".to_string()),
    }
}

#[tauri::command]
pub fn loopback_take_recorded(state: tauri::State<'_, LoopbackState>) -> Result<Vec<f32>, String> {
    let guard = state
        .lock()
        .map_err(|_| "estado de captura de loopback corrompido.".to_string())?;
    match guard.as_ref() {
        Some(session) => Ok(session.take_recorded()),
        None => Err("nenhuma captura de loopback iniciada — chame loopback_start primeiro.".to_string()),
    }
}

#[tauri::command]
pub fn loopback_stop(state: tauri::State<'_, LoopbackState>) -> Result<(), String> {
    let mut guard = state
        .lock()
        .map_err(|_| "estado de captura de loopback corrompido.".to_string())?;
    guard.take(); // dropar a sessão já desliga a thread/stream (ver impl Drop).
    Ok(())
}
