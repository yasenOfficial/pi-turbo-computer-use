#!/usr/bin/env python3
"""Read only the disposable private-session GTK controls, before Brave is launched."""
import time
import pyatspi

want = {'Pi Brave GTK probe input', 'Pi Brave GTK probe button'}
found = set()
end = time.monotonic() + 5
while time.monotonic() < end:
    todo = [pyatspi.Registry.getDesktop(0)]
    seen = 0
    while todo and seen < 200:
        obj = todo.pop()
        seen += 1
        try:
            name = obj.name or ''
            if name in want:
                found.add(name)
            if found == want:
                print('GTK_PRIVATE_REGISTRY_OK', flush=True)
                raise SystemExit(0)
            for i in range(min(obj.childCount, 40)):
                todo.append(obj[i])
        except (SystemExit, KeyboardInterrupt):
            raise
        except Exception:
            pass
    time.sleep(.2)
print('GTK_PRIVATE_REGISTRY_MISSING ' + ','.join(sorted(found)), flush=True)
raise SystemExit(1)
