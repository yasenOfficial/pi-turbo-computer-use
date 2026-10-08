//! Scoped activity and capture suspension for the overlay worker.
//! All state transitions happen on the worker; guards only enqueue commands.
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

pub enum Command {
    Begin(u64, Option<tokio::sync::oneshot::Sender<()>>),
    End(u64),
    Suspend(u64, mpsc::Sender<()>),
    Resume(u64),
    Stop,
}

#[derive(Default)]
pub struct Lifecycle {
    active: HashSet<u64>,
    suspended: HashSet<u64>,
    stopped: bool,
}

impl Lifecycle {
    /// Returns true only when a fresh idle-to-active interval starts.
    /// Suspension changes visibility, not the animation epoch.
    pub fn apply(&mut self, command: &Command) -> bool {
        let was_active = self.active();
        match command {
            Command::Begin(id, _) if !self.stopped => {
                self.active.insert(*id);
            }
            Command::End(id) => {
                self.active.remove(id);
            }
            Command::Suspend(id, _) if !self.stopped => {
                self.suspended.insert(*id);
            }
            Command::Resume(id) => {
                self.suspended.remove(id);
            }
            Command::Stop => {
                self.stopped = true;
                self.active.clear();
                self.suspended.clear();
            }
            _ => {}
        }
        !was_active && self.active()
    }
    pub fn active(&self) -> bool {
        !self.stopped && !self.active.is_empty()
    }
    pub fn visible(&self) -> bool {
        self.active() && self.suspended.is_empty()
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

pub struct Activity {
    sender: mpsc::Sender<Command>,
    id: u64,
}
impl Activity {
    pub fn begin(sender: &mpsc::Sender<Command>) -> Self {
        let id = id();
        let _ = sender.send(Command::Begin(id, None));
        Self {
            sender: sender.clone(),
            id,
        }
    }
    /// Enqueue Begin and transfer the guard immediately, so a lease can store
    /// it before waiting for the worker's mapping acknowledgement. A cancelled
    /// IPC request must not discard activity for an already-created lease.
    pub fn begin_with_ack(
        sender: &mpsc::Sender<Command>,
    ) -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let id = id();
        let (ack, ready) = tokio::sync::oneshot::channel();
        let activity = Self {
            sender: sender.clone(),
            id,
        };
        let _ = sender.send(Command::Begin(id, Some(ack)));
        (activity, ready)
    }
    pub async fn begin_ready(sender: &mpsc::Sender<Command>) -> Self {
        Self::begin_ready_for(sender, Duration::from_secs(2)).await
    }
    async fn begin_ready_for(sender: &mpsc::Sender<Command>, timeout: Duration) -> Self {
        let (activity, ready) = Self::begin_with_ack(sender);
        // Guard exists even if this future is cancelled while waiting to map.
        // If the overlay is unavailable, input still works without feedback.
        let _ = tokio::time::timeout(timeout, ready).await;
        activity
    }
}
impl Drop for Activity {
    fn drop(&mut self) {
        let _ = self.sender.send(Command::End(self.id));
    }
}

pub struct Suspension {
    sender: mpsc::Sender<Command>,
    id: u64,
}
impl Suspension {
    pub fn sync(sender: &mpsc::Sender<Command>) -> anyhow::Result<Self> {
        let (ack, receiver) = mpsc::channel();
        let suspension = Self {
            sender: sender.clone(),
            id: id(),
        };
        sender
            .send(Command::Suspend(suspension.id, ack))
            .map_err(|_| anyhow::anyhow!("overlay worker unavailable before visual capture"))?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| anyhow::anyhow!("overlay did not confirm unmap: {error}"))?;
        Ok(suspension)
    }
}
impl Drop for Suspension {
    fn drop(&mut self) {
        let _ = self.sender.send(Command::Resume(self.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(receiver: &mpsc::Receiver<Command>, state: &mut Lifecycle) {
        while let Ok(command) = receiver.try_recv() {
            state.apply(&command);
        }
    }
    #[test]
    fn nested_batch_and_step_guards_do_not_flicker_or_leak_on_error() {
        let (tx, rx) = mpsc::channel();
        let mut state = Lifecycle::default();
        let batch = Activity::begin(&tx);
        let step = Activity::begin(&tx);
        run(&rx, &mut state);
        assert!(state.active());
        assert!(state.visible());
        drop(step); // Failed step, batch is still waiting/observing.
        run(&rx, &mut state);
        assert!(state.visible());
        drop(batch);
        run(&rx, &mut state);
        assert!(!state.visible());
    }
    #[test]
    fn breathing_epoch_survives_capture_and_nested_actions() {
        let mut state = Lifecycle::default();
        let (ack, _) = mpsc::channel();
        assert!(state.apply(&Command::Begin(1, None)));
        assert!(!state.apply(&Command::Begin(2, None)));
        assert!(!state.apply(&Command::Suspend(3, ack)));
        assert!(state.active());
        assert!(!state.visible());
        assert!(!state.apply(&Command::End(2)));
        assert!(!state.apply(&Command::Resume(3)));
        assert!(state.visible());
        assert!(!state.apply(&Command::End(1)));
        assert!(!state.active());
        assert!(!state.visible());
        assert!(state.apply(&Command::Begin(4, None)));
        assert!(state.visible());
        assert!(!state.apply(&Command::Stop));
        assert!(!state.apply(&Command::Begin(5, None)));
        assert!(!state.visible());
    }

    #[tokio::test]
    async fn cancelled_pending_begin_releases_its_token() {
        let (tx, rx) = mpsc::channel();
        let task = tokio::spawn(async move { Activity::begin_ready(&tx).await });
        let mut state = Lifecycle::default();
        // Begin is queued; deliberately withhold its acknowledgement.
        let command = loop {
            if let Ok(command) = rx.try_recv() {
                break command;
            }
            tokio::task::yield_now().await;
        };
        state.apply(&command);
        assert!(state.visible());
        task.abort();
        let _ = task.await;
        run(&rx, &mut state);
        assert!(!state.visible());
    }

    #[tokio::test]
    async fn unresponsive_worker_cannot_block_input_indefinitely() {
        let (tx, rx) = mpsc::channel();
        let activity = Activity::begin_ready_for(&tx, Duration::from_millis(10)).await;
        let mut state = Lifecycle::default();
        // The worker never acknowledges Begin; the timeout still returns an
        // owned guard, which ends its queued token on scope exit.
        run(&rx, &mut state);
        assert!(state.visible());
        drop(activity);
        run(&rx, &mut state);
        assert!(!state.visible());
    }

    #[test]
    fn capture_suspension_guard_resumes_after_error() {
        let (tx, rx) = mpsc::channel();
        let active = Activity::begin(&tx);
        let worker = std::thread::spawn(move || {
            let mut state = Lifecycle::default();
            while let Ok(command) = rx.recv() {
                state.apply(&command);
                if let Command::Suspend(_, ref ack) = command {
                    assert!(!state.visible());
                    ack.send(()).unwrap();
                }
                if matches!(command, Command::Resume(_)) {
                    assert!(state.visible());
                    break;
                }
            }
        });
        let fail = || -> anyhow::Result<()> {
            let _suspended = Suspension::sync(&tx)?;
            anyhow::bail!("capture failed")
        };
        assert!(fail().is_err());
        worker.join().unwrap();
        drop(active);
    }

    #[test]
    fn suspension_resumes_even_on_early_return_and_stop_is_sticky() {
        let (tx, rx) = mpsc::channel();
        let mut state = Lifecycle::default();
        let active = Activity::begin(&tx);
        let (ack, _) = mpsc::channel();
        let suspended = id();
        tx.send(Command::Suspend(suspended, ack)).unwrap();
        run(&rx, &mut state);
        assert!(state.active()); // Suspension does not restart the breathing epoch.
        assert!(!state.visible());
        tx.send(Command::Resume(suspended)).unwrap();
        run(&rx, &mut state);
        assert!(state.active());
        assert!(state.visible());
        tx.send(Command::Stop).unwrap();
        let queued = Activity::begin(&tx);
        run(&rx, &mut state);
        assert!(!state.active());
        assert!(!state.visible());
        drop((active, queued));
        run(&rx, &mut state);
        assert!(!state.visible());
    }
}
