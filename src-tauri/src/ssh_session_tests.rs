//! Real loopback TCP / SSH regression tests for close during stalled operations.
//! The fixture creates its own host key and never reads a user identity.
use super::*;
use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Copy)]
enum Stage { Auth, Pty, Sftp, RejectAuth, RejectPty, RejectShell }
#[derive(Clone, Copy)]
enum ProxyKind { Socks, Http }
type Entered = Arc<Mutex<Option<oneshot::Sender<()>>>>;

struct TestServer { stage: Stage, entered: Entered }
struct TestClient { stage: Stage, entered: Entered }
impl TestClient {
    fn notify_entered(&self) {
        if let Some(tx) = self.entered.lock().unwrap().take() { let _ = tx.send(()); }
    }
}
impl russh::server::Server for TestServer {
    type Handler = TestClient;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self::Handler {
        TestClient { stage: self.stage, entered: self.entered.clone() }
    }
}
impl russh::server::Handler for TestClient {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<Auth, Self::Error> {
        if matches!(self.stage, Stage::Auth) {
            self.notify_entered();
            return std::future::pending().await;
        }
        if matches!(self.stage, Stage::RejectAuth) { return Ok(Auth::Reject { proceed_with_methods: None, partial_success: false }); }
        Ok(Auth::Accept)
    }
    async fn channel_open_session(&mut self, _: Channel<Msg>, reply: ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(&mut self, channel: ChannelId, _: &str, _: u32, _: u32, _: u32, _: u32, _: &[(Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
        if matches!(self.stage, Stage::Pty) {
            self.notify_entered();
            return std::future::pending().await;
        }
        if matches!(self.stage, Stage::RejectPty) { session.channel_failure(channel)?; return Ok(()); }
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        if matches!(self.stage, Stage::RejectShell) { session.channel_failure(channel)?; return Ok(()); }
        session.channel_success(channel)?;
        Ok(())
    }
    async fn subsystem_request(&mut self, _: ChannelId, name: &str, _: &mut Session) -> Result<(), Self::Error> {
        if name == "sftp" {
            self.notify_entered();
            return std::future::pending().await;
        }
        Ok(())
    }
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hurricane-ssh-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

async fn session_task(port: u16, root: PathBuf, proxy: ssh_relay::Proxy) -> (
    mpsc::UnboundedSender<()>, mpsc::UnboundedSender<SftpReq>,
    tokio::task::JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>,
) {
    let (input, input_rx) = mpsc::unbounded_channel();
    let (resize, resize_rx) = mpsc::unbounded_channel();
    let (stop, stop_rx) = mpsc::unbounded_channel();
    let (sftp, sftp_rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        // Keep the input senders alive so only the explicit stop closes it.
        let _keep_input = input;
        let _keep_resize = resize;
        run(Sink(Arc::new(|_, _, _| {})), "close-fixture".into(),
            "127.0.0.1".into(), port, "close-fixture-user".into(), None, None,
            24, 80, root, input_rx, resize_rx, stop_rx, sftp_rx, proxy).await
    });
    (stop, sftp, task)
}

#[tokio::test]
async fn close_during_ssh_banner_stall() {
    let scratch = Scratch::new();
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let (stop, _sftp, task) = session_task(port, scratch.0.clone(), ssh_relay::Proxy::None).await;
    let (_stream, _) = tokio::time::timeout(Duration::from_secs(3), socket.accept()).await.unwrap().unwrap();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), task).await.expect("close cancels unfinished SSH handshake").unwrap().unwrap();
}

async fn closes_at(stage: Stage, proxy_kind: Option<ProxyKind>) {
    let scratch = Scratch::new();
    let key = scratch.0.join("fixture-host-key");
    assert!(std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&key).status().unwrap().success());
    let config = russh::server::Config {
        keys: vec![load_secret_key(key, None).unwrap()],
        auth_rejection_time: Duration::ZERO,
        ..Default::default()
    };
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let (entered_tx, entered_rx) = oneshot::channel();
    let entered = Arc::new(Mutex::new(Some(entered_tx)));
    let server = tokio::spawn(async move { TestServer { stage, entered }.run_on_socket(Arc::new(config), &socket).await });
    let (proxy, proxy_task) = if let Some(kind) = proxy_kind {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = socket.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut tunnel, _) = socket.accept().await.unwrap();
            match kind {
                ProxyKind::Socks => {
                    let mut greeting = [0; 2]; tunnel.read_exact(&mut greeting).await.unwrap();
                    assert_eq!(greeting[0], 5);
                    let mut methods = vec![0; greeting[1] as usize]; tunnel.read_exact(&mut methods).await.unwrap();
                    tunnel.write_all(&[5, 0]).await.unwrap();
                    let mut request = [0; 4]; tunnel.read_exact(&mut request).await.unwrap();
                    assert_eq!(&request[..3], &[5, 1, 0]);
                    let size = match request[3] {
                        1 => 4, 4 => 16,
                        3 => { let mut len = [0]; tunnel.read_exact(&mut len).await.unwrap(); len[0] as usize },
                        other => panic!("unexpected SOCKS address type {other}"),
                    };
                    let mut address = vec![0; size]; tunnel.read_exact(&mut address).await.unwrap();
                    let mut target_port = [0; 2]; tunnel.read_exact(&mut target_port).await.unwrap();
                    assert_eq!(u16::from_be_bytes(target_port), port);
                    tunnel.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await.unwrap();
                }
                ProxyKind::Http => {
                    let mut header = Vec::new();
                    while !header.ends_with(b"\r\n\r\n") {
                        let mut byte = [0]; tunnel.read_exact(&mut byte).await.unwrap(); header.push(byte[0]);
                        assert!(header.len() <= 4096);
                    }
                    assert!(String::from_utf8(header).unwrap().starts_with(&format!("CONNECT 127.0.0.1:{port} ")));
                    tunnel.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                }
            }
            let mut upstream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut tunnel, &mut upstream).await;
        });
        let proxy = match kind {
            ProxyKind::Socks => ssh_relay::Proxy::Socks5(ssh_relay::Socks5Proxy {
                addr: "127.0.0.1".into(), port: proxy_port, user: None, password: None, proxy_dns: true,
            }),
            ProxyKind::Http => ssh_relay::Proxy::Http(ssh_relay::HttpProxy {
                addr: "127.0.0.1".into(), port: proxy_port, user: None, password: None, proxy_dns: true,
            }),
        };
        (proxy, Some(task))
    } else { (ssh_relay::Proxy::None, None) };
    let (stop, sftp, task) = session_task(port, scratch.0.clone(), proxy).await;
    let reply = if matches!(stage, Stage::Sftp) {
        let (tx, rx) = oneshot::channel();
        sftp.send(SftpReq::Realpath { path: ".".into(), reply: tx }).unwrap();
        Some(rx)
    } else { None };
    tokio::time::timeout(Duration::from_secs(5), entered_rx).await.expect("fixture enters blocking protocol stage").unwrap();
    stop.send(()).unwrap();
    let finished = tokio::time::timeout(Duration::from_secs(1), task).await;
    server.abort();
    if let Some(proxy_task) = proxy_task { proxy_task.abort(); }
    finished.expect("close cancels stalled SSH stage").unwrap().unwrap();
    if let Some(reply) = reply {
        assert!(tokio::time::timeout(Duration::from_secs(1), reply).await.expect("SFTP worker is cancelled with the session").is_err());
    }
}

