#!/usr/bin/env node
// Opt-in, private Docker browser fixture only: synthetic loopback site, no real account/profile/network destination.
// Default: declared desktop_set_text without id (legacy short ASCII typing),
// exact-verified URL before Return. BROWSER_NAVIGATION_METHOD=paste|setter
// isolates those presently failing mechanisms in separate fresh containers;
// never auto-fallback or replay uncertain input.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';
import { extensionHarness } from './extension-harness.mjs';
if (process.env.RUN_BROWSER_NAVIGATION_REAL !== '1') {
 console.log('SKIP: set RUN_BROWSER_NAVIGATION_REAL=1 for private Firefox navigation fixture'); process.exit(77);
}
const root = path.resolve(import.meta.dirname, '..');
const release = process.env.PI_CODEX_ULTRA_RELEASE_ROOT; assert.ok(release, 'Installed Pi release required');
const require = createRequire(path.join(release, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
 typebox: require.resolve('typebox'), '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
} });
const { DesktopTarget } = await jiti.import(path.join(root, '.pi/extensions/computer-use/target.ts'));
const { ComputerUseMode } = await jiti.import(path.join(root, '.pi/extensions/computer-use/mode.ts'));
const { DesktopWorkflow } = await jiti.import(path.join(root, '.pi/extensions/computer-use/workflow.ts'));
const { registerComputerUseTools } = await jiti.import(path.join(root, '.pi/extensions/computer-use/tools.ts'));
const { DesktopLoadout } = await jiti.import(path.join(root, '.pi/extensions/computer-use/loadout.ts'));
const exec = promisify(execFile), dir = await mkdtemp(path.join(os.tmpdir(), 'pbn-'));
await mkdir(path.join(dir, 'r'), { mode: 0o700 }); await mkdir(path.join(dir, 's'), { mode: 0o700 });
const sessionId = `navigation-fixture-${randomUUID()}`;
const runtime = new BrowserDockerRuntime({ sessionId, runtimeDir: path.join(dir, 'r'), stateDir: path.join(dir, 's') });
const imageId = (await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', 'pi-computer-browser:local'])).stdout.trim();
await writeFile(runtime.imageFile, JSON.stringify({ imageId }), { mode: 0o600 });
const tools = new Map(), harness = extensionHarness(tools);
let active = [];
const ctx = { mode: 'tui', hasUI: true, signal: undefined, sessionManager: {
 getSessionId: () => sessionId, getBranch: () => harness.entries,
}, isIdle: () => true, abort() {}, ui: { setWidget() {}, notify() {} } };
const mode = new ComputerUseMode(harness.pi, async () => true);
let target; const workflow = new DesktopWorkflow(request => target.lease(request, ctx));
target = new DesktopTarget(harness.pi, mode, workflow, id => { assert.equal(id, sessionId); return runtime; });
registerComputerUseTools(harness.pi, workflow, undefined, target);
mode.start(ctx, 'startup'); target.restore(ctx);
const url = 'http://127.0.0.1:8088/navigation?x=a%20b&literal=%2B';
const method = ['paste', 'setter', 'type'].includes(process.env.BROWSER_NAVIGATION_METHOD) ? process.env.BROWSER_NAVIGATION_METHOD : 'set_text_no_id';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, reason) {
 let last;
 for (let n = 0; n < 75; n++) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(200); }
 throw Error(`${reason}: ${last?.message ?? 'no matching observation'}`);
}
async function call(name, params) {
 if (method !== 'type') assert.ok(active.includes(name), `${name} is not declared in basic ON`);
 const result = await tools.get(name).execute(name, params, undefined, undefined, ctx);
 return result.details.response;
}
async function observe() { return call('desktop_observe', {}); }
function focused(snapshot) { return (snapshot.snapshot?.nodes ?? []).filter(n => n.focused === true && /combo box|entry|text/.test(n.role)); }
async function field() {
 const snapshot = await observe();
 const candidates = focused(snapshot);
 console.log('Owned Firefox focused roles:', JSON.stringify(candidates.map(n => ({ role: n.role, name: n.name, hasValue: typeof n.value === 'string', valueReadFailed: n.value_read_failed, enabled: n.enabled, visible: n.visible }))));
 assert.equal(candidates.length, 1, 'Need exactly one focused semantic URL field; never use arbitrary coordinates');
 return { window: snapshot.windows.find(w => w.active)?.title, node: candidates[0] };
}
async function cleanupVolume() {
 const name = `pi-computer-profile-${runtime.key}`; let volume;
 try { volume = JSON.parse((await exec('docker', ['volume', 'inspect', '--format', '{{json .}}', name])).stdout); } catch { return; }
 assert.equal(volume.Name, name); assert.equal(volume.Labels['org.pi-computer.browser.key'], runtime.key);
 assert.equal(volume.Labels['org.pi-computer.browser.uid'], String(process.getuid()));
 await exec('docker', ['volume', 'rm', name]);
}
let created = false;
try {
 created = true;
 await target.command('docker start', ctx); await target.enable(ctx); mode.setEnabled(true, ctx);
 assert.equal(mode.isEnabled(), true); assert.equal(target.target, 'docker');
 const state = await runtime.status(); assert.equal(state.status, 'running');
 const loadout = new DesktopLoadout({ getAllTools: () => [...tools.keys()].map(name => ({ name })),
  getActiveTools: () => active, setActiveTools: names => { active = names; } });
 loadout.sync(true);
 assert.equal(active.length, 16, 'Fixture registers production daemon tools; UI-only declaration tools are absent');
 assert.ok(active.includes('desktop_set_text'), 'Physical short-text path must be declared ON');
 assert.ok(!active.includes('desktop_type'), 'Diagnostic-only tool is not in basic ON');
 // Local HTTP origin is visible only inside this disposable container. Avoid a host port and external websites.
 const python = `from http.server import BaseHTTPRequestHandler, HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  if self.path == '/navigation?x=a%20b&literal=%2B':\n   body = b'<!doctype html><title>Owned Navigation Ready</title><button>Owned Navigation Button</button><label>Owned Navigation Choice<select><option>Owned Default</option><option>Owned Other</option></select></label>'\n   self.send_response(200)\n  else:\n   body = b'<!doctype html><title>Owned Navigation Wrong URL</title>'\n   self.send_response(404)\n  self.send_header('Content-Type', 'text/html; charset=utf-8')\n  self.send_header('Content-Length', str(len(body)))\n  self.end_headers()\n  self.wfile.write(body)\n def log_message(self, *args): pass\nHTTPServer(('127.0.0.1',8088),H).serve_forever()`;
 await exec('docker', ['exec', '-d', '--user', `${process.getuid()}:${process.getuid()}`, state.handle.containerId,
  'python3', '-c', python]);
 await until(async () => (await exec('docker', ['exec', state.handle.containerId, 'python3', '-c',
  'import http.client; c = http.client.HTTPConnection("127.0.0.1",8088); c.request("GET","/navigation?x=a%20b&literal=%2B"); assert c.getresponse().status == 200'])).stdout === '', 'Owned HTTP fixture unavailable');
 const initial = await until(async () => { const view = await observe(); return view.windows?.some(w => /Firefox/i.test(w.title)) && view; }, 'Owned Firefox window unavailable');
 const window = initial.windows.find(w => /Firefox/i.test(w.title));
 console.log('Owned Firefox initial window:', JSON.stringify({ title: window.title, active: window.active }));
 assert.ok(window, 'Owned Firefox window unavailable');
 assert.equal((await call('desktop_focus_window', { title: window.title })).ok, true);
 assert.equal((await call('desktop_keypress', { key: 'ctrl+l' })).ok, true);
 const { node, window: activeTitle } = await field();
 assert.equal(activeTitle, window.title);
 if (method === 'type') {
  const typed = await call('desktop_type', { text: 'owned' });
  assert.equal(typed.ok, true);
  const observed = await field();
  const inspected = await call('desktop_inspect', { id: observed.node.id });
  console.log('Owned short ASCII keyboard value:', JSON.stringify({ observedValue: observed.node.value,
   inspectValue: inspected.node?.value, focused: inspected.node?.focused }));
  assert.equal(inspected.node?.value, 'owned', 'Control diagnostic: physical keyboard must be independently readable');
 } else {
 // Focused Firefox combo: each method is tested in a new, test-owned profile.
 // No fallback after a dispatched paste or reported setter success.
 const entryResult = method === 'paste'
  ? await call('desktop_paste_text', { text: url, target: { id: node.id }, window_title: activeTitle })
  : method === 'setter' ? await call('desktop_set_text', { id: node.id, text: url })
  : await call('desktop_set_text', { text: url });
 const paste = method === 'paste' ? entryResult : null;
 console.log(`Owned URL ${method}:`, JSON.stringify({ ok: entryResult.ok, error: entryResult.error,
  paste: paste?.paste && { status: paste.paste.status, paste_sent: paste.paste.paste_sent,
   focus_verification: paste.paste.focus_verification, shortcut: paste.paste.shortcut,
   keyboard_events: paste.paste.keyboard_events, clipboard_restore_status: paste.paste.clipboard_restore_status } }));
 assert.equal(entryResult.ok, true, `Native Firefox URL ${method} must succeed`);
 const afterEntry = await field();
 let inspected;
 for (let n = 0; n < 5; n++) {
  inspected = await call('desktop_inspect', { id: afterEntry.node.id });
  if (inspected.node?.value === url) break;
  await delay(250);
 }
 console.log(`Owned URL inspection after ${method}:`, JSON.stringify({ role: inspected.node?.role,
  value: inspected.node?.value, focused: inspected.node?.focused, error: inspected.error }));
 assert.equal(inspected.node?.id, afterEntry.node.id, 'Fresh focused URL field identity changed');
 assert.equal(inspected.node?.focused, true, 'URL field focus changed before Return');
 assert.equal(inspected.node?.value, url, `${method} requires exact independent semantic readback before Return`);
 assert.equal((await call('desktop_keypress', { key: 'Return' })).ok, true);
 const arrived = await until(async () => {
  const view = await observe();
  return view.windows.some(w => w.active && w.title.includes('Owned Navigation Ready')) &&
   view.snapshot?.nodes?.some(n => n.name === 'Owned Navigation Button');
 }, 'Firefox did not load exact private navigation route');
 assert.equal(arrived, true);
 // A list/choice combo must never gain paste permission merely from its role.
 const page = await observe();
 const choice = page.snapshot?.nodes?.find(n => n.role === 'combo box' && /Owned Navigation Choice/.test(n.name));
 assert.ok(choice, 'Synthetic choice combo was not accessible');
 assert.equal((await call('desktop_click', { id: choice.id })).ok, true);
 // Firefox opens a menu-item popup on mouse activation. Escape closes it
 // while leaving the real noneditable choice focused for the paste gate.
 assert.equal((await call('desktop_keypress', { key: 'Escape' })).ok, true);
 const choiceState = await observe();
 const choiceField = focused(choiceState);
 assert.deepEqual(choiceField.map(n => n.id), [choice.id], 'Only the test-owned noneditable choice may have semantic field focus');
 assert.equal(choiceField[0].role, 'combo box');
 const otherFocusedLeaves = (choiceState.snapshot?.nodes ?? []).filter(n => n.focused === true && n.id !== choice.id &&
  !['application', 'frame', 'window', 'dialog', 'panel', 'grouping', 'scroll pane', 'root pane', 'layered pane',
   'viewport', 'document frame', 'document web', 'internal frame', 'embedded'].includes(n.role));
 assert.deepEqual(otherFocusedLeaves, [], 'A focused popup/menu leaf would confound the noneditable combo check');
 const exactChoiceWindow = choiceState.windows.find(w => w.active)?.title;
 assert.ok(exactChoiceWindow?.includes('Owned Navigation Ready'), 'Choice must be in the active fixture page');
 const denied = await call('desktop_paste_text', { text: 'Test-owned payload', target: { id: choice.id }, window_title: exactChoiceWindow });
 assert.equal(denied.ok, false, 'Noneditable choice combo must fail live editability/interface verification');
 assert.notEqual(denied.paste?.paste_sent, true, 'Noneditable combo must receive no clipboard shortcut');
 const afterDenied = await observe();
 assert.equal(afterDenied.snapshot?.nodes?.find(n => n.id === choice.id)?.value, choiceField[0].value,
  'Denied paste must leave choice value unchanged');
 console.log(`PASS: registered desktop tools entered an exact URL via ${method}, navigated to the owned route, and denied noneditable combo paste.`);
 }
} finally {
 mode.setEnabled(false, ctx);
 await workflow.close(); await target.releaseControl(ctx);
 if (created) await runtime.stop(); await cleanupVolume(); await rm(dir, { recursive: true, force: true });
}
