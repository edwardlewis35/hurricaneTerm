//! 串口会话 —— 语义重写自 WindTerm 2.6.0 `SerialBridge` / `SerialSession`
//! 证据（目标 sha256 d26c6406…35edd1，入口地址）：
//! - SerialBridge::setConfig   entry 1003b2f30
//! - SerialBridge::__attach    entry 1003b2d30
//! - SerialBridge::__detach    entry 1003b2db0
//! - SerialSession::open       entry 1003b39d0
//! - SerialBridge::setOption   （空函数体——运行期改选项无效，实证）
//! - SerialBridge::read/write/hostAddress/hostName/lastErrorString（薄转发 QSerialPort）
//! 属性名实读自 prop-names.tsv：serial.baudRate/dataBits/parity/stopBits/flowControl、
//! session.target。
//!
//! 已确证语义：
//! 1. 配置守卫：会话配置存在（config!=null && count!=0 && options!=null）才读选项，
//!    否则全部走默认：9600 / 8 / None / 1 / None。
//! 2. baudRate：toInt，无范围校验；setBaudRate(rate, AllDirections=3)。
//! 3. dataBits：仅 5..=8 合法（`(n-5)<4`），否则回退 8。
//! 4. parity：字符串精确比较（CaseSensitive）Even→2 Odd→3 Mark→5 Space→4，其余→0
//!    （与 QSerialPort::Parity 枚举值一致）。
//! 5. stopBits：仅 1..=3 合法（`(n-1)<3`），否则回退 1。
//! 6. flowControl："RTS/CTS"→1（硬件），"XON/XOFF"→2（软件），其余→0。
//! 7. attach：setPortName → 先 detach → open(ReadWrite=3)；成功才
//!    attached 信号 + setState(3)；失败静默（错误文本经 lastErrorString 取）。
//! 8. detach：若 isOpen → detaching 信号 → close → setState(0) → detached 信号；
//!    未开则仅 setState(0)，不发信号。
//! 9. SerialSession::open：createBridge → setConfig → attach(session.target, 0)。
//!    端口名来自 session.target；hostAddress/hostName 均返回 portName()。

use std::collections::BTreeMap;

/// Qt QSerialPort::Parity 枚举值（二进制实证映射）
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Parity {
    #[default]
    None = 0,
    Even = 2,
    Odd = 3,
    Space = 4,
    Mark = 5,
}

/// Qt QSerialPort::FlowControl 枚举值
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum FlowControl {
    #[default]
    None = 0,
    Hardware = 1, // "RTS/CTS"
    Software = 2, // "XON/XOFF"
}

/// SuperBridge::setState 观察到的状态码（attach 成功=3，detach=0）
pub const STATE_DETACHED: u32 = 0;
pub const STATE_ATTACHED: u32 = 3;

/// QSerialPort::open 传入的 OpenMode：ReadWrite = 1|2 = 3
pub const OPEN_MODE_READWRITE: u32 = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct SerialSettings {
    pub baud_rate: i32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
    pub flow: FlowControl,
}

impl Default for SerialSettings {
    /// 无配置时的默认值（setConfig 字面量：0x2580/8/"None"/1/"None"）
    fn default() -> Self {
        SerialSettings { baud_rate: 9600, data_bits: 8, parity: Parity::None, stop_bits: 1, flow: FlowControl::None }
    }
}

/// 会话选项值（SuperSession::option 的 QVariant 简化）
#[derive(Clone, Debug, PartialEq)]
pub enum OptVal {
    Int(i64),
    Str(String),
}

impl OptVal {
    fn to_int(&self) -> i64 {
        match self {
            OptVal::Int(i) => *i,
            OptVal::Str(s) => s.trim().parse().unwrap_or(0), // QVariant::toInt 失败=0
        }
    }
    fn to_str(&self) -> &str {
        match self {
            OptVal::Str(s) => s,
            OptVal::Int(_) => "", // toString 数值型此处未用到
        }
    }
}

