// hurricaneTerm — 裸 TCP 实连层
// 会话/代理类型与选项码语义见 re/tcp.rs；本层做真实 socket IO。
// socket 实体 = 进程 stdio 代理套接字：支持 直连 / Socks5 / Http(CONNECT) / ProxyCommand / System(env 近似)。
//
// 行为约束落地：
// - setOption 四键 → socket 选项码 0/1/5/6（re::tcp::tcp_socket_option 语义路径），未知键忽略。
// - setProxy 分流：Http→CONNECT-only(码3)、Socks5(码1)、其余→哨兵2=直连（不 setProxy）。
// - setProxyCommand 门控：仅 type=="ProxyCommand" 生效（command/workdir/env 三件）。
// - detach 无条件序列：detaching → disconnectFromHost → state=0 → detached。
// 近似项（代码注释标注）：System→env 代理近似；
// ProxyCommand 的 %h/%p 替换沿用 OpenSSH 惯例。
#![allow(dead_code)]

use crate::re::tcp::{
    proxy_type_code, resolve_proxy, ProxyCommand, ResolvedProxy, TcpBridge, OPT_KEEP_ALIVE,
    OPT_LOW_DELAY, OPT_RECV_BUF, OPT_SEND_BUF, PROXY_COMMAND,
};
use crate::ssh_live::Sink;
use crate::{AppHandle, Emitter, OutPayload};
use base64::Engine as _;
use std::io::{self, BufRead, Read, Write};
use std::net::{IpAddr, TcpStream};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::Duration;
use tokio::sync::mpsc;

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
pub const READ_POLL: Duration = Duration::from_millis(200);

/// 会话参数（main.rs 命令层组装；空串=未设置）
#[derive(Clone, Debug, Default)]
pub struct TcpParams {
    pub target: String, // "host:port" 或 host（session.target 键）
    pub port: u16,      // 独立端口（fallback）
    pub low_delay: Option<String>,
    pub keep_alive: Option<String>,
    pub send_buf: Option<String>,
    pub recv_buf: Option<String>,
    pub proxy_type: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_user: String,
    pub proxy_password: String,
    pub proxy_command: String,
    pub proxy_workdir: String,
    pub proxy_env: String, // 第4参：代理环境串
}

/// "host:port" / "[v6]:port" / "host" 解析；无端口段用 fallback
pub fn parse_target(target: &str, fallback: u16) -> (String, u16) {
    let t = target.trim();
    if let Some(rest) = t.strip_prefix('[') {
        if let Some(i) = rest.find(']') {
            let host = rest[..i].to_string();
            let port = rest[i + 1..]
                .strip_prefix(':')
                .and_then(|p| p.trim().parse().ok())
                .unwrap_or(fallback);
            return (host, port);
        }
    }
    if let Some((h, p)) = t.rsplit_once(':') {
        if !h.is_empty() && !h.contains(':') {
            if let Ok(pp) = p.trim().parse::<u16>() {
                return (h.to_string(), pp);
            }
        }
    }
    (t.to_string(), fallback)
}

/// 语义路径：TcpParams → TcpBridge（re::tcp 状态机做全部映射/门控决策）
pub fn bridge_from(params: &TcpParams) -> TcpBridge {
    let mut b = TcpBridge::default();
    if let Some(v) = &params.low_delay {
        b.set_option("session.tcpLowDelay", v);
    }
    if let Some(v) = &params.keep_alive {
        b.set_option("session.tcpKeepAlive", v);
    }
    if let Some(v) = &params.send_buf {
        b.set_option("session.tcpSendBufferSize", v);
    }
    if let Some(v) = &params.recv_buf {
        b.set_option("session.tcpReceiveBufferSize", v);
    }
    if !params.proxy_type.is_empty() {
        b.set_proxy(
            &params.proxy_type,
            &params.proxy_host,
            params.proxy_port,
            &params.proxy_user,
            &params.proxy_password,
        );
    }
    if !params.proxy_command.is_empty() || params.proxy_type == PROXY_COMMAND {
        b.set_proxy_command(
            &params.proxy_type,
            &params.proxy_command,
            &params.proxy_workdir,
            &params.proxy_env,
        );
    }
    b
}

