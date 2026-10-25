//! Explicit text-only host/Docker X11 clipboard bridge.
//!
//! The host server and container relay each own only their local X11
//! CLIPBOARD selection. They exchange bounded UTF-8 frames over a separate
//! 0600 `/ipc/bridge` bind; no host X socket, DISPLAY, XAUTHORITY, shell, or
//! model IPC is shared with the container.
use crate::clipboard::Worker;
use anyhow::{bail, Context, Result};
use std::{
    collections::VecDeque,
    fs,
    io::{self, ErrorKind, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::Path,
    thread,
    time::{Duration, Instant},
};
use xxhash_rust::xxh3::xxh3_64;

const MAX_TEXT: usize = 65_536;
const MAX_FRAME: usize = MAX_TEXT + 4;
const POLL: Duration = Duration::from_millis(25);
const CONNECT_WAIT: Duration = Duration::from_millis(200);
const CONNECT_DEADLINE: Duration = Duration::from_secs(30);

fn bridge_error(message: &'static str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, message)
}

fn validate_path(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.as_os_str().len() > 4096 {
        bail!("clipboard bridge path must be an absolute bounded path");
    }
    let parent = path
        .parent()
        .context("clipboard bridge path has no parent")?;
    let metadata = fs::metadata(parent).context("clipboard bridge parent unavailable")?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        bail!("clipboard bridge parent must be a private directory");
    }
    Ok(())
}

fn frame(text: &str) -> io::Result<Vec<u8>> {
    if text.len() > MAX_TEXT {
        return Err(bridge_error("clipboard bridge text exceeds 65536 bytes"));
    }
    let mut bytes = Vec::with_capacity(4 + text.len());
    bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
    bytes.extend_from_slice(text.as_bytes());
    Ok(bytes)
}