/// parity 字符串 → 枚举（QString::compare CaseSensitive；不匹配任何已知值 → None）
pub fn parity_from_str(s: &str) -> Parity {
    match s {
        "Even" => Parity::Even,
        "Odd" => Parity::Odd,
        "Mark" => Parity::Mark,
        "Space" => Parity::Space,
        _ => Parity::None,
    }
}

/// flowControl 字符串 → 枚举
pub fn flow_from_str(s: &str) -> FlowControl {
    match s {
        "RTS/CTS" => FlowControl::Hardware,
        "XON/XOFF" => FlowControl::Software,
        _ => FlowControl::None,
    }
}

/// dataBits 合法域 5..=8，否则回退 8（证据：`iVar6 - 5U < 4`）
pub fn normalize_data_bits(n: i64) -> u8 {
    if (5..=8).contains(&n) {
        n as u8
    } else {
        8
    }
}

/// stopBits 合法域 1..=3，否则回退 1（证据：`iVar6 - 1U < 3`）
pub fn normalize_stop_bits(n: i64) -> u8 {
    if (1..=3).contains(&n) {
        n as u8
    } else {
        1
    }
}

/// setConfig 的完整语义：`options=None` 对应二进制里的配置缺失守卫（全默认）。
pub fn settings_from_options(options: Option<&BTreeMap<String, OptVal>>) -> SerialSettings {
    let Some(map) = options else {
        return SerialSettings::default();
    };
    let get = |k: &str| map.get(k);
    // baudRate：toInt，无校验（证据：直接 setBaudRate）
    let baud_rate = get("serial.baudRate").map(|v| v.to_int() as i32).unwrap_or(9600);
    let data_bits = get("serial.dataBits").map(|v| normalize_data_bits(v.to_int())).unwrap_or(8);
    let parity = get("serial.parity").map(|v| parity_from_str(v.to_str())).unwrap_or_default();
    let stop_bits = get("serial.stopBits").map(|v| normalize_stop_bits(v.to_int())).unwrap_or(1);
    let flow = get("serial.flowControl").map(|v| flow_from_str(v.to_str())).unwrap_or_default();
    SerialSettings { baud_rate, data_bits, parity, stop_bits, flow }
}

/// 桥状态机（attach/detach 信号顺序语义）
#[derive(Debug, Default)]
pub struct SerialBridge {
    pub state: u32,
    pub port_name: String,
    pub settings: SerialSettings,
    pub open: bool,
    /// 记录发出的信号序列，供测试断言（detaching/detached 仅当 isOpen）
    pub signals: Vec<&'static str>,
}

impl SerialBridge {
    /// SerialSession::open 流：setConfig → attach(session.target)
    pub fn session_open(&mut self, target: &str, options: Option<&BTreeMap<String, OptVal>>) {
        self.settings = settings_from_options(options);
        self.attach(target, true);
    }

    /// __attach：setPortName → 先 detach → open(ReadWrite)；仅成功才 attached+state=3
    pub fn attach(&mut self, port_name: &str, open_ok: bool) -> bool {
        self.port_name = port_name.to_string();
        self.detach();
        if open_ok {
            self.open = true;
            self.state = STATE_ATTACHED;
            self.signals.push("attached");
            true
        } else {
            false
        }
    }

    /// __detach：isOpen 才 detaching→close→detached；state 一律置 0
    pub fn detach(&mut self) {
        if self.open {
            self.signals.push("detaching");
            self.open = false;
            self.state = STATE_DETACHED;
            self.signals.push("detached");
        } else {
            self.state = STATE_DETACHED;
        }
    }

    /// setOption：二进制为空函数体——串口选项运行期不可变，必须重开会话
    pub fn set_option(&mut self, _key: &str, _val: OptVal) {}

