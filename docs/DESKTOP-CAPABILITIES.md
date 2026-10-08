# Desktop capture and Firefox accessibility diagnosis

**Scope:** Read-only investigation on Linux Mint Cinnamon/X11. No settings were
changed, no windows were focused or interacted with, and the installed/user
Firefox was not launched or restarted. No browser profile or browsing data was
read. `scripts/diagnose-desktop.sh` performs a repeatable, privacy-limited
snapshot using only package metadata, process identity/allowlisted environment,
AT-SPI service presence, accessibility setting values, and X extension metadata.

## Findings (observed on this host)

- Session is `XDG_SESSION_TYPE=x11`, `XDG_CURRENT_DESKTOP=X-Cinnamon`,
  `DISPLAY=:0`; `GTK_MODULES=gail:atk-bridge`.
- Installed Muffin is `6.4.1+xia` (Mint backport), Cinnamon `6.4.14+xia`.
  `Composite`, `DAMAGE`, and `XFIXES` X extensions are present. Muffin owns the
  `_NET_SUPPORTING_WM_CHECK` property. This establishes a composited X11 session,
  not that a root-window Damage subscription sees the final screen.
- Firefox package is `157.0.1+linuxmint1`; installed executable reports
  `157.0.1`. A Firefox process was already running. Its executable resolves to
  `/usr/lib/firefox/firefox-bin (deleted)`, indicating the process image no
  longer matches the currently installed on-disk file (likely package replacement
  after it started; exact cause is not established). Its allowlisted environment
  includes `GTK_MODULES=gail:atk-bridge`, `DISPLAY=:0`, and X11 session type.
- The session AT-SPI bus and `org.a11y.atspi.Registry` were present. Both
  `org.gnome.desktop.interface toolkit-accessibility` and
  `org.cinnamon.desktop.interface toolkit-accessibility` read `false`.
  `GTK_MODULES` and the AT-SPI bus existing do **not** prove Firefox has exposed
  an accessible tree. Conversely these GTK settings alone do not prove Gecko
  accessibility is disabled: Firefox has its own Gecko/ATK activation path.
  Registry service presence is not a per-application accessibility test.
- An isolated Firefox/GTK test is now recorded below. It did not use the running
  Firefox/profile or network. Results show the installed Firefox can expose the
  test page through AT-SPI, but the `force_disabled=0`-only case did not register
  a Firefox accessible application. The original user-visible failure is still
  uncharacterized, so this is evidence about activation paths, not a complete
  root-cause diagnosis.

## Muffin compositor: what root XDamage misses

The installed Muffin source package is not enabled in local apt source metadata,
so implementation details were checked against the Mint Muffin `6.4.1` source
and cross-checked against the installed package version/changelog. Relevant
implementation paths:

