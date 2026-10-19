//! Keep JSON bytes in WebView2's download pipeline; expose no filesystem IPC.
use std::path::PathBuf;
use std::{collections::HashSet, sync::Mutex};
use tauri::{
    webview::{DownloadEvent, PermissionKind, PermissionResponse},
    Url, Webview,
};

pub fn permission(webview: Webview, kind: PermissionKind, port: u16) -> PermissionResponse {
    // Chromium otherwise suppresses later Blob downloads after the asynchronous report fetch.
    // Every download still requires the scoped DownloadStarting check and a native save chooser.
    if kind == PermissionKind::AutomaticDownloads
        && matches!(webview.label(), "main" | "diagnostics")
        && webview.url().is_ok_and(|page| {
            crate::connection::allowed_navigation(&page, port) && page.path() == "/developer"
        })
    {
        #[cfg(feature = "webview-smoke")]
        eprintln!("GenzoRoom download smoke: automatic_permission_allowed");
        PermissionResponse::Allow
    } else {
        PermissionResponse::Default
    }
}

pub fn bridge() -> String {
    let script =
        "Object.defineProperty(window,'__GENZOROOM_REPORT_DOWNLOAD__',{value:true});".to_string();
    #[cfg(feature = "webview-smoke")]
    if std::env::args().any(|value| value == "--auto-smoke")
        && std::env::var_os("GENZOROOM_DOWNLOAD_SMOKE_DIR").is_some()
    {
        let mode = std::env::var("GENZOROOM_DOWNLOAD_SMOKE_MODE").unwrap_or_default();
        let mode = if matches!(mode.as_str(), "cancel" | "failure") {
            mode.as_str()
        } else {
            "save"
        };
        return script
            + &format!(
                "window.__GENZOROOM_JSON_SMOKE__={};",
                serde_json::to_string(mode).unwrap()
            );
    }
    script
}

