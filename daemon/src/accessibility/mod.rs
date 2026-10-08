//! AT-SPI application tree over the accessibility D-Bus (not the session bus).
use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::Notify, time::timeout};
use zbus::{proxy::CacheProperties, zvariant::OwnedObjectPath, Connection, Proxy};

use crate::state::{Bounds, Cache, Node, NodeIds};

const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const ACTION: &str = "org.a11y.atspi.Action";
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
const TEXT: &str = "org.a11y.atspi.Text";
const VALUE: &str = "org.a11y.atspi.Value";
const ROOT_BUS: &str = "org.a11y.atspi.Registry";
const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const REGISTRY_PATH: &str = "/org/a11y/atspi/registry";

// zbus's default lazy property cache sends Properties.GetAll on the first
// get_property. Some AT-SPI implementations cannot serialize every advertised
// property into a{sv}; asking for only the needed property with Get avoids
// forcing unrelated getters (and avoids a crash in the remote process).
// Apply this to *every* proxy, including root, registry and bus proxies, so
// none can start an automatic GetAll during construction or later reads.
async fn atspi_proxy<'a>(
    connection: &Connection,
    destination: &'a str,
    path: &'a str,
    interface: &'a str,
) -> zbus::Result<Proxy<'a>> {
    zbus::proxy::Builder::<Proxy<'a>>::new(connection)
        .destination(destination)?
        .path(path)?
        .interface(interface)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}
// AT-SPI event names use the registry's colon-separated namespace, not the
// D-Bus signal interface names. An empty suffix subscribes to the whole class.
const EVENT_INTERESTS: [&str; 3] = ["object:", "focus:", "window:"];
const UNREGISTERED_RESCAN: Duration = Duration::from_secs(1);
const MAX_NODES: usize = 600;
// GTK source views can sit below split panes, scrollers and tab containers.
// Keep the node cap; depth alone should not exclude a focused editor.
const MAX_DEPTH: usize = 24;
const CALL_TIMEOUT: Duration = Duration::from_millis(450);
// Probe only the verified Cinnamon shell stage, never the desktop in general.
// A menu outside this small search remains undiscovered rather than inventing UI.
const CINNAMON_PROBE_NODES: usize = 64;
const CINNAMON_PROBE_DEPTH: usize = 12;
// Includes identity queries as well as the tree walk. Timeout drops the
// in-flight D-Bus call and treats the menu as unverified, not as present.
const CINNAMON_PROBE_TIMEOUT: Duration = Duration::from_millis(180);

// AT-SPI StateType indices (not bit flags). GetState returns two u32 words.
const ACTIVE: u32 = 1;
const EDITABLE: u32 = 7;
const ENABLED: u32 = 8;
const FOCUSED: u32 = 12;
const SHOWING: u32 = 25;

fn has_state(words: &[u32], state: u32) -> bool {
    words
        .get((state / 32) as usize)
        .is_some_and(|word| word & (1u32 << (state % 32)) != 0)
}

// Skip state/interface/action queries for layout and static content: there can
// be hundreds of those in a single window. Entry/text queries are similarly
// limited to controls that may actually expose a value.
fn is_actionable(role: &str) -> bool {
    matches!(
        role,
        "push button"
            | "toggle button"
            | "check box"
            | "radio button"
            | "link"
            | "page tab"
            | "menu item"
            | "check menu item"
            | "radio menu item"
            | "combo box"
            | "list item"
            | "tree item"
            | "slider"
            | "spin button"
            | "entry"
            | "password text"
            | "text"
    )
}

fn is_text_control(role: &str, states: Option<&[u32]>) -> bool {
    role == "entry" || (role == "text" && states.is_some_and(|s| has_state(s, EDITABLE)))
}

// Only explicit non-showing popup/choice roles are safe to collapse. In
// particular, a GTK panel or scrolled window with no extents (or an unreliable
// SHOWING flag) may still contain the live source view. Keep the root node so
// its name and actions remain available when the popup is closed.
fn choice_branch(role: &str) -> bool {
    matches!(
        role,
        "menu"
            | "popup menu"
            | "menu item"
            | "check menu item"
            | "radio menu item"
            | "list"
            | "table"
            | "table row"
            | "tree"
    )
}

fn prune_descendants(role: &str, states: Option<&[u32]>) -> bool {
    choice_branch(role) && states.is_some_and(|s| !has_state(s, SHOWING))
}

// Even a showing language selector can have hundreds of table cells. Walk
// other branches first, then return to those cells if the budget permits.
fn defer_descendants(role: &str) -> bool {
    choice_branch(role) || role == "menu bar"
}

// A large *showing* selector can fill the deferred queue before a deeper
// editor is discovered. Drop the least urgent queued cells to reserve slots
// for the main tree; dangling child IDs are removed at snapshot commit.
fn reserve_slot<T>(
    normal: bool,
    main: &VecDeque<T>,
    deferred: &mut VecDeque<T>,
    emitted: usize,
) -> bool {
    if normal {
        while emitted + main.len() + deferred.len() >= MAX_NODES && !deferred.is_empty() {
            deferred.pop_back();
        }
    }
    emitted + main.len() + deferred.len() < MAX_NODES
}

type Reference = (String, OwnedObjectPath);

struct WindowCandidate {
    app: Reference,
    window: Reference,
    role: String,
    active: bool,
    focused: bool,
    showing: bool,
    shell_menu: bool,
}

// Accept only AT-SPI state on real shell descendants. A focused, showing
// editable search field is useful even if the popup has no MENU role; an idle
// shell stage (or an invisible/unknown-state entry) is not menu evidence.
async fn bounded_shell_probe(probe: impl Future<Output = bool>, budget: Duration) -> bool {
    timeout(budget, probe).await.unwrap_or(false)
}

fn cinnamon_menu_signal(role: &str, states: &[u32]) -> bool {
    has_state(states, SHOWING)
        && (matches!(role, "menu" | "popup menu")
            || (matches!(role, "entry" | "text")
                && has_state(states, FOCUSED)
                && (role == "entry" || has_state(states, EDITABLE))))
}

// An application can keep ACTIVE set on a background window. Include all
// reported active windows (even when SHOWING is unreliable), but never let
// unrelated app trees consume the node budget. A newly shown dialog can be
// visible before it gains ACTIVE (or if the user focuses another app), so
// include showing dialogs even when a different window is active. If none is
// active, use showing windows rather than returning an empty desktop.
fn selected_windows(windows: &[WindowCandidate]) -> Vec<usize> {
    let active = windows.iter().any(|w| w.active);
    let mut selected: Vec<_> = windows
        .iter()
        .enumerate()
        .filter(|(_, w)| {
            if active {
                w.active
                    || (w.showing && w.shell_menu)
                    || (w.showing && matches!(w.role.as_str(), "dialog" | "alert" | "file chooser"))
            } else {
                w.showing
            }
        })
        .map(|(index, _)| index)
        .collect();
    selected.sort_by_key(|&i| (!windows[i].focused, !windows[i].active, i));
    selected
}

