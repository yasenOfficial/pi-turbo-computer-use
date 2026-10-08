# Security and privacy

This experimental extension acts on the real X11 desktop using the current user's privileges. It is not a sandbox or a permission enforcement system for arbitrary models. Review tasks and avoid parallel agent input on the same display.

## Safety boundaries

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
- Daemon owner records/management tokens from the private state directory.
- Unredacted desktop screenshots, accessible trees, diagnostics, or logs.
- API/SSH tokens, private keys, `.env` files, or user workspace artifacts.

The public repository contains source, configuration examples, synthetic test fixtures, and bounded benchmark metadata. Never add a live desktop transcript as a regression fixture. Test-owned dummy UUIDs are not production credentials.

## Reporting

Use a private security advisory on GitHub if available, or contact the repository owner privately. Do not put exploitable details or secrets in a public issue. Include the affected build, minimal redacted steps, and whether input was sent; do not attach private state files.
