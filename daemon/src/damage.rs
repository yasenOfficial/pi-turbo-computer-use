//! XDamage root notifications are *hints*, not a complete screen-change stream.
//! Damage is attached to a drawable; child windows and compositors can update
//! the visible screen without damaging the root drawable. Never interpret an
//! empty root event queue as evidence that the screen is unchanged.
//!
//! Integration (main.rs): lazily create
//! `capture::damage::ScreenDirtyBackend::new(tile_size)` and, after hiding
//! the overlay, call `backend.update_profiled()` for `(ScreenDiffUpdate, CaptureStages)`
//! (or `backend.update()` if timings are not needed). This
//! replaces the dirty-region `ScreenDiffCache` field; keep the existing
//! `X11Capture` for explicit screenshots.
//! `capture_verified` is for a *different*, independently proven complete dirty
//! rectangle source only; root XDamage does NOT meet that contract. The current
//! native-hash baseline never enters the decoded-RGBA sparse-partial path.

use crate::capture::{CaptureResult, CaptureTransport, X11Capture};
use crate::screen_diff::{Rect, ScreenDiffCache, ScreenDiffUpdate};
use std::io;
use std::time::{Duration, Instant};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::damage::{ConnectionExt as _, ReportLevel};
use x11rb::protocol::xproto::{ConnectionExt as _, Window};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

const MAX_EVENTS: usize = 4096;
const MAX_PATCHES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DamageRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl From<Rect> for DamageRect {
    fn from(value: Rect) -> Self {
        Self {
            x: i32::from(value.x),
            y: i32::from(value.y),
            width: u32::from(value.width),
            height: u32::from(value.height),
        }
    }
}

/// Convert rectangles (including negative or off-screen bounds) to a deduplicated,
/// row-major list of exact screen tiles. Overflowing/empty rectangles are invalid.
/// This is a geometry utility, NOT an assertion that XDamage covers all changes.
pub fn rectangles_to_tiles(
    dimensions: (u16, u16),
    tile_size: u16,
    rects: &[DamageRect],
) -> CaptureResult<Vec<Rect>> {
    let (width, height) = dimensions;
    if width == 0 || height == 0 || tile_size == 0 {
        return Err(invalid("empty screen or tile size"));
    }
    let cols = usize::from(width.div_ceil(tile_size));
    let rows = usize::from(height.div_ceil(tile_size));
    let mut flags = vec![false; cols * rows];
    for rect in rects {
        if rect.width == 0 || rect.height == 0 {
            return Err(invalid("empty damage rectangle"));
        }
        let right = i64::from(rect.x) + i64::from(rect.width);
        let bottom = i64::from(rect.y) + i64::from(rect.height);
        if right > i64::from(i32::MAX) || bottom > i64::from(i32::MAX) {
            return Err(invalid("damage rectangle overflow"));
        }
        let left = i64::from(rect.x).max(0).min(i64::from(width));
        let top = i64::from(rect.y).max(0).min(i64::from(height));
        let right = right.max(0).min(i64::from(width));
        let bottom = bottom.max(0).min(i64::from(height));
        if left >= right || top >= bottom {
            continue;
        }
        let start_x = left as usize / usize::from(tile_size);
        let end_x = (right as usize - 1) / usize::from(tile_size);
        let start_y = top as usize / usize::from(tile_size);
        let end_y = (bottom as usize - 1) / usize::from(tile_size);
        for y in start_y..=end_y {
            for x in start_x..=end_x {
                flags[y * cols + x] = true;
            }
        }
    }
    let mut result = Vec::new();
    for (index, marked) in flags.into_iter().enumerate() {
        if marked {
            let x = (index % cols * usize::from(tile_size)) as u16;
            let y = (index / cols * usize::from(tile_size)) as u16;
            result.push(Rect {
                x,
                y,
                width: tile_size.min(width - x),
                height: tile_size.min(height - y),
            });
        }
    }
    Ok(result)
}