/// setOption 映射码 → 真实 socket 选项；返回逐键日志
pub fn apply_socket_options(sock: &TcpStream, opts: &[(u8, String)]) -> Vec<String> {
    let r = socket2::SockRef::from(sock);
    let truthy = |v: &str| matches!(v.trim(), "1" | "true" | "True" | "yes");
    let mut log = Vec::new();
    for (code, v) in opts {
        let res: io::Result<()> = match *code {
            OPT_LOW_DELAY => r.set_tcp_nodelay(truthy(v)), // TCP_NODELAY（码 0；socket2 0.6 方法名）
            OPT_KEEP_ALIVE => r.set_keepalive(truthy(v)),  // SO_KEEPALIVE（码 1）
            OPT_SEND_BUF => v
                .trim()
                .parse::<usize>()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))
                .and_then(|n| r.set_send_buffer_size(n)),
            OPT_RECV_BUF => v
                .trim()
                .parse::<usize>()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))
                .and_then(|n| r.set_recv_buffer_size(n)),
            _ => Ok(()), // re::tcp 已过滤未知键；防御分支
        };
        log.push(match res {
            Ok(()) => format!("socket option {code}={v} ok"),
            Err(e) => format!("socket option {code}={v} 失败: {e}"),
        });
    }
    log
}

// ———— SOCKS5 客户端（RFC1928/1929；服务端语义见 re/tunnel.rs 的 socks5_handshake） ————

pub fn socks5_reply_text(code: u8) -> &'static str {
    match code {
        0 => "succeeded",
        1 => "general failure",
        2 => "connection not allowed",
        3 => "network unreachable",
        4 => "host unreachable",
        5 => "connection refused",
        6 => "ttl expired",
        7 => "command not supported",
        8 => "address type not supported",
        _ => "unknown",
    }
}

fn read_exact_t(sock: &mut TcpStream, buf: &mut [u8]) -> io::Result<()> {
    sock.read_exact(buf)
}

/// 经 ctrl（已连到代理）为 host:port 建立 SOCKS5 CONNECT
pub fn socks5_connect(
    sock: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> io::Result<()> {
    sock.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    sock.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let has_auth = !user.is_empty();
    let greeting: Vec<u8> = if has_auth { vec![5, 2, 0, 2] } else { vec![5, 1, 0] };
    sock.write_all(&greeting)?;
    let mut h = [0u8; 2];
    read_exact_t(sock, &mut h)?;
    if h[0] != 5 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "SOCKS5 版本应答错误"));
    }
    match h[1] {
        0 => {}
        2 => {
            if !has_auth {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "代理要求用户名/密码"));
            }
            let mut req = vec![1u8, user.len() as u8];
            req.extend(user.bytes());
            req.push(pass.len() as u8);
            req.extend(pass.bytes());
            sock.write_all(&req)?;
            let mut rep = [0u8; 2];
            read_exact_t(sock, &mut rep)?;
            if rep[0] != 1 || rep[1] != 0 {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "SOCKS5 认证失败"));
            }
        }
        0xFF => return Err(io::Error::new(io::ErrorKind::PermissionDenied, "无可用认证方法")),
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("未知认证方法 {other}"),
            ))
        }
    }
    // CONNECT
    let mut req = vec![5u8, 1, 0]; // VER CMD=CONNECT RSV
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            req.push(1);
            req.extend(v4.octets());
        }
        Ok(IpAddr::V6(v6)) => {
            req.push(4);
            req.extend(v6.octets());
        }
        Err(_) => {
            req.push(3);
            req.push(host.len() as u8);
            req.extend(host.bytes());
        }
    }
    req.extend(port.to_be_bytes());
    sock.write_all(&req)?;
    let mut rep = [0u8; 4];
    read_exact_t(sock, &mut rep)?;
    if rep[0] != 5 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "SOCKS5 应答版本错误"));
    }
    if rep[1] != 0 {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("SOCKS5: {} ({})", socks5_reply_text(rep[1]), rep[1]),
        ));
    }
    // 跳过 BND.ADDR/BND.PORT
    let skip = match rep[3] {
        1 => 6,
        4 => 18,
        3 => {
            let mut l = [0u8; 1];
            read_exact_t(sock, &mut l)?;
            l[0] as usize + 2
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("未知 ATYP {other}"),
            ))
        }
    };
    let mut junk = vec![0u8; skip];
    read_exact_t(sock, &mut junk)?;
    Ok(())
}

