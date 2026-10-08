#!/usr/bin/env python3
"""Private-session AT-SPI event recorder; only disposable Brave/Xephyr metadata."""
import json
import sys
import pyatspi

title = sys.argv[1]

def on_event(event):
    try:
        source = event.source
        name = source.name or ''
        role = source.getRoleName()
        # This monitor sees the private bus only. Avoid logging arbitrary node text.
        if title in name or (role == 'application' and 'brave' in name.lower()):
            print(json.dumps({'type': event.type, 'role': role,
                              'source': 'owned-title' if title in name else 'brave-app'}), flush=True)
    except Exception:
        pass

pyatspi.Registry.registerEventListener(on_event, 'object:')
pyatspi.Registry.registerEventListener(on_event, 'window:')
pyatspi.Registry.start()
