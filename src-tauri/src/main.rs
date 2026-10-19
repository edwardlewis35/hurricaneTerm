// hurricaneTerm — Tauri 2 backend: local PTY sessions + fs/state services.
// Application implementation is Apache-2.0 (see LICENSE). The vendored ZMODEM
// state machine retains its upstream MIT/Apache-2.0 licenses and patch notice.
#![allow(unused)]

mod re;
mod jump;
mod files;
mod pty_child;
mod terminal_io;
mod modem_transport;
mod modem_live;
mod ssh_live;
mod ssh_relay;
#[cfg(unix)]
mod serial_live;
mod tcp_live;
mod gist_sync;
mod ai;
mod harness_log;
mod agent_exec;
mod connection_error;
mod credentials;
mod mac_text_input;
mod memory;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

type BoxedWriter = Box<dyn Write + Send>;
type SessionWriter = Arc<tokio::sync::Mutex<BoxedWriter>>;
type BoxedResize = Box<dyn Fn(u16, u16) -> Result<(), String> + Send>;

struct Entry {
    gate: Arc<modem_transport::SessionGate>,
    writer: SessionWriter,
    resize: BoxedResize,
    killer: Option<pty_child::Killer>,
    closer: Option<Box<dyn Fn() + Send>>,
    sftp: Option<tokio::sync::mpsc::UnboundedSender<ssh_live::SftpReq>>,
    exec: agent_exec::Target,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
struct PtyState(Mutex<HashMap<String, Entry>>);

#[derive(Default)]
struct TransferState(Mutex<HashMap<String, Arc<ssh_live::TransferControl>>>);
#[derive(Default)]
struct ModemPending(Mutex<std::collections::HashSet<(String,String)>>);

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
#[serde(rename_all = "camelCase")]
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
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub password: String,
    // —— 串口/TCP（live 模块；字段名沿用 session.target/serial.*）——
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub baud_rate: i32,
    #[serde(default)]
    pub data_bits: i32,
    #[serde(default)]
    pub parity: String,
    #[serde(default)]
    pub stop_bits: i32,
    #[serde(default)]
    pub flow_control: String,
    #[serde(default)]
    pub proxy_type: String,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_user: String,
    #[serde(default)]
    pub proxy_password: String,
    #[serde(default)]
    pub proxy_command: String,
    // —— Tabby 风格 Profile 扩展（0.6.0 UI 改版；serde default 兼容旧存储）——
    #[serde(default)]
    pub auth: String, // publickey | password | keyboard-interactive | none
    #[serde(default)]
    pub identity_file: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub last_used: i64,
    #[serde(default)]
    pub jump_host: String,
}

#[derive(Clone, Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub is_link: bool,
    pub permissions: Option<u32>,
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

#[tauri::command]
fn spawn(
    app: AppHandle,
    state: State<PtyState>,
    executions: State<agent_exec::AgentExecState>,
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

    let shell_cmd = command.filter(|c| !c.is_empty());
    let is_default_shell = shell_cmd.is_none();
    let mut cb = CommandBuilder::new(shell_cmd.unwrap_or_else(default_shell));
    // login shell：会读 /etc/zprofile、~/.zprofile（`brew shellenv` 通常写在这里）。
    // macOS 从 Finder/Dock 启动的 GUI 进程不继承终端 PATH，而非 login shell 又跳过 zprofile，
    // 两者叠加即 `zsh: command not found: brew`（0.7.x 实机反馈根因）。
    #[cfg(unix)]
    if is_default_shell {
        cb.arg("-l");
    }
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
    let output_stopped = Arc::new(AtomicBool::new(false));
    let alive = Arc::new(AtomicBool::new(true));
    let gate = modem_transport::SessionGate::new(id.clone(), alive.clone(), cfg!(unix));

    {
        let id2 = id.clone();
        let app2 = app.clone();
        let stopped = output_stopped.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut decoder = terminal_io::Utf8Decoder::default();
            loop {
                if stopped.load(Ordering::Acquire) { break; }
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        modem_transport::disconnect(&id2);
                        let data = decoder.finish();
                        if !data.is_empty() { let _ = app2.emit("pty-output", OutPayload { id: id2.clone(), data }); }
                        let _ = app2.emit("pty-exit", ExitPayload { id: id2.clone() });
                        break;
                    }
                    Ok(n) => {
                        if stopped.load(Ordering::Acquire) { break; }
                        let data = modem_transport::decode(&id2, &mut decoder, &buf[..n]);
                        if !data.is_empty() { let _ = app2.emit("pty-output", OutPayload { id: id2.clone(), data }); }
                    }
                }
            }
        });
    }

    let id3 = id.clone();
    let app3 = app.clone();
    let executions = executions.inner().clone();
    let child_alive = alive.clone();
    let killer = pty_child::monitor_child(child, move || {
        child_alive.store(false, Ordering::Release);
        modem_transport::disconnect(&id3);
        executions.cancel_session(&id3);
        let _ = app3.emit("pty-exit", ExitPayload { id: id3 });
    });

    state
        .0
        .lock()
        .unwrap()
        .insert(
            id.clone(),
            Entry {
                gate,
                writer: Arc::new(tokio::sync::Mutex::new(Box::new(writer))),
                resize,
                killer: Some(killer),
                closer: Some(Box::new(move || { output_stopped.store(true, Ordering::Release); })),
                sftp: None,
                exec: agent_exec::Target::Local { cwd: std::env::current_dir().ok() },
                alive,
            },
        );
    Ok(id)
}

