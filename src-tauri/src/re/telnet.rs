//! Telnet 协商引擎 —— 协商命令映射与选项状态机。
//! - command_ack:   (x!=0) ? DO(0xFD)  : WILL(0xFB)
//! - command_no_ack:(x!=0) ? DONT(0xFE): WONT(0xFC)
//! - command_req:   (x==0) ? DO(0xFD)  : WILL(0xFB)
//! - command_no_req:(x==0) ? DONT(0xFE): WONT(0xFC)
//!   （x = 协商方向：0=远端数据类选项，非0=本地类；ack/noAck 应答对端，req/noReq 我方发起）
//! - 初始请求：遍历选项表（每项 3 字段），state & 0x10 置位者，
//!   有名称 -> WILL，无名称 -> DO，发出 [IAC,cmd,opt]
//! - 状态向量补齐为 11 项，初值复制自选项表
//! - is_local_edit：第 8 个状态项 bit0 == 0 时为本地编辑（ECHO 关闭语义）
//! - 选项写入：发送 [IAC, cmd, option] 并记录 side=1 日志
//! - 解析规则分三类匹配组：NegotiateOption / NegotiateSubOption / IgnoreWrongIAC

pub const IAC: u8 = 0xFF;
pub const DONT: u8 = 0xFE;
pub const DO: u8 = 0xFD;
pub const WILL: u8 = 0xFB;
pub const WONT: u8 = 0xFC;
pub const SB: u8 = 0xFA;
pub const SE: u8 = 0xF0;

/// 标准选项号（RFC 854/855/1091…）
pub mod opt {
    pub const ECHO: u8 = 1;
    pub const SGA: u8 = 3;
    pub const STATUS: u8 = 5;
    pub const TM: u8 = 6;
    pub const LOCCTL: u8 = 10;
    pub const DUN: u8 = 2;
    pub const SUPDUP: u8 = 69;
    pub const SEND: u8 = 20;
    pub const NEW_ENV: u8 = 39;
}

/// 协商方向：远端数据类选项 / 本地类选项（取值 0/非0）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    /// 远端数据类选项（x == 0）
    Remote,
    /// 本地类选项（x != 0）
    Local,
}

/// 四映射函数 —— 协商方向到命令字的确切映射
pub fn command_ack(side: Side) -> u8 {
    match side {
        Side::Local => DO,   // (x!=0)*2+0xfb
        Side::Remote => WILL, // x==0 -> 0xfb
    }
}
pub fn command_no_ack(side: Side) -> u8 {
    match side {
        Side::Local => DONT, // (x!=0)*2-4 -> 0xFE
        Side::Remote => WONT,
    }
}
pub fn command_req(side: Side) -> u8 {
    match side {
        Side::Remote => DO,  // (x==0)*2+0xfb
        Side::Local => WILL,
    }
}
pub fn command_no_req(side: Side) -> u8 {
    match side {
        Side::Remote => DONT, // (x==0)*2-4
        Side::Local => WONT,
    }
}

/// 初始请求的发出命令选择：有名称 -> WILL，无名称 -> DO
pub fn init_command(has_name: bool) -> u8 {
    if has_name {
        WILL
    } else {
        DO
    }
}

/// 状态位：初始请求检查 0x10（“初始请求发送”位）；bit0 = 已启用
pub const STATE_INIT_REQUEST: u8 = 0x10;
pub const STATE_ENABLED: u8 = 0x1;

/// 单个选项（每项三字段：option / name / init-state）
#[derive(Clone, Debug)]
pub struct TelnetOption {
    pub byte: u8,
    pub name: Option<&'static str>,
    pub state: u8,
    pub side: Side,
}

