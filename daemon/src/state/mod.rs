pub mod seen;

use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub parent: Option<String>,
    pub children: Vec<String>,
    pub name: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// A read attempt failed; absence must not be interpreted as a verified empty value.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub value_read_failed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub generation: u64,
    pub root: Option<String>,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Delta {
    pub from: u64,
    pub generation: u64,
    pub changed: Vec<Node>,
    pub removed: Vec<String>,
}

pub struct Cache {
    snapshot: Snapshot,
    previous: Option<Snapshot>,
}

impl Cache {
    pub fn new() -> Self {
        Self {
            snapshot: Snapshot {
                generation: 0,
                root: None,
                nodes: vec![],
            },
            previous: None,
        }
    }
    pub fn current(&self) -> &Snapshot {
        &self.snapshot
    }

    /// A refresh with identical content must not advance the generation.
    pub fn update(&mut self, root: Option<String>, nodes: Vec<Node>) {
        if self.snapshot.generation != 0
            && self.snapshot.root == root
            && self.snapshot.nodes == nodes
        {
            return;
        }
        self.previous = Some(self.snapshot.clone());
        self.snapshot = Snapshot {
            generation: self.snapshot.generation + 1,
            root,
            nodes,
        };
    }

    /// A delta is valid only for a retained generation. Older clients get a full snapshot.
    pub fn observe(&self, since: Option<u64>) -> (Option<Snapshot>, Option<Delta>) {
        let now = &self.snapshot;
        if let Some(from) = since {
            if from == now.generation {
                return (
                    None,
                    Some(Delta {
                        from,
                        generation: from,
                        changed: vec![],
                        removed: vec![],
                    }),
                );
            }
            if let Some(previous) = &self.previous {
                if previous.generation == from {
                    let old: HashMap<_, _> = previous.nodes.iter().map(|n| (&n.id, n)).collect();
                    let current: HashMap<_, _> = now.nodes.iter().map(|n| (&n.id, n)).collect();
                    let changed = now
                        .nodes
                        .iter()
                        .filter(|n| old.get(&n.id) != Some(&n))
                        .cloned()
                        .collect();
                    let removed = previous
                        .nodes
                        .iter()
                        .filter(|n| !current.contains_key(&n.id))
                        .map(|n| n.id.clone())
                        .collect();
                    return (
                        None,
                        Some(Delta {
                            from,
                            generation: now.generation,
                            changed,
                            removed,
                        }),
                    );
                }
            }
        }
        (Some(now.clone()), None)
    }
}

/// IDs are compact, monotonic within a daemon lifetime, and never recycled.
/// Keep the mapping across scans so unchanged AT-SPI objects retain their IDs.
#[derive(Default)]
pub struct NodeIds {
    next: u64,
    by_reference: HashMap<(String, String), String>,
}

impl NodeIds {
    pub fn id(&mut self, bus: &str, path: &str) -> String {
        self.by_reference
            .entry((bus.to_owned(), path.to_owned()))
            .or_insert_with(|| {
                self.next += 1;
                format!("n{}", self.next)
            })
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(name: &str) -> Node {
        Node {
            id: "a".into(),
            parent: None,
            children: vec![],
            name: name.into(),
            role: "button".into(),
            bounds: None,
            value: None,
            value_read_failed: false,
            enabled: None,
            visible: None,
            focused: None,
            actions: None,
        }
    }
    #[test]
    fn stable_ids() {
        let mut ids = NodeIds::default();
        assert_eq!(ids.id(":1.2", "/a"), "n1");
        assert_eq!(ids.id(":1.2", "/b"), "n2");
        assert_eq!(ids.id(":1.2", "/a"), "n1");
        assert_eq!(ids.id(":1.3", "/a"), "n3");
    }
    #[test]
    fn semantic_fields_serialize_only_when_available() {
        let empty = serde_json::to_value(node("field")).unwrap();
        for key in ["value", "enabled", "visible", "focused", "actions"] {
            assert!(empty.get(key).is_none(), "{key} should be omitted");
        }
        let mut field = node("field");
        field.value = Some(String::new());
        field.enabled = Some(false);
        field.actions = Some(vec![]);
        let encoded = serde_json::to_value(field).unwrap();
        assert_eq!(encoded["value"], "");
        assert_eq!(encoded["enabled"], false);
        assert_eq!(encoded["actions"], serde_json::json!([]));
    }
    #[test]
    fn semantic_changes_advance_generation() {
        let mut cache = Cache::new();
        cache.update(None, vec![node("field")]);
        let generation = cache.current().generation;
        let mut changed = node("field");
        changed.value = Some("typed".into());
        changed.focused = Some(true);
        cache.update(None, vec![changed]);
        let delta = cache.observe(Some(generation)).1.unwrap();
        assert_eq!(delta.changed[0].value.as_deref(), Some("typed"));
        assert_eq!(delta.changed[0].focused, Some(true));
    }
    #[test]
    fn targeted_changes_only_emit_changed_node_without_structural_delta() {
        let mut cache = Cache::new();
        let mut entry = node("Search");
        entry.value = Some(String::new());
        entry.role = "entry".into();
        let mut other = node("Submit");
        other.id = "b".into();
        cache.update(Some("a".into()), vec![entry.clone(), other.clone()]);
        let before = cache.current().generation;
        entry.value = Some("new value".into());
        entry.focused = Some(true);
        entry.name = "Search query".into();
        cache.update(Some("a".into()), vec![entry.clone(), other]);
        let delta = cache.observe(Some(before)).1.unwrap();
        assert_eq!(delta.from, before);
        assert_eq!(delta.generation, before + 1);
        assert_eq!(delta.changed, vec![entry]);
        assert!(delta.removed.is_empty());
    }

    #[test]
    fn changes_and_eviction() {
        let mut cache = Cache::new();
        cache.update(Some("a".into()), vec![node("first")]);
        let generation = cache.current().generation;
        cache.update(Some("a".into()), vec![node("first")]);
        assert_eq!(generation, cache.current().generation);
        cache.update(Some("a".into()), vec![node("second")]);
        let (full, delta) = cache.observe(Some(generation));
        assert!(full.is_none());
        assert_eq!(delta.unwrap().changed[0].name, "second");
        cache.update(None, vec![]);
        assert_eq!(
            cache.observe(Some(generation + 1)).1.unwrap().removed,
            vec!["a"]
        );
        assert!(cache.observe(Some(generation)).0.is_some());
    }
}
