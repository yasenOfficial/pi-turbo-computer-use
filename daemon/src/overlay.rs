//! Optional X11 visual feedback. Requires `x11rb` features `shape`, `render`, and `randr`.
//!
//! The window is never mapped while inactive. It has an empty X Shape *input*
//! region, so mouse clicks and pointer motion pass straight through to clients.
//! Rendering is direct to an ARGB window; this module does not subscribe to
//! Damage events or capture the screen (avoiding overlay-induced damage loops).

use std::{error::Error, io, time::Duration};

use crate::config::OverlayStyle;

// Render's Color (including FillRectangles and solid fills) is premultiplied;
// only gradient stops are straight-alpha. See libXrender.txt §2.4 and the
// Render protocol's compositing equations. Straight RGB with changing alpha
// gets clipped to alpha by compositors, looking like a constant neon line.
fn render_color(rgb: [u8; 3], opacity: f64) -> Color {
    let alpha = (opacity.clamp(0.0, 1.0) * 65535.0).round() as u16;
    let channel = |value: u8| ((u32::from(value) * 257 * u32::from(alpha) + 32767) / 65535) as u16;
    Color {
        red: channel(rgb[0]),
        green: channel(rgb[1]),
        blue: channel(rgb[2]),
        alpha,
    }
}

// A single antialiased Gaussian annulus, cached as an A8 Render mask. The
// smooth outer cutoff reaches exactly zero at the bounding box; no hard ring.
fn halo_profile(distance: f64, radius: f64) -> f64 {
    if distance >= radius {
        return 0.0;
    }
    let sigma = radius * 0.125;
    let gaussian = (-0.5 * ((distance - radius * 0.76) / sigma).powi(2)).exp();
    let t = ((radius - distance) / (radius * 0.18)).clamp(0.0, 1.0);
    gaussian * t * t * (3.0 - 2.0 * t)
}

fn halo_mask(radius: u16, pad: usize) -> Vec<u8> {
    let side = usize::from(radius) * 2 + 1;
    let stride = side.div_ceil(pad) * pad;
    let mut data = vec![0; stride * side];
    for y in 0..side {
        for x in 0..side {
            if x == 0 || y == 0 || x + 1 == side || y + 1 == side {
                continue;
            }
            // Four coverage samples suppress staircase edges on small halos.
            let mut coverage = 0.0;
            for sy in [-0.25, 0.25] {
                for sx in [-0.25, 0.25] {
                    let dx = x as f64 - f64::from(radius) + sx;
                    let dy = y as f64 - f64::from(radius) + sy;
                    coverage += halo_profile(dx.hypot(dy), f64::from(radius));
                }
            }
            data[y * stride + x] = (coverage * 255.0 / 4.0).round() as u8;
        }
    }
    data
}

use x11rb::{
    connection::Connection,
    protocol::{
        randr::{ConnectionExt as _, MonitorInfo},
        render::{Color, ConnectionExt as _, PictOp, PictType},
        shape::{ConnectionExt as _, SK, SO},
        xproto::{
            AtomEnum, ColormapAlloc, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux,
            ImageFormat, PropMode, Rectangle, StackMode, WindowClass,
        },
    },
    rust_connection::RustConnection,
};

pub type OverlayResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const OVERLAY_WM_NAME: &[u8] = b"Pi computer-use feedback";

fn unsupported(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, message)
}

fn intersection(a: Rectangle, b: Rectangle) -> Option<Rectangle> {
    let left = i32::from(a.x).max(i32::from(b.x));
    let top = i32::from(a.y).max(i32::from(b.y));
    let right = (i32::from(a.x) + i32::from(a.width)).min(i32::from(b.x) + i32::from(b.width));
    let bottom = (i32::from(a.y) + i32::from(a.height)).min(i32::from(b.y) + i32::from(b.height));
    (left < right && top < bottom).then_some(Rectangle {
        x: left as i16,
        y: top as i16,
        width: (right - left) as u16,
        height: (bottom - top) as u16,
    })
}

fn root_rect(width: u16, height: u16) -> Rectangle {
    Rectangle {
        x: 0,
        y: 0,
        width,
        height,
    }
}

fn monitor_rects(monitors: &[MonitorInfo], root: Rectangle) -> Vec<Rectangle> {
    monitors
        .iter()
        .filter_map(|m| {
            intersection(
                Rectangle {
                    x: m.x,
                    y: m.y,
                    width: m.width,
                    height: m.height,
                },
                root,
            )
        })
        .collect()
}

// RandR 1.5 added GetMonitors. Older/absent RandR, malformed or empty
// layouts, and transient X errors must not prevent visual feedback.
fn discover_monitors(conn: &RustConnection, root: u32, bounds: Rectangle) -> Vec<Rectangle> {
    let found = (|| {
        let version = conn.randr_query_version(1, 5).ok()?.reply().ok()?;
        if (version.major_version, version.minor_version) < (1, 5) {
            return None;
        }
        let reply = conn.randr_get_monitors(root, true).ok()?.reply().ok()?;
        let rects = monitor_rects(&reply.monitors, bounds);
        (!rects.is_empty()).then_some(rects)
    })();
    found.unwrap_or_else(|| vec![bounds])
}

