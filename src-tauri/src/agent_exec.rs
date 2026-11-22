//! Bounded, cancellable agent commands. A command gets its own process / SSH
//! exec channel; it never writes markers or input to the user's interactive PTY.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot, Notify};

pub const OUTPUT_LIMIT: usize = 256 * 1024;
const DEFAULT_TIMEOUT: u64 = 60;
const MAX_TIMEOUT: u64 = 300;
const TOMBSTONE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecRequest {
    pub request_id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_seconds: Option<u64>,
}
impl ExecRequest {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [("requestId", &self.request_id), ("sessionId", &self.session_id)] {
            if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
                return Err(format!("{name} 无效"));
            }
        }
        if self.command.trim().is_empty() || self.command.len() > 16_384 || self.command.contains('\0') {
            return Err("命令不能为空，且不能超过 16 KiB 或包含 NUL".into());
        }
        if let Some(path) = &self.cwd {
            if path.len() > 4096 || path.contains('\0') {
                return Err("工作目录无效或超过 4096 字节".into());
            }
        }
        let timeout = self.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT);
        if !(1..=MAX_TIMEOUT).contains(&timeout) { return Err("命令超时必须为 1–300 秒".into()); }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputEvent {
    pub request_id: String,
    pub session_id: String,
    pub stream: &'static str,
    pub data: String,
}
pub type OutputSink = Arc<dyn Fn(OutputEvent) + Send + Sync>;

#[derive(Clone)]
pub enum Target {
    Local { cwd: Option<PathBuf> },
    Ssh(mpsc::UnboundedSender<crate::ssh_live::SftpReq>),
    Unsupported,
}

pub struct ExecControl {
    // 0: running, 1: cancelled, 2: deadline, 3: session closed.
    reason: AtomicU8,
    notify: Notify,
    started: Instant,
    deadline: Instant,
}
impl ExecControl {
    pub fn new(timeout: Duration) -> Self {
        let started = Instant::now();
        Self { reason: AtomicU8::new(0), notify: Notify::new(), started, deadline: started + timeout }
    }
    fn stop(&self, reason: u8) {
        let _ = self.reason.compare_exchange(0, reason, Ordering::SeqCst, Ordering::SeqCst);
        self.notify.notify_one();
    }
    pub fn cancel(&self) { self.stop(1); }
    pub fn session_closed(&self) { self.stop(3); }
    pub fn is_stopped(&self) -> bool { self.reason.load(Ordering::SeqCst) != 0 }
    pub async fn stopped(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_stopped() { return; }
            notified.await;
        }
    }
    async fn deadline(&self) {
        tokio::time::sleep_until(tokio::time::Instant::from_std(self.deadline)).await;
        self.stop(2);
    }
    fn result(&self, request: &ExecRequest, output: Output, exit_code: Option<i32>, signal: Option<String>) -> ExecResult {
        let reason = self.reason.load(Ordering::SeqCst);
        ExecResult {
            stdout: output.stdout, stderr: output.stderr, exit_code, signal,
            duration_ms: self.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            truncated: output.truncated, timed_out: reason == 2, cancelled: reason == 1 || reason == 3,
            cwd: request.cwd.as_ref().filter(|s| !s.is_empty()).cloned(),
        }
    }
}

