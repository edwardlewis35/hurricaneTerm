//! 本地 Shell 会话 —— pty 附着、环境/locale 组装、子进程初始化与命令执行。
//! 会话属性：process.arguments / process.environment / process.locale /
//! process.workingDirectory。
//!
//! 语义：
//! 1. attach(program)：路径规范化后存为 shell 路径 → detach 旧会话 →
//!    创建 pty → 挂接 readyRead/errorOccurred → 读 4 个 process.* 选项 →
//!    拆分用户环境 → cwd 不存在则清空 → 默认 env 三件套（缺失才补）→
//!    locale 解析 → LANG 缺失才注入 → pty.start(program,args,cwd,env,…) →
//!    成功 setState(3)+attached。
//! 2. 默认 env：COLORTERM=truecolor、
//!    COMMAND_MODE=unix2003（macOS 惯例）、TERM=xterm-256color；
//!    合并方向：用户 env 为准，默认仅补缺失键（map 查找命中则跳过 insert）。
//! 3. locale 解析：""→系统默认路径；"Ignore"→不注入；"Automatic"→
//!    系统默认 locale；否则若不在 systemLocales 列表内→清空（不注入）；
//!    最终 locale 非空且用户 env 无 LANG → 插入 LANG=<locale>。
//! 4. 子进程初始化（fork 后）：dup2(pty,0/1/2) → setsid →
//!    ioctl(fd,0x20007461=TIOCSCTTY) → tcsetpgrp(fd,sid) → 写 utmpx：
//!    ut_type=7(USER_PROCESS)、ut_line=去 "/dev/" 前缀的 tty 名、
//!    ut_id=line 末 4 字符、ut_user=用户名、ut_pid=getpid、ut_tv=gettimeofday、
//!    utmpxname("/var/run/utmpx")+setutxent/pututxline/endutxent。
//! 5. 命令执行器：execute(cmd) 对命令字节串**精确去重**（逐字节相等即忽略），
//!    否则 startProcess：splitCommandLine→program+args、以 ReadWrite=3 启动进程，
//!    stdout/stderr/stateChanged 三路输出汇聚为 commandOutput 信号。
//! 6. 窗口协商（negotiate_window，参数 cols/rows/force）：仅 force 且桥可识别为
//!    ShellBridge 时 resizeWindow；resizeWindow 对 pty==null 静默返回 0。
//! 7. hostAddress：路径存在→文件基名；否则→最后一个 [/\\] 之后的子串；
//!    hostName：返回完整 shell 路径。
//! 8. read/write：pty 为空→读取返回空 / 写入返回 0。

pub const STATE_DETACHED: u32 = 0;
pub const STATE_ATTACHED: u32 = 3;
/// macOS/BSD TIOCSCTTY ioctl 号（_IOR('t',97) = 0x20007461）
pub const TIOCSCTTY: u64 = 0x20007461;
/// utmpx 记录类型：USER_PROCESS（macOS）
pub const UT_TYPE_USER_PROCESS: i16 = 7;

/// attach 使用的默认环境三件套
pub const DEFAULT_ENV: [(&str, &str); 3] = [
    ("COLORTERM", "truecolor"),
    ("COMMAND_MODE", "unix2003"),
    ("TERM", "xterm-256color"),
];

/// setOption 语义：只写入选项 map，attach 时才生效
#[derive(Debug, Default)]
pub struct ShellBridge {
    pub state: u32,
    pub program: String,
    pub options: Vec<(String, String)>, // 以有序列表简化的选项 map
    pub pty_started: bool,
    pub signals: Vec<&'static str>,
}

