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
const MAX_AMBIGUOUS_MATCHES: usize = 20;

fn validate(request: &LaunchAppRequest) -> Result<(), &'static str> {
    match (&request.app_id, &request.name) {
        (Some(id), None) => {
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
        (None, Some(name)) => {
            if name.is_empty()
                || name.trim().is_empty()
                || name.chars().count() > MAX_SELECTOR
                || name.chars().any(char::is_control)
            {
                return Err("name must be a nonempty exact display name of at most 240 characters");
            }
        }
        _ => return Err("provide exactly one of app_id or name"),
    }
    Ok(())
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
        [] => Err(Response::error(
            "installed visible desktop application not found",
        )),
        [(index, _)] => Ok(*index),
        _ => Err(Response {
            ok: false,
            error: Some("ambiguous desktop application; use app_id".into()),
            app_matches: Some(
                matches
                    .iter()
                    .take(MAX_AMBIGUOUS_MATCHES)
                    .map(|(_, app)| (*app).clone())
                    .collect(),
            ),
            ..Response::empty()
        }),
    }
}

fn launch_with(
    request: LaunchAppRequest,
    safety: &Safety,
    entries: &[AppMatch],
    dispatch: impl FnOnce(usize) -> Result<(), String>,
) -> Response {
    if let Err(error) = validate(&request) {
        return Response::error(error);
    }
    if safety.stopped() {
        return Response::error("input stopped; restart daemon to re-enable");
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
        return Response::error("input stopped; restart daemon to re-enable");
    }
    match dispatch(index) {
        Ok(()) => Response {
            launch: Some(LaunchResult {
                app_id: entries[index].app_id.clone(),
                name: entries[index].name.clone(),
                accepted: true,
            }),
            ..Response::empty()
        },
        Err(error) => Response::error(format!("desktop launch failed: {error}")),
    }
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
        return Response::error(error);
    }
    if safety.stopped() {
        return Response::error("input stopped; restart daemon to re-enable");
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
        }
    }
    fn name(name: &str) -> LaunchAppRequest {
        LaunchAppRequest {
            app_id: None,
            name: Some(name.into()),
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
        assert!(validate(&LaunchAppRequest {
            app_id: None,
            name: None
        })
        .is_err());
        assert!(validate(&LaunchAppRequest {
            app_id: Some("one.desktop".into()),
            name: Some("Editor".into())
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
        assert!(
            !launch_with(id("one.desktop"), &safety, &registry, |_| Err(
                "rejected".into()
            ))
            .ok
        );
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