/// 客户端默认选项表 —— 供初始请求流程遍历；
/// 条目按 RFC 客户端惯例填充，状态向量长度为 11。
pub fn client_option_table() -> Vec<TelnetOption> {
    use Side::{Local, Remote};
    let mut t = vec![
        TelnetOption { byte: opt::ECHO, name: Some("TELOPT_ECHO"), state: STATE_INIT_REQUEST | STATE_ENABLED, side: Local },
        TelnetOption { byte: opt::SGA, name: Some("TELOPT_SGA"), state: STATE_INIT_REQUEST | STATE_ENABLED, side: Local },
        TelnetOption { byte: opt::DUN, name: Some("TELOPT_DUN"), state: 0, side: Remote },
        TelnetOption { byte: opt::STATUS, name: Some("TELOPT_STATUS"), state: 0, side: Remote },
        TelnetOption { byte: opt::TM, name: Some("TELOPT_TM"), state: 0, side: Remote },
        TelnetOption { byte: opt::SEND, name: Some("TELOPT_SEND"), state: STATE_INIT_REQUEST, side: Remote },
        TelnetOption { byte: opt::LOCCTL, name: Some("TELOPT_LOCCTL"), state: 0, side: Local },
        TelnetOption { byte: opt::NEW_ENV, name: None, state: STATE_INIT_REQUEST, side: Remote },
        TelnetOption { byte: opt::SUPDUP, name: Some("TELOPT_SUPDUP"), state: 0, side: Local },
        TelnetOption { byte: 24, name: Some("TELOPT_LFLOW"), state: 0, side: Local },
        TelnetOption { byte: 3, name: Some("TELOPT_LOGGING"), state: 0, side: Remote },
    ];
    debug_assert_eq!(t.len(), 11);
    t.truncate(11);
    t
}

/// 协商引擎：持有选项状态，解析下行字节、产出上行响应与净数据
pub struct Negotiator {
    pub options: Vec<TelnetOption>,
    pending_iac: bool,
    sub_option: Option<u8>,
    sub_buf: Vec<u8>,
}

pub struct Outcome {
    pub data: Vec<u8>,
    pub responses: Vec<u8>,
    pub log: Vec<String>,
}

impl Negotiator {
    pub fn client_default() -> Self {
        Self {
            options: client_option_table(),
            pending_iac: false,
            sub_option: None,
            sub_buf: Vec::new(),
        }
    }

    /// 初始请求等价：对 state & 0x10 的选项发出 [IAC, init_command(has_name), byte]
    pub fn initial_requests(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for o in &self.options {
            if o.state & STATE_INIT_REQUEST != 0 {
                out.extend_from_slice(&[IAC, init_command(o.name.is_some()), o.byte]);
            }
        }
        out
    }

    /// is_local_edit：ECHO 状态 bit0 == 0（第 8 个状态项，此处按 ECHO 语义定位）
    pub fn is_local_edit(&self) -> bool {
        self.options
            .iter()
            .find(|o| o.byte == opt::ECHO)
            .map(|o| o.state & STATE_ENABLED == 0)
            .unwrap_or(true)
    }

    fn find_mut(&mut self, byte: u8) -> Option<&mut TelnetOption> {
        self.options.iter_mut().find(|o| o.byte == byte)
    }

    fn send(&self, out: &mut Vec<u8>, log: &mut Vec<String>, cmd: u8, opt_byte: u8) {
        out.extend_from_slice(&[IAC, cmd, opt_byte]);
        log.push(format!("-> {:02X} {}", cmd, name_of(opt_byte)));
    }
    /// 处理下行字节流（协商/子选项/忽略三类匹配）
    pub fn on_data(&mut self, input: &[u8]) -> Outcome {
        let mut data = Vec::new();
        let mut responses = Vec::new();
        let mut log = Vec::new();
        let mut i = 0usize;
        while i < input.len() {
            let b = input[i];
            i += 1;
            if self.pending_iac {
                self.pending_iac = false;
                match b {
                    IAC => {
                        // IAC IAC 转义：子选项内属于载荷，否则属于数据（RFC 854）
                        if self.sub_option.is_some() {
                            self.sub_buf.push(IAC);
                        } else {
                            data.push(IAC);
                        }
                    }
                    WILL | WONT | DO | DONT => {
                        if i < input.len() {
                            let o = input[i];
                            i += 1;
                            self.handle_negotiation(b, o, &mut responses, &mut log);
                        } else {
                            log.push(format!("<- truncated negotiation {:02X}", b));
                        }
                    }
                    SB => {
                        self.sub_option = Some(1);
                        self.sub_buf.clear();
                    }
                    SE => {
                        if self.sub_option.take().is_some() {
                            log.push(format!("<- SB len={}", self.sub_buf.len()));
                            self.sub_buf.clear();
                        }
                    }
                    _ => {
                        // 其它命令（Go/AO/EC/EL/BM/SBRP…）：按 IgnoreWrongIAC 语义忽略
                        log.push(format!("<- unhandled IAC {:02X}", b));
                    }
                }
                continue;
            }
            if b == IAC {
                self.pending_iac = true;
                continue;
            }
            if self.sub_option.is_some() {
                self.sub_buf.push(b);
                continue;
            }
            data.push(b);
        }
        Outcome { data, responses, log }
    }

