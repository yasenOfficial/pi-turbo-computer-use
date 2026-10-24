# Isolated Docker browser target

An optional target for the **same Pi session and the same `desktop_*` tools**. It runs one Firefox ESR browser with a dedicated persistent profile, Xvfb, a minimal window manager, private D-Bus/AT-SPI and the existing Rust daemon inside Docker. A localhost noVNC page lets you watch and take over. No nested agent, remote browser debugging, DOM automation or replacement Pi runtime is involved.

## Start and watch

After updating the extension, run `/reload`. While Pi is idle and Computer use is OFF:

```text
/computer-use docker build
/computer-use docker start
/computer-use docker status
```

`build` explicitly downloads the Debian/Rust/package dependencies and builds the image. It is not performed automatically by a tool or by loading the extension. The runtime pins the resulting local image ID. The first build can take several minutes.

`start` selects Docker **but leaves Computer use OFF**. `status` displays a link such as `http://127.0.0.1:32781/vnc.html`. Open it in your normal browser and press Connect: **there is no viewer password**. The port is allocated dynamically and bound only to IPv4 loopback. No password is generated, read, stored or transmitted. The viewer can remain open while you work in other host applications. Loopback is not authentication: other local clients can reach and control this viewer.

Then explicitly enable agent interaction:

```text
/computer-use on
```

Give browser tasks normally. The ON bar names **Docker browser**. Mouse, focus, keyboard, clipboard, AT-SPI and captures from registered desktop tools target the container's virtual screen—not the host screen. Existing visual-permission, saved-login and Action required rules still apply. You may sign into the isolated browser yourself; existing host browser logins/profiles are **not** copied.

## Take over safely

```text
/computer-use docker pause
```

Pause turns Computer use OFF, aborts the active Pi run and sends the container daemon's native sticky Stop. **Wait for the confirmed paused message before intervening.** Already-dispatched individual events cannot be undone; native Stop prevents subsequent automation input/batch steps. If Stop is not acknowledged, the command says it is unconfirmed, stays OFF, and does not retry automatically. Merely clicking inside the viewer does not automatically pause the agent.

After completing your manual step:

```text
/computer-use docker resume
/computer-use on
```

`resume` explicitly restarts **only the stopped container daemon**, preserving Firefox, its in-container login, the virtual screen and viewer. It stays OFF until `on`. It requires Pi/tools to be idle. It cannot silently reset a host Stop. The existing `/computer-use off` command alone blocks new calls but does not stop an already-running batch; use `docker pause` for takeover.

For MFA/CAPTCHA, follow Action required through this viewer, then resume/enable as needed and reply “готово”. Do not share account credentials or security codes with the model.

## Stop and return to the host

```text
/computer-use off
/computer-use docker stop
```

This removes only the pinned, ownership-verified browser container/network and its private IPC directory. **Its dedicated Docker profile volume is retained**, including cookies, site storage, bookmarks and saved browser settings. A subsequent `docker start` in the same Pi session/resumed conversation reuses it, including after container removal or host reboot. Websites can still expire/revoke sessions; session-only cookies and policies such as private browsing need not survive a normal browser shutdown. This is profile persistence, not a guarantee that every website remains signed in.

The rest of the home, including ordinary Downloads, remains temporary. There is no host profile mount or download-export feature. A new/forked Pi session ID receives a separate profile; there is no automatic cross-session profile sharing. Profile disk usage is not capped by the RAM/tmpfs limits, nor encrypted/backed up automatically. `stop` never removes the profile volume; deleting it separately intentionally signs out/erases the stored data.

Containers are not removed on `/reload` or ordinary Pi shutdown: explicitly `stop` before exiting to avoid leaving an idle browser running.

Stopping, startup failure or connection loss **never switches to host**. A Docker selection survives reload/resume/tree restoration but requires explicit `on` and fresh validation. A fork has its own runtime identity; it does not adopt the original browser automatically. To deliberately select the host while idle/OFF:

```text
/computer-use host
/computer-use on
```

Multiple Pi session IDs receive separate runtime records, UUID containers, virtual displays and loopback ports. Multiple clients of the same Pi session are not separate desktop owners.

## Upgrade an existing temporary-profile container

An already-running v1 container retains its old password and tmpfs until explicitly migrated. Reloading code or building an image does not change its mounts or copy its cookies. To preserve its current data, use the same Pi conversation that owns it, while idle:

```text
/reload
/computer-use off
/computer-use docker build
/computer-use docker migrate
/computer-use docker status
/computer-use on
```

`migrate` requires an acknowledged native Stop, validates exact source ownership, briefly quiesces only that container's verified Firefox processes and streams its profile archive directly into a private volume-only importer. The source container, daemon and viewer stay running; Firefox is resumed by an EXIT trap and a separate recovery thaw. No profile bytes enter model context, logs or a host archive. Only after a verified complete import does the command remove the old container and start the new passwordless one, still OFF. The localhost port may change. Firefox lock files are not reused; SQLite/WAL files and other profile data are preserved for browser recovery.

Failed/uncertain Stop or import preserves the source container and stays OFF; do not delete it or repeatedly retry. A partial import is quarantined by private migration metadata and requires manual review. Legacy `stop` is refused before completed migration so it cannot silently discard a logged-in temporary profile. No real user container is migrated as a side effect of installing/testing this feature.

## Boundaries and limitations