fn edge_rects(monitor: Rectangle, depth: u16) -> [Rectangle; 4] {
    let x = i32::from(monitor.x) + i32::from(depth);
    let y = i32::from(monitor.y) + i32::from(depth);
    let w = monitor.width - 2 * depth;
    let h = monitor.height - 2 * depth;
    [
        Rectangle {
            x: x as i16,
            y: y as i16,
            width: w,
            height: 1,
        },
        Rectangle {
            x: x as i16,
            y: (y + i32::from(h) - 1) as i16,
            width: w,
            height: 1,
        },
        Rectangle {
            x: x as i16,
            y: y as i16,
            width: 1,
            height: h,
        },
        Rectangle {
            x: (x + i32::from(w) - 1) as i16,
            y: y as i16,
            width: 1,
            height: h,
        },
    ]
}

// Only these strips can contain edge pixels. Never clear the full root in a
// frame tick, even when monitors span a large virtual desktop.
fn edge_dirty_rects(monitor: Rectangle, layers: u16) -> Vec<Rectangle> {
    let depth = layers.min(monitor.width / 2).min(monitor.height / 2);
    if depth == 0 {
        return Vec::new();
    }
    let (x, y) = (i32::from(monitor.x), i32::from(monitor.y));
    let (w, h, d) = (monitor.width, monitor.height, depth);
    [
        Rectangle {
            x: monitor.x,
            y: monitor.y,
            width: w,
            height: d,
        },
        Rectangle {
            x: monitor.x,
            y: (y + i32::from(h - d)) as i16,
            width: w,
            height: d,
        },
        Rectangle {
            x: monitor.x,
            y: (y + i32::from(d)) as i16,
            width: d,
            height: h - 2 * d,
        },
        Rectangle {
            x: (x + i32::from(w - d)) as i16,
            y: (y + i32::from(d)) as i16,
            width: d,
            height: h - 2 * d,
        },
    ]
    .into_iter()
    .filter(|r| r.width > 0 && r.height > 0)
    .collect()
}

fn breath(elapsed: Duration, period_ms: u64) -> f64 {
    // Bounded, seamless 35%-100% modulation of the configured base opacity.
    // Modulo before converting to f64 keeps long-running sessions precise.
    let period = u128::from(period_ms) * 1_000_000;
    let phase = (elapsed.as_nanos() % period) as f64 / period as f64;
    0.675 - 0.325 * (std::f64::consts::TAU * phase).cos()
}

fn union(a: Rectangle, b: Rectangle) -> Rectangle {
    let left = i32::from(a.x).min(i32::from(b.x));
    let top = i32::from(a.y).min(i32::from(b.y));
    let right = (i32::from(a.x) + i32::from(a.width)).max(i32::from(b.x) + i32::from(b.width));
    let bottom = (i32::from(a.y) + i32::from(a.height)).max(i32::from(b.y) + i32::from(b.height));
    Rectangle {
        x: left as i16,
        y: top as i16,
        width: (right - left) as u16,
        height: (bottom - top) as u16,
    }
}

fn halo_bounds(point: (i32, i32), radius: i32, root: Rectangle) -> Option<Rectangle> {
    // The ring's inclusive outer radius fits in this half-open rectangle.
    let (x, y) = point;
    let left = (x - radius).max(0);
    let top = (y - radius).max(0);
    let right = (x + radius + 1).min(i32::from(root.width));
    let bottom = (y + radius + 1).min(i32::from(root.height));
    (left < right && top < bottom).then_some(Rectangle {
        x: left as i16,
        y: top as i16,
        width: (right - left) as u16,
        height: (bottom - top) as u16,
    })
}

/// Composited, click-through edge glow and pointer halo. Coordinates are in
/// root-window pixels, including the virtual desktop spanning multiple heads.
/// Construct once; call `acting(false)` when the agent stops acting. If no
/// compositor/ARGB visual is available, construction fails without mapping a
/// window; callers may log the error and continue without visual feedback.
/// Methods are synchronous X11 operations; the owner should not hold the
/// overlay across async suspension points.
pub struct Overlay {
    conn: RustConnection,
    window: u32,
    root: u32,
    picture: u32,
    cursor_mask: u32,
    cursor_pixmap: u32,
    click_mask: u32,
    click_pixmap: u32,
    colormap: u32,
    width: u16,
    height: u16,
    monitors: Vec<Rectangle>,
    edge_dirty: Vec<Rectangle>,
    style: OverlayStyle,
    active: bool,
    pointer: Option<(i32, i32)>,
    drawn_pointer: Option<(i32, i32)>,
    drawn_click: Option<(i32, i32)>,
    intensity: f64,
    last_frame: Option<Duration>,
}

