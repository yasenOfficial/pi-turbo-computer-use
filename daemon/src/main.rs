mod accessibility;
mod apps;
mod capture;
mod config;
mod feedback;
mod input;
mod leases;
mod metrics;
mod overlay;
mod protocol;
mod runtime;
mod safety;
mod screen_diff;
mod socket_lock;
mod state;
mod visual;

use accessibility::Accessibility;
use anyhow::{bail, Context, Result};
use feedback::{Activity, Command as Visual, Lifecycle, Suspension};
use protocol::{
    AssertActual, AssertFields, AssertionDetail, BatchAction, BatchResult, BatchStep, Request,
    Response, WaitCondition,
};
use state::{Bounds, Cache, Delta, Node, Snapshot};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use std::{path::Path, sync::mpsc};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::Mutex,
};

// Backend modules intentionally expose boxed errors; convert at the integration boundary.
fn external<T>(result: Result<T, Box<dyn std::error::Error + Send + Sync>>) -> Result<T> {
    result.map_err(|error| anyhow::anyhow!("{error}"))
}

// The worker owns every X11 overlay operation. Tokens are unique across clients;
// dropping one request cannot unmap another request's active gesture.
struct VisualFeedback(mpsc::Sender<Visual>);

impl VisualFeedback {
    fn new(safety: safety::Safety, style: config::OverlayStyle) -> Self {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut overlay: Option<overlay::Overlay> = None;
            // Treat a construction failure as unavailable until restart to
            // avoid repeated X11 probes and log spam on every Begin.
            let mut unavailable = false;
            let mut lifecycle = Lifecycle::default();
            let mut phase = Instant::now();
            // Use exactly the same high-resolution cadence as animate() so
            // non-divisors of 1000 (e.g. 30 fps) do not lose every other frame.
            let interval = style.animation.frame_interval();
            let mut next_frame = Instant::now();
            loop {
                let message = if lifecycle.visible() && overlay.is_some() {
                    receiver.recv_timeout(next_frame.saturating_duration_since(Instant::now()))
                } else {
                    receiver
                        .recv()
                        .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                };
                match message {
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if safety.stopped() {
                            lifecycle.apply(&Visual::Stop);
                            if let Some(visual) = overlay.as_mut() {
                                if let Err(error) = visual.acting(false) {
                                    eprintln!("overlay unavailable: {error}");
                                    break;
                                }
                            }
                        }
                        next_frame = Instant::now() + interval;
                        if lifecycle.visible() {
                            if let Some(visual) = overlay.as_mut() {
                                if let Err(error) = visual
                                    .refresh_pointer_position()
                                    .and_then(|()| visual.animate(phase.elapsed()))
                                {
                                    eprintln!("overlay unavailable: {error}");
                                    break;
                                }
                            }
                        }
                    }
                    Ok(command) => {
                        let was_visible = lifecycle.visible();
                        let started = if safety.stopped() {
                            lifecycle.apply(&Visual::Stop)
                        } else {
                            lifecycle.apply(&command)
                        };
                        let visible = lifecycle.visible();
                        if started {
                            phase = Instant::now();
                        }
                        let mut created = false;
                        if visible && overlay.is_none() && !unavailable {
                            match overlay::Overlay::with_style(style) {
                                Ok(visual) => {
                                    overlay = Some(visual);
                                    created = true;
                                }
                                Err(error) => {
                                    unavailable = true;
                                    eprintln!("overlay unavailable: {error}");
                                }
                            }
                        }
                        if let Some(visual) = overlay.as_mut() {
                            let result = if visible && (!was_visible || created) {
                                next_frame = Instant::now() + interval;
                                visual
                                    .acting(true)
                                    .and_then(|()| visual.refresh_pointer_position())
                                    .and_then(|()| visual.animate(phase.elapsed()))
                            } else if !visible && was_visible {
                                visual.acting(false)
                            } else {
                                Ok(())
                            };
                            if let Err(error) = result {
                                eprintln!("overlay unavailable: {error}");
                                break;
                            }
                            if let Visual::Suspend(_, ack) = &command {
                                // X server has processed the unmap before capture starts.
                                if let Err(error) = visual.sync() {
                                    eprintln!("overlay unavailable: {error}");
                                    break;
                                }
                                let _ = ack.send(());
                            }
                        } else if let Visual::Suspend(_, ack) = &command {
                            let _ = ack.send(());
                        }
                        if let Visual::Begin(_, Some(ack)) = command {
                            // Nested Begin already has its parent's mapped and
                            // synced window; only round-trip on a new map.
                            if visible && (!was_visible || created) {
                                if let Some(visual) = overlay.as_mut() {
                                    if let Err(error) = visual.sync() {
                                        eprintln!("overlay unavailable: {error}");
                                        break;
                                    }
                                }
                            }
                            let _ = ack.send(());
                        }
                    }
                }
            }
            // Drop destroys the window if unmapping failed or the daemon exits.
        });
        Self(sender)
    }

    async fn begin(&self) -> Activity {
        Activity::begin_ready(&self.0).await
    }
    fn suspend(&self) -> Result<Suspension> {
        Suspension::sync(&self.0)
    }
    fn stop(&self) {
        let _ = self.0.send(Visual::Stop);
    }
}

// Shared control-plane state is never behind the daemon's action mutex: a
// Stop request from another connection must interrupt an in-flight gesture.
struct Shared {
    daemon: std::sync::Arc<Mutex<Daemon>>,
    safety: safety::Safety,
    metrics: std::sync::Arc<metrics::Metrics>,
    hide: Option<mpsc::Sender<Visual>>,
    leases: std::sync::Arc<leases::Leases>,
    runtime: runtime::Runtime,
}

struct Daemon {
    feedback: Option<VisualFeedback>,
    accessibility: Option<Accessibility>,
    cache: Cache,
    last_observed: Option<u64>,
    input: Option<input::X11Input>,
    capture: Option<capture::X11Capture>,
    visual_cache: visual::VisualCache,
    screen_dirty: Option<capture::damage::ScreenDirtyBackend>,
    screen_tile_size: u16,
    seen: state::seen::SeenCache,
    safety: safety::Safety,
    metrics: std::sync::Arc<metrics::Metrics>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Offline binary identity: no configuration, socket, AT-SPI, or X11 access.
    if std::env::args().any(|arg| arg == "--build-info") {
        println!("{}", serde_json::to_string(&runtime::build_info())?);
        return Ok(());
    }
    // Validate configuration before connecting to the desktop or touching a socket.
    let config = config::Config::load()?;
    if config.debug {
        eprintln!(
            "daemon config: socket={}, overlay={}, tile_size={}",
            config.socket, config.overlay, config.tile_size
        );
    }
    let stdio = std::env::args().any(|arg| arg == "--stdio");
    // Lock and probe before connecting AT-SPI or registering a hotkey. Defer
    // bind until Shared is ready: a connect-only client treats it as readiness.
    // Stdio is independent of the socket and must not claim its lock.
    let socket = config.socket;
    let ipc = if stdio {
        None
    } else {
        let lock = socket_lock::SocketLock::acquire(Path::new(&socket))?;
        socket_lock::prepare_path(Path::new(&socket)).await?;
        Some(lock)
    };
    let accessibility = match Accessibility::connect().await {
        Ok(backend) => Some(backend),
        Err(error) => {
            eprintln!("AT-SPI unavailable: {error:#}");
            None
        }
    };
    let safety = safety::Safety::default();
    let feedback = config
        .overlay
        .then(|| VisualFeedback::new(safety.clone(), config.overlay_style));
    let hide = feedback.as_ref().map(|visual| visual.0.clone());
    let leases = leases::Leases::new(safety.clone(), hide.clone());
    leases.start();
    let metrics = std::sync::Arc::new(metrics::Metrics::default());
    let daemon = std::sync::Arc::new(Mutex::new(Daemon {
        feedback,
        accessibility,
        cache: Cache::new(),
        last_observed: None,
        input: None,
        capture: None,
        visual_cache: visual::VisualCache::new(config.tile_size),
        screen_dirty: None,
        screen_tile_size: config.tile_size,
        seen: state::seen::SeenCache::new(),
        safety: safety.clone(),
        metrics: metrics.clone(),
    }));
    let shared = std::sync::Arc::new(Shared {
        daemon,
        safety,
        metrics,
        hide,
        leases,
        runtime: runtime::Runtime::new(if stdio {
            None
        } else {
            std::env::var("COMPUTER_USE_MANAGED_TOKEN").ok()
        })?,
    });
    if stdio {
        start_hotkey(&shared).await;
        serve(tokio::io::stdin(), tokio::io::stdout(), shared, false).await?;
        return Ok(());
    }
    let _lock = ipc.expect("socket lock held before desktop initialization");
    let listener = socket_lock::bind(Path::new(&socket)).await?;
    start_hotkey(&shared).await;
    loop {
        if shared.runtime.closing() {
            break;
        }
        tokio::select! {
            biased;
            _ = shared.runtime.shutdown.notified() => break,
            result = listener.accept() => {
                let (stream, _) = result?;
                let shared = shared.clone();
                tokio::spawn(async move {
                    let (read, write) = stream.into_split();
                    if let Err(error) = serve(read, write, shared, true).await {
                        eprintln!("IPC connection: {error:#}");
                    }
                });
            }
        }
    }
    // Give the accepted IPC response time to reach the requester before
    // dropping the listener/lock; never kill a client or force-stop a process.
    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok(())
}

async fn start_hotkey(shared: &Shared) {
    // The callback never waits for the daemon action mutex.
    let hide = shared.hide.clone();
    let leases = shared.leases.clone();
    safety::start(shared.safety.clone(), move || {
        leases.clear();
        if let Some(sender) = hide {
            let _ = sender.send(Visual::Stop);
        }
    });
}

async fn serve<R, W>(
    read: R,
    write: W,
    shared: std::sync::Arc<Shared>,
    unix_socket: bool,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // Each request owns its own activity; EOF cannot unmap another client.
    serve_connection_transport(read, write, &shared, unix_socket).await
}

