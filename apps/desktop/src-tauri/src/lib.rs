use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

struct EngineProcess(Mutex<Option<Child>>);

// Skeleton engine resolution: env override, else the repo checkout this binary
// was compiled from. A packaged distribution must bundle the engine as a
// resource instead (docs/decisions/0001-tauri-node-sidecar.md).
fn engine_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PROMPTZONE_ENGINE_DIR") {
        return PathBuf::from(dir);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../engine");
    dev.canonicalize().unwrap_or(dev)
}

fn spawn_engine() -> std::io::Result<Child> {
    Command::new("node")
        .arg("src/index.ts")
        .current_dir(engine_dir())
        .env("PROMPTZONE_PARENT_PID", std::process::id().to_string())
        .spawn()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let child = match spawn_engine() {
                Ok(child) => {
                    println!("[promptzone] engine started (pid {})", child.id());
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
