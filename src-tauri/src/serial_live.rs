// hurricaneTerm — 串口实连层（POSIX termios 直驱）
// 选项语义（默认值/归一/校验）见 re/serial.rs；
// 本文件只做真实端口 IO 接线；选项校验/默认值/归一全部走 re::serial 语义路径。
//
// 为什么不用 serialport crate：其 Parity 无 Mark/Space、StopBits 无 1.5；
// 而 Linux 经 CMSPAR 支持 Mark/Space（macOS 不支持），且 1.5 位停止位
// 在 POSIX 上本就无对应设置 → 直驱 termios 才能覆盖这些取值。
//
// 行为约束落地：
// - setOption 空函数体 → 不提供运行期改参，必须重开会话。
// - attach：setPortName → 先 detach → open(ReadWrite=3)；仅成功才 attached+state=3；失败静默。
// - detach：isOpen 才 detaching→close→detached；state 一律 0。
// - hostAddress/hostName = portName。
// - lastErrorString ≈ 本层 open 错误文本。
#![allow(dead_code)]

use crate::re::serial::{settings_from_options, FlowControl, OptVal, Parity, SerialBridge, SerialSettings};
use crate::ssh_live::Sink;
use crate::{AppHandle, Emitter, OutPayload};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::time::Duration;
use tokio::sync::mpsc;

/// VTIME=2（0.1s 单位）→ 空读节拍 200ms，pump 借此轮询 stop
pub const READ_POLL: Duration = Duration::from_millis(200);

// ———— 纯映射（可单测；flag 语义按 posix/CMSPAR 能力） ————

/// dataBits(5..=8，re 已归一) → c_cflag 数据位编码
pub fn data_bits_flag(n: u8) -> libc::tcflag_t {
    match n {
        5 => termios::CS5,
        6 => termios::CS6,
        7 => termios::CS7,
        _ => termios::CS8,
    }
}

/// parity → (置位, 清除) 位组。Linux 经 CMSPAR 支持 Mark/Space；
/// 其余平台（macOS/Windows）Mark/Space → None → open 报不支持。
pub fn parity_flags(p: Parity) -> Option<(libc::tcflag_t, libc::tcflag_t)> {
    #[cfg(target_os = "linux")]
    let cmspar = libc::CMSPAR as libc::tcflag_t;
    #[cfg(not(target_os = "linux"))]
    let cmspar: libc::tcflag_t = 0;
    let clear = termios::PARENB | termios::PARODD | cmspar;
    let set: libc::tcflag_t = match p {
        Parity::None => 0,
        Parity::Even => termios::PARENB,
        Parity::Odd => termios::PARENB | termios::PARODD,
        #[cfg(target_os = "linux")]
        Parity::Mark => termios::PARENB | termios::PARODD | cmspar,
        #[cfg(target_os = "linux")]
        Parity::Space => termios::PARENB | cmspar,
        #[cfg(not(target_os = "linux"))]
        Parity::Mark | Parity::Space => return None,
    };
    Some((set, clear))
}

/// stopBits(1..=3，re 已归一)：1→无 CSTOPB；2→CSTOPB；3(1.5)→POSIX 不支持
pub fn stop_bits_flag(n: u8) -> io::Result<libc::tcflag_t> {
    match n {
        1 => Ok(0),
        2 => Ok(termios::CSTOPB),
        _ => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("停止位 {n}（1.5）在 POSIX 不支持"),
        )),
    }
}

pub fn flow_cflag(f: FlowControl) -> libc::tcflag_t {
    match f {
        FlowControl::Hardware => libc::CRTSCTS as libc::tcflag_t,
        _ => 0,
    }
}

pub fn flow_iflag(f: FlowControl) -> libc::tcflag_t {
    match f {
        FlowControl::Software => termios::IXON | termios::IXOFF,
        _ => 0,
    }
}

