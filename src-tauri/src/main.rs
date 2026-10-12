// hurricaneTerm — Tauri 2 backend: local PTY sessions + fs/state services.
// Original implementation (Apache-2.0, see LICENSE). UI structure mirrors WindTerm's layout
// (dock panes / menu / statusbar / triggers), code is our own.
#![allow(unused)]

mod re;
mod ssh_live;
mod ssh_relay;
#[cfg(unix)]
mod serial_live;
mod tcp_live;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};
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
    sftp: Option<tokio::sync::mpsc::UnboundedSender<ssh_live::SftpReq>>,
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
    // —— 串口/TCP（项5 live 模块；字段名对齐 WindTerm 属性表 session.target/serial.*）——
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
                sftp: None,
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
            sftp: None,
        },
    );
    Ok(id)
}

/// SSH 会话：russh 实连，认证序列/状态映射遵循 re/ssh_auth 语义（WindTerm 证据）
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
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    // 中继/代理拨号层（ssh_relay，实证 connectHost 分发语义）
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
    let user = user.filter(|u| !u.is_empty()).unwrap_or_else(|| {
        std::env::var("USER").unwrap_or_else(|_| "root".into())
    });
    // 默认密钥：~/.ssh/id_ed25519（WindTerm 自动发现语义简化版）
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
    .map_err(|e| e.to_string())?;

    let ssh_in = ctl.input;
    let rz = ctl.resize;
    let stop = ctl.stop;
    state.0.lock().unwrap().insert(
        id.clone(),
        Entry {
            writer: Box::new(ssh_live::SshInput(ssh_in)),
            resize: Box::new(move |r, c| {
                rz.send((c as u32, r as u32)).map_err(|_| "closed".to_string())
            }),
            child: None,
            closer: Some(Box::new(move || {
                let _ = stop.send(());
            })),
            sftp: Some(ctl.sftp),
        },
    );
    Ok(id)
}

/// 串口会话：实连层 serialport 4；选项表键名按二进制实读（serial.baudRate/dataBits/parity/stopBits/flowControl）
/// 语义路径：re::serial::settings_from_options（默认/归一/校验全在证据模块）；
/// 实证：运行期改选项无效（setOption 空函数体）→ 本命令仅在 open 时读参，重连生效。
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
        let _ = (path, settings);
        return Err("串口会话当前仅支持 Unix 平台（termios 实现）".to_string());
    }
    #[cfg(unix)]
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
    let (host_label, ctl) =
        serial_live::spawn_session(app.clone(), id.clone(), target.trim(), &opts)
            .map_err(|e| e.to_string())?;
    let _ = host_label; // 标题用会话名；host=portName 实证已在 serial_live 内
    let stop = ctl.stop;
    state.0.lock().unwrap().insert(
        id.clone(),
        Entry {
            writer: Box::new(ctl.writer), // Box<dyn SerialPort>: Write + Send（trait 超界）
            resize: Box::new(|_r, _c| Ok(())), // 串口无窗口尺寸概念
            child: None,
            sftp: None,
            closer: Some(Box::new(move || {
                let _ = stop.send(());
            })),
        },
    );
    Ok(id)
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
    let (_label, ctl) = tcp_live::spawn_session(app.clone(), id.clone(), params)
        .map_err(|e| e.to_string())?;
    let tcp_live::TcpCtl { writer, stop, killer } = ctl;
    state.0.lock().unwrap().insert(
        id.clone(),
        Entry {
            writer,
            resize: Box::new(|_r, _c| Ok(())), // 裸 TCP 无尺寸语义（实证：桥层无 resizeWindow）
            child: None,
            sftp: None,
            closer: Some(Box::new(move || {
                let _ = stop.send(()); // 通知 pump
                killer(); // shutdown(Both)/kill child → 读线程退出 → detach 信号对
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
            connect_ssh,
            connect_serial,
            connect_tcp,
            sftp_list,
            sftp_download,
            sftp_upload,
            sessions_load,
            sessions_save,
            ui_state_save,
            ui_state_load,
            complete_input,
            fs_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running hurricaneTerm");
}

fn main() {
    run();
}