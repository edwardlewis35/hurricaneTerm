//! Real loopback TCP / SSH regression tests for close during stalled operations.
//! The fixture creates its own host key and never reads a user identity.
use super::*;
use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Copy)]
enum Stage { Auth, Pty, Sftp }
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
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
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
