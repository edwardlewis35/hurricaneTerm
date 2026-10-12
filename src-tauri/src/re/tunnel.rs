//! 隧道 / 端口转发 / 代理 —— 语义重写自 WindTerm 2.6.0
//! `Tunnel` / `TunnelCenter` / `ForwardingCenter` / `ForwardingHandler` /
//! `ProxyServer`(SOCKS5) / `ProxyCommandSocket` / `SshBridge::open*Forwarding`。
//! 证据：re-work/decompiled/session/*.pseudo.txt（入口地址见各文件头），
//! 字符串常量直接从二进制符号表实读（SSH_FORWARDING_* / PROXY_* / NOT_IMPORTANT_MARK /
//! tr() 标签 0x100a5xxxx）。
//!
//! 已确证核心语义（详见 re-work/notes/tunnel.md）：
//! - Tunnel 布局 0x48B：uuid(+0x00) session(+0x08) name(+0x10) type(+0x18) error(+0x20)
//!   error_level(+0x28) flags(+0x2c: bit0=autoOpen, bit1=localhostOnly) state(+0x30)
//!   listen_port(+0x34) dest_port(+0x36) dest_host(+0x38) assigned_port(+0x40)
//! - TunnelType: 0=Invalid 1=Dynamic 2=Local 3=Remote；State: 0=WaitingToOpen 1=Opened
//!   2=WaitingToClose 3=Closed（stateText 表 0x100ab5460 实读）
//! - start 守卫 state>=2；stop 守卫 state<=1；Remote 独占会话，Dynamic/Local 复用非独占会话
//! - setTunnel：state∈{0,3} 清 assigned_port；Closed+空错误早退（保留旧错误）；
//!   错误级 4，"!important " 前缀 → 3 并剥离；变更发 tunnelChanged
//! - SOCKS5：仅 CONNECT；无可用方法回 [05,05]（非 RFC 的 FF，二进制实证）；
//!   域名请求回 atype=1+全零 IPv4；异常消息 tr 表实读
//! - X11：仅 loopback 显示；TCP 端口 = display+6000；空 DISPLAY→unix:/tmp/.X11-unix/X<n>
//! - ProxyCommand：QProcess 态→socket 态 {NotRunning→0,Starting→2,Running→3}；
//!   错误表 [FailedToStart→2, Crashed→1, Timedout→5, ReadError→3→1]（0x100982b70 实读）

pub const NOT_IMPORTANT_MARK: &str = "!important "; // 符号表实读 @0x100ae3190

// ---------------------------------------------------------------- 类型/状态

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[repr(u32)]
pub enum TunnelType {
    #[default]
    Unknown = 0, // isValid()==false 的类型
    Dynamic = 1, // SOCKS5 动态
    Local = 2,
    Remote = 3,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[repr(u32)]
pub enum TunnelState {
    #[default]
    WaitingToOpen = 0,
    Opened = 1,
    WaitingToClose = 2,
    Closed = 3,
}

/// 证据：typeText 0x10018a060（tr id 实读解码）
pub fn type_text(t: TunnelType) -> &'static str {
    match t {
        TunnelType::Dynamic => "Dynamic forwarding",
        TunnelType::Local => "Local forwarding",
        TunnelType::Remote => "Remote forwarding",
        TunnelType::Unknown => "", // 证据：shared_null（空串）
    }
}

/// 证据：stateText 0x100188e90 + 字符串表 0x100ab5460 实读；>=4 回退 'Opened'（上游行为）
pub fn state_text(s: TunnelState) -> &'static str {
    match s {
        TunnelState::WaitingToOpen => "Waiting to open...",
        TunnelState::Opened => "Opened",
        TunnelState::WaitingToClose => "Waiting to close...",
        TunnelState::Closed => "Closed",
    }
}

// ---------------------------------------------------------------- Tunnel 模型

#[derive(Clone, Debug)]
pub struct Tunnel {
    pub uuid: String,          // +0x00 唯一 id（tunnelFromUuid 检索键）
    pub session: String,       // +0x08 所属会话名（持久化分组键）
    pub name: String,          // +0x10 显示名（可空；序列化 "name:Type" 的 name 段）
    pub ttype: TunnelType,     // +0x18
    pub error: String,         // +0x20
    pub error_level: u32,      // +0x28 4=重要错误 3=非重要（!important 前缀）
    pub auto_open: bool,       // +0x2c bit0
    pub localhost_only: bool,  // +0x2c bit1
    pub state: TunnelState,    // +0x30
    pub listen_port: u16,      // +0x34 0=自动分配
    pub dest_port: u16,        // +0x36
    pub dest_host: String,     // +0x38
    pub assigned_port: u16,    // +0x40 Opened 时的实际端口
}

impl Tunnel {
    pub fn new(uuid: impl Into<String>, ttype: TunnelType) -> Self {
        Self {
            uuid: uuid.into(),
            session: String::new(),
            name: String::new(),
            ttype,
            error: String::new(),
            error_level: 0,
            auto_open: false,
            localhost_only: false,
            state: TunnelState::default(),
            listen_port: 0,
            dest_port: 0,
            dest_host: String::new(),
            assigned_port: 0,
        }
    }

    /// 证据：isValid 0x100188c10 —— return *(int*)(this+0x18) != 0
    pub fn is_valid(&self) -> bool {
        self.ttype != TunnelType::Unknown
    }

    /// 证据：listeningPortText 0x100188c20
    /// port!=0 → 十进制；否则 state!=Opened → "Dynamic port allocation"；
    /// 否则 "Local|Remote <assigned_port>"（type==Remote→Remote，其余一律 Local）
    pub fn listening_port_text(&self) -> String {
        if self.listen_port != 0 {
            return self.listen_port.to_string();
        }
        if self.state != TunnelState::Opened {
            return "Dynamic port allocation".into();
        }
        let label = if self.ttype == TunnelType::Remote { "Remote" } else { "Local" };
        format!("{label} {}", self.assigned_port)
    }