struct Active { session_id: String, control: Arc<ExecControl> }
#[derive(Default)]
struct Registry {
    active: HashMap<String, Active>,
    early_cancel: HashMap<String, Instant>,
    finished: HashMap<String, Instant>,
}
#[derive(Clone, Default)]
pub struct AgentExecState(Arc<Mutex<Registry>>);
pub struct Lease { state: AgentExecState, request_id: String, pub control: Arc<ExecControl> }
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.state.0.lock() {
            registry.active.remove(&self.request_id);
            bounded_insert(&mut registry.finished, self.request_id.clone(), 256);
        }
    }
}
fn bounded_insert(map: &mut HashMap<String, Instant>, id: String, max: usize) {
    let now = Instant::now();
    map.retain(|_, at| now.duration_since(*at) < TOMBSTONE_TTL);
    if map.len() >= max {
        if let Some(oldest) = map.iter().min_by_key(|(_, at)| **at).map(|(id, _)| id.clone()) { map.remove(&oldest); }
    }
    map.insert(id, now);
}
impl AgentExecState {
    pub fn begin(&self, request: &ExecRequest) -> Result<Lease, String> {
        request.validate()?;
        let mut registry = self.0.lock().map_err(|_| "命令状态不可用")?;
        let now = Instant::now();
        registry.early_cancel.retain(|_, at| now.duration_since(*at) < TOMBSTONE_TTL);
        registry.finished.retain(|_, at| now.duration_since(*at) < TOMBSTONE_TTL);
        if registry.active.contains_key(&request.request_id) || registry.finished.contains_key(&request.request_id) {
            return Err("命令 requestId 已使用".into());
        }
        if registry.active.len() >= 32 { return Err("同时执行的机器数量已达上限".into()); }
        if registry.active.values().any(|job| job.session_id == request.session_id) { return Err("该机器已有命令正在执行".into()); }
        let control = Arc::new(ExecControl::new(Duration::from_secs(request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT))));
        if registry.early_cancel.remove(&request.request_id).is_some() { control.cancel(); }
        registry.active.insert(request.request_id.clone(), Active { session_id: request.session_id.clone(), control: control.clone() });
        Ok(Lease { state: self.clone(), request_id: request.request_id.clone(), control })
    }
    pub fn cancel(&self, request_id: &str) -> bool {
        if request_id.is_empty() || request_id.len() > 128 || request_id.chars().any(char::is_control) { return false; }
        let Ok(mut registry) = self.0.lock() else { return false; };
        if let Some(job) = registry.active.get(request_id) { job.control.cancel(); return true; }
        if registry.finished.contains_key(request_id) { return false; }
        // IPC cancellation may reach Rust before the corresponding execution.
        bounded_insert(&mut registry.early_cancel, request_id.into(), 128);
        true
    }
    pub fn cancel_session(&self, session_id: &str) {
        if let Ok(registry) = self.0.lock() {
            for job in registry.active.values().filter(|job| job.session_id == session_id) { job.control.session_closed(); }
        }
    }
}

#[derive(Default)]
struct Output { stdout: String, stderr: String, used: usize, truncated: bool }
impl Output {
    fn push(&mut self, request: &ExecRequest, stream: &'static str, text: &str, sink: &OutputSink) {
        let mut take = (OUTPUT_LIMIT - self.used).min(text.len());
        while !text.is_char_boundary(take) { take -= 1; }
        if take < text.len() { self.truncated = true; }
        if take == 0 { return; }
        let data = &text[..take];
        self.used += take;
        if stream == "stderr" { self.stderr.push_str(data); } else { self.stdout.push_str(data); }
        sink(OutputEvent { request_id: request.request_id.clone(), session_id: request.session_id.clone(), stream, data: data.into() });
    }
}

pub async fn execute(target: Target, request: ExecRequest, control: Arc<ExecControl>, sink: OutputSink) -> Result<ExecResult, String> {
    if control.is_stopped() { return Ok(control.result(&request, Output::default(), None, None)); }
    match target {
        Target::Local { cwd } => execute_local(&request, cwd, control, sink).await,
        Target::Ssh(tx) => {
            let (reply, mut rx) = oneshot::channel();
            tx.send(crate::ssh_live::SftpReq::AgentExec { request: request.clone(), control: control.clone(), sink, reply })
                .map_err(|_| "SSH 会话已关闭，不能执行命令")?;
            tokio::select! {
                biased;
                result = &mut rx => result.map_err(|_| "SSH 会话已关闭，命令执行已终止".to_string())?,
                _ = control.stopped() => {
                    // Let the worker signal and close its own exec channel before
                    // allowing a second command on this machine.
                    match tokio::time::timeout(Duration::from_secs(1), rx).await {
                        Ok(Ok(result)) => result,
                        _ => Ok(control.result(&request, Output::default(), None, None)),
                    }
                },
                _ = control.deadline() => {
                    match tokio::time::timeout(Duration::from_secs(1), rx).await {
                        Ok(Ok(result)) => result,
                        _ => Ok(control.result(&request, Output::default(), None, None)),
                    }
                },
            }
        }
        Target::Unsupported => Err("该协议不支持 AI 运维命令，仅支持本地终端和 SSH".into()),
    }
}

