# Security and privacy

By default, this experimental extension acts on the real X11 desktop using the current user's privileges. The optional Docker browser target directs registered desktop tools to a separate virtual screen with no automatic host fallback. **Neither mode sandboxes Pi's ordinary host bash/file tools or arbitrary extensions.** Review tasks and avoid parallel agent input on the same display.

## Docker browser target

See [Docker browser guide](docs/DOCKER-BROWSER.md). The container has no host display/D-Bus/Docker socket, home, workspace or browser-profile mount. Its only bind mount is a private, per-session IPC directory; UID, image/container/network identity, privileges, mounts and loopback port publication are checked before use. Missing/unsafe Docker state blocks calls rather than selecting the host. Host selection is explicit and idle/OFF only.

The noVNC viewer is localhost HTTP, not a remotely hardened service. Its traditional VNC password is limited to eight random Base64 characters (48 bits); do not expose or forward the port publicly. Credentials live in container tmpfs and are shown only through explicit command UI, never model results or saved session entries. Local same-user processes remain trusted. A browser/daemon sharing this container is not a separate user-to-user boundary.

A dedicated outbound Docker bridge **can reach internet/LAN/host-gateway services**; it is not network isolation or an egress allowlist. Docker has shared-kernel/container-escape risks, and Docker-group control itself has host-level authority. Pi shell permissions are unchanged: the Docker-only desktop routing promise is not an OS sandbox for a malicious model with shell access.

Pause requires an acknowledged native Stop before manual takeover; accepted events cannot be undone. Resume explicitly restarts only the stopped container daemon and leaves mode OFF. No automatic Stop reset or uncertain input replay. Browser state is ephemeral and is destroyed on explicit container removal; reload/shutdown do not remove it automatically.

## Safety boundaries

- OFF blocks registered desktop observation/actions, visual/model handoffs, and task submission. Only emergency Stop and metadata-only ping/metrics remain available; it cannot revoke already-dispatched tools/input. This host-tool gate is not a sandbox for arbitrary shell commands or other extensions.
- Every registered image capture requires a single-use exact tool/target permit citing an explicit screenshot request or remaining semantic blocker. The model supplies that rationale; the gate cannot independently verify its truth. Authorization and capture cannot share an assistant batch.
- Optional hybrid routing is visible in the same Pi session and uses authenticated physical targets only. Both models receive the same conversation under their provider's data policy; model switching is not data anonymization. No nested classifier/model call is used.

- User-only Unix socket (`0600`) and permanent user-owned lock inode.
- Emergency Stop bypasses the action mutex, is sticky, and must not be reset by automatic startup or upgrade.
- Input dispatch acknowledgment is not a guarantee of final UI state. Sent actions with timeout/disconnect/cancellation have uncertain outcomes; do not automatically replay them.
- Native app launching uses an installed visible GIO desktop entry, never an arbitrary command supplied by the model.
- Compatibility is checked before AT-SPI/UI work. Authenticated ownership and idle state are required for graceful managed upgrades; arbitrary/legacy processes are not forcibly killed.
- Workflow leases expire if renewal is lost. Overlay support fails closed rather than placing an opaque window over the desktop.
- Model handoff/prompt rules do not replace user review. Existing browser autofill may be used for a task's verified site/account; password extraction, OTP retrieval, CAPTCHA bypass, or unrequested account operations are outside that permission.

## Sensitive information

Accessibility names, window titles, tool text, and images may contain personal information and reach the model provider. In-memory UI history excludes editable values/images but is not a universal privacy guarantee. Multiple clients share daemon-lifetime UI metadata on the same desktop.

Do **not** publish:

- Pi conversation/session files or personal settings.
- Browser profiles, cookies, passwords, login/MFA codes, or credential databases.
- Daemon owner records/management tokens, Docker runtime records, or noVNC viewer passwords from private state/UI.
- Unredacted desktop screenshots, accessible trees, diagnostics, or logs.
- API/SSH tokens, private keys, `.env` files, or user workspace artifacts.

The public repository contains source, configuration examples, synthetic test fixtures, and bounded benchmark metadata. Never add a live desktop transcript as a regression fixture. Test-owned dummy UUIDs are not production credentials.

## Reporting

Use a private security advisory on GitHub if available, or contact the repository owner privately. Do not put exploitable details or secrets in a public issue. Include the affected build, minimal redacted steps, and whether input was sent; do not attach private state files.
