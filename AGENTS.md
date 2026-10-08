# Project development rules

- This is an extension for an existing Pi runtime, not a Pi fork/rebuild or a nested autonomous model.
- Read the compatible installed Pi SDK docs before changing event, tool, command, or TUI integration. Verify real resource loading as well as mock tests.
- Real user desktop tasks must use registered `desktop_*` tools only. Shell/IPC scripts are restricted to source development and isolated test-owned fixtures, never a substitute for desktop tools.
- Prefer semantic controls and live node inspection. Compact output omissions do not prove a control is absent. Use bounded visual fallback only where accessibility is insufficient; never claim universal screenshot-free operation or quote native latency as provider quota.
- Preserve verified focus, direct AT-SPI properties (no implicit GetAll), sticky emergency Stop, graceful authenticated idle upgrade, socket ownership/locking, and no automatic replay of uncertain input.
- Do not alter personal browser profiles/settings, overwrite user workspaces, or expose saved passwords/management tokens in tests or logs. Test-owned profiles/windows/sockets must be isolated and identifiable.
- No processes, sockets, or recurring timers at extension factory load. Cleanup timers/leases at settlement, cancellation, and shutdown/reload. User abort is notification-silent.
- Mode/timer UI is per Pi session; desktop input and emergency Stop are shared. Default persistent mode is OFF at fresh startup.
- Keep README/implementation reference and tests consistent with capabilities and limitations.
- For authorized changes to this project, run relevant tests, make small descriptive commits, and push the configured public origin when authentication is available. Before staging/pushing, inspect the exact file set for credentials, screenshots, transcripts, diagnostics, binaries, and unrelated user files. Never use `git add` outside this repository or force-push to conceal a leak; report accidental exposure and arrange credential rotation/remediation.
