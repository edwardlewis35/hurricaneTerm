//! XYModem 原生帧协议状态机
//!
//! ## 关键结论
//! - X/Y-Modem 是**本模块内的原生帧实现**，ZModem 才是
//!   lrzsz 外部进程包装（见 re/zmodem.rs）。
//! - 帧 = `[SOH|STX][seq][~seq][data:128|1024][CRC16-BE | sum8]`；
//!   CRC 为 CRC-16/XMODEM（poly 0x1021, init 0, 不反转）——半字节技巧与
//!   逐位参考实现数值等价（"123456789" → 0x31C3）。
//! - YModem 块 0 载荷为 **`name\0dec(size)\0dec(mtime秒)`**（NUL 分隔）；
//!   全零块 0 = 批次结束。
//! - 协商（interval 3000ms）：第 0..2 轮发 'C'（CRC 模式），
//!   3..9 轮发 NAK（校验和模式），≥10 轮 cancel+关闭。
//!   ⚠ 保留的启动怪癖：start() 建定时器→start()→**reset() 立即销毁定时器**，
//!   interval=0 只保证首轮立即触发即被销毁；NAK 阶梯与放弃分支在真实流程中不可达
//!   （防御性代码）。本模块保留完整阶梯（on_negotiation_tick），并如实建模该怪癖
//!   （start 后协商定时器句柄即被 reset 清空 → handle_download 的 pre-reset 实际永不触发）。
//! - 帧超时（10000ms）：每收一个 chunk 重挂，
//!   超时 → resendPacket([NAK])，重发上限 5。
//! - 默认值：padding=0x1A、checksumMode=CRC16、packetSize=128、
//!   policy（-y=0 -n=1 -N=2 -E=3 默认=4）、expectedSize 0xFFFFFFFF=未知、
//!   expectedMtime -1=未知；seq 起点：X 从 1、Y 从 0（reset 置 is_y^1）。
//! - EOT 冲突策略：
//!   0(-y) 恒覆盖；1(-n) 仅当旧文件 mtime 更旧才覆盖；2(-N) 需 mtime 与 size 都更小；
//!   3(-E) 改名 "base(n).ext"；4(默认) 存在即丢弃（cancelWriting）。
//! - protocolArgument：X→"-X"、Y→"--ymodem"、Z→""。

use super::zmodem::{
    cancel_plan, notify_error_text, notify_message, CancelAction, ModemMode, ModemType,
};

// ---------------------------------------------------------------------------
// 协议常量
// ---------------------------------------------------------------------------

pub const SOH: u8 = 0x01; // 128B 数据帧头
pub const STX: u8 = 0x02; // 1024B 数据帧头
pub const EOT: u8 = 0x04;
pub const ACK: u8 = 0x06;
pub const NAK: u8 = 0x15;
pub const CAN: u8 = 0x18;
pub const C_CH: u8 = b'C';
pub const BS: u8 = 0x08;

/// 默认填充字节：UI 默认 "1A" 时不发 --padding
pub const DEFAULT_PADDING: u8 = 0x1A;
/// 包大小档位：128 / 1024
pub const PACKET_128: u16 = 0x80;
pub const PACKET_1K: u16 = 0x400;
/// staging 满 0x20000 才落盘
pub const STAGING_LIMIT: usize = 0x20000;
/// 重发上限
pub const RETRY_LIMIT: u32 = 5;
/// 协商轮数上限；前 3 轮 'C'
pub const NEGOTIATION_LIMIT: u32 = 10;
pub const NEGOTIATION_CRC_ROUNDS: u32 = 3;
/// 定时器间隔
pub const NEGOTIATION_INTERVAL_MS: u32 = 3000;
pub const FRAME_TIMEOUT_MS: u32 = 10_000;
/// expectedSize 未知哨兵
pub const SIZE_UNKNOWN: u64 = 0xFFFF_FFFF;
/// mtime 解析失败哨兵
pub const MTIME_UNKNOWN: i64 = -1;

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/// 0 = CRC16，1 = 8bit 字节和（NAK 协商切换）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ChecksumMode {
    Crc16 = 0,
    Checksum8 = 1,
}

/// CRC-16/XMODEM。刻意采用半字节技巧：
/// `t = bswap16(crc) ^ b; t ^= (t>>4)&0xf; crc = (t<<12) ^ (t<<5) ^ t`，
/// 单测证明与逐位参考实现等价。
pub fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        let t0 = crc.swap_bytes() ^ (b as u16);
        let t = t0 ^ ((t0 >> 4) & 0xf);
        crc = ((t << 12) ^ ((t & 0xff) << 5) ^ t) as u16;
    }
    crc
}

/// 逐位参考实现（仅测试对照用）
fn crc16_xmodem_bitwise(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// 校验和模式分支：字节和 mod 256
pub fn checksum8(data: &[u8]) -> u8 {
    data.iter().fold(0u8, |a, &b| a.wrapping_add(b))
}

/// 按模式返回校验值（校验和模式也返回 u16，≤0xff）
pub fn calculate_crc(mode: ChecksumMode, data: &[u8]) -> u16 {
    match mode {
        ChecksumMode::Crc16 => crc16_xmodem(data),
        ChecksumMode::Checksum8 => checksum8(data) as u16,
    }
}

/// 验证 `data[0..len]` 的校验值与 `data[len..]` 处的存储值。
/// CRC 模式：存储为大端 2 字节；
/// 校验和模式：1 字节。
pub fn check_data(mode: ChecksumMode, data: &[u8], len: usize) -> bool {
    match mode {
        ChecksumMode::Crc16 => {
            let want = ((data[len] as u16) << 8) | data[len + 1] as u16;
            crc16_xmodem(&data[..len]) == want
        }
        ChecksumMode::Checksum8 => checksum8(&data[..len]) == data[len],
    }
}

/// 帧长（不含数据区外内容）：3 + size + (CRC?2:1)
pub fn frame_total(packet_size: u16, mode: ChecksumMode) -> usize {
    3 + packet_size as usize + if mode == ChecksumMode::Crc16 { 2 } else { 1 }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/// 会话状态（is_open = state != Closed）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum XyState {
    Idle = 0,
    HeaderSent = 1,
    HeaderAcked = 2,
    DataPhase = 3,
    EotSent = 4,
    EndHeaderSent = 5,
    Closed = 6,
}

/// 下载冲突策略
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum OverwritePolicy {
    /// "-y"：恒覆盖
    Overwrite = 0,
    /// "-n"：旧文件 mtime 更旧才覆盖
    NewerWins = 1,
    /// "-N"：旧文件 mtime 且 size 都更小才覆盖
    NewerAndSmallerWins = 2,
    /// "-E"：改名 "base(n).ext"
    Rename = 3,
    /// 无参数：存在即丢弃
    NeverOverwrite = 4,
}

impl OverwritePolicy {
    pub fn from_args(args: &[String]) -> Self {
        // 顺序：-n → -N → -E → -y → 默认
        if args.iter().any(|a| a == "-n") {
            OverwritePolicy::NewerWins
        } else if args.iter().any(|a| a == "-N") {
            OverwritePolicy::NewerAndSmallerWins
        } else if args.iter().any(|a| a == "-E") {
            OverwritePolicy::Rename
        } else if args.iter().any(|a| a == "-y") {
            OverwritePolicy::Overwrite
        } else {
            OverwritePolicy::NeverOverwrite
        }
    }
}

/// lrzsz 风格协议参数映射
pub fn protocol_argument(kind: ModemType) -> &'static str {
    match kind {
        ModemType::XModem => "-X",
        ModemType::YModem => "--ymodem",
        ModemType::ZModem => "",
    }
}

/// 上传源：文件打开失败建模为 Err(错误文本)
#[derive(Clone, Debug)]
pub struct UploadFile {
    pub name: String,
    pub mtime: i64,
    pub content: Result<Vec<u8>, String>,
}

/// 当前打开的上传文件
#[derive(Clone, Debug)]
pub struct OpenUpload {
    pub name: String,
    pub mtime: i64,
    pub bytes: Vec<u8>,
    pub pos: usize,
    /// Some(_) → 读取失败（组包时检查该错误）
    pub error: Option<String>,
}

/// 保存文件的模型：写进内存，commit/cancelWriting 决定去向
#[derive(Clone, Debug)]
pub struct SaveFile {
    pub path: String,
    pub written: Vec<u8>,
    /// Some(_) → open 失败
    pub open_error: Option<String>,
    /// Some(_) → 落盘写失败
    pub write_error: Option<String>,
    /// Some(_) → commit 失败
    pub commit_error: Option<String>,
    pub open: bool,
    pub committed: bool,
    pub cancelled: bool,
}

