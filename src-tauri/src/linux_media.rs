//! Libera `navigator.getUserMedia`/`navigator.mediaDevices.getUserMedia` no
//! WebKitGTK (Linux) — usado pelo Auto Sampler
//! (`src/audio/rack/autoSampler.ts`) pra gravar a entrada de áudio
//! (dispositivo de loopback configurado pelo usuário) durante a captura
//! automática.
//!
//! Ao contrário de um navegador de verdade, o WebKitGTK vem com streams de
//! mídia DESLIGADOS por padrão e não tem prompt de permissão nenhum: toda
//! chamada de `getUserMedia()` é recusada a menos que o app embarcador (1)
//! ligue explicitamente as settings `enable-media-stream`/`enable-webaudio`
//! e (2) responda ao sinal `permission-request` permitindo pedidos do tipo
//! `UserMediaPermissionRequest` — outros tipos (geolocalização, notificação)
//! ficam com o padrão do WebKit, que é negar. Ver, por exemplo, o mesmo
//! problema/correção documentado publicamente em
//! github.com/zackees/fastled-wasm (PR #228, "allow microphone access on
//! Linux") — a mesma combinação de versão `webkit2gtk = "2.0"` com a
//! feature `v2_40` (a mesma que o `wry`, usado pelo Tauri, já linka).
//!
//! No Windows (WebView2/Chromium) e no macOS (WKWebView, com
//! `NSMicrophoneUsageDescription` declarado em `Info.plist` — ver esse
//! arquivo na raiz de `src-tauri/`), o próprio engine já mostra um prompt
//! de permissão nativo sem precisar de nada disso; por isso esta função só
//! existe compilada pra `target_os = "linux"` (ver chamada em `lib.rs`).
#![cfg(target_os = "linux")]

use gtk::glib::Cast;
use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

pub fn allow_user_media(webview: &webkit2gtk::WebView) {
    if let Some(settings) = webview.settings() {
        settings.set_enable_media_stream(true);
        settings.set_enable_webaudio(true);
    }
    webview.connect_permission_request(|_, request| {
        if request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>().is_some() {
            request.allow();
            true
        } else {
            false
        }
    });
}
