//! Root-window X11 capture (GetImage or optional MIT-SHM), PNG encoding and tile hashes.
//! Dirty-region hashes use native pixel bytes, excluding scanline padding and
//! non-color bits; screenshots are still decoded to RGBA.

#[path = "damage.rs"]
pub mod damage;

use std::error::Error;
use std::io;
use std::sync::Mutex;

use base64::Engine as _;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder, Visualid, Window};
use x11rb::rust_connection::RustConnection;
use xxhash_rust::xxh3::{xxh3_64, Xxh3};

pub type CaptureResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedRegion {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    /// PNG image (without a data URI prefix).
    pub png_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileHash {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub hash: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaFrame {
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}

impl RgbaFrame {
    /// Copy a bounded subrectangle into a tightly packed RGBA frame.
    pub fn crop(&self, x: u16, y: u16, width: u16, height: u16) -> CaptureResult<Self> {
        if width == 0
            || height == 0
            || u32::from(x) + u32::from(width) > u32::from(self.width)
            || u32::from(y) + u32::from(height) > u32::from(self.height)
            || self.rgba.len() != usize::from(self.width) * usize::from(self.height) * 4
        {
            return Err(invalid("invalid RGBA crop").into());
        }
        let mut rgba = Vec::with_capacity(usize::from(width) * usize::from(height) * 4);
        for row in y..y + height {
            let start = (usize::from(row) * usize::from(self.width) + usize::from(x)) * 4;
            rgba.extend_from_slice(&self.rgba[start..start + usize::from(width) * 4]);
        }
        Ok(Self {
            width,
            height,
            rgba,
        })
    }

    /// Encode this decoded frame as an RGBA PNG, returned as base64.
    pub fn png_base64(&self) -> CaptureResult<String> {
        let expected = usize::from(self.width) * usize::from(self.height) * 4;
        if self.width == 0 || self.height == 0 || self.rgba.len() != expected {
            return Err(invalid("invalid RGBA frame dimensions or buffer length").into());
        }
        let mut bytes = Vec::new();
        {
            let mut encoder =
                png::Encoder::new(&mut bytes, u32::from(self.width), u32::from(self.height));
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header()?;
            writer.write_image_data(&self.rgba)?;
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// Row-major tile hashes; edge tiles contain only their actual pixels.
    pub fn tile_hashes(&self, tile_size: u16) -> CaptureResult<Vec<TileHash>> {
        if tile_size == 0
            || self.rgba.len() != usize::from(self.width) * usize::from(self.height) * 4
        {
            return Err(invalid("invalid tile size or RGBA frame").into());
        }
        let mut result = Vec::new();
        for y in (0..self.height).step_by(usize::from(tile_size)) {
            for x in (0..self.width).step_by(usize::from(tile_size)) {
                let width = tile_size.min(self.width - x);
                let height = tile_size.min(self.height - y);
                let mut pixels = Vec::with_capacity(usize::from(width) * usize::from(height) * 4);
                for row in y..y + height {
                    let start = (usize::from(row) * usize::from(self.width) + usize::from(x)) * 4;
                    pixels.extend_from_slice(&self.rgba[start..start + usize::from(width) * 4]);
                }
                result.push(TileHash {
                    x,
                    y,
                    width,
                    height,
                    hash: xxh3_64(&pixels),
                });
            }
        }
        Ok(result)
    }
}

/// X11 screen capture. A new connection is created for each instance.
pub struct X11Capture {
    conn: RustConnection,
    root: Window,
    visual: Visualid,
    shm_available: bool,
    #[cfg(target_os = "linux")]
    shm: Mutex<Option<ShmBuffer>>,
}

impl X11Capture {
    pub fn new() -> CaptureResult<Self> {
        let (conn, screen) = x11rb::connect(None)?;
        let root = &conn.setup().roots[screen];
        let (window, visual) = (root.root, root.root_visual);
        // A remote or restricted server may advertise SHM but reject attachments.
        // Such failures are handled per capture by falling back to GetImage.
        let shm_available = conn
            .extension_information("MIT-SHM")
            .ok()
            .flatten()
            .is_some()
            && conn
                .shm_query_version()
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .is_some();
        Ok(Self {
            conn,
            root: window,
            visual,
            shm_available,
            #[cfg(target_os = "linux")]
            shm: Mutex::new(None),
        })
    }

    pub fn screen_size(&self) -> CaptureResult<(u16, u16)> {
        let geometry = self.conn.get_geometry(self.root)?.reply()?;
        Ok((geometry.width, geometry.height))
    }

    /// Capture the complete root window (including currently visible windows).
    pub fn capture_screen(&self) -> CaptureResult<RgbaFrame> {
        let (width, height) = self.screen_size()?;
        self.capture_rgba(0, 0, width, height)
    }

    /// Read the entire visible root even if XDamage reports no changes. Try
    /// MIT-SHM first; any unsupported format, server error or allocation failure
    /// falls back to the existing full-frame GetImage path.
    pub fn capture_screen_fast(&self) -> CaptureResult<RgbaFrame> {
        let (width, height) = self.screen_size()?;
        if self.shm_available {
            if let Ok(frame) = self.capture_screen_shm(width, height) {
                return Ok(frame);
            }
        }
        self.capture_rgba(0, 0, width, height)
    }

    /// Borrow raw native pixels only for the duration of this callback. Both
    /// transports use exactly the same pixel layout and hashing implementation.
    /// The callback must not recursively capture on this instance: the SHM
    /// mapping remains locked and attached until the callback returns.
    pub fn with_screen_image<T>(
        &self,
        callback: impl FnOnce(RawImage<'_>) -> CaptureResult<T>,
    ) -> CaptureResult<T> {
        let (width, height) = self.screen_size()?;
        if width == 0 || height == 0 {
            return Err(invalid("empty root screen").into());
        }
        let mut callback = Some(callback);
        #[cfg(target_os = "linux")]
        if self.shm_available {
            match self.with_shm_image(width, height, &mut callback) {
                Ok(Some(image)) => return Ok(image),
                Err(error) if callback.is_none() => return Err(error),
                _ => {} // Transport failed before invoking the callback: GetImage.
            }
        }
        let reply = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                self.root,
                0,
                0,
                width,
                height,
                u32::MAX,
            )?
            .reply()?;
        let image = self.raw_image(&reply.data, width, height, reply.depth)?;
        callback.take().expect("callback used only once")(image)
    }

    fn raw_image<'a>(
        &self,
        data: &'a [u8],
        width: u16,
        height: u16,
        depth: u8,
    ) -> CaptureResult<RawImage<'a>> {
        let setup = self.conn.setup();
        let format = setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == depth)
            .ok_or_else(|| invalid("unsupported X11 image depth"))?;
        let visual = setup
            .roots
            .iter()
            .flat_map(|screen| &screen.allowed_depths)
            .flat_map(|depth| &depth.visuals)
            .find(|visual| visual.visual_id == self.visual)
            .ok_or_else(|| invalid("root visual not found"))?;
        let length = zpixmap_len(width, height, format.bits_per_pixel, format.scanline_pad)?;
        if data.len() < length {
            return Err(invalid("truncated X11 image").into());
        }
        Ok(RawImage {
            data: &data[..length],
            width,
            height,
            format: NativePixelFormat {
                depth,
                bpp: format.bits_per_pixel,
                pad: format.scanline_pad,
                order: setup.image_byte_order,
                masks: [visual.red_mask, visual.green_mask, visual.blue_mask],
            },
            transport: CaptureTransport::GetImage,
        })
    }

    #[cfg(target_os = "linux")]
    fn with_shm_image<T>(
        &self,
        width: u16,
        height: u16,
        callback: &mut Option<impl FnOnce(RawImage<'_>) -> CaptureResult<T>>,
    ) -> CaptureResult<Option<T>> {
        let setup = self.conn.setup();
        let depth = setup
            .roots
            .iter()
            .find(|screen| screen.root == self.root)
            .ok_or_else(|| invalid("root screen not found"))?
            .root_depth;
        let format = setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == depth)
            .ok_or_else(|| invalid("unsupported X11 image depth"))?;
        let len = zpixmap_len(width, height, format.bits_per_pixel, format.scanline_pad)?;
        if len == 0 || len > 256 * 1024 * 1024 || len > u32::MAX as usize {
            return Err(invalid("SHM image exceeds capture limit").into());
        }
        let mut guard = self.shm.lock().unwrap_or_else(|poison| poison.into_inner());
        let reuse = guard.as_ref().is_some_and(|buffer| buffer.len == len);
        if !reuse {
            if let Some(old) = guard.take() {
                old.detach(&self.conn)?;
            }
            *guard = Some(ShmBuffer::new(&self.conn, len)?);
        }
        let buffer = guard.as_ref().expect("SHM buffer allocated");
        let response = self
            .conn
            .shm_get_image(
                self.root,
                0,
                0,
                width,
                height,
                u32::MAX,
                u8::from(ImageFormat::Z_PIXMAP),
                buffer.seg,
                0,
            )
            .map_err(|error| -> Box<dyn Error + Send + Sync> { error.into() })
            .and_then(|cookie| cookie.reply().map_err(Into::into));
        let reply = match response {
            Ok(reply)
                if reply.depth == depth
                    && reply.visual == self.visual
                    && reply.size as usize == len =>
            {
                reply
            }
            _ => {
                if let Some(old) = guard.take() {
                    let _ = old.detach(&self.conn);
                }
                return Err(invalid("MIT-SHM image failed or changed format").into());
            }
        };
        let _ = reply; // The checked reply is a barrier for the server's write.
        let buffer = guard.as_ref().expect("SHM buffer attached");
        let mut image = self.raw_image(buffer.segment.bytes(buffer.len), width, height, depth)?;
        image.transport = CaptureTransport::Shm;
        Ok(Some(callback.take().expect("callback used only once")(
            image,
        )?))
    }

    #[cfg(target_os = "linux")]
    fn capture_screen_shm(&self, width: u16, height: u16) -> CaptureResult<RgbaFrame> {
        self.with_shm_image(
            width,
            height,
            &mut Some(|image: RawImage<'_>| {
                Ok(RgbaFrame {
                    width,
                    height,
                    rgba: image.decode()?,
                })
            }),
        )?
        .ok_or_else(|| invalid("MIT-SHM image unavailable").into())
    }

    #[cfg(not(target_os = "linux"))]
    fn capture_screen_shm(&self, _width: u16, _height: u16) -> CaptureResult<RgbaFrame> {
        Err(invalid("SysV SHM capture requires Linux").into())
    }

    /// Capture a validated root-window rectangle, decoded to RGBA8.
    pub fn capture_rgba(
        &self,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
    ) -> CaptureResult<RgbaFrame> {
        let (screen_width, screen_height) = self.screen_size()?;
        if width == 0
            || height == 0
            || u32::from(x) + u32::from(width) > u32::from(screen_width)
            || u32::from(y) + u32::from(height) > u32::from(screen_height)
            || x > i16::MAX as u16
            || y > i16::MAX as u16
        {
            return Err(invalid("capture rectangle is empty or outside the root window").into());
        }
        let image = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                self.root,
                x as i16,
                y as i16,
                width,
                height,
                u32::MAX,
            )?
            .reply()?;
        let rgba = self.decode_image(&image.data, width, height, image.depth)?;
        Ok(RgbaFrame {
            width,
            height,
            rgba,
        })
    }

    fn decode_image(
        &self,
        data: &[u8],
        width: u16,
        height: u16,
        depth: u8,
    ) -> CaptureResult<Vec<u8>> {
        let setup = self.conn.setup();
        let format = setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == depth)
            .ok_or_else(|| invalid("unsupported X11 image depth"))?;
        let visual = setup
            .roots
            .iter()
            .flat_map(|screen| &screen.allowed_depths)
            .flat_map(|depth| &depth.visuals)
            .find(|visual| visual.visual_id == self.visual)
            .ok_or_else(|| invalid("root visual not found"))?;
        decode_zpixmap(
            data,
            width,
            height,
            format.bits_per_pixel,
            format.scanline_pad,
            setup.image_byte_order,
            [visual.red_mask, visual.green_mask, visual.blue_mask],
        )
    }

    /// Capture a rectangle directly as base64-encoded PNG.
    pub fn capture_region(
        &self,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
    ) -> CaptureResult<CapturedRegion> {
        let png_base64 = self.capture_rgba(x, y, width, height)?.png_base64()?;
        Ok(CapturedRegion {
            x,
            y,
            width,
            height,
            png_base64,
        })
    }

    /// Hash a fresh complete-screen capture by square tiles in row-major order.
    pub fn tile_hashes(&self, tile_size: u16) -> CaptureResult<Vec<TileHash>> {
        self.capture_screen()?.tile_hashes(tile_size)
    }
}

// The mapping's address is stored as an integer so X11Capture remains Send
// without implementing Send for a raw pointer. It is converted to a slice only
// under the buffer mutex, after the checked X11 reply has completed the write.
#[cfg(target_os = "linux")]
struct ShmBuffer {
    segment: SysvSegment,
    seg: u32,
    len: usize,
}

#[cfg(target_os = "linux")]
impl ShmBuffer {
    fn new(conn: &RustConnection, len: usize) -> CaptureResult<Self> {
        let mut segment = SysvSegment::new(len)?;
        let seg = conn.generate_id()?;
        // Even a failed checked attach gets a best-effort server detach.
        let mut attachment = ShmAttachment {
            conn,
            seg,
            attached: true,
        };
        conn.shm_attach(seg, segment.id as u32, false)?.check()?;
        segment.mark_for_removal()?;
        attachment.attached = false; // ShmBuffer owns the server attachment now.
        Ok(Self { segment, seg, len })
    }

    fn detach(self, conn: &RustConnection) -> CaptureResult<()> {
        // The segment remains IPC_RMID-marked if the server is disconnected.
        let attachment = ShmAttachment {
            conn,
            seg: self.seg,
            attached: true,
        };
        attachment.detach()
    }
}

impl Drop for X11Capture {
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        {
            let buffer = self
                .shm
                .get_mut()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(buffer) = buffer.take() {
                let _ = buffer.detach(&self.conn);
            }
        }
    }
}

/// Transport that successfully supplied the pixels, independent of capture mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptureTransport {
    Shm,
    #[default]
    GetImage,
}

impl CaptureTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shm => "shm",
            Self::GetImage => "get_image",
        }
    }
}

/// Native hash interpretation. A changed depth, channel mask, byte order,
/// bits-per-pixel or scanline padding forces a fresh diff baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativePixelFormat {
    pub(crate) depth: u8,
    pub(crate) bpp: u8,
    pub(crate) pad: u8,
    pub(crate) order: ImageOrder,
    pub(crate) masks: [u32; 3],
}

/// A validated native X11 ZPixmap view. The slice cannot outlive the capture callback.
pub struct RawImage<'a> {
    data: &'a [u8],
    pub width: u16,
    pub height: u16,
    format: NativePixelFormat,
    transport: CaptureTransport,
}

impl RawImage<'_> {
    pub fn format(&self) -> NativePixelFormat {
        self.format
    }

    pub fn transport(&self) -> CaptureTransport {
        self.transport
    }

    pub fn decode(&self) -> CaptureResult<Vec<u8>> {
        decode_zpixmap(
            self.data,
            self.width,
            self.height,
            self.format.bpp,
            self.format.pad,
            self.format.order,
            self.format.masks,
        )
    }

    /// Hash only color-bearing pixel bytes; skip row padding and undefined XRGB bits.
    pub fn tile_hashes(&self, tile_size: u16) -> CaptureResult<Vec<TileHash>> {
        raw_tile_hashes(
            self.data,
            self.width,
            self.height,
            self.format.bpp,
            self.format.pad,
            self.format.order,
            self.format.masks,
            tile_size,
        )
    }
}

