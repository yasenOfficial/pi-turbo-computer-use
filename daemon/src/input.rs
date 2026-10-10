//! X11 pointer and keyboard input using the XTEST extension.
//!
//! Coordinates are root-window (desktop) coordinates. Text is typed via the
//! current X keyboard mapping; unmapped characters return an error rather than
//! silently producing a different character. This does not implement an IME.

use std::error::Error;
use std::io;
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xkb::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageData, ClientMessageEvent, ConnectionExt as _, EventMask, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

use crate::{safety::Safety, state::Bounds};
use serde::Serialize;

/// EWMH window metadata, independent of the AT-SPI semantic tree.
#[derive(Debug, Serialize)]
pub struct X11Window {
    pub id: String,
    pub title: String,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
}

// WM_NAME with type STRING uses ISO-8859-1, not UTF-8. Both name
// properties are NUL-terminated; never expose trailing property padding.
fn parse_window_name(bytes: &[u8], utf8: bool) -> String {
    let bytes = bytes.split(|&byte| byte == 0).next().unwrap_or_default();
    if utf8 {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        bytes.iter().map(|&byte| char::from(byte)).collect()
    }
}

/// Read EWMH clients without XTEST or any input events. The active window is
/// included even if the WM's client list has not caught up (or omits it).
pub fn list_windows() -> InputResult<Vec<X11Window>> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let atom =
        |name: &[u8]| -> InputResult<u32> { Ok(conn.intern_atom(false, name)?.reply()?.atom) };
    let clients = atom(b"_NET_CLIENT_LIST")?;
    let active_atom = atom(b"_NET_ACTIVE_WINDOW")?;
    let name_atom = atom(b"_NET_WM_NAME")?;
    let utf8_atom = atom(b"UTF8_STRING")?;
    let active = conn
        .get_property(false, root, active_atom, AtomEnum::WINDOW, 0, 1)?
        .reply()?
        .value32()
        .and_then(|mut values| values.next());
    let list = conn
        .get_property(false, root, clients, AtomEnum::WINDOW, 0, 4096)?
        .reply()?;
    if list.bytes_after != 0 {
        return Err(invalid("window list exceeds supported size").into());
    }
    let mut ids: Vec<Window> = list.value32().map(Iterator::collect).unwrap_or_default();
    if let Some(active) = active.filter(|&id| id != 0) {
        if !ids.contains(&active) {
            ids.push(active);
        }
    }
    let mut windows = Vec::with_capacity(ids.len());
    for id in ids {
        // Clients can close between reading the list and querying properties.
        let title = (|| -> InputResult<String> {
            let net = conn
                .get_property(false, id, name_atom, utf8_atom, 0, 1024)?
                .reply()?;
            if !net.value.is_empty() {
                return Ok(parse_window_name(&net.value, true));
            }
            let legacy = conn
                .get_property(false, id, AtomEnum::WM_NAME, AtomEnum::ANY, 0, 1024)?
                .reply()?;
            Ok(parse_window_name(&legacy.value, legacy.type_ == utf8_atom))
        })()
        .unwrap_or_default();
        let bounds = (|| -> InputResult<Bounds> {
            let geometry = conn.get_geometry(id)?.reply()?;
            let location = conn.translate_coordinates(id, root, 0, 0)?.reply()?;
            Ok(Bounds {
                x: i32::from(location.dst_x),
                y: i32::from(location.dst_y),
                width: i32::from(geometry.width),
                height: i32::from(geometry.height),
            })
        })()
        .ok();
        windows.push(X11Window {
            id: format!("0x{id:08x}"),
            title,
            active: Some(id) == active,
            bounds,
        });
    }
    Ok(windows)
}

pub type InputResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn stopped() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "emergency stop active")
}

const FOCUS_WAIT: Duration = Duration::from_millis(1000);
const FOCUS_POLL: Duration = Duration::from_millis(20);

// EWMH _NET_ACTIVE_WINDOW: source=2 (pager/automation), timestamp=CurrentTime
// (0), currently active window unknown (0). Never send WM_DELETE_WINDOW or
// synthetic input in this path.
fn focus_request(
    root: Window,
    window: Window,
    active_atom: u32,
) -> (Window, EventMask, ClientMessageEvent) {
    (
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        ClientMessageEvent::new(
            32,
            window,
            active_atom,
            ClientMessageData::from([2, 0, 0, 0, 0]),
        ),
    )
}

fn check_stop(safety: Option<&Safety>) -> InputResult<()> {
    if safety.is_some_and(Safety::stopped) {
        Err(stopped().into())
    } else {
        Ok(())
    }
}