/// Telnet 会话：协商引擎见 re/telnet.rs
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
        .map_err(|e| connection_error::redact(&format!("Telnet TCP/DNS 连接失败 {host}:{port}：{e}"), &[]))?;
    let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
    let mut resp_writer = stream.try_clone().map_err(|e| e.to_string())?;
    let killer = stream.try_clone().map_err(|e| e.to_string())?;
    let writer = stream;

    let id = Uuid::new_v4().to_string();
    let alive = Arc::new(AtomicBool::new(true));
    let gate = modem_transport::SessionGate::new(id.clone(), alive.clone(), false);
    let mut nego = re::telnet::Negotiator::client_default();

    // initOptions 等价：对带 0x10 标志的选项发 WILL/DO
    let init = nego.initial_requests();
    let _ = resp_writer.write_all(&init);

    {
        let id2 = id.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut decoder = terminal_io::Utf8Decoder::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        modem_transport::disconnect(&id2);
                        let data = decoder.finish();
                        if !data.is_empty() { let _ = app2.emit("pty-output", OutPayload { id: id2.clone(), data }); }
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
                            let data = decoder.push(&o.data);
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
            gate,
            writer: Arc::new(tokio::sync::Mutex::new(Box::new(writer))),
            resize: Box::new(|_r, _c| Ok(())),
            killer: None,
            closer: Some(Box::new(move || {
                let _ = killer.shutdown(std::net::Shutdown::Both);
            })),
            sftp: None,
            exec: agent_exec::Target::Unsupported,
            alive,
        },
    );
    Ok(id)
}

/// SSH 会话：russh 实连，认证序列/状态映射遵循 re/ssh_auth 语义
#[tauri::command]
fn connect_ssh(
    app: AppHandle,
    state: State<PtyState>,
    rows: u16,
    cols: u16,
    host: String,
    port: Option<u16>,
    user: Option<String>,
    password: Option<String>,
    key_path: Option<String>,
    proxy_type: Option<String>,
    proxy_host: Option<String>,
    proxy_port: Option<u16>,
    proxy_user: Option<String>,
    proxy_password: Option<String>,
    proxy_command: Option<String>,
    jump_host: Option<String>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    // 中继/代理拨号层（ssh_relay）
    let proxy = match proxy_type.as_deref().unwrap_or("") {
        "" | "none" | "None" => ssh_relay::Proxy::None,
        v => ssh_relay::proxy_from_session_value(v, &ssh_relay::ProxyProps {
            host: proxy_host.unwrap_or_default(),
            port: proxy_port.unwrap_or(1080),
            user: proxy_user.unwrap_or_default(),
            password: proxy_password.unwrap_or_default(),
            command: proxy_command.unwrap_or_default(),
            working_directory: String::new(),
            environment: String::new(),
            proxy_dns: true,
        }),
    };
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;

    // 跳板机：proxy 为直连且填了 jump_host 时，走 Proxy::Jump（direct-tcpip 二级会话）
    let jh = jump_host.as_deref().unwrap_or("").trim().to_string();
    let jump_spec = if jh.is_empty() { None } else {
        Some(jump::parse_spec(&jh, user.as_deref().filter(|u| !u.is_empty()).unwrap_or("root"))
            .ok_or("SSH 跳板机地址格式错误，请使用 user@host[:port] 或 user@[IPv6]:port，端口范围为 1–65535")?)
    };
    let proxy_is_none = matches!(proxy, ssh_relay::Proxy::None);
    let proxy = if proxy_is_none {
        match jump_spec {
            Some(mut spec) => {
                spec.password = password.clone().filter(|p| !p.is_empty());
                spec.key_path = key_path.clone().filter(|k| !k.is_empty());
                ssh_relay::Proxy::Jump(jump::opener(spec, config_dir.clone()))
            }
            None => proxy,
        }
    } else {
        proxy
    };

    let user = user.filter(|u| !u.is_empty()).unwrap_or_else(|| {
        std::env::var("USER").unwrap_or_else(|_| "root".into())
    });
    // 默认密钥：~/.ssh/id_ed25519（自动发现）
    let key = key_path.filter(|k| !k.is_empty()).or_else(|| {
        let h = std::env::var("HOME").ok()?;
        Some(format!("{h}/.ssh/id_ed25519"))
    });
    let ctl = ssh_live::spawn_session(
        app.clone(),
        id.clone(),
        host,
        port.unwrap_or(22),
        user,
        password.filter(|p| !p.is_empty()),
        key,
        rows,
        cols,
        config_dir,
        proxy,
    )
    .map_err(|e| connection_error::redact(&format!("SSH 连接任务启动失败：{e}"), &[]))?;

    let ssh_in = ctl.input;
    let rz = ctl.resize;
    let stop = ctl.stop;
    state.0.lock().unwrap().insert(
        id.clone(),
        Entry {
            gate: modem_transport::SessionGate::new(id.clone(), ctl.alive.clone(), true),
            writer: Arc::new(tokio::sync::Mutex::new(Box::new(ssh_live::SshInput(ssh_in)))),
            resize: Box::new(move |r, c| {
                rz.send((c as u32, r as u32)).map_err(|_| "closed".to_string())
            }),
            killer: None,
            closer: Some(Box::new(move || {
                let _ = stop.send(());
            })),
            sftp: Some(ctl.sftp.clone()),
            exec: agent_exec::Target::Ssh(ctl.sftp),
            alive: ctl.alive,
        },
    );
    Ok(id)
}