#[cfg(test)]
async fn serve_connection<R, W>(read: R, write: W, shared: &Shared) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    serve_connection_transport(read, write, shared, true).await
}

async fn serve_connection_transport<R, W>(
    read: R,
    mut write: W,
    shared: &Shared,
    unix_socket: bool,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let daemon = &shared.daemon;
    let metrics = &shared.metrics;
    let mut lines = BufReader::new(read).lines();
    while let Some(line) = lines.next_line().await? {
        let started = Instant::now();
        let request = serde_json::from_str::<Request>(&line);
        let is_metrics = matches!(request, Ok(Request::Metrics { .. }));
        let mut shutdown_accepted = false;
        let response = match request {
            Ok(Request::DaemonInfo) => {
                // Metadata even while an action holds the mutex. try_lock never waits.
                let busy = daemon.try_lock().is_err();
                Response {
                    daemon_info: Some(runtime::DaemonInfo {
                        protocol_version: runtime::PROTOCOL_VERSION,
                        build_id: runtime::BUILD_ID,
                        pid: std::process::id(),
                        instance_id: shared.runtime.instance_id.clone(),
                        managed: unix_socket && shared.runtime.managed(),
                        input_stopped: shared.safety.stopped(),
                        active_workflows: shared.leases.active_count(),
                        busy,
                        capabilities: runtime::CAPABILITIES,
                    }),
                    ..Response::empty()
                }
            }
            Ok(Request::ShutdownIfIdle(protocol::ShutdownRequest { instance_id, token })) => {
                if !unix_socket || !shared.runtime.authorized(&instance_id, &token) {
                    Response::error("shutdown_if_idle unauthorized or unmanaged")
                } else if shared.safety.stopped() {
                    Response::error("input stopped; automatic upgrade refused")
                } else if let Ok(_guard) = daemon.try_lock() {
                    if shared.leases.close_if_idle(|| {
                        shared
                            .runtime
                            .closing
                            .store(true, std::sync::atomic::Ordering::SeqCst);
                        shared.safety.stop(); // Gate all queued input before releasing the mutex.
                    }) {
                        shutdown_accepted = true;
                        Response::empty()
                    } else {
                        Response::error("active workflows; shutdown refused")
                    }
                } else {
                    Response::error("daemon busy; shutdown refused")
                }
            }
            Ok(_) if shared.runtime.closing() => Response::error("daemon shutting down"),
            Ok(Request::Stop) => {
                // The atomic flag and notification cannot wait behind a drag,
                // text entry, or another connection's daemon mutex. Releasing
                // held synthetic input remains the input backend's job.
                shared.safety.stop();
                shared.leases.clear();
                if let Some(hide) = &shared.hide {
                    let _ = hide.send(Visual::Stop);
                }
                Response {
                    input_stopped: Some(true),
                    ..Response::empty()
                }
            }
            Ok(Request::ControlActivity {
                action,
                token,
                ttl_ms,
            }) => {
                if !unix_socket {
                    Response::error("control_activity requires a local Unix socket")
                } else {
                    match shared.leases.handle(action, token, ttl_ms).await {
                        Ok(()) => Response::empty(),
                        Err(error) => Response::error(error),
                    }
                }
            }
            Ok(Request::Wait {
                since,
                timeout_ms,
                milliseconds,
                condition,
            }) => {
                match wait_for_change(
                    daemon,
                    metrics,
                    since,
                    timeout_ms.or(milliseconds),
                    condition,
                )
                .await
                {
                    Ok(response) => response,
                    Err(error) => Response::error(format!("{error:#}")),
                }
            }
            Ok(Request::Batch {
                actions,
                stop_on_error,
                include_changes,
            }) => run_batch(daemon, metrics, actions, stop_on_error, include_changes).await,
            Ok(request) => {
                let mut guard = if is_metrics {
                    daemon.lock().await // A metrics query must not change the measurements.
                } else {
                    measured_lock(daemon, metrics).await
                };
                match guard.handle(request).await {
                    Ok(response) => response,
                    Err(error) => Response::error(format!("{error:#}")),
                }
            }
            Err(error) => Response::error(format!("invalid request: {error}")),
        };
        if !is_metrics {
            metrics.record("ipc_handler", started.elapsed());
        }
        let serialize_started = Instant::now();
        let json = serde_json::to_string(&response)?;
        if !is_metrics {
            metrics.record("serialization", serialize_started.elapsed());
        }
        // A disconnected client only prevents delivery of this reply. It does
        // not roll back an action already dispatched; timeout/abort is uncertain.
        let delivery = async {
            write.write_all(json.as_bytes()).await?;
            write.write_all(b"\n").await?;
            write.flush().await
        }
        .await;
        if shutdown_accepted {
            shared.runtime.shutdown.notify_one(); // Permit persists even before accept selects.
            delivery?;
            break;
        }
        delivery?;
    }
    Ok(())
}

// A wait/batch can acquire the daemon mutex more than once; lock counts are
// per acquisition, not per request. Never hold the metrics mutex while waiting.
async fn measured_lock<'a>(
    daemon: &'a std::sync::Arc<Mutex<Daemon>>,
    metrics: &metrics::Metrics,
) -> tokio::sync::MutexGuard<'a, Daemon> {
    let started = Instant::now();
    let guard = daemon.lock().await;
    metrics.record("lock", started.elapsed());
    guard
}

const MAX_BATCH_ACTIONS: usize = 24;

fn batch_limit(actions: &[BatchAction]) -> Result<()> {
    if actions.is_empty() || actions.len() > MAX_BATCH_ACTIONS {
        bail!("batch requires 1..={MAX_BATCH_ACTIONS} actions");
    }
    // Fail malformed assertions before any earlier step can dispatch input.
    // Uniqueness and equality still require a fresh scan at the assertion step.
    for (index, action) in actions.iter().enumerate() {
        if let BatchAction::Assert { target, expected } = action {
            validate_assert(target, expected)
                .with_context(|| format!("batch assertion at step {index}"))?;
        }
    }
    Ok(())
}

// Compare the initial and final trees directly: Cache only retains one prior
// generation, and a multi-step batch can advance it more than once.
fn batch_delta(before: &Snapshot, after: &Snapshot) -> Delta {
    let old: HashMap<_, _> = before.nodes.iter().map(|node| (&node.id, node)).collect();
    let new: HashMap<_, _> = after.nodes.iter().map(|node| (&node.id, node)).collect();
    Delta {
        from: before.generation,
        generation: after.generation,
        changed: after
            .nodes
            .iter()
            .filter(|node| old.get(&node.id) != Some(node))
            .cloned()
            .collect(),
        removed: before
            .nodes
            .iter()
            .filter(|node| !new.contains_key(&node.id))
            .map(|node| node.id.clone())
            .collect(),
    }
}

fn resolve_target(nodes: &[Node], target: &WaitCondition) -> Result<String> {
    if target.id.is_none() && target.name.is_none() && target.role.is_none() {
        bail!("target requires id, name, or role");
    }
    // Unlike wait's substring matching, an action must identify exactly one node.
    let mut matches = nodes.iter().filter(|node| {
        target.id.as_ref().is_none_or(|id| node.id == *id)
            && target.name.as_ref().is_none_or(|name| node.name == *name)
            && target.role.as_ref().is_none_or(|role| node.role == *role)
    });
    let node = matches
        .next()
        .context("target not found in current accessibility snapshot")?;
    if matches.next().is_some() {
        bail!("ambiguous target; specify an id or more fields");
    }
    Ok(node.id.clone())
}

// Bound both the request and echoed readbacks. Compare full live values before
// truncating output, so a long prefix can never turn a mismatch into a match.
fn bounded(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn validate_assert(target: &WaitCondition, expected: &AssertFields) -> Result<()> {
    if target.id.is_none() && target.name.is_none() && target.role.is_none() {
        bail!("assert target requires id, name, or role");
    }
    for field in [&target.id, &target.name, &target.role] {
        if field.as_ref().is_some_and(|s| s.len() > 240) {
            bail!("assert target field exceeds 240 characters");
        }
    }
    if expected.name.as_ref().is_some_and(|s| s.len() > 240) {
        bail!("assert expected name exceeds 240 characters");
    }
    if expected
        .value
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|s| s.len() > 16_384)
    {
        bail!("assert expected value exceeds 16384 characters");
    }
    if expected.name.is_none()
        && expected.value.is_none()
        && expected.enabled.is_none()
        && expected.visible.is_none()
        && expected.focused.is_none()
    {
        bail!("assert expected requires at least one field");
    }
    Ok(())
}

fn compare_assert(node: &Node, expected: AssertFields) -> Result<AssertionDetail> {
    // Password fields are deliberately not exposed by the tree walker. Never
    // try to verify a value on a password role, including `value: null`.
    if node.role == "password text" && expected.value.is_some() {
        bail!("cannot assert password value");
    }
    // A failed text/value getter is not evidence that the value is absent.
    // Reject even an explicit `value: null` before comparing or echoing it.
    if node.value_read_failed && expected.value.is_some() {
        bail!("cannot assert unreadable value");
    }
    let matched = expected.name.as_ref().is_none_or(|name| *name == node.name)
        && expected
            .value
            .as_ref()
            .is_none_or(|value| value == &node.value)
        && expected
            .enabled
            .is_none_or(|enabled| node.enabled == Some(enabled))
        && expected
            .visible
            .is_none_or(|visible| node.visible == Some(visible))
        && expected
            .focused
            .is_none_or(|focused| node.focused == Some(focused));
    let actual = AssertActual {
        name: expected.name.as_ref().map(|_| bounded(&node.name, 240)),
        value: expected
            .value
            .as_ref()
            .map(|_| node.value.as_ref().map(|v| bounded(v, 16_384))),
        enabled: expected.enabled.map(|_| node.enabled),
        visible: expected.visible.map(|_| node.visible),
        focused: expected.focused.map(|_| node.focused),
    };
    Ok(AssertionDetail {
        node_id: bounded(&node.id, 240),
        role: bounded(&node.role, 240),
        matched,
        expected,
        actual,
    })
}