// Unknown display titles or AT-SPI identities must never suppress a window.
fn background_hint(active_title: Option<&str>) -> bool {
    active_title.is_some_and(|title| !title.is_empty() && title != "Desktop")
}

fn background_desktop_only(
    active_title: Option<&str>,
    selected: &[(&str, &str, &str)],
    shell_menu: bool,
) -> bool {
    !shell_menu
        && background_hint(active_title)
        && !selected.is_empty()
        && selected.iter().all(|&(app, role, name)| {
            (app.eq_ignore_ascii_case("cinnamon") && role == "window" && name.is_empty())
                || ((app.eq_ignore_ascii_case("nemo") || app.eq_ignore_ascii_case("nemo-desktop"))
                    && role == "frame"
                    && name == "Desktop")
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Change {
    Full,
    Node {
        bus: String,
        path: OwnedObjectPath,
        kind: ChangeKind,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ChangeKind {
    Name,
    Value,
    State,
    Focus,
    Bounds,
}

// The queue and full-scan marker share a lock. Draining before a refresh
// cannot erase signals that arrive while the refresh is in flight.
fn enqueue(queue: &Mutex<VecDeque<Change>>, change: Change) {
    let mut pending = queue.lock().unwrap();
    if change == Change::Full || pending.len() >= 256 {
        pending.clear();
        pending.push_back(Change::Full);
    } else if !pending.contains(&Change::Full) {
        pending.push_back(change);
    }
}

// A failed/closed stream must never leave a successfully registered backend
// trusting a cache that can no longer receive notifications.
fn fallback_tick(
    registered: bool,
    reader_alive: bool,
    queue: &Mutex<VecDeque<Change>>,
    wake: &Notify,
) -> bool {
    if registered && reader_alive {
        return false;
    }
    enqueue(queue, Change::Full);
    wake.notify_waiters();
    true
}

fn classify(message: &zbus::Message) -> Option<Change> {
    let header = message.header();
    if !header
        .interface()?
        .as_str()
        .starts_with("org.a11y.atspi.Event.")
    {
        return None;
    }
    let member = header.member()?.as_str();
    if !matches!(
        member,
        "ChildrenChanged"
            | "PropertyChange"
            | "StateChanged"
            | "BoundsChanged"
            | "TextChanged"
            | "ActiveDescendantChanged"
            | "Focus"
            | "Activate"
            | "Deactivate"
            | "Create"
            | "Destroy"
            | "Raise"
            | "Lower"
    ) {
        return Some(Change::Full);
    }
    if matches!(
        member,
        "ChildrenChanged"
            | "ActiveDescendantChanged"
            | "Activate"
            | "Deactivate"
            | "Create"
            | "Destroy"
            | "Raise"
            | "Lower"
    ) {
        return Some(Change::Full);
    }
    let Some(bus) = header.sender().map(|s| s.to_string()) else {
        return Some(Change::Full);
    };
    let Some(path) = header
        .path()
        .and_then(|p| OwnedObjectPath::try_from(p.as_str()).ok())
    else {
        return Some(Change::Full);
    };
    // AT-SPI object events use (detail, detail1, detail2, any_data, source).
    // Never guess the meaning of an undecodable property/state event.
    let kind = match member {
        "Focus" => ChangeKind::Focus,
        "BoundsChanged" => ChangeKind::Bounds,
        "TextChanged" => ChangeKind::Value,
        "PropertyChange" | "StateChanged" => {
            let Ok((detail, ..)) = message.body().deserialize::<(
                String,
                i32,
                i32,
                zbus::zvariant::OwnedValue,
                (String, OwnedObjectPath),
            )>() else {
                return Some(Change::Full);
            };
            match (member, detail.to_ascii_lowercase().as_str()) {
                ("PropertyChange", "accessible-name" | "name") => ChangeKind::Name,
                ("PropertyChange", "accessible-value" | "value") => ChangeKind::Value,
                ("StateChanged", "focused") => ChangeKind::Focus,
                // A formerly collapsed choice subtree must be rediscovered
                // when it opens; updating only its cached root loses children.
                ("StateChanged", "showing") => return Some(Change::Full),
                ("StateChanged", "enabled") => ChangeKind::State,
                _ => return Some(Change::Full),
            }
        }
        _ => unreachable!(),
    };
    Some(Change::Node { bus, path, kind })
}

pub struct Accessibility {
    connection: Connection,
    pending: Arc<Mutex<VecDeque<Change>>>,
    references: HashMap<String, Reference>,
    ids: NodeIds,
    notify: Arc<Notify>,
    last_background_hint: Option<bool>,
    reader_task: tokio::task::JoinHandle<()>,
}

impl Drop for Accessibility {
    fn drop(&mut self) {
        // The reader holds a Connection clone. Stop it so an abandoned backend
        // cannot retain a bus name (and its registry subscriptions) indefinitely.
        self.reader_task.abort();
    }
}

// Registry.RegisterEvent has the introspected signature (s, as, s) -> ().
// The empty properties and app name request all events, from all applications.
fn event_registration(event: &str) -> (&str, Vec<&str>, &str) {
    (event, vec![], "")
}

async fn register_events(connection: &Connection) -> Result<()> {
    let registry = atspi_proxy(connection, ROOT_BUS, REGISTRY_PATH, ROOT_BUS)
        .await
        .context("AT-SPI event registry")?;
    for event in EVENT_INTERESTS {
        timeout(
            Duration::from_secs(2),
            registry.call::<_, _, ()>("RegisterEvent", &event_registration(event)),
        )
        .await
        .with_context(|| format!("AT-SPI RegisterEvent {event} timeout"))?
        .with_context(|| format!("AT-SPI RegisterEvent {event}"))?;
    }
    Ok(())
}

impl Accessibility {
    pub async fn connect() -> Result<Self> {
        let session = Connection::session().await.context("session D-Bus")?;
        let bus = atspi_proxy(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus").await?;
        let address: String = bus
            .call("GetAddress", &())
            .await
            .context("AT-SPI bus address (is accessibility enabled?)")?;
        let connection = zbus::connection::Builder::address(address.as_str())?
            .build()
            .await
            .context("connect to AT-SPI bus")?;
        let pending = Arc::new(Mutex::new(VecDeque::from([Change::Full])));
        // Activate the receiver before AddMatch/RegisterEvent: even if the
        // spawned reader has not been polled, its queue will retain signals
        // arriving during the first traversal.
        let mut stream = zbus::MessageStream::from(&connection);
        // Subscribe before the first traversal so no events are missed.
        for interface in ["Object", "Focus", "Window"] {
            let rule = format!("type='signal',interface='org.a11y.atspi.Event.{interface}'");
            connection
                .call_method(
                    Some("org.freedesktop.DBus"),
                    "/org/freedesktop/DBus",
                    Some("org.freedesktop.DBus"),
                    "AddMatch",
                    &(rule.as_str()),
                )
                .await?;
        }
        // AddMatch controls delivery to this connection; RegisterEvent tells
        // AT-SPI applications which events to produce in the first place.
        // If the registry is unavailable, retain the semantic backend but
        // rescan at a bounded rate rather than silently trusting an inert cache.
        let registered = match register_events(&connection).await {
            Ok(()) => true,
            Err(error) => {
                eprintln!("AT-SPI event registration failed; using 1s rescan fallback: {error:#}");
                false
            }
        };
        let marker = pending.clone();
        let notify = Arc::new(Notify::new());
        let wake = notify.clone();
        let reader_task = tokio::spawn(async move {
            let mut fallback = tokio::time::interval(UNREGISTERED_RESCAN);
            fallback.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut reader_alive = true;
            loop {
                tokio::select! {
                    message = stream.next(), if reader_alive => {
                        match message {
                            Some(Ok(message)) if message.message_type() == zbus::message::Type::Signal => {
                                if let Some(change) = classify(&message) {
                                    enqueue(&marker, change);
                                    wake.notify_waiters();
                                }
                            }
                            Some(Ok(_)) => {}
                            Some(Err(error)) => {
                                eprintln!("AT-SPI event reader failed; using 1s rescan fallback: {error}");
                                reader_alive = false;
                                enqueue(&marker, Change::Full);
                                wake.notify_waiters();
                            }
                            None => {
                                eprintln!("AT-SPI event reader ended; using 1s rescan fallback");
                                reader_alive = false;
                                enqueue(&marker, Change::Full);
                                wake.notify_waiters();
                            }
                        }
                    }
                    _ = fallback.tick() => {
                        fallback_tick(registered, reader_alive, &marker, &wake);
                    }
                }
            }
        });
        Ok(Self {
            connection,
            pending,
            references: HashMap::new(),
            ids: NodeIds::default(),
            notify,
            last_background_hint: None,
            reader_task,
        })
    }

    pub fn is_dirty(&self) -> bool {
        !self.pending.lock().unwrap().is_empty()
    }
    pub fn needs_refresh(&self, active_title: Option<&str>) -> bool {
        self.last_background_hint != Some(background_hint(active_title))
    }
    pub fn invalidate(&self) {
        enqueue(&self.pending, Change::Full);
        self.notify.notify_waiters();
    }
    pub fn notifications(&self) -> Arc<Notify> {
        self.notify.clone()
    }

    pub async fn refresh(&mut self, cache: &mut Cache, active_title: Option<&str>) -> Result<()> {
        let hint = background_hint(active_title);
        let changes: Vec<_> = self.pending.lock().unwrap().drain(..).collect();
        if changes.is_empty()
            && cache.current().generation != 0
            && self.last_background_hint == Some(hint)
        {
            return Ok(());
        }
        if cache.current().generation == 0
            || changes.contains(&Change::Full)
            || self.last_background_hint != Some(hint)
        {
            return self.full_refresh(cache, active_title).await;
        }
        // Work on a copy: a failed partial update must never publish a stale
        // mixture of old and new fields. Unknown sources and unsupported values
        // force a complete traversal instead.
        let mut nodes = cache.current().nodes.clone();
        for change in changes {
            let Change::Node { bus, path, kind } = change else {
                unreachable!()
            };
            let Some((index, _)) = nodes.iter().enumerate().find(|(_, node)| {
                self.references
                    .get(&node.id)
                    .is_some_and(|r| r.0 == bus && r.1 == path)
            }) else {
                return self.full_refresh(cache, active_title).await;
            };
            if self
                .update_node(&mut nodes, index, &bus, &path, kind)
                .await
                .is_err()
            {
                return self.full_refresh(cache, active_title).await;
            }
        }
        // Do not publish a partially refreshed tree if a structural event
        // arrived during the node queries. Hold the queue lock through commit
        // so that event cannot race between this check and cache.update.
        let structural = {
            let mut pending = self.pending.lock().unwrap();
            if pending.contains(&Change::Full) {
                pending.clear();
                true
            } else {
                cache.update(cache.current().root.clone(), nodes);
                false
            }
        };
        if structural {
            self.full_refresh(cache, active_title).await
        } else {
            Ok(())
        }
    }

    async fn full_refresh(&mut self, cache: &mut Cache, active_title: Option<&str>) -> Result<()> {
        match self.scan(active_title).await {
            Ok((root, nodes)) => {
                self.last_background_hint = Some(background_hint(active_title));
                cache.update(root, nodes);
                Ok(())
            }
            Err(error) => {
                self.invalidate();
                Err(error)
            }
        }
    }

    async fn update_node(
        &self,
        nodes: &mut [Node],
        index: usize,
        bus: &str,
        path: &OwnedObjectPath,
        kind: ChangeKind,
    ) -> Result<()> {
        let node = &nodes[index];
        // Window state/focus affects tree selection; moving a container can
        // invalidate every descendant's screen coordinates.
        let window = matches!(
            node.role.as_str(),
            "frame" | "window" | "dialog" | "alert" | "file chooser"
        );
        if (window && kind != ChangeKind::Name)
            || (kind == ChangeKind::Bounds && !node.children.is_empty())
        {
            bail!("container or window changed");
        }
        let proxy = timeout(
            CALL_TIMEOUT,
            atspi_proxy(&self.connection, bus, path.as_str(), ACCESSIBLE),
        )
        .await??;
        match kind {
            ChangeKind::Name => {
                let name: String = timeout(CALL_TIMEOUT, proxy.get_property("Name")).await??;
                nodes[index].name = name;
            }
            ChangeKind::State | ChangeKind::Focus => {
                // Only actionable nodes had their states fetched by the scan.
                if !is_actionable(&node.role) {
                    bail!("untracked node state");
                }
                let states: Vec<u32> = timeout(CALL_TIMEOUT, proxy.call("GetState", &())).await??;
                if has_state(&states, EDITABLE) && node.role == "text" && node.value.is_none() {
                    bail!("text became editable");
                }
                let focused = has_state(&states, FOCUSED);
                if kind == ChangeKind::Focus && focused {
                    for other in nodes.iter_mut() {
                        if other.focused == Some(true) {
                            other.focused = Some(false);
                        }
                    }
                }
                nodes[index].focused = Some(focused);
                nodes[index].enabled = Some(has_state(&states, ENABLED));
                nodes[index].visible = Some(has_state(&states, SHOWING));
            }
            ChangeKind::Value => {
                let role = node.role.as_str();
                let interface =
                    if is_text_control(role, None) || (role == "text" && node.value.is_some()) {
                        TEXT
                    } else if matches!(role, "slider" | "spin button") {
                        VALUE
                    } else {
                        bail!("untracked value");
                    };
                // A scan without a value could mean the interface was absent;
                // do not invent a field on a node without verifying its shape.
                if node.value.is_none() {
                    bail!("value not cached");
                }
                let value_proxy = timeout(
                    CALL_TIMEOUT,
                    atspi_proxy(&self.connection, bus, path.as_str(), interface),
                )
                .await??;
                nodes[index].value = Some(if interface == TEXT {
                    timeout(CALL_TIMEOUT, value_proxy.call("GetText", &(0i32, -1i32))).await??
                } else {
                    let number: f64 =
                        timeout(CALL_TIMEOUT, value_proxy.get_property("CurrentValue")).await??;
                    number.to_string()
                });
            }
            ChangeKind::Bounds => {
                let component = timeout(
                    CALL_TIMEOUT,
                    atspi_proxy(&self.connection, bus, path.as_str(), COMPONENT),
                )
                .await??;
                let (x, y, width, height): (i32, i32, i32, i32) =
                    timeout(CALL_TIMEOUT, component.call("GetExtents", &(0u32))).await??;
                nodes[index].bounds = (width > 0 && height > 0).then_some(Bounds {
                    x,
                    y,
                    width,
                    height,
                });
            }
        }
        Ok(())
    }

    // The installed menu applet names a St.Entry `menu-search-entry`, but
    // Clutter's AT-SPI adapter may not publish that actor name or even its
    // children. Do not synthesize a search node from the JS source. Check
    // actual roles and states, under the exact Cinnamon stage identity only.
    async fn cinnamon_menu_open(&self, window: &Reference) -> bool {
        let mut queue = VecDeque::from([(window.clone(), 0usize)]);
        let mut seen = HashSet::new();
        while let Some(((bus, path), depth)) = queue.pop_front() {
            if seen.len() >= CINNAMON_PROBE_NODES {
                break;
            }
            if !seen.insert((bus.clone(), path.clone())) {
                continue;
            }
            let Ok(Ok(proxy)) = timeout(
                CALL_TIMEOUT,
                atspi_proxy(&self.connection, bus.as_str(), path.as_str(), ACCESSIBLE),
            )
            .await
            else {
                continue;
            };
            if depth > 0 {
                if let Ok(Ok(role)) =
                    timeout(CALL_TIMEOUT, proxy.call::<_, _, String>("GetRoleName", &())).await
                {
                    if matches!(role.as_str(), "menu" | "popup menu" | "entry" | "text") {
                        if let Ok(Ok(states)) =
                            timeout(CALL_TIMEOUT, proxy.call::<_, _, Vec<u32>>("GetState", &()))
                                .await
                        {
                            if cinnamon_menu_signal(&role, &states) {
                                return true;
                            }
                        }
                    }
                }
            }
            if depth < CINNAMON_PROBE_DEPTH {
                if let Ok(Ok(children)) = timeout(
                    CALL_TIMEOUT,
                    proxy.call::<_, _, Vec<Reference>>("GetChildren", &()),
                )
                .await
                {
                    for child in children {
                        if queue.len() + seen.len() >= CINNAMON_PROBE_NODES {
                            break;
                        }
                        queue.push_back((child, depth + 1));
                    }
                }
            }
        }
        false
    }

    pub async fn scan(
        &mut self,
        active_title: Option<&str>,
    ) -> Result<(Option<String>, Vec<Node>)> {
        let root_ref = (ROOT_BUS.to_owned(), OwnedObjectPath::try_from(ROOT_PATH)?);
        let root_proxy = atspi_proxy(
            &self.connection,
            root_ref.0.as_str(),
            root_ref.1.as_str(),
            ACCESSIBLE,
        )
        .await
        .context("AT-SPI root unavailable")?;
        let apps: Vec<Reference> = timeout(CALL_TIMEOUT, root_proxy.call("GetChildren", &()))
            .await
            .context("AT-SPI root children timeout")?
            .context("AT-SPI root children")?;

        // Discover top-level windows *before* emitting any applications. The
        // registry has many background apps, and a breadth-first scan of all
        // of them puts the active window far outside the first screen of nodes.
        let mut windows = Vec::new();
        for app in apps {
            let Ok(Ok(proxy)) = timeout(
                CALL_TIMEOUT,
                atspi_proxy(&self.connection, app.0.as_str(), app.1.as_str(), ACCESSIBLE),
            )
            .await
            else {
                continue;
            };
            let Ok(Ok(children)) = timeout(
                CALL_TIMEOUT,
                proxy.call::<_, _, Vec<Reference>>("GetChildren", &()),
            )
            .await
            else {
                continue;
            };
            for window in children {
                let Ok(Ok(proxy)) = timeout(
                    CALL_TIMEOUT,
                    atspi_proxy(
                        &self.connection,
                        window.0.as_str(),
                        window.1.as_str(),
                        ACCESSIBLE,
                    ),
                )
                .await
                else {
                    continue;
                };
                let Ok(Ok(role)) =
                    timeout(CALL_TIMEOUT, proxy.call::<_, _, String>("GetRoleName", &())).await
                else {
                    continue;
                };
                if !matches!(
                    role.as_str(),
                    "frame" | "window" | "dialog" | "alert" | "file chooser"
                ) {
                    continue;
                }
                let states: Option<Vec<u32>> = timeout(CALL_TIMEOUT, proxy.call("GetState", &()))
                    .await
                    .ok()
                    .and_then(Result::ok);
                windows.push(WindowCandidate {
                    app: app.clone(),
                    window,
                    role,
                    active: states.as_ref().is_some_and(|s| has_state(s, ACTIVE)),
                    focused: states.as_ref().is_some_and(|s| has_state(s, FOCUSED)),
                    showing: states.as_ref().is_none_or(|s| has_state(s, SHOWING)),
                    shell_menu: false,
                });
            }
        }
        // Only the selected applications/windows are reachable from root.
        // This keeps parent/children references consistent and leaves the node
        // cap for actionable descendants, rather than background applications.
        // Other applications may keep EWMH/AT-SPI ACTIVE while the Cinnamon
        // menu is open. Inspect only showing, empty-named Cinnamon windows;
        // neither the shell app identity alone nor an empty stage is evidence.
        let mut shell_apps: HashMap<Reference, bool> = HashMap::new();
        for candidate in &mut windows {
            if candidate.role != "window" || !candidate.showing {
                continue;
            }
            // Limit the entire per-window detection, including identity
            // checks. A stalled shell never delays each of 64 child queries.
            candidate.shell_menu = bounded_shell_probe(async {
                let is_cinnamon = if let Some(&known) = shell_apps.get(&candidate.app) {
                    known
                } else {
                    let app_name = async {
                        let proxy = atspi_proxy(
                            &self.connection,
                            candidate.app.0.as_str(),
                            candidate.app.1.as_str(),
                            ACCESSIBLE,
                        )
                        .await?;
                        proxy.get_property::<String>("Name").await
                    };
                    let known = matches!(timeout(CALL_TIMEOUT, app_name).await, Ok(Ok(name)) if name.eq_ignore_ascii_case("cinnamon"));
                    shell_apps.insert(candidate.app.clone(), known);
                    known
                };
                if !is_cinnamon {
                    return false;
                }
                let window_name = async {
                    let proxy = atspi_proxy(
                        &self.connection,
                        candidate.window.0.as_str(),
                        candidate.window.1.as_str(),
                        ACCESSIBLE,
                    )
                    .await?;
                    proxy.get_property::<String>("Name").await
                };
                if !matches!(timeout(CALL_TIMEOUT, window_name).await, Ok(Ok(name)) if name.is_empty())
                {
                    return false;
                }
                self.cinnamon_menu_open(&candidate.window).await
            }, CINNAMON_PROBE_TIMEOUT).await;
        }
        let selected = selected_windows(&windows);
        let mut identities = Vec::new();
        if background_hint(active_title) {
            for &index in &selected {
                let candidate = &windows[index];
                let app_name = async {
                    let proxy = atspi_proxy(
                        &self.connection,
                        candidate.app.0.as_str(),
                        candidate.app.1.as_str(),
                        ACCESSIBLE,
                    )
                    .await?;
                    proxy.get_property::<String>("Name").await
                };
                let window_name = async {
                    let proxy = atspi_proxy(
                        &self.connection,
                        candidate.window.0.as_str(),
                        candidate.window.1.as_str(),
                        ACCESSIBLE,
                    )
                    .await?;
                    proxy.get_property::<String>("Name").await
                };
                // An unavailable identity must never hide an unknown window.
                let (app, name) = tokio::join!(
                    timeout(CALL_TIMEOUT, app_name),
                    timeout(CALL_TIMEOUT, window_name)
                );
                if let (Ok(Ok(app)), Ok(Ok(name))) = (app, name) {
                    identities.push((app, candidate.role.as_str(), name));
                } else {
                    break;
                }
            }
        }
        let identities: Vec<_> = identities
            .iter()
            .map(|(app, role, name)| (app.as_str(), *role, name.as_str()))
            .collect();
        let prune_desktop = identities.len() == selected.len()
            && background_desktop_only(
                active_title,
                &identities,
                selected.iter().any(|&i| windows[i].shell_menu),
            );
        let mut selected_children: HashMap<Reference, Vec<Reference>> = HashMap::new();
        let mut selected_apps = Vec::new();
        for index in selected {
            let candidate = &windows[index];
            if !selected_apps.contains(&candidate.app) {
                selected_apps.push(candidate.app.clone());
            }
            selected_children
                .entry(candidate.app.clone())
                .or_default()
                .push(candidate.window.clone());
            if prune_desktop {
                selected_children.insert(candidate.window.clone(), vec![]);
            }
        }
        selected_children.insert(root_ref.clone(), selected_apps);
        let mut queue = VecDeque::from([(root_ref, None, 0usize)]);
        let mut deferred = VecDeque::new();
        let mut seen = HashSet::new();
        let mut nodes = Vec::new();
        let mut references = HashMap::new();
        let mut root = None;
        while let Some(((bus, path), parent, depth)) =
            queue.pop_front().or_else(|| deferred.pop_front())
        {
            let id = self.ids.id(&bus, path.as_str());
            if seen.contains(&id) {
                continue;
            }
            let proxy = match timeout(
                CALL_TIMEOUT,
                atspi_proxy(&self.connection, bus.as_str(), path.as_str(), ACCESSIBLE),
            )
            .await
            {
                Ok(Ok(proxy)) => proxy,
                _ => continue,
            };
            // A vanished object is ignored instead of aborting the entire tree.
            let role: String = match timeout(CALL_TIMEOUT, proxy.call("GetRoleName", &())).await {
                Ok(Ok(role)) => role,
                _ => continue,
            };
            seen.insert(id.clone());
            let name: String = timeout(CALL_TIMEOUT, proxy.get_property("Name"))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            // Check choice state before GetChildren: closed GTK menus and
            // selectors may advertise hundreds of invisible descendants.
            // Other roles retain the old cheap state-query policy.
            let states: Option<Vec<u32>> = if is_actionable(&role) || choice_branch(&role) {
                timeout(CALL_TIMEOUT, proxy.call("GetState", &()))
                    .await
                    .ok()
                    .and_then(Result::ok)
            } else {
                None
            };
            let children: Vec<Reference> = if depth < MAX_DEPTH
                && nodes.len()
                    + queue.len()
                    + if defer_descendants(&role) {
                        deferred.len()
                    } else {
                        0
                    }
                    < MAX_NODES
                && !prune_descendants(&role, states.as_deref())
            {
                if let Some(selected) = selected_children.get(&(bus.clone(), path.clone())) {
                    selected.clone()
                } else {
                    timeout(CALL_TIMEOUT, proxy.call("GetChildren", &()))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or_default()
                }
            } else {
                vec![]
            };
            let bounds = match timeout(
                CALL_TIMEOUT,
                atspi_proxy(&self.connection, bus.as_str(), path.as_str(), COMPONENT),
            )
            .await
            {
                Ok(Ok(component)) => match timeout(
                    CALL_TIMEOUT,
                    component.call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(0u32)),
                )
                .await
                {
                    Ok(Ok((x, y, width, height))) if width > 0 && height > 0 => Some(Bounds {
                        x,
                        y,
                        width,
                        height,
                    }),
                    _ => None,
                },
                _ => None,
            };
            let text_control = is_text_control(&role, states.as_deref());
            let interfaces: Option<Vec<String>> = if text_control || is_actionable(&role) {
                timeout(CALL_TIMEOUT, proxy.call("GetInterfaces", &()))
                    .await
                    .ok()
                    .and_then(Result::ok)
            } else {
                None
            };
            let value = if text_control
                && interfaces
                    .as_ref()
                    .is_some_and(|i| i.iter().any(|s| s == TEXT))
            {
                match timeout(
                    CALL_TIMEOUT,
                    atspi_proxy(&self.connection, bus.as_str(), path.as_str(), TEXT),
                )
                .await
                {
                    Ok(Ok(text_proxy)) => timeout(
                        CALL_TIMEOUT,
                        text_proxy.call::<_, _, String>("GetText", &(0i32, -1i32)),
                    )
                    .await
                    .ok()
                    .and_then(Result::ok),
                    _ => None,
                }
            } else if matches!(role.as_str(), "slider" | "spin button")
                && interfaces
                    .as_ref()
                    .is_some_and(|i| i.iter().any(|s| s == VALUE))
            {
                match timeout(
                    CALL_TIMEOUT,
                    atspi_proxy(&self.connection, bus.as_str(), path.as_str(), VALUE),
                )
                .await
                {
                    Ok(Ok(value_proxy)) => timeout(
                        CALL_TIMEOUT,
                        value_proxy.get_property::<f64>("CurrentValue"),
                    )
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .map(|number| number.to_string()),
                    _ => None,
                }
            } else {
                None
            };
            let actions = if interfaces
                .as_ref()
                .is_some_and(|i| i.iter().any(|s| s == ACTION))
            {
                match timeout(
                    CALL_TIMEOUT,
                    atspi_proxy(&self.connection, bus.as_str(), path.as_str(), ACTION),
                )
                .await
                {
                    Ok(Ok(action_proxy)) => {
                        let count: Option<i32> =
                            timeout(CALL_TIMEOUT, action_proxy.get_property("NActions"))
                                .await
                                .ok()
                                .and_then(Result::ok);
                        if let Some(count) = count {
                            let mut names = Vec::new();
                            // Most controls have one action. Bound misreported counts.
                            for index in 0..count.clamp(0, 4) {
                                if let Ok(Ok(name)) = timeout(
                                    CALL_TIMEOUT,
                                    action_proxy.call::<_, _, String>("GetName", &(index)),
                                )
                                .await
                                {
                                    names.push(name);
                                }
                            }
                            Some(names)
                        } else {
                            None
                        }
                    }
                    _ => None,
                }
            } else {
                None
            };
            if root.is_none() {
                root = Some(id.clone());
            }
            let mut child_ids = Vec::new();
            for (child_bus, child_path) in children {
                if !reserve_slot(
                    !defer_descendants(&role),
                    &queue,
                    &mut deferred,
                    nodes.len(),
                ) {
                    break;
                }
                let child_id = self.ids.id(&child_bus, child_path.as_str());
                if !seen.contains(&child_id) {
                    child_ids.push(child_id);
                    let next = ((child_bus, child_path), Some(id.clone()), depth + 1);
                    if defer_descendants(&role) {
                        deferred.push_back(next);
                    } else {
                        queue.push_back(next);
                    }
                }
            }
            references.insert(id.clone(), (bus, path));
            nodes.push(Node {
                id,
                parent,
                children: child_ids,
                name,
                role,
                bounds,
                value,
                enabled: states.as_ref().map(|s| has_state(s, ENABLED)),
                visible: states.as_ref().map(|s| has_state(s, SHOWING)),
                focused: states.as_ref().map(|s| has_state(s, FOCUSED)),
                actions,
            });
        }
        if nodes.is_empty() {
            bail!("AT-SPI root unavailable");
        }
        // Children can disappear between GetChildren and GetRoleName. Never emit
        // references to objects that did not make it into this snapshot.
        let present: HashSet<_> = nodes.iter().map(|node| node.id.clone()).collect();
        for node in &mut nodes {
            node.children.retain(|id| present.contains(id));
        }
        self.references = references;
        Ok((root, nodes))
    }

    /// Return false only when the object does not offer an actionable operation.
    /// An advertised action that fails is an error, not a reason to click blindly.
    pub async fn click(&self, id: &str) -> Result<bool> {
        let (bus, path) = self
            .references
            .get(id)
            .context("unknown or stale accessibility id; observe again")?;
        let accessible =
            atspi_proxy(&self.connection, bus.as_str(), path.as_str(), ACCESSIBLE).await?;
        let interfaces: Vec<String> = timeout(CALL_TIMEOUT, accessible.call("GetInterfaces", &()))
            .await
            .context("AT-SPI GetInterfaces timeout")?
            .context("AT-SPI GetInterfaces")?;
        if !interfaces.iter().any(|interface| interface == ACTION) {
            return Ok(false);
        }
        let proxy = atspi_proxy(&self.connection, bus.as_str(), path.as_str(), ACTION).await?;
        let count: i32 = timeout(CALL_TIMEOUT, proxy.get_property("NActions"))
            .await
            .context("AT-SPI NActions timeout")?
            .context("AT-SPI NActions")?;
        if count <= 0 {
            return Ok(false);
        }
        let worked: bool = proxy
            .call("DoAction", &(0i32))
            .await
            .context("AT-SPI DoAction")?;
        if !worked {
            bail!("AT-SPI action was rejected");
        }
        self.invalidate();
        Ok(true)
    }

    pub async fn set_text(&self, id: &str, text: &str) -> Result<()> {
        let (bus, path) = self
            .references
            .get(id)
            .context("unknown or stale accessibility id; observe again")?;
        let proxy =
            atspi_proxy(&self.connection, bus.as_str(), path.as_str(), EDITABLE_TEXT).await?;
        let reply = proxy
            .call_method("SetTextContents", &(text))
            .await
            .context("AT-SPI SetTextContents")?;
        if matches!(reply.body().deserialize::<bool>(), Ok(false)) {
            bail!("AT-SPI text change was rejected");
        }
        // SetTextContents may not emit a signal on every application. Record
        // the known value change ourselves without forcing a tree traversal.
        enqueue(
            &self.pending,
            Change::Node {
                bus: bus.clone(),
                path: path.clone(),
                kind: ChangeKind::Value,
            },
        );
        self.notify.notify_waiters();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct PrivateBus(Child);

    impl Drop for PrivateBus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    // A separate bus (no session bus, X server, accessibility bridge, or user
    // profile). Its advertised property is deliberately *not* the one read by
    // our scanner: GetAll would invoke this getter, whereas Get("Name") won't.
    struct FakeAccessible {
        unrelated_gets: Arc<AtomicUsize>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl FakeAccessible {
        #[zbus(property)]
        fn name(&self) -> &str {
            "fixture control"
        }

        #[zbus(property)]
        fn unrelated(&self) -> &str {
            self.unrelated_gets.fetch_add(1, Ordering::SeqCst);
            "a property GetAll must marshal"
        }
    }

    #[tokio::test]
    async fn property_reads_never_fetch_all_atspi_properties() {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("dbus-daemon is needed for the private-bus regression test");
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let _bus = PrivateBus(child);
        assert!(!address.trim().is_empty(), "private bus address");
        let address = address.trim();
        let unrelated_gets = Arc::new(AtomicUsize::new(0));
        let service = zbus::connection::Builder::address(address)
            .unwrap()
            .name("org.test.AtspiFixture")
            .unwrap()
            .serve_at(
                "/org/test/control",
                FakeAccessible {
                    unrelated_gets: unrelated_gets.clone(),
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = zbus::connection::Builder::address(address)
            .unwrap()
            .build()
            .await
            .unwrap();
        // The server's stream sees the incoming method calls independently
        // of zbus's object-server dispatcher.
        let mut wire = zbus::MessageStream::from(&service);
        let proxy = atspi_proxy(
            &client,
            "org.test.AtspiFixture",
            "/org/test/control",
            ACCESSIBLE,
        )
        .await
        .unwrap();
        let name: String = timeout(Duration::from_secs(3), proxy.get_property("Name"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(name, "fixture control");
        let first_property_call = timeout(Duration::from_secs(3), async {
            loop {
                let message = wire.next().await.unwrap().unwrap();
                let header = message.header();
                if header
                    .interface()
                    .is_some_and(|i| i.as_str() == "org.freedesktop.DBus.Properties")
                {
                    break header.member().unwrap().to_string();
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(first_property_call, "Get");
        assert_eq!(unrelated_gets.load(Ordering::SeqCst), 0);

        // Prove that this fixture detects GetAll: the same object's explicit
        // GetAll must visit the unrelated getter that the normal read skipped.
        let properties = atspi_proxy(
            &client,
            "org.test.AtspiFixture",
            "/org/test/control",
            "org.freedesktop.DBus.Properties",
        )
        .await
        .unwrap();
        let _: HashMap<String, zbus::zvariant::OwnedValue> = timeout(
            Duration::from_secs(3),
            properties.call("GetAll", &(ACCESSIBLE)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(unrelated_gets.load(Ordering::SeqCst), 1);
        let second_property_call = timeout(Duration::from_secs(3), async {
            loop {
                let message = wire.next().await.unwrap().unwrap();
                let header = message.header();
                if header
                    .interface()
                    .is_some_and(|i| i.as_str() == "org.freedesktop.DBus.Properties")
                {
                    break header.member().unwrap().to_string();
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(second_property_call, "GetAll");
        drop(service);
    }

    fn candidate(active: bool, focused: bool, showing: bool) -> WindowCandidate {
        WindowCandidate {
            app: ("app".into(), OwnedObjectPath::try_from("/app").unwrap()),
            window: ("app".into(), OwnedObjectPath::try_from("/window").unwrap()),
            role: "frame".into(),
            active,
            focused,
            showing,
            shell_menu: false,
        }
    }

    fn signal_on(interface: &str, member: &str, detail: &str) -> zbus::Message {
        zbus::Message::signal("/org/test/entry", interface, member)
            .unwrap()
            .sender(":1.42")
            .unwrap()
            .build(&(
                detail,
                0i32,
                0i32,
                zbus::zvariant::Value::new(0u32),
                (
                    "test",
                    OwnedObjectPath::try_from("/org/test/entry").unwrap(),
                ),
            ))
            .unwrap()
    }

    fn signal(member: &str, detail: &str) -> zbus::Message {
        signal_on("org.a11y.atspi.Event.Object", member, detail)
    }

    #[test]
    fn registry_interest_wire_schema() {
        assert_eq!(EVENT_INTERESTS, ["object:", "focus:", "window:"]);
        for event in EVENT_INTERESTS {
            let message = zbus::Message::method(REGISTRY_PATH, "RegisterEvent")
                .unwrap()
                .destination(ROOT_BUS)
                .unwrap()
                .interface(ROOT_BUS)
                .unwrap()
                .build(&event_registration(event))
                .unwrap();
            assert_eq!(message.body().signature().unwrap().to_string(), "sass");
            let (name, properties, app): (String, Vec<String>, String) =
                message.body().deserialize().unwrap();
            assert_eq!(
                (name.as_str(), properties, app.as_str()),
                (event, vec![], "")
            );
        }
    }

    #[test]
    fn classifies_focus_and_window_registration_classes() {
        assert_eq!(
            classify(&signal_on("org.a11y.atspi.Event.Window", "Create", "")),
            Some(Change::Full)
        );
        assert_eq!(
            classify(&signal_on("org.a11y.atspi.Event.Window", "Destroy", "")),
            Some(Change::Full)
        );
        assert_eq!(
            classify(&signal_on("org.a11y.atspi.Event.Focus", "Focus", "")),
            Some(Change::Node {
                bus: ":1.42".into(),
                path: OwnedObjectPath::try_from("/org/test/entry").unwrap(),
                kind: ChangeKind::Focus,
            })
        );
    }

    #[test]
    fn classifies_targeted_and_structural_events() {
        let path = OwnedObjectPath::try_from("/org/test/entry").unwrap();
        assert_eq!(
            classify(&signal("TextChanged", "insert")),
            Some(Change::Node {
                bus: ":1.42".into(),
                path: path.clone(),
                kind: ChangeKind::Value,
            })
        );
        for (member, detail, kind) in [
            ("PropertyChange", "accessible-name", ChangeKind::Name),
            ("StateChanged", "focused", ChangeKind::Focus),
            ("StateChanged", "enabled", ChangeKind::State),
            ("BoundsChanged", "", ChangeKind::Bounds),
        ] {
            assert_eq!(
                classify(&signal(member, detail)),
                Some(Change::Node {
                    bus: ":1.42".into(),
                    path: path.clone(),
                    kind,
                })
            );
        }
        for (member, detail) in [
            ("ChildrenChanged", "add"),
            ("PropertyChange", "accessible-role"),
            ("StateChanged", "active"),
            ("StateChanged", "showing"),
            ("Other", ""),
        ] {
            assert_eq!(classify(&signal(member, detail)), Some(Change::Full));
        }
        let undecodable = zbus::Message::signal(
            "/org/test/entry",
            "org.a11y.atspi.Event.Object",
            "PropertyChange",
        )
        .unwrap()
        .sender(":1.42")
        .unwrap()
        .build(&("accessible-name",))
        .unwrap();
        assert_eq!(classify(&undecodable), Some(Change::Full));
    }

    #[test]
    fn reader_failure_keeps_bounded_fallback_active_after_initial_refresh() {
        let queue = Mutex::new(VecDeque::new());
        let wake = Notify::new();
        let mut reader_alive = true;
        assert!(!fallback_tick(true, reader_alive, &queue, &wake));
        assert!(queue.lock().unwrap().is_empty());
        // Model a registered reader receiving an error or EOF, followed by a
        // successful full refresh that drains the first invalidation. Every
        // subsequent timer tick must invalidate again rather than going idle.
        reader_alive = false;
        for _ in 0..3 {
            assert!(fallback_tick(true, reader_alive, &queue, &wake));
            assert_eq!(
                queue.lock().unwrap().drain(..).collect::<Vec<_>>(),
                vec![Change::Full]
            );
        }
        assert!(fallback_tick(false, true, &queue, &wake));
        assert_eq!(queue.lock().unwrap().front(), Some(&Change::Full));
    }

    #[test]
    fn queue_preserves_events_received_after_a_refresh_starts() {
        let queue = Mutex::new(VecDeque::new());
        let event = Change::Node {
            bus: ":1.42".into(),
            path: OwnedObjectPath::try_from("/org/test/entry").unwrap(),
            kind: ChangeKind::Value,
        };
        enqueue(&queue, event.clone());
        let drained: Vec<_> = queue.lock().unwrap().drain(..).collect();
        enqueue(&queue, Change::Full);
        assert_eq!(drained, vec![event.clone()]);
        assert_eq!(queue.lock().unwrap().front(), Some(&Change::Full));
        queue.lock().unwrap().clear();
        for _ in 0..257 {
            enqueue(&queue, event.clone());
        }
        assert_eq!(
            queue.lock().unwrap().iter().collect::<Vec<_>>(),
            vec![&Change::Full]
        );
    }

    #[test]
    fn parses_at_spi_state_words() {
        let words = [
            1 << ACTIVE | 1 << ENABLED | 1 << FOCUSED | 1 << SHOWING,
            1 << 1,
        ];
        assert!(has_state(&words, ACTIVE));
        assert!(has_state(&words, ENABLED));
        assert!(has_state(&words, FOCUSED));
        assert!(has_state(&words, SHOWING));
        assert!(has_state(&words, 33));
        assert!(!has_state(&words, EDITABLE));
        assert!(!has_state(&words[..1], 33));
        assert!(is_text_control("entry", None));
        assert!(!is_text_control("text", Some(&words)));
        assert!(is_text_control("text", Some(&[1 << EDITABLE])));
    }

    #[test]
    fn closed_choices_collapse_but_unknown_or_virtual_containers_do_not() {
        let hidden = [0u32, 0];
        let showing = [1 << SHOWING];
        for role in [
            "menu",
            "popup menu",
            "menu item",
            "list",
            "table",
            "table row",
            "tree",
        ] {
            assert!(prune_descendants(role, Some(&hidden)), "{role}");
            assert!(!prune_descendants(role, Some(&showing)), "{role}");
            assert!(!prune_descendants(role, None), "{role}");
            assert!(defer_descendants(role));
        }
        for role in [
            "panel",
            "scroll pane",
            "viewport",
            "text",
            "entry",
            "menu bar",
        ] {
            assert!(!prune_descendants(role, Some(&hidden)), "{role}");
        }
        assert!(defer_descendants("menu bar"));
        assert!(!defer_descendants("text"));
    }

    #[test]
    fn saturated_selector_queue_yields_to_main_editor_path() {
        let main = VecDeque::from(["editor ancestor"]);
        let mut deferred = VecDeque::from(vec!["selector cell"; MAX_NODES - 2]);
        assert!(reserve_slot(true, &main, &mut deferred, 1));
        assert_eq!(deferred.len(), MAX_NODES - 3);
        deferred.push_back("selector cell");
        assert!(!reserve_slot(false, &main, &mut deferred, 1));
        let mut deferred = VecDeque::<&str>::new();
        assert!(!reserve_slot(true, &main, &mut deferred, MAX_NODES - 1));
    }

    #[test]
    fn choice_fanout_does_not_use_up_editor_budget() {
        // An early menu/table sibling contains more cells than the scan cap;
        // a deeper source view must be visited before any of those cells.
        let mut main = VecDeque::from([("table", 0usize), ("panel", 0)]);
        let mut choices = VecDeque::new();
        let mut visited = Vec::new();
        while let Some((role, depth)) = main.pop_front().or_else(|| choices.pop_front()) {
            visited.push(role);
            if role == "table" {
                for _ in 0..MAX_NODES {
                    choices.push_back(("table cell", depth + 1));
                }
            } else if role == "panel" && depth < 15 {
                main.push_back((if depth == 14 { "text" } else { "panel" }, depth + 1));
            }
            if role == "text" {
                break;
            }
        }
        assert_eq!(visited.last(), Some(&"text"));
        assert!(!visited.contains(&"table cell"));
        assert!(MAX_DEPTH >= 15);
    }

    #[test]
    fn prunes_only_known_desktop_shells_behind_named_active_window() {
        let shells = [
            ("cinnamon", "window", ""),
            ("nemo-desktop", "frame", "Desktop"),
        ];
        assert!(background_desktop_only(
            Some("Terminal"),
            &[("nemo", "frame", "Desktop")],
            false
        ));
        assert!(background_desktop_only(
            Some("Mozilla Firefox"),
            &shells,
            false
        ));
        assert!(background_desktop_only(
            Some("Terminal"),
            &shells[..1],
            false
        ));
        // A verified live shell menu must not be discarded as an idle desktop.
        assert!(!background_desktop_only(Some("Terminal"), &shells, true));
        for title in [None, Some(""), Some("Desktop")] {
            assert!(!background_desktop_only(title, &shells, false));
        }
        assert!(!background_desktop_only(Some("Firefox"), &[], false));
        for other in [
            ("zenity", "dialog", "Save"),
            ("firefox", "frame", "Browser"),
            ("nemo", "frame", "Files"),
            ("cinnamon", "window", "Settings"),
            ("unknown", "frame", "Desktop"),
        ] {
            assert!(!background_desktop_only(
                Some("Firefox"),
                &[shells[0], other],
                false
            ));
        }
    }

    #[tokio::test]
    async fn shell_probe_timeout_is_fail_closed() {
        assert!(CINNAMON_PROBE_TIMEOUT <= Duration::from_millis(200));
        assert!(bounded_shell_probe(std::future::ready(true), CINNAMON_PROBE_TIMEOUT).await);
        assert!(!bounded_shell_probe(std::future::ready(false), CINNAMON_PROBE_TIMEOUT).await);
        assert!(
            !bounded_shell_probe(std::future::pending::<bool>(), Duration::from_millis(2)).await
        );
    }

    #[test]
    fn shell_menu_requires_observed_showing_popup_or_focused_search() {
        let showing = 1 << SHOWING;
        let focused = 1 << FOCUSED;
        for role in ["menu", "popup menu"] {
            assert!(cinnamon_menu_signal(role, &[showing]));
            assert!(!cinnamon_menu_signal(role, &[0]));
        }
        assert!(cinnamon_menu_signal("entry", &[showing | focused]));
        assert!(cinnamon_menu_signal(
            "text",
            &[showing | focused | (1 << EDITABLE)]
        ));
        for (role, states) in [
            ("entry", showing),
            ("entry", focused),
            ("text", showing | focused),
            ("panel", showing | focused),
            ("window", showing | focused),
        ] {
            assert!(!cinnamon_menu_signal(role, &[states]), "{role}");
        }
        assert!(CINNAMON_PROBE_NODES < MAX_NODES);
        assert!(CINNAMON_PROBE_DEPTH < MAX_DEPTH);
    }

    #[test]
    fn selects_real_showing_shell_menu_despite_other_active_window() {
        let mut shell = candidate(false, false, true);
        shell.role = "window".into();
        shell.shell_menu = true;
        let windows = [candidate(true, true, true), shell];
        assert_eq!(selected_windows(&windows), vec![0, 1]);
        let mut idle = candidate(false, true, true);
        idle.role = "window".into();
        assert_eq!(
            selected_windows(&[candidate(true, true, true), idle]),
            vec![0]
        );
    }

    #[test]
    fn selects_active_windows_before_background_ones() {
        let windows = [
            candidate(false, false, true),
            candidate(true, false, true),
            candidate(true, true, true),
            candidate(false, false, false),
        ];
        assert_eq!(selected_windows(&windows), vec![2, 1]);
    }

    #[test]
    fn selects_new_showing_dialog_even_if_another_app_keeps_focus() {
        let mut dialog = candidate(false, false, true);
        dialog.role = "dialog".into();
        let windows = [
            candidate(true, true, true),
            dialog,
            candidate(false, false, true),
        ];
        assert_eq!(selected_windows(&windows), vec![0, 1]);
    }

    #[test]
    fn falls_back_to_showing_but_keeps_active_without_showing() {
        let windows = [candidate(false, false, false), candidate(false, true, true)];
        assert_eq!(selected_windows(&windows), vec![1]);
        let windows = [candidate(true, false, false), candidate(false, false, true)];
        assert_eq!(selected_windows(&windows), vec![0]);
    }
}