/// 磁盘上已存在的目标文件（policy/rename 判定 + commit 去向）
#[derive(Clone, Debug, Default)]
pub struct DiskFile {
    pub size: i64,
    pub mtime: i64,
    pub content: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum XyEvent {
    Message(String),
    Finished(bool),
    /// notifyProgress(transferred, total)；total=SIZE_UNKNOWN 表示未知
    Progress(u64, u64),
}

// ---------------------------------------------------------------------------
// 主状态机
// ---------------------------------------------------------------------------

/// XYModem（is_y 区分 X/Y）
pub struct XyModem {
    // 会话公共侧
    pub mode: ModemMode,                 // 上传/下载方向
    pub download_name: String,           // 空名忽略（set_download_file_name）
    pub download_folder: String,         // start 强制尾 '/'
    pub upload_files: Vec<UploadFile>,   // 上传时弹出队首

    // 帧状态
    pub is_y: bool,                      // X/Y 判别
    pub trim_padding: bool,              // 收尾时去除 0x1A 填充
    pub padding_byte: u8,                // 默认 0x1A
    pub checksum: ChecksumMode,          // CRC16/校验和
    pub seq: u8,                         // 当前帧序号
    pub packet_size: u16,                // 128/1024
    pub state: XyState,                  // 状态机状态

    pub recv_buf: Vec<u8>,               // 接收缓冲
    pub pending: Vec<u8>,                // 上一帧数据/待重发帧
    pub staging: Vec<u8>,                // 落盘暂存
    pub out_file: Option<SaveFile>,      // 当前保存文件
    pub cur_upload: Option<OpenUpload>,  // 当前上传文件
    pub policy: OverwritePolicy,         // 冲突策略
    pub errors: u32,                     // 错误计数
    pub expected_size: u64,              // 块 0 声明的大小
    pub expected_mtime: i64,             // reset 不清
    pub received: u64,                   // 已收字节
    pub retries: u32,                    // 重发计数
    pub rounds: u32,                     // 协商轮次

    // 定时器句柄（本模型为布尔 + 集成层驱动 tick）
    pub frame_timer_alive: bool,
    pub negotiation_timer_alive: bool,

    // 环境
    pub disk: std::collections::HashMap<String, DiskFile>,
    /// 测试钩子：下一次 open_output_file 的 open 失败（模拟磁盘/权限错误）
    pub pending_open_error: Option<String>,
    /// 测试钩子：新建 SaveFile 携带的写/提交错误
    pub pending_write_error: Option<String>,
    pub pending_commit_error: Option<String>,
    /// 上传/下载字节转义仅在 telnet 通道生效
    pub is_telnet: bool,
    pub telnet_line_mode: bool, // 选项 #10 激活则上传不转义裸 CR

    // 输出
    pub out: Vec<u8>, // 统一经 write_out 写出
    pub events: Vec<XyEvent>,
    prev_msg_ends_lf: bool, // 上一条消息是否以 \n 结尾
}

impl XyModem {
    /// 构造：热路径默认值 + 立即 reset
    pub fn new(is_y: bool) -> Self {
        let mut m = Self {
            mode: ModemMode::Download,
            download_name: String::new(),
            download_folder: String::new(),
            upload_files: Vec::new(),
            is_y,
            trim_padding: false,
            padding_byte: DEFAULT_PADDING,
            checksum: ChecksumMode::Crc16,
            seq: 0,
            packet_size: PACKET_128,
            state: XyState::Idle,
            recv_buf: Vec::new(),
            pending: Vec::new(),
            staging: Vec::new(),
            out_file: None,
            cur_upload: None,
            policy: OverwritePolicy::Overwrite, // 构造默认 0
            errors: 0,
            expected_size: SIZE_UNKNOWN,
            expected_mtime: 0,
            received: 0,
            retries: 0,
            rounds: 0,
            frame_timer_alive: false,
            negotiation_timer_alive: false,
            disk: Default::default(),
            pending_open_error: None,
            pending_write_error: None,
            pending_commit_error: None,
            is_telnet: false,
            telnet_line_mode: false,
            out: Vec::new(),
            events: Vec::new(),
            prev_msg_ends_lf: true,
        };
        m.reset(); // 构造尾部即 reset
        m
    }

    /// 切换 1k / 128B 包大小
    pub fn set_use_1k_packet(&mut self, use1k: bool) {
        self.packet_size = if use1k { PACKET_1K } else { PACKET_128 };
    }

    /// 会话是否仍打开
    pub fn is_open(&self) -> bool {
        self.state != XyState::Closed
    }

    /// 关闭会话
    pub fn close(&mut self) {
        self.state = XyState::Closed;
    }

    /// 复位帧状态与计数器
    pub fn reset(&mut self) {
        self.state = XyState::Idle;
        self.seq = (self.is_y as u8) ^ 1; // X 从 1、Y 从 0 起
        self.retries = 0;
        self.rounds = 0;
        self.errors = 0;
        self.received = 0;
        self.expected_size = SIZE_UNKNOWN; // mtime **不清**
        if self.is_y && !self.download_name.is_empty() {
            self.download_name.clear(); // Y 模式清空下载名
        }
        self.recv_buf.clear();
        self.pending.clear();
        self.staging.clear();
        self.out_file = None;
        self.cur_upload = None;
        self.negotiation_timer_alive = false;
        self.frame_timer_alive = false;
    }

    /// 启动会话。args 为 lrzsz 风格参数表；folder 为下载目录。
    pub fn start(&mut self, mode: ModemMode, args: &[String], folder: &str) {
        self.state = XyState::Closed; // 首行先置 Closed
        self.mode = mode;
        // 分隔符归一化 + 保证尾 '/'
        let mut f = folder.replace('\\', "/");
        if !f.ends_with('/') {
            f.push('/');
        }
        self.download_folder = f;

        if mode == ModemMode::Upload {
            if self.upload_files.is_empty() {
                self.notify_error("No files selected to transfer.", true);
            }
            if !self.is_y {
                // XModem：--padding <hex> → paddingByte = 解码后首字节
                for a in args {
                    if a.contains("--padding") {
                        if let Some(sp) = a.rfind(' ') {
                            let hex = a[sp + 1..].as_bytes();
                            if let Some(byte) = hex_decode_first(hex) {
                                self.padding_byte = byte;
                            }
                        }
                    }
                }
            }
            // 上传分支不解析 --trimPadding、不建协商定时器（直接 reset 返回）
            self.reset();
            return;
        }

        // Download
        if self.is_y {
            self.policy = OverwritePolicy::from_args(args);
        }
        if args.iter().any(|a| a == "--trimPadding") {
            self.trim_padding = true;
        }
        // 协商定时器：不存在则建并启动；随后 reset() 立即将其销毁
        // （首轮立即触发后即销毁）
        self.negotiation_timer_alive = true;
        self.reset(); // 注意：reset 会清 negotiation_timer_alive
        // 已销毁的定时器当轮仍会立即触发一次（interval=0）；
        // 集成层若需复刻该首轮，应显式调用一次 on_negotiation_tick()。
    }

    /// 协商定时器 tick（interval 3000ms 重挂）
    pub fn on_negotiation_tick(&mut self) {
        if self.rounds < NEGOTIATION_LIMIT {
            if self.rounds < NEGOTIATION_CRC_ROUNDS {
                self.checksum = ChecksumMode::Crc16;
                self.write_out(&[C_CH]);
            } else {
                self.checksum = ChecksumMode::Checksum8;
                self.write_out(&[NAK]);
            }
        } else {
            // stop + cancel() + state=Closed
            self.negotiation_timer_alive = false;
            self.run_cancel();
            self.state = XyState::Closed;
        }
        self.rounds += 1; // 两分支都自增
    }

    /// 帧超时定时器 tick（10s）
    pub fn on_frame_timeout(&mut self) {
        if self.state != XyState::Closed {
            self.resend_packet(&[NAK]);
        }
    }

    /// 通道数据入口：按模式分派
    pub fn read(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let chunk = self.translate_downloaded(chunk);
        if self.mode == ModemMode::Upload {
            self.handle_upload(&chunk);
        } else {
            self.handle_download(&chunk);
        }
    }

    // ------------------------------------------------------------------
    // 上传（发送方）
    // ------------------------------------------------------------------

