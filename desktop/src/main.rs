#![cfg_attr(
    all(feature = "bundled-backend", not(debug_assertions)),
    windows_subsystem = "windows"
)]

mod backend_launch;
mod backend_process;
mod connection;
mod host_diagnostics;
mod lifecycle;
mod report_download;
mod single_instance;
#[cfg(feature = "webview-smoke")]
mod smoke;
#[cfg(windows)]
mod titlebar;

use connection::{allowed_navigation, user_root, Connection};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::NewWindowResponse,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

const MENU_SHORTCUT_BRIDGE: &str = r#"window.addEventListener('keydown', event => {
  if (event.key.toLowerCase() !== 'p' || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.isComposing) window.dispatchEvent(new Event('genzoroom:open-settings'));
}, true);"#;

fn open_diagnostics(app: &tauri::AppHandle, port: u16) {
    if let Some(window) = app.get_webview_window("diagnostics") {
        let _ = window.set_focus();
        return;
    }
    // WebView2 window creation in a synchronous event callback can deadlock.
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(root) = user_root() else { return };
        let url = format!("http://127.0.0.1:{port}/developer")
            .parse()
            .unwrap();
        let downloads = report_download::Downloads::default();
        let result = WebviewWindowBuilder::new(&app, "diagnostics", WebviewUrl::External(url))
            .title("GenzoRoom Developer Diagnostics")
            .inner_size(1280.0, 850.0)
            .data_directory(root.join("webview2"))
            .disable_drag_drop_handler()
            .devtools(true)
            .initialization_script(report_download::bridge())
            .on_download(move |webview, event| downloads.handle(webview, event, port))
            .on_permission_request(move |webview, kind| {
                report_download::permission(webview, kind, port)
            })
            .on_navigation(move |url| allowed_navigation(url, port))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_page_load(observe_page)
            .on_document_title_changed(observe_title)
            .build();
        match result {
            Ok(window) => {
                #[cfg(windows)]
                titlebar::apply_dark_theme(&window);
            }
            Err(_) => eprintln!("GenzoRoom desktop: diagnostics_window_failed"),
        }
    });
}