fn raw_tile_hashes(
    data: &[u8],
    width: u16,
    height: u16,
    bpp: u8,
    pad: u8,
    order: ImageOrder,
    masks: [u32; 3],
    tile_size: u16,
) -> CaptureResult<Vec<TileHash>> {
    if tile_size == 0 || masks.iter().any(|mask| *mask == 0) {
        return Err(invalid("invalid tile size or X11 visual").into());
    }
    let length = zpixmap_len(width, height, bpp, pad)?;
    if data.len() < length {
        return Err(invalid("truncated X11 image").into());
    }
    let stride = length / usize::from(height);
    let pixel_bytes = usize::from(bpp / 8);
    let color_mask = masks[0] | masks[1] | masks[2];
    let full_mask = u32::MAX >> (32 - u32::from(bpp));
    // Common XRGB8888: copy each bounded tile row once and clear its unused
    // alpha byte. Never hash undefined alpha or the server's scanline padding.
    let xrgb_unused_byte = if bpp == 32 && color_mask == 0x00ff_ffff {
        Some(if order == ImageOrder::LSB_FIRST { 3 } else { 0 })
    } else {
        None
    };
    let byte_masks: Vec<u8> = (0..pixel_bytes)
        .map(|index| {
            let shift = if order == ImageOrder::LSB_FIRST {
                index * 8
            } else {
                (pixel_bytes - 1 - index) * 8
            };
            (color_mask >> shift) as u8
        })
        .collect();
    let mut hashes = Vec::new();
    let mut row = Vec::new();
    for y in (0..height).step_by(usize::from(tile_size)) {
        for x in (0..width).step_by(usize::from(tile_size)) {
            let tile_width = tile_size.min(width - x);
            let tile_height = tile_size.min(height - y);
            let mut hasher = Xxh3::new();
            for dy in 0..usize::from(tile_height) {
                let start = (usize::from(y) + dy) * stride + usize::from(x) * pixel_bytes;
                let pixels = &data[start..start + usize::from(tile_width) * pixel_bytes];
                if color_mask == full_mask {
                    hasher.update(pixels);
                } else {
                    row.clear();
                    row.extend_from_slice(pixels);
                    if let Some(unused) = xrgb_unused_byte {
                        for pixel in row.chunks_exact_mut(4) {
                            pixel[unused] = 0;
                        }
                    } else {
                        for pixel in row.chunks_exact_mut(pixel_bytes) {
                            for (byte, mask) in pixel.iter_mut().zip(&byte_masks) {
                                *byte &= mask;
                            }
                        }
                    }
                    hasher.update(&row);
                }
            }
            hashes.push(TileHash {
                x,
                y,
                width: tile_width,
                height: tile_height,
                hash: hasher.digest(),
            });
        }
    }
    Ok(hashes)
}