    /// 证据：operator== 0x10018a190 —— 比较 uuid/type/session/listen_port/
    /// dest_host/dest_port/localhostOnly(bit1)；**不比较** name/error/state/autoOpen(bit0)
    pub fn same_definition(&self, o: &Tunnel) -> bool {
        self.uuid == o.uuid
            && self.ttype == o.ttype
            && self.session == o.session
            && self.listen_port == o.listen_port
            && self.dest_host == o.dest_host
            && self.dest_port == o.dest_port
            && self.localhost_only == o.localhost_only
    }
}

// ---------------------------------------------------------------- TunnelCenter

/// TunnelSession 语义模型（+0x10 SuperSession*、+0x18 会话名、+0x20 dedicated/busy、
/// +0x28 starting uuid 列表、+0x30 opened-requested uuid 列表）
#[derive(Clone, Debug, Default)]
pub struct TunnelSession {
    pub session_name: String,
    pub super_ready: bool, // SuperSession::state()==7 (Ready)
    pub dedicated: bool,   // +0x20：Remote 隧道独占
    pub starting: Vec<String>, // +0x28
    pub opened: Vec<String>,   // +0x30（会话 ready 时重放）
}

#[derive(Clone, Debug, Default)]
pub struct TunnelCenter {
    pub tunnels: Vec<Tunnel>,           // this+0x60 QVector<Tunnel> stride 0x48
    pub sessions: Vec<TunnelSession>,   // this+0x68 QVector<TunnelSession*>
    pub changed: Vec<String>,           // tunnelChanged 信号记录（测试用）
    pub ready_emitted: Vec<String>,     // sessionReady 信号记录
}

impl TunnelCenter {
    pub fn tunnel_from_uuid(&self, uuid: &str) -> Option<&Tunnel> {
        self.tunnels.iter().find(|t| t.uuid == uuid)
    }
    pub fn tunnel_from_uuid_mut(&mut self, uuid: &str) -> Option<&mut Tunnel> {
        self.tunnels.iter_mut().find(|t| t.uuid == uuid)
    }

    /// 证据：setTunnel 0x10018bce0
    pub fn set_tunnel(&mut self, uuid: &str, state: TunnelState, error: &str) {
        let idx = match self.tunnels.iter().position(|t| t.uuid == uuid) {
            Some(i) => i,
            None => return,
        };
        let t = &mut self.tunnels[idx];
        if t.state == state && t.error == error {
            return; // 证据：state 与 error 均相同 → 直接返回
        }
        t.state = state;
        if state == TunnelState::Closed || state == TunnelState::WaitingToOpen {
            t.assigned_port = 0; // 证据：(state==3||state==0) → +0x40 = 0
        }
        if state == TunnelState::Closed && error.is_empty() {
            self.changed.push(uuid.into()); // 证据：goto 尾块（仍发 tunnelChanged）
            return; // 保留旧 error，不改 error_level
        }
        t.error_level = 4;
        t.error = error.into();
        if t.error.starts_with(NOT_IMPORTANT_MARK) {
            t.error_level = 3;
            t.error = t.error[NOT_IMPORTANT_MARK.len()..].to_string();
        }
        self.changed.push(uuid.into());
    }

    /// 证据：startTunnel 0x10018b640
    pub fn start_tunnel(&mut self, uuid: &str) -> bool {
        let (ttype, state) = match self.tunnel_from_uuid(uuid) {
            Some(t) => (t.ttype, t.state),
            None => return false,
        };
        if ttype == TunnelType::Unknown {
            return false;
        }
        if (state as u32) < 2 {
            return false; // 已在 WaitingToOpen/Opened
        }
        // Remote → 新建独占 TunnelSession；Dynamic/Local → 复用首个非独占会话，无则新建
        let sess_idx = if ttype == TunnelType::Remote {
            self.sessions.push(TunnelSession {
                session_name: self.tunnel_from_uuid(uuid).unwrap().session.clone(),
                ..Default::default()
            });
            self.sessions.len() - 1
        } else {
            match self.sessions.iter().position(|s| !s.dedicated) {
                Some(i) => i,
                None => {
                    self.sessions.push(TunnelSession {
                        session_name: self.tunnel_from_uuid(uuid).unwrap().session.clone(),
                        ..Default::default()
                    });
                    self.sessions.len() - 1
                }
            }
        };
        self.set_tunnel(uuid, TunnelState::WaitingToOpen, "");
        let s = &mut self.sessions[sess_idx];
        s.dedicated |= ttype == TunnelType::Remote; // 证据：this[0x20] |= (type==3)
        s.starting.push(uuid.into());               // +0x28
        // TunnelSession::openTunnelForwarding：会话 Ready → 立即 async open，否则排队 +0x30
        if s.super_ready {
            if !s.opened.contains(&uuid.to_string()) {
                s.opened.push(uuid.into());
            }
        } else {
            // setSessionReady 时重放 opened 列表
            if !s.opened.contains(&uuid.to_string()) {
                s.opened.push(uuid.into());
            }
        }
        true
    }

    /// 证据：stopTunnel 0x10018e8c0
    pub fn stop_tunnel(&mut self, uuid: &str) -> bool {
        let (ttype, state) = match self.tunnel_from_uuid(uuid) {
            Some(t) => (t.ttype, t.state),
            None => return false,
        };
        if ttype == TunnelType::Unknown {
            return false;
        }
        if (state as u32) > 1 {
            return false; // 仅 WaitingToOpen/Opened 可停
        }
        self.set_tunnel(uuid, TunnelState::WaitingToClose, "");
        for s in &mut self.sessions {
            if s.starting.iter().any(|u| u == uuid) {
                s.starting.retain(|u| u != uuid); // removeOne(+0x28)
                s.opened.retain(|u| u != uuid);   // removeOne(+0x30)
                if s.super_ready {
                    // SuperSession::state()==7 → asyncCloseTunnelForwarding(op=0xb)
                }
                break; // 证据：命中即 break
            }
        }
        true
    }

    /// 证据：autoStartTunnels 0x10018b540 —— 遍历全部，flags&1 者 start
    pub fn auto_start_tunnels(&mut self) {
        let uuids: Vec<String> = self
            .tunnels
            .iter()
            .filter(|t| t.auto_open)
            .map(|t| t.uuid.clone())
            .collect();
        for u in uuids {
            self.start_tunnel(&u);
        }
    }