/// 串口会话：实连层 serialport 4；选项键名 serial.baudRate/dataBits/parity/stopBits/flowControl
/// 语义路径：re::serial::settings_from_options（默认/归一/校验都在该模块）；
/// 运行期改选项无效 → 本命令仅在 open 时读参，重连生效。
#[tauri::command]
fn connect_serial(
    app: AppHandle,
    state: State<PtyState>,
    target: String,
    baud_rate: Option<i32>,
    data_bits: Option<i64>,
    parity: Option<String>,
    stop_bits: Option<i64>,
    flow_control: Option<String>,
) -> Result<String, String> {
    #[cfg(not(unix))]
    {
        let _ = (&target, &baud_rate, &data_bits, &parity, &stop_bits, &flow_control, &app, &state);
        return Err("串口会话当前仅支持 Unix 平台（termios 实现）".to_string());
    }
    #[cfg(unix)]
    {

        let mut opts: BTreeMap<String, re::serial::OptVal> = BTreeMap::new();
    if let Some(v) = baud_rate.filter(|v| *v > 0) {
        opts.insert("serial.baudRate".into(), re::serial::OptVal::Int(v as i64));
    }
    if let Some(v) = data_bits.filter(|v| *v > 0) {
        opts.insert("serial.dataBits".into(), re::serial::OptVal::Int(v));
    }
    if let Some(v) = parity.filter(|v| !v.is_empty()) {
        opts.insert("serial.parity".into(), re::serial::OptVal::Str(v));
    }
    if let Some(v) = stop_bits.filter(|v| *v > 0) {
        opts.insert("serial.stopBits".into(), re::serial::OptVal::Int(v));
    }
    if let Some(v) = flow_control.filter(|v| !v.is_empty()) {
        opts.insert("serial.flowControl".into(), re::serial::OptVal::Str(v));
    }
    let id = Uuid::new_v4().to_string();
    let alive = Arc::new(AtomicBool::new(true));
    let gate = modem_transport::SessionGate::new(id.clone(), alive.clone(), true);
    let (host_label, ctl) =
        serial_live::spawn_session(app.clone(), id.clone(), target.trim(), &opts)
            .map_err(|e| connection_error::redact(&format!("串口打开或配置失败 {target}：{e}"), &[]))?;
    let _ = host_label; // 标题用会话名；host=portName 已在 serial_live 内处理
    let stop = ctl.stop;
    state.0.lock().unwrap().insert(
        id.clone(),
        Entry {
            gate,
            writer: Arc::new(tokio::sync::Mutex::new(Box::new(ctl.writer))), // Box<dyn SerialPort>: Write + Send
            resize: Box::new(|_r, _c| Ok(())), // 串口无窗口尺寸概念
            killer: None,
            sftp: None,
            exec: agent_exec::Target::Unsupported,
            alive,
            closer: Some(Box::new(move || {
                let _ = stop.send(());
            })),
        },
    );
    Ok(id)
    }
}


/// 裸 TCP 会话：实连层；代理分流/选项映射走 re::tcp 语义路径（Socks5/Http CONNECT/ProxyCommand/直连哨兵）
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn connect_tcp(
    app: AppHandle,
    state: State<PtyState>,
    host: String,
    port: Option<u16>,
    target: Option<String>,
    low_delay: Option<bool>,
    keep_alive: Option<bool>,
    send_buf: Option<i64>,
    recv_buf: Option<i64>,
    proxy_type: Option<String>,
    proxy_host: Option<String>,
    proxy_port: Option<u16>,
    proxy_user: Option<String>,
    proxy_password: Option<String>,
    proxy_command: Option<String>,
) -> Result<String, String> {
    let params = tcp_live::TcpParams {
        target: target.filter(|t| !t.is_empty()).unwrap_or_else(|| host.clone()),
        port: port.unwrap_or(0),
        low_delay: low_delay.map(|v| v.to_string()),
        keep_alive: keep_alive.map(|v| v.to_string()),
        send_buf: send_buf.map(|v| v.to_string()),
        recv_buf: recv_buf.map(|v| v.to_string()),
        proxy_type: proxy_type.unwrap_or_default(),
        proxy_host: proxy_host.unwrap_or_default(),
        proxy_port: proxy_port.unwrap_or(0),
        proxy_user: proxy_user.unwrap_or_default(),
        proxy_password: proxy_password.unwrap_or_default(),
        proxy_command: proxy_command.unwrap_or_default(),
        proxy_workdir: String::new(),
        proxy_env: String::new(),
    };
    let id = Uuid::new_v4().to_string();
    let alive = Arc::new(AtomicBool::new(true));
    let gate = modem_transport::SessionGate::new(id.clone(), alive.clone(), true);
    let connection_label = params.target.clone();
    let secrets = vec![params.proxy_password.clone(), params.proxy_command.clone()];
    let (_label, ctl) = tcp_live::spawn_session(app.clone(), id.clone(), params)
        .map_err(|e| connection_error::redact(&format!("TCP 连接或代理协商失败 {connection_label}：{e}"), &secrets))?;
    let tcp_live::TcpCtl { writer, stop, killer } = ctl;
    state.0.lock().unwrap().insert(
        id.clone(),
        Entry {
            gate,
            writer: Arc::new(tokio::sync::Mutex::new(writer)),
            resize: Box::new(|_r, _c| Ok(())), // 裸 TCP 无尺寸语义
            killer: None,
            sftp: None,
            exec: agent_exec::Target::Unsupported,
            alive,
            closer: Some(Box::new(move || {
                let _ = stop.send(()); // 通知 pump
                killer(); // shutdown(Both)/kill child → 读线程退出 → detach 信号对
            })),
        },
    );
    Ok(id)
}

#[tauri::command]
async fn write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    write_session(state, id, data.into_bytes()).await
}

#[tauri::command]
async fn write_binary(state: State<'_, PtyState>, id: String, data: Vec<u8>) -> Result<(), String> {
    write_session(state, id, data).await
}

