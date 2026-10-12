//! ZModem/Modem 会话编排 —— 语义重写自 WindTerm 2.6.0（反编译语料为准）
//!
//! 目标二进制 sha256: d26c6406b848d3bdcc97bd3cf87ba8fdb089a0f5e960fb7155a34d341235edd1
//! 证据目录: re-work/decompiled/session/（下文以 `符号@entry` 引用）
//!
//! ## 关键 RE 结论（推翻任务预设）
//! WindTerm 的 **ZModem 帧协议不在二进制里**：`ZModem::start@1002aca10` 证明它是
//! 对 vendored **lrzsz 外部进程**（`/vendors/lrzsz/sz`、`/vendors/lrzsz/rz`，
//! 字符串实证于 __cstring 0x100a5c4a6/0x100a5c4b8）的包装。ZDLE/帧 CRC 状态机
//! 由 lrzsz 自身实现，WindTerm 只做：进程编排 + 字节管道 + stdout 文本解析。
//! 原生实现的帧协议是 X/Y-Modem（`XYModem` 类，见 modemPrepare 证据），
//! 其函数不在本语料批次内（记入 TODO）。
//!
//! ## 已确证语义清单
//! - `ZModem::start@1002aca10`：args = 调用方参数 + ["-b","-e","-v"]；
//!   mode==1(Upload) → 程序 sz + 追加 uploadFilePaths(this+0x48，非空时)；
//!   mode==0(Download) → 程序 rz + 追加 downloadFileName(this+0x38，非空时)；
//!   程序路径 = applicationDirPath + 上述相对路径（toNativeSeparators）。
//!   先 close()；三个输出解析正则装入 this+0x4a8/0x4b0/0x4b8；
//!   连接：started→process.start、modemRead→writeStandardInput、
//!   stateChanged→setModemProcessState、readyRead→解析、errorOccurred→错误表。
//! - `ZModem::setModemProcessState@1002ac8b0`：同值短路；进入 Running 置 started 标志
//!   (this+0x50)；Running→NotRunning 且 started==1 → "Process %1 crashed before the
//!   transfer is completed." + finished(false)。`ZModem::close@1002ac4b0` 直接把
//!   state 字段清 0（正常结束走 close，事后 stateChanged 被同值短路吞掉）。
//! - `ZModem::isOpen@1002ac5c0`：state==Running && (进程对象缺失 || ready 标志==0)。
//! - `ZModem::read@1002ac880`：仅 state==Running 时：translateDownloadedBytes + 管道到进程。
//! - `ModemProcess::writeStandardInput@1002ae960`：写入数据若含 QByteArrayMatcher
//!   模式（this+0x40，构造器不在语料；候选串 "\b"*8 @0x100a5c20f，紧邻错误串表，
//!   即 lrzsz 等待握手标记——推断）则置 ready 标志(+0x28)=1。
//! - `ZModem::notifyModemProcessError@1002ac600`：QProcess::ProcessError 0..5 →
//!   字符串表（__cstring 实读）：%1=程序名。
//! - `Modem::cancel@1002a6740`：Upload → 子类取消 + finished(false)；
//!   恒写 `Modem::cancelSequence@1002a6840` = "\x18"*8 + "\x08"*8；
//!   Download → 3000ms singleShot（宽限后收尾，lambda 体不在语料，推断为 close）。
//! - `Modem::notifyMessage@1002a6a50`：上一条消息不以 \n 结尾且新消息不以 \r/\n 开头
//!   → 前置 "\r\n"；记录 endsWith('\n')。
//! - `Modem::notifyError@1002a6850`：msg = "Error: " + trimmed + "\r\nTransfer aborted.\r\n"。
//! - `Modem::notifyProgress@1002a6c60`：total==-1 → "\r %1 bytes transferred..."；
//!   total==0 → pct=100（last>99 去重）；否则 pct=transferred*100/total（≤last 去重，单调）；
//!   进度条 20 列：'='*(pct/5)，未完成时再 '>' + ' '*(19-pct/5)（chop 1），
//!   完成时 '='*20；时间=formatSeconds(max(1,elapsed),false)；
//!   未完成：速度=transferred*1000/elapsed → formatBytesAsDecimal + " %1/s"；
//!   完成： " %1 bytes"（total≠0 用 total 否则 transferred）；
//!   尾串按上次长度补空格（终端残字清除）；总格式 "\r %1% [%2%3] %4"，%1 右对齐宽 3。
//! - `Modem::translateUploadedBytes@1002a7970`（仅 TelnetCommander）：倒序扫描，
//!   0xFF 后插入 0xFF（IAC 转义）；'\r' 后插入 '\n'（当 telnet 选项#10 未激活）。
//! - `Modem::translateDownloadedBytes@1002a7820`（仅 TelnetCommander）：IAC IAC→IAC
//!   （实证 remove 分支）；'\r' 分支存在（CRLF→LF 去 CR——对称推断）。
//! - `SuperTerm::modemType@100304f40`：args 含 "--zmodem"/"-Z" → 2；"--ymodem" → 1；
//!   否则（含 "-X"/"--xmodem"）→ 0。
//! - `SuperTerm::modemPrepare@100305200`：type 2 → ZModem（进程包装）；
//!   type 0 → XYModem(X)，use1k = (xmodem.packetSize == 1024)；
//!   type 1 → XYModem(Y)，use1k = (ymodem.packetSize != 128)。
//! - `SuperTerm::zmodemReceive@10031b240`：已有 modem → 取消；建 singleShot QTimer，
//!   超时 → 自动开始接收（lambda 体不在语料）。
//! - `SuperTerm::filterModemData@1002ffc90`：modem 存在 && isOpen && 数据非空
//!   → 数据喂 modem::read，返回"已消费"。
//! - 输出解析正则（start 装入，实读字符串）：
//!   FILE: `(?:Sending|Receiving): *(?<transferFile>[^\r]+)`
//!   SIZE: `(?:Sent|received): *(?<transferedSize>\d+)(/ *(?<totalSize>\d+))?`
//!   NAME: escape(name) + ":?[^\.]++\."（用途未定，推断为改名/完成匹配）