// A successful SendEvent only acknowledges transport, not WM activation.
// Keep polling bounded; never retry the request or force focus with XTEST.
fn observe_focus(
    conn: &RustConnection,
    root: Window,
    target: Window,
    active_atom: u32,
) -> InputResult<Option<Window>> {
    // Check existence even if the root property still has a stale ID.
    // A BadWindow is a vanished target, not a successful focus.
    conn.get_window_attributes(target)?.reply().map_err(
        |error| -> Box<dyn Error + Send + Sync> {
            match error {
                x11rb::errors::ReplyError::X11Error(ref x11)
                    if x11.error_kind == x11rb::protocol::ErrorKind::Window =>
                {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        format!("focus target 0x{target:08x} vanished: {error}"),
                    )
                    .into()
                }
                other => other.into(),
            }
        },
    )?;
    let property = conn
        .get_property(false, root, active_atom, AtomEnum::WINDOW, 0, 1)?
        .reply()?;
    Ok(property.value32().and_then(|mut ids| ids.next()))
}

fn await_focus(
    safety: Option<&Safety>,
    target: Window,
    mut observe: impl FnMut() -> InputResult<Option<Window>>,
) -> InputResult<()> {
    let deadline = Instant::now() + FOCUS_WAIT;
    loop {
        check_stop(safety)?;
        if observe()? == Some(target) {
            check_stop(safety)?;
            return Ok(());
        }
        check_stop(safety)?;
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("window manager did not activate window 0x{target:08x}"),
            )
            .into());
        }
        std::thread::sleep(FOCUS_POLL.min(deadline.saturating_duration_since(Instant::now())));
    }
}

// X11 keysym values (not Linux input keycodes).
const SHIFT: u32 = 0xffe1;
const CTRL: u32 = 0xffe3;
const ALT: u32 = 0xffe9;
const SUPER: u32 = 0xffeb;
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION: u8 = 6;

// The ledger contains only presses made by this gesture. Release requests in
// cleanup deliberately bypass the stop check and continue after errors.
struct Gesture<'a> {
    safety: Option<&'a Safety>,
    emit: &'a mut dyn FnMut(u8, u8, i16, i16) -> InputResult<()>,
    preflight: Option<&'a mut dyn FnMut(u8, u8) -> InputResult<()>>,
    held: Vec<(u8, u8)>,
}

impl Gesture<'_> {
    fn check_stop(&self) -> InputResult<()> {
        if self.safety.is_some_and(Safety::stopped) {
            Err(stopped().into())
        } else {
            Ok(())
        }
    }

    fn send(&mut self, kind: u8, detail: u8, x: i16, y: i16) -> InputResult<()> {
        self.check_stop()?;
        let press = kind == KEY_PRESS || kind == BUTTON_PRESS;
        let release = kind == KEY_RELEASE || kind == BUTTON_RELEASE;
        let down_kind = if kind == KEY_RELEASE {
            KEY_PRESS
        } else {
            BUTTON_PRESS
        };
        if release && !self.held.contains(&(down_kind, detail)) {
            return Err(invalid("unpaired synthetic release").into());
        }
        if press {
            if self.held.contains(&(kind, detail)) {
                return Err(invalid("synthetic input already held").into());
            }
            if let Some(preflight) = self.preflight.as_mut() {
                preflight(kind, detail)?;
            }
            self.check_stop()?;
        }
        // Record before a checked send: transport failure may leave delivery
        // ambiguous, so cleanup must still attempt the corresponding release.
        if press {
            self.held.push((kind, detail));
        }
        (self.emit)(kind, detail, x, y)?;
        if release {
            let index = self
                .held
                .iter()
                .rposition(|&entry| entry == (down_kind, detail))
                .unwrap();
            self.held.remove(index);
        }
        Ok(())
    }

    fn pointer(&mut self, x: i16, y: i16) -> InputResult<()> {
        self.send(MOTION, 0, x, y)
    }

    fn button(&mut self, button: u8, down: bool) -> InputResult<()> {
        self.send(
            if down { BUTTON_PRESS } else { BUTTON_RELEASE },
            button,
            0,
            0,
        )
    }

    fn keycode(&mut self, code: u8, down: bool) -> InputResult<()> {
        self.send(if down { KEY_PRESS } else { KEY_RELEASE }, code, 0, 0)
    }

    fn cleanup(&mut self) {
        for (kind, detail) in self.held.drain(..).rev() {
            let release = if kind == KEY_PRESS {
                KEY_RELEASE
            } else {
                BUTTON_RELEASE
            };
            let _ = (self.emit)(release, detail, 0, 0);
        }
    }
}

