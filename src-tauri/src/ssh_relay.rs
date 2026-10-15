// hurricaneTerm — SSH 中继/代理 dial 层（队列项3）
// 架构：libssh **不直连**目标，
// TCP 目标被 PROXY_HOST/PORT 覆盖到本地中继，outer 侧按会话代理配置走
// 直连 / SOCKS5 / HTTP CONNECT / ProxyCommand 进程 / 跳板 四种通道之一。
// 本模块把"经代理抵达目标"收敛成统一拨号函数 dial()，返回已建立隧道的字节双工流，
// 供 russh `client::connect_stream` 直接接管（见文末接线说明与 to_tokio）。
// SOCKS5 字节序遵循 re/tunnel.rs 的行为（含无可用方法时回 [05,05] 而非 RFC FF
// 的怪癖 → 客户端解析对选择字节 0x05 容忍为"拒绝"；域名请求应答被改写 atyp'=1+4×0
// → 客户端按**应答**的 atyp 变长解析而非请求值）。
// ProxyCommand 分词/状态表复用 re/tunnel.rs 的函数（split_proxy_command、
// socket_error_from_process_error 表 [2,1,5,1]）。
#![allow(dead_code)]

use crate::re::tunnel::{socket_error_from_process_error, split_proxy_command};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

// ---------------------------------------------------------------- 双工抽象

/// 统一双工流：任何 Read+Write+Send+Debug 都可用（TcpStream、进程 stdio 桥、跳板回调产物）。
/// Debug 作为超约：使 Box<dyn Duplex> 上的 unwrap/expect 日志可用。
/// 注意：本工具链（rustc 1.99）无 std::io::split，全双工异步桥必须用显式拆半
/// （Dialed::split → BoxedReader/BoxedWriter，见 to_tokio）。
pub trait Duplex: Read + Write + Send + std::fmt::Debug {}
impl<T: Read + Write + Send + std::fmt::Debug> Duplex for T {}
pub type BoxedDuplex = Box<dyn Duplex>;
pub type BoxedReader = Box<dyn Read + Send>;
pub type BoxedWriter = Box<dyn Write + Send>;

/// 拨号目标（跳板回调的入参；host/port 为**真实**目标，非代理端点）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

/// 跳板拨号回调：父代理用 russh direct-tcpip 实现（open_channel("direct-tcpip")
/// 的 stream 包成 BoxedDuplex 返回）。Box<dyn> 注入以保持本模块不依赖会话状态。
pub type JumpOpener = Box<dyn Fn(&Target) -> io::Result<BoxedDuplex> + Send + Sync>;

// ---------------------------------------------------------------- Proxy 模型

#[derive(Clone, Debug)]
pub struct Socks5Proxy {
    pub addr: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    /// 代理 DNS 能力位：proxyDns==false 时 capabilities &= ~0x10
    /// （0x10 = 域名解析能力位）——即**本地解析**后按 IP 发给代理，
    /// true 时把域名原样交给代理解析（atyp=3）。
    pub proxy_dns: bool,
}

#[derive(Clone, Debug)]
pub struct HttpProxy {
    pub addr: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub proxy_dns: bool,
}

#[derive(Clone, Debug)]
pub struct ProxyCommandSpec {
    /// 完整命令行（首 token 为程序，其余为参数）
    pub cmd: String,
    /// 工作目录：空 → 继承当前进程目录
    pub working_directory: Option<String>,
    /// 注入子进程的环境变量串，按 "K=V;K2=V2" 解析
    pub environment: Vec<(String, String)>,
}

/// 会话代理五态 + 系统/全局两态（类型串：
/// None/System/Socks5/Http/ProxyCommand/Global/Jump，见 re/tunnel.rs PROXY_*）
pub enum Proxy {
    /// 直连（哨兵语义：无代理时 PROXY_HOST 仍指向本地中继；本层等价于裸 TCP）
    None,
    /// 系统代理：按环境变量解析
    System,
    Socks5(Socks5Proxy),
    Http(HttpProxy),
    ProxyCommand(ProxyCommandSpec),
    /// 跳板：dial 时调用注入回调（russh direct-tcpip 由父代理接线）
    Jump(JumpOpener),
}

/// 属性值分发："command"→进程模式；"system"/"http"/"socks5"→
/// 代理类型；**其他值→跳过**（不设代理 = 直连）。
pub fn proxy_from_session_value(value: &str, props: &ProxyProps) -> Proxy {
    match value {
        "command" => Proxy::ProxyCommand(ProxyCommandSpec {
            cmd: props.command.clone(),
            working_directory: if props.working_directory.is_empty() {
                None
            } else {
                Some(props.working_directory.clone())
            },
            environment: parse_environment(&props.environment),
        }),
        "system" | "global" => Proxy::System, // Global：全局作用域在配置层收敛
        "socks5" => Proxy::Socks5(Socks5Proxy {
            addr: props.host.clone(),
            port: props.port,
            user: non_empty(&props.user),
            password: non_empty(&props.password),
            proxy_dns: props.proxy_dns,
        }),
        "http" => Proxy::Http(HttpProxy {
            addr: props.host.clone(),
            port: props.port,
            user: non_empty(&props.user),
            password: non_empty(&props.password),
            proxy_dns: props.proxy_dns,
        }),
        _ => Proxy::None, // 未知值直接跳过
    }
}

fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// session.proxy* 属性包（键名 PROXY_PROP_KEYS）
#[derive(Clone, Debug, Default)]
pub struct ProxyProps {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub command: String,
    pub working_directory: String,
    pub environment: String,
    pub proxy_dns: bool, // 默认 true：域名交给代理解析
}

/// 线上类型码 http→3、socks5→1；
/// 且**仅当 type()!=2 才下发代理**（2=HTTP 哨兵，内置 HTTP
/// 代理被绕开——本层的 dial 即"自己完成 CONNECT"的落地）。
pub fn proxy_wire_type_code(value: &str) -> Option<i32> {
    match value {
        "socks5" => Some(1),
        "http" => Some(3),
        _ => None,
    }
}

