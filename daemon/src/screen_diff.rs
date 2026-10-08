//! On-demand, metadata-only dirty regions for complete root captures.
//! The live backend hashes native X11 pixels without RGBA conversion; decoded
//! RGBA ingestion remains available for callers and the verified-partial API.
//! No PNG is encoded here.
use crate::capture::{CaptureResult, NativePixelFormat, RgbaFrame, TileHash};
use serde::Serialize;
use std::io;

const MAX_REGIONS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl From<&TileHash> for Rect {
    fn from(tile: &TileHash) -> Self {
        Self {
            x: tile.x,
            y: tile.y,
            width: tile.width,
            height: tile.height,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    FullRoot,
    VerifiedPartial,
}

#[derive(Debug, Serialize)]
pub struct ScreenDiffUpdate {
    pub revision: u64,
    /// Explicit about bandwidth: root XDamage hints do not authorize partial capture.
    pub capture_mode: CaptureMode,
    /// True on the first update or after a screen resize.
    pub baseline: bool,
    pub screen_width: u16,
    pub screen_height: u16,
    pub tile_size: u16,
    /// Number of changed tiles (all tiles on a baseline).
    pub dirty_tiles: usize,
    /// Absolute root-window rectangles. A baseline covers the whole screen.
    pub regions: Vec<Rect>,
    /// True only when more than 64 regions required a conservative bounding rectangle.
    pub summarized: bool,
}

pub struct ScreenDiffCache {
    tile_size: u16,
    dimensions: Option<(u16, u16)>,
    hashes: Vec<u64>,
    revision: u64,
    representation: Option<HashRepresentation>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HashRepresentation {
    Rgba,
    Native(NativePixelFormat),
}

impl ScreenDiffCache {
    pub fn new(tile_size: u16) -> Self {
        assert!(tile_size > 0, "tile size must be positive");
        Self {
            tile_size,
            dimensions: None,
            hashes: Vec::new(),
            revision: 0,
            representation: None,
        }
    }

    pub fn tile_size(&self) -> u16 {
        self.tile_size
    }

    pub fn dimensions(&self) -> Option<(u16, u16)> {
        self.dimensions
    }

    /// Discard hashes after a failed or uncertain capture. The next full frame is a baseline.
    pub fn invalidate(&mut self) {
        self.dimensions = None;
        self.hashes.clear();
        self.representation = None;
    }

    /// Ingest complete, tile-aligned GetImage rectangles. All supplied pixels must
    /// belong to distinct whole tiles (partial tiles at screen edges are allowed).
    /// Missing tiles retain their previous hashes. Errors leave the cache unchanged.
    /// Only use when the rectangle source guarantees *complete* dirty coverage.
    pub fn update_partial(
        &mut self,
        dimensions: (u16, u16),
        patches: &[(Rect, RgbaFrame)],
    ) -> CaptureResult<ScreenDiffUpdate> {
        let (width, height) = dimensions;
        if width == 0
            || height == 0
            || self.dimensions != Some(dimensions)
            || self.representation != Some(HashRepresentation::Rgba)
        {
            return Err(invalid_partial(
                "partial update requires an existing matching baseline",
            ));
        }
        let cols = width.div_ceil(self.tile_size) as usize;
        let rows = height.div_ceil(self.tile_size) as usize;
        if self.hashes.len() != cols * rows {
            return Err(invalid_partial("missing tile hashes"));
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid_partial("screen diff revision exhausted"))?;
        let mut new_hashes = self.hashes.clone();
        let mut seen = vec![false; cols * rows];
        let mut changed = Vec::new();
        for (rect, frame) in patches {
            let right = u32::from(rect.x) + u32::from(rect.width);
            let bottom = u32::from(rect.y) + u32::from(rect.height);
            if rect.width == 0
                || rect.height == 0
                || rect.x % self.tile_size != 0
                || rect.y % self.tile_size != 0
                || right > u32::from(width)
                || bottom > u32::from(height)
                || (right != u32::from(width) && rect.width % self.tile_size != 0)
                || (bottom != u32::from(height) && rect.height % self.tile_size != 0)
                || (frame.width, frame.height) != (rect.width, rect.height)
            {
                return Err(invalid_partial("invalid partial tile rectangle"));
            }
            for mut tile in frame.tile_hashes(self.tile_size)? {
                tile.x += rect.x;
                tile.y += rect.y;
                let index = usize::from(tile.y / self.tile_size) * cols
                    + usize::from(tile.x / self.tile_size);
                if seen[index] {
                    return Err(invalid_partial("overlapping partial tiles"));
                }
                seen[index] = true;
                if new_hashes[index] != tile.hash {
                    new_hashes[index] = tile.hash;
                    changed.push((index, tile));
                }
            }
        }
        changed.sort_by_key(|(index, _)| *index);
        let mut accumulator = RegionAccumulator::default();
        for (_, tile) in &changed {
            accumulator.add(tile);
        }
        let (dirty_tiles, regions, summarized) = accumulator.finish();
        self.hashes = new_hashes;
        self.revision = revision;
        Ok(ScreenDiffUpdate {
            revision,
            capture_mode: CaptureMode::VerifiedPartial,
            baseline: false,
            screen_width: width,
            screen_height: height,
            tile_size: self.tile_size,
            dirty_tiles,
            regions,
            summarized,
        })
    }

    /// Compare a full root frame against the previous successful request.
    /// Invalid frames and revision exhaustion leave the cache untouched.
    pub fn update(&mut self, frame: &RgbaFrame) -> CaptureResult<ScreenDiffUpdate> {
        if frame.width == 0 || frame.height == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty root frame").into());
        }
        let tiles = frame.tile_hashes(self.tile_size)?;
        self.update_hashes((frame.width, frame.height), tiles, HashRepresentation::Rgba)
    }

    /// Consume full-screen native X11 tile hashes without an RGBA conversion.
    /// Switching between RGBA and native hash representations starts a baseline.
    pub fn update_native(
        &mut self,
        dimensions: (u16, u16),
        tiles: Vec<TileHash>,
        format: NativePixelFormat,
    ) -> CaptureResult<ScreenDiffUpdate> {
        if dimensions.0 == 0
            || dimensions.1 == 0
            || tiles.len()
                != usize::from(dimensions.0.div_ceil(self.tile_size))
                    * usize::from(dimensions.1.div_ceil(self.tile_size))
        {
            return Err(invalid_partial("invalid native tile count or dimensions"));
        }
        self.update_hashes(dimensions, tiles, HashRepresentation::Native(format))
    }

    fn update_hashes(
        &mut self,
        dimensions: (u16, u16),
        tiles: Vec<TileHash>,
        representation: HashRepresentation,
    ) -> CaptureResult<ScreenDiffUpdate> {
        let revision = self.revision.checked_add(1).ok_or_else(|| {
            io::Error::new(io::ErrorKind::Other, "screen diff revision exhausted")
        })?;
        let baseline = self.dimensions != Some(dimensions)
            || self.hashes.len() != tiles.len()
            || self.representation != Some(representation);
        let (dirty_tiles, regions, summarized) = if baseline {
            (
                tiles.len(),
                vec![Rect {
                    x: 0,
                    y: 0,
                    width: dimensions.0,
                    height: dimensions.1,
                }],
                false,
            )
        } else {
            let mut accumulator = RegionAccumulator::default();
            for (tile, previous_hash) in tiles.iter().zip(&self.hashes) {
                if tile.hash != *previous_hash {
                    accumulator.add(tile);
                }
            }
            accumulator.finish()
        };
        self.hashes = tiles.into_iter().map(|tile| tile.hash).collect();
        self.dimensions = Some(dimensions);
        self.representation = Some(representation);
        self.revision = revision;
        Ok(ScreenDiffUpdate {
            revision,
            capture_mode: CaptureMode::FullRoot,
            baseline,
            screen_width: dimensions.0,
            screen_height: dimensions.1,
            tile_size: self.tile_size,
            dirty_tiles,
            regions,
            summarized,
        })
    }
}

fn invalid_partial(message: &'static str) -> Box<dyn std::error::Error + Send + Sync> {
    io::Error::new(io::ErrorKind::InvalidInput, message).into()
}

#[derive(Default)]
struct RegionAccumulator {
    dirty_tiles: usize,
    bounds: Option<Rect>,
    regions: Vec<Rect>,
    // (x, width, region index) for runs on the preceding dirty row.
    previous: Vec<(u16, u16, usize)>,
    current: Vec<Rect>,
    row: Option<u16>,
    summarized: bool,
}

impl RegionAccumulator {
    fn add(&mut self, tile: &TileHash) {
        let rect = Rect::from(tile);
        self.dirty_tiles += 1;
        self.bounds = Some(match self.bounds {
            None => rect,
            Some(bounds) => {
                let x = bounds.x.min(rect.x);
                let y = bounds.y.min(rect.y);
                let right = (u32::from(bounds.x) + u32::from(bounds.width))
                    .max(u32::from(rect.x) + u32::from(rect.width));
                let bottom = (u32::from(bounds.y) + u32::from(bounds.height))
                    .max(u32::from(rect.y) + u32::from(rect.height));
                Rect {
                    x,
                    y,
                    width: (right - u32::from(x)) as u16,
                    height: (bottom - u32::from(y)) as u16,
                }
            }
        });
        if self.summarized {
            return;
        }
        if self.row != Some(rect.y) {
            self.flush();
            if self.summarized {
                return;
            }
            self.row = Some(rect.y);
        }
        if let Some(last) = self.current.last_mut() {
            if u32::from(last.x) + u32::from(last.width) == u32::from(rect.x) {
                last.width += rect.width;
                return;
            }
        }
        self.current.push(rect);
        if self.current.len() > MAX_REGIONS {
            self.summarize();
        }
    }

    fn flush(&mut self) {
        if self.summarized {
            return;
        }
        let mut next = Vec::new();
        for run in std::mem::take(&mut self.current) {
            if let Some(&(_, _, index)) = self.previous.iter().find(|&&(x, width, index)| {
                x == run.x
                    && width == run.width
                    && u32::from(self.regions[index].y) + u32::from(self.regions[index].height)
                        == u32::from(run.y)
            }) {
                self.regions[index].height += run.height;
                next.push((run.x, run.width, index));
            } else {
                let index = self.regions.len();
                self.regions.push(run);
                next.push((run.x, run.width, index));
            }
            if self.regions.len() > MAX_REGIONS {
                self.summarize();
                return;
            }
        }
        self.previous = next;
    }

    fn summarize(&mut self) {
        self.regions.clear();
        self.previous.clear();
        self.current.clear();
        self.summarized = true;
    }

    fn finish(mut self) -> (usize, Vec<Rect>, bool) {
        self.flush();
        if self.summarized {
            // Every changed tile contributed to bounds, even after the region cap.
            self.regions
                .push(self.bounds.expect("summarized dirty region"));
        }
        (self.dirty_tiles, self.regions, self.summarized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u16, height: u16) -> RgbaFrame {
        RgbaFrame {
            width,
            height,
            rgba: vec![0; usize::from(width) * usize::from(height) * 4],
        }
    }

    fn paint(frame: &mut RgbaFrame, x: u16, y: u16) {
        frame.rgba[(usize::from(y) * usize::from(frame.width) + usize::from(x)) * 4] = 255;
    }

    fn rect(x: u16, y: u16, width: u16, height: u16) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn baseline_and_unchanged() {
        let mut cache = ScreenDiffCache::new(2);
        let image = frame(5, 3);
        let first = cache.update(&image).unwrap();
        assert_eq!(first.revision, 1);
        assert!(first.baseline);
        assert!(!first.summarized);
        assert_eq!(
            (first.screen_width, first.screen_height, first.tile_size),
            (5, 3, 2)
        );
        assert_eq!(first.dirty_tiles, 6);
        assert_eq!(first.regions, [rect(0, 0, 5, 3)]);
        let second = cache.update(&image).unwrap();
        assert_eq!(second.revision, 2);
        assert!(!second.baseline && !second.summarized);
        assert_eq!(second.dirty_tiles, 0);
        assert!(second.regions.is_empty());
        let json = serde_json::to_value(&second).unwrap();
        assert_eq!(json["regions"], serde_json::json!([]));
        assert_eq!(json["screen_width"], 5);
    }

    #[test]
    fn one_tile_and_horizontal_merge() {
        let mut cache = ScreenDiffCache::new(2);
        let mut image = frame(8, 6);
        cache.update(&image).unwrap();
        paint(&mut image, 5, 3);
        let one = cache.update(&image).unwrap();
        assert_eq!(one.dirty_tiles, 1);
        assert_eq!(one.regions, [rect(4, 2, 2, 2)]);
        paint(&mut image, 7, 3);
        paint(&mut image, 3, 3);
        let horizontal = cache.update(&image).unwrap();
        assert_eq!(horizontal.dirty_tiles, 2);
        assert_eq!(horizontal.regions, [rect(2, 2, 2, 2), rect(6, 2, 2, 2)]);

        let mut cache = ScreenDiffCache::new(2);
        cache.update(&frame(8, 6)).unwrap();
        let mut image = frame(8, 6);
        paint(&mut image, 2, 0);
        paint(&mut image, 4, 0);
        let merged = cache.update(&image).unwrap();
        assert_eq!(merged.dirty_tiles, 2);
        assert_eq!(merged.regions, [rect(2, 0, 4, 2)]);
    }

    #[test]
    fn vertical_and_rectangular_merge() {
        let mut cache = ScreenDiffCache::new(2);
        let mut image = frame(6, 8);
        cache.update(&image).unwrap();
        for &(x, y) in &[(2, 2), (2, 4), (2, 6)] {
            paint(&mut image, x, y);
        }
        let vertical = cache.update(&image).unwrap();
        assert_eq!(vertical.regions, [rect(2, 2, 2, 6)]);
        paint(&mut image, 0, 0);
        paint(&mut image, 2, 0);
        paint(&mut image, 0, 2);
        let rectangle = cache.update(&image).unwrap();
        assert_eq!(rectangle.regions, [rect(0, 0, 4, 2), rect(0, 2, 2, 2)]);
    }

    #[test]
    fn diagonal_tiles_do_not_merge() {
        let mut cache = ScreenDiffCache::new(2);
        let mut image = frame(4, 4);
        cache.update(&image).unwrap();
        paint(&mut image, 0, 0);
        paint(&mut image, 2, 2);
        let update = cache.update(&image).unwrap();
        assert_eq!(update.dirty_tiles, 2);
        assert_eq!(update.regions, [rect(0, 0, 2, 2), rect(2, 2, 2, 2)]);
        assert!(!update.summarized);
    }

    #[test]
    fn odd_edges_resize_and_failed_update() {
        let mut cache = ScreenDiffCache::new(2);
        let mut image = frame(5, 3);
        cache.update(&image).unwrap();
        paint(&mut image, 4, 2);
        paint(&mut image, 2, 2);
        let edges = cache.update(&image).unwrap();
        assert_eq!(edges.dirty_tiles, 2);
        assert_eq!(edges.regions, [rect(2, 2, 3, 1)]);
        assert!(cache
            .update(&RgbaFrame {
                width: 5,
                height: 3,
                rgba: vec![0]
            })
            .is_err());
        assert!(cache.update(&frame(0, 2)).is_err());
        let unchanged = cache.update(&image).unwrap();
        assert_eq!(unchanged.revision, 3);
        assert!(unchanged.regions.is_empty());
        let resized = cache.update(&frame(3, 5)).unwrap();
        assert_eq!(resized.revision, 4);
        assert!(resized.baseline);
        assert_eq!(resized.dirty_tiles, 6);
        assert_eq!(resized.regions, [rect(0, 0, 3, 5)]);
        let tiny = cache.update(&frame(1, 1)).unwrap();
        assert!(tiny.baseline);
        assert_eq!(tiny.dirty_tiles, 1);
        assert_eq!(tiny.regions, [rect(0, 0, 1, 1)]);
    }

    #[test]
    fn native_hash_representation_keeps_baselines_consistent() {
        use x11rb::protocol::xproto::ImageOrder;
        let format = NativePixelFormat {
            depth: 24,
            bpp: 32,
            pad: 32,
            order: ImageOrder::LSB_FIRST,
            masks: [0xff0000, 0xff00, 0xff],
        };
        let changed_format = NativePixelFormat {
            depth: 32,
            ..format
        };
        let mut cache = ScreenDiffCache::new(2);
        let dimensions = (3, 3);
        let tiles = |last| {
            (0..2)
                .flat_map(|y| {
                    (0..2).map(move |x| TileHash {
                        x: x * 2,
                        y: y * 2,
                        width: if x == 1 { 1 } else { 2 },
                        height: if y == 1 { 1 } else { 2 },
                        hash: if x == 1 && y == 1 { last } else { 17 },
                    })
                })
                .collect::<Vec<_>>()
        };
        assert!(
            cache
                .update_native(dimensions, tiles(42), format)
                .unwrap()
                .baseline
        );
        let get_image = cache.update_native(dimensions, tiles(42), format).unwrap();
        assert!(!get_image.baseline);
        assert_eq!(get_image.dirty_tiles, 0);
        let changed = cache.update_native(dimensions, tiles(43), format).unwrap();
        assert_eq!(changed.regions, [rect(2, 2, 1, 1)]);
        assert!(
            cache
                .update_native(dimensions, tiles(43), changed_format)
                .unwrap()
                .baseline
        );
        assert_eq!(
            cache
                .update_native(dimensions, tiles(43), changed_format)
                .unwrap()
                .dirty_tiles,
            0
        );
        for changed_format in [
            NativePixelFormat { bpp: 24, ..format },
            NativePixelFormat { pad: 64, ..format },
            NativePixelFormat {
                order: ImageOrder::MSB_FIRST,
                ..format
            },
            NativePixelFormat {
                masks: [0xff, 0xff00, 0xff0000],
                ..format
            },
        ] {
            assert!(
                cache
                    .update_native(dimensions, tiles(43), changed_format)
                    .unwrap()
                    .baseline
            );
            assert!(
                cache
                    .update_native(dimensions, tiles(43), format)
                    .unwrap()
                    .baseline
            );
            assert_eq!(
                cache
                    .update_native(dimensions, tiles(43), format)
                    .unwrap()
                    .dirty_tiles,
                0
            );
        }
        assert!(cache.update(&frame(3, 3)).unwrap().baseline);
        assert!(
            cache
                .update_native(dimensions, tiles(43), format)
                .unwrap()
                .baseline
        );
        assert!(cache.update_partial(dimensions, &[]).is_err());
        assert!(cache.update_native(dimensions, vec![], format).is_err());
    }

    #[test]
    fn partial_ingestion_is_transactional_and_preserves_untouched_tiles() {
        let mut cache = ScreenDiffCache::new(2);
        let mut image = frame(5, 3);
        cache.update(&image).unwrap();
        paint(&mut image, 4, 2);
        paint(&mut image, 0, 0);
        let edge = rect(4, 2, 1, 1);
        let patch = image.crop(4, 2, 1, 1).unwrap();
        assert!(cache
            .update_partial((5, 3), &[(edge, patch.clone()), (edge, patch.clone())])
            .is_err());
        assert!(cache
            .update_partial(
                (5, 3),
                &[(rect(3, 2, 2, 1), image.crop(3, 2, 2, 1).unwrap())]
            )
            .is_err());
        assert!(cache.update_partial((6, 3), &[]).is_err());
        let result = cache
            .update_partial((5, 3), &[(edge, patch.clone())])
            .unwrap();
        assert_eq!(result.revision, 2);
        assert_eq!(result.regions, [edge]);
        assert_eq!(
            cache
                .update_partial((5, 3), &[(edge, patch)])
                .unwrap()
                .dirty_tiles,
            0
        );
        // The other painted tile was not ingested; a full scan still finds it.
        let full = cache.update(&image).unwrap();
        assert_eq!(full.regions, [rect(0, 0, 2, 2)]);
        cache.invalidate();
        assert!(cache.update_partial((5, 3), &[]).is_err());
        assert!(cache.update(&image).unwrap().baseline);
    }

    #[test]
    fn partial_merges_and_summarizes_in_row_major_order() {
        let mut cache = ScreenDiffCache::new(1);
        let mut image = frame(24, 24);
        cache.update(&image).unwrap();
        let mut patches = Vec::new();
        for y in 0..24 {
            for x in 0..24 {
                if (x + y) % 2 == 0 {
                    paint(&mut image, x, y);
                    patches.push((rect(x, y, 1, 1), image.crop(x, y, 1, 1).unwrap()));
                }
            }
        }
        patches.reverse();
        let result = cache.update_partial((24, 24), &patches).unwrap();
        assert_eq!(result.dirty_tiles, 288);
        assert!(result.summarized);
        assert_eq!(result.regions, [rect(0, 0, 24, 24)]);
    }

    #[test]
    fn scattered_tiles_are_capped_by_dirty_bounds() {
        let mut cache = ScreenDiffCache::new(1);
        let mut image = frame(24, 24);
        cache.update(&image).unwrap();
        for y in 2..20 {
            for x in 3..21 {
                if (x + y) % 2 == 0 {
                    paint(&mut image, x, y);
                }
            }
        }
        let update = cache.update(&image).unwrap();
        assert_eq!(update.dirty_tiles, 162);
        assert!(update.summarized);
        assert_eq!(update.regions, [rect(3, 2, 18, 18)]);
        let unchanged = cache.update(&image).unwrap();
        assert!(!unchanged.summarized);
        assert!(unchanged.regions.is_empty());
    }
}