/// Modem::ModemMode（ZModem::start 分支实证：1 → sz）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ModemMode {
    Download = 0,
    Upload = 1,
}

/// SuperTerm::modemPrepare 的 King::ModemType
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ModemType {
    XModem = 0,
    YModem = 1,
    ZModem = 2,
}

/// QProcess::ProcessState（setModemProcessState 数值）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum ProcessState {
    NotRunning = 0,
    Starting = 1,
    Running = 2,
}

/// QProcess::ProcessError（notifyModemProcessError switch 0..5）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum ProcessError {
    FailedToStart = 0,
    Crashed = 1,
    Timedout = 2,
    ReadError = 3,
    WriteError = 4,
    UnknownError = 5,
}

/// 证据：Modem::cancelSequence@1002a6840 直接返回该字面串
pub const CANCEL_SEQUENCE: [u8; 16] = [
    0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
];

/// 证据：ZModem::start 恒追加的三个 lrzsz 参数（顺序实证）
pub const LRZSZ_ARGS: [&str; 3] = ["-b", "-e", "-v"];

/// 证据：__cstring 0x100a5c4a6 / 0x100a5c4b8
pub const SZ_RELATIVE: &str = "/vendors/lrzsz/sz";
pub const RZ_RELATIVE: &str = "/vendors/lrzsz/rz";

/// 证据：__cstring 0x100a5c20f（8 个退格，lrzsz 等待握手标记——推断为 ModemProcess
/// QByteArrayMatcher 的模式；构造器不在语料，标记为推断）
pub const WAITING_PATTERN: [u8; 8] = [0x08; 8];

/// 证据：Modem::cancel@1002a6740 Download 分支 QTimer::singleShotImpl(3000,...)
pub const DOWNLOAD_CANCEL_GRACE_MS: u64 = 3000;

/// 证据：notifyModemProcessError 字符串表（__cstring 实读，%1=程序名）
pub fn process_error_message(err: ProcessError, program: &str) -> &'static str {
    // 返回模板，%1 由调用方替换
    let _ = program;
    match err {
        ProcessError::FailedToStart => "Process %1 failed to start.",
        ProcessError::Crashed => "Process %1 crashed.",
        ProcessError::Timedout => "Process %1 timeout.",
        // 注意：switch case3 → 0xa5c403（read），case4 → 0xa5c3c5（write）——
        // 与 QProcess 枚举文档顺序不同的交叉映射，实读实证。
        ProcessError::ReadError => "An error occurred when attempting to read from the %1 process.",
        ProcessError::WriteError => {
            "An error occurred when attempting to write to the %1 process."
        }
        ProcessError::UnknownError => "An unknown error occurred in %1 process.",
    }
}

pub fn format_process_error(err: ProcessError, program: &str) -> String {
    process_error_message(err, program).replace("%1", program)
}