/// 波特率 → termios 速度码：不在支持表内 → 打开失败。
pub fn baud_speed(rate: i32) -> Option<termios::speed_t> {
    if rate <= 0 {
        return None;
    }
    let r = rate as u32;
    let s = match r {
        50 => termios::B50,
        75 => termios::B75,
        110 => termios::B110,
        134 => termios::B134,
        150 => termios::B150,
        200 => termios::B200,
        300 => termios::B300,
        600 => termios::B600,
        1200 => termios::B1200,
        1800 => termios::B1800,
        2400 => termios::B2400,
        4800 => termios::B4800,
        9600 => termios::B9600,
        19200 => termios::B19200,
        38400 => termios::B38400,
        57600 => libc::B57600 as termios::speed_t,
        115200 => libc::B115200 as termios::speed_t,
        #[cfg(target_os = "linux")]
        230400 => libc::B230400 as termios::speed_t,
        #[cfg(target_os = "linux")]
        460800 => libc::B460800 as termios::speed_t,
        _ => return None,
    };
    Some(s as termios::speed_t)
}

/// 人读参数串（attach 日志）："115200 8N1 flow=RTS/CTS"
pub fn settings_text(s: &SerialSettings) -> String {
    let p = match s.parity {
        Parity::None => 'N',
        Parity::Even => 'E',
        Parity::Odd => 'O',
        Parity::Mark => 'M',
        Parity::Space => 'S',
    };
    let f = match s.flow {
        FlowControl::None => "None",
        FlowControl::Hardware => "RTS/CTS",
        FlowControl::Software => "XON/XOFF",
    };
    format!("{} {}{}{} flow={}", s.baud_rate, s.data_bits, p, s.stop_bits, f)
}

// ———— 端口实体：File + termios 配置（Read/Write/Send） ————

#[derive(Debug)]
pub struct RawPort {
    file: std::fs::File,
}

impl Read for RawPort {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.file.read(buf)
    }
}
impl Write for RawPort {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.file.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl RawPort {
    pub fn try_clone(&self) -> io::Result<RawPort> {
        Ok(RawPort { file: self.file.try_clone()? })
    }
}

/// 配置 termios（open 后一次性；运行期不可改）
#[cfg(unix)]
pub fn configure(fd: std::os::unix::io::RawFd, s: &SerialSettings) -> io::Result<()> {
    let speed = baud_speed(s.baud_rate)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("不支持的波特率 {}", s.baud_rate)))?;
    let (pset, pclear) = parity_flags(s.parity).ok_or_else(|| {
        io::Error::new(io::ErrorKind::Unsupported, format!("{:?} 校验位本平台不支持", s.parity))
    })?;
    let stop = stop_bits_flag(s.stop_bits)?;

    let mut t = termios::Termios::from_fd(fd)?;
    termios::cfmakeraw(&mut t); // 原始模式（串口透传）
    // c_cflag：先清相关位组再置
    let clear = termios::CSIZE | termios::CSTOPB | termios::PARENB | termios::PARODD | pclear | libc::CRTSCTS as libc::tcflag_t;
    t.c_cflag &= !clear;
    t.c_cflag |= data_bits_flag(s.data_bits) | termios::CREAD | termios::CLOCAL | stop | pset | flow_cflag(s.flow);
    // c_iflag：软件流控
    t.c_iflag &= !(termios::IXON | termios::IXOFF | termios::IXANY);
    t.c_iflag |= flow_iflag(s.flow);
    // 空读节拍：VMIN=0/VTIME=2（200ms）
    t.c_cc[termios::VMIN as usize] = 0;
    t.c_cc[termios::VTIME as usize] = 2;
    termios::cfsetspeed(&mut t, speed)?;
    termios::tcsetattr(fd, termios::TCSANOW, &t)
}

#[cfg(not(unix))]
pub fn configure(_fd: i32, _s: &SerialSettings) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "串口仅支持 POSIX（Windows 属 P2）"))
}

