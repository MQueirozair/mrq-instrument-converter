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
//! (compartilhado — `WASAPI (Shared Mode)`) — ou MME/DirectSound, que no
//! Windows acabam passando pelo mesmo "mixer" do sistema — apontando pro
//! MESMO dispositivo de saída escolhido aqui. NÃO funciona se ele estiver
//! em modo exclusivo (`WASAPI (Exclusive Mode)` ou `ASIO`/`ASIO4ALL`),
//! porque nesse caso o dispositivo fica bloqueado para qualquer outro
//! cliente WASAPI (erro `0x8889000A` — `AUDCLNT_E_DEVICE_IN_USE`) e o
//! áudio nunca passa pelo mixer do Windows.
//!
//! Técnica: no backend WASAPI do `cpal`, construir um *input stream* a
//! partir de um dispositivo de SAÍDA liga automaticamente a flag
//! `AUDCLNT_STREAMFLAGS_LOOPBACK` da API do Windows — a mesma técnica
//! usada pelo OBS Studio ("Captura de Áudio da Área de Trabalho") e pelo
//! Audacity (host "Windows WASAPI" + dispositivo "(loopback)").

#[cfg(target_os = "windows")]
mod imp {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use serde::Serialize;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LoopbackStartInfo {
        pub sample_rate_hz: u32,
        pub channels: u16,
        pub device_name: String,
    }

