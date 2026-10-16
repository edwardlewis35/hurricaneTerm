// hurricaneTerm — SSH 实连层（russh 0.64）
// 认证编排（方法顺序/成功判定/状态映射）见 re/ssh_auth.rs；
// 本文件只做协议 IO 接线，复用 Entry/pty-* 事件模型，前端零改动。
#![allow(dead_code)]

use crate::re::ssh_auth::{map_auth_state, AuthState};
use crate::ssh_relay;
use crate::{AppHandle, Emitter, OutPayload};

/// 事件汇：生产走 AppHandle，测试可注入收集器——同一代码路径 e2e 可测
#[derive(Clone)]
pub struct Sink(pub std::sync::Arc<dyn Fn(&str, String, String) + Send + Sync>);
impl Sink {
    pub fn emit(&self, topic: &str, id: String, data: String) {
        (self.0)(topic, id, data)
    }
    pub fn from_app(app: AppHandle) -> Self {
        Sink(std::sync::Arc::new(move |t, id, d| {
            let _ = app.emit(t, OutPayload { id, data: d });
        }))
    }
}
use russh::keys::PublicKeyOrCertificate;
use russh::client::{self, AuthResult, Config, Handler};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tokio::sync::mpsc;
use tokio::sync::Notify;
use russh_sftp::client::{SftpSession, error::Error as SftpError};
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};

#[cfg(test)]
#[path = "ssh_session_tests.rs"]
mod session_tests;

/// Entry.writer 的适配：前端写入 -> 转发到 SSH 通道
pub struct SshInput(pub mpsc::UnboundedSender<Vec<u8>>);
impl Write for SshInput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.send(buf.to_vec()).map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 会话控制句柄（resize/stop/sftp 走通道）
pub struct SshCtl {
    pub alive: Arc<AtomicBool>,
    pub input: mpsc::UnboundedSender<Vec<u8>>,
    pub resize: mpsc::UnboundedSender<(u32, u32)>,
    pub stop: mpsc::UnboundedSender<()>,
    pub sftp: mpsc::UnboundedSender<SftpReq>,
}

#[derive(Clone, serde::Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
    pub permissions: Option<u32>,
    pub is_link: bool,
}

/// Pause retains the open streams and offsets in this session. It is not a
/// persistent resume mechanism; cancellation leaves the uniquely named .part.
#[derive(Clone, Default)]
pub struct TransferControl {
    state: Arc<AtomicU8>,
    notify: Arc<Notify>,
}
impl TransferControl {
    pub fn new() -> Self { Self::default() }
    pub fn pause(&self) {
        let _ = self.state.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
        self.notify.notify_one();
    }
    pub fn resume(&self) {
        let _ = self.state.compare_exchange(1, 0, Ordering::SeqCst, Ordering::SeqCst);
        self.notify.notify_one();
    }
    pub fn cancel(&self) {
        self.state.store(2, Ordering::SeqCst);
        self.notify.notify_one();
    }
    pub fn is_cancelled(&self) -> bool { self.state.load(Ordering::SeqCst) == 2 }
}

pub enum SftpReq {
    AgentExec { request: crate::agent_exec::ExecRequest, control: Arc<crate::agent_exec::ExecControl>, sink: crate::agent_exec::OutputSink, reply: oneshot::Sender<Result<crate::agent_exec::ExecResult, String>> },
    List { path: String, reply: oneshot::Sender<Result<Vec<SftpEntry>, String>> },
    Download { remote: String, local: String, reply: oneshot::Sender<Result<(), String>> },
    Upload { local: String, remote: String, reply: oneshot::Sender<Result<(), String>> },
    Realpath { path: String, reply: oneshot::Sender<Result<String, String>> },
    Stat { path: String, reply: oneshot::Sender<Result<Option<SftpEntry>, String>> },
    Mkdir { path: String, reply: oneshot::Sender<Result<(), String>> },
    CreateFile { path: String, reply: oneshot::Sender<Result<(), String>> },
    Rename { from: String, to: String, reply: oneshot::Sender<Result<(), String>> },
    Copy { from: String, to: String, move_item: bool, reply: oneshot::Sender<Result<(), String>> },
    Remove { path: String, recursive: bool, reply: oneshot::Sender<Result<(), String>> },
    ReadFile { path: String, reply: oneshot::Sender<Result<crate::files::FilePreview, String>> },
    WriteFile { path: String, content: String, expected_modified: Option<u64>, expected_revision: Option<String>, force: bool, reply: oneshot::Sender<Result<(), String>> },
    Chmod { path: String, mode: u32, reply: oneshot::Sender<Result<(), String>> },
    Transfer { transfer_id: String, local: String, remote: String, upload: bool, policy: String, control: Arc<TransferControl>, reply: oneshot::Sender<Result<(), String>> },
}

/// TOFU 主机密钥：~/.config/<id>/known_hosts（"host|sha256:..." 行）。
/// TOFU：已有已知项则严格比对，首见才记录。
pub struct Tofu {
    pub host: String,
    pub file: PathBuf,
}

impl Tofu {
    fn lookup(&self, fp: &str) -> Option<bool> {
        let content = std::fs::read_to_string(&self.file).ok()?;
        let mine = format!("{}|{}", self.host, fp);
        let any_for_host = content
            .lines()
            .any(|l| l.split('|').next() == Some(self.host.as_str()));
        if !any_for_host {
            return None; // 首次：信任并记录
        }
        Some(content.lines().any(|l| l == mine))
    }
    fn record(&self, fp: &str) {
        use std::io::Write;
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)
        {
            let _ = writeln!(f, "{}|{}", self.host, fp);
        }
    }
}

pub struct WtHandler {
    pub tofu: Tofu,
    pub log: Vec<String>, // 收集 check 阶段日志（简化：直接 eprintln）
}

impl Handler for WtHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fp = format!("{:?}", key); // 稳定指纹表示（含类型+base64）
        Ok(match self.tofu.lookup(&fp) {
            None => {
                self.tofu.record(&fp);
                eprintln!("[ssh] TOFU: 已记录主机密钥 {}", self.tofu.host);
                true
            }
            Some(ok) => {
                if !ok {
                    eprintln!("[ssh] 主机密钥不匹配，拒绝连接（known_hosts 可删除该条目重试）");
                }
                ok
            }
        })
    }
}

/// AuthResult -> libssh 风格码（PARTIAL 计入成功集 {0,2}）
fn auth_code(r: &AuthResult) -> i32 {
    match r {
        AuthResult::Success => 0,
        AuthResult::Failure {
            partial_success, ..
        } => {
            if *partial_success {
                2
            } else {
                1
            }
        }
    }
}