/// open(ReadWrite=3) 等价：打开 + 配置；错误文本 = lastErrorString 语义
#[cfg(unix)]
pub fn open_port(name: &str, s: &SerialSettings) -> io::Result<RawPort> {
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(name)
        .map_err(|e| io::Error::new(e.kind(), format!("{name}: {e}")))?;
    configure(file.as_raw_fd(), s)?;
    Ok(RawPort { file })
}

#[cfg(not(unix))]
pub fn open_port(name: &str, _s: &SerialSettings) -> io::Result<RawPort> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("{name}: 串口实连仅支持 POSIX（Windows 属 P2）"),
    ))
}

/// 控制句柄
pub struct SerialCtl {
    pub writer: RawPort,
    pub stop: mpsc::UnboundedSender<()>,
}

/// SerialSession::open 流：setConfig → attach(session.target)。
/// 失败返回 Err（错误文本=lastErrorString）；成功进入 attached/state=3 并起 pump。
pub fn spawn_session(
    app: AppHandle,
    id: String,
    port_name: &str,
    options: &BTreeMap<String, OptVal>,
) -> io::Result<(String, SerialCtl)> {
    // 语义路径：re::serial::settings_from_options（config 守卫/默认/归一全在其中）
    let settings = settings_from_options(Some(options));

    // __attach：setPortName → __detach（新桥无旧口）→ open；仅成功才 attached+state=3
    let mut bridge = SerialBridge::default();
    bridge.settings = settings.clone();
    let port = match open_port(port_name, &settings) {
        Ok(p) => p,
        Err(e) => {
            bridge.attach(port_name, false); // 失败静默：state=0、无 attached 信号
            return Err(e);
        }
    };
    bridge.attach(port_name, true);

    let sink = Sink::from_app(app.clone());
    sink.emit(
        "re-log",
        id.clone(),
        format!("attached {} ({})", port_name, settings_text(&settings)),
    );

    let reader = port.try_clone()?;
    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<()>();
    let id2 = id.clone();
    let port2 = port_name.to_string();
    std::thread::spawn(move || {
        pump(reader, &sink, &id2, &mut stop_rx);
        // detach 序列：isOpen 才 detaching→close→detached
        sink.emit("re-log", id2.clone(), format!("detaching {port2}"));
        sink.emit("re-log", id2.clone(), "detached".into());
        let _ = app.emit("pty-exit", OutPayload { id: id2, data: String::new() });
    });

    Ok((port_name.to_string(), SerialCtl { writer: port, stop: stop_tx }))
}

