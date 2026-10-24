# Isolated Docker browser target

An optional target for the **same Pi session and the same `desktop_*` tools**. It runs one fresh Firefox ESR browser, Xvfb, a minimal window manager, private D-Bus/AT-SPI and the existing Rust daemon inside Docker. A localhost noVNC page lets you watch and take over. No nested agent, remote browser debugging, DOM automation or replacement Pi runtime is involved.

## Start and watch

After updating the extension, run `/reload`. While Pi is idle and Computer use is OFF:

```text
/computer-use docker build
/computer-use docker start
/computer-use docker status
```

`build` explicitly downloads the Debian/Rust/package dependencies and builds the image. It is not performed automatically by a tool or by loading the extension. The runtime pins the resulting local image ID. The first build can take several minutes.

`start` selects Docker **but leaves Computer use OFF**. `status` displays a link such as `http://127.0.0.1:32781/vnc.html` and the viewer password in the command UI. Open that link yourself in your normal browser, press Connect and enter that password. The port is allocated dynamically and bound only to IPv4 loopback. The password is not included in the URL, model tool results, session entries or container logs. The viewer can remain open while you work in other host applications.

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

For MFA/CAPTCHA, follow Action required through this viewer, then resume/enable as needed and reply “готово”. Do not share credentials or viewer passwords with the model.

## Stop and return to the host

```text
/computer-use off
/computer-use docker stop
```

This removes only the pinned, ownership-verified browser container/network and its private IPC directory. **Its tmpfs browser profile, cookies, downloads and login are lost.** There is no host profile mount, download-export command or persistent profile feature. Start a new container explicitly when needed. Containers are not removed on `/reload` or on ordinary Pi shutdown: use explicit `stop` before exiting to avoid leaving an idle browser running.

Stopping, startup failure or connection loss **never switches to host**. A Docker selection survives reload/resume/tree restoration but requires explicit `on` and fresh validation. A fork has its own runtime identity; it does not adopt the original browser automatically. To deliberately select the host while idle/OFF:

```text
/computer-use host
/computer-use on
```

Multiple Pi session IDs receive separate runtime records, UUID containers, virtual displays and loopback ports. Multiple clients of the same Pi session are not separate desktop owners.

## Boundaries and limitations

- No host X11/Wayland/D-Bus socket, Docker socket, personal home, workspace or browser profile is mounted in the browser container. Only one fresh private IPC directory is bind-mounted. No host networking, host PID namespace, extra devices or privileged mode.
- Non-root host UID, dropped capabilities, no-new-privileges, read-only root; aggregate 2 CPU, 2 GiB RAM/no extra swap, 512 PIDs, 256 MiB shared memory; bounded tmpfs home/runtime/tmp. Large sites can hit these limits.
- Image/container/network identity, ownership labels, mounts, runtime restrictions and loopback publication are checked before use. An IPC symlink, changed socket identity, missing container or unsafe configuration fails closed. No host daemon autostart is used for a Docker target.
- The browser uses a normal dedicated Docker **bridge with outbound networking**. This is **not network isolation**: internet and potentially LAN/host-gateway services are reachable. There is no URL/domain egress allowlist or guarantee against network scanning by compromised code.
- noVNC HTTP is local and unencrypted. VNC authentication effectively uses an 8-character random Base64 password (48 bits); this is a local viewer guard, not strong remote-access authentication. Do not expose/forward its port publicly. Other local processes/users able to access the loopback port may attempt connections. Localhost-only publication also relies on Docker and host firewall behavior.
- Docker is not an absolute security sandbox. Docker-group access is host-privileged authority, used only by the trusted lifecycle helper. Container compromise still has a shared-kernel risk.
- **This target isolates registered Computer Use desktop operations, not the entire Pi agent.** Pi's ordinary file/bash tools still run on the host with your existing permissions. Instructions prohibit host GUI launch while Docker is selected, but that is not an OS-enforced shell sandbox. A fully containerized Pi would be a separate architecture and is not provided here.
- Watching the noVNC stream is a user action; it does not grant the model unrestricted screenshot permission. Captures still require the existing exact visual grant. Browser accessibility varies by site and is not universally sufficient.
- Metadata probes do not prove browser readiness or task success. Input timeout/disconnect remains uncertain: no automatic replay. An unexpected daemon/critical process exit ends the container session rather than automatically reviving stopped automation.

## Private state and recovery

Runtime records/image pin and lifecycle locks live under `~/.local/state/pi-computer/docker` (or `XDG_STATE_HOME`), outside the repository. IPC lives under `$XDG_RUNTIME_DIR/pi-computer-docker/<uuid>/ipc`. Owner records are private; they contain no viewer password. The viewer password exists in container-private tmpfs and is read only for the explicit command UI.

A build interrupted by killing its process can leave a private lifecycle lock. Do not delete locks or adopt containers blindly. Verify that the owning operation ended and inspect only the known private session state; cleanup is limited to exact IDs, UUID names and ownership labels. An uncertain Docker create whose ID was not received is deliberately not adopted by name. No broad `docker prune`, `docker rm $(...)`, or unrelated container stop is used.

## Development verification

Fast source-only fixtures:

```sh
node tests/test-browser-docker-runtime.mjs
node tests/test-docker-browser-target.mjs
```

They check fixed Docker arguments, image/container/network validation, stopped/incomplete cleanup, private credentials, per-session locking, target pins, reload/fork, socket substitution refusal, pause/resume and no host fallback. They do not prove Docker containment or browser operation.

The optional real smoke test uses only a test-owned browser/container and a synthetic local page. It must never access the user's host desktop/profile or real accounts:

```sh
RUN_BROWSER_DOCKER_REAL=1 node tests/test-browser-docker-real.mjs
```

Completed on the implementation host: explicit image build; localhost viewer HTTP and real password-authenticated RFB handshake (no no-auth offered); Firefox AT-SPI discovery and native click with a semantically verified label change; sticky Stop rejecting further input; explicit daemon-only resume preserving the fixture page and viewer password. Test-owned container/network/IPC were removed. Zero screenshots, real accounts, public-site tasks or host GUI actions were used. This is a scripted runtime integration test, not a live agent/provider, security-containment or performance benchmark.

Integration fixes found by the real smoke check included Docker bind-mount syntax, a missing container passwd entry, Firefox accessibility bootstrap, first-run UI and PID pressure. The final image keeps Firefox's sandbox enabled, caps its requested content-process counts and Tokio worker threads, and uses the 512 aggregate PID limit above. Static paragraph text can be omitted by the existing compact AT-SPI traversal; the fixture deliberately verifies an actionable button's changed label instead of treating an omitted paragraph as absent.