impl ShellBridge {
    pub fn set_option(&mut self, key: &str, value: &str) {
        // 同名键覆盖旧值
        if let Some(slot) = self.options.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value.to_string();
        } else {
            self.options.push((key.to_string(), value.to_string()));
        }
    }

    pub fn get_option(&self, key: &str) -> Option<&str> {
        self.options.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// attach 流（IO 部分以参数注入）：成功才 state=3 + attached
    pub fn attach(&mut self, program: &str, plan: &AttachPlan, start_ok: bool) -> bool {
        self.program = normalize_program(program);
        // detach 先执行
        self.detach();
        if start_ok {
            self.pty_started = true;
            self.state = STATE_ATTACHED;
            self.signals.push("attached");
            let _ = plan; // plan 在真实实现里喂给 pty.start
            true
        } else {
            false
        }
    }

    pub fn detach(&mut self) {
        if self.pty_started {
            self.signals.push("detaching");
            self.pty_started = false;
            self.state = STATE_DETACHED;
            self.signals.push("detached");
        } else {
            self.state = STATE_DETACHED;
        }
    }

    /// resizeWindow：pty==null 静默（返回 None）
    pub fn resize_window(&self, cols: u16, rows: u16) -> Option<(u16, u16)> {
        if self.pty_started {
            Some((cols, rows))
        } else {
            None
        }
    }

    /// hostAddress 语义：文件存在→文件基名；否则→最后分隔符后子串
    pub fn host_address(&self) -> String {
        display_name(&self.program)
    }

    /// hostName：完整 shell 路径
    pub fn host_name(&self) -> &str {
        &self.program
    }
}

