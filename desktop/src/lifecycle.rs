use crate::backend_process::{identifier, BackendProcess};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

pub const BRIDGE: &str = r#"let genzoroomFrontendReady = false;
Object.defineProperty(window, '__GENZOROOM_DESKTOP__', {
  value: Object.freeze({ respond: message => {
    const response = window.__TAURI_INTERNALS__.invoke('desktop_lifecycle', { message });
    if (message.kind === 'ready') return response.then(value => { genzoroomFrontendReady = true; return value; });
    return response;
  } })
});
const showGenzoRoomStartupError = () => {
  if (genzoroomFrontendReady || document.querySelector('[data-genzoroom-startup-error]')) return;
  const panel = document.createElement('div');
  panel.setAttribute('role', 'alert');
  panel.dataset.genzoroomStartupError = 'true';
  panel.textContent = 'GenzoRoom could not finish starting. Close the window to stop safely.';
  Object.assign(panel.style, { position: 'fixed', inset: '0', zIndex: '2147483647', display: 'grid', placeItems: 'center', padding: '2rem', background: '#18181a', color: '#f4f4f5', font: '16px sans-serif' });
  (document.body || document.documentElement).append(panel);
};
window.addEventListener('error', showGenzoRoomStartupError, true);
window.addEventListener('unhandledrejection', showGenzoRoomStartupError);"#;

#[cfg(feature = "webview-smoke")]
const UNREADY_SMOKE_BRIDGE: &str = r#"Object.defineProperty(window, '__GENZOROOM_DESKTOP__', {
  value: Object.freeze({ respond: message => message.kind === 'ready'
    ? Promise.reject(new Error('frontend_not_ready'))
    : window.__TAURI_INTERNALS__.invoke('desktop_lifecycle', { message }) })
});"#;