async fn write_session(state: State<'_, PtyState>, id: String, data: Vec<u8>) -> Result<(), String> {
    let (writer, write_lease) = {
        let map = state.0.lock().map_err(|e| e.to_string())?;
        let entry = map.get(&id).ok_or("no such pty")?;
        (entry.writer.clone(), entry.gate.begin_write()?)
    };
    // Only this session's writer is locked while IO can block. Other sessions,
    // close, resize and SFTP calls never wait on a global map lock held by IO.
    // Tokio's FIFO mutex serializes input without consuming blocking workers
    // while another write is pending (important for quick typing / paste).
    let mut writer = writer.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        // Cancellation of the IPC future must not release modem exclusion while
        // its blocking writer is still running.
        let _write_lease = write_lease;
        writer.write_all(&data).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
/* ---------- PuTTY 式会话落盘日志（设置页开关；前端缓冲后按秒刷盘） ---------- */
#[derive(Default)]
struct LogState(Mutex<std::collections::HashMap<String, std::fs::File>>);

#[tauri::command]
fn session_log_start(app: AppHandle, state: State<LogState>, id: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let short: String = id.chars().take(8).collect();
    let path = dir.join(format!("session-{short}-{ts}.log"));
    let f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    state.0.lock().map_err(|e| e.to_string())?.insert(id, f);
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn session_log_append(state: State<LogState>, id: String, data: String) -> Result<(), String> {
    use std::io::Write;
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(f) = map.get_mut(&id) {
        f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn session_log_stop(state: State<LogState>, id: String) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[tauri::command]
fn resize(state: State<PtyState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let e = map.get(&id).ok_or("no such pty")?;
    (e.resize)(rows, cols)
}

#[tauri::command]
async fn kill(state: State<'_, PtyState>, executions: State<'_, agent_exec::AgentExecState>, id: String) -> Result<(), String> {
    let entry = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    executions.cancel_session(&id);
    modem_transport::disconnect(&id);
    // Removing the entry is idempotent; release the global map before any
    // signal, socket shutdown or destructor runs. None run on the UI thread.
    if let Some(mut entry) = entry {
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(close) = &entry.closer { close(); }
            if let Some(killer) = &mut entry.killer { let _ = killer.kill(); }
            drop(entry);
        }).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn sftp_call<T: Send + 'static>(
    state: &tauri::State<'_, PtyState>,
    id: String,
    mk: impl FnOnce(tokio::sync::oneshot::Sender<Result<T, String>>) -> ssh_live::SftpReq,
) -> Result<T, String> {
    let tx = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .and_then(|e| e.sftp.clone())
        .ok_or("该会话无 SFTP（需 SSH 会话）".to_string())?;
    let (rpl, rx) = tokio::sync::oneshot::channel();
    tx.send(mk(rpl)).map_err(|_| "会话已关闭".to_string())?;
    rx.await.map_err(|_| "SFTP 无响应".to_string())?
}

#[tauri::command]
async fn sftp_list(
    state: tauri::State<'_, PtyState>,
    id: String,
    path: String,
) -> Result<Vec<ssh_live::SftpEntry>, String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::List { path, reply }).await
}

#[tauri::command]
async fn sftp_download(
    state: tauri::State<'_, PtyState>,
    id: String,
    remote: String,
    local: String,
) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Download { remote, local, reply }).await
}

#[tauri::command]
async fn sftp_upload(
    state: tauri::State<'_, PtyState>,
    id: String,
    local: String,
    remote: String,
) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Upload { local, remote, reply }).await
}

#[tauri::command]
async fn sftp_realpath(state: State<'_, PtyState>, id: String, path: String) -> Result<String, String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Realpath { path, reply }).await
}

#[tauri::command]
async fn sftp_stat(state: State<'_, PtyState>, id: String, path: String) -> Result<Option<ssh_live::SftpEntry>, String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Stat { path, reply }).await
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, PtyState>, id: String, path: String) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Mkdir { path, reply }).await
}

#[tauri::command]
async fn sftp_create_file(state: State<'_, PtyState>, id: String, path: String) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::CreateFile { path, reply }).await
}

#[tauri::command]
async fn sftp_rename(state: State<'_, PtyState>, id: String, from: String, to: String) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Rename { from, to, reply }).await
}

#[tauri::command]
async fn sftp_copy(state: State<'_, PtyState>, id: String, from: String, to: String, move_item: bool) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Copy { from, to, move_item, reply }).await
}

#[tauri::command]
async fn sftp_remove(state: State<'_, PtyState>, id: String, path: String, recursive: bool) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Remove { path, recursive, reply }).await
}

#[tauri::command]
async fn sftp_read_file(state: State<'_, PtyState>, id: String, path: String) -> Result<files::FilePreview, String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::ReadFile { path, reply }).await
}

#[tauri::command]
async fn sftp_write_file(
    state: State<'_, PtyState>, id: String, path: String, content: String,
    expected_modified: Option<u64>, expected_revision: Option<String>, force: bool,
) -> Result<(), String> {
    sftp_call(&state, id, |reply| ssh_live::SftpReq::WriteFile {
        path, content, expected_modified, expected_revision, force, reply,
    }).await
}

#[tauri::command]
async fn sftp_chmod(state: State<'_, PtyState>, id: String, path: String, mode: u32) -> Result<(), String> {
    if mode > 0o7777 { return Err("权限必须是 0000–7777 范围内的八进制模式".into()); }
    sftp_call(&state, id, |reply| ssh_live::SftpReq::Chmod { path, mode, reply }).await
}

#[tauri::command]
fn modem_capabilities(state: State<'_, PtyState>, session_id:String)->Result<serde_json::Value,String>{
    let entries=state.0.lock().map_err(|_|"会话状态不可用")?;
    let entry=entries.get(&session_id).ok_or("目标连接不存在")?;
    let available=entry.gate.is_alive()&&entry.gate.binary_supported();
    let reason=if !entry.gate.is_alive(){"目标连接已断开"}else if !entry.gate.binary_supported(){"此通道无法保证二进制保真；请使用 SSH、原始 TCP、Unix 本地终端或串口"}else{"X/Y/ZMODEM 已内置，请先在对端启动相应收发程序"};
    let protocols=["xmodem","ymodem","zmodem"].iter().map(|p|serde_json::json!({"protocol":p,"available":available})).collect::<Vec<_>>();
    Ok(serde_json::json!({"available":available,"reason":reason,"protocols":protocols}))
}
#[tauri::command]
async fn modem_transfer_start(app:AppHandle,state:State<'_,PtyState>,pending:State<'_,ModemPending>,request:modem_live::Request)->Result<modem_live::Outcome,String>{
    modem_live::validate(&request)?;
    let (writer,_lease,input,cancel)={
        let entries=state.0.lock().map_err(|_|"会话状态不可用")?;
        let entry=entries.get(&request.session_id).ok_or("目标连接不存在")?;
        let mut cancelled=pending.0.lock().map_err(|_|"传输状态不可用")?;
        if cancelled.remove(&(request.session_id.clone(),request.transfer_id.clone())) {return Err("传输在启动前已取消".into())}
        let (lease,input,cancel)=entry.gate.begin_modem(request.transfer_id.clone())?;
        (entry.writer.clone(),lease,input,cancel)
    };
    let sink:modem_live::Sink=Arc::new(move|progress|{let _=app.emit("modem-transfer-progress",progress);});
    modem_live::run(request,input,cancel,writer,sink).await
}
#[tauri::command]
fn modem_transfer_cancel(state:State<'_,PtyState>,pending:State<'_,ModemPending>,session_id:String,transfer_id:String)->Result<(),String>{
    if transfer_id.is_empty()||transfer_id.len()>200{return Err("传输编号无效".into())}
    let entries=state.0.lock().map_err(|_|"会话状态不可用")?;
    let entry=entries.get(&session_id).ok_or("目标连接已关闭")?;
    if !entry.gate.cancel(&transfer_id){let mut cancelled=pending.0.lock().map_err(|_|"传输状态不可用")?;if cancelled.len()>=256{cancelled.clear()}cancelled.insert((session_id,transfer_id));}Ok(())
}
#[tauri::command]
async fn sftp_transfer_start(
    state: State<'_, PtyState>, transfers: State<'_, TransferState>,
    id: String, transfer_id: String, local: String, remote: String, upload: bool, policy: String,
) -> Result<(), String> {
    if transfer_id.trim().is_empty() { return Err("传输 ID 不能为空".into()); }
    if !matches!(policy.as_str(), "overwrite" | "skip" | "rename") {
        return Err("未知的文件冲突处理策略".into());
    }
    let control = Arc::new(ssh_live::TransferControl::new());
    {
        let mut registry = transfers.0.lock().map_err(|e| e.to_string())?;
        if registry.contains_key(&transfer_id) { return Err("该传输已经在运行".into()); }
        registry.insert(transfer_id.clone(), Arc::clone(&control));
    }
    let result = sftp_call(&state, id, |reply| ssh_live::SftpReq::Transfer {
        transfer_id: transfer_id.clone(), local, remote, upload, policy, control, reply,
    }).await;
    if let Ok(mut registry) = transfers.0.lock() { registry.remove(&transfer_id); }
    result
}

