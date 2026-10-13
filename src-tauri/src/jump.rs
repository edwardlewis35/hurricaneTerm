// hurricaneTerm — jump.rs：跳板机（JumpServers）真实接线
// 原创代码 (Apache-2.0)。语义对应 WindTerm 代理类型表里的 JumpServers（re/tunnel.rs PROXY_*）。
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

/// 跳板端点。user/password/key 复用主会话凭据（WindTerm JumpServers 属性表同语义简化版）。
#[derive(Clone, Debug)]
pub struct JumpSpec {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
}

/// 解析 "user@host[:port]"；非法返回 None（调用方回退直连）。
pub fn parse_spec(raw: &str, default_user: &str) -> Option<JumpSpec> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let (user, rest) = match s.split_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (default_user.to_string(), s),
    };
    if user.is_empty() || rest.is_empty() {
        return None;
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
        None => (rest.to_string(), 22),
    };
    if host.is_empty() {
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
    std::thread::Builder::new()
        .name("jump-pump".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(_) => return,
            };
            let _ = rt.block_on(pump(spec, target, config_dir, up_w, dn_r));
        })
        .map_err(ioe)?;
    Ok(Box::new(PipePair { rd: up_r, wr: dn_w }))
}

async fn pump(
    spec: JumpSpec,
    target: ssh_relay::Target,
    config_dir: PathBuf,
    mut up_w: std::io::PipeWriter,
    mut dn_r: std::io::PipeReader,
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
    let session = russh::client::connect(cfg, (spec.host.as_str(), spec.port), handler)
        .await
        .map_err(ioe)?;

    // 认证：none → publickey → password（与主会话同序，省去 keyboard-interactive）
    let mut authed = session
        .authenticate_none(&spec.user)
        .await
        .map_err(ioe)?
        .success();
    if !authed {
        let kp = spec.key_path.clone().or_else(|| {
            std::env::var("HOME").ok().map(|h| format!("{h}/.ssh/id_ed25519"))
        });
        if let Some(kp) = kp {
            if let Ok(key) = load_secret_key(expand(&kp), None) {
                let pk = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha512));
                authed = session
                    .authenticate_publickey(&spec.user, pk)
                    .await
                    .map_err(ioe)?
                    .success();
            }
        }
    }
    if !authed {
        if let Some(pw) = &spec.password {
            authed = session
                .authenticate_password(&spec.user, pw)
                .await
                .map_err(ioe)?
                .success();
        }
    }
    if !authed {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("jump auth failed: {}@{}", spec.user, spec.host),
        ));
    }

    // 跳板之上开 direct-tcpip 到真实目标
    let ch = session
        .channel_open_direct_tcpip(&target.host, target.port as u32, "127.0.0.1", 0u32)
        .await
        .map_err(ioe)?;
    let ch_in = ch.clone();

    // 远端 → up_w（阻塞写放进 blocking 池，避免卡住 current_thread runtime）
    let up = Arc::new(Mutex::new(up_w));
    let dn = Arc::new(Mutex::new(dn_r));
    let out = tokio::spawn(async move {
        let mut chr = ch_in;
        loop {
            match chr.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    let chunk = data.to_vec();
                    let up2 = Arc::clone(&up);
                    let ok = tokio::task::spawn_blocking(move || {
                        let mut g = up2.lock().expect("jump up lock");
                        g.write_all(&chunk).and_then(|_| g.flush()).is_ok()
                    })
                    .await;
                    if ok != Ok(true) {
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
            if ch.data_bytes(bytes::Bytes::from(chunk)).await.is_err() {
                break;
            }
        }
        let _ = ch.close().await;
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
}