    /// 证据：sessionTunnels 0x10018d1e0 —— 按会话名(+0x08)序列化为
    /// "name:Type[(localhost)][(auto)],listenPort,dest" 以 ';' 连接（即 ssh.tunnels 存储格式）
    pub fn session_tunnels(&self, session: &str) -> String {
        let mut parts: Vec<String> = Vec::new();
        for t in self.tunnels.iter().filter(|t| t.session == session) {
            let short = match t.ttype {
                TunnelType::Dynamic => "Dynamic",
                TunnelType::Local => "Local",
                TunnelType::Remote => "Remote",
                TunnelType::Unknown => "",
            };
            let mut desc = String::new();
            if !t.name.is_empty() {
                desc.push_str(&t.name);
                desc.push(':');
            }
            desc.push_str(short);
            if t.localhost_only {
                desc.push_str("(localhost)");
            }
            if t.auto_open {
                desc.push_str("(auto)");
            }
            let dest = if t.ttype == TunnelType::Dynamic {
                "Any".to_string()
            } else {
                format!("{}:{}", t.dest_host, t.dest_port)
            };
            parts.push(format!("{desc},{},{dest}", t.listen_port));
        }
        parts.join(";")
    }

    /// 证据：addSessionTunnels 0x10018a580 —— 解析存储串并迁移旧标记：
    /// "Direct"→Local, "Reverse"→Remote, "(Local)"→"(localhost)"；
    /// 每条必须恰好 3 个逗号字段；无名时回退 param_2 + ":port"
    pub fn add_session_tunnels(&mut self, session: &str, default_name: &str, stored: &str) {
        for entry in stored.split(';') {
            let fields: Vec<&str> = entry.split(',').collect();
            if fields.len() != 3 {
                continue; // 证据：size!=3 直接跳过
            }
            let mut desc = fields[0].to_string();
            // 旧标记迁移（顺序与二进制一致）
            desc = desc.replace("Direct", "Local");
            desc = desc.replace("Reverse", "Remote");
            desc = desc.replace("(Local)", "(localhost)");
            desc = desc.replace("(Auto)", "(auto)");
            let mut flags = 0u8;
            if desc.contains("(localhost)") {
                flags |= 2;
                desc = desc.replace("(localhost)", "");
            }
            if desc.contains("(auto)") {
                flags |= 1;
                desc = desc.replace("(auto)", "");
            }
            let (name, type_token) = match desc.rfind(':') {
                Some(i) => (desc[..i].to_string(), desc[i + 1..].to_string()),
                None => (String::new(), desc.clone()),
            };
            let listen_port = fields[1].parse::<u16>().unwrap_or(0);
            let ttype = match type_token.as_str() {
                "Dynamic" => TunnelType::Dynamic,
                "Local" => TunnelType::Local,
                "Remote" => TunnelType::Remote,
                _ => TunnelType::Unknown,
            };
            let (dest_host, dest_port) = if ttype == TunnelType::Dynamic {
                (String::new(), 0u16)
            } else {
                let mut it = fields[2].splitn(2, ':');
                (
                    it.next().unwrap_or("").to_string(),
                    it.next().and_then(|p| p.parse().ok()).unwrap_or(0),
                )
            };
            let name = if name.is_empty() {
                if ttype == TunnelType::Dynamic {
                    default_name.to_string()
                } else {
                    format!("{default_name}:{listen_port}")
                }
            } else {
                name
            };
            let uuid = format!("{session}:{name}:{listen_port}"); // 上游 uuid 生成点未反编译，此处保证唯一稳定
            self.tunnels.push(Tunnel {
                uuid,
                session: session.to_string(),
                name,
                ttype,
                auto_open: flags & 1 != 0,
                localhost_only: flags & 2 != 0,
                listen_port,
                dest_host,
                dest_port,
                ..Tunnel::new("", TunnelType::Unknown)
            });
        }
    }
}

// ---------------------------------------------------------------- ForwardingCenter

/// 证据：ProxyServer::ProxyType —— 0=直连 TCP（Local 隧道），1=SOCKS5（Dynamic 隧道）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum ProxyServerType {
    Tcp = 0,
    Socks5 = 1,
}

/// ForwardingCenter::Forwarding 表项 { handler, destHost, destPort }（QMap<server, QList>）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForwardingRef {
    pub handler: usize, // ForwardingHandler* 身份
    pub dest_host: String,
    pub dest_port: u16,
}

#[derive(Clone, Debug)]
pub struct ProxyServerState {
    pub uuid: String,
    pub ptype: ProxyServerType,
    pub localhost_only: bool,
    pub bound_port: u16,
    pub listening: bool,
    pub error: Option<(i32, String)>,
    pub forwardings: Vec<ForwardingRef>,
}

/// 证据：ForwardingCenter 0x1000cc4d0 startForwardingServer ——
/// 复用 (uuid, listenPort) 相同的服务器；否则新建并 bind
/// localhostOnly ? Loopback(2) : AnyIPv4(4)；同 (handler,destHost,destPort) 表项去重；
/// 结果回 proxyServerReady(uuid, actualPort) 或 proxyServerError(uuid, err, msg)。
/// 自旋锁 busy 标志(+0x20)：sched_yield×16 → sleep 100ms×16 → sleep 10s（证据保留）。
#[derive(Clone, Debug, Default)]
pub struct ForwardingCenter {
    pub servers: Vec<ProxyServerState>,
    pub last_event: Option<String>,
}

impl ForwardingCenter {
    pub fn start_forwarding_server(
        &mut self,
        handler: usize,
        uuid: &str,
        ptype: ProxyServerType,
        listen_port: u16,
        dest_host: &str,
        dest_port: u16,
        localhost_only: bool,
    ) -> u16 {
        let idx = if let Some(i) = self
            .servers
            .iter()
            .position(|s| s.uuid == uuid && s.bound_port == listen_port)
        {
            i
        } else {
            self.servers.push(ProxyServerState {
                uuid: uuid.into(),
                ptype,
                localhost_only,
                bound_port: listen_port,
                listening: true, // 真实实现：QTcpServer::listen 结果
                error: None,
                forwardings: Vec::new(),
            });
            self.servers.len() - 1
        };
        let f = ForwardingRef {
            handler,
            dest_host: dest_host.into(),
            dest_port,
        };
        let s = &mut self.servers[idx];
        if !s.forwardings.contains(&f) {
            s.forwardings.push(f);
        }
        if s.listening {
            self.last_event = Some(format!("ready:{}:{}", uuid, s.bound_port));
            s.bound_port
        } else {
            let (c, m) = s.error.clone().unwrap_or((-1, "unknown".into()));
            self.last_event = Some(format!("error:{uuid}:{c}:{m}"));
            0
        }
    }

