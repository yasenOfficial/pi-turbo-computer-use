//! Ephemeral, metadata-only search hints. Results are NOT action targets: an ID
//! must be resolved against a freshly observed AT-SPI tree before any input.
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::{Bounds, Node, Snapshot};

const MAX_ENTRIES: usize = 2_000;
const TTL_MS: u64 = 30 * 60 * 1_000;
const MAX_RESULTS: usize = 50;
const DEFAULT_RESULTS: usize = 10;
const MAX_FIELD_CHARS: usize = 240;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SeenSource {
    Current,
    Stale,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SeenHit {
    pub id: String,
    pub name: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    pub last_seen_ms: u64,
    pub generation: u64,
    pub source: SeenSource,
}

#[derive(Debug, Serialize)]
pub struct SeenSearch {
    pub generation: u64,
    pub results: Vec<SeenHit>,
}

// Lowercase copies are built on observation, not once per candidate per query.
struct CachedHit {
    hit: SeenHit,
    name_key: String,
    role_key: String,
    window_key: String,
}

impl CachedHit {
    fn new(hit: SeenHit) -> Self {
        let name_key = hit.name.to_lowercase();
        let role_key = hit.role.to_lowercase();
        let window_key = hit.window.as_deref().unwrap_or("").to_lowercase();
        Self {
            hit,
            name_key,
            role_key,
            window_key,
        }
    }
}

/// In-memory, daemon-lifetime history. No Node or snapshot is retained: in
/// particular, `Node.value`, children, actions and screenshot bytes are never
/// copied into this cache. Editable node names are suppressed too, as some
/// applications mirror typed/private contents into their accessible name.
#[derive(Default)]
pub struct SeenCache {
    entries: HashMap<String, CachedHit>,
    generation: u64,
    // None means no trusted comparison key (e.g. the last title echoed an
    // editable value). The inner None means no X11 fallback title was present.
    // Only public, already-truncated title metadata can live here.
    last_public_title: Option<Option<String>>,
}

fn metadata(text: &str) -> String {
    text.chars().take(MAX_FIELD_CHARS).collect()
}

fn editable(role: &str) -> bool {
    matches!(
        role.to_ascii_lowercase().as_str(),
        "entry"
            | "password text"
            | "text"
            | "combo box"
            | "spin button"
            | "text field"
            | "search field"
            | "editable text"
    )
}

// Byte trie with failure links: checks all private strings against titles and
// retained names in total linear time, without pairwise node/value comparisons.
#[derive(Default)]
struct MatcherNode {
    edges: HashMap<u8, usize>,
    fail: usize,
    terminal: bool,
}

struct PrivateMatcher {
    nodes: Vec<MatcherNode>,
}

impl PrivateMatcher {
    fn new(snapshot: &Snapshot) -> Self {
        let mut nodes = vec![MatcherNode::default()];
        for node in &snapshot.nodes {
            if !editable(&node.role) {
                continue;
            }
            for text in [Some(node.name.as_str()), node.value.as_deref()]
                .into_iter()
                .flatten()
            {
                // Only the first MAX_FIELD_CHARS can appear in indexed metadata.
                let pattern = metadata(text);
                if pattern.is_empty() {
                    continue;
                }
                let mut state = 0;
                for byte in pattern.bytes() {
                    let next = if let Some(&next) = nodes[state].edges.get(&byte) {
                        next
                    } else {
                        let next = nodes.len();
                        nodes.push(MatcherNode::default());
                        nodes[state].edges.insert(byte, next);
                        next
                    };
                    state = next;
                }
                nodes[state].terminal = true;
            }
        }
        let mut queue = VecDeque::new();
        for &child in nodes[0].edges.values() {
            queue.push_back(child);
        }
        while let Some(parent) = queue.pop_front() {
            let edges: Vec<_> = nodes[parent].edges.iter().map(|(&b, &i)| (b, i)).collect();
            for (byte, child) in edges {
                let mut fail = nodes[parent].fail;
                while fail != 0 && !nodes[fail].edges.contains_key(&byte) {
                    fail = nodes[fail].fail;
                }
                nodes[child].fail = nodes[fail].edges.get(&byte).copied().unwrap_or(0);
                nodes[child].terminal |= nodes[nodes[child].fail].terminal;
                queue.push_back(child);
            }
        }
        Self { nodes }
    }

    fn contains(&self, text: &str) -> bool {
        if self.nodes.len() == 1 {
            return false;
        }
        let mut state = 0;
        for byte in text.bytes() {
            while state != 0 && !self.nodes[state].edges.contains_key(&byte) {
                state = self.nodes[state].fail;
            }
            state = self.nodes[state].edges.get(&byte).copied().unwrap_or(0);
            if self.nodes[state].terminal {
                return true;
            }
        }
        false
    }
}

// Cache ancestor walks for a whole observation. The cap protects against
// malformed cyclic parent references (and does not recurse on deep trees).
fn window_for<'a>(
    node: &Node,
    by_id: &HashMap<&str, &'a Node>,
    windows: &mut HashMap<&'a str, Option<&'a str>>,
) -> Option<&'a str> {
    let mut parent = node.parent.as_deref();
    let mut path = Vec::new();
    let mut found = None;
    for _ in 0..by_id.len() {
        let Some(ancestor) = parent.and_then(|id| by_id.get(id)).copied() else {
            break;
        };
        if matches!(ancestor.role.as_str(), "frame" | "window" | "dialog")
            && !ancestor.name.is_empty()
        {
            found = Some(ancestor.name.as_str());
            break;
        }
        if let Some(&cached) = windows.get(ancestor.id.as_str()) {
            found = cached;
            break;
        }
        path.push(ancestor.id.as_str());
        parent = ancestor.parent.as_deref();
    }
    for id in path {
        windows.insert(id, found);
    }
    found
}