    /// 上传侧：逐字节扫描控制字符
    pub fn handle_upload(&mut self, chunk: &[u8]) {
        for &c in chunk {
            if c > 0x17 {
                if c == CAN {
                    self.state = XyState::Closed;
                    // 从整个 chunk 提取可读消息：截到首个 NUL、去 CAN/BS、trim
                    let end = chunk.iter().position(|&b| b == 0).unwrap_or(chunk.len());
                    let stripped: String = chunk[..end]
                        .iter()
                        .filter(|&&b| b != CAN && b != BS)
                        .map(|&b| b as char)
                        .collect();
                    let trimmed = stripped.trim().to_string();
                    if !trimmed.is_empty() {
                        self.notify_message(&trimmed);
                        self.errors += 1;
                    }
                } else if c == C_CH {
                    match self.state {
                        XyState::Idle => {
                            self.checksum = ChecksumMode::Crc16;
                            if self.is_y {
                                self.send_packet(0); // Y：块 0 头
                            } else {
                                self.send_packet(1); // X：直接数据
                            }
                        }
                        XyState::HeaderAcked => self.send_packet(1),
                        _ => {} // 仅做终态检查（下方统一处理）
                    }
                }
                // 其它 >0x18 字节忽略
            } else if c == NAK {
                if !self.is_y && self.state == XyState::Idle {
                    self.checksum = ChecksumMode::Checksum8; // Idle 态 NAK → 校验和模式
                } else {
                    let last = self.pending.clone();
                    self.resend_packet(&last);
                }
            } else if c == ACK {
                let s = self.state;
                if !self.is_y {
                    match s {
                        XyState::DataPhase => self.send_packet(1),
                        XyState::EotSent => {
                            self.state = XyState::Closed;
                        }
                        _ => {}
                    }
                } else {
                    match s {
                        XyState::HeaderSent => self.state = XyState::HeaderAcked,
                        XyState::DataPhase => self.send_packet(1),
                        XyState::EotSent => self.reset(),
                        XyState::EndHeaderSent => {
                            let msg = if self.errors == 0 {
                                "Transfer complete."
                            } else {
                                "Transfer incomplete."
                            };
                            self.notify_message(msg);
                            self.state = XyState::Closed;
                        }
                        _ => {}
                    }
                }
            } else {
                // 其余 ≤0x17 字节忽略
            }
            // 每字节处理完检查 state==6 → notifyFinished(errors==0) 并终止
            if self.state == XyState::Closed {
                let ok = self.errors == 0;
                self.notify_finished(ok);
                return;
            }
        }
    }

    /// 发送当前包（which：0=块 0 头，1=数据块）
    pub fn send_packet(&mut self, which: u16) {
        let ok = self.prepare_packet(which);
        if !ok {
            let err = self
                .cur_upload
                .as_ref()
                .and_then(|f| f.error.clone());
            // 无当前文件或无读错误 → 写单字节 EOT（并替换 pending）；
            // 否则 notifyError
            if self.cur_upload.is_none() || err.is_none() {
                self.pending = vec![EOT];
                let p = self.pending.clone();
                self.write_out(&p);
            } else {
                self.notify_error(&err.unwrap(), true);
            }
        } else {
            let p = self.pending.clone();
            self.write_out(&p);
        }
        self.retries = 0;
        self.seq = self.seq.wrapping_add(1);
    }

    /// 组装待发内容：数据块 or YModem 块 0
    pub fn prepare_packet(&mut self, which: u16) -> bool {
        if which == 1 {
            if !self.is_y && self.cur_upload.is_none() {
                self.open_next_file();
            }
            if self.cur_upload.is_some() {
                let (n, size) = {
                    let f = self.cur_upload.as_mut().unwrap();
                    let room = self.packet_size as usize;
                    let avail = f.bytes.len().saturating_sub(f.pos);
                    let n = avail.min(room);
                    f.pos += n;
                    (n, f.bytes.len())
                };
                if n < 1 {
                    if n != 0 {
                        return false; // 读错误（模型不可达：bytes 无错误态）
                    }
                    // EOF：关文件、进入 EotSent、返回 false（→ send_packet 写 EOT）
                    self.cur_upload = None;
                    self.state = XyState::EotSent;
                    return false;
                }
                let pos = self.cur_upload.as_ref().unwrap().pos;
                self.events.push(XyEvent::Progress(pos as u64, size as u64));
                let data: Vec<u8> = {
                    let f = self.cur_upload.as_ref().unwrap();
                    f.bytes[f.pos - n..f.pos].to_vec()
                };
                self.build_data_packet(&data, n as u16);
                self.state = XyState::DataPhase;
                return true;
            }
            false
        } else {
            // which == 0：YModem 块 0
            let opened = self.open_next_file();
            if opened {
                let meta = {
                    let f = self.cur_upload.as_ref().unwrap();
                    (f.name.clone(), f.bytes.len() as i64, f.mtime)
                };
                self.build_header(Some((&meta.0, meta.1, meta.2)));
                return true;
            }
            if self.cur_upload.is_none() && self.upload_files.is_empty() {
                self.build_header(None); // 批次结束块
                return true;
            }
            false
        }
    }

    /// 弹出队首打开；失败 → "Sending %1 failed: %2" + errors++ 继续
    pub fn open_next_file(&mut self) -> bool {
        self.cur_upload = None;
        loop {
            let Some(next) = self.upload_files.first().cloned() else {
                return false;
            };
            self.upload_files.remove(0);
            match next.content {
                Ok(bytes) => {
                    self.cur_upload = Some(OpenUpload {
                        name: next.name.clone(),
                        mtime: next.mtime,
                        bytes,
                        pos: 0,
                        error: None,
                    });
                    self.notify_message(&format!("Sending: {}", next.name));
                    return true;
                }
                Err(e) => {
                    self.notify_message(&format!("Sending {} failed: {}", next.name, e));
                    self.errors += 1;
                }
            }
        }
    }

    /// 组数据帧：`[SOH|STX][seq][~seq][data 补 padding][CRC-BE|sum]` → pending
    pub fn build_data_packet(&mut self, data: &[u8], len: u16) {
        let size = self.packet_size as usize;
        let mut pkt: Vec<u8> = Vec::with_capacity(3 + size + 2);
        pkt.push(if self.packet_size == PACKET_128 {
            SOH
        } else {
            STX
        });
        pkt.push(self.seq);
        pkt.push(!self.seq);
        let m = (len as usize).min(size);
        pkt.extend_from_slice(&data[..m]);
        if m < size {
            pkt.resize(3 + size, self.padding_byte);
        }
        match self.checksum {
            ChecksumMode::Crc16 => {
                let c = crc16_xmodem(&pkt[3..3 + size]);
                pkt.push((c >> 8) as u8);
                pkt.push(c as u8);
            }
            ChecksumMode::Checksum8 => pkt.push(checksum8(&pkt[3..3 + size])),
        }
        self.pending = pkt;
    }

    /// YModem 块 0 = `name\0size\0mtime`，补 '\0'；seq 强制 0；state=1/5
    pub fn build_header(&mut self, file: Option<(&str, i64, i64)>) {
        let size = self.packet_size as usize;
        let mut payload: Vec<u8> = Vec::new();
        if let Some((name, sz, mtime)) = file {
            payload.extend_from_slice(name.as_bytes());
            payload.push(0);
            payload.extend_from_slice(sz.to_string().as_bytes());
            payload.push(0);
            payload.extend_from_slice(mtime.to_string().as_bytes());
        }
        if payload.len() < size {
            payload.resize(size, 0);
        }
        let len = payload.len().min(size) as u16;
        self.seq = 0; // 块 0 序号固定 0
        self.build_data_packet(&payload, len);
        self.state = if file.is_some() {
            XyState::HeaderSent
        } else {
            XyState::EndHeaderSent
        };
    }

    /// <5 次重发；超限 notifyError("%1 failed, retry limit reached.")
    pub fn resend_packet(&mut self, buf: &[u8]) {
        if self.retries < RETRY_LIMIT {
            self.write_out(buf);
            self.retries += 1;
            return;
        }
        let what = if self.mode == ModemMode::Download {
            "Receive"
        } else {
            "Send"
        };
        self.notify_error(&format!("{} failed, retry limit reached.", what), true);
    }

    // ------------------------------------------------------------------
    // 下载（接收方）
    // ------------------------------------------------------------------