// A selector is refreshed immediately before resolution, without returning a
// full snapshot as a step result. The resolved id is passed to handle only once.
async fn batch_target(
    guard: &mut Daemon,
    id: Option<String>,
    target: Option<WaitCondition>,
) -> Result<Option<String>> {
    if id.is_some() && target.is_some() {
        bail!("provide either id or target, not both");
    }
    if id.is_some() || target.is_some() {
        // Keep this lock through handle: another client cannot invalidate the
        // selection between refresh/resolution and the input operation.
        guard.observe(None, false).await?;
    }
    if let Some(target) = target {
        return Ok(Some(resolve_target(&guard.cache.current().nodes, &target)?));
    }
    Ok(id)
}

async fn batch_step(
    daemon: &std::sync::Arc<Mutex<Daemon>>,
    metrics: &metrics::Metrics,
    action: BatchAction,
    wait_timeout: Option<u64>,
) -> Result<(Response, Option<AssertionDetail>)> {
    let mut guard = measured_lock(daemon, metrics).await;
    if guard.safety.stopped() {
        bail!("input stopped; batch cancelled by emergency stop");
    }
    // The batch token covers selector resolution and waits; handle owns the
    // individual input action. No third token or X11 round trip is needed.
    let request = match action {
        BatchAction::Wait {
            since,
            timeout_ms,
            milliseconds,
            condition,
        } => {
            drop(guard); // wait_for_change releases the mutex between notifications.
            let timeout = timeout_ms.or(milliseconds).unwrap_or(30_000).min(120_000);
            return wait_for_change(
                daemon,
                metrics,
                since,
                Some(timeout.min(wait_timeout.unwrap_or(timeout))),
                condition,
            )
            .await
            .map(|response| (response, None));
        }
        BatchAction::Assert { target, expected } => {
            validate_assert(&target, &expected)?;
            let backend = guard.accessibility.as_ref().context("AT-SPI unavailable")?;
            // observe alone can reuse its notification cache. Explicitly force a
            // full scan: app/window properties and quiet adapters can change
            // without a corresponding node event. No screenshot or GetAll.
            backend.invalidate();
            guard.observe(None, false).await?;
            if guard.accessibility.is_none() {
                bail!("AT-SPI unavailable after assertion refresh");
            }
            if guard.safety.stopped() {
                bail!("input stopped; batch cancelled by emergency stop");
            }
            let id = resolve_target(&guard.cache.current().nodes, &target)?;
            let node = guard
                .cache
                .current()
                .nodes
                .iter()
                .find(|n| n.id == id)
                .context("target disappeared during assertion")?;
            return Ok((Response::empty(), Some(compare_assert(node, expected)?)));
        }
        BatchAction::Click {
            id,
            target,
            x,
            y,
            button,
            clicks,
            physical,
        } => Request::Click {
            id: batch_target(&mut guard, id, target).await?,
            x,
            y,
            button,
            clicks,
            physical,
        },
        BatchAction::DoubleClick { id, target, x, y } => Request::DoubleClick {
            id: batch_target(&mut guard, id, target).await?,
            x,
            y,
        },
        BatchAction::SetText { id, target, text } => Request::SetText {
            id: batch_target(&mut guard, id, target).await?,
            text,
        },
        BatchAction::Keypress { key } => Request::Keypress { key },
        BatchAction::Scroll {
            x,
            y,
            direction,
            amount,
        } => Request::Scroll {
            x,
            y,
            direction,
            amount,
        },
        BatchAction::Drag {
            from_x,
            from_y,
            to_x,
            to_y,
            button,
            steps,
        } => Request::Drag {
            from_x,
            from_y,
            to_x,
            to_y,
            button,
            steps,
        },
        BatchAction::FocusWindow { title } => Request::FocusWindow { title },
    };
    guard.handle(request).await.map(|response| (response, None))
}

// Preserve an earlier failure, but never report a successful final step when
// Stop arrived while that step or its read-only verification was in flight.
fn mark_stopped_step(error: &mut Option<String>, stopped: bool) {
    if stopped && error.is_none() {
        *error = Some("input stopped; batch cancelled by emergency stop".into());
    }
}

fn mark_stopped_response(response: &mut Response) {
    response.input_stopped = Some(true);
    if let Some(batch) = response.batch.as_mut() {
        batch.completed = false;
        if response.error.is_none() {
            if let Some(step) = batch.steps.last_mut() {
                mark_stopped_step(&mut step.error, true);
                step.ok = false;
                response.error = step.error.clone();
            }
        }
    }
    response.ok = false;
}

async fn run_batch(
    daemon: &std::sync::Arc<Mutex<Daemon>>,
    metrics: &metrics::Metrics,
    actions: Vec<BatchAction>,
    stop_on_error: bool,
    include_changes: bool,
) -> Response {
    if let Err(error) = batch_limit(&actions) {
        return Response::error(error);
    }
    let started = Instant::now();
    // Keep feedback active across step waits and final observation, but a
    // read-only batch of waits should not light up the desktop.
    let _activity = if actions
        .iter()
        .any(|a| !matches!(a, BatchAction::Wait { .. } | BatchAction::Assert { .. }))
    {
        measured_lock(daemon, metrics).await.activity().await
    } else {
        None
    };
    // Waits have a per-step maximum and the aggregate is bounded by the sum
    // of those maxima (plus action time). Never timeout/cancel a dispatched
    // action: cancellation could leave an uncertain, partially executed input.
    let wait_budget = actions
        .iter()
        .filter_map(|action| match action {
            BatchAction::Wait {
                timeout_ms,
                milliseconds,
                ..
            } => Some(timeout_ms.or(*milliseconds).unwrap_or(30_000).min(120_000)),
            _ => None,
        })
        .fold(0u64, u64::saturating_add);
    let mut remaining_wait_ms = wait_budget;
    let before = {
        let mut guard = measured_lock(daemon, metrics).await;
        match guard.observe(None, false).await {
            Ok(_) => guard.cache.current().clone(),
            Err(error) => return Response::error(format!("batch initial observation: {error:#}")),
        }
    };
    let total = actions.len();
    let mut steps = Vec::with_capacity(total);
    let mut first_error = None;
    for (index, action) in actions.into_iter().enumerate() {
        let kind = action.kind();
        let step_started = Instant::now();
        let is_wait = matches!(action, BatchAction::Wait { .. });
        let stopped = measured_lock(daemon, metrics).await.safety.stopped();
        let result = if stopped {
            Err(anyhow::anyhow!(
                "input stopped; restart daemon to re-enable"
            ))
        } else {
            batch_step(
                daemon,
                metrics,
                action,
                is_wait.then_some(remaining_wait_ms),
            )
            .await
        };
        if is_wait {
            remaining_wait_ms =
                remaining_wait_ms.saturating_sub(
                    step_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                );
        }
        let (mut error, matched, assertion) = match result {
            Ok((response, _)) if response.matched == Some(false) => (
                Some("wait condition timed out".to_string()),
                Some(false),
                None,
            ),
            Ok((_, Some(detail))) => {
                let error = (!detail.matched).then(|| "assertion mismatch".to_string());
                let matched = Some(detail.matched);
                (error, matched, Some(detail))
            }
            Ok((response, None)) => (None, response.matched, None),
            Err(error) => (Some(format!("{error:#}")), None, None),
        };
        // A Stop received during a read-only assertion or an in-flight step
        // also prevents later steps, even with stop_on_error:false.
        let stopped = stopped || measured_lock(daemon, metrics).await.safety.stopped();
        mark_stopped_step(&mut error, stopped);
        if let Some(error) = &error {
            first_error.get_or_insert_with(|| error.clone());
        }
        let abort = stopped || (error.is_some() && stop_on_error);
        steps.push(BatchStep {
            index,
            kind,
            ok: error.is_none(),
            error,
            matched,
            assertion,
            elapsed_ms: step_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        });
        if abort {
            break;
        }
    }
    let input_stopped = measured_lock(daemon, metrics).await.safety.stopped();
    let mut response = Response {
        ok: first_error.is_none(),
        error: first_error,
        batch: Some(BatchResult {
            completed: steps.len() == total && !input_stopped,
            steps,
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        }),
        input_stopped: Some(input_stopped),
        ..Response::empty()
    };
    // Even after a failed step, report effects of successful earlier actions.
    // AT-SPI may be absent; retain the action acknowledgements and X11 windows.
    let mut guard = measured_lock(daemon, metrics).await;
    match guard.observe(None, false).await {
        Ok(observed) => {
            response.windows = observed.windows;
            if include_changes && guard.accessibility.is_some() {
                response.changes = Some(batch_delta(&before, guard.cache.current()));
            }
        }
        Err(error) => {
            if response.error.is_none() {
                response.ok = false;
                response.error = Some(format!("batch final observation: {error:#}"));
            }
        }
    }
    // Stop can also arrive during the final (read-only) observation. A
    // response reporting input_stopped must not claim a successful batch.
    if guard.safety.stopped() {
        mark_stopped_response(&mut response);
    }
    response
}