/// 证据：setModemProcessState 崩溃分支字面串（fromAscii_helper 实读）
pub fn crash_message(program: &str) -> String {
    "Process %1 crashed before the transfer is completed.".replace("%1", program)
}

/// ZModem::start 的启动请求构造
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: String,
    pub args: Vec<String>,
}

/// 证据：ZModem::start@1002aca10 的参数装配顺序：
/// caller_args → "-b","-e","-v" → mode 专属列表（upload paths / download name）
pub fn build_launch(
    app_dir: &str,
    mode: ModemMode,
    caller_args: &[String],
    upload_paths: &[String],
    download_name: Option<&str>,
) -> LaunchPlan {
    let mut args: Vec<String> = caller_args.to_vec();
    for a in LRZSZ_ARGS {
        args.push(a.to_string());
    }
    let rel = match mode {
        ModemMode::Upload => {
            if !upload_paths.is_empty() {
                args.extend(upload_paths.iter().cloned());
            }
            SZ_RELATIVE
        }
        ModemMode::Download => {
            if let Some(n) = download_name {
                if !n.is_empty() {
                    args.push(n.to_string());
                }
            }
            RZ_RELATIVE
        }
    };
    LaunchPlan { program: format!("{}{}", app_dir, rel), args }
}

/// 证据：SuperTerm::modemType@100304f40 —— 命令行参数 → 协议类型
pub fn modem_type(args: &[String]) -> ModemType {
    let has = |s: &str| args.iter().any(|a| a == s);
    if has("--zmodem") || has("-Z") {
        ModemType::ZModem
    } else if has("--ymodem") {
        ModemType::YModem
    } else {
        ModemType::XModem // "-X"/"--xmodem" 与缺省
    }
}

/// 证据：SuperTerm::modemPrepare@100305200 —— X/Y 包大小 → use1k
pub fn prepare_use_1k(kind: ModemType, packet_size: i32) -> Option<bool> {
    match kind {
        ModemType::XModem => Some(packet_size == 1024), // bVar3 = iVar2 == 0x400
        ModemType::YModem => Some(packet_size != 128),   // bVar3 = iVar2 != 0x80
        ModemType::ZModem => None,                       // 进程包装，无包大小概念
    }
}

/// ZModem 会话状态机（ZModem 对象 + ModemProcess 标志的合并模型）
#[derive(Clone, Debug)]
pub struct ZmodemSession {
    pub state: ProcessState,
    /// this+0x50：曾进入 Running（崩溃判定用）
    started_running: bool,
    /// ModemProcess+0x28：stdin 写入中出现握手模式
    ready: bool,
    /// this+0x80 直写标志（close 语义）：不经信号路径
    pub interruption_requested: bool,
    pub program: String,
    /// Modem+0x10 上次百分比（单调去重）
    pub last_percent: i32,
    /// Modem+0x14 上次尾串长度（补空格清残字）
    pub last_tail_len: usize,
    /// Modem+0x31：上一条消息以 \n 结尾
    pub prev_ends_lf: bool,
    /// 已下载字节计数（read 路径 translateDownloadedBytes 伴随计数）
    pub downloaded_bytes: i64,
}

/// set_state 产出的事件
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionEvent {
    /// Running→NotRunning 且 started 标志置位：崩溃中断
    CrashedBeforeCompleted,
}

impl ZmodemSession {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            state: ProcessState::NotRunning,
            started_running: false,
            ready: false,
            interruption_requested: false,
            program: program.into(),
            last_percent: -1,
            last_tail_len: 0,
            prev_ends_lf: false,
            downloaded_bytes: 0,
        }
    }

    /// 证据：ZModem::setModemProcessState@1002ac8b0
    pub fn set_state(&mut self, new: ProcessState) -> Option<SessionEvent> {
        if self.state == new {
            return None; // 同值短路
        }
        let mut ev = None;
        if new != ProcessState::NotRunning || self.state != ProcessState::Running {
            if new == ProcessState::Running {
                self.started_running = true; // this+0x50 = 1
            }
        } else if self.started_running {
            ev = Some(SessionEvent::CrashedBeforeCompleted);
        }
        self.state = new;
        ev
    }

    /// 证据：ZModem::close@1002ac4b0 —— requestInterruption + 直写 state=0 + 线程回收
    pub fn close(&mut self) {
        if self.state != ProcessState::NotRunning || self.started_running {
            self.interruption_requested = true;
            self.ready = false;
            self.state = ProcessState::NotRunning; // *(this+0x80) = 0
            self.started_running = false;
        }
    }

    /// 证据：ZModem::isOpen@1002ac5c0 —— Running && (进程缺失 || !ready)
    pub fn is_open(&self) -> bool {
        self.state == ProcessState::Running && !self.ready
    }

    /// 证据：ModemProcess::writeStandardInput@1002ae960 —— 模式命中置 ready
    pub fn note_stdin_write(&mut self, data: &[u8]) {
        if contains_pattern(data, &WAITING_PATTERN) {
            self.ready = true;
        }
    }

    /// 证据：ZModem::read@1002ac880 —— 仅 Running 时管道；伴随下载字节计数
    /// （translateDownloadedBytes 由调用方按 telnet 属性先做，见 translate_*）
    pub fn read_from_channel(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        if self.state == ProcessState::Running {
            self.downloaded_bytes += data.len() as i64;
            Some(data.to_vec())
        } else {
            None
        }
    }
}