// IPC_RMID is attempted on all failures.
#[cfg(target_os = "linux")]
struct SysvSegment {
    id: libc::c_int,
    address: usize,
    removed: bool,
}

#[cfg(target_os = "linux")]
impl SysvSegment {
    fn new(len: usize) -> io::Result<Self> {
        // SAFETY: IPC_PRIVATE creates a new segment; `len` is positive and bounded.
        let id = unsafe { libc::shmget(libc::IPC_PRIVATE, len, libc::IPC_CREAT | 0o600) };
        if id == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `id` is a live segment. shmat returns (void*)-1 on failure.
        let ptr = unsafe { libc::shmat(id, std::ptr::null(), 0) };
        if ptr as isize == -1 {
            let error = io::Error::last_os_error();
            // SAFETY: `id` still belongs to us even if shmat failed.
            unsafe { libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut()) };
            return Err(error);
        }
        if ptr.is_null() {
            // A zero address can be a valid SysV attachment on permissive
            // systems but cannot be represented as a Rust slice reference.
            unsafe {
                libc::shmdt(ptr);
                libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
            }
            return Err(invalid("null SysV SHM mapping"));
        }
        Ok(Self {
            id,
            address: ptr as usize,
            removed: false,
        })
    }

    fn bytes(&self, len: usize) -> &[u8] {
        // SAFETY: mapping is live, len is the allocated size, and the checked
        // server reply has completed before this view is constructed.
        unsafe { std::slice::from_raw_parts(self.address as *const u8, len) }
    }

    fn mark_for_removal(&mut self) -> io::Result<()> {
        // SAFETY: `id` remains valid while client and server are attached.
        if unsafe { libc::shmctl(self.id, libc::IPC_RMID, std::ptr::null_mut()) } == -1 {
            return Err(io::Error::last_os_error());
        }
        self.removed = true;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl Drop for SysvSegment {
    fn drop(&mut self) {
        // SAFETY: This mapping was obtained by shmat and has not been detached.
        unsafe { libc::shmdt(self.address as *mut libc::c_void) };
        if !self.removed {
            // SAFETY: Best-effort cleanup of a segment not yet marked for removal.
            unsafe { libc::shmctl(self.id, libc::IPC_RMID, std::ptr::null_mut()) };
        }
    }
}

#[cfg(target_os = "linux")]
struct ShmAttachment<'a> {
    conn: &'a RustConnection,
    seg: u32,
    attached: bool,
}

#[cfg(target_os = "linux")]
impl ShmAttachment<'_> {
    fn detach(mut self) -> CaptureResult<()> {
        self.conn.shm_detach(self.seg)?.check()?;
        self.attached = false;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl Drop for ShmAttachment<'_> {
    fn drop(&mut self) {
        if self.attached {
            if let Ok(cookie) = self.conn.shm_detach(self.seg) {
                let _ = cookie.check();
            }
        }
    }
}

fn channel(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let value = (pixel & mask) >> mask.trailing_zeros();
    let max = mask >> mask.trailing_zeros();
    ((u64::from(value) * 255 + u64::from(max) / 2) / u64::from(max)) as u8
}

fn zpixmap_len(width: u16, height: u16, bpp: u8, pad: u8) -> CaptureResult<usize> {
    if width == 0 || height == 0 || !matches!(bpp, 8 | 16 | 24 | 32) || pad == 0 || pad % 8 != 0 {
        return Err(invalid("unsupported X11 ZPixmap format").into());
    }
    let bits = usize::from(width)
        .checked_mul(usize::from(bpp))
        .and_then(|n| n.checked_add(usize::from(pad) - 1))
        .ok_or_else(|| invalid("X11 image stride overflow"))?;
    let stride = (bits / usize::from(pad))
        .checked_mul(usize::from(pad) / 8)
        .ok_or_else(|| invalid("X11 image stride overflow"))?;
    stride
        .checked_mul(usize::from(height))
        .ok_or_else(|| invalid("X11 image size overflow").into())
}