fn quote_sh(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }
fn shell_script(request: &ExecRequest) -> String {
    let change_directory = request.cwd.as_ref().filter(|s| !s.is_empty()).map(|path| format!("cd -- {} || exit $?\n", quote_sh(path))).unwrap_or_default();
    // No PTY or stdin is supplied. sudo -n also makes a plain sudo invocation
    // fail immediately rather than prompting for a password or askpass UI.
    format!("export TERM=dumb PAGER=cat GIT_PAGER=cat SUDO_ASKPASS=\nsudo() {{ command sudo -n \"$@\"; }}\n{change_directory}{}", request.command)
}

struct ChildGuard { child: tokio::process::Child, pid: Option<u32> }
impl ChildGuard {
    async fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // setsid() makes this command the sole owner of its process group.
            // The interactive shell belongs to a different session entirely.
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            // /T includes children; /PID targets only this command's root PID.
            // This also covers non-PowerShell children started by the script.
            let mut killer = tokio::process::Command::new("taskkill.exe");
            killer.args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
            let _ = tokio::time::timeout(Duration::from_secs(1), killer.status()).await;
        }
        let _ = self.child.start_kill();
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } }
        // Tokio reaps a killed child without blocking the UI thread.
        let _ = self.child.start_kill();
    }
}

async fn execute_local(request: &ExecRequest, default_cwd: Option<PathBuf>, control: Arc<ExecControl>, sink: OutputSink) -> Result<ExecResult, String> {
    #[cfg(unix)]
    let mut command = {
        use std::os::unix::process::CommandExt;
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-lc", &shell_script(request)]);
        unsafe { command.as_std_mut().pre_exec(|| { if libc::setsid() == -1 { return Err(std::io::Error::last_os_error()); } Ok(()) }); }
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = tokio::process::Command::new("powershell.exe");
        let cwd = request.cwd.as_ref().filter(|s| !s.is_empty()).map(|path| format!("Set-Location -LiteralPath '{}' -ErrorAction Stop;\n", path.replace('\'', "''"))).unwrap_or_default();
        let script = format!("$ErrorActionPreference = 'Stop';\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n{cwd}{}\nif ($null -ne $LASTEXITCODE) {{ exit $LASTEXITCODE }}", request.command);
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script]);
        command.creation_flags(0x08000000 | 0x00000200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP.
        command
    };
    #[cfg(not(any(unix, windows)))]
    return Err("此平台暂不支持本地 AI 运维命令".into());
    if let Some(cwd) = default_cwd { command.current_dir(cwd); }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command.env("TERM", "dumb").env("PAGER", "cat").env("GIT_PAGER", "cat").env("SUDO_ASKPASS", "");
    if control.is_stopped() { return Ok(control.result(request, Output::default(), None, None)); }
    let mut child = command.spawn().map_err(|e| format!("无法启动命令：{e}"))?;
    let mut stdout = child.stdout.take().ok_or("无法读取命令 stdout")?;
    let mut stderr = child.stderr.take().ok_or("无法读取命令 stderr")?;
    let mut guard = ChildGuard { pid: child.id(), child };
    let mut output = Output::default();
    let (mut out_decoder, mut err_decoder) = (crate::terminal_io::Utf8Decoder::default(), crate::terminal_io::Utf8Decoder::default());
    let (mut out_done, mut err_done) = (false, false);
    let (mut out_buf, mut err_buf) = ([0u8; 8192], [0u8; 8192]);
    let mut status = None;
    let mut stopped = false;
    let mut draining = false;
    let mut drain_deadline = tokio::time::Instant::from_std(control.deadline + Duration::from_secs(1));
    loop {
        if status.is_some() && out_done && err_done { break; }
        tokio::select! {
            biased;
            _ = control.stopped(), if !stopped => {
                stopped = true; guard.terminate().await;
                draining = true; drain_deadline = tokio::time::Instant::now() + Duration::from_secs(1);
            },
            _ = control.deadline(), if !stopped => {
                stopped = true; guard.terminate().await;
                draining = true; drain_deadline = tokio::time::Instant::now() + Duration::from_secs(1);
            },
            _ = tokio::time::sleep_until(drain_deadline), if draining => {
                // A command can deliberately detach with setsid() while still
                // inheriting a pipe. Never wait indefinitely for that pipe;
                // closing it is distinct from killing an unrelated daemon.
                output.truncated = true;
                break;
            },
            result = stdout.read(&mut out_buf), if !out_done => match result {
                Ok(0) | Err(_) => out_done = true,
                Ok(n) => output.push(request, "stdout", &out_decoder.push(&out_buf[..n]), &sink),
            },
            result = stderr.read(&mut err_buf), if !err_done => match result {
                Ok(0) | Err(_) => err_done = true,
                Ok(n) => output.push(request, "stderr", &err_decoder.push(&err_buf[..n]), &sink),
            },
            result = guard.child.wait(), if status.is_none() => {
                status = Some(result.map_err(|e| format!("无法获取命令退出状态：{e}"))?);
                // End descendants that still own stdout/stderr after the shell
                // exits. Managed services started through systemd are separate.
                guard.terminate().await;
                if !draining { draining = true; drain_deadline = tokio::time::Instant::now() + Duration::from_secs(1); }
            },
        }
    }
    output.push(request, "stdout", &out_decoder.finish(), &sink);
    output.push(request, "stderr", &err_decoder.finish(), &sink);
    let exit_code = status.as_ref().and_then(|status| status.code());
    #[cfg(unix)]
    let signal = { use std::os::unix::process::ExitStatusExt; status.as_ref().and_then(|status| status.signal()).map(|n| n.to_string()) };
    #[cfg(not(unix))]
    let signal = None;
    if status.is_some() { guard.pid = None; } // Never signal a stale, reaped group.
    Ok(control.result(request, output, exit_code, signal))
}