#[tokio::test]
async fn close_during_ssh_authentication_stall() { closes_at(Stage::Auth, None).await; }
#[tokio::test]
async fn close_during_ssh_pty_request_stall() { closes_at(Stage::Pty, None).await; }
#[tokio::test]
async fn close_cancels_spawned_sftp_workers() { closes_at(Stage::Sftp, None).await; }

#[tokio::test]
async fn ssh_through_socks_tcp_fastpath_reaches_auth_and_closes() { closes_at(Stage::Auth, Some(ProxyKind::Socks)).await; }
#[tokio::test]
async fn ssh_through_http_tcp_fastpath_reaches_auth_and_closes() { closes_at(Stage::Auth, Some(ProxyKind::Http)).await; }

async fn capture_failure(host: String, port: u16, root: PathBuf, proxy: ssh_relay::Proxy, password: Option<String>, key: Option<String>) -> (String, Vec<crate::connection_error::ConnectionError>) {
    let (input, input_rx) = mpsc::unbounded_channel(); let (resize, resize_rx) = mpsc::unbounded_channel();
    let (stop, stop_rx) = mpsc::unbounded_channel(); let (requests, request_rx) = mpsc::unbounded_channel();
    let events = Arc::new(Mutex::new(Vec::new())); let collect = events.clone();
    let sink = Sink(Arc::new(move |topic, _, data| { if topic == "connection-error" { collect.lock().unwrap().push(serde_json::from_str(&data).unwrap()); } }));
    let result = tokio::time::timeout(Duration::from_secs(5), run(sink, "failure-fixture".into(), host, port, "fixture-user".into(), password, key, 24, 80, root, input_rx, resize_rx, stop_rx, request_rx, proxy)).await.expect("failure must be delivered promptly");
    drop((input, resize, stop, requests));
    let error = result.expect_err("fixture must reject connection").to_string();
    let events = events.lock().unwrap().clone();
    (error, events)
}

