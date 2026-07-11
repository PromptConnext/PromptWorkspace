use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct EngineProcess(Mutex<Option<Child>>);

// Per-session auth token (ADR 0008): 32 hex chars from the OS CSPRNG, minted
// once per launch. Shared with the engine (env) and the webview (injected
// global) so every request can be authenticated. Falls back to a pid/addr-based
// value only if /dev/urandom is unreadable (macOS/Linux always have it).
fn mint_token() -> String {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    format!("pz{}{:p}", std::process::id(), &buf)
}

// Engine resolution (ADR 0001): explicit override, else the copy bundled into
// the app's resource dir (packaged), else the repo checkout this binary was
// compiled from (dev / `cargo build`).
fn engine_dir<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> PathBuf {
    if let Ok(dir) = std::env::var("PROMPTZONE_ENGINE_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(res) = handle.path().resource_dir() {
        let bundled = res.join("engine");
        if bundled.join("src").join("index.ts").exists() {
            return bundled;
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../engine");
    dev.canonicalize().unwrap_or(dev)
}

fn spawn_engine(token: &str, dir: &Path) -> std::io::Result<Child> {
    // Prefer the Node runtime bundled next to the engine (packaged app, ADR
    // 0001); fall back to `node` on PATH in dev.
    let bundled_node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node = if bundled_node.exists() {
        bundled_node.into_os_string()
    } else {
        std::ffi::OsString::from("node")
    };
    Command::new(node)
        .arg("src/index.ts")
        .current_dir(dir)
        .env("PROMPTZONE_PARENT_PID", std::process::id().to_string())
        .env("PROMPTZONE_AUTH_TOKEN", token)
        .spawn()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token = mint_token();
    tauri::Builder::default()
        .setup(move |app| {
            let dir = engine_dir(app.handle());
            let child = match spawn_engine(&token, &dir) {
                Ok(child) => {
                    println!(
                        "[promptzone] engine started (pid {}) from {}",
                        child.id(),
                        dir.display()
                    );
                    Some(child)
                }
                Err(err) => {
                    // The UI polls /engine/health and surfaces "unreachable";
                    // never block the shell on a failed sidecar.
                    eprintln!("[promptzone] failed to start engine: {err}");
                    None
                }
            };
            app.manage(EngineProcess(Mutex::new(child)));

            // Build the main window in Rust so we can inject the session token
            // before any app script runs (ADR 0008). Window chrome mirrors what
            // tauri.conf.json used to declare.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("PromptZone")
                .inner_size(1280.0, 840.0)
                .initialization_script(&format!("window.__PROMPTZONE_TOKEN__ = \"{token}\";"))
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<EngineProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