fn with_gesture<'a>(
    safety: Option<&'a Safety>,
    emit: &'a mut dyn FnMut(u8, u8, i16, i16) -> InputResult<()>,
    preflight: Option<&'a mut dyn FnMut(u8, u8) -> InputResult<()>>,
    action: impl FnOnce(&mut Gesture<'_>) -> InputResult<()>,
) -> InputResult<()> {
    let mut gesture = Gesture {
        safety,
        emit,
        preflight,
        held: Vec::new(),
    };
    let result = action(&mut gesture).and_then(|()| gesture.check_stop());
    // Even on success, never allow a malformed gesture to leave input held.
    gesture.cleanup();
    result
}

/// An XTEST-backed input device. Requires access to the X server and XTEST.
pub struct X11Input {
    conn: RustConnection,
    root: Window,
    safety: Option<Safety>,
}

impl X11Input {
    pub fn new() -> InputResult<Self> {
        let (conn, screen) = x11rb::connect(None)?;
        conn.xtest_get_version(2, 2)?.reply()?;
        let root = conn.setup().roots[screen].root;
        Ok(Self {
            conn,
            root,
            safety: None,
        })
    }

    /// Attach the daemon's sticky emergency stop before using this device.
    pub fn set_safety(&mut self, safety: Safety) {
        self.safety = Some(safety);
    }

    pub fn new_with_safety(safety: Safety) -> InputResult<Self> {
        let mut input = Self::new()?;
        input.set_safety(safety);
        Ok(input)
    }

    // Refuse to synthesize a press over a key/button already down. Otherwise
    // our matching release could release input held by the user. X11 does not
    // expose provenance, so this is a best-effort snapshot, not a global grab.
    fn preflight(&self, kind: u8, detail: u8) -> InputResult<()> {
        if kind == KEY_PRESS {
            let keys = self.conn.query_keymap()?.reply()?.keys;
            if keys[usize::from(detail) / 8] & (1 << (detail % 8)) != 0 {
                return Err(invalid("key already held; refusing synthetic press").into());
            }
        } else if kind == BUTTON_PRESS && detail <= 5 {
            let state = u16::from(self.conn.query_pointer(self.root)?.reply()?.mask);
            let mask = match detail {
                1 => 1 << 8,
                2 => 1 << 9,
                3 => 1 << 10,
                4 => 1 << 11,
                _ => 1 << 12,
            };
            if state & mask != 0 {
                return Err(invalid("button already held; refusing synthetic press").into());
            }
        }
        Ok(())
    }

    fn gesture(&self, action: impl FnOnce(&mut Gesture<'_>) -> InputResult<()>) -> InputResult<()> {
        let mut emit = |kind, detail, x, y| self.event(kind, detail, x, y);
        let mut preflight = |kind, detail| self.preflight(kind, detail);
        let result = with_gesture(
            self.safety.as_ref(),
            &mut emit,
            Some(&mut preflight),
            action,
        );
        let flush = self.conn.flush();
        result?;
        flush?;
        Ok(())
    }

    fn event(&self, kind: u8, detail: u8, x: i16, y: i16) -> InputResult<()> {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)?
            .check()?;
        Ok(())
    }

    /// Move and click a physical X button (1=left, 2=middle, 3=right).
    pub fn click(&self, x: i16, y: i16, button: u8) -> InputResult<()> {
        if !(1..=7).contains(&button) {
            return Err(invalid("X button must be in 1..=7").into());
        }
        self.gesture(|g| {
            g.pointer(x, y)?;
            g.button(button, true)?;
            g.button(button, false)
        })
    }

