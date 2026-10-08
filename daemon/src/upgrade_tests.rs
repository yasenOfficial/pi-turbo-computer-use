use super::*;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const TOKEN: &str = "00112233-4455-4677-8899-aabbccddeeff";

fn fixture(token: Option<&str>) -> Arc<Shared> {
    let safety = safety::Safety::default();
    let metrics = Arc::new(metrics::Metrics::default());
    Arc::new(Shared {
        daemon: Arc::new(Mutex::new(Daemon {
            feedback: None,
            accessibility: None,
            cache: Cache::new(),
            last_observed: None,
            input: None,
            capture: None,
            visual_cache: visual::VisualCache::default(),
            screen_dirty: None,
            screen_tile_size: 32,
            seen: state::seen::SeenCache::new(),
            safety: safety.clone(),
            metrics: metrics.clone(),
        })),
        leases: leases::Leases::new(safety.clone(), None),
        safety,
        metrics,
        hide: None,
        runtime: runtime::Runtime::new(token.map(str::to_owned)).unwrap(),
    })
}

async fn request(
    shared: Arc<Shared>,
    payload: serde_json::Value,
    socket: bool,
) -> serde_json::Value {
    let (server, client) = tokio::io::duplex(8192);
    let task = tokio::spawn(async move {
        let (read, write) = tokio::io::split(server);
        serve_connection_transport(read, write, &shared, socket)
            .await
            .unwrap();
    });
    let (read, mut write) = tokio::io::split(client);
    write
        .write_all(format!("{payload}\n").as_bytes())
        .await
        .unwrap();
    let line = BufReader::new(read)
        .lines()
        .next_line()
        .await
        .unwrap()
        .unwrap();
    drop(write);
    task.await.unwrap();
    serde_json::from_str(&line).unwrap()
}
fn shutdown(shared: &Shared, token: &str) -> serde_json::Value {
    serde_json::json!({"cmd":"shutdown_if_idle","instance_id":shared.runtime.instance_id,"token":token})
}

#[tokio::test]
async fn metadata_never_waits_for_action_or_touches_desktop() {
    let shared = fixture(Some(TOKEN));
    let guard = shared.daemon.lock().await;
    let info = tokio::time::timeout(
        Duration::from_millis(250),
        request(
            shared.clone(),
            serde_json::json!({"cmd":"daemon_info"}),
            true,
        ),
    )
    .await
    .unwrap();
    assert_eq!(info["ok"], true);
    let data = &info["daemon_info"];
    assert_eq!(data["protocol_version"], 1);
    assert_eq!(data["build_id"], runtime::BUILD_ID);
    assert_eq!(data["pid"], std::process::id());
    assert_eq!(data["instance_id"], shared.runtime.instance_id);
    assert_eq!(data["instance_id"].as_str().unwrap().len(), 32);
    assert_eq!(data["managed"], true);
    assert_eq!(data["busy"], true);
    assert_eq!(data["active_workflows"], 0);
    assert_eq!(data["input_stopped"], false);
    assert_eq!(
        data["capabilities"],
        serde_json::json!(runtime::CAPABILITIES)
    );
    assert!(!info.to_string().contains(TOKEN));
    assert_eq!(
        request(shared.clone(), shutdown(&shared, TOKEN), true).await["ok"],
        false
    );
    drop(guard);
    assert!(!shared.runtime.closing());
}

#[tokio::test]
async fn authenticated_idle_shutdown_rejects_unsafe_states_without_stopping() {
    let shared = fixture(Some(TOKEN));
    assert_eq!(
        request(shared.clone(), shutdown(&shared, "wrong"), true).await["ok"],
        false
    );
    let mut wrong = shutdown(&shared, TOKEN);
    wrong["instance_id"] = "00000000000000000000000000000000".into();
    assert_eq!(request(shared.clone(), wrong, true).await["ok"], false);
    assert_eq!(
        request(shared.clone(), shutdown(&shared, TOKEN), false).await["ok"],
        false
    );
    let lease = "11223344-5566-7788-99aa-bbccddeeff00";
    assert_eq!(
        request(
            shared.clone(),
            serde_json::json!({"cmd":"control_activity","action":"begin","token":lease}),
            true
        )
        .await["ok"],
        true
    );
    let info = request(
        shared.clone(),
        serde_json::json!({"cmd":"daemon_info"}),
        true,
    )
    .await;
    assert_eq!(info["daemon_info"]["active_workflows"], 1);
    assert_eq!(
        request(shared.clone(), shutdown(&shared, TOKEN), true).await["ok"],
        false
    );
    assert!(!shared.safety.stopped());
    assert_eq!(
        request(
            shared.clone(),
            serde_json::json!({"cmd":"control_activity","action":"end","token":lease}),
            true
        )
        .await["ok"],
        true
    );
    assert_eq!(
        request(shared.clone(), shutdown(&shared, TOKEN), true).await,
        serde_json::json!({"ok":true})
    );
    assert!(shared.runtime.closing());
    assert!(shared.safety.stopped());
    // The listener receives a persistent notification only after the reply
    // was flushed; no polling or forced process termination is required.
    tokio::time::timeout(
        Duration::from_millis(250),
        shared.runtime.shutdown.notified(),
    )
    .await
    .unwrap();
    // A new lease cannot slip in after the idle check or re-enable input.
    assert_eq!(
        request(
            shared.clone(),
            serde_json::json!({"cmd":"control_activity","action":"begin","token":lease}),
            true
        )
        .await["ok"],
        false
    );
}

#[tokio::test]
async fn unmanaged_stdio_and_emergency_stop_are_never_upgradeable() {
    let unmanaged = fixture(None);
    assert_eq!(
        request(unmanaged.clone(), shutdown(&unmanaged, TOKEN), true).await["ok"],
        false
    );
    assert_eq!(
        request(
            unmanaged.clone(),
            serde_json::json!({"cmd":"daemon_info"}),
            false
        )
        .await["daemon_info"]["managed"],
        false
    );
    let shared = fixture(Some(TOKEN));
    assert_eq!(
        request(shared.clone(), serde_json::json!({"cmd":"stop"}), true).await["ok"],
        true
    );
    assert_eq!(
        request(shared.clone(), shutdown(&shared, TOKEN), true).await["ok"],
        false
    );
    assert!(!shared.runtime.closing());
    assert_eq!(
        request(
            shared.clone(),
            serde_json::json!({"cmd":"daemon_info"}),
            true
        )
        .await["daemon_info"]["input_stopped"],
        true
    );
}

#[test]
fn strict_contract_and_fresh_random_instance() {
    let a = fixture(Some(TOKEN));
    let b = fixture(Some(TOKEN));
    assert_ne!(a.runtime.instance_id, b.runtime.instance_id);
    assert_eq!(runtime::BUILD_ID.len(), 16);
    assert!(runtime::BUILD_ID.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(serde_json::from_value::<Request>(
        serde_json::json!({"cmd":"shutdown_if_idle","instance_id":"x","token":"y","extra":true})
    )
    .is_err());
    assert!(serde_json::from_value::<Request>(
        serde_json::json!({"cmd":"shutdown_if_idle","instance_id":"x"})
    )
    .is_err());
    assert!(!fixture(Some("invalid")).runtime.managed());
    assert_eq!(
        serde_json::to_value(runtime::build_info()).unwrap(),
        serde_json::json!({"probe_marker":"pi-computer-build-info-v1","protocol_version":1,"build_id":runtime::BUILD_ID,"capabilities":runtime::CAPABILITIES})
    );
}
