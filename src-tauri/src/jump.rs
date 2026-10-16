// hurricaneTerm — jump.rs：跳板机（jump host）真实接线
// 原创代码 (Apache-2.0)。作为 ssh_relay 的一种代理类型（Proxy::Jump）接入。
//
// 设计要点：
// - ssh_relay::dial_any 是**同步** std-io 契约，且 ssh_live 在 spawn_blocking 线程里调用它，
//   因此 JumpOpener 保持同步签名即可：内部起一个**嵌套 current_thread runtime** 完成
//   「连跳板 → 认证 → open_direct_tcpip」，再用 os 管道把异步 Channel 适配成 std Read/Write。
// - 主机密钥沿用 ssh_live 的 TOFU（known_hosts 严格比对），不为跳板另开信任口子。
// - 认证顺序与主会话一致：none → publickey → password。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh::ChannelMsg;

use crate::ssh_live;
use crate::ssh_relay;

/// 跳板端点。user/password/key 复用主会话凭据。
#[derive(Clone, Debug)]
pub struct JumpSpec {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
}

/// 解析 user@host[:port] / user@[IPv6]:port；非法返回 None，调用方必须拒绝。
pub fn parse_spec(raw: &str, default_user: &str) -> Option<JumpSpec> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let (user, rest) = match s.split_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (default_user.to_string(), s),
    };
    if user.is_empty() || rest.is_empty() || user.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let (host, port) = if let Some(bracketed) = rest.strip_prefix('[') {
        let (host, suffix) = bracketed.split_once(']')?;
        host.parse::<std::net::Ipv6Addr>().ok()?;
        let port = if suffix.is_empty() { 22 } else { suffix.strip_prefix(':')?.parse::<u16>().ok()? };
        (host.to_string(), port)
    } else if rest.matches(':').count() > 1 {
        rest.parse::<std::net::Ipv6Addr>().ok()?;
        (rest.to_string(), 22)
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
            None => (rest.to_string(), 22),
        }
    };
    if host.is_empty() || port == 0 || host.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '@' | '/' | '\\' | '?' | '#' | '[' | ']')) {
        return None;
    }
    Some(JumpSpec {
        host,
        port,
        user,
        password: None,
        key_path: None,
    })
}

/// 构造注入 ssh_relay::Proxy::Jump 的同步 opener。
pub fn opener(spec: JumpSpec, config_dir: PathBuf) -> ssh_relay::JumpOpener {
    Box::new(move |t: &ssh_relay::Target| open_sync(spec.clone(), t.clone(), config_dir.clone()))
}

/// 管道对：消费端 read=远端来数据，write=发往远端。
#[derive(Debug)]
struct PipePair {
    rd: std::io::PipeReader,
    wr: std::io::PipeWriter,
}
impl Read for PipePair {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.rd.read(buf)
    }
}
impl Write for PipePair {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.wr.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.wr.flush()
    }
}

fn ioe<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

fn open_sync(
    spec: JumpSpec,
    target: ssh_relay::Target,
    config_dir: PathBuf,
) -> std::io::Result<ssh_relay::BoxedDuplex> {
    let (up_r, up_w) = std::io::pipe()?; // 远端 → 调用方
    let (dn_r, dn_w) = std::io::pipe()?; // 调用方 → 远端
    let (ready, ready_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("jump-pump".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(error) => { let _ = ready.send(Err(ioe(format!("跳板机任务启动失败：{error}")))); return; },
            };
            let notify_ready = ready.clone();
            if let Err(error) = rt.block_on(pump(spec, target, config_dir, up_w, dn_r, notify_ready)) {
                let _ = ready.send(Err(error));
            }
        })
        .map_err(ioe)?;
    // Do not turn a failed jump-host login into an unexplained EOF during the
    // target's SSH handshake. Return the original setup failure to dial_any.
    ready_rx.recv_timeout(Duration::from_secs(30)).map_err(|error| ioe(format!("跳板机连接或认证超时/中断：{error}")))??;
    Ok(Box::new(PipePair { rd: up_r, wr: dn_w }))
}

