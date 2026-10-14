//! 裸 TCP 会话 —— socket 连接、选项设置与代理装配引擎。
//! 会话属性：session.tcpLowDelay / session.tcpKeepAlive /
//! session.tcpReceiveBufferSize / session.tcpSendBufferSize / session.target。
//! 代理类型字符串：
//! "ProxyCommand" "Global" "Http" "JumpServers" "None" "Socks5" "System"。
//!
//! 语义：
//! 1. attach：connectToHost(host, port, 3=ReadWrite, 2=?)
//!    —— 第 4 实参 2 在本层未使用（代理 socket 归 re/tunnel.rs 模块）。
//! 2. detach：detaching → disconnectFromHost → setState(0) → detached（无条件对）。
//! 3. setOption 映射到 socket 选项码后 setSocketOption：
//!    tcpLowDelay→0(LowDelay/NODELAY)、tcpKeepAlive→1、
//!    tcpSendBufferSize→5、tcpReceiveBufferSize→6；未知键忽略。
//! 4. setProxy(type, host, port, user, password)：
//!    "System"→取系统代理；"Http"→类型码 3
//!    （仅 CONNECT 的 HTTP 代理）；"Socks5"→1；其余→哨兵码 2=占位代理。
//!    末段守卫：类型码==2（哨兵）则不调用 socket->setProxy ——
//!    哨兵 2 即"不设代理=直连"。System 分支产出的代理同样过该守卫。
//! 5. setProxyCommand(type, command, workingDir, extra)：仅当
//!    type=="ProxyCommand" 才生效——socket.setProxyCommand(command)、
//!    setProxyWorkingDirectory(dir)，并把第 4 参作为附加环境值写入
//!    （字段用途归 re/tunnel.rs 模块核对）。
//! 6. read/write/lastErrorString：薄转发。

pub const STATE_DETACHED: u32 = 0;
pub const STATE_ATTACHED: u32 = 3;

/// 代理类型字符串
pub const PROXY_COMMAND: &str = "ProxyCommand";
pub const PROXY_GLOBAL: &str = "Global";
pub const PROXY_HTTP: &str = "Http";
pub const PROXY_JUMPSERVERS: &str = "JumpServers";
pub const PROXY_NONE: &str = "None";
pub const PROXY_SOCKS5: &str = "Socks5";
pub const PROXY_SYSTEM: &str = "System";

/// socket 选项码（setOption 使用的映射表）
pub const OPT_LOW_DELAY: u8 = 0; // session.tcpLowDelay → TCP_NODELAY
pub const OPT_KEEP_ALIVE: u8 = 1; // session.tcpKeepAlive
pub const OPT_SEND_BUF: u8 = 5; // session.tcpSendBufferSize
pub const OPT_RECV_BUF: u8 = 6; // session.tcpReceiveBufferSize

/// setOption：属性名 → socket 选项码；未知键返回 None
pub fn tcp_socket_option(prop: &str) -> Option<u8> {
    match prop {
        "session.tcpLowDelay" => Some(OPT_LOW_DELAY),
        "session.tcpKeepAlive" => Some(OPT_KEEP_ALIVE),
        "session.tcpReceiveBufferSize" => Some(OPT_RECV_BUF),
        "session.tcpSendBufferSize" => Some(OPT_SEND_BUF),
        _ => None,
    }
}

/// 代理解析结果（setProxy 分流）
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolvedProxy {
    /// "System"：取系统代理，仍过 type!=2 守卫
    System,
    /// "Http" → 类型码 3（仅 CONNECT 的 HTTP 代理）
    HttpConnectOnly { host: String, port: u16, user: String, password: String },
    /// "Socks5" → 类型码 1
    Socks5 { host: String, port: u16, user: String, password: String },
    /// 其余（"None"/"Global"/未知）→ 哨兵码 2 → 不设代理，直连
    Direct,
}

/// 代理类型码：Http→3、Socks5→1、哨兵→2
pub fn proxy_type_code(kind: &ResolvedProxy) -> u8 {
    match kind {
        ResolvedProxy::Socks5 { .. } => 1,
        ResolvedProxy::Direct => 2, // 占位/哨兵
        ResolvedProxy::HttpConnectOnly { .. } => 3,
        ResolvedProxy::System => 0, // 由系统代理实际决定，此处仅占位
    }
}

/// setProxy 分流：type 字符串 → ResolvedProxy（大小写敏感）
pub fn resolve_proxy(type_: &str, host: &str, port: u16, user: &str, password: &str) -> ResolvedProxy {
    match type_ {
        PROXY_SYSTEM => ResolvedProxy::System,
        PROXY_HTTP => ResolvedProxy::HttpConnectOnly {
            host: host.into(),
            port,
            user: user.into(),
            password: password.into(),
        },
        PROXY_SOCKS5 => ResolvedProxy::Socks5 {
            host: host.into(),
            port,
            user: user.into(),
            password: password.into(),
        },
        _ => ResolvedProxy::Direct,
    }
}

/// 末段守卫：类型码==2（哨兵）→ 不应用代理
pub fn should_apply_proxy(p: &ResolvedProxy) -> bool {
    proxy_type_code(p) != 2
}

/// ProxyCommand 三元组（setProxyCommand 生效时写入 socket）
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ProxyCommand {
    pub command: String,
    pub working_directory: String,
    /// 附加环境值（第 4 参，用途待 re/tunnel.rs 核对）
    pub extra: String,
}