// ———— HTTP CONNECT（Http→码3，终端场景仅 CONNECT） ————

pub fn http_connect(
    sock: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> io::Result<()> {
    sock.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    sock.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if !user.is_empty() {
        let cred = format!("{user}:{pass}");
        let b64 = base64::engine::general_purpose::STANDARD.encode(cred);
        req.push_str(&format!("Proxy-Authorization: Basic {b64}\r\n"));
    }
    req.push_str("Connection: keep-alive\r\n\r\n");
    sock.write_all(req.as_bytes())?;
    // 逐字节吃状态行+头部直到空行（\r\n\r\n）；
    // 不用 BufReader：防止预读把隧道首包（服务端早期输出）缓冲后丢弃
    let mut head: Vec<u8> = Vec::with_capacity(512);
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if sock.read(&mut b)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "HTTP 代理应答截断"));
        }
        head.push(b[0]);
        if head.len() > 64 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "HTTP 应答头过大"));
        }
    }
    let status = String::from_utf8_lossy(&head)
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let code: u16 = status
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    if code != 200 {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("HTTP CONNECT 失败: {}", status.trim()),
        ));
    }
    Ok(())
}

// ———— ProxyCommand（仅 type=="ProxyCommand"；command 经子进程 stdio 转发） ————

/// %h/%p 替换（OpenSSH 惯例）
pub fn expand_proxy_command(cmd: &str, host: &str, port: u16) -> String {
    cmd.replace("%h", host).replace("%p", &port.to_string())
}

pub fn spawn_proxy_command(pc: &ProxyCommand, host: &str, port: u16) -> io::Result<(Child, ChildStdin, ChildStdout)> {
    let expanded = expand_proxy_command(&pc.command, host, port);
    let (program, args) = crate::re::tunnel::split_proxy_command(&expanded);
    if program.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "ProxyCommand 为空"));
    }
    let mut c = std::process::Command::new(&program);
    c.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if !pc.working_directory.is_empty() {
        c.current_dir(&pc.working_directory);
    }
    // 第4参 proxyEnvironment：非空则注入 PROXY_ENV 供命令取用
    if !pc.extra.is_empty() {
        c.env("HTERM_PROXY_ENV", &pc.extra);
    }
    let mut child = c.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| io::Error::other("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| io::Error::other("no stdout"))?;
    Ok((child, stdin, stdout))
}

/// 活动连接：直连/代理 TCP 或 ProxyCommand 子进程 stdio
pub enum LiveSocket {
    Tcp { read: TcpStream, write: TcpStream },
    Cmd { child: Child, read: ChildStdout, write: ChildStdin },
}

/// System 代理 env 近似（按 http_proxy/all_proxy 分流）
pub fn system_proxy_from_env() -> Option<ResolvedProxy> {
    let v = ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .filter(|s| !s.is_empty())?;
    let (scheme, rest) = v.split_once("://").unwrap_or(("http", &v));
    let (host, port) = parse_target(rest, if scheme.contains("socks") { 1080 } else { 3128 });
    let p = resolve_proxy(
        if scheme.contains("socks") { "Socks5" } else { "Http" },
        &host,
        port,
        "",
        "",
    );
    // System 分支产出的代理同样过 type!=2 守卫
    if proxy_type_code(&p) == 2 {
        None
    } else {
        Some(p)
    }
}