    /// Ask the window manager to activate a uniquely titled EWMH client window.
    pub fn focus_window(&self, title: &str) -> InputResult<()> {
        let title = title.trim();
        if title.is_empty() {
            return Err(invalid("window title must not be empty").into());
        }
        check_stop(self.safety.as_ref())?;
        let atom = |name: &[u8]| -> InputResult<u32> {
            Ok(self.conn.intern_atom(false, name)?.reply()?.atom)
        };
        let clients = atom(b"_NET_CLIENT_LIST")?;
        let name = atom(b"_NET_WM_NAME")?;
        let active = atom(b"_NET_ACTIVE_WINDOW")?;
        let list = self
            .conn
            .get_property(false, self.root, clients, AtomEnum::WINDOW, 0, 4096)?
            .reply()?;
        if list.bytes_after != 0 {
            return Err(invalid("window list exceeds supported size").into());
        }
        let windows = list
            .value32()
            .ok_or_else(|| invalid("window manager does not expose _NET_CLIENT_LIST"))?;
        let mut matches = Vec::new();
        for window in windows {
            let property = self
                .conn
                .get_property(false, window, name, AtomEnum::ANY, 0, 1024)?
                .reply()?;
            let property = if property.value.is_empty() {
                self.conn
                    .get_property(false, window, AtomEnum::WM_NAME, AtomEnum::ANY, 0, 1024)?
                    .reply()?
            } else {
                property
            };
            let found = String::from_utf8_lossy(&property.value);
            if found.to_lowercase().contains(&title.to_lowercase()) {
                matches.push((window, found.to_string()));
            }
        }
        // Prefer an exact match; never pick an arbitrary window when ambiguous.
        let exact: Vec<_> = matches
            .iter()
            .filter(|(_, name)| name.eq_ignore_ascii_case(title))
            .collect();
        let window = if exact.len() == 1 {
            exact[0].0
        } else if exact.is_empty() && matches.len() == 1 {
            matches[0].0
        } else {
            return Err(invalid(format!(
                "window title has {} matches (expected one)",
                if exact.is_empty() {
                    matches.len()
                } else {
                    exact.len()
                }
            ))
            .into());
        };
        check_stop(self.safety.as_ref())?;
        let (destination, mask, event) = focus_request(self.root, window, active);
        self.conn
            .send_event(false, destination, mask, event)?
            .check()?;
        self.conn.flush()?;
        await_focus(self.safety.as_ref(), window, || {
            observe_focus(&self.conn, self.root, window, active)
        })
    }

    /// Drag a button from start to end in `steps` interpolated moves.
    pub fn drag(
        &self,
        from_x: i16,
        from_y: i16,
        to_x: i16,
        to_y: i16,
        button: u8,
        steps: u16,
    ) -> InputResult<()> {
        if !(1..=7).contains(&button) || steps == 0 {
            return Err(invalid("drag requires a button in 1..=7 and steps > 0").into());
        }
        self.gesture(|g| drag_events(g, from_x, from_y, to_x, to_y, button, steps))
    }

    /// Scroll by X wheel clicks at a desktop coordinate: up/down/left/right.
    pub fn scroll(&self, x: i16, y: i16, direction: &str, amount: u32) -> InputResult<()> {
        let button = match direction.to_ascii_lowercase().as_str() {
            "up" => 4,
            "down" => 5,
            "left" => 6,
            "right" => 7,
            _ => return Err(invalid("scroll direction must be up/down/left/right").into()),
        };
        if amount > 1000 {
            return Err(invalid("scroll amount must be <= 1000").into());
        }
        self.gesture(|g| scroll_events(g, x, y, button, amount))
    }

    fn mapping(&self) -> InputResult<KeyboardMapping> {
        let setup = self.conn.setup();
        let first = setup.min_keycode;
        let count = setup.max_keycode - first + 1;
        let reply = self.conn.get_keyboard_mapping(first, count)?.reply()?;
        Ok(KeyboardMapping {
            first,
            per_keycode: usize::from(reply.keysyms_per_keycode),
            keysyms: reply.keysyms,
        })
    }

    /// Send one X keysym as a complete press/release. Unpaired releases are
    /// forbidden: they might release a key physically held by the user.
    pub fn key_event(&self, keysym: u32, pressed: bool) -> InputResult<()> {
        if !pressed {
            return Err(invalid("unpaired key release is not supported").into());
        }
        let (code, _) = self
            .mapping()?
            .lookup(keysym)
            .ok_or_else(|| invalid(format!("unmapped X keysym: 0x{keysym:x}")))?;
        self.gesture(|g| {
            g.keycode(code, true)?;
            g.keycode(code, false)
        })
    }

    /// Select exactly one paste chord before taking clipboard ownership.
    /// A Latin v in the *active* XKB group permits Ctrl+V; otherwise use the
    /// language-independent Shift+Insert. Never switch the user's layout and
    /// never retry with a second shortcut after any input was dispatched.
    pub fn preflight_paste(&self) -> InputResult<PasteShortcut> {
        check_stop(self.safety.as_ref())?;
        let shortcut = self.choose_paste_shortcut()?;
        let (modifier, key) = shortcut.keycodes();
        self.preflight(KEY_PRESS, modifier)?;
        self.preflight(KEY_PRESS, key)?;
        Ok(shortcut)
    }