pub fn should_set_proxy_on_session(code: i32) -> bool {
    code != 2
}

/// 代理命令：splitCommandLine 语义——首 token 弹出为
/// 程序、其余为参数；%h/%p 替换为真实目标主机/端口（OpenSSH 惯例，
/// 典型用法 "ssh -W %h:%p gateway"）。
pub fn substitute_h_p(cmd: &str, host: &str, port: u16) -> String {
    cmd.replace("%h", host).replace("%p", &port.to_string())
}

pub fn parse_environment(s: &str) -> Vec<(String, String)> {
    s.split(';')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.to_string()))
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

/// System/Global 解析：all_proxy/ALL_PROXY，支持 socks5://host:port 与
/// http(s)://host:port；无/不可解析 → None（直连）。
pub fn parse_proxy_url(url: &str) -> Option<Proxy> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = authority.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    match scheme {
        "socks5" | "socks5h" => Some(Proxy::Socks5(Socks5Proxy {
            addr: host.to_string(),
            port,
            user: None,
            password: None,
            proxy_dns: scheme == "socks5h",
        })),
        "http" | "https" => Some(Proxy::Http(HttpProxy {
            addr: host.to_string(),
            port,
            user: None,
            password: None,
            proxy_dns: true,
        })),
        _ => None,
    }
}

fn system_proxy() -> Proxy {
    for key in ["ALL_PROXY", "all_proxy"] {
        if let Ok(v) = std::env::var(key) {
            if let Some(p) = parse_proxy_url(&v) {
                return p;
            }
        }
    }
    Proxy::None
}

// ---------------------------------------------------------------- dial 入口

/// 拨号结果：纯 TCP 隧道（直连/SOCKS5/HTTP）返回具体 TcpStream——父代理可
/// set_nonblocking + tokio::net::TcpStream::from_std 零拷贝接入 russh；
/// 进程桥返回 ProcessDuplex（可真拆读写两半）；回调通道返回 BoxedDuplex。
#[derive(Debug)]
pub enum Dialed {
    Tcp(TcpStream),
    Process(ProcessDuplex),
    Relay(BoxedDuplex),
}

impl Dialed {
    /// Process stdio readers need an explicit cancellation flag: merely
    /// closing the Tokio duplex cannot wake a blocking read from an idle
    /// ProxyCommand which ignores EOF on stdin.
    pub fn split_with_cancel(self) -> (BoxedReader, BoxedWriter, Option<Arc<AtomicBool>>) {
        match self {
            Dialed::Process(mut process) => {
                let cancel = process.cancel.clone();
                let (reader, writer) = process.split_duplex();
                (reader, writer, Some(cancel))
            }
            dialed => {
                let (reader, writer) = dialed.split();
                (reader, writer, None)
            }
        }
    }
    pub fn into_boxed(self) -> BoxedDuplex {
        match self {
            Dialed::Tcp(s) => Box::new(s),
            Dialed::Process(p) => Box::new(p),
            Dialed::Relay(b) => b,
        }
    }

    /// 拆成独立读写两半（to_tokio 全双工桥的入参）。
    /// Tcp：try_clone；Process：原生分离（stdin 写侧 / 管道接收器+子进程监护读侧）；
    /// Relay：共享锁回退——**半双工安全，全双工慎用**（读阻塞时写会等锁；
    /// 跳板在异步侧应由父代理直接用 russh direct-tcpip 的 async 流，不走此回退）。
    pub fn split(self) -> (BoxedReader, BoxedWriter) {
        match self {
            Dialed::Tcp(s) => {
                let w = s.try_clone().expect("TcpStream try_clone");
                (Box::new(s), Box::new(w))
            }
            Dialed::Process(mut p) => p.split_duplex(),
            Dialed::Relay(b) => {
                let shared = Arc::new(Mutex::new(b));
                (Box::new(LockedReader(shared.clone())), Box::new(LockedWriter(shared)))
            }
        }
    }
}

struct LockedReader(Arc<Mutex<BoxedDuplex>>);
impl Read for LockedReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.lock().expect("duplex lock").read(buf)
    }
}
struct LockedWriter(Arc<Mutex<BoxedDuplex>>);
impl Write for LockedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("duplex lock").write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().expect("duplex lock").flush()
    }
}

/// 任务规定入口：统一"经代理抵达目标"。
pub fn dial(proxy: &Proxy, host: &str, port: u16, timeout: Duration) -> io::Result<BoxedDuplex> {
    dial_any(proxy, host, port, timeout).map(Dialed::into_boxed)
}

pub fn dial_any(proxy: &Proxy, host: &str, port: u16, timeout: Duration) -> io::Result<Dialed> {
    let target = Target {
        host: host.to_string(),
        port,
    };
    match proxy {
        Proxy::None => Ok(Dialed::Tcp(connect_timeout(host, port, timeout)?)),
        Proxy::System => dial_any(&system_proxy(), host, port, timeout),
        Proxy::Socks5(p) => Ok(Dialed::Tcp(dial_socks5(p, &target, timeout)?)),
        Proxy::Http(p) => Ok(Dialed::Tcp(dial_http_connect(p, &target, timeout)?)),
        Proxy::ProxyCommand(p) => Ok(Dialed::Process(dial_proxy_command(p, &target)?)),
        Proxy::Jump(opener) => Ok(Dialed::Relay(opener(&target)?)),
    }
}

fn connect_timeout(host: &str, port: u16, timeout: Duration) -> io::Result<TcpStream> {
    // 先试字面 IP（免解析），再走 DNS。DNS 阶段无超时控制（std 限制），接线文档已注明。
    if let Ok(addr) = format!("{host}:{port}").parse::<SocketAddr>() {
        return TcpStream::connect_timeout(&addr, timeout);
    }
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs()?.collect();
    if addrs.is_empty() {
        return Err(io::Error::new(io::ErrorKind::AddrNotAvailable, "no address resolved"));
    }
    let mut err = io::Error::new(io::ErrorKind::NotConnected, "no address");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(s) => return Ok(s),
            Err(e) => err = e,
        }
    }
    Err(err)
}

