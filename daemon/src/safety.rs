//! Emergency X11 passive hotkey. This connection never synthesizes input or
//! releases the user's real keys/buttons; daemon XTEST gestures release their
//! own synthetic presses and do not retain held input between requests.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::sync::Notify;
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{ConnectionExt as _, GrabMode, ModMask},
        Event,
    },
    rust_connection::RustConnection,
};

const ESCAPE: u32 = 0xff1b;
const ALT_LEFT: u32 = 0xffe9;
const ALT_RIGHT: u32 = 0xffea;
const CTRL_LEFT: u32 = 0xffe3;
const CTRL_RIGHT: u32 = 0xffe4;
const SHIFT_LEFT: u32 = 0xffe1;
const SHIFT_RIGHT: u32 = 0xffe2;
const NUM_LOCK: u32 = 0xff7f;
const SCROLL_LOCK: u32 = 0xff14;

#[derive(Clone, Default)]
pub struct Safety {
    stopped: Arc<AtomicBool>,
    changed: Arc<Notify>,
}

impl Safety {
    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Sticky until daemon restart; returns true only on the first stop.
    pub fn stop(&self) -> bool {
        let first = !self.stopped.swap(true, Ordering::SeqCst);
        if first {
            self.changed.notify_waiters();
        }
        first
    }

    pub fn notifications(&self) -> Arc<Notify> {
        self.changed.clone()
    }
}

struct Hotkey {
    conn: RustConnection,
    key: u8,
    modifiers: u16,
    ignored: u16,
}

// Each attempt owns its connection: a failed checked grab can leave earlier
// masks installed, so the primary connection must close before trying Shift.
fn try_primary_then_fallback<T>(mut attempt: impl FnMut(bool) -> Result<T>) -> Result<(T, bool)> {
    match attempt(false) {
        Ok(hotkey) => Ok((hotkey, false)),
        Err(primary) => {
            let fallback = attempt(true).with_context(|| {
                format!("Ctrl+Alt+Esc unavailable ({primary:#}); Ctrl+Alt+Shift+Escape also unavailable")
            })?;
            Ok((fallback, true))
        }
    }
}

impl Hotkey {
    fn connect() -> Result<(Self, bool)> {
        try_primary_then_fallback(Self::grab)
    }

    fn grab(with_shift: bool) -> Result<Self> {
        let (conn, screen) = x11rb::connect(None)?;
        let setup = conn.setup();
        let first = setup.min_keycode;
        let count = setup.max_keycode - first + 1;
        let mapping = conn.get_keyboard_mapping(first, count)?.reply()?;
        let per = usize::from(mapping.keysyms_per_keycode);
        if per == 0 {
            bail!("empty X11 keyboard mapping");
        }
        let keycode = |symbol| {
            mapping
                .keysyms
                .chunks_exact(per)
                .enumerate()
                .find_map(|(i, syms)| syms.contains(&symbol).then(|| first + i as u8))
        };
        let key = keycode(ESCAPE).context("Escape is not mapped")?;
        let modifiers = conn.get_modifier_mapping()?.reply()?;
        let width = usize::from(modifiers.keycodes_per_modifier());
        if width == 0 {
            bail!("empty X11 modifier mapping");
        }
        let mask_for = |symbols: &[u32]| -> u16 {
            modifiers
                .keycodes
                .chunks_exact(width)
                .enumerate()
                .fold(0, |mask, (i, codes)| {
                    if symbols
                        .iter()
                        .filter_map(|&s| keycode(s))
                        .any(|code| codes.contains(&code))
                    {
                        mask | (1 << i)
                    } else {
                        mask
                    }
                })
        };
        let ctrl = mask_for(&[CTRL_LEFT, CTRL_RIGHT]);
        let alt = mask_for(&[ALT_LEFT, ALT_RIGHT]);
        if ctrl == 0 || alt == 0 || ctrl == alt {
            bail!("Ctrl or Alt is not mapped to an X11 modifier");
        }
        let mut required = ctrl | alt;
        if with_shift {
            let shift = mask_for(&[SHIFT_LEFT, SHIFT_RIGHT]);
            if shift == 0 || shift & required != 0 {
                bail!("Shift is not mapped to a distinct X11 modifier");
            }
            required |= shift;
        }
        let ignored = (u16::from(ModMask::LOCK) | mask_for(&[NUM_LOCK, SCROLL_LOCK])) & !required;
        let root = setup.roots[screen].root;
        let mut combinations = vec![0];
        for bit in 0..8 {
            let flag = 1 << bit;
            if ignored & flag != 0 {
                combinations.extend(combinations.clone().into_iter().map(|mask| mask | flag));
            }
        }
        // Checked grabs: BadAccess means another client owns the shortcut.
        // Dropping the connection releases any grabs already installed.
        for mask in combinations {
            conn.grab_key(
                false,
                root,
                ModMask::from(required | mask),
                key,
                GrabMode::ASYNC,
                GrabMode::ASYNC,
            )?
            .check()?;
        }
        conn.flush()?;
        Ok(Self {
            conn,
            key,
            modifiers: required,
            ignored,
        })
    }