/// 程序路径规范化的可见效果：统一分隔符、折叠重复分隔符、
/// 去尾部分隔符（UNC 前导双斜杠特例未建模）。
pub fn normalize_program(path: &str) -> String {
    let unified: String = path.replace('\\', "/");
    let mut out = String::with_capacity(unified.len());
    let mut prev_sep = false;
    for c in unified.chars() {
        if c == '/' {
            if !prev_sep {
                out.push('/');
            }
            prev_sep = true;
        } else {
            out.push(c);
            prev_sep = false;
        }
    }
    let trimmed = out.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// hostAddress：若路径存在取文件基名，
/// 否则取最后一个 [/\\] 分隔符之后的子串（无分隔符则原样）。
pub fn display_name(path: &str) -> String {
    // 按路径是否存在分流；两条分支结果对规范路径一致，
    // 这里保留“取最后一段”的公共语义。
    let unified = path.replace('\\', "/");
    match unified.rfind('/') {
        Some(i) => unified[i + 1..].to_string(),
        None => unified,
    }
}

/// attach 时的 pty.start 计划（4 个 process.* 选项 + 解析后的 env/cwd）
#[derive(Debug, Default, PartialEq)]
pub struct AttachPlan {
    pub arguments: Vec<String>,
    pub working_directory: Option<String>,
    pub environment: Vec<(String, String)>, // 最终 env（含默认补齐与 LANG）
}

/// 属性名 → 选项读取（attach 使用的键）
pub const PROP_ARGUMENTS: &str = "process.arguments";
pub const PROP_ENVIRONMENT: &str = "process.environment";
pub const PROP_LOCALE: &str = "process.locale";
pub const PROP_WORKING_DIRECTORY: &str = "process.workingDirectory";

/// locale 解析（attach 四分支）
/// - "Ignore" → None（显式不注入）
/// - "Automatic" → Some(default_locale)
/// - 在 system_locales 列表内 → Some(该值)
/// - 否则 → None（不在系统 locale 列表即清空）
pub fn resolve_locale(prop: &str, system_locales: &[&str], default_locale: &str) -> Option<String> {
    if prop == "Ignore" {
        return None;
    }
    if prop == "Automatic" {
        return Some(default_locale.to_string());
    }
    if system_locales.contains(&prop) {
        return Some(prop.to_string());
    }
    None
}

/// 环境合并：用户 env 为准，DEFAULT_ENV 仅补缺失键；随后 locale 非空且
/// 用户未设 LANG 时注入 LANG（attach 末段）。
pub fn build_environment(user_env: &[(String, String)], locale: Option<&str>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = user_env.to_vec();
    for (k, v) in DEFAULT_ENV {
        if !env.iter().any(|(ek, _)| ek == k) {
            env.push((k.to_string(), v.to_string()));
        }
    }
    if let Some(loc) = locale {
        if !loc.is_empty() && !env.iter().any(|(ek, _)| ek == "LANG") {
            env.push(("LANG".to_string(), loc.to_string()));
        }
    }
    env
}

/// cwd 校验：目录不存在 → 清空为空串
pub fn validate_cwd(cwd: &str, exists: bool) -> Option<String> {
    if cwd.is_empty() || !exists {
        None
    } else {
        Some(cwd.to_string())
    }
}

/// utmpx 记录构造（子进程初始化写入的字段）
#[derive(Debug, PartialEq)]
pub struct UtmpxUser {
    pub ut_user: String,
    pub ut_line: String, // tty 设备名去 "/dev/" 前缀
    pub ut_id: String,   // ut_line 末 4 字符
    pub ut_type: i16,    // 7 = USER_PROCESS
    pub ut_pid: u32,
}

/// utmpx 部分：line 去 "/dev/" 前缀；id 取 line 末 4 字符。
pub fn build_utmpx(user: &str, tty_path: &str, pid: u32) -> UtmpxUser {
    let line = tty_path.strip_prefix("/dev/").unwrap_or(tty_path).to_string();
    let id = if line.len() >= 4 {
        line[line.len() - 4..].to_string()
    } else {
        line.clone()
    };
    UtmpxUser {
        ut_user: user.to_string(),
        ut_line: line,
        ut_id: id,
        ut_type: UT_TYPE_USER_PROCESS,
        ut_pid: pid,
    }
}

/// 子进程初始化的 syscall 顺序（供移植参考，非可执行逻辑）
pub fn child_setup_sequence() -> [&'static str; 5] {
    ["dup2(pty,0);dup2(pty,1);dup2(pty,2)", "setsid()", "ioctl(TIOCSCTTY)", "tcsetpgrp(pty,sid)", "pututxline(USER_PROCESS)"]
}

/// ShellExecutor 的命令去重表（execute：逐字节精确命中即忽略）
#[derive(Debug, Default)]
pub struct ShellExecutor {
    pub commands: Vec<String>,
}

impl ShellExecutor {
    /// 返回 true=已启动新进程；false=命令字节完全相同被去重
    pub fn execute(&mut self, command: &str) -> bool {
        if self.commands.iter().any(|c| c == command) {
            return false;
        }
        self.commands.push(command.to_string());
        true
    }
}

/// splitCommandLine 近似语义：
/// 首个空白分隔 token 为 program，其余为 args。
pub fn split_command_line(line: &str) -> (String, Vec<String>) {
    let mut it = line.split_whitespace();
    let program = it.next().unwrap_or_default().to_string();
    (program, it.map(|s| s.to_string()).collect())
}

/// 窗口协商门控：仅 force 且桥是 ShellBridge 才 resize
pub fn negotiate_window(force: bool, is_shell_bridge: bool, cols: u16, rows: u16) -> Option<(u16, u16)> {
    if force && is_shell_bridge {
        Some((cols, rows))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_env_fills_missing_only() {
        let user = vec![("TERM".to_string(), "xterm".to_string())];
        let env = build_environment(&user, None);
        // 用户 TERM 保留，不被默认 xterm-256color 覆盖（用户 env 为准）
        assert_eq!(env.iter().find(|(k, _)| k == "TERM").unwrap().1, "xterm");
        assert!(env.iter().any(|(k, v)| k == "COLORTERM" && v == "truecolor"));
        assert!(env.iter().any(|(k, v)| k == "COMMAND_MODE" && v == "unix2003"));
    }

    #[test]
    fn lang_injected_when_locale_and_absent() {
        let user: Vec<(String, String)> = vec![];
        let env = build_environment(&user, Some("zh_CN.UTF-8"));
        assert!(env.iter().any(|(k, v)| k == "LANG" && v == "zh_CN.UTF-8"));
        // 用户已设 LANG → 不覆盖
        let user2 = vec![("LANG".to_string(), "en_US.UTF-8".to_string())];
        let env2 = build_environment(&user2, Some("zh_CN.UTF-8"));
        assert_eq!(env2.iter().find(|(k, _)| k == "LANG").unwrap().1, "en_US.UTF-8");
        // locale None/空 → 不注入
        let env3 = build_environment(&user, None);
        assert!(!env3.iter().any(|(k, _)| k == "LANG"));
    }

    #[test]
    fn locale_resolution_four_branches() {
        let sys = ["en_US.UTF-8", "de_DE.UTF-8"];
        assert_eq!(resolve_locale("Ignore", &sys, "xx"), None);
        assert_eq!(resolve_locale("Automatic", &sys, "en_US.UTF-8").as_deref(), Some("en_US.UTF-8"));
        assert_eq!(resolve_locale("de_DE.UTF-8", &sys, "x").as_deref(), Some("de_DE.UTF-8"));
        assert_eq!(resolve_locale("fr_FR.UTF-8", &sys, "x"), None); // 不在列表→清空
    }

    #[test]
    fn cwd_validation() {
        assert_eq!(validate_cwd("/tmp/nope", false), None);
        assert_eq!(validate_cwd("", true), None);
        assert_eq!(validate_cwd("/tmp/yes", true).as_deref(), Some("/tmp/yes"));
    }

    #[test]
    fn utmpx_fields() {
        let r = build_utmpx("el", "/dev/ttys003", 4242);
        assert_eq!(r.ut_line, "ttys003"); // "/dev/" 前缀剥离
        assert_eq!(r.ut_id, "s003"); // 末 4 字符
        assert_eq!(r.ut_type, 7);
        assert_eq!(r.ut_pid, 4242);
        // 非 /dev/ 路径原样
        let r2 = build_utmpx("el", "ttys001", 1);
        assert_eq!(r2.ut_line, "ttys001");
        assert_eq!(r2.ut_id, "s001");
    }

    #[test]
    fn executor_dedup_exact_bytes() {
        let mut ex = ShellExecutor::default();
        assert!(ex.execute("ls -la"));
        assert!(!ex.execute("ls -la")); // 完全相同 → 忽略
        assert!(ex.execute("ls  -la")); // 一个空格之差即不同命令
        assert_eq!(ex.commands.len(), 2);
    }

    #[test]
    fn split_command_line_basic() {
        let (p, a) = split_command_line("git commit -m 'init'");
        assert_eq!(p, "git");
        assert_eq!(a, vec!["commit", "-m", "'init'"]);
    }

    #[test]
    fn attach_detach_and_resize() {
        let mut b = ShellBridge::default();
        b.set_option(PROP_LOCALE, "Ignore");
        assert_eq!(b.get_option(PROP_LOCALE), Some("Ignore"));
        // start 失败：无 attached 信号，state 保持 0
        assert!(!b.attach("/bin/zsh", &AttachPlan::default(), false));
        assert_eq!(b.state, STATE_DETACHED);
        assert!(b.signals.is_empty());
        // 成功：state=3 + attached；重 attach 先 detach
        assert!(b.attach("/bin/zsh", &AttachPlan::default(), true));
        assert_eq!(b.state, STATE_ATTACHED);
        b.signals.clear();
        b.attach("/bin/bash", &AttachPlan::default(), true);
        assert_eq!(b.signals, vec!["detaching", "detached", "attached"]);
        // resize：pty 在 → Some；negotiate 需 force+类型匹配
        assert_eq!(b.resize_window(120, 40), Some((120, 40)));
        assert_eq!(negotiate_window(true, true, 80, 24), Some((80, 24)));
        assert_eq!(negotiate_window(false, true, 80, 24), None);
        assert_eq!(negotiate_window(true, false, 80, 24), None);
        let dead = ShellBridge::default();
        assert_eq!(dead.resize_window(1, 1), None); // pty==null 静默
    }

    #[test]
    fn display_name_and_host() {
        assert_eq!(display_name("/bin/zsh"), "zsh");
        assert_eq!(display_name("C:\\Windows\\system32\\cmd.exe"), "cmd.exe");
        assert_eq!(display_name("zsh"), "zsh");
        let mut b = ShellBridge::default();
        b.program = "/usr/local/bin/fish".into();
        assert_eq!(b.host_address(), "fish");
        assert_eq!(b.host_name(), "/usr/local/bin/fish");
    }

    #[test]
    fn program_normalization() {
        assert_eq!(normalize_program("/bin//zsh/"), "/bin/zsh");
        assert_eq!(normalize_program("C:\\Windows\\cmd.exe"), "C:/Windows/cmd.exe");
    }

    #[test]
    fn child_setup_sequence_shape() {
        let seq = child_setup_sequence();
        assert_eq!(seq[0], "dup2(pty,0);dup2(pty,1);dup2(pty,2)");
        assert_eq!(seq[2], "ioctl(TIOCSCTTY)");
        assert_eq!(TIOCSCTTY, 0x20007461);
    }
}