#[tauri::command]
fn sftp_transfer_control(transfers: State<'_, TransferState>, transfer_id: String, action: String) -> Result<(), String> {
    let control = {
        transfers.0.lock().map_err(|e| e.to_string())?.get(&transfer_id).cloned()
            .ok_or_else(|| "传输已结束或不存在".to_string())?
    };
    match action.as_str() {
        "pause" => control.pause(),
        "resume" => control.resume(),
        "cancel" => control.cancel(),
        _ => return Err("未知的传输控制操作".into()),
    }
    Ok(())
}

// ================= P2 命令补全 =================

#[derive(Clone, serde::Serialize)]
pub struct Completion { pub value: String, pub info: String }
#[derive(Clone, serde::Serialize)]
pub struct CompleteResult { pub start: usize, pub items: Vec<Completion> }

fn path_bins() -> &'static Vec<String> {
    static BINS: OnceLock<Vec<String>> = OnceLock::new();
    BINS.get_or_init(|| {
        let mut set: std::collections::BTreeSet<String> = Default::default();
        for dir in std::env::var("PATH").unwrap_or_default().split(':') {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    if e.path().is_file() {
                        if let Some(n) = e.file_name().to_str() { set.insert(n.to_string()); }
                    }
                }
            }
        }
        for b in ["cd","echo","export","alias","source","history","pwd","set","unset"] {
            set.insert(b.to_string());
        }
        set.into_iter().collect()
    })
}

fn option_table() -> &'static std::collections::HashMap<&'static str, Vec<(&'static str, &'static str)>> {
    static T: OnceLock<std::collections::HashMap<&'static str, Vec<(&'static str, &'static str)>>> = OnceLock::new();
    T.get_or_init(|| {
        let mut m: std::collections::HashMap<&'static str, Vec<(&'static str, &'static str)>> = Default::default();
        let mut add = |k: &'static str, v: Vec<(&'static str, &'static str)>| { m.insert(k, v); };
        add("git commit", vec![("-m","message"),("-a","all"),("--amend","amend"),("--no-edit","no-edit"),("-v","verbose"),("-F","file"),("--allow-empty",  "")]);
        add("git push", vec![("-u","set-upstream"),("--force-with-lease","safe-force"),("--tags","tags"),("--dry-run","dry-run")]);
        add("git log", vec![("--oneline","one-line"),("-p","patch"),("--graph","graph"),("-n","count"),("--author","author"),("--since","since")]);
        add("git checkout", vec![("-b","new-branch"),("--","--"),("-t","track")]);
        add("docker run", vec![("-d","detach"),("--rm","auto-remove"),("-it","interactive-tty"),("-p","publish"),("-v","volume"),("--name","name"),("-e","env"),("--network","network")]);
        add("docker compose", vec![("-f","file"),("up","up"),("down","down"),("logs","logs"),("ps","ps"),("exec","exec"),("build","build")]);
        add("ssh", vec![("-p","port"),("-i","identity"),("-L","local-fwd"),("-R","remote-fwd"),("-J","jump"),("-N","no-cmd"),("-v","verbose"),("-o","option")]);
        add("curl", vec![("-o","output"),("-O","remote-name"),("-X","method"),("-s","silent"),("-I","head"),("-L","location"),("-H","header"),("--data","body"),("--fail-with-body","fail")]);
        add("tar", vec![("-x","extract"),("-c","create"),("-z","gzip"),("-j","bzip2"),("-f","file"),("-v","verbose"),("-C","chdir"),("--exclude","exclude")]);
        add("grep", vec![("-r","recursive"),("-i","ignore-case"),("-n","line-number"),("-E","extended"),("-C","context"),("-v","invert"),("-w","word"),("--include","include")]);
        add("find", vec![("-name","name"),("-type","type"),("-exec","exec"),("-mtime","mtime"),("-size","size"),("-delete","delete"),("-maxdepth","depth")]);
        add("systemctl", vec![("--now","now"),("--user","user"),("--no-pager","no-pager"),("--force","force")]);
        add("kubectl get", vec![("-n","namespace"),("-o","output"),("-w","watch"),("-A","all-namespaces")]);
        add("apt", vec![("-y","assume-yes"),("--no-install-recommends","lean")]);
        add("ls", vec![("-l","long"),("-a","all"),("-h","human"),("-t","time-sort"),("-S","size-sort"),("-r","reverse"),("-1","one"),("--color","color")]);
        add("cargo", vec![("--release","release"),("-p","package"),("--features","features")]);
        add("scp", vec![("-P","port"),("-r","recursive"),("-i","identity"),("-C","compress")]);
        add("rsync", vec![("-a","archive"),("-z","compress"),("-v","verbose"),("--progress","progress"),("-e","rsh"),("--delete","delete")]);
        m
    })
}