    /// 下载侧主循环
    pub fn handle_download(&mut self, chunk: &[u8]) {
        // 前置：协商定时器存活 且 首字节 ∈ {SOH,STX,EOT,CAN} → reset()
        // （start() 的 reset 怪癖使该分支在常规流程中永不触发——保留语义）
        if self.negotiation_timer_alive
            && !chunk.is_empty()
            && matches!(chunk[0], SOH | STX | EOT | CAN)
        {
            self.reset();
        }
        self.recv_buf.extend_from_slice(chunk);

        loop {
            if self.recv_buf.is_empty() {
                return;
            }
            let b0 = self.recv_buf[0];
            let (size, is_frame) = match b0 {
                SOH => (PACKET_128 as usize, true),
                STX => (PACKET_1K as usize, true),
                _ => (0usize, false),
            };
            if !is_frame {
                if b0 == EOT {
                    self.handle_eot();
                    if !self.recv_buf.is_empty() {
                        self.recv_buf.remove(0); // remove 越界钳位；reset 已清空则空操作
                    }
                    self.arm_frame_timer();
                    continue;
                }
                if b0 == CAN {
                    self.handle_can(chunk);
                    if !self.recv_buf.is_empty() {
                        self.recv_buf.remove(0);
                    }
                    self.arm_frame_timer();
                    continue;
                }
                // 垃圾字节：丢 1 字节
                self.recv_buf.remove(0);
                self.arm_frame_timer();
                continue;
            }
            let need = frame_total(size as u16, self.checksum);
            if self.recv_buf.len() < need {
                return; // 等待更多字节（不重挂定时器）
            }
            let mut reply: u8 = NAK;
            let seq = self.recv_buf[1];
            let comp = self.recv_buf[2];
            if seq == !comp {
                if seq == self.seq {
                    let data: Vec<u8> = self.recv_buf[3..3 + size].to_vec();
                    let ok = check_data(self.checksum, &self.recv_buf[3..need], size);
                    if ok {
                        if seq == 0 && self.download_name.is_empty() {
                            self.handle_file_info(&data);
                            if self.download_name.is_empty() {
                                // 批次结束块
                                self.notify_finished(true);
                                self.state = XyState::Closed;
                                reply = ACK;
                            } else {
                                self.seq = self.seq.wrapping_add(1);
                                self.state = XyState::DataPhase;
                                reply = C_CH;
                            }
                        } else if self.save_data(Some(&data)) {
                            self.seq = self.seq.wrapping_add(1);
                            self.state = XyState::DataPhase;
                            reply = ACK;
                        }
                    }
                } else {
                    reply = ACK;
                    if self.seq.wrapping_sub(1) != seq {
                        self.notify_error("Invalid packet sequence number.", true);
                        reply = CAN; // 该字节不写出（dispatch 只认 ACK/'C'/NAK）
                    }
                }
            }
            self.recv_buf.drain(..need);
            self.dispatch_reply(reply);
            self.arm_frame_timer();
        }
    }

    fn handle_eot(&mut self) {
        if self.open_output_file() {
            let policy = self.policy as u8;
            let need_check = policy < 5 && matches!(policy, 1 | 2 | 4);
            let mut discard = false;
            if need_check {
                let path = self
                    .out_file
                    .as_ref()
                    .map(|f| f.path.clone())
                    .unwrap_or_default();
                if let Some(ex) = self.disk.get(&path) {
                    match policy {
                        1 => discard = !(ex.mtime < self.expected_mtime),
                        2 => {
                            discard = !(ex.mtime < self.expected_mtime
                                && ex.size < self.expected_size as i64)
                        }
                        _ /*4*/ => discard = true,
                    }
                }
            }
            self.save_data(None);
            if discard {
                // cancelWriting()
                if let Some(f) = self.out_file.as_mut() {
                    f.cancelled = true;
                }
            } else {
                // commit()（temp→final rename）；失败 → notifyError
                let commit_err = self.out_file.as_ref().and_then(|f| f.commit_error.clone());
                let (ok, path, written) = match self.out_file.as_mut() {
                    Some(f) => {
                        f.committed = commit_err.is_none();
                        (f.committed, f.path.clone(), f.written.clone())
                    }
                    None => (false, String::new(), Vec::new()),
                };
                if let Some(e) = commit_err {
                    self.notify_error(&e, true);
                }
                if ok {
                    self.disk.insert(
                        path,
                        DiskFile {
                            size: written.len() as i64,
                            mtime: self.expected_mtime,
                            content: written,
                        },
                    );
                }
            }
            self.reset();
        }
        if !self.is_y {
            self.notify_finished(true);
            self.state = XyState::Closed;
        } else {
            self.state = XyState::Idle; // 等下一文件头
        }
        self.dispatch_reply(C_CH); // EOT 走 'C' 分支 = ACK（Y 再补 'C'）
    }

    fn handle_can(&mut self, chunk: &[u8]) {
        let end = chunk.iter().position(|&b| b == 0).unwrap_or(chunk.len());
        let stripped: String = chunk[..end]
            .iter()
            .filter(|&&b| b != CAN && b != BS)
            .map(|&b| b as char)
            .collect();
        let trimmed = stripped.trim().to_string();
        if !trimmed.is_empty() {
            self.notify_message(&trimmed);
        }
        self.notify_message("Server canceled transfer.");
        self.notify_finished(false);
        self.state = XyState::Closed;
    }

    /// dispatch：ACK→write(ACK)；'C'→write(ACK)+（Y 再 write('C')）；NAK→write(NAK)；CAN→不写
    fn dispatch_reply(&mut self, reply: u8) {
        match reply {
            ACK => self.write_out(&[ACK]),
            C_CH => {
                self.write_out(&[ACK]);
                if self.is_y {
                    self.write_out(&[C_CH]);
                }
            }
            NAK => self.write_out(&[NAK]),
            _ => {}
        }
    }

    /// 尾部定时器管理：不存在则建（10s）；retries=0；state==Closed stop 否则 start
    fn arm_frame_timer(&mut self) {
        if !self.frame_timer_alive {
            self.frame_timer_alive = true;
        }
        self.retries = 0;
        if self.state == XyState::Closed {
            self.frame_timer_alive = false;
        }
    }

    /// 块 0 头解析：`name\0size\0mtime`
    pub fn handle_file_info(&mut self, data: &[u8]) {
        let nul = data.iter().position(|&b| b == 0);
        let (name_bytes, rest) = match nul {
            Some(i) => (&data[..i], &data[i + 1..]),
            None => (data, &[] as &[u8]),
        };
        let parts: Vec<&[u8]> = rest.split(|&b| b == 0).collect();
        let name = String::from_utf8_lossy(name_bytes).to_string();
        self.set_download_file_name(&name); // 空名忽略
        self.expected_size = match parts.first().map(|p| parse_uint(p)) {
            Some(Some(v)) => v as u64,
            _ => SIZE_UNKNOWN,
        };
        self.expected_mtime = match parts.get(1).map(|p| parse_int(p)) {
            Some(Some(v)) => v,
            _ => MTIME_UNKNOWN,
        };
        self.received = 0; // 每文件清 0
    }

    /// 空名忽略；"Receiving: %1\r\n"（名取最后分隔符后）
    pub fn set_download_file_name(&mut self, name: &str) {
        if name.is_empty() {
            return;
        }
        self.download_name = name.to_string();
        let shown = match self.download_name.rfind('/') {
            Some(i) => self.download_name[i + 1..].to_string(),
            None => self.download_name.clone(),
        };
        self.notify_message(&format!("Receiving: {}\r\n", shown));
    }

    /// 打开输出文件（含改名策略）
    pub fn open_output_file(&mut self) -> bool {
        if let Some(f) = self.out_file.as_ref() {
            return f.open;
        }
        let mut name = self.download_name.clone();
        let path = if !self.is_y {
            name.clone()
        } else {
            if self.policy == OverwritePolicy::Rename {
                let candidate = format!("{}{}", self.download_folder, name);
                if self.disk.contains_key(&candidate) {
                    // "%1(%2)%3"：base + "(n)" + ".suffix"（循环上限 0x7ffffffe）
                    let (base, suffix) = split_name(&name);
                    let mut n: i64 = 1;
                    loop {
                        let uniq = format!("{}({}){}", base, n, suffix);
                        self.download_name = uniq.clone();
                        let cand = format!("{}{}", self.download_folder, uniq);
                        if n >= 0x7ffffffe || !self.disk.contains_key(&cand) {
                            break;
                        }
                        n += 1;
                    }
                    name = self.download_name.clone();
                }
            }
            format!("{}{}", self.download_folder, name)
        };
        let mut f = SaveFile {
            path,
            written: Vec::new(),
            open_error: self.pending_open_error.clone(),
            write_error: self.pending_write_error.clone(),
            commit_error: self.pending_commit_error.clone(),
            open: false,
            committed: false,
            cancelled: false,
        };
        if f.open_error.is_some() {
            let e = f.open_error.clone().unwrap();
            self.out_file = Some(f);
            self.notify_error(&e, true);
            return false;
        }
        f.open = true;
        self.out_file = Some(f);
        true
    }