// ---------------------------------------------------------------- SOCKS5 客户端

/// 兼容性容忍：本仓库的 SOCKS5 **服务端**无可用方法时回
/// [05,05]（非 RFC 的 FF），且域名请求的应答被改写为 atyp'=1 + 4×0。
/// 因此本客户端：① 选择字节非 0x00/0x02 一律视为拒绝（0x05/0xFF 都给明确报错）；
/// ② 应答按**应答头里的 atyp** 变长解析，不假设与请求一致。
pub fn dial_socks5(p: &Socks5Proxy, target: &Target, timeout: Duration) -> io::Result<TcpStream> {
    let mut s = connect_timeout(&p.addr, p.port, timeout)?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(timeout)).ok();

    // greeting：有凭据时同时提供 no-auth(0) 与 user/pass(2)，否则仅 0
    let methods: &[u8] = if p.user.is_some() { &[0x00, 0x02] } else { &[0x00] };
    let mut greeting = vec![0x05, methods.len() as u8];
    greeting.extend_from_slice(methods);
    s.write_all(&greeting)?;
    let mut sel = [0u8; 2];
    s.read_exact(&mut sel)?;
    if sel[0] != 5 {
        return Err(sock_err(format!("SOCKS5 应答版本非法: {}", sel[0])));
    }
    match sel[1] {
        0x00 => {}
        0x02 => socks5_auth(&mut s, p)?,
        // 0x05 = 本实现拒绝字节；0xFF = RFC 拒绝；其余=未提供方法
        other => {
            return Err(sock_err(format!(
                "SOCKS5 无可用认证方法（服务端选择 0x{other:02x}）"
            )))
        }
    }

    // CONNECT 请求：proxy_dns=false → 本地解析后发 IP；否则域名 atyp=3
    let (atyp, addr_bytes) = socks5_addr(&target.host, target.port, p.proxy_dns)?;
    let mut req = vec![0x05, 0x01, 0x00, atyp];
    req.extend_from_slice(&addr_bytes);
    req.extend_from_slice(&target.port.to_be_bytes());
    s.write_all(&req)?;

    // 应答：ver, rep, rsv, atyp'（atyp' 可能与请求不同）
    let mut head = [0u8; 4];
    s.read_exact(&mut head)?;
    if head[0] != 5 {
        return Err(sock_err(format!("SOCKS5 应答版本非法: {}", head[0])));
    }
    if head[1] != 0 {
        return Err(sock_err(format!(
            "SOCKS5 CONNECT 失败: {} (rep=0x{:02x})",
            socks5_reply_name(head[1]),
            head[1]
        )));
    }
    skip_socks5_addr(&mut s, head[3])?; // BND.ADDR
    let mut bnd_port = [0u8; 2];
    s.read_exact(&mut bnd_port)?; // BND.PORT（忽略值，隧道已建立）
    // 握手完成：清掉超时——长会话空闲靠 keepalive（SshSession::keepAlive 语义），
    // 中继读方向不设超时（仅进程通道有 Timedout→5 映射）
    s.set_read_timeout(None)?;
    s.set_write_timeout(None)?;
    Ok(s)
}

fn socks5_auth(s: &mut TcpStream, p: &Socks5Proxy) -> io::Result<()> {
    // RFC1929 子协商（版本 0x01）
    let user = p.user.clone().unwrap_or_default();
    let pass = p.password.clone().unwrap_or_default();
    let mut req = vec![0x01, user.len() as u8];
    req.extend_from_slice(user.as_bytes());
    req.push(pass.len() as u8);
    req.extend_from_slice(pass.as_bytes());
    s.write_all(&req)?;
    let mut rsp = [0u8; 2];
    s.read_exact(&mut rsp)?;
    if rsp[0] != 1 || rsp[1] != 0 {
        return Err(sock_err(format!(
            "SOCKS5 认证被拒 (status=0x{:02x})",
            rsp[1]
        )));
    }
    Ok(())
}

/// 返回 (atyp, 地址字节[不含端口])。proxy_dns=false 时域名先本地解析。
fn socks5_addr(host: &str, port: u16, proxy_dns: bool) -> io::Result<(u8, Vec<u8>)> {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return Ok(match ip {
            std::net::IpAddr::V4(v4) => (1, v4.octets().to_vec()),
            std::net::IpAddr::V6(v6) => (4, v6.octets().to_vec()),
        });
    }
    if !proxy_dns {
        // 本地解析（对齐 proxyDns==false 清 ResolveDns 能力位）
        let addrs: Vec<SocketAddr> = (host, port)
            .to_socket_addrs()
            .map_err(|e| sock_err(format!("本地解析 {host} 失败: {e}")))?
            .collect();
        let a = addrs
            .first()
            .ok_or_else(|| sock_err(format!("本地解析 {host} 无结果")))?
            .ip();
        return Ok(match a {
            std::net::IpAddr::V4(v4) => (1, v4.octets().to_vec()),
            std::net::IpAddr::V6(v6) => (4, v6.octets().to_vec()),
        });
    }
    let b = host.as_bytes();
    if b.is_empty() || b.len() > 255 {
        return Err(sock_err("SOCKS5 域名长度非法".into()));
    }
    let mut v = vec![b.len() as u8];
    v.extend_from_slice(b);
    Ok((3, v))
}

fn skip_socks5_addr(s: &mut TcpStream, atyp: u8) -> io::Result<()> {
    let n = match atyp {
        1 => 4,
        4 => 16,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l)?;
            l[0] as usize
        }
        other => return Err(sock_err(format!("SOCKS5 应答地址族非法: 0x{other:02x}"))),
    };
    let mut sink = vec![0u8; n];
    s.read_exact(&mut sink)?;
    Ok(())
}

