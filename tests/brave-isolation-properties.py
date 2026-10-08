#!/usr/bin/env python3
"""Count only daemon-sent AT-SPI Properties.Get/GetAll on the private test bus."""
import json
import os
import re
import subprocess
import sys
import gi
from gi.repository import Gio, GLib

address, daemon_pid = sys.argv[1], int(sys.argv[2])
bus = Gio.DBusConnection.new_for_address_sync(
    address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
    Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
monitor = subprocess.Popen(
    ['dbus-monitor', '--address', address,
     "type='method_call',interface='org.freedesktop.DBus.Properties'"],
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
header = re.compile(r'^method call .*sender=(:[\w.]+).*interface=org\.freedesktop\.DBus\.Properties; member=(GetAll|Get)\b')
known = {}
try:
    for line in monitor.stdout:
        match = header.search(line)
        if not match:
            continue
        sender, method = match.groups()
        if sender not in known:
            try:
                response = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                                         'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                                         GLib.Variant('(s)', (sender,)), GLib.VariantType('(u)'),
                                         Gio.DBusCallFlags.NONE, 1500, None)
                known[sender] = response.unpack()[0]
            except Exception:
                known[sender] = None
        if known[sender] == daemon_pid:
            print(json.dumps({'property': method}), flush=True)
finally:
    monitor.terminate()
    monitor.wait(timeout=2)
