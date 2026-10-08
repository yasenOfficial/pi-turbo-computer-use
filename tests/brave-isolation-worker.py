#!/usr/bin/env python3
"""Only called inside test-brave-desktop-isolation.sh's private PID/network/X namespace."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path('/tmp')
SOURCE = Path(os.environ['PI_BRAVE_TEST_ROOT'])
BRAVE = os.environ['PI_BRAVE_BIN']
DAEMON = os.environ['DAEMON_BIN']
FORCE = os.environ.get('PI_BRAVE_FORCE_A11Y') == '1'
BRIDGE = os.environ.get('PI_BRAVE_A11Y_MODE', 'plain') == 'bridge'
children = []


def spawn(args, log, env=None):
    f = open(log, 'wb')
    p = subprocess.Popen(args, stdout=f, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    f.close()
    children.append(p)
    return p


def command(args, timeout=3, env=None):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)


def request(path, payload):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(8)
        s.connect(str(path))
        s.sendall((json.dumps(payload) + '\n').encode())
        data = s.makefile('rb').readline()
    if not data:
        raise RuntimeError('daemon closed IPC without reply')
    return json.loads(data)


def brave_pids(profile):
    # PID namespace is private; filter exact unique profile argument, never host processes.
    result = []
    needle = ('--user-data-dir=' + str(profile)).encode()
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if needle in (proc / 'cmdline').read_bytes().split(b'\0'):
                result.append(int(proc.name))
        except (OSError, PermissionError):
            pass
    return sorted(result)


def windows(title):
    p = command(['wmctrl', '-l'], timeout=3)
    if p.returncode:
        return []
    return [line.split()[0].lower() for line in p.stdout.splitlines()
            if len(line.split(maxsplit=3)) == 4 and title in line.split(maxsplit=3)[3]]


def xid_state(xid):
    p = command(['xprop', '-id', xid, 'WM_STATE', '_NET_WM_STATE'], timeout=3)
    return p.stdout.replace('\n', ' ')[:240] if p.returncode == 0 else 'XID missing'


def active_xid():
    p = command(['xprop', '-root', '_NET_ACTIVE_WINDOW'], timeout=3)
    return p.stdout.strip().rsplit(' ', 1)[-1].lower() if p.returncode == 0 else 'unknown'


def snapshot(path, title):
    reply = request(path, {'cmd': 'observe'})
    nodes = reply.get('snapshot', {}).get('nodes', [])
    own = any(title in w.get('title', '') for w in reply.get('windows', []))
    # Only report metadata for disposable local-page accessibility nodes.
    targets = {'Pi Brave isolation input', 'Pi Brave isolation action'}
    gtk_targets = {'Pi Brave GTK probe input', 'Pi Brave GTK probe button'}
    names = {str(n.get('name', '')) for n in nodes}
    found = sorted(targets & names)
    owned_names = sorted({name[:90] for name in names if name.startswith('Pi Brave')})[:12]
    return {'ok': reply.get('ok'), 'window': own, 'nodes': len(nodes), 'controls': found,
            'fixture_names': owned_names, 'gtk_controls': sorted(gtk_targets & names),
            'brave_app': any(n.get('role') == 'application' and 'brave' in str(n.get('name', '')).lower()
                             for n in nodes),
            'error': str(reply.get('error', ''))[:200]}


def semantic_roundtrip(sock, title, xid):
    """Only interact with exactly one node under the unique disposable page title."""
    wanted = ('Pi Brave isolation input', 'Pi Brave isolation action')

    def owned_nodes():
        reply = request(sock, {'cmd': 'observe'})
        if not reply.get('ok'):
            raise RuntimeError('semantic observe rejected: ' + str(reply.get('error')))
        if windows(title) != [xid]:
            raise RuntimeError('owned XID changed/duplicated before semantic action')
        nodes = reply.get('snapshot', {}).get('nodes', [])
        by_id = {n['id']: n for n in nodes}
        matched = {}
        diagnostics = []
        for n in nodes:
            if not ((n.get('name') == wanted[0] and n.get('role') == 'entry') or
                    (n.get('name') == wanted[1] and n.get('role') == 'push button')):
                continue
            parents = []
            ancestor = n.get('parent')
            seen = set()
            while ancestor in by_id and ancestor not in seen:
                seen.add(ancestor)
                parent = by_id[ancestor]
                parents.append(str(parent.get('name', '')))
                ancestor = parent.get('parent')
            diagnostics.append({'name': n.get('name'), 'role': n.get('role'),
                                'ancestors': [s[:75] for s in parents[:8]]})
            if any(title in s for s in parents):
                matched.setdefault(n['name'], []).append(n)
        if any(len(matched.get(name, [])) != 1 for name in wanted):
            raise RuntimeError('fixture target not uniquely under own title counts=' +
                               repr({k: len(v) for k, v in matched.items()}) +
                               ' candidates=' + str(diagnostics)[:600])
        return matched, nodes

    targets, _ = owned_nodes()
    entry = targets[wanted[0]][0]
    button = targets[wanted[1]][0]
    text = 'Привіт, світ — українська ї ✓'
    reply = request(sock, {'cmd': 'set_text', 'id': entry['id'], 'text': text})
    id_set_error = str(reply.get('error', ''))[:180] if not reply.get('ok') else None
    if id_set_error:
        # Chromium may expose an entry but not EditableText.SetTextContents.
        # Never claim a Unicode semantic roundtrip in that configuration.
        fresh, _ = owned_nodes()
        reply = request(sock, {'cmd': 'click', 'id': fresh[wanted[0]][0]['id']})
        if not reply.get('ok'):
            raise RuntimeError('owned entry click rejected: ' + str(reply.get('error')))
        if int(active_xid(), 16) != int(xid, 16):
            raise RuntimeError('owned entry did not activate own Xephyr XID')
        fresh, _ = owned_nodes()
        if fresh[wanted[0]][0].get('focused') is not True:
            raise RuntimeError('owned entry is not semantically focused before typing')
        text = 'Pi Brave ASCII probe'
        reply = request(sock, {'cmd': 'set_text', 'text': text})
        if not reply.get('ok'):
            raise RuntimeError('owned focused-entry typing rejected: ' + str(reply.get('error')))
    fresh, _ = owned_nodes()  # revalidate XID, title ancestry, unique control before reading
    value = fresh[wanted[0]][0].get('value')
    if value != text:
        inspected = request(sock, {'cmd': 'inspect', 'id': fresh[wanted[0]][0]['id']})
        value = inspected.get('node', {}).get('value')
    if value != text:
        raise RuntimeError('owned entry semantic value mismatch: ' + repr(value)[:100])
    fresh, _ = owned_nodes()  # revalidate again immediately before button action
    reply = request(sock, {'cmd': 'click', 'id': fresh[wanted[1]][0]['id']})
    if not reply.get('ok'):
        raise RuntimeError('owned local button click rejected: ' + str(reply.get('error')))
    def click_visible():
        _, nodes = owned_nodes()
        return any('Pi Brave clicked ✓' in str(n.get('name', '')) or
                   'Pi Brave clicked ✓' in str(n.get('value', '')) for n in nodes)
    wait_for(click_visible, 5, 'local page button response in accessibility graph')
    return {'unicode_value': id_set_error is None, 'id_set_error': id_set_error,
            'ascii_value': id_set_error is not None, 'local_button_response': True,
            'input_role': entry.get('role'), 'button_role': button.get('role')}


def wait_for(test, seconds, label):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = test()
        if value:
            return value
        time.sleep(.25)
    raise RuntimeError('timeout waiting for ' + label)


def one_case(index, mode, overlay, native):
    base = ROOT / ('case-' + str(index))
    base.mkdir(mode=0o700)
    title = 'pi-brave-isolation-' + uuid.uuid4().hex
    page = base / 'page.html'
    page.write_text('<!doctype html><html><meta charset="utf-8"><title>' + title +
                    '</title><body><label for="test">Pi Brave isolation input</label>' +
                    '<input id="test"><button type="button" onclick="document.getElementById(' +
                    "'result').textContent='Pi Brave clicked ✓'\"" +
                    '>Pi Brave isolation action</button><p id="result">Pi Brave ready</p></body></html>')
    profile = base / 'profile'
    profile.mkdir(mode=0o700)
    env = os.environ.copy()
    env.update(HOME=str(base / 'home'), XDG_CONFIG_HOME=str(base / 'config'),
               XDG_CACHE_HOME=str(base / 'cache'), XDG_DATA_HOME=str(base / 'data'),
               XDG_DATA_DIRS=str(base / 'empty-system-data'), XDG_RUNTIME_DIR=str(base / 'runtime'),
               XDG_CURRENT_DESKTOP='PiBraveIsolation', COMPUTER_USE_SOCKET=str(base / 'daemon.sock'),
               COMPUTER_USE_CONFIG=str(base / 'daemon.toml'), COMPUTER_USE_OVERLAY=str(int(overlay)),
               COMPUTER_USE_DEBUG='0')
    for key in ('AT_SPI_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE',
                'GTK_MODULES', 'GNOME_ACCESSIBILITY', 'ACCESSIBILITY_ENABLED',
                'CHROME_USER_DATA_DIR', 'CHROME_CONFIG_HOME'):
        env.pop(key, None)
    for d in ('home', 'config', 'cache', 'data/applications', 'empty-system-data', 'runtime'):
        (base / d).mkdir(parents=True, mode=0o700, exist_ok=True)
    (base / 'daemon.toml').write_text('[daemon]\noverlay = ' + str(overlay).lower() + '\n')
    args = [BRAVE, '--user-data-dir=' + str(profile), '--no-first-run',
            '--no-default-browser-check', '--disable-background-networking',
            '--disable-component-update', '--disable-features=MediaRouter',
            '--disable-setuid-sandbox', '--new-window']
    if FORCE:
        args.append('--force-renderer-accessibility')  # Explicit test variation only.
    args.append(page.as_uri())
    if native:
        desktop = base / 'data/applications/pi-brave-isolation.desktop'
        desktop.write_text('[Desktop Entry]\nType=Application\nName=Pi Brave Isolation ' + title +
                           '\nExec=' + ' '.join(args) + '\nTerminal=false\n')
    wm_env = env.copy()
    # Metacity needs system GSettings schemas; only the daemon's app registry
    # uses the restricted XDG_DATA_DIRS fixture.
    wm_env['XDG_DATA_DIRS'] = '/usr/local/share:/usr/share'
    wm = spawn(['metacity', '--composite' if overlay else '--no-composite'], base / 'wm.log', wm_env)
    browser = None
    daemon = None
    events = None
    gtk = None
    properties = None
    lease = None
    native_started = None
    result = {'case': index, 'mode': mode, 'overlay': overlay, 'native': native,
              'force_a11y': FORCE, 'a11y_mode': 'bridge' if BRIDGE else 'plain'}
    case_started = time.monotonic()
    try:
        wait_for(lambda: 'Metacity' in command(['wmctrl', '-m'], timeout=2, env=env).stdout,
                 8, 'nested Metacity EWMH window manager')
        if mode != 'baseline' and BRIDGE:
            from gi.repository import Gio, GLib
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)  # dbus-run-session, not host bus
            address = bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus',
                                    'GetAddress', None, GLib.VariantType('(s)'),
                                    Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
            if not address.startswith('unix:'):
                raise RuntimeError('private accessibility bus address is not Unix')
            result['private_a11y_bus'] = True  # never print an address or host information
            for name in ('IsEnabled', 'ScreenReaderEnabled'):
                try:
                    old = bus.call_sync('org.a11y.Bus', '/org/a11y/bus',
                                        'org.freedesktop.DBus.Properties', 'Get',
                                        GLib.Variant('(ss)', ('org.a11y.Status', name)),
                                        GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 3000, None)
                    result['status_' + name + '_before'] = old.unpack()[0]
                    bus.call_sync('org.a11y.Bus', '/org/a11y/bus',
                                  'org.freedesktop.DBus.Properties', 'Set',
                                  GLib.Variant('(ssv)', ('org.a11y.Status', name,
                                                         GLib.Variant('b', True))),
                                  None, Gio.DBusCallFlags.NONE, 3000, None)
                    result['status_' + name + '_set'] = True
                except Exception as exc:
                    result['status_' + name + '_error'] = str(exc)[:160]
            env.update(AT_SPI_BUS_ADDRESS=address, GTK_MODULES='gail:atk-bridge',
                       GNOME_ACCESSIBILITY='1', ACCESSIBILITY_ENABLED='1')
            gtk = spawn(['python3', str(SOURCE / 'tests/brave-isolation-gtk-probe.py')],
                        base / 'gtk.log', env)
            registry = command(['python3', str(SOURCE / 'tests/brave-isolation-probe-registry.py')],
                               timeout=9, env=env)
            result['gtk_private_registry'] = registry.stdout.strip()[:120]
            if registry.returncode:
                raise RuntimeError('private AT-SPI GTK control probe failed: ' +
                                   (registry.stdout + registry.stderr)[-200:])
        browser_env = env.copy()
        browser_env['XDG_DATA_DIRS'] = '/usr/local/share:/usr/share'
        if os.environ.get('PI_BRAVE_BROWSER_GTK_MODULES', '1') == '0':
            browser_env.pop('GTK_MODULES', None)
        result['browser_gtk_modules'] = browser_env.get('GTK_MODULES', '')
        if mode != 'baseline':
            events = spawn(['python3', str(SOURCE / 'tests/brave-isolation-events.py'), title],
                           base / 'events.log', env)
            time.sleep(.3)
        browser = spawn(args, base / 'brave.log', browser_env)
        xids = wait_for(lambda: windows(title), 28, 'unique owned Brave title')
        if len(xids) != 1:
            raise RuntimeError('ambiguous owned Brave windows: ' + repr(xids))
        xid = xids[0]
        result['xid_before'] = xid
        result['pid_before'] = brave_pids(profile)
        result['initial_state'] = xid_state(xid)
        if not result['pid_before']:
            raise RuntimeError('Brave window appeared but profile-matched process absent')
        if mode not in ('baseline', 'bridge-baseline'):
            daemon = spawn([DAEMON], base / 'daemon.log', env)
            if BRIDGE:
                properties = spawn(['python3', str(SOURCE / 'tests/brave-isolation-properties.py'),
                                    env['AT_SPI_BUS_ADDRESS'], str(daemon.pid)],
                                   base / 'properties.log', env)
                time.sleep(.3)
            sock = base / 'daemon.sock'
            wait_for(lambda: sock.is_socket(), 12, 'isolated daemon socket')
            if sock.stat().st_mode & 0o777 != 0o600:
                raise RuntimeError('daemon socket permissions not 0600')
            started = time.monotonic()
            result['observe_before'] = snapshot(sock, title)
            result['observe_before_ms'] = round((time.monotonic() - started) * 1000)
            if BRIDGE:
                result['gtk_probe_registered'] = result['gtk_private_registry'] == 'GTK_PRIVATE_REGISTRY_OK'
                # The daemon snapshot may omit this separate GTK utility window;
                # the pre-browser private-registry check is the independent proof.
                result['gtk_in_daemon_snapshot'] = result['observe_before']['gtk_controls']
                if not result['observe_before']['brave_app']:
                    raise RuntimeError('Brave application absent from active private AT-SPI graph')
                result['web_controls_available'] = set(result['observe_before']['controls']) == {
                    'Pi Brave isolation input', 'Pi Brave isolation action'}
                if FORCE and not result['web_controls_available']:
                    raise RuntimeError('forced Brave local-page controls absent from active AT-SPI graph')
                if mode == 'observe' and result['web_controls_available']:
                    started = time.monotonic()
                    result['semantic'] = semantic_roundtrip(sock, title, xid)
                    result['semantic_ms'] = round((time.monotonic() - started) * 1000)
            if mode == 'overlay-focus':
                lease = str(uuid.uuid4())
                reply = request(sock, {'cmd': 'control_activity', 'action': 'begin',
                                       'token': lease, 'ttl_ms': 30000})
                if not reply.get('ok'):
                    raise RuntimeError('overlay activity rejected: ' + repr(reply))
            if mode in ('focus', 'overlay-focus'):
                started = time.monotonic()
                reply = request(sock, {'cmd': 'focus_window', 'title': title})
                result['focus_reply'] = {'ok': reply.get('ok'), 'error': reply.get('error')}
                if not reply.get('ok'):
                    raise RuntimeError('focus rejected: ' + str(reply.get('error')))
                wait_for(lambda: int(active_xid(), 16) == int(xid, 16), 5,
                         'actual _NET_ACTIVE_WINDOW=' + xid)
                result['active_xid'] = active_xid()
                result['focus_ack_ms'] = round((time.monotonic() - started) * 1000)
            if native:
                started = time.monotonic()
                native_started = started
                reply = request(sock, {'cmd': 'launch_app', 'app_id': 'pi-brave-isolation.desktop'})
                result['launch_ack_ms'] = round((time.monotonic() - started) * 1000)
                result['launch_reply'] = {'ok': reply.get('ok'), 'launch': reply.get('launch'),
                                          'error': reply.get('error')}
                if not reply.get('ok'):
                    raise RuntimeError('GIO launch rejected: ' + str(reply.get('error')))
        samples = []
        # Repeated observations exercise AT-SPI registry/cache while tracking the X client.
        for i in range(7):
            time.sleep(.75)
            sample = {'t': i, 'pid_count': len(brave_pids(profile)), 'xids': windows(title),
                      'state': xid_state(xid), 'active': active_xid(),
                      'wrapper_exit': browser.poll(), 'wm_exit': wm.poll(),
                      'daemon_exit': daemon.poll() if daemon else None}
            if daemon and daemon.poll() is None:
                try:
                    sample['at'] = snapshot(base / 'daemon.sock', title)
                except Exception as exc:
                    sample['at_error'] = str(exc)[:200]
            if native_started and 'launch_second_xid_ms' not in result and len(sample['xids']) > 1:
                result['launch_second_xid_ms'] = round((time.monotonic() - native_started) * 1000)
            samples.append(sample)
        result['samples'] = samples
        result['pid_after'] = brave_pids(profile)
        result['xid_after'] = windows(title)
        result['final_state'] = xid_state(xid)
        result['outcome'] = ('WINDOW_DISAPPEARED' if xid not in result['xid_after'] else
                             'BROWSER_PROCESS_GONE' if not result['pid_after'] else
                             'DAEMON_GONE' if daemon and daemon.poll() is not None else
                             'WINDOW_AND_PROCESS_ALIVE')
        if result['outcome'] == 'WINDOW_AND_PROCESS_ALIVE':
            if native and not any(other != xid for other in result['xid_after']):
                result['outcome'] = 'GIO_ACCEPTED_BUT_NO_SECOND_OWNED_WINDOW'
            if BRIDGE and FORCE and daemon:
                result['web_controls_persistent'] = all(
                    set(s.get('at', {}).get('controls', [])) ==
                    {'Pi Brave isolation input', 'Pi Brave isolation action'} for s in samples)
                if not result['web_controls_persistent']:
                    result['outcome'] = 'AT_CONTROLS_DISAPPEARED'
        if lease and daemon and daemon.poll() is None:
            result['lease_end_ok'] = request(base / 'daemon.sock',
                                             {'cmd': 'control_activity', 'action': 'end', 'token': lease}).get('ok')
    except Exception as exc:
        result['outcome'] = 'INCONCLUSIVE_SETUP_OR_IPC'
        result['error'] = str(exc)[:850]
        if browser and 'xid_before' in result:
            result['pid_after'] = brave_pids(profile)
            result['xid_after'] = windows(title)
            result['final_state'] = xid_state(result['xid_before'])
            if result['xid_before'] not in result['xid_after']:
                result['outcome'] = 'WINDOW_DISAPPEARED_DURING_ACTION'
    finally:
        result['runtime_ms'] = round((time.monotonic() - case_started) * 1000)
        event_log = base / 'events.log'
        result['at_events'] = [json.loads(line) for line in event_log.read_text().splitlines()[-30:]
                               if line.startswith('{')] if event_log.exists() else []
        result['event_monitor_exit'] = events.poll() if events else None
        property_log = (base / 'properties.log').read_text(errors='replace') if properties else ''
        result['daemon_private_at_properties'] = {
            key: sum(line == json.dumps({'property': key}) for line in property_log.splitlines())
            for key in ('Get', 'GetAll')}
        if BRIDGE and FORCE and daemon and result['outcome'] == 'WINDOW_AND_PROCESS_ALIVE':
            counters = result['daemon_private_at_properties']
            if not counters['Get'] or counters['GetAll']:
                result['outcome'] = 'PROPERTIES_GET_ONLY_NOT_CONFIRMED'
        result['property_monitor_exit'] = properties.poll() if properties else None
        result['gtk_log_tail'] = (base / 'gtk.log').read_text(errors='replace')[-400:] if (base / 'gtk.log').exists() else ''
        result['brave_log_tail'] = (base / 'brave.log').read_text(errors='replace')[-900:] if (base / 'brave.log').exists() else ''
        result['brave_abort_logged'] = 'Aborted' in result['brave_log_tail']
        result['daemon_log_tail'] = (base / 'daemon.log').read_text(errors='replace')[-900:] if (base / 'daemon.log').exists() else ''
        # Only our own subprocess groups; the private PID namespace reaps GIO children.
        for proc in (browser, daemon, events, properties, gtk, wm):
            if proc and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for proc in (browser, daemon, events, properties, gtk, wm):
            if proc:
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if proc.poll() is None:
                        os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main():
    # Xephyr is the ONLY process allowed to connect to the inherited host display.
    host = os.environ['DISPLAY']
    number = 93
    while (ROOT / ('.X' + str(number) + '-lock')).exists() or (ROOT / '.X11-unix' / ('X' + str(number))).exists():
        number += 1
    display = ':' + str(number)
    xephyr = spawn(['Xephyr', '-ac', '-noreset', '-no-host-grab', '-screen', '1100x800',
                    display, '-display', host], ROOT / 'xephyr.log')
    try:
        wait_for(lambda: command(['xdpyinfo', '-display', display], timeout=2).returncode == 0,
                 12, 'Xephyr display')
        os.environ['DISPLAY'] = display
        os.environ.pop('XAUTHORITY', None)
        cases = [(1, 'baseline', False, False)]
        if BRIDGE:
            cases.append((0, 'bridge-baseline', False, False))  # no daemon: attribution control
        cases += [(2, 'observe', False, False), (3, 'focus', False, False),
                  (4, 'overlay-focus', True, False), (5, 'native-launch', False, True)]
        if os.environ.get('PI_BRAVE_CASE'):
            cases = [case for case in cases if str(case[0]) == os.environ['PI_BRAVE_CASE']]
            if not cases:
                raise ValueError('PI_BRAVE_CASE is not in the selected matrix')
        results = [one_case(*case) for case in cases]
        print('SUMMARY ' + json.dumps([{'case': r['case'], 'outcome': r['outcome'],
                                        'controls': r.get('samples', [{}])[-1].get('at', {}).get('controls', [])}
                                       for r in results]), flush=True)
        return 1 if any(r['outcome'] != 'WINDOW_AND_PROCESS_ALIVE' for r in results) else 0
    finally:
        if xephyr.poll() is None:
            os.killpg(xephyr.pid, signal.SIGTERM)
        xephyr.wait(timeout=5)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print('MATRIX_SETUP_FAILURE: ' + repr(exc), flush=True)
        sys.exit(2)
