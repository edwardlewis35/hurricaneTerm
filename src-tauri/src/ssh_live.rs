// hurricaneTerm — SSH 实连层（russh 0.64）
// 语义遵循 re/ssh_auth.rs（WindTerm 认证编排：方法顺序/成功判定/状态映射，均有反编译证据）；
// 本文件只做协议 IO 接线，复用 Entry/pty-* 事件模型，前端零改动。
#![allow(dead_code)]

use crate::re::ssh_auth::{map_auth_state, AuthState};
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

/// 会话控制句柄（resize/stop 走通道）
pub struct SshCtl {
    pub input: mpsc::UnboundedSender<Vec<u8>>,
    pub resize: mpsc::UnboundedSender<(u32, u32)>,
    pub stop: mpsc::UnboundedSender<()>,
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
) -> io::Result<SshCtl> {
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (rz_tx, mut rz_rx) = mpsc::unbounded_channel::<(u32, u32)>();
    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<()>();

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
        )) {
            eprintln!("[ssh] {e}");
        }
        let _ = app.emit("pty-exit", OutPayload { id, data: String::new() });
    });

    Ok(SshCtl {
        input: in_tx,
        resize: rz_tx,
        stop: stop_tx,
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
    let mut session = client::connect(cfg, (host.as_str(), port), handler).await?;
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

    // —— shell 通道 ——
    let chan = session.channel_open_session().await?;
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
            m = reader.wait() => {
                match m {
                    Some(ChannelMsg::Data { data }) => {
                        let s = String::from_utf8_lossy(&data).to_string();
                        app.emit("pty-output", id.clone(), s);
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
    let _ = session
        .disconnect(Disconnect::ByApplication, "bye", "en")
        .await;
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
}
