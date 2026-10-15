//! SSH 连接流 —— 会话选项装配、状态码映射、代理解析与中继队列模型。
//! 参考：libssh 的 ssh_options_set / ssh_is_server_known 交互。
//!
//! 核心架构：libssh 不直连真实主机 —— 中继 socket 是
//!   真实网络 outer socket（TCP/HTTP/SOCKS5/代理命令进程） ⇄ 256KB 内存块队列 ⇄ libssh 回调泵，
//!   且 libssh 的 TCP 连接目标被 PROXY_HOST/PROXY_PORT 选项覆盖为本地中继端口
//!   （HOST/PORT 保留为逻辑身份，供 known_hosts 使用）。

/// 本层使用的 ssh_options_e 类型码约定。
/// 与公开头文件的差异：44 处多一个字符串项（agent socket），
/// EXTERNAL_CALLBACKS 取 45。
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
    /// 类型码 44：字符串，路径经 ssh_path_expand_tilde 展开
    IdentityAgent = 44,
    /// 类型码 45：拷贝 5 指针回调结构 {user, flush, bytes_to_recv, in, out}
    ExternalCallbacks = 45,
}

/// ssh_options_set 的值域（char*/long/long long 三种重载）
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptValue {
    Str(String),
    Long(i64),
    LongLong(i64),
}

/// 会话状态码约定
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

/// 服务器已知状态
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum ServerKnownState {
    ServerUnknown = 0,
    ServerKnown = 1,
    ServerChanged = 2,
    ServerMismatched = 3,
}

/// 服务器已知状态码映射：
/// 1->1, 2->2, 3->3, 其余->0
pub fn map_server_known(libssh_code: i32) -> ServerKnownState {
    match libssh_code {
        1 => ServerKnownState::ServerKnown,
        2 => ServerKnownState::ServerChanged,
        3 => ServerKnownState::ServerMismatched,
        _ => ServerKnownState::ServerUnknown,
    }
}

/// 服务器已知状态判定：
/// ssh_is_server_known() ∈ 1..=3 原样透传；-1 视为不可判定；
/// 其余（0=NOT_KNOWN、4=FILE_NOT_FOUND…）归 0。Err(()) 对应 -1 分支。
pub fn server_known_state(libssh_code: i32) -> Result<ServerKnownState, ()> {
    if libssh_code == -1 {
        return Err(()); // -1：不可判定，按错误处理
    }
    let clamped = if (1..=3).contains(&libssh_code) { libssh_code } else { 0 };
    Ok(map_server_known(clamped))
}

/// TCP 属性 -> socket 选项编号（本层使用的编号约定）：
/// LowDelay->0, KeepAlive->1, ReceiveBufferSize->6, SendBufferSize->5。
/// 注：该约定把收发缓冲编号**交换**传递（与 receive=5/send=6 的常见排序相反，
/// 两处调用点一致，按原样保留；russh 落地时如需正确语义请显式纠正）。
pub fn tcp_option_code(prop: &str) -> Option<u8> {
    match prop {
        "session.tcpLowDelay" => Some(0),
        "session.tcpKeepAlive" => Some(1),
        "session.tcpReceiveBufferSize" => Some(6),
        "session.tcpSendBufferSize" => Some(5),
        _ => None,
    }
}

/// REKEY_DATALIMIT：存储值 = 输入MB << 20，负数丢弃
pub fn rekey_data_mb_to_bytes(mb: i64) -> Option<i64> {
    if mb < 0 {
        None
    } else {
        Some(mb << 20)
    }
}

/// REKEY_TIMELIMIT：存储值 = min(输入分钟, 60000) * 60 秒，负数丢弃
pub fn rekey_time_min_to_secs(min: i64) -> Option<i64> {
    if min < 0 {
        None
    } else {
        Some(min.min(60_000) * 60)
    }
}

/// LOGTYPE 属性：bit2(&4) 开启协议日志
pub fn logtype_enables_protocol(logtype: i32) -> bool {
    (logtype & 4) != 0
}