pub fn bridge(unready_smoke: bool) -> &'static str {
    #[cfg(feature = "webview-smoke")]
    if unready_smoke {
        return UNREADY_SMOKE_BRIDGE;
    }
    let _ = unready_smoke;
    BRIDGE
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrontendState {
    NeverReady,
    Ready,
    Reloading,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequestPhase {
    Guarding,
    HostShutdown,
    Draining,
}

#[derive(Debug)]
struct PendingRequest {
    id: String,
    phase: RequestPhase,
    restart: bool,
}

#[derive(Debug)]
struct LifecycleState {
    frontend: FrontendState,
    pending: Option<PendingRequest>,
}

pub struct Lifecycle {
    launch: Option<crate::backend_launch::BackendLaunch>,
    owner: Mutex<Option<BackendProcess>>,
    state: Mutex<LifecycleState>,
    pub exit_code: AtomicI32,
    pub approved: AtomicBool,
}

impl Lifecycle {
    pub fn new(owner: Option<BackendProcess>) -> Arc<Self> {
        Arc::new(Self {
            launch: owner.as_ref().map(|owner| owner.launch.clone()),
            owner: Mutex::new(owner),
            state: Mutex::new(LifecycleState {
                frontend: FrontendState::NeverReady,
                pending: None,
            }),
            exit_code: AtomicI32::new(0),
            approved: AtomicBool::new(false),
        })
    }

    pub fn request_close(self: &Arc<Self>, app: &tauri::AppHandle) {
        let reloading = self.state.lock().unwrap().frontend == FrontendState::Reloading;
        if reloading {
            if confirm_reload_exit() {
                let _ = self.request_after_reload_confirmation(app);
            }
        } else {
            let _ = self.request(app, false);
        }
    }

    pub fn request_exit(self: &Arc<Self>, app: &tauri::AppHandle) {
        // ExitRequested can follow a user-denied window-close prompt; never prompt twice here.
        let _ = self.request(app, false);
    }

    fn request(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        restart: bool,
    ) -> Result<(), &'static str> {
        let request_id = identifier()?;
        let phase = self.begin_request(&request_id, restart)?;

        self.dispatch_request(app, request_id, phase);
        Ok(())
    }

    fn request_after_reload_confirmation(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
    ) -> Result<(), &'static str> {
        let request_id = identifier()?;
        let phase = self.begin_confirmed_reload_exit(&request_id)?;
        self.dispatch_request(app, request_id, phase);
        Ok(())
    }

    fn begin_confirmed_reload_exit(&self, request_id: &str) -> Result<RequestPhase, &'static str> {
        let mut state = self.state.lock().unwrap();
        if state.pending.is_some() {
            return Err("lifecycle_busy");
        }
        if state.frontend != FrontendState::Reloading {
            return Err("frontend_state_changed");
        }
        state.pending = Some(PendingRequest {
            id: request_id.into(),
            phase: RequestPhase::HostShutdown,
            restart: false,
        });
        Ok(RequestPhase::HostShutdown)
    }

    fn dispatch_request(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        request_id: String,
        phase: RequestPhase,
    ) {
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

            if phase == RequestPhase::HostShutdown {
                if !state.begin_draining(&request_id) {
                    return;
                }
                state.finish_shutdown(&app, request_id);
                return;
            }

            if !state.request_is_guarding(&request_id) {
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
    }

    fn begin_request(&self, request_id: &str, restart: bool) -> Result<RequestPhase, &'static str> {
        let mut state = self.state.lock().unwrap();
        if state.pending.is_some() {
            return Err("lifecycle_busy");
        }
        let phase = match state.frontend {
            FrontendState::NeverReady => RequestPhase::HostShutdown,
            FrontendState::Ready => RequestPhase::Guarding,
            // A document that was once editable may still own unsaved state during reload.
            FrontendState::Reloading => return Err("frontend_reloading"),
        };
        state.pending = Some(PendingRequest {
            id: request_id.into(),
            phase,
            restart,
        });
        Ok(phase)
    }

    fn accept_close_result(&self, request_id: &str) -> Result<bool, &'static str> {
        let mut state = self.state.lock().unwrap();
        let Some(pending) = state.pending.as_mut() else {
            return Err("stale_lifecycle_response");
        };
        if pending.id != request_id || pending.phase != RequestPhase::Guarding {
            return Err("stale_lifecycle_response");
        }
        pending.phase = RequestPhase::Draining;
        Ok(pending.restart)
    }

    fn request_is_guarding(&self, request_id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .pending
            .as_ref()
            .is_some_and(|pending| {
                pending.id == request_id && pending.phase == RequestPhase::Guarding
            })
    }

    fn page_start_transition(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        if state.frontend == FrontendState::Ready {
            state.frontend = FrontendState::Reloading;
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.phase == RequestPhase::Guarding)
        {
            state.pending.take().map(|pending| pending.id)
        } else {
            None
        }
    }

    fn begin_draining(&self, request_id: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if let Some(pending) = state.pending.as_mut() {
            if pending.id == request_id {
                pending.phase = RequestPhase::Draining;
                return true;
            }
        }
        false
    }

    fn take_pending(&self, request_id: &str) -> Option<PendingRequest> {
        let mut state = self.state.lock().unwrap();
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == request_id)
        {
            state.pending.take()
        } else {
            None
        }
    }

    fn cancel(&self, app: &tauri::AppHandle, request_id: &str, code: &str) {
        if self.take_pending(request_id).is_none() {
            return;
        }
        if let Some(owner) = self.owner.lock().unwrap().as_mut() {
            owner.resume(request_id);
        }
        eprintln!("GenzoRoom desktop: {code}");
        self.notify_cancelled(app, Some(request_id), code);
    }

    fn notify_cancelled(&self, app: &tauri::AppHandle, request_id: Option<&str>, code: &str) {
        if let Some(window) = app.get_webview_window("main") {
            let detail = serde_json::json!({"code":code, "requestId":request_id});
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('genzoroom:close-cancelled', {{detail:{detail}}}))"));
        }
    }

    fn finish_shutdown(self: &Arc<Self>, app: &tauri::AppHandle, request_id: String) {
        let restart = self
            .state
            .lock()
            .unwrap()
            .pending
            .as_ref()
            .filter(|pending| pending.id == request_id)
            .is_some_and(|pending| pending.restart);
        let result = {
            let mut owner = self.owner.lock().unwrap();
            owner
                .as_mut()
                .map_or(Ok(()), |owner| owner.shutdown(&request_id))
        };
        if result.is_err() {
            self.cancel(app, &request_id, "backend_shutdown_failed");
            return;
        }
        if restart {
            self.restart_backend(app, request_id);
        } else {
            self.approved.store(true, Ordering::SeqCst);
            app.exit(self.exit_code.load(Ordering::SeqCst));
        }
    }

    fn restart_backend(self: &Arc<Self>, app: &tauri::AppHandle, request_id: String) {
        if let Some(diagnostics) = app.get_webview_window("diagnostics") {
            let _ = diagnostics.close();
        }
        let mut owner = self.owner.lock().unwrap();
        let launch = self
            .launch
            .as_ref()
            .expect("managed lifecycle owns a launch configuration");
        let started = BackendProcess::start_launch(
            launch.clone(),
            std::time::Duration::from_secs(30),
            false,
            false,
        )
        .or_else(|_| {
            BackendProcess::start_launch(
                launch.clone(),
                std::time::Duration::from_secs(30),
                false,
                true,
            )
        });
        match started {
            Ok((child, connection)) => {
                *owner = Some(child);
                self.state.lock().unwrap().frontend = FrontendState::Reloading;
                if let Some(window) = app.get_webview_window("main") {
                    let url = serde_json::to_string(connection.bootstrap_url().as_str()).unwrap();
                    if window
                        .eval(format!("sessionStorage.clear(); location.replace({url})"))
                        .is_ok()
                    {
                        self.state.lock().unwrap().pending = None;
                        return;
                    }
                }
                eprintln!("GenzoRoom desktop: restart_navigation_failed");
                // Never unlock an old document against a newly selected Backend.
                if owner.as_mut().unwrap().shutdown(&request_id).is_ok() {
                    self.approved.store(true, Ordering::SeqCst);
                    app.exit(1);
                }
            }
            Err(_) => {
                drop(owner);
                self.cancel(app, &request_id, "backend_restart_failed");
            }
        }
    }

    fn backend_exited(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.phase == RequestPhase::Draining)
        {
            return None;
        }
        state.pending.take().map(|pending| pending.id)
    }

    pub fn monitor(self: &Arc<Self>, app: &tauri::AppHandle) {
        let state = self.clone();
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if state.approved.load(Ordering::SeqCst) {
                return;
            }
            let draining = state
                .state
                .lock()
                .unwrap()
                .pending
                .as_ref()
                .is_some_and(|pending| pending.phase == RequestPhase::Draining);
            if draining {
                continue;
            }
            let exited = if let Ok(mut owner) = state.owner.try_lock() {
                if owner
                    .as_mut()
                    .is_some_and(|owner| owner.exited().unwrap_or(true))
                {
                    owner.take();
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if exited {
                eprintln!("GenzoRoom desktop: backend_exited_unexpectedly");
                let request_id = state.backend_exited();
                state.notify_cancelled(&app, request_id.as_deref(), "backend_exited_unexpectedly");
                return;
            }
        });
    }

    fn mark_ready(&self) -> Result<(), &'static str> {
        let mut state = self.state.lock().unwrap();
        if state.pending.is_some() {
            return Err("lifecycle_busy");
        }
        state.frontend = FrontendState::Ready;
        Ok(())
    }

    pub fn page_started(self: &Arc<Self>, app: &tauri::AppHandle) {
        if let Some(request_id) = self.page_start_transition() {
            let state = self.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(owner) = state.owner.lock().unwrap().as_mut() {
                    owner.resume(&request_id);
                }
                state.notify_cancelled(&app, Some(&request_id), "frontend_reloaded");
            });
        }
    }
}

