use super::*;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

fn request(command: &str) -> ExecRequest {
    ExecRequest { request_id: uuid::Uuid::new_v4().to_string(), session_id: "agent-local-fixture".into(), command: command.into(), cwd: None, timeout_seconds: Some(5) }
}
fn no_output() -> OutputSink { Arc::new(|_| {}) }
async fn local(request: ExecRequest) -> ExecResult {
    let control = Arc::new(ExecControl::new(Duration::from_secs(request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT))));
    execute(Target::Local { cwd: None }, request, control, no_output()).await.unwrap()
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("hurricane-agent-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

#[test]
fn validates_identifiers_command_and_timeout_without_restricting_operations() {
    let mut req = request("printf valid");
    req.validate().unwrap();
    for seconds in [0, 301, u64::MAX] { req.timeout_seconds = Some(seconds); assert!(req.validate().is_err()); }
    req.timeout_seconds = None; req.validate().unwrap();
    req.command = "x".repeat(16_385); assert!(req.validate().is_err());
    req.command = "\0".into(); assert!(req.validate().is_err());
    req.command = "  ".into(); assert!(req.validate().is_err());
    req.command = "systemctl restart example.service".into(); req.validate().unwrap();
    req.cwd = Some("\0bad".into()); assert!(req.validate().is_err());
    req.cwd = None; req.request_id = "".into(); assert!(req.validate().is_err());
}

#[test]
fn ipc_request_rejects_unknown_fields() {
    let value = serde_json::json!({"requestId":"r", "sessionId":"s", "command":"true", "unexpected":true});
    assert!(serde_json::from_value::<ExecRequest>(value).is_err());
}

#[test]
fn registry_serializes_each_machine_and_releases_on_drop() {
    let state = AgentExecState::default();
    let req = request("true"); let lease = state.begin(&req).unwrap();
    assert!(state.begin(&req).is_err());
    let mut next = request("true"); assert!(state.begin(&next).is_err());
    next.session_id = "another-machine".into(); let other = state.begin(&next).unwrap();
    state.cancel_session(&req.session_id); assert!(lease.control.is_stopped()); assert!(!other.control.is_stopped());
    drop(lease); let new_req = request("true"); assert!(state.begin(&new_req).is_ok());
    assert!(!state.cancel(&req.request_id));
}

#[test]
fn early_cancel_is_bounded_and_consumed_before_spawn() {
    let state = AgentExecState::default(); let req = request("true");
    assert!(state.cancel(&req.request_id)); let lease = state.begin(&req).unwrap(); assert!(lease.control.is_stopped());
    for index in 0..1000 { state.cancel(&format!("unknown-{index}")); }
    assert!(state.0.lock().unwrap().early_cancel.len() <= 128);
}

#[tokio::test]
async fn early_cancel_cannot_launch_a_process() {
    let scratch = Scratch::new();
    let req = request(&format!("printf should-not-exist > {}", quote_sh(&scratch.0.join("started").to_string_lossy())));
    let state = AgentExecState::default(); state.cancel(&req.request_id);
    let lease = state.begin(&req).unwrap();
    let result = execute(Target::Local { cwd: None }, req, lease.control.clone(), no_output()).await.unwrap();
    assert!(result.cancelled); assert!(!scratch.0.join("started").exists());
}

#[tokio::test]
async fn unsupported_protocol_never_falls_back_to_local() {
    let req = request("printf must-not-run");
    let control = Arc::new(ExecControl::new(Duration::from_secs(5)));
    assert!(execute(Target::Unsupported, req, control, no_output()).await.unwrap_err().contains("协议"));
}

#[cfg(unix)]
#[tokio::test]
async fn local_command_has_separate_stdout_stderr_and_exit_status() {
    let result = local(request("printf '你好🙂'; printf 'error details' >&2; exit 7")).await;
    assert_eq!(result.stdout, "你好🙂"); assert_eq!(result.stderr, "error details");
    assert_eq!(result.exit_code, Some(7)); assert!(!result.cancelled && !result.timed_out && !result.truncated);
}

#[cfg(windows)]
#[tokio::test]
async fn local_powershell_has_separate_stdout_stderr_and_exit_status() {
    let mut req = request("[Console]::Out.Write('hello'); [Console]::Error.Write('error details'); exit 7");
    // This checks output and exit status, not cold PowerShell startup speed.
    // Use the production default instead of the fixtures' short 5s deadline;
    // explicit timeout and cancellation tests keep their independent budgets.
    req.timeout_seconds = None;
    let result = local(req).await;
    assert!(!result.timed_out && !result.cancelled && !result.truncated,
        "PowerShell must finish normally before checking its output: {result:?}");
    assert_eq!(result.stdout, "hello"); assert_eq!(result.stderr, "error details"); assert_eq!(result.exit_code, Some(7));
}

#[cfg(unix)]
#[tokio::test]
async fn local_cwd_quotes_spaces_and_apostrophes_without_shell_injection() {
    let scratch = Scratch::new(); let path = scratch.0.join("quote' and space;$(touch injected)");
    std::fs::create_dir(&path).unwrap();
    let mut req = request("pwd; printf saved > result.txt"); req.cwd = Some(path.to_string_lossy().into());
    let result = local(req).await;
    assert_eq!(result.exit_code, Some(0)); assert_eq!(result.stdout.trim(), path.to_string_lossy());
    assert_eq!(std::fs::read_to_string(path.join("result.txt")).unwrap(), "saved");
    assert!(!scratch.0.join("injected").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn local_stdin_is_eof_and_missing_cwd_fails() {
    let result = local(request("if read answer; then printf unexpected; else printf eof; fi")).await;
    assert_eq!(result.stdout, "eof");
    let mut req = request("printf should-not-run"); req.cwd = Some("/hurricane-agent-no-such-directory".into());
    let result = local(req).await; assert_ne!(result.exit_code, Some(0)); assert_eq!(result.stdout, "");
}

#[cfg(unix)]
#[tokio::test]
async fn local_sudo_is_forced_non_interactive() {
    // Verify the wrapper even on a host without sudo, without requesting any
    // privileges or touching the real sudo binary.
    let scratch = Scratch::new(); let fake_sudo = scratch.0.join("sudo");
    std::fs::write(&fake_sudo, "#!/bin/sh\nprintf '%s' \"$1\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake_sudo, std::fs::Permissions::from_mode(0o700)).unwrap();
    let result = local(request(&format!("PATH={}:$PATH; sudo example", quote_sh(&scratch.0.to_string_lossy())))).await;
    assert_eq!(result.stdout, "-n");
}

#[cfg(unix)]
#[tokio::test]
async fn local_output_is_bounded_but_drained_and_events_equal_result() {
    let req = request("head -c 400000 /dev/zero | tr '\\000' 'x'; printf '\\344\\270\\255\\360\\237\\231\\202' >&2");
    let events = Arc::new(Mutex::new(Vec::<OutputEvent>::new())); let collect = events.clone();
    let result = execute(Target::Local { cwd: None }, req, Arc::new(ExecControl::new(Duration::from_secs(5))), Arc::new(move |event| collect.lock().unwrap().push(event))).await.unwrap();
    assert_eq!(result.exit_code, Some(0)); assert!(result.truncated);
    assert!(result.stdout.len() + result.stderr.len() <= OUTPUT_LIMIT);
    let all = events.lock().unwrap();
    assert_eq!(all.iter().filter(|e| e.stream == "stdout").map(|e| e.data.as_str()).collect::<String>(), result.stdout);
    assert_eq!(all.iter().filter(|e| e.stream == "stderr").map(|e| e.data.as_str()).collect::<String>(), result.stderr);
}

#[test]
fn output_budget_never_splits_unicode() {
    let req = request("true"); let mut output = Output::default();
    output.push(&req, "stdout", &"🙂".repeat(OUTPUT_LIMIT / 4 + 1), &no_output());
    assert_eq!(output.stdout.len(), OUTPUT_LIMIT); assert!(output.truncated); assert!(!output.stdout.contains('\u{fffd}'));
}

#[cfg(unix)]
#[tokio::test]
async fn local_timeout_kills_the_command_group_and_reaps() {
    let mut req = request("printf started; sleep 30 & wait"); req.timeout_seconds = Some(1);
    let before = Instant::now(); let result = local(req).await;
    assert!(result.timed_out && !result.cancelled); assert!(before.elapsed() < Duration::from_secs(4));
    assert_eq!(result.stdout, "started"); assert!(result.signal.is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn cancel_and_session_close_do_not_kill_unrelated_commands() {
    for close_session in [false, true] {
        let req = request("printf started; sleep 30 & wait");
        let state = AgentExecState::default(); let lease = state.begin(&req).unwrap();
        let first = Arc::new(Notify::new()); let first_out = first.clone();
        let command = execute(Target::Local { cwd: None }, req.clone(), lease.control.clone(), Arc::new(move |_| first_out.notify_one()));
        let cancellation = async {
            first.notified().await;
            if close_session { state.cancel_session(&req.session_id); } else { state.cancel(&req.request_id); }
        };
        let (result, _) = tokio::time::timeout(Duration::from_secs(4), async { tokio::join!(command, cancellation) }).await.unwrap();
        let result = result.unwrap(); assert!(result.cancelled && !result.timed_out); assert_eq!(result.stdout, "started");
        assert_eq!(local(request("printf unaffected")).await.stdout, "unaffected");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn shell_exit_does_not_leave_background_pipe_hanging() {
    let before = Instant::now(); let result = local(request("sleep 30 & printf done; exit 0")).await;
    assert_eq!(result.stdout, "done"); assert_eq!(result.exit_code, Some(0)); assert!(!result.timed_out);
    assert!(before.elapsed() < Duration::from_secs(3));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn detached_descendant_cannot_hold_the_agent_output_open_forever() {
    // Linux setsid is intentionally used only in this fixture. The detached
    // process exits by itself after three seconds; no persistent task is left.
    // Its inherited pipes outlive the shell, even though its new process group
    // correctly survives killing the agent command's original group.
    let scratch = Scratch::new(); let ready = quote_sh(&scratch.0.join("detached-ready").to_string_lossy());
    let detached = quote_sh(&format!("printf ready > {ready}; sleep 3; printf late"));
    let command = format!("setsid sh -c {detached} & while [ ! -f {ready} ]; do sleep 0.01; done; printf done; exit 0");
    let before = Instant::now();
    let result = local(request(&command)).await;
    assert_eq!(result.stdout, "done"); assert_eq!(result.exit_code, Some(0));
    assert!(result.truncated); assert!(!result.timed_out && !result.cancelled);
    assert!(before.elapsed() < Duration::from_secs(2));
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_the_agent_prevents_descendant_side_effects() {
    let scratch = Scratch::new(); let marker = scratch.0.join("descendant-ran");
    let req = request(&format!("(sleep 1; printf leaked > {}) & printf ready; wait", quote_sh(&marker.to_string_lossy())));
    let control = Arc::new(ExecControl::new(Duration::from_secs(5))); let cancel = control.clone();
    let result = execute(Target::Local { cwd: None }, req, control, Arc::new(move |_| cancel.cancel())).await.unwrap();
    assert!(result.cancelled); assert_eq!(result.stdout, "ready");
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!marker.exists(), "the independently spawned descendant was killed with the command group");
}

#[test]
fn streamed_unicode_fragments_reconstruct_exactly_like_the_final_response() {
    let text = "中文🙂stderr界限"; let req = request("true");
    for boundary in 0..=text.len() {
        let events = Arc::new(Mutex::new(String::new())); let collect = events.clone();
        let sink: OutputSink = Arc::new(move |event| collect.lock().unwrap().push_str(&event.data));
        let mut output = Output::default(); let mut decoder = crate::terminal_io::Utf8Decoder::default();
        for fragment in [&text.as_bytes()[..boundary], &text.as_bytes()[boundary..]] {
            output.push(&req, "stdout", &decoder.push(fragment), &sink);
        }
        output.push(&req, "stdout", &decoder.finish(), &sink);
        assert_eq!(output.stdout, text); assert_eq!(*events.lock().unwrap(), output.stdout);
    }
}

#[cfg(unix)]
mod ssh_fixture {
    use super::*;
    use crate::ssh_live::{self, SftpReq, Sink};
    use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session};
    use russh::{Channel, ChannelId, Pty};
    type Controls = Arc<Mutex<HashMap<ChannelId, Arc<ExecControl>>>>;
    struct Server { controls: Controls, inputs: Arc<Mutex<Vec<u8>>>, started: Arc<Notify>, execs: Arc<AtomicUsize> }
    struct Client { controls: Controls, inputs: Arc<Mutex<Vec<u8>>>, started: Arc<Notify>, execs: Arc<AtomicUsize> }
    impl russh::server::Server for Server {
        type Handler = Client;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Client {
            Client { controls: self.controls.clone(), inputs: self.inputs.clone(), started: self.started.clone(), execs: self.execs.clone() }
        }
    }
    impl russh::server::Handler for Client {
        type Error = russh::Error;
        async fn auth_none(&mut self, _: &str) -> Result<Auth, Self::Error> { Ok(Auth::Accept) }
        async fn channel_open_session(&mut self, _: Channel<Msg>, reply: ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> { reply.accept().await; Ok(()) }
        async fn pty_request(&mut self, id: ChannelId, _: &str, _: u32, _: u32, _: u32, _: u32, _: &[(Pty, u32)], session: &mut Session) -> Result<(), Self::Error> { session.channel_success(id)?; Ok(()) }
        async fn shell_request(&mut self, id: ChannelId, session: &mut Session) -> Result<(), Self::Error> { session.channel_success(id)?; self.started.notify_one(); Ok(()) }
        async fn data(&mut self, id: ChannelId, bytes: &[u8], session: &mut Session) -> Result<(), Self::Error> {
            self.inputs.lock().unwrap().extend_from_slice(bytes); session.data(id, bytes.to_vec())?; Ok(())
        }
        async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
            if let Some(control) = self.controls.lock().unwrap().get(&id) { control.cancel(); } Ok(())
        }
        async fn signal(&mut self, id: ChannelId, _: russh::Sig, _: &mut Session) -> Result<(), Self::Error> {
            if let Some(control) = self.controls.lock().unwrap().get(&id) { control.cancel(); } Ok(())
        }
        async fn exec_request(&mut self, id: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
            self.execs.fetch_add(1, AtomicOrdering::SeqCst);
            session.channel_success(id)?;
            let command = String::from_utf8(data.to_vec()).unwrap();
            let control = Arc::new(ExecControl::new(Duration::from_secs(10))); self.controls.lock().unwrap().insert(id, control.clone());
            let handle = session.handle(); let controls = self.controls.clone();
            tokio::spawn(async move {
                let req = request(&command); let (tx, mut rx) = mpsc::unbounded_channel::<OutputEvent>();
                let sink: OutputSink = Arc::new(move |event| { let _ = tx.send(event); });
                let operation = execute_local(&req, None, control, sink); tokio::pin!(operation);
                let result = loop {
                    tokio::select! {
                        biased;
                        Some(event) = rx.recv() => {
                            if event.stream == "stderr" { let _ = handle.extended_data(id, 1, event.data.into_bytes()).await; }
                            else { let _ = handle.data(id, event.data.into_bytes()).await; }
                        }
                        result = &mut operation => break result,
                    }
                };
                while let Ok(event) = rx.try_recv() {
                    if event.stream == "stderr" { let _ = handle.extended_data(id, 1, event.data.into_bytes()).await; }
                    else { let _ = handle.data(id, event.data.into_bytes()).await; }
                }
                if let Ok(result) = result {
                    // The local fixture also has a capture cap. Add a protocol
                    // packet past that cap to exercise the SSH client's own
                    // independent truncation and continued draining.
                    if result.truncated { let _ = handle.data(id, b"fixture-output-past-capture-limit".to_vec()).await; }
                    let _ = handle.exit_status_request(id, result.exit_code.unwrap_or(137) as u32).await;
                }
                let _ = handle.eof(id).await; let _ = handle.close(id).await;
                controls.lock().unwrap().remove(&id);
            });
            Ok(())
        }
    }
    struct Fixture {
        scratch: Scratch, input: mpsc::UnboundedSender<Vec<u8>>, stop: mpsc::UnboundedSender<()>, tx: mpsc::UnboundedSender<SftpReq>,
        task: tokio::task::JoinHandle<()>, server: tokio::task::JoinHandle<()>, controls: Controls, inputs: Arc<Mutex<Vec<u8>>>, execs: Arc<AtomicUsize>, output: Arc<Mutex<String>>,
    }
    impl Fixture {
        async fn new() -> Self {
            let scratch = Scratch::new(); let key_path = scratch.0.join("fixture-only-key");
            assert!(std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&key_path).status().unwrap().success());
            let config = Arc::new(russh::server::Config { keys: vec![russh::keys::load_secret_key(key_path, None).unwrap()], auth_rejection_time: Duration::ZERO, ..Default::default() });
            let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = socket.local_addr().unwrap().port();
            let controls = Controls::default(); let inputs = Arc::new(Mutex::new(Vec::new())); let started = Arc::new(Notify::new()); let execs = Arc::new(AtomicUsize::new(0));
            let mut fixture_server = Server { controls: controls.clone(), inputs: inputs.clone(), started: started.clone(), execs: execs.clone() };
            let server = tokio::spawn(async move { let _ = fixture_server.run_on_socket(config, &socket).await; });
            let (input, input_rx) = mpsc::unbounded_channel(); let (resize, resize_rx) = mpsc::unbounded_channel(); let (stop, stop_rx) = mpsc::unbounded_channel(); let (tx, requests) = mpsc::unbounded_channel();
            let config_dir = scratch.0.clone(); let output = Arc::new(Mutex::new(String::new())); let collect = output.clone();
            let task = tokio::spawn(async move { let _resize = resize;
                let _ = ssh_live::run(Sink(Arc::new(move |topic, _, data| { if topic == "pty-output" { collect.lock().unwrap().push_str(&data); } })), "agent-ssh-fixture".into(), "127.0.0.1".into(), port, "fixture".into(), None, None, 24, 80, config_dir, input_rx, resize_rx, stop_rx, requests, crate::ssh_relay::Proxy::None).await;
            });
            tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
            Self { scratch, input, stop, tx, task, server, controls, inputs, execs, output }
        }
        async fn run(&self, command: &str) -> ExecResult {
            let req = request(command); execute(Target::Ssh(self.tx.clone()), req, Arc::new(ExecControl::new(Duration::from_secs(5))), no_output()).await.unwrap()
        }
        async fn wait_for_shell_echo(&self, expected: &str) {
            tokio::time::timeout(Duration::from_secs(2), async { while !self.output.lock().unwrap().contains(expected) { tokio::time::sleep(Duration::from_millis(10)).await; } }).await.unwrap();
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = self.stop.send(()); self.task.abort(); self.server.abort(); for control in self.controls.lock().unwrap().values() { control.cancel(); } } }

    #[tokio::test]
    async fn ssh_exec_reuses_authenticated_session_and_preserves_interactive_shell() {
        let fixture = Fixture::new().await;
        let result = fixture.run("printf 'remote 中文'; printf problem >&2; exit 9").await;
        assert_eq!(result.stdout, "remote 中文"); assert_eq!(result.stderr, "problem"); assert_eq!(result.exit_code, Some(9));
        assert!(fixture.inputs.lock().unwrap().is_empty());
        fixture.input.send(b"interactive-still-alive".to_vec()).unwrap(); fixture.wait_for_shell_echo("interactive-still-alive").await;
        assert_eq!(fixture.run("printf next").await.stdout, "next"); assert_eq!(fixture.execs.load(AtomicOrdering::SeqCst), 2);
    }

    #[tokio::test]
    async fn ssh_exec_workdir_and_large_output_are_bounded() {
        let fixture = Fixture::new().await; let mut req = request("pwd; head -c 400000 /dev/zero | tr '\\000' x"); req.cwd = Some(fixture.scratch.0.to_string_lossy().into());
        let result = execute(Target::Ssh(fixture.tx.clone()), req, Arc::new(ExecControl::new(Duration::from_secs(5))), no_output()).await.unwrap();
        assert!(result.stdout.starts_with(&fixture.scratch.0.to_string_lossy().to_string())); assert_eq!(result.exit_code, Some(0)); assert!(result.truncated); assert_eq!(result.stdout.len() + result.stderr.len(), OUTPUT_LIMIT);
    }

    #[tokio::test]
    async fn ssh_timeout_closes_only_exec_channel() {
        let fixture = Fixture::new().await; let req = request("printf started; sleep 30");
        let result = execute(Target::Ssh(fixture.tx.clone()), req, Arc::new(ExecControl::new(Duration::from_secs(1))), no_output()).await.unwrap();
        assert!(result.timed_out); assert_eq!(result.stdout, "started");
        fixture.input.send(b"after-timeout".to_vec()).unwrap(); fixture.wait_for_shell_echo("after-timeout").await;
        assert_eq!(fixture.run("printf next").await.stdout, "next");
    }

    #[tokio::test]
    async fn ssh_cancel_closes_only_exec_channel_and_no_late_execution_after_precancel() {
        let fixture = Fixture::new().await; let control = Arc::new(ExecControl::new(Duration::from_secs(5)));
        let ready = Arc::new(Notify::new()); let ready_sink = ready.clone();
        let command = execute(Target::Ssh(fixture.tx.clone()), request("printf started; sleep 30"), control.clone(), Arc::new(move |_| ready_sink.notify_one()));
        let cancel = async { ready.notified().await; control.cancel(); };
        let (result, _) = tokio::time::timeout(Duration::from_secs(4), async { tokio::join!(command, cancel) }).await.unwrap(); assert!(result.unwrap().cancelled);
        fixture.input.send(b"after-cancel".to_vec()).unwrap(); fixture.wait_for_shell_echo("after-cancel").await;
        let before = fixture.execs.load(AtomicOrdering::SeqCst); let control = Arc::new(ExecControl::new(Duration::from_secs(5))); control.cancel();
        let result = execute(Target::Ssh(fixture.tx.clone()), request("printf must-not-start"), control, no_output()).await.unwrap();
        assert!(result.cancelled); assert_eq!(fixture.execs.load(AtomicOrdering::SeqCst), before);
    }

    #[tokio::test]
    async fn closing_ssh_session_finishes_pending_agent_request() {
        let fixture = Fixture::new().await; let ready = Arc::new(Notify::new()); let ready_sink = ready.clone();
        let operation = execute(Target::Ssh(fixture.tx.clone()), request("printf started; sleep 30"), Arc::new(ExecControl::new(Duration::from_secs(5))), Arc::new(move |_| ready_sink.notify_one()));
        let close = async { ready.notified().await; fixture.stop.send(()).unwrap(); };
        let (result, _) = tokio::time::timeout(Duration::from_secs(4), async { tokio::join!(operation, close) }).await.unwrap();
        assert!(result.unwrap_err().contains("SSH 会话已关闭"));
    }
}
