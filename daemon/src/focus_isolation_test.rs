//! Focus tests are intentionally isolated from the user's desktop. Only the
//! dedicated shell harness may run the ignored live test (on its own Xephyr).
use super::*;
use x11rb::protocol::xproto::{CreateWindowAux, PropMode, WindowClass};
use x11rb::wrapper::ConnectionExt as _;

#[test]
fn focus_wire_is_only_pager_active_window_request() {
    let root = 0x101;
    let target = 0x202;
    let atom = 0x303;
    let (destination, mask, event) = focus_request(root, target, atom);
    assert_eq!(destination, root);
    assert_eq!(
        mask,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY
    );
    assert_eq!(event.response_type, 33); // ClientMessage, never DestroyNotify
    assert_eq!(event.format, 32);
    assert_eq!(event.window, target);
    assert_eq!(event.type_, atom); // _NET_ACTIVE_WINDOW, not WM_PROTOCOLS/WM_DELETE_WINDOW
    assert_eq!(event.data.as_data32(), [2, 0, 0, 0, 0]);
}

#[test]
fn focus_wait_is_bounded_on_wm_refusal_and_never_reissues_request() {
    let start = Instant::now();
    let mut observations = 0;
    let err = await_focus(None, 42, || {
        observations += 1;
        Ok(Some(7))
    })
    .unwrap_err();
    assert_eq!(
        err.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::TimedOut
    );
    assert!(start.elapsed() >= FOCUS_WAIT);
    assert!(start.elapsed() < Duration::from_millis(1500));
    assert!(observations > 1);
}

#[test]
fn stop_prevents_observation_and_interrupts_poll_promptly() {
    let safety = Safety::default();
    safety.stop();
    assert_eq!(
        await_focus(Some(&safety), 42, || panic!("observed after stop"))
            .unwrap_err()
            .downcast_ref::<io::Error>()
            .unwrap()
            .kind(),
        io::ErrorKind::Interrupted
    );
    let safety = Safety::default();
    let start = Instant::now();
    let err = await_focus(Some(&safety), 42, || {
        safety.stop();
        Ok(Some(42))
    })
    .unwrap_err();
    assert_eq!(
        err.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::Interrupted
    );
    assert!(start.elapsed() < Duration::from_millis(200));
}

#[test]
fn vanished_target_error_is_not_silently_treated_as_focus() {
    let err = await_focus(None, 42, || -> InputResult<Option<Window>> {
        Err(io::Error::new(io::ErrorKind::NotFound, "target vanished").into())
    })
    .unwrap_err();
    assert_eq!(
        err.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
#[ignore = "ONLY tests/test-focus-isolation.sh: isolated Xephyr with its own WM"]
fn isolated_wm_focus_preserves_owned_window_ids() {
    assert_eq!(
        std::env::var("PI_FOCUS_ISOLATED_DISPLAY").unwrap(),
        std::env::var("DISPLAY").unwrap()
    );
    let (conn, screen) = x11rb::connect(None).unwrap();
    let root = conn.setup().roots[screen].root;
    let utf8 = conn
        .intern_atom(false, b"UTF8_STRING")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let name = conn
        .intern_atom(false, b"_NET_WM_NAME")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let clients = conn
        .intern_atom(false, b"_NET_CLIENT_LIST")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let active = conn
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let prefix = format!("pi-focus-isolated-{}", std::process::id());
    let titles = [format!("{prefix}-target"), format!("{prefix}-other")];
    let ids: Vec<_> = titles
        .iter()
        .enumerate()
        .map(|(index, title)| {
            let id = conn.generate_id().unwrap();
            conn.create_window(
                0,
                id,
                root,
                25 + index as i16 * 220,
                25,
                180,
                120,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new(),
            )
            .unwrap()
            .check()
            .unwrap();
            conn.change_property8(PropMode::REPLACE, id, name, utf8, title.as_bytes())
                .unwrap()
                .check()
                .unwrap();
            conn.change_property8(
                PropMode::REPLACE,
                id,
                AtomEnum::WM_NAME,
                AtomEnum::STRING,
                title.as_bytes(),
            )
            .unwrap()
            .check()
            .unwrap();
            conn.map_window(id).unwrap().check().unwrap();
            id
        })
        .collect();
    conn.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let property = conn
            .get_property(false, root, clients, AtomEnum::WINDOW, 0, 4096)
            .unwrap()
            .reply()
            .unwrap();
        let listed: Vec<_> = property
            .value32()
            .map(Iterator::collect)
            .unwrap_or_default();
        if ids.iter().all(|id| listed.contains(id)) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "nested WM never listed both test windows"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let input = X11Input::new().unwrap();
    for title in [&titles[1], &titles[0], &titles[0]] {
        input.focus_window(title).unwrap();
        let property = conn
            .get_property(false, root, active, AtomEnum::WINDOW, 0, 1)
            .unwrap()
            .reply()
            .unwrap();
        let focused = property.value32().unwrap().next();
        assert_eq!(
            focused,
            Some(if title == &titles[0] { ids[0] } else { ids[1] })
        );
        for id in &ids {
            conn.get_window_attributes(*id).unwrap().reply().unwrap();
        }
        let listed: Vec<_> = conn
            .get_property(false, root, clients, AtomEnum::WINDOW, 0, 4096)
            .unwrap()
            .reply()
            .unwrap()
            .value32()
            .unwrap()
            .collect();
        assert!(
            ids.iter().all(|id| listed.contains(id)),
            "focus destroyed/unlisted a test window"
        );
    }
    assert!(
        input.focus_window(&prefix).is_err(),
        "ambiguous title must be rejected"
    );
    let safety = Safety::default();
    safety.stop();
    let guarded = X11Input::new_with_safety(safety).unwrap();
    let before = Instant::now();
    let err = guarded.focus_window(&titles[1]).unwrap_err();
    assert_eq!(
        err.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::Interrupted
    );
    assert!(before.elapsed() < Duration::from_millis(200));
    let property = conn
        .get_property(false, root, active, AtomEnum::WINDOW, 0, 1)
        .unwrap()
        .reply()
        .unwrap();
    assert_eq!(property.value32().unwrap().next(), Some(ids[0]));
    conn.destroy_window(ids[0]).unwrap().check().unwrap();
    conn.flush().unwrap();
    let err = observe_focus(&conn, root, ids[0], active).unwrap_err();
    assert_eq!(
        err.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::NotFound
    );
    assert!(
        input.focus_window(&titles[0]).is_err(),
        "destroyed target must not report success"
    );
    conn.get_window_attributes(ids[1]).unwrap().reply().unwrap();
}