    fn handle_negotiation(&mut self, cmd: u8, o: u8, out: &mut Vec<u8>, log: &mut Vec<String>) {
        log.push(format!("<- {:02X} {}", cmd, name_of(o)));
        let side = self.options.iter().find(|x| x.byte == o).map(|x| x.side);
        let supported = side.is_some();
        let side = side.unwrap_or(Side::Remote);
        match cmd {
            DO => {
                // 对端要求我方启用
                let reply = if supported { command_ack(side) } else { WONT };
                if supported {
                    if let Some(x) = self.find_mut(o) {
                        x.state |= STATE_ENABLED;
                    }
                }
                self.send(out, log, reply, o);
            }
            WILL => {
                // 对端声明启用
                let reply = if supported { DO } else { DONT };
                if supported {
                    if let Some(x) = self.find_mut(o) {
                        x.state |= STATE_ENABLED;
                    }
                }
                self.send(out, log, reply, o);
            }
            DONT => {
                if let Some(x) = self.find_mut(o) {
                    x.state &= !STATE_ENABLED;
                }
                self.send(out, log, WONT, o);
            }
            WONT => {
                if let Some(x) = self.find_mut(o) {
                    x.state &= !STATE_ENABLED;
                }
                self.send(out, log, DONT, o);
            }
            _ => {}
        }
    }

    pub fn name_of(byte: u8) -> String {
        name_of(byte)
    }
}

/// 选项号 -> 名称（表驱动：标准选项 + 未知回退 0xNN）
pub fn name_of(byte: u8) -> String {
    client_option_table()
        .into_iter()
        .find(|o| o.byte == byte)
        .and_then(|o| o.name.map(String::from))
        .unwrap_or_else(|| format!("TELOPT_0x{:02X}", byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_table_values() {
        // commandAck: (x!=0)*2+0xfb
        assert_eq!(command_ack(Side::Local), DO);
        assert_eq!(command_ack(Side::Remote), WILL);
        // commandNoAck: (x!=0)*2-4
        assert_eq!(command_no_ack(Side::Local), DONT);
        assert_eq!(command_no_ack(Side::Remote), WONT);
        // commandReq: (x==0)*2+0xfb
        assert_eq!(command_req(Side::Remote), DO);
        assert_eq!(command_req(Side::Local), WILL);
        // commandNoReq: (x==0)*2-4
        assert_eq!(command_no_req(Side::Remote), DONT);
        assert_eq!(command_no_req(Side::Local), WONT);
    }

    #[test]
    fn init_command_maps_name_presence() {
        assert_eq!(init_command(true), WILL);  // 有名称 -> 0xFB
        assert_eq!(init_command(false), DO);   // 无名称 -> 0xFD
    }

    #[test]
    fn initial_requests_only_flag_0x10() {
        let n = Negotiator::client_default();
        let req = n.initial_requests();
        // 表中带 INIT_REQUEST 的：ECHO(有名称->WILL), SGA(WILL), SEND(WILL), NEW_ENV(无名称->DO)
        assert!(req.windows(3).any(|w| w == [IAC, WILL, opt::ECHO]));
        assert!(req.windows(3).any(|w| w == [IAC, WILL, opt::SGA]));
        assert!(req.windows(3).any(|w| w == [IAC, DO, opt::NEW_ENV]));
        assert!(!req.windows(3).any(|w| w == [IAC, WILL, opt::STATUS]));
    }

    #[test]
    fn parser_escape_and_negotiation_and_sub() {
        let mut n = Negotiator::client_default();
        let o = n.on_data(&[b'a', IAC, IAC, b'b', IAC, WILL, opt::ECHO]);
        assert_eq!(o.data, b"a\xFFb"); // IAC IAC -> 转义出字面 0xFF（RFC 854）
        // WILL ECHO -> 我方回 DO ECHO
        assert!(o.responses.windows(3).any(|w| w == [IAC, DO, opt::ECHO]));
        // 子选项吞掉
        let o2 = n.on_data(&[IAC, SB, opt::TM, 1, 2, IAC, SE, b'z']);
        assert_eq!(o2.data, b"z");
    }

    #[test]
    fn echo_off_means_local_edit() {
        let mut n = Negotiator::client_default();
        assert!(!n.is_local_edit()); // ECHO 初始 ENABLED
        n.options.iter_mut().find(|x| x.byte == opt::ECHO).unwrap().state &= !STATE_ENABLED;
        assert!(n.is_local_edit());
    }
}