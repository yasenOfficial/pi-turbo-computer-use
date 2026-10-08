//! On-demand incremental visual crops. No background screenshots or damage stream.
use crate::capture::{CaptureResult, RgbaFrame, TileHash};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Serialize)]
pub struct VisualPatch {
    /// Absolute root-window coordinates.
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub png_base64: String,
}

#[derive(Debug, Serialize)]
pub struct VisualUpdate {
    /// True if the client must discard earlier patches for this crop.
    pub full: bool,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub tile_size: u16,
    /// Pass this as `since_visual` on the next incremental request.
    pub revision: u64,
    pub patches: Vec<VisualPatch>,
}

pub struct VisualCache {
    tile_size: u16,
    // Cache is scoped to one crop; a different id or geometry starts a new baseline.
    key: Option<String>,
    bounds: Option<Rect>,
    hashes: Vec<TileHash>,
    revision: u64,
}

impl Default for VisualCache {
    fn default() -> Self {
        Self::new(64)
    }
}

impl VisualCache {
    pub fn new(tile_size: u16) -> Self {
        assert!(tile_size > 0, "tile size must be positive");
        Self {
            tile_size,
            key: None,
            bounds: None,
            hashes: Vec::new(),
            revision: 0,
        }
    }

    pub fn update(
        &mut self,
        key: &str,
        bounds: Rect,
        frame: &RgbaFrame,
        since_visual: Option<u64>,
    ) -> CaptureResult<VisualUpdate> {
        if frame.width != bounds.width || frame.height != bounds.height {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "crop/frame dimensions differ",
            )
            .into());
        }
        let hashes = frame.tile_hashes(self.tile_size)?;
        let full = since_visual != Some(self.revision)
            || self.key.as_deref() != Some(key)
            || self.bounds != Some(bounds)
            || self.hashes.len() != hashes.len();
        let dirty: Vec<bool> = hashes
            .iter()
            .enumerate()
            .map(|(i, tile)| full || self.hashes[i].hash != tile.hash)
            .collect();
        let rects = merge_dirty_tiles(&hashes, &dirty);
        // Commit only after all patches have been successfully encoded.
        let patches = rects
            .into_iter()
            .map(|rect| {
                let png_base64 = frame
                    .crop(rect.x, rect.y, rect.width, rect.height)?
                    .png_base64()?;
                Ok(VisualPatch {
                    x: u32::from(bounds.x)
                        .checked_add(u32::from(rect.x))
                        .and_then(|x| u16::try_from(x).ok())
                        .ok_or_else(|| {
                            std::io::Error::new(
                                std::io::ErrorKind::InvalidInput,
                                "patch x overflow",
                            )
                        })?,
                    y: u32::from(bounds.y)
                        .checked_add(u32::from(rect.y))
                        .and_then(|y| u16::try_from(y).ok())
                        .ok_or_else(|| {
                            std::io::Error::new(
                                std::io::ErrorKind::InvalidInput,
                                "patch y overflow",
                            )
                        })?,
                    width: rect.width,
                    height: rect.height,
                    png_base64,
                })
            })
            .collect::<CaptureResult<Vec<_>>>()?;
        self.key = Some(key.to_owned());
        self.bounds = Some(bounds);
        self.hashes = hashes;
        self.revision = self.revision.checked_add(1).unwrap_or(1);
        Ok(VisualUpdate {
            full,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            tile_size: self.tile_size,
            revision: self.revision,
            patches,
        })
    }
}