    /// 暂存与落盘
    pub fn save_data(&mut self, data: Option<&[u8]>) -> bool {
        match data {
            None => {
                if self.expected_size == SIZE_UNKNOWN {
                    if self.trim_padding {
                        // 从 pending 尾部 chop 连续 0x1A
                        let mut k = 0usize;
                        while k < self.pending.len()
                            && self.pending[self.pending.len() - 1 - k] == 0x1A
                        {
                            k += 1;
                        }
                        self.pending.truncate(self.pending.len() - k);
                    }
                } else {
                    // 截到精确剩余长度 left(expected_size - received)
                    let keep = self
                        .expected_size
                        .saturating_sub(self.received)
                        .min(self.pending.len() as u64) as usize;
                    self.pending.truncate(keep);
                }
                self.staging.extend_from_slice(&self.pending);
                self.pending.clear();
            }
            Some(d) => {
                self.staging.extend_from_slice(&self.pending);
                self.received += self.pending.len() as u64;
                self.pending = d.to_vec();
                if self.staging.len() != STAGING_LIMIT {
                    return true; // 未满 128KB：不落盘
                }
            }
        }
        if !self.open_output_file() {
            return true; // open 失败仍返回 true（错误在 commit 处浮出）
        }
        let write_err = self
            .out_file
            .as_ref()
            .and_then(|f| f.write_error.clone());
        if let Some(e) = write_err {
            self.notify_error(&e, true);
            if data.is_some() {
                self.run_cancel(); // 二次 cancel（notifyError 已含一次）
                self.state = XyState::Closed;
            }
            return false;
        }
        let (pos, total) = {
            let f = self.out_file.as_mut().unwrap();
            f.written.extend_from_slice(&self.staging);
            (f.written.len() as u64, if self.is_y { self.expected_size } else { SIZE_UNKNOWN })
        };
        self.events.push(XyEvent::Progress(pos, total));
        self.staging.clear();
        true
    }

    // ------------------------------------------------------------------
    // 会话基类辅助（语义与 re/zmodem.rs 一致）
    // ------------------------------------------------------------------

    fn write_out(&mut self, data: &[u8]) {
        // 写出前做上传字节转义
        let t = self.translate_uploaded(data);
        self.out.extend_from_slice(&t);
    }

    fn translate_uploaded(&self, data: &[u8]) -> Vec<u8> {
        if !self.is_telnet {
            return data.to_vec();
        }
        let mut out = Vec::with_capacity(data.len() + 4);
        for &b in data {
            out.push(b);
            if b == 0xFF {
                out.push(0xFF);
            } else if b == b'\r' && !self.telnet_line_mode {
                out.push(b'\n');
            }
        }
        out
    }

    fn translate_downloaded(&self, data: &[u8]) -> Vec<u8> {
        if !self.is_telnet {
            return data.to_vec();
        }
        let mut out = Vec::with_capacity(data.len());
        let mut i = 0;
        while i < data.len() {
            if data[i] == 0xFF && i + 1 < data.len() && data[i + 1] == 0xFF {
                out.push(0xFF);
                i += 2;
            } else if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
                i += 1; // CRLF → LF
            } else {
                out.push(data[i]);
                i += 1;
            }
        }
        out
    }

    fn notify_message(&mut self, msg: &str) {
        let t = notify_message(msg, &mut self.prev_msg_ends_lf);
        self.events.push(XyEvent::Message(t));
    }

    /// abort=true 时先 cancel() 再发文本
    fn notify_error(&mut self, msg: &str, abort: bool) {
        let text = if abort {
            notify_error_text(msg) // "Error: " + trimmed + "\r\nTransfer aborted.\r\n"
        } else {
            format!("Error: {}", msg.trim())
        };
        if abort {
            self.run_cancel();
        }
        self.events.push(XyEvent::Message(text));
    }

    /// cancel（经 zmodem::cancel_plan）
    fn run_cancel(&mut self) {
        for a in cancel_plan(self.mode) {
            match a {
                CancelAction::CancelAndFinish => {
                    self.close();
                    self.notify_finished_raw(false);
                }
                CancelAction::WriteCancelSequence => {
                    self.out.extend_from_slice(&super::zmodem::CANCEL_SEQUENCE);
                }
                CancelAction::GracefulCloseAfter(_) => {
                    // 3s 宽限后 close（集成层调度；此处记录状态）
                    self.frame_timer_alive = false;
                }
            }
        }
    }

    /// 结束通知 = notifyMessage("\r\n") + finished(success)
    fn notify_finished(&mut self, ok: bool) {
        self.notify_message("\r\n");
        self.events.push(XyEvent::Finished(ok));
    }

    fn notify_finished_raw(&mut self, ok: bool) {
        self.events.push(XyEvent::Finished(ok));
    }
}

/// start() 的 --padding <hex>：十六进制解码后取首字节
fn hex_decode_first(hex: &[u8]) -> Option<u8> {
    if hex.len() < 2 {
        return None;
    }
    let hi = (hex[0] as char).to_digit(16)?;
    let lo = (hex[1] as char).to_digit(16)?;
    Some((hi * 16 + lo) as u8)
}

/// 无符号解析：全串须为合法十进制数（允许前导空白）
fn parse_uint(b: &[u8]) -> Option<u32> {
    let s = String::from_utf8_lossy(b);
    s.trim().parse::<u32>().ok()
}

fn parse_int(b: &[u8]) -> Option<i64> {
    let s = String::from_utf8_lossy(b);
    s.trim().parse::<i64>().ok()
}

/// base/suffix 拆分近似：最后一个 '.' 且不在 0 位
fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), format!(".{}", &name[i + 1..])),
        _ => (name.to_string(), String::new()),
    }
}

/// 测试辅助：逐位参考 CRC（供等价性单测）
#[cfg(test)]
pub(crate) fn crc16_reference(data: &[u8]) -> u16 {
    crc16_xmodem_bitwise(data)
}

