//! SSH 连接流 —— 语义重写自 WindTerm 2.6.0 `SshSocket` / `SshBridge::__attach` /
//! `ProxyCommandSocket` / `Ssh::Session`（libssh fork 交互）。
//! 证据：re-work/decompiled/session/*.pseudo.txt（Ghidra）+
//! re-work/decompiled/SshBridge____attach__lambda1_listening.asm.txt（r2, entry 0x1003a8e00）+
//! re-work/decompiled/libssh_fork__ssh_options_set__case44_45.txt（libssh.4.dylib）+
//! re-work/decompiled/King____enums_moc_evidence.txt。
//! 语义笔记：re-work/notes/ssh_connect.md。
//!
//! 核心架构（实证）：libssh 不直连真实主机 —— SshSocket 是
//!   真实网络 outer socket（TCP/HTTP/SOCKS5/代理命令进程） ⇄ 256KB 内存块队列 ⇄ libssh 回调泵，
//!   且 libssh 的 TCP 连接目标被 fork 的 PROXY_HOST/PROXY_PORT 选项覆盖为本地中继端口
//!   （HOST/PORT 保留为逻辑身份，供 known_hosts 使用）。

/// WindTerm 捆绑 libssh fork 的 ssh_options_e（编号实证：
/// setUser 直写 7；__attach::$_1 反汇编立即数；dylib ssh_options_set 46-case 跳转表）。
/// 与公开头文件 v2.6.0 的差异：二进制在 44 处多一个字符串项（agent socket），
/// EXTERNAL_CALLBACKS 在二进制中为 45（见 notes 未确证清单）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum SshOption {
    Host = 0,
    Port = 1,
    ProxyHost = 3,
    ProxyPort = 4,
    User = 7,
    SshDir = 8,
    Timeout = 12,
    LogVerbosity = 16,
    CiphersCS = 18,
    KeyExchange = 27,
    HmacCS = 32,
    Nodelay = 39,
    PubkeyAcceptedTypes = 40,
    RekeyData = 42,
    RekeyTime = 43,
    /// 二进制观察号 44：字符串 + ssh_path_expand_tilde（dylib case44）
    IdentityAgent = 44,
    /// 二进制观察号 45：拷贝 5 指针 {user, flush, bytes_to_recv, in, out}（dylib case45）
    ExternalCallbacks = 45,
}

/// ssh_options_set 的值域（fork 的三个包装重载：char*/long/long long）
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptValue {
    Str(String),
    Long(i64),
    LongLong(i64),
}

/// King::SessionState（moc 元数据顺序实证，见 King____enums_moc_evidence.txt）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum SessionState {
    Unconnected = 0,
    HostLookup = 1,
    Connecting = 2,
    Connected = 3,
    Bound = 4,
    Closing = 5,
    Listening = 6,
    HostAuthed = 7,
    HostAuthing = 8,
    HostDenied = 9,
    HostVerified = 10,
}

/// King::ServerKnownState
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum ServerKnownState {
    ServerUnknown = 0,
    ServerKnown = 1,
    ServerChanged = 2,
    ServerMismatched = 3,
}

/// Ssh::Session::mapServerKnown —— 证据 entry 100113780：
/// 1->1, 2->2, 3->3, 其余->0
pub fn map_server_known(libssh_code: i32) -> ServerKnownState {
    match libssh_code {
        1 => ServerKnownState::ServerKnown,
        2 => ServerKnownState::ServerChanged,
        3 => ServerKnownState::ServerMismatched,
        _ => ServerKnownState::ServerUnknown,
    }
}

/// Ssh::Session::serverKnownState —— 证据 entry 100113c30：
/// ssh_is_server_known() ∈ 1..=3 原样透传；-1 抛异常；其余（0=NOT_KNOWN、4=FILE_NOT_FOUND…）归 0。
/// Err(()) 对应二进制中的 throw Ssh::Exception(session)。
pub fn server_known_state(libssh_code: i32) -> Result<ServerKnownState, ()> {
    if libssh_code == -1 {
        return Err(()); // 证据：___cxa_throw(Exception(session))
    }
    let clamped = if (1..=3).contains(&libssh_code) { libssh_code } else { 0 };
    Ok(map_server_known(clamped))
}

