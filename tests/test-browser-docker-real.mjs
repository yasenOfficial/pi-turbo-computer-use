#!/usr/bin/env node
// Opt-in owned-container fixture only: no host GUI, real accounts or profiles.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';

if (process.env.RUN_BROWSER_DOCKER_REAL !== '1') {
 console.log('SKIP: set RUN_BROWSER_DOCKER_REAL=1 after explicit docker build'); process.exit(77);
}
const release = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
assert.ok(release, 'Use the current installed Pi SDK');
const require = createRequire(path.join(release, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
const WebSocket = require('ws'), exec = promisify(execFile);
const sessionId = `fixture-only-${randomUUID()}`, runtime = new BrowserDockerRuntime({ sessionId });
let attempted = false, handle, viewer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(body) {
 return new Promise((resolve, reject) => {
  const c = createConnection(handle.socketPath); let buffer = '', settled = false;
  const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); c.destroy(); error ? reject(error) : resolve(result); };
  const timer = setTimeout(() => finish(Error('Private fixture IPC timeout')), 5000);
  c.on('error', () => finish(Error('Private fixture IPC unavailable')));
  c.on('connect', () => c.write(JSON.stringify(body) + '\n'));
  c.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { try { finish(null, JSON.parse(buffer.split('\n')[0])); } catch { finish(Error('Invalid fixture IPC')); } } });
 });
}
async function until(fn, message, attempts = 90) {
 for (let i = 0; i < attempts; i++) { try { const result = await fn(); if (result) return result; } catch {} await sleep(200); }
 throw Error(message);
}
async function verifyViewer(info) {
 assert.equal(info.authentication, 'none'); assert.equal(info.password, undefined);
 const url = new URL(info.url); assert.equal(url.hostname, '127.0.0.1'); url.protocol = 'ws:'; url.pathname = '/websockify';
 viewer = new WebSocket(url, ['binary']); let bytes = Buffer.alloc(0), failed = false;
 viewer.on('message', chunk => { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); }); viewer.on('error', () => { failed = true; });
 const take = async n => until(() => {
  assert.ok(!failed); if (bytes.length < n) return false;
  const out = bytes.subarray(0, n); bytes = bytes.subarray(n); return out;
 }, 'Private viewer RFB handshake timeout', 40);
 assert.match((await take(12)).toString(), /^RFB 003\.00[78]\n$/); viewer.send(Buffer.from('RFB 003.008\n'));
 const count = (await take(1))[0]; assert.ok(count > 0);
 const types = await take(count); assert.ok(types.includes(1), 'VNC must offer no-auth'); assert.ok(!types.includes(2), 'Password auth was removed');
 viewer.send(Buffer.from([1])); assert.equal((await take(4)).readUInt32BE(), 0);
 viewer.send(Buffer.from([1])); await take(24); // shared client, no framebuffer/image requested
 viewer.close(); viewer = undefined;
}
const fixturePage = `<!doctype html><html><head><title>Owned Persistent Fixture</title></head><body>
<button onclick="document.cookie='fixture_login=owned; Max-Age=86400; Path=/';this.textContent='Fixture done'">Fixture button</button>
<button id="cookie">Cookie missing</button><script>if(document.cookie.split('; ').includes('fixture_login=owned'))document.getElementById('cookie').textContent='Cookie persisted';</script></body></html>`;
const server = `from http.server import HTTPServer, BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(${JSON.stringify(fixturePage)}.encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',8088),Handler).serve_forever()
`;
async function openFixture() {
 await until(async () => (await request({ cmd: 'ping' })).ok, 'Private daemon not ready');
 await exec('docker', ['exec', '--user', `${process.getuid()}:${process.getuid()}`, handle.containerId, 'sh', '-c', 'printf %s "$1" > /home/browser/fixture-server.py', 'fixture', server], { timeout: 5000 });
 await exec('docker', ['exec', '--detach', '--user', `${process.getuid()}:${process.getuid()}`, handle.containerId, 'python3', '/home/browser/fixture-server.py'], { timeout: 5000 });
 await until(async () => (await request({ cmd: 'observe' })).windows?.some(w => /firefox/i.test(w.title)), 'Private Firefox not ready');
 for (const body of [{ cmd: 'keypress', key: 'ctrl+l' }, { cmd: 'type', text: 'http://127.0.0.1:8088/' }, { cmd: 'keypress', key: 'Return' }]) assert.equal((await request(body)).ok, true);
 return until(async () => {
  const nodes = (await request({ cmd: 'observe' })).snapshot?.nodes ?? [];
  return nodes.some(n => n.name === 'Fixture button' && n.role === 'push button') ? nodes : false;
 }, 'Private Firefox fixture controls missing');
}
async function verifyCookie() {
 await until(async () => (await request({ cmd: 'observe' })).snapshot?.nodes?.some(n => n.name === 'Cookie persisted'), 'Persistent fixture cookie missing');
}
async function cleanupProfile() {
 const name = `pi-computer-profile-${runtime.key}`;
 let volume;
 try { volume = JSON.parse((await exec('docker', ['volume', 'inspect', '--format', '{{json .}}', name])).stdout); } catch { return; }
 assert.equal(volume.Name, name); assert.equal(volume.Driver, 'local');
 assert.equal(volume.Labels['org.pi-computer.browser.key'], runtime.key);
 assert.equal(volume.Labels['org.pi-computer.browser.uid'], String(process.getuid()));
 await exec('docker', ['volume', 'rm', name]); // only this random test session's volume
}
try {
 attempted = true; handle = await runtime.start();
 const nodes = await openFixture(); const info = await runtime.viewerInfo();
 await until(async () => (await fetch(info.url)).status === 200, 'Private viewer HTTP not ready'); await verifyViewer(info);
 assert.equal((await request({ cmd: 'click', id: nodes.find(n => n.name === 'Fixture button' && n.role === 'push button').id })).ok, true);
 await until(async () => (await request({ cmd: 'observe' })).snapshot?.nodes?.some(n => n.name === 'Fixture done'), 'Native fixture click failed');
 const original = (await request({ cmd: 'daemon_info' })).daemon_info;
 assert.equal((await request({ cmd: 'stop' })).input_stopped, true);
 assert.equal((await request({ cmd: 'keypress', key: 'ctrl+l' })).ok, false);
 await runtime.restartInput();
 await until(async () => { const info = (await request({ cmd: 'daemon_info' })).daemon_info; return info && !info.input_stopped && info.instance_id !== original.instance_id; }, 'Explicit daemon resume failed');
 await until(async () => (await request({ cmd: 'observe' })).snapshot?.nodes?.some(n => n.name === 'Fixture done'), 'Daemon resume lost browser page');
 // A real full-container restart, then removal/recreation, must keep the dummy
 // persistent cookie. No real user cookie value or profile is ever inspected.
 await exec('docker', ['restart', '--time', '10', handle.containerId], { timeout: 20_000 });
 await openFixture(); await verifyCookie();
 const previousId = handle.containerId; await runtime.stop(); handle = await runtime.start(); assert.notEqual(handle.containerId, previousId);
 await openFixture(); await verifyCookie(); await verifyViewer(await runtime.viewerInfo());
 console.log('PASS: localhost passwordless RFB, native Firefox click, sticky Stop/resume, dummy persistent cookie surviving full restart AND container removal/recreation. No host GUI, screenshots or real accounts.');
} finally {
 viewer?.close(); if (attempted) await runtime.stop(); await cleanupProfile();
}
