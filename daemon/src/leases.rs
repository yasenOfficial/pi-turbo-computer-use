//! Bounded, expiring overlay-only leases. Independent of the action mutex;
//! losing a client or a renewal cannot leave the light on indefinitely.
use std::{
    collections::HashMap,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{bail, Result};

use crate::{
    feedback::{Activity, Command},
    protocol::ControlActivityAction,
    safety::Safety,
};

const DEFAULT_TTL_MS: u64 = 30_000;
const MAX_LEASES: usize = 8;
const TICK: Duration = Duration::from_millis(100);

struct Lease {
    expires: Instant,
    // None when the overlay is disabled; lease semantics remain identical.
    _activity: Option<Activity>,
}

pub struct Leases {
    active: Mutex<HashMap<String, Lease>>,
    sender: Option<mpsc::Sender<Command>>,
    safety: Safety,
}

impl Leases {
    pub fn new(safety: Safety, sender: Option<mpsc::Sender<Command>>) -> Arc<Self> {
        Arc::new(Self {
            active: Mutex::new(HashMap::new()),
            sender,
            safety,
        })
    }

    /// Weak reference lets test/daemon shutdown release the actor without a
    /// background task retaining the overlay sender or the guards forever.
    pub fn start(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(TICK).await;
                let Some(leases) = weak.upgrade() else { break };
                leases.reap();
            }
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Lease>> {
        self.active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn clear(&self) {
        self.lock().clear(); // Drops guards and enqueues End without waiting for X11.
    }

    pub fn active_count(&self) -> u32 {
        let mut active = self.lock();
        active.retain(|_, lease| lease.expires > Instant::now());
        active.len() as u32
    }

    // Keep the idle check and closing fence under the same short lock as Begin.
    // Begin checks safety while holding this lock, so none can slip past exit.
    pub fn close_if_idle(&self, close: impl FnOnce()) -> bool {
        let mut active = self.lock();
        active.retain(|_, lease| lease.expires > Instant::now());
        if !active.is_empty() || self.safety.stopped() {
            return false;
        }
        close();
        true
    }

    #[cfg(test)]
    pub fn lock_for_test(&self) -> usize {
        self.lock().len()
    }

    fn reap(&self) {
        let mut active = self.lock();
        if self.safety.stopped() {
            active.clear();
        } else {
            let now = Instant::now();
            active.retain(|_, lease| lease.expires > now);
        }
    }

    pub async fn handle(
        &self,
        action: ControlActivityAction,
        token: String,
        ttl_ms: Option<u64>,
    ) -> Result<()> {
        // UUID, not an arbitrary caller-supplied label: only local clients
        // knowing a high-entropy workflow token can renew/end that lease.
        if !valid_uuid(&token) {
            bail!("control_activity token must be a UUID (36 ASCII characters)");
        }
        let ttl = match action {
            ControlActivityAction::End => {
                if ttl_ms.is_some() {
                    bail!("end does not accept ttl_ms");
                }
                None
            }
            _ => {
                let ms = ttl_ms.unwrap_or(DEFAULT_TTL_MS);
                if !(1_000..=60_000).contains(&ms) {
                    bail!("control_activity ttl_ms must be 1000..=60000");
                }
                Some(Duration::from_millis(ms))
            }
        };
        // This lock only protects 8 entries and never spans an await or X11.
        let ready = {
            let mut active = self.lock();
            if self.safety.stopped() {
                active.clear();
                if action != ControlActivityAction::End {
                    bail!("input stopped; restart daemon to re-enable activity");
                }
            }
            let now = Instant::now();
            active.retain(|_, lease| lease.expires > now);
            match action {
                ControlActivityAction::Begin => {
                    if active.contains_key(&token) {
                        bail!("activity token already active");
                    }
                    if active.len() >= MAX_LEASES {
                        bail!("too many activity leases (maximum 8)");
                    }
                    let (activity, ready) = match &self.sender {
                        Some(sender) => {
                            let (guard, ready) = Activity::begin_with_ack(sender);
                            (Some(guard), Some(ready))
                        }
                        None => (None, None),
                    };
                    active.insert(
                        token.clone(),
                        Lease {
                            expires: now + ttl.unwrap(),
                            _activity: activity,
                        },
                    );
                    ready
                }
                ControlActivityAction::Renew => {
                    let lease = active
                        .get_mut(&token)
                        .ok_or_else(|| anyhow::anyhow!("unknown or expired activity token"))?;
                    lease.expires = now + ttl.unwrap();
                    None
                }
                ControlActivityAction::End => {
                    active.remove(&token); // Unknown end is intentionally idempotent.
                    None
                }
            }
        };
        if let Some(ready) = ready {
            // A worker failure or unavailable X11 is non-fatal. Still wait for
            // a healthy worker's map/sync before acknowledging the workflow.
            let _ = tokio::time::timeout(Duration::from_secs(2), ready).await;
        }
        if action == ControlActivityAction::Begin {
            if self.safety.stopped() {
                self.clear();
                bail!("input stopped; restart daemon to re-enable activity");
            }
            // A slow/unresponsive worker may outlive a short TTL or an End.
            if !self
                .lock()
                .get(&token)
                .is_some_and(|lease| lease.expires > Instant::now())
            {
                bail!("activity lease ended or expired before acknowledgement");
            }
        }
        Ok(())
    }
}

fn valid_uuid(token: &str) -> bool {
    if token.len() != 36 {
        return false;
    } // Also bounds the caller's token size.
    token.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feedback::Lifecycle;

    const A: &str = "00112233-4455-6677-8899-aabbccddeeff";
    fn token(n: u8) -> String {
        format!("00112233-4455-6677-8899-aabbccddee{n:02x}")
    }
    fn drain(rx: &mpsc::Receiver<Command>, state: &mut Lifecycle) {
        while let Ok(command) = rx.try_recv() {
            state.apply(&command);
            if let Command::Begin(_, Some(ack)) = command {
                let _ = ack.send(());
            }
        }
    }
    #[tokio::test]
    async fn leases_overlap_actions_and_suspend_without_flicker() {
        let (tx, rx) = mpsc::channel();
        let leases = Leases::new(Safety::default(), Some(tx.clone()));
        // Worker consumes Begin and acknowledges the map.
        let worker = tokio::spawn(async move {
            let command = loop {
                if let Ok(command) = rx.try_recv() {
                    break command;
                }
                tokio::task::yield_now().await;
            };
            let mut state = Lifecycle::default();
            state.apply(&command);
            if let Command::Begin(_, Some(ack)) = command {
                ack.send(()).unwrap();
            }
            (rx, state)
        });
        leases
            .handle(ControlActivityAction::Begin, A.into(), None)
            .await
            .unwrap();
        let (rx, mut state) = worker.await.unwrap();
        assert!(state.visible());
        let step = Activity::begin(&tx);
        drain(&rx, &mut state);
        drop(step);
        drain(&rx, &mut state);
        assert!(state.visible());
        let (ack, _) = mpsc::channel();
        state.apply(&Command::Suspend(42, ack));
        assert!(!state.visible());
        state.apply(&Command::Resume(42));
        assert!(state.visible());
        leases
            .handle(ControlActivityAction::End, A.into(), None)
            .await
            .unwrap();
        drain(&rx, &mut state);
        assert!(!state.visible());
    }

    #[tokio::test]
    async fn timer_expiry_drops_visual_guard_without_client_disconnect_or_x11() {
        let (tx, rx) = mpsc::channel();
        let leases = Leases::new(Safety::default(), Some(tx));
        leases.start();
        let begin = {
            let leases = leases.clone();
            tokio::spawn(async move {
                leases
                    .handle(ControlActivityAction::Begin, A.into(), Some(1_000))
                    .await
                    .unwrap();
            })
        };
        let command = loop {
            if let Ok(command) = rx.try_recv() {
                break command;
            }
            tokio::task::yield_now().await;
        };
        let mut state = Lifecycle::default();
        state.apply(&command);
        if let Command::Begin(_, Some(ack)) = command {
            ack.send(()).unwrap();
        }
        begin.await.unwrap();
        assert!(state.visible());
        tokio::time::sleep(Duration::from_millis(1_250)).await;
        drain(&rx, &mut state);
        assert!(!state.visible());
        assert_eq!(leases.lock_for_test(), 0);
    }

    #[tokio::test]
    async fn expiry_renewal_cap_and_stop_without_x11() {
        let safety = Safety::default();
        let leases = Leases::new(safety.clone(), None);
        leases.start();
        assert!(leases
            .handle(ControlActivityAction::Renew, A.into(), None)
            .await
            .is_err());
        assert!(leases
            .handle(ControlActivityAction::Begin, "bad".into(), None)
            .await
            .is_err());
        assert!(leases
            .handle(ControlActivityAction::Begin, A.into(), Some(999))
            .await
            .is_err());
        for i in 0..8 {
            leases
                .handle(ControlActivityAction::Begin, token(i), Some(1_000))
                .await
                .unwrap();
        }
        assert!(leases
            .handle(ControlActivityAction::Begin, token(8), None)
            .await
            .is_err());
        tokio::time::sleep(Duration::from_millis(550)).await;
        leases
            .handle(ControlActivityAction::Renew, token(0), Some(1_000))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(leases
            .handle(ControlActivityAction::Renew, token(1), None)
            .await
            .is_err());
        assert_eq!(leases.lock().len(), 1);
        assert!(leases
            .handle(ControlActivityAction::Renew, token(0), None)
            .await
            .is_ok());
        safety.stop();
        tokio::time::timeout(Duration::from_millis(400), async {
            while !leases.lock().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(leases
            .handle(ControlActivityAction::Begin, A.into(), None)
            .await
            .is_err());
        leases
            .handle(ControlActivityAction::End, A.into(), None)
            .await
            .unwrap();
    }
}
