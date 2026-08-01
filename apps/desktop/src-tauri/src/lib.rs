use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

// `Manager` is only needed for the release-only resource_dir() lookup in
// engine_dir(); a debug build resolves the engine from the repo checkout.
#[cfg_attr(debug_assertions, allow(unused_imports))]
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

// How many trailing lines of engine stdout/stderr to keep around for the
// crash-retry UI (WP7c). Interleaved from both streams, oldest dropped first.
const ENGINE_LOG_CAPACITY: usize = 200;

type EngineLog = Arc<Mutex<VecDeque<String>>>;

struct EngineProcess {
    child: Mutex<Option<Child>>,
    log: EngineLog,
    token: String,
    dir: PathBuf,
}

// Spawn a background thread that copies each line from `reader` into the
// shared ring buffer, trimming the oldest entries once it's over capacity.
fn pump_into_log<R: std::io::Read + Send + 'static>(reader: R, log: EngineLog) {
    std::thread::spawn(move || {
        let mut lines = BufReader::new(reader).lines();
        while let Some(Ok(line)) = lines.next() {
            let mut buf = log.lock().unwrap();
            buf.push_back(line);
            while buf.len() > ENGINE_LOG_CAPACITY {
                buf.pop_front();
            }
        }
    });
}

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
#[cfg_attr(debug_assertions, allow(unused_variables))]
fn engine_dir<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> PathBuf {
    if let Ok(dir) = std::env::var("PROMPTCONNEXT_ENGINE_DIR") {
        return PathBuf::from(dir);
    }
    // Release builds only. Under `tauri dev` the resource dir is target/debug/,
    // where the `.engine-pkg` copy left behind by any earlier `tauri build`
    // lingers — preferring it there silently ran weeks-old engine code against
    // a current webview, so a route added since the last package 404s.
    #[cfg(not(debug_assertions))]
    if let Ok(res) = handle.path().resource_dir() {
        let bundled = res.join("engine");
        if bundled.join("src").join("index.ts").exists() {
            return bundled;
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../engine");
    dev.canonicalize().unwrap_or(dev)
}

// Spawns the engine with stdout/stderr piped and starts the background
// threads that copy their output into `log` (WP7c: crash-retry log tail).
fn spawn_engine(token: &str, dir: &Path, log: &EngineLog) -> std::io::Result<Child> {
    // Prefer the Node runtime bundled next to the engine (packaged app, ADR
    // 0001); fall back to `node` on PATH in dev.
    let bundled_node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node = if bundled_node.exists() {
        bundled_node.into_os_string()
    } else {
        std::ffi::OsString::from("node")
    };
    let mut child = Command::new(node)
        .arg("src/index.ts")
        .current_dir(dir)
        .env("PROMPTCONNEXT_PARENT_PID", std::process::id().to_string())
        .env("PROMPTCONNEXT_AUTH_TOKEN", token)
        // Names the scheme this shell registered so the sign-in page bounces
        // the ADR 0014 callback back here. Must match register() below and
        // tauri.conf.json's deep-link config.
        .env("PROMPTCONNEXT_DEEP_LINK_SCHEME", "promptconnext")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(stdout) = child.stdout.take() {
        pump_into_log(stdout, log.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        pump_into_log(stderr, log.clone());
    }

    Ok(child)
}

// Returns the last-N captured lines of engine stdout/stderr, oldest first.
// Backs the crash-retry UI's collapsible log view (WP7c).
#[tauri::command]
fn engine_log_tail(state: State<EngineProcess>) -> Vec<String> {
    state.log.lock().unwrap().iter().cloned().collect()
}

// Kills the currently-managed engine child (if any) and spawns a fresh one in
// its place, updating the managed state. Used by the desktop UI's "Retry"
// action when the engine has crashed (WP7c) — the health poll in App.tsx
// picks up recovery on its next tick.
#[tauri::command]
fn restart_engine(state: State<EngineProcess>) -> Result<(), String> {
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let child = spawn_engine(&state.token, &state.dir, &state.log).map_err(|e| e.to_string())?;
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token = mint_token();
    let builder = tauri::Builder::default()
        // Registration order matters: tauri-plugin-single-instance must be
        // added first so its second-instance callback can forward the
        // OS-provided deep-link argv into the deep-link plugin's state
        // (Windows/Linux single-instance re-launch path).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A promptconnext:// open (or a plain second launch) hit an
            // already-running instance; bring the existing window forward.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        // Auto-update (in-app download + install) and process control for the
        // post-install relaunch. Desktop-only plugins; the webview drives the
        // check/skip/remind UX and calls downloadAndInstall() + relaunch().
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![engine_log_tail, restart_engine])
        .setup(move |app| {
            let dir = engine_dir(app.handle());
            let log: EngineLog = Arc::new(Mutex::new(VecDeque::new()));
            let child = match spawn_engine(&token, &dir, &log) {
                Ok(child) => {
                    println!(
                        "[promptconnext] engine started (pid {}) from {}",
                        child.id(),
                        dir.display()
                    );
                    Some(child)
                }
                Err(err) => {
                    // The UI polls /engine/health and surfaces "unreachable";
                    // never block the shell on a failed sidecar.
                    eprintln!("[promptconnext] failed to start engine: {err}");
                    None
                }
            };
            app.manage(EngineProcess {
                child: Mutex::new(child),
                log,
                token: token.clone(),
                dir,
            });

            // Build the main window in Rust so we can inject the session token
            // before any app script runs (ADR 0008). Window chrome mirrors what
            // tauri.conf.json used to declare.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("PromptConnext")
                .inner_size(1280.0, 840.0)
                .initialization_script(&format!("window.__PROMPTCONNEXT_TOKEN__ = \"{token}\";"))
                .build()?;

            // Release Windows builds register the scheme from the
            // `plugins.deep-link.desktop.schemes` config at bundle time
            // (installer registry keys), and Linux packaging (e.g. an
            // AppImage launched without a proper installer) may skip its
            // equivalent step too — so register at runtime as a fallback in
            // both cases, which also covers `tauri dev` on those two
            // platforms (it never produces a bundle at all).
            //
            // macOS has no runtime equivalent: tauri-plugin-deep-link's
            // register() unconditionally returns Error::UnsupportedPlatform
            // there (Launch Services only reads CFBundleURLTypes from a
            // bundle's Info.plist — there's no dynamic registration API for
            // an unbundled process). So on `tauri dev` for macOS, the
            // `promptconnext://` redirect after browser sign-in has no
            // registered handler and silently goes nowhere; that's why
            // TopBar's sign-in flow also has a "paste the code manually"
            // fallback — it's not just a dev convenience, it's the only way
            // ADR 0014 completes on an unbundled macOS build. Still call
            // register() here on macOS too (cheap, harmlessly logged) in
            // case a future plugin version adds support.
            #[cfg(any(target_os = "linux", target_os = "macos", debug_assertions))]
            {
                if let Err(err) = app.deep_link().register("promptconnext") {
                    eprintln!("[promptconnext] failed to register promptconnext:// scheme: {err}");
                }
            }

            // Forward every promptconnext:// callback to the webview, which
            // parses ?code & ?state and calls the engine redeem route. Only
            // an opaque one-time code rides this URL (ADR 0014). On macOS
            // this fires directly from the OS `open` event; on Windows/Linux
            // it's relayed via the single-instance plugin's argv (registered
            // above), plus the initial-launch argv handled by the deep-link
            // plugin's own setup.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = handle.emit("auth-callback", serde_json::json!({ "url": url.to_string() }));
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<EngineProcess>() {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
