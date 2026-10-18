//! A binary lane on the *existing* terminal connection. No bytes pass through
//! UTF-8, terminal events, triggers or logging while a modem owns this lane.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{mpsc, watch};

const INPUT_CHUNKS: usize = 256; // bounded: at most 2 MiB for 8 KiB readers
type Sessions = Mutex<HashMap<String, Weak<SessionGate>>>;
fn sessions() -> &'static Sessions { static REGISTRY: OnceLock<Sessions> = OnceLock::new(); REGISTRY.get_or_init(Default::default) }

struct Active { transfer_id: String, input: mpsc::Sender<Vec<u8>>, cancel: watch::Sender<bool> }
#[derive(Default)]
struct Activity { modem: Option<Active>, writes: usize }

pub struct SessionGate {
    id: String,
    alive: Arc<AtomicBool>,
    binary: bool,
    activity: Mutex<Activity>,
}
impl SessionGate {
    pub fn new(id: String, alive: Arc<AtomicBool>, binary: bool) -> Arc<Self> {
        let session = Arc::new(Self { id: id.clone(), alive, binary, activity: Mutex::new(Activity::default()) });
        if let Ok(mut registry) = sessions().lock() { registry.retain(|_, value| value.strong_count() != 0); registry.insert(id, Arc::downgrade(&session)); }
        session
    }
    pub fn alive(&self) -> Arc<AtomicBool> { self.alive.clone() }
    pub fn is_alive(&self) -> bool { self.alive.load(Ordering::Acquire) }
    pub fn binary_supported(&self) -> bool { self.binary }
    pub fn is_busy(&self) -> bool { self.activity.lock().map(|state| state.modem.is_some()).unwrap_or(true) }
    pub fn begin_write(self: &Arc<Self>) -> Result<WriteLease, String> {
        let mut activity = self.activity.lock().map_err(|_| "终端传输状态不可用")?;
        if !self.is_alive() { return Err("目标会话已退出或断开，请先重新连接".into()); }
        if activity.modem.is_some() { return Err("此终端正在传输文件，暂时不能输入命令".into()); }
        activity.writes += 1;
        Ok(WriteLease { gate: self.clone() })
    }
    pub fn begin_modem(self: &Arc<Self>, transfer_id: String) -> Result<(ModemLease, mpsc::Receiver<Vec<u8>>, watch::Receiver<bool>), String> {
        let mut activity = self.activity.lock().map_err(|_| "终端传输状态不可用")?;
        if !self.is_alive() { return Err("目标会话已退出或断开，请先重新连接".into()); }
        if !self.binary { return Err("此通道无法保证二进制保真，请使用 SSH、串口、原始 TCP 或 Unix 本地终端".into()); }
        if activity.modem.is_some() { return Err("该终端已有文件正在传输".into()); }
        if activity.writes != 0 { return Err("终端正在发送输入，请稍后重试文件传输".into()); }
        let (input, receiver) = mpsc::channel(INPUT_CHUNKS);
        let (cancel, cancel_receiver) = watch::channel(false);
        activity.modem = Some(Active { transfer_id: transfer_id.clone(), input, cancel });
        Ok((ModemLease { gate: self.clone(), transfer_id }, receiver, cancel_receiver))
    }
    pub fn cancel(&self, transfer_id: &str) -> bool {
        let Ok(activity) = self.activity.lock() else { return false; };
        let Some(active) = activity.modem.as_ref().filter(|job| job.transfer_id == transfer_id) else { return false; };
        active.cancel.send_replace(true); true
    }
    fn disconnect(&self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(activity) = self.activity.lock() { if let Some(active) = &activity.modem { active.cancel.send_replace(true); } }
    }
    fn route(&self, bytes: &[u8]) -> bool {
        let Ok(activity) = self.activity.lock() else { return true; };
        let Some(active) = &activity.modem else { return false; };
        // Never block the PTY/SSH reader: a slow or failed receiver cancels the
        // transfer instead of growing memory or leaking binary into the UI.
        for chunk in bytes.chunks(8192) {
            if *active.cancel.borrow() { break; }
            if active.input.try_send(chunk.to_vec()).is_err() { active.cancel.send_replace(true); break; }
        }
        true
    }
}
impl Drop for SessionGate { fn drop(&mut self) { self.disconnect(); if let Ok(mut registry) = sessions().lock() { registry.remove(&self.id); } } }
pub struct WriteLease { gate: Arc<SessionGate> }
impl Drop for WriteLease { fn drop(&mut self) { if let Ok(mut activity) = self.gate.activity.lock() { activity.writes = activity.writes.saturating_sub(1); } } }
pub struct ModemLease { gate: Arc<SessionGate>, transfer_id: String }
impl Drop for ModemLease {
    fn drop(&mut self) {
        if let Ok(mut activity) = self.gate.activity.lock() {
            if activity.modem.as_ref().map(|job| job.transfer_id.as_str()) == Some(&self.transfer_id) { activity.modem = None; }
        }
    }
}
fn lookup(id: &str) -> Option<Arc<SessionGate>> { sessions().lock().ok()?.get(id)?.upgrade() }
pub fn disconnect(id: &str) { if let Some(gate) = lookup(id) { gate.disconnect(); } }
pub fn busy(id: &str) -> bool { lookup(id).map(|gate|gate.is_busy()).unwrap_or(false) }
pub fn decode(id: &str, decoder: &mut crate::terminal_io::Utf8Decoder, bytes: &[u8]) -> String {
    if lookup(id).map(|gate| gate.route(bytes)).unwrap_or(false) {
        // An incomplete text character from before the binary boundary must
        // not combine with binary bytes or appear after the transfer.
        decoder.finish(); String::new()
    } else { decoder.push(bytes) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn gate() -> Arc<SessionGate> { static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0); SessionGate::new(format!("modem-test-{}", NEXT.fetch_add(1, Ordering::SeqCst)), Arc::new(AtomicBool::new(true)), true) }
    #[tokio::test]
    async fn binary_bytes_are_exact_and_never_reach_text_decoder() {
        let gate = gate(); let (_lease, mut input, _) = gate.begin_modem("job".into()).unwrap();
        let mut decoder = crate::terminal_io::Utf8Decoder::default();
        let data: Vec<u8> = (0..=255).collect();
        assert!(decode(&gate.id, &mut decoder, &data).is_empty()); assert_eq!(input.recv().await.unwrap(), data);
    }
    #[test]
    fn ordinary_input_and_modem_have_atomic_exclusion() {
        let gate = gate(); let write = gate.begin_write().unwrap(); assert!(gate.begin_modem("job".into()).is_err()); drop(write);
        let (modem, _, _) = gate.begin_modem("job".into()).unwrap(); assert!(gate.begin_write().is_err()); assert!(gate.begin_modem("other".into()).is_err()); drop(modem);
        assert!(gate.begin_write().is_ok());
    }
    #[test]
    fn cancellation_requires_the_exact_transfer_and_session() {
        let first = gate(); let second = gate(); let (_lease, _, cancel) = first.begin_modem("job".into()).unwrap();
        assert!(!second.cancel("job")); assert!(!first.cancel("different")); assert!(!*cancel.borrow()); assert!(first.cancel("job")); assert!(*cancel.borrow());
    }
    #[test]
    fn disconnect_cancels_active_binary_and_rejects_new_operations() {
        let gate = gate(); let (_lease, _, cancel) = gate.begin_modem("job".into()).unwrap(); disconnect(&gate.id);
        assert!(*cancel.borrow()); assert!(!gate.is_alive()); assert!(gate.begin_write().is_err()); assert!(gate.begin_modem("next".into()).is_err());
    }
    #[test]
    fn queue_overflow_cancels_without_falling_back_to_text() {
        let gate = gate(); let (_lease, _receiver, cancel) = gate.begin_modem("job".into()).unwrap();
        let mut decoder = crate::terminal_io::Utf8Decoder::default(); for _ in 0..=INPUT_CHUNKS { assert!(decode(&gate.id, &mut decoder, b"binary").is_empty()); } assert!(*cancel.borrow());
    }
    #[test]
    fn releasing_binary_lane_restores_text_without_stale_partial_utf8() {
        let gate = gate(); let mut decoder = crate::terminal_io::Utf8Decoder::default(); assert!(decode(&gate.id, &mut decoder, &[0xe4]).is_empty());
        let (lease, _input, _) = gate.begin_modem("job".into()).unwrap(); assert!(decode(&gate.id, &mut decoder, &[0xff, 0x00]).is_empty()); drop(lease);
        assert_eq!(decode(&gate.id, &mut decoder, "就绪".as_bytes()), "就绪");
    }
    #[test]
    fn nonbinary_telnet_is_rejected_before_acquiring_the_lane() {
        let gate = SessionGate::new("telnet-test".into(), Arc::new(AtomicBool::new(true)), false); assert!(gate.begin_modem("job".into()).is_err()); assert!(!gate.is_busy());
    }
}