pub fn spawn_session(
    app: AppHandle,
    id: String,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
    rows: u16,
    cols: u16,
    config_dir: PathBuf,
    proxy: ssh_relay::Proxy,
) -> io::Result<SshCtl> {
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (rz_tx, mut rz_rx) = mpsc::unbounded_channel::<(u32, u32)>();
    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<()>();
    let (sftp_tx, sftp_rx) = mpsc::unbounded_channel::<SftpReq>();
    let alive = Arc::new(AtomicBool::new(true));
    let session_alive = alive.clone();

    let app2 = app.clone();
    let id2 = id.clone();
    let host2 = host.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio rt");
        if let Err(e) = rt.block_on(run(
            Sink::from_app(app2),
            id2,
            host2,
            port,
            user,
            password,
            key_path,
            rows,
            cols,
            config_dir,
            in_rx,
            rz_rx,
            stop_rx,
            sftp_rx,
            proxy,
        )) {
            eprintln!("[ssh] {e}");
        }
        session_alive.store(false, Ordering::Release);
        let _ = app.emit("pty-exit", OutPayload { id, data: String::new() });
    });

    Ok(SshCtl {
        alive,
        input: in_tx,
        resize: rz_tx,
        stop: stop_tx,
        sftp: sftp_tx,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    app: Sink,
    id: String,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
    rows: u16,
    cols: u16,
    config_dir: PathBuf,
    mut in_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    mut rz_rx: mpsc::UnboundedReceiver<(u32, u32)>,
    mut stop_rx: mpsc::UnboundedReceiver<()>,
    mut sftp_rx: mpsc::UnboundedReceiver<SftpReq>,
    proxy: ssh_relay::Proxy,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Cancellation surrounds the whole session, including handshake, auth,
    // PTY requests and channel backpressure. A stop is not restricted to the
    // established shell's select loop.
    tokio::select! {
        biased;
        _ = stop_rx.recv() => Ok(()),
        result = run_session(app, id, host, port, user, password, key_path,
            rows, cols, config_dir, in_rx, rz_rx, sftp_rx, proxy) => result,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    app: Sink,
    id: String,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
    rows: u16,
    cols: u16,
    config_dir: PathBuf,
    mut in_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    mut rz_rx: mpsc::UnboundedReceiver<(u32, u32)>,
    mut sftp_rx: mpsc::UnboundedReceiver<SftpReq>,
    proxy: ssh_relay::Proxy,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cfg = Arc::new(Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)), // SshSession::keepAlive 语义
        nodelay: true, // interactive input should not wait for a Nagle batch
        ..Default::default()
    });
    let handler = WtHandler {
        tofu: Tofu {
            host: host.clone(),
            file: config_dir.join("known_hosts"),
        },
        log: Vec::new(),
    };
    let connect = async { Ok::<_, Box<dyn std::error::Error + Send + Sync>>(match proxy {
        ssh_relay::Proxy::None => client::connect(cfg, (host.as_str(), port), handler).await?,
        proxy => {
            // 架构：libssh 连本地中继 -> 本层 dial_any 统一拨号（SOCKS5/HTTP/ProxyCommand/System）
            let h = host.clone();
            let dialed = tokio::task::spawn_blocking(move || {
                ssh_relay::dial_any(&proxy, &h, port, std::time::Duration::from_secs(30))
            })
            .await
            .map_err(|e| e.to_string())??;
            match dialed {
                ssh_relay::Dialed::Tcp(socket) => {
                    // SOCKS / HTTP CONNECT already return a TCP tunnel. Avoid
                    // two bridging pumps, buffer copies and spawn_blocking
                    // round-trips for every subsequent SSH packet.
                    socket.set_nonblocking(true)?;
                    socket.set_nodelay(true)?;
                    let stream = tokio::net::TcpStream::from_std(socket)?;
                    client::connect_stream(cfg, stream, handler).await?
                }
                dialed => {
                    let (rd, wr, cancel) = dialed.split_with_cancel();
                    let stream = ssh_relay::to_tokio_with_cancel(rd, wr, cancel).await?;
                    client::connect_stream(cfg, stream, handler).await?
                }
            }
        }
    }) };
    let mut session = tokio::time::timeout(std::time::Duration::from_secs(30), connect)
        .await.map_err(|_| "SSH 连接或握手超时（30 秒）")??;
    log(&app, &id, format!("已连接 {host}:{port} (ssh-2)"));

    // —— 认证序列：none -> publickey -> password -> keyboard-interactive ——
    let mut authed = false;
    let mut steps: Vec<(&'static str, i32)> = Vec::new();

    let r = session.authenticate_none(&user).await?;
    let code = auth_code(&r);
    steps.push(("none", code));
    if code == 0 {
        authed = true;
    }

    if !authed {
        if let Some(kp) = &key_path {
            let key_path = expand(kp);
            match tokio::task::spawn_blocking(move || load_secret_key(key_path, None)).await? {
                Ok(key) => {
                    let pk = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha512));
                    let r = session.authenticate_publickey(&user, pk).await?;
                    let code = auth_code(&r);
                    steps.push(("publickey", code));
                    if code == 0 {
                        authed = true;
                    }
                }
                Err(e) => steps.push(("publickey", -1)),
            }
        }
    }

    if !authed {
        if let Some(pw) = &password {
            let r = session.authenticate_password(&user, pw).await?;
            let code = auth_code(&r);
            steps.push(("password", code));
            if code == 0 {
                authed = true;
            } else if code == 1 {
                // keyboard-interactive 兜底（op=3）：start -> 逐轮应答
                use russh::client::KeyboardInteractiveAuthResponse as Kbi;
                let mut resp = session
                    .authenticate_keyboard_interactive_start(&user, None)
                    .await?;
                let mut code2 = 1i32;
                loop {
                    match resp {
                        Kbi::Success => { code2 = 0; break }
                        Kbi::Failure { partial_success, .. } => { code2 = if partial_success { 2 } else { 1 }; break }
                        Kbi::InfoRequest { prompts, .. } => {
                            let answers = vec![pw.clone(); prompts.len().max(1)];
                            resp = session.authenticate_keyboard_interactive_respond(answers).await?;
                        }
                    }
                }
                steps.push(("keyboard-interactive", code2));
                if code2 == 0 { authed = true; }
            }
        }
    }

    for (m, c) in &steps {
        let st: AuthState = map_auth_state(*c);
        log(
            &app,
            &id,
            format!("auth {m} -> code {c} state {:?}", st as i32),
        );
    }
    if !authed {
        return Err("所有认证方法均失败".into());
    }

    // —— 自动登录 expect 引擎（re/auto_login.rs，自动登录 默认规则：login:/password:）——
    use crate::re::auto_login::{AccountPart, AutoLoginExpect};
    let mut okm = AutoLoginExpect::default();
    okm.compile_expects(AccountPart::Username, &[]);
    okm.compile_expects(AccountPart::Password, &[]);
    let mut al_tail = String::new();

    // —— shell 通道 ——
    let chan = session.channel_open_session().await?;
    let ssh_handle = std::sync::Arc::new(session); // channel_open_session 取 &self，Arc 共享
    let (mut reader, chan) = chan.split();
    chan.request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await?;
    chan.request_shell(true).await?;
    log(&app, &id, "shell 已启动".into());
    let mut stdout_decoder = crate::terminal_io::Utf8Decoder::default();
    let mut stderr_decoder = crate::terminal_io::Utf8Decoder::default();
    // JoinSet aborts these tasks on drop. Closing a tab cannot leave detached
    // transfers retaining SSH handle clones after the shell has been removed.
    let mut sftp_jobs = tokio::task::JoinSet::new();

    loop {
        tokio::select! {
            Some(b) = in_rx.recv() => {
                if chan.data_bytes(bytes::Bytes::from(b)).await.is_err() { break; }
            }
            Some((c, r)) = rz_rx.recv() => {
                let _ = chan.window_change(c, r, 0, 0).await;
            }
            Some(req) = sftp_rx.recv() => {
                let h = ssh_handle.clone();
                let sink2 = app.clone();
                let id2 = id.clone();
                sftp_jobs.spawn(async move {
                    handle_sftp_request(&h, req, &sink2, &id2).await;
                });
            }
            Some(_) = sftp_jobs.join_next(), if !sftp_jobs.is_empty() => {}
            m = reader.wait() => {
                match m {
                    Some(ChannelMsg::Data { data }) => {
                        let s = stdout_decoder.push(&data);
                        if !s.is_empty() { app.emit("pty-output", id.clone(), s.clone()); }
                        // auto-login：输出流尾窗匹配 自动登录 expect 规则 -> 应答
                        if !s.is_empty() {
                            crate::terminal_io::append_tail(&mut al_tail, &s, 240);
                            if okm.match_account_expect(AccountPart::Username, &al_tail) {
                                let _ = chan.data_bytes(bytes::Bytes::from(format!("{}\r", user))).await;
                                al_tail.clear();
                                log(&app, &id, "auto-login: username 已应答".into());
                            } else if password.is_some() && okm.match_account_expect(AccountPart::Password, &al_tail) {
                                let _ = chan.data_bytes(bytes::Bytes::from(format!("{}\r", password.as_deref().unwrap_or("")))).await;
                                al_tail.clear();
                                log(&app, &id, "auto-login: password 已应答".into());
                            }
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let s = stderr_decoder.push(&data);
                        if !s.is_empty() { app.emit("pty-output", id.clone(), s); }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    for decoder in [&mut stdout_decoder, &mut stderr_decoder] {
        let tail = decoder.finish();
        if !tail.is_empty() { app.emit("pty-output", id.clone(), tail); }
    }
    sftp_jobs.abort_all();
    let _ = ssh_handle
        .disconnect(Disconnect::ByApplication, "bye", "en")
        .await;
    Ok(())
}

async fn open_sftp(h: &std::sync::Arc<client::Handle<WtHandler>>)
    -> Result<russh_sftp::client::SftpSession, String> {
    let chan = h.channel_open_session().await.map_err(|e| e.to_string())?;
    chan.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
    russh_sftp::client::SftpSession::new(chan.into_stream())
        .await
        .map_err(|e| e.to_string())
}

async fn handle_sftp_request(h: &Arc<client::Handle<WtHandler>>, req: SftpReq, sink: &Sink, id: &str) {
    match req {
        SftpReq::AgentExec { request, control, sink, reply } => {
            let _ = reply.send(crate::agent_exec::execute_ssh(h, &request, control, sink).await);
        }
        SftpReq::List { path, reply } => { let _ = reply.send(do_sftp_list(h, &path, sink, id).await); }
        SftpReq::Realpath { path, reply } => { let _ = reply.send(async {
            let s = open_sftp(h).await?;
            s.canonicalize(remote_input(&s, &path).await?).await.map_err(|e| e.to_string())
        }.await); }
        SftpReq::Stat { path, reply } => { let _ = reply.send(async {
            let s = open_sftp(h).await?;
            let path = remote_lookup(&s, &path).await?;
            Ok(remote_stat(&s, &path).await?.map(|md| sftp_entry(&path, &md)))
        }.await); }
        SftpReq::Mkdir { path, reply } => { let _ = reply.send(async {
            let s = open_sftp(h).await?;
            let path = remote_target(&s, &path).await?;
            ensure_remote_absent(&s, &path).await?;
            s.create_dir(path).await.map_err(|e| e.to_string())
        }.await); }
        SftpReq::CreateFile { path, reply } => { let _ = reply.send(async {
            let s = open_sftp(h).await?;
            let path = remote_target(&s, &path).await?;
            let file = s.open_with_flags(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE)
                .await.map_err(|e| e.to_string())?;
            file.close().await.map_err(|e| e.to_string())
        }.await); }
        SftpReq::Rename { from, to, reply } => { let _ = reply.send(do_remote_copy(h, &from, &to, true).await); }
        SftpReq::Copy { from, to, move_item, reply } => { let _ = reply.send(do_remote_copy(h, &from, &to, move_item).await); }
        SftpReq::Remove { path, recursive, reply } => { let _ = reply.send(do_remote_remove(h, &path, recursive).await); }
        SftpReq::ReadFile { path, reply } => { let _ = reply.send(async {
            let s = open_sftp(h).await?;
            let path = remote_input(&s, &path).await?;
            let (bytes, md) = read_remote_bounded(&s, &path).await?;
            crate::files::preview_bytes(&bytes, md.mtime.unwrap_or(0) as u64 * 1000, md.len())
        }.await); }
        SftpReq::WriteFile { path, content, expected_modified, expected_revision, force, reply } => {
            let _ = reply.send(do_remote_write(h, &path, &content, expected_modified, expected_revision.as_deref(), force).await);
        }
        SftpReq::Chmod { path, mode, reply } => { let _ = reply.send(async {
            if mode > 0o7777 { return Err("权限必须是 0000 到 7777 的八进制值".into()); }
            let s = open_sftp(h).await?;
            let path = remote_target(&s, &path).await?;
            let md = remote_stat(&s, &path).await?.ok_or("文件不存在")?;
            if md.file_type().is_symlink() { return Err("不能修改符号链接目标的权限".into()); }
            s.set_metadata(path, FileAttributes { permissions: Some(mode), ..Default::default() })
                .await.map_err(|e| e.to_string())
        }.await); }
        SftpReq::Transfer { transfer_id, local, remote, upload, policy, control, reply } => {
            let out = do_sftp_transfer(h, &transfer_id, &remote, &local, upload, &policy, &control, sink, id).await;
            let _ = reply.send(out);
        }
        // Compatibility calls also stream and never implicitly overwrite an existing file.
        SftpReq::Upload { local, remote, reply } => {
            let _ = reply.send(do_sftp_transfer(h, &uuid::Uuid::new_v4().to_string(), &remote, &local, true, "error", &TransferControl::new(), sink, id).await);
        }
        SftpReq::Download { remote, local, reply } => {
            let _ = reply.send(do_sftp_transfer(h, &uuid::Uuid::new_v4().to_string(), &remote, &local, false, "error", &TransferControl::new(), sink, id).await);
        }
    }
}

fn sftp_entry(path: &str, md: &FileAttributes) -> SftpEntry {
    SftpEntry {
        name: if path == "/" { "/".to_string() } else { path.rsplit('/').next().unwrap_or(path).to_string() }, path: path.to_string(),
        is_dir: md.file_type().is_dir(), is_link: md.file_type().is_symlink(),
        size: md.len(), mtime: md.mtime.unwrap_or(0) as u64,
        permissions: md.permissions.map(|mode| mode & 0o7777),
    }
}

// SFTP paths use POSIX separators even on Windows. The server, not a lexical
// cleanup, resolves symlinks before '..'. Mutations canonicalize only the parent.
async fn remote_input(s: &SftpSession, path: &str) -> Result<String, String> {
    if path.contains('\0') { return Err("路径不能包含 NUL".into()); }
    if path == "~" || path.starts_with("~/") {
        let home = s.canonicalize(".").await.map_err(|e| e.to_string())?;
        return Ok(if path == "~" { home } else { format!("{}/{}", home.trim_end_matches('/'), &path[2..]) });
    }
    Ok(if path.is_empty() { ".".to_string() } else { path.to_string() })
}

async fn remote_target(s: &SftpSession, path: &str) -> Result<String, String> {
    let p = remote_input(s, path).await?;
    let p = p.trim_end_matches('/');
    let (parent, name) = p.rsplit_once('/').unwrap_or((".", p));
    if name.is_empty() || name == "." || name == ".." { return Err("修改操作需要明确的文件或目录名".into()); }
    let parent = s.canonicalize(if parent.is_empty() { "/" } else { parent }).await.map_err(|e| e.to_string())?;
    Ok(remote_join(&parent, name))
}

async fn remote_lookup(s: &SftpSession, path: &str) -> Result<String, String> {
    let p = remote_input(s, path).await?;
    let leaf = p.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if matches!(leaf, "" | "." | "..") {
        s.canonicalize(p).await.map_err(|e| e.to_string())
    } else { remote_target(s, &p).await }
}

fn remote_join(parent: &str, name: &str) -> String { format!("{}/{}", parent.trim_end_matches('/'), name) }
fn remote_temp(target: &str, kind: &str) -> String {
    let parent = target.rsplit_once('/').map(|(parent, _)| parent).unwrap_or(".");
    remote_join(parent, &format!(".hurricane-{}.{}", uuid::Uuid::new_v4(), kind))
}
fn local_temp(target: &std::path::Path, kind: &str) -> PathBuf {
    target.with_file_name(format!(".hurricane-{}.{}", uuid::Uuid::new_v4(), kind))
}
fn valid_child(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err("服务器返回了不安全的文件名".into());
    }
    Ok(())
}
async fn remote_stat(s: &SftpSession, path: &str) -> Result<Option<FileAttributes>, String> {
    match s.symlink_metadata(path).await {
        Ok(md) => Ok(Some(md)),
        Err(SftpError::Status(st)) if st.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
async fn ensure_remote_absent(s: &SftpSession, path: &str) -> Result<(), String> {
    if remote_stat(s, path).await?.is_some() { Err(format!("目标已存在：{path}")) } else { Ok(()) }
}
async fn protect_remote(s: &SftpSession, path: &str) -> Result<(), String> {
    let home = s.canonicalize(".").await.map_err(|e| e.to_string())?;
    if path == "/" || path == home { Err("不能删除或移动整个根目录或家目录".into()) } else { Ok(()) }
}

async fn do_sftp_list(h: &Arc<client::Handle<WtHandler>>, path: &str, _sink: &Sink, _id: &str) -> Result<Vec<SftpEntry>, String> {
    let s = open_sftp(h).await?;
    let path = s.canonicalize(remote_input(&s, path).await?).await.map_err(|e| e.to_string())?;
    let rd = s.read_dir(&path).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for item in rd {
        let name = item.file_name(); valid_child(&name)?;
        let path = remote_join(&path, &name);
        let md = item.metadata();
        let mut entry = sftp_entry(&path, &md);
        if entry.is_link {
            // A link can be opened for navigation, but recursive operations use
            // lstat below and never traverse it.
            if let Ok(target) = s.metadata(&path).await { entry.is_dir = target.file_type().is_dir(); }
        }
        out.push(entry);
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

async fn read_remote_bounded(s: &SftpSession, path: &str) -> Result<(Vec<u8>, FileAttributes), String> {
    let md = s.metadata(path).await.map_err(|e| e.to_string())?;
    if md.file_type().is_dir() { return Err("无法预览目录".into()); }
    if md.len() > crate::files::IMAGE_LIMIT { return Err("文件超过预览大小限制（图片 15 MiB，文本 2 MiB）".into()); }
    let mut file = s.open(path).await.map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let result = (&mut file).take(crate::files::IMAGE_LIMIT + 1).read_to_end(&mut bytes).await.map_err(|e| e.to_string());
    let close = file.close().await.map_err(|e| e.to_string());
    result?; close?;
    if bytes.len() as u64 > crate::files::IMAGE_LIMIT { return Err("文件读取期间增长，超过预览大小限制".into()); }
    Ok((bytes, md))
}

async fn verify_remote_revision(s: &SftpSession, path: &str, modified: Option<u64>, revision: Option<&str>) -> Result<(), String> {
    let md = remote_stat(s, path).await?.ok_or("文件已被删除")?;
    if md.file_type().is_symlink() || !md.file_type().is_file() { return Err("只能编辑普通文件".into()); }
    if modified.is_some_and(|expected| expected != md.mtime.unwrap_or(0) as u64 * 1000) { return Err("文件已被其他程序修改，请重新打开或确认强制保存".into()); }
    if let Some(expected) = revision {
        let (bytes, _) = read_remote_bounded(s, path).await?;
        if crate::files::revision(&bytes) != expected { return Err("文件内容已被其他程序修改，请重新打开或确认强制保存".into()); }
    }
    Ok(())
}

async fn do_remote_write(h: &Arc<client::Handle<WtHandler>>, path: &str, content: &str, modified: Option<u64>, revision: Option<&str>, force: bool) -> Result<(), String> {
    if content.len() as u64 > crate::files::TEXT_LIMIT || content.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{c}')) { return Err("只能保存不超过 2 MiB 的文本文件".into()); }
    if !force && modified.is_none() && revision.is_none() { return Err("请先打开文件取得修订信息，再保存".into()); }
    let s = open_sftp(h).await?;
    let path = remote_target(&s, path).await?;
    let md = remote_stat(&s, &path).await?.ok_or("文件不存在，请先新建")?;
    if !md.file_type().is_file() { return Err("只能编辑普通文件".into()); }
    if md.len() > crate::files::TEXT_LIMIT { return Err("文本编辑上限为 2 MiB".into()); }
    let (current, _) = read_remote_bounded(&s, &path).await?;
    let preview = crate::files::preview_bytes(&current, md.mtime.unwrap_or(0) as u64 * 1000, md.len())?;
    if preview.kind != "text" { return Err("二进制文件和图片不能作为文本覆盖保存".into()); }
    if !force { verify_remote_revision(&s, &path, modified, revision).await?; }
    let part = remote_temp(&path, "part");
    let mut file = s.open_with_flags(&part, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE).await.map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).await.map_err(|e| format!("{e}；临时文件保留在 {part}"))?;
    file.flush().await.map_err(|e| format!("{e}；临时文件保留在 {part}"))?;
    file.close().await.map_err(|e| format!("{e}；临时文件保留在 {part}"))?;
    if let Some(mode) = md.permissions {
        s.set_metadata(&part, FileAttributes { permissions: Some(mode & 0o7777), ..Default::default() }).await.map_err(|e| e.to_string())?;
    }
    if !force { verify_remote_revision(&s, &path, modified, revision).await.map_err(|e| format!("{e}；临时文件保留在 {part}"))?; }
    commit_remote(&s, &part, &path, true).await
}

#[derive(Clone, Debug)]
struct TreeNode { path: String, parts: Vec<String>, is_dir: bool, size: u64 }

async fn remote_tree(s: &SftpSession, root: &str) -> Result<Vec<TreeNode>, String> {
    remote_tree_controlled(s, root, None).await
}
async fn remote_tree_controlled(s: &SftpSession, root: &str, control: Option<(&TransferControl, &TransferProgress<'_>)>) -> Result<Vec<TreeNode>, String> {
    let mut stack = vec![(root.to_string(), Vec::<String>::new())];
    let mut nodes = Vec::new();
    while let Some((path, parts)) = stack.pop() {
        if let Some((control, progress)) = control { checkpoint(control, progress).await?; }
        let md = remote_stat(s, &path).await?.ok_or_else(|| format!("源文件不存在：{path}"))?;
        if md.file_type().is_symlink() { return Err(format!("递归操作不跟随符号链接：{path}")); }
        let is_dir = md.file_type().is_dir();
        if !is_dir && !md.file_type().is_file() { return Err(format!("不支持传输特殊文件：{path}")); }
        if is_dir {
            for item in s.read_dir(&path).await.map_err(|e| e.to_string())? {
                let name = item.file_name(); valid_child(&name)?;
                let mut child = parts.clone(); child.push(name.clone());
                stack.push((remote_join(&path, &name), child));
            }
        }
        nodes.push(TreeNode { path, parts, is_dir, size: if is_dir { 0 } else { md.len() } });
        if nodes.len() > 100_000 { return Err("目录树超过 100000 项，请分批操作".into()); }
    }
    Ok(nodes)
}

fn local_tree(root: &std::path::Path) -> Result<Vec<TreeNode>, String> {
    local_tree_controlled(root, None)
}
fn local_tree_controlled(root: &std::path::Path, control: Option<&TransferControl>) -> Result<Vec<TreeNode>, String> {
    let mut stack = vec![(root.to_path_buf(), Vec::<String>::new())];
    let mut nodes = Vec::new();
    while let Some((path, parts)) = stack.pop() {
        if control.is_some_and(TransferControl::is_cancelled) { return Err("传输已取消".into()); }
        let md = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if md.is_symlink() { return Err(format!("递归操作不跟随符号链接：{}", path.display())); }
        if !md.is_dir() && !md.is_file() { return Err(format!("不支持传输特殊文件：{}", path.display())); }
        if md.is_dir() {
            for item in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                let name = item.file_name().into_string().map_err(|_| "无法传输非 UTF-8 文件名")?;
                let mut child = parts.clone(); child.push(name);
                stack.push((item.path(), child));
            }
        }
        nodes.push(TreeNode { path: path.to_string_lossy().into_owned(), parts, is_dir: md.is_dir(), size: if md.is_file() { md.len() } else { 0 } });
        if nodes.len() > 100_000 { return Err("目录树超过 100000 项，请分批操作".into()); }
    }
    Ok(nodes)
}

async fn do_remote_remove(h: &Arc<client::Handle<WtHandler>>, path: &str, recursive: bool) -> Result<(), String> {
    let s = open_sftp(h).await?;
    let path = remote_target(&s, path).await?; protect_remote(&s, &path).await?;
    let md = remote_stat(&s, &path).await?.ok_or("文件不存在")?;
    // Unlink links directly; never enumerate or remove their target.
    if !md.file_type().is_dir() { return s.remove_file(path).await.map_err(|e| e.to_string()); }
    if !recursive { return s.remove_dir(path).await.map_err(|e| e.to_string()); }
    let mut stack = vec![(path, false)];
    while let Some((path, visited)) = stack.pop() {
        let md = remote_stat(&s, &path).await?.ok_or("文件不存在")?;
        if md.file_type().is_dir() {
            if visited { s.remove_dir(path).await.map_err(|e| e.to_string())?; }
            else {
                stack.push((path.clone(), true));
                for item in s.read_dir(&path).await.map_err(|e| e.to_string())? {
                    let name = item.file_name(); valid_child(&name)?;
                    stack.push((remote_join(&path, &name), false));
                }
            }
        } else { s.remove_file(path).await.map_err(|e| e.to_string())?; }
    }
    Ok(())
}

async fn do_remote_copy(h: &Arc<client::Handle<WtHandler>>, from: &str, to: &str, move_item: bool) -> Result<(), String> {
    let s = open_sftp(h).await?;
    let from = remote_target(&s, from).await?;
    let to = remote_target(&s, to).await?;
    if to == from || to.starts_with(&(from.clone() + "/")) { return Err("目标不能是源自身或其子目录".into()); }
    ensure_remote_absent(&s, &to).await?;
    if move_item { protect_remote(&s, &from).await?; return s.rename(from, to).await.map_err(|e| e.to_string()); }
    for node in remote_tree(&s, &from).await? {
        let target = node.parts.iter().fold(to.clone(), |p, name| remote_join(&p, name));
        if node.is_dir { s.create_dir(target).await.map_err(|e| e.to_string())?; }
        else {
            let part = remote_temp(&target, "part");
            let mut input = s.open(&node.path).await.map_err(|e| e.to_string())?;
            let mut output = s.open_with_flags(&part, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE).await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 65536];
            loop { let n = input.read(&mut buf).await.map_err(|e| e.to_string())?; if n == 0 { break; } output.write_all(&buf[..n]).await.map_err(|e| e.to_string())?; }
            input.close().await.map_err(|e| e.to_string())?;
            output.flush().await.map_err(|e| e.to_string())?;
            output.close().await.map_err(|e| e.to_string())?;
            commit_remote(&s, &part, &target, false).await?;
        }
    }
    Ok(())
}

// SFTP v3 rename fails if newpath exists. Explicit overwrite first preserves
// the old destination under a unique backup; failed replacement restores it.
async fn commit_remote(s: &SftpSession, part: &str, target: &str, overwrite: bool) -> Result<(), String> {
    let existing = remote_stat(s, target).await?;
    if let Some(md) = existing {
        if !overwrite { return Err(format!("目标已存在；完整临时文件保留在 {part}")); }
        if md.file_type().is_dir() || md.file_type().is_symlink() { return Err(format!("不能用普通文件覆盖目录或符号链接；临时文件保留在 {part}")); }
        let backup = remote_temp(target, "backup");
        s.rename(target, &backup).await.map_err(|e| format!("{e}；临时文件保留在 {part}"))?;
        if let Err(e) = s.rename(part, target).await {
            let restored = s.rename(&backup, target).await;
            return Err(format!("{e}；临时文件：{part}；原文件{}", if restored.is_ok() { "已恢复".to_string() } else { format!("保留在 {backup}") }));
        }
        s.remove_file(&backup).await.map_err(|e| format!("文件已保存，旧文件备份 {backup} 清理失败：{e}"))?;
    } else { s.rename(part, target).await.map_err(|e| format!("{e}；临时文件保留在 {part}"))?; }
    Ok(())
}

struct TransferProgress<'a> {
    sink: &'a Sink, session_id: &'a str, transfer_id: &'a str, name: String,
    upload: bool, done: u64, total: u64,
    emission: std::sync::Mutex<ProgressEmission>,
}
#[derive(Default)]
struct ProgressEmission {
    last: Option<(std::time::Instant, String)>,
}
impl TransferProgress<'_> {
    fn emit(&self, status: &str, error: Option<&str>) {
        self.emit_at(status, error, std::time::Instant::now());
    }
    // One UI update per 100 ms during steady transfer. State transitions and
    // terminal/error events bypass the gate and carry the exact byte counts.
    fn emit_at(&self, status: &str, error: Option<&str>, now: std::time::Instant) {
        {
            let mut emission = self.emission.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if status == "running" && error.is_none() && emission.last.as_ref().is_some_and(|(last, previous)|
                previous == "running" && now.saturating_duration_since(*last) < std::time::Duration::from_millis(100)) {
                return;
            }
            emission.last = Some((now, status.to_string()));
        }
        let mut data = serde_json::json!({ "transferId": self.transfer_id, "sessionId": self.session_id,
            "name": self.name, "direction": if self.upload { "up" } else { "down" },
            "done": self.done, "total": self.total, "status": status });
        if let Some(error) = error { data["error"] = serde_json::Value::String(error.to_string()); }
        self.sink.emit("sftp-transfer-progress", self.session_id.to_string(), data.to_string());
        self.sink.emit("transfer-progress", self.session_id.to_string(), format!("{}\t{}\t{}\t{}\t{}", self.name, self.done, self.total,
            if self.upload { "up" } else { "down" }, if matches!(status, "completed" | "skipped" | "cancelled" | "failed") { 1 } else { 0 }));
    }
}
async fn checkpoint(control: &TransferControl, progress: &TransferProgress<'_>) -> Result<(), String> {
    let mut paused = false;
    loop {
        // notified() is created before loading to avoid missed resume/cancel.
        let notified = control.notify.notified();
        match control.state.load(Ordering::SeqCst) {
            2 => return Err("传输已取消；已接收的数据保留在 .part 临时文件".into()),
            1 => { if !paused { progress.emit("paused", None); paused = true; } notified.await; }
            _ => { if paused { progress.emit("running", None); } return Ok(()); }
        }
    }
}

fn local_target(path: &str) -> Result<PathBuf, String> {
    let path = expand(path);
    let path = if path.is_absolute() { path } else { std::env::current_dir().map_err(|e| e.to_string())?.join(path) };
    let name = path.file_name().ok_or("传输目标需要明确的文件或目录名")?;
    if matches!(path.components().next_back(), Some(std::path::Component::ParentDir | std::path::Component::CurDir)) { return Err("传输目标需要明确的文件或目录名".into()); }
    let parent = std::fs::canonicalize(path.parent().ok_or("目标没有父目录")?).map_err(|e| e.to_string())?;
    Ok(parent.join(name))
}
fn local_stat(path: &std::path::Path) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(path) { Ok(md) => Ok(Some(md)), Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None), Err(e) => Err(e.to_string()) }
}
fn safe_local_component(name: &str) -> bool {
    let mut components = std::path::Path::new(name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_))) || components.next().is_some() { return false; }
    #[cfg(windows)]
    {
        if name.ends_with('.') || name.ends_with(' ') || name.chars().any(|ch| "<>:\\|?*\"".contains(ch)) { return false; }
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9')) { return false; }
    }
    true
}
fn renamed_leaf(name: &str, index: u32) -> String {
    if let Some((stem, ext)) = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()) { format!("{stem} ({index}).{ext}") }
    else { format!("{name} ({index})") }
}
async fn remote_collision(s: &SftpSession, target: &str, policy: &str) -> Result<Option<String>, String> {
    if remote_stat(s, target).await?.is_none() { return Ok(Some(target.to_string())); }
    match policy {
        "skip" => Ok(None), "overwrite" => Ok(Some(target.to_string())),
        "rename" => {
            let (parent, name) = target.rsplit_once('/').ok_or("目标路径无效")?;
            for i in 1..=10000 { let candidate = remote_join(parent, &renamed_leaf(name, i)); if remote_stat(s, &candidate).await?.is_none() { return Ok(Some(candidate)); } }
            Err("无法分配唯一目标文件名".into())
        }
        _ => Err(format!("目标已存在，请选择覆盖、跳过或自动重命名：{target}")),
    }
}
fn local_collision(target: &std::path::Path, policy: &str) -> Result<Option<PathBuf>, String> {
    if local_stat(target)?.is_none() { return Ok(Some(target.to_path_buf())); }
    match policy {
        "skip" => Ok(None), "overwrite" => Ok(Some(target.to_path_buf())),
        "rename" => {
            let name = target.file_name().and_then(|s| s.to_str()).ok_or("目标文件名无效")?;
            for i in 1..=10000 { let candidate = target.with_file_name(renamed_leaf(name, i)); if local_stat(&candidate)?.is_none() { return Ok(Some(candidate)); } }
            Err("无法分配唯一目标文件名".into())
        }
        _ => Err(format!("目标已存在，请选择覆盖、跳过或自动重命名：{}", target.display())),
    }
}
fn commit_local(part: &std::path::Path, target: &std::path::Path, overwrite: bool) -> Result<(), String> {
    let backup = if let Some(md) = local_stat(target)? {
        if !overwrite { return Err(format!("目标已存在；完整临时文件保留在 {}", part.display())); }
        if !md.is_file() || md.is_symlink() { return Err(format!("不能用普通文件覆盖目录或符号链接；临时文件保留在 {}", part.display())); }
        let backup = local_temp(target, "backup");
        crate::files::rename_exclusive(target, &backup)?; Some(backup)
    } else { None };
    // Native exclusive rename publishes the complete file without replacing a
    // target created by a second writer after our initial stat check.
    if let Err(e) = crate::files::rename_exclusive(part, target) {
        let restoration = backup.as_ref().map(|b| crate::files::rename_exclusive(b, target));
        return Err(format!("{e}；临时文件保留在 {}{}", part.display(),
            if restoration.as_ref().is_some_and(|r| r.is_err()) { format!("；原文件保留在 {}", backup.unwrap().display()) } else { String::new() }));
    }
    if let Some(backup) = backup { std::fs::remove_file(backup).map_err(|e| format!("传输完成但备份清理失败：{e}"))?; }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn do_sftp_transfer(h: &Arc<client::Handle<WtHandler>>, transfer_id: &str, remote: &str, local: &str, upload: bool, policy: &str, control: &TransferControl, sink: &Sink, id: &str) -> Result<(), String> {
    let mut progress = TransferProgress { sink, session_id: id, transfer_id, name: if upload { expand(local).file_name().unwrap_or_default().to_string_lossy().into_owned() } else { remote.rsplit('/').next().unwrap_or(remote).to_string() }, upload, done: 0, total: 0, emission: Default::default() };
    progress.emit("preparing", None);
    let result: Result<bool, String> = async {
        if !matches!(policy, "overwrite" | "skip" | "rename" | "error") { return Err("无效的文件冲突策略".into()); }
        checkpoint(control, &progress).await?;
        let s = open_sftp(h).await?;
        if upload {
            let root = expand(local);
            let scan_control = control.clone();
            let nodes = tokio::task::spawn_blocking(move || local_tree_controlled(&root, Some(&scan_control)))
                .await.map_err(|e| e.to_string())??;
            checkpoint(control, &progress).await?;
            let remote = remote_target(&s, remote).await?;
            let Some(remote) = remote_collision(&s, &remote, policy).await? else { progress.emit("skipped", None); return Ok(false); };
            progress.total = nodes.iter().fold(0u64, |total, n| total.saturating_add(n.size)); progress.emit("running", None);
            for node in nodes {
                checkpoint(control, &progress).await?;
                let target = node.parts.iter().fold(remote.clone(), |p, name| remote_join(&p, name));
                if node.is_dir {
                    if let Some(md) = remote_stat(&s, &target).await? {
                        if !md.file_type().is_dir() { return Err(format!("目标不是普通目录：{target}")); }
                    } else { s.create_dir(&target).await.map_err(|e| e.to_string())?; }
                    continue;
                }
                let Some(target) = remote_collision(&s, &target, policy).await? else { progress.total = progress.total.saturating_sub(node.size); progress.emit("running", None); continue; };
                // Re-check the source immediately before opening; refuse links.
                let md = tokio::fs::symlink_metadata(&node.path).await.map_err(|e| e.to_string())?;
                if !md.is_file() || md.is_symlink() { return Err(format!("源文件已改变：{}", node.path)); }
                let part = remote_temp(&target, "part");
                let mut input = tokio::fs::File::open(&node.path).await.map_err(|e| e.to_string())?;
                let mut output = s.open_with_flags(&part, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE).await.map_err(|e| e.to_string())?;
                let stream: Result<(), String> = async {
                    let mut buf = vec![0u8; 65536]; let mut copied = 0u64;
                    loop {
                        checkpoint(control, &progress).await?;
                        let n = input.read(&mut buf).await.map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        output.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                        copied += n as u64; progress.done += n as u64; progress.emit("running", None);
                    }
                    if copied != node.size { return Err("源文件大小在传输期间改变，请重试".into()); }
                    output.flush().await.map_err(|e| e.to_string())?; Ok(())
                }.await;
                let closed = output.close().await.map_err(|e| format!("{e}；临时文件：{part}"));
                if let Err(e) = stream { return Err(format!("{e}；临时文件：{part}")); } closed?;
                checkpoint(control, &progress).await.map_err(|e| format!("{e}；临时文件：{part}"))?;
                commit_remote(&s, &part, &target, policy == "overwrite").await?;
            }
        } else {
            let remote = remote_target(&s, remote).await?;
            let nodes = remote_tree_controlled(&s, &remote, Some((control, &progress))).await?;
            let root = local_target(local)?;
            let Some(root) = local_collision(&root, policy)? else { progress.emit("skipped", None); return Ok(false); };
            progress.total = nodes.iter().fold(0u64, |total, n| total.saturating_add(n.size)); progress.emit("running", None);
            for node in nodes {
                checkpoint(control, &progress).await?;
                // Names valid on remote POSIX may not be safe local Windows
                // components. Reject rather than permitting escape or aliases.
                for name in &node.parts { if !safe_local_component(name) { return Err(format!("文件名不适合本地文件系统：{name}")); } }
                let target = node.parts.iter().fold(root.clone(), |p, name| p.join(name));
                if node.is_dir {
                    match tokio::fs::symlink_metadata(&target).await {
                        Ok(md) => if !md.is_dir() || md.is_symlink() { return Err(format!("目标不是普通目录：{}", target.display())); },
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => { tokio::fs::create_dir(&target).await.map_err(|e| e.to_string())?; }
                        Err(e) => return Err(e.to_string()),
                    }
                    continue;
                }
                let Some(target) = local_collision(&target, policy)? else { progress.total = progress.total.saturating_sub(node.size); progress.emit("running", None); continue; };
                let md = remote_stat(&s, &node.path).await?.ok_or("源文件已被删除")?;
                if !md.file_type().is_file() { return Err(format!("源文件已改变：{}", node.path)); }
                let part = local_temp(&target, "part");
                let mut input = s.open(&node.path).await.map_err(|e| e.to_string())?;
                let mut output = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await.map_err(|e| e.to_string())?;
                let stream: Result<(), String> = async {
                    let mut buf = vec![0u8; 65536]; let mut copied = 0u64;
                    loop {
                        checkpoint(control, &progress).await?;
                        let n = input.read(&mut buf).await.map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        output.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                        copied += n as u64; progress.done += n as u64; progress.emit("running", None);
                    }
                    if copied != node.size { return Err("源文件大小在传输期间改变，请重试".into()); }
                    output.flush().await.map_err(|e| e.to_string())?;
                    output.sync_all().await.map_err(|e| e.to_string())?; Ok(())
                }.await;
                // Finish Tokio's pending local write even on cancellation so
                // received bytes remain in the .part file before it is dropped.
                let flushed = output.flush().await.map_err(|e| format!("{e}；临时文件：{}", part.display()));
                let closed = input.close().await.map_err(|e| format!("{e}；临时文件：{}", part.display())); drop(output);
                if let Err(e) = stream { return Err(format!("{e}；临时文件：{}", part.display())); } flushed?; closed?;
                checkpoint(control, &progress).await.map_err(|e| format!("{e}；临时文件：{}", part.display()))?;
                commit_local(&part, &target, policy == "overwrite")?;
            }
        }
        Ok(true)
    }.await;
    match result {
        Ok(completed) => { if completed { progress.emit("completed", None); } Ok(()) }
        Err(error) => { progress.emit(if control.is_cancelled() { "cancelled" } else { "failed" }, Some(&error)); Err(error) }
    }
}

fn log(app: &Sink, id: &str, msg: String) {
    app.emit("re-log", id.to_string(), msg);
}

fn expand(p: &str) -> PathBuf {
    if p == "~" {
        dirs::home_dir().unwrap_or_default()
    } else if let Some(rest) = p.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else {
        PathBuf::from(p)
    }
}

#[cfg(test)]
mod sftp_safety_tests {
    use super::*;

    #[test]
    fn progress_throttles_running_updates_without_losing_exact_completion() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = events.clone();
        let sink = Sink(Arc::new(move |topic, _, data| observed.lock().unwrap().push((topic.to_string(), data))));
        let mut progress = TransferProgress { sink: &sink, session_id: "ssh", transfer_id: "copy", name: "data.bin".into(), upload: true,
            done: 0, total: 1000, emission: Default::default() };
        let base = std::time::Instant::now();
        progress.emit_at("preparing", None, base);
        for millisecond in 0..1000 {
            progress.done = millisecond;
            progress.emit_at("running", None, base + std::time::Duration::from_millis(millisecond));
        }
        progress.done = progress.total;
        progress.emit_at("completed", None, base + std::time::Duration::from_millis(999));
        let events = events.lock().unwrap();
        let updates: Vec<serde_json::Value> = events.iter().filter(|(topic, _)| topic == "sftp-transfer-progress")
            .map(|(_, data)| serde_json::from_str(data).unwrap()).collect();
        assert_eq!(updates.iter().filter(|event| event["status"] == "running").count(), 10);
        assert_eq!(updates.last().unwrap()["status"], "completed");
        assert_eq!(updates.last().unwrap()["done"], 1000);
        assert_eq!(updates.last().unwrap()["total"], 1000);
        assert_eq!(events.iter().filter(|(topic, _)| topic == "transfer-progress").count(), updates.len());
    }

    #[test]
    fn progress_pause_resume_errors_and_terminal_states_bypass_the_time_gate() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = events.clone();
        let sink = Sink(Arc::new(move |topic, _, data| {
            if topic == "sftp-transfer-progress" { observed.lock().unwrap().push(serde_json::from_str::<serde_json::Value>(&data).unwrap()); }
        }));
        let progress = TransferProgress { sink: &sink, session_id: "ssh", transfer_id: "copy", name: "data.bin".into(), upload: false,
            done: 73, total: 100, emission: Default::default() };
        let same_instant = std::time::Instant::now();
        for status in ["preparing", "running", "paused", "running", "failed", "cancelled", "skipped", "completed"] {
            progress.emit_at(status, None, same_instant);
        }
        progress.emit_at("running", Some("read error"), same_instant);
        progress.emit_at("running", Some("second error"), same_instant);
        let events = events.lock().unwrap();
        let statuses: Vec<&str> = events.iter().map(|event| event["status"].as_str().unwrap()).collect();
        assert_eq!(statuses, ["preparing", "running", "paused", "running", "failed", "cancelled", "skipped", "completed", "running", "running"]);
        assert_eq!(events.last().unwrap()["done"], 73);
        assert_eq!(events.last().unwrap()["error"], "second error");
    }

    #[tokio::test]
    async fn cloned_control_cancels_the_blocking_directory_scan() {
        let dir = scratch();
        let scan_dir = dir.clone();
        let control = TransferControl::new();
        let scan_control = control.clone();
        control.cancel();
        let result = tokio::task::spawn_blocking(move || local_tree_controlled(&scan_dir, Some(&scan_control))).await.unwrap();
        assert!(result.unwrap_err().contains("已取消"));
        // The path is task-owned; cancellation happens before any entries are read.
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn scratch() -> PathBuf {
        let p = std::env::temp_dir().join(format!("hurricane-sftp-unit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap(); p
    }

    #[test]
    fn no_clobber_publication_keeps_complete_partial() {
        let dir = scratch(); let target = dir.join("dest"); let part = dir.join("dest.part");
        std::fs::write(&target, b"existing").unwrap(); std::fs::write(&part, b"new").unwrap();
        assert!(commit_local(&part, &target, false).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"existing");
        assert_eq!(std::fs::read(&part).unwrap(), b"new");
        commit_local(&part, &target, true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new"); assert!(!part.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recursive_plan_keeps_empty_directories_and_sizes() {
        let dir = scratch(); std::fs::create_dir(dir.join("empty")).unwrap();
        std::fs::create_dir(dir.join("nested")).unwrap(); std::fs::write(dir.join("nested/file"), b"payload").unwrap();
        let nodes = local_tree(&dir).unwrap();
        assert_eq!(nodes.len(), 4); assert_eq!(nodes.iter().map(|n| n.size).sum::<u64>(), 7);
        assert!(nodes.iter().any(|n| n.is_dir && n.parts == vec!["empty"]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn traversal_refuses_links_and_destination_link_is_not_overwritten() {
        let dir = scratch(); let outside = scratch();
        std::fs::write(outside.join("safe"), b"original").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        assert!(local_tree(&dir).unwrap_err().contains("符号链接"));
        let target = dir.join("dest"); let part = dir.join("dest.part");
        std::os::unix::fs::symlink(outside.join("safe"), &target).unwrap(); std::fs::write(&part, b"new").unwrap();
        assert!(commit_local(&part, &target, true).is_err());
        assert_eq!(std::fs::read(outside.join("safe")).unwrap(), b"original"); assert!(part.exists());
        std::fs::remove_dir_all(dir).unwrap(); std::fs::remove_dir_all(outside).unwrap();
    }

    #[tokio::test]
    async fn pause_blocks_resume_releases_and_cancel_is_terminal() {
        let control = Arc::new(TransferControl::new()); control.pause();
        let copy = control.clone();
        let job = tokio::spawn(async move {
            let sink = Sink(Arc::new(|_, _, _| {}));
            let progress = TransferProgress { sink: &sink, session_id: "s", transfer_id: "t", name: "f".into(), upload: true, done: 0, total: 1, emission: Default::default() };
            checkpoint(&copy, &progress).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!job.is_finished()); control.resume(); assert!(job.await.unwrap().is_ok());
        control.cancel(); control.resume(); assert!(control.is_cancelled());
        let sink = Sink(Arc::new(|_, _, _| {}));
        let progress = TransferProgress { sink: &sink, session_id: "s", transfer_id: "t", name: "f".into(), upload: true, done: 0, total: 1, emission: Default::default() };
        assert!(checkpoint(&control, &progress).await.is_err());
    }

    #[test]
    fn conflict_rename_does_not_replace_original() {
        let dir = scratch(); let target = dir.join("report.txt");
        std::fs::write(&target, b"old").unwrap();
        assert_eq!(local_collision(&target, "skip").unwrap(), None);
        assert!(local_collision(&target, "error").is_err());
        assert_eq!(local_collision(&target, "rename").unwrap().unwrap(), dir.join("report (1).txt"));
        assert_eq!(std::fs::read(&target).unwrap(), b"old"); std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod e2e {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// 端到端：真连本机 sshd（key auth），跑完整 run() 生产路径，验证 shell 回显。
    #[test]
    #[ignore = "requires local sshd on 127.0.0.1:22"]
    fn ssh_local_echo() {
        let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let sink = Sink(Arc::new(move |t: &str, _id: String, d: String| {
            ev.lock().unwrap().push((t.to_string(), d));
        }));
        let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (_rz_tx, rz_rx) = mpsc::unbounded_channel::<(u32, u32)>();
        let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();
        let (_stx, srx) = mpsc::unbounded_channel::<SftpReq>();

        let user = std::env::var("USER").unwrap_or_else(|_| "el".into());
        let key = format!("{}/.ssh/id_ed25519", std::env::var("HOME").unwrap());
        let dir = std::env::temp_dir().join("wt-e2e-tofu");
        std::fs::remove_dir_all(&dir).ok();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let h = rt.spawn(async move {
            run(
                sink,
                "e2e".into(),
                "127.0.0.1".into(),
                22,
                user,
                None,
                Some(key),
                24,
                80,
                dir,
                in_rx,
                rz_rx,
                stop_rx,
                srx,
                ssh_relay::Proxy::None,
            )
            .await
        });

        std::thread::sleep(std::time::Duration::from_secs(2));
        in_tx.send(b"echo HELLO-$((1+1))\n".to_vec()).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));

        let snapshot: Vec<_> = events.lock().unwrap().clone();
        let auth_ok = snapshot.iter().any(|(_, d)| d.contains("auth publickey -> code 0"));
        let echoed = snapshot
            .iter()
            .any(|(t, d)| t == "pty-output" && d.contains("HELLO-2"));
        let _ = stop_tx.send(());
        drop(in_tx);
        rt.block_on(h).unwrap().unwrap();
        assert!(auth_ok, "认证序列未成功: {snapshot:?}");
        assert!(echoed, "shell 回显未到达: {snapshot:?}");
    }

    /// SFTP e2e：上传->列表可见->下载->字节一致。走生产 run()。
    #[test]
    #[ignore = "requires local sshd with sftp subsystem"]
    fn sftp_local_roundtrip() {
        let events = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let ev = events.clone();
        let sink = Sink(Arc::new(move |t: &str, _id: String, d: String| {
            ev.lock().unwrap().push((t.to_string(), d));
        }));
        let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (_rz_tx, rz_rx) = mpsc::unbounded_channel::<(u32, u32)>();
        let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();
        let (stx, srx) = mpsc::unbounded_channel::<SftpReq>();

        let user = std::env::var("USER").unwrap_or_else(|_| "el".into());
        let key = format!("{}/.ssh/id_ed25519", std::env::var("HOME").unwrap());
        let dir = std::env::temp_dir().join("wt-e2e-tofu2");
        std::fs::remove_dir_all(&dir).ok();

        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let h = rt.spawn(async move {
            run(sink, "sftp-e2e".into(), "127.0.0.1".into(), 22, user, None, Some(key),
                24, 80, dir, in_rx, rz_rx, stop_rx, srx, ssh_relay::Proxy::None).await
        });
        std::thread::sleep(std::time::Duration::from_secs(2));

        // 1) 列表
        let (rpl, rxr) = oneshot::channel();
        stx.send(SftpReq::List { path: "/tmp".into(), reply: rpl }).unwrap();
        let listing = rt.block_on(rxr).unwrap().unwrap();
        assert!(listing.iter().any(|e| !e.name.is_empty()), "列表为空");

        // 2) 上传 -> 3) 下载 -> 字节比对
        let src = std::env::temp_dir().join("wt-sftp-src.bin");
        let dst = std::env::temp_dir().join("wt-sftp-dst.bin");
        let payload: Vec<u8> = (0..70000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &payload).unwrap();
        let remote = "/tmp/wt-sftp-e2e.bin".to_string();
        let (rpl, rxr) = oneshot::channel();
        stx.send(SftpReq::Upload { local: src.to_string_lossy().into(), remote: remote.clone(), reply: rpl }).unwrap();
        rt.block_on(rxr).unwrap().unwrap();

        let (rpl, rxr) = oneshot::channel();
        stx.send(SftpReq::List { path: "/tmp".into(), reply: rpl }).unwrap();
        let listing = rt.block_on(rxr).unwrap().unwrap();
        assert!(listing.iter().any(|e| e.name == "wt-sftp-e2e.bin"), "上传后列表缺文件");

        let (rpl, rxr) = oneshot::channel();
        stx.send(SftpReq::Download { remote, local: dst.to_string_lossy().into(), reply: rpl }).unwrap();
        rt.block_on(rxr).unwrap().unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), payload, "下载字节不一致");

        let snap2 = events.lock().unwrap().clone();
        let prog_n = snap2.iter().filter(|(t, _)| t == "transfer-progress").count();
        assert!(prog_n > 0, "无进度事件");
        let _ = stop_tx.send(());
        drop(in_tx); drop(stx);
        rt.block_on(h).unwrap().unwrap();
        std::fs::remove_file(&src).ok(); std::fs::remove_file(&dst).ok();
        std::fs::remove_file("/tmp/wt-sftp-e2e.bin").ok();
    }
}