- [`src/compositor/meta-compositor-x11.c`](https://github.com/linuxmint/muffin/blob/6.4.1/src/compositor/meta-compositor-x11.c)
  handles per-client X Damage events, gets the XDamage drawable from each event,
  and passes it to the relevant window actor. Its X11 compositor `manage` path
  assigns `display->x11_display->composite_overlay_window` as compositor output,
  reparents the Clutter stage X window into that overlay, maps the overlay, and
  then redirects root subwindows with Composite. The code's damage path is about
  updating window actors, not publishing a complete root-output damage stream.
- [`src/compositor/compositor.c`](https://github.com/linuxmint/muffin/blob/6.4.1/src/compositor/compositor.c)
  builds the stage actor hierarchy (background/window groups and other actors),
  redirects subwindows manually, and shows the stage. The source documents
  `meta_disable_unredirect_for_display()` as useful when recording video; ordinary
  fullscreen unredirect can otherwise put a window outside the compositor's
  ordinary composited path.
- The Composite overlay window is explicitly Muffin's X11 **output target**;
  it is a much more plausible output drawable to investigate than root. But the
  source evidence alone does not prove that an external client's `XGetImage` or
  XDamage selection on the overlay yields every final GL-composited pixel/change
  on every driver, especially with fullscreen unredirect, cursor planes, or
  overlays. No such capture has been empirically validated here. Do not ship an
  overlay-based implementation as “complete” without testing the exact output
  pixels and damage behavior against this Muffin build/GPU.

### Concrete implementation direction (proposed, not implemented)

For strict actual-desktop capture, integrate with Muffin's compositor render
pipeline rather than watching root damage. In-process Muffin code has the stage
and receives per-window damage; the public-ish API exported by the installed
`libmuffin.so.0` includes `meta_get_stage_for_display`, and the source's stage is
the object rendered to the compositor output. A supported compositor-side
capture hook can obtain pixels at/after the stage render, provide full-frame or
stage-damage notifications, and explicitly account for cursor and unredirected
fullscreen paths. Muffin's documented `meta_disable_unredirect_for_display()`
can prevent unredirect while recording, but it is compositor-internal API and
should only be used by a cooperating Muffin integration—not by silently
reconfiguring the user's compositor.

A separate X11 capture process has no general protocol API to subscribe to
Muffin's finished scene-damage stream. XDamage on the root alone is insufficient;
XDamage on every client drawable requires tracking all actor lifecycle/stacking,
then still does not provide composition/opacity/effects/cursor final pixels.
The overlay/stage X window can be prototyped as an **opt-in candidate** (full
readback rather than assuming a complete damage feed), but first prove actual
pixel equivalence and damage coverage on the target Muffin/driver. No fallback
that drops the compositor or captures only a subset should be presented as
complete.

## Firefox accessibility: safe next steps

The existing Firefox process's deleted executable means its runtime state is
not evidence about the currently installed file. A disposable-profile test was
run with installed Firefox, a local HTML page, `--no-remote`, a private D-Bus
session, and a bubblewrap network namespace. The only GTK test window and browser
window were inside a 1x1 Xephyr display; no host browser window was opened or
focused. The nested X server briefly mapped its tiny host-side window.

### Test results (observed; default test gates only the automatic case)

`tests/test-firefox-accessibility.sh` checks named input/button controls on the
local Firefox page and named controls in a temporary GTK3 app over AT-SPI. Each
case has a separate throwaway profile; GTK bridge modules match the observed
session environment. Network namespace isolation was required and verified by
bubblewrap. No existing profile/settings were read or changed.

| Profile setting | Scoped activation environment | Result |
| --- | --- | --- |
| `accessibility.force_disabled=-1` (automatic) | no `GNOME_ACCESSIBILITY` / `GTK_A11Y` override | **PASS**: Firefox page controls and GTK controls exposed |
| `accessibility.force_disabled=0` | no override (`--matrix` only) | **INCONCLUSIVE/UNAVAILABLE**: GTK controls exposed, but no Firefox application/controls appeared on AT-SPI within 30 s |
| `accessibility.force_disabled=-1` (automatic) | `GNOME_ACCESSIBILITY=1` | **PASS**: Firefox page controls and GTK controls exposed |

The default automatic case and the scoped `GNOME_ACCESSIBILITY=1` case both
passed. The force-0 result is non-gating and inconclusive, not proof that the
preference itself caused the missing application. The GNOME environment result
is evidence that a fresh process with that scoped activation can expose the
page; it does **not** establish that the environment override fixes the user's
precise symptom. The standard automatic case was repeated after the reported
AT-SPI event-interest change and passed again. Each isolated run used its own
AT-SPI bus and a probe that queried the accessibility tree, so it does not test
the main process's event subscriptions. Demand-driven Firefox accessibility
makes AT-SPI consumers/event subscriptions a plausible factor to investigate,
not a verified cause or fix for the existing browser process. The existing
Firefox was not restarted or tested, and its original accessibility failure
remains unresolved. In the test, GTK was explicitly given the session's existing
`GTK_MODULES=gail:atk-bridge`; GNOME activation was the only additional setting.
Do not change global GTK/GNOME settings. A cautious user test is to launch a
separate Firefox with a disposable profile and `GNOME_ACCESSIBILITY=1` scoped to
that command, then check its accessibility tree; do not forward the environment
into a running Firefox and mistake the existing process for the test instance.
For their actual browser, first record the exact symptom and `about:support`
Accessibility state. Avoid recommending `accessibility.force_disabled=0` here.

## Diagnostic script

Run `scripts/diagnose-desktop.sh` for read-only system facts and
`tests/test-firefox-accessibility.sh` for the isolated test. Its default run
(repeated successfully) gates only automatic Firefox/GTK accessibility;
`--matrix` additionally tests
scoped GNOME activation and reports the force-0 variant as non-gating
inconclusive/unavailable when appropriate. It skips if Firefox or isolation/test
prerequisites are missing. The diagnostic does not enumerate windows or
reveal titles, print full process command lines/unfiltered environments, read
Firefox profile files, or write configuration. The test uses only temporary
profiles and kills its own Firefox, GTK, and Xephyr processes on completion.

## Sources

1. Mint Muffin 6.4.1 X11 compositor implementation:
   [meta-compositor-x11.c](https://github.com/linuxmint/muffin/blob/6.4.1/src/compositor/meta-compositor-x11.c),
   [compositor.c](https://github.com/linuxmint/muffin/blob/6.4.1/src/compositor/compositor.c).
2. Installed package evidence: `muffin 6.4.1+xia`, `libmuffin0 6.4.1+xia`,
   `/usr/share/doc/muffin/changelog.gz`; `nm -D
   /usr/lib/x86_64-linux-gnu/libmuffin.so.0` showed the stage accessor and
   unredirect control symbols. This is an installed-package observation, not a
   test of invoking those APIs from an external process.
3. X Composite overlay-window API description:
   [XCompositeGetOverlayWindow](https://www.x.org/releases/X11R7.7/doc/compositeproto/compositeproto.txt).
   Its existence does not guarantee a complete externally readable final output
   or damage stream for a particular driver/compositor.
4. Mozilla Linux ATK/AT-SPI overview:
   [Mozilla Support for Linux/UNIX Assistive Technology Developers](https://www-archive.mozilla.org/access/unix/atspi-support).
   Firefox pref background (historical; use as context, not as version-specific
   proof): [Electrolysis/Accessibility](https://wiki.mozilla.org/Electrolysis/Accessibility).