/// SshBridge::setOption 的 TCP 属性 -> QAbstractSocket::SocketOption 编号。
/// 证据 entry 1003a7380 与 connectHost(1003b04e0) 两处一致：
/// LowDelay->0, KeepAlive->1, ReceiveBufferSize->6, SendBufferSize->5。
/// 注：Qt5 枚举中 Receive=5/Send=6 —— WindTerm 将收发缓冲**交换**传递（两调用点一致，
/// 属实现者一致的怪癖，按原样复刻；russh 落地时如需正确语义请显式纠正）。
pub fn tcp_option_code(prop: &str) -> Option<u8> {
    match prop {
        "session.tcpLowDelay" => Some(0),
        "session.tcpKeepAlive" => Some(1),
        "session.tcpReceiveBufferSize" => Some(6),
        "session.tcpSendBufferSize" => Some(5),
        _ => None,
    }
}

/// REKEY_DATALIMIT：存储值 = 输入MB << 20（证据 entry 1003a7380：`lVar4 << 0x14`，负数丢弃）
pub fn rekey_data_mb_to_bytes(mb: i64) -> Option<i64> {
    if mb < 0 {
        None
    } else {
        Some(mb << 20)
    }
}

/// REKEY_TIMELIMIT：存储值 = min(输入分钟, 60000) * 60 秒（证据：`iVar5 * 0x3c`，负数丢弃）
pub fn rekey_time_min_to_secs(min: i64) -> Option<i64> {
    if min < 0 {
        None
    } else {
        Some(min.min(60_000) * 60)
    }
}

/// LOGTYPE 属性：bit2(&4) 开启协议日志（证据：`(toInt & 4) != 0 -> this[0xe8]=1`）
pub fn logtype_enables_protocol(logtype: i32) -> bool {
    (logtype & 4) != 0
}

/// __attach::$_1 的 ssh_options_set 键表（证据 0x1003a8e00 反汇编，逐调用点）。
/// 返回按二进制执行顺序排列的 (选项, 值) 序列；条件项按证据中的分支跳过。
#[derive(Clone, Debug)]
pub struct BridgeConfig {
    pub host: String,             // 逻辑主机（known_hosts 身份）
    pub port: u16,                // 逻辑端口
    pub relay_listen_port: u16,   // SshSocket 本地中继 QTcpServer 实际端口（listening 信号）
    pub known_path: String,       // CTerminalConfig::defaultKnownPath()
    pub agent_socket: String,     // sessionOption("sshAgent.<system>") 或默认
    pub ciphers: String,
    pub key_exchange: String,
    pub mac_hashes: String,
    pub public_keys: String,
    pub connection_timeout_secs: i32, // bridge+0xec（0=未设）
    pub rekey_data_bytes: i64,        // bridge+0xf8（-1=未设）
    pub rekey_time_secs: i64,         // bridge+0xf0（-1=未设）
    pub protocol_log: bool,           // bridge[0xe8]（LOGTYPE&4）
}

