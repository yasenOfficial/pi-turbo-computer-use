//! Daemon settings. Only the daemon reads TOML; the Pi extension has its own
//! environment-based socket and timeout settings.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug)]
pub struct Config {
    pub socket: String,
    pub overlay: bool,
    pub overlay_style: OverlayStyle,
    pub tile_size: u16,
    pub debug: bool,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    daemon: Option<DaemonConfig>,
    // Kept for the reference defaults; the daemon does not configure the client.
    client: Option<ClientConfig>,
    overlay: Option<OverlayFileConfig>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct OverlayFileConfig {
    edge: Option<EdgeFileConfig>,
    cursor: Option<CursorFileConfig>,
    animation: Option<AnimationFileConfig>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeFileConfig {
    color: Option<String>,
    width: Option<u16>,
    blur: Option<u16>,
    opacity: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorFileConfig {
    color: Option<String>,
    radius: Option<u16>,
    opacity: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnimationFileConfig {
    enabled: Option<bool>,
    period_ms: Option<u64>,
    fps: Option<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnimationStyle {
    pub enabled: bool,
    pub period_ms: u64,
    pub fps: u16,
}

impl AnimationStyle {
    /// The owner should schedule at this cadence only while control is active.
    pub fn frame_interval(self) -> Duration {
        Duration::from_secs(1) / u32::from(self.fps)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EdgeStyle {
    pub color: [u8; 3],
    pub width: u16,
    pub blur: u16,
    pub opacity: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorStyle {
    pub color: [u8; 3],
    pub radius: u16,
    pub opacity: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlayStyle {
    pub edge: EdgeStyle,
    pub cursor: CursorStyle,
    pub animation: AnimationStyle,
}

impl Default for OverlayStyle {
    fn default() -> Self {
        // Subtle cool edge and a single soft pointer halo without a config file.
        Self {
            edge: EdgeStyle {
                color: [0x41, 0x98, 0xf7],
                width: 2,
                blur: 28,
                opacity: 0.22,
            },
            cursor: CursorStyle {
                color: [0x41, 0x98, 0xf7],
                radius: 40,
                opacity: 0.38,
            },
            animation: AnimationStyle {
                enabled: true,
                period_ms: 1600,
                fps: 30,
            },
        }
    }
}

fn color(value: &str, name: &str) -> Result<[u8; 3]> {
    let hex = value.strip_prefix('#').unwrap_or("");
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("{name} must be a #RRGGBB hex color");
    }
    Ok([
        u8::from_str_radix(&hex[0..2], 16)?,
        u8::from_str_radix(&hex[2..4], 16)?,
        u8::from_str_radix(&hex[4..6], 16)?,
    ])
}

fn bounded(value: u16, min: u16, max: u16, name: &str) -> Result<u16> {
    if !(min..=max).contains(&value) {
        bail!("{name} must be {min}..={max}");
    }
    Ok(value)
}

fn opacity(value: f64, name: &str) -> Result<f64> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        bail!("{name} must be a finite number in 0.0..=1.0");
    }
    Ok(value)
}

impl OverlayStyle {
    fn from_file(file: Option<OverlayFileConfig>) -> Result<Self> {
        let mut style = Self::default();
        let file = file.unwrap_or_default();
        if let Some(edge) = file.edge {
            if let Some(value) = edge.color {
                style.edge.color = color(&value, "overlay.edge.color")?;
            }
            if let Some(value) = edge.width {
                style.edge.width = bounded(value, 1, 64, "overlay.edge.width")?;
            }
            if let Some(value) = edge.blur {
                style.edge.blur = bounded(value, 0, 64, "overlay.edge.blur")?;
            }
            if let Some(value) = edge.opacity {
                style.edge.opacity = opacity(value, "overlay.edge.opacity")?;
            }
        }
        if let Some(cursor) = file.cursor {
            if let Some(value) = cursor.color {
                style.cursor.color = color(&value, "overlay.cursor.color")?;
            }
            if let Some(value) = cursor.radius {
                style.cursor.radius = bounded(value, 16, 128, "overlay.cursor.radius")?;
            }
            if let Some(value) = cursor.opacity {
                style.cursor.opacity = opacity(value, "overlay.cursor.opacity")?;
            }
        }
        if let Some(animation) = file.animation {
            if let Some(value) = animation.enabled {
                style.animation.enabled = value;
            }
            if let Some(value) = animation.period_ms {
                if !(400..=10_000).contains(&value) {
                    bail!("overlay.animation.period_ms must be 400..=10000");
                }
                style.animation.period_ms = value;
            }
            if let Some(value) = animation.fps {
                style.animation.fps = bounded(value, 10, 30, "overlay.animation.fps")?;
            }
        }
        Ok(style)
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct DaemonConfig {
    socket: Option<String>,
    socket_mode: Option<String>,
    overlay: Option<bool>,
    tile_size: Option<u16>,
    debug: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientConfig {
    timeout_ms: Option<u64>,
}

fn default_socket() -> String {
    format!(
        "{}/pi-computer.sock",
        std::env::var("XDG_RUNTIME_DIR")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("/run/user/{}", unsafe { libc::geteuid() }))
    )
}

fn env_override(name: &str) -> Result<Option<String>> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => bail!("{name}: {error}"),
    }
}

fn parse_bool(value: &str) -> Result<bool> {
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("expected 1/0, true/false, yes/no, or on/off"),
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        let explicit = std::env::var_os("COMPUTER_USE_CONFIG");
        let path = if let Some(path) = explicit.as_ref() {
            if path.is_empty() {
                bail!("COMPUTER_USE_CONFIG must be a non-empty path");
            }
            Some(PathBuf::from(path))
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))
                })
                .map(|dir| dir.join("pi-computer/config.toml"))
        };
        let file = match path {
            Some(path) if explicit.is_some() => Self::read_file(&path)?,
            Some(path) => match std::fs::read_to_string(&path) {
                Ok(contents) => toml::from_str(&contents)
                    .with_context(|| format!("parse config {}", path.display()))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileConfig::default(),
                Err(error) => {
                    return Err(error).with_context(|| format!("read config {}", path.display()))
                }
            },
            None => FileConfig::default(),
        };
        Self::from_file(
            file,
            env_override("COMPUTER_USE_SOCKET")?.as_deref(),
            env_override("COMPUTER_USE_OVERLAY")?.as_deref(),
            env_override("COMPUTER_USE_TILE_SIZE")?.as_deref(),
            env_override("COMPUTER_USE_DEBUG")?.as_deref(),
        )
    }

    fn from_file(
        file: FileConfig,
        socket_env: Option<&str>,
        overlay_env: Option<&str>,
        tile_env: Option<&str>,
        debug_env: Option<&str>,
    ) -> Result<Self> {
        let overlay_style = OverlayStyle::from_file(file.overlay)?;
        let daemon = file.daemon.unwrap_or_default();
        if daemon
            .socket_mode
            .as_deref()
            .is_some_and(|mode| mode != "0600")
        {
            bail!("daemon.socket_mode must be 0600 (socket permissions are fixed)");
        }
        // The client section documents extension defaults but is not applied here.
        let _ = file.client.and_then(|client| client.timeout_ms);
        let file_socket = daemon
            .socket
            .as_deref()
            .unwrap_or("${XDG_RUNTIME_DIR}/pi-computer.sock");
        if file_socket.is_empty() {
            bail!("daemon.socket must not be empty");
        }
        let socket = socket_env
            .map(str::to_owned)
            .unwrap_or_else(|| match file_socket {
                "${XDG_RUNTIME_DIR}/pi-computer.sock" => default_socket(),
                value => value.to_owned(),
            });
        if socket.is_empty() {
            bail!("socket path must not be empty");
        }
        let overlay = overlay_env
            .map(parse_bool)
            .transpose()
            .context("COMPUTER_USE_OVERLAY")?
            .unwrap_or(daemon.overlay.unwrap_or(true));
        let file_tile = daemon.tile_size.unwrap_or(64);
        if file_tile == 0 {
            bail!("daemon.tile_size must be 1..=65535");
        }
        let tile_size = tile_env
            .map(|value| {
                value
                    .parse::<u16>()
                    .context("COMPUTER_USE_TILE_SIZE must be 1..=65535")
            })
            .transpose()?
            .unwrap_or(file_tile);
        if tile_size == 0 {
            bail!("tile_size must be 1..=65535");
        }
        let debug = debug_env
            .map(parse_bool)
            .transpose()
            .context("COMPUTER_USE_DEBUG")?
            .unwrap_or(daemon.debug.unwrap_or(false));
        Ok(Self {
            socket,
            overlay,
            overlay_style,
            tile_size,
            debug,
        })
    }

    fn read_file(path: &Path) -> Result<FileConfig> {
        let contents = std::fs::read_to_string(path)
            .with_context(|| format!("read config {}", path.display()))?;
        toml::from_str(&contents).with_context(|| format!("parse config {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_defaults_parse() {
        let config: FileConfig = toml::from_str(include_str!("../../config/default.toml")).unwrap();
        let daemon = config.daemon.unwrap();
        assert_eq!(
            daemon.socket.as_deref(),
            Some("${XDG_RUNTIME_DIR}/pi-computer.sock")
        );
        assert_eq!(daemon.socket_mode.as_deref(), Some("0600"));
        assert_eq!(daemon.overlay, Some(true));
        assert_eq!(daemon.tile_size, Some(64));
        assert_eq!(daemon.debug, Some(false));
        assert_eq!(config.client.unwrap().timeout_ms, Some(30_000));
        let style = OverlayStyle::from_file(config.overlay).unwrap();
        assert_eq!(style.edge.color, [0x41, 0x98, 0xf7]);
        assert_eq!((style.edge.width, style.edge.blur), (2, 28));
        assert_eq!(style.edge.opacity, 0.22);
        assert_eq!(style.cursor.color, [0x41, 0x98, 0xf7]);
        assert_eq!(style.cursor.radius, 40);
        assert_eq!(style.cursor.opacity, 0.38);
        assert_eq!(
            style.animation,
            AnimationStyle {
                enabled: true,
                period_ms: 1600,
                fps: 30
            }
        );
        assert_eq!(
            style.animation.frame_interval(),
            Duration::from_secs(1) / 30
        );
    }

    #[test]
    fn parses_custom_settings_and_rejects_invalid_config() {
        let config: FileConfig = toml::from_str(
            "[daemon]\nsocket = '/tmp/test.sock'\noverlay = false\ntile_size = 32\ndebug = true\n",
        )
        .unwrap();
        let daemon = config.daemon.unwrap();
        assert_eq!(daemon.socket.as_deref(), Some("/tmp/test.sock"));
        assert_eq!(daemon.overlay, Some(false));
        assert_eq!(daemon.tile_size, Some(32));
        assert_eq!(daemon.debug, Some(true));
        for invalid in [
            "[daemon]\ntile_size = -1",
            "[daemon]\noverlay = 'off'",
            "[daemon]\nunknown = true",
            "[daemon\n",
        ] {
            assert!(toml::from_str::<FileConfig>(invalid).is_err(), "{invalid}");
        }
        assert!(parse_bool("OFF").is_ok_and(|value| !value));
        assert!(parse_bool("bogus").is_err());
    }

    #[test]
    fn overrides_and_validation() {
        let file = || {
            toml::from_str("[daemon]\nsocket = '/tmp/config.sock'\noverlay = false\ntile_size = 32\ndebug = false\n").unwrap()
        };
        let config = Config::from_file(
            file(),
            Some("/tmp/env.sock"),
            Some("ON"),
            Some("16"),
            Some("yes"),
        )
        .unwrap();
        assert_eq!(config.socket, "/tmp/env.sock");
        assert!(config.overlay && config.debug);
        assert_eq!(config.tile_size, 16);
        let config = Config::from_file(file(), None, None, None, None).unwrap();
        assert_eq!(config.socket, "/tmp/config.sock");
        assert!(!config.overlay && !config.debug);
        assert_eq!(config.tile_size, 32);
        for bad in ["tile_size = 0", "socket_mode = '0666'", "socket = ''"] {
            let file = toml::from_str(&format!("[daemon]\n{bad}\n")).unwrap();
            assert!(
                Config::from_file(file, Some("/tmp/override.sock"), None, Some("64"), None)
                    .is_err()
            );
        }
        assert!(Config::from_file(file(), None, None, Some("0"), None).is_err());
        assert!(Config::from_file(file(), None, Some("maybe"), None, None).is_err());
    }

    #[test]
    fn overlay_style_parsing_and_validation() {
        let parse = |text| {
            let file: FileConfig = toml::from_str(text)?;
            Ok::<_, anyhow::Error>(Config::from_file(file, None, None, None, None)?.overlay_style)
        };
        let default = parse("").unwrap();
        assert_eq!(default, OverlayStyle::default());
        assert_eq!(default.edge.color, [0x41, 0x98, 0xf7]);
        assert_eq!((default.edge.width, default.edge.blur), (2, 28));
        assert_eq!(default.cursor.color, [0x41, 0x98, 0xf7]);
        assert_eq!(default.cursor.radius, 40);
        assert_eq!(
            default.animation.frame_interval(),
            Duration::from_secs(1) / 30
        );
        let animation =
            parse("[overlay.animation]\nenabled = false\nperiod_ms = 2400\nfps = 30\n").unwrap();
        assert_eq!(
            animation.animation,
            AnimationStyle {
                enabled: false,
                period_ms: 2400,
                fps: 30
            }
        );
        assert_eq!(
            animation.animation.frame_interval(),
            Duration::from_secs(1) / 30
        );
        let partial = parse("[overlay.edge]\ncolor = '#aB00Ff'\nblur = 0\n[overlay.cursor]\nradius = 16\nopacity = 0.0\n").unwrap();
        assert_eq!(partial.edge.color, [0xab, 0, 0xff]);
        assert_eq!(partial.edge.width, default.edge.width);
        assert_eq!(partial.edge.blur, 0);
        assert_eq!(partial.cursor.radius, 16);
        assert_eq!(partial.cursor.opacity, 0.0);
        for invalid in [
            "[overlay.edge]\ncolor = '4198F7'",
            "[overlay.edge]\ncolor = '#12345g'",
            "[overlay.edge]\nwidth = 0",
            "[overlay.edge]\nwidth = 65",
            "[overlay.edge]\nblur = 65",
            "[overlay.edge]\nopacity = -0.1",
            "[overlay.edge]\nopacity = 1.1",
            "[overlay.edge]\nopacity = nan",
            "[overlay.cursor]\ncolor = '#abc'",
            "[overlay.cursor]\nradius = 15",
            "[overlay.cursor]\nradius = 129",
            "[overlay.cursor]\nopacity = inf",
            "[overlay.cursor]\nunknown = true",
            "[overlay.animation]\nperiod_ms = 399",
            "[overlay.animation]\nperiod_ms = 10001",
            "[overlay.animation]\nfps = 9",
            "[overlay.animation]\nfps = 31",
            "[overlay.animation]\nfps = -1",
            "[overlay.animation]\nenabled = 'yes'",
            "[overlay.animation]\nunknown = true",
        ] {
            assert!(parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn explicit_missing_config_is_an_error() {
        assert!(Config::read_file(Path::new("/nonexistent/pi-computer-config-test.toml")).is_err());
    }
}