impl Overlay {
    pub fn new() -> OverlayResult<Self> {
        Self::with_style(OverlayStyle::default())
    }

    pub fn with_style(style: OverlayStyle) -> OverlayResult<Self> {
        let (conn, screen_index) = x11rb::connect(None)?;
        let screen = &conn.setup().roots[screen_index];
        let (root, width, height) = (screen.root, screen.width_in_pixels, screen.height_in_pixels);
        if width == 0 || height == 0 || width > i16::MAX as u16 || height > i16::MAX as u16 {
            return Err(
                unsupported("X11 virtual desktop exceeds supported overlay dimensions").into(),
            );
        }

        let monitors = discover_monitors(&conn, root, root_rect(width, height));
        let edge_dirty = monitors
            .iter()
            .flat_map(|&m| edge_dirty_rects(m, style.edge.width + style.edge.blur))
            .collect();

        // Without a compositor an ARGB window can display as an opaque black
        // rectangle. Fail closed instead of obscuring the user's desktop.
        let selection = conn
            .intern_atom(false, format!("_NET_WM_CM_S{screen_index}").as_bytes())?
            .reply()?
            .atom;
        if conn.get_selection_owner(selection)?.reply()?.owner == x11rb::NONE {
            return Err(unsupported("no X11 compositor owns _NET_WM_CM_Sn").into());
        }

        let formats = conn.render_query_pict_formats()?.reply()?;
        let (visual, format) = formats.screens[screen_index]
            .depths
            .iter()
            .filter(|depth| depth.depth == 32)
            .flat_map(|depth| depth.visuals.iter())
            .find_map(|v| {
                let f = formats.formats.iter().find(|f| {
                    f.id == v.format
                        && f.depth == 32
                        && f.type_ == PictType::DIRECT
                        && f.direct.alpha_mask != 0
                })?;
                // The visual must really belong to the root screen's depth 32.
                screen
                    .allowed_depths
                    .iter()
                    .find(|d| d.depth == 32)?
                    .visuals
                    .iter()
                    .find(|candidate| candidate.visual_id == v.visual)?;
                Some((v.visual, f.id))
            })
            .ok_or_else(|| unsupported("no 32-bit ARGB visual with alpha on this X11 screen"))?;

        let colormap = conn.generate_id()?;
        conn.create_colormap(ColormapAlloc::NONE, colormap, root, visual)?
            .check()?;
        let window = conn.generate_id()?;
        conn.create_window(
            32,
            window,
            root,
            0,
            0,
            width,
            height,
            0,
            WindowClass::INPUT_OUTPUT,
            visual,
            &CreateWindowAux::new()
                .colormap(colormap)
                .border_pixel(0)
                .override_redirect(1)
                .background_pixel(0),
        )?
        .check()?;
        // Stable inspection marker for the parent's root-child lookup. This
        // property does not select events, accept focus, or change input shape.
        conn.change_property(
            PropMode::REPLACE,
            window,
            AtomEnum::WM_NAME,
            AtomEnum::STRING,
            8,
            OVERLAY_WM_NAME.len() as u32,
            OVERLAY_WM_NAME,
        )?
        .check()?;
        // Empty input region is mandatory. If SHAPE isn't available, do not
        // map the window at all. Bounding shape remains the full rectangle.
        conn.shape_rectangles(
            SO::SET,
            SK::INPUT,
            x11rb::protocol::xproto::ClipOrdering::UNSORTED,
            window,
            0,
            0,
            &[],
        )?
        .check()?;
        let picture = conn.generate_id()?;
        conn.render_create_picture(picture, window, format, &Default::default())?
            .check()?;
        let a8 = formats
            .formats
            .iter()
            .find(|f| {
                f.depth == 8
                    && f.type_ == PictType::DIRECT
                    && f.direct.alpha_mask == 255
                    && f.direct.red_mask == 0
                    && f.direct.green_mask == 0
                    && f.direct.blue_mask == 0
            })
            .ok_or_else(|| unsupported("XRender A8 format unavailable"))?
            .id;
        let (cursor_pixmap, cursor_mask) =
            Self::create_halo_mask(&conn, root, a8, style.cursor.radius)?;
        let (click_pixmap, click_mask) = Self::create_halo_mask(&conn, root, a8, 15)?;
        conn.flush()?;
        Ok(Self {
            conn,
            window,
            root,
            picture,
            cursor_mask,
            cursor_pixmap,
            click_mask,
            click_pixmap,
            colormap,
            width,
            height,
            monitors,
            edge_dirty,
            style,
            active: false,
            pointer: None,
            drawn_pointer: None,
            drawn_click: None,
            intensity: 1.0,
            last_frame: None,
        })
    }

    /// Server round trip after unmapping, before another X connection captures.
    pub fn sync(&self) -> OverlayResult<()> {
        self.conn.get_geometry(self.window)?.reply()?;
        Ok(())
    }

    /// Map/unmap the overlay. No pixels are drawn while inactive.
    pub fn acting(&mut self, on: bool) -> OverlayResult<()> {
        if self.active == on {
            return Ok(());
        }
        if on {
            self.intensity = if self.style.animation.enabled {
                0.35
            } else {
                1.0
            };
            self.last_frame = None;
            self.draw_full()?;
            self.conn
                .configure_window(
                    self.window,
                    &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
                )?
                .check()?;
            self.conn.map_window(self.window)?.check()?;
        } else {
            self.conn.unmap_window(self.window)?.check()?;
        }
        self.conn.flush()?;
        self.active = on;
        Ok(())
    }

    /// Update the halo; clears any previous click flash. Has no effect while
    /// inactive except recording where to place the halo upon activation.
    pub fn pointer(&mut self, x: i32, y: i32) -> OverlayResult<()> {
        self.pointer = self.on_screen(x, y);
        if self.active {
            self.draw_update(None)?;
        }
        Ok(())
    }

    /// Show an additional warm ring at the click location until the next
    /// pointer update (or the overlay is deactivated). No X input is taken.
    pub fn click(&mut self, x: i32, y: i32) -> OverlayResult<()> {
        self.pointer = self.on_screen(x, y);
        if self.active {
            self.draw_update(self.pointer)?;
        }
        Ok(())
    }

    /// Read the actual root pointer on this overlay's separate X connection.
    /// This does not synthesize or intercept input. Safe to call while inactive;
    /// active changes only redraw bounded halo regions.
    pub fn refresh_pointer_position(&mut self) -> OverlayResult<()> {
        let reply = self.conn.query_pointer(self.root)?.reply()?;
        let position = if reply.same_screen {
            self.on_screen(i32::from(reply.root_x), i32::from(reply.root_y))
        } else {
            None
        };
        if position != self.pointer {
            self.pointer = position;
            if self.active {
                self.draw_update(None)?;
            }
        }
        Ok(())
    }

    /// Advance the breathing glow. Pass elapsed time since the start of this
    /// active control interval (e.g. Instant::elapsed()). This is throttled to
    /// the configured frame rate; the owner should stop ticking when inactive.
    /// The owner must unmap via acting(false) and sync() before screenshots.
    pub fn animate(&mut self, elapsed: Duration) -> OverlayResult<()> {
        if !self.active || !self.style.animation.enabled {
            return Ok(());
        }
        if let Some(last) = self.last_frame {
            if elapsed >= last && elapsed - last < self.style.animation.frame_interval() {
                return Ok(());
            }
        }
        self.intensity = breath(elapsed, self.style.animation.period_ms);
        // Clear only the edge strips and the old halo footprints. Clear all
        // dirty regions before redrawing so overlapping heads and halos do not
        // leave ghosts or accumulate alpha across frames.
        let root = root_rect(self.width, self.height);
        for &rect in &self.edge_dirty {
            self.clear(rect)?;
        }
        for rect in self.old_halo_rects(root) {
            self.clear(rect)?;
        }
        self.draw_edges(None)?;
        self.draw_halos(self.drawn_click)?;
        self.conn.flush()?;
        self.drawn_pointer = self.pointer;
        self.last_frame = Some(elapsed);
        Ok(())
    }

    fn on_screen(&self, x: i32, y: i32) -> Option<(i32, i32)> {
        (x >= 0 && y >= 0 && x < i32::from(self.width) && y < i32::from(self.height))
            .then_some((x, y))
    }

    fn draw_full(&mut self) -> OverlayResult<()> {
        self.clear(root_rect(self.width, self.height))?;
        self.draw_edges(None)?;
        self.draw_halos(None)?;
        self.conn.flush()?;
        self.drawn_pointer = self.pointer;
        self.drawn_click = None;
        Ok(())
    }

    fn draw_update(&mut self, click: Option<(i32, i32)>) -> OverlayResult<()> {
        let root = root_rect(self.width, self.height);
        // Keep distant old click and halo regions separate: a union of their
        // bounding boxes could clear most of the desktop.
        let dirty = self.old_halo_rects(root);
        for &rect in &dirty {
            self.clear(rect)?;
        }
        for rect in dirty {
            self.draw_edges(Some(rect))?;
        }
        self.draw_halos(click)?;
        self.conn.flush()?;
        self.drawn_pointer = self.pointer;
        self.drawn_click = click;
        Ok(())
    }

    fn old_halo_rects(&self, root: Rectangle) -> Vec<Rectangle> {
        let pointer = self
            .drawn_pointer
            .and_then(|p| halo_bounds(p, i32::from(self.style.cursor.radius), root));
        let click = self.drawn_click.and_then(|p| halo_bounds(p, 15, root));
        match (pointer, click) {
            (Some(a), Some(b)) if intersection(a, b).is_some() => vec![union(a, b)],
            (Some(a), Some(b)) => vec![a, b],
            (Some(a), None) | (None, Some(a)) => vec![a],
            (None, None) => vec![],
        }
    }

    fn clear(&self, rect: Rectangle) -> OverlayResult<()> {
        self.conn.render_fill_rectangles(
            PictOp::SRC,
            self.picture,
            Color {
                red: 0,
                green: 0,
                blue: 0,
                alpha: 0,
            },
            &[rect],
        )?;
        Ok(())
    }

    fn draw_edges(&self, clip: Option<Rectangle>) -> OverlayResult<()> {
        for monitor in &self.monitors {
            let edge = self.style.edge;
            let layers = edge.width + edge.blur;
            for depth in (0..layers.min(monitor.width / 2).min(monitor.height / 2)).rev() {
                let distance = f64::from(depth.saturating_sub(edge.width - 1));
                let strength = if edge.blur == 0 {
                    1.0
                } else {
                    let sigma = f64::from(edge.blur) / 3.0;
                    (-0.5 * (distance / sigma).powi(2)).exp()
                };
                let c = render_color(edge.color, edge.opacity * self.intensity * strength);
                let rects = edge_rects(*monitor, depth);
                let visible: Vec<_> = rects
                    .iter()
                    .filter_map(|&r| match clip {
                        Some(c) => intersection(r, c),
                        None => Some(r),
                    })
                    .collect();
                if !visible.is_empty() {
                    self.conn
                        .render_fill_rectangles(PictOp::OVER, self.picture, c, &visible)?;
                }
            }
        }
        Ok(())
    }

    fn draw_halos(&self, click: Option<(i32, i32)>) -> OverlayResult<()> {
        if let Some(point) = self.pointer {
            self.composite_halo(
                point,
                self.style.cursor.radius,
                self.cursor_mask,
                render_color(
                    self.style.cursor.color,
                    self.style.cursor.opacity * self.intensity,
                ),
            )?;
        }
        if let Some(point) = click {
            self.composite_halo(
                point,
                15,
                self.click_mask,
                render_color([0xff, 0xb8, 0x28], 0x9900 as f64 / 65535.0),
            )?;
        }
        Ok(())
    }

    fn composite_halo(
        &self,
        (x, y): (i32, i32),
        radius: u16,
        mask: u32,
        color: Color,
    ) -> OverlayResult<()> {
        if color.alpha == 0 {
            return Ok(());
        }
        let root = root_rect(self.width, self.height);
        if let Some(bounds) = halo_bounds((x, y), i32::from(radius), root) {
            let src = self.conn.generate_id()?;
            self.conn.render_create_solid_fill(src, color)?;
            self.conn.render_composite(
                PictOp::OVER,
                src,
                mask,
                self.picture,
                0,
                0,
                (i32::from(bounds.x) - x + i32::from(radius)) as i16,
                (i32::from(bounds.y) - y + i32::from(radius)) as i16,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
            )?;
            self.conn.render_free_picture(src)?;
        }
        Ok(())
    }

    fn create_halo_mask(
        conn: &RustConnection,
        root: u32,
        format: u32,
        radius: u16,
    ) -> OverlayResult<(u32, u32)> {
        let side = radius * 2 + 1;
        let pixmap = conn.generate_id()?;
        conn.create_pixmap(8, pixmap, root, side, side)?.check()?;
        let gc = conn.generate_id()?;
        conn.create_gc(gc, pixmap, &Default::default())?.check()?;
        let pad = usize::from(
            conn.setup()
                .pixmap_formats
                .iter()
                .find(|f| f.depth == 8)
                .ok_or_else(|| unsupported("X11 depth-8 pixmap format unavailable"))?
                .scanline_pad,
        ) / 8;
        conn.put_image(
            ImageFormat::Z_PIXMAP,
            pixmap,
            gc,
            side,
            side,
            0,
            0,
            0,
            8,
            &halo_mask(radius, pad),
        )?
        .check()?;
        conn.free_gc(gc)?;
        let picture = conn.generate_id()?;
        conn.render_create_picture(picture, pixmap, format, &Default::default())?
            .check()?;
        Ok((pixmap, picture))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: i16, y: i16, width: u16, height: u16) -> MonitorInfo {
        MonitorInfo {
            name: 0,
            primary: false,
            automatic: false,
            x,
            y,
            width,
            height,
            width_in_millimeters: 0,
            height_in_millimeters: 0,
            outputs: vec![],
        }
    }

    fn coords(r: Rectangle) -> (i16, i16, u16, u16) {
        (r.x, r.y, r.width, r.height)
    }

    #[test]
    fn clips_monitor_coordinates_to_root() {
        let rects = monitor_rects(
            &[
                monitor(0, 0, 150, 200),
                monitor(150, 30, 200, 200),
                monitor(-20, -10, 30, 40),
                monitor(400, 0, 50, 50),
                monitor(5, 5, 0, 20),
            ],
            root_rect(300, 200),
        );
        assert_eq!(
            rects.into_iter().map(coords).collect::<Vec<_>>(),
            vec![(0, 0, 150, 200), (150, 30, 150, 170), (0, 0, 10, 30),]
        );
    }

    #[test]
    fn edges_use_monitor_offsets_including_internal_seams() {
        let monitor = Rectangle {
            x: 150,
            y: 30,
            width: 100,
            height: 80,
        };
        assert_eq!(
            edge_rects(monitor, 0).map(coords),
            [
                (150, 30, 100, 1),
                (150, 109, 100, 1),
                (150, 30, 1, 80),
                (249, 30, 1, 80),
            ]
        );
        assert_eq!(coords(edge_rects(monitor, 17)[0]), (167, 47, 66, 1));
        let clip = Rectangle {
            x: 145,
            y: 25,
            width: 10,
            height: 10,
        };
        assert_eq!(
            intersection(edge_rects(monitor, 0)[0], clip).map(coords),
            Some((150, 30, 5, 1))
        );
    }

    #[test]
    fn breathing_envelope_is_smooth_periodic_and_never_vanishes() {
        let period = 1600;
        let at = |ms| breath(Duration::from_millis(ms), period);
        for ms in 0..=3200 {
            let value = at(ms);
            assert!((0.35 - 1e-12..=1.0 + 1e-12).contains(&value));
            if ms < 1600 {
                assert!((value - at(ms + 1600)).abs() < 1e-12);
            }
        }
        assert!((at(0) - 0.35).abs() < 1e-12);
        assert!((at(800) - 1.0).abs() < 1e-12);
        assert!((at(400) - 0.675).abs() < 1e-12);
        assert!((at(1599) - at(1601)).abs() < 1e-5);
        assert!((breath(Duration::from_secs(86400), period) - at(0)).abs() < 1e-12);
    }

    #[test]
    fn animated_strips_cover_clipped_multi_monitor_edges_not_root() {
        let root = root_rect(300, 200);
        let heads = monitor_rects(
            &[monitor(-20, -10, 170, 210), monitor(150, 30, 200, 200)],
            root,
        );
        assert_eq!(
            heads.iter().copied().map(coords).collect::<Vec<_>>(),
            vec![(0, 0, 150, 200), (150, 30, 150, 170)]
        );
        for head in heads {
            let strips = edge_dirty_rects(head, 24);
            assert_eq!(strips.len(), 4);
            assert!(strips
                .iter()
                .all(|r| intersection(*r, root).map(coords) == Some(coords(*r))));
            assert!(strips.iter().all(|r| coords(*r) != coords(root)));
            for depth in 0..24 {
                for edge in edge_rects(head, depth) {
                    let covered: u32 = strips
                        .iter()
                        .filter_map(|strip| intersection(edge, *strip))
                        .map(|part| u32::from(part.width) * u32::from(part.height))
                        .sum();
                    assert_eq!(
                        covered,
                        u32::from(edge.width) * u32::from(edge.height),
                        "edge {edge:?} outside head {head:?} strips"
                    );
                }
            }
        }
        let tiny = Rectangle {
            x: 10,
            y: 10,
            width: 8,
            height: 6,
        };
        assert_eq!(edge_dirty_rects(tiny, 24).len(), 2);
        assert!(edge_dirty_rects(tiny, 24)
            .iter()
            .all(|r| r.width > 0 && r.height > 0));
    }

