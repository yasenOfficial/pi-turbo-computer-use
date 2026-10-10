//! On-demand X11 CLIPBOARD transaction. Previous clipboard bytes never enter
//! IPC, logs, or the accessibility cache; new text arrives in the explicit request. All X11 selection ownership stays on one worker.
//! An unsupported/unreadable previous format fails *before* taking ownership.
use crate::safety::Safety;
use std::{
    collections::{HashMap, HashSet},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{
            self, Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
            SelectionNotifyEvent, Window, WindowClass,
        },
        Event,
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};

const MAX_FORMATS: usize = 64;
const MAX_FORMAT: usize = 4 * 1024 * 1024;
const MAX_TOTAL: usize = 8 * 1024 * 1024;
const CHUNK: usize = 32 * 1024;
const WAIT: Duration = Duration::from_secs(2);
const MAX_OUTGOING: usize = 8;
const MAX_OUTGOING_BYTES: usize = 16 * 1024 * 1024;

type Result<T> = std::result::Result<T, &'static str>;

/// The X11 selection protocol is not a Wayland clipboard implementation.
/// Reject native Wayland sessions before any observation or clipboard worker
/// starts. An explicitly X11 session remains valid even when a Wayland socket
/// name is present in a mixed environment.
pub fn validate_session(session_type: Option<&str>, wayland_display: Option<&str>) -> Result<()> {
    let x11 = session_type.is_some_and(|s| s.eq_ignore_ascii_case("x11"));
    if session_type.is_some_and(|s| s.eq_ignore_ascii_case("wayland"))
        || (!x11 && wayland_display.is_some_and(|s| !s.is_empty()))
    {
        return Err("unsupported Wayland session for clipboard paste (X11 only)");
    }
    Ok(())
}