/// setProxyCommand 门控：仅 type=="ProxyCommand" 才写 socket
pub fn proxy_command_from(type_: &str, command: &str, workdir: &str, extra: &str) -> Option<ProxyCommand> {
    if type_ == PROXY_COMMAND {
        Some(ProxyCommand { command: command.into(), working_directory: workdir.into(), extra: extra.into() })
    } else {
        None
    }
}

/// 桥状态机（attach/detach 信号顺序 + 已应用选项/代理）
#[derive(Debug, Default)]
pub struct TcpBridge {
    pub state: u32,
    pub signals: Vec<&'static str>,
    pub socket_options: Vec<(u8, String)>,
    pub proxy: Option<ResolvedProxy>,
    pub proxy_command: Option<ProxyCommand>,
}

impl TcpBridge {
    /// attach：connectToHost(host, port, ReadWrite=3, 2)（异步，状态由 socket 信号驱动）
    pub fn attach(&mut self, host: &str, port: u16) -> (String, u16, u32) {
        (host.to_string(), port, OPEN_MODE_READWRITE)
    }

    /// detach：detaching → disconnect → state=0 → detached（无条件序列）
    pub fn detach(&mut self) {
        self.signals.push("detaching");
        self.state = STATE_DETACHED;
        self.signals.push("detached");
    }

    /// setOption：未知键忽略；已知键记录 (code, value)
    pub fn set_option(&mut self, prop: &str, value: &str) -> bool {
        match tcp_socket_option(prop) {
            Some(code) => {
                self.socket_options.push((code, value.to_string()));
                true
            }
            None => false,
        }
    }

    /// setProxy：解析并仅在非哨兵时应用
    pub fn set_proxy(&mut self, type_: &str, host: &str, port: u16, user: &str, password: &str) {
        let p = resolve_proxy(type_, host, port, user, password);
        if should_apply_proxy(&p) {
            self.proxy = Some(p);
        } else {
            self.proxy = None; // 直连：不触碰 socket 代理
        }
    }

    /// setProxyCommand：门控写入
    pub fn set_proxy_command(&mut self, type_: &str, command: &str, workdir: &str, extra: &str) -> bool {
        self.proxy_command = proxy_command_from(type_, command, workdir, extra);
        self.proxy_command.is_some()
    }
}

/// attach 的 OpenMode 实参（3=ReadWrite）
pub const OPEN_MODE_READWRITE: u32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_mapping() {
        assert_eq!(tcp_socket_option("session.tcpLowDelay"), Some(0));
        assert_eq!(tcp_socket_option("session.tcpKeepAlive"), Some(1));
        assert_eq!(tcp_socket_option("session.tcpSendBufferSize"), Some(5));
        assert_eq!(tcp_socket_option("session.tcpReceiveBufferSize"), Some(6));
        assert_eq!(tcp_socket_option("session.proxy"), None); // 非 socket 选项
        assert_eq!(tcp_socket_option("bogus"), None);
    }

    #[test]
    fn proxy_type_dispatch() {
        let p = resolve_proxy("Socks5", "127.0.0.1", 1080, "u", "p");
        assert_eq!(p, ResolvedProxy::Socks5 { host: "127.0.0.1".into(), port: 1080, user: "u".into(), password: "p".into() });
        assert_eq!(proxy_type_code(&p), 1);
        let h = resolve_proxy("Http", "h", 8080, "", "");
        assert_eq!(proxy_type_code(&h), 3); // Http → 3
        assert!(should_apply_proxy(&h));
        // "None"/"Global"/未知 → 哨兵 2 → 直连（不 setProxy）
        for t in ["None", "Global", "JumpServers", "Whatever", ""] {
            let d = resolve_proxy(t, "h", 1, "", "");
            assert_eq!(d, ResolvedProxy::Direct);
            assert!(!should_apply_proxy(&d));
        }
        // 大小写敏感
        assert_ne!(resolve_proxy("socks5", "h", 1, "", ""), ResolvedProxy::Socks5 { host: "h".into(), port: 1, user: "".into(), password: "".into() });
    }

    #[test]
    fn proxy_command_gate() {
        assert!(proxy_command_from("ProxyCommand", "ssh -W %h:%p gw", "/tmp", "env").is_some());
        assert!(proxy_command_from("Socks5", "x", "y", "z").is_none());
        let mut b = TcpBridge::default();
        assert!(!b.set_proxy_command("Http", "c", "w", "e"));
        assert!(b.proxy_command.is_none());
        assert!(b.set_proxy_command("ProxyCommand", "nc %h %p", "/usr/bin", ""));
        let pc = b.proxy_command.clone().unwrap();
        assert_eq!(pc.command, "nc %h %p");
        assert_eq!(pc.working_directory, "/usr/bin");
    }

    #[test]
    fn bridge_flow() {
        let mut b = TcpBridge::default();
        // attach 参数：ReadWrite=3
        assert_eq!(b.attach("example.com", 6000), ("example.com".into(), 6000, 3));
        b.set_option("session.tcpLowDelay", "1");
        b.set_option("session.tcpKeepAlive", "1");
        assert!(!b.set_option("unknown", "1")); // 未知键不记录
        assert_eq!(b.socket_options.len(), 2);
        b.set_proxy("Socks5", "127.0.0.1", 7890, "", "");
        assert!(b.proxy.is_some());
        b.set_proxy("None", "", 0, "", "");
        assert!(b.proxy.is_none()); // 直连清代理（哨兵路径不 setProxy）
        b.detach();
        assert_eq!(b.signals, vec!["detaching", "detached"]);
        assert_eq!(b.state, STATE_DETACHED);
    }
}
