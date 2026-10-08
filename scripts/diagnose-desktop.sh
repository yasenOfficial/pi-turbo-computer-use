#!/usr/bin/env bash
# Read-only diagnostics for X11/Cinnamon capture and Firefox AT-SPI.
# Intentionally avoids window titles, profile data, browsing data, and settings writes.
set -u

section() { printf '\n--- %s ---\n' "$1"; }

section 'OS and session (allowlisted environment only)'
printf 'kernel=%s\n' "$(uname -srmo 2>/dev/null || true)"
for key in XDG_SESSION_TYPE XDG_CURRENT_DESKTOP DESKTOP_SESSION DISPLAY WAYLAND_DISPLAY GTK_MODULES GTK_PATH NO_AT_BRIDGE; do
    value="${!key-}"
    printf '%s=%s\n' "$key" "${value:-<unset>}"
done

section 'Installed relevant package versions'
dpkg-query -W -f='${binary:Package}\t${Version}\t${db:Status-Status}\n' \
    muffin cinnamon firefox at-spi2-core libatk-bridge2.0-0t64 libxdamage1 2>/dev/null || true

section 'Relevant process identities (no full command lines)'
ps -eo pid=,comm= | awk '$2 == "cinnamon" || $2 ~ /^(muffin|firefox|firefox-bin|at-spi)/ {print}'

section 'Firefox executable/version and allowlisted environment'
if command -v firefox >/dev/null 2>&1; then
    readlink -f "$(command -v firefox)" 2>/dev/null || true
    firefox --version 2>&1 | head -1
fi
for pid in $(pgrep -x firefox-bin 2>/dev/null || true); do
    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
    printf 'pid=%s executable=%s\n' "$pid" "${exe:-<unavailable>}"
    if [ -r "/proc/$pid/environ" ]; then
        tr '\0' '\n' < "/proc/$pid/environ" | awk -F= '$1 ~ /^(DISPLAY|XDG_SESSION_TYPE|GTK_MODULES|GTK_PATH|NO_AT_BRIDGE|AT_SPI_BUS_ADDRESS|MOZ_ENABLE_WAYLAND)$/ {print}'
    fi
done

section 'AT-SPI service state (service names only)'
addr=''
if command -v gdbus >/dev/null 2>&1; then
    reply=$(gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress 2>/dev/null || true)
    addr=$(printf '%s' "$reply" | sed -n "s/.*'\\([^']*\\)'.*/\\1/p")
fi
if [ -n "$addr" ]; then
    printf 'AT-SPI bus address is available (value redacted).\n'
    gdbus call --address="$addr" --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames 2>/dev/null \
      | grep -o 'org\.a11y\.atspi\.Registry' | sort -u || true
else
    printf 'AT-SPI bus address unavailable.\n'
fi

section 'Accessibility setting values (read only)'
for schema in org.gnome.desktop.interface org.cinnamon.desktop.interface; do
    if gsettings list-schemas 2>/dev/null | grep -Fxq "$schema"; then
        printf '%s toolkit-accessibility=' "$schema"
        gsettings get "$schema" toolkit-accessibility 2>&1 || true
    fi
done

section 'X11 compositor and extensions (no window enumeration)'
if [ -n "${DISPLAY-}" ] && command -v xdpyinfo >/dev/null 2>&1; then
    xdpyinfo -queryExtensions 2>/dev/null | awk '/^[[:space:]]*(Composite|DAMAGE|XFIXES)[[:space:]]/ {print $1}' | sort -u
fi
if [ -n "${DISPLAY-}" ] && command -v xprop >/dev/null 2>&1; then
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | sed -E 's/window id # 0x[0-9a-fA-F]+/window id # <redacted>/'
fi

cat <<'NOTE'
Interpretation: XDamage on the root drawable alone is not a complete source for a
composited desktop. It does not report damage to offscreen redirected client
surfaces or guarantee notification of the compositor's final scene output.
This script does not capture pixels, alter settings, inspect browser profiles,
or interact with windows.
NOTE
