//! Bounded, metadata-only latency counters. Never store requests, node names or pixels.
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

// capture_setup: overlay unmap + lazy backend connection; capture: full
// update_profiled call; acquisition: backend-reported transport + XDamage
// drain/size verification; capture_other: unassigned update time. Stage
// totals overlap (capture contains acquisition/hash/merge), not additive.
const CAPACITY: usize = 256;
const STAGES: [&str; 14] = [
    "ipc_handler",
    "lock",
    "serialization",
    "at_spi",
    "windows",
    "seen_index",
    "seen_search",
    "capture_setup",
    "capture",
    "capture_other",
    "acquisition",
    "convert",
    "hash",
    "merge",
];

#[derive(Default)]
struct Samples {
    recent: VecDeque<u64>,
    count: u64,
    total_us: u64,
}

impl Samples {
    fn record(&mut self, duration: Duration) {
        let micros = duration.as_micros().min(u128::from(u64::MAX)) as u64;
        self.count = self.count.saturating_add(1);
        self.total_us = self.total_us.saturating_add(micros);
        if self.recent.len() == CAPACITY {
            self.recent.pop_front();
        }
        self.recent.push_back(micros);
    }

    fn summary(&self) -> StageSummary {
        let mut sorted: Vec<_> = self.recent.iter().copied().collect();
        sorted.sort_unstable();
        let percentile = |percent: usize| -> Option<u64> {
            (!sorted.is_empty()).then(|| sorted[(sorted.len() * percent).div_ceil(100) - 1])
        };
        StageSummary {
            count: self.count,
            samples: sorted.len(),
            total_us: self.total_us,
            p50_us: percentile(50),
            p95_us: percentile(95),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct StageSummary {
    pub count: u64,
    pub samples: usize,
    pub total_us: u64,
    pub p50_us: Option<u64>,
    pub p95_us: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub stages: BTreeMap<&'static str, StageSummary>,
    /// Most recent successful dirty_regions capture, if any.
    pub capture_mode: Option<&'static str>,
    /// Last successful native X11 transport (SHM is not socket pixel bytes).
    pub capture_transport: Option<&'static str>,
    /// Pixel-area estimate, not actual X11 wire bytes (MIT-SHM/native format
    /// may differ). Full-root verification reads the entire screen.
    pub transferred_pixels: u64,
    pub capture_count: u64,
}

struct Inner {
    stages: [Samples; STAGES.len()],
    capture_mode: Option<&'static str>,
    capture_transport: Option<&'static str>,
    transferred_pixels: u64,
    capture_count: u64,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            stages: std::array::from_fn(|_| Samples::default()),
            capture_mode: None,
            capture_transport: None,
            transferred_pixels: 0,
            capture_count: 0,
        }
    }
}

#[derive(Default)]
pub struct Metrics(Mutex<Inner>);

impl Metrics {
    pub fn record(&self, stage: &'static str, duration: Duration) {
        if let Some(index) = STAGES.iter().position(|name| *name == stage) {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).stages[index].record(duration);
        }
    }

    pub fn capture(&self, mode: &'static str, transport: &'static str, pixels: u64) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.capture_mode = Some(mode);
        inner.capture_transport = Some(transport);
        inner.capture_count = inner.capture_count.saturating_add(1);
        inner.transferred_pixels = inner.transferred_pixels.saturating_add(pixels);
    }

    /// An explicit reset returns the interval snapshot, then clears counters
    /// atomically. It does not reset the screen diff cache.
    pub fn report(&self, reset: bool) -> Report {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let report = Report {
            stages: STAGES
                .iter()
                .enumerate()
                .map(|(index, stage)| (*stage, inner.stages[index].summary()))
                .collect(),
            capture_mode: inner.capture_mode,
            capture_transport: inner.capture_transport,
            transferred_pixels: inner.transferred_pixels,
            capture_count: inner.capture_count,
        };
        if reset {
            *inner = Inner::default();
        }
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_exact_percentiles_count_and_reset() {
        let metrics = Metrics::default();
        let empty = metrics.report(false);
        assert_eq!(empty.stages["hash"].count, 0);
        assert!(empty.stages["hash"].p50_us.is_none());
        for n in 1..=300 {
            metrics.record("hash", Duration::from_micros(n));
        }
        let stats = &metrics.report(false).stages["hash"];
        assert_eq!(
            (stats.count, stats.samples, stats.total_us),
            (300, 256, 45150)
        );
        assert_eq!(stats.p50_us, Some(172)); // most recent 45..=300, nearest rank 128
        assert_eq!(stats.p95_us, Some(288)); // nearest rank 244
        metrics.capture("full_root", "shm", 1920 * 1080);
        assert_eq!(metrics.report(false).transferred_pixels, 1920 * 1080);
        let interval = metrics.report(true);
        assert_eq!(interval.stages["hash"].count, 300);
        assert_eq!(interval.stages["hash"].p95_us, Some(288));
        assert_eq!(interval.capture_mode, Some("full_root"));
        assert_eq!(interval.capture_transport, Some("shm"));
        assert_eq!(interval.transferred_pixels, 1920 * 1080);
        assert_eq!(metrics.report(false).stages["hash"].count, 0);
        assert_eq!(metrics.report(false).capture_mode, None);
        assert_eq!(metrics.report(false).transferred_pixels, 0);
    }

    #[test]
    fn no_private_payload_or_unbounded_stage_keys() {
        let metrics = Metrics::default();
        metrics.record("private query text", Duration::from_micros(3));
        assert_eq!(metrics.report(false).stages.len(), STAGES.len());
        assert!(!serde_json::to_string(&metrics.report(false))
            .unwrap()
            .contains("private"));
    }
}