    #[derive(Clone, Copy, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LoopbackLevels {
        pub rms_l: f32,
        pub rms_r: f32,
    }

    fn compute_stereo_rms<T, F>(data: &[T], channels: usize, mut to_f32: F) -> (f32, f32)
    where
        F: FnMut(&T) -> f32,
    {
        if data.is_empty() || channels == 0 {
            return (0.0, 0.0);
        }
        let frames = data.len() / channels;
        if frames == 0 {
            return (0.0, 0.0);
        }
        let mut sum_l = 0.0f64;
        let mut sum_r = 0.0f64;
        if channels == 1 {
            for s in data.iter().take(frames) {
                let v = to_f32(s) as f64;
                sum_l += v * v;
            }
            let rms = (sum_l / frames as f64).sqrt() as f32;
            (rms, rms)
        } else {
            for frame in data.chunks_exact(channels) {
                let l = to_f32(&frame[0]) as f64;
                let r = to_f32(&frame[1]) as f64;
                sum_l += l * l;
                sum_r += r * r;
            }
            let rms_l = (sum_l / frames as f64).sqrt() as f32;
            let rms_r = (sum_r / frames as f64).sqrt() as f32;
            (rms_l, rms_r)
        }
    }

    fn format_open_error(found_name: &str, err: impl std::fmt::Display) -> String {
        let raw = err.to_string();
        if raw.to_ascii_lowercase().contains("0x8889000a") {
            format!(
                "o dispositivo de saída \"{found_name}\" está bloqueado em Modo Exclusivo por outro programa (erro WASAPI 0x8889000A — AUDCLNT_E_DEVICE_IN_USE). \
No Kontakt, abra Options (ícone de engrenagem) > Audio e mude o Driver de \"WASAPI (Exclusive Mode)\" ou \"ASIO\" para \"WASAPI (Shared Mode)\" \
(ou clique em \"Abrir Painel de Som do Windows\" abaixo, dê dois cliques em \"{found_name}\" na aba Reprodução > aba Avançado e desmarque \"Permitir que aplicativos assumam o controle exclusivo deste dispositivo\")."
            )
        } else {
            format!("não foi possível abrir a captura de loopback em \"{found_name}\": {raw}")
        }
    }

    /// Mantém viva a thread dedicada que possui o `cpal::Stream` (o stream
    /// em si nunca atravessa threads — só o buffer, o medidor de nível L/R
    /// e a flag de "gravando agora" são compartilhados, via `Arc`). Ao ser
    /// derrubada (`Drop`), avisa a thread pra desligar e espera ela
    /// terminar — garante que a captura sempre para de verdade, mesmo se o
    /// chamador esquecer de parar explicitamente.
    pub struct LoopbackSession {
        shutdown_tx: mpsc::Sender<()>,
        join_handle: Option<JoinHandle<()>>,
        buffer: Arc<Mutex<Vec<f32>>>,
        recording: Arc<AtomicBool>,
        levels: Arc<Mutex<(f32, f32, Option<Instant>)>>,
        alive: Arc<AtomicBool>,
        requested_device: Option<String>,
        info: LoopbackStartInfo,
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
        /// (ou desde o início, na primeira vez).
        pub fn take_recorded(&self) -> Vec<f32> {
            match self.buffer.lock() {
                Ok(mut buf) => std::mem::take(&mut *buf),
                Err(_) => Vec::new(),
            }
        }

        /// Devolve o nível RMS L/R mais recente medido pelo callback de
        /// loopback. Como o WASAPI loopback só dispara o callback enquanto
        /// existe áudio sendo renderizado no dispositivo de saída, qualquer
        /// leitura com mais de 200ms sem pacote novo é tratada como silêncio
        /// (`0.0`), evitando que a barra VU congele no último valor quando o
        /// som para.
        pub fn get_levels(&self) -> LoopbackLevels {
            match self.levels.lock() {
                Ok(guard) => {
                    let (rms_l, rms_r, updated_at) = *guard;
                    match updated_at {
                        Some(t) if t.elapsed() <= Duration::from_millis(200) => {
                            LoopbackLevels { rms_l, rms_r }
                        }
                        _ => LoopbackLevels {
                            rms_l: 0.0,
                            rms_r: 0.0,
                        },
                    }
                }
                Err(_) => LoopbackLevels {
                    rms_l: 0.0,
                    rms_r: 0.0,
                },
            }
        }

        pub fn is_alive(&self) -> bool {
            self.alive.load(Ordering::Relaxed)
        }

        pub fn requested_device(&self) -> &Option<String> {
            &self.requested_device
        }

        pub fn info(&self) -> &LoopbackStartInfo {
            &self.info
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
        let levels: Arc<Mutex<(f32, f32, Option<Instant>)>> = Arc::new(Mutex::new((0.0, 0.0, None)));
        let alive = Arc::new(AtomicBool::new(false));

        let buffer_thread = Arc::clone(&buffer);
        let recording_thread = Arc::clone(&recording);
        let levels_thread = Arc::clone(&levels);
        let alive_thread = Arc::clone(&alive);
        let requested_for_thread = device_name.clone();

        let join_handle = std::thread::Builder::new()
            .name("mrq-loopback-capture".into())
            .spawn(move || {
                let built = (|| -> Result<(cpal::Stream, u32, u16, String), String> {
                    let host = cpal::default_host();
                    let device = match &requested_for_thread {
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
                        format_open_error(&found_name, e)
                    })?;
                    let sample_format = supported.sample_format();
                    let config: cpal::StreamConfig = supported.config();
                    let sample_rate_hz = config.sample_rate.0;
                    let channels = config.channels;
                    let ch_usize = (channels as usize).max(1);

                    let alive_err = Arc::clone(&alive_thread);
                    let err_fn = move |err: cpal::StreamError| {
                        alive_err.store(false, Ordering::Relaxed);
                        eprintln!("[mrq-loopback] erro no stream de captura: {err}");
                    };

                    let stream = match sample_format {
                        cpal::SampleFormat::F32 => {
                            let buf_cb = Arc::clone(&buffer_thread);
                            let rec_cb = Arc::clone(&recording_thread);
                            let lvl_cb = Arc::clone(&levels_thread);
                            device.build_input_stream(
                                &config,
                                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                    let (rms_l, rms_r) = compute_stereo_rms(data, ch_usize, |s| *s);
                                    if let Ok(mut lv) = lvl_cb.lock() {
                                        *lv = (rms_l, rms_r, Some(Instant::now()));
                                    }
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
                            let lvl_cb = Arc::clone(&levels_thread);
                            device.build_input_stream(
                                &config,
                                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                    let (rms_l, rms_r) =
                                        compute_stereo_rms(data, ch_usize, |s| *s as f32 / i16::MAX as f32);
                                    if let Ok(mut lv) = lvl_cb.lock() {
                                        *lv = (rms_l, rms_r, Some(Instant::now()));
                                    }
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
                            let lvl_cb = Arc::clone(&levels_thread);
                            device.build_input_stream(
                                &config,
                                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                                    let (rms_l, rms_r) = compute_stereo_rms(data, ch_usize, |s| {
                                        (*s as f32 / u16::MAX as f32) * 2.0 - 1.0
                                    });
                                    if let Ok(mut lv) = lvl_cb.lock() {
                                        *lv = (rms_l, rms_r, Some(Instant::now()));
                                    }
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
                    .map_err(|e| format_open_error(&found_name, e))?;

                    stream
                        .play()
                        .map_err(|e| format_open_error(&found_name, e))?;
                    Ok((stream, sample_rate_hz, channels, found_name))
                })();

                match built {
                    Ok((stream, sample_rate_hz, channels, found_name)) => {
                        alive_thread.store(true, Ordering::Relaxed);
                        if ready_tx.send(Ok((sample_rate_hz, channels, found_name))).is_err() {
                            alive_thread.store(false, Ordering::Relaxed);
                            return;
                        }
                        let _ = shutdown_rx.recv();
                        alive_thread.store(false, Ordering::Relaxed);
                        drop(stream);
                    }
                    Err(e) => {
                        alive_thread.store(false, Ordering::Relaxed);
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| format!("não foi possível iniciar a thread de captura de áudio: {e}"))?;

        match ready_rx.recv() {
            Ok(Ok((sample_rate_hz, channels, resolved_name))) => {
                let info = LoopbackStartInfo {
                    sample_rate_hz,
                    channels,
                    device_name: resolved_name,
                };
                Ok((
                    LoopbackSession {
                        shutdown_tx,
                        join_handle: Some(join_handle),
                        buffer,
                        recording,
                        levels,
                        alive,
                        requested_device: device_name,
                        info: info.clone(),
                    },
                    info,
                ))
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("a thread de captura de áudio encerrou inesperadamente antes de responder.".to_string()),
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use serde::Serialize;

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LoopbackStartInfo {
        pub sample_rate_hz: u32,
        pub channels: u16,
        pub device_name: String,
    }

    #[derive(Clone, Copy, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LoopbackLevels {
        pub rms_l: f32,
        pub rms_r: f32,
    }

    pub struct LoopbackSession {
        requested_device: Option<String>,
        info: LoopbackStartInfo,
    }

    impl LoopbackSession {
        pub fn set_recording(&self, _recording: bool) {}
        pub fn take_recorded(&self) -> Vec<f32> {
            Vec::new()
        }
        pub fn get_levels(&self) -> LoopbackLevels {
            LoopbackLevels {
                rms_l: 0.0,
                rms_r: 0.0,
            }
        }
        pub fn is_alive(&self) -> bool {
            false
        }
        pub fn requested_device(&self) -> &Option<String> {
            &self.requested_device
        }
        pub fn info(&self) -> &LoopbackStartInfo {
            &self.info
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

pub use imp::{is_supported, list_devices, start, LoopbackLevels, LoopbackSession, LoopbackStartInfo};
use std::sync::{Arc, Mutex};

/// Estado gerenciado pelo Tauri — uma sessão de loopback ativa por vez,
/// compartilhada entre o medidor de nível L/R ao vivo e a gravação do Auto
/// Sampler.
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
    if let Some(existing) = guard.as_ref() {
        if existing.is_alive() && existing.requested_device() == &device_name {
            existing.set_recording(false);
            let _ = existing.take_recorded();
            return Ok(existing.info().clone());
        }
    }
    if let Some(old) = guard.take() {
        drop(old);
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
pub fn loopback_get_levels(state: tauri::State<'_, LoopbackState>) -> LoopbackLevels {
    match state.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(session) => session.get_levels(),
            None => LoopbackLevels {
                rms_l: 0.0,
                rms_r: 0.0,
            },
        },
        Err(_) => LoopbackLevels {
            rms_l: 0.0,
            rms_r: 0.0,
        },
    }
}

#[tauri::command]
pub fn loopback_stop(state: tauri::State<'_, LoopbackState>) -> Result<(), String> {
    let mut guard = state
        .lock()
        .map_err(|_| "estado de captura de loopback corrompido.".to_string())?;
    guard.take();
    Ok(())
}

#[tauri::command]
pub fn loopback_open_sound_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("control.exe")
            .arg("mmsys.cpl")
            .spawn()
            .map_err(|e| format!("não foi possível abrir o Painel de Som do Windows (mmsys.cpl): {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("atalho do Painel de Som do Windows só está disponível no Windows.".to_string())
    }
}
