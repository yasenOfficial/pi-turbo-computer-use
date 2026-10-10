//! Newline-delimited JSON over a Unix socket (or --stdio). One response per line.
//! Default socket: $XDG_RUNTIME_DIR/pi-computer.sock (normally
//! /run/user/$UID/pi-computer.sock). COMPUTER_USE_SOCKET overrides it.
//! Coordinates are absolute X11 coordinates.
use serde::{Deserialize, Serialize};

use crate::input::X11Window;
use crate::state::{seen::SeenSearch, Delta, Node, Snapshot};

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    /// Metadata only; never probes X11, AT-SPI, or the action mutex.
    DaemonInfo,
    /// Authenticated, idle-only cooperative exit. Not an emergency stop.
    ShutdownIfIdle(ShutdownRequest),
    /// `since` requests changes from that generation; otherwise a full tree.
    Observe {
        since: Option<u64>,
        #[serde(default)]
        screenshot: bool,
    },
    Inspect {
        id: String,
    },
    /// Metadata-only historical hints; never use an old ID without a fresh
    /// AT-SPI observation and validation before acting.
    SearchSeen {
        query: String,
        limit: Option<usize>,
    },
    /// Legacy PNG by default. With `incremental:true` and a bounded id, returns
    /// `visual` instead: full baseline when `since_visual` is absent/stale,
    /// otherwise changed PNG patches in absolute coordinates. Polling is on-demand.
    InspectVisual {
        id: Option<String>,
        /// Opt-in on-demand tile patches; requires an id-based bounded crop.
        #[serde(default)]
        incremental: bool,
        /// Revision from the last visual update; absent/stale revision returns a full crop.
        since_visual: Option<u64>,
    },
    Wait {
        since: Option<u64>,
        timeout_ms: Option<u64>,
        milliseconds: Option<u64>,
        condition: Option<WaitCondition>,
    },
    Changes {
        since: Option<u64>,
    },
    Click {
        id: Option<String>,
        x: Option<i32>,
        y: Option<i32>,
        button: Option<String>,
        clicks: Option<u8>,
        #[serde(default)]
        physical: bool,
    },
    DoubleClick {
        id: Option<String>,
        x: Option<i32>,
        y: Option<i32>,
    },
    Drag {
        from_x: i32,
        from_y: i32,
        to_x: i32,
        to_y: i32,
        button: Option<String>,
        steps: Option<u16>,
    },
    FocusWindow {
        title: String,
    },
    /// Launch a visible installed .desktop application via GIO, never a command line.
    LaunchApp(LaunchAppRequest),
    /// Local Unix-socket control plane only. Holds overlay activity across tool calls;
    /// it never authorizes input or changes the emergency-stop state.
    ControlActivity {
        action: ControlActivityAction,
        token: String,
        ttl_ms: Option<u64>,
    },
    /// Permanently disable input until this daemon is restarted.
    Stop,
    /// Clipboard-backed bounded UTF-8 paste, never a character-by-character fallback.
    PasteText {
        text: String,
        target: Option<WaitCondition>,
        window_title: Option<String>,
        /// Only for a preceding, explicitly verified GUI focus action in the
        /// unique active window; not independent machine focus evidence.
        focus_verified: Option<bool>,
    },
    #[serde(alias = "type")]
    SetText {
        id: Option<String>,
        text: String,
    },
    #[serde(alias = "key")]
    Keypress {
        key: String,
    },
    Scroll {
        x: Option<i32>,
        y: Option<i32>,
        direction: String,
        amount: Option<u32>,
    },
    /// Compare the current full root frame with the last explicit dirty_regions request.
    DirtyRegions,
    Screenshot {
        x: Option<u16>,
        y: Option<u16>,
        width: Option<u16>,
        height: Option<u16>,
    },
    Ping,
    /// Query bounded, metadata-only timings. `reset:true` returns the current
    /// interval, then clears counters atomically; ordinary queries never reset.
    Metrics {
        #[serde(default)]
        reset: bool,
    },
    Batch {
        actions: Vec<BatchAction>,
        #[serde(default = "default_true")]
        stop_on_error: bool,
        #[serde(default = "default_true")]
        include_changes: bool,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShutdownRequest {
    pub instance_id: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchAppRequest {
    pub app_id: Option<String>,
    pub name: Option<String>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppMatch {
    pub app_id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct LaunchResult {
    pub app_id: String,
    pub name: String,
    /// GIO accepted dispatch; this does not mean a window exists or is ready.
    pub accepted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlActivityAction {
    Begin,
    Renew,
    End,
}

fn default_true() -> bool {
    true
}

/// Only bounded, non-visual operations are allowed in a batch.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BatchAction {
    Click {
        id: Option<String>,
        target: Option<WaitCondition>,
        x: Option<i32>,
        y: Option<i32>,
        button: Option<String>,
        clicks: Option<u8>,
        #[serde(default)]
        physical: bool,
    },
    DoubleClick {
        id: Option<String>,
        target: Option<WaitCondition>,
        x: Option<i32>,
        y: Option<i32>,
    },
    SetText {
        id: Option<String>,
        target: Option<WaitCondition>,
        text: String,
    },
    Keypress {
        key: String,
    },
    Scroll {
        x: Option<i32>,
        y: Option<i32>,
        direction: String,
        amount: Option<u32>,
    },
    Drag {
        from_x: i32,
        from_y: i32,
        to_x: i32,
        to_y: i32,
        button: Option<String>,
        steps: Option<u16>,
    },
    FocusWindow {
        title: String,
    },
    Wait {
        since: Option<u64>,
        timeout_ms: Option<u64>,
        milliseconds: Option<u64>,
        condition: Option<WaitCondition>,
    },
    /// Immediate equality check against a fresh AT-SPI scan; never waits.
    Assert {
        target: WaitCondition,
        expected: AssertFields,
    },
}

/// A missing field is not checked. `value: null` explicitly checks for no value.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssertFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_assert_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub value: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
}

fn deserialize_assert_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionDetail {
    pub node_id: String,
    pub role: String,
    pub matched: bool,
    pub expected: AssertFields,
    pub actual: AssertActual,
}

#[derive(Debug, Default, Serialize)]
pub struct AssertActual {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<Option<bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<Option<bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<Option<bool>>,
}

impl BatchAction {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Click { .. } => "click",
            Self::DoubleClick { .. } => "double_click",
            Self::SetText { .. } => "set_text",
            Self::Keypress { .. } => "keypress",
            Self::Scroll { .. } => "scroll",
            Self::Drag { .. } => "drag",
            Self::FocusWindow { .. } => "focus_window",
            Self::Wait { .. } => "wait",
            Self::Assert { .. } => "assert",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStep {
    pub index: usize,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub ok: bool,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assertion: Option<AssertionDetail>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub steps: Vec<BatchStep>,
    pub elapsed_ms: u64,
    pub completed: bool,
}

#[derive(Debug, Deserialize)]
pub struct WaitCondition {
    pub id: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PasteResult {
    /// dispatched=shortcut and a non-TARGETS selection transfer observed;
    /// uncertain=shortcut attempted but transfer unconfirmed;
    /// not_pasted=no shortcut attempted. Never proof of field insertion.
    pub status: &'static str,
    pub method: &'static str,
    /// Exactly one preflighted gesture: ctrl_v or shift_insert. No retry.
    pub shortcut: &'static str,
    /// semantic=live AT-SPI focused editable field; declared_active_window=
    /// caller-declared focus with an independently observed exact active title.
    pub focus_verification: &'static str,
    pub paste_sent: bool,
    pub clipboard_restore_status: &'static str,
    pub clipboard_restored: bool,
    /// Null after an XTEST transport failure: some presses may have arrived.
    pub keyboard_events: Option<u64>,
    pub verified: bool,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_info: Option<crate::runtime::DaemonInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch: Option<BatchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch: Option<LaunchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paste: Option<PasteResult>,
    /// Installed visible desktop entries only; never Exec or filesystem paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_matches: Option<Vec<AppMatch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_matches_total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_matches_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_discovery: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_attempted: Option<bool>,
    /// Net semantic change from the pre-batch generation, even if intermediate
    /// cache generations have been evicted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Delta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Snapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<Delta>,
    /// Current EWMH clients (also present on changes with an empty semantic delta).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<X11Window>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<Node>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen: Option<SeenSearch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub png_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visual: Option<crate::visual::VisualUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_diff: Option<crate::screen_diff::ScreenDiffUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<crate::metrics::Report>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<bool>,
    /// Whether the emergency stop has disabled input for this daemon lifetime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_stopped: Option<bool>,
}

impl Response {
    pub fn empty() -> Self {
        Self {
            ok: true,
            daemon_info: None,
            error: None,
            batch: None,
            launch: None,
            paste: None,
            app_matches: None,
            app_matches_total: None,
            app_matches_truncated: None,
            app_discovery: None,
            launch_status: None,
            launch_attempted: None,
            changes: None,
            snapshot: None,
            delta: None,
            windows: None,
            node: None,
            seen: None,
            png_base64: None,
            visual: None,
            screen_diff: None,
            metrics: None,
            matched: None,
            input_stopped: None,
        }
    }
    pub fn error(error: impl std::fmt::Display) -> Self {
        Self {
            ok: false,
            error: Some(error.to_string()),
            ..Self::empty()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metrics_are_explicit_and_reset_is_opt_in() {
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"metrics"}"#).unwrap(),
            Request::Metrics { reset: false }
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"metrics","reset":true}"#).unwrap(),
            Request::Metrics { reset: true }
        ));
        let compact = serde_json::to_value(Response::empty()).unwrap();
        assert!(compact.get("metrics").is_none());
        assert_eq!(
            serde_json::to_value(Response {
                metrics: Some(crate::metrics::Metrics::default().report(false)),
                ..Response::empty()
            })
            .unwrap()["metrics"]["stages"]["capture"]["count"],
            0
        );
    }

    #[test]
    fn batch_contract_and_compact_response() {
        let request: Request = serde_json::from_str(r#"{"cmd":"batch","actions":[{"type":"click","id":"n10"},{"type":"wait","condition":{"name":"Save","role":"dialog"},"timeout_ms":150},{"type":"set_text","target":{"role":"text","name":"Query"},"text":"hello"},{"type":"click","target":{"role":"push button","name":"OK"}}],"stop_on_error":true,"include_changes":true}"#).unwrap();
        let Request::Batch {
            actions,
            stop_on_error,
            include_changes,
        } = request
        else {
            panic!("expected batch")
        };
        assert!(stop_on_error && include_changes);
        assert_eq!(actions.len(), 4);
        assert!(matches!(&actions[0], BatchAction::Click { id: Some(id), .. } if id == "n10"));
        assert!(matches!(
            &actions[1],
            BatchAction::Wait {
                timeout_ms: Some(150),
                ..
            }
        ));
        assert!(matches!(
            &actions[2],
            BatchAction::SetText {
                target: Some(_),
                ..
            }
        ));
        assert!(matches!(
            &actions[3],
            BatchAction::Click {
                target: Some(_),
                ..
            }
        ));
        let encoded = serde_json::to_value(Response {
            ok: false,
            error: Some("failed".into()),
            batch: Some(BatchResult {
                steps: vec![BatchStep {
                    index: 0,
                    kind: "click",
                    ok: false,
                    elapsed_ms: 1,
                    error: Some("stopped".into()),
                    matched: None,
                    assertion: None,
                }],
                completed: false,
                elapsed_ms: 2,
            }),
            ..Response::empty()
        })
        .unwrap();
        assert_eq!(encoded["batch"]["steps"][0]["elapsedMs"], 1);
        assert_eq!(encoded["batch"]["steps"][0]["type"], "click");
        assert!(encoded.get("snapshot").is_none());
        assert!(encoded.get("png_base64").is_none());
        assert!(matches!(
            serde_json::from_str::<Request>(
                r#"{"cmd":"batch","actions":[{"type":"keypress","key":"Return"}]}"#
            )
            .unwrap(),
            Request::Batch {
                stop_on_error: true,
                include_changes: true,
                ..
            }
        ));
        assert!(serde_json::from_str::<Request>(
            r#"{"cmd":"batch","actions":[{"type":"screenshot"}]}"#
        )
        .is_err());
    }

    #[test]
    fn assert_batch_contract_preserves_null_false_and_rejects_unknown_fields() {
        let request: Request = serde_json::from_str(
            r#"{"cmd":"batch","actions":[{"type":"assert","target":{"id":"n1","role":"entry"},"expected":{"value":null,"enabled":false}}]}"#,
        ).unwrap();
        let Request::Batch { actions, .. } = request else {
            panic!("batch")
        };
        let BatchAction::Assert { target, expected } = &actions[0] else {
            panic!("assert")
        };
        assert_eq!(target.id.as_deref(), Some("n1"));
        assert!(matches!(expected.value, Some(None)));
        assert_eq!(expected.enabled, Some(false));
        assert_eq!(actions[0].kind(), "assert");
        let step = serde_json::to_value(BatchStep {
            index: 0,
            kind: "assert",
            ok: false,
            elapsed_ms: 3,
            error: Some("assertion mismatch".into()),
            matched: Some(false),
            assertion: Some(AssertionDetail {
                node_id: "n1".into(),
                role: "entry".into(),
                matched: false,
                expected: AssertFields {
                    value: Some(None),
                    enabled: Some(false),
                    ..AssertFields::default()
                },
                actual: AssertActual {
                    value: Some(Some("text".into())),
                    enabled: Some(None),
                    ..AssertActual::default()
                },
            }),
        })
        .unwrap();
        assert_eq!(
            step["assertion"]["expected"]["value"],
            serde_json::Value::Null
        );
        assert_eq!(step["assertion"]["expected"]["enabled"], false);
        assert_eq!(step["assertion"]["actual"]["value"], "text");
        assert_eq!(
            step["assertion"]["actual"]["enabled"],
            serde_json::Value::Null
        );
        assert!(serde_json::from_str::<Request>(
            r#"{"cmd":"batch","actions":[{"type":"assert","target":{"id":"n1"},"expected":{"unknown":true}}]}"#
        ).is_err());
        let request: Request = serde_json::from_str(
            r#"{"cmd":"batch","actions":[{"type":"assert","target":{"id":"n1"},"expected":{"value":""}}]}"#
        ).unwrap();
        let Request::Batch { actions, .. } = request else {
            panic!("batch")
        };
        assert!(
            matches!(&actions[0], BatchAction::Assert { expected: AssertFields { value: Some(Some(value)), .. }, .. } if value.is_empty())
        );
    }

    #[test]
    fn dirty_regions_contract_is_metadata_only_across_repeated_requests() {
        use crate::{capture::RgbaFrame, screen_diff::ScreenDiffCache};

        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"dirty_regions"}"#).unwrap(),
            Request::DirtyRegions
        ));
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"quadrants"}"#).is_err());
        let mut cache = ScreenDiffCache::new(2);
        let mut frame = RgbaFrame {
            width: 4,
            height: 4,
            rgba: vec![0; 4 * 4 * 4],
        };
        let baseline = serde_json::to_value(Response {
            screen_diff: Some(cache.update(&frame).unwrap()),
            ..Response::empty()
        })
        .unwrap();
        assert_eq!(baseline["screen_diff"]["baseline"], true);
        assert_eq!(
            baseline["screen_diff"]["regions"],
            serde_json::json!([
                {"x":0,"y":0,"width":4,"height":4}
            ])
        );
        assert_eq!(baseline["screen_diff"]["dirty_tiles"], 4);
        assert!(baseline.get("quadrants").is_none());

        let unchanged = serde_json::to_value(Response {
            screen_diff: Some(cache.update(&frame).unwrap()),
            ..Response::empty()
        })
        .unwrap();
        assert_eq!(unchanged["screen_diff"]["revision"], 2);
        assert_eq!(unchanged["screen_diff"]["baseline"], false);
        assert_eq!(unchanged["screen_diff"]["regions"], serde_json::json!([]));

        frame.rgba[0] = 255;
        let changed = serde_json::to_value(Response {
            screen_diff: Some(cache.update(&frame).unwrap()),
            ..Response::empty()
        })
        .unwrap();
        assert_eq!(changed["screen_diff"]["dirty_tiles"], 1);
        assert_eq!(
            changed["screen_diff"]["regions"],
            serde_json::json!([
                {"x":0,"y":0,"width":2,"height":2}
            ])
        );
        assert!(changed.get("png_base64").is_none());
        assert!(!serde_json::to_string(&changed).unwrap().contains("base64"));
        assert!(Response::error("X11 unavailable").screen_diff.is_none());
    }

    #[test]
    fn search_seen_contract() {
        assert!(
            matches!(serde_json::from_str::<Request>(r#"{"cmd":"search_seen","query":"Save","limit":5}"#).unwrap(),
            Request::SearchSeen { query, limit: Some(5) } if query == "Save")
        );
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"search_seen","limit":1}"#).is_err());
        assert!(Response::empty().seen.is_none());
        let value = serde_json::to_value(Response {
            seen: Some(SeenSearch {
                generation: 1,
                results: vec![],
            }),
            ..Response::empty()
        })
        .unwrap();
        assert_eq!(value["seen"]["results"], serde_json::json!([]));
        assert!(value.get("png_base64").is_none());
    }

    #[test]
    fn control_activity_contract() {
        let Request::ControlActivity { action, token, ttl_ms } =
            serde_json::from_str::<Request>(
                r#"{"cmd":"control_activity","action":"begin","token":"00112233-4455-6677-8899-aabbccddeeff"}"#
            ).unwrap() else { panic!("expected control_activity") };
        assert_eq!(action, ControlActivityAction::Begin);
        assert_eq!(token, "00112233-4455-6677-8899-aabbccddeeff");
        assert_eq!(ttl_ms, None);
        assert!(matches!(
            serde_json::from_str::<Request>(
                r#"{"cmd":"control_activity","action":"renew","token":"x","ttl_ms":10000}"#
            )
            .unwrap(),
            Request::ControlActivity {
                action: ControlActivityAction::Renew,
                ttl_ms: Some(10000),
                ..
            }
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(
                r#"{"cmd":"control_activity","action":"end","token":"x"}"#
            )
            .unwrap(),
            Request::ControlActivity {
                action: ControlActivityAction::End,
                ..
            }
        ));
        assert!(serde_json::from_str::<Request>(
            r#"{"cmd":"control_activity","action":"toggle","token":"x"}"#
        )
        .is_err());
        assert_eq!(
            serde_json::to_value(Response::empty()).unwrap(),
            serde_json::json!({"ok":true})
        );
    }

    #[test]
    fn launch_contract() {
        assert!(matches!(
            serde_json::from_str::<Request>(
                r#"{"cmd":"launch_app","app_id":"org.example.App.desktop"}"#
            )
            .unwrap(),
            Request::LaunchApp(LaunchAppRequest {
                app_id: Some(_),
                name: None,
                query: None
            })
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"launch_app","name":"Example"}"#).unwrap(),
            Request::LaunchApp(LaunchAppRequest {
                app_id: None,
                name: Some(_),
                query: None
            })
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"launch_app","query":"CubeIDE"}"#).unwrap(),
            Request::LaunchApp(LaunchAppRequest {
                query: Some(_),
                app_id: None,
                name: None
            })
        ));
        assert!(serde_json::from_str::<Request>(
            r#"{"cmd":"launch_app","name":"Example","exec":"evil"}"#
        )
        .is_err());
        let value = serde_json::to_value(Response {
            launch: Some(LaunchResult {
                app_id: "org.example.App.desktop".into(),
                name: "Example".into(),
                accepted: true,
            }),
            ..Response::empty()
        })
        .unwrap();
        assert_eq!(
            value["launch"],
            serde_json::json!({"app_id":"org.example.App.desktop","name":"Example","accepted":true})
        );
        assert!(value.get("app_matches").is_none());
    }

    #[test]
    fn command_contract() {
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"observe","since":1}"#).unwrap(),
            Request::Observe {
                since: Some(1),
                screenshot: false
            }
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"click","id":"n1"}"#).unwrap(),
            Request::Click { id: Some(_), .. }
        ));
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"keypress","key":"Return"}"#).is_ok());
        assert!(
            serde_json::from_str::<Request>(r#"{"cmd":"wait","since":1,"timeout_ms":200}"#).is_ok()
        );
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"inspect","id":"n1"}"#).is_ok());
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"click","id":"n1","physical":true}"#)
                .unwrap(),
            Request::Click { physical: true, .. }
        ));
        assert!(serde_json::from_str::<Request>(
            r#"{"cmd":"drag","from_x":0,"from_y":0,"to_x":1,"to_y":1}"#
        )
        .is_ok());
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"cmd":"inspect_visual","id":"n1"}"#).unwrap(),
            Request::InspectVisual {
                incremental: false,
                ..
            }
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(
                r#"{"cmd":"inspect_visual","id":"n1","incremental":true}"#
            )
            .unwrap(),
            Request::InspectVisual {
                incremental: true,
                since_visual: None,
                ..
            }
        ));
        assert!(
            serde_json::from_str::<Request>(r#"{"cmd":"focus_window","title":"Terminal"}"#).is_ok()
        );
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"stop"}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"double_click","x":1,"y":2}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"type","text":"hi"}"#).is_ok());
        assert!(matches!(
            serde_json::from_str::<Request>(
                r#"{"cmd":"wait","milliseconds":20,"condition":{"role":"button","name":"Save"}}"#
            )
            .unwrap(),
            Request::Wait {
                milliseconds: Some(20),
                condition: Some(_),
                ..
            }
        ));
        assert!(
            serde_json::from_str::<Request>(r#"{"cmd":"set_text","id":"n1","text":"hi"}"#).is_ok()
        );
    }
}