    /// 证据：serverPort 0x1000cc3d0 —— 按 uuid 找首个服务器返回实际端口，无则 0
    pub fn server_port(&self, uuid: &str) -> u16 {
        self.servers
            .iter()
            .find(|s| s.uuid == uuid)
            .map(|s| s.bound_port)
            .unwrap_or(0)
    }

    /// 证据：removeForwardingServer 0x1000cc130 —— 按 uuid 整台删除（不区分 handler），
    /// 释放全部表项并发 proxyServerClosed
    pub fn remove_forwarding_server(&mut self, _handler: usize, uuid: &str) {
        if let Some(i) = self.servers.iter().position(|s| s.uuid == uuid) {
            self.servers.remove(i);
            self.last_event = Some(format!("closed:{uuid}"));
        }
    }

    /// 证据：removeForwardingHandler 0x1000cbb60 —— 摘除该 handler 的全部表项；
    /// 表项清空后删除服务器并发 proxyServerClosed(server.uuid)
    pub fn remove_forwarding_handler(&mut self, handler: usize) {
        let mut closed: Vec<String> = Vec::new();
        for s in &mut self.servers {
            s.forwardings.retain(|f| f.handler != handler);
        }
        self.servers.retain(|s| {
            if s.forwardings.is_empty() {
                closed.push(s.uuid.clone());
                false
            } else {
                true
            }
        });
        for u in closed {
            self.last_event = Some(format!("closed:{u}"));
        }
    }
}

// ---------------------------------------------------------------- ForwardingHandler

/// 证据：ForwardingHandler::Forwarding { uuid, channel, socket }；
/// RemoteForwarding { uuid, timer, channel, bind_host("localhost"|"") , bind_port, host, port }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteForwarding {
    pub uuid: String,
    pub bind_host: String, // localhostOnly ? "localhost" : ""（证据 remoteForwarding 0x1000cf4c0）
    pub bind_port: u16,    // listenForward 回填实际端口
    pub host: String,
    pub port: u16,
}

/// 证据：x11Forwarding 0x1000cf7d0 —— DISPLAY 解析：
/// 空 → 环境 DISPLAY，取 ':' 后数字 n → unix:/tmp/.X11-unix/X<n>（domainForwarding）；
/// 否则 (?<host>.*?):(?<port>\d+)(\.(?<screen>\d+))?；host 以 "unix:"/":" 开头或
/// =="localhost" 或 QHostAddress.isLoopback 才接受；TCP 端口 = port+6000；
/// 端口溢出为 0 或 host 为空 → 忽略。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum X11Target {
    Unix { path: String },
    Tcp { host: String, port: u16 },
    Reject,
}

pub fn parse_x11_display(display: &str, env_display: Option<&str>) -> X11Target {
    if display.is_empty() {
        let d = env_display.unwrap_or("");
        if let Some(pos) = d.rfind(':') {
            let rest = &d[pos + 1..];
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = num.parse::<u32>() {
                return X11Target::Unix { path: format!("/tmp/.X11-unix/X{n}") };
            }
        }
        return X11Target::Reject;
    }
    // host:port(.screen)
    let (host, tail) = match display.split_once(':') {
        Some(h) => h,
        None => return X11Target::Reject,
    };
    let port_part: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    let port: u16 = match port_part.parse() {
        Ok(p) => p,
        Err(_) => return X11Target::Reject,
    };
    let loopback = host.starts_with("unix:")
        || host.starts_with(':')
        || host.is_empty()
        || host == "localhost"
        || is_loopback_ip(host);
    if !loopback {
        return X11Target::Reject;
    }
    let mapped = port.wrapping_add(6000);
    if mapped == 0 || host.is_empty() {
        return X11Target::Reject;
    }
    X11Target::Tcp { host: host.into(), port: mapped }
}

fn is_loopback_ip(host: &str) -> bool {
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------- SOCKS5

/// 证据：ProxyServer::Socks5State（$_2 直接写线上字节）：0=Succeeded 5=Refused
/// 7=CommandNotSupported 8=AddressTypeNotSupported；握手拒绝实测写 [05,05]（非 RFC FF）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Socks5Reply {
    Succeeded = 0,
    ConnectionRefused = 5,
    CommandNotSupported = 7,
    AddressTypeNotSupported = 8,
}

pub const SOCKS_ERR_LEN: &str = "SOCKS 5 request is invalid (requested length: %1).";
pub const SOCKS_ERR_VER: &str = "SOCKS 5 request is invalid (requested version: %1).";
pub const SOCKS_ERR_CMD: &str = "SOCKS 5 request is not supported (requested command: %1).";
pub const SOCKS_ERR_ATYP: &str = "SOCKS 5 request is not supported (requested address type: %1).";
pub const SOCKS_ERR_ADDRLEN: &str = "SOCKS 5 address length is invalid.";
pub const SOCKS_ERR_EMPTYHOST: &str = "SOCKS 5 request is invalid (requested host is empty).";
pub const SOCKS_ERR_HS_LEN: &str = "SOCKS 5 handshake request is invalid (requested length: %1).";
pub const SOCKS_ERR_HS_VER: &str = "SOCKS 5 handshake request is invalid (requested version: %1).";

