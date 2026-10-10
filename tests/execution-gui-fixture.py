#!/usr/bin/env python3
"""Offline fixture worker; ONLY via test-execution-gui-isolation.sh's private PID/net/X namespace."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(os.environ['PI_EXECUTION_ROOT'])
TMP = Path('/tmp')
TITLE = 'PiExecutionFixture' + uuid.uuid4().hex[:12]
TEXT = 'Първи ред: Български текст.\nSecond line: English text ✓\nТрети ред: Unicode — готово.'
ASCII = 'abcdefghijklmnopqrstuvwxyz' * 5 + 'abcdefghijklmnopqrst'  # exactly 150 unshifted keys
children = []


def start(args, name, env=None):
    log = open(TMP / (name + '.log'), 'wb')
    try:
        process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=True)
    finally:
        log.close()
    children.append(process)
    return process


def await_condition(fn, seconds):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = fn()
        if value:
            return value
        time.sleep(.2)
    raise TimeoutError('fixture readiness/verification timed out')


def request(data, tally):
    tally['daemon_requests'] += 1
    cmd = data['cmd']
    if cmd in ('click', 'keypress', 'paste_text', 'set_text', 'focus_window', 'type'):
        tally['input_dispatch_requests'] += 1
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(12)
        conn.connect(str(TMP / 'daemon.sock'))
        conn.sendall((json.dumps(data, ensure_ascii=False) + '\n').encode())
        packet = conn.makefile('rb').readline()
    if not packet:
        raise RuntimeError('private daemon returned no result')
    reply = json.loads(packet)
    if reply.get('png_base64') or reply.get('visual'):
        tally['image_blocks'] += 1
        raise RuntimeError('unexpected image returned from semantic-only fixture')
    if not reply.get('ok'):
        raise RuntimeError('private daemon rejected ' + cmd + ': ' + str(reply.get('error', 'unknown'))[:120])
    return reply


def windows(tally):
    return request({'cmd': 'observe'}, tally)


def own_nodes(snapshot, window_title, name, role):
    nodes = (snapshot.get('snapshot') or {}).get('nodes', [])
    by_id = {n['id']: n for n in nodes}
    selected = []
    for node in nodes:
        if node.get('name') != name or node.get('role') != role or node.get('visible') is False:
            continue
        parent = node.get('parent')
        seen = set()
        while parent in by_id and parent not in seen:
            seen.add(parent)
            ancestor = by_id[parent]
            if window_title in (ancestor.get('name') or ''):
                selected.append(node)
                break
            parent = ancestor.get('parent')
    return selected


def owned_window(reply, title):
    matches = [w for w in reply.get('windows', []) if title in (w.get('title') or '')]
    if len(matches) != 1:
        raise RuntimeError('fixture window not unique')
    return matches[0]


def find_target(title, name, role, tally):
    def check():
        reply = windows(tally)
        try:
            owned_window(reply, title)
        except RuntimeError:
            return None
        candidates = own_nodes(reply, title, name, role)
        if len(candidates) > 1:
            raise RuntimeError('ambiguous private semantic target')
        if len(candidates) == 1:
            return candidates[0]
        return None
    try:
        return await_condition(check, 12)
    except TimeoutError:
        snapshot = windows(tally)
        nodes = (snapshot.get('snapshot') or {}).get('nodes', [])
        matches = [(n.get('role'), n.get('name')) for n in nodes if (n.get('name') or '').startswith('Pi execution')]
        raise RuntimeError('fixture control absent; roles=' + str(matches[:12])[:260] +
                           '; windows=' + str(len(snapshot.get('windows', []))) +
                           '; nodes=' + str(len(nodes)) +
                           '; owned_window=' + str(sum(title in (w.get('title') or '') for w in snapshot.get('windows', []))))


class Server(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.events = []
        self.input_reports = {}
        self.page_gets = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path != '/':
            self.send_error(404)
            return
        self.server.page_gets += 1
        html = ("<!doctype html><html><meta charset='utf-8'><title>" + TITLE + "</title>"
                "<body><h1>Private execution fixture</h1>"
                "<button id='go' type='button' aria-label='Pi execution local button' "
                "onclick=\"fetch('/event',{method:'POST',headers:{'Content-Type':'application/json'},"
                "body:JSON.stringify({kind:'clicked'})})\">Click fixture</button>"
                "<label for='entry'>Pi execution multilingual form</label>"
                "<textarea id='entry' aria-label='Pi execution multilingual form'></textarea>"
                "<button type='button' aria-label='Pi execution submit form' "
                "onclick=\"fetch('/event',{method:'POST',headers:{'Content-Type':'application/json'},"
                "body:JSON.stringify({kind:'submitted',value:document.getElementById('entry').value})})\">Submit</button>"
                "<label for='legacy'>Pi execution legacy text input</label>"
                "<input id='legacy' type='text' aria-label='Pi execution legacy text input'>"
                "<button type='button' aria-label='Pi execution verify legacy' onclick=\"verifyInput('legacy')\">Verify legacy</button>"
                "<label for='clipboard'>Pi execution clipboard text input</label>"
                "<input id='clipboard' type='text' aria-label='Pi execution clipboard text input'>"
                "<button type='button' aria-label='Pi execution verify clipboard' onclick=\"verifyInput('clipboard')\">Verify clipboard</button>"
                "<script>for(const id of ['legacy','clipboard']){let e=document.getElementById(id);"
                "for(const kind of ['keydown','keyup','paste']){e.addEventListener(kind,event=>{"
                "if(event.isTrusted){e.dataset[kind]=Number(e.dataset[kind]||0)+1}},true)}}"
                "function verifyInput(id){let e=document.getElementById(id);"
                "fetch('/event',{method:'POST',headers:{'Content-Type':'application/json'},"
                "body:JSON.stringify({kind:'input_verified',strategy:id,value:e.value,"
                "keydown:Number(e.dataset.keydown||0),keyup:Number(e.dataset.keyup||0),"
                "paste:Number(e.dataset.paste||0)})})}</script>"
                "</body></html>").encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def do_POST(self):
        if self.path != '/event' or int(self.headers.get('Content-Length', '-1')) not in range(1, 4097):
            self.send_error(400)
            return
        try:
            data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if not isinstance(data, dict):
                self.send_error(400)
                return
            if data.get('kind') == 'input_verified':
                strategy = data.get('strategy')
                keys = ('keydown', 'keyup', 'paste')
                if (strategy not in ('legacy', 'clipboard') or strategy in self.server.input_reports
                    or data.get('value') != ASCII or any(type(data.get(key)) is not int
                    or not 0 <= data[key] <= 1000 for key in keys)):
                    self.send_error(400)
                    return
                self.server.input_reports[strategy] = {key: data[key] for key in keys}
            elif data in ({'kind': 'clicked'}, {'kind': 'submitted', 'value': TEXT}):
                self.server.events.append(data['kind'])  # never store the form text
            else:
                self.send_error(400)
                return
            self.send_response(204)
            self.end_headers()
        except (ValueError, UnicodeError):
            self.send_error(400)


def row(id_, status, tally=None, reason=None, duration=None):
    return {'id': id_, 'status': status,
            'fixture_execution': ({'wall_ms': round(duration, 3), **tally,
              'verified_result': True, 'model_messages': None, 'model_tokens': None,
              'agent_tool_calls': None, 'billed_cost': None} if status == 'fixture_pass' else None),
            'reason': reason, 'baseline': None, 'optimized': None}


def editor_target(title, tally):
    def check():
        snapshot = windows(tally)
        try:
            own = owned_window(snapshot, title)
        except RuntimeError:
            return None
        nodes = (snapshot.get('snapshot') or {}).get('nodes', [])
        by_id = {node['id']: node for node in nodes}
        editors = []
        for node in nodes:
            if node.get('role') != 'text' or node.get('focused') is not True:
                continue
            parent = node.get('parent')
            seen = set()
            while parent in by_id and parent not in seen:
                seen.add(parent)
                if title in (by_id[parent].get('name') or ''):
                    editors.append(node)
                    break
                parent = by_id[parent].get('parent')
        if len(editors) > 1:
            raise RuntimeError('ambiguous private Xed editor')
        return (own, editors[0]) if len(editors) == 1 and own.get('active') else None
    return await_condition(check, 18)


def run_case(id_, action):
    tally = {'daemon_requests': 0, 'input_dispatch_requests': 0,
             'image_blocks': 0, 'reported_paste_keyboard_events': None}
    begin = time.monotonic()
    try:
        action(tally)
        return row(id_, 'fixture_pass', tally, duration=(time.monotonic()-begin)*1000)
    except Exception as exc:
        # No retries of uncertain input. Never output text, UI responses, paths, or logs.
        return row(id_, 'fixture_failed', reason=type(exc).__name__ + ': ' + str(exc)[:135])


def main():
    # The shell started Xephyr *outside* the worker namespace. Never inherit
    # the parent DISPLAY, Xauthority, home or live runtime sockets here.
    display = os.environ['DISPLAY']
    if (display != os.environ.get('PI_EXECUTION_PRIVATE_DISPLAY')
        or not display.startswith(':') or not display[1:].isdigit()
        or not (TMP / '.X11-unix' / ('X' + display[1:])).is_socket()
        or (TMP / '.X11-unix/X0').exists()
        or Path('/run/user/%d/bus' % os.getuid()).exists()
        or Path('/run/user/%d/keyring' % os.getuid()).exists()
        or os.environ.get('HOME') != '/tmp/home'
        or os.environ.get('XDG_RUNTIME_DIR') != '/tmp/runtime'
        or os.environ.get('XAUTHORITY') or os.environ.get('SSH_AUTH_SOCK')):
        raise RuntimeError('private fixture guard failed; no GUI dispatch')
    await_condition(lambda: subprocess.run(['xdpyinfo', '-display', display], stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL, timeout=2).returncode == 0, 12)
    os.environ.update(HOME='/tmp/home', XDG_CONFIG_HOME='/tmp/config',
                      XDG_CACHE_HOME='/tmp/cache', XDG_DATA_HOME='/tmp/data',
                      XDG_RUNTIME_DIR='/tmp/runtime', GTK_MODULES='gail:atk-bridge',
                      GNOME_ACCESSIBILITY='1', COMPUTER_USE_SOCKET='/tmp/daemon.sock',
                      COMPUTER_USE_CONFIG='/tmp/config.toml', COMPUTER_USE_OVERLAY='false')
    for folder in ('home', 'config', 'cache', 'data', 'runtime', 'profile'):
        (TMP / folder).mkdir(mode=0o700, exist_ok=True)
    (TMP / 'config.toml').write_text('')
    start(['metacity', '--no-composite'], 'wm')
    server = Server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = 'http://127.0.0.1:%d/' % server.server_port
    binary = os.environ['PI_EXECUTION_BROWSER']
    if Path(binary).name.startswith('firefox'):
        (TMP / 'profile' / 'user.js').write_text('user_pref("accessibility.force_disabled", -1);\n'
            'user_pref("browser.aboutwelcome.enabled", false);\n'
            'user_pref("browser.shell.checkDefaultBrowser", false);\n'
            'user_pref("network.proxy.type", 0);\n'
            'user_pref("app.update.enabled", false);\n')
        browser_args = [binary, '--no-remote', '--profile', '/tmp/profile', url]
    else:
        browser_args = [binary, '--user-data-dir=/tmp/profile', '--no-first-run',
            '--no-default-browser-check', '--disable-background-networking',
            '--no-proxy-server', '--disable-extensions', '--disable-component-update',
            '--disable-features=MediaRouter', '--disable-setuid-sandbox',
            '--force-renderer-accessibility', '--new-window', url]
    browser = start(browser_args, 'browser')
    daemon = start([os.environ['PI_EXECUTION_DAEMON']], 'daemon')
    await_condition(lambda: (TMP / 'daemon.sock').is_socket(), 12)
    output = []
    try:
        def button(tally):
            node = find_target(TITLE, 'Pi execution local button', 'push button', tally)
            owned_window(windows(tally), TITLE)
            request({'cmd': 'click', 'id': node['id']}, tally)
            await_condition(lambda: 'clicked' in server.events, 5)
        output.append(run_case('local-website-button', button))

        def form(tally):
            # The file is fixture-owned; read its exact UTF-8 bytes before GUI input.
            source = TMP / 'multilingual.txt'
            source.write_text(TEXT, encoding='utf-8')
            text = source.read_text(encoding='utf-8')
            if text != TEXT:
                raise RuntimeError('private fixture source changed')
            target = find_target(TITLE, 'Pi execution multilingual form', 'entry', tally)
            request({'cmd': 'click', 'id': target['id']}, tally)
            snapshot = windows(tally)
            active = owned_window(snapshot, TITLE)
            if active.get('active') is not True:
                raise RuntimeError('browser window is not active')
            matches = own_nodes(snapshot, TITLE, 'Pi execution multilingual form', 'entry')
            if len(matches) != 1 or matches[0].get('focused') is not True:
                raise RuntimeError('browser field not semantically focused')
            paste = request({'cmd': 'paste_text', 'text': text,
                             'target': {'id': matches[0]['id']},
                             'window_title': active['title']}, tally)['paste']
            if paste['status'] != 'dispatched' or paste['keyboard_events'] != 4:
                raise RuntimeError('paste dispatch not confirmed')
            tally['reported_paste_keyboard_events'] = paste['keyboard_events']
            # No DOM automation: the fixture page reports the submitted value via
            # its own normal button handler, after a real native semantic click.
            submit = find_target(TITLE, 'Pi execution submit form', 'push button', tally)
            request({'cmd': 'click', 'id': submit['id']}, tally)
            await_condition(lambda: 'submitted' in server.events, 5)
        output.append(run_case('bulgarian-english-file-to-browser-form', form))

        # Controlled low-level comparison, NOT a replay of old vs new agents.
        # The same freshly built binary retains the exact pinned type_text body;
        # each path gets a distinct, initially empty test-owned browser field.
        def text_path(strategy, name, verify_name):
            tally = {'daemon_requests': 0, 'input_dispatch_requests': 0, 'image_blocks': 0}
            started = time.monotonic()
            target = find_target(TITLE, name, 'entry', tally)
            request({'cmd': 'click', 'id': target['id']}, tally)
            snapshot = windows(tally)
            active = owned_window(snapshot, TITLE)
            entries = own_nodes(snapshot, TITLE, name, 'entry')
            if (not active.get('active') or len(entries) != 1
                or entries[0].get('focused') is not True or entries[0].get('value') not in ('', None)):
                raise RuntimeError('comparison field not uniquely empty and focused')
            native_events = None
            if strategy == 'legacy':
                # This protocol alias runs unchanged native Input::type_text;
                # there is no semantic node id and no clipboard in this path.
                request({'cmd': 'type', 'text': ASCII}, tally)
            else:
                paste = request({'cmd': 'paste_text', 'text': ASCII,
                    'target': {'id': entries[0]['id']}, 'window_title': active['title']}, tally)['paste']
                if paste.get('status') != 'dispatched' or paste.get('verified') is not False:
                    raise RuntimeError('comparison paste was not dispatched')
                native_events = paste.get('keyboard_events')
                if native_events != 4:
                    raise RuntimeError('comparison paste reported unexpected shortcut events')
            def verified_text():
                state = windows(tally)
                nodes = own_nodes(state, TITLE, name, 'entry')
                return len(nodes) == 1 and nodes[0].get('value') == ASCII
            await_condition(verified_text, 7)
            check = find_target(TITLE, verify_name, 'push button', tally)
            request({'cmd': 'click', 'id': check['id']}, tally)
            stats = await_condition(lambda: server.input_reports.get(strategy), 6)
            if stats['keydown'] < 1 or stats['keyup'] < 1:
                raise RuntimeError('trusted browser key events were not observed')
            if (strategy == 'legacy' and stats['paste'] != 0) or (strategy == 'clipboard' and stats['paste'] != 1):
                raise RuntimeError('browser paste-event semantics differed from the strategy')
            return {'verified_result': True,
                'wall_ms_including_discovery_and_verification': round((time.monotonic()-started)*1000, 3),
                **tally, 'dom_trusted_keydown': stats['keydown'], 'dom_trusted_keyup': stats['keyup'],
                'dom_trusted_paste': stats['paste'], 'native_reported_paste_keyboard_events': native_events,
                'model_tokens': None, 'agent_tool_calls': None, 'billed_cost': None}
        try:
            legacy = text_path('legacy', 'Pi execution legacy text input', 'Pi execution verify legacy')
            clipboard = text_path('clipboard', 'Pi execution clipboard text input', 'Pi execution verify clipboard')
            controlled = {'scope': 'same_working_tree_native_binary_private_browser_fixture',
                'status': 'verified', 'payload_ascii_characters': len(ASCII),
                'legacy_type_text': legacy, 'clipboard_paste': clipboard,
                'limitations': 'Browser DOM trusted key events, not X11 global event telemetry; fixed ASCII text and separate fresh fields, no model/agent run.'}
        except Exception as exc:
            controlled = {'scope': 'same_working_tree_native_binary_private_browser_fixture',
                'status': 'fixture_failed', 'reason': type(exc).__name__ + ': ' + str(exc)[:90],
                'legacy_type_text': None, 'clipboard_paste': None}

        editor_title = 'PiExecutionEditor' + uuid.uuid4().hex[:12]
        initial = 'Pi-owned file open verification\n'
        editor_file = TMP / (editor_title + '.txt')
        editor_file.write_text(initial, encoding='utf-8')
        editor = start(['xed', '--standalone', '--new-window', '--geometry=950x600',
                        str(editor_file)], 'xed')
        def open_editor(tally):
            def loaded():
                _, node = editor_target(editor_title, tally)
                return node if (node.get('value') or '').rstrip('\n') == initial.rstrip('\n') else None
            await_condition(loaded, 12)
            if editor_file.read_text(encoding='utf-8') != initial:
                raise RuntimeError('private editor fixture file changed on open')
        output.append(run_case('open-file-in-gui-editor', open_editor))

        def mixed(tally):
            title, node = editor_target(editor_title, tally)
            if (node.get('value') or '').rstrip('\n') != initial.rstrip('\n'):
                raise RuntimeError('private editor initial value changed')
            request({'cmd': 'keypress', 'key': 'Ctrl+End'}, tally)
            title, node = editor_target(editor_title, tally)
            added = '\nВтори ред: fixture Unicode ✓'
            expected = initial.rstrip('\n') + added
            pasted = request({'cmd': 'paste_text', 'text': added, 'target': {'id': node['id']},
                              'window_title': title['title']}, tally)['paste']
            if pasted.get('status') != 'dispatched' or pasted.get('keyboard_events') != 4:
                raise RuntimeError('editor paste dispatch not confirmed')
            tally['reported_paste_keyboard_events'] = 4
            try:
                await_condition(lambda: request({'cmd': 'inspect', 'id': node['id']}, tally)
                                .get('node', {}).get('value', '').rstrip('\n') == expected, 6)
            except TimeoutError:
                actual = request({'cmd': 'inspect', 'id': node['id']}, tally).get('node', {}).get('value', '')
                raise RuntimeError('private editor post-paste semantic length=' + str(len(actual)) +
                                   ', expected=' + str(len(expected)))
            request({'cmd': 'keypress', 'key': 'Ctrl+S'}, tally)
            try:
                await_condition(lambda: editor_file.read_text(encoding='utf-8') == expected + '\n', 7)
            except TimeoutError:
                actual = editor_file.read_text(encoding='utf-8')
                raise RuntimeError('private editor saved file length=' + str(len(actual)) +
                                   ', trailing_newline=' + str(actual.endswith('\n')))
        output.append(run_case('mixed-filesystem-and-gui', mixed))

        code_binary = os.environ.get('PI_EXECUTION_CODE')
        if code_binary:
            project = TMP / ('PiExecutionProject' + uuid.uuid4().hex[:10])
            project.mkdir(mode=0o700)
            (project / 'README.txt').write_text('Test-owned project\n', encoding='utf-8')
            vscode = start([code_binary, '--user-data-dir=/tmp/code-profile',
                '--extensions-dir=/tmp/code-extensions', '--no-sandbox',
                '--disable-gpu', '--force-renderer-accessibility', '--new-window', str(project)], 'code')
            def open_project(tally):
                def check():
                    snapshot = windows(tally)
                    matching = [w for w in snapshot.get('windows', [])
                                if project.name in (w.get('title') or '')]
                    if len(matching) > 1:
                        raise RuntimeError('ambiguous test-owned project window')
                    return matching[0] if len(matching) == 1 else None
                await_condition(check, 22)
                if (project / 'README.txt').read_text(encoding='utf-8') != 'Test-owned project\n':
                    raise RuntimeError('test-owned project disappeared')
            output.append(run_case('open-existing-project-in-vscode', open_project))
        else:
            output.append(row('open-existing-project-in-vscode', 'skipped', reason='VS Code unavailable inside private fixture.'))
        print(json.dumps({'schema_version': 1, 'isolated': True,
                          'working_tree_native_binary_sha256': hashlib.sha256(
                              Path(os.environ['PI_EXECUTION_DAEMON']).read_bytes()).hexdigest(),
                          'page_gets': server.page_gets,
                          'browser_alive': browser.poll() is None,
                          'network': 'private net namespace, loopback HTTP only',
                          'browser_profile': 'test-owned private', 'model_provider_calls': 0,
                          'controlled_input_comparison': controlled,
                          'cases': output}, ensure_ascii=False), flush=True)
        return 0 if (controlled['status'] == 'verified'
                     and all(r['status'] in ('fixture_pass', 'skipped') for r in output)) else 1
    finally:
        server.shutdown()
        server.server_close()
        for proc in reversed(children):
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for proc in reversed(children):
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'schema_version': 1, 'isolated': True, 'setup_failure': type(error).__name__}), flush=True)
        sys.exit(1)