async fn pump(
    spec: JumpSpec,
    target: ssh_relay::Target,
    config_dir: PathBuf,
    mut up_w: std::io::PipeWriter,
    mut dn_r: std::io::PipeReader,
    ready: std::sync::mpsc::SyncSender<std::io::Result<()>>,
) -> std::io::Result<()> {
    let cfg = Arc::new(russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let handler = ssh_live::WtHandler {
        tofu: ssh_live::Tofu {
            host: spec.host.clone(),
            file: config_dir.join("known_hosts"),
        },
        log: Vec::new(),
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut session = tokio::time::timeout_at(deadline, russh::client::connect(cfg, (spec.host.as_str(), spec.port), handler))
        .await.map_err(|_| ioe("跳板机 DNS/TCP/SSH 握手超时"))?
        .map_err(|error| ioe(format!("跳板机 {}:{} 连接或主机密钥验证失败：{error}", spec.host, spec.port)))?;

    // 认证：none → publickey → password（与主会话同序，省去 keyboard-interactive）
    let mut authed = tokio::time::timeout_at(deadline, session.authenticate_none(&spec.user))
        .await.map_err(|_| ioe("跳板机认证协商超时"))?
        .map_err(|error| ioe(format!("跳板机认证协商失败：{error}")))?
        .success();
    let mut key_failure = String::new();
    if !authed {
        let kp = spec.key_path.clone().or_else(|| {
            std::env::var("HOME").ok().map(|h| format!("{h}/.ssh/id_ed25519"))
        });
        if let Some(kp) = kp {
            match load_secret_key(expand(&kp), None) {
                Ok(key) => {
                    let pk = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha512));
                    authed = tokio::time::timeout_at(deadline, session.authenticate_publickey(&spec.user, pk))
                        .await.map_err(|_| ioe("跳板机公钥认证超时"))?
                        .map_err(|error| ioe(format!("跳板机公钥认证失败：{error}")))?
                        .success();
                },
                Err(error) => { key_failure = format!("；私钥读取失败：{error}"); }
            }
        }
    }
    if !authed {
        if let Some(pw) = &spec.password {
            authed = tokio::time::timeout_at(deadline, session.authenticate_password(&spec.user, pw))
                .await.map_err(|_| ioe("跳板机密码认证超时"))?
                .map_err(|error| ioe(format!("跳板机密码认证失败：{error}")))?
                .success();
        }
    }
    if !authed {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("跳板机认证失败（jump auth failed）：{}@{}，服务器未接受提供的认证方式{key_failure}", spec.user, spec.host),
        ));
    }

    // 跳板之上开 direct-tcpip 到真实目标
    let ch = tokio::time::timeout_at(deadline, session.channel_open_direct_tcpip(&target.host, target.port as u32, "127.0.0.1", 0u32))
        .await.map_err(|_| ioe("跳板机 direct-tcpip 打开目标通道超时"))?
        .map_err(|error| ioe(format!("跳板机无法连接目标 {}:{}（direct-tcpip）：{error}", target.host, target.port)))?;
    ready.send(Ok(())).map_err(|_| ioe("跳板机连接请求已取消"))?;
    let (mut rd, wr) = ch.split();

    // 远端 → up_w（阻塞写放进 blocking 池，避免卡住 current_thread runtime）
    let up = Arc::new(Mutex::new(up_w));
    let dn = Arc::new(Mutex::new(dn_r));
    let out = tokio::spawn(async move {
        loop {
            match rd.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    let chunk = data.to_vec();
                    let up2 = Arc::clone(&up);
                    let ok = tokio::task::spawn_blocking(move || {
                        let mut g = up2.lock().expect("jump up lock");
                        g.write_all(&chunk).and_then(|_| g.flush()).is_ok()
                    })
                    .await;
                    if !matches!(ok, Ok(true)) {
                        break;
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
    });

    // dn_r（阻塞读）→ 通道
    let inn = tokio::spawn(async move {
        loop {
            let dn2 = Arc::clone(&dn);
            let chunk = tokio::task::spawn_blocking(move || {
                let mut g = dn2.lock().expect("jump dn lock");
                let mut b = vec![0u8; 8192];
                match g.read(&mut b) {
                    Ok(0) => None,
                    Ok(n) => {
                        b.truncate(n);
                        Some(b)
                    }
                    Err(_) => None,
                }
            })
            .await;
            let chunk = match chunk {
                Ok(Some(c)) => c,
                _ => break,
            };
            if wr.data_bytes(bytes::Bytes::from(chunk)).await.is_err() {
                break;
            }
        }
        let _ = wr.close().await;
    });

    let _ = tokio::join!(out, inn);
    // session 在此作用域结束前保持存活，通道随之关闭
    drop(session);
    Ok(())
}

fn expand(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(h) = std::env::var("HOME") {
            return format!("{h}/{rest}");
        }
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_full() {
        let s = parse_spec("ops@bastion.example:2222", "root").unwrap();
        assert_eq!(s.user, "ops");
        assert_eq!(s.host, "bastion.example");
        assert_eq!(s.port, 2222);
    }

    #[test]
    fn parse_default_port_and_user() {
        let s = parse_spec("bastion.example", "root").unwrap();
        assert_eq!(s.user, "root");
        assert_eq!(s.port, 22);
        let s2 = parse_spec("ops@10.0.0.9", "").unwrap();
        assert_eq!(s2.user, "ops");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_spec("", "root").is_none());
        assert!(parse_spec("@host", "root").is_none());
        assert!(parse_spec("user@", "root").is_none());
        assert!(parse_spec("host:notaport", "root").is_none());
    }
    #[test]
    fn parse_rejects_invalid_configured_addresses_instead_of_suggesting_direct_fallback() {
        for value in ["ops@host:0", "ops@host:65536", "ops@host:-1", "ops@host:", "ops@host name", "ops@user@host", "https://host:22", "ops@[::1", "ops@[bad]:22", "ops@[::1]:bad", "ops@host/path"] {
            assert!(parse_spec(value, "root").is_none(), "invalid jump address accepted: {value}");
        }
    }
    #[test]
    fn parse_supports_ipv6_without_ambiguous_port_splitting() {
        let spec = parse_spec("ops@[2001:db8::1]:2222", "root").unwrap();
        assert_eq!(spec.host, "2001:db8::1"); assert_eq!(spec.port, 2222);
        let spec = parse_spec("ops@2001:db8::1", "root").unwrap();
        assert_eq!(spec.host, "2001:db8::1"); assert_eq!(spec.port, 22);
    }
}