struct Link {
    stream: UnixStream,
    input: Vec<u8>,
    output: VecDeque<u8>,
}
impl Link {
    fn new(stream: UnixStream) -> io::Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(Self {
            stream,
            input: Vec::new(),
            output: VecDeque::new(),
        })
    }
    fn queue(&mut self, text: &str) -> io::Result<()> {
        self.output.extend(frame(text)?);
        Ok(())
    }
    fn flush(&mut self) -> io::Result<()> {
        while !self.output.is_empty() {
            let contiguous = self.output.make_contiguous();
            match self.stream.write(contiguous) {
                Ok(0) => {
                    return Err(io::Error::new(
                        ErrorKind::BrokenPipe,
                        "clipboard bridge closed",
                    ))
                }
                Ok(count) => {
                    self.output.drain(..count);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    fn receive(&mut self) -> io::Result<Vec<String>> {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match self.stream.read(&mut buffer) {
                Ok(0) => {
                    return Err(io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "clipboard bridge closed",
                    ))
                }
                Ok(count) => {
                    self.input.extend_from_slice(&buffer[..count]);
                    if self.input.len() > MAX_FRAME * 2 {
                        return Err(bridge_error("clipboard bridge input exceeds bound"));
                    }
                    if count < buffer.len() {
                        break;
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
        let mut result = Vec::new();
        loop {
            if self.input.len() < 4 {
                break;
            }
            let length = u32::from_le_bytes(self.input[..4].try_into().unwrap()) as usize;
            if length > MAX_TEXT {
                return Err(bridge_error("clipboard bridge frame exceeds bound"));
            }
            if self.input.len() < 4 + length {
                break;
            }
            let bytes = self.input[4..4 + length].to_vec();
            self.input.drain(..4 + length);
            result.push(
                String::from_utf8(bytes)
                    .map_err(|_| bridge_error("clipboard bridge frame is not UTF-8"))?,
            );
        }
        Ok(result)
    }
}

fn run_link(mut worker: Worker, mut link: Link, host_side: bool) -> Result<()> {
    let worker_window = worker.bridge_window();
    let mut observed_owner = None;
    let mut local_hash = None;
    let mut remote_hash = None;
    let mut remote_initialized = host_side;
    loop {
        for _ in 0..32 {
            match worker.pump() {
                Ok(Some(event)) => worker.event(event),
                Ok(None) => break,
                Err(error) => return Err(anyhow::anyhow!(error)),
            }
        }
        for text in link.receive().context("clipboard bridge receive")? {
            let hash = xxh3_64(text.as_bytes());
            if Some(hash) == local_hash {
                continue;
            }
            worker
                .bridge_own_text(&text)
                .map_err(|error| anyhow::anyhow!(error))?;
            local_hash = Some(hash);
            remote_initialized = true;
            observed_owner = Some(worker_window);
        }
        let owner = worker.owner().map_err(|error| anyhow::anyhow!(error))?;
        let first_observation = observed_owner.is_none();
        observed_owner = Some(owner);
        if owner != 0 && owner != worker_window && (host_side || remote_initialized) {
            // X11 does not notify a requestor when the same owner replaces
            // its selection contents. Re-read the bounded text while the
            // bridge is explicitly active, but only forward changed hashes.
            // A failed read is harmless and is retried on the next poll.
            if let Ok(text) = worker.bridge_snapshot_text(owner) {
                let hash = xxh3_64(text.as_bytes());
                if Some(hash) != remote_hash {
                    link.queue(&text).context("clipboard bridge queue")?;
                    remote_hash = Some(hash);
                }
            }
        } else if first_observation && host_side && owner == 0 {
            // An ownerless host CLIPBOARD is an explicit empty initial
            // state; stale Docker text must not leak back to host.
            link.queue("").context("clipboard bridge queue")?;
            remote_hash = Some(xxh3_64(&[]));
        }
        link.flush().context("clipboard bridge send")?;
        thread::sleep(POLL);
    }
}

fn server_socket(path: &Path) -> Result<UnixListener> {
    validate_path(path)?;
    if path.exists() {
        bail!("clipboard bridge socket already exists");
    }
    let listener = UnixListener::bind(path).context("clipboard bridge bind failed")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Host-side entry point. The process inherits the host DISPLAY deliberately;
/// only the private `/ipc/bridge` Unix socket is exposed to the Docker relay.
pub fn run_server(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    unsafe {
        // The host launcher owns this short-lived bridge. Do not leave a
        // clipboard synchronizer behind if the launcher process disappears.
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
    }
    let listener = server_socket(path)?;
    let result = (|| -> Result<()> {
        let worker = Worker::new().map_err(|error| anyhow::anyhow!(error))?;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    let link = Link::new(stream)?;
                    // One relay per explicitly owned browser. Additional
                    // clients cannot observe or inject clipboard frames.
                    run_link(worker, link, true)?;
                    break;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(POLL),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    })();
    let _ = fs::remove_file(path);
    result
}

/// Container-side entry point. It never opens the host X display; it connects
/// only to the socket mounted at `/ipc/bridge/clipboard-bridge.sock`.
pub fn run_relay(path: &Path) -> Result<()> {
    validate_path(path)?;
    let deadline = Instant::now() + CONNECT_DEADLINE;
    loop {
        match UnixStream::connect(path) {
            Ok(stream) => {
                let worker = Worker::new().map_err(|error| anyhow::anyhow!(error))?;
                return run_link(worker, Link::new(stream)?, false);
            }
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(CONNECT_WAIT);
            }
            Err(error) => return Err(error).context("clipboard bridge relay connect failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    #[test]
    fn bridge_frames_are_bounded_binary_utf8_and_private() {
        let text = "Български\n".repeat(1000);
        let encoded = frame(&text).unwrap();
        assert_eq!(
            u32::from_le_bytes(encoded[..4].try_into().unwrap()) as usize,
            text.len()
        );
        assert!(frame(&"x".repeat(MAX_TEXT + 1)).is_err());
        assert!(frame("\0clipboard-marker").is_ok());
    }
    #[test]
    fn bridge_link_round_trips_only_bounded_utf8_frames() {
        let (left, mut right) = UnixStream::pair().unwrap();
        let mut sender = Link::new(left).unwrap();
        sender.queue("host-to-container").unwrap();
        sender.flush().unwrap();
        let mut bytes = [0u8; 64];
        let count = right.read(&mut bytes).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize,
            count - 4
        );
        assert_eq!(&bytes[4..count], b"host-to-container");
        assert!(sender.queue(&"x".repeat(MAX_TEXT + 1)).is_err());
    }
}