    fn choose_paste_shortcut(&self) -> InputResult<PasteShortcut> {
        let mapping = self.mapping()?;
        // If the extension cannot report the active group, never assume that
        // the primary group's Latin v is active. Fail closed to Shift+Insert.
        let group = self
            .conn
            .xkb_use_extension(1, 0)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .filter(|reply| reply.supported)
            .and_then(|_| {
                self.conn
                    .xkb_get_state(u16::from(xkb::ID::USE_CORE_KBD))
                    .ok()
            })
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| u8::from(reply.group));
        select_paste_shortcut(&mapping, group)
    }

    /// Check that both the selected group and keycodes are still the same
    /// immediately before the gesture. An intervening change never triggers
    /// a second shortcut or a language switch.
    pub fn paste(&self, shortcut: PasteShortcut) -> InputResult<()> {
        check_stop(self.safety.as_ref())?;
        if self.choose_paste_shortcut()? != shortcut {
            return Err(
                invalid("paste shortcut keymap or active group changed before input").into(),
            );
        }
        let (modifier, key) = shortcut.keycodes();
        self.gesture(|g| {
            g.keycode(modifier, true)?;
            g.keycode(key, true)?;
            g.keycode(key, false)?;
            g.keycode(modifier, false)
        })
    }

    /// Press a key or chord, e.g. `Enter`, `Ctrl+L`, or `Shift+Tab`.
    pub fn key(&self, key: &str) -> InputResult<()> {
        let parts: Vec<&str> = key.split('+').collect();
        let (last, modifiers) = parts.split_last().ok_or_else(|| invalid("empty key"))?;
        let mapping = self.mapping()?;
        let mut held = Vec::new();
        for modifier in modifiers {
            let symbol = match modifier.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => CTRL,
                "alt" => ALT,
                "shift" => SHIFT,
                "super" | "meta" | "win" => SUPER,
                _ => return Err(invalid(format!("unknown modifier: {modifier}")).into()),
            };
            held.push(
                mapping
                    .lookup(symbol)
                    .ok_or_else(|| invalid(format!("unmapped modifier: {modifier}")))?
                    .0,
            );
        }
        let symbol = named_keysym(last).ok_or_else(|| invalid(format!("unknown key: {last}")))?;
        // Chords conventionally spell Ctrl+L with a capital L but mean the
        // unshifted L key; Ctrl+Shift+L explicitly requests Shift.
        let symbol = if modifiers.iter().any(|m| {
            ["ctrl", "control", "alt", "super", "meta", "win"]
                .iter()
                .any(|name| m.eq_ignore_ascii_case(name))
        }) && last.len() == 1
            && last.as_bytes()[0].is_ascii_uppercase()
        {
            last.as_bytes()[0].to_ascii_lowercase() as u32
        } else {
            symbol
        };
        let (code, needs_shift) = mapping
            .lookup(symbol)
            .ok_or_else(|| invalid(format!("unmapped key: {last}")))?;
        if needs_shift && !modifiers.iter().any(|m| m.eq_ignore_ascii_case("shift")) {
            held.push(
                mapping
                    .lookup(SHIFT)
                    .ok_or_else(|| invalid("unmapped Shift"))?
                    .0,
            );
        }
        // Validate the whole chord before sending any events. Release held keys
        // even if sending the main key fails.
        self.gesture(|g| {
            for &modifier in &held {
                g.keycode(modifier, true)?;
            }
            g.keycode(code, true)?;
            g.keycode(code, false)?;
            for &modifier in held.iter().rev() {
                g.keycode(modifier, false)?;
            }
            Ok(())
        })
    }

    /// Type text through the currently configured X keymap (no clipboard use).
    pub fn type_text(&self, text: &str) -> InputResult<()> {
        validate_physical_text(text)?;
        let mapping = self.mapping()?;
        let keys: Vec<_> = text
            .chars()
            .map(|c| {
                let symbol = char_keysym(c);
                mapping
                    .lookup(symbol)
                    .ok_or_else(|| invalid(format!("character {c:?} not present in X keymap")))
            })
            .collect::<Result<_, _>>()?;
        let shift = if keys.iter().any(|(_, shifted)| *shifted) {
            Some(
                mapping
                    .lookup(SHIFT)
                    .ok_or_else(|| invalid("unmapped Shift"))?
                    .0,
            )
        } else {
            None
        };
        self.gesture(|g| type_events(g, &keys, shift))
    }
}

fn drag_events(
    g: &mut Gesture<'_>,
    from_x: i16,
    from_y: i16,
    to_x: i16,
    to_y: i16,
    button: u8,
    steps: u16,
) -> InputResult<()> {
    g.pointer(from_x, from_y)?;
    g.button(button, true)?;
    for i in 1..=steps {
        g.pointer(
            interpolate(from_x, to_x, i, steps),
            interpolate(from_y, to_y, i, steps),
        )?;
    }
    g.button(button, false)
}

fn scroll_events(g: &mut Gesture<'_>, x: i16, y: i16, button: u8, amount: u32) -> InputResult<()> {
    g.pointer(x, y)?;
    for _ in 0..amount {
        g.button(button, true)?;
        g.button(button, false)?;
    }
    Ok(())
}