pub fn build_session_options(cfg: &BridgeConfig) -> Vec<(SshOption, OptValue)> {
    let mut v = Vec::new();
    // 恒设项
    v.push((SshOption::Host, OptValue::Str(cfg.host.clone())));
    v.push((SshOption::Port, OptValue::Long(cfg.port as i64)));
    // 中继端点覆盖：fork 的 PROXY_HOST/PROXY_PORT 决定真实 TCP 连接目标
    // （dylib ssh_connect 0xf7c1：proxy_host 非空则连 proxy_host:proxy_port，端口 0 时缺省 22）
    v.push((SshOption::ProxyHost, OptValue::Str("0.0.0.0".into()))); // QHostAddress(AnyIPv4).toString()
    v.push((SshOption::ProxyPort, OptValue::Long(cfg.relay_listen_port as i64)));
    v.push((SshOption::SshDir, OptValue::Str(cfg.known_path.clone())));
    v.push((SshOption::Nodelay, OptValue::Long(1)));
    v.push((SshOption::IdentityAgent, OptValue::Str(cfg.agent_socket.clone())));
    // 非空才设（证据：QString size!=0 分支）
    for (opt, s) in [
        (SshOption::CiphersCS, &cfg.ciphers),
        (SshOption::KeyExchange, &cfg.key_exchange),
        (SshOption::HmacCS, &cfg.mac_hashes),
        (SshOption::PubkeyAcceptedTypes, &cfg.public_keys),
    ] {
        if !s.is_empty() {
            v.push((opt, OptValue::Str(s.clone())));
        }
    }
    // !=0 / !=-1 才设
    if cfg.connection_timeout_secs != 0 {
        v.push((SshOption::Timeout, OptValue::Long(cfg.connection_timeout_secs as i64)));
    }
    if cfg.rekey_data_bytes != -1 {
        v.push((SshOption::RekeyData, OptValue::LongLong(cfg.rekey_data_bytes)));
    }
    if cfg.rekey_time_secs != -1 {
        v.push((SshOption::RekeyTime, OptValue::Long(cfg.rekey_time_secs)));
    }
    // 外部回调（恒设；结构体在二进制中为 {user, flush, bytes_to_recv, in, out} 5 指针）
    v.push((SshOption::ExternalCallbacks, OptValue::Long(1))); // 占位：回调结构非数据
    // 条件日志（证据：bridge[0xe8]!=0 才 setOption(16,4)，4=SSH_LOG_PACKET）
    if cfg.protocol_log {
        v.push((SshOption::LogVerbosity, OptValue::Long(4)));
    }
    v
}

/// connectHost/setSocketOption/state 的自旋锁退避（证据 entry 1003b04e0 循环）：
/// 第 0-1 次忙等；2..=15 sched_yield；16..=31 睡 100ms；>=32 睡 10s。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backoff {
    Busy,
    Yield,
    SleepMs(u64),
}
pub fn backoff(attempt: u32) -> Backoff {
    if attempt < 2 {
        Backoff::Busy
    } else if attempt < 16 {
        Backoff::Yield
    } else if attempt < 32 {
        Backoff::SleepMs(100)
    } else {
        Backoff::SleepMs(10_000)
    }
}

/// connectHost 的代理解析（证据 entry 1003b04e0 的 PROP_SESSION_PROXY 分支）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProxyResolution {
    /// "command"：走 ProxyCommandSocket 进程桥（程序/工作目录/环境三元组）
    Command { command: String, working_dir: String, environment: String },
    /// "system"：取 SuperApplication::systemProxy()
    System,
    /// "http" -> QNetworkProxy 类型码 3；"socks5" -> 1（实证值）
    Endpoint { kind: &'static str, type_code: u8, host: String, port: u16, user: String, password: String, proxy_dns: bool },
    /// 其他字符串：跳过代理设置
    Skip,
}

pub fn resolve_proxy(props: &std::collections::HashMap<String, String>) -> ProxyResolution {
    let get = |k: &str| props.get(k).cloned().unwrap_or_default();
    match get("session.proxy").as_str() {
        "command" => ProxyResolution::Command {
            command: get("session.proxyCommand"),
            working_dir: get("session.proxyWorkingDirectory"),
            environment: get("session.proxyEnvironment"),
        },
        "system" => ProxyResolution::System,
        "http" => ProxyResolution::Endpoint {
            kind: "http",
            type_code: 3,
            host: get("session.proxyHost"),
            port: get("session.proxyPort").parse().unwrap_or(0),
            user: get("session.proxyUser"),
            password: get("session.proxyPassword"),
            proxy_dns: get("session.proxyDns") == "true",
        },
        "socks5" => ProxyResolution::Endpoint {
            kind: "socks5",
            type_code: 1,
            host: get("session.proxyHost"),
            port: get("session.proxyPort").parse().unwrap_or(0),
            user: get("session.proxyUser"),
            password: get("session.proxyPassword"),
            proxy_dns: get("session.proxyDns") == "true",
        },
        _ => ProxyResolution::Skip,
    }
}