fn confirm_reload_exit() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_TASKMODAL, MB_YESNO,
        };
        let message: Vec<u16> = "GenzoRoom is still reloading. Closing now may lose edits that were not saved before reloading. Exit anyway?\n\nGenzoRoomは再読み込み中です。再読み込み前に保存されていない編集内容が失われる可能性があります。終了しますか?"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let title: Vec<u16> = "GenzoRoom".encode_utf16().chain(Some(0)).collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TASKMODAL,
            ) == IDYES
        }
    }
    #[cfg(not(windows))]
    {
        false
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
        return state.mark_ready();
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
    if message.kind != "closeResult" {
        return Err("stale_lifecycle_response");
    }
    state.accept_close_result(&request_id)?;
    let app = window.app_handle().clone();
    if !saved {
        state.cancel(&app, &request_id, "edit_save_failed");
        return Ok(());
    }
    let state = state.inner().clone();
    std::thread::spawn(move || state.finish_shutdown(&app, request_id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_request(frontend: FrontendState, phase: RequestPhase, id: &str) -> Lifecycle {
        Lifecycle {
            launch: None,
            owner: Mutex::new(None),
            state: Mutex::new(LifecycleState {
                frontend,
                pending: Some(PendingRequest {
                    id: id.into(),
                    phase,
                    restart: false,
                }),
            }),
            exit_code: AtomicI32::new(0),
            approved: AtomicBool::new(false),
        }
    }

    #[test]
    fn backend_exit_resolves_guard_and_duplicate_exit_is_idempotent() {
        let lifecycle = with_request(FrontendState::Ready, RequestPhase::Guarding, "old");
        assert_eq!(lifecycle.backend_exited().as_deref(), Some("old"));
        assert!(lifecycle.state.lock().unwrap().pending.is_none());
        assert_eq!(lifecycle.backend_exited(), None);
    }

    #[test]
    fn delayed_close_result_cannot_consume_a_new_request() {
        let lifecycle = with_request(FrontendState::Ready, RequestPhase::Guarding, "new");
        assert!(lifecycle.take_pending("old").is_none());
        assert_eq!(
            lifecycle.state.lock().unwrap().pending.as_ref().unwrap().id,
            "new"
        );
    }

    #[test]
    fn backend_exit_during_drain_is_owned_by_the_shutdown_waiter() {
        let lifecycle = with_request(FrontendState::Ready, RequestPhase::Draining, "active");
        assert_eq!(lifecycle.backend_exited(), None);
        assert_eq!(
            lifecycle.state.lock().unwrap().pending.as_ref().unwrap().id,
            "active"
        );
    }

    #[test]
    fn initial_unready_can_use_host_shutdown_but_reload_cannot_bypass_guard() {
        let initial = Lifecycle::new(None);
        assert_eq!(
            initial.begin_request("initial", false),
            Ok(RequestPhase::HostShutdown)
        );
        let reloading = Lifecycle::new(None);
        reloading.state.lock().unwrap().frontend = FrontendState::Ready;
        assert_eq!(reloading.page_start_transition(), None);
        assert_eq!(
            reloading.begin_request("reload", false),
            Err("frontend_reloading")
        );
        assert!(reloading.state.lock().unwrap().pending.is_none());
    }

    #[test]
    fn reload_can_use_host_shutdown_only_after_explicit_confirmation() {
        let lifecycle = Lifecycle::new(None);
        lifecycle.state.lock().unwrap().frontend = FrontendState::Reloading;
        assert_eq!(
            lifecycle.begin_request("normal", false),
            Err("frontend_reloading")
        );
        assert_eq!(
            lifecycle.begin_confirmed_reload_exit("confirmed"),
            Ok(RequestPhase::HostShutdown)
        );
        assert_eq!(
            lifecycle.state.lock().unwrap().pending.as_ref().unwrap().id,
            "confirmed"
        );

        let changed = Lifecycle::new(None);
        changed.state.lock().unwrap().frontend = FrontendState::Ready;
        assert_eq!(
            changed.begin_confirmed_reload_exit("stale-confirmation"),
            Err("frontend_state_changed")
        );
        assert!(changed.state.lock().unwrap().pending.is_none());
    }

    #[test]
    fn failed_save_cancellation_does_not_clear_a_replacement_request() {
        let lifecycle = with_request(FrontendState::Ready, RequestPhase::Guarding, "new");
        assert!(lifecycle.take_pending("old").is_none());
        assert!(lifecycle.state.lock().unwrap().pending.is_some());
        assert!(lifecycle.take_pending("new").is_some());
    }

    #[test]
    fn close_result_and_backend_exit_have_one_request_id_owner() {
        let lifecycle = with_request(FrontendState::Ready, RequestPhase::Guarding, "request");
        assert_eq!(lifecycle.accept_close_result("request"), Ok(false));
        assert_eq!(lifecycle.backend_exited(), None);
        assert_eq!(
            lifecycle
                .state
                .lock()
                .unwrap()
                .pending
                .as_ref()
                .unwrap()
                .phase,
            RequestPhase::Draining
        );
    }

    #[test]
    fn cancellation_allows_a_new_close_attempt_and_old_completion_is_stale() {
        let lifecycle = with_request(FrontendState::Ready, RequestPhase::Guarding, "old");
        assert_eq!(lifecycle.backend_exited().as_deref(), Some("old"));
        assert_eq!(
            lifecycle.begin_request("new", false),
            Ok(RequestPhase::Guarding)
        );
        assert_eq!(
            lifecycle.accept_close_result("old"),
            Err("stale_lifecycle_response")
        );
        assert_eq!(
            lifecycle.state.lock().unwrap().pending.as_ref().unwrap().id,
            "new"
        );
    }

    #[test]
    fn navigation_cancels_only_a_guarding_request_before_the_new_document_can_close() {
        let lifecycle = with_request(FrontendState::Ready, RequestPhase::Guarding, "old");
        assert_eq!(lifecycle.page_start_transition().as_deref(), Some("old"));
        assert_eq!(
            lifecycle.state.lock().unwrap().frontend,
            FrontendState::Reloading
        );
        assert_eq!(
            lifecycle.begin_request("new", false),
            Err("frontend_reloading")
        );

        let draining = with_request(FrontendState::Ready, RequestPhase::Draining, "approved");
        assert_eq!(draining.page_start_transition(), None);
        assert!(draining.state.lock().unwrap().pending.is_some());
    }
}