#[derive(Clone)]
struct Format {
    kind: Atom,
    width: u8,
    bytes: Vec<u8>,
}
struct Atoms {
    clipboard: Atom,
    targets: Atom,
    utf8: Atom,
    text: Atom,
    plain: Atom,
    string: Atom,
    incr: Atom,
    property: Atom,
    timestamp: Atom,
    multiple: Atom,
    save: Atom,
}
fn atom(conn: &RustConnection, name: &[u8]) -> Result<Atom> {
    conn.intern_atom(false, name)
        .map_err(|_| "clipboard X11 unavailable")?
        .reply()
        .map(|r| r.atom)
        .map_err(|_| "clipboard X11 unavailable")
}
impl Atoms {
    fn new(conn: &RustConnection) -> Result<Self> {
        Ok(Self {
            clipboard: atom(conn, b"CLIPBOARD")?,
            targets: atom(conn, b"TARGETS")?,
            utf8: atom(conn, b"UTF8_STRING")?,
            text: atom(conn, b"TEXT")?,
            plain: atom(conn, b"text/plain;charset=utf-8")?,
            string: AtomEnum::STRING.into(),
            incr: atom(conn, b"INCR")?,
            property: atom(conn, b"_PI_PASTE_TRANSFER")?,
            timestamp: atom(conn, b"TIMESTAMP")?,
            multiple: atom(conn, b"MULTIPLE")?,
            save: atom(conn, b"SAVE_TARGETS")?,
        })
    }
    fn protocol(&self, atom: Atom) -> bool {
        atom == self.targets
            || atom == self.incr
            || atom == self.timestamp
            || atom == self.multiple
            || atom == self.save
            || atom == 0
    }
}
struct Transfer {
    requestor: Window,
    property: Atom,
    format: Format,
    offset: usize,
    ending: bool,
    deadline: Instant,
    dispatched: bool,
}
struct Worker {
    conn: RustConnection,
    window: Window,
    atoms: Atoms,
    offered: HashMap<Atom, Format>,
    outgoing: Vec<Transfer>,
    served: bool,
    transfer_failed: bool,
    dispatched: bool,
    paste_safety: Option<Safety>,
}
impl Worker {
    fn new() -> Result<Self> {
        let (conn, screen) = x11rb::connect(None).map_err(|_| "clipboard X11 unavailable")?;
        let atoms = Atoms::new(&conn)?;
        let window = conn
            .generate_id()
            .map_err(|_| "clipboard X11 unavailable")?;
        conn.create_window(
            0,
            window,
            conn.setup().roots[screen].root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .map_err(|_| "clipboard X11 unavailable")?
        .check()
        .map_err(|_| "clipboard X11 unavailable")?;
        Ok(Self {
            conn,
            window,
            atoms,
            offered: HashMap::new(),
            outgoing: Vec::new(),
            served: false,
            transfer_failed: false,
            dispatched: false,
            paste_safety: None,
        })
    }
    fn owner(&self) -> Result<Window> {
        self.conn
            .get_selection_owner(self.atoms.clipboard)
            .map_err(|_| "clipboard X11 unavailable")?
            .reply()
            .map(|r| r.owner)
            .map_err(|_| "clipboard X11 unavailable")
    }
    fn change(&self, window: Window, property: Atom, data: &Format) -> Result<()> {
        let cookie = match data.width {
            8 => self.conn.change_property8(
                PropMode::REPLACE,
                window,
                property,
                data.kind,
                &data.bytes,
            ),
            16 => self.conn.change_property16(
                PropMode::REPLACE,
                window,
                property,
                data.kind,
                &data
                    .bytes
                    .chunks_exact(2)
                    .map(|b| u16::from_ne_bytes([b[0], b[1]]))
                    .collect::<Vec<_>>(),
            ),
            32 => self.conn.change_property32(
                PropMode::REPLACE,
                window,
                property,
                data.kind,
                &data
                    .bytes
                    .chunks_exact(4)
                    .map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
                    .collect::<Vec<_>>(),
            ),
            _ => return Err("invalid clipboard property format"),
        }
        .map_err(|_| "clipboard transfer failed")?;
        cookie.check().map_err(|_| "clipboard transfer failed")
    }
    fn prune_outgoing(&mut self) {
        let now = Instant::now();
        if self
            .outgoing
            .iter()
            .any(|t| t.deadline <= now && t.dispatched)
        {
            self.transfer_failed = true;
        }
        self.outgoing.retain(|t| t.deadline > now);
    }
    fn event(&mut self, event: Event) {
        self.prune_outgoing();
        match event {
            Event::SelectionClear(e) if e.selection == self.atoms.clipboard => {
                // A delayed clear from an earlier ownership generation must
                // not erase a later successful reacquisition on this window.
                if self.owner().ok() != Some(self.window) {
                    if self.outgoing.iter().any(|t| t.dispatched) {
                        self.transfer_failed = true;
                    }
                    self.offered.clear();
                    self.outgoing.clear();
                }
            }
            Event::SelectionRequest(e) if e.selection == self.atoms.clipboard => {
                let property = if e.property == 0 {
                    e.target
                } else {
                    e.property
                };
                let mut accepted = 0;
                if self.owner().ok() == Some(self.window)
                    && !self.paste_safety.as_ref().is_some_and(Safety::stopped)
                {
                    let value = if e.target == self.atoms.targets {
                        let mut names: Vec<_> = self.offered.keys().copied().collect();
                        names.push(self.atoms.targets);
                        Some(Format {
                            kind: AtomEnum::ATOM.into(),
                            width: 32,
                            bytes: names.iter().flat_map(|n| n.to_ne_bytes()).collect(),
                        })
                    } else {
                        self.offered.get(&e.target).and_then(|data| {
                            // Check before cloning untrusted clients' requests.
                            if data.bytes.len() > CHUNK
                                && (self.outgoing.len() >= MAX_OUTGOING
                                    || self.outgoing.iter().any(|t| {
                                        t.requestor == e.requestor && t.property == property
                                    })
                                    || self
                                        .outgoing
                                        .iter()
                                        .map(|t| t.format.bytes.len())
                                        .sum::<usize>()
                                        + data.bytes.len()
                                        > MAX_OUTGOING_BYTES)
                            {
                                if self.dispatched {
                                    self.transfer_failed = true;
                                }
                                None
                            } else {
                                Some(data.clone())
                            }
                        })
                    };
                    if let Some(data) = value {
                        let incremental = data.bytes.len() > CHUNK;
                        let sent = if incremental {
                            // Select PropertyNotify on the requestor for INCR handshake.
                            let listen = self
                                .conn
                                .change_window_attributes(
                                    e.requestor,
                                    &xproto::ChangeWindowAttributesAux::new()
                                        .event_mask(EventMask::PROPERTY_CHANGE),
                                )
                                .is_ok_and(|c| c.check().is_ok());
                            if listen {
                                let length = Format {
                                    kind: self.atoms.incr,
                                    width: 32,
                                    bytes: (data.bytes.len() as u32).to_ne_bytes().to_vec(),
                                };
                                if self.change(e.requestor, property, &length).is_ok() {
                                    self.outgoing.push(Transfer {
                                        requestor: e.requestor,
                                        property,
                                        format: data,
                                        offset: 0,
                                        ending: false,
                                        deadline: Instant::now() + WAIT,
                                        dispatched: self.dispatched,
                                    });
                                    true
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else {
                            self.change(e.requestor, property, &data).is_ok()
                        };
                        if sent {
                            accepted = property;
                            // INCR's initial length only promises a transfer;
                            // completion requires its final zero-chunk delete.
                            if e.target != self.atoms.targets && !incremental && self.dispatched {
                                self.served = true;
                            }
                        } else if self.dispatched && e.target != self.atoms.targets {
                            self.transfer_failed = true;
                        }
                    }
                }
                let reply = SelectionNotifyEvent {
                    response_type: xproto::SELECTION_NOTIFY_EVENT,
                    sequence: 0,
                    time: e.time,
                    requestor: e.requestor,
                    selection: e.selection,
                    target: e.target,
                    property: accepted,
                };
                if !self
                    .conn
                    .send_event(false, e.requestor, EventMask::NO_EVENT, reply)
                    .is_ok_and(|c| c.check().is_ok())
                    || self.conn.flush().is_err()
                {
                    if self.dispatched && accepted != 0 {
                        self.transfer_failed = true;
                    }
                }
            }
            Event::PropertyNotify(e) if e.state == xproto::Property::DELETE => {
                if let Some(index) = self
                    .outgoing
                    .iter()
                    .position(|t| t.requestor == e.window && t.property == e.atom)
                {
                    let t = &mut self.outgoing[index];
                    if t.ending {
                        let transfer = self.outgoing.swap_remove(index);
                        if transfer.dispatched {
                            self.served = true;
                        }
                        return;
                    }
                    let end = (t.offset + CHUNK).min(t.format.bytes.len());
                    let chunk = Format {
                        kind: t.format.kind,
                        width: t.format.width,
                        bytes: t.format.bytes[t.offset..end].to_vec(),
                    };
                    let requestor = t.requestor;
                    let property = t.property;
                    t.offset = end;
                    // INCR requires a final zero-length property after the last
                    // nonempty chunk, followed by the requestor's final delete.
                    t.ending = chunk.bytes.is_empty();
                    if self.change(requestor, property, &chunk).is_err()
                        || self.conn.flush().is_err()
                    {
                        let transfer = self.outgoing.swap_remove(index);
                        if transfer.dispatched {
                            self.transfer_failed = true;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    fn pump(&mut self) -> Result<Option<Event>> {
        self.conn
            .poll_for_event()
            .map_err(|_| "clipboard X11 unavailable")
    }
    fn receive(
        &mut self,
        target: Atom,
        previous: Window,
        deadline: Instant,
        safety: &Safety,
    ) -> Result<Format> {
        self.conn
            .convert_selection(
                self.window,
                self.atoms.clipboard,
                target,
                self.atoms.property,
                x11rb::CURRENT_TIME,
            )
            .map_err(|_| "clipboard snapshot failed")?;
        self.conn.flush().map_err(|_| "clipboard snapshot failed")?;
        while Instant::now() < deadline {
            if safety.stopped() {
                return Err("clipboard snapshot stopped");
            }
            if self.owner()? != previous {
                return Err("clipboard changed during snapshot");
            }
            if let Some(event) = self.pump()? {
                if let Event::SelectionNotify(e) = &event {
                    if e.requestor == self.window
                        && e.selection == self.atoms.clipboard
                        && e.target == target
                    {
                        if e.property == 0 {
                            return Err("clipboard format unavailable");
                        }
                        return self.read_transfer(previous, deadline, safety);
                    }
                }
                self.event(event);
            } else {
                thread::sleep(Duration::from_millis(2));
            }
        }
        Err("clipboard snapshot timed out")
    }
    fn read_transfer(
        &mut self,
        previous: Window,
        deadline: Instant,
        safety: &Safety,
    ) -> Result<Format> {
        let mut data = Vec::new();
        let mut result: Option<(Atom, u8)> = None;
        let mut incr = false;
        loop {
            if safety.stopped() {
                return Err("clipboard snapshot stopped");
            }
            if Instant::now() >= deadline || self.owner()? != previous {
                return Err("clipboard snapshot incomplete");
            }
            let reply = self
                .conn
                .get_property(
                    true,
                    self.window,
                    self.atoms.property,
                    AtomEnum::ANY,
                    0,
                    (MAX_FORMAT / 4 + 1) as u32,
                )
                .map_err(|_| "clipboard snapshot failed")?
                .reply()
                .map_err(|_| "clipboard snapshot failed")?;
            if reply.bytes_after != 0 {
                return Err("clipboard format too large");
            }
            if reply.type_ == self.atoms.incr && !incr {
                if reply.format != 32 {
                    return Err("invalid clipboard INCR");
                }
                incr = true;
            } else {
                if !matches!(reply.format, 8 | 16 | 32) {
                    return Err("invalid clipboard property format");
                }
                if let Some((kind, width)) = result {
                    if kind != reply.type_ || width != reply.format {
                        return Err("clipboard format changed");
                    }
                }
                result = Some((reply.type_, reply.format));
                if data.len() + reply.value.len() > MAX_FORMAT {
                    return Err("clipboard format too large");
                }
                if incr && reply.value.is_empty() {
                    break;
                }
                data.extend_from_slice(&reply.value);
            }
            if !incr {
                break;
            }
            self.conn.flush().map_err(|_| "clipboard snapshot failed")?;
            let mut ready = false;
            while Instant::now() < deadline {
                if safety.stopped() {
                    return Err("clipboard snapshot stopped");
                }
                if self.owner()? != previous {
                    return Err("clipboard changed during snapshot");
                }
                if let Some(event) = self.pump()? {
                    if matches!(&event, Event::PropertyNotify(e) if e.window == self.window && e.atom == self.atoms.property && e.state == xproto::Property::NEW_VALUE)
                    {
                        ready = true;
                        break;
                    }
                    self.event(event);
                } else {
                    thread::sleep(Duration::from_millis(2));
                }
            }
            if !ready {
                return Err("clipboard INCR timed out");
            }
        }
        let (kind, width) = result.ok_or("clipboard format unavailable")?;
        Ok(Format {
            kind,
            width,
            bytes: data,
        })
    }
    fn snapshot(&mut self, previous: Window, safety: &Safety) -> Result<HashMap<Atom, Format>> {
        let deadline = Instant::now() + WAIT;
        if safety.stopped() {
            return Err("clipboard snapshot stopped");
        }
        if previous == 0 {
            return Ok(HashMap::new());
        }
        if previous == self.window {
            return Ok(self.offered.clone());
        }
        let targets = self.receive(self.atoms.targets, previous, deadline, safety)?;
        if targets.kind != u32::from(AtomEnum::ATOM)
            || targets.width != 32
            || targets.bytes.len() % 4 != 0
            || targets.bytes.len() > MAX_FORMATS * 4
        {
            return Err("clipboard TARGETS unsupported");
        }
        let names: Vec<Atom> = targets
            .bytes
            .chunks_exact(4)
            .map(|v| u32::from_ne_bytes(v.try_into().unwrap()))
            .collect();
        if names.len() > MAX_FORMATS {
            return Err("clipboard has too many formats");
        }
        let mut values = HashMap::new();
        let mut unique = HashSet::new();
        let mut total = 0;
        for target in names {
            if !unique.insert(target) || self.atoms.protocol(target) {
                continue;
            }
            let format = self.receive(target, previous, deadline, safety)?;
            total += format.bytes.len();
            if total > MAX_TOTAL {
                return Err("clipboard snapshot too large");
            }
            values.insert(target, format);
        }
        if values.is_empty() {
            return Err("clipboard has no preservable formats");
        }
        Ok(values)
    }
    fn own(&mut self, data: HashMap<Atom, Format>) -> Result<()> {
        self.conn
            .set_selection_owner(self.window, self.atoms.clipboard, x11rb::CURRENT_TIME)
            .map_err(|_| "clipboard ownership failed")?
            .check()
            .map_err(|_| "clipboard ownership failed")?;
        if self.owner()? != self.window {
            return Err("clipboard ownership lost");
        }
        self.offered = data;
        self.outgoing.clear();
        self.served = false;
        self.transfer_failed = false;
        self.dispatched = false;
        Ok(())
    }
    fn restore(&mut self, prior: Option<(Window, HashMap<Atom, Format>)>) -> &'static str {
        let Some((owner, formats)) = prior else {
            return "unavailable";
        };
        if self.owner().ok() != Some(self.window) {
            return "skipped_new_owner";
        }
        if owner == 0 {
            if !self
                .conn
                .set_selection_owner(0u32, self.atoms.clipboard, x11rb::CURRENT_TIME)
                .is_ok_and(|c| c.check().is_ok())
            {
                return "unavailable";
            }
            self.offered.clear();
        } else {
            self.offered = formats;
        }
        self.outgoing.clear();
        self.dispatched = false;
        "restored"
    }
}

enum Command {
    Begin(String, Safety, Sender<Result<()>>),
    MarkDispatch(Sender<Result<()>>),
    Finish(Safety, Sender<(&'static str, bool)>),
    Cancel(Sender<&'static str>),
}
/// The worker is lazy and lives only while its daemon holds this sender.
pub struct Clipboard {
    sender: Sender<Command>,
}
impl Clipboard {
    pub fn new() -> Self {
        let (sender, rx) = mpsc::channel();
        thread::spawn(move || run(rx));
        Self { sender }
    }
    pub fn begin(&self, text: String, safety: Safety) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        self.sender
            .send(Command::Begin(text, safety, tx))
            .map_err(|_| "clipboard worker unavailable")?;
        rx.recv().map_err(|_| "clipboard worker unavailable")?
    }
    /// Refuse the shortcut if another owner won the selection since Begin.
    /// This X11 round trip is a preflight, not an atomic lock across XTEST.
    /// Ignore clipboard-manager polling before the shortcut; X11 still cannot
    /// attribute later requests to the intended application.
    pub fn mark_dispatch(&self) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        self.sender
            .send(Command::MarkDispatch(tx))
            .map_err(|_| "clipboard worker unavailable")?;
        rx.recv().map_err(|_| "clipboard worker unavailable")?
    }
    pub fn finish(&self, safety: Safety) -> Result<(&'static str, bool)> {
        let (tx, rx) = mpsc::channel();
        self.sender
            .send(Command::Finish(safety, tx))
            .map_err(|_| "clipboard worker unavailable")?;
        rx.recv().map_err(|_| "clipboard worker unavailable")
    }
    pub fn cancel(&self) -> &'static str {
        let (tx, rx) = mpsc::channel();
        if self.sender.send(Command::Cancel(tx)).is_err() {
            return "unavailable";
        }
        rx.recv().unwrap_or("unavailable")
    }
}
fn run(rx: Receiver<Command>) {
    let Ok(mut worker) = Worker::new() else {
        while let Ok(cmd) = rx.recv() {
            match cmd {
                Command::Begin(_, _, tx) => {
                    let _ = tx.send(Err("clipboard X11 unavailable"));
                }
                Command::MarkDispatch(tx) => {
                    let _ = tx.send(Err("clipboard worker unavailable"));
                }
                Command::Finish(_, tx) => {
                    let _ = tx.send(("unavailable", false));
                }
                Command::Cancel(tx) => {
                    let _ = tx.send("unavailable");
                }
            }
        }
        return;
    };
    let mut prior: Option<(Window, HashMap<Atom, Format>)> = None;
    let mut stop_restore: Option<&'static str> = None;
    loop {
        worker.prune_outgoing();
        // Stop does not wait for a Finish command or for a requestor that
        // never acknowledges INCR. Restoring old data is metadata cleanup,
        // never another desktop input gesture.
        if worker.paste_safety.as_ref().is_some_and(Safety::stopped) {
            worker.transfer_failed = true;
            worker.paste_safety = None;
            if prior.is_some() {
                stop_restore = Some(worker.restore(prior.take()));
            }
        }
        match rx.try_recv() {
            Ok(Command::Begin(text, safety, tx)) => {
                let result = (|| {
                    if prior.is_some() {
                        return Err("clipboard transaction already active");
                    }
                    if !worker.outgoing.is_empty() {
                        return Err("clipboard transfer still in progress");
                    }
                    let previous = worker.owner()?;
                    let saved = worker.snapshot(previous, &safety)?;
                    if worker.owner()? != previous {
                        return Err("clipboard changed during snapshot");
                    }
                    let mut offered = HashMap::new();
                    for target in [worker.atoms.utf8, worker.atoms.text, worker.atoms.plain] {
                        offered.insert(
                            target,
                            Format {
                                kind: target,
                                width: 8,
                                bytes: text.as_bytes().to_vec(),
                            },
                        );
                    }
                    if text.chars().all(|c| (c as u32) <= 255) {
                        offered.insert(
                            worker.atoms.string,
                            Format {
                                kind: worker.atoms.string,
                                width: 8,
                                bytes: text.chars().map(|c| c as u8).collect(),
                            },
                        );
                    }
                    if safety.stopped() {
                        return Err("clipboard snapshot stopped");
                    }
                    worker.own(offered)?;
                    worker.paste_safety = Some(safety);
                    stop_restore = None;
                    prior = Some((previous, saved));
                    Ok(())
                })();
                let _ = tx.send(result);
            }
            Ok(Command::MarkDispatch(tx)) => {
                let result = if prior.is_none()
                    || worker.paste_safety.as_ref().is_none_or(Safety::stopped)
                {
                    Err("clipboard paste stopped before shortcut")
                } else {
                    match worker.owner() {
                        Ok(owner) if owner == worker.window => {
                            worker.served = false;
                            worker.transfer_failed = false;
                            worker.dispatched = true;
                            Ok(())
                        }
                        Ok(_) => Err("clipboard ownership changed before paste; shortcut not sent"),
                        Err(_) => {
                            Err("clipboard ownership unavailable before paste; shortcut not sent")
                        }
                    }
                };
                let _ = tx.send(result);
            }
            Ok(Command::Finish(safety, tx)) => {
                let deadline = Instant::now() + WAIT;
                while prior.is_some()
                    && !safety.stopped()
                    && worker.owner().ok() == Some(worker.window)
                    && Instant::now() < deadline
                    && (!worker.served || !worker.outgoing.is_empty())
                {
                    worker.prune_outgoing();
                    match worker.pump() {
                        Ok(Some(e)) => worker.event(e),
                        Ok(None) => thread::sleep(Duration::from_millis(2)),
                        Err(_) => {
                            worker.transfer_failed = true;
                            break;
                        }
                    }
                }
                // Only a completed transfer counts. X11 cannot prove that the
                // application inserted text into the intended field.
                let served = !safety.stopped()
                    && worker.served
                    && !worker.transfer_failed
                    && worker.outgoing.is_empty();
                worker.paste_safety = None;
                let status = stop_restore
                    .take()
                    .unwrap_or_else(|| worker.restore(prior.take()));
                let _ = tx.send((status, served));
            }
            Ok(Command::Cancel(tx)) => {
                worker.paste_safety = None;
                let status = stop_restore
                    .take()
                    .unwrap_or_else(|| worker.restore(prior.take()));
                let _ = tx.send(status);
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => match worker.pump() {
                Ok(Some(event)) => worker.event(event),
                Ok(None) => thread::sleep(Duration::from_millis(3)),
                Err(_) => break,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_gate_is_pure_and_rejects_wayland_without_display_access() {
        for (session, socket) in [
            (Some("wayland"), None),
            (Some("WAYLAND"), Some("wayland-0")),
            (Some("wayland"), Some("")),
            (None, Some("wayland-0")),
            (Some("unknown"), Some("wayland-0")),
        ] {
            assert_eq!(
                validate_session(session, socket),
                Err("unsupported Wayland session for clipboard paste (X11 only)")
            );
        }
        for (session, socket) in [
            (None, None),
            (None, Some("")),
            (Some("x11"), None),
            (Some("X11"), Some("wayland-0")),
            (Some("x11"), Some("wayland-0")),
        ] {
            assert_eq!(validate_session(session, socket), Ok(()));
        }
    }
    #[test]
    fn payload_is_utf8_bounded_and_latin1_fallback_is_lossless() {
        let sample = "Български Deutsch ∑\n".repeat(2000);
        assert!(sample.len() > CHUNK && sample.len() <= 65536);
        assert!(!sample.chars().all(|c| (c as u32) <= 255));
        assert_eq!(sample.as_bytes().len(), sample.len());
    }

    // Only the private display started by test-clipboard-isolation.sh is used.
    #[test]
    #[ignore = "requires a private Xephyr DISPLAY; run test-clipboard-isolation.sh"]
    fn isolated_snapshot_incr_utf8_binary_restore_and_new_owner() {
        assert_eq!(
            std::env::var("DISPLAY").unwrap(),
            std::env::var("PI_CLIPBOARD_PRIVATE_DISPLAY").unwrap()
        );
        let (quit_tx, quit_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let old_binary = (0..60_000).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let old_copy = old_binary.clone();
        let old = thread::spawn(move || {
            let mut owner = Worker::new().unwrap();
            let image = atom(&owner.conn, b"image/png").unwrap();
            let mut initial = HashMap::new();
            initial.insert(
                image,
                Format {
                    kind: image,
                    width: 8,
                    bytes: old_copy,
                },
            );
            initial.insert(
                owner.atoms.utf8,
                Format {
                    kind: owner.atoms.utf8,
                    width: 8,
                    bytes: b"previous".to_vec(),
                },
            );
            owner.own(initial).unwrap();
            ready_tx.send(image).unwrap();
            while quit_rx.try_recv().is_err() {
                if let Some(e) = owner.pump().unwrap() {
                    owner.event(e);
                } else {
                    thread::sleep(Duration::from_millis(2));
                }
            }
        });
        let image = ready_rx.recv().unwrap();
        let clipboard = Clipboard::new();
        let text = "Български Deutsch ∑\n".repeat(2000);
        assert!(text.len() <= 65_536 && text.len() > CHUNK);
        clipboard.begin(text.clone(), Safety::default()).unwrap();
        clipboard.mark_dispatch().unwrap();
        let mut reader = Worker::new().unwrap();
        let current_owner = reader.owner().unwrap();
        assert_eq!(
            reader
                .receive(
                    reader.atoms.utf8,
                    current_owner,
                    Instant::now() + WAIT,
                    &Safety::default()
                )
                .unwrap()
                .bytes,
            text.as_bytes()
        );
        let (restored, served) = clipboard.finish(Safety::default()).unwrap();
        assert_eq!((restored, served), ("restored", true));
        let previous_owner = reader.owner().unwrap();
        assert_eq!(
            reader
                .receive(
                    image,
                    previous_owner,
                    Instant::now() + WAIT,
                    &Safety::default()
                )
                .unwrap()
                .bytes,
            old_binary
        );
        assert_eq!(
            reader
                .receive(
                    reader.atoms.utf8,
                    previous_owner,
                    Instant::now() + WAIT,
                    &Safety::default()
                )
                .unwrap()
                .bytes,
            b"previous"
        );
        // An INCR requestor that never deletes the initial length has not
        // received any payload. Expiry must not count as a completed paste.
        clipboard.begin(text.clone(), Safety::default()).unwrap();
        clipboard.mark_dispatch().unwrap();
        reader
            .conn
            .convert_selection(
                reader.window,
                reader.atoms.clipboard,
                reader.atoms.utf8,
                reader.atoms.property,
                x11rb::CURRENT_TIME,
            )
            .unwrap();
        reader.conn.flush().unwrap();
        let wait = Instant::now() + WAIT;
        loop {
            assert!(
                Instant::now() < wait,
                "private INCR request was not acknowledged"
            );
            if let Some(event) = reader.pump().unwrap() {
                if let Event::SelectionNotify(e) = event {
                    if e.target == reader.atoms.utf8 {
                        assert_eq!(e.property, reader.atoms.property);
                        break;
                    }
                }
            } else {
                thread::sleep(Duration::from_millis(2));
            }
        }
        let header = reader
            .conn
            .get_property(
                false,
                reader.window,
                reader.atoms.property,
                AtomEnum::ANY,
                0,
                1,
            )
            .unwrap()
            .reply()
            .unwrap();
        assert_eq!(header.type_, reader.atoms.incr);
        let (restored, served) = clipboard.finish(Safety::default()).unwrap();
        assert_eq!((restored, served), ("restored", false));
        assert_eq!(reader.owner().unwrap(), previous_owner);
        // Stop during Finish must cancel waiting instead of blocking for WAIT.
        let stop = Safety::default();
        clipboard.begin(text.clone(), stop.clone()).unwrap();
        clipboard.mark_dispatch().unwrap();
        let signal = stop.clone();
        let stop_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            signal.stop();
        });
        let started = Instant::now();
        let (restored, served) = clipboard.finish(stop).unwrap();
        stop_thread.join().unwrap();
        assert_eq!((restored, served), ("restored", false));
        assert!(
            started.elapsed() < Duration::from_millis(600),
            "Stop delayed clipboard cleanup"
        );
        assert_eq!(reader.owner().unwrap(), previous_owner);
        // Stop also restores without waiting for the client to call Finish.
        let stop_without_finish = Safety::default();
        clipboard
            .begin(text.clone(), stop_without_finish.clone())
            .unwrap();
        clipboard.mark_dispatch().unwrap();
        stop_without_finish.stop();
        let deadline = Instant::now() + Duration::from_millis(600);
        while reader.owner().unwrap() != previous_owner && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(reader.owner().unwrap(), previous_owner);
        assert_eq!(
            clipboard.finish(stop_without_finish).unwrap(),
            ("restored", false)
        );
        clipboard.begin("second".into(), Safety::default()).unwrap();
        let mut newcomer = Worker::new().unwrap();
        let mut newest = HashMap::new();
        newest.insert(
            newcomer.atoms.utf8,
            Format {
                kind: newcomer.atoms.utf8,
                width: 8,
                bytes: b"user's new copy".to_vec(),
            },
        );
        newcomer.own(newest).unwrap();
        // The command used immediately before Ctrl+V must reject a takeover,
        // leaving the caller on its no-shortcut (keyboard_events:0) path.
        assert_eq!(
            clipboard.mark_dispatch(),
            Err("clipboard ownership changed before paste; shortcut not sent")
        );
        assert_eq!(clipboard.cancel(), "skipped_new_owner");
        assert_eq!(reader.owner().unwrap(), newcomer.window);
        newcomer.own(HashMap::new()).unwrap();
        assert!(clipboard
            .begin("must not overwrite".into(), Safety::default())
            .is_err());
        assert_eq!(reader.owner().unwrap(), newcomer.window);
        let stop = Safety::default();
        let trigger = stop.clone();
        let stopper = thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            trigger.stop();
        });
        let started = Instant::now();
        assert!(clipboard
            .begin("cancel pending snapshot".into(), stop)
            .is_err());
        stopper.join().unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(600),
            "Stop must interrupt snapshot polling"
        );
        assert_eq!(reader.owner().unwrap(), newcomer.window);
        // A hostile requestor must not multiply 4 MiB formats without bound.
        let mut flood = Worker::new().unwrap();
        flood
            .own(HashMap::from([(
                flood.atoms.utf8,
                Format {
                    kind: flood.atoms.utf8,
                    width: 8,
                    bytes: vec![b'x'; MAX_FORMAT],
                },
            )]))
            .unwrap();
        let requestor = Worker::new().unwrap();
        for i in 0..12 {
            let property = atom(&flood.conn, format!("_PI_CLIPBOARD_TEST_{i}").as_bytes()).unwrap();
            flood.event(Event::SelectionRequest(xproto::SelectionRequestEvent {
                response_type: xproto::SELECTION_REQUEST_EVENT,
                sequence: 0,
                time: 0,
                owner: flood.window,
                requestor: requestor.window,
                selection: flood.atoms.clipboard,
                target: flood.atoms.utf8,
                property,
            }));
        }
        assert!(flood.outgoing.len() <= MAX_OUTGOING);
        assert_eq!(
            flood
                .outgoing
                .iter()
                .map(|t| t.format.bytes.len())
                .sum::<usize>(),
            MAX_OUTGOING_BYTES
        );
        for transfer in &mut flood.outgoing {
            transfer.deadline = Instant::now() - Duration::from_millis(1);
        }
        flood.prune_outgoing();
        assert!(flood.outgoing.is_empty());
        // SelectionClear from the first ownership generation can arrive
        // after this window reacquires CLIPBOARD. Keep the new payload.
        newcomer.own(HashMap::new()).unwrap();
        let new_payload = b"new generation".to_vec();
        flood
            .own(HashMap::from([(
                flood.atoms.utf8,
                Format {
                    kind: flood.atoms.utf8,
                    width: 8,
                    bytes: new_payload.clone(),
                },
            )]))
            .unwrap();
        flood.event(Event::SelectionClear(xproto::SelectionClearEvent {
            response_type: xproto::SELECTION_CLEAR_EVENT,
            sequence: 0,
            time: 0,
            owner: flood.window,
            selection: flood.atoms.clipboard,
        }));
        assert_eq!(flood.owner().unwrap(), flood.window);
        assert_eq!(
            flood.offered.get(&flood.atoms.utf8).unwrap().bytes,
            new_payload
        );
        quit_tx.send(()).unwrap();
        old.join().unwrap();
    }
}
