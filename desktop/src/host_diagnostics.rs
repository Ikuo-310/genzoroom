//! Fixed startup codes only; never capture Backend stderr or transport credentials.
use std::io::Write;

pub fn startup_failed(code: &str) {
    if !cfg!(feature = "bundled-backend") {
        return;
    }
    let code = if code.len() <= 80
        && code
            .bytes()
            .all(|value| value.is_ascii_lowercase() || value == b'_')
    {
        code
    } else {
        "desktop_startup_failed"
    };
    let _ = write_code(code);
    #[cfg(windows)]
    if !cfg!(feature = "webview-smoke") {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let message: Vec<u16> = format!("GenzoRoom could not start.\nError: {code}\n\nGenzoRoomを起動できませんでした。\n診断: %LOCALAPPDATA%\\GenzoRoom\\logs\\host.jsonl")
            .encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "GenzoRoom".encode_utf16().chain(Some(0)).collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

fn write_code(code: &str) -> std::io::Result<()> {
    let root = crate::connection::user_root()
        .map_err(std::io::Error::other)?
        .join("logs");
    std::fs::create_dir_all(&root)?;
    let path = root.join("host.jsonl");
    if std::fs::metadata(&path).is_ok_and(|file| file.len() > 65536) {
        let previous = root.join("host.previous.jsonl");
        if previous.exists() {
            std::fs::remove_file(&previous)?;
        }
        std::fs::rename(&path, previous)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(
        file,
        "{}",
        serde_json::json!({"event":"startup_failed", "errorCode":code})
    )
}