fn type_events(g: &mut Gesture<'_>, keys: &[(u8, bool)], shift: Option<u8>) -> InputResult<()> {
    for &(code, shifted) in keys {
        if shifted {
            g.keycode(shift.expect("shift prevalidated"), true)?;
        }
        g.keycode(code, true)?;
        g.keycode(code, false)?;
        if shifted {
            g.keycode(shift.expect("shift prevalidated"), false)?;
        }
    }
    Ok(())
}

/// XTEST keycodes are prepared once; no text character is synthesized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteShortcut {
    CtrlV { ctrl: u8, v: u8 },
    ShiftInsert { shift: u8, insert: u8 },
}
impl PasteShortcut {
    pub fn label(self) -> &'static str {
        match self {
            Self::CtrlV { .. } => "ctrl_v",
            Self::ShiftInsert { .. } => "shift_insert",
        }
    }
    fn keycodes(self) -> (u8, u8) {
        match self {
            Self::CtrlV { ctrl, v } => (ctrl, v),
            Self::ShiftInsert { shift, insert } => (shift, insert),
        }
    }
}
fn select_paste_shortcut(
    mapping: &KeyboardMapping,
    active_group: Option<u8>,
) -> InputResult<PasteShortcut> {
    if let Some(v) =
        active_group.and_then(|group| mapping.lookup_group_unshifted(b'v' as u32, group))
    {
        if let Some((ctrl, _)) = mapping.lookup(CTRL) {
            if ctrl != v {
                return Ok(PasteShortcut::CtrlV { ctrl, v });
            }
        }
    }
    let shift = mapping
        .lookup(SHIFT)
        .ok_or_else(|| invalid("unmapped Shift"))?
        .0;
    let (insert, shifted) = mapping
        .lookup(0xff63)
        .ok_or_else(|| invalid("unmapped Insert"))?;
    if shifted || shift == insert {
        return Err(invalid("unsupported paste chord mapping").into());
    }
    Ok(PasteShortcut::ShiftInsert { shift, insert })
}

fn validate_physical_text(text: &str) -> InputResult<()> {
    if text.chars().count() > 16_384 {
        return Err(invalid("physical text must be <= 16384 characters").into());
    }
    Ok(())
}

fn interpolate(start: i16, end: i16, step: u16, steps: u16) -> i16 {
    (i32::from(start) + (i32::from(end) - i32::from(start)) * i32::from(step) / i32::from(steps))
        as i16
}

fn char_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        '\u{8}' => 0xff08,
        c if (c as u32) <= 0xff => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}

fn named_keysym(key: &str) -> Option<u32> {
    let lower = key.to_ascii_lowercase();
    Some(match lower.as_str() {
        "enter" | "return" => 0xff0d,
        "tab" => 0xff09,
        "backspace" => 0xff08,
        "escape" | "esc" => 0xff1b,
        "space" => 0x20,
        "plus" => 0x2b,
        "delete" | "del" => 0xffff,
        "home" => 0xff50,
        "left" => 0xff51,
        "up" => 0xff52,
        "right" => 0xff53,
        "down" => 0xff54,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        "end" => 0xff57,
        "insert" => 0xff63,
        "f1" => 0xffbe,
        "f2" => 0xffbf,
        "f3" => 0xffc0,
        "f4" => 0xffc1,
        "f5" => 0xffc2,
        "f6" => 0xffc3,
        "f7" => 0xffc4,
        "f8" => 0xffc5,
        "f9" => 0xffc6,
        "f10" => 0xffc7,
        "f11" => 0xffc8,
        "f12" => 0xffc9,
        _ => {
            let mut chars = key.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            char_keysym(c)
        }
    })
}

struct KeyboardMapping {
    first: u8,
    per_keycode: usize,
    keysyms: Vec<u32>,
}

impl KeyboardMapping {
    // XKB groups occupy pairs of columns in the core keymap. Do not guess
    // when the active group has no explicit unshifted Latin v column.
    fn lookup_group_unshifted(&self, symbol: u32, group: u8) -> Option<u8> {
        if self.per_keycode == 0 {
            return None;
        }
        let column = usize::from(group).checked_mul(2)?;
        self.keysyms
            .chunks_exact(self.per_keycode)
            .enumerate()
            .find_map(|(index, columns)| {
                (columns.get(column) == Some(&symbol))
                    .then(|| u8::try_from(usize::from(self.first) + index).ok())
                    .flatten()
            })
    }