fn invalid(message: &'static str) -> Box<dyn std::error::Error + Send + Sync> {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}

#[derive(Debug)]
pub struct DamageDrain {
    /// Total dequeued events, including unexpected ones (used for overflow detection).
    pub events: usize,
    pub damage_events: usize,
    pub rectangles: Vec<DamageRect>,
    /// True if the stream overflowed, was malformed, or contains unrecognized events.
    pub uncertain: bool,
    /// A compositor's selection owner was detected. Root damage is not complete
    /// even when this is false (child window damage is still independent).
    pub compositor_active: bool,
}

/// Internal timing/transport report; fields are not added to the wire response.
#[derive(Debug, Default, Clone, Copy)]
pub struct CaptureStages {
    pub acquisition: Duration,
    pub convert: Duration,
    pub hash: Duration,
    pub merge: Duration,
    /// Successful transport for the final, size-verified full-root capture.
    pub transport: CaptureTransport,
}

/// Drop-in backend for DirtyRegions. A missing/broken XDamage extension does
/// not prevent safe full-frame diffing. No PNG is encoded.
pub struct ScreenDirtyBackend {
    capture: X11Capture,
    cache: ScreenDiffCache,
    tracker: Option<DamageTracker>,
}

impl ScreenDirtyBackend {
    pub fn new(tile_size: u16) -> CaptureResult<Self> {
        if tile_size == 0 {
            return Err(invalid("empty tile size"));
        }
        let capture = X11Capture::new()?;
        let tracker = DamageTracker::new().ok().flatten();
        Ok(Self {
            capture,
            cache: ScreenDiffCache::new(tile_size),
            tracker,
        })
    }

    pub fn update(&mut self) -> CaptureResult<ScreenDiffUpdate> {
        self.update_profiled().map(|(update, _)| update)
    }

    /// Full-root update and separate capture/convert/hash/merge timings.
    /// Native dirty hashing does not convert to RGBA, so `convert` is zero.
    pub fn update_profiled(&mut self) -> CaptureResult<(ScreenDiffUpdate, CaptureStages)> {
        let drain_start = Instant::now();
        if let Some(tracker) = &self.tracker {
            let _ = tracker.drain(); // Root damage is diagnostic only, never a skip hint.
        }
        let drain_duration = drain_start.elapsed();
        let result =
            capture_full_profiled(&self.capture, &mut self.cache).map(|(update, mut stages)| {
                stages.acquisition += drain_duration;
                (update, stages)
            });
        if result.is_err() {
            self.cache.invalidate();
        }
        result
    }

    /// Legacy incremental API for an independently complete screen-damage source.
    /// Root XDamage events alone must never be supplied as `complete_rects`.
    /// Native full-root baselines cannot accept decoded-RGBA patches and fall
    /// back to a fresh full-root read; this is not used by DirtyRegions.
    pub fn update_verified(
        &mut self,
        complete_rects: &[DamageRect],
    ) -> CaptureResult<ScreenDiffUpdate> {
        if let Some(tracker) = &self.tracker {
            tracker.capture_verified(&self.capture, &mut self.cache, complete_rects)
        } else {
            let result = capture_full(&self.capture, &mut self.cache);
            if result.is_err() {
                self.cache.invalidate();
            }
            result
        }
    }

    /// Returns optional XDamage diagnostics along with the diff update.
    pub fn update_with_stats(&mut self) -> CaptureResult<(Option<DamageDrain>, ScreenDiffUpdate)> {
        if let Some(tracker) = &self.tracker {
            tracker.capture_update_with_stats(&self.capture, &mut self.cache)
        } else {
            let result = capture_full(&self.capture, &mut self.cache);
            if result.is_err() {
                self.cache.invalidate();
            }
            result.map(|update| (None, update))
        }
    }
}

/// A dedicated connection: draining notifications cannot eat another module's events.
/// The root drawable is tracked to provide hints/telemetry only.
pub struct DamageTracker {
    conn: RustConnection,
    root: Window,
    damage: u32,
    compositor_selection: u32,
}

impl DamageTracker {
    /// `None` means XDamage is unavailable; callers must use full captures.
    pub fn new() -> CaptureResult<Option<Self>> {
        let (conn, screen) = x11rb::connect(None)?;
        if conn.extension_information("DAMAGE")?.is_none() {
            return Ok(None);
        }
        let version = conn.damage_query_version(1, 1)?.reply()?;
        if version.major_version < 1 {
            return Ok(None);
        }
        let root = conn.setup().roots[screen].root;
        let selection_name = format!("_NET_WM_CM_S{screen}");
        let compositor_selection = conn
            .intern_atom(false, selection_name.as_bytes())?
            .reply()?
            .atom;
        let damage = conn.generate_id()?;
        // Checked request: a failed create must not appear as an active tracker.
        conn.damage_create(damage, root, ReportLevel::RAW_RECTANGLES)?
            .check()?;
        conn.flush()?;
        Ok(Some(Self {
            conn,
            root,
            damage,
            compositor_selection,
        }))
    }

    pub fn drain(&self) -> CaptureResult<DamageDrain> {
        let compositor_active = self
            .conn
            .get_selection_owner(self.compositor_selection)?
            .reply()?
            .owner
            != 0;
        // A reply acts as a barrier for notifications queued before this request.
        self.conn.get_geometry(self.root)?.reply()?;
        let mut result = DamageDrain {
            events: 0,
            damage_events: 0,
            rectangles: Vec::new(),
            uncertain: false,
            compositor_active,
        };
        while let Some(event) = self.conn.poll_for_event()? {
            result.events += 1;
            if result.events > MAX_EVENTS {
                result.uncertain = true;
                break;
            }
            match event {
                Event::DamageNotify(event)
                    if event.damage == self.damage && event.drawable == self.root =>
                {
                    result.damage_events += 1;
                    let rect = DamageRect {
                        x: i32::from(event.area.x),
                        y: i32::from(event.area.y),
                        width: u32::from(event.area.width),
                        height: u32::from(event.area.height),
                    };
                    // The high bit marks more events in this batch.
                    if rect.width == 0
                        || rect.height == 0
                        || (u8::from(event.level) & 0x7f) != u8::from(ReportLevel::RAW_RECTANGLES)
                    {
                        result.uncertain = true;
                    }
                    result.rectangles.push(rect);
                }
                _ => result.uncertain = true,
            }
        }
        Ok(result)
    }

    /// Safe default. Root notifications are drained and counted, but the frame is
    /// scanned in full because root/child/compositor changes have incomplete coverage.
    /// No PNG is encoded. A failed capture invalidates cached hashes.
    pub fn capture_update(
        &self,
        capture: &X11Capture,
        cache: &mut ScreenDiffCache,
    ) -> CaptureResult<ScreenDiffUpdate> {
        self.capture_update_with_stats(capture, cache)
            .map(|(_, update)| update)
    }

    /// Like `capture_update`, but returns the event count and rectangles as
    /// telemetry. `None` means the event connection failed; the full scan still
    /// succeeds if SHM or fallback GetImage succeeds. Do not reuse these rectangles as a complete
    /// dirty set for `capture_verified`.
    pub fn capture_update_with_stats(
        &self,
        capture: &X11Capture,
        cache: &mut ScreenDiffCache,
    ) -> CaptureResult<(Option<DamageDrain>, ScreenDiffUpdate)> {
        let events = self.drain().ok();
        let result = capture_full(capture, cache);
        if result.is_err() {
            cache.invalidate();
        }
        result.map(|update| (events, update))
    }

    /// Fast path ONLY for rectangles from an independently verified, complete
    /// visible-screen damage stream, including window moves/unmaps/stack changes.
    /// Never pass `drain().rectangles` here. A compositor, event overflow,
    /// unsupported extension, resize or bad/expensive patch triggers full capture.
    /// A successful empty patch list is safe ONLY under that external guarantee.
    pub fn capture_verified(
        &self,
        capture: &X11Capture,
        cache: &mut ScreenDiffCache,
        complete_rects: &[DamageRect],
    ) -> CaptureResult<ScreenDiffUpdate> {
        let result = (|| {
            let drain = match self.drain() {
                Ok(drain) => drain,
                Err(_) => return capture_full(capture, cache),
            };
            let dimensions = capture.screen_size()?;
            if drain.uncertain || drain.compositor_active || cache.dimensions() != Some(dimensions)
            {
                return capture_full(capture, cache);
            }
            let tiles = match rectangles_to_tiles(dimensions, cache.tile_size(), complete_rects) {
                Ok(tiles) => tiles,
                Err(_) => return capture_full(capture, cache),
            };
            // Root damage can veto an incomplete external dirty list, but can
            // never certify its completeness (child/compositor damage is missing).
            let root_tiles =
                match rectangles_to_tiles(dimensions, cache.tile_size(), &drain.rectangles) {
                    Ok(tiles) => tiles,
                    Err(_) => return capture_full(capture, cache),
                };
            if root_tiles.iter().any(|root_tile| {
                tiles
                    .binary_search_by_key(&(root_tile.y, root_tile.x), |tile| (tile.y, tile.x))
                    .is_err()
            }) {
                return capture_full(capture, cache);
            }
            let total = usize::from(dimensions.0.div_ceil(cache.tile_size()))
                * usize::from(dimensions.1.div_ceil(cache.tile_size()));
            if tiles.len() > MAX_PATCHES || tiles.len() * 2 >= total {
                return capture_full(capture, cache);
            }
            // Group adjacent tiles on a row into one GetImage request.
            let mut runs: Vec<Rect> = Vec::new();
            for tile in tiles {
                if let Some(last) = runs.last_mut() {
                    if last.y == tile.y
                        && last.height == tile.height
                        && u32::from(last.x) + u32::from(last.width) == u32::from(tile.x)
                    {
                        last.width += tile.width;
                        continue;
                    }
                }
                runs.push(tile);
            }
            let mut patches = Vec::with_capacity(runs.len());
            for rect in runs {
                let frame = match capture.capture_rgba(rect.x, rect.y, rect.width, rect.height) {
                    Ok(frame) => frame,
                    Err(_) => return capture_full(capture, cache),
                };
                patches.push((rect, frame));
            }
            if capture.screen_size()? != dimensions {
                return capture_full(capture, cache);
            }
            match cache.update_partial(dimensions, &patches) {
                Ok(update) => Ok(update),
                Err(_) => capture_full(capture, cache),
            }
        })();
        if result.is_err() {
            cache.invalidate();
        }
        result
    }
}

fn capture_full(
    capture: &X11Capture,
    cache: &mut ScreenDiffCache,
) -> CaptureResult<ScreenDiffUpdate> {
    capture_full_profiled(capture, cache).map(|(update, _)| update)
}

fn capture_full_profiled(
    capture: &X11Capture,
    cache: &mut ScreenDiffCache,
) -> CaptureResult<(ScreenDiffUpdate, CaptureStages)> {
    let mut stages = CaptureStages::default();
    // A resize can race GetImage; retry once without committing stale hashes.
    for _ in 0..2 {
        let acquire_start = Instant::now();
        // Both MIT-SHM and GetImage provide the same native ZPixmap view.
        let (dimensions, tiles, format) = capture.with_screen_image(|image| {
            stages.acquisition += acquire_start.elapsed();
            stages.transport = image.transport();
            let hash_start = Instant::now();
            let tiles = image.tile_hashes(cache.tile_size())?;
            stages.hash += hash_start.elapsed();
            Ok(((image.width, image.height), tiles, image.format()))
        })?;
        let verify_start = Instant::now();
        let stable = capture.screen_size()? == dimensions;
        stages.acquisition += verify_start.elapsed();
        if stable {
            let merge_start = Instant::now();
            let update = cache.update_native(dimensions, tiles, format)?;
            stages.merge += merge_start.elapsed();
            return Ok((update, stages));
        }
    }
    Err(invalid("screen resized during capture"))
}

impl Drop for DamageTracker {
    fn drop(&mut self) {
        if let Ok(cookie) = self.conn.damage_destroy(self.damage) {
            let _ = cookie.check();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(x: i32, y: i32, width: u32, height: u32) -> DamageRect {
        DamageRect {
            x,
            y,
            width,
            height,
        }
    }
    #[test]
    fn clips_deduplicates_and_includes_partial_edge_tiles() {
        let tiles =
            rectangles_to_tiles((5, 3), 2, &[r(-1, -1, 2, 2), r(3, 1, 4, 5), r(4, 2, 1, 1)])
                .unwrap();
        assert_eq!(
            tiles,
            [
                Rect {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 2
                },
                Rect {
                    x: 2,
                    y: 0,
                    width: 2,
                    height: 2
                },
                Rect {
                    x: 4,
                    y: 0,
                    width: 1,
                    height: 2
                },
                Rect {
                    x: 2,
                    y: 2,
                    width: 2,
                    height: 1
                },
                Rect {
                    x: 4,
                    y: 2,
                    width: 1,
                    height: 1
                },
            ]
        );
        assert!(rectangles_to_tiles((5, 3), 2, &[r(8, 8, 1, 1)])
            .unwrap()
            .is_empty());
    }
    #[test]
    #[ignore = "requires an accessible X11 server; read-only full-root capture"]
    fn live_profiled_full_root_repeat() {
        let mut backend = ScreenDirtyBackend::new(64).unwrap();
        let (first, stages) = backend.update_profiled().unwrap();
        assert!(first.baseline);
        assert_eq!(stages.convert, Duration::ZERO);
        eprintln!("first full-root stages: {stages:?}");
        let mut samples = Vec::new();
        for _ in 0..20 {
            let (update, stages) = backend.update_profiled().unwrap();
            assert!(!update.baseline);
            assert_eq!(stages.convert, Duration::ZERO);
            assert!(matches!(
                stages.transport,
                CaptureTransport::Shm | CaptureTransport::GetImage
            ));
            samples.push(stages);
        }
        let percentile = |mut values: Vec<Duration>, percent: usize| {
            values.sort();
            values[((values.len() - 1) * percent).div_ceil(100)]
        };
        eprintln!("repeat full-root transport={} acquisition p50={:?} p95={:?}; hash p50={:?} p95={:?}; merge p50={:?}",
            samples[0].transport.as_str(),
            percentile(samples.iter().map(|s| s.acquisition).collect(), 50),
            percentile(samples.iter().map(|s| s.acquisition).collect(), 95),
            percentile(samples.iter().map(|s| s.hash).collect(), 50),
            percentile(samples.iter().map(|s| s.hash).collect(), 95),
            percentile(samples.iter().map(|s| s.merge).collect(), 50));
        backend.capture.shm_available = false;
        let (fallback, stages) = backend.update_profiled().unwrap();
        assert!(
            !fallback.baseline,
            "transport switch must retain native baseline"
        );
        assert_eq!(stages.transport, CaptureTransport::GetImage);
        backend.capture.shm_available = true;
        let (resumed, stages) = backend.update_profiled().unwrap();
        assert!(!resumed.baseline);
        eprintln!(
            "fallback transport={}, resumed transport={}",
            CaptureTransport::GetImage.as_str(),
            stages.transport.as_str()
        );
    }

    #[test]
    fn rejects_corrupt_rectangles_and_exact_tile_boundaries() {
        assert!(rectangles_to_tiles((5, 3), 2, &[r(0, 0, 0, 1)]).is_err());
        assert!(rectangles_to_tiles((5, 3), 2, &[r(i32::MAX, 0, 2, 1)]).is_err());
        assert!(rectangles_to_tiles((5, 3), 0, &[]).is_err());
        let tiles = rectangles_to_tiles((5, 3), 2, &[r(2, 0, 2, 2)]).unwrap();
        assert_eq!(
            tiles,
            [Rect {
                x: 2,
                y: 0,
                width: 2,
                height: 2
            }]
        );
    }
}
