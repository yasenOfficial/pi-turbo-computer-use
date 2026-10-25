# Browser use — one shared isolated browser

Use the existing Pi session and its normal `desktop_*` tools, without managing Docker yourself:

```text
/browser use
/browser use off
```

**`/browser use`** selects the isolated Docker target, prepares the image if missing/outdated, reuses or starts the browser, migrates a verified old temporary profile if needed, checks the daemon, noVNC page **and actual passwordless RFB backend through its WebSocket proxy**, turns Computer use ON, and shows the current viewer link. No separate build, status, migrate or ON command is required. First preparation can take several minutes; ordinary subsequent use reuses the image. Errors remain OFF and never fall back to the host desktop. New containers use Docker `unless-stopped` restart policy: a Firefox/VNC/daemon crash causes Docker to recreate the managed browser and reuse the common profile instead of leaving a dead viewer port. Repeated crash loops still fail visibly and require `/browser use` recovery; no host fallback or input replay is performed.

**`/browser use off`** immediately turns mode OFF and aborts this Pi run, stops input in the owned browser, removes its container/network, and retains the common profile. It also handles an already-stopped container. If an old temporary profile needs migration before removal, it is preserved automatically rather than discarded. The command reports success only after verified cleanup; unsafe/uncertain states remain blocked instead of deleting data blindly.

After installing an extension update, run `/reload` once so Pi loads the new command. Nothing starts on extension import, fresh Pi startup, session resume, `/reload` or an ordinary prompt. Browser use starts only because you explicitly run `/browser use`.

## Watch or take over

The command shows a link such as `http://127.0.0.1:32781/vnc.html`. Open it yourself in your normal browser and press Connect. **No password is required.** Your host pointer and window focus are independent of the container's virtual screen.

For manual intervention:

```text
/browser use pause
```

Wait for the confirmed paused message before using the viewer's mouse/keyboard. Pause turns Computer use OFF, aborts the run and requires the container daemon's sticky native Stop acknowledgment. Already-dispatched individual events cannot be undone. Unconfirmed Stop is never described as safe takeover or automatically retried. Clicking in the viewer alone does not pause automation.

When finished, run **`/browser use`** again. This explicit command resumes the stopped daemon while preserving Firefox and the current page, checks readiness, and enables control. For login/MFA/CAPTCHA, complete the human step in the viewer, then resume and reply “готово” as appropriate. No account credentials or security codes should be sent to the model.

## Basic URL navigation

URL entry is normal automation, not a human security handoff. For a short ASCII address in the managed Firefox, the agent is instructed to focus the observed browser window, use Ctrl+L, initially use the already-declared `desktop_set_text({text:url})` **without an id** (short physical typing), inspect the fresh focused URL field for the exact address, and only then press Return and verify the destination. This path is covered through the registered basic-ON tools, not an undeclared legacy typing tool, browser debug API, HTTP replacement or host GUI.

Firefox exposes its URL field as an editable **combo box**. The native paste gate now recognizes this as a candidate, but still requires live focused/editable/enabled/showing state plus the EditableText interface. Noneditable choice combos, password fields, conflicting focused fields and stale targets remain blocked. Editable-combo values can be read semantically for verification.

**Known Firefox limitation:** in separate fresh fixture runs, clipboard paste and id-based SetTextContents returned dispatch/acceptance but left this Firefox address bar empty. They are not treated as proven insertion, and are not the default short-ASCII URL-entry method. The successful regression uses the no-id physical path with exact independent readback before Return. There is no automatic replay/fallback after an uncertain earlier input; the agent must verify the current field first. Long/Unicode URL entry and every browser/site combination are not claimed universally verified. MFA/CAPTCHA still require the human.

## One browser and one profile for all Pi chats

There is **one common managed browser and one common persistent Docker profile** for the host user/private state directory, not a new volume per Pi conversation. Different chats see the same tabs, cookies and logins. Explicit use can reconnect after another chat recreated the browser; ordinary tool calls cannot silently adopt a changed socket/container.

An atomic private control claim prevents two Pi chats from automating the shared browser concurrently. It is held across a whole agent run, including model thinking, and released after workflow cleanup. Commands that change/start/stop the browser also acquire the claim. A second active controller gets a busy message rather than interleaving input. Emergency Stop remains shared. **Stopping the common browser affects all chats**, not just the one issuing OFF.

The common profile survives full container restart, removal/recreation and host reboot. **Firefox restores its previous normal windows/tabs** instead of forcing a fresh blank tab; cookies, site storage, bookmarks and browser settings are retained; a website can still expire/revoke its session, and private-browsing/session-only cookies need not survive normal browser shutdown. This is persistent profile storage, not a guarantee that every site remains signed in.

Ordinary Downloads and the rest of the tmpfs home remain temporary. There is no host-profile import or download-export feature. During normal OFF/upgrade shutdown, the private supervisor first sends a fixed X11 `WM_DELETE_WINDOW` request only to verified Firefox windows and waits for session data to flush before stopping its display/D-Bus. This is internal lifecycle shutdown, not a model-callable keyboard/mouse tool. Bounded signal fallback reports a fixed warning if normal close fails; a crash/force kill can still lose the most recent changes or require Firefox recovery. Private windows are not a persistent session.