/// 握手：len<3 或 ver!=5 → Err；方法含 0x00 → 回 [05,00] 进入请求态；
/// 否则回 [05,05] 并断开（证据 socks5Handshake 0x100100b20）
pub fn socks5_handshake(buf: &[u8]) -> Result<(Vec<u8>, bool), String> {
    if buf.len() < 3 {
        return Err(SOCKS_ERR_HS_LEN.replace("%1", &buf.len().to_string()));
    }
    if buf[0] != 5 {
        return Err(SOCKS_ERR_HS_VER.replace("%1", &buf[0].to_string()));
    }
    let n = buf[1] as usize;
    let methods = &buf[2..(2 + n).min(buf.len())];
    if methods.contains(&0) {
        Ok((vec![0x05, 0x00], true)) // 选中 no-auth，state→2
    } else {
        Ok((vec![0x05, 0x05], false)) // 证据：拒绝字节为 0x05（非 FF），随后 deleteLater
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Socks5Request {
    pub command: u8,
    pub atype: u8,
    pub host: String, // IPv4/IPv6 为十进制字符串（QHostAddress::toString）
    pub port: u16,
}

/// 证据：socks5Request 0x100100fb0 —— 头部 4B(ver,cmd,resv,atype)；总长必须
/// == 6 + addr_len（atype1→4, 4→16, 3→1+len）；cmd!=1→7；atype∉{1,3,4}→8；
/// host 空→5。域名走异步 DNS（$_3），此处同步建模。
pub fn socks5_parse_request(buf: &[u8]) -> Result<(Socks5Request, Option<Socks5Reply>, Option<String>), (Option<Socks5Reply>, String)> {
    // (request, Some(reply)=成功路径预置, None) / Err((Some(reply), msg))
    if buf.len() < 5 {
        return Err((Some(Socks5Reply::ConnectionRefused), SOCKS_ERR_LEN.replace("%1", &buf.len().to_string())));
    }
    let (ver, cmd, _resv, atype) = (buf[0], buf[1], buf[2], buf[3]);
    if ver != 5 {
        return Err((Some(Socks5Reply::ConnectionRefused), SOCKS_ERR_VER.replace("%1", &ver.to_string())));
    }
    if cmd != 1 {
        return Err((Some(Socks5Reply::CommandNotSupported), SOCKS_ERR_CMD.replace("%1", &cmd.to_string())));
    }
    if ![1u8, 3, 4].contains(&atype) {
        return Err((Some(Socks5Reply::AddressTypeNotSupported), SOCKS_ERR_ATYP.replace("%1", &atype.to_string())));
    }
    // 证据顺序：先按 atype 算期望总长并校验（!= 6+addr_len → "address length is invalid"，无应答码），
    // 再解析地址
    let addr_len = match atype {
        1 => 4usize,
        4 => 16usize,
        3 => buf[4] as usize + 1,
        _ => unreachable!(),
    };
    if buf.len() != addr_len + 6 {
        return Err((None, SOCKS_ERR_ADDRLEN.into()));
    }
    let host = match atype {
        1 => ipv4_to_string(&buf[4..8]),
        4 => ipv6_to_string(&buf[4..20]),
        3 => String::from_utf8_lossy(&buf[5..5 + addr_len - 1]).to_string(),
        _ => unreachable!(),
    };
    let port = u16::from_be_bytes([buf[4 + addr_len], buf[5 + addr_len]]);
    if host.is_empty() {
        return Err((Some(Socks5Reply::ConnectionRefused), SOCKS_ERR_EMPTYHOST.into()));
    }
    Ok((Socks5Request { command: cmd, atype, host, port }, Some(Socks5Reply::Succeeded), None))
}

/// 证据：$_2 0x100101a30 —— 应答 [05, rep, 00, atyp', BND.ADDR, BND.PORT]；
/// 请求 atype==3(域名) 时 atyp'=1 且 BND.ADDR=4×0；否则 atyp'=请求值、
/// IPv6 用 AnyIPv6(::)、IPv4 用 0.0.0.0；BND.PORT=0
pub fn socks5_reply(rep: Socks5Reply, req_atype: u8) -> Vec<u8> {
    let (atyp, addr): (u8, Vec<u8>) = if req_atype == 3 {
        (1, vec![0, 0, 0, 0])
    } else if req_atype == 4 {
        (4, vec![0u8; 16])
    } else {
        (1, vec![0, 0, 0, 0])
    };
    let mut v = vec![0x05, rep as u8, 0x00, atyp];
    v.extend(addr);
    v.extend([0, 0]); // port 0
    v
}

fn ipv4_to_string(b: &[u8]) -> String {
    format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
}
fn ipv6_to_string(b: &[u8]) -> String {
    // QHostAddress::toString 的常规压缩形式；重写用 std 规范化即可（语义等价）
    let mut o = [0u16; 8];
    for i in 0..8 {
        o[i] = u16::from_be_bytes([b[i * 2], b[i * 2 + 1]]);
    }
    std::net::Ipv6Addr::from(o).to_string()
}

// ---------------------------------------------------------------- ProxyCommand / 代理配置

/// 证据：socketStateFromProcessState 0x100144540
/// QProcess{NotRunning=0,Starting=1,Running=2} → QAbstractSocket{Unconnected=0,Connecting=2,Connected=3}
pub fn socket_state_from_process_state(process_state: u32) -> u32 {
    match process_state {
        1 => 2,
        2 => 3,
        _ => 0,
    }
}

/// 证据：socketErrorFromProcessError 0x100143e70，表 @0x100982b70 实读 [2,1,5,1]
/// QProcess::ProcessError{FailedToStart=0,Crashed=1,Timedout=2,ReadError=3,WriteError=4}
/// → SocketError{2=ConnectionRefused,1=HostNotFound,5=SocketTimeout,1, 4→1, >4→-1(Unknown)}
pub fn socket_error_from_process_error(err: u32) -> i32 {
    const TABLE: [i32; 4] = [2, 1, 5, 1];
    if err < 4 {
        TABLE[err as usize]
    } else if err == 4 {
        1
    } else {
        -1
    }
}

/// 证据：setProxyCommand 0x100144100 —— splitCommandLine 后**首 token 弹出**为 program，
/// 其余为 args
pub fn split_proxy_command(cmd: &str) -> (String, Vec<String>) {
    let mut tokens: Vec<String> = cmd
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    if tokens.is_empty() {
        return (String::new(), Vec::new());
    }
    let program = tokens.remove(0);
    (program, tokens)
}

/// 代理类型字符串（符号表实读）：None/System/Socks5/Http/ProxyCommand/Global/JumpServers
pub const PROXY_NONE: &str = "None";
pub const PROXY_SYSTEM: &str = "System";
pub const PROXY_SOCKS5: &str = "Socks5";
pub const PROXY_HTTP: &str = "Http";
pub const PROXY_COMMAND: &str = "ProxyCommand";
pub const PROXY_GLOBAL: &str = "Global";
pub const PROXY_JUMPSERVERS: &str = "JumpServers";

/// 证据：SshBridge::setProxy/setProxyCommand —— 仅写入 session 选项表（PROP_SESSION_*），
/// 真正生效在 SshSocket::connectHost（B2.2）；键名从二进制字符串池实读
pub const PROXY_PROP_KEYS: &[&str] = &[
    "session.proxy",
    "session.proxyDns",
    "session.proxyHost",
    "session.proxyPort",
    "session.proxyUser",
    "session.proxyPassword",
    "session.proxyCommand",
    "session.proxyWorkingDirectory",
    "session.proxyEnvironment",
    "session.proxyJumpServer1..4",
];

/// 隧道持久化键（字符串池实读 "ssh.tunnels"；setTunnels 按会话名 setUserSession）
pub const SSH_TUNNELS_KEY: &str = "ssh.tunnels";

/// 证据：SuperSession::asyncOpenTunnelForwarding op=0x16，载荷
/// [type, uuid, listenPort, destHost, destPort, localhostOnly]（autoOpen 不传）；
/// asyncCloseTunnelForwarding op=0xb，载荷 [uuid]
pub const ASYNC_OP_OPEN_TUNNEL: u32 = 0x16;
pub const ASYNC_OP_CLOSE_TUNNEL: u32 = 0xb;
pub const SUPER_SESSION_STATE_READY: u32 = 7;

/// 证据：SuperSession::openTunnelForwarding 0x1002f5a70 —— 按类型分发到 SshBridge
pub fn dispatch_open(bridge: &dyn SshBridgeTunnel, t: &Tunnel) {
    match t.ttype {
        TunnelType::Remote => bridge.open_remote_forwarding(
            &t.uuid, t.listen_port, &t.dest_host, t.dest_port, t.localhost_only,
        ),
        TunnelType::Local => bridge.open_local_forwarding(
            &t.uuid, t.listen_port, &t.dest_host, t.dest_port, t.localhost_only,
        ),
        TunnelType::Dynamic => bridge.open_dynamic_forwarding(&t.uuid, t.listen_port, t.localhost_only),
        TunnelType::Unknown => {}
    }
}

/// SshBridge 隧道面（证据校验过的入口校验：Local/Remote 要求 destHost.trimmed 非空且
/// destPort!=0；Dynamic 无目的端校验）
pub trait SshBridgeTunnel {
    fn open_local_forwarding(&self, uuid: &str, listen: u16, host: &str, port: u16, localhost_only: bool);
    fn open_remote_forwarding(&self, uuid: &str, bind: u16, host: &str, port: u16, localhost_only: bool);
    fn open_dynamic_forwarding(&self, uuid: &str, port: u16, localhost_only: bool);
    fn close_tunnel_forwarding(&self, uuid: &str);
}

pub fn open_local_forwarding_validated(host: &str, port: u16) -> bool {
    // 证据：openLocalForwarding 0x1003a3c70 —— trimmed 非空 && destPort != 0
    !host.trim().is_empty() && port != 0
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn tunnel(t: TunnelType) -> Tunnel {
        Tunnel::new("u1", t)
    }

    #[test]
    fn state_and_type_text_tables() {
        // 证据：0x100ab5460 表 + typeText tr id 解码
        assert_eq!(state_text(TunnelState::WaitingToOpen), "Waiting to open...");
        assert_eq!(state_text(TunnelState::Opened), "Opened");
        assert_eq!(state_text(TunnelState::WaitingToClose), "Waiting to close...");
        assert_eq!(state_text(TunnelState::Closed), "Closed");
        assert_eq!(type_text(TunnelType::Dynamic), "Dynamic forwarding");
        assert_eq!(type_text(TunnelType::Unknown), "");
    }

    #[test]
    fn listening_port_text_three_branches() {
        let mut t = tunnel(TunnelType::Local);
        assert_eq!(t.listening_port_text(), "Dynamic port allocation"); // port=0, state=0
        t.listen_port = 8080;
        assert_eq!(t.listening_port_text(), "8080");
        t.listen_port = 0;
        t.state = TunnelState::Opened;
        t.assigned_port = 54321;
        assert_eq!(t.listening_port_text(), "Local 54321");
        t.ttype = TunnelType::Remote;
        assert_eq!(t.listening_port_text(), "Remote 54321");
        t.ttype = TunnelType::Dynamic; // 证据：非 Remote 一律 Local
        assert_eq!(t.listening_port_text(), "Local 54321");
    }

    #[test]
    fn equality_ignores_name_state_autoopen() {
        // 证据：operator== 只比较 uuid/type/session/ports/destHost/localhostOnly
        let mut a = tunnel(TunnelType::Local);
        let mut b = tunnel(TunnelType::Local);
        a.name = "x".into();
        a.state = TunnelState::Opened;
        a.auto_open = true;
        assert!(a.same_definition(&b));
        a.localhost_only = true;
        b.listen_port = 1;
        assert!(!a.same_definition(&b));
        b.listen_port = 0;
        assert!(!a.same_definition(&b)); // localhostOnly 参与比较
    }

    #[test]
    fn set_tunnel_state_machine() {
        let mut c = TunnelCenter::default();
        let mut t = tunnel(TunnelType::Local);
        t.state = TunnelState::Opened;
        t.assigned_port = 9999;
        c.tunnels.push(t);
        // Closed + 空错误：清 assigned_port，保留旧 error，仍发 changed
        c.set_tunnel("u1", TunnelState::Closed, "");
        let t = c.tunnel_from_uuid("u1").unwrap();
        assert_eq!(t.assigned_port, 0);
        assert_eq!(t.error_level, 0); // 未进入错误赋值分支
        assert_eq!(c.changed.len(), 1);
        // "!important " 前缀 → level 3 + 剥离
        c.set_tunnel("u1", TunnelState::WaitingToOpen, "!important ssh: no agent");
        let t = c.tunnel_from_uuid("u1").unwrap();
        assert_eq!(t.error_level, 3);
        assert_eq!(t.error, "ssh: no agent");
        // 普通错误 → level 4
        c.set_tunnel("u1", TunnelState::WaitingToClose, "boom");
        let t = c.tunnel_from_uuid("u1").unwrap();
        assert_eq!(t.error_level, 4);
        assert_eq!(t.error, "boom");
        // 同 state 同 error → 幂等早退（changed 不再增长）
        let n = c.changed.len();
        c.set_tunnel("u1", TunnelState::WaitingToClose, "boom");
        assert_eq!(c.changed.len(), n);
    }

    #[test]
    fn start_stop_guards_and_session_sharing() {
        let mut c = TunnelCenter::default();
        let mut local = tunnel(TunnelType::Local);
        local.session = "srv".into();
        local.state = TunnelState::Closed;
        let mut dyn_t = Tunnel::new("u2", TunnelType::Dynamic);
        dyn_t.session = "srv".into();
        dyn_t.state = TunnelState::Closed;
        let mut remote = Tunnel::new("u3", TunnelType::Remote);
        remote.session = "srv".into();
        remote.state = TunnelState::Closed;
        c.tunnels = vec![local, dyn_t, remote];

        // 守卫：Opened 不可再 start；Closed 可 start
        c.tunnels[0].state = TunnelState::Opened;
        assert!(!c.start_tunnel("u1"));
        c.tunnels[0].state = TunnelState::Closed;

        assert!(c.start_tunnel("u1")); // 建共享会话 #0
        assert!(c.start_tunnel("u2")); // 复用共享会话 #0（非独占）
        assert_eq!(c.sessions.len(), 1);
        assert_eq!(c.sessions[0].starting, vec!["u1", "u2"]);
        assert!(c.start_tunnel("u3")); // Remote → 新建独占会话 #1
        assert_eq!(c.sessions.len(), 2);
        assert!(c.sessions[1].dedicated);
        // stop 守卫：WaitingToOpen(0) 可停；Closed(3)/WaitingToClose(2) 不可
        assert!(c.stop_tunnel("u1"));
        assert_eq!(c.tunnel_from_uuid("u1").unwrap().state, TunnelState::WaitingToClose);
        assert!(!c.stop_tunnel("u1")); // 已是 WaitingToClose → 幂等拒绝
        assert_eq!(c.sessions[0].starting, vec!["u2"]); // 命中即 break：只清首个
    }

    #[test]
    fn auto_start_only_flags_bit0() {
        let mut c = TunnelCenter::default();
        let mut a = tunnel(TunnelType::Local);
        a.state = TunnelState::Closed;
        a.auto_open = true;
        let mut b = tunnel(TunnelType::Local);
        b.uuid = "u2".into();
        b.state = TunnelState::Closed;
        b.localhost_only = true; // bit1 不触发
        c.tunnels = vec![a, b];
        c.auto_start_tunnels();
        assert_eq!(c.tunnel_from_uuid("u1").unwrap().state, TunnelState::WaitingToOpen);
        assert_eq!(c.tunnel_from_uuid("u2").unwrap().state, TunnelState::Closed);
    }

    #[test]
    fn session_tunnels_roundtrip_with_legacy_tokens() {
        let mut c = TunnelCenter::default();
        c.add_session_tunnels(
            "srv",
            "srv",
            "Web:Local(localhost)(auto),8080,127.0.0.1:80;Direct,2222,example.com:22;Socks:Reverse,3306,db:3306;D:Dynamic(auto),1080,Any",
        );
        assert_eq!(c.tunnels.len(), 4);
        let t0 = &c.tunnels[0];
        assert_eq!((t0.name.as_str(), t0.ttype, t0.listen_port, t0.dest_host.as_str(), t0.dest_port),
                   ("Web", TunnelType::Local, 8080, "127.0.0.1", 80));
        assert!(t0.localhost_only && t0.auto_open);
        // 旧 token：Direct→Local、Reverse→Remote；无名→default:port
        assert_eq!(c.tunnels[1].ttype, TunnelType::Local);
        assert_eq!(c.tunnels[1].name, "srv:2222");
        assert_eq!(c.tunnels[2].ttype, TunnelType::Remote);
        assert_eq!(c.tunnels[3].ttype, TunnelType::Dynamic);
        assert_eq!(c.tunnels[3].dest_host, "");
        // 序列化回去（sessionTunnels 格式）
        let s = c.session_tunnels("srv");
        assert!(s.contains("Web:Local(localhost)(auto),8080,127.0.0.1:80"));
        assert!(s.contains("srv:2222:Local,2222,example.com:22"));
        assert!(s.contains(",1080,Any"));
    }

    #[test]
    fn socks5_handshake_vectors() {
        // 无方法 → [05,05]（证据实证，非 RFC 0xFF）
        let (reply, ok) = socks5_handshake(&[5, 1, 2]).unwrap(); // method=2 (GSSAPI)
        assert_eq!(reply, vec![5, 5]);
        assert!(!ok);
        // 含 0 → [05,00]
        let (reply, ok) = socks5_handshake(&[5, 2, 0, 2]).unwrap();
        assert_eq!(reply, vec![5, 0]);
        assert!(ok);
        // 长度/版本错误
        assert!(socks5_handshake(&[5, 1]).is_err());
        let e = socks5_handshake(&[4, 1, 0]).unwrap_err();
        assert!(e.contains("version: 4"));
    }

    #[test]
    fn socks5_request_vectors() {
        // IPv4 CONNECT 1.2.3.4:80
        let req = socks5_parse_request(&[5, 1, 0, 1, 1, 2, 3, 4, 0, 80]).unwrap().0;
        assert_eq!((req.host.as_str(), req.port, req.atype), ("1.2.3.4", 80, 1));
        // 域名 example.com:443
        let mut b = vec![5, 1, 0, 3, 11];
        b.extend(b"example.com");
        b.extend([0x01, 0xbb]);
        let req = socks5_parse_request(&b).unwrap().0;
        assert_eq!((req.host.as_str(), req.port), ("example.com", 443));
        // 命令不支持 → 7；地址族不支持 → 8；长度不符 → addr invalid（无应答码）
        assert_eq!(socks5_parse_request(&[5, 2, 0, 1, 1, 1, 1, 1, 0, 1]).unwrap_err().0,
                   Some(Socks5Reply::CommandNotSupported));
        assert_eq!(socks5_parse_request(&[5, 1, 0, 9, 1, 1, 1, 1, 0, 1]).unwrap_err().0,
                   Some(Socks5Reply::AddressTypeNotSupported));
        assert!(socks5_parse_request(&[5, 1, 0, 1, 1, 2, 3]).unwrap_err().0.is_none());
        // 应答格式：域名请求 → atyp'=1 + 0.0.0.0:0（证据 $_2）
        assert_eq!(socks5_reply(Socks5Reply::Succeeded, 3),
                   vec![5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(socks5_reply(Socks5Reply::CommandNotSupported, 1),
                   vec![5, 7, 0, 1, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn x11_display_rules() {
        // 空串 → 环境 DISPLAY 尾数 → unix socket 路径
        assert_eq!(parse_x11_display("", Some("host:11.0")),
                   X11Target::Unix { path: "/tmp/.X11-unix/X11".into() });
        // loopback TCP：port+6000
        assert_eq!(parse_x11_display("localhost:1", None),
                   X11Target::Tcp { host: "localhost".into(), port: 6001 });
        assert_eq!(parse_x11_display("127.0.0.1:0", None),
                   X11Target::Tcp { host: "127.0.0.1".into(), port: 6000 });
        // 非 loopback 主机 → 拒绝
        assert_eq!(parse_x11_display("10.0.0.5:0", None), X11Target::Reject);
        assert_eq!(parse_x11_display("evil.example:1", None), X11Target::Reject);
    }

    #[test]
    fn proxy_command_tables() {
        assert_eq!(socket_state_from_process_state(0), 0); // NotRunning→Unconnected
        assert_eq!(socket_state_from_process_state(1), 2); // Starting→Connecting
        assert_eq!(socket_state_from_process_state(2), 3); // Running→Connected
        assert_eq!(socket_error_from_process_error(0), 2); // FailedToStart→ConnectionRefused
        assert_eq!(socket_error_from_process_error(2), 5); // Timedout→SocketTimeout
        assert_eq!(socket_error_from_process_error(4), 1); // WriteError→1
        assert_eq!(socket_error_from_process_error(9), -1); // Unknown
        // 首 token 弹出为 program
        let (p, a) = split_proxy_command("ssh -W %h:%p gateway");
        assert_eq!(p, "ssh");
        assert_eq!(a, vec!["-W", "%h:%p", "gateway"]);
    }

    #[test]
    fn forwarding_center_reuse_and_cleanup() {
        let mut fc = ForwardingCenter::default();
        let h1 = 0x1000usize;
        let h2 = 0x2000usize;
        fc.start_forwarding_server(h1, "u1", ProxyServerType::Tcp, 8080, "127.0.0.1", 80, true);
        // 同 uuid+port 复用服务器
        fc.start_forwarding_server(h1, "u1", ProxyServerType::Tcp, 8080, "127.0.0.1", 443, true);
        assert_eq!(fc.servers.len(), 1);
        assert_eq!(fc.servers[0].forwardings.len(), 2); // dest 不同 → 两表项
        fc.start_forwarding_server(h2, "u1", ProxyServerType::Tcp, 8080, "127.0.0.1", 80, true);
        assert_eq!(fc.servers[0].forwardings.len(), 3);
        // removeForwardingServer 按 uuid 整台删除（证据：不区分 handler）
        fc.remove_forwarding_server(h1, "u1");
        assert!(fc.servers.is_empty());
        // removeForwardingHandler：表项清空才删服务器
        fc.start_forwarding_server(h1, "u2", ProxyServerType::Socks5, 1080, "", 0, false);
        fc.start_forwarding_server(h2, "u2", ProxyServerType::Socks5, 1080, "", 0, false);
        fc.remove_forwarding_handler(h1);
        assert_eq!(fc.servers.len(), 1);
        fc.remove_forwarding_handler(h2);
        assert!(fc.servers.is_empty());
        assert_eq!(fc.server_port("u2"), 0);
    }

    #[test]
    fn bridge_validation_and_dispatch() {
        // openLocalForwarding 校验：destHost.trimmed 非空 && destPort!=0
        assert!(open_local_forwarding_validated("h", 80));
        assert!(!open_local_forwarding_validated("  ", 80));
        assert!(!open_local_forwarding_validated("h", 0));

        struct Rec(std::cell::RefCell<Vec<String>>);
        impl SshBridgeTunnel for Rec {
            fn open_local_forwarding(&self, u: &str, l: u16, h: &str, p: u16, lo: bool) {
                self.0.borrow_mut().push(format!("L {u} {l} {h} {p} {lo}"));
            }
            fn open_remote_forwarding(&self, u: &str, l: u16, h: &str, p: u16, lo: bool) {
                self.0.borrow_mut().push(format!("R {u} {l} {h} {p} {lo}"));
            }
            fn open_dynamic_forwarding(&self, u: &str, p: u16, lo: bool) {
                self.0.borrow_mut().push(format!("D {u} {p} {lo}"));
            }
            fn close_tunnel_forwarding(&self, u: &str) {
                self.0.borrow_mut().push(format!("C {u}"));
            }
        }
        let rec = Rec(std::cell::RefCell::new(Vec::new()));
        let mut t = tunnel(TunnelType::Remote);
        t.listen_port = 3306;
        t.dest_host = "db".into();
        t.dest_port = 3306;
        t.localhost_only = true;
        dispatch_open(&rec, &t);
        t.ttype = TunnelType::Dynamic;
        dispatch_open(&rec, &t);
        t.ttype = TunnelType::Unknown;
        dispatch_open(&rec, &t); // 不产生调用
        assert_eq!(rec.0.borrow().as_slice(),
                   ["R u1 3306 db 3306 true", "D u1 3306 true"]);
        assert_eq!(ASYNC_OP_OPEN_TUNNEL, 22);
        assert_eq!(ASYNC_OP_CLOSE_TUNNEL, 11);
    }
}