/// 按桥决策打开连接（__attach 的实连等价；含 setProxy/setProxyCommand/setOption 落地）
pub fn open(bridge: &TcpBridge, host: &str, port: u16) -> io::Result<LiveSocket> {
    if let Some(pc) = &bridge.proxy_command {
        let (child, stdin, stdout) = spawn_proxy_command(pc, host, port)?;
        return Ok(LiveSocket::Cmd { child, read: stdout, write: stdin });
    }
    let target = match &bridge.proxy {
        Some(ResolvedProxy::Socks5 { host: ph, port: pp, user, password }) => {
            let mut sock = TcpStream::connect((ph.as_str(), *pp))
                .map_err(|e| io::Error::new(e.kind(), format!("代理 {ph}:{pp} 连接失败: {e}")))?;
            socks5_connect(&mut sock, host, port, user, password)?;
            sock
        }
        Some(ResolvedProxy::HttpConnectOnly { host: ph, port: pp, user, password }) => {
            let mut sock = TcpStream::connect((ph.as_str(), *pp))
                .map_err(|e| io::Error::new(e.kind(), format!("代理 {ph}:{pp} 连接失败: {e}")))?;
            http_connect(&mut sock, host, port, user, password)?;
            sock
        }
        Some(ResolvedProxy::System) => match system_proxy_from_env() {
            Some(ResolvedProxy::Socks5 { host: ph, port: pp, user, password }) => {
                let mut sock = TcpStream::connect((ph.as_str(), pp))?;
                socks5_connect(&mut sock, host, port, &user, &password)?;
                sock
            }
            Some(ResolvedProxy::HttpConnectOnly { host: ph, port: pp, user, password }) => {
                let mut sock = TcpStream::connect((ph.as_str(), pp))?;
                http_connect(&mut sock, host, port, &user, &password)?;
                sock
            }
            _ => TcpStream::connect((host, port))?,
        },
        None | Some(ResolvedProxy::Direct) => TcpStream::connect((host, port))?,
    };
    // setOption 落地：作用于 socket 本体（attach 前已 setSocketOption）
    let _logs = apply_socket_options(&target, &bridge.socket_options);
    target.set_read_timeout(Some(READ_POLL))?;
    let read = target.try_clone()?;
    Ok(LiveSocket::Tcp { read, write: target })
}

/// 控制句柄：writer 交 Entry；close 走 detach 序列
pub struct TcpCtl {
    pub writer: Box<dyn Write + Send>,
    pub stop: mpsc::UnboundedSender<()>,
    pub killer: Box<dyn Fn() + Send>,
}

impl TcpCtl {
    pub fn close(self) {
        let _ = self.stop.send(());
        (self.killer)();
    }
}

/// TcpSession::open 流：语义路径(bridge_from) → open → pump。返回 (host 标签, 控制句柄)。
pub fn spawn_session(app: AppHandle, id: String, params: TcpParams) -> io::Result<(String, TcpCtl)> {
    let bridge = bridge_from(&params);
    let (host, port) = parse_target(&params.target, params.port);
    if host.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "缺少目标 host"));
    }
    let sock = open(&bridge, &host, port)?;
    let sink = Sink::from_app(app.clone());
    for l in apply_bridge_logs(&bridge) {
        sink.emit("re-log", id.clone(), l);
    }
    sink.emit("re-log", id.clone(), format!("connected {host}:{port}"));

    let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();
    let (writer, killer): (Box<dyn Write + Send>, Box<dyn Fn() + Send>) = match sock {
        LiveSocket::Tcp { read, write } => {
            let w = write.try_clone()?;
            let k = Box::new(move || {
                let _ = w.shutdown(std::net::Shutdown::Both); // disconnectFromHost 等价
            });
            let mut rx = stop_rx;
            let mut r = read;
            let s2 = sink.clone();
            let i2 = id.clone();
            let app2 = app.clone();
            std::thread::spawn(move || {
                pump(&mut r, s2.clone(), &i2, &mut rx);
                detach_signals(s2, i2, app2);
            });
            (Box::new(write), k)
        }
        LiveSocket::Cmd { child, read, write } => {
            let child = std::sync::Mutex::new(child); // Fn 要求：kill 需 &mut → 锁内可变
            let k = Box::new(move || {
                let _ = child.lock().unwrap().kill();
            });
            let mut rx = stop_rx;
            let mut r = read;
            let s2 = sink.clone();
            let i2 = id.clone();
            let app2 = app.clone();
            std::thread::spawn(move || {
                pump(&mut r, s2.clone(), &i2, &mut rx);
                detach_signals(s2, i2, app2);
            });
            (Box::new(write), k)
        }
    };

    Ok((format!("{host}:{port}"), TcpCtl { writer, stop: stop_tx, killer }))
}