fn run() -> Result<(), &'static str> {
    if !cfg!(windows) {
        return Err("windows_required");
    }
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let check_backend = arguments == ["--check-backend"];
    let smoke = cfg!(feature = "webview-smoke") && arguments == ["--webview-smoke"];
    let auto_smoke = cfg!(feature = "webview-smoke") && arguments == ["--auto-smoke"];
    let unready_smoke =
        cfg!(feature = "webview-smoke") && arguments == ["--frontend-unready-smoke"];
    let bootstrap_failure_smoke =
        cfg!(feature = "webview-smoke") && arguments == ["--bootstrap-failure-smoke"];
    let process_smoke = cfg!(feature = "webview-smoke") && arguments == ["--process-smoke"];
    let crash_smoke = cfg!(feature = "webview-smoke")
        && matches!(arguments.as_slice(), [mode] if mode == "--backend-crash-smoke" || mode == "--backend-crash-hold-smoke");
    let recovery_smoke =
        cfg!(feature = "webview-smoke") && arguments == ["--startup-recovery-smoke"];
    #[cfg(feature = "webview-smoke")]
    if arguments == ["--startup-timeout-smoke"] {
        backend_process::BackendProcess::startup_timeout_smoke()?;
        return Err("smoke_timeout_missing");
    }
    let restart_smoke = cfg!(feature = "webview-smoke")
        && (arguments == ["--restart-smoke"] || arguments == ["--restart-failure-smoke"]);
    let environment = arguments == ["--environment-backend"];
    let manual = arguments == ["--manual-backend"] || check_backend || smoke;
    if !arguments.is_empty()
        && !manual
        && !auto_smoke
        && !unready_smoke
        && !bootstrap_failure_smoke
        && !process_smoke
        && !environment
        && !restart_smoke
        && !crash_smoke
        && !recovery_smoke
    {
        return Err("unsupported_arguments");
    }
    let _instance_lock = if check_backend || process_smoke {
        None
    } else {
        Some(single_instance::acquire()?)
    };
    let (owner, connection) = if manual {
        let connection = Connection::load()?;
        if connection.launch_id.is_some() {
            return Err("backend_is_managed_by_another_host");
        }
        connection.verify_backend()?;
        (None, connection)
    } else {
        let (owner, connection) = if environment || auto_smoke {
            backend_process::BackendProcess::start_mode(true, false)?
        } else {
            backend_process::BackendProcess::start().or_else(|code| {
                // The selected profile may be inaccessible; recover without opening or replacing it.
                // Conflict and timeout retain their explicit startup errors, never adopting a listener.
                if code == "backend_startup_failed" {
                    backend_process::BackendProcess::start_mode(false, true)
                } else {
                    Err(code)
                }
            })?
        };
        (Some(owner), connection)
    };
    if check_backend {
        println!("GenzoRoom desktop: backend_verified");
        return Ok(());
    }
    #[cfg(feature = "webview-smoke")]
    if process_smoke {
        return owner.unwrap().process_smoke();
    }
    let port = connection.port;
    let mut bootstrap = connection.bootstrap_url();
    if bootstrap_failure_smoke {
        bootstrap.set_fragment(Some("invalid-isolated-smoke-token"));
    }
    let state = lifecycle::Lifecycle::new(owner);
    let exit_state = state.clone();
    let application = tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            lifecycle::desktop_lifecycle,
            set_native_menu_language
        ])
        .menu(|app| {
            let preferences =
                MenuItem::with_id(app, "preferences", "Preferences", true, Some("Ctrl+P"))?;
            let file_separator = PredefinedMenuItem::separator(app)?;
            let exit = MenuItem::with_id(app, "exit", "Exit", true, Some("Ctrl+Q"))?;
            let file = Submenu::with_id_and_items(
                app,
                "file",
                "File",
                true,
                &[&preferences, &file_separator, &exit],
            )?;
            let fullscreen =
                MenuItem::with_id(app, "fullscreen", "Full screen", true, None::<&str>)?;
            let diagnostics = MenuItem::with_id(
                app,
                "diagnostics",
                "Developer Diagnostics",
                true,
                None::<&str>,
            )?;
            let view = Submenu::with_id_and_items(app, "view", "View", true, &[&fullscreen])?;
            let help_separator = PredefinedMenuItem::separator(app)?;
            let about = MenuItem::with_id(app, "about", "About GenzoRoom", true, None::<&str>)?;
            let help = Submenu::with_id_and_items(
                app,
                "help",
                "Help",
                true,
                &[&diagnostics, &help_separator, &about],
            )?;
            Menu::with_items(app, &[&file, &view, &help])
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "diagnostics" => open_diagnostics(app, port),
            "preferences" => dispatch_main_event(app, "genzoroom:open-settings"),
            "about" => dispatch_main_event(app, "genzoroom:show-about"),
            "exit" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            "fullscreen" => {
                if let Some(window) = app
                    .webview_windows()
                    .values()
                    .find(|window| window.is_focused().unwrap_or(false))
                {
                    let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
                }
            }
            _ => {}
        })
        .setup(move |app| {
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("desktop-lifecycle")
                    .local(false)
                    .window("main")
                    .remote(format!("http://127.0.0.1:{port}/*"))
                    .permission("allow-desktop-lifecycle"),
            )?;
            #[cfg(feature = "webview-smoke")]
            smoke::start_timeout(app.handle());
            let mut config = app.config().app.windows[0].clone();
            if cfg!(feature = "bundled-backend") {
                config.title = "GenzoRoom".into();
            }
            config.url = WebviewUrl::External(bootstrap.clone());
            let handle = app.handle().clone();
            let downloads = report_download::Downloads::default();
            let main_window = WebviewWindowBuilder::from_config(app, &config)?
                .initialization_script(lifecycle::bridge(unready_smoke))
                .initialization_script(MENU_SHORTCUT_BRIDGE)
                .initialization_script(report_download::bridge())
                .on_download(move |webview, event| downloads.handle(webview, event, port))
                .on_permission_request(move |webview, kind| {
                    report_download::permission(webview, kind, port)
                })
                .data_directory(user_root().map_err(std::io::Error::other)?.join("webview2"))
                .on_navigation(move |url| allowed_navigation(url, port))
                .on_new_window(move |url, _| {
                    if allowed_navigation(&url, port)
                        && url.path() == "/developer"
                        && url.query().is_none()
                        && url.fragment().is_none()
                    {
                        open_diagnostics(&handle, port);
                    }
                    NewWindowResponse::Deny
                })
                .on_page_load(observe_page)
                .on_document_title_changed(observe_title)
                .build()?;
            #[cfg(windows)]
            titlebar::apply_dark_theme(&main_window);
            state.monitor(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = window.state::<std::sync::Arc<lifecycle::Lifecycle>>();
                    if !state.approved.load(std::sync::atomic::Ordering::SeqCst) {
                        api.prevent_close();
                        state.request_close(window.app_handle());
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .map_err(|_| "window_runtime_failed")?;
    application.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if !exit_state
                .approved
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_exit();
                if let Some(code) = code {
                    exit_state
                        .exit_code
                        .store(code, std::sync::atomic::Ordering::SeqCst);
                }
                exit_state.request_exit(app);
            }
        }
    });
    Ok(())
}