    /// Run manually on a composited X11 desktop. Reads only our ARGB window:
    /// no root screenshot, files, simulated clicks, or input grabs.
    #[test]
    #[ignore = "requires a live X11 compositor; briefly maps a click-through overlay"]
    fn live_read_only_breathing_xrender_clickthrough() -> OverlayResult<()> {
        use x11rb::protocol::xproto::{ImageFormat, ImageOrder, MapState};

        fn pixel_at(overlay: &Overlay, x: i16, y: i16) -> OverlayResult<u32> {
            let image = overlay
                .conn
                .get_image(ImageFormat::Z_PIXMAP, overlay.window, x, y, 1, 1, u32::MAX)?
                .reply()?;
            assert_eq!(image.depth, 32);
            let bytes: [u8; 4] = image.data.as_slice().try_into()?;
            let pixel = if overlay.conn.setup().image_byte_order == ImageOrder::LSB_FIRST {
                u32::from_le_bytes(bytes)
            } else {
                u32::from_be_bytes(bytes)
            };
            Ok(pixel)
        }

        fn assert_viewable(overlay: &Overlay) -> OverlayResult<()> {
            let state = overlay
                .conn
                .get_window_attributes(overlay.window)?
                .reply()?
                .map_state;
            assert_eq!(state, MapState::VIEWABLE);
            Ok(())
        }

        let style = OverlayStyle::default();
        assert!(style.animation.enabled);
        assert_eq!(style.animation.period_ms, 1600);
        let mut overlay = Overlay::with_style(style)?;
        let name = overlay
            .conn
            .get_property(
                false,
                overlay.window,
                AtomEnum::WM_NAME,
                AtomEnum::STRING,
                0,
                32,
            )?
            .reply()?;
        assert_eq!(name.format, 8);
        assert_eq!(name.value, OVERLAY_WM_NAME);
        let screen_index = overlay
            .conn
            .setup()
            .roots
            .iter()
            .position(|screen| screen.root == overlay.root)
            .unwrap();
        let visual = overlay
            .conn
            .get_window_attributes(overlay.window)?
            .reply()?
            .visual;
        let formats = overlay.conn.render_query_pict_formats()?.reply()?;
        let format_id = formats.screens[screen_index]
            .depths
            .iter()
            .flat_map(|depth| &depth.visuals)
            .find(|entry| entry.visual == visual)
            .unwrap()
            .format;
        let direct = &formats
            .formats
            .iter()
            .find(|format| format.id == format_id)
            .unwrap()
            .direct;
        let component =
            |pixel: u32, shift: u16, mask: u16| ((pixel >> shift) & u32::from(mask)) as u16;
        let channels = |pixel: u32| {
            [
                component(pixel, direct.red_shift, direct.red_mask),
                component(pixel, direct.green_shift, direct.green_mask),
                component(pixel, direct.blue_shift, direct.blue_mask),
                component(pixel, direct.alpha_shift, direct.alpha_mask),
            ]
        };
        assert_eq!(direct.alpha_mask, 255);

        // Sample the outermost left edge of a real, clipped monitor, not the
        // desktop. Stay away from corner layers when space permits.
        let monitor = overlay.monitors.iter().min_by_key(|m| m.x).unwrap();
        let edge_x = monitor.x;
        let edge_y = (i32::from(monitor.y) + i32::from(monitor.height) / 2) as i16;
        overlay.acting(true)?;
        overlay.refresh_pointer_position()?;
        overlay.animate(Duration::ZERO)?;
        overlay.sync()?;
        assert_viewable(&overlay)?;
        assert!(overlay
            .conn
            .shape_get_rectangles(overlay.window, SK::INPUT)?
            .reply()?
            .rectangles
            .is_empty());
        let low = channels(pixel_at(&overlay, edge_x, edge_y)?);
        overlay.animate(Duration::from_millis(style.animation.period_ms / 2))?;
        overlay.sync()?;
        assert_viewable(&overlay)?;
        let high = channels(pixel_at(&overlay, edge_x, edge_y)?);
        assert!(
            low[3] > 0 && high[3] > low[3] + 10,
            "expected XRender alpha to breathe: {low:?} -> {high:?}"
        );
        for i in 0..3 {
            assert!(
                low[i] <= low[3] && high[i] <= high[3],
                "invalid premultiplied pixels: {low:?} -> {high:?}"
            );
        }
        assert!(
            high[2] > low[2] + 10,
            "blue must visibly breathe: {low:?} -> {high:?}"
        );
        eprintln!("edge RGBA low {low:?}, high {high:?}");

        // Sample the own window's antialiased halo at two phases, away from
        // screen edges. No pointer is moved and no desktop pixels are read.
        let center = (i32::from(overlay.width) / 2, i32::from(overlay.height) / 2);
        overlay.pointer(center.0, center.1)?;
        overlay.animate(Duration::from_millis(1600))?;
        overlay.sync()?;
        let hx = (center.0 + i32::from(style.cursor.radius) * 3 / 4) as i16;
        let hy = center.1 as i16;
        let halo_low = channels(pixel_at(&overlay, hx, hy)?);
        overlay.animate(Duration::from_millis(2400))?;
        overlay.sync()?;
        let halo_high = channels(pixel_at(&overlay, hx, hy)?);
        assert!(
            halo_low[3] > 0 && halo_high[3] > halo_low[3] + 20,
            "halo alpha must breathe: {halo_low:?} -> {halo_high:?}"
        );
        assert!(
            halo_high[2] > halo_low[2] + 20 && halo_high[..3].iter().all(|c| *c <= halo_high[3]),
            "halo color must be premultiplied and breathe: {halo_low:?} -> {halo_high:?}"
        );
        eprintln!("halo RGBA low {halo_low:?}, high {halo_high:?}");
        overlay.pointer(center.0, center.1)?;
        overlay.click(center.0, center.1)?; // overlay drawing only, no X input
        overlay.sync()?;
        let warm = channels(pixel_at(&overlay, (center.0 + 11) as i16, center.1 as i16)?);
        assert!(
            warm[3] > 0 && warm[0] > warm[2] && warm[..3].iter().all(|c| *c <= warm[3]),
            "warm click color must be premultiplied: {warm:?}"
        );
        overlay.pointer(center.0, center.1)?;

        // On adjacent heads, put the *overlay-only* halo across the seam;
        // consecutive frames at the same phase must not accumulate opacity
        // where halo and both monitor edge strips intersect.
        for left in &overlay.monitors {
            let seam = i32::from(left.x) + i32::from(left.width);
            if let Some(right) = overlay
                .monitors
                .iter()
                .find(|right| i32::from(right.x) == seam)
            {
                let top = i32::from(left.y).max(i32::from(right.y));
                let bottom = (i32::from(left.y) + i32::from(left.height))
                    .min(i32::from(right.y) + i32::from(right.height));
                if bottom <= top {
                    continue;
                }
                let y = (top + (bottom - top) / 2) as i16;
                let center = if seam + 39 < i32::from(overlay.width) {
                    seam + 39
                } else if seam >= 39 {
                    seam - 39
                } else {
                    continue;
                };
                overlay.pointer(center, i32::from(y))?; // draw only; no desktop input
                overlay.animate(Duration::from_millis(2400))?;
                overlay.sync()?;
                assert_viewable(&overlay)?;
                let seam_alpha = channels(pixel_at(&overlay, seam as i16, y)?)[3];
                overlay.animate(Duration::from_millis(4000))?;
                overlay.sync()?;
                assert_viewable(&overlay)?;
                assert_eq!(channels(pixel_at(&overlay, seam as i16, y)?)[3], seam_alpha);
                break;
            }
        }

        // Synchronous, bounded frame work on our own window (not a root
        // capture). Log a local diagnostic, not a machine-dependent limit.
        let start = std::time::Instant::now();
        for frame in 0..30 {
            overlay.animate(Duration::from_millis(4800 + frame * 50))?;
        }
        overlay.sync()?;
        eprintln!(
            "overlay 30 frames including X sync: {:?}/frame",
            start.elapsed() / 30
        );
        overlay.acting(false)?;
        overlay.sync()?;
        assert_eq!(
            overlay
                .conn
                .get_window_attributes(overlay.window)?
                .reply()?
                .map_state,
            MapState::UNMAPPED
        );
        Ok(())
    }