pub async fn execute_ssh(handle: &Arc<russh::client::Handle<crate::ssh_live::WtHandler>>, request: &ExecRequest, control: Arc<ExecControl>, sink: OutputSink) -> Result<ExecResult, String> {
    use russh::ChannelMsg;
    if control.is_stopped() || Instant::now() >= control.deadline {
        if !control.is_stopped() { control.stop(2); }
        return Ok(control.result(request, Output::default(), None, None));
    }
    let mut channel = tokio::select! {
        biased;
        _ = control.stopped() => return Ok(control.result(request, Output::default(), None, None)),
        _ = control.deadline() => return Ok(control.result(request, Output::default(), None, None)),
        channel = handle.channel_open_session() => channel.map_err(|e| format!("无法打开 SSH 命令通道：{e}"))?,
    };
    // The remote login shell may itself be fish/csh. An explicit POSIX shell
    // keeps quoting and cwd semantics stable without requiring a remote PTY.
    let script = format!("sh -lc {}", quote_sh(&shell_script(request)));
    let setup = async { channel.exec(true, script).await?; channel.eof().await };
    let setup_result = tokio::select! {
        biased;
        _ = control.stopped() => None,
        _ = control.deadline() => None,
        result = setup => Some(result),
    };
    if setup_result.is_none() {
        let _ = tokio::time::timeout(Duration::from_millis(250), async { let _ = channel.signal(russh::Sig::KILL).await; channel.close().await }).await;
        return Ok(control.result(request, Output::default(), None, None));
    }
    if let Err(error) = setup_result.unwrap() {
        let _ = tokio::time::timeout(Duration::from_millis(250), channel.close()).await;
        return Err(format!("SSH 命令通道启动失败：{error}"));
    }
    let mut output = Output::default();
    let (mut out_decoder, mut err_decoder) = (crate::terminal_io::Utf8Decoder::default(), crate::terminal_io::Utf8Decoder::default());
    let (mut exit_code, mut signal) = (None, None);
    loop {
        tokio::select! {
            biased;
            _ = control.stopped() => break,
            _ = control.deadline() => break,
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) => output.push(request, "stdout", &out_decoder.push(&data), &sink),
                Some(ChannelMsg::ExtendedData { data, .. }) => output.push(request, "stderr", &err_decoder.push(&data), &sink),
                Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status as i32),
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => signal = Some(format!("{signal_name:?}")),
                Some(ChannelMsg::Failure) => { output.push(request, "stderr", "SSH 服务器拒绝执行命令", &sink); break; },
                // EOF only closes output; SSH commonly sends exit-status AFTER
                // EOF, so wait for Close instead of losing the exit code.
                Some(ChannelMsg::Close) | None => break,
                _ => {},
            },
        }
    }
    output.push(request, "stdout", &out_decoder.finish(), &sink);
    output.push(request, "stderr", &err_decoder.finish(), &sink);
    let _ = tokio::time::timeout(Duration::from_millis(250), async {
        if control.is_stopped() { let _ = channel.signal(russh::Sig::KILL).await; }
        channel.close().await
    }).await;
    Ok(control.result(request, output, exit_code, signal))
}

#[cfg(test)]
#[path = "agent_exec_tests.rs"]
mod tests;