impl SeenCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Call after each successful observation/refresh, including an unchanged
    /// generation; `window_title` is the active X11 title fallback for nodes
    /// without an accessible frame ancestor. Do not pass images or field values.
    pub fn observe(&mut self, snapshot: &Snapshot, window_title: Option<&str>) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        self.observe_at(snapshot, window_title, now_ms);
    }

    fn observe_at(&mut self, snapshot: &Snapshot, window_title: Option<&str>, now_ms: u64) {
        if snapshot.generation < self.generation {
            return;
        }
        let title_key = window_title.map(metadata);
        // A stable generation guarantees the nodes, roles, names and editable
        // values have not changed. The effective X11 fallback title is the
        // only independent input. Never keep an unvalidated/private title as
        // a shortcut key. Refresh timestamps before TTL pruning so unchanged
        // current entries are not accidentally discarded after a long pause.
        if snapshot.generation == self.generation
            && self.last_public_title.as_ref() == Some(&title_key)
        {
            for entry in self.entries.values_mut() {
                if entry.hit.source == SeenSource::Current {
                    entry.hit.last_seen_ms = now_ms;
                }
            }
            self.prune(now_ms);
            return;
        }
        self.generation = snapshot.generation;
        self.prune(now_ms);
        let by_id: HashMap<&str, &Node> =
            snapshot.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let current: HashSet<&str> = snapshot.nodes.iter().map(|n| n.id.as_str()).collect();
        let private = PrivateMatcher::new(snapshot);
        // Only keep a comparison key when the title is safe to retain. If it
        // echoed an editable field, rebuild on the next observation instead.
        self.last_public_title = if title_key.as_deref().is_some_and(|s| private.contains(s)) {
            None
        } else {
            Some(title_key)
        };
        let mut windows = HashMap::new();
        for node in &snapshot.nodes {
            if node.id.is_empty() {
                continue;
            }
            let title = window_for(node, &by_id, &mut windows)
                .or(window_title)
                .map(metadata)
                .filter(|s| !s.is_empty() && !private.contains(s));
            let name = if editable(&node.role) {
                String::new()
            } else {
                metadata(&node.name)
            };
            let hit = SeenHit {
                id: node.id.clone(),
                name: if private.contains(&name) {
                    String::new()
                } else {
                    name
                },
                role: metadata(&node.role),
                bounds: node.bounds.clone(),
                window: title,
                last_seen_ms: now_ms,
                generation: snapshot.generation,
                source: SeenSource::Current,
            };
            self.entries.insert(hit.id.clone(), CachedHit::new(hit));
        }
        for (id, entry) in &mut self.entries {
            let hit = &mut entry.hit;
            if !current.contains(id.as_str()) {
                hit.source = SeenSource::Stale;
            }
            // A later scan may reveal that previously public-looking metadata
            // echoed an editable value: scrub historical hints too.
            if hit.window.as_deref().is_some_and(|s| private.contains(s)) {
                hit.window = None;
                entry.window_key.clear();
            }
            if private.contains(&hit.name) {
                hit.name.clear();
                entry.name_key.clear();
            }
        }
        if self.entries.len() > MAX_ENTRIES {
            let mut oldest: Vec<_> = self
                .entries
                .values()
                .map(|entry| (entry.hit.last_seen_ms, entry.hit.id.as_str()))
                .collect();
            oldest.sort_unstable();
            let remove: Vec<_> = oldest
                .into_iter()
                .take(self.entries.len() - MAX_ENTRIES)
                .map(|(_, id)| id.to_owned())
                .collect();
            for id in remove {
                self.entries.remove(&id);
            }
        }
    }

    fn prune(&mut self, now_ms: u64) {
        let mut removed_current = false;
        self.entries.retain(|_, entry| {
            let keep = now_ms.saturating_sub(entry.hit.last_seen_ms) < TTL_MS;
            removed_current |= !keep && entry.hit.source == SeenSource::Current;
            keep
        });
        // Search can expire current entries independently of observation. A
        // subsequent same-generation observation must repopulate those nodes.
        if removed_current {
            self.last_public_title = None;
        }
    }

    /// Ranked case-insensitive match over public metadata only. No empty query
    /// enumeration; results are capped even when the client omits limit.
    pub fn search(&mut self, query: &str, limit: Option<usize>) -> SeenSearch {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        self.search_at(query, limit, now_ms)
    }

    fn search_at(&mut self, query: &str, limit: Option<usize>, now_ms: u64) -> SeenSearch {
        self.prune(now_ms);
        let query = query.trim().to_lowercase();
        let count = limit.unwrap_or(DEFAULT_RESULTS).min(MAX_RESULTS);
        let mut ranked: Vec<_> = if query.is_empty() || count == 0 {
            Vec::new()
        } else {
            self.entries
                .values()
                .filter_map(|entry| {
                    let score = match entry.name_key.as_str() {
                        name if !name.is_empty() && name == query => 5,
                        name if !name.is_empty() && name.starts_with(&query) => 4,
                        name if name.match_indices(&query).any(|(index, _)| {
                            index > 0
                                && !name[..index]
                                    .chars()
                                    .next_back()
                                    .is_some_and(char::is_alphanumeric)
                        }) =>
                        {
                            3
                        }
                        name if name.contains(&query) => 2,
                        _ if entry.role_key.contains(&query) => 1,
                        _ if entry.window_key.contains(&query) => 0,
                        _ => return None,
                    };
                    Some((score, entry))
                })
                .collect()
        };
        ranked.sort_unstable_by(|(score_a, a), (score_b, b)| {
            score_b
                .cmp(score_a)
                .then_with(|| {
                    (b.hit.source == SeenSource::Current)
                        .cmp(&(a.hit.source == SeenSource::Current))
                })
                .then_with(|| b.hit.last_seen_ms.cmp(&a.hit.last_seen_ms))
                .then_with(|| a.hit.id.cmp(&b.hit.id))
        });
        SeenSearch {
            generation: self.generation,
            results: ranked
                .into_iter()
                .take(count)
                .map(|(_, entry)| entry.hit.clone())
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, name: &str, role: &str) -> Node {
        Node {
            id: id.into(),
            parent: None,
            children: vec![],
            name: name.into(),
            role: role.into(),
            bounds: None,
            value: None,
            value_read_failed: false,
            enabled: None,
            visible: None,
            focused: None,
            actions: None,
        }
    }
    fn snapshot(generation: u64, nodes: Vec<Node>) -> Snapshot {
        Snapshot {
            generation,
            root: None,
            nodes,
        }
    }

    #[test]
    fn search_bounds_and_window_context() {
        let mut seen = SeenCache::new();
        let mut frame = node("f", "Project window", "frame");
        frame.bounds = Some(Bounds {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        });
        let mut button = node("b", "Save", "push button");
        button.parent = Some("f".into());
        button.bounds = Some(Bounds {
            x: 11,
            y: 12,
            width: 40,
            height: 20,
        });
        seen.observe_at(&snapshot(1, vec![frame, button]), Some("fallback"), 100);
        let hits = seen.search_at("PROJECT", Some(2), 101).results;
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "f"); // Exact name outranks window context.
        assert_eq!(hits[1].id, "b");
        assert_eq!(hits[1].window.as_deref(), Some("Project window"));
        assert_eq!(hits[1].bounds.as_ref().unwrap().x, 11);
        assert!(seen.search_at("missing", None, 101).results.is_empty());
        assert!(seen.search_at(" ", None, 101).results.is_empty());
    }

    #[test]
    fn relevance_before_current_then_recency() {
        let mut seen = SeenCache::new();
        let mut old = node("exact-stale", "Save", "button");
        old.parent = Some("frame".into());
        seen.observe_at(&snapshot(1, vec![old]), None, 10);
        seen.observe_at(
            &snapshot(
                2,
                vec![
                    node("prefix", "Save As", "button"),
                    node("token", "File Save", "button"),
                    node("substring", "Autosave", "button"),
                    node("role", "Other", "save button"),
                    node("window", "Other", "button"),
                ],
            ),
            Some("Save Window"),
            20,
        );
        let ids: Vec<_> = seen
            .search_at("SAVE", None, 21)
            .results
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(
            ids,
            [
                "exact-stale",
                "prefix",
                "token",
                "substring",
                "role",
                "window"
            ]
        );
        seen.observe_at(
            &snapshot(
                3,
                vec![
                    node("exact-current", "Save", "button"),
                    node("prefix", "Save As", "button"),
                ],
            ),
            None,
            30,
        );
        let ids: Vec<_> = seen
            .search_at("save", None, 31)
            .results
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(&ids[..2], ["exact-current", "exact-stale"]);
    }

    #[test]
    fn revision_current_stale_and_refresh() {
        let mut seen = SeenCache::new();
        seen.observe_at(&snapshot(2, vec![node("a", "Save", "button")]), None, 10);
        seen.observe_at(&snapshot(3, vec![node("b", "Save", "button")]), None, 20);
        let result = seen.search_at("save", None, 21);
        assert_eq!(result.generation, 3);
        assert_eq!(result.results[0].source, SeenSource::Current);
        assert_eq!(result.results[1].source, SeenSource::Stale);
        seen.observe_at(&snapshot(2, vec![node("a", "wrong", "button")]), None, 22);
        assert_eq!(seen.search_at("wrong", None, 23).results.len(), 0);
        seen.observe_at(&snapshot(4, vec![node("a", "Save", "button")]), None, 30);
        assert_eq!(seen.search_at("save", None, 31).results[0].id, "a");
    }

    #[test]
    fn eviction_ttl_limit_and_private_values() {
        let mut seen = SeenCache::new();
        let mut secret = node("secret", "typed-password", "password text");
        secret.value = Some("private-value".into());
        seen.observe_at(
            &snapshot(1, vec![secret, node("other", "Save", "button")]),
            Some("private-value — Editor"),
            1,
        );
        let encoded = serde_json::to_string(&seen.search_at("button", None, 2)).unwrap();
        assert!(!encoded.contains("private-value"));
        assert!(seen.search_at("editor", None, 2).results.is_empty());
        assert!(!encoded.contains("typed-password") && !encoded.contains("private-value"));
        let mut entered = node("field", "private-value", "entry");
        entered.value = Some("private-value".into());
        seen.observe_at(&snapshot(2, vec![entered]), None, 2);
        assert!(!serde_json::to_string(&seen.search_at("button", None, 3))
            .unwrap()
            .contains("private-value"));
        assert!(seen.search_at("typed-password", None, 2).results.is_empty());
        let nodes = (0..2_010)
            .map(|n| node(&format!("n{n}"), "Common", "button"))
            .collect();
        seen.observe_at(&snapshot(3, nodes), None, 3);
        assert_eq!(seen.entries.len(), MAX_ENTRIES);
        assert_eq!(
            seen.search_at("common", Some(100_000), 4).results.len(),
            MAX_RESULTS
        );
        assert_eq!(
            seen.search_at("common", None, 4).results.len(),
            DEFAULT_RESULTS
        );
        assert_eq!(seen.search_at("common", Some(0), 4).results.len(), 0);
        assert!(seen
            .search_at("common", None, 3 + TTL_MS)
            .results
            .is_empty());
    }

    #[test]
    fn unchanged_generation_refreshes_without_reindexing_and_preserves_stale_ttl() {
        let mut seen = SeenCache::new();
        seen.observe_at(&snapshot(1, vec![node("old", "Save", "button")]), None, 1);
        let current = snapshot(2, vec![node("live", "Save", "button")]);
        seen.observe_at(&current, Some("Public Editor"), 2);
        let key_ptr = seen.entries["live"].name_key.as_ptr();
        seen.observe_at(&current, Some("Public Editor"), TTL_MS - 1);
        assert_eq!(seen.entries["live"].name_key.as_ptr(), key_ptr);
        assert_eq!(seen.entries["live"].hit.last_seen_ms, TTL_MS - 1);
        assert_eq!(seen.entries["old"].hit.last_seen_ms, 1);
        let hits = seen.search_at("Save", None, TTL_MS + 1).results;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "live");
        // Search can prune a current hit too; the next unchanged observation
        // must reindex it, rather than keeping an incomplete current set.
        assert!(seen.search_at("Save", None, 2 * TTL_MS).results.is_empty());
        seen.observe_at(&current, Some("Public Editor"), 2 * TTL_MS + 1);
        assert_eq!(
            seen.search_at("Save", None, 2 * TTL_MS + 2).results[0].id,
            "live"
        );
    }

    #[test]
    fn fallback_title_change_and_private_title_force_revalidation() {
        let mut seen = SeenCache::new();
        let mut field = node("field", "secret", "entry");
        field.value = Some("secret".into());
        let current = snapshot(1, vec![field, node("button", "Save", "button")]);
        seen.observe_at(&current, Some("Public Editor"), 10);
        seen.observe_at(&current, Some("Other Editor"), 11);
        assert_eq!(seen.search_at("other editor", None, 12).results.len(), 2);
        seen.observe_at(&current, Some("secret — Editor"), 13);
        assert!(
            seen.last_public_title.is_none(),
            "do not cache private X11 titles"
        );
        assert!(seen.search_at("secret", None, 14).results.is_empty());
        assert!(seen.search_at("other editor", None, 14).results.is_empty());
        seen.observe_at(&current, None, 15);
        assert!(seen.search_at("editor", None, 16).results.is_empty());
    }

    /// Compare the same 1,000-node tree with and without a generation bump.
    /// Run in release mode: cargo test --release benchmark_unchanged_index -- --ignored --nocapture
    #[test]
    #[ignore]
    fn benchmark_unchanged_index() {
        use std::hint::black_box;
        use std::time::Instant;
        let nodes: Vec<_> = (0..1_000)
            .map(|i| node(&format!("n{i}"), &format!("Save {i}"), "button"))
            .collect();
        let mut cache = SeenCache::new();
        let mut same = snapshot(1, nodes.clone());
        cache.observe_at(&same, Some("Public Editor"), 1);
        let start = Instant::now();
        for i in 0..100 {
            cache.observe_at(black_box(&same), Some("Public Editor"), i + 2);
        }
        let unchanged = start.elapsed();
        let start = Instant::now();
        for i in 0..100 {
            same.generation += 1;
            cache.observe_at(black_box(&same), Some("Public Editor"), i + 102);
        }
        let rebuilt = start.elapsed();
        assert_eq!(cache.entries.len(), 1_000);
        eprintln!("seen_index release 1k nodes x100: unchanged={unchanged:?}, full_rebuild={rebuilt:?}, speedup={:.1}x", rebuilt.as_secs_f64() / unchanged.as_secs_f64());
    }

    #[test]
    fn stale_metadata_scrubbed_and_parent_cycle_bounded() {
        let mut seen = SeenCache::new();
        let mut a = node("a", "secret-in-public-name", "button");
        a.parent = Some("b".into());
        let mut b = node("b", "Other", "button");
        b.parent = Some("a".into());
        seen.observe_at(
            &snapshot(1, vec![a, b]),
            Some("secret-in-public-name window"),
            1,
        );
        let mut entry = node("private", "secret-in-public-name", "entry");
        entry.value = Some("secret-in-public-name".into());
        seen.observe_at(&snapshot(2, vec![entry]), None, 2);
        assert!(seen
            .search_at("secret-in-public-name", None, 3)
            .results
            .is_empty());
        assert!(seen.search_at("window", None, 3).results.is_empty());
    }
}