/// connectHost 末尾规则：`if (QNetworkProxy::type() != 2) outer->setProxy(proxy)`
/// （type 2 = HttpProxy —— 该情形不设 Qt 套接字代理）
pub fn should_apply_qt_proxy(proxy_type_code: u8) -> bool {
    proxy_type_code != 2
}

/// proxyDns==false 时清除 capabilities 的 0x10 位（SuperApplication::networkProxy 证据：
/// `setCapabilities(caps & 0xffffffef)`）
pub fn apply_proxy_dns_capability(caps: u32, proxy_dns: bool) -> u32 {
    if proxy_dns {
        caps
    } else {
        caps & !0x10
    }
}

/// ProxyCommandSocket::connectToHost（证据 entry 1001439c0）：
/// 程序串非空 -> 进程桥；否则普通 TCP 连接。
pub fn proxy_command_connects_process(program: &str) -> bool {
    !program.is_empty()
}

/// ProxyCommandSocket::socketStateFromProcessState（证据 entry 100144540）：
/// QProcess{NotRunning=0,Starting=1,Running=2} -> QAbstractSocket{Unconnected=0,Connecting=2,Connected=3}
pub fn process_state_to_socket_state(state: u8) -> u8 {
    match state {
        1 => 2, // Starting -> Connecting
        2 => 3, // Running  -> Connected
        _ => 0, // NotRunning(0) 及其余 -> Unconnected
    }
}

/// ProxyCommandSocket::socketErrorFromProcessError（证据 entry 100143e70 +
/// 数据表 0x100982b70 实读 [2,1,5,1]）：
/// QProcess::ProcessError{FailedToStart=0,Crashed=1,Timedout=2,ReadError=3,WriteError=4}
/// -> QAbstractSocket::SocketError{ConnectionRefused=1,RemoteHostClosed=2,SocketTimeout=5,Unknown=-1}
pub fn process_error_to_socket_error(err: u32) -> i32 {
    match err {
        0 => 2,  // FailedToStart -> RemoteHostClosedError
        1 => 1,  // Crashed -> ConnectionRefusedError
        2 => 5,  // Timedout -> SocketTimeoutError
        3 => 1,  // ReadError -> ConnectionRefusedError
        4 => 1,  // WriteError -> ConnectionRefusedError（代码式 (err==4)*2-1）
        _ => -1, // 其余 -> UnknownSocketError
    }
}