fn contains_pattern(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// 证据：Modem::notifyMessage@1002a6a50 —— "\r\n" 前缀规则 + endsWith 记忆
pub fn notify_message(msg: &str, prev_ends_lf: &mut bool) -> String {
    let mut out = String::new();
    if !*prev_ends_lf && !msg.starts_with('\r') && !msg.starts_with('\n') {
        out.push_str("\r\n"); // 0xa513df 实读
    }
    out.push_str(msg);
    *prev_ends_lf = msg.ends_with('\n');
    out
}

/// 证据：Modem::notifyError@1002a6850 —— "Error: " + trimmed + "\r\nTransfer aborted.\r\n"
pub fn notify_error_text(msg: &str) -> String {
    // 前缀 "Error: "(0xa5c218) + trimmed + 后缀(0xa5c220)，均 __cstring 实读
    format!("Error: {}\r\nTransfer aborted.\r\n", msg.trim())
}

/// 证据：TransferCenter::formatSeconds@100104770
/// "%1:%2:%3"（时不补零、分秒宽 2），with_ms 追加 ".%1"（宽 3）；
/// 总秒 <36000 时在最前插 '0'（小时补成 2 位）。
pub fn format_seconds(ms: i64, with_ms: bool) -> String {
    let sec = ms / 1000;
    let mut s = format!(
        "{}:{:02}:{:02}",
        sec / 3600,
        (sec % 3600) / 60,
        sec % 60
    );
    if with_ms {
        s.push_str(&format!(".{:03}", (ms % 1000).abs()));
    }
    if sec < 36000 {
        s.insert(0, '0');
    }
    s
}

/// 证据：TransferCenter::formatBytesAsBinary@100104050
/// 阈值 0x400/0x100000/0x40000000 → KiB/MiB/GiB（乘 2^-10/2^-20/2^-30，实读 double），
/// 否则 "Bytes"。小数位 2（QLocale::toString 精度参数反编译不完整——推断）。
pub fn format_bytes_binary(bytes: i64) -> String {
    const KIB: f64 = 0.0009765625; // _DAT_100981e70 实读
    const MIB: f64 = 9.5367431640625e-07; // _DAT_100981e78 实读
    const GIB: f64 = 9.313225746154785e-10; // _DAT_100981e80 实读
    let v = bytes as f64;
    if bytes >= 0x40000000 {
        format!("{:.2} GiB", v * GIB)
    } else if bytes >= 0x100000 {
        format!("{:.2} MiB", v * MIB)
    } else if bytes >= 0x400 {
        format!("{:.2} KiB", v * KIB)
    } else {
        format!("{} Bytes", bytes)
    }
}

/// 证据：TransferCenter::formatBytesAsDecimal@1001043b0
/// <1000 整数 "Bytes"；阈值 1e3/1e6/1e9 → KB/MB/GB（除 1000/1e6/1e9，实读 double）。
pub fn format_bytes_decimal(bytes: i64) -> String {
    let v = bytes as f64;
    if bytes >= 1_000_000_000 {
        format!("{:.2} GB", v / 1e9)
    } else if bytes >= 1_000_000 {
        format!("{:.2} MB", v / 1e6)
    } else if bytes >= 1000 {
        format!("{:.2} KB", v / 1000.0)
    } else {
        format!("{}", bytes)
    }
}

/// 证据：Modem::notifyProgress@1002a6c60 的渲染核心。
/// 返回 (消息?, 新 last_percent, 新尾串长度)。None = 单调去重跳过。
pub fn render_modem_progress(
    transferred: i64,
    total: i64,
    elapsed_ms: i64,
    last_percent: i32,
    last_tail_len: usize,
) -> (Option<String>, i32, usize) {
    // total == -1（反编译 0xffffffff 哨兵）
    if total == -1 {
        return (
            Some(format!("\r {} bytes transferred...", transferred)),
            last_percent,
            last_tail_len,
        );
    }
    let pct: i32 = if total == 0 {
        if last_percent > 99 {
            return (None, last_percent, last_tail_len);
        }
        100
    } else {
        let p = (transferred.saturating_mul(100) / total) as i32;
        if p <= last_percent {
            return (None, last_percent, last_tail_len);
        }
        p
    };
    let k = (pct / 5) as usize; // '=' 数
    let (bar, spaces) = if pct >= 100 {
        ("=".repeat(k), " ".repeat(20usize.saturating_sub(k)))
    } else {
        // '=' 后追加 '>'（append 0x3e），空格 chop(1)
        ("=".repeat(k) + ">", " ".repeat(19usize.saturating_sub(k)))
    };
    let elapsed = if elapsed_ms > 0 { elapsed_ms } else { 1 }; // max(1, elapsed)
    let mut tail = format_seconds(elapsed, false);
    if pct >= 100 {
        let bytes = if total != 0 { total } else { transferred };
        tail.push_str(&format!(" {} bytes", bytes));
    } else {
        let speed = transferred.saturating_mul(1000) / elapsed;
        tail.push_str(&format!(" {}/s", format_bytes_decimal(speed)));
    }
    let mut tail_len = tail.chars().count();
    if tail_len < last_tail_len {
        // 补空格覆盖上次残字（实证：append spaces）
        tail.push_str(&" ".repeat(last_tail_len - tail_len));
    } else {
        tail_len = tail.chars().count();
    }
    let msg = format!("\r {:>3}% [{}{}] {}", pct, bar, spaces, tail);
    (Some(msg), pct, tail_len)
}

/// 证据：ZModem::start 装入的两个输出解析正则（字符串实读）
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ZmodemOutputEvent {
    /// `(?:Sending|Receiving): *(?<transferFile>[^\r]+)`
    FileStarted(String),
    /// `(?:Sent|received): *(?<transferedSize>\d+)(/ *(?<totalSize>\d+))?`
    Progress { transferred: i64, total: Option<i64> },
}

/// 按 \r / \n 切行并跑两个模式（手写匹配器，纯 std；语义 = QRegularExpression
/// globalMatch 的捕获组）。前缀后允许多空格（`: *`）。
pub fn parse_process_output(data: &[u8]) -> Vec<ZmodemOutputEvent> {
    let text = String::from_utf8_lossy(data);
    let mut events = Vec::new();
    for line in text.split(['\r', '\n']) {
        if let Some(rest) = strip_prefix_flex(line, &["Sending:", "Receiving:"]) {
            // [^\r]+ 贪婪捕获（行已按 \r 切分，取整行剩余）
            if !rest.is_empty() {
                events.push(ZmodemOutputEvent::FileStarted(rest.to_string()));
            }
            continue;
        }
        if let Some(rest) = strip_prefix_flex(line, &["Sent:", "received:"]) {
            let mut chars = rest.chars().peekable();
            let mut num = String::new();
            while let Some(c) = chars.peek() {
                if c.is_ascii_digit() {
                    num.push(*c);
                    chars.next();
                } else {
                    break;
                }
            }
            if num.is_empty() {
                continue; // \d+ 不满足
            }
            let transferred = num.parse().unwrap_or(0);
            // 可选 "/ *(?<totalSize>\d+)"
            let rem: String = chars.clone().collect();
            let total = parse_optional_total(&rem);
            events.push(ZmodemOutputEvent::Progress { transferred, total });
        }
    }
    events
}

/// 匹配 "Keyword:" + `: *`（零或多个空格）+ 非空捕获（[^\r]+ / \d+ 由调用方校验）
fn strip_prefix_flex<'a>(line: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    for p in prefixes {
        if let Some(rest) = line.strip_prefix(*p) {
            let body = rest.trim_start_matches(' ');
            if !body.is_empty() {
                return Some(body);
            }
            return Some(""); // 捕获失败由调用方判空丢弃
        }
    }
    None
}