    fn escape_down(&self) -> Result<bool> {
        let keys = self.conn.query_keymap()?.reply()?.keys;
        Ok(keys[usize::from(self.key) / 8] & (1 << (self.key % 8)) != 0)
    }

    fn run(self, safety: Safety, hide: impl FnOnce()) -> Result<()> {
        // A chord held during startup must not stop the daemon due to key repeat.
        // Drain queued events before arming, after the physical Escape is released.
        while self.escape_down()? {
            std::thread::sleep(Duration::from_millis(30));
        }
        while self.conn.poll_for_event()?.is_some() {}
        loop {
            if let Event::KeyPress(event) = self.conn.wait_for_event()? {
                let state = u16::from(event.state);
                // KeyPress.state also contains held mouse buttons; only X11
                // modifier bits participate in the passive grab.
                if event.detail == self.key && (state & 0xff) & !self.ignored == self.modifiers {
                    if safety.stop() {
                        hide();
                    }
                    return Ok(());
                }
            }
        }
    }
}

/// Dedicated connection/thread: the hotkey is processed even if IPC or AT-SPI
/// holds the daemon mutex. Failure leaves the protocol Stop request available.
pub fn start(safety: Safety, hide: impl FnOnce() + Send + 'static) {
    match Hotkey::connect() {
        Ok((hotkey, fallback)) => {
            if fallback {
                eprintln!("emergency hotkey: Ctrl+Alt+Shift+Escape (Ctrl+Alt+Esc unavailable)");
            }
            std::thread::spawn(move || {
                if let Err(error) = hotkey.run(safety, hide) {
                    eprintln!("warning: emergency hotkey unavailable: {error:#}; use Stop request");
                }
            });
        }
        Err(error) => {
            eprintln!("warning: emergency hotkey unavailable: {error:#}; use Stop request")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{try_primary_then_fallback, Safety};
    use anyhow::bail;
    use std::cell::Cell;

    #[test]
    fn primary_hotkey_wins() {
        let mut attempts = Vec::new();
        let (key, fallback) = try_primary_then_fallback(|shift| {
            attempts.push(shift);
            Ok("primary")
        })
        .unwrap();
        assert_eq!(key, "primary");
        assert!(!fallback);
        assert_eq!(attempts, [false]);
    }

    #[test]
    fn failed_primary_releases_partial_grabs_before_fallback() {
        struct PartialGrab<'a>(&'a Cell<bool>);
        impl Drop for PartialGrab<'_> {
            fn drop(&mut self) {
                self.0.set(false);
            }
        }

        let grabbed = Cell::new(false);
        let (key, fallback) = try_primary_then_fallback(|shift| {
            if !shift {
                grabbed.set(true);
                let _connection = PartialGrab(&grabbed);
                bail!("BadAccess after first mask");
            }
            assert!(!grabbed.get(), "primary connection still owns a grab");
            Ok("fallback")
        })
        .unwrap();
        assert_eq!(key, "fallback");
        assert!(fallback);
    }

    #[test]
    fn reports_both_failed_hotkeys() {
        let error = try_primary_then_fallback::<()>(|shift| {
            if shift {
                bail!("fallback failed");
            }
            bail!("primary failed");
        })
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("primary failed"));
        assert!(message.contains("fallback failed"));
    }

    #[test]
    fn stop_is_atomic_shared_and_sticky() {
        let first = Safety::default();
        let second = first.clone();
        assert!(!first.stopped());
        assert!(second.stop());
        assert!(first.stopped());
        assert!(!first.stop());
        assert!(second.stopped());
    }
}