The volume has no disk quota and is not automatically encrypted or backed up. Normal OFF/stop **never deletes the profile volume**. Deliberately deleting that Docker volume separately erases its saved sessions and data.

## Automatic upgrades without losing an old profile

`/browser use` automatically handles the uniquely owned previous temporary-profile container. It first prepares the new trusted image, requires native Stop acknowledgment, validates exact source ownership, briefly quiesces only that container's verified Firefox processes and streams its profile archive into a private, network-isolated volume-only importer. No cookies/profile bytes enter model context, logs or a host archive. An EXIT trap and recovery thaw resume the source browser. Only after a complete verified import is the old container removed and the passwordless persistent version started.

Previous per-chat ownership metadata is adopted only when there is exactly one verified candidate. An existing persistent volume can become the common profile without copying/deleting it. Multiple old browsers/profiles, interrupted adoption, incomplete import or ambiguous ownership fail closed: **there is no automatic merging, deletion or selection of somebody's profile**. Such exceptional recovery needs review, not the normal Docker command sequence.

A partial import is quarantined by private metadata; failed import preserves the source. SQLite/WAL data is retained for browser recovery, while obsolete Firefox process-lock files are not reused. Tests/installation do not automatically migrate or stop an already-running real user browser. Migration happens on the explicit high-level command.

## Desktop and security boundaries

The container runs Firefox ESR, Xvfb, a minimal window manager, private D-Bus/AT-SPI and the existing Rust daemon. This is not a nested agent, browser-debugging/DOM automation stack or replacement Pi build.

- No host X11/Wayland/D-Bus socket, Docker socket, personal home, workspace or host browser profile is mounted. One fresh private IPC directory is bind-mounted; one verified Docker-managed named volume holds `/home/browser/profile`.
- Docker clipboard synchronization is an explicit opt-in: start Pi with `PI_CLIPBOARD_BRIDGE=1` (and a built host daemon, or `COMPUTER_USE_DAEMON=/absolute/path/to/pi-turbo-daemon`) before `/browser use`. The host bridge server inherits the host X11 display, while the container receives only a separate private `/ipc/bridge` bind containing a 65,536-byte bounded UTF-8 Unix-socket protocol; host X sockets, `DISPLAY` and `XAUTHORITY` are never mounted into Docker. Ctrl+C/Ctrl+V then synchronize the native X11 `CLIPBOARD` selection in both directions. If the bridge cannot be validated, the Docker browser is not started; it is never silently replaced by host automation.
- Non-root host UID, ALL capabilities dropped, no-new-privileges, read-only root, private PID/IPC/network namespaces; aggregate 2 CPUs, 2 GiB RAM/no extra swap, 512 PIDs and 256 MiB shared memory. Remaining home/runtime/tmp use bounded tmpfs. Large sites can hit limits.
- Image/container/network/volume identity, mounts, runtime restrictions and loopback publication are checked before use. An IPC symlink, unexpected socket replacement or unsafe metadata blocks calls. Docker target failures never start/use the host daemon as fallback.
- The viewer is **HTTP, unencrypted and unauthenticated**, bound only to host IPv4 loopback. Any local process/user able to reach the port can view/control the browser and its logged-in accounts. Localhost is **not authentication**; browser-origin behavior is not a replacement. Never expose/forward/proxy this port publicly.
- The browser uses an outbound Docker bridge: internet and potentially LAN/host-gateway services remain reachable. This is not network isolation or a URL/domain egress allowlist.
- Docker is not an absolute sandbox; kernel/container-escape risks remain. Docker-group control itself is host-privileged authority, exercised only by trusted fixed lifecycle operations.
- **Only registered Computer Use desktop operations are routed to this isolated display. Pi's ordinary bash/file tools remain on the host with their existing permissions.** Instructions forbid host GUI launch while Docker is selected, but this is not an OS-enforced shell sandbox for the entire agent.
- Watching noVNC yourself does not grant the model unrestricted screenshot permission. Existing exact visual grants, saved-login rules, human security handoffs, uncertain-input no-replay policy and sticky Stop remain in effect.
- Native metadata/viewer health checks do not prove task success or universal accessibility. Browser accessibility varies by site; a single-page fixture is not a general browser compatibility guarantee.

## Advanced diagnostics and private state

The old `/computer-use docker build|start|status|pause|resume|migrate|stop` commands remain for diagnostics/manual recovery, not the normal workflow. They leave mode OFF where documented. Host desktop automation remains separately available through explicit `/computer-use host`, then `/computer-use on` while idle/OFF.

Private runtime records, image/source fingerprint, lifecycle/control locks and profile/migration metadata live under `~/.local/state/pi-computer/docker` (or `XDG_STATE_HOME`). The shared identity is derived from host UID and the canonical state directory, not Pi session ID. IPC lives under `$XDG_RUNTIME_DIR/pi-computer-docker/<uuid>/ipc`; the optional clipboard bridge socket is in its sibling `bridge` directory and is mounted only at `/ipc/bridge`. A previously verified volume may retain its old name after adoption; otherwise the common profile uses `pi-computer-profile-<shared-hash>`.