fn parse_optional_total(s: &str) -> Option<i64> {
    let t = s.strip_prefix('/')?.trim_start_matches(' ');
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

/// 证据：Modem::translateDownloadedBytes@1002a7820（仅 telnet 通道时启用）
/// 已实证：IAC IAC → IAC（remove 分支）；CRLF → LF（'\r' 分支存在，去 CR 为对称推断）
pub fn translate_downloaded(data: &[u8], is_telnet: bool) -> Vec<u8> {
    if !is_telnet {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0usize;
    while i < data.len() {
        let b = data[i];
        if b == 0xFF
            && i + 1 < data.len()
            && data[i + 1] == 0xFF
        {
            out.push(b);
            i += 2; // 丢重复 IAC
            continue;
        }
        if b == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
            i += 1; // 丢 CR，保留 LF（推断分支）
            continue;
        }
        out.push(b);
        i += 1;
    }
    out
}

/// 证据：Modem::translateUploadedBytes@1002a7970（仅 telnet 通道时启用）
/// 倒序扫描等价于正序：0xFF 后补一个 0xFF；'\r' 后补 '\n'（当 line-mode 选项 #10 未激活）。
pub fn translate_uploaded(data: &[u8], is_telnet: bool, line_mode_active: bool) -> Vec<u8> {
    if !is_telnet {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(data.len() + 8);
    for &b in data {
        out.push(b);
        if b == 0xFF {
            out.push(0xFF);
        } else if b == b'\r' && !line_mode_active {
            out.push(b'\n');
        }
    }
    out
}

/// 证据：Modem::cancel@1002a6740 —— 取消动作序列
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CancelAction {
    /// Upload：子类取消 + finished(false)
    CancelAndFinish,
    /// 恒发取消序列
    WriteCancelSequence,
    /// Download：3000ms 宽限后收尾（lambda 体不在语料，推断 close）
    GracefulCloseAfter(u64),
}

pub fn cancel_plan(mode: ModemMode) -> Vec<CancelAction> {
    let mut v = Vec::new();
    if mode == ModemMode::Upload {
        v.push(CancelAction::CancelAndFinish);
    }
    v.push(CancelAction::WriteCancelSequence);
    if mode == ModemMode::Download {
        v.push(CancelAction::GracefulCloseAfter(DOWNLOAD_CANCEL_GRACE_MS));
    }
    v
}

/// 证据：SuperTerm::filterModemData@1002ffc90 —— 输入拦截判定
pub fn filter_modem_data(modem_present: bool, is_open: bool, data: &[u8]) -> bool {
    modem_present && is_open && !data.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn launch_args_order_and_program() {
        // 证据 ZModem::start：caller args → -b -e -v → mode 列表
        let up = build_launch("/app", ModemMode::Upload, &s(&["--zmodem"]), &s(&["/tmp/a.bin"]), None);
        assert_eq!(up.program, "/app/vendors/lrzsz/sz");
        assert_eq!(up.args, s(&["--zmodem", "-b", "-e", "-v", "/tmp/a.bin"]));
        let dn = build_launch("/app", ModemMode::Download, &s(&[]), &s(&[]), Some("out.txt"));
        assert_eq!(dn.program, "/app/vendors/lrzsz/rz");
        assert_eq!(dn.args, s(&["-b", "-e", "-v", "out.txt"]));
        // 空 download name 不追加（this+0x38 size != 0 守卫）
        let dn2 = build_launch("/app", ModemMode::Download, &s(&[]), &s(&[]), Some(""));
        assert_eq!(dn2.args, s(&["-b", "-e", "-v"]));
    }

    #[test]
    fn crash_detection_state_machine() {
        // 证据 setModemProcessState：Running→NotRunning 且 started → 崩溃错误
        let mut z = ZmodemSession::new("rz");
        assert_eq!(z.set_state(ProcessState::Starting), None);
        assert_eq!(z.set_state(ProcessState::Running), None);
        assert_eq!(
            z.set_state(ProcessState::NotRunning),
            Some(SessionEvent::CrashedBeforeCompleted)
        );
        assert_eq!(crash_message("rz"), "Process rz crashed before the transfer is completed.");
        // 同值短路
        let mut z2 = ZmodemSession::new("sz");
        z2.set_state(ProcessState::Running);
        assert_eq!(z2.set_state(ProcessState::Running), None);
        // 正常路径：close 直写 state=0 → 事后信号被短路吞掉
        let mut z3 = ZmodemSession::new("sz");
        z3.set_state(ProcessState::Running);
        z3.close();
        assert_eq!(z3.set_state(ProcessState::NotRunning), None);
        // 未 Running 过的 NotRunning 不报错
        let mut z4 = ZmodemSession::new("rz");
        z4.set_state(ProcessState::Starting);
        assert_eq!(z4.set_state(ProcessState::NotRunning), None);
    }

    #[test]
    fn is_open_and_read_gating() {
        // isOpen = Running && !ready；read 仅 Running
        let mut z = ZmodemSession::new("rz");
        assert!(!z.is_open());
        assert_eq!(z.read_from_channel(b"x"), None);
        z.set_state(ProcessState::Running);
        assert!(z.is_open());
        assert_eq!(z.read_from_channel(b"abc"), Some(b"abc".to_vec()));
        assert_eq!(z.downloaded_bytes, 3);
        z.note_stdin_write(b"hello");
        assert!(z.is_open()); // 无模式不置 ready
        z.note_stdin_write(&[b'x', 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08]);
        assert!(!z.is_open()); // \b{8} 命中 → ready
    }

    #[test]
    fn error_table_cross_mapping() {
        // 实证：case3→read 模板、case4→write 模板（与直觉相反的交叉位）
        assert_eq!(
            format_process_error(ProcessError::FailedToStart, "sz"),
            "Process sz failed to start."
        );
        assert_eq!(format_process_error(ProcessError::Crashed, "sz"), "Process sz crashed.");
        assert_eq!(format_process_error(ProcessError::Timedout, "rz"), "Process rz timeout.");
        assert!(
            format_process_error(ProcessError::ReadError, "rz").contains("read from the rz process")
        );
        assert!(format_process_error(ProcessError::WriteError, "rz")
            .contains("write to the rz process"));
        assert!(format_process_error(ProcessError::UnknownError, "rz")
            .contains("unknown error occurred in rz"));
    }

    #[test]
    fn cancel_sequence_and_plan() {
        assert_eq!(&CANCEL_SEQUENCE[..8], &[0x18; 8]);
        assert_eq!(&CANCEL_SEQUENCE[8..], &[0x08; 8]);
        assert_eq!(
            cancel_plan(ModemMode::Upload),
            vec![CancelAction::CancelAndFinish, CancelAction::WriteCancelSequence]
        );
        assert_eq!(
            cancel_plan(ModemMode::Download),
            vec![
                CancelAction::WriteCancelSequence,
                CancelAction::GracefulCloseAfter(3000)
            ]
        );
    }

    #[test]
    fn notify_message_lf_rule() {
        let mut ends = false;
        // 首条不带换行结尾 → 前置 \r\n（0xa513df）
        assert_eq!(notify_message("Hello", &mut ends), "\r\nHello");
        assert!(!ends);
        // 以 \n 结尾 → 记录；下一条不再前置（本条是否前置只看上一条状态：实证）
        assert_eq!(notify_message("Line\n", &mut ends), "\r\nLine\n");
        assert!(ends);
        assert_eq!(notify_message("Next", &mut ends), "Next");
        // 以 \r 开头的（进度行）永不前置
        let mut ends2 = false;
        assert_eq!(notify_message("\r 50% ...", &mut ends2), "\r 50% ...");
    }

    #[test]
    fn notify_error_wrapping() {
        let t = notify_error_text("  boom  ");
        assert!(t.starts_with("Error: boom"));
        assert!(t.ends_with("\r\nTransfer aborted.\r\n"));
    }

    #[test]
    fn progress_monotonic_and_bar() {
        // 50%：bar = 10'=' + '>' + 9' '；speed = 5000*1000/1000 = 5000 → "5.00 KB"
        let (msg, pct, len) = render_modem_progress(5000, 10000, 1000, -1, 0);
        let m = msg.unwrap();
        assert_eq!(pct, 50);
        assert!(m.contains("==========>         "), "bar: {}", m);
        assert!(m.starts_with("\r  50% ["));
        assert!(m.contains("5.00 KB/s"));
        // 单调去重：≤ last 跳过
        let (skip, p2, _) = render_modem_progress(5001, 10000, 1100, pct, len);
        assert!(skip.is_none());
        assert_eq!(p2, 50);
        // total==0 → 100%
        let (msg100, p100, _) = render_modem_progress(123, 0, 500, -1, 0);
        assert_eq!(p100, 100);
        assert!(msg100.unwrap().contains(" 123 bytes"));
        // total==-1 哨兵
        let (m2, _, _) = render_modem_progress(999, -1, 100, -1, 0);
        assert_eq!(m2.unwrap(), "\r 999 bytes transferred...");
        // 完成时 '='*20 无箭头
        let (m3, _, _) = render_modem_progress(10, 10, 100, -1, 0);
        assert!(m3.unwrap().contains("[====================]"));
    }

    #[test]
    fn format_seconds_table() {
        assert_eq!(format_seconds(1000, false), "00:00:01");
        assert_eq!(format_seconds(3_661_000, true), "01:01:01.000");
        assert_eq!(format_seconds(36_000_000, false), "10:00:00"); // ≥36000s 不补前导 0
        assert_eq!(format_seconds(61_000, false), "00:01:01");
    }

    #[test]
    fn byte_format_thresholds() {
        // 二进制：0x400/0x100000/0x40000000
        assert_eq!(format_bytes_binary(1023), "1023 Bytes");
        assert_eq!(format_bytes_binary(1024), "1.00 KiB");
        assert_eq!(format_bytes_binary(1536), "1.50 KiB");
        assert_eq!(format_bytes_binary(1 << 20), "1.00 MiB");
        assert_eq!(format_bytes_binary(1 << 30), "1.00 GiB");
        // 十进制：1000/1e6/1e9
        assert_eq!(format_bytes_decimal(999), "999");
        assert_eq!(format_bytes_decimal(1000), "1.00 KB");
        assert_eq!(format_bytes_decimal(1_500_000), "1.50 MB");
        assert_eq!(format_bytes_decimal(1_500_000_000), "1.50 GB");
    }

    #[test]
    fn output_parsing_regex_semantics() {
        // FILE 模式：Sending/Receiving + 多空格 + [^\r]+
        let ev = parse_process_output(b"Sending:   report.pdf\r\n");
        assert_eq!(ev, vec![ZmodemOutputEvent::FileStarted("report.pdf".into())]);
        let ev = parse_process_output(b"Receiving: a.txt\n");
        assert_eq!(ev, vec![ZmodemOutputEvent::FileStarted("a.txt".into())]);
        // SIZE 模式：Sent/received + 可选 / total
        let ev = parse_process_output(b"Sent: 1234/ 5678");
        assert_eq!(
            ev,
            vec![ZmodemOutputEvent::Progress { transferred: 1234, total: Some(5678) }]
        );
        let ev = parse_process_output(b"received: 99");
        assert_eq!(
            ev,
            vec![ZmodemOutputEvent::Progress { transferred: 99, total: None }]
        );
        // 大小写严格：模式只有 "Sent|received"（小写 r）
        assert!(parse_process_output(b"Received: 5").is_empty());
        assert!(parse_process_output(b"sent: 5").is_empty());
    }

    #[test]
    fn telnet_translation() {
        // 下载：IAC IAC → IAC（实证分支）
        assert_eq!(translate_downloaded(&[0xFF, 0xFF, b'a'], true), vec![0xFF, b'a']);
        // 非 telnet 原样
        assert_eq!(translate_downloaded(b"\r\n", false), b"\r\n".to_vec());
        // 上传：IAC 转义 + 裸 CR → CRLF（选项未激活）
        assert_eq!(translate_uploaded(&[0xFF], true, false), vec![0xFF, 0xFF]);
        assert_eq!(translate_uploaded(b"a\rb", true, false), b"a\r\nb".to_vec());
        // line-mode 激活时不动 CR
        assert_eq!(translate_uploaded(b"a\rb", true, true), b"a\rb".to_vec());
    }

    #[test]
    fn modem_type_and_prepare() {
        assert_eq!(modem_type(&s(&["--zmodem"])), ModemType::ZModem);
        assert_eq!(modem_type(&s(&["-Z"])), ModemType::ZModem);
        assert_eq!(modem_type(&s(&["--ymodem"])), ModemType::YModem);
        assert_eq!(modem_type(&s(&["-X"])), ModemType::XModem);
        assert_eq!(modem_type(&s(&[])), ModemType::XModem);
        // 包大小 → use1k（modemPrepare 两分支实读）
        assert_eq!(prepare_use_1k(ModemType::XModem, 1024), Some(true));
        assert_eq!(prepare_use_1k(ModemType::XModem, 128), Some(false));
        assert_eq!(prepare_use_1k(ModemType::YModem, 1024), Some(true));
        assert_eq!(prepare_use_1k(ModemType::YModem, 128), Some(false));
        assert_eq!(prepare_use_1k(ModemType::ZModem, 1024), None);
    }

    #[test]
    fn filter_modem_data_gate() {
        assert!(filter_modem_data(true, true, b"x"));
        assert!(!filter_modem_data(true, false, b"x")); // isOpen false
        assert!(!filter_modem_data(false, true, b"x")); // 无 modem
        assert!(!filter_modem_data(true, true, b"")); // 空数据
    }
}
