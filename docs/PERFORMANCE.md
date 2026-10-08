# Performance and verification

The benchmark reports below identify the optimization milestone binary, before
subsequent scoped breathing-overlay lifecycle changes. The current overlay has
separate read-only live XRender/lifecycle tests; rerun the command below for a
fresh measurement of the latest build.

These are local X11 desktop measurements, not LLM latency, provider tokens, or a
promise about every application. Screen: 1920×1200, Linux Mint Cinnamon/Muffin.
All comparisons used **release** binaries, an isolated Unix socket, no overlay,
10 warmups and 100 measured requests per command over one persistent benchmark
connection. The Pi extension opens separate connections per tool call; actual
GTK/model-output tests exercise that path separately. The desktop could change
independently. The benchmark performs no desktop input and no PNG encoding.

## Before versus current build

| Request | Before p50 / p95 (ms) | Current p50 / p95 (ms) |
|---|---:|---:|
| ping | 0.012 / 0.025 | 0.012 / 0.092 |
| observe, warm cache (*) | 0.198 / 0.244 | 1.310 / 1.957 |
| dirty_regions | 15.976 / 19.851 | **1.582 / 7.986** |
| search_seen, no matching hint | 0.191 / 0.545 | 0.164 / 0.184 |

(*) The observation trees were not identical: the final run's raw observe
response was 94,366 bytes versus 1,525 before, due to independent desktop changes
and newly registered accessibility event interests. Do not interpret this as
an apples-to-apples semantic refresh regression. Model output is separately
scoped and budgeted; these numbers concern raw daemon IPC.

Dirty checks improved about **10× at p50**; p95 still reflects compositor/server
load. Acquisition p50 was 0.552 ms, native hashing 0.968 ms, and full-frame
conversion was zero. Cold dirty check was 11.924 ms (setup + first frame), not the
steady-state number. The current warm response was 189 raw IPC UTF-8 bytes at
p50 in this run. Changed frames produce longer lists. These bytes are not the
extension's rendered model-output size.

Raw reports: [before](benchmarks/before-optimization.json),
[after](benchmarks/after-optimization.json). The before binary was preserved from
the pre-optimization local release build; it has no metrics command, so its
stage breakdown is unavailable. The current report includes bounded stage
p50/p95 and transport (`shm`). Binary SHA-256 identifiers:

- Before: `710d9d4fc28829541b05224e8809c1f899c28ecfe206a624981bab293460a4cd`
- Current: `5db60df1f7e0154f3f72b1e244260021a639741c940294103c33e0cc463028ac`

## What changed

- Persistent, bounded MIT-SHM mapping with early IPC_RMID, checked server
  attachment, resize handling, and GetImage fallback.
- Native padded ZPixmap tile hashing, ignoring undefined non-color bits and row
  padding. No dirty-check RGBA intermediate. Hash representation/visual changes
  reset the baseline; transport switching with identical format does not.
- Normalized ranked seen-history keys and an unchanged-generation fast path;
  the index remains in memory, bounded by count and TTL. Search refresh no
  longer clones a full accessibility response only to discard it.
- Bounded diagnostic counters exposed only by `desktop_metrics`; a reset reads
  the interval before clearing it. Stage totals overlap and must not be summed.
- Model-only exact active-window scoping retains linked controls/application
  ancestors. Ambiguous or unmatched titles remain conservative. Unscoped
  overviews default to 24 top nodes; observation text is capped at 6,000 chars
  with generation/window metadata and omission counts preserved. A 139,183-char
  mixed-desktop fixture becomes 1,253 scoped chars or ≤5,573 unscoped chars.
  Partial batch timings survive overflow. Images remain explicit opt-in.
- Actual AT-SPI Registry event-interest registration, not just D-Bus AddMatch.
  Backend teardown aborts its event task. Registration failure falls back to
  bounded semantic invalidation. Showing dialogs remain discoverable when
  another application retains focus.
- Stop bypasses the action lock; native gestures check between events and
  best-effort release synthetic presses. Socket cancellation does not falsely
  promise that input was rolled back. Default launcher now uses release.

## Verification

- 87 ordinary Rust tests passed; six optional tests are not in the ordinary run.
- Explicit live release tests passed for SHM reuse, GetImage fallback, resuming
  SHM, raw tile hashes, and stage profiling. No static-screen assumption.
- Extension tests passed (20 tools), including large valid-JSON observations,
  scoped ranked historical hints, private-field scrubbing, partial batch errors,
  cancellation uncertainty, omission counts and diagnostic mapping.
- Isolated GTK tests passed in debug and release: revalidated test-owned IDs,
  four ordered actions, dirty rectangles without images, current→stale history,
  no searchable typed marker, and stopped wait without subsequent input.
- Offline launcher tests, socket smoke test, read-only live observation test,
  and shell syntax checks passed.
- Offline/disposable-profile Firefox and GTK controls were exposed over AT-SPI
  in the optional Xephyr/bubblewrap test. No user profile/settings were changed.
  This does not establish a fix for an already-running inaccessible browser;
  see [capability investigation](DESKTOP-CAPABILITIES.md).
- A separate 14-step semantic-plus-two-crops extension demo completed with 10,311
  model-facing text characters (approximately 2,583 tokens by summing rounded
  characters/4 per step). No model API call was made; image tokens, tool schemas,
  conversation context, reasoning and exact provider tokenizer counts are not
  included. This is a larger multi-step diagnostic demo, not a per-click cost.

## Subsequent round-trip/context work (not a new timing benchmark)

The current implementation additionally prioritizes uniquely matched active-window AT-SPI traversal with separate dialog/popup capacity, supports live exact `assert` checks inside batch, and reduces model declarations to 3 OFF / 17 basic ON (+1 hybrid phase tool, +1 granted capture tool). Non-desktop tools are preserved. ON rules are no longer duplicated into every slash-command task message; saved-login and other safety rules remain in the system section. Semantic deltas/targeted waits are preferred; history is not silently rewritten.

Assertions force a fresh bounded AT-SPI scan and therefore can add local scan work while avoiding a separate model request. Failed reads are marked unknown and cannot pass a null assertion. The scope/loadout/assertion changes have unit, synthetic contract, and real Pi loader tests, but **no end-to-end provider/quota or live-application performance measurement**. The historical timings above do not measure these changes.

## Remaining limits

Root XDamage is **not** a complete final-screen change stream under Muffin.
Every production dirty check still scans the full root; it honestly reports
`capture_mode:full_root`. No unsafe partial/no-change shortcut is enabled.
Compositor-side output/damage integration remains research, not an implemented
capability. Root readback itself can depend on compositor/driver behavior.

Latency and output cost change with active applications, animations, cold
AT-SPI scans, and the query. Semantic actions are not rollbackable. There is no
provider-token or billing guarantee, and tests do not prove every app or driver.

## Reproduce

```sh
~/.cargo/bin/cargo build --release --manifest-path daemon/Cargo.toml
node scripts/profile-benchmark.mjs --daemon "$PWD/daemon/target/release/pi-turbo-daemon" --count 100 --warmup 10
node tests/test-extension.mjs
tests/test-run-profile.sh
tests/test-batch-dirty-regions.sh
DAEMON_BIN="$PWD/daemon/target/release/pi-turbo-daemon" tests/test-batch-dirty-regions.sh
node tests/demo-benchmark.mjs
tests/test-firefox-accessibility.sh  # exits 77 if optional isolation dependencies are absent
```