async fn failure_server(stage: Stage, scratch: &Scratch) -> (u16, tokio::task::JoinHandle<()>) {
    let key = scratch.0.join("fixture-host-key");
    assert!(std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&key).status().unwrap().success());
    let config = russh::server::Config { keys: vec![load_secret_key(key, None).unwrap()], auth_rejection_time: Duration::ZERO, ..Default::default() };
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = socket.local_addr().unwrap().port();
    let entered = Arc::new(Mutex::new(None));
    let task = tokio::spawn(async move { let _ = TestServer { stage, entered }.run_on_socket(Arc::new(config), &socket).await; });
    (port, task)
}

#[tokio::test]
async fn dns_failure_is_reported_once_with_phase_and_cause() {
    let scratch = Scratch::new();
    // NUL makes the system resolver fail locally, without an external DNS query.
    let (_, events) = capture_failure("invalid\0host".into(), 22, scratch.0.clone(), ssh_relay::Proxy::None, None, None).await;
    assert_eq!(events.len(), 1); assert_eq!(events[0].stage, "dns"); assert!(events[0].error.contains("DNS")); assert!(!events[0].error.contains('\0'));
}

#[tokio::test]
async fn refused_tcp_connection_keeps_underlying_os_reason() {
    let scratch = Scratch::new(); let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = socket.local_addr().unwrap().port(); drop(socket);
    let (_, events) = capture_failure("127.0.0.1".into(), port, scratch.0.clone(), ssh_relay::Proxy::None, None, None).await;
    assert_eq!(events.len(), 1); assert_eq!(events[0].stage, "tcp"); assert!(events[0].error.contains(&port.to_string())); assert!(events[0].error.contains("os error"));
}

#[tokio::test]
async fn authentication_failure_includes_missing_key_detail_without_password() {
    let scratch = Scratch::new(); let (port, server) = failure_server(Stage::RejectAuth, &scratch).await;
    let secret = "fixture-password-must-not-leak";
    let (_, events) = capture_failure("127.0.0.1".into(), port, scratch.0.clone(), ssh_relay::Proxy::None, Some(secret.into()), Some(scratch.0.join("missing-private-key").to_string_lossy().into())).await;
    server.abort(); assert_eq!(events.len(), 1); assert_eq!(events[0].stage, "authentication"); assert!(events[0].error.contains("私钥")); assert!(events[0].error.contains("missing-private-key")); assert!(!events[0].error.contains(secret));
}

#[tokio::test]
async fn changed_host_key_has_a_specific_user_visible_reason() {
    let scratch = Scratch::new(); let (port, server) = failure_server(Stage::RejectPty, &scratch).await;
    std::fs::write(scratch.0.join("known_hosts"), "127.0.0.1|different-key\n").unwrap();
    let (_, events) = capture_failure("127.0.0.1".into(), port, scratch.0.clone(), ssh_relay::Proxy::None, None, None).await;
    server.abort(); assert_eq!(events.len(), 1); assert_eq!(events[0].stage, "host-key"); assert!(events[0].error.contains("known_hosts"));
}