Treat the entire profile volume as sensitive: it may contain live cookies, saved passwords and account data. Do not dump, log, publish or upload it. Source fingerprinting reads only trusted Docker build inputs and Rust sources, never profiles, `.git`, transcripts or private runtime data.

If an older extension reported **“Shared browser control is unavailable”** immediately after an update, its native `.mjs` runtime could have remained cached across Pi `/reload`. The extension now loads that module by its on-disk source hash on each factory load. Run `/reload` once after this fix, then `/browser use`; no container/profile deletion, cache clearing, Pi restart or Docker rebuild is required for this loader fix. A real Pi same-process reload regression verifies that changed control methods are actually refreshed, not just that the command exists.

If a viewer link says **failed to connect**, run `/browser use` again and use the link it reports: removal/recreation can allocate a different port. New containers auto-restart after a critical child crash; an older container created before this policy is automatically replaced on the next explicit `/browser use` while its verified profile is retained. A noVNC HTML page alone does not establish that its VNC backend is alive; the command now checks a real read-only RFB handshake (no framebuffer updates or GUI input) before reporting readiness. There is no background automatic input retry or silent host fallback. Fixed child-role/exit-status diagnostics help distinguish daemon, Firefox, VNC and proxy failures without logging page titles/URLs or profile data. The reported `32811` incident was an exited container with a refused TCP port; its original child-exit cause could not be recovered from the old suppressed diagnostics.

Docker may remove an old image object while a container created from it still runs. This does not alone make that container unsafe: inspection/owned cleanup uses its exact privately pinned container/image IDs, schema, UID, privileges, mounts, network and profile-volume checks. An altered container remains blocked. New containers and migration importers still require an inspectable trusted image. The image-GC false-refusal regression is covered for both old and current containers; the original running user's container metadata was revalidated without stopping it or reading profile contents.

A killed build can leave a lifecycle lock; a crashed Pi process can leave a control claim. Such uncertain claims are not stolen automatically. Verify the prior owner/operation ended before tightly scoped manual recovery. An uncertain Docker create ID is not adopted by name. No broad prune or unrelated container removal is used.

## Verification

Fast source/isolated IPC fixtures:

```sh
node tests/test-browser-docker-runtime.mjs
node tests/test-browser-use.mjs
node tests/test-docker-browser-target.mjs
node tests/test-browser-runtime-reload.mjs
node tests/test-browser-viewer-health.mjs
```

They cover cached preparation, shared profile/ownership adoption, competing control claims, explicit ON/OFF, cancellation during build/start, legacy upgrade, image replacement, pause/resume, socket substitution and no host fallback.

Opt-in real integration, always using private fixture state/runtime roots so the production shared browser is inaccessible:

```sh
RUN_BROWSER_USE_REAL=1 node tests/test-browser-use-real.mjs
RUN_BROWSER_DOCKER_REAL=1 node tests/test-browser-docker-real.mjs
RUN_BROWSER_PROFILE_MIGRATION_REAL=1 node tests/test-browser-profile-migration-real.mjs
RUN_BROWSER_TABS_REAL=1 node tests/test-browser-tabs-real.mjs
RUN_BROWSER_NAVIGATION_REAL=1 node tests/test-browser-navigation-real.mjs
```

Completed: real high-level use/reuse/pause/off/start with no repeated image build; passwordless RFB; Firefox native semantic click; sticky Stop and daemon-only resume; dummy persistent cookie surviving full restart and removal/recreation; synthetic v1 profile migration/adoption and recreation visible to two Pi session identities. Test-owned containers/networks/volumes/temp files and fixture images were removed. The live real-user legacy browser was not stopped/migrated or read for profile contents.

The viewer/tab-restoration follow-up also passed: two synthetic tabs survived container removal/recreation and a full restart without duplicates; native tab selection plus exact active-window titles verified both pages when compact AT-SPI omitted tab nodes. Repeated RFB connect/disconnect and a further 68-second private stability interval kept the viewer/browser running. Loopback protocol fixtures reject HTTP-only readiness, backend disconnects, password-only negotiation and malformed replies. The current user profile was not read or modified by development checks.

The URL follow-up verified basic-ON tool declarations, short ASCII address entry including percent-encoding/punctuation, exact live AT-SPI readback before Return, native Firefox navigation to the expected synthetic loopback route, and refusal of paste into a sole-focused noneditable choice combo. A native guard test also rejects conflicting focused editable candidates even with an explicit target. Separate opt-in paste/id-setter diagnostics remain documented failures, not successful navigation tests. No real TikTok page, user account or user browser was changed by these development checks.

These are scripted integration checks, not live agent/provider, security-containment or performance benchmarks. No host GUI, screenshots, real accounts or public-site tasks were used. Real tests previously found Docker tmpfs-copy limitations, Firefox onboarding/accessibility bootstrap and PID pressure; the implementation keeps Firefox's sandbox enabled and uses fixed exec streaming for migration.
