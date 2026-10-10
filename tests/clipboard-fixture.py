#!/usr/bin/env python3
"""Only run with DISPLAY and socket allocated by test-clipboard-isolation.sh."""
import ctypes
import json
import os
import socket
import sys
import time

assert os.environ['DISPLAY'] == os.environ['PI_CLIPBOARD_PRIVATE_DISPLAY']
sock = os.environ['COMPUTER_USE_SOCKET']
title = os.environ['PI_CLIPBOARD_TITLE']

def request(payload):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(20)
        conn.connect(sock)
        conn.sendall((json.dumps(payload, ensure_ascii=False) + '\n').encode())
        return json.loads(conn.makefile('rb').readline())

def private_bulgarian_group(lock=False):
    # Test-only XKB change on the explicitly isolated Xephyr server; never
    # executed by the production daemon or against the parent user's display.
    assert os.environ['DISPLAY'] == os.environ['PI_CLIPBOARD_PRIVATE_DISPLAY']
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XkbLockGroup.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]
    x11.XkbLockGroup.restype = ctypes.c_int
    x11.XkbGetState.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p]
    x11.XkbGetState.restype = ctypes.c_int
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    class State(ctypes.Structure):
        _fields_ = [(field, ctypes.c_ubyte) for field in (
            'group', 'locked_group', 'base_group', 'latched_group',
            'mods', 'base_mods', 'latched_mods', 'locked_mods',
            'compat_state', 'grab_mods', 'compat_grab_mods',
            'lookup_mods', 'compat_lookup_mods')]
        _fields_ += [('ptr_buttons', ctypes.c_ushort)]
    display = x11.XOpenDisplay(os.environ['DISPLAY'].encode())
    assert display, 'private X11 display unavailable'
    try:
        if lock:
            assert x11.XkbLockGroup(display, 0x100, 1), 'could not select private Bulgarian group'
            x11.XSync(display, 0)
        state = State()
        assert x11.XkbGetState(display, 0x100, ctypes.byref(state)) == 0
        assert state.group == 1, f'Bulgarian group not active: {state.group}'
    finally:
        x11.XCloseDisplay(display)

if sys.argv[1:] == ['--tk-editor']:
    import tkinter as tk
    root = tk.Tk()
    root.title(title)
    root.geometry('600x150')
    text = tk.StringVar()
    entry = tk.Entry(root, textvariable=text, width=70)
    entry.pack(expand=True)
    def record(*_):
        with open(os.path.join(os.environ['PI_CLIPBOARD_TEST_TMP'], 'tk-entry-value'), 'w', encoding='utf-8') as out:
            out.write(text.get())
    text.trace_add('write', record)
    record()
    # Test-owned Tk window: establish the caret before declaring focus in IPC.
    root.after(350, entry.focus_force)
    def focus_diagnostic():
        with open(os.path.join(os.environ['PI_CLIPBOARD_TEST_TMP'], 'tk-focus'), 'w') as out:
            out.write(str(root.focus_get() == entry))
    root.after(650, focus_diagnostic)
    root.mainloop()
    sys.exit(0)

if sys.argv[1:] == ['fallback-worker']:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        result = request({'cmd': 'observe'})
        windows = result.get('windows', [])
        if len([w for w in windows if w['title'] == title]) == 1 \
                and any(w['title'] == title and w.get('active') for w in windows):
            break
        time.sleep(.1)
    else:
        raise AssertionError('private Tk window not active')
    # An explicitly declared visual/previous-focus path must not silently
    # override a semantic target nor work without the active-window title.
    assert not request({'cmd': 'paste_text', 'text': 'no', 'window_title': title})['ok']
    assert not request({'cmd': 'paste_text', 'text': 'no', 'window_title': title,
                        'focus_verified': True, 'target': {'role': 'entry'}})['ok']
    assert not request({'cmd': 'paste_text', 'text': 'no', 'window_title': 'wrong',
                        'focus_verified': True})['ok']
    payload = 'Bulgarian Български ∑'
    focus_path = os.path.join(os.environ['PI_CLIPBOARD_TEST_TMP'], 'tk-focus')
    for _ in range(20):
        if os.path.exists(focus_path):
            with open(focus_path) as inp:
                assert inp.read() == 'True', 'private Tk field was not focused'
            break
        time.sleep(.1)
    else:
        raise AssertionError('private Tk focus state was not ready')
    pasted = request({'cmd': 'paste_text', 'text': payload, 'window_title': title,
                      'focus_verified': True})
    if not pasted['ok']:
        value_path = os.path.join(os.environ['PI_CLIPBOARD_TEST_TMP'], 'tk-entry-value')
        with open(value_path, encoding='utf-8') as inp:
            observed_length = len(inp.read())
        raise AssertionError(f'paste not confirmed (fixture field length={observed_length}): {pasted}')
    assert pasted['paste']['focus_verification'] == 'declared_active_window', pasted
    assert pasted['paste']['shortcut'] == 'ctrl_v', pasted
    assert pasted['paste']['status'] == 'dispatched' and pasted['paste']['verified'] is False
    value_path = os.path.join(os.environ['PI_CLIPBOARD_TEST_TMP'], 'tk-entry-value')
    for _ in range(40):
        if os.path.exists(value_path):
            with open(value_path, encoding='utf-8') as inp:
                if inp.read() == payload:
                    break
        time.sleep(.1)
    else:
        raise AssertionError('private Tk entry did not receive expected UTF-8 paste')
    assert request({'cmd': 'stop'})['input_stopped']
    print('PASS: private Tk declared-focus fallback, exact active window, no target override, Stop')
    sys.exit(0)