#[tokio::test]
async fn server_pty_and_shell_rejections_are_not_silent_successes() {
    for (stage, expected) in [(Stage::RejectPty, "pty"), (Stage::RejectShell, "shell")] {
        let scratch = Scratch::new(); let (port, server) = failure_server(stage, &scratch).await;
        let (_, events) = capture_failure("127.0.0.1".into(), port, scratch.0.clone(), ssh_relay::Proxy::None, None, None).await;
        server.abort(); assert_eq!(events.len(), 1); assert_eq!(events[0].stage, expected); assert!(events[0].error.contains("CHANNEL_FAILURE"));
    }
}

#[tokio::test]
async fn proxy_status_is_reported_without_echoing_proxy_credentials() {
    let scratch = Scratch::new(); let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = socket.local_addr().unwrap().port();
    let password = "proxy-secret-fixture";
    let server = tokio::spawn(async move {
        let (mut client, _) = socket.accept().await.unwrap(); let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") { let mut byte = [0]; client.read_exact(&mut byte).await.unwrap(); head.push(byte[0]); }
        client.write_all(format!("HTTP/1.1 407 {password}\r\n\r\n").as_bytes()).await.unwrap();
    });
    let proxy = ssh_relay::Proxy::Http(ssh_relay::HttpProxy { addr: "127.0.0.1".into(), port, user: Some("fixture".into()), password: Some(password.into()), proxy_dns: true });
    let (_, events) = capture_failure("target.invalid".into(), 22, scratch.0.clone(), proxy, None, None).await;
    server.await.unwrap(); assert_eq!(events.len(), 1); assert_eq!(events[0].stage, "proxy"); assert!(events[0].error.contains("407")); assert!(events[0].error.contains("HTTP CONNECT")); assert!(!events[0].error.contains(password));
}

#[tokio::test]
async fn jump_authentication_error_reaches_the_outer_connection() {
    let scratch = Scratch::new(); let (port, server) = failure_server(Stage::RejectAuth, &scratch).await;
    let spec = crate::jump::JumpSpec { host: "127.0.0.1".into(), port, user: "fixture".into(), password: None, key_path: Some(scratch.0.join("missing-jump-key").to_string_lossy().into()) };
    let proxy = ssh_relay::Proxy::Jump(crate::jump::opener(spec, scratch.0.clone()));
    let (_, events) = capture_failure("target.invalid".into(), 22, scratch.0.clone(), proxy, None, None).await;
    server.abort(); assert_eq!(events.len(), 1); assert_eq!(events[0].stage, "proxy"); assert!(events[0].error.contains("jump auth failed")); assert!(events[0].error.contains("私钥读取失败"));
}

#[tokio::test]
async fn user_close_does_not_emit_a_connection_failure() {
    let scratch = Scratch::new(); let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let (_input, input_rx) = mpsc::unbounded_channel(); let (_resize, resize_rx) = mpsc::unbounded_channel(); let (stop, stop_rx) = mpsc::unbounded_channel(); let (_sftp, sftp_rx) = mpsc::unbounded_channel();
    let events = Arc::new(Mutex::new(Vec::new())); let collect = events.clone();
    let task = tokio::spawn(run(Sink(Arc::new(move |topic, _, data| collect.lock().unwrap().push((topic.to_string(), data)))), "close-no-error".into(), "127.0.0.1".into(), port, "fixture".into(), None, None, 24, 80, scratch.0.clone(), input_rx, resize_rx, stop_rx, sftp_rx, ssh_relay::Proxy::None));
    let (_stream, _) = listener.accept().await.unwrap(); stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap().unwrap();
    assert!(!events.lock().unwrap().iter().any(|(topic, _)| topic == "connection-error"));
}

#[tokio::test]
async fn timeout_retains_the_actual_connection_phase() {
    let error = phase(tokio::time::Instant::now() + Duration::from_millis(10), "handshake", "SSH banner 握手失败", std::future::pending::<Result<(), io::Error>>()).await.unwrap_err();
    let payload = crate::connection_error::ConnectionError::new("timeout-fixture", "ssh", error.as_ref(), &[]);
    assert_eq!(payload.stage, "handshake"); assert!(payload.error.contains("banner")); assert!(payload.error.contains("超时"));
}
