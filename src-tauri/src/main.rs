// hurricaneTerm — Tauri 2 backend: local PTY sessions + fs/state services.
// Original implementation (Apache-2.0, see LICENSE). UI structure mirrors WindTerm's layout
// (dock panes / menu / statusbar / triggers), code is our own.
#![allow(unused)]

mod re;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

type BoxedWriter = Box<dyn Write + Send>;
type BoxedResize = Box<dyn Fn(u16, u16) -> Result<(), String> + Send>;
type BoxedChild = Box<dyn Child + Send + Sync>;

struct Entry {
    writer: BoxedWriter,
    resize: BoxedResize,
    child: Option<Arc<Mutex<BoxedChild>>>,
    closer: Option<Box<dyn Fn() + Send>>,
}

#[derive(Default)]
struct PtyState(Mutex<HashMap<String, Entry>>);

#[derive(Clone, Serialize)]
struct OutPayload {
    id: String,
    data: String,
}
#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub folder: String,
}

#[derive(Clone, Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub is_link: bool,
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

#[tauri::command]
fn spawn(
    app: AppHandle,
    state: State<PtyState>,
    rows: u16,
    cols: u16,
    command: Option<String>,
    args: Option<Vec<String>>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cb = CommandBuilder::new(command.filter(|c| !c.is_empty()).unwrap_or_else(default_shell));
    for a in args.unwrap_or_default() {
        cb.arg(a);
    }
    cb.env("TERM", "xterm-256color");
    cb.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cb).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = Arc::new(Mutex::new(pair.master));
    let m = Arc::clone(&master);
    let resize: BoxedResize = Box::new(move |r, c| {
        m.lock()
            .map_err(|_| "poisoned".to_string())?
            .resize(PtySize {
                rows: r,
                cols: c,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    });

    let id = Uuid::new_v4().to_string();

    {
        let id2 = id.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = app2.emit("pty-exit", ExitPayload { id: id2.clone() });
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app2.emit("pty-output", OutPayload { id: id2.clone(), data });
                    }
                }
            }
        });
    }

    let child = Arc::new(Mutex::new(child));
    {
        let c = Arc::clone(&child);
        let id3 = id.clone();
        let app3 = app.clone();
        std::thread::spawn(move || {
            let _ = c.lock().unwrap().wait();
            let _ = app3.emit("pty-exit", ExitPayload { id: id3 });
        });
    }

    state
        .0
        .lock()
        .unwrap()
        .insert(
            id.clone(),
            Entry {
                writer: Box::new(writer),
                resize,
                child: Some(child),
                closer: None,
            },
        );
    Ok(id)
}

/// Telnet 会话：协商引擎语义重写自 WindTerm TelnetCommander（见 re/telnet.rs 证据注释）
#[tauri::command]
fn connect_telnet(
    app: AppHandle,
    state: State<PtyState>,
    host: String,
    port: u16,
) -> Result<String, String> {
    use std::io::Write as _;
    use std::net::TcpStream;
    let stream = TcpStream::connect((host.as_str(), port))
        .map_err(|e| format!("连接失败 {host}:{port}: {e}"))?;
    let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
    let mut resp_writer = stream.try_clone().map_err(|e| e.to_string())?;
    let killer = stream.try_clone().map_err(|e| e.to_string())?;
    let writer = stream;

    let id = Uuid::new_v4().to_string();
    let mut nego = re::telnet::Negotiator::client_default();

    // initOptions 等价：对带 0x10 标志的选项发 WILL/DO
    let init = nego.initial_requests();
    let _ = resp_writer.write_all(&init);

    {
        let id2 = id.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = app2.emit("pty-exit", ExitPayload { id: id2.clone() });
                        break;
                    }
                    Ok(n) => {
                        let o = nego.on_data(&buf[..n]);
                        if !o.responses.is_empty() && resp_writer.write_all(&o.responses).is_err() {
                            break;
                        }
                        for l in &o.log {
                            let _ = app2.emit(
                                "re-log",
                                OutPayload { id: id2.clone(), data: l.clone() },
                            );
                        }
                        if !o.data.is_empty() {
                            let data = String::from_utf8_lossy(&o.data).to_string();
                            let _ = app2.emit(
                                "pty-output",
                                OutPayload { id: id2.clone(), data },
                            );
                        }
                    }
                }
            }
        });
    }

    state.0.lock().unwrap().insert(
        id.clone(),
        Entry {
            writer: Box::new(writer),
            resize: Box::new(|_r, _c| Ok(())),
            child: None,
            closer: Some(Box::new(move || {
                let _ = killer.shutdown(std::net::Shutdown::Both);
            })),
        },
    );
    Ok(id)
}

#[tauri::command]
fn write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let e = map.get_mut(&id).ok_or("no such pty")?;
    e.writer.write_all(data.as_bytes()).map_err(|x| x.to_string())?;
    e.writer.flush().map_err(|x| x.to_string())
}
#[tauri::command]
fn resize(state: State<PtyState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let e = map.get(&id).ok_or("no such pty")?;
    (e.resize)(rows, cols)
}

#[tauri::command]
fn kill(state: State<PtyState>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(e) = map.remove(&id) {
        if let Some(c) = &e.child {
            let _ = c.lock().unwrap().kill();
        }
        if let Some(cl) = &e.closer {
            cl();
        }
    }
    Ok(())
}

#[tauri::command]
fn sessions_load(app: AppHandle) -> Vec<Session> {
    cfg_path(&app, "sessions.json")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn sessions_save(app: AppHandle, sessions: Vec<Session>) -> Result<(), String> {
    let p = cfg_path(&app, "sessions.json")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_string_pretty(&sessions).unwrap()).map_err(|e| e.to_string())
}

/// Generic UI state blob (theme, font size, triggers, layout) — frontend owns the schema.
#[tauri::command]
fn ui_state_save(app: AppHandle, name: String, value: String) -> Result<(), String> {
    let p = cfg_path(&app, &format!("ui-{}.json", sanitize(&name)))?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, value).map_err(|e| e.to_string())
}

#[tauri::command]
fn ui_state_load(app: AppHandle, name: String) -> Option<String> {
    cfg_path(&app, &format!("ui-{}.json", sanitize(&name)))
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
}

#[tauri::command]
fn fs_list(path: Option<String>) -> Result<Vec<FsEntry>, String> {
    let dir = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into())),
    };
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(FsEntry {
            path: e.path().to_string_lossy().to_string(),
            is_dir: md.is_dir(),
            size: if md.is_file() { md.len() } else { 0 },
            modified,
            is_link: e.path().is_symlink(),
            name,
        });
    }
    out.sort_by(|a, b| (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase())));
    Ok(out)
}

fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn cfg_path(app: &AppHandle, file: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(file))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            spawn,
            write,
            resize,
            kill,
            connect_telnet,
            sessions_load,
            sessions_save,
            ui_state_save,
            ui_state_load,
            fs_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running hurricaneTerm");
}

fn main() {
    run();
}