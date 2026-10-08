//! Desktop-entry launching. No Exec strings, paths or shell commands are accepted
//! from IPC: GIO resolves installed application metadata and performs activation.
use crate::{
    protocol::{AppMatch, LaunchAppRequest, LaunchResult, Response},
    safety::Safety,
};
use std::{
    ffi::{c_char, c_int, c_void, CStr},
    ptr,
};

const MAX_SELECTOR: usize = 240;
const MAX_MATCHES: usize = 20;

fn failure(status: &'static str, error: impl Into<String>) -> Response {
    Response {
        ok: false,
        error: Some(error.into()),
        launch_status: Some(status),
        launch_attempted: Some(false),
        ..Response::empty()
    }
}

fn validate(request: &LaunchAppRequest) -> Result<(), &'static str> {
    match (&request.app_id, &request.name, &request.query) {
        (Some(id), None, None) => {
            if id.is_empty()
                || id.len() > MAX_SELECTOR
                || !id.ends_with(".desktop")
                || id.starts_with('.')
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            {
                return Err("app_id must be a desktop ID basename (*.desktop, max 240 ASCII bytes; no paths)");
            }
        }
        (None, Some(name), None) => {
            if name.is_empty()
                || name.trim().is_empty()
                || name.chars().count() > MAX_SELECTOR
                || name.chars().any(char::is_control)
            {
                return Err("name must be a nonempty exact display name of at most 240 characters");
            }
        }
        (None, None, Some(query)) => {
            if query.is_empty()
                || query.trim().is_empty()
                || query.len() > MAX_SELECTOR
                || query.chars().any(char::is_control)
            {
                return Err("query must be nonempty, at most 240 UTF-8 bytes, without controls");
            }
        }
        _ => return Err("provide exactly one of query, app_id or name"),
    }
    Ok(())
}

// Sort before bounding; normalize case for de-duplication, with raw strings
// as a stable tie-break when registry enumeration order differs.
fn bounded_matches(matches: impl IntoIterator<Item = AppMatch>) -> (Vec<AppMatch>, usize, bool) {
    let mut keyed: Vec<_> = matches
        .into_iter()
        .map(|app| (app.app_id.to_lowercase(), app.name.to_lowercase(), app))
        .collect();
    keyed.sort_by(|a, b| {
        (&a.0, &a.1, &a.2.app_id, &a.2.name).cmp(&(&b.0, &b.1, &b.2.app_id, &b.2.name))
    });
    keyed.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
    let total = keyed.len();
    let result = keyed
        .into_iter()
        .take(MAX_MATCHES)
        .map(|(_, _, app)| app)
        .collect();
    (result, total, total > MAX_MATCHES)
}

fn discover(entries: &[AppMatch], query: &str) -> Response {
    let query = query.trim().to_lowercase();
    let (app_matches, app_matches_total, app_matches_truncated) = bounded_matches(
        entries
            .iter()
            .filter(|app| {
                app.app_id.to_lowercase().contains(&query)
                    || app.name.to_lowercase().contains(&query)
            })
            .cloned(),
    );
    Response {
        app_matches: Some(app_matches),
        app_matches_total: Some(app_matches_total),
        app_matches_truncated: Some(app_matches_truncated),
        app_discovery: Some(true),
        launch_status: Some("lookup"),
        launch_attempted: Some(false),
        ..Response::empty()
    }
}

// A separate resolver keeps selection and the stop gate testable without a
// desktop, DBus, X server or an executable launched in the test process.
fn select(entries: &[AppMatch], request: &LaunchAppRequest) -> Result<usize, Response> {
    let matches: Vec<_> = entries
        .iter()
        .enumerate()
        .filter(|(_, app)| {
            request.app_id.as_ref().is_some_and(|id| app.app_id == *id)
                || request.name.as_ref().is_some_and(|name| app.name == *name)
        })
        .collect();
    match matches.as_slice() {
        [] => Err(failure(
            "not_found",
            "installed visible desktop application not found",
        )),
        [(index, _)] => Ok(*index),
        _ => {
            let (app_matches, total, truncated) =
                bounded_matches(matches.iter().map(|(_, app)| (*app).clone()));
            Err(Response {
                app_matches: Some(app_matches),
                app_matches_total: Some(total),
                app_matches_truncated: Some(truncated),
                ..failure("ambiguous", "ambiguous desktop application; use app_id")
            })
        }
    }
}

fn launch_with(
    request: LaunchAppRequest,
    safety: &Safety,
    entries: &[AppMatch],
    dispatch: impl FnOnce(usize) -> Result<(), String>,
) -> Response {
    if let Err(error) = validate(&request) {
        return failure("invalid", error);
    }
    if safety.stopped() {
        return failure("stopped", "input stopped; restart daemon to re-enable");
    }
    if let Some(query) = &request.query {
        return discover(entries, query);
    }
    let index = match select(entries, &request) {
        Ok(index) => index,
        Err(response) => return response,
    };
    // This final atomic load is the request's stop gate, not an atomic GIO
    // launch or a cancellation barrier. If stopped here, do not dispatch. If
    // Stop arrives just AFTER this load (including before the GIO call), this
    // launch is already in flight and may still be accepted. Stop acknowledges
    // disabling subsequent gated launches; it cannot retract an in-flight one.
    if safety.stopped() {
        return failure("stopped", "input stopped; restart daemon to re-enable");
    }
    match dispatch(index) {
        Ok(()) => Response {
            launch_status: Some("accepted"),
            launch_attempted: Some(true),
            launch: Some(LaunchResult {
                app_id: entries[index].app_id.clone(),
                name: entries[index].name.clone(),
                accepted: true,
            }),
            ..Response::empty()
        },
        // A failed GIO return does not prove activation had no side effects.
        Err(error) => Response {
            launch_attempted: Some(true),
            ..failure("dispatch_failed", format!("desktop launch failed: {error}"))
        },
    }
}

/// Only a GIO dispatch attempt may have changed the desktop. Even a failed
/// GIO return cannot rule out startup side effects; lookup never dispatches.
pub fn requires_accessibility_refresh(response: &Response) -> bool {
    response.launch_attempted == Some(true)
}

// GIO owns desktop Exec field-code expansion, DBusActivatable activation,
// startup notification and environment. Only entries enumerated in the
// session's installed GDesktopAppInfo registry can reach g_app_info_launch.
#[link(name = "gio-2.0")]
unsafe extern "C" {
    fn g_app_info_get_all() -> *mut GList;
    fn g_app_info_get_id(app: *mut c_void) -> *const c_char;
    fn g_app_info_get_display_name(app: *mut c_void) -> *const c_char;
    fn g_app_info_should_show(app: *mut c_void) -> c_int;
    fn g_app_info_launch(
        app: *mut c_void,
        files: *const GList,
        context: *mut c_void,
        error: *mut *mut GError,
    ) -> c_int;
    fn g_desktop_app_info_get_type() -> usize;
}
#[link(name = "gobject-2.0")]
unsafe extern "C" {
    fn g_type_check_instance_is_a(instance: *mut c_void, type_id: usize) -> c_int;
    fn g_object_unref(object: *mut c_void);
}
#[link(name = "glib-2.0")]
unsafe extern "C" {
    fn g_list_free(list: *mut GList);
    fn g_error_free(error: *mut GError);
}

#[repr(C)]
struct GList {
    data: *mut c_void,
    next: *mut GList,
    prev: *mut GList,
}
#[repr(C)]
struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}

struct InstalledApps(*mut GList);
impl Drop for InstalledApps {
    fn drop(&mut self) {
        // g_app_info_get_all transfers a full list and a reference to each app.
        unsafe {
            let mut node = self.0;
            while !node.is_null() {
                if !(*node).data.is_null() {
                    g_object_unref((*node).data);
                }
                node = (*node).next;
            }
            g_list_free(self.0);
        }
    }
}

fn metadata(value: *const c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// Synchronous GIO call; run from a blocking worker, never on Tokio's reactor.
/// Caller holds the daemon's action mutex for the full resolution/dispatch.
pub fn launch(request: LaunchAppRequest, safety: Safety) -> Response {
    if let Err(error) = validate(&request) {
        return failure("invalid", error);
    }
    if safety.stopped() {
        return failure("stopped", "input stopped; restart daemon to re-enable");
    }
    let list = InstalledApps(unsafe { g_app_info_get_all() });
    let desktop_type = unsafe { g_desktop_app_info_get_type() };
    let mut entries = Vec::new();
    let mut objects = Vec::new();
    let mut node = list.0;
    while !node.is_null() {
        unsafe {
            let app = (*node).data;
            if !app.is_null()
                && g_type_check_instance_is_a(app, desktop_type) != 0
                && g_app_info_should_show(app) != 0
            {
                if let (Some(app_id), Some(name)) = (
                    metadata(g_app_info_get_id(app)),
                    metadata(g_app_info_get_display_name(app)),
                ) {
                    // Never dispatch a desktop ID we could not accept from IPC.
                    let selector = LaunchAppRequest {
                        app_id: Some(app_id.clone()),
                        name: None,
                        query: None,
                    };
                    if validate(&selector).is_ok() {
                        entries.push(AppMatch { app_id, name });
                        objects.push(app);
                    }
                }
            }
            node = (*node).next;
        }
    }
    launch_with(request, &safety, &entries, |index| unsafe {
        let mut error: *mut GError = ptr::null_mut();
        let accepted = g_app_info_launch(objects[index], ptr::null(), ptr::null_mut(), &mut error);
        let message = if error.is_null() {
            "GIO rejected launch".to_string()
        } else {
            let message =
                metadata((*error).message).unwrap_or_else(|| "GIO rejected launch".into());
            g_error_free(error);
            message
        };
        if accepted != 0 {
            Ok(())
        } else {
            Err(message)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    fn id(id: &str) -> LaunchAppRequest {
        LaunchAppRequest {
            app_id: Some(id.into()),
            name: None,
            query: None,
        }
    }
    fn name(name: &str) -> LaunchAppRequest {
        LaunchAppRequest {
            app_id: None,
            name: Some(name.into()),
            query: None,
        }
    }
    fn query(query: &str) -> LaunchAppRequest {
        LaunchAppRequest {
            query: Some(query.into()),
            name: None,
            app_id: None,
        }
    }
    fn entries() -> Vec<AppMatch> {
        vec![
            AppMatch {
                app_id: "one.desktop".into(),
                name: "Editor".into(),
            },
            AppMatch {
                app_id: "two.desktop".into(),
                name: "Editor".into(),
            },
        ]
    }
    #[test]
    fn selectors_reject_paths_commands_oversize_and_both() {
        for bad in [
            "/tmp/one.desktop",
            "../one.desktop",
            "one.desktop --flag",
            "one",
            "a/b.desktop",
        ] {
            assert!(validate(&id(bad)).is_err(), "{bad}");
        }
        assert!(validate(&id(&format!("{}.desktop", "a".repeat(240)))).is_err());
        assert!(validate(&name("  ")).is_err());
        assert!(validate(&name("a\n")).is_err());
        for bad in ["", " \t ", "a\n", &"é".repeat(121)] {
            assert!(validate(&query(bad)).is_err());
        }
        assert!(validate(&query(&"é".repeat(120))).is_ok());
        let mut mixed = query("Editor");
        mixed.app_id = Some("one.desktop".into());
        assert!(validate(&mixed).is_err());
        mixed.app_id = None;
        mixed.name = Some("Editor".into());
        assert!(validate(&mixed).is_err());
        assert!(validate(&LaunchAppRequest {
            app_id: None,
            name: None,
            query: None
        })
        .is_err());
        assert!(validate(&LaunchAppRequest {
            app_id: Some("one.desktop".into()),
            name: Some("Editor".into()),
            query: None
        })
        .is_err());
    }
    #[test]
    fn exact_id_name_ambiguity_and_ack_never_invoke_real_gio() {
        let safety = Safety::default();
        let registry = entries();
        let invoked = AtomicBool::new(false);
        let response = launch_with(name("Editor"), &safety, &registry, |_| {
            invoked.store(true, Ordering::SeqCst);
            Ok(())
        });
        assert!(!response.ok);
        assert_eq!(response.app_matches.unwrap(), registry);
        assert!(!invoked.load(Ordering::SeqCst));
        assert!(!launch_with(name("editor"), &safety, &registry, |_| panic!("not found")).ok);
        let response = launch_with(id("two.desktop"), &safety, &registry, |index| {
            assert_eq!(index, 1);
            Ok(())
        });
        assert_eq!(response.launch.unwrap().accepted, true);
        let response = launch_with(name("Editor"), &safety, &registry[..1], |index| {
            assert_eq!(index, 0);
            Ok(())
        });
        assert_eq!(response.launch.unwrap().app_id, "one.desktop");
        let failed = launch_with(id("one.desktop"), &safety, &registry, |_| {
            Err("rejected".into())
        });
        assert!(!failed.ok);
        assert_eq!(failed.launch_status, Some("dispatch_failed"));
        assert_eq!(failed.launch_attempted, Some(true));
    }
    #[test]
    fn discovery_is_bounded_deterministic_and_never_dispatches() {
        let safety = Safety::default();
        let mut registry = vec![AppMatch {
            app_id: "stm32cubeide-1.18.desktop".into(),
            name: "Éditeur STM32CubeIDE".into(),
        }];
        for n in (0..25).rev() {
            registry.push(AppMatch {
                app_id: format!("cube-{n:02}.desktop"),
                name: "CubeIDE".into(),
            });
        }
        registry.push(registry[0].clone());
        let lookup = launch_with(query(" STM32CUBEIDE "), &safety, &registry, |_| {
            panic!("query dispatched")
        });
        assert!(lookup.ok);
        assert_eq!(lookup.launch_status, Some("lookup"));
        assert_eq!(lookup.launch_attempted, Some(false));
        assert_eq!(lookup.app_discovery, Some(true));
        assert_eq!(lookup.app_matches_total, Some(1));
        assert_eq!(lookup.app_matches.unwrap(), registry[..1]);
        let lookup = launch_with(query("cube"), &safety, &registry, |_| {
            panic!("query dispatched")
        });
        assert_eq!(lookup.app_matches_total, Some(26));
        assert_eq!(lookup.app_matches_truncated, Some(true));
        let matches = lookup.app_matches.unwrap();
        assert_eq!(matches.len(), MAX_MATCHES);
        assert_eq!(matches[0].app_id, "cube-00.desktop");
        assert_eq!(matches[19].app_id, "cube-19.desktop");
        let empty = launch_with(query("not-installed"), &safety, &registry, |_| {
            panic!("query dispatched")
        });
        assert!(empty.ok);
        assert_eq!(empty.app_matches_total, Some(0));
        assert_eq!(empty.app_matches.unwrap(), Vec::<AppMatch>::new());
        let launched = launch_with(
            id("stm32cubeide-1.18.desktop"),
            &safety,
            &registry[..1],
            |_| Ok(()),
        );
        assert_eq!(launched.launch_status, Some("accepted"));
        assert_eq!(launched.launch_attempted, Some(true));
        let invalid = launch_with(query("\n"), &safety, &registry, |_| {
            panic!("invalid dispatched")
        });
        assert_eq!(invalid.launch_status, Some("invalid"));
        assert_eq!(invalid.launch_attempted, Some(false));
    }
    #[test]
    fn accessibility_refresh_only_after_attempted_dispatch() {
        let safety = Safety::default();
        let registry = entries();
        for request in [
            query("Editor"),
            query("absent"),
            name("absent"),
            name("Editor"),
            query("\n"),
        ] {
            let response = launch_with(request, &safety, &registry, |_| panic!("no dispatch"));
            assert!(
                !requires_accessibility_refresh(&response),
                "{:?}",
                response.launch_status
            );
        }
        let accepted = launch_with(id("one.desktop"), &safety, &registry, |_| Ok(()));
        assert!(requires_accessibility_refresh(&accepted));
        let failed = launch_with(id("one.desktop"), &safety, &registry, |_| {
            Err("uncertain".into())
        });
        assert!(!failed.ok);
        assert!(requires_accessibility_refresh(&failed));
        safety.stop();
        let stopped = launch_with(query("Editor"), &safety, &registry, |_| panic!("stopped"));
        assert_eq!(stopped.launch_status, Some("stopped"));
        assert!(!requires_accessibility_refresh(&stopped));
    }
    #[test]
    fn stop_after_final_gate_does_not_cancel_in_flight_dispatch() {
        let safety = Safety::default();
        let registry = entries();
        // Model Stop landing after the final gate, before GIO would be called.
        // No application is executed by this fake dispatch.
        let response = launch_with(id("one.desktop"), &safety, &registry, |index| {
            assert_eq!(index, 0);
            assert!(safety.stop());
            Ok(())
        });
        assert!(safety.stopped());
        assert!(response.ok);
        let ack = response.launch.expect("in-flight dispatch was accepted");
        assert_eq!(ack.app_id, "one.desktop");
        assert!(ack.accepted); // Acceptance is not window readiness or cancellation.
        let subsequent = launch_with(id("two.desktop"), &safety, &registry, |_| {
            panic!("subsequent dispatch must be blocked")
        });
        assert!(!subsequent.ok);
        assert!(subsequent.error.unwrap().contains("input stopped"));
        assert!(subsequent.launch.is_none());
    }
    #[test]
    fn stop_before_resolution_prevents_dispatch() {
        let safety = Safety::default();
        safety.stop();
        assert!(
            !launch_with(id("one.desktop"), &safety, &entries(), |_| panic!(
                "stopped"
            ))
            .ok
        );
        assert!(safety.stopped());
    }
}
