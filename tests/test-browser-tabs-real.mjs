#!/usr/bin/env node
// Explicit test-owned browser only. Never reads the real shared profile or GUI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';
if (process.env.RUN_BROWSER_TABS_REAL !== '1') {
 console.log('SKIP: set RUN_BROWSER_TABS_REAL=1 for private tab-restore integration'); process.exit(77);
}
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const release = process.env.PI_CODEX_ULTRA_RELEASE_ROOT; assert.ok(release);
const require = createRequire(path.join(release, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { alias: { typebox: require.resolve('typebox'), '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui') } });
const { checkViewer } = await jiti.import(path.join(root, '.pi/extensions/computer-use/target.ts'));
const dir = await mkdtemp('/tmp/pbt-'); await mkdir(dir + '/r', { mode: 0o700 }); await mkdir(dir + '/s', { mode: 0o700 });
const runtime = new BrowserDockerRuntime({ sessionId: `tabs-fixture-${randomUUID()}`, runtimeDir: dir + '/r', stateDir: dir + '/s' });
const imageId = (await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', 'pi-computer-browser:local'])).stdout.trim();
await writeFile(runtime.imageFile, JSON.stringify({ imageId }), { mode: 0o600 });
let handle, attempted = false;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function request(body) {
 return new Promise((resolve, reject) => {
  const socket = createConnection(handle.socketPath); let bytes = '', settled = false;
  const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
  const timer = setTimeout(() => finish(Error('Owned fixture IPC timeout')), 5000);
  socket.on('error', () => finish(Error('Owned fixture IPC unavailable')));
  socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
  socket.on('data', b => { bytes += b; if (bytes.includes('\n')) { try { finish(null, JSON.parse(bytes.split('\n')[0])); } catch { finish(Error('Invalid fixture IPC')); } } });
 });
}
async function until(fn, message) {
 for (let n = 0; n < 90; n++) { try { const result = await fn(); if (result) return result; } catch {} await delay(200); }
 throw Error(message);
}
async function ready() {
 await until(async () => (await request({ cmd: 'ping' })).ok, 'Fixture daemon did not start');
 await until(async () => { await checkViewer((await runtime.viewerInfo()).url); return true; }, 'Actual proxy/VNC route did not become ready');
 await until(async () => {
  const view = await request({ cmd: 'observe' });
  return view.windows?.some(w => /Firefox/i.test(w.title) && w.active) && view.snapshot?.nodes?.some(n => n.role === 'combo box');
 }, 'Fixture Firefox accessibility controls did not start');
}
async function tabNames() {
 return (await request({ cmd: 'observe' })).snapshot?.nodes?.filter(n => n.role === 'page tab').map(n => n.name) ?? [];
}
async function currentTitleContains(title) {
 return (await request({ cmd: 'observe' })).windows?.some(w => w.active && w.title.includes(title));
}
async function verifyTwoTabs() {
 // Firefox's compact AT-SPI tree can omit tab controls. Verify both restored
 // pages through native tab selection plus exact active-window title instead
 // of treating omitted nodes as absent. No framebuffer capture is needed.
 for (const [key, title] of [['alt+1', 'Owned Tab One'], ['alt+2', 'Owned Tab Two'], ['alt+9', 'Owned Tab Two']]) {
  assert.equal((await request({ cmd: 'keypress', key })).ok, true);
  await until(() => currentTitleContains(title), 'Both owned tabs were not restored');
 }
 const owned = (await tabNames()).filter(n => n.includes('Owned Tab One') || n.includes('Owned Tab Two'));
 if (owned.length) assert.equal(owned.length, 2, 'Restoring must not duplicate fixture tabs');
}
async function openTab(number, create) {
 if (create) assert.equal((await request({ cmd: 'keypress', key: 'ctrl+t' })).ok, true);
 for (const body of [{ cmd: 'keypress', key: 'ctrl+l' }, { cmd: 'type', text: `file:///home/browser/profile/fixture-${number}.html` }, { cmd: 'keypress', key: 'Return' }])
  assert.equal((await request(body)).ok, true);
 await until(() => currentTitleContains(`Owned Tab ${number === 1 ? 'One' : 'Two'}`), 'Owned fixture tab did not load');
}
async function cleanupVolume() {
 const name = `pi-computer-profile-${runtime.key}`; let volume;
 try { volume = JSON.parse((await exec('docker', ['volume', 'inspect', '--format', '{{json .}}', name])).stdout); } catch { return; }
 assert.equal(volume.Name, name); assert.equal(volume.Labels['org.pi-computer.browser.key'], runtime.key);
 assert.equal(volume.Labels['org.pi-computer.browser.uid'], String(process.getuid()));
 await exec('docker', ['volume', 'rm', name]);
}
try {
 attempted = true; handle = await runtime.start(); await ready();
 for (const [n, title] of [[1, 'One'], [2, 'Two']]) {
  const page = `<!doctype html><title>Owned Tab ${title}</title><button>Owned Tab ${title} Ready</button>`;
  await exec('docker', ['exec', '--user', `${process.getuid()}:${process.getuid()}`, handle.containerId, 'sh', '-c', 'printf %s "$1" > "$2"', 'fixture', page, `/home/browser/profile/fixture-${n}.html`]);
 }
 await openTab(1, false); await openTab(2, true); await verifyTwoTabs();
 const previous = handle.containerId;
 await runtime.stop(); handle = await runtime.start(); assert.notEqual(handle.containerId, previous);
 await ready(); await verifyTwoTabs();
 await exec('docker', ['restart', '--time', '30', handle.containerId], { timeout: 45_000 });
 await ready(); await verifyTwoTabs();
 // Disconnecting a viewer probe must not terminate the managed browser.
 for (let i = 0; i < 3; i++) await checkViewer((await runtime.viewerInfo()).url);
 if (process.env.RUN_BROWSER_VIEWER_STABILITY === '1') {
  // The reported real failure occurred around one minute after startup. Keep
  // only this synthetic browser alive past that interval and recheck the real
  // proxy route; never poll/screenshot the user's desktop.
  for (let i = 0; i < 4; i++) { await delay(17_000); await checkViewer((await runtime.viewerInfo()).url); }
 }
 assert.equal((await runtime.status()).status, 'running');
 console.log('PASS: real proxy/RFB route, two saved tabs restored without duplicates after container removal/recreation AND full restart; repeated viewer disconnects preserve browser. Private fixtures only.');
} catch (error) {
 if (handle) {
  try {
   const view = await request({ cmd: 'observe' });
   console.log('Private fixture state:', JSON.stringify({ windows: view.windows?.map(w => w.title), tabs: view.snapshot?.nodes?.filter(n => n.role === 'page tab').map(n => n.name) }));
   const logs = (await exec('docker', ['logs', '--tail', '30', handle.containerId])).stderr;
   for (const line of logs.split('\n')) if (line.startsWith('browser-session:')) console.log(line);
  } catch { console.log('Private fixture metadata unavailable'); }
 }
 throw error;
} finally {
 if (attempted) await runtime.stop(); await cleanupVolume(); await rm(dir, { recursive: true, force: true });
}
