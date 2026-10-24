#!/usr/bin/python3
"""Fixed private-display Firefox WM_DELETE_WINDOW lifecycle request.

No arguments, keyboard, pointer, titles, profiles, URLs or host X11 access.
An X11 window's class/PID properties are untrusted: match both against an
actual same-UID Firefox executable before requesting a normal close.
"""
import ctypes as C
import os
import sys

if len(sys.argv) != 1 or os.geteuid() == 0 or os.environ.get("DISPLAY") != ":99":
    sys.exit(1)

X = C.CDLL("libX11.so.6")
P = C.c_void_p
W = C.c_ulong
X.XOpenDisplay.argtypes = [C.c_char_p]
X.XOpenDisplay.restype = P
X.XDefaultRootWindow.argtypes = [P]
X.XDefaultRootWindow.restype = W
X.XInternAtom.argtypes = [P, C.c_char_p, C.c_int]
X.XInternAtom.restype = W
X.XGetWindowProperty.argtypes = [P, W, W, C.c_long, C.c_long, C.c_int, W,
                                 C.POINTER(W), C.POINTER(C.c_int), C.POINTER(W),
                                 C.POINTER(W), C.POINTER(P)]
X.XGetWindowProperty.restype = C.c_int
X.XFree.argtypes = [P]
X.XGetWMProtocols.argtypes = [P, W, C.POINTER(P), C.POINTER(C.c_int)]
X.XGetWMProtocols.restype = C.c_int
X.XSendEvent.argtypes = [P, W, C.c_int, C.c_long, P]
X.XSendEvent.restype = C.c_int
X.XFlush.argtypes = [P]
X.XCloseDisplay.argtypes = [P]

class Data(C.Union):
    _fields_ = [("b", C.c_char * 20), ("s", C.c_short * 10), ("l", C.c_long * 5)]

class ClientMessage(C.Structure):
    _fields_ = [("type", C.c_int), ("serial", W), ("send_event", C.c_int),
                ("display", P), ("window", W), ("message_type", W),
                ("format", C.c_int), ("data", Data)]

# XEvent is a 24-long union (192 bytes on 64-bit Xlib); ClientMessage fits.
class Event(C.Union):
    _fields_ = [("message", ClientMessage), ("pad", C.c_long * 24)]

def property_bytes(display, window, atom, length=128):
    actual, fmt, count, rest, data = W(), C.c_int(), W(), W(), P()
    code = X.XGetWindowProperty(display, window, atom, 0, length, 0, 0,
                                C.byref(actual), C.byref(fmt), C.byref(count),
                                C.byref(rest), C.byref(data))
    try:
        if code != 0 or not data.value or rest.value or fmt.value not in (8, 32):
            return None
        if fmt.value == 8:
            return C.string_at(data, count.value)
        return [C.cast(data, C.POINTER(W))[i] for i in range(count.value)]
    finally:
        if data.value:
            X.XFree(data)

def firefox_pid(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        if os.stat(f"/proc/{pid}").st_uid != os.geteuid():
            return False
        return os.readlink(f"/proc/{pid}/exe") == "/usr/lib/firefox-esr/firefox-esr"
    except (OSError, ValueError):
        return False

display = X.XOpenDisplay(b":99")
if not display:
    sys.exit(1)
try:
    atom = lambda name: X.XInternAtom(display, name.encode("ascii"), 1)
    clients, klass, pid_atom = atom("_NET_CLIENT_LIST"), atom("WM_CLASS"), atom("_NET_WM_PID")
    protocols, delete = atom("WM_PROTOCOLS"), atom("WM_DELETE_WINDOW")
    if not all((clients, klass, pid_atom, protocols, delete)):
        sys.exit(1)
    windows = property_bytes(display, X.XDefaultRootWindow(display), clients, 512)
    if not isinstance(windows, list) or not windows:
        sys.exit(1)
    sent = 0
    for window in windows:
        names = property_bytes(display, window, klass)
        owner = property_bytes(display, window, pid_atom, 1)
        if not isinstance(names, bytes) or not isinstance(owner, list) or len(owner) != 1:
            continue
        classes = names.rstrip(b"\0").split(b"\0")
        if len(classes) < 2 or classes[-1].lower() not in (b"firefox", b"firefox-esr") or not firefox_pid(owner[0]):
            continue
        supported, count = P(), C.c_int()
        if not X.XGetWMProtocols(display, window, C.byref(supported), C.byref(count)):
            continue
        try:
            if not supported.value or delete not in C.cast(supported, C.POINTER(W))[:count.value]:
                continue
        finally:
            if supported.value:
                X.XFree(supported)
        event = Event()
        event.message.type = 33  # ClientMessage
        event.message.send_event = 1
        event.message.display = display
        event.message.window = window
        event.message.message_type = protocols
        event.message.format = 32
        event.message.data.l[0] = delete
        event.message.data.l[1] = 0  # CurrentTime
        if X.XSendEvent(display, window, 0, 0, C.byref(event)):
            sent += 1
    X.XFlush(display)
    sys.exit(0 if sent else 1)
finally:
    X.XCloseDisplay(display)