    #[test]
    fn render_colors_are_premultiplied_at_all_opacities() {
        for color in [
            [0x41, 0x98, 0xf7],
            [0xff, 0xb8, 0x28],
            [0, 0, 0],
            [255, 255, 255],
        ] {
            for opacity in [0.0, 0.01, 0.05, 0.22, 0.35, 0.38, 0.6, 1.0] {
                let c = render_color(color, opacity);
                assert!([c.red, c.green, c.blue].iter().all(|&v| v <= c.alpha));
                let expected = |v: u8| (f64::from(v) * 257.0 * opacity).round() as i32;
                for (value, component) in color.into_iter().zip([c.red, c.green, c.blue]) {
                    assert!((i32::from(component) - expected(value)).abs() <= 1);
                }
            }
        }
        let low = render_color([0x41, 0x98, 0xf7], 0.22 * 0.35);
        let high = render_color([0x41, 0x98, 0xf7], 0.22);
        assert!(high.blue > low.blue * 2 && high.alpha > low.alpha * 2);
    }

    #[test]
    fn cached_gaussian_halo_has_smooth_zero_boundary() {
        for radius in [15, 16, 40, 128] {
            let side = usize::from(radius) * 2 + 1;
            let pixels = halo_mask(radius, 4);
            let stride = side.div_ceil(4) * 4;
            assert_eq!(pixels.len(), side * stride);
            assert_eq!(
                pixels[usize::from(radius) * stride + usize::from(radius)],
                0
            );
            assert_eq!(pixels[usize::from(radius) * stride], 0);
            assert_eq!(pixels[usize::from(radius) * stride + side - 1], 0);
            let mid = usize::from(radius) * stride;
            let band = &pixels[mid..mid + side];
            assert!(band[usize::from(radius) * 7 / 4] > 100);
            assert!(band.windows(2).any(|w| w[0] > 0 && w[0] < w[1]));
            assert!(band.windows(2).any(|w| w[0] > w[1] && w[1] > 0));
        }
    }

    #[test]
    fn dirty_halos_clip_at_root_edges() {
        let root = root_rect(300, 200);
        let top_left = halo_bounds((0, 0), 40, root).unwrap();
        let bottom_right = halo_bounds((299, 199), 15, root).unwrap();
        assert_eq!(coords(top_left), (0, 0, 41, 41));
        assert_eq!(coords(bottom_right), (284, 184, 16, 16));
        assert_eq!(coords(union(top_left, bottom_right)), coords(root));
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        let _ = self.conn.render_free_picture(self.picture);
        let _ = self.conn.render_free_picture(self.cursor_mask);
        let _ = self.conn.render_free_picture(self.click_mask);
        let _ = self.conn.free_pixmap(self.cursor_pixmap);
        let _ = self.conn.free_pixmap(self.click_pixmap);
        let _ = self.conn.destroy_window(self.window);
        let _ = self.conn.free_colormap(self.colormap);
        let _ = self.conn.flush();
    }
}
