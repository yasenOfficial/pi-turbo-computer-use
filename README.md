# Pi Turbo Computer Use

**Semantic-first Linux desktop automation for an existing Pi session.** A TypeScript extension exposes `desktop_*` tools to your current agent; a local Rust daemon handles AT-SPI accessibility, X11 input, native application launching, and bounded screenshots when needed.

This is **not a new Pi build, browser plugin, or autonomous nested agent**. It is an experimental X11 extension; accessibility coverage varies by application. The source is public, but no project license has been selected yet.

## Features

- **22 model-facing tools:** semantic observe/diffs/inspection, UI history search, verified focus, native GIO app launch, Unicode editable text where supported, input, ordered batches, waits, bounded captures, dirty rectangles, metrics, emergency Stop, and an extension-local user handoff.
- `/computer-use on`, `off`, and `toggle`. **OFF at fresh Pi startup**, including reopening saved sessions. `/reload` preserves the chosen mode in the current session.
- An ON bar with a live whole-run timer and the last duration. Toggle/timing state is session-local; the physical desktop and emergency Stop are shared across sessions.
- Breathing blue screen-edge light and a smooth cursor-following halo during desktop work **including model thinking**, with expiring workflow leases and capture suspension.
- Lazy daemon startup and safety/version validation before UI calls. Authenticated, idle, extension-owned daemons can upgrade gracefully; arbitrary or emergency-stopped processes are never forcibly replaced.
- **Action required** handoff for MFA/2FA, CAPTCHA, missing/ambiguous login, approval, or a genuine technical blocker. Generic OS notifications contain no task text or credentials. User abort/Stop is silent.

## Requirements

- Linux **X11**, XTEST, and a session D-Bus/AT-SPI registry. Tested on Linux Mint Cinnamon; **Wayland is not supported**.
- Current Rust/Cargo and native GLib/GIO development libraries.
- An installed, trusted Pi extension runtime that provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`, including **`agent_settled`**, structured `before_agent_start`, `tool_call`, and `model-only` tool support. Development uses the Pi Codex Ultra / Earendil API; other Pi builds may differ. Do not assume every upstream/fork release is compatible.
- `notify-send` and a desktop notification service for OS notifications (optional).
- Python 3 for IPC test/benchmark scripts; Node.js for extension tests.

Ubuntu / Linux Mint prerequisites:

```sh
sudo apt update
sudo apt install build-essential pkg-config libglib2.0-dev at-spi2-core \
  dbus x11-utils python3 libnotify-bin
```

Install a current Rust toolchain from [rustup.rs](https://rustup.rs/) if needed. No root privileges are required after installing system dependencies.

## Install into your existing Pi

```sh
git clone https://github.com/yasenOfficial/pi-turbo-computer-use.git
cd pi-turbo-computer-use
./scripts/install.sh
```

The script builds the release daemon, installs it to `~/.local/bin/pi-turbo-daemon`, and installs `~/.config/pi-computer/config.toml` **only if absent**. It does not install a service, modify Pi settings, or start a desktop workflow.

Add the **absolute** extension path to the existing `extensions` array in `~/.pi/agent/settings.json`, preserving all other entries/settings:

```json
{
  "extensions": [
    "/absolute/path/to/pi-turbo-computer-use/.pi/extensions/computer-use/index.ts"
  ]
}
```

Run **`/reload` in your current Pi session**. No Pi rebuild or new session is required. Loading from a child directory is not automatic when Pi's working directory is its parent; the explicit settings entry avoids that problem. The Pi host resolves its own TypeScript dependencies; there is no project `npm install` step.

The first desktop tool lazily starts the release daemon if the expected socket is absent/refused. It does **not** compile on a tool call: rerun `./scripts/install.sh` after pulling Rust changes. A missing/unsafe binary or incompatible listener blocks UI observation. Legacy daemons without the safety handshake require a one-time controlled migration; they are not auto-killed.

Optional foreground start for diagnostics:

```sh
./scripts/run-daemon.sh
```

## Usage

```text
/computer-use on                    Enable direct desktop prompts
/computer-use off                   Disable persistent mode (not emergency Stop)
/computer-use toggle                Toggle mode
/computer-use <task>                One-off task in this same session
/computer-use status                Tool/mode status, not daemon connectivity
/computer-use instructions          Show operating rules locally
```

Example:

> Open the text editor, create a new note with “Hello”, and save it in a new file. Do not overwrite existing files.

While ON, normal prompts receive computer-use operating rules. The bar shows `Computer use ON · 00:12`, then `Computer use ON · последно: 00:23`. Timing begins before model execution and includes tool work/continuations, but not time waiting in Pi's input queue. Turning OFF hides the bar; it does not cancel a running task or revoke an already-issued input event.

For a user-only blocker, the agent calls `desktop_request_user`, explains the concrete step, ends its turn, and sends **Pi · Action required** at settlement instead of a completion notification. Complete the step directly and reply **“готово” / “done”**; the agent re-observes and continues. There is no background polling or second model orchestrator. Saved browser login may be used through the normal browser autofill UI for the matching requested site/account, unless the task forbids it. Password extraction/reveal, account creation, OTP retrieval, and security bypass are not authorized. This is model guidance and explicit handoff, not guaranteed automatic recognition of every login screen.

## Architecture

```text
Existing Pi session
  └─ TypeScript extension (.pi/extensions/computer-use/)
       ├─ commands, structured prompt rules, timer/bar, notifications/handoff
       ├─ lazy startup, build/capability handshake, private ownership record
       └─ newline-delimited JSON over user-only Unix socket (0600)
            └─ Rust daemon (daemon/)
                 ├─ AT-SPI via D-Bus: bounded cached tree, events, direct properties
                 ├─ X11/EWMH/XTEST: window metadata, verified focus, input
                 ├─ GIO: installed desktop-entry application dispatch
                 ├─ MIT-SHM/GetImage: explicit crops, native tile hashes, PNG
                 └─ XRender/Shape: click-through feedback with expiring leases