// ===========================================================================
// 单元测试：覆盖非常规分支行为（非教科书 XModem）
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_frame(size: usize, seq: u8, data: &[u8], mode: ChecksumMode) -> Vec<u8> {
        make_frame_pad(size, seq, data, mode, 0x1A)
    }

    /// 块 0 头按 ' ' 填充（补零；0x1A 填充会毒化 mtime 解析）
    fn make_frame_pad(
        size: usize,
        seq: u8,
        data: &[u8],
        mode: ChecksumMode,
        pad: u8,
    ) -> Vec<u8> {
        let mut f = vec![if size == 128 { SOH } else { STX }, seq, !seq];
        let mut d = data.to_vec();
        d.resize(size, pad);
        f.extend_from_slice(&d);
        match mode {
            ChecksumMode::Crc16 => {
                let c = crc16_xmodem(&d);
                f.push((c >> 8) as u8);
                f.push(c as u8);
            }
            ChecksumMode::Checksum8 => f.push(checksum8(&d)),
        }
        f
    }

    fn up(name: &str, bytes: &[u8]) -> UploadFile {
        UploadFile {
            name: name.into(),
            mtime: 1_700_000_000,
            content: Ok(bytes.to_vec()),
        }
    }

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ---- 校验 ----

    #[test]
    fn crc_nibble_trick_equals_bitwise() {
        assert_eq!(crc16_xmodem(b"123456789"), 0x31C3); // CRC-16/XMODEM 标准 check 值
        for n in [0usize, 1, 2, 3, 127, 128, 129, 1024] {
            let d: Vec<u8> = (0..n).map(|i| (i * 7 + i / 13) as u8).collect();
            assert_eq!(crc16_xmodem(&d), crc16_reference(&d), "len={n}");
        }
    }

    #[test]
    fn checksum8_wraps() {
        assert_eq!(checksum8(&[0xFF, 0x02]), 0x01);
        assert_eq!(checksum8(&[]), 0);
    }

    #[test]
    fn crc_stored_big_endian() {
        let mut pkt = vec![SOH, 1, 0xFE];
        let d = vec![0x41u8; 128];
        pkt.extend_from_slice(&d);
        let c = crc16_xmodem(&d);
        pkt.push((c >> 8) as u8);
        pkt.push(c as u8);
        assert!(check_data(ChecksumMode::Crc16, &pkt[3..], 128));
        // 字节序反了就验不过
        pkt.swap(3 + 128, 3 + 129);
        assert!(!check_data(ChecksumMode::Crc16, &pkt[3..], 128));
    }

    // ---- 组包 ----

    #[test]
    fn build_packet_128_crc() {
        let mut m = XyModem::new(false);
        m.seq = 1;
        m.build_data_packet(b"HELLO", 5);
        let p = &m.pending;
        assert_eq!(p[0], SOH);
        assert_eq!(p[1], 1);
        assert_eq!(p[2], !1u8);
        assert_eq!(&p[3..8], b"HELLO");
        assert!(p[8..3 + 128].iter().all(|&b| b == DEFAULT_PADDING));
        assert_eq!(p.len(), 3 + 128 + 2);
        let c = u16::from_be_bytes([p[3 + 128], p[3 + 129]]);
        assert_eq!(c, crc16_xmodem(&p[3..3 + 128]));
    }

    #[test]
    fn build_packet_1k_checksum_stx() {
        let mut m = XyModem::new(false);
        m.set_use_1k_packet(true);
        m.checksum = ChecksumMode::Checksum8;
        m.seq = 0;
        m.build_data_packet(b"x", 1);
        assert_eq!(m.pending[0], STX);
        assert_eq!(m.pending.len(), 3 + 1024 + 1);
        assert_eq!(m.pending[3 + 1024], checksum8(&m.pending[3..3 + 1024]));
    }

    // ---- start ----

    #[test]
    fn start_folder_slash_and_seq_init() {
        let mut x = XyModem::new(false);
        x.start(ModemMode::Download, &[], "/tmp/dl");
        assert_eq!(x.download_folder, "/tmp/dl/");
        assert_eq!(x.seq, 1); // X 从 1 起（reset：is_y^1）
        let mut y = XyModem::new(true);
        y.start(ModemMode::Download, &[], "/tmp/dl/");
        assert_eq!(y.seq, 0); // Y 从 0 起
    }

    #[test]
    fn start_upload_empty_list_errors_then_reset_quirk() {
        let mut m = XyModem::new(false);
        m.start(ModemMode::Upload, &[], "");
        // notifyError(abort) → cancel(upload)=close+finished(false)+CAN 序列；
        // 随后 start 尾部的 reset 把 state 拉回 Idle
        let msgs: Vec<String> = m
            .events
            .iter()
            .filter_map(|e| match e {
                XyEvent::Message(s) => Some(s.clone()),
                _ => None,
            })
            .collect();
        assert!(msgs
            .iter()
            .any(|s| s.contains("Error: No files selected to transfer.")));
        assert!(m.events.iter().any(|e| *e == XyEvent::Finished(false)));
        assert_eq!(&m.out[..16], &super::super::zmodem::CANCEL_SEQUENCE[..]);
        assert_eq!(m.state, XyState::Idle);
    }

    #[test]
    fn start_padding_hex_override() {
        let mut m = XyModem::new(false);
        m.start(ModemMode::Upload, &args(&["--padding 41"]), "");
        assert_eq!(m.padding_byte, 0x41);
        let mut m2 = XyModem::new(false);
        m2.start(ModemMode::Upload, &args(&["-X"]), "");
        assert_eq!(m2.padding_byte, DEFAULT_PADDING);
    }

    #[test]
    fn start_trim_padding_only_for_download() {
        let mut m = XyModem::new(false);
        m.start(ModemMode::Upload, &args(&["--trimPadding"]), "");
        assert!(!m.trim_padding); // 上传分支不解析
        m.start(ModemMode::Download, &args(&["--trimPadding"]), "");
        assert!(m.trim_padding);
    }

    #[test]
    fn policy_arg_mapping() {
        assert_eq!(
            OverwritePolicy::from_args(&args(&["-n"])),
            OverwritePolicy::NewerWins
        );
        assert_eq!(
            OverwritePolicy::from_args(&args(&["-N"])),
            OverwritePolicy::NewerAndSmallerWins
        );
        assert_eq!(
            OverwritePolicy::from_args(&args(&["-E"])),
            OverwritePolicy::Rename
        );
        assert_eq!(
            OverwritePolicy::from_args(&args(&["-y"])),
            OverwritePolicy::Overwrite
        );
        assert_eq!(
            OverwritePolicy::from_args(&args(&[])),
            OverwritePolicy::NeverOverwrite
        );
        // -n 优先于 -N 优先于 -E 优先于 -y（嵌套 if 链）
        assert_eq!(
            OverwritePolicy::from_args(&args(&["-N", "-y"])),
            OverwritePolicy::NewerAndSmallerWins
        );
    }

    #[test]
    fn protocol_argument_mapping() {
        assert_eq!(protocol_argument(ModemType::XModem), "-X");
        assert_eq!(protocol_argument(ModemType::YModem), "--ymodem");
        assert_eq!(protocol_argument(ModemType::ZModem), "");
    }

    // ---- 上传状态机 ----

    #[test]
    fn upload_x_negotiate_and_stream() {
        let mut m = XyModem::new(false);
        m.upload_files = vec![up("a.bin", b"HELLO")];
        m.start(ModemMode::Upload, &args(&["-X"]), "");
        m.read(b"C"); // 'C' → CRC 模式 + 发块 1
        assert_eq!(m.checksum, ChecksumMode::Crc16);
        assert_eq!(m.out.len(), 3 + 128 + 2);
        assert_eq!(m.out[0], SOH);
        assert_eq!(m.out[1], 1);
        assert_eq!(m.state, XyState::DataPhase);
        m.out.clear();
        m.read(&[ACK]); // EOF → EOT
        assert_eq!(m.out, vec![EOT]);
        assert_eq!(m.state, XyState::EotSent);
        m.out.clear();
        m.read(&[ACK]); // X: 4 → Closed → finished(errors==0)
        assert_eq!(m.state, XyState::Closed);
        assert!(m.events.iter().any(|e| *e == XyEvent::Finished(true)));
    }

    #[test]
    fn upload_y_full_lifecycle() {
        let mut m = XyModem::new(true);
        m.upload_files = vec![up("f.txt", b"DATA")];
        m.start(ModemMode::Upload, &args(&["--ymodem"]), "");
        m.read(b"C"); // 块 0 头
        assert_eq!(m.state, XyState::HeaderSent);
        let hdr = m.out.clone();
        assert_eq!(hdr[1], 0); // seq 0
        let payload = &hdr[3..3 + 128];
        let mut want = b"f.txt".to_vec();
        want.push(0);
        want.extend_from_slice(b"4");
        want.push(0);
        want.extend_from_slice(b"1700000000");
        assert_eq!(&payload[..want.len()], &want[..]);
        m.out.clear();
        m.read(&[ACK]); // 1 → 2
        assert_eq!(m.state, XyState::HeaderAcked);
        m.read(b"C"); // 数据块 seq1
        assert_eq!(m.state, XyState::DataPhase);
        m.out.clear();
        m.read(&[ACK]); // EOF → EOT
        assert_eq!(m.out, vec![EOT]);
        assert_eq!(m.state, XyState::EotSent);
        m.out.clear();
        m.read(&[ACK]); // Y: 4 → reset（下一文件）
        assert_eq!(m.state, XyState::Idle);
        assert_eq!(m.seq, 0);
        m.out.clear();
        m.read(b"C"); // 列表空 → 结束块（全零头）
        assert_eq!(m.state, XyState::EndHeaderSent);
        assert!(m.out[3..3 + 128].iter().all(|&b| b == 0));
        m.out.clear();
        m.read(&[ACK]); // 5 → 完成
        let msgs: Vec<&str> = m
            .events
            .iter()
            .filter_map(|e| match e {
                XyEvent::Message(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(msgs.iter().any(|s| s.contains("Transfer complete.")));
        assert!(m.events.iter().any(|e| *e == XyEvent::Finished(true)));
    }

    #[test]
    fn upload_nak_at_zero_switches_checksum_then_resend_limit() {
        let mut m = XyModem::new(false);
        m.upload_files = vec![up("a.bin", b"HELLO")];
        m.start(ModemMode::Upload, &[], "");
        m.read(&[NAK]); // X state0 → 校验和模式
        assert_eq!(m.checksum, ChecksumMode::Checksum8);
        m.read(b"C"); // 'C' 又切回 CRC
        assert_eq!(m.checksum, ChecksumMode::Crc16);
        assert_eq!(m.state, XyState::DataPhase);
        m.out.clear();
        for i in 0..6 {
            m.out.clear();
            m.read(&[NAK]); // 重发 +0x68
            if i < 5 {
                assert_eq!(m.out.len(), 3 + 128 + 2, "resend {i}");
                assert_eq!(m.retries, i + 1);
            } else {
                // 第 6 次：超限 → notifyError(abort) → cancel：close+finished(false)+CAN 序列
                assert_eq!(&m.out[..16], &super::super::zmodem::CANCEL_SEQUENCE[..]);
                let msgs: Vec<String> = m
                    .events
                    .iter()
                    .filter_map(|e| match e {
                        XyEvent::Message(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect();
                assert!(msgs.iter().any(|s| s.contains("Send failed, retry limit reached.")));
                assert!(m.events.iter().any(|e| *e == XyEvent::Finished(false)));
            }
        }
    }

    #[test]
    fn upload_can_extracts_message_and_fails() {
        let mut m = XyModem::new(false);
        m.upload_files = vec![up("a.bin", b"HELLO")];
        m.start(ModemMode::Upload, &[], "");
        m.read(b"C");
        m.events.clear();
        m.out.clear();
        // CAN + 文本 + NUL + 尾部垃圾：截到 NUL、去 CAN/BS、trim
        let mut junk = vec![CAN, CAN];
        junk.extend_from_slice(b"disk full");
        junk.push(0);
        junk.extend_from_slice(b"trailing");
        m.read(&junk);
        assert_eq!(m.state, XyState::Closed);
        assert_eq!(m.errors, 1);
        let msgs: Vec<String> = m
            .events
            .iter()
            .filter_map(|e| match e {
                XyEvent::Message(s) => Some(s.clone()),
                _ => None,
            })
            .collect();
        assert!(msgs.iter().any(|s| s.contains("disk full")));
        assert!(m.events.iter().any(|e| *e == XyEvent::Finished(false)));
    }

    // ---- 下载状态机 ----

    fn x_dl() -> XyModem {
        let mut m = XyModem::new(false);
        m.download_name = "out.bin".into();
        m.start(ModemMode::Download, &[], "/dl");
        m
    }

    #[test]
    fn download_accepts_good_frame_acks_and_saves() {
        let mut m = x_dl();
        let f = make_frame(128, 1, b"HELLO", ChecksumMode::Crc16);
        m.read(&f);
        assert_eq!(m.out, vec![ACK]);
        assert_eq!(m.seq, 2);
        assert_eq!(m.state, XyState::DataPhase);
        assert_eq!(m.pending.len(), 128); // 新包进 pending
        assert_eq!(&m.pending[..5], b"HELLO");
        assert!(m.recv_buf.is_empty()); // 整帧消费
    }

    #[test]
    fn download_bad_crc_naks() {
        let mut m = x_dl();
        let mut f = make_frame(128, 1, b"HELLO", ChecksumMode::Crc16);
        f[10] ^= 0xFF; // 破坏数据
        m.read(&f);
        assert_eq!(m.out, vec![NAK]);
        assert_eq!(m.seq, 1); // 不前进
    }

    #[test]
    fn download_bad_complement_naks() {
        let mut m = x_dl();
        let mut f = make_frame(128, 1, b"HELLO", ChecksumMode::Crc16);
        f[2] = 0; // ~seq 不对
        m.read(&f);
        assert_eq!(m.out, vec![NAK]);
    }

    #[test]
    fn download_duplicate_seq_acks_without_save() {
        let mut m = x_dl();
        let f = make_frame(128, 1, b"HELLO", ChecksumMode::Crc16);
        m.read(&f); // → seq 2
        m.out.clear();
        m.recv_buf.clear();
        m.read(&f); // 重复 seq 1 = expected-1 → ACK 不保存
        assert_eq!(m.out, vec![ACK]);
        assert_eq!(m.seq, 2);
        assert_eq!(m.pending.len(), 128); // pending 未被重复包替换
        assert_eq!(&m.pending[..5], b"HELLO");
    }

    #[test]
    fn download_invalid_seq_errors_no_reply_byte() {
        let mut m = x_dl();
        let f = make_frame(128, 7, b"HELLO", ChecksumMode::Crc16); // 期望 1
        m.read(&f);
        // notifyError(abort) → download cancel：CAN 序列（+宽限）；dispatch 的 0x18 不写出
        assert_eq!(m.out, super::super::zmodem::CANCEL_SEQUENCE.to_vec());
        let msgs: Vec<String> = m
            .events
            .iter()
            .filter_map(|e| match e {
                XyEvent::Message(s) => Some(s.clone()),
                _ => None,
            })
            .collect();
        assert!(msgs.iter().any(|s| s.contains("Invalid packet sequence number.")));
    }

    #[test]
    fn download_drops_garbage_before_frame() {
        let mut m = x_dl();
        let mut stream = b"junk\xff\x00".to_vec();
        stream.extend(make_frame(128, 1, b"HI", ChecksumMode::Crc16));
        m.read(&stream);
        assert_eq!(m.out, vec![ACK]);
        assert!(m.recv_buf.is_empty());
    }

    #[test]
    fn download_waits_for_partial_frame() {
        let mut m = x_dl();
        let f = make_frame(128, 1, b"HELLO", ChecksumMode::Crc16);
        m.read(&f[..100]);
        assert!(m.out.is_empty());
        m.read(&f[100..]);
        assert_eq!(m.out, vec![ACK]);
    }

    #[test]
    fn download_y_header_then_end_header() {
        let mut m = XyModem::new(true);
        m.start(ModemMode::Download, &args(&["-y"]), "/dl");
        let mut payload = b"a.txt".to_vec();
        payload.push(0);
        payload.extend_from_slice(b"5");
        payload.push(0);
        payload.extend_from_slice(b"1700000000");
        let f = make_frame_pad(128, 0, &payload, ChecksumMode::Crc16, 0);
        m.read(&f);
        assert_eq!(m.download_name, "a.txt");
        assert_eq!(m.expected_size, 5);
        assert_eq!(m.expected_mtime, 1_700_000_000);
        assert_eq!(m.out, vec![ACK, C_CH]); // ACK + 'C'（Y）
        assert_eq!(m.seq, 1);
        m.out.clear();
        m.recv_buf.clear();
        // 数据帧（size=5 → 收尾 left 截断）
        m.read(&make_frame(128, 1, b"WORLD", ChecksumMode::Crc16));
        assert_eq!(m.out, vec![ACK]);
        m.out.clear();
        m.recv_buf.clear();
        // EOT → commit 精确 5 字节；Y → state Idle + ACK + 'C'
        m.read(&[EOT]);
        let d = m.disk.get("/dl/a.txt").expect("committed");
        assert_eq!(d.content, b"WORLD"); // 已知 size=5 → left 截断
        assert_eq!(m.state, XyState::Idle);
        assert_eq!(m.out, vec![ACK, C_CH]);
        m.out.clear();
        m.recv_buf.clear();
        // 全零块 0（seq 回到 0，名字被上一轮 EOT 的 reset 清空）→ 批次结束
        assert_eq!(m.seq, 0);
        let end = make_frame_pad(128, 0, b"", ChecksumMode::Crc16, 0); // 全零块
        m.read(&end);
        assert!(m.events.iter().any(|e| *e == XyEvent::Finished(true)));
        assert_eq!(m.state, XyState::Closed);
        assert_eq!(m.out, vec![ACK]);
    }

    #[test]
    fn download_can_cancels() {
        let mut m = x_dl();
        m.read(b"\x18server says no");
        let msgs: Vec<String> = m
            .events
            .iter()
            .filter_map(|e| match e {
                XyEvent::Message(s) => Some(s.clone()),
                _ => None,
            })
            .collect();
        assert!(msgs.iter().any(|s| s.contains("Server canceled transfer.")));
        assert!(msgs.iter().any(|s| s.contains("server says no")));
        assert!(m.events.iter().any(|e| *e == XyEvent::Finished(false)));
        assert_eq!(m.state, XyState::Closed);
    }

    #[test]
    fn download_x_eot_commits_and_finishes() {
        let mut m = x_dl();
        m.read(&make_frame(128, 1, b"HELLO", ChecksumMode::Crc16));
        m.out.clear();
        m.read(&[EOT]);
        // reset() 已销毁 SaveFile 对象；commit 的去向是磁盘
        assert!(m.out_file.is_none());
        let d = m.disk.get("out.bin").expect("committed");
        // X：大小未知且未开 trimPadding → 保留整包（含 0x1A 填充）
        assert_eq!(d.content.len(), 128);
        assert_eq!(&d.content[..5], b"HELLO");
        assert!(m.events.iter().any(|e| *e == XyEvent::Finished(true)));
        assert_eq!(m.state, XyState::Closed);
        assert_eq!(m.out, vec![ACK]); // X 不再补 'C'
    }

    #[test]
    fn download_x_eot_trims_ctrlz_when_requested() {
        let mut m = XyModem::new(false);
        m.download_name = "out.bin".into();
        m.start(ModemMode::Download, &args(&["--trimPadding"]), "");
        m.read(&make_frame(128, 1, b"HELLO", ChecksumMode::Crc16));
        m.read(&[EOT]);
        assert_eq!(m.disk["out.bin"].content, b"HELLO");
    }

    fn old_file() -> DiskFile {
        DiskFile { size: 9, mtime: 5, content: b"OLD".to_vec() }
    }

    #[test]
    fn eot_policies_against_existing_file() {
        // 默认(4)：存在即丢弃
        let mut m2 = XyModem::new(true);
        m2.disk.insert("/dl/a.txt".into(), old_file());
        m2.start(ModemMode::Download, &args(&[]), "/dl");
        assert_eq!(m2.policy, OverwritePolicy::NeverOverwrite);
        let mut p = b"a.txt".to_vec();
        p.push(0);
        p.extend_from_slice(b"5");
        p.push(0);
        p.extend_from_slice(b"10"); // 来件 mtime=10 > 旧 5
        m2.read(&make_frame_pad(128, 0, &p, ChecksumMode::Crc16, 0));
        m2.read(&make_frame(128, 1, b"WORLD", ChecksumMode::Crc16));
        m2.read(&[EOT]);
        assert_eq!(m2.disk["/dl/a.txt"].content, b"OLD"); // cancelWriting → 旧文件保留
        // -n：旧文件更旧(mtime 5 < 10) → 覆盖
        let mut m3 = XyModem::new(true);
        m3.disk.insert("/dl/a.txt".into(), old_file());
        m3.start(ModemMode::Download, &args(&["-n"]), "/dl");
        m3.read(&make_frame_pad(128, 0, &p, ChecksumMode::Crc16, 0));
        m3.read(&make_frame(128, 1, b"WORLD", ChecksumMode::Crc16));
        m3.read(&[EOT]);
        assert_eq!(m3.disk["/dl/a.txt"].content, b"WORLD");
        // -N：mtime 更旧但 size 更大(9 < 5 false) → 丢弃
        let mut m4 = XyModem::new(true);
        m4.disk.insert("/dl/a.txt".into(), old_file());
        m4.start(ModemMode::Download, &args(&["-N"]), "/dl");
        m4.read(&make_frame_pad(128, 0, &p, ChecksumMode::Crc16, 0));
        m4.read(&make_frame(128, 1, b"WORLD", ChecksumMode::Crc16));
        m4.read(&[EOT]);
        assert_eq!(m4.disk["/dl/a.txt"].content, b"OLD");
    }

    #[test]
    fn eot_rename_policy() {
        let mut m = XyModem::new(true);
        m.disk.insert("/dl/a.txt".into(), old_file());
        m.start(ModemMode::Download, &args(&["-E"]), "/dl");
        let mut p = b"a.txt".to_vec();
        p.push(0);
        p.extend_from_slice(b"2");
        p.push(0);
        p.extend_from_slice(b"7");
        m.read(&make_frame_pad(128, 0, &p, ChecksumMode::Crc16, 0));
        m.read(&make_frame(128, 1, b"XY", ChecksumMode::Crc16));
        m.read(&[EOT]);
        // 改名发生在 open_output_file（首次 flush/EOT 时）——固定时机；
        // "%1(%2)%3" → a(1).txt，旧文件保留
        assert_eq!(m.disk["/dl/a(1).txt"].content, b"XY");
        assert_eq!(m.disk["/dl/a.txt"].content, b"OLD");
    }

    #[test]
    fn staging_flushes_at_128k() {
        let mut m = XyModem::new(false);
        m.download_name = "big.bin".into();
        m.set_use_1k_packet(true);
        m.start(ModemMode::Download, &[], "");
        let data = vec![0x42u8; 1024];
        for i in 0..129u16 {
            let seq = (1 + i as u32) as u8;
            m.read(&make_frame(1024, seq, &data, ChecksumMode::Crc16));
            m.out.clear();
        }
        // 第 129 帧：staging 128×1024 = 0x20000 → 落盘
        let f = m.out_file.as_ref().unwrap();
        assert_eq!(f.written.len(), 0x20000);
        assert!(m.staging.is_empty());
        assert!(m
            .events
            .iter()
            .any(|e| matches!(e, XyEvent::Progress(p, t) if *p == 0x20000 && *t == SIZE_UNKNOWN)));
    }

    #[test]
    fn write_error_cancels_mid_transfer() {
        let mut m = x_dl();
        m.pending_write_error = Some("disk full".into());
        m.read(&make_frame(128, 1, b"HELLO", ChecksumMode::Crc16));
        // 首包只进 staging 不落盘；EOT 收尾 flush 才失败
        m.events.clear();
        m.read(&[EOT]);
        let msgs: Vec<String> = m
            .events
            .iter()
            .filter_map(|e| match e {
                XyEvent::Message(s) => Some(s.clone()),
                _ => None,
            })
            .collect();
        assert!(msgs.iter().any(|s| s.contains("Error: disk full")));
        assert_eq!(m.state, XyState::Closed);
    }

    // ---- 定时器 ----

    #[test]
    fn negotiation_ladder() {
        let mut m = XyModem::new(false);
        m.start(ModemMode::Download, &[], "");
        for _ in 0..3 {
            m.out.clear();
            m.on_negotiation_tick();
            assert_eq!(m.out, vec![C_CH]);
            assert_eq!(m.checksum, ChecksumMode::Crc16);
        }
        for _ in 3..10 {
            m.out.clear();
            m.on_negotiation_tick();
            assert_eq!(m.out, vec![NAK]);
            assert_eq!(m.checksum, ChecksumMode::Checksum8);
        }
        m.out.clear();
        m.on_negotiation_tick(); // 第 11 次：rounds==10 → 放弃
        assert_eq!(m.out, super::super::zmodem::CANCEL_SEQUENCE.to_vec());
        assert_eq!(m.state, XyState::Closed);
        assert!(!m.negotiation_timer_alive);
    }

    #[test]
    fn frame_timeout_resends_nak_until_limit() {
        let mut m = x_dl();
        for i in 0..6 {
            m.out.clear();
            m.on_frame_timeout();
            if i < 5 {
                assert_eq!(m.out, vec![NAK]);
                assert_eq!(m.retries, i + 1);
            } else {
                assert_eq!(&m.out[..16], &super::super::zmodem::CANCEL_SEQUENCE[..]);
                let msgs: Vec<String> = m
                    .events
                    .iter()
                    .filter_map(|e| match e {
                        XyEvent::Message(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect();
                assert!(msgs
                    .iter()
                    .any(|s| s.contains("Receive failed, retry limit reached.")));
            }
        }
    }

    #[test]
    fn frame_timer_restarts_per_chunk_and_stops_when_closed() {
        let mut m = x_dl();
        m.read(&make_frame(128, 1, b"HI", ChecksumMode::Crc16));
        assert!(m.frame_timer_alive);
        assert_eq!(m.retries, 0);
        m.recv_buf.clear();
        m.read(b"\x18"); // CAN → Closed → 定时器管理 stop
        assert_eq!(m.state, XyState::Closed);
        assert!(!m.frame_timer_alive);
        // valid frame 会把 state 覆写回 DataPhase 并重启定时器（is_open 守卫在 filter 层）
        m.recv_buf.clear();
        m.state = XyState::DataPhase;
        m.seq = 2;
        m.read(&make_frame(128, 2, b"HI", ChecksumMode::Crc16));
        assert!(m.frame_timer_alive);
    }

    // ---- telnet 转义（write_out 路径）----

    #[test]
    fn telnet_escaping_on_outbound_bytes() {
        let mut m = x_dl();
        m.is_telnet = true;
        let f = make_frame(128, 1, b"\xff", ChecksumMode::Crc16);
        m.read(&f); // reply ACK(0x06) 不含 0xFF → 原样
        assert_eq!(m.out, vec![ACK]);
        // 直接写出含 0xFF 的包体（上传路径）
        m.out.clear();
        let mut u = XyModem::new(false);
        u.is_telnet = true;
        u.upload_files = vec![up("x", b"\xff\r")];
        u.start(ModemMode::Upload, &[], "");
        u.read(b"C");
        // 包体里的 0xFF → IAC IAC；\r → CRLF（translate_uploaded 对整包作用）
        assert_eq!(&u.out[..3], [SOH, 1, 0xFE]);
        assert_eq!(&u.out[3..7], [0xFF, 0xFF, 0x0D, 0x0A]);
        assert_eq!(u.out.len(), 3 + 128 + 2 + 2); // 原 133 + 两处转义各 1 字节
    }
}