/// 补全入口：基于 re/scheme 的分词上下文。返回替换起点 + 候选。
#[tauri::command]
fn complete_input(line: String, caret: usize) -> CompleteResult {
    use re::scheme::{completion_context, subcommand_tools, CompletionCtx};
    let caret = caret.min(line.len());
    let mut items: Vec<Completion> = Vec::new();
    let mut start = caret;
    match completion_context(&line, caret) {
        CompletionCtx::Command { prompt } => {
            start = prompt;
            let prefix = &line[prompt..caret];
            for b in path_bins() {
                if b.starts_with(prefix) {
                    items.push(Completion { value: b.clone(), info: "command".into() });
                    if items.len() >= 40 { break; }
                }
            }
        }
        CompletionCtx::SubCommand { tool, sub_prefix } => {
            if let Some(subs) = subcommand_tools().get(tool.as_str()) {
                start = caret.saturating_sub(sub_prefix.len());
                for sc in subs {
                    if sc.starts_with(&sub_prefix) {
                        items.push(Completion { value: sc.to_string(), info: format!("{tool} subcommand") });
                    }
                }
            }
        }
        CompletionCtx::Option { tool, sub, word_start } => {
            start = word_start;
            let key = match &sub { Some(s) => format!("{tool} {s}"), None => tool.clone() };
            let prefix = line[word_start.min(line.len())..caret].to_string();
            if let Some(opts) = option_table().get(key.as_str()) {
                for (v, i) in opts {
                    if v.starts_with(&prefix) {
                        items.push(Completion { value: v.to_string(), info: i.to_string() });
                    }
                }
            }
        }
        CompletionCtx::Word { word, word_start } => {
            // 文件/目录补全
            start = word_start;
            let (dir, prefix) = match word.rfind('/') {
                Some(k) => (word[..=k].to_string(), word[k + 1..].to_string()),
                None => (String::new(), word.clone()),
            };
            let base = if dir.is_empty() { ".".to_string() } else { dir.clone() };
            if let Ok(rd) = std::fs::read_dir(&base) {
                let mut entries: Vec<_> = rd.flatten().collect();
                entries.sort_by_key(|e| e.file_name());
                for e in entries {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !name.starts_with(&prefix) { continue; }
                    let is_dir = e.path().is_dir();
                    let value = format!("{dir}{name}{}", if is_dir { "/" } else { "" });
                    items.push(Completion { value, info: if is_dir { "dir".into() } else { "file".into() } });
                    if items.len() >= 60 { break; }
                }
            }
        }
    }
    CompleteResult { start, items }
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
async fn fs_list(path: Option<String>) -> Result<Vec<FsEntry>, String> {
    fs_call(move || files::list(path.as_deref())).await
}

async fn fs_call<T: Send + 'static>(action: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_realpath(path: Option<String>) -> Result<String, String> { fs_call(move || files::realpath(path.as_deref())).await }

#[tauri::command]
async fn fs_stat(path: String) -> Result<Option<FsEntry>, String> { fs_call(move || files::stat(&path)).await }

#[tauri::command]
async fn fs_mkdir(path: String) -> Result<(), String> { fs_call(move || files::mkdir(&path)).await }

#[tauri::command]
async fn fs_create_file(path: String) -> Result<(), String> { fs_call(move || files::create_file(&path)).await }

#[tauri::command]
async fn fs_rename(from: String, to: String) -> Result<(), String> { fs_call(move || files::rename(&from, &to)).await }

#[tauri::command]
async fn fs_remove(path: String, recursive: bool) -> Result<(), String> { fs_call(move || files::remove(&path, recursive)).await }

#[tauri::command]
async fn fs_read_file(path: String) -> Result<files::FilePreview, String> { fs_call(move || files::read_file(&path)).await }

#[tauri::command]
async fn fs_write_file(path: String, content: String, expected_modified: Option<u64>, expected_revision: Option<String>, force: bool) -> Result<(), String> {
    fs_call(move || files::write_file(&path, &content, expected_modified, expected_revision.as_deref(), force)).await
}

#[tauri::command]
async fn fs_copy(from: String, to: String, move_item: bool) -> Result<(), String> { fs_call(move || files::copy(&from, &to, move_item)).await }

fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn cfg_path(app: &AppHandle, file: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(file))
}

// ---- 触发器引擎（re::triggers，P2-2）----
// 前端 v0 设置 {name,pattern,action,arg,enabled} 映射为后端触发器语义；
// 编译/可执行门/捕获替换/转义解析全部走后端引擎，UI 动作回传前端执行。
#[derive(Default)]
struct TriggersState(Mutex<re::triggers::TriggerManager>);