```

The socket defaults to `$XDG_RUNTIME_DIR/pi-computer.sock`. Required safety capabilities prevent observing through an unsafe legacy daemon. The daemon never implicitly requests AT-SPI `Properties.GetAll`, avoiding a reproduced Chromium bridge abort. Native launch acknowledgment is **dispatch accepted**, not window readiness. Input timeout/disconnect outcomes are uncertain and must never be replayed automatically.

## Screenshots, quota, and limits

Semantic output is the default: observations do **not** include images unless explicitly requested. Prefer `desktop_search_seen` → live `desktop_inspect` when the compact tree omits a control; batch verified actions; verify editable text semantically. Use a **small screenshot crop only for information not available through accessibility**. Some browser pages/custom widgets remain inaccessible, so screenshot-free operation is not a universal guarantee.

Root dirty rectangles are merged changed **64×64 tiles across the whole display**, not quadrants. `desktop_dirty_regions` returns metadata only but still acquires a raw root frame. Cinnamon root XDamage is incomplete, so empty damage queues do not justify skipping capture. Captures suspend feedback, but X-server synchronization is not a universal compositor presentation fence.

Model reasoning, context size, image dimensions, and the number of round trips all affect quota. Native daemon timings are **not provider token/image billing or end-to-end agent latency**. See [performance evidence](docs/PERFORMANCE.md) and [desktop accessibility findings](docs/DESKTOP-CAPABILITIES.md).

## Safety

**Ctrl+Alt+Esc** is the primary emergency Stop hotkey; the daemon tries **Ctrl+Alt+Shift+Escape** if that grab is unavailable. `desktop_stop` also disables input immediately without waiting behind the action mutex. Stop is sticky: deliberately restart your own daemon and `/reload` only when safe. The extension must not revive stopped input automatically.

Tools operate on your real desktop with your user's privileges. Multiple Pi sessions are **not isolated desktops**; their workflows can interleave. No screenshot, browser profile, saved credential, ownership token, or session transcript belongs in a public bug report. See [SECURITY.md](SECURITY.md).

## Configuration and troubleshooting

The daemon accepts TOML; the extension reads environment overrides. Useful variables:

| Variable | Purpose |
|---|---|
| `COMPUTER_USE_SOCKET` | Same exact socket path for extension and daemon |
| `COMPUTER_USE_AUTOSTART=0` | Require a manually started daemon |
| `COMPUTER_USE_DAEMON` | Absolute executable ELF daemon override, not a script |
| `COMPUTER_USE_CONFIG` | Explicit daemon TOML path |
| `COMPUTER_USE_OVERLAY=0` | Disable feedback overlay |
| `COMPUTER_USE_TIMEOUT_MS` | Extension IPC timeout, default 30000 |

The extension prefers the repository release binary/config when available. Startup diagnostics live privately under `~/.local/state/pi-computer/`; **never publish ownership records/tokens**. If the launch name is not an exact installed localized name, use a known desktop-entry ID or inspect the actual launcher; do not guess IDs. An empty compact accessibility response does not prove the app closed.

Full configuration, lifecycle, tools, diagnostics and optional GUI test matrix: [implementation reference](docs/REFERENCE.md). Wire contract: [PROTOCOL.md](PROTOCOL.md). Chromium crash reproduction/fix: [Brave isolation findings](docs/brave-isolation-findings.md).

## Development and checks

Run from the repository root:

```sh
cargo fmt --check --manifest-path daemon/Cargo.toml
cargo test --locked --manifest-path daemon/Cargo.toml
cargo build --release --locked --manifest-path daemon/Cargo.toml
node tests/test-computer-use-mode.mjs
node --test tests/test-computer-use-notification.mjs
node tests/test-extension.mjs
node tests/test-real-pi-load.mjs
node tests/test-daemon-autostart.mjs
node tests/test-daemon-autostart-real.mjs
node tests/test-daemon-upgrade.mjs
node tests/test-launch-app.mjs
```

Node integration tests require the compatible Pi SDK. They prefer `PI_CODING_AGENT_PACKAGE` (path to its `package.json`) or `PI_CODEX_ULTRA_RELEASE_ROOT`; otherwise they search the local Pi Codex Ultra release installation. Core notification tests inject subprocess mocks and do not send real notifications. GUI test scripts are optional and described separately; inspect their scope before running them. GitHub CI runs native Rust checks without controlling a user's desktop.

Keep changes and tests in small commits; do not commit local build outputs, screenshots, logs, private settings, or credentials. Public issues should contain redacted reproducible steps, not personal desktop captures.