    /// hostAddress/hostName：均返回 portName()
    pub fn host(&self) -> &str {
        &self.port_name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: Vec<(&str, OptVal)>) -> BTreeMap<String, OptVal> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn defaults_without_config() {
        // 证据守卫：config 缺失 → 9600/8/None/1/None
        assert_eq!(settings_from_options(None), SerialSettings::default());
        assert_eq!(SerialSettings::default().baud_rate, 9600); // 0x2580 实读
    }

    #[test]
    fn reads_all_five_properties() {
        let m = map(vec![
            ("serial.baudRate", OptVal::Int(115200)),
            ("serial.dataBits", OptVal::Int(7)),
            ("serial.parity", OptVal::Str("Even".into())),
            ("serial.stopBits", OptVal::Int(2)),
            ("serial.flowControl", OptVal::Str("XON/XOFF".into())),
        ]);
        let s = settings_from_options(Some(&m));
        assert_eq!(s, SerialSettings { baud_rate: 115200, data_bits: 7, parity: Parity::Even, stop_bits: 2, flow: FlowControl::Software });
    }

    #[test]
    fn data_bits_and_stop_bits_fallback() {
        assert_eq!(normalize_data_bits(4), 8); // 越界回退
        assert_eq!(normalize_data_bits(9), 8);
        assert_eq!(normalize_data_bits(5), 5);
        assert_eq!(normalize_stop_bits(0), 1);
        assert_eq!(normalize_stop_bits(4), 1);
        assert_eq!(normalize_stop_bits(3), 3);
    }

    #[test]
    fn parity_flow_str_maps_case_sensitive() {
        assert_eq!(parity_from_str("Mark"), Parity::Mark);
        assert_eq!(parity_from_str("mark"), Parity::None); // CaseSensitive 比较
        assert_eq!(parity_from_str("Bogus"), Parity::None);
        assert_eq!(flow_from_str("RTS/CTS"), FlowControl::Hardware);
        assert_eq!(flow_from_str("rts/cts"), FlowControl::None);
    }

    #[test]
    fn attach_detach_signal_order() {
        let mut b = SerialBridge::default();
        // 未开时 detach：仅置状态，不发信号（证据：cVar1==0 分支）
        b.detach();
        assert!(b.signals.is_empty());
        assert_eq!(b.state, STATE_DETACHED);
        // attach 成功：state=3 + attached
        assert!(b.attach("/dev/tty.usbserial", true));
        assert_eq!(b.state, STATE_ATTACHED);
        assert_eq!(b.signals, vec!["attached"]);
        // 重 attach：先 detach（detaching/detached）再 attached
        b.signals.clear();
        assert!(b.attach("/dev/ttyUSB0", true));
        assert_eq!(b.signals, vec!["detaching", "detached", "attached"]);
        assert_eq!(b.host(), "/dev/ttyUSB0");
    }

    #[test]
    fn attach_failure_keeps_state_and_silent() {
        let mut b = SerialBridge::default();
        assert!(!b.attach("/dev/nope", false));
        assert_eq!(b.state, STATE_DETACHED);
        assert!(b.signals.is_empty()); // 失败不发 attached（实证）
        // 端口名仍已写入（setPortName 在 open 之前）
        assert_eq!(b.port_name, "/dev/nope");
    }

    #[test]
    fn set_option_is_noop() {
        let mut b = SerialBridge::default();
        b.set_option("serial.baudRate", OptVal::Int(19200));
        assert_eq!(b.settings, SerialSettings::default()); // 空函数体实证
    }

    #[test]
    fn session_open_flow() {
        let mut b = SerialBridge::default();
        let m = map(vec![("serial.baudRate", OptVal::Str("57600".into()))]);
        b.session_open("COM3", Some(&m));
        assert_eq!(b.settings.baud_rate, 57600); // toInt 字符串路径
        assert!(b.open);
        assert_eq!(b.state, STATE_ATTACHED);
    }
}