/// setProxyCommand（证据 entry 100144100）：splitCommandLine 后 args[0]=程序、其余=参数。
/// 分词器仅部分实证（trim + 空白分隔 + 反斜杠转义分支，见 notes 未确证清单）。
pub fn split_proxy_command(cmd: &str) -> (String, Vec<String>) {
    let mut args: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    let mut started = false;
    for ch in cmd.trim().chars() {
        if escaped {
            cur.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch.is_whitespace() {
            if started {
                args.push(std::mem::take(&mut cur));
                started = false;
            }
        } else {
            cur.push(ch);
            started = true;
        }
    }
    if started {
        args.push(cur);
    }
    if args.is_empty() {
        (String::new(), args)
    } else {
        let program = args.remove(0);
        (program, args)
    }
}

use std::collections::VecDeque;

/// SshSocket 接收队列的语义模型（onOuterSocketReadyRead + read + bytesToRead 证据）：
/// - 256KB 块；队尾块容量足够则复用，否则从池取新块
/// - read 部分消费：memmove 剩余、计数递减、块空则归还池
/// - bytes_to_read：outer 消失 => -1；否则 (count>0)，无数据时阻塞等待（此处建模为非阻塞谓词）
pub struct RelayQueue {
    block_size: usize,
    blocks: VecDeque<Block>,
    pub bytes_to_read: i64,
    pub outer_alive: bool,
}

#[derive(Clone)]
struct Block {
    data: Vec<u8>,
    used: usize,
}

impl RelayQueue {
    pub fn new() -> Self {
        Self { block_size: 0x40000, blocks: VecDeque::new(), bytes_to_read: 0, outer_alive: true }
    }

    /// onOuterSocketReadyRead 的分配语义：优先复用队尾（剩余容量 >= 来量），否则新块。
    /// 返回实际写入的块索引。
    pub fn push_chunk(&mut self, incoming_len: usize) -> usize {
        let idx = match self.blocks.back() {
            Some(b) if b.data.capacity() - b.used >= incoming_len => self.blocks.len() - 1,
            _ => {
                self.blocks.push_back(Block { data: Vec::with_capacity(self.block_size), used: 0 });
                self.blocks.len() - 1
            }
        };
        idx
    }

    /// 模拟 outer->read 追加 n 字节（n<0 对应读错误 -> errorOccurred，由调用方处理）
    pub fn append(&mut self, idx: usize, bytes: &[u8]) {
        let b = &mut self.blocks[idx];
        b.data.extend_from_slice(bytes);
        b.used += bytes.len();
        self.bytes_to_read += bytes.len() as i64;
    }

    /// SshSocket::read(ssh_buffer*)：把队首最多 out.len() 字节交给 libssh 缓冲。
    /// 返回实际消费字节数；部分消费保留剩余；块空则出队。
    pub fn read_into(&mut self, out: &mut [u8]) -> usize {
        let mut done = 0usize;
        while done < out.len() {
            let Some(front) = self.blocks.front_mut() else { break };
            let take = (out.len() - done).min(front.used);
            out[done..done + take].copy_from_slice(&front.data[..take]);
            // memmove 剩余
            front.data.drain(..take);
            front.used -= take;
            done += take;
            self.bytes_to_read -= take as i64;
            if front.used == 0 {
                self.blocks.pop_front(); // CyclicMemoryPool::freeMemoryBlock
            }
        }
        done
    }

    /// bytesToRead 谓词：outer 消失 -> -1；否则 (bytes_to_read > 0)
    pub fn bytes_available(&self) -> i64 {
        if !self.outer_alive {
            -1
        } else {
            i64::from(self.bytes_to_read > 0)
        }
    }
}

/// SuperSession::onAsyncMessage 操作码 -> 处理器名（全表证据见
/// decompiled/SuperSession____onAsyncMessage__opcode_map.txt）。
pub fn async_op_handler(op: i32) -> Option<&'static str> {
    Some(match op {
        0 => "SshBridge::authAgent",
        1 => "SshBridge::authGssapiWithMic",
        2 => "SshBridge::authInteractive",
        6 => "SuperSession::autoLogin",
        7 => "SuperSession::authNone",
        8 => "SuperSession::authOneKey",
        9 => "SshBridge::authPassword",
        10 => "SuperSession::authPublicKey",
        11 => "SshBridge::closeTunnelForwarding",
        12 => "SuperSession::createCommander",
        13 => "SuperSession::createLogger",
        14 => "SuperSession::createTransfer",
        15 => "SshBridge::executeCommand", // 虚表 [bridge vtable +0x60]
        21 => "SessionLogger::flush",
        22 => "SshBridge::openTunnelForwarding", // wParam.toList() 6 元素，首元素 King::TunnelType
        23 => "SuperSession::pauseLogger",
        24 => "SuperSession::removeCommander",
        25 => "SuperSession::removeLogger",
        26 => "SuperSession::removeTerm",
        27 => "SuperSession::removeTransfer",
        28 => "SessionLogger::resume",
        29 => "SuperSession::saveConfig",
        30 => "SshBridge::setAutoLogin(QJsonObject)",
        31 => "SshBridge::setAutoLoginRememberStep",
        32 => "SuperSession::setKeepAlive",
        33 => "SuperSession::setOption",
        34 => "SshBridge::startLogProtocol",
        36 => "SshBridge::stopLogProtocol",
        // 3..=5, 16..=20, 35：跳转表 default（no-op）
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> BridgeConfig {
        BridgeConfig {
            host: "example.org".into(),
            port: 2222,
            relay_listen_port: 41000,
            known_path: "/data/profiles/known_hosts".into(),
            agent_socket: "/tmp/ssh-agent".into(),
            ciphers: String::new(),
            key_exchange: "curve25519".into(),
            mac_hashes: String::new(),
            public_keys: String::new(),
            connection_timeout_secs: 0,
            rekey_data_bytes: -1,
            rekey_time_secs: -1,
            protocol_log: false,
        }
    }

    #[test]
    fn option_table_matches_disassembly_order_and_conditionals() {
        let opts = build_session_options(&cfg());
        let names: Vec<_> = opts.iter().map(|(o, _)| *o).collect();
        // 恒设前缀（0x1003a8eb5..0x1003a9017 的调用序）
        assert_eq!(&names[..7], &[
            SshOption::Host, SshOption::Port, SshOption::ProxyHost,
            SshOption::ProxyPort, SshOption::SshDir, SshOption::Nodelay,
            SshOption::IdentityAgent,
        ]);
        // 空串项被跳过（ciphers/mac/publickeys 空），仅 kex 非空
        assert!(names.contains(&SshOption::KeyExchange));
        assert!(!names.contains(&SshOption::CiphersCS));
        // timeout==0、rekey==-1、未开日志 -> 条件项缺席
        assert!(!names.contains(&SshOption::Timeout));
        assert!(!names.contains(&SshOption::RekeyData));
        assert!(!names.contains(&SshOption::RekeyTime));
        assert!(!names.contains(&SshOption::LogVerbosity));
        // Host 是逻辑身份、ProxyHost/ProxyPort 是中继端点
        assert_eq!(opts[0].1, OptValue::Str("example.org".into()));
        assert_eq!(opts[2].1, OptValue::Str("0.0.0.0".into()));
        assert_eq!(opts[3].1, OptValue::Long(41000));
    }

    #[test]
    fn conditional_options_appear_when_set() {
        let mut c = cfg();
        c.connection_timeout_secs = 30;
        c.rekey_data_bytes = 1 << 20;
        c.rekey_time_secs = 3600;
        c.protocol_log = true;
        let opts = build_session_options(&c);
        assert!(opts.contains(&(SshOption::Timeout, OptValue::Long(30))));
        assert!(opts.contains(&(SshOption::RekeyData, OptValue::LongLong(1 << 20))));
        assert!(opts.contains(&(SshOption::RekeyTime, OptValue::Long(3600))));
        // 日志开启时 LOG_VERBOSITY=4 必为最后一项（证据：在 setCallbacks 之后）
        assert_eq!(opts.last().unwrap(), &(SshOption::LogVerbosity, OptValue::Long(4)));
    }

    #[test]
    fn rekey_scaling_is_bitshift_and_minute_cap() {
        // 证据：MB<<20；min(60000)*60
        assert_eq!(rekey_data_mb_to_bytes(1), Some(1 << 20));
        assert_eq!(rekey_data_mb_to_bytes(-1), None);
        assert_eq!(rekey_time_min_to_secs(10), Some(600));
        assert_eq!(rekey_time_min_to_secs(99999), Some(60_000 * 60));
        assert_eq!(rekey_time_min_to_secs(-5), None);
    }

    #[test]
    fn tcp_option_codes_reproduce_swapped_buffers() {
        assert_eq!(tcp_option_code("session.tcpLowDelay"), Some(0));
        assert_eq!(tcp_option_code("session.tcpKeepAlive"), Some(1));
        // WindTerm 一致地把 receive->6 / send->5（Qt5 枚举本为 5/6），复刻之
        assert_eq!(tcp_option_code("session.tcpReceiveBufferSize"), Some(6));
        assert_eq!(tcp_option_code("session.tcpSendBufferSize"), Some(5));
        assert_eq!(tcp_option_code("session.proxy"), None);
    }

    #[test]
    fn server_known_clamps_and_throws() {
        // 证据 100113c30：1..3 透传、-1 抛、其余归 0（含 FILE_NOT_FOUND=4）
        assert_eq!(server_known_state(1), Ok(ServerKnownState::ServerKnown));
        assert_eq!(server_known_state(2), Ok(ServerKnownState::ServerChanged));
        assert_eq!(server_known_state(3), Ok(ServerKnownState::ServerMismatched));
        assert_eq!(server_known_state(4), Ok(ServerKnownState::ServerUnknown));
        assert_eq!(server_known_state(0), Ok(ServerKnownState::ServerUnknown));
        assert_eq!(server_known_state(-1), Err(()));
        assert_eq!(map_server_known(7), ServerKnownState::ServerUnknown);
    }

    #[test]
    fn backoff_schedule_matches_spin_loop_immediates() {
        // 证据 0x1003b04e0：<2 忙等、<0x10 yield、<0x20 100ms、否则 10s
        assert_eq!(backoff(0), Backoff::Busy);
        assert_eq!(backoff(1), Backoff::Busy);
        assert_eq!(backoff(2), Backoff::Yield);
        assert_eq!(backoff(15), Backoff::Yield);
        assert_eq!(backoff(16), Backoff::SleepMs(100));
        assert_eq!(backoff(31), Backoff::SleepMs(100));
        assert_eq!(backoff(32), Backoff::SleepMs(10_000));
    }

    #[test]
    fn proxy_resolution_type_codes_and_skip() {
        let mut p = std::collections::HashMap::new();
        p.insert("session.proxy".into(), "socks5".into());
        p.insert("session.proxyHost".into(), "10.0.0.1".into());
        p.insert("session.proxyPort".into(), "1080".into());
        match resolve_proxy(&p) {
            ProxyResolution::Endpoint { type_code, port, proxy_dns, .. } => {
                assert_eq!(type_code, 1); // socks5 -> 1（实证）
                assert_eq!(port, 1080);
                assert!(!proxy_dns);
            }
            other => panic!("{other:?}"),
        }
        p.insert("session.proxy".into(), "http".into());
        assert!(matches!(resolve_proxy(&p), ProxyResolution::Endpoint { type_code: 3, .. }));
        p.insert("session.proxy".into(), "command".into());
        assert!(matches!(resolve_proxy(&p), ProxyResolution::Command { .. }));
        p.insert("session.proxy".into(), "system".into());
        assert!(matches!(resolve_proxy(&p), ProxyResolution::System));
        p.insert("session.proxy".into(), "nonsense".into());
        assert!(matches!(resolve_proxy(&p), ProxyResolution::Skip));
        // setProxy 规则：type!=2 才设
        assert!(!should_apply_qt_proxy(2));
        assert!(should_apply_qt_proxy(1));
        assert!(should_apply_qt_proxy(3));
        // proxyDns=false 清 0x10 位
        assert_eq!(apply_proxy_dns_capability(0x1f, false), 0x0f);
        assert_eq!(apply_proxy_dns_capability(0x1f, true), 0x1f);
    }

    #[test]
    fn process_state_and_error_tables() {
        // 状态：NotRunning->0, Starting->2, Running->3（证据 100144540）
        assert_eq!(process_state_to_socket_state(0), 0);
        assert_eq!(process_state_to_socket_state(1), 2);
        assert_eq!(process_state_to_socket_state(2), 3);
        // 错误：数据表 0x100982b70 实读 [2,1,5,1] + (==4)*2-1（证据 100143e70）
        assert_eq!(process_error_to_socket_error(0), 2);
        assert_eq!(process_error_to_socket_error(1), 1);
        assert_eq!(process_error_to_socket_error(2), 5);
        assert_eq!(process_error_to_socket_error(3), 1);
        assert_eq!(process_error_to_socket_error(4), 1);
        assert_eq!(process_error_to_socket_error(5), -1);
    }

    #[test]
    fn split_command_program_args_contract() {
        // 证据 100144100：args[0]=程序、其余=参数；空串 -> 不启用进程桥
        let (prog, args) = split_proxy_command("ssh -W %h:%p bastion");
        assert_eq!(prog, "ssh");
        assert_eq!(args, ["-W", "%h:%p", "bastion"]);
        assert_eq!(split_proxy_command("  ").0, "");
        assert!(!proxy_command_connects_process(""));
        assert!(proxy_command_connects_process("ssh"));
        // 反斜杠转义分支（部分实证）
        let (p2, a2) = split_proxy_command("cmd\\ x arg");
        assert_eq!(p2, "cmd x");
        assert_eq!(a2, ["arg"]);
    }

    #[test]
    fn relay_queue_chunking_and_partial_read() {
        let mut q = RelayQueue::new();
        // 首块
        let i = q.push_chunk(10);
        q.append(i, b"0123456789");
        assert_eq!(q.bytes_to_read, 10);
        // 队尾剩余充足 -> 复用同一块
        assert_eq!(q.push_chunk(5), i);
        q.append(i, b"abcde");
        // 超过块容量(256KB)的来量 -> 新块
        let j = q.push_chunk(0x40000);
        assert_eq!(j, 1);
        // libssh 拉取：部分消费保留剩余
        let mut buf = [0u8; 6];
        assert_eq!(q.read_into(&mut buf), 6);
        assert_eq!(&buf[..], b"012345");
        assert_eq!(q.bytes_to_read, 9);
        // 排空第一块后自动出队（归还池）
        let mut rest = [0u8; 9];
        assert_eq!(q.read_into(&mut rest), 9);
        assert_eq!(&rest[..4], b"6789");
        assert_eq!(&rest[4..], b"abcde");
        assert_eq!(q.bytes_to_read, 0);
        // 空队列 -> 谓词 0；再追加 -> 1（waitForReadyRead/bytesToRead 的 (count>0) 返回）
        assert_eq!(q.bytes_available(), 0);
        let i2 = q.push_chunk(1);
        q.append(i2, b"x");
        assert_eq!(q.bytes_available(), 1);
        // outer 消失 -> -1（证据：bytesToRead 的 this+0x20 判空分支）
        q.outer_alive = false;
        assert_eq!(q.bytes_available(), -1);
    }

    #[test]
    fn async_op_table_spot_checks_against_wrappers() {
        // asyncXxx 包装器 grep 实证：agent=0, gss=1, interactive=2, autoLogin=6, none=7,
        // oneKey=8, password=9, closeTunnel=0xb, createCommander=0xc, setOption=0x21,
        // startLog=0x22, stopLog=0x24, keepAlive=0x20, saveConfig=0x1d
        assert_eq!(async_op_handler(0), Some("SshBridge::authAgent"));
        assert_eq!(async_op_handler(9), Some("SshBridge::authPassword"));
        assert_eq!(async_op_handler(0x21), Some("SuperSession::setOption"));
        assert_eq!(async_op_handler(0x22), Some("SshBridge::startLogProtocol"));
        assert_eq!(async_op_handler(0x24), Some("SshBridge::stopLogProtocol"));
        assert_eq!(async_op_handler(0x20), Some("SuperSession::setKeepAlive"));
        assert_eq!(async_op_handler(0x1d), Some("SuperSession::saveConfig"));
        // default 组：3,4,5,16..20,35 无处理器
        for op in [3, 4, 5, 16, 17, 18, 19, 20, 35, 37, 999] {
            assert_eq!(async_op_handler(op), None, "op {op}");
        }
    }

    #[test]
    fn session_state_values_from_moc_strings() {
        // 证据：moc 元数据声明序（Connecting 前无其它成员名可见于 HostLookup 之后）
        assert_eq!(SessionState::Connecting as i32, 2);
        assert_eq!(SessionState::Connected as i32, 3);
        assert_eq!(SessionState::HostVerified as i32, 10);
        assert_eq!(map_server_known(ServerKnownState::ServerKnown as i32), ServerKnownState::ServerKnown);
    }
}