/// Coalesce horizontal runs of dirty tiles, then extend equal runs vertically.
/// Partial edge tiles are sized from their real pixel bounds.
fn merge_dirty_tiles(tiles: &[TileHash], dirty: &[bool]) -> Vec<Rect> {
    let mut result: Vec<Rect> = Vec::new();
    let mut previous: Vec<(u16, u16, usize)> = Vec::new(); // x, width, result index
    let mut i = 0;
    while i < tiles.len() {
        let row_y = tiles[i].y;
        let mut next = Vec::new();
        while i < tiles.len() && tiles[i].y == row_y {
            if !dirty[i] {
                i += 1;
                continue;
            }
            let x = tiles[i].x;
            let mut width = tiles[i].width;
            let height = tiles[i].height;
            i += 1;
            while i < tiles.len()
                && tiles[i].y == row_y
                && dirty[i]
                && u32::from(x) + u32::from(width) == u32::from(tiles[i].x)
            {
                width += tiles[i].width;
                i += 1;
            }
            if let Some(&(_, _, index)) = previous.iter().find(|&&(px, pw, index)| {
                px == x
                    && pw == width
                    && u32::from(result[index].y) + u32::from(result[index].height)
                        == u32::from(row_y)
            }) {
                result[index].height += height;
                next.push((x, width, index));
            } else {
                let index = result.len();
                result.push(Rect {
                    x,
                    y: row_y,
                    width,
                    height,
                });
                next.push((x, width, index));
            }
        }
        previous = next;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(w: u16, h: u16) -> RgbaFrame {
        RgbaFrame {
            width: w,
            height: h,
            rgba: vec![0; usize::from(w) * usize::from(h) * 4],
        }
    }
    #[test]
    fn baseline_unchanged_changed_and_reset() {
        let mut cache = VisualCache::default();
        let bounds = Rect {
            x: 10,
            y: 20,
            width: 130,
            height: 130,
        };
        let mut image = frame(130, 130);
        let first = cache.update("one", bounds, &image, None).unwrap();
        assert!(first.full);
        assert_eq!(first.patches.len(), 1);
        assert_eq!(
            (
                first.patches[0].x,
                first.patches[0].y,
                first.patches[0].width,
                first.patches[0].height
            ),
            (10, 20, 130, 130)
        );
        let unchanged = cache
            .update("one", bounds, &image, Some(first.revision))
            .unwrap();
        assert!(!unchanged.full && unchanged.patches.is_empty());
        image.rgba[(129 * 130 + 129) * 4] = 255;
        let changed = cache
            .update("one", bounds, &image, Some(unchanged.revision))
            .unwrap();
        assert!(!changed.full);
        assert_eq!(
            (
                changed.patches[0].x,
                changed.patches[0].y,
                changed.patches[0].width,
                changed.patches[0].height
            ),
            (138, 148, 2, 2)
        );
        // A second client without our revision must get a baseline, not an empty delta.
        let second = cache.update("one", bounds, &image, None).unwrap();
        assert!(second.full);
        let other = cache
            .update("other", bounds, &image, Some(second.revision))
            .unwrap();
        assert!(other.full);
        assert!(
            cache
                .update(
                    "other",
                    Rect { x: 11, ..bounds },
                    &image,
                    Some(other.revision)
                )
                .unwrap()
                .full
        );
    }
    #[test]
    fn configured_tile_size_is_used_for_hashes_and_response() {
        let mut cache = VisualCache::new(32);
        let bounds = Rect {
            x: 0,
            y: 0,
            width: 65,
            height: 1,
        };
        let image = frame(65, 1);
        let baseline = cache.update("crop", bounds, &image, None).unwrap();
        assert_eq!(baseline.tile_size, 32);
        assert_eq!(cache.hashes.len(), 3);
    }

    #[test]
    fn merge_adjoining_runs_without_swallowing_clean_tiles() {
        let hashes = frame(130, 130).tile_hashes(64).unwrap();
        let dirty = [true, true, false, true, true, false, false, false, true];
        let rects = merge_dirty_tiles(&hashes, &dirty);
        assert_eq!(
            rects,
            vec![
                Rect {
                    x: 0,
                    y: 0,
                    width: 128,
                    height: 128
                },
                Rect {
                    x: 128,
                    y: 128,
                    width: 2,
                    height: 2
                }
            ]
        );
    }
}