// Release the daemon mutex while waiting: other clients must still be able to
// act, observe, and trigger AT-SPI notifications during a wait.
async fn wait_for_change(
    daemon: &std::sync::Arc<Mutex<Daemon>>,
    metrics: &metrics::Metrics,
    since: Option<u64>,
    timeout_ms: Option<u64>,
    condition: Option<WaitCondition>,
) -> Result<Response> {
    if condition
        .as_ref()
        .is_some_and(|c| c.id.is_none() && c.name.is_none() && c.role.is_none())
    {
        bail!("wait condition requires id, name, or role");
    }
    let deadline = tokio::time::Instant::now()
        + Duration::from_millis(timeout_ms.unwrap_or(30_000).min(120_000));
    let mut baseline = since;
    loop {
        let mut guard = measured_lock(daemon, metrics).await;
        if guard.safety.stopped() {
            bail!("input stopped; wait cancelled by emergency stop");
        }
        let response = guard.observe(baseline, false).await?;
        let generation = guard.cache.current().generation;
        if let Some(condition) = &condition {
            if matches_condition(&guard.cache.current().nodes, condition) {
                return Ok(Response {
                    matched: Some(true),
                    ..response
                });
            }
        } else if baseline.is_some_and(|from| generation != from) {
            return Ok(response);
        }
        if baseline.is_none() {
            baseline = Some(generation);
        }
        let notify = guard
            .accessibility
            .as_ref()
            .context("AT-SPI unavailable")?
            .notifications();
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let safety = guard.safety.clone();
        let emergency = safety.notifications();
        let emergency_notified = emergency.notified();
        tokio::pin!(emergency_notified);
        emergency_notified.as_mut().enable();
        if safety.stopped() {
            bail!("input stopped; wait cancelled by emergency stop");
        }
        // A signal may have landed between scan and subscription.
        if tokio::time::Instant::now() >= deadline {
            return Ok(Response {
                matched: condition.as_ref().map(|_| false),
                ..response
            });
        }
        if guard.accessibility.as_ref().is_some_and(|a| a.is_dirty()) {
            continue;
        }
        drop(guard);
        tokio::select! {
            biased;
            _ = emergency_notified => bail!("input stopped; wait cancelled by emergency stop"),
            result = tokio::time::timeout_at(deadline, notified) => {
                if result.is_err() {
                    let mut guard = measured_lock(daemon, metrics).await;
                    if guard.safety.stopped() {
                        bail!("input stopped; wait cancelled by emergency stop");
                    }
                    let response = guard.observe(baseline, false).await?;
                    let matched = condition
                        .as_ref()
                        .map(|condition| matches_condition(&guard.cache.current().nodes, condition));
                    return Ok(Response { matched, ..response });
                }
            }
        }
    }
}

// Clip accessibility bounds (which can extend off-screen) to a captureable root rectangle.
fn clipped_bounds(bounds: &Bounds, screen: (u16, u16)) -> Result<(u16, u16, u16, u16)> {
    let x = i64::from(bounds.x).clamp(0, i64::from(screen.0));
    let y = i64::from(bounds.y).clamp(0, i64::from(screen.1));
    let right = (i64::from(bounds.x) + i64::from(bounds.width)).clamp(0, i64::from(screen.0));
    let bottom = (i64::from(bounds.y) + i64::from(bounds.height)).clamp(0, i64::from(screen.1));
    if right <= x || bottom <= y || x > i64::from(i16::MAX) || y > i64::from(i16::MAX) {
        bail!("node bounds are outside the capturable screen");
    }
    Ok((x as u16, y as u16, (right - x) as u16, (bottom - y) as u16))
}

fn matches_condition(nodes: &[Node], condition: &WaitCondition) -> bool {
    nodes.iter().any(|node| {
        condition.id.as_ref().is_none_or(|id| &node.id == id)
            && condition
                .name
                .as_ref()
                .is_none_or(|name| node.name.contains(name))
            && condition
                .role
                .as_ref()
                .is_none_or(|role| node.role == *role)
    })
}

impl Daemon {
    async fn activity(&self) -> Option<Activity> {
        if self.safety.stopped() {
            return None;
        }
        match &self.feedback {
            Some(feedback) => Some(feedback.begin().await),
            None => None,
        }
    }
    fn suspend_feedback(&self) -> Result<Option<Suspension>> {
        self.feedback
            .as_ref()
            .map(VisualFeedback::suspend)
            .transpose()
    }
    fn ensure_input_enabled(&self) -> Result<()> {
        if self.safety.stopped() {
            bail!("input stopped; restart daemon to re-enable")
        }
        Ok(())
    }
    fn input(&mut self) -> Result<&input::X11Input> {
        self.ensure_input_enabled()?;
        if self.input.is_none() {
            self.input = Some(external(input::X11Input::new_with_safety(
                self.safety.clone(),
            ))?);
        }
        Ok(self.input.as_ref().unwrap())
    }
    fn capture(&mut self) -> Result<&capture::X11Capture> {
        if self.capture.is_none() {
            self.capture = Some(external(capture::X11Capture::new())?);
        }
        Ok(self.capture.as_ref().unwrap())
    }
    // Mutation replies are acknowledgements. The next observation processes
    // queued AT-SPI changes, or rescans after an action whose effects are unknown.
    fn action_result(&self) -> Response {
        self.invalidate();
        Response::empty()
    }
    async fn refresh_id_cache(&mut self) -> Result<()> {
        // An earlier action may have invalidated node references. Refresh before
        // using an id, without changing the caller's default changes baseline.
        if self
            .accessibility
            .as_ref()
            .is_some_and(|backend| backend.is_dirty())
        {
            let last_observed = self.last_observed;
            let result = self.observe(None, false).await;
            self.last_observed = last_observed;
            result?;
        }
        Ok(())
    }
    // Refresh windows, accessibility and the seen index without cloning a
    // response snapshot. Search still updates last_observed, as observe did.
    // SeenCache must run even on unchanged generations: it refreshes current
    // status/TTL and the active-window fallback (not just the node generation).
    async fn refresh_observation(&mut self) -> Result<Vec<input::X11Window>> {
        let at_spi_connect_started = Instant::now();
        if self.accessibility.is_none() {
            self.accessibility = Accessibility::connect().await.ok();
        }
        let at_spi_connect_elapsed = at_spi_connect_started.elapsed();
        // Read the display's active title before AT-SPI refresh. This is only
        // a hint for pruning known background desktop shells, never a reason
        // to omit an unknown or named accessible window.
        let windows_started = Instant::now();
        let windows_result = external(input::list_windows());
        self.metrics.record("windows", windows_started.elapsed());
        let windows = windows_result?;
        let active_title = windows
            .iter()
            .find(|window| window.active)
            .map(|window| window.title.as_str());
        let at_spi_started = Instant::now();
        if let Some(backend) = self.accessibility.as_mut() {
            if backend.is_dirty()
                || self.cache.current().generation == 0
                || backend.needs_refresh(active_title)
            {
                if let Err(error) = backend.refresh(&mut self.cache, active_title).await {
                    eprintln!("AT-SPI refresh unavailable: {error:#}");
                    self.accessibility = None;
                    self.cache.update(None, vec![]);
                }
            }
        } else {
            self.cache.update(None, vec![]);
        }
        self.metrics.record(
            "at_spi",
            at_spi_connect_elapsed.saturating_add(at_spi_started.elapsed()),
        );
        // X11 clients may change without any AT-SPI notification; the list
        // above is queried on every observation, including unchanged trees.
        // Keep bounded, searchable metadata, not editable values or images.
        let seen_started = Instant::now();
        self.seen.observe(self.cache.current(), active_title);
        self.metrics.record("seen_index", seen_started.elapsed());
        Ok(windows)
    }

    async fn observe(&mut self, since: Option<u64>, screenshot: bool) -> Result<Response> {
        let windows = self.refresh_observation().await?;
        let (snapshot, delta) = self.cache.observe(since);
        self.last_observed = Some(self.cache.current().generation);
        let png_base64 = if screenshot {
            let _suspension = self.suspend_feedback()?;
            Some(external(
                external(self.capture()?.capture_screen())?.png_base64(),
            )?)
        } else {
            None
        };
        Ok(Response {
            snapshot,
            delta,
            windows: Some(windows),
            png_base64,
            ..Response::empty()
        })
    }