/// 输出泵：tty 语义 Ok(0)=VTIME 空读（非 EOF）；退出靠错误或 stop。
/// 泛型化以便用 UnixStream 单测（生产传 RawPort）。
pub fn pump<R: Read>(mut reader: R, sink: &Sink, id: &str, stop: &mut mpsc::UnboundedReceiver<()>) {
    let mut buf = [0u8; 4096];
    let mut decoder = crate::terminal_io::Utf8Decoder::default();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {} // 空读节拍
            Ok(n) => {
                let data = decoder.push(&buf[..n]);
                if !data.is_empty() { sink.emit("pty-output", id.to_string(), data); }
            }
            Err(e)
                if e.kind() == io::ErrorKind::TimedOut
                    || e.kind() == io::ErrorKind::WouldBlock
                    || e.raw_os_error() == Some(11) => {}
            Err(_) => break,
        }
        if stop.try_recv().is_ok() {
            break;
        }
    }
    let tail = decoder.finish();
    if !tail.is_empty() { sink.emit("pty-output", id.to_string(), tail); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::re::serial::FlowControl;
    use std::io::Write as _;
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex};

    #[test]
    fn data_bits_flags() {
        assert_eq!(data_bits_flag(5), termios::CS5);
        assert_eq!(data_bits_flag(7), termios::CS7);
        assert_eq!(data_bits_flag(8), termios::CS8);
        assert_eq!(data_bits_flag(9), termios::CS8); // 归一兜底
    }

    #[test]
    fn parity_flags_match_qt() {
        #[cfg(target_os = "linux")]
        let cmspar = libc::CMSPAR as libc::tcflag_t;
        #[cfg(not(target_os = "linux"))]
        let cmspar: libc::tcflag_t = 0;
        let clear = termios::PARENB | termios::PARODD | cmspar;
        assert_eq!(parity_flags(Parity::None), Some((0, clear)));
        assert_eq!(parity_flags(Parity::Even), Some((termios::PARENB, clear)));
        assert_eq!(parity_flags(Parity::Odd), Some((termios::PARENB | termios::PARODD, clear)));
        #[cfg(target_os = "linux")]
        {
            assert_eq!(parity_flags(Parity::Mark), Some((termios::PARENB | termios::PARODD | cmspar, clear)));
            assert_eq!(parity_flags(Parity::Space), Some((termios::PARENB | cmspar, clear)));
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(parity_flags(Parity::Mark), None);
            assert_eq!(parity_flags(Parity::Space), None);
        }
    }

    #[test]
    fn stop_bits_posix_semantics() {
        assert_eq!(stop_bits_flag(1).unwrap(), 0);
        assert_eq!(stop_bits_flag(2).unwrap(), termios::CSTOPB);
        // 1.5 位停止位在 POSIX 不支持 → 报错（取值域 1..=3 中的 3）
        assert!(stop_bits_flag(3).is_err());
    }

    #[test]
    fn flow_flags() {
        assert_eq!(flow_cflag(FlowControl::Hardware), libc::CRTSCTS as libc::tcflag_t);
        assert_eq!(flow_cflag(FlowControl::Software), 0);
        assert_eq!(flow_iflag(FlowControl::Software), termios::IXON | termios::IXOFF);
        assert_eq!(flow_iflag(FlowControl::None), 0);
    }

    #[test]
    fn baud_table_matches_qt_supported() {
        assert_eq!(baud_speed(9600).unwrap() as u32, termios::B9600 as u32);
        assert_eq!(baud_speed(115200).unwrap() as u32, libc::B115200 as u32);
        assert_eq!(baud_speed(123456), None); // 支持表外 → 打开失败
        assert_eq!(baud_speed(0), None);
        assert_eq!(baud_speed(-1), None);
    }

    #[test]
    fn settings_text_human_form() {
        let s = SerialSettings { baud_rate: 115200, data_bits: 7, parity: Parity::Even, stop_bits: 2, flow: FlowControl::Hardware };
        assert_eq!(settings_text(&s), "115200 7E2 flow=RTS/CTS");
    }

    #[test]
    fn open_nonexistent_port_fails_with_error_text() {
        let s = SerialSettings::default();
        let e = open_port("/dev/definitely-not-a-tty-htest", &s).unwrap_err();
        assert!(e.to_string().contains("/dev/definitely-not-a-tty-htest"));
    }

    #[test]
    #[cfg(unix)]
    fn open_port_on_real_tty_slave_e2e() {
        // posix_openpt → 从端 tty 路径 = 真字符设备；验证 open_port+configure 全路径
        // （含 Mark 校验位 CMSPAR、硬件流控 CRTSCTS 在 Linux tty 层接受）
        let mfd = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
        if mfd < 0 {
            return; // 无 /dev/ptmx 环境：跳过
        }
        assert_eq!(unsafe { libc::grantpt(mfd) }, 0);
        assert_eq!(unsafe { libc::unlockpt(mfd) }, 0);
        let name = unsafe {
            let p = libc::ptsname(mfd);
            assert!(!p.is_null());
            std::ffi::CStr::from_ptr(p).to_string_lossy().to_string()
        };
        let s = SerialSettings {
            baud_rate: 115200,
            data_bits: 7,
            parity: Parity::Mark,
            stop_bits: 2,
            flow: FlowControl::Hardware,
        };
        let mut port = open_port(&name, &s).expect("open slave tty");
        // 写路径：从端 write → 主端 read（pty 管道透传）
        port.write_all(b"uart-live-ok").unwrap();
        let mut buf = [0u8; 12];
        let n = unsafe { libc::read(mfd, buf.as_mut_ptr() as *mut libc::c_void, 12) };
        assert!(n > 0, "主端未读到字节");
        assert_eq!(&buf[..n as usize], b"uart-live-ok");
        // 读路径：主端写 → RawPort read（VTIME 节拍内到达）
        unsafe { libc::write(mfd, b">>rcv".as_ptr() as *const libc::c_void, 5) };
        let mut got = [0u8; 8];
        let mut r = &mut port;
        let mut tries = 0usize;
        let m = loop {
            let k = r.read(&mut got).unwrap();
            if k > 0 {
                break got[..k].to_vec();
            }
            tries += 1;
            assert!(tries < 50, "VTIME 空读 10s 未见数据");
        };
        assert_eq!(m, b">>rcv");
        drop(port);
        unsafe { libc::close(mfd) };
    }

    #[test]
    #[cfg(unix)]
    fn configure_rejects_unsupported_baud_on_real_fd() {
        // 用 pts 对做真 fd：cfsetspeed 表外值应报 InvalidInput
        let l = std::fs::File::open("/dev/ptmx");
        let Ok(f) = l else { return }; // 无 ptmx 环境跳过
        let s = SerialSettings { baud_rate: 123456, ..Default::default() };
        use std::os::unix::io::AsRawFd;
        let e = configure(f.as_raw_fd(), &s).unwrap_err();
        assert!(e.kind() == io::ErrorKind::InvalidInput, "{e:?}");
    }

    #[test]
    fn pump_forwards_output_and_honors_stop() {
        let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let sink = Sink(Arc::new(move |t: &str, _id: String, d: String| {
            ev.lock().unwrap().push((t.to_string(), d));
        }));
        let (mut a, b) = UnixStream::pair().unwrap();
        b.set_read_timeout(Some(READ_POLL)).unwrap();
        let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();

        a.write_all(b"uart> hello").unwrap();
        let h = std::thread::spawn(move || {
            let mut rx = stop_rx;
            let mut r = b;
            pump(&mut r, &sink, "t1", &mut rx)
        });
        std::thread::sleep(Duration::from_millis(400));
        let _ = stop_tx.send(());
        h.join().unwrap();
        let snap = events.lock().unwrap().clone();
        assert!(snap.iter().any(|(t, d)| t == "pty-output" && d == "uart> hello"), "{snap:?}");
    }

    #[test]
    fn pump_exits_on_read_error_or_stop() {
        // tty 语义：Ok(0) 不是 EOF；关闭对端后靠 stop 退出（或读错误）
        let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let sink = Sink(Arc::new(move |t: &str, _id: String, d: String| {
            ev.lock().unwrap().push((t.to_string(), d));
        }));
        let (a, b) = UnixStream::pair().unwrap();
        b.set_read_timeout(Some(READ_POLL)).unwrap();
        drop(a);
        let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();
        let h = std::thread::spawn(move || {
            let mut rx = stop_rx;
            let mut r = b;
            pump(&mut r, &sink, "t2", &mut rx)
        });
        std::thread::sleep(Duration::from_millis(300));
        let _ = stop_tx.send(());
        h.join().unwrap(); // 会返回：Ok(0) 不退出，stop 退出
    }

    #[test]
    fn options_flow_uses_re_semantics() {
        let m: BTreeMap<String, OptVal> = [("serial.baudRate".to_string(), OptVal::Str("57600".into())), ("serial.dataBits".to_string(), OptVal::Int(12)), ("serial.stopBits".to_string(), OptVal::Int(9))]
            .into_iter()
            .collect();
        let s = settings_from_options(Some(&m));
        assert_eq!(s.baud_rate, 57600);
        assert_eq!(data_bits_flag(s.data_bits), termios::CS8); // 越界归一 8
        assert_eq!(stop_bits_flag(s.stop_bits).unwrap(), 0); // 越界归一 1
    }
}