/// ssh_options_set 键表：按写入顺序返回 (选项, 值) 序列，条件项按各自分支跳过。
#[derive(Clone, Debug)]
pub struct BridgeConfig {
    pub host: String,             // 逻辑主机（known_hosts 身份）
    pub port: u16,                // 逻辑端口
    pub relay_listen_port: u16,   // 本地中继实际监听端口（listening 信号）
    pub known_path: String,       // known_hosts 路径
    pub agent_socket: String,     // 认证代理 socket 路径（配置项或默认）
    pub ciphers: String,
    pub key_exchange: String,
    pub mac_hashes: String,
    pub public_keys: String,
    pub connection_timeout_secs: i32, // 0=未设
    pub rekey_data_bytes: i64,        // -1=未设
    pub rekey_time_secs: i64,         // -1=未设
    pub protocol_log: bool,           // LOGTYPE&4
}

pub fn build_session_options(cfg: &BridgeConfig) -> Vec<(SshOption, OptValue)> {
    let mut v = Vec::new();
    // 恒设项
    v.push((SshOption::Host, OptValue::Str(cfg.host.clone())));
    v.push((SshOption::Port, OptValue::Long(cfg.port as i64)));
    // 中继端点覆盖：PROXY_HOST/PROXY_PORT 决定真实 TCP 连接目标
    // （proxy_host 非空则连 proxy_host:proxy_port，端口 0 时缺省 22）
    v.push((SshOption::ProxyHost, OptValue::Str("0.0.0.0".into()))); // 任意 IPv4
    v.push((SshOption::ProxyPort, OptValue::Long(cfg.relay_listen_port as i64)));
    v.push((SshOption::SshDir, OptValue::Str(cfg.known_path.clone())));
    v.push((SshOption::Nodelay, OptValue::Long(1)));
    v.push((SshOption::IdentityAgent, OptValue::Str(cfg.agent_socket.clone())));
    // 非空才设
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
    // 外部回调（恒设；结构体为 {user, flush, bytes_to_recv, in, out} 5 指针）
    v.push((SshOption::ExternalCallbacks, OptValue::Long(1))); // 占位：回调结构非数据
    // 条件日志：仅开启时设 LOG_VERBOSITY=4（4=SSH_LOG_PACKET）
    if cfg.protocol_log {
        v.push((SshOption::LogVerbosity, OptValue::Long(4)));
    }
    v
}

/// 自旋锁退避策略：
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

/// 连接阶段的代理解析（按 session.proxy 取值分支）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProxyResolution {
    /// "command"：走代理命令进程桥（程序/工作目录/环境三元组）
    Command { command: String, working_dir: String, environment: String },
    /// "system"：取系统代理设置
    System,
    /// "http" -> 类型码 3；"socks5" -> 1
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

/// 连接末尾规则：代理类型码 != 2 时才把代理套到外层 socket
/// （type 2 = HTTP 代理 —— 该情形不设套接字代理）
pub fn should_apply_proxy_option(proxy_type_code: u8) -> bool {
    proxy_type_code != 2
}

/// proxyDns==false 时清除 capabilities 的 0x10 位（远程 DNS 解析能力位），
/// 即保留 `caps & 0xffffffef`
pub fn apply_proxy_dns_capability(caps: u32, proxy_dns: bool) -> u32 {
    if proxy_dns {
        caps
    } else {
        caps & !0x10
    }
}

/// 代理命令连接：程序串非空 -> 进程桥；否则普通 TCP 连接。
pub fn proxy_command_connects_process(program: &str) -> bool {
    !program.is_empty()
}

/// 进程状态 -> socket 状态映射：
/// {NotRunning=0,Starting=1,Running=2} -> {Unconnected=0,Connecting=2,Connected=3}
pub fn process_state_to_socket_state(state: u8) -> u8 {
    match state {
        1 => 2, // Starting -> Connecting
        2 => 3, // Running  -> Connected
        _ => 0, // NotRunning(0) 及其余 -> Unconnected
    }
}