fn v0_to_trigger(i: usize, v: &serde_json::Value) -> Option<re::triggers::Trigger> {
    let obj = v.as_object()?;
    let pattern = obj.get("pattern")?.as_str()?.to_string();
    if pattern.is_empty() {
        return None; // lambda3：空 pattern 丢弃（1001817c0）
    }
    let enabled = obj
        .get("enabled")
        .map(|b| b.as_bool().unwrap_or(true))
        .unwrap_or(true);
    let action = obj.get("action").and_then(|a| a.as_str()).unwrap_or("highlight");
    let arg = obj
        .get("arg")
        .and_then(|a| a.as_str())
        .unwrap_or("")
        .to_string();
    let name = obj
        .get("name")
        .and_then(|a| a.as_str())
        .unwrap_or("")
        .to_string();
    let mut settings: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let ty;
    match action {
        "send" => {
            ty = re::triggers::TriggerType::SendText;
            settings.insert("text.pattern".into(), serde_json::Value::String(pattern));
            // 文本走 parseEscapedString（\r → CR），与 v0 行为一致
            settings.insert("text".into(), serde_json::Value::String(arg + r"\r"));
        }
        "bell" => {
            ty = re::triggers::TriggerType::PlaySound;
            settings.insert("text.pattern".into(), serde_json::Value::String(pattern));
        }
        _ => {
            // highlight → Highlight text：从 settings["value"] 数组展开
            ty = re::triggers::TriggerType::HighlightText;
            let mut rule = serde_json::Map::new();
            rule.insert("text.pattern".into(), serde_json::Value::String(pattern));
            settings.insert(
                "value".into(),
                serde_json::Value::Array(vec![serde_json::Value::Object(rule)]),
            );
        }
    }
    Some(re::triggers::Trigger {
        name,
        uuid: format!("v0-{i}"),
        description: String::new(),
        enabled,
        dynamic: false,
        r#type: ty,
        settings: settings.into_iter().collect(),
        target_sessions: Default::default(),
        target_systems: ["*".to_string()].into_iter().collect(),
    })
}

#[tauri::command]
fn triggers_reload(
    state: tauri::State<TriggersState>,
    triggers: String,
) -> Result<usize, String> {
    let list: Vec<serde_json::Value> = serde_json::from_str(&triggers).map_err(|e| e.to_string())?;
    let ts: Vec<_> = list
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v0_to_trigger(i, v))
        .collect();
    let mut c = state.0.lock().map_err(|e| e.to_string())?;
    Ok(c.set_triggers(ts).rules_len)
}

/// 收集型 sink：动作回传前端（编辑层高亮/声音/发送/进程/错误）
struct CollectSink(Vec<serde_json::Value>);
impl re::triggers::TriggerSink for CollectSink {
    fn open_url(&mut self, url: &str) {
        self.0
            .push(serde_json::json!({ "action": "open", "url": url }));
    }
    fn play_sound(&mut self, _s: &str) {
        self.0.push(serde_json::json!({ "action": "bell" }));
    }
    fn start_process_detached(
        &mut self,
        program: &str,
        args: &[String],
        _cwd: &str,
        _hide: bool,
    ) -> bool {
        self.0
            .push(serde_json::json!({ "action": "run", "program": program, "args": args }));
        !program.is_empty()
    }
    fn send_text(&mut self, text: &str) {
        self.0
            .push(serde_json::json!({ "action": "send", "text": text }));
    }
    fn report_error(&mut self, name: &str, body: &str) {
        self.0.push(serde_json::json!({
            "action": "log",
            "text": format!("触发器「{name}」执行失败：{body}")
        }));
    }
    fn has_widget(&self) -> bool {
        true
    }
}