assert sys.argv[1:] == ['editor-worker']
deadline = time.monotonic() + 65
while time.monotonic() < deadline:
    result = request({'cmd': 'observe'})
    windows = result.get('windows', [])
    nodes = (result.get('snapshot') or {}).get('nodes', [])
    by_id = {node['id']: node for node in nodes}
    editors = []
    for node in nodes:
        if node.get('role') != 'text' or node.get('focused') is not True:
            continue
        parent = node.get('parent')
        while parent in by_id:
            ancestor = by_id[parent]
            if title in ancestor.get('name', ''):
                editors.append(node)
                break
            parent = ancestor.get('parent')
    active = [w['title'] for w in windows if w.get('active')]
    if len(editors) == 1 and len(active) == 1 and title in active[0]:
        break
    time.sleep(.2)
else:
    raise AssertionError(f'isolated editor unavailable: active={active!r}, title={title!r}, '
                         f'text_nodes={[(n.get("name"), n.get("focused")) for n in nodes if n.get("role") == "text"][:8]!r}, '
                         f'windows={[w.get("title") for w in windows]!r}')

editor = editors[0]
active_title = active[0]
assert not request({'cmd': 'paste_text', 'text': 'wrong', 'target': {'id': editor['id']},
                    'window_title': 'not the active title', 'focus_verified': True})['ok']
assert not request({'cmd': 'paste_text', 'text': 'wrong', 'target': {'role': 'password text'},
                    'window_title': active_title, 'focus_verified': True})['ok']
text = ('Български Deutsch ∑\n' * 200)
assert len(text.encode()) < 65536
if os.environ.get('PI_CLIPBOARD_TEST_BG') == '1':
    private_bulgarian_group(lock=True)
result = request({'cmd': 'paste_text', 'text': text, 'target': {'id': editor['id']},
                  'window_title': active_title})
assert result['ok'], result
paste = result['paste']
assert paste['status'] == 'dispatched' and paste['focus_verification'] == 'semantic', paste
assert paste['shortcut'] == ('shift_insert' if os.environ.get('PI_CLIPBOARD_TEST_BG') == '1' else 'ctrl_v'), paste
assert paste['keyboard_events'] == 4 and not paste['verified'], paste
assert paste['clipboard_restored'], paste
for _ in range(50):
    node = request({'cmd': 'inspect', 'id': editor['id']})['node']
    if node.get('value') == text:
        break
    time.sleep(.1)
else:
    value = node.get('value') or ''
    raise AssertionError(f'isolated editor did not reflect exact paste: actual_len={len(value)}, expected_len={len(text)}, '
                         f'prefix={value[:70]!r}, expected_prefix={text[:70]!r}')
if os.environ.get('PI_CLIPBOARD_TEST_BG') == '1':
    private_bulgarian_group()  # production paste did not change the group
assert request({'cmd': 'stop'})['input_stopped']
assert not request({'cmd': 'paste_text', 'text': 'should not be entered',
                    'target': {'id': editor['id']}, 'window_title': active_title})['ok']
if os.environ.get('PI_CLIPBOARD_TEST_BG') == '1':
    print('PASS: private Xed semantic UTF-8 paste under Bulgarian XKB group; group unchanged')
else:
    print('PASS: private Xed exact focused field, multiline UTF-8, wrong title, Stop')
