//! Metadata-only control plane for version probes and cooperative upgrades.
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

pub const PROTOCOL_VERSION: u32 = 1;
pub const BUILD_ID: &str = env!("PI_DAEMON_BUILD_ID");
pub const CAPABILITIES: &[&str] = &["atspi_direct_properties", "verified_focus", "launch_app"];

#[derive(Serialize)]
pub struct BuildInfo {
    // The extension checks for this embedded marker before invoking the offline
    // flag, so an older binary cannot accidentally treat it as normal startup.
    pub probe_marker: &'static str,
    pub protocol_version: u32,
    pub build_id: &'static str,
    pub capabilities: &'static [&'static str],
}
pub fn build_info() -> BuildInfo {
    BuildInfo {
        probe_marker: "pi-computer-build-info-v1",
        protocol_version: PROTOCOL_VERSION,
        build_id: BUILD_ID,
        capabilities: CAPABILITIES,
    }
}

#[derive(Debug, Serialize)]
pub struct DaemonInfo {
    pub protocol_version: u32,
    pub build_id: &'static str,
    pub pid: u32,
    pub instance_id: String,
    pub managed: bool,
    pub input_stopped: bool,
    pub active_workflows: u32,
    pub busy: bool,
    pub capabilities: &'static [&'static str],
}

pub struct Runtime {
    pub instance_id: String,
    token: Option<String>,
    pub closing: AtomicBool,
    pub shutdown: Notify,
}

pub fn valid_uuid(token: &str) -> bool {
    token.len() == 36
        && token.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

impl Runtime {
    pub fn new(managed_token: Option<String>) -> std::io::Result<Self> {
        let mut random = [0u8; 16];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        Ok(Self {
            instance_id: random.iter().map(|b| format!("{b:02x}")).collect(),
            token: managed_token.filter(|token| valid_uuid(token)),
            closing: AtomicBool::new(false),
            shutdown: Notify::new(),
        })
    }
    pub fn managed(&self) -> bool {
        self.token.is_some()
    }
    pub fn authorized(&self, instance: &str, token: &str) -> bool {
        self.instance_id == instance && self.token.as_deref() == Some(token)
    }
    pub fn closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
}