fn decode_zpixmap(
    data: &[u8],
    width: u16,
    height: u16,
    bpp: u8,
    pad: u8,
    order: ImageOrder,
    masks: [u32; 3],
) -> CaptureResult<Vec<u8>> {
    let len = zpixmap_len(width, height, bpp, pad)?;
    if masks.iter().any(|m| *m == 0) {
        return Err(invalid("unsupported X11 visual").into());
    }
    if data.len() < len {
        return Err(invalid("truncated X11 GetImage response").into());
    }
    let stride = len / usize::from(height);
    let bytes_per_pixel = usize::from(bpp / 8);
    let mut rgba = Vec::with_capacity(usize::from(width) * usize::from(height) * 4);
    for y in 0..usize::from(height) {
        for x in 0..usize::from(width) {
            let start = y * stride + x * bytes_per_pixel;
            let pixel = &data[start..start + bytes_per_pixel];
            let value = if order == ImageOrder::LSB_FIRST {
                pixel
                    .iter()
                    .rev()
                    .fold(0_u32, |acc, byte| (acc << 8) | u32::from(*byte))
            } else {
                pixel
                    .iter()
                    .fold(0_u32, |acc, byte| (acc << 8) | u32::from(*byte))
            };
            rgba.extend_from_slice(&[
                channel(value, masks[0]),
                channel(value, masks[1]),
                channel(value, masks[2]),
                255,
            ]);
        }
    }
    Ok(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shm_geometry_uses_padded_full_rows_and_rejects_invalid_formats() {
        assert_eq!(zpixmap_len(3, 2, 24, 32).unwrap(), 24);
        assert_eq!(zpixmap_len(1, 2, 32, 64).unwrap(), 16);
        assert_eq!(zpixmap_len(2, 1, 16, 16).unwrap(), 4);
        assert!(zpixmap_len(0, 2, 32, 32).is_err());
        assert!(zpixmap_len(2, 0, 32, 32).is_err());
        assert!(zpixmap_len(2, 1, 12, 32).is_err());
        assert!(zpixmap_len(2, 1, 32, 7).is_err());
    }

    #[test]
    fn decode_24bpp_padded_rows() {
        assert_eq!(
            decode_zpixmap(
                &[3, 2, 1, 0, 6, 5, 4, 0],
                1,
                2,
                24,
                32,
                ImageOrder::LSB_FIRST,
                [0xff0000, 0xff00, 0xff]
            )
            .unwrap(),
            [1, 2, 3, 255, 4, 5, 6, 255]
        );
    }

    #[test]
    fn decode_little_endian_with_padded_rows() {
        let image = decode_zpixmap(
            &[
                0x03, 0x02, 0x01, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0x06, 0x05, 0x04, 0x00, 0x00, 0x00,
                0x00, 0x00,
            ],
            1,
            2,
            32,
            64,
            ImageOrder::LSB_FIRST,
            [0x00ff0000, 0x0000ff00, 0x000000ff],
        )
        .unwrap();
        assert_eq!(image, [1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn decode_big_endian_rgb565_and_reject_truncation() {
        let masks = [0xf800, 0x07e0, 0x001f];
        assert_eq!(
            decode_zpixmap(
                &[0xf8, 0x00, 0x00, 0x1f],
                2,
                1,
                16,
                16,
                ImageOrder::MSB_FIRST,
                masks
            )
            .unwrap(),
            [255, 0, 0, 255, 0, 0, 255, 255]
        );
        assert!(decode_zpixmap(&[0xf8], 2, 1, 16, 16, ImageOrder::MSB_FIRST, masks).is_err());
    }

    #[test]
    fn tile_hashes_include_partial_edges_and_are_stable() {
        let frame = RgbaFrame {
            width: 3,
            height: 2,
            rgba: (0..24).collect(),
        };
        let tiles = frame.tile_hashes(2).unwrap();
        assert_eq!(tiles.len(), 2);
        assert_eq!(
            (tiles[1].x, tiles[1].y, tiles[1].width, tiles[1].height),
            (2, 0, 1, 2)
        );
        assert_eq!(tiles[1].hash, xxh3_64(&[8, 9, 10, 11, 20, 21, 22, 23]));
        assert_eq!(tiles, frame.tile_hashes(2).unwrap());
        assert!(frame.tile_hashes(0).is_err());
    }

    #[test]
    fn native_hashes_ignore_padding_and_unused_bits_but_detect_color_changes() {
        // 3 x 2 XRGB pixels, row padded to 16 bytes, tile size 2.
        let mut raw = vec![0u8; 32];
        for y in 0..2 {
            for x in 0..3 {
                let offset = y * 16 + x * 4;
                raw[offset..offset + 4].copy_from_slice(&[x as u8 + 1, y as u8 + 2, 3, 0xaa]);
            }
        }
        let hash = |bytes: &[u8]| {
            raw_tile_hashes(
                bytes,
                3,
                2,
                32,
                128,
                ImageOrder::LSB_FIRST,
                [0xff0000, 0xff00, 0xff],
                2,
            )
            .unwrap()
        };
        let baseline = hash(&raw);
        assert_eq!(baseline.len(), 2);
        assert_eq!((baseline[1].x, baseline[1].width), (2, 1));
        let decoded = |bytes: &[u8]| {
            RgbaFrame {
                width: 3,
                height: 2,
                rgba: decode_zpixmap(
                    bytes,
                    3,
                    2,
                    32,
                    128,
                    ImageOrder::LSB_FIRST,
                    [0xff0000, 0xff00, 0xff],
                )
                .unwrap(),
            }
            .tile_hashes(2)
            .unwrap()
        };
        let decoded_baseline = decoded(&raw);
        raw[15] ^= 0xff; // scanline padding
        raw[3] ^= 0xff; // unused XRGB byte
        assert_eq!(hash(&raw), baseline);
        assert_eq!(decoded(&raw), decoded_baseline);
        raw[2 * 4] ^= 1; // color at the right partial tile
        assert_eq!(hash(&raw)[0], baseline[0]);
        assert_ne!(hash(&raw)[1], baseline[1]);
        assert_eq!(decoded(&raw)[0], decoded_baseline[0]);
        assert_ne!(decoded(&raw)[1], decoded_baseline[1]);
        assert!(raw_tile_hashes(
            &raw[..15],
            3,
            2,
            32,
            128,
            ImageOrder::LSB_FIRST,
            [0xff0000, 0xff00, 0xff],
            2
        )
        .is_err());
    }

    #[test]
    fn native_formats_and_endianness() {
        for (bytes, bpp, pad, order, masks) in [
            (
                vec![0xf8, 0x00, 0, 0x1f],
                16,
                16,
                ImageOrder::MSB_FIRST,
                [0xf800, 0x07e0, 0x001f],
            ),
            (
                vec![0, 0xf8, 0x1f, 0],
                16,
                16,
                ImageOrder::LSB_FIRST,
                [0xf800, 0x07e0, 0x001f],
            ),
            (
                vec![1, 2, 3, 4, 5, 6, 0, 0],
                24,
                32,
                ImageOrder::LSB_FIRST,
                [0xff0000, 0xff00, 0xff],
            ),
            (
                vec![3, 2, 1, 6, 5, 4, 0, 0],
                24,
                32,
                ImageOrder::MSB_FIRST,
                [0xff, 0xff00, 0xff0000],
            ),
        ] {
            let first = raw_tile_hashes(&bytes, 2, 1, bpp, pad, order, masks, 1).unwrap();
            assert_eq!(first.len(), 2);
            let mut changed = bytes.clone();
            changed[0] ^= 1;
            let second = raw_tile_hashes(&changed, 2, 1, bpp, pad, order, masks, 1).unwrap();
            assert_ne!(first[0].hash, second[0].hash);
            assert_eq!(first[1].hash, second[1].hash);
        }
    }

    #[test]
    fn big_endian_xrgb_ignores_unused_first_byte() {
        let masks = [0xff0000, 0xff00, 0xff];
        let original = [0xaa, 1, 2, 3, 0, 0, 0, 0];
        let mut changed = original;
        let hash = |raw: &[u8]| {
            raw_tile_hashes(raw, 1, 1, 32, 64, ImageOrder::MSB_FIRST, masks, 1).unwrap()
        };
        changed[0] = 0x55;
        changed[7] = 0xff;
        assert_eq!(hash(&original), hash(&changed));
        changed[1] ^= 1;
        assert_ne!(hash(&original), hash(&changed));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sysv_mapping_mark_remove_and_detach_on_resize_and_failure() {
        for len in [4096, 8192, 4096] {
            let mut segment = SysvSegment::new(len).unwrap();
            let id = segment.id;
            segment.mark_for_removal().unwrap();
            assert_eq!(segment.bytes(len).len(), len);
            drop(segment);
            // IPC_RMID and last detach removed the name, even on resize.
            assert_eq!(
                unsafe { libc::shmctl(id, libc::IPC_STAT, std::ptr::null_mut()) },
                -1
            );
        }
        let segment = SysvSegment::new(4096).unwrap();
        let id = segment.id;
        drop(segment); // failure before server attach still removes it
        assert_eq!(
            unsafe { libc::shmctl(id, libc::IPC_STAT, std::ptr::null_mut()) },
            -1
        );
    }

    #[test]
    #[ignore = "requires an accessible X11 server"]
    fn capture_live_root_pixel() {
        let capture = X11Capture::new().unwrap();
        let (width, height) = capture.screen_size().unwrap();
        assert!(width > 0 && height > 0);
        let pixel = capture.capture_region(0, 0, 1, 1).unwrap();
        assert_eq!((pixel.width, pixel.height), (1, 1));
        assert!(!pixel.png_base64.is_empty());
    }

    #[test]
    #[ignore = "requires an accessible X11 server; read-only full-root capture"]
    fn capture_live_root_fast() {
        let capture = X11Capture::new().unwrap();
        let frame = capture.capture_screen_fast().unwrap();
        assert_eq!((frame.width, frame.height), capture.screen_size().unwrap());
        assert_eq!(
            frame.rgba.len(),
            usize::from(frame.width) * usize::from(frame.height) * 4
        );
        assert!(frame.rgba.chunks_exact(4).all(|pixel| pixel[3] == 255));
        let mut fallback = X11Capture::new().unwrap();
        fallback.shm_available = false;
        let get_image = fallback.capture_screen_fast().unwrap();
        assert_eq!(get_image.rgba.len(), frame.rgba.len());
        if capture.shm_available {
            match capture.capture_screen_shm(frame.width, frame.height) {
                Ok(shm) => {
                    assert_eq!(shm.rgba.len(), frame.rgba.len());
                    eprintln!("MIT-SHM full-root capture succeeded");
                }
                Err(error) => eprintln!("MIT-SHM unavailable; GetImage fallback: {error}"),
            }
        } else {
            eprintln!("MIT-SHM extension unavailable; GetImage fallback");
        }
    }

    #[test]
    #[ignore = "requires an accessible X11 server; read-only SHM reuse/fallback"]
    fn live_native_hash_shm_reuse_and_fallback() {
        let capture = X11Capture::new().unwrap();
        let first = capture
            .with_screen_image(|image| image.tile_hashes(64))
            .unwrap();
        let first_seg = capture
            .shm
            .lock()
            .unwrap()
            .as_ref()
            .map(|buffer| buffer.seg);
        assert_eq!(
            capture
                .with_screen_image(|image| Ok(image.transport()))
                .unwrap(),
            if first_seg.is_some() {
                CaptureTransport::Shm
            } else {
                CaptureTransport::GetImage
            }
        );
        let second = capture
            .with_screen_image(|image| image.tile_hashes(64))
            .unwrap();
        assert_eq!(first.len(), second.len());
        assert_eq!(
            first_seg,
            capture
                .shm
                .lock()
                .unwrap()
                .as_ref()
                .map(|buffer| buffer.seg)
        );
        let mut fallback = X11Capture::new().unwrap();
        fallback.shm_available = false;
        let get_image = fallback
            .with_screen_image(|image| image.tile_hashes(64))
            .unwrap();
        assert_eq!(first.len(), get_image.len());
        assert_eq!(
            fallback
                .with_screen_image(|image| Ok(image.transport()))
                .unwrap(),
            CaptureTransport::GetImage
        );
        // A live screen may change between captures; compare only stable geometry.
        let live_id = capture.shm.lock().unwrap().as_ref().map(|buffer| {
            assert!(buffer.segment.removed);
            buffer.segment.id
        });
        drop(capture); // Server detach precedes client unmap and final IPC cleanup.
        if let Some(id) = live_id {
            assert_eq!(
                unsafe { libc::shmctl(id, libc::IPC_STAT, std::ptr::null_mut()) },
                -1
            );
        }
    }

    #[test]
    fn crop_selects_exact_pixels_and_checks_bounds() {
        let frame = RgbaFrame {
            width: 3,
            height: 2,
            rgba: (0..24).collect(),
        };
        assert_eq!(
            frame.crop(1, 0, 2, 2).unwrap().rgba,
            [4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]
        );
        assert!(frame.crop(2, 0, 2, 1).is_err());
        assert!(frame.crop(0, 0, 0, 1).is_err());
    }

    #[test]
    fn png_base64_has_png_signature() {
        let frame = RgbaFrame {
            width: 1,
            height: 1,
            rgba: vec![255, 0, 0, 255],
        };
        let png = base64::engine::general_purpose::STANDARD
            .decode(frame.png_base64().unwrap())
            .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
