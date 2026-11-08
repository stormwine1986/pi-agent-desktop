//! The panel shown while the packaged server starts.
//!
//! The main window cannot exist before the server answers (it would load a
//! connection-refused page), and on Windows that wait is 1–3 seconds of the
//! user staring at nothing after double-clicking the icon. This window fills
//! that gap: shown right after the server process is spawned, closed the moment
//! the main window is revealed.
//!
//! It is deliberately a separate window rather than a splash URL in the main
//! one: the main window's navigation guard pins it to the server origin, and
//! pointing it somewhere else first would mean teaching that guard about a
//! second origin for the sake of a few hundred milliseconds.
//!
//! The document is written to a temp file and loaded as `file://`. The first
//! attempt fed the markup to `about:blank` through an initialization script and
//! `document.write`; WebView2 dropped it when the blank document finalized and
//! the user got a black rectangle. A real navigation has no such race.

use std::io::Write as _;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::logging::{desktop_log, since_process_start_ms};
use crate::native_prefs::read_stored_theme;
#[cfg(not(target_os = "macos"))]
use crate::native_prefs::theme_background_color;

/// Label of the splash window. Public so the window-state plugin can denylist
/// it: the plugin restores a saved position after the window is already on
/// screen, which made a centred panel jump to one side on every start.
pub const SPLASH_LABEL: &str = "splash";

/// The app icon, compiled in rather than read from the resource directory: the
/// splash must draw before anything else is guaranteed to be on disk.
const ICON_PNG: &[u8] = include_bytes!("../../icons/128x128.png");

/// Shows the splash window unless one already exists. Failures are logged and
/// ignored: a missing splash must never keep the app from starting.
pub fn show_splash(app: &AppHandle) {
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        return;
    }
    let Some(path) = write_splash_document(app) else {
        return;
    };
    let Ok(url) = Url::from_file_path(&path) else {
        desktop_log(app, "splash: temp path is not a valid file URL");
        return;
    };

    let built = {
        let mut builder = WebviewWindowBuilder::new(app, SPLASH_LABEL, WebviewUrl::External(url))
            .title("Entity Assistant")
            .inner_size(420.0, 280.0)
            .resizable(false)
            .decorations(false)
            .skip_taskbar(true)
            // Centred when it is created, not after: the window is shown
            // before its first paint, so centring afterwards made it appear in
            // the corner and jump.
            .center()
            // The main window stays hidden until the first screen is ready, but
            // a slow reveal must not leave the splash buried behind it.
            .always_on_top(true)
            // Matches the document background, so the window does not flash
            // white while the page is still loading.
            .visible(true)
            .on_page_load(|webview, payload| {
                desktop_log(
                    webview.app_handle(),
                    &format!("splash page load {:?}", payload.event()),
                );
            });
        #[cfg(not(target_os = "macos"))]
        {
            let theme = read_stored_theme(app);
            builder =
                builder.background_color(theme_background_color(theme.as_deref().unwrap_or("dark")));
        }
        builder.build()
    };

    match built {
        Ok(_) => desktop_log(
            app,
            &format!("splash shown (+{}ms)", since_process_start_ms()),
        ),
        Err(error) => desktop_log(app, &format!("splash window failed: {error}")),
    }
}

/// Closes the splash window if it is still up. Safe to call more than once.
pub fn close_splash(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
        let _ = window.close();
    }
    // The document is deliberately left on disk: deleting it on close raced
    // WebView2's navigation and produced ERR_FILE_NOT_FOUND when a second
    // instance started while the first was still on screen. It is one small
    // file with a fixed name, rewritten on every launch.
}

fn splash_document_path() -> PathBuf {
    std::env::temp_dir().join("entity-assistant-splash.html")
}

fn write_splash_document(app: &AppHandle) -> Option<PathBuf> {
    let path = splash_document_path();
    let html = splash_document(read_stored_theme(app).as_deref());
    match std::fs::File::create(&path).and_then(|mut file| file.write_all(html.as_bytes())) {
        Ok(()) => Some(path),
        Err(error) => {
            desktop_log(app, &format!("splash: could not write document: {error}"));
            None
        }
    }
}

fn splash_document(theme: Option<&str>) -> String {
    let (background, foreground, track, tint) = match theme {
        Some("light") => ("#ffffff", "#1a1a1a", "#e2e2e2", "none"),
        // The icon is a near-black tile; on a dark splash it would otherwise
        // leave nothing visible but the glyph.
        _ => ("#111111", "#e8e8e8", "#333333", "brightness(1.35)"),
    };
    let icon = format!("data:image/png;base64,{}", base64_encode(ICON_PNG));
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Entity Assistant</title><style>\
html,body{{margin:0;height:100%;background:{background};color:{foreground};\
font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;\
display:flex;align-items:center;justify-content:center;overflow:hidden;\
user-select:none;-webkit-user-select:none;-webkit-app-region:drag}}\
.wrap{{display:flex;flex-direction:column;align-items:center;gap:16px}}\
.mark{{width:64px;height:64px;display:block;filter:{tint}}}\
.title{{font-size:15px;letter-spacing:.02em}}\
.bar{{position:relative;width:132px;height:2px;background:{track};overflow:hidden;border-radius:2px}}\
.bar::after{{content:\"\";position:absolute;left:-40%;top:0;width:40%;height:100%;\
background:{foreground};opacity:.7;animation:slide 1.1s ease-in-out infinite}}\
@keyframes slide{{0%{{left:-40%}}100%{{left:100%}}}}\
.hint{{font-size:11px;opacity:.45}}\
</style></head><body><div class=\"wrap\">\
<img class=\"mark\" alt=\"\" src=\"{icon}\">\
<div class=\"title\">Entity Assistant</div>\
<div class=\"bar\"></div><div class=\"hint\">Starting up</div></div></body></html>"
    )
}

/// Minimal standard base64. Avoids a dependency for the one data URI above.
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}