/// 进程错误 -> socket 错误映射（表 [2,1,5,1]）：
/// {FailedToStart=0,Crashed=1,Timedout=2,ReadError=3,WriteError=4}
/// -> {ConnectionRefused=1,RemoteHostClosed=2,SocketTimeout=5,Unknown=-1}
pub fn process_error_to_socket_error(err: u32) -> i32 {
    match err {
        0 => 2,  // FailedToStart -> RemoteHostClosedError
        1 => 1,  // Crashed -> ConnectionRefusedError
        2 => 5,  // Timedout -> SocketTimeoutError
        3 => 1,  // ReadError -> ConnectionRefusedError
        4 => 1,  // WriteError -> ConnectionRefusedError
        _ => -1, // 其余 -> UnknownSocketError
    }
}

/// 代理命令拆分：首个 token 为程序、其余为参数。
/// 分词规则：trim + 空白分隔 + 反斜杠转义。
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

/// 接收队列的语义模型：
/// - 256KB 块；队尾块容量足够则复用，否则从池取新块
/// - 部分消费：搬移剩余、计数递减、块空则归还池
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

    /// 来量分配的语义：优先复用队尾（剩余容量 >= 来量），否则新块。
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

    /// 模拟从 outer socket 读取并追加 n 字节（n<0 对应读错误 -> 错误上报，由调用方处理）
    pub fn append(&mut self, idx: usize, bytes: &[u8]) {
        let b = &mut self.blocks[idx];
        b.data.extend_from_slice(bytes);
        b.used += bytes.len();
        self.bytes_to_read += bytes.len() as i64;
    }

    /// read：把队首最多 out.len() 字节交给 libssh 缓冲。
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
                self.blocks.pop_front(); // 空块归还池
            }
        }
        done
    }

    /// 可读性谓词：outer 消失 -> -1；否则 (bytes_to_read > 0)
    pub fn bytes_available(&self) -> i64 {
        if !self.outer_alive {
            -1
        } else {
            i64::from(self.bytes_to_read > 0)
        }
    }
}