    async fn handle(&mut self, request: Request) -> Result<Response> {
        // Extension double_click is a physical two-click gesture, not two
        // semantic DoAction calls (which often don't constitute a double click).
        let request = match request {
            Request::DoubleClick { id, x, y } => Request::Click {
                id,
                x,
                y,
                button: None,
                clicks: Some(2),
                physical: true,
            },
            other => other,
        };
        let _activity = if matches!(
            request,
            Request::Click { .. }
                | Request::Drag { .. }
                | Request::FocusWindow { .. }
                | Request::LaunchApp(..)
                | Request::SetText { .. }
                | Request::Keypress { .. }
                | Request::Scroll { .. }
        ) {
            self.activity().await
        } else {
            None
        };
        match request {
            Request::DaemonInfo | Request::ShutdownIfIdle(..) => {
                unreachable!("version control plane is handled outside the mutex")
            }
            Request::Ping => Ok(Response {
                input_stopped: Some(self.safety.stopped()),
                ..Response::empty()
            }),
            Request::Metrics { reset } => Ok(Response {
                metrics: Some(self.metrics.report(reset)),
                ..Response::empty()
            }),
            Request::Stop => {
                self.safety.stop();
                self.input = None;
                if let Some(feedback) = &self.feedback {
                    feedback.stop();
                }
                Ok(Response {
                    input_stopped: Some(true),
                    ..Response::empty()
                })
            }
            Request::Observe { since, screenshot } => self.observe(since, screenshot).await,
            Request::SearchSeen { query, limit } => {
                if query.trim().is_empty() || query.chars().count() > 240 {
                    bail!("search_seen requires a nonempty query of at most 240 characters");
                }
                if limit.is_some_and(|n| n == 0 || n > 50) {
                    bail!("search_seen limit must be 1..=50");
                }
                // Refresh current/stale status without cloning or serializing a tree.
                self.refresh_observation().await?;
                self.last_observed = Some(self.cache.current().generation);
                let started = Instant::now();
                let seen = self.seen.search(&query, limit);
                self.metrics.record("seen_search", started.elapsed());
                Ok(Response {
                    seen: Some(seen),
                    ..Response::empty()
                })
            }
            Request::Inspect { id } => {
                self.observe(None, false).await?;
                let node = self
                    .cache
                    .current()
                    .nodes
                    .iter()
                    .find(|node| node.id == id)
                    .cloned()
                    .context("unknown or stale accessibility id; observe again")?;
                Ok(Response {
                    node: Some(node),
                    ..Response::empty()
                })
            }
            Request::InspectVisual {
                id,
                incremental,
                since_visual,
            } => {
                if incremental && id.is_none() {
                    bail!("incremental inspect_visual requires an id-based crop");
                }
                if let Some(id) = id {
                    self.observe(None, false).await?;
                    let bounds = self
                        .cache
                        .current()
                        .nodes
                        .iter()
                        .find(|node| node.id == id)
                        .context("unknown or stale accessibility id; observe again")?
                        .bounds
                        .clone()
                        .context("node has no visual bounds")?;
                    let capture = self.capture()?;
                    let (x, y, width, height) =
                        clipped_bounds(&bounds, external(capture.screen_size())?)?;
                    if incremental {
                        // GetImage includes composited overlays. Unmap before reading,
                        // and wait for the X server to confirm the unmap.
                        let _suspension = self.suspend_feedback()?;
                        let frame = external(self.capture()?.capture_rgba(x, y, width, height))?;
                        let visual = external(self.visual_cache.update(
                            &id,
                            visual::Rect {
                                x,
                                y,
                                width,
                                height,
                            },
                            &frame,
                            since_visual,
                        ))?;
                        Ok(Response {
                            visual: Some(visual),
                            ..Response::empty()
                        })
                    } else {
                        let _suspension = self.suspend_feedback()?;
                        let png_base64 =
                            external(self.capture()?.capture_region(x, y, width, height))?
                                .png_base64;
                        Ok(Response {
                            png_base64: Some(png_base64),
                            ..Response::empty()
                        })
                    }
                } else {
                    let _suspension = self.suspend_feedback()?;
                    let png_base64 =
                        external(external(self.capture()?.capture_screen())?.png_base64())?;
                    Ok(Response {
                        png_base64: Some(png_base64),
                        ..Response::empty()
                    })
                }
            }
            Request::DirtyRegions => {
                // Root XDamage omits redirected children and compositor paints.
                // Until we have a complete damage source, it is only telemetry:
                // every result is verified against a full native-pixel capture.
                // Setup includes lazy connection and overlay unmap; the
                // profiled acquisition stage includes XDamage drain/size checks.
                let setup_started = Instant::now();
                let _suspension = self.suspend_feedback()?;
                let backend = if let Some(backend) = self.screen_dirty.as_mut() {
                    backend
                } else {
                    self.screen_dirty = Some(external(capture::damage::ScreenDirtyBackend::new(
                        self.screen_tile_size,
                    ))?);
                    self.screen_dirty.as_mut().unwrap()
                };
                self.metrics
                    .record("capture_setup", setup_started.elapsed());
                let started = Instant::now();
                let result = external(backend.update_profiled());
                let total = started.elapsed();
                self.metrics.record("capture", total);
                let (screen_diff, stages) = result?;
                // Backend bookkeeping not attributed to its four core stages.
                let profiled = stages
                    .acquisition
                    .saturating_add(stages.convert)
                    .saturating_add(stages.hash)
                    .saturating_add(stages.merge);
                self.metrics
                    .record("capture_other", total.saturating_sub(profiled));
                self.metrics.record("acquisition", stages.acquisition);
                self.metrics.record("convert", stages.convert);
                self.metrics.record("hash", stages.hash);
                self.metrics.record("merge", stages.merge);
                let mode = match screen_diff.capture_mode {
                    screen_diff::CaptureMode::FullRoot => "full_root",
                    screen_diff::CaptureMode::VerifiedPartial => "verified_partial",
                };
                let pixels =
                    u64::from(screen_diff.screen_width) * u64::from(screen_diff.screen_height);
                self.metrics
                    .capture(mode, stages.transport.as_str(), pixels);
                Ok(Response {
                    screen_diff: Some(screen_diff),
                    ..Response::empty()
                })
            }
            Request::LaunchApp(request) => {
                // Keep the action mutex across the blocking native GIO call,
                // but never block the Tokio reactor or delay Stop behind GIO.
                // The worker's final atomic stop check gates new dispatches;
                // Stop after that check cannot cancel an in-flight activation.
                let safety = self.safety.clone();
                let response = tokio::task::spawn_blocking(move || apps::launch(request, safety))
                    .await
                    .context("desktop launch worker failed; dispatch outcome unknown; do not retry automatically")?;
                if response.ok {
                    self.invalidate();
                }
                Ok(response)
            }
            Request::ControlActivity { .. } => {
                unreachable!("control_activity is handled outside the mutex")
            }
            Request::Wait { .. } => unreachable!("wait is handled outside the mutex"),
            Request::Batch { .. } => unreachable!("batch is handled outside the mutex"),
            Request::DoubleClick { .. } => unreachable!("double_click normalized above"),
            Request::Changes { since } => self.observe(since.or(self.last_observed), false).await,
            Request::Screenshot {
                x,
                y,
                width,
                height,
            } => {
                let provided = [x.is_some(), y.is_some(), width.is_some(), height.is_some()]
                    .into_iter()
                    .filter(|present| *present)
                    .count();
                if provided != 0 && provided != 4 {
                    bail!("screenshot region requires x, y, width, and height");
                }
                let _suspension = self.suspend_feedback()?;
                let capture = self.capture()?;
                let png_base64 = match (x, y, width, height) {
                    (Some(x), Some(y), Some(width), Some(height)) => {
                        external(capture.capture_region(x, y, width, height))?.png_base64
                    }
                    _ => external(external(capture.capture_screen())?.png_base64())?,
                };
                Ok(Response {
                    png_base64: Some(png_base64),
                    ..Response::empty()
                })
            }
            Request::Click {
                id,
                x,
                y,
                button,
                clicks,
                physical: force_physical,
            } => {
                self.ensure_input_enabled()?;
                let count = clicks.unwrap_or(1);
                if count == 0 || count > 5 {
                    bail!("clicks must be 1..=5");
                }
                let button = match button.as_deref().unwrap_or("left") {
                    "left" => 1,
                    "middle" => 2,
                    "right" => 3,
                    _ => bail!("invalid button"),
                };
                if let Some(id) = id {
                    self.refresh_id_cache().await?;
                    self.ensure_input_enabled()?;
                    let bounds = self
                        .cache
                        .current()
                        .nodes
                        .iter()
                        .find(|node| node.id == id)
                        .context("unknown or stale accessibility id; observe again")?
                        .bounds
                        .clone();
                    for _ in 0..count {
                        self.ensure_input_enabled()?;
                        let acted = if force_physical || button != 1 || count > 1 {
                            false
                        } else {
                            self.accessibility
                                .as_ref()
                                .context("observe before clicking an id")?
                                .click(&id)
                                .await?
                        };
                        if !acted {
                            self.ensure_input_enabled()?;
                            let b = bounds
                                .as_ref()
                                .context("element has no action or clickable bounds")?;
                            let x = b.x + b.width / 2;
                            let y = b.y + b.height / 2;
                            external(self.input()?.click(x.try_into()?, y.try_into()?, button))?;
                        }
                    }
                } else if let (Some(x), Some(y)) = (x, y) {
                    for _ in 0..count {
                        self.ensure_input_enabled()?;
                        external(self.input()?.click(x.try_into()?, y.try_into()?, button))?;
                    }
                } else {
                    bail!("click requires id or both x and y");
                }
                Ok(self.action_result())
            }
            Request::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
                button,
                steps,
            } => {
                let button = match button.as_deref().unwrap_or("left") {
                    "left" => 1,
                    "middle" => 2,
                    "right" => 3,
                    _ => bail!("invalid button"),
                };
                let steps = steps.unwrap_or(12);
                if !(1..=120).contains(&steps) {
                    bail!("drag steps must be 1..=120");
                }
                external(self.input()?.drag(
                    from_x.try_into()?,
                    from_y.try_into()?,
                    to_x.try_into()?,
                    to_y.try_into()?,
                    button,
                    steps,
                ))?;

                Ok(self.action_result())
            }
            Request::FocusWindow { title } => {
                external(self.input()?.focus_window(&title))?;
                Ok(self.action_result())
            }
            Request::SetText { id, text } => {
                self.ensure_input_enabled()?;
                if let Some(id) = id {
                    self.refresh_id_cache().await?;
                    self.ensure_input_enabled()?;
                    self.accessibility
                        .as_ref()
                        .context("observe before setting text")?
                        .set_text(&id, &text)
                        .await?;
                    // Update the known text locally; let AT-SPI structural
                    // events discover any resulting menus/suggestions.
                    let snapshot = self.cache.current().clone();
                    let mut nodes = snapshot.nodes;
                    if let Some(node) = nodes.iter_mut().find(|node| node.id == id) {
                        if matches!(node.role.as_str(), "entry" | "text") {
                            node.value = Some(text);
                        }
                    }
                    self.cache.update(snapshot.root, nodes);
                    Ok(Response::empty())
                } else {
                    external(self.input()?.type_text(&text))?;
                    Ok(self.action_result())
                }
            }
            Request::Keypress { key } => {
                external(self.input()?.key(&key))?;
                Ok(self.action_result())
            }
            Request::Scroll {
                x,
                y,
                direction,
                amount,
            } => {
                let (x, y) = (x.unwrap_or(0), y.unwrap_or(0));
                external(self.input()?.scroll(
                    x.try_into()?,
                    y.try_into()?,
                    &direction,
                    amount.unwrap_or(1),
                ))?;

                Ok(self.action_result())
            }
        }
    }
    fn invalidate(&self) {
        if let Some(backend) = &self.accessibility {
            backend.invalidate();
        }
    }
}

#[cfg(test)]
mod upgrade_tests;

#[cfg(test)]
mod tests {
    use super::{
        batch_delta, batch_limit, batch_step, clipped_bounds, compare_assert,
        mark_stopped_response, mark_stopped_step, matches_condition, resolve_target, run_batch,
        validate_assert, Daemon,
    };
    use crate::{
        protocol::{AssertFields, BatchAction, BatchResult, BatchStep, Response, WaitCondition},
        state::{Bounds, Cache, Node},
    };

