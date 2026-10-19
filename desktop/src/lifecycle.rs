use crate::backend_process::{identifier, BackendProcess};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

pub const BRIDGE: &str = r#"Object.defineProperty(window, '__GENZOROOM_DESKTOP__', {
  value: Object.freeze({ respond: message => window.__TAURI_INTERNALS__.invoke('desktop_lifecycle', { message }) })
});"#;

pub struct Lifecycle {
    owner: Mutex<Option<BackendProcess>>,
    pending: Mutex<Option<String>>,
    draining: AtomicBool,
    restart: AtomicBool,
    pub exit_code: std::sync::atomic::AtomicI32,
    pub approved: AtomicBool,
    pub frontend_ready: AtomicBool,
}

impl Lifecycle {
    pub fn new(owner: Option<BackendProcess>) -> Arc<Self> {
        Arc::new(Self {
            owner: Mutex::new(owner),
            pending: Mutex::new(None),
            draining: AtomicBool::new(false),
            restart: AtomicBool::new(false),
            exit_code: std::sync::atomic::AtomicI32::new(0),
            approved: AtomicBool::new(false),
            frontend_ready: AtomicBool::new(false),
        })
    }

    pub fn request_close(self: &Arc<Self>, app: &tauri::AppHandle) {
        let _ = self.request(app, false);
    }

    fn request(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        restart: bool,
    ) -> Result<(), &'static str> {
        if !self.frontend_ready.load(Ordering::SeqCst) {
            return Err("frontend_not_ready_for_close");
        }
        let request_id = identifier()?;
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.is_some() {
                return Err("lifecycle_busy");
            }
            self.restart.store(restart, Ordering::SeqCst);
            *pending = Some(request_id.clone());
        }
        let state = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let prepared = {
                let mut owner = state.owner.lock().unwrap();
                owner
                    .as_mut()
                    .map_or(Ok(()), |owner| owner.prepare(&request_id))
            };
            if prepared.is_err() {
                state.cancel(&app, &request_id, "backend_shutdown_failed");
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let script = format!("window.dispatchEvent(new CustomEvent('genzoroom:close-request', {{detail:{{requestId:{}}}}}))", serde_json::to_string(&request_id).unwrap());
                if window.eval(script).is_ok() {
                    return;
                }
            }
            state.cancel(&app, &request_id, "frontend_not_ready");
        });
        Ok(())
    }

    fn cancel(&self, app: &tauri::AppHandle, request_id: &str, code: &str) {
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.as_deref() != Some(request_id) {
                return;
            }
            *pending = None;
            self.draining.store(false, Ordering::SeqCst);
            self.restart.store(false, Ordering::SeqCst);
        }
        if let Some(owner) = self.owner.lock().unwrap().as_mut() {
            owner.resume(request_id);
        }
        eprintln!("GenzoRoom desktop: {code}");
        if let Some(window) = app.get_webview_window("main") {
            let detail = serde_json::json!({"code":code});
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('genzoroom:close-cancelled', {{detail:{detail}}}))"));
        }
    }

    pub fn monitor(self: &Arc<Self>, app: &tauri::AppHandle) {
        let state = self.clone();
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if state.approved.load(Ordering::SeqCst) {
                return;
            }
            if state.draining.load(Ordering::SeqCst) {
                continue;
            }
            if let Ok(mut owner) = state.owner.try_lock() {
                if owner
                    .as_mut()
                    .is_some_and(|owner| owner.exited().unwrap_or(true))
                {
                    eprintln!("GenzoRoom desktop: backend_exited_unexpectedly");
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.dispatchEvent(new CustomEvent('genzoroom:close-cancelled', {detail:{code:'backend_exited_unexpectedly'}}))");
                    }
                    return;
                }
                if owner.is_none() {
                    return;
                }
            }
        });
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    kind: String,
    request_id: Option<String>,
    saved: Option<bool>,
}

#[tauri::command]
pub fn desktop_lifecycle(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Lifecycle>>,
    message: Message,
) -> Result<(), &'static str> {
    if window.label() != "main" {
        return Err("invalid_lifecycle_window");
    }
    if message.kind == "ready" && message.request_id.is_none() && message.saved.is_none() {
        state.frontend_ready.store(true, Ordering::SeqCst);
        return Ok(());
    }
    if message.kind == "restart" && message.request_id.is_none() && message.saved.is_none() {
        if state
            .owner
            .try_lock()
            .map_err(|_| "lifecycle_busy")?
            .is_none()
        {
            return Err("managed_mode_required");
        }
        return state.inner().request(window.app_handle(), true);
    }
    let request_id = message.request_id.ok_or("invalid_lifecycle_response")?;
    let saved = message.saved.ok_or("invalid_lifecycle_response")?;
    {
        let pending = state.pending.lock().unwrap();
        if message.kind != "closeResult"
            || pending.as_deref() != Some(&request_id)
            || state.draining.swap(true, Ordering::SeqCst)
        {
            return Err("stale_lifecycle_response");
        }
    }
    let app = window.app_handle().clone();
    if !saved {
        state.cancel(&app, &request_id, "edit_save_failed");
        return Ok(());
    }
    // The pending response is consumed before any asynchronous shutdown work is dispatched.
    let state = state.inner().clone();
    // Keep the child and Job handle owned while waiting, regardless of encoding duration.
    std::thread::spawn(move || {
        let result = {
            let mut owner = state.owner.lock().unwrap();
            owner
                .as_mut()
                .map_or(Ok(()), |owner| owner.shutdown(&request_id))
        };
        if result.is_ok() && state.restart.load(Ordering::SeqCst) {
            // A full document navigation discards old Gallery/Stack/edit state before authentication.
            if let Some(diagnostics) = app.get_webview_window("diagnostics") {
                let _ = diagnostics.close();
            }
            let mut owner = state.owner.lock().unwrap();
            let started =
                BackendProcess::start().or_else(|_| BackendProcess::start_mode(false, true));
            match started {
                Ok((child, connection)) => {
                    *owner = Some(child);
                    state.frontend_ready.store(false, Ordering::SeqCst);
                    if let Some(window) = app.get_webview_window("main") {
                        let url =
                            serde_json::to_string(connection.bootstrap_url().as_str()).unwrap();
                        if window
                            .eval(format!("sessionStorage.clear(); location.replace({url})"))
                            .is_ok()
                        {
                            *state.pending.lock().unwrap() = None;
                            state.draining.store(false, Ordering::SeqCst);
                            state.restart.store(false, Ordering::SeqCst);
                            return;
                        }
                    }
                    eprintln!("GenzoRoom desktop: restart_navigation_failed");
                    // Never unlock an old document against a newly selected Backend.
                    if owner.as_mut().unwrap().shutdown(&request_id).is_ok() {
                        state.approved.store(true, Ordering::SeqCst);
                        app.exit(1);
                    }
                }
                Err(_) => {
                    drop(owner);
                    state.cancel(&app, &request_id, "backend_restart_failed");
                }
            }
        } else if result.is_ok() {
            state.approved.store(true, Ordering::SeqCst);
            app.exit(state.exit_code.load(Ordering::SeqCst));
        } else {
            state.cancel(&app, &request_id, "backend_shutdown_failed");
        }
    });
    Ok(())
}
