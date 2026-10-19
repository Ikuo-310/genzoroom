//! Opt-in real-WebView test instrumentation, excluded from ordinary builds.
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{webview::PageLoadEvent, Manager};

static ROOT_RESULTS: AtomicU8 = AtomicU8::new(0);
static RESTART_PAGES: AtomicU8 = AtomicU8::new(0);

fn enabled() -> bool {
    std::env::args().any(|argument| {
        matches!(
            argument.as_str(),
            "--webview-smoke"
                | "--auto-smoke"
                | "--frontend-unready-smoke"
                | "--bootstrap-failure-smoke"
                | "--restart-smoke"
                | "--restart-failure-smoke"
                | "--backend-crash-smoke"
                | "--backend-crash-hold-smoke"
                | "--startup-recovery-smoke"
        )
    })
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
    if std::env::args().any(|value| value == "--bootstrap-failure-smoke")
        && window.label() == "main"
        && payload.event() == PageLoadEvent::Finished
        && payload.url().path() == "/__local/bootstrap"
    {
        let _ = window.eval(r#"(async()=>{
          while(!document.querySelector('#status')?.textContent.startsWith('Session unavailable'))await new Promise(r=>setTimeout(r,20));
          document.title='GenzoRoom-bootstrap-unready-ready';
        })()"#);
        return;
    }
    if std::env::args().any(|value| value == "--frontend-unready-smoke")
        && window.label() == "main"
        && payload.event() == PageLoadEvent::Finished
        && payload.url().path() == "/"
    {
        let _ = window.eval(r#"(async()=>{
          const ready=()=>document.querySelector('dialog[open][role="alertdialog"]');
          if(!ready()) await new Promise(resolve=>{
            const observer=new MutationObserver(()=>{if(document.querySelector('dialog[open][role="alertdialog"]')){observer.disconnect();resolve();}});
            observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true});
          });
          const dialog=document.querySelector('dialog[open][role="alertdialog"]');
          document.title='GenzoRoom-unready-ready:'+JSON.stringify({blocked:document.querySelector('#root')?.inert===true,
            errorVisible:!!dialog&&dialog.textContent.trim().length>0});
        })()"#);
        return;
    }
    if std::env::args().any(|value| value == "--startup-recovery-smoke")
        && window.label() == "main"
        && payload.event() == PageLoadEvent::Finished
        && payload.url().path() == "/"
    {
        let _ = window.eval("(async()=>{while(!document.querySelector('.settings-button'))await new Promise(r=>setTimeout(r,20));document.querySelector('.settings-button').click();await new Promise(r=>setTimeout(r,100));const data=await(await fetch('/__local/connection')).json();document.title='GenzoRoom-recovery:'+JSON.stringify({documentFresh:true,sessionCleared:true,recoveryReady:data.source==='recovery'&&data.error==='restart_failed'&&data.pendingRestart,settingsAvailable:!!document.querySelector('input[type=password]')})})()");
        return;
    }
    if std::env::args()
        .any(|value| value == "--backend-crash-smoke" || value == "--backend-crash-hold-smoke")
        && window.label() == "main"
        && payload.event() == PageLoadEvent::Finished
        && payload.url().path() == "/"
    {
        if std::env::args().any(|value| value == "--backend-crash-hold-smoke") {
            let _ = window.eval("window.__GENZOROOM_CRASH_HOLD_SMOKE__=true");
        }
        let _ = window.eval(r#"(async()=>{
          while(!document.querySelector('.settings-button'))await new Promise(r=>setTimeout(r,20));
          window.addEventListener('genzoroom:close-cancelled',async event=>{
            if(event.detail?.code!=='backend_exited_unexpectedly')return;
            await new Promise(r=>setTimeout(r,100));
            const dialog=document.querySelector('dialog[open]');
            const shown=!!dialog&&dialog.getAttribute('role')==='alertdialog';
            if(window.__GENZOROOM_CRASH_HOLD_SMOKE__){document.title='GenzoRoom-crash-held';return;}
            dialog?.querySelector('button')?.click();
            await new Promise(r=>setTimeout(r,50));
            document.title='GenzoRoom-crash:'+JSON.stringify({errorShown:shown,returned:!document.querySelector('dialog')});
          });
          document.title='GenzoRoom-crash-ready';
        })()"#);
        return;
    }
    if std::env::args().any(|argument| {
        matches!(
            argument.as_str(),
            "--restart-smoke" | "--restart-failure-smoke"
        )
    }) && window.label() == "main"
        && payload.event() == PageLoadEvent::Finished
        && payload.url().path() == "/"
    {
        if RESTART_PAGES.fetch_add(1, Ordering::SeqCst) == 0 {
            let _ = window.eval("(async()=>{while(!document.querySelector('#root')?.childElementCount)await new Promise(r=>setTimeout(r,20));sessionStorage.setItem('genzoroom-restart-smoke','old');window.__genzoroomOldConnection=true;document.title='GenzoRoom-restart-ready';})()");
        } else if std::env::args().any(|argument| argument == "--restart-failure-smoke") {
            let _ = window.eval("(async()=>{while(!document.querySelector('.settings-button'))await new Promise(r=>setTimeout(r,20));document.querySelector('.settings-button').click();await new Promise(r=>setTimeout(r,100));const data=await(await fetch('/__local/connection')).json();document.title='GenzoRoom-recovery:'+JSON.stringify({documentFresh:!window.__genzoroomOldConnection,sessionCleared:sessionStorage.getItem('genzoroom-restart-smoke')===null,recoveryReady:data.source==='recovery'&&data.error==='restart_failed'&&data.pendingRestart,settingsAvailable:!!document.querySelector('input[type=password]')})})()");
        } else {
            let _ = window.eval("document.title='GenzoRoom-restarted:'+JSON.stringify({documentFresh:!window.__genzoroomOldConnection,sessionCleared:sessionStorage.getItem('genzoroom-restart-smoke')===null})");
        }
        return;
    }
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
    if let Some(stage) = title.strip_prefix("GenzoRoom-download-failed:") {
        let stage = if matches!(stage, "init" | "full" | "jpeg" | "webgpu") {
            stage
        } else {
            "unknown"
        };
        eprintln!("GenzoRoom download smoke: failed stage={stage}");
        window.app_handle().exit(2);
        return;
    }
    if title == "GenzoRoom-crash-ready" {
        use std::io::Write;
        println!("GenzoRoom crash smoke: ready");
        let _ = std::io::stdout().flush();
        return;
    }
    if title == "GenzoRoom-crash-held" {
        use std::io::Write;
        println!("GenzoRoom crash smoke: held");
        let _ = std::io::stdout().flush();
        return;
    }
    if title == "GenzoRoom-bootstrap-unready-ready" {
        use std::io::Write;
        println!("GenzoRoom unready smoke: ready true");
        let _ = std::io::stdout().flush();
        let window = window.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            if std::io::stdin().read_line(&mut line).is_ok() && line.trim() == "close" {
                let _ = window.close();
            }
        });
        return;
    }
    if let Some(payload) = title.strip_prefix("GenzoRoom-unready-ready:") {
        use std::io::Write;
        let passed = serde_json::from_str::<serde_json::Value>(payload)
            .is_ok_and(|value| value["blocked"] == true && value["errorVisible"] == true);
        println!("GenzoRoom unready smoke: ready {passed}");
        let _ = std::io::stdout().flush();
        if !passed {
            window.app_handle().exit(2);
            return;
        }
        let window = window.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            if std::io::stdin().read_line(&mut line).is_ok() && line.trim() == "close" {
                let _ = window.close();
            }
        });
        return;
    }
    if let Some(payload) = title.strip_prefix("GenzoRoom-crash:") {
        let passed = serde_json::from_str::<serde_json::Value>(payload)
            .is_ok_and(|value| value["errorShown"] == true && value["returned"] == true);
        println!("GenzoRoom crash smoke: {{\"recoveredUi\":{passed}}}");
        window.app_handle().exit(if passed { 0 } else { 2 });
        return;
    }
    if let Some(payload) = title.strip_prefix("GenzoRoom-json:") {
        use sha2::{Digest, Sha256};
        let passed = (|| -> Option<bool> {
            let root = std::path::PathBuf::from(std::env::var_os("GENZOROOM_DOWNLOAD_SMOKE_DIR")?);
            let values: Vec<serde_json::Value> = serde_json::from_str(payload).ok()?;
            if values.len() != 3 {
                return Some(false);
            }
            for (value, prefix) in values.iter().zip([
                "genzoroom-diagnostics-",
                "genzoroom-jpeg-diagnostics-",
                "genzoroom-webgpu-diagnostics-",
            ]) {
                let name = value["name"].as_str()?;
                if !name.starts_with(prefix)
                    || !name.ends_with(".json")
                    || name.contains(['/', '\\'])
                {
                    return Some(false);
                }
                let bytes = std::fs::read(root.join(name)).ok()?;
                let digest = format!("{:x}", Sha256::digest(&bytes));
                let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
                if value["sha256"] != digest
                    || json["schemaVersion"] != 2
                    || !bytes.ends_with(b"\n")
                {
                    return Some(false);
                }
            }
            Some(true)
        })()
        .unwrap_or(false);
        println!("GenzoRoom JSON smoke: {{\"roundtrip\":{passed}}}");
        let _ = window.eval(format!("window.__genzoroomJsonPassed={passed}"));
        return;
    }
    if let Some(payload) = title.strip_prefix("GenzoRoom-json-outcome:") {
        let passed = serde_json::from_str::<serde_json::Value>(payload)
            .is_ok_and(|value| value["handled"] == true);
        println!("GenzoRoom JSON outcome smoke: {{\"handled\":{passed}}}");
        let _ = window.eval(format!("window.__genzoroomJsonPassed={passed}"));
        return;
    }
    if window.label() == "main" {
        if let Some(payload) = title.strip_prefix("GenzoRoom-recovery:") {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                let fields = [
                    "documentFresh",
                    "sessionCleared",
                    "recoveryReady",
                    "settingsAvailable",
                ];
                let result: serde_json::Map<String, serde_json::Value> = fields
                    .iter()
                    .map(|key| {
                        (
                            (*key).to_string(),
                            serde_json::Value::Bool(value[key] == true),
                        )
                    })
                    .collect();
                let passed = fields.iter().all(|key| value[key] == true);
                println!(
                    "GenzoRoom recovery smoke: {}",
                    serde_json::Value::Object(result)
                );
                window.app_handle().exit(if passed { 0 } else { 2 });
            }
            return;
        }
    }
    if window.label() == "main" && title == "GenzoRoom-restart-ready" {
        std::thread::spawn(move || {
            use std::io::Write;
            println!("GenzoRoom restart smoke: ready");
            let _ = std::io::stdout().flush();
            let mut line = String::new();
            let _ = std::io::stdin().read_line(&mut line);
            let _ = window.eval("window.__GENZOROOM_DESKTOP__.respond({kind:'restart'})");
        });
        return;
    }
    if window.label() == "main" {
        if let Some(payload) = title.strip_prefix("GenzoRoom-restarted:") {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                let fresh = value["documentFresh"] == true;
                let cleared = value["sessionCleared"] == true;
                println!("GenzoRoom restart smoke: {{\"documentFresh\":{fresh},\"sessionCleared\":{cleared}}}");
                if fresh && cleared {
                    let _ = window.eval(include_str!("webview-smoke.js"));
                } else {
                    window.app_handle().exit(2);
                }
            }
            return;
        }
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
