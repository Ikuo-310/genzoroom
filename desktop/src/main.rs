mod backend_process;
mod connection;
mod lifecycle;
#[cfg(feature = "webview-smoke")]
mod smoke;

use connection::{allowed_navigation, user_root, Connection};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    webview::NewWindowResponse,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

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
        let result = WebviewWindowBuilder::new(&app, "diagnostics", WebviewUrl::External(url))
            .title("GenzoRoom Developer Diagnostics")
            .inner_size(1280.0, 850.0)
            .data_directory(root.join("webview2"))
            .disable_drag_drop_handler()
            .devtools(true)
            .on_navigation(move |url| allowed_navigation(url, port))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_page_load(observe_page)
            .on_document_title_changed(observe_title)
            .build();
        if result.is_err() {
            eprintln!("GenzoRoom desktop: diagnostics_window_failed");
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
    let process_smoke = cfg!(feature = "webview-smoke") && arguments == ["--process-smoke"];
    let restart_smoke = cfg!(feature = "webview-smoke")
        && (arguments == ["--restart-smoke"] || arguments == ["--restart-failure-smoke"]);
    let environment = arguments == ["--environment-backend"];
    let manual = arguments == ["--manual-backend"] || check_backend || smoke;
    if !arguments.is_empty()
        && !manual
        && !auto_smoke
        && !process_smoke
        && !environment
        && !restart_smoke
    {
        return Err("unsupported_arguments");
    }
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
            backend_process::BackendProcess::start()?
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
    let bootstrap = connection.bootstrap_url();
    let state = lifecycle::Lifecycle::new(owner);
    let exit_state = state.clone();
    let application = tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![lifecycle::desktop_lifecycle])
        .menu(|app| {
            let fullscreen =
                MenuItem::with_id(app, "fullscreen", "Full screen", true, None::<&str>)?;
            let diagnostics = MenuItem::with_id(
                app,
                "diagnostics",
                "Developer Diagnostics",
                true,
                None::<&str>,
            )?;
            let window = Submenu::with_items(app, "Window", true, &[&fullscreen, &diagnostics])?;
            Menu::with_items(app, &[&window])
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "diagnostics" => open_diagnostics(app, port),
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
            config.url = WebviewUrl::External(bootstrap.clone());
            let handle = app.handle().clone();
            WebviewWindowBuilder::from_config(app, &config)?
                .initialization_script(lifecycle::BRIDGE)
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
                exit_state.request_close(app);
            }
        }
    });
    Ok(())
}

fn observe_page(window: tauri::WebviewWindow, payload: tauri::webview::PageLoadPayload<'_>) {
    if window.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
        // A reloaded document must register its own save guard before accepting Close.
        window
            .state::<std::sync::Arc<lifecycle::Lifecycle>>()
            .frontend_ready
            .store(false, std::sync::atomic::Ordering::SeqCst);
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
        std::process::exit(1);
    }
}