fn dispatch_main_event(app: &tauri::AppHandle, event_name: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let script = format!("window.dispatchEvent(new Event('{event_name}'))");
        let _ = window.eval(&script);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeMenuLabels {
    file: &'static str,
    preferences: &'static str,
    exit: &'static str,
    view: &'static str,
    fullscreen: &'static str,
    help: &'static str,
    diagnostics: &'static str,
    about: &'static str,
}

fn native_menu_labels(language: &str) -> Result<NativeMenuLabels, &'static str> {
    match language {
        "ja" => Ok(NativeMenuLabels {
            file: "ファイル",
            preferences: "環境設定",
            exit: "終了",
            view: "表示",
            fullscreen: "全画面表示",
            help: "ヘルプ",
            diagnostics: "開発者ページ",
            about: "GenzoRoomについて",
        }),
        "en" => Ok(NativeMenuLabels {
            file: "File",
            preferences: "Preferences",
            exit: "Exit",
            view: "View",
            fullscreen: "Full Screen",
            help: "Help",
            diagnostics: "Developer Diagnostics",
            about: "About GenzoRoom",
        }),
        _ => Err("unsupported_language"),
    }
}

fn set_menu_item_text(
    submenu: &Submenu<tauri::Wry>,
    item_id: &str,
    text: &str,
) -> Result<(), &'static str> {
    let item = submenu
        .get(item_id)
        .and_then(|kind| kind.as_menuitem().cloned())
        .ok_or("native_menu_item_missing")?;
    item.set_text(text).map_err(|_| "native_menu_update_failed")
}

#[tauri::command]
fn set_native_menu_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    let labels = native_menu_labels(&language).map_err(str::to_owned)?;
    let menu = app
        .menu()
        .ok_or_else(|| "native_menu_unavailable".to_owned())?;
    for (submenu_id, title) in [
        ("file", labels.file),
        ("view", labels.view),
        ("help", labels.help),
    ] {
        let submenu = menu
            .get(submenu_id)
            .and_then(|kind| kind.as_submenu().cloned())
            .ok_or_else(|| "native_menu_submenu_missing".to_owned())?;
        submenu
            .set_text(title)
            .map_err(|_| "native_menu_update_failed".to_owned())?;
        let item_labels: &[(&str, &str)] = match submenu_id {
            "file" => &[("preferences", labels.preferences), ("exit", labels.exit)],
            "view" => &[("fullscreen", labels.fullscreen)],
            _ => &[("diagnostics", labels.diagnostics), ("about", labels.about)],
        };
        for (item_id, item_text) in item_labels {
            set_menu_item_text(&submenu, item_id, item_text).map_err(str::to_owned)?;
        }
    }
    Ok(())
}

fn observe_page(window: tauri::WebviewWindow, payload: tauri::webview::PageLoadPayload<'_>) {
    if window.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
        // A reloaded document must register its own save guard before accepting Close.
        window
            .state::<std::sync::Arc<lifecycle::Lifecycle>>()
            .page_started(window.app_handle());
    }
    #[cfg(feature = "webview-smoke")]
    smoke::page_loaded(window, payload);
    #[cfg(not(feature = "webview-smoke"))]
    let _ = (window, payload);
}

fn observe_title(window: tauri::WebviewWindow, title: String) {
    #[cfg(feature = "webview-smoke")]
    smoke::title_changed(window, title);
    #[cfg(not(feature = "webview-smoke"))]
    let _ = (window, title);
}

fn main() {
    if let Err(code) = run() {
        // Tauri/HTTP errors may include a bootstrap URL; expose only fixed error codes.
        eprintln!("GenzoRoom desktop failed: {code}");
        host_diagnostics::startup_failed(code);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod native_menu_tests {
    use super::{native_menu_labels, NativeMenuLabels};

    #[test]
    fn native_menu_labels_follow_supported_app_languages() {
        assert_eq!(
            native_menu_labels("ja"),
            Ok(NativeMenuLabels {
                file: "ファイル",
                preferences: "環境設定",
                exit: "終了",
                view: "表示",
                fullscreen: "全画面表示",
                help: "ヘルプ",
                diagnostics: "開発者ページ",
                about: "GenzoRoomについて",
            })
        );
        assert_eq!(
            native_menu_labels("en"),
            Ok(NativeMenuLabels {
                file: "File",
                preferences: "Preferences",
                exit: "Exit",
                view: "View",
                fullscreen: "Full Screen",
                help: "Help",
                diagnostics: "Developer Diagnostics",
                about: "About GenzoRoom",
            })
        );
        assert_eq!(native_menu_labels("fr"), Err("unsupported_language"));
    }
}
