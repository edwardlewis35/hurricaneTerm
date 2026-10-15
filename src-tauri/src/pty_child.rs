//! A PTY child must be waitable and terminable independently.
//!
//! Holding a child mutex across `wait()` prevents a close command from acquiring
//! that mutex to kill the same child. The waiter would then need the very exit
//! that the blocked close command is supposed to cause.

use portable_pty::{Child, ChildKiller};
use std::sync::mpsc;
use std::time::Duration;

pub type Killer = Box<dyn ChildKiller + Send + Sync>;

#[derive(Clone, Debug)]
struct CloseHandle(mpsc::Sender<()>);

impl ChildKiller for CloseHandle {
    fn kill(&mut self) -> std::io::Result<()> {
        // The receiver is gone after natural exit. Closing an exited tab is a
        // no-op and never sends a signal to a PID which may have been reused.
        let _ = self.0.send(());
        Ok(())
    }
    fn clone_killer(&self) -> Killer { Box::new(self.clone()) }
}

pub fn monitor_child(
    mut child: Box<dyn Child + Send + Sync>,
    on_exit: impl FnOnce() + Send + 'static,
) -> Killer {
    let (close, requests) = mpsc::channel();
    std::thread::spawn(move || {
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {}
            }
            match requests.recv_timeout(Duration::from_millis(50)) {
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // The owning Child handle provides native termination:
                    // Unix sends HUP, allows a short grace, then SIGKILL if
                    // needed. A cloned Unix raw killer only sends HUP and can
                    // leave an HUP-ignoring process running indefinitely.
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
        on_exit();
    });
    Box::new(CloseHandle(close))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    use std::sync::mpsc;
    use std::time::Duration;

    fn closes_real_pty(command: &str) {
        let pair = native_pty_system().openpty(PtySize {
            rows: 24, cols: 80, pixel_width: 0, pixel_height: 0,
        }).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", command]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (first_output_tx, first_output_rx) = mpsc::channel();
        let (reader_exit_tx, reader_exit_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            let mut first = Some(first_output_tx);
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                if let Some(tx) = first.take() { let _ = tx.send(()); }
            }
            let _ = reader_exit_tx.send(());
        });
        let (child_exit_tx, child_exit_rx) = mpsc::channel();
        let mut killer = monitor_child(child, move || { let _ = child_exit_tx.send(()); });
        first_output_rx.recv_timeout(Duration::from_secs(5)).expect("PTY child started");
        // The owner is already monitoring the child. Close must not depend on
        // a wait releasing a shared child lock.
        std::thread::sleep(Duration::from_millis(50));
        let (kill_tx, kill_rx) = mpsc::channel();
        std::thread::spawn(move || { let _ = kill_tx.send(killer.kill()); });
        let closed = kill_rx.recv_timeout(Duration::from_secs(2));
        drop(pair.master);
        closed.expect("close must not block behind child wait").unwrap();
        child_exit_rx.recv_timeout(Duration::from_secs(5)).expect("child must be reaped");
        reader_exit_rx.recv_timeout(Duration::from_secs(5)).expect("PTY reader must exit");
    }

    #[test]
    fn close_idle_shell_does_not_wait_for_natural_exit() {
        closes_real_pty("printf ready; read answer");
    }

    #[test]
    fn close_shell_during_continuous_output() {
        closes_real_pty("while :; do printf 'terminal output continues\\n'; done");
    }

    #[test]
    fn close_reaps_shell_that_ignores_hangup() {
        closes_real_pty("trap '' HUP; printf ready; while :; do printf 'ignoring HUP\\n'; done");
    }
}