- No host X11/Wayland/D-Bus socket, Docker socket, personal home, workspace or browser profile is mounted in the browser container. Only one fresh private IPC directory is bind-mounted; one ownership-verified Docker-managed named volume is mounted at `/home/browser/profile`. No host networking, host PID namespace, extra devices or privileged mode.
- Non-root host UID, dropped capabilities, no-new-privileges, read-only root; aggregate 2 CPU, 2 GiB RAM/no extra swap, 512 PIDs, 256 MiB shared memory; bounded tmpfs home/runtime/tmp. Large sites can hit these limits.
- Image/container/network identity, ownership labels, mounts, runtime restrictions and loopback publication are checked before use. An IPC symlink, changed socket identity, missing container or unsafe configuration fails closed. No host daemon autostart is used for a Docker target.
- The browser uses a normal dedicated Docker **bridge with outbound networking**. This is **not network isolation**: internet and potentially LAN/host-gateway services are reachable. There is no URL/domain egress allowlist or guarantee against network scanning by compromised code.
- noVNC HTTP is **local, unencrypted and unauthenticated by explicit choice**. Any process/user able to reach its loopback port can view the browser, control it and access its logged-in sessions. Never expose/forward the port publicly, put it behind a public proxy, or rely on an untrusted machine's other users. Browser-origin restrictions are not authentication. Localhost-only publication also relies on Docker and host firewall behavior.
- Docker is not an absolute security sandbox. Docker-group access is host-privileged authority, used only by the trusted lifecycle helper. Container compromise still has a shared-kernel risk.
- **This target isolates registered Computer Use desktop operations, not the entire Pi agent.** Pi's ordinary file/bash tools still run on the host with your existing permissions. Instructions prohibit host GUI launch while Docker is selected, but that is not an OS-enforced shell sandbox. A fully containerized Pi would be a separate architecture and is not provided here.
- Watching the noVNC stream is a user action; it does not grant the model unrestricted screenshot permission. Captures still require the existing exact visual grant. Browser accessibility varies by site and is not universally sufficient.
- Metadata probes do not prove browser readiness or task success. Input timeout/disconnect remains uncertain: no automatic replay. An unexpected daemon/critical process exit ends the container session rather than automatically reviving stopped automation.

## Private state and recovery

Runtime records/image pin and lifecycle locks live under `~/.local/state/pi-computer/docker` (or `XDG_STATE_HOME`), outside the repository. IPC lives under `$XDG_RUNTIME_DIR/pi-computer-docker/<uuid>/ipc`. Owner/profile/migration records are private metadata; they contain no browser cookies or viewer password. Persistent browser data lives in the per-session `pi-computer-profile-<session-hash>` Docker volume, not the source repository. Treat the entire volume as sensitive: it can contain live cookies, saved passwords and site data. Do not dump it into diagnostics or upload it. Only exact-owned volume metadata is inspected by lifecycle checks.

A build interrupted by killing its process can leave a private lifecycle lock. Do not delete locks or adopt containers blindly. Verify that the owning operation ended and inspect only the known private session state; cleanup is limited to exact IDs, UUID names and ownership labels. An uncertain Docker create whose ID was not received is deliberately not adopted by name. No broad `docker prune`, `docker rm $(...)`, or unrelated container stop is used.

## Development verification

Fast source-only fixtures:

```sh
node tests/test-browser-docker-runtime.mjs
node tests/test-docker-browser-target.mjs
```

They check fixed Docker arguments, image/container/network/volume validation, profile retention/reuse, legacy migration guards, stopped/incomplete cleanup, per-session locking, target pins, reload/fork, socket substitution refusal, pause/resume and no host fallback. They do not prove Docker containment or browser operation.

The optional real smoke test uses only a test-owned browser/container and a synthetic local page. It must never access the user's host desktop/profile or real accounts:

```sh
RUN_BROWSER_DOCKER_REAL=1 node tests/test-browser-docker-real.mjs
```

Completed for the v2 update: 19 runtime cases and focused target/mode/safety/extension/real-Pi-loader suites; the real v2 fixture passed passwordless RFB, native Firefox interaction, Stop/resume, and a dummy persistent cookie surviving both a full container restart and removal/recreation. The separate opt-in `RUN_BROWSER_PROFILE_MIGRATION_REAL=1 node tests/test-browser-profile-migration-real.mjs` also passed: it builds an isolated v1 fixture from tracked sources, imports its synthetic profile, and verifies retention after v2 removal/recreation. Test containers, networks, profile volumes, temporary files and the fixture image were cleaned up; the already-running real user container was not migrated/stopped or inspected for profile contents.

Real migration testing exposed that Docker `cp` cannot archive this tmpfs profile, so the final implementation uses a fixed, Firefox-quiesced `docker exec` tar stream instead. Legacy containers remain strictly pinned/validated even when Docker no longer exposes their old image configuration; v2 image absence still fails closed. These are scripted integration checks, not live agent/provider, containment or performance benchmarks. No host GUI, screenshots, real accounts or user-profile data were used.

Integration fixes found by the real smoke check included Docker bind-mount syntax, a missing container passwd entry, Firefox accessibility bootstrap, first-run UI and PID pressure. The final image keeps Firefox's sandbox enabled, caps its requested content-process counts and Tokio worker threads, and uses the 512 aggregate PID limit above. Static paragraph text can be omitted by the existing compact AT-SPI traversal; the fixture deliberately verifies an actionable button's changed label instead of treating an omitted paragraph as absent.
