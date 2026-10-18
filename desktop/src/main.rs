mod connection;
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
    if !arguments.is_empty() && !check_backend && !smoke {
        return Err("unsupported_arguments");
    }
    let connection = Connection::load()?;
    connection.verify_backend()?;
    if check_backend {
        println!("GenzoRoom desktop: backend_verified");
        return Ok(());
    }
    let port = connection.port;
    let bootstrap = connection.bootstrap_url();
    tauri::Builder::default()
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
            #[cfg(feature = "webview-smoke")]
            smoke::start_timeout(app.handle());
            let mut config = app.config().app.windows[0].clone();
            config.url = WebviewUrl::External(bootstrap.clone());
            let handle = app.handle().clone();
            WebviewWindowBuilder::from_config(app, &config)?
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|_| "window_runtime_failed")
}

fn observe_page(window: tauri::WebviewWindow, payload: tauri::webview::PageLoadPayload<'_>) {
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