fn valid_name(name: &str) -> bool {
    name.len() <= 128
        && name.ends_with(".json")
        && name
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'-' | b'.'))
        && [
            "genzoroom-diagnostics-",
            "genzoroom-jpeg-diagnostics-",
            "genzoroom-webgpu-diagnostics-",
            "genzoroom-backend-logs-",
            "genzoroom-frontend-logs-",
            "genzoroom-all-logs-",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn permitted(label: &str, page: &Url, url: &Url, port: u16) -> bool {
    matches!(label, "main" | "diagnostics")
        && crate::connection::allowed_navigation(page, port)
        && page.path() == "/developer"
        && url.scheme() == "blob"
        && Url::parse(url.path())
            .is_ok_and(|inner| crate::connection::allowed_navigation(&inner, port))
}

fn notify(webview: &Webview, url: &Url, status: &str) {
    let detail = serde_json::json!({"url":url.as_str(),"status":status});
    let _ = webview.eval(format!(
        "window.dispatchEvent(new CustomEvent('genzoroom:report-download',{{detail:{detail}}}))"
    ));
}

#[derive(Default)]
pub struct Downloads {
    active: Mutex<HashSet<String>>,
}

impl Downloads {
    pub fn handle(&self, webview: Webview, event: DownloadEvent<'_>, port: u16) -> bool {
        match event {
            DownloadEvent::Requested { url, destination } => {
                let allowed = webview
                    .url()
                    .is_ok_and(|page| permitted(webview.label(), &page, &url, port));
                let name = destination
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                #[cfg(feature = "webview-smoke")]
                eprintln!(
                    "GenzoRoom download smoke: requested allowed={allowed} named={}",
                    valid_name(name)
                );
                if !allowed || !valid_name(name) {
                    notify(&webview, &url, "failed");
                    return false;
                }
                match choose(&webview, name) {
                    Ok(Some(path)) => {
                        self.active.lock().unwrap().insert(url.to_string());
                        *destination = path;
                        true
                    }
                    Ok(None) => {
                        notify(&webview, &url, "cancelled");
                        false
                    }
                    Err(()) => {
                        notify(&webview, &url, "failed");
                        false
                    }
                }
            }
            DownloadEvent::Finished { url, success, .. } => {
                #[cfg(feature = "webview-smoke")]
                eprintln!("GenzoRoom download smoke: finished success={success}");
                // WebView2 also finishes cancelled/rejected requests with success=false.
                // Only an accepted request may emit this second, terminal notification.
                if self.active.lock().unwrap().remove(url.as_str()) {
                    notify(&webview, &url, if success { "saved" } else { "failed" });
                }
                true
            }
            _ => false,
        }
    }
}

fn choose(webview: &Webview, name: &str) -> Result<Option<PathBuf>, ()> {
    #[cfg(feature = "webview-smoke")]
    if std::env::args().any(|value| value == "--auto-smoke") {
        if let Some(root) = std::env::var_os("GENZOROOM_DOWNLOAD_SMOKE_DIR") {
            let root = PathBuf::from(root);
            if !root.is_absolute() || !root.is_dir() {
                return Err(());
            }
            match std::env::var("GENZOROOM_DOWNLOAD_SMOKE_MODE").as_deref() {
                Ok("cancel") => return Ok(None),
                // A directory is not a writable download file; exercise WebView2's real failure event.
                Ok("failure") => return Ok(Some(root)),
                _ => {}
            }
            return Ok(Some(root.join(name)));
        }
    }
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::UI::Controls::Dialogs::*;
        let mut buffer = vec![0u16; 32768];
        for (index, value) in name.encode_utf16().enumerate() {
            buffer[index] = value;
        }
        let filter: Vec<u16> = "JSON (*.json)\0*.json\0\0".encode_utf16().collect();
        let extension: Vec<u16> = "json\0".encode_utf16().collect();
        let mut options: OPENFILENAMEW = std::mem::zeroed();
        options.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        options.hwndOwner = webview.window().hwnd().map_err(|_| ())?.0;
        options.lpstrFile = buffer.as_mut_ptr();
        options.nMaxFile = buffer.len() as u32;
        options.lpstrFilter = filter.as_ptr();
        options.lpstrDefExt = extension.as_ptr();
        // A native save chooser must not change the Backend launcher's working directory.
        options.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_EXPLORER;
        if GetSaveFileNameW(&mut options) == 0 {
            return if CommDlgExtendedError() == 0 {
                Ok(None)
            } else {
                Err(())
            };
        }
        let length = buffer.iter().position(|value| *value == 0).ok_or(())?;
        Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..length],
        ))))
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, name);
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_requires_diagnostics_window_and_exact_origin_blob() {
        let page = Url::parse("http://127.0.0.1:3191/developer").unwrap();
        let blob = Url::parse("blob:http://127.0.0.1:3191/1234").unwrap();
        assert!(permitted("diagnostics", &page, &blob, 3191));
        assert!(permitted("main", &page, &blob, 3191));
        assert!(!permitted("other", &page, &blob, 3191));
        assert!(!permitted(
            "main",
            &Url::parse("http://127.0.0.1:3191/").unwrap(),
            &blob,
            3191
        ));
        for url in [
            "blob:http://evil.invalid/1234",
            "http://127.0.0.1:3191/api/file",
            "blob:http://127.0.0.1:3192/1234",
        ] {
            assert!(!permitted(
                "diagnostics",
                &page,
                &Url::parse(url).unwrap(),
                3191
            ));
        }
    }
    #[test]
    fn suggested_name_cannot_address_another_file() {
        assert!(valid_name(
            "genzoroom-jpeg-diagnostics-20261019T000000Z.json"
        ));
        for name in [
            "../genzoroom-diagnostics-a.json",
            "genzoroom-diagnostics-x.exe",
            "file.json",
        ] {
            assert!(!valid_name(name));
        }
    }
}