/// detach 序列（无条件）：detaching → disconnect → state=0 → detached；随后 pty-exit
fn detach_signals(sink: Sink, id: String, app: AppHandle) {
    sink.emit("re-log", id.clone(), "detaching".into());
    sink.emit("re-log", id.clone(), "detached".into());
    let _ = app.emit("pty-exit", OutPayload { id, data: String::new() });
}

fn apply_bridge_logs(bridge: &TcpBridge) -> Vec<String> {
    let mut v = Vec::new();
    if let Some(p) = &bridge.proxy {
        v.push(format!("proxy type {} (code {})", p_variant(p), proxy_type_code(p)));
    }
    if let Some(pc) = &bridge.proxy_command {
        v.push(format!("proxy command: {} (cwd {})", pc.command, pc.working_directory));
    }
    v
}

fn p_variant(p: &ResolvedProxy) -> &'static str {
    match p {
        ResolvedProxy::System => "System",
        ResolvedProxy::HttpConnectOnly { .. } => "Http",
        ResolvedProxy::Socks5 { .. } => "Socks5",
        ResolvedProxy::Direct => "Direct",
    }
}

/// 输出泵（与串口同构：超时轮询 + stop 通道）
pub fn pump<R: Read>(mut reader: R, sink: Sink, id: &str, stop: &mut mpsc::UnboundedReceiver<()>) {
    let mut buf = [0u8; 8192];
    let mut decoder = crate::terminal_io::Utf8Decoder::default();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = crate::modem_transport::decode(id, &mut decoder, &buf[..n]);
                if !data.is_empty() { sink.emit("pty-output", id.to_string(), data); }
            }
            Err(e)
                if e.kind() == io::ErrorKind::TimedOut
                    || e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        if stop.try_recv().is_ok() {
            break;
        }
    }
    crate::modem_transport::disconnect(id);
    let tail = decoder.finish();
    if !tail.is_empty() { sink.emit("pty-output", id.to_string(), tail); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn collector() -> (Sink, Arc<Mutex<Vec<(String, String)>>>) {
        let ev = Arc::new(Mutex::new(Vec::new()));
        let e2 = ev.clone();
        (Sink(Arc::new(move |t: &str, _id: String, d: String| {
            e2.lock().unwrap().push((t.to_string(), d));
        })), ev)
    }

    #[test]
    fn target_parsing() {
        assert_eq!(parse_target("example.com:6000", 0), ("example.com".into(), 6000));
        assert_eq!(parse_target("example.com", 23), ("example.com".into(), 23));
        assert_eq!(parse_target("[::1]:8080", 0), ("::1".into(), 8080));
        assert_eq!(parse_target("192.168.1.1", 23), ("192.168.1.1".into(), 23));
        assert_eq!(parse_target("  host:44  ", 0), ("host".into(), 44));
        assert_eq!(parse_target("", 0), ("".into(), 0));
    }

    #[test]
    fn bridge_semantics_path() {
        let mut p = TcpParams {
            target: "h:1".into(),
            low_delay: Some("1".into()),
            keep_alive: Some("0".into()),
            proxy_type: "Socks5".into(),
            proxy_host: "p".into(),
            proxy_port: 1080,
            ..Default::default()
        };
        let b = bridge_from(&p);
        assert_eq!(b.socket_options, vec![(0, "1".into()), (1, "0".into())]);
        assert!(b.proxy.is_some());
        assert!(b.proxy_command.is_none()); // 门控：非 ProxyCommand 不写
        p.proxy_type = "ProxyCommand".into();
        p.proxy_command = "nc %h %p".into();
        let b2 = bridge_from(&p);
        assert_eq!(b2.proxy_command.unwrap().command, "nc %h %p");
        // 哨兵直连：None → 不 setProxy（re::tcp 已测分流，此处验证桥接线）
        p.proxy_type = "None".into();
        p.proxy_command = "".into();
        assert!(bridge_from(&p).proxy.is_none());
    }

    #[test]
    fn socket_options_apply_to_real_socket() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let h = std::thread::spawn(move || l.accept().map(|(s, _)| s));
        let c = TcpStream::connect(addr).unwrap();
        let srv = h.join().unwrap();
        let logs = apply_socket_options(
            &c,
            &[(OPT_LOW_DELAY, "1".into()), (OPT_KEEP_ALIVE, "true".into()), (OPT_SEND_BUF, "65536".into()), (OPT_RECV_BUF, "65536".into())],
        );
        assert!(logs.iter().all(|l| l.contains("ok")), "{logs:?}");
        let r = socket2::SockRef::from(&c);
        assert!(r.tcp_nodelay().unwrap());
        assert!(r.keepalive().unwrap());
        assert!(r.send_buffer_size().unwrap() > 0);
        drop(srv);
    }

    #[test]
    fn socks5_client_e2e_via_fake_proxy() {
        // 假 SOCKS5 代理：no-auth + CONNECT，然后转发到 echo 服务
        let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let echo_addr = echo.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut s in echo.incoming().filter_map(|x| x.ok()) {
                let mut b = [0u8; 64];
                if let Ok(n) = s.read(&mut b) {
                    let _ = s.write_all(&b[..n]);
                }
            }
        });
        let px = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let px_addr = px.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = px.accept().unwrap();
            let mut g = [0u8; 3];
            s.read_exact(&mut g).unwrap();
            assert_eq!(g, [5, 1, 0]);
            s.write_all(&[5, 0]).unwrap();
            // CONNECT 请求（IPv4 127.0.0.1:echo）
            let mut req = [0u8; 10];
            s.read_exact(&mut req).unwrap();
            assert_eq!(&req[..3], &[5, 1, 0]);
            assert_eq!(req[3], 1); // ATYP v4
            let mut rep = [0u8; 10];
            rep[..4].copy_from_slice(&[5, 0, 0, 1]);
            s.write_all(&rep).unwrap();
            // 转发到 echo
            let mut up = TcpStream::connect(echo_addr).unwrap();
            let mut up2 = up.try_clone().unwrap();
            let mut a = s.try_clone().unwrap();
            std::thread::spawn(move || {
                let mut b = [0u8; 4096];
                while let Ok(n) = a.read(&mut b) {
                    if n == 0 || up2.write_all(&b[..n]).is_err() {
                        break;
                    }
                    let _ = up2.flush();
                }
            });
            let mut b = [0u8; 4096];
            while let Ok(n) = up.read(&mut b) {
                if n == 0 || s.write_all(&b[..n]).is_err() {
                    break;
                }
                let _ = s.flush();
            }
        });
        let mut sock = TcpStream::connect(px_addr).unwrap();
        socks5_connect(&mut sock, "127.0.0.1", echo_addr.port(), "", "").unwrap();
        sock.write_all(b"over-socks").unwrap();
        let mut got = [0u8; 10];
        sock.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let n = sock.read(&mut got).unwrap();
        assert_eq!(&got[..n], b"over-socks");
    }

    #[test]
    fn http_connect_e2e_via_fake_proxy() {
        let px = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let px_addr = px.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = px.accept().unwrap();
            let mut br = io::BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            br.read_line(&mut line).unwrap();
            assert!(line.starts_with("CONNECT target.test:9 HTTP/1.1"), "{line}");
            let mut auth = String::new();
            br.read_line(&mut auth).unwrap(); // Host 行
            br.read_line(&mut auth).unwrap(); // Proxy-Authorization
            assert!(auth.contains("Basic"), "{auth}");
            let _ = s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
            let mut b = [0u8; 32];
            if let Ok(n) = s.read(&mut b) {
                let _ = s.write_all(&b[..n]);
            }
        });
        let mut sock = TcpStream::connect(px_addr).unwrap();
        http_connect(&mut sock, "target.test", 9, "u", "p").unwrap();
        sock.write_all(b"via-connect").unwrap();
        let mut got = [0u8; 11];
        sock.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        sock.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"via-connect");
    }

    #[test]
    fn proxy_command_passthrough_with_cat() {
        // %h/%p 替换 + 子进程 stdio 转发（cat 作透传代理命令）
        assert_eq!(expand_proxy_command("nc -X %h %p", "1.2.3.4", 23), "nc -X 1.2.3.4 23");
        let pc = ProxyCommand { command: "cat".into(), working_directory: String::new(), extra: String::new() };
        let (_child, mut w, mut r) = spawn_proxy_command(&pc, "ignored", 0).unwrap();
        w.write_all(b"proxy-cmd-ok").unwrap();
        w.flush().unwrap();
        // ChildStdout 无超时 API：读线程 + recv_timeout 防挂
        let (tx, rx) = std::sync::mpsc::channel::<[u8; 12]>();
        std::thread::spawn(move || {
            let mut got = [0u8; 12];
            if r.read_exact(&mut got).is_ok() {
                let _ = tx.send(got);
            }
        });
        let got = rx.recv_timeout(Duration::from_secs(3)).expect("cat 透传超时");
        assert_eq!(&got, b"proxy-cmd-ok");
    }

    #[test]
    fn open_direct_and_bridge_gating() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).unwrap();
            let _ = s.write_all(&b);
        });
        let b = TcpBridge::default();
        let sock = open(&b, "127.0.0.1", addr.port()).unwrap();
        match sock {
            LiveSocket::Tcp { mut read, mut write } => {
                write.write_all(b"ping").unwrap();
                read.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut got = [0u8; 4];
                read.read_exact(&mut got).unwrap();
                assert_eq!(&got, b"ping");
            }
            _ => panic!("expected tcp"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn pump_stop_and_output() {
        let (sink, ev) = collector();
        let (mut a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        b.set_read_timeout(Some(READ_POLL)).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        a.write_all(b"tcp-bytes").unwrap();
        let h = std::thread::spawn(move || {
            let mut r = b;
            pump(&mut r, sink, "x", &mut rx);
        });
        std::thread::sleep(Duration::from_millis(300));
        let _ = tx.send(());
        h.join().unwrap();
        let snap = ev.lock().unwrap().clone();
        assert!(snap.iter().any(|(t, d)| t == "pty-output" && d == "tcp-bytes"), "{snap:?}");
    }

    #[test]
    fn system_proxy_env_absent_is_none_or_valid() {
        // 无 env 时 None（直连）；有 env 时产出过守卫的非哨兵代理
        std::env::remove_var("http_proxy");
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("all_proxy");
        std::env::remove_var("ALL_PROXY");
        assert!(system_proxy_from_env().is_none());
        std::env::set_var("all_proxy", "socks5://127.0.0.1:1080");
        let p = system_proxy_from_env();
        assert!(matches!(p, Some(ResolvedProxy::Socks5 { .. })));
        std::env::remove_var("all_proxy");
    }
}