/// 异步消息操作码 -> 处理器名。
pub fn async_op_label(op: i32) -> Option<&'static str> {
    Some(match op {
        0 => "auth-agent",
        1 => "auth-gssapi-with-mic",
        2 => "auth-interactive",
        6 => "auto-login",
        7 => "auth-none",
        8 => "auth-one-key",
        9 => "auth-password",
        10 => "auth-public-key",
        11 => "close-tunnel-forwarding",
        12 => "create-commander",
        13 => "create-logger",
        14 => "create-transfer",
        15 => "execute-command", // 命令通道
        21 => "SessionLogger::flush",
        22 => "open-tunnel-forwarding", // 参数 6 元素，首元素为隧道类型
        23 => "pause-logger",
        24 => "remove-commander",
        25 => "remove-logger",
        26 => "remove-term",
        27 => "remove-transfer",
        28 => "SessionLogger::resume",
        29 => "save-config",
        30 => "set-auto-login",
        31 => "set-auto-login-remember-step",
        32 => "set-keep-alive",
        33 => "set-option",
        34 => "start-log-protocol",
        36 => "stop-log-protocol",
        // 3..=5, 16..=20, 35：无处理器（no-op）
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
    fn option_table_order_and_conditionals() {
        let opts = build_session_options(&cfg());
        let names: Vec<_> = opts.iter().map(|(o, _)| *o).collect();
        // 恒设前缀的写入顺序
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
        // 日志开启时 LOG_VERBOSITY=4 必为最后一项（在回调设置之后）
        assert_eq!(opts.last().unwrap(), &(SshOption::LogVerbosity, OptValue::Long(4)));
    }

    #[test]
    fn rekey_scaling_is_bitshift_and_minute_cap() {
        // MB<<20；min(60000)*60
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
        // 约定 receive->6 / send->5（常见排序本为 5/6），保持一致
        assert_eq!(tcp_option_code("session.tcpReceiveBufferSize"), Some(6));
        assert_eq!(tcp_option_code("session.tcpSendBufferSize"), Some(5));
        assert_eq!(tcp_option_code("session.proxy"), None);
    }

    #[test]
    fn server_known_clamps_and_throws() {
        // 1..3 透传、-1 报错、其余归 0（含 FILE_NOT_FOUND=4）
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
        // <2 忙等、<16 yield、<32 100ms、否则 10s
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
                assert_eq!(type_code, 1); // socks5 -> 1
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
        // 代理套用规则：type!=2 才设
        assert!(!should_apply_proxy_option(2));
        assert!(should_apply_proxy_option(1));
        assert!(should_apply_proxy_option(3));
        // proxyDns=false 清 0x10 位
        assert_eq!(apply_proxy_dns_capability(0x1f, false), 0x0f);
        assert_eq!(apply_proxy_dns_capability(0x1f, true), 0x1f);
    }

    #[test]
    fn process_state_and_error_tables() {
        // 状态：NotRunning->0, Starting->2, Running->3
        assert_eq!(process_state_to_socket_state(0), 0);
        assert_eq!(process_state_to_socket_state(1), 2);
        assert_eq!(process_state_to_socket_state(2), 3);
        // 错误：映射表 [2,1,5,1]，4 -> 1
        assert_eq!(process_error_to_socket_error(0), 2);
        assert_eq!(process_error_to_socket_error(1), 1);
        assert_eq!(process_error_to_socket_error(2), 5);
        assert_eq!(process_error_to_socket_error(3), 1);
        assert_eq!(process_error_to_socket_error(4), 1);
        assert_eq!(process_error_to_socket_error(5), -1);
    }

    #[test]
    fn split_command_program_args_contract() {
        // args[0]=程序、其余=参数；空串 -> 不启用进程桥
        let (prog, args) = split_proxy_command("ssh -W %h:%p bastion");
        assert_eq!(prog, "ssh");
        assert_eq!(args, ["-W", "%h:%p", "bastion"]);
        assert_eq!(split_proxy_command("  ").0, "");
        assert!(!proxy_command_connects_process(""));
        assert!(proxy_command_connects_process("ssh"));
        // 反斜杠转义分支
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
        // 空队列 -> 谓词 0；再追加 -> 1（(count>0) 返回）
        assert_eq!(q.bytes_available(), 0);
        let i2 = q.push_chunk(1);
        q.append(i2, b"x");
        assert_eq!(q.bytes_available(), 1);
        // outer 消失 -> -1（判空分支）
        q.outer_alive = false;
        assert_eq!(q.bytes_available(), -1);
    }

    #[test]
    fn async_op_table_spot_checks_against_wrappers() {
        // 操作码表：agent=0, gss=1, interactive=2, autoLogin=6, none=7,
        // oneKey=8, password=9, closeTunnel=0xb, createCommander=0xc, setOption=0x21,
        // startLog=0x22, stopLog=0x24, keepAlive=0x20, saveConfig=0x1d
        assert_eq!(async_op_label(0), Some("auth-agent"));
        assert_eq!(async_op_label(9), Some("auth-password"));
        assert_eq!(async_op_label(0x21), Some("set-option"));
        assert_eq!(async_op_label(0x22), Some("start-log-protocol"));
        assert_eq!(async_op_label(0x24), Some("stop-log-protocol"));
        assert_eq!(async_op_label(0x20), Some("set-keep-alive"));
        assert_eq!(async_op_label(0x1d), Some("save-config"));
        // default 组：3,4,5,16..20,35 无处理器
        for op in [3, 4, 5, 16, 17, 18, 19, 20, 35, 37, 999] {
            assert_eq!(async_op_label(op), None, "op {op}");
        }
    }

    #[test]
    fn session_state_values() {
        // 会话状态码的顺序约定
        assert_eq!(SessionState::Connecting as i32, 2);
        assert_eq!(SessionState::Connected as i32, 3);
        assert_eq!(SessionState::HostVerified as i32, 10);
        assert_eq!(map_server_known(ServerKnownState::ServerKnown as i32), ServerKnownState::ServerKnown);
    }
}