    // Columns 0/1 are the unshifted/shifted symbols in the primary group.
    fn lookup(&self, symbol: u32) -> Option<(u8, bool)> {
        if self.per_keycode == 0 {
            return None;
        }
        self.keysyms
            .chunks_exact(self.per_keycode)
            .enumerate()
            .find_map(|(index, columns)| {
                // X permits a zero second column to mean the case-converted first.
                let shifted = if columns.len() > 1 && columns[1] == 0 {
                    char::from_u32(columns[0])
                        .and_then(|c| {
                            let mut uppercase = c.to_uppercase();
                            let upper = uppercase.next()?;
                            (uppercase.next().is_none() && upper != c).then_some(char_keysym(upper))
                        })
                        .unwrap_or(0)
                } else {
                    *columns.get(1).unwrap_or(&0)
                };
                let shift = if columns[0] == symbol {
                    false
                } else if shifted == symbol {
                    true
                } else {
                    return None;
                };
                let code = u8::try_from(usize::from(self.first) + index).ok()?;
                Some((code, shift))
            })
    }
}

#[cfg(test)]
#[path = "focus_isolation_test.rs"]
mod focus_isolation_test;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_primary_group_and_implicit_uppercase() {
        let map = KeyboardMapping {
            first: 8,
            per_keycode: 2,
            keysyms: vec![0x61, 0, 0x31, 0x21],
        };
        assert_eq!(map.lookup(0x61), Some((8, false)));
        assert_eq!(map.lookup(0x41), Some((8, true)));
        assert_eq!(map.lookup(0x21), Some((9, true)));
        assert_eq!(map.lookup(0x42), None);
    }

    #[test]
    fn paste_shortcut_does_not_require_a_latin_letter_in_the_keymap() {
        let map = KeyboardMapping {
            first: 8,
            per_keycode: 4,
            keysyms: vec![SHIFT, 0, 0, 0, 0xff63, 0, 0, 0, 0x0100_0432, 0, 0, 0],
        };
        assert!(map.lookup(b'v' as u32).is_none());
        assert_eq!(
            select_paste_shortcut(&map, Some(0)).unwrap(),
            PasteShortcut::ShiftInsert {
                shift: 8,
                insert: 9
            }
        );
        assert_eq!(
            select_paste_shortcut(&map, None).unwrap(),
            PasteShortcut::ShiftInsert {
                shift: 8,
                insert: 9
            }
        );
    }

    #[test]
    fn paste_selects_only_one_active_group_chord_before_ownership() {
        let map = KeyboardMapping {
            first: 8,
            per_keycode: 4,
            keysyms: vec![
                CTRL,
                0,
                0,
                0,
                SHIFT,
                0,
                0,
                0,
                0xff63,
                0,
                0,
                0,
                b'v' as u32,
                b'V' as u32,
                0x0100_0432,
                0x0100_0412,
            ],
        };
        assert_eq!(
            select_paste_shortcut(&map, Some(0)).unwrap(),
            PasteShortcut::CtrlV { ctrl: 8, v: 11 }
        );
        assert_eq!(
            select_paste_shortcut(&map, Some(1)).unwrap(),
            PasteShortcut::ShiftInsert {
                shift: 9,
                insert: 10
            }
        );
        assert_eq!(
            select_paste_shortcut(&map, None).unwrap(),
            PasteShortcut::ShiftInsert {
                shift: 9,
                insert: 10
            }
        );
        // Also select Ctrl+V when Latin is active only in the second group.
        let mut reverse = map;
        reverse.keysyms[12..16].copy_from_slice(&[
            0x0100_0432,
            0x0100_0412,
            b'v' as u32,
            b'V' as u32,
        ]);
        assert_eq!(
            select_paste_shortcut(&reverse, Some(0)).unwrap(),
            PasteShortcut::ShiftInsert {
                shift: 9,
                insert: 10
            }
        );
        assert_eq!(
            select_paste_shortcut(&reverse, Some(1)).unwrap(),
            PasteShortcut::CtrlV { ctrl: 8, v: 11 }
        );
    }

    #[test]
    fn interpolation_including_negative_positions() {
        assert_eq!(interpolate(-100, 100, 1, 4), -50);
        assert_eq!(interpolate(-100, 100, 4, 4), 100);
        assert_eq!(interpolate(i16::MIN, i16::MAX, 2, 2), i16::MAX);
    }

    #[test]
    fn stop_interrupts_drag_and_releases_only_our_press() {
        let safety = Safety::default();
        let mut events = Vec::new();
        let mut emit = |kind, detail, x, y| {
            events.push((kind, detail, x, y));
            if kind == MOTION && x == 1 {
                safety.stop();
            }
            Ok(())
        };
        let result = with_gesture(Some(&safety), &mut emit, None, |g| {
            drag_events(g, 0, 0, 2, 0, 1, 2)
        });
        assert_eq!(
            result
                .unwrap_err()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::Interrupted
        );
        assert_eq!(
            events,
            [
                (MOTION, 0, 0, 0),
                (BUTTON_PRESS, 1, 0, 0),
                (MOTION, 0, 1, 0),
                (BUTTON_RELEASE, 1, 0, 0)
            ]
        );
    }

    #[test]
    fn error_or_stop_releases_keys_and_modifiers_in_reverse_order() {
        let safety = Safety::default();
        let mut events = Vec::new();
        let mut emit = |kind, detail, _, _| {
            events.push((kind, detail));
            if kind == KEY_PRESS && detail == 42 {
                safety.stop();
                return Err(invalid("ambiguous checked press").into());
            }
            Ok(())
        };
        assert!(with_gesture(Some(&safety), &mut emit, None, |g| {
            g.keycode(37, true)?;
            g.keycode(42, true)?;
            g.keycode(42, false)
        })
        .is_err());
        assert_eq!(
            events,
            [
                (KEY_PRESS, 37),
                (KEY_PRESS, 42),
                (KEY_RELEASE, 42),
                (KEY_RELEASE, 37)
            ]
        );
    }

    #[test]
    fn stop_during_scroll_releases_wheel_and_skips_remaining_clicks() {
        let safety = Safety::default();
        let mut events = Vec::new();
        let mut emit = |kind, detail, _, _| {
            events.push((kind, detail));
            if kind == BUTTON_PRESS {
                safety.stop();
            }
            Ok(())
        };
        assert!(
            with_gesture(Some(&safety), &mut emit, None, |g| scroll_events(
                g, 0, 0, 4, 3
            ))
            .is_err()
        );
        assert_eq!(
            events,
            [(MOTION, 0), (BUTTON_PRESS, 4), (BUTTON_RELEASE, 4)]
        );
    }

    #[test]
    fn stop_during_type_releases_shift_and_character() {
        let safety = Safety::default();
        let mut events = Vec::new();
        let mut emit = |kind, detail, _, _| {
            events.push((kind, detail));
            if kind == KEY_PRESS && detail == 38 {
                safety.stop();
            }
            Ok(())
        };
        assert!(
            with_gesture(Some(&safety), &mut emit, None, |g| type_events(
                g,
                &[(38, true), (39, false)],
                Some(50)
            ))
            .is_err()
        );
        assert_eq!(
            events,
            [
                (KEY_PRESS, 50),
                (KEY_PRESS, 38),
                (KEY_RELEASE, 38),
                (KEY_RELEASE, 50)
            ]
        );
    }

    #[test]
    fn already_stopped_emits_no_events() {
        let safety = Safety::default();
        safety.stop();
        let mut events = Vec::new();
        let mut emit = |kind, detail, _, _| {
            events.push((kind, detail));
            Ok(())
        };
        assert!(
            with_gesture(Some(&safety), &mut emit, None, |g| scroll_events(
                g, 0, 0, 4, 10
            ))
            .is_err()
        );
        assert!(events.is_empty());
    }

    #[test]
    fn preflight_refusal_does_not_release_a_physical_key() {
        let mut events = Vec::new();
        let mut emit = |kind, detail, _, _| {
            events.push((kind, detail));
            Ok(())
        };
        let mut preflight =
            |_: u8, _: u8| -> InputResult<()> { Err(invalid("already held").into()) };
        assert!(with_gesture(None, &mut emit, Some(&mut preflight), |g| g
            .keycode(42, true))
        .is_err());
        assert!(events.is_empty());
    }

    #[test]
    fn physical_text_limit_counts_characters() {
        assert!(validate_physical_text(&"é".repeat(16_384)).is_ok());
        assert!(validate_physical_text(&"é".repeat(16_385)).is_err());
    }

    #[test]
    #[ignore = "requires an X11 server with XTEST"]
    fn connect_to_live_xtest() {
        X11Input::new().unwrap(); // no events sent to the desktop
    }

    #[test]
    fn x11_names_handle_utf8_latin1_and_nul() {
        assert_eq!(
            parse_window_name(b"Mozilla Firefox\0padding", true),
            "Mozilla Firefox"
        );
        assert_eq!(parse_window_name("Café".as_bytes(), true), "Café");
        assert_eq!(parse_window_name(b"Caf\xe9\0junk", false), "Café");
        assert_eq!(parse_window_name(b"", false), "");
    }

    #[test]
    fn key_names_and_unicode() {
        assert_eq!(named_keysym("Ctrl"), None);
        assert_eq!(named_keysym("Enter"), Some(0xff0d));
        assert_eq!(named_keysym("F12"), Some(0xffc9));
        assert_eq!(char_keysym('€'), 0x0100_20ac);
    }
}