fn socks5_reply_name(rep: u8) -> &'static str {
    // 名称表对齐 re/tunnel.rs Socks5Reply（0/5/7/8），其余按 RFC1928 补全
    match rep {
        1 => "general failure",
        2 => "connection not allowed",
        3 => "network unreachable",
        4 => "host unreachable",
        5 => "connection refused",
        6 => "TTL expired",
        7 => "command not supported",
        8 => "address type not supported",
        _ => "unknown reply",
    }
}

fn sock_err(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionRefused, msg)
}

// ---------------------------------------------------------------- HTTP CONNECT

pub fn dial_http_connect(
    p: &HttpProxy,
    target: &Target,
    timeout: Duration,
) -> io::Result<TcpStream> {
    let mut s = connect_timeout(&p.addr, p.port, timeout)?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(timeout)).ok();

    // 目标地址：proxy_dns=false 同样先本地解析（与 SOCKS5 能力位一致）
    let hostport = if !p.proxy_dns && target.host.parse::<std::net::IpAddr>().is_err() {
        let a = (target.host.as_str(), target.port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::AddrNotAvailable, "no address"))?;
        format!("{}:{}", a.ip(), target.port)
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let mut req = format!("CONNECT {hostport} HTTP/1.0\r\nHost: {hostport}\r\n");
    if let (Some(u), Some(pass)) = (&p.user, &p.password) {
        let cred = base64(format!("{u}:{pass}").as_bytes());
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", cred));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())?;

    // 读到 \r\n\r\n；状态行非 200 即失败（407=需认证，代理失败一律上抛）
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        s.read_exact(&mut byte)?;
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP CONNECT 应答头超长",
            ));
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let status_line = head.lines().next().unwrap_or("");
    let code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("HTTP 应答状态行非法: {status_line}"),
            )
        })?;
    if code != 200 {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("HTTP CONNECT 被拒: {status_line}"),
        ));
    }
    // 同上：握手完成后清除超时，会话期空闲由 keepalive 保活
    s.set_read_timeout(None)?;
    s.set_write_timeout(None)?;
    Ok(s)
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let v = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(v >> 18 & 63) as usize] as char);
        out.push(T[(v >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(v >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(v & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------- ProxyCommand

/// 进程 stdio 桥：stdin=写侧；stdout+stderr 合流为读侧（两路都喂 socket 读方向）。
/// 启动失败 → FailedToStart → socket 错误码 2(ConnectionRefused 域)，
/// 表 [2,1,5,1] 见 re/tunnel.rs socket_error_from_process_error。
pub fn dial_proxy_command(p: &ProxyCommandSpec, target: &Target) -> io::Result<ProcessDuplex> {
    let expanded = substitute_h_p(&p.cmd, &target.host, target.port);
    let (program, args) = split_proxy_command(&expanded);
    if program.is_empty() {
        // FailedToStart 等价：错误码 2
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!(
                "ProxyCommand 启动失败（socket error {}）：命令为空",
                socket_error_from_process_error(0)
            ),
        ));
    }
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(wd) = &p.working_directory {
        cmd.current_dir(wd); // wd 空 → None → 继承当前进程目录
    }
    for (k, v) in &p.environment {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Err(io::Error::new(
                e.kind(),
                format!(
                    "ProxyCommand '{program}' 启动失败（socket error {}）: {e}",
                    socket_error_from_process_error(0)
                ),
            ))
        }
    };
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    // Backpressure caps queued proxy output at 16 * 32 KiB instead of letting
    // a fast stdout/stderr producer grow an unbounded allocation queue.
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
    for stream in [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut r = stream;
            let mut buf = [0u8; 32 * 1024];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
            // tx drop → 读侧 EOF
        });
    }
    drop(tx);
    Ok(ProcessDuplex {
        child: Some(child),
        stdin: Some(stdin),
        rx: Some(rx),
        pending: VecDeque::new(),
        cancel: Arc::new(AtomicBool::new(false)),
    })
}

/// 进程 stdio 桥（对齐 进程 stdio 代理套接字：stdout/stderr 合流读、stdin 写）。
/// Drop 时终止子进程（std Child 无 kill_on_drop，手动实现，对齐 outer deleteLater）。
/// 字段 Option 化：因为实现了 Drop 不可逐字段移出；split_duplex 用 take 取出。
pub struct ProcessDuplex {
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
    rx: Option<mpsc::Receiver<Vec<u8>>>,
    pending: VecDeque<u8>,
    cancel: Arc<AtomicBool>,
}

impl ProcessDuplex {
    /// 真拆两半：读侧携带子进程监护（Drop 即 kill），写侧携带 stdin（Drop 即关管道）。
    pub fn split_duplex(&mut self) -> (BoxedReader, BoxedWriter) {
        let child = self.child.take().expect("child held");
        let stdin = self.stdin.take().expect("stdin held");
        let rx = self.rx.take().expect("rx held");
        (
            Box::new(ProcReader { child, rx, pending: std::mem::take(&mut self.pending), cancel: self.cancel.clone() }),
            Box::new(ProcWriter(stdin)),
        )
    }
}

struct ProcReader {
    child: std::process::Child,
    rx: mpsc::Receiver<Vec<u8>>,
    pending: VecDeque<u8>,
    cancel: Arc<AtomicBool>,
}

impl Read for ProcReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.pending.is_empty() {
            if self.cancel.load(Ordering::Acquire) { return Ok(0); }
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => self.pending.extend(chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len());
        for i in 0..n {
            buf[i] = self.pending.pop_front().unwrap();
        }
        Ok(n)
    }
}

impl Drop for ProcReader {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct ProcWriter(std::process::ChildStdin);
impl Write for ProcWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl std::fmt::Debug for ProcessDuplex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let pid = self.child.as_ref().map(|c| c.id());
        write!(f, "ProcessDuplex(pid={pid:?})")
    }
}
impl std::fmt::Debug for ProcReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProcReader")
    }
}
impl std::fmt::Debug for ProcWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProcWriter")
    }
}

