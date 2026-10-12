// hurricaneTerm — SSH 实连层（russh 0.64）
// 语义遵循 re/ssh_auth.rs（WindTerm 认证编排：方法顺序/成功判定/状态映射，均有反编译证据）；
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
use tokio::sync::mpsc;

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
}

pub enum SftpReq {
    List { path: String, reply: oneshot::Sender<Result<Vec<SftpEntry>, String>> },
    Download { remote: String, local: String, reply: oneshot::Sender<Result<(), String>> },
    Upload { local: String, remote: String, reply: oneshot::Sender<Result<(), String>> },
}

/// TOFU 主机密钥：~/.config/<id>/known_hosts（"host|sha256:..." 行）。
/// 语义对应 WindTerm eraseServerKnown（有已知项则严格比对）。
struct Tofu {
    host: String,
    file: PathBuf,
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

struct WtHandler {
    tofu: Tofu,
    log: Vec<String>, // 收集 check 阶段日志（简化：直接 eprintln）
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

/// AuthResult -> libssh 风格码（证据：PARTIAL 计入 isOperationSuccess{0,2}）
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
        let _ = app.emit("pty-exit", OutPayload { id, data: String::new() });
    });

    Ok(SshCtl {
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
    let cfg = Arc::new(Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)), // SshSession::keepAlive 语义
        ..Default::default()
    });
    let handler = WtHandler {
        tofu: Tofu {
            host: host.clone(),
            file: config_dir.join("known_hosts"),
        },
        log: Vec::new(),
    };
    let mut session = match proxy {
        ssh_relay::Proxy::None => client::connect(cfg, (host.as_str(), port), handler).await?,
        proxy => {
            // 实证架构：libssh 连本地中继 -> 本层 dial_any 统一拨号（SOCKS5/HTTP/ProxyCommand/System）
            let h = host.clone();
            let dialed = tokio::task::spawn_blocking(move || {
                ssh_relay::dial_any(&proxy, &h, port, std::time::Duration::from_secs(30))
            })
            .await
            .map_err(|e| e.to_string())??;
            let (rd, wr) = dialed.split();
            let stream = ssh_relay::to_tokio(rd, wr).await?;
            client::connect_stream(cfg, stream, handler).await?
        }
    };
    log(&app, &id, format!("已连接 {host}:{port} (ssh-2)"));

    // —— 认证序列：WindTerm 顺序 none -> publickey -> password -> keyboard-interactive ——
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
            match load_secret_key(expand(kp), None) {
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
                // keyboard-interactive 兜底（WindTerm op=3）：start -> 逐轮应答
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

    // —— 自动登录 expect 引擎（re/auto_login.rs，OneKey 默认规则：login:/password:）——
    use crate::re::auto_login::{AccountPart, OneKeyExpect};
    let mut okm = OneKeyExpect::default();
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
                tokio::spawn(async move {
                    match req {
                        SftpReq::List { path, reply } => {
                            let out = do_sftp_list(&h, &path, &sink2, &id2).await;
                            let _ = reply.send(out);
                        }
                        SftpReq::Download { remote, local, reply } => {
                            let out = do_sftp_xfer(&h, &remote, &local, false, &sink2, &id2).await;
                            let _ = reply.send(out);
                        }
                        SftpReq::Upload { local, remote, reply } => {
                            let out = do_sftp_xfer(&h, &remote, &local, true, &sink2, &id2).await;
                            let _ = reply.send(out);
                        }
                    }
                });
            }
            m = reader.wait() => {
                match m {
                    Some(ChannelMsg::Data { data }) => {
                        let s = String::from_utf8_lossy(&data).to_string();
                        app.emit("pty-output", id.clone(), s.clone());
                        // WindTerm auto-login 语义：输出流尾窗匹配 OneKey expect 规则 -> 应答
                        if !s.is_empty() {
                            al_tail.push_str(&s);
                            if al_tail.len() > 240 { let cut = al_tail.len()-240; al_tail.drain(..cut); }
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
                        let s = String::from_utf8_lossy(&data).to_string();
                        app.emit("pty-output", id.clone(), s);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            _ = stop_rx.recv() => { break; }
        }
    }
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

async fn do_sftp_list(
    h: &std::sync::Arc<client::Handle<WtHandler>>,
    path: &str,
    _sink: &Sink,
    _id: &str,
) -> Result<Vec<SftpEntry>, String> {
    let sftp = open_sftp(h).await?;
    let rd = sftp.read_dir(path.to_string()).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in rd {
        let md = e.metadata();
        out.push(SftpEntry {
            name: e.file_name(),
            path: e.path(),
            is_dir: md.is_dir(),
            size: md.len(),
            mtime: md.mtime.unwrap_or(0) as u64,
        });
        if out.len() >= 3000 { break; }
    }
    out.sort_by(|a, b| (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase())));
    Ok(out)
}

/// dir=false: remote->local 下载；dir=true: local->remote 上传。进度事件 transfer-progress。
async fn do_sftp_xfer(
    h: &std::sync::Arc<client::Handle<WtHandler>>,
    remote: &str,
    local: &str,
    upload: bool,
    sink: &Sink,
    id: &str,
) -> Result<(), String> {
    let sftp = open_sftp(h).await?;
    let name = remote.rsplit(['/', '\\']).next().unwrap_or(remote).to_string();
    let total = if upload {
        std::fs::metadata(local).map(|m| m.len()).unwrap_or(0)
    } else {
        sftp.metadata(remote.to_string()).await.map(|m| m.len()).unwrap_or(0)
    };
    let mut done: u64 = 0;
    let mut emit = |done: u64, last: bool| {
        sink.emit(
            "transfer-progress",
            id.to_string(),
            format!("{}\t{}\t{}\t{}\t{}", name, done, total, if upload { "up" } else { "down" }, if last { 1 } else { 0 }),
        );
    };
    if !upload {
        let mut rf = sftp.open(remote.to_string()).await.map_err(|e| e.to_string())?;
        let mut lf = std::fs::File::create(local).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 32768];
        loop {
            let n = rf.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 { break; }
            std::io::Write::write_all(&mut lf, &buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            emit(done, false);
        }
    } else {
        let mut wf = sftp.create(remote.to_string()).await.map_err(|e| e.to_string())?;
        let data = std::fs::read(local).map_err(|e| e.to_string())?;
        for chunk in data.chunks(32768) {
            wf.write_all(chunk).await.map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            emit(done, false);
        }
        wf.flush().await.map_err(|e| e.to_string())?;
        wf.close().await.map_err(|e| e.to_string())?;
    }
    emit(done, true);
    Ok(())
}

fn log(app: &Sink, id: &str, msg: String) {
    app.emit("re-log", id.to_string(), msg);
}

fn expand(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else {
        PathBuf::from(p)
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
