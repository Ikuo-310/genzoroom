//! Opt-in real-WebView test instrumentation, excluded from ordinary builds.
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{webview::PageLoadEvent, Manager};

static ROOT_RESULTS: AtomicU8 = AtomicU8::new(0);

fn enabled() -> bool {
    std::env::args().any(|argument| matches!(argument.as_str(), "--webview-smoke" | "--auto-smoke"))
}

pub fn start_timeout(app: &tauri::AppHandle) {
    if enabled() {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(40));
            eprintln!("GenzoRoom WebView2 smoke: timeout");
            app.exit(2);
        });
    }
}

pub fn page_loaded(window: tauri::WebviewWindow, payload: tauri::webview::PageLoadPayload<'_>) {
    if enabled()
        && payload.event() == PageLoadEvent::Finished
        && matches!(payload.url().path(), "/" | "/developer")
        && window.eval(include_str!("webview-smoke.js")).is_err()
    {
        eprintln!("GenzoRoom WebView2 smoke: script_failed");
        window.app_handle().exit(2);
    }
}

pub fn title_changed(window: tauri::WebviewWindow, title: String) {
    if !enabled() {
        return;
    }
    if let Some(payload) = title.strip_prefix("GenzoRoom-keyboard:") {
        if window.label() == "main" {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                let fields = [
                    "domDown",
                    "domUp",
                    "documentEvents",
                    "keyCode",
                    "modifiers",
                    "targetFocus",
                    "simpleShortcut",
                    "inputGuard",
                ];
                let passed = fields.iter().all(|key| value[key] == true);
                let result: serde_json::Map<String, serde_json::Value> = fields
                    .iter()
                    .map(|key| {
                        (
                            (*key).to_string(),
                            serde_json::Value::Bool(value[key] == true),
                        )
                    })
                    .collect();
                println!(
                    "GenzoRoom keyboard smoke: {}",
                    serde_json::Value::Object(result)
                );
                let _ = window.eval(format!("window.__genzoroomKeyboardPassed = {passed}"));
            }
        }
        return;
    }
    if let Some(payload) = title.strip_prefix("GenzoRoom-smoke-root:") {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
            let bits = ["react", "health", "apiErrors", "image"]
                .iter()
                .enumerate()
                .fold(0, |bits, (index, key)| {
                    bits | if value[key].as_bool().unwrap_or(false) {
                        1 << index
                    } else {
                        0
                    }
                });
            ROOT_RESULTS.store(bits, Ordering::SeqCst);
        }
        return;
    }
    if let Some(payload) = title.strip_prefix("GenzoRoom-smoke:") {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            return;
        };
        let fields = [
            "react",
            "health",
            "apiErrors",
            "image",
            "diagnostics",
            "sharedCookie",
            "secureContext",
            "gpuApi",
            "gpuResults",
        ];
        let mut result: serde_json::Map<String, serde_json::Value> = fields
            .iter()
            .map(|key| {
                (
                    (*key).to_string(),
                    serde_json::Value::Bool(value[key].as_bool().unwrap_or(false)),
                )
            })
            .collect();
        let root = ROOT_RESULTS.load(Ordering::SeqCst);
        for (index, key) in fields[..4].iter().enumerate() {
            result.insert(
                (*key).to_string(),
                serde_json::Value::Bool(root & (1 << index) != 0),
            );
        }
        let passed = fields[..6].iter().all(|key| result[*key] == true);
        // Only fixed boolean fields leave the WebView, never text, URLs, keys or image data.
        println!(
            "GenzoRoom WebView2 smoke: {}",
            serde_json::Value::Object(result)
        );
        window.app_handle().exit(if passed { 0 } else { 2 });
    }
}