impl Read for ProcessDuplex {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pending.is_empty() {
            match self.rx.as_mut().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "split already taken")
            })?.recv()
            {
                Ok(chunk) => self.pending.extend(chunk),
                Err(_) => return Ok(0), // 两路读线程都结束 → EOF
            }
        }
        let n = buf.len().min(self.pending.len());
        for i in 0..n {
            buf[i] = self.pending.pop_front().unwrap();
        }
        Ok(n)
    }
}

impl Write for ProcessDuplex {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "split already taken"))?
            .write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "split already taken"))?
            .flush()
    }
}

impl Drop for ProcessDuplex {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ---------------------------------------------------------------- tokio 桥（russh 接线用）

/// 把拆好的读写两半桥成 tokio AsyncRead+AsyncWrite（russh 0.64 connect_stream 的
/// T 约束）。内部 tokio::io::duplex 双缓冲 + 两个泵任务；须在 tokio 运行时上下文调用。
/// 纯 TCP 隧道优先走 Dialed::Tcp → tokio::net::TcpStream::from_std（零额外拷贝）。
pub async fn to_tokio(
    rd: BoxedReader,
    wr: BoxedWriter,
) -> io::Result<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static> {
    to_tokio_with_cancel(rd, wr, None).await
}

pub async fn to_tokio_with_cancel(
    mut rd: BoxedReader,
    mut wr: BoxedWriter,
    cancel: Option<Arc<AtomicBool>>,
) -> io::Result<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut push_tx, push_rx) = tokio::io::duplex(64 * 1024); // std→russh
    let (pull_tx, mut pull_rx) = tokio::io::duplex(64 * 1024); // russh→std
    let cancel = cancel.unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let reader_cancel = cancel.clone();

    // std → push_tx：阻塞 read 放 spawn_blocking，避免占死工作线程；
    // 句柄随闭包往返（spawn_blocking 消耗捕获，故把 rd 传回来）
    tokio::spawn(async move {
        loop {
            if reader_cancel.load(Ordering::Acquire) { break; }
            let (read, rd_back) = tokio::task::spawn_blocking(move || {
                let mut b = vec![0u8; 32 * 1024];
                let out = match rd.read(&mut b) {
                    Ok(0) | Err(_) => Vec::new(), // 读错误/EOF 统一按隧道关闭处理
                    Ok(n) => b[..n].to_vec(),
                };
                (out, rd)
            })
            .await
            .expect("spawn_blocking read pump");
            rd = rd_back;
            if read.is_empty() {
                break;
            }
            if push_tx.write_all(&read).await.is_err() {
                break;
            }
        }
        let _ = push_tx.shutdown().await;
    });

    // pull_rx → std：写也放 spawn_blocking（进程管道可能阻塞）；句柄同样随闭包往返
    tokio::spawn(async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = match AsyncReadExt::read(&mut pull_rx, &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let data = buf[..n].to_vec();
            match tokio::task::spawn_blocking(move || {
                let mut w = wr;
                let ok = w.write_all(&data).is_ok();
                (ok, w)
            })
            .await
            {
                Ok((ok, w_back)) => {
                    wr = w_back;
                    if !ok {
                        break;
                    }
                }
                Err(_) => break, // 阻塞线程崩溃：隧道放弃
            }
        }
    });

    Ok(TokioBridge {
        rd: push_rx,
        wr: pull_tx,
        cancel,
    })
}

struct TokioBridge {
    rd: tokio::io::DuplexStream,
    wr: tokio::io::DuplexStream,
    cancel: Arc<AtomicBool>,
}

impl Drop for TokioBridge {
    fn drop(&mut self) { self.cancel.store(true, Ordering::Release); }
}

impl tokio::io::AsyncRead for TokioBridge {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.rd).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for TokioBridge {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.wr).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.wr).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.wr).poll_shutdown(cx)
    }
}