#[tauri::command]
fn triggers_feed(state: tauri::State<TriggersState>, data: String) -> Vec<serde_json::Value> {
    let mut c = match state.0.lock() {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let uuids: std::collections::BTreeSet<String> =
        c.trigger_rules().iter().map(|r| r.uuid.clone()).collect();
    let hits = c.match_output(&uuids, &data);
    let mut sink = CollectSink(vec![]);
    for h in &hits {
        // 高亮/tooltip 属编辑层动作：executeTriggerRule 内为 no-op（1001822a0），在此回传前端
        if let Some(rule) = c.trigger_rule(h.rule_id) {
            if matches!(
                rule.r#type,
                re::triggers::TriggerType::HighlightText | re::triggers::TriggerType::ShowTooltip
            ) {
                sink.0
                    .push(serde_json::json!({ "action": "highlight", "ruleId": h.rule_id }));
            }
        }
        c.execute_trigger_rule(h.rule_id, &h.captures, &mut sink);
    }
    sink.0
}

#[tauri::command]
async fn gist_request(request: gist_sync::GistRequest) -> Result<gist_sync::GistResponse, String> {
    gist_sync::gist_request(request).await
}

#[tauri::command]
async fn ai_chat(app: AppHandle, state: State<'_, ai::AiState>, request: ai::AiChatRequest) -> Result<ai::AiChatResponse, String> {
    ai::chat(&state, request, move |delta| {
        app.emit("ai-chat-delta", delta).map_err(|_| "AI 界面无法接收回复".to_owned())
    }).await
}

#[tauri::command]
async fn ai_agent_step(app: AppHandle, state: State<'_, ai::AiState>, request: ai::AiAgentRequest) -> Result<ai::AiAgentResponse, String> {
    ai::agent_step(&state, request, move |delta| {
        app.emit("ai-chat-delta", delta).map_err(|_| "AI 界面无法接收回复".to_owned())
    }).await
}

#[tauri::command]
async fn harness_create(state: State<'_, harness_log::HarnessStore>, id: String, metadata: serde_json::Value) -> Result<harness_log::SessionRecord, String> { state.create(id, metadata).await }
#[tauri::command]
async fn harness_append(state: State<'_, harness_log::HarnessStore>, id: String, expected_seq: u64, kind: String, data: serde_json::Value) -> Result<harness_log::SessionEvent, String> { state.append(id, expected_seq, kind, data).await }
#[tauri::command]
async fn harness_read(state: State<'_, harness_log::HarnessStore>, id: String) -> Result<harness_log::SessionRecord, String> { state.read(id).await }
#[tauri::command]
async fn harness_list(state: State<'_, harness_log::HarnessStore>) -> Result<Vec<harness_log::SessionSummary>, String> { state.list().await }
#[tauri::command]
fn harness_fingerprint(identity: String) -> Result<String, String> { harness_log::fingerprint(&identity) }

#[tauri::command]
async fn agent_exec(
    app: AppHandle, state: State<'_, PtyState>, executions: State<'_, agent_exec::AgentExecState>,
    request: agent_exec::ExecRequest,
) -> Result<agent_exec::ExecResult, String> {
    // Registration and target lookup share the PTY-map lock. A concurrent
    // close either prevents registration or cancels the newly registered job.
    let (target, lease, _write_lease) = {
        let entries = state.0.lock().map_err(|_| "会话状态不可用")?;
        let entry = entries.get(&request.session_id).filter(|entry| entry.alive.load(Ordering::Acquire))
            .ok_or("目标会话已退出或断开，请先重新连接")?;
        let target = entry.exec.clone();
        if matches!(target, agent_exec::Target::Unsupported) { return Err("该协议不支持 AI 运维命令，仅支持本地终端和 SSH".into()); }
        let write_lease = entry.gate.begin_write()?;
        let lease = executions.begin(&request)?;
        if !entry.alive.load(Ordering::Acquire) {
            lease.control.session_closed();
            return Err("目标会话已退出或断开，请先重新连接".into());
        }
        (target, lease, write_lease)
    };
    let sink: agent_exec::OutputSink = Arc::new(move |output| { let _ = app.emit("agent-exec-output", output); });
    agent_exec::execute(target, request, lease.control.clone(), sink).await
}

#[tauri::command]
fn agent_exec_cancel(executions: State<'_, agent_exec::AgentExecState>, request_id: String) -> bool {
    executions.cancel(&request_id)
}

#[tauri::command]
fn ai_cancel(state: State<'_, ai::AiState>, request_id: String) -> bool {
    state.cancel(&request_id)
}

#[tauri::command]
async fn ai_key_read(state: State<'_, credentials::Credentials>, endpoint: String) -> Result<Option<String>, String> {
    state.read(endpoint).await
}

#[tauri::command]
async fn ai_key_write(state: State<'_, credentials::Credentials>, endpoint: String, api_key: String) -> Result<(), String> {
    state.write(endpoint, api_key).await
}

#[tauri::command]
async fn ai_key_delete(state: State<'_, credentials::Credentials>, endpoint: String) -> Result<(), String> {
    state.delete(endpoint).await
}

#[tauri::command]
async fn memory_list(state: State<'_, memory::MemoryState>, scope: String) -> Result<Vec<memory::MemoryDoc>, String> { state.list(scope).await }
#[tauri::command]
async fn memory_get(state: State<'_, memory::MemoryState>, scope: String, path: String, from_line: Option<usize>, lines: Option<usize>) -> Result<memory::MemoryFile, String> { state.get(scope, path, from_line, lines).await }
#[tauri::command]
async fn memory_write(state: State<'_, memory::MemoryState>, request: memory::MemoryWriteRequest) -> Result<memory::MemoryDoc, String> { state.write(request).await }
#[tauri::command]
async fn memory_delete(state: State<'_, memory::MemoryState>, request: memory::MemoryDeleteRequest) -> Result<memory::MemoryDeleteResponse, String> { state.delete(request).await }
#[tauri::command]
async fn memory_search(state: State<'_, memory::MemoryState>, request: memory::MemorySearchRequest) -> Result<memory::MemorySearchResponse, String> { state.search(request).await }
#[tauri::command]
async fn memory_reindex(state: State<'_, memory::MemoryState>, request: memory::MemoryReindexRequest) -> Result<memory::MemoryStatus, String> { state.reindex(request).await }
#[tauri::command]
async fn memory_status(state: State<'_, memory::MemoryState>, scope: String) -> Result<memory::MemoryStatus, String> { state.status(scope).await }
#[tauri::command]
async fn memory_embedding_test(state: State<'_, memory::MemoryState>, embedding: memory::EmbeddingConfig) -> Result<memory::EmbeddingTestResponse, String> { state.embedding_test(embedding).await }
#[tauri::command]
async fn memory_key_read(state: State<'_, credentials::Credentials>, endpoint: String) -> Result<Option<String>, String> { state.read_embedding(endpoint).await }
#[tauri::command]
async fn memory_key_write(state: State<'_, credentials::Credentials>, endpoint: String, api_key: String) -> Result<(), String> { state.write_embedding(endpoint, api_key).await }
#[tauri::command]
async fn memory_key_delete(state: State<'_, credentials::Credentials>, endpoint: String) -> Result<(), String> { state.delete_embedding(endpoint).await }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    mac_text_input::configure();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(mac_text_input::init());
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState::default())
        .manage(TransferState::default())
        .manage(ModemPending::default())
        .manage(TriggersState::default())
        .manage(LogState::default())
        .manage(ai::AiState::default())
        .manage(agent_exec::AgentExecState::default())
        .manage(credentials::Credentials::default())
        .setup(|app| {
            app.manage(memory::MemoryState::new(app.path().app_config_dir()?.join("ai-memory")));
            app.manage(harness_log::HarnessStore::new(app.path().app_config_dir()?.join("ai-runs")));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn,
            write,
            write_binary,
            resize,
            kill,
            connect_telnet,
            connect_ssh,
            connect_serial,
            connect_tcp,
            sftp_list,
            sftp_download,
            sftp_upload,
            sftp_realpath,
            sftp_stat,
            sftp_mkdir,
            sftp_create_file,
            sftp_rename,
            sftp_copy,
            sftp_remove,
            sftp_read_file,
            sftp_write_file,
            sftp_chmod,
            modem_capabilities,
            modem_transfer_start,
            modem_transfer_cancel,
            sftp_transfer_start,
            sftp_transfer_control,
            sessions_load,
            sessions_save,
            gist_request,
            harness_create,
            harness_append,
            harness_read,
            harness_list,
            harness_fingerprint,
            ai_chat,
            ai_agent_step,
            ai_cancel,
            ai_key_read,
            ai_key_write,
            ai_key_delete,
            memory_list,
            memory_get,
            memory_write,
            memory_delete,
            memory_search,
            memory_reindex,
            memory_status,
            memory_embedding_test,
            memory_key_read,
            memory_key_write,
            memory_key_delete,
            agent_exec,
            agent_exec_cancel,
            ui_state_save,
            ui_state_load,
            complete_input,
            fs_list,
            fs_realpath,
            fs_stat,
            fs_mkdir,
            fs_create_file,
            fs_rename,
            fs_remove,
            fs_read_file,
            fs_write_file,
            fs_copy,
            triggers_reload,
            triggers_feed,
            session_log_start,
            session_log_append,
            session_log_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running hurricaneTerm");
}

fn main() {
    run();
}