    /// Manual compositor integration check: only creates/inspects our named,
    /// click-through overlay. Does not capture the desktop or synthesize input.
    #[tokio::test]
    #[ignore = "requires a live composited X11 desktop; briefly maps our own overlay"]
    async fn live_visual_feedback_activity_capture_stop_and_cleanup() -> anyhow::Result<()> {
        use std::{collections::HashSet, time::Duration};
        use x11rb::{
            connection::Connection as _,
            protocol::xproto::{AtomEnum, ConnectionExt as _, MapState},
        };

        async fn poll(
            mut condition: impl FnMut() -> anyhow::Result<bool>,
            description: &str,
        ) -> anyhow::Result<()> {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
            loop {
                if condition()? {
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    anyhow::bail!("timed out waiting for overlay {description}");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        let (conn, screen) = x11rb::connect(None)?;
        let root = conn.setup().roots[screen].root;
        let children =
            || -> anyhow::Result<Vec<u32>> { Ok(conn.query_tree(root)?.reply()?.children) };
        let before: HashSet<_> = children()?.into_iter().collect();
        let safety = crate::safety::Safety::default();
        let visual =
            super::VisualFeedback::new(safety.clone(), crate::config::OverlayStyle::default());
        let activity = visual.begin().await; // First Begin maps and syncs the worker's window.
        let named = children()?
            .into_iter()
            .filter(|id| !before.contains(id))
            .filter(|id| {
                conn.get_property(false, *id, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 64)
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .is_some_and(|property| {
                        property.format == 8 && property.value == b"Pi computer-use feedback"
                    })
            })
            .collect::<Vec<_>>();
        anyhow::ensure!(
            named.len() == 1,
            "expected exactly one new named overlay, found {}; requires X11 compositor, ARGB and SHAPE (see overlay unavailable diagnostic)",
            named.len()
        );
        let window = named[0];
        let state = || -> anyhow::Result<MapState> {
            Ok(conn.get_window_attributes(window)?.reply()?.map_state)
        };
        anyhow::ensure!(state()? == MapState::VIEWABLE, "Begin did not map overlay");
        tokio::time::sleep(Duration::from_millis(900)).await;
        anyhow::ensure!(
            state()? == MapState::VIEWABLE,
            "overlay disappeared during breathing"
        );

        let suspension = visual.suspend()?; // Ack includes X server unmap round trip.
        anyhow::ensure!(
            state()? == MapState::UNMAPPED,
            "capture suspension did not unmap"
        );
        drop(suspension);
        poll(
            || Ok(state()? == MapState::VIEWABLE),
            "resume after capture",
        )
        .await?;
        drop(activity);
        poll(|| Ok(state()? == MapState::UNMAPPED), "End unmap").await?;

        let next = visual.begin().await;
        anyhow::ensure!(state()? == MapState::VIEWABLE, "new activity did not map");
        safety.stop();
        visual.stop();
        poll(
            || Ok(state()? == MapState::UNMAPPED),
            "emergency stop unmap",
        )
        .await?;
        let queued = visual.begin().await;
        anyhow::ensure!(
            state()? == MapState::UNMAPPED,
            "queued Begin remapped after stop"
        );
        drop((next, queued));
        drop(visual); // Last sender goes away; worker destroys its own window.
        poll(
            || Ok(!children()?.contains(&window)),
            "worker window destruction",
        )
        .await?;
        Ok(())
    }

    /// Manual, read-only compositor integration: actual mode-0600 Unix IPC
    /// connections bracket a model-thinking pause, renewal, capture suspension,
    /// expiry and sticky Stop. Only this test's named overlay is inspected.
    #[tokio::test]
    #[ignore = "requires a live composited X11 desktop; maps only its own overlay and socket"]
    async fn live_unix_ipc_activity_lease_whole_workflow() -> anyhow::Result<()> {
        use anyhow::Context as _;
        use std::{
            collections::HashSet,
            os::unix::fs::{DirBuilderExt as _, PermissionsExt as _},
            path::{Path, PathBuf},
            time::{Duration, SystemTime, UNIX_EPOCH},
        };
        use tokio::{
            io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
            net::{UnixListener, UnixStream},
        };
        use x11rb::{
            connection::Connection as _,
            protocol::xproto::{AtomEnum, ConnectionExt as _, MapState},
        };

        struct SocketDir(PathBuf);
        impl Drop for SocketDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.0.join("ipc"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        struct Fixture {
            _directory: SocketDir,
            shared: Option<std::sync::Arc<super::Shared>>,
            server: Option<tokio::task::JoinHandle<()>>,
        }
        impl Fixture {
            async fn shutdown(&mut self) {
                if let Some(shared) = &self.shared {
                    shared.safety.stop();
                    shared.leases.clear();
                    if let Some(sender) = &shared.hide {
                        let _ = sender.send(crate::feedback::Command::Stop);
                    }
                }
                if let Some(server) = self.server.take() {
                    server.abort();
                    let _ = server.await; // JoinSet aborts any remaining IPC clients.
                }
                self.shared.take(); // Last overlay sender: destroy our window.
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Some(shared) = &self.shared {
                    shared.safety.stop();
                    shared.leases.clear();
                    if let Some(sender) = &shared.hide {
                        let _ = sender.send(crate::feedback::Command::Stop);
                    }
                }
                if let Some(server) = &self.server {
                    server.abort();
                }
            }
        }
        async fn request(
            path: &Path,
            command: serde_json::Value,
        ) -> anyhow::Result<serde_json::Value> {
            // Every request gets a fresh real Unix connection. Closing Begin's
            // connection must not drop the daemon-owned activity guard.
            let mut stream = UnixStream::connect(path).await?;
            stream
                .write_all(serde_json::to_string(&command)?.as_bytes())
                .await?;
            stream.write_all(b"\n").await?;
            let mut lines = BufReader::new(stream).lines();
            let line = tokio::time::timeout(Duration::from_secs(4), lines.next_line())
                .await??
                .context("IPC closed before acknowledgement")?;
            Ok(serde_json::from_str(&line)?)
        }
        async fn poll(
            description: &str,
            timeout: Duration,
            mut condition: impl FnMut() -> anyhow::Result<bool>,
        ) -> anyhow::Result<()> {
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                if condition()? {
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    anyhow::bail!("timed out waiting for overlay {description}");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        let (conn, screen) = x11rb::connect(None)?;
        let root = conn.setup().roots[screen].root;
        let children =
            || -> anyhow::Result<Vec<u32>> { Ok(conn.query_tree(root)?.reply()?.children) };
        let before: HashSet<u32> = children()?.into_iter().collect();
        let name = b"Pi computer-use feedback";

        let directory = std::env::temp_dir().join(format!(
            "pi-activity-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let socket_dir = SocketDir(directory);
        let socket = socket_dir.0.join("ipc");
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        anyhow::ensure!(
            std::fs::metadata(&socket)?.permissions().mode() & 0o777 == 0o600,
            "temporary IPC socket is not owner-only"
        );

        let safety = crate::safety::Safety::default();
        let feedback =
            super::VisualFeedback::new(safety.clone(), crate::config::OverlayStyle::default());
        let hide = Some(feedback.0.clone());
        let leases = crate::leases::Leases::new(safety.clone(), hide.clone());
        leases.start();
        let metrics = std::sync::Arc::new(crate::metrics::Metrics::default());
        let daemon = std::sync::Arc::new(tokio::sync::Mutex::new(Daemon {
            feedback: Some(feedback),
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None, // Never construct XTEST or exercise a model input tool.
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: safety.clone(),
            metrics: metrics.clone(),
        }));
        let shared = std::sync::Arc::new(super::Shared {
            daemon,
            safety,
            metrics,
            hide,
            leases,
            runtime: crate::runtime::Runtime::new(None)?,
        });
        let serving = shared.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            while let Ok((stream, _)) = listener.accept().await {
                let shared = serving.clone();
                connections.spawn(async move {
                    let (read, write) = stream.into_split();
                    super::serve(read, write, shared, true).await
                });
                while connections.try_join_next().is_some() {}
            }
        });
        let mut fixture = Fixture {
            _directory: socket_dir,
            shared: Some(shared),
            server: Some(server),
        };
        let token = "00112233-4455-4677-8899-aabbccddeeff";
        let second = "00112233-4455-4677-8899-aabbccddee00";
        let third = "00112233-4455-4677-8899-aabbccddee01";
        let begin = |token: &str, ttl: u64| {
            serde_json::json!({
                "cmd": "control_activity", "action": "begin", "token": token, "ttl_ms": ttl,
            })
        };
        let renew = serde_json::json!({"cmd":"control_activity","action":"renew","token":token});
        let end = serde_json::json!({"cmd":"control_activity","action":"end","token":token});
        anyhow::ensure!(
            request(&socket, begin(token, 30_000)).await?["ok"] == true,
            "lease begin rejected"
        );
        let named: Vec<_> = children()?
            .into_iter()
            .filter(|id| !before.contains(id))
            .filter(|id| {
                conn.get_property(false, *id, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 64)
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .is_some_and(|property| property.format == 8 && property.value == name)
            })
            .collect();
        anyhow::ensure!(named.len() == 1,
            "expected one newly created named overlay, found {}; requires compositor, ARGB and SHAPE (see overlay unavailable diagnostic)", named.len());
        let window = named[0];
        let state = || -> anyhow::Result<MapState> {
            Ok(conn.get_window_attributes(window)?.reply()?.map_state)
        };
        anyhow::ensure!(
            state()? == MapState::VIEWABLE,
            "Begin acknowledgement preceded map"
        );
        // No action or IPC request while the model would be thinking.
        tokio::time::sleep(Duration::from_millis(1_050)).await;
        anyhow::ensure!(
            state()? == MapState::VIEWABLE,
            "lease faded between tool calls"
        );
        anyhow::ensure!(
            request(&socket, renew).await?["ok"] == true,
            "renew on another socket failed"
        );
        anyhow::ensure!(state()? == MapState::VIEWABLE, "renew flickered");

        let suspension = {
            let guard = fixture.shared.as_ref().unwrap().daemon.lock().await;
            guard
                .suspend_feedback()?
                .context("feedback disabled during capture simulation")?
        };
        anyhow::ensure!(
            state()? == MapState::UNMAPPED,
            "capture did not unmap overlay"
        );
        drop(suspension);
        poll("capture resume", Duration::from_secs(1), || {
            Ok(state()? == MapState::VIEWABLE)
        })
        .await?;
        anyhow::ensure!(request(&socket, end).await?["ok"] == true, "end rejected");
        poll("End unmap", Duration::from_secs(1), || {
            Ok(state()? == MapState::UNMAPPED)
        })
        .await?;

        anyhow::ensure!(
            request(&socket, begin(second, 1_000)).await?["ok"] == true,
            "short lease rejected"
        );
        anyhow::ensure!(state()? == MapState::VIEWABLE, "short lease did not map");
        poll(
            "timer expiry without renewal",
            Duration::from_millis(1_800),
            || Ok(state()? == MapState::UNMAPPED),
        )
        .await?;
        anyhow::ensure!(
            request(
                &socket,
                serde_json::json!({
                    "cmd":"control_activity","action":"renew","token":second
                })
            )
            .await?["ok"]
                == false,
            "expired token renewed"
        );

        anyhow::ensure!(
            request(&socket, begin(third, 30_000)).await?["ok"] == true,
            "pre-stop lease rejected"
        );
        anyhow::ensure!(state()? == MapState::VIEWABLE, "pre-stop lease did not map");
        let stop = request(&socket, serde_json::json!({"cmd":"stop"})).await?;
        anyhow::ensure!(
            stop["ok"] == true && stop["input_stopped"] == true,
            "stop rejected"
        );
        poll("Stop unmap", Duration::from_secs(1), || {
            Ok(state()? == MapState::UNMAPPED)
        })
        .await?;
        anyhow::ensure!(
            request(&socket, begin(token, 30_000)).await?["ok"] == false,
            "stopped daemon accepted a new lease"
        );
        anyhow::ensure!(state()? == MapState::UNMAPPED, "stopped worker remapped");
        anyhow::ensure!(
            fixture
                .shared
                .as_ref()
                .unwrap()
                .daemon
                .lock()
                .await
                .input
                .is_none(),
            "test unexpectedly constructed native input"
        );
        fixture.shutdown().await;
        poll(
            "own worker window destruction",
            Duration::from_secs(1),
            || Ok(!children()?.contains(&window)),
        )
        .await?;
        Ok(())
    }

    #[test]
    fn batch_limit_and_selectors_are_safe() {
        let action = || BatchAction::Keypress { key: "a".into() };
        assert!(batch_limit(&[]).is_err());
        assert!(batch_limit(&(0..24).map(|_| action()).collect::<Vec<_>>()).is_ok());
        assert!(batch_limit(&(0..25).map(|_| action()).collect::<Vec<_>>()).is_err());
        let node = |id: &str| Node {
            id: id.into(),
            parent: None,
            children: vec![],
            name: "OK".into(),
            role: "push button".into(),
            bounds: None,
            value: None,
            value_read_failed: false,
            enabled: None,
            visible: None,
            focused: None,
            actions: None,
        };
        let nodes = vec![node("n1"), node("n2")];
        let selector = WaitCondition {
            id: None,
            name: Some("OK".into()),
            role: Some("push button".into()),
        };
        assert!(resolve_target(&nodes, &selector)
            .unwrap_err()
            .to_string()
            .contains("ambiguous"));
        let selector = WaitCondition {
            id: Some("n2".into()),
            ..selector
        };
        assert_eq!(resolve_target(&nodes, &selector).unwrap(), "n2");
        let mut cache = Cache::new();
        cache.update(None, vec![node("n1")]);
        let initial = cache.current().clone();
        cache.update(None, vec![node("n2")]);
        cache.update(None, vec![node("n1"), node("n2")]);
        let delta = batch_delta(&initial, cache.current());
        assert_eq!(delta.from, initial.generation);
        assert_eq!(delta.changed.len(), 1);
        assert_eq!(delta.changed[0].id, "n2");
        assert!(delta.removed.is_empty());
    }

    #[test]
    fn assert_checks_exact_live_node_fields_and_bounded_readbacks() {
        let selector = WaitCondition {
            id: Some("n1".into()),
            name: None,
            role: None,
        };
        let mut node = Node {
            id: "n1".into(),
            parent: None,
            children: vec![],
            name: "Ready".into(),
            role: "entry".into(),
            bounds: None,
            value: None,
            value_read_failed: false,
            enabled: Some(false),
            visible: Some(true),
            focused: None,
            actions: None,
        };
        assert!(validate_assert(&selector, &AssertFields::default()).is_err());
        assert!(validate_assert(
            &WaitCondition {
                id: None,
                name: None,
                role: None
            },
            &AssertFields {
                enabled: Some(false),
                ..AssertFields::default()
            }
        )
        .is_err());
        assert!(validate_assert(
            &selector,
            &AssertFields {
                value: Some(Some("x".repeat(16_385))),
                ..AssertFields::default()
            }
        )
        .is_err());
        assert!(validate_assert(
            &selector,
            &AssertFields {
                name: Some("x".repeat(241)),
                ..AssertFields::default()
            }
        )
        .is_err());
        let expected = AssertFields {
            name: Some("Ready".into()),
            value: Some(None),
            enabled: Some(false),
            visible: Some(true),
            focused: Some(false),
        };
        let detail = compare_assert(&node, expected).unwrap();
        assert!(!detail.matched); // absent focus is not false
        assert_eq!(
            serde_json::to_value(&detail).unwrap()["actual"]["focused"],
            serde_json::Value::Null
        );
        let expected = AssertFields {
            value: Some(None),
            enabled: Some(false),
            ..AssertFields::default()
        };
        assert!(compare_assert(&node, expected).unwrap().matched);
        node.value_read_failed = true;
        for value in [None, Some("".into())] {
            let error = compare_assert(
                &node,
                AssertFields {
                    value: Some(value),
                    ..AssertFields::default()
                },
            )
            .unwrap_err();
            assert!(error.to_string().contains("unreadable value"));
        }
        assert!(
            compare_assert(
                &node,
                AssertFields {
                    enabled: Some(false),
                    ..AssertFields::default()
                }
            )
            .unwrap()
            .matched,
            "unreadable value does not invalidate unrelated fields"
        );
        node.value_read_failed = false;
        node.value = Some("secret".into());
        assert!(
            !compare_assert(
                &node,
                AssertFields {
                    value: Some(None),
                    ..AssertFields::default()
                }
            )
            .unwrap()
            .matched
        );
        assert!(
            !compare_assert(
                &node,
                AssertFields {
                    name: Some("Read".into()),
                    ..AssertFields::default()
                }
            )
            .unwrap()
            .matched
        );
        node.value = Some("z".repeat(20_000));
        let detail = compare_assert(
            &node,
            AssertFields {
                value: Some(Some("different".into())),
                ..AssertFields::default()
            },
        )
        .unwrap();
        assert!(!detail.matched);
        assert_eq!(detail.actual.value.unwrap().unwrap().len(), 16_384);
        node.role = "password text".into();
        assert!(compare_assert(
            &node,
            AssertFields {
                value: Some(None),
                ..AssertFields::default()
            }
        )
        .is_err());
        assert!(
            compare_assert(
                &node,
                AssertFields {
                    name: Some("Ready".into()),
                    ..AssertFields::default()
                }
            )
            .unwrap()
            .matched
        );
        assert!(resolve_target(&[], &selector)
            .unwrap_err()
            .to_string()
            .contains("not found"));
        assert!(resolve_target(&[node.clone(), node], &selector)
            .unwrap_err()
            .to_string()
            .contains("ambiguous"));
    }

    #[test]
    fn stop_after_last_success_is_still_a_batch_failure() {
        let mut response = Response {
            batch: Some(BatchResult {
                steps: vec![BatchStep {
                    index: 0,
                    kind: "assert",
                    ok: true,
                    elapsed_ms: 1,
                    error: None,
                    matched: Some(true),
                    assertion: None,
                }],
                elapsed_ms: 1,
                completed: true,
            }),
            ..Response::empty()
        };
        mark_stopped_response(&mut response);
        assert!(!response.ok);
        assert_eq!(response.input_stopped, Some(true));
        assert!(response
            .error
            .as_deref()
            .unwrap()
            .starts_with("input stopped;"));
        let batch = response.batch.unwrap();
        assert!(!batch.completed);
        assert!(!batch.steps[0].ok);
        assert_eq!(batch.steps[0].matched, Some(true)); // evidence predates cancellation
        let mut error = None;
        mark_stopped_step(&mut error, true);
        assert_eq!(
            error.as_deref(),
            Some("input stopped; batch cancelled by emergency stop")
        );
        assert!(error.is_some(), "the last step must not report ok:true");
        let mut existing = Some("assertion mismatch".into());
        mark_stopped_step(&mut existing, true);
        assert_eq!(existing.as_deref(), Some("assertion mismatch"));
        let mut running = None;
        mark_stopped_step(&mut running, false);
        assert!(running.is_none());
    }

    #[test]
    fn crop_clips_to_screen_and_rejects_invisible_nodes() {
        assert_eq!(
            clipped_bounds(
                &Bounds {
                    x: -5,
                    y: 10,
                    width: 20,
                    height: 50
                },
                (100, 40)
            )
            .unwrap(),
            (0, 10, 15, 30)
        );
        assert!(clipped_bounds(
            &Bounds {
                x: 110,
                y: 1,
                width: 10,
                height: 5
            },
            (100, 40)
        )
        .is_err());
    }

    #[test]
    fn wait_condition_matches_same_node() {
        let nodes = vec![Node {
            id: "n1".into(),
            parent: None,
            children: vec![],
            name: "Save file".into(),
            role: "button".into(),
            bounds: None,
            value: None,
            value_read_failed: false,
            enabled: None,
            visible: None,
            focused: None,
            actions: None,
        }];
        assert!(matches_condition(
            &nodes,
            &WaitCondition {
                id: Some("n1".into()),
                name: Some("Save".into()),
                role: Some("button".into())
            }
        ));
        assert!(!matches_condition(
            &nodes,
            &WaitCondition {
                id: Some("n2".into()),
                name: Some("Save".into()),
                role: None
            }
        ));
    }

    #[tokio::test]
    async fn batch_dispatch_rejects_conflicting_selectors_and_stopped_input_without_x11() {
        let daemon = std::sync::Arc::new(tokio::sync::Mutex::new(Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: crate::safety::Safety::default(),
            metrics: std::sync::Arc::new(crate::metrics::Metrics::default()),
        }));
        let conflict = BatchAction::Click {
            id: Some("n1".into()),
            target: Some(WaitCondition {
                id: None,
                name: Some("OK".into()),
                role: None,
            }),
            x: None,
            y: None,
            button: None,
            clicks: None,
            physical: false,
        };
        let metrics = daemon.lock().await.metrics.clone();
        assert!(batch_step(&daemon, &metrics, conflict, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("either id or target"));
        // A malformed later assertion rejects the entire batch before the
        // first keypress or even an initial desktop observation.
        for invalid in [
            BatchAction::Assert {
                target: WaitCondition {
                    id: Some("n1".into()),
                    name: None,
                    role: None,
                },
                expected: AssertFields::default(),
            },
            BatchAction::Assert {
                target: WaitCondition {
                    id: None,
                    name: None,
                    role: None,
                },
                expected: AssertFields {
                    enabled: Some(false),
                    ..AssertFields::default()
                },
            },
            BatchAction::Assert {
                target: WaitCondition {
                    id: Some("n1".into()),
                    name: None,
                    role: None,
                },
                expected: AssertFields {
                    value: Some(Some("x".repeat(16_385))),
                    ..AssertFields::default()
                },
            },
        ] {
            let actions = vec![
                BatchAction::Keypress {
                    key: "Return".into(),
                },
                invalid,
            ];
            let rejected = run_batch(&daemon, &metrics, actions, false, true).await;
            assert!(!rejected.ok);
            assert!(rejected
                .error
                .unwrap()
                .contains("batch assertion at step 1"));
            assert!(rejected.batch.is_none());
            let guard = daemon.lock().await;
            assert!(guard.input.is_none());
            assert_eq!(guard.cache.current().generation, 0);
        }
        daemon.lock().await.safety.stop();
        let error = batch_step(
            &daemon,
            &metrics,
            BatchAction::Keypress {
                key: "Return".into(),
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("input stopped"));
        assert!(daemon.lock().await.input.is_none());
    }

    #[tokio::test]
    async fn stop_is_sticky_and_blocks_semantic_input_without_x11() {
        let mut daemon = Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: crate::safety::Safety::default(),
            metrics: std::sync::Arc::new(crate::metrics::Metrics::default()),
        };
        assert!(
            daemon
                .handle(crate::protocol::Request::Stop)
                .await
                .unwrap()
                .ok
        );
        assert!(daemon
            .handle(crate::protocol::Request::Click {
                id: Some("n1".into()),
                x: None,
                y: None,
                button: None,
                clicks: None,
                physical: false
            })
            .await
            .is_err());
        assert!(daemon
            .handle(crate::protocol::Request::SetText {
                id: Some("n1".into()),
                text: "hello".into()
            })
            .await
            .is_err());
        assert!(daemon.input().is_err());
        assert!(daemon.safety.stopped());
        assert!(
            daemon
                .handle(crate::protocol::Request::Ping)
                .await
                .unwrap()
                .ok
        );
    }

    #[tokio::test]
    async fn emergency_signal_blocks_all_input_paths_without_x11() {
        use crate::protocol::Request;
        let safety = crate::safety::Safety::default();
        let mut daemon = Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: safety.clone(),
            metrics: std::sync::Arc::new(crate::metrics::Metrics::default()),
        };
        assert!(safety.stop()); // Signal from the hotkey thread, without the mutex.
        for request in [
            Request::Click {
                id: Some("n1".into()),
                x: None,
                y: None,
                button: None,
                clicks: None,
                physical: false,
            },
            Request::SetText {
                id: Some("n1".into()),
                text: "blocked".into(),
            },
            Request::Drag {
                from_x: 0,
                from_y: 0,
                to_x: 1,
                to_y: 1,
                button: None,
                steps: None,
            },
            Request::FocusWindow {
                title: "test".into(),
            },
            Request::Keypress { key: "a".into() },
            Request::Scroll {
                x: None,
                y: None,
                direction: "down".into(),
                amount: None,
            },
        ] {
            assert!(daemon
                .handle(request)
                .await
                .unwrap_err()
                .to_string()
                .contains("input stopped"));
        }
        assert!(daemon.input.is_none());
        assert!(daemon.handle(Request::Ping).await.unwrap().ok);
        assert!(daemon.handle(Request::Stop).await.unwrap().ok);
        assert!(safety.stopped());
    }

    #[tokio::test]
    async fn incomplete_screenshot_region_fails_without_x11() {
        let mut daemon = Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: crate::safety::Safety::default(),
            metrics: std::sync::Arc::new(crate::metrics::Metrics::default()),
        };
        let error = daemon
            .handle(crate::protocol::Request::Screenshot {
                x: Some(1),
                y: None,
                width: Some(5),
                height: Some(5),
            })
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("requires x, y, width, and height"));
        assert!(daemon.capture.is_none());
    }

    #[tokio::test]
    async fn metrics_ipc_rejects_invalid_reset_without_x11() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let daemon = std::sync::Arc::new(tokio::sync::Mutex::new(Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: crate::safety::Safety::default(),
            metrics: std::sync::Arc::new(crate::metrics::Metrics::default()),
        }));
        let shared = {
            let guard = daemon.lock().await;
            super::Shared {
                daemon: daemon.clone(),
                safety: guard.safety.clone(),
                metrics: guard.metrics.clone(),
                hide: None,
                leases: crate::leases::Leases::new(guard.safety.clone(), None),
                runtime: crate::runtime::Runtime::new(None).unwrap(),
            }
        };
        let (server, client) = tokio::io::duplex(16384);
        let task = tokio::spawn(async move {
            let (read, write) = tokio::io::split(server);
            super::serve_connection_transport(read, write, &shared, false)
                .await
                .unwrap();
        });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        for (payload, ok, count) in [
            (r#"{"cmd":"metrics","reset":"true"}"#, false, None),
            (r#"{"cmd":"ping"}"#, true, None),
            (r#"{"cmd":"metrics"}"#, true, Some(2)),
            (r#"{"cmd":"metrics","reset":true}"#, true, Some(2)),
            (r#"{"cmd":"metrics"}"#, true, Some(0)),
        ] {
            write
                .write_all(format!("{payload}\n").as_bytes())
                .await
                .unwrap();
            let response: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(response["ok"], ok);
            if !ok {
                assert!(response["error"]
                    .as_str()
                    .unwrap()
                    .contains("invalid request"));
            }
            if let Some(count) = count {
                assert_eq!(response["metrics"]["stages"]["ipc_handler"]["count"], count);
                assert!(
                    response["metrics"]["stages"]["lock"]["count"]
                        .as_u64()
                        .unwrap()
                        <= count
                );
            } else {
                assert!(response.get("metrics").is_none());
            }
        }
        write.write_all(b"{\"cmd\":\"control_activity\",\"action\":\"begin\",\"token\":\"00112233-4455-6677-8899-aabbccddeeff\"}\n").await.unwrap();
        let response: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(response["ok"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("local Unix socket"));
        drop(write);
        drop(lines);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn stop_ipc_sets_atomic_flag_while_daemon_mutex_is_held() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let safety = crate::safety::Safety::default();
        let metrics = std::sync::Arc::new(crate::metrics::Metrics::default());
        let daemon = std::sync::Arc::new(tokio::sync::Mutex::new(Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: safety.clone(),
            metrics: metrics.clone(),
        }));
        let leases = crate::leases::Leases::new(safety.clone(), None);
        let shared = super::Shared {
            daemon: daemon.clone(),
            safety: safety.clone(),
            metrics,
            hide: None,
            leases: leases.clone(),
            runtime: crate::runtime::Runtime::new(None).unwrap(),
        };
        let guard = daemon.lock().await; // Simulate another connection's long-running action.
        let (server, client) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move {
            let (read, write) = tokio::io::split(server);
            super::serve_connection(read, write, &shared).await.unwrap();
        });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        for payload in [
            r#"{"cmd":"control_activity","action":"begin","token":"00112233-4455-6677-8899-aabbccddeeff"}"#,
            r#"{"cmd":"control_activity","action":"renew","token":"00112233-4455-6677-8899-aabbccddeeff","ttl_ms":10000}"#,
        ] {
            write
                .write_all(format!("{payload}\n").as_bytes())
                .await
                .unwrap();
            let reply = tokio::time::timeout(std::time::Duration::from_secs(1), lines.next_line())
                .await
                .expect("control activity must bypass the action mutex")
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&reply).unwrap(),
                serde_json::json!({"ok":true})
            );
        }
        assert_eq!(leases.lock_for_test(), 1);
        write.write_all(b"{\"cmd\":\"stop\"}\n").await.unwrap();
        let response: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(std::time::Duration::from_secs(1), lines.next_line())
                .await
                .expect("stop must bypass the action mutex")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["input_stopped"], true);
        assert!(safety.stopped());
        assert_eq!(leases.lock_for_test(), 0);
        write.write_all(b"{\"cmd\":\"control_activity\",\"action\":\"begin\",\"token\":\"00112233-4455-6677-8899-aabbccddeeff\"}\n").await.unwrap();
        let reply = lines.next_line().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&reply).unwrap()["ok"],
            false
        );
        drop(guard);
        // A stopped IPC launch must not enumerate GIO or touch X11, even for
        // a real-looking desktop ID; this test never dispatches any app.
        write
            .write_all(b"{\"cmd\":\"launch_app\",\"app_id\":\"org.example.App.desktop\"}\n")
            .await
            .unwrap();
        let response: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(std::time::Duration::from_secs(1), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["ok"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("input stopped"));
        assert!(response.get("launch").is_none());
        assert!(daemon.lock().await.input.is_none());
        drop(write);
        drop(lines);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn incremental_full_screen_is_rejected_before_x11() {
        let mut daemon = Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: crate::visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: crate::state::seen::SeenCache::new(),
            safety: crate::safety::Safety::default(),
            metrics: std::sync::Arc::new(crate::metrics::Metrics::default()),
        };
        let error = daemon
            .handle(crate::protocol::Request::InspectVisual {
                id: None,
                incremental: true,
                since_visual: None,
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("requires an id-based crop"));
        assert!(daemon.capture.is_none());
    }
}