// ---------------------------------------------------------------- 接线说明（给父代理）
//
// ssh_live::run 里的接入点（替换现 client::connect(cfg, (host, port), handler)）：
//
//   1) 同步拨号放阻塞线程（dial 内部是阻塞 std IO）：
//      let dialed = tokio::task::spawn_blocking(move || {
//          ssh_relay::dial_any(&proxy, &host, port, std::time::Duration::from_secs(30))
//      }).await??;
//
//   2) 按变体接 russh（russh 0.64: client::connect_stream(cfg, stream, addr, handler)，
//      stream: AsyncRead+AsyncWrite+Unpin+Send+'static；addr 仍传真实 host:port，
//      保证 known_hosts 身份对齐中继架构的 HOST/PORT 语义）：
//        Dialed::Tcp(s)  => s.set_nonblocking(true)?;
//                           let ts = tokio::net::TcpStream::from_std(s)?;
//                           client::connect_stream(cfg, ts, (host.as_str(), port), handler)
//        Dialed::Process(p) => let (rd, wr) = p.split_duplex();
//                           let stream = ssh_relay::to_tokio(rd, wr).await?;
//                           client::connect_stream(cfg, stream, (host.as_str(), port), handler)
//        Dialed::Relay(b)   => let (rd, wr) = b 的持有者 .split(); 同上（半双工锁回退，
//                           跳板建议改用 russh direct-tcpip 的 async 流避开）
//
//   3) Proxy 来源：会话 JSON 的 session.proxy* 键 → ProxyProps → proxy_from_session_value
//      （键名表见 re/tunnel.rs PROXY_PROP_KEYS）；
//      Jump 的 JumpOpener 由父代理用已建立的 russh Handle 闭包实现：
//        |t| handle.open_channel(russh::ChannelOpenDirectTcpIp::new(&t.host, t.port, "127.0.0.1", 0))
//        → stream 包成 BoxedDuplex（需 Read/Write 适配，或直接在 connect_stream 层用 async 通道）。
//
// 4) 超时：dial 的 timeout 只约束 TCP 连接与握手；会话期空闲靠 keepalive 30s（已实现）。

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// 一次性回环 echo 服务：accept 一条连接，回显直至 EOF
    fn spawn_echo() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut b = [0u8; 4096];
                loop {
                    match s.read(&mut b) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if s.write_all(&b[..n]).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
        port
    }

    #[derive(Copy, Clone, PartialEq, Eq)]
    enum SocksMode {
        Ok,
        NoAcceptable, // 无可用方法时回 [05,05]（非 FF）
        Refused,      // CONNECT 应答 rep=5
    }

    /// 最小 SOCKS5 代理：记录 CONNECT 目标；应答恒用 atyp'=1（模拟域名
    /// 应答改写）；随后桥接到 127.0.0.1:target_port。
    fn spawn_socks5(target_port: u16, mode: SocksMode) -> (u16, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let log2 = log.clone();
        std::thread::spawn(move || {
            let Ok((mut c, _)) = l.accept() else { return };
            let mut h = [0u8; 2];
            if c.read_exact(&mut h).is_err() || h[0] != 5 {
                return;
            }
            let mut methods = vec![0u8; h[1] as usize];
            let _ = c.read_exact(&mut methods);
            let sel: Vec<u8> = if methods.contains(&0) && mode != SocksMode::NoAcceptable {
                vec![5, 0]
            } else {
                vec![5, 5] // 本实现的拒绝字节
            };
            if c.write_all(&sel).is_err() || sel[1] == 5 {
                return;
            }
            let mut req = [0u8; 4];
            if c.read_exact(&mut req).is_err() {
                return;
            }
            let alen = match req[3] {
                1 => 4,
                4 => 16,
                3 => {
                    let mut l1 = [0u8; 1];
                    let _ = c.read_exact(&mut l1);
                    l1[0] as usize
                }
                _ => return,
            };
            let mut addr = vec![0u8; alen];
            let _ = c.read_exact(&mut addr);
            let mut pb = [0u8; 2];
            let _ = c.read_exact(&mut pb);
            let host = match req[3] {
                3 => String::from_utf8_lossy(&addr).to_string(),
                1 => format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]),
                _ => "ipv6".into(),
            };
            log2.lock().unwrap().push(format!("{host}:{}", u16::from_be_bytes(pb)));
            if mode == SocksMode::Refused {
                let _ = c.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
                return;
            }
            // 应答恒 atyp'=1（域名请求也回 4×0）
            let _ = c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
            if let Ok(mut t) = TcpStream::connect(("127.0.0.1", target_port)) {
                let mut c2 = c.try_clone().unwrap();
                let mut t2 = t.try_clone().unwrap();
                let h1 = std::thread::spawn(move || {
                    let _ = std::io::copy(&mut c2, &mut t);
                });
                let _ = std::io::copy(&mut t2, &mut c);
                let _ = h1.join();
            }
        });
        (port, log)
    }

    /// 最小 HTTP CONNECT 代理：记录请求首行与授权头；reply407 拒 407
    fn spawn_http(target_port: u16, reply407: bool) -> (u16, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let log2 = log.clone();
        std::thread::spawn(move || {
            let Ok((mut c, _)) = l.accept() else { return };
            let mut head: Vec<u8> = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if c.read(&mut byte).unwrap_or(0) == 0 {
                    return;
                }
                head.push(byte[0]);
            }
            let text = String::from_utf8_lossy(&head).to_string();
            for line in text.lines().take(3) {
                log2.lock().unwrap().push(line.to_string());
            }
            if reply407 {
                let _ = c.write_all(b"HTTP/1.0 407 Proxy Authentication Required\r\n\r\n");
                return;
            }
            let _ = c.write_all(b"HTTP/1.0 200 Connection established\r\n\r\n");
            if let Ok(mut t) = TcpStream::connect(("127.0.0.1", target_port)) {
                let mut c2 = c.try_clone().unwrap();
                let mut t2 = t.try_clone().unwrap();
                let h1 = std::thread::spawn(move || {
                    let _ = std::io::copy(&mut c2, &mut t);
                });
                let _ = std::io::copy(&mut t2, &mut c);
                let _ = h1.join();
            }
        });
        (port, log)
    }

    fn socks(addr: u16) -> Proxy {
        Proxy::Socks5(Socks5Proxy {
            addr: "127.0.0.1".into(),
            port: addr,
            user: None,
            password: None,
            proxy_dns: true,
        })
    }

    fn read_line(d: &mut BoxedDuplex) -> Vec<u8> {
        let mut line: Vec<u8> = Vec::new();
        loop {
            let mut b = [0u8; 1];
            d.read_exact(&mut b).unwrap();
            if b[0] == b'\n' {
                return line;
            }
            line.push(b[0]);
        }
    }

    #[test]
    fn dial_direct_echo() {
        let p = spawn_echo();
        let mut d = dial(&Proxy::None, "127.0.0.1", p, Duration::from_secs(2)).unwrap();
        d.write_all(b"HELLO").unwrap();
        let mut b = [0u8; 5];
        d.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"HELLO");
    }

    #[test]
    fn dial_socks5_domain_e2e_with_reply_rewrite() {
        // 域名 CONNECT + 应答被改写 atyp'=1 —— 客户端必须按应答 atyp 解析成功
        let echo = spawn_echo();
        let (px, log) = spawn_socks5(echo, SocksMode::Ok);
        let mut d = dial(&socks(px), "example.invalid", 443, Duration::from_secs(2)).unwrap();
        d.write_all(b"PING").unwrap();
        let mut b = [0u8; 4];
        d.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"PING");
        assert_eq!(log.lock().unwrap().as_slice(), ["example.invalid:443"]);
    }

    #[test]
    fn dial_socks5_ipv4_target() {
        let echo = spawn_echo();
        let (px, log) = spawn_socks5(echo, SocksMode::Ok);
        let mut d = dial(&socks(px), "127.0.0.1", echo, Duration::from_secs(2)).unwrap();
        d.write_all(b"V4").unwrap();
        let mut b = [0u8; 2];
        d.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"V4");
        let expected = format!("127.0.0.1:{echo}");
        assert_eq!(log.lock().unwrap().as_slice(), [expected.as_str()]);
    }

    #[test]
    fn dial_socks5_no_acceptable_method_tolerates_0x05() {
        // 拒绝字节是 05 而非 RFC FF —— 必须报"无可用方法"且指出 0x05
        let echo = spawn_echo();
        let (px, _) = spawn_socks5(echo, SocksMode::NoAcceptable);
        let e = dial(&socks(px), "any.host", 22, Duration::from_secs(2)).unwrap_err();
        assert!(e.to_string().contains("无可用认证方法"), "{e}");
        assert!(e.to_string().contains("0x05"), "{e}");
    }

    #[test]
    fn dial_socks5_connect_refused_maps_name() {
        let echo = spawn_echo();
        let (px, _) = spawn_socks5(echo, SocksMode::Refused);
        let e = dial(&socks(px), "any.host", 22, Duration::from_secs(2)).unwrap_err();
        assert!(e.to_string().contains("connection refused"), "{e}");
        assert_eq!(e.kind(), io::ErrorKind::ConnectionRefused);
    }

    #[test]
    fn dial_http_connect_e2e_with_auth_header() {
        let echo = spawn_echo();
        let (px, log) = spawn_http(echo, false);
        let p = Proxy::Http(HttpProxy {
            addr: "127.0.0.1".into(),
            port: px,
            user: Some("u".into()),
            password: Some("p".into()),
            proxy_dns: true,
        });
        let mut d = dial(&p, "target.example", 80, Duration::from_secs(2)).unwrap();
        d.write_all(b"GET").unwrap();
        let mut b = [0u8; 3];
        d.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"GET");
        let log = log.lock().unwrap();
        assert_eq!(log[0], "CONNECT target.example:80 HTTP/1.0");
        assert_eq!(log[1], "Host: target.example:80");
        assert_eq!(
            log[2],
            format!("Proxy-Authorization: Basic {}", base64(b"u:p"))
        );
    }

    #[test]
    fn dial_http_407_errors() {
        let echo = spawn_echo();
        let (px, _) = spawn_http(echo, true);
        let p = Proxy::Http(HttpProxy {
            addr: "127.0.0.1".into(),
            port: px,
            user: None,
            password: None,
            proxy_dns: true,
        });
        let e = dial(&p, "h", 1, Duration::from_secs(2)).unwrap_err();
        assert!(e.to_string().contains("407"), "{e}");
    }

    #[test]
    fn dial_proxy_command_substitution_and_stdout_read() {
        // printf 输出替换后的 %h:%p —— 验证替换 + 首 token 弹出 + 读侧合流
        let p = Proxy::ProxyCommand(ProxyCommandSpec {
            cmd: "printf %h:%p".into(),
            working_directory: None,
            environment: Vec::new(),
        });
        let mut d = dial(&p, "127.0.0.1", 22, Duration::from_secs(2)).unwrap();
        let mut s = String::new();
        d.read_to_string(&mut s).unwrap();
        assert_eq!(s, "127.0.0.1:22");
    }

    #[test]
    fn dial_proxy_command_cat_echo_roundtrip() {
        // /bin/cat 当代理：写什么回什么（stdin→stdout）
        let p = Proxy::ProxyCommand(ProxyCommandSpec {
            cmd: "/bin/cat".into(),
            working_directory: None,
            environment: Vec::new(),
        });
        let mut d = dial(&p, "unused.host", 22, Duration::from_secs(2)).unwrap();
        d.write_all(b"relay me\n").unwrap();
        assert_eq!(read_line(&mut d), b"relay me");
    }

    #[test]
    fn dial_proxy_command_start_failure_maps_socket_error_2() {
        // FailedToStart → 表 [2,1,5,1] 首项 = 2
        let p = Proxy::ProxyCommand(ProxyCommandSpec {
            cmd: "definitely-not-a-real-binary-xyz %h".into(),
            working_directory: None,
            environment: Vec::new(),
        });
        let e = dial(&p, "h", 22, Duration::from_secs(2)).unwrap_err();
        assert!(e.to_string().contains("socket error 2"), "{e}");
    }

    #[test]
    fn dial_jump_callback_injection() {
        // Jump：回调注入（父代理后续接 russh direct-tcpip）
        let echo = spawn_echo();
        let seen = Arc::new(Mutex::new(Vec::<Target>::new()));
        let seen2 = seen.clone();
        let opener: JumpOpener = Box::new(move |t: &Target| {
            seen2.lock().unwrap().push(t.clone());
            let s = TcpStream::connect(("127.0.0.1", t.port))?; // 测试里直连 echo 充当转发
            Ok(Box::new(s) as BoxedDuplex)
        });
        let mut d = dial(
            &Proxy::Jump(opener),
            "internal-host",
            echo,
            Duration::from_secs(2),
        )
        .unwrap();
        d.write_all(b"J").unwrap();
        let mut b = [0u8; 1];
        d.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"J");
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [Target {
                host: "internal-host".into(),
                port: echo
            }]
        );
    }

    #[test]
    fn proxy_value_dispatch_tables() {
        // 值分发 + 类型码 + setProxy 哨兵
        let props = ProxyProps {
            host: "1.2.3.4".into(),
            port: 1080,
            command: "ssh -W %h:%p gw".into(),
            ..Default::default()
        };
        assert!(matches!(
            proxy_from_session_value("socks5", &props),
            Proxy::Socks5(_)
        ));
        assert!(matches!(
            proxy_from_session_value("http", &props),
            Proxy::Http(_)
        ));
        assert!(matches!(
            proxy_from_session_value("command", &props),
            Proxy::ProxyCommand(_)
        ));
        assert!(matches!(
            proxy_from_session_value("system", &props),
            Proxy::System
        ));
        assert!(matches!(
            proxy_from_session_value("bogus", &props),
            Proxy::None
        )); // 其他值跳过
        assert_eq!(proxy_wire_type_code("socks5"), Some(1));
        assert_eq!(proxy_wire_type_code("http"), Some(3));
        assert_eq!(proxy_wire_type_code("command"), None);
        assert!(should_set_proxy_on_session(1));
        assert!(should_set_proxy_on_session(3));
        assert!(!should_set_proxy_on_session(2)); // 哨兵：type==2 不下发代理
    }

    #[test]
    fn substitution_and_env_and_url_parsing() {
        assert_eq!(
            substitute_h_p("ssh -W %h:%p gw", "10.0.0.1", 2222),
            "ssh -W 10.0.0.1:2222 gw"
        );
        assert_eq!(
            parse_environment("HTTP_PROXY=http://x:80; PATH=/bin"),
            vec![
                ("HTTP_PROXY".to_string(), "http://x:80".to_string()),
                ("PATH".to_string(), "/bin".to_string())
            ]
        );
        let p = parse_proxy_url("socks5://192.168.8.246:7890").unwrap();
        match p {
            Proxy::Socks5(s) => {
                assert_eq!(
                    (s.addr.as_str(), s.port, s.proxy_dns),
                    ("192.168.8.246", 7890, false)
                );
            }
            _ => panic!("wrong variant"),
        }
        let h = parse_proxy_url("http://192.168.8.246:7890/extra").unwrap();
        assert!(matches!(h, Proxy::Http(x) if x.addr=="192.168.8.246" && x.port==7890));
        assert!(parse_proxy_url("gopher://x:1").is_none());
    }

    #[test]
    fn base64_vectors() {
        assert_eq!(base64(b"u:p"), "dTpw");
        assert_eq!(base64(b"el:secret123"), "ZWw6c2VjcmV0MTIz");
        assert_eq!(base64(b"a"), "YQ==");
    }

    #[tokio::test]
    async fn to_tokio_bridge_roundtrip() {
        // 拆半后桥接 /bin/cat：写→读回，验证 AsyncRead+AsyncWrite 形状可喂 connect_stream
        let p = Proxy::ProxyCommand(ProxyCommandSpec {
            cmd: "/bin/cat".into(),
            working_directory: None,
            environment: Vec::new(),
        });
        let (rd, wr) = dial_any(&p, "h", 22, Duration::from_secs(2))
            .unwrap()
            .split();
        let mut t = to_tokio(rd, wr).await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        t.write_all(b"async-ping\n").await.unwrap();
        let mut line = Vec::new();
        loop {
            let mut b = [0u8; 1];
            t.read_exact(&mut b).await.unwrap();
            if b[0] == b'\n' {
                break;
            }
            line.push(b[0]);
        }
        assert_eq!(line, b"async-ping");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_idle_proxy_bridge_kills_and_reaps_its_process() {
        let directory = std::env::temp_dir().join(format!("hurricane-proxy-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let pid_file = directory.join("proxy.pid");
        std::fs::write(directory.join("fixture.sh"), "printf '%s' \"$$\" > proxy.pid\ntrap '' HUP\nexec /bin/sleep 600\n").unwrap();
        // exec leaves exactly one fixture process. It ignores HUP and never
        // reads stdin, so dropping the write half alone cannot make it exit.
        let proxy = Proxy::ProxyCommand(ProxyCommandSpec {
            cmd: "/bin/sh fixture.sh".into(),
            working_directory: Some(directory.to_string_lossy().into()),
            environment: Vec::new(),
        });
        let (reader, writer, cancel) = dial_any(&proxy, "fixture", 22, Duration::from_secs(2)).unwrap().split_with_cancel();
        let stream = to_tokio_with_cancel(reader, writer, cancel).await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let pid: libc::pid_t = loop {
            if let Ok(pid) = std::fs::read_to_string(&pid_file).and_then(|text| text.parse().map_err(|_| io::Error::from(io::ErrorKind::InvalidData))) { break pid; }
            assert!(tokio::time::Instant::now() < deadline, "fixture process started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        // Ensure the reader pump has entered its wait for process output.
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(stream);
        let reaped = tokio::time::timeout(Duration::from_secs(2), async {
            while unsafe { libc::kill(pid, 0) } == 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await;
        if reaped.is_err() { unsafe { libc::kill(pid, libc::SIGKILL); } }
        std::fs::remove_dir_all(directory).unwrap();
        reaped.expect("dropping an idle ProxyCommand bridge must kill and reap its owned process");
    }

    #[test]
    fn dialed_tcp_fastpath_is_concrete() {
        // 纯 TCP 隧道（None/Socks5/Http）走 Dialed::Tcp——父代理 from_std 零拷贝接入
        let echo = spawn_echo();
        let (px, _) = spawn_socks5(echo, SocksMode::Ok);
        match dial_any(&socks(px), "h.host", 443, Duration::from_secs(2)).unwrap() {
            Dialed::Tcp(s) => {
                let mut s = s;
                s.write_all(b"FAST").unwrap();
                let mut b = [0u8; 4];
                s.read_exact(&mut b).unwrap();
                assert_eq!(&b, b"FAST");
            }
            other => panic!("SOCKS5 应走 Tcp 快路径，得到 {other:?}"),
        }
    }

    #[test]
    fn dialed_process_split_full_duplex() {
        // 读写两半可同时使用（无共享锁）：写 cat 同时从读半收——这是 to_tokio 的前提
        let p = Proxy::ProxyCommand(ProxyCommandSpec {
            cmd: "/bin/cat".into(),
            working_directory: None,
            environment: Vec::new(),
        });
        let (mut rd, mut wr) = dial_any(&p, "h", 22, Duration::from_secs(2))
            .unwrap()
            .split();
        let writer = std::thread::spawn(move || {
            wr.write_all(b"half-duplex no more\n").unwrap();
            wr
        });
        let mut line: Vec<u8> = Vec::new();
        loop {
            let mut b = [0u8; 1];
            rd.read_exact(&mut b).unwrap();
            if b[0] == b'\n' {
                break;
            }
            line.push(b[0]);
        }
        assert_eq!(line, b"half-duplex no more");
        let _ = writer.join();
    }
}
