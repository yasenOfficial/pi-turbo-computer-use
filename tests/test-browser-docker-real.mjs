#!/usr/bin/env node
// Opt-in test-owned Docker/browser fixture. Never connects to the host desktop,
// personal browser profile, real accounts or public websites. No screenshots.
import assert from 'node:assert/strict';
import { randomUUID, createCipheriv } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';

if (process.env.RUN_BROWSER_DOCKER_REAL !== '1') {
 console.log('SKIP: set RUN_BROWSER_DOCKER_REAL=1 after explicit docker build');
 process.exit(77);
}
const release = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
assert.ok(release, 'Use the current installed Pi SDK');
const require = createRequire(path.join(release, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
const WebSocket = require('ws');
const exec = promisify(execFile);
const runtime = new BrowserDockerRuntime({ sessionId: `fixture-only-${randomUUID()}` });
let attempted = false, handle, viewer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(body) {
 return new Promise((resolve, reject) => {
  const c = createConnection(handle.socketPath); let buffer = ''; let settled = false;
  const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); c.destroy(); error ? reject(error) : resolve(result); };
  const timer = setTimeout(() => finish(Error('Private fixture IPC timeout')), 5000);
  c.on('error', () => finish(Error('Private fixture IPC unavailable')));
  c.on('connect', () => c.write(JSON.stringify(body) + '\n'));
  c.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { try { finish(null, JSON.parse(buffer.split('\n')[0])); } catch { finish(Error('Invalid fixture IPC')); } } });
 });
}
async function until(fn, message, attempts = 80) {
 for (let i = 0; i < attempts; i++) { try { const result = await fn(); if (result) return result; } catch {} await sleep(200); }
 throw Error(message);
}
// RFB 3.8 auth proves the HTTP viewer's WebSocket route reaches a VNC server
// that requires the generated password. Never print its bytes/challenge/key.
async function verifyViewer(credentials) {
 const url = new URL(credentials.url); url.protocol = 'ws:'; url.pathname = '/websockify';
 viewer = new WebSocket(url, ['binary']);
 let bytes = Buffer.alloc(0), failure;
 viewer.on('message', chunk => { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); });
 viewer.on('error', () => { failure = true; });
 const take = async n => until(() => {
  assert.ok(!failure, 'Private viewer WebSocket failed');
  if (bytes.length < n) return false;
  const out = bytes.subarray(0, n); bytes = bytes.subarray(n); return out;
 }, 'Private viewer handshake timeout', 40);
 assert.match((await take(12)).toString(), /^RFB 003\.00[78]\n$/);
 viewer.send(Buffer.from('RFB 003.008\n'));
 const count = (await take(1))[0]; assert.ok(count > 0);
 const types = await take(count); assert.ok(types.includes(2)); assert.ok(!types.includes(1), 'VNC must not offer no-auth');
 viewer.send(Buffer.from([2]));
 const challenge = await take(16);
 const key = Buffer.from(credentials.password, 'ascii');
 for (let i = 0; i < 8; i++) { let x = key[i], reverse = 0; for (let bit = 0; bit < 8; bit++) { reverse = (reverse << 1) | (x & 1); x >>= 1; } key[i] = reverse; }
 const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
 viewer.send(Buffer.concat([cipher.update(challenge), cipher.final()]));
 assert.equal((await take(4)).readUInt32BE(), 0, 'Generated VNC password must authenticate');
 viewer.send(Buffer.from([1])); // shared, preserving any other user viewer
 await take(24); // server init header; no framebuffer/pixels requested
 viewer.close(); viewer = undefined;
}
try {
 attempted = true; handle = await runtime.start();
 await until(async () => (await request({ cmd: 'ping' })).ok, 'Private daemon not ready');
 const creds = await until(() => runtime.viewerCredentials(), 'Private viewer credentials not ready');
 await until(async () => (await fetch(creds.url)).status === 200, 'Private viewer HTTP not ready');
 await verifyViewer(creds);
 await until(async () => (await request({ cmd: 'observe' })).windows?.some(w => /firefox/i.test(w.title)), 'Private Firefox window not ready');
 const markup = '<!doctype html><html><head><title>Owned Docker Fixture</title></head><body><label for="entry">Fixture input</label><input id="entry"><button onclick="this.textContent=\'Fixture done\'">Fixture button</button><p id="result">Fixture waiting</p></body></html>';
 // Fixed fixture-only file inside the exact owned container, not a public shell tool.
 await exec('docker', ['exec', '--user', `${process.getuid()}:${process.getuid()}`, handle.containerId, 'sh', '-c', 'printf %s "$1" > /home/browser/fixture.html', 'fixture', markup], { timeout: 5000 });
 assert.equal((await request({ cmd: 'keypress', key: 'ctrl+l' })).ok, true);
 assert.equal((await request({ cmd: 'type', text: 'file:///home/browser/fixture.html' })).ok, true);
 assert.equal((await request({ cmd: 'keypress', key: 'Return' })).ok, true);
 let lastFixtureNodes = [];
 const nodes = await until(async () => {
  const r = await request({ cmd: 'observe' });
  const nodes = r.snapshot?.nodes ?? []; lastFixtureNodes = nodes;
  return nodes.some(n => n.name === 'Fixture button' && n.role === 'push button') ? nodes : false;
 }, 'Private Firefox AT-SPI fixture controls missing').catch(error => {
  console.log('Owned fixture node metadata:', JSON.stringify(lastFixtureNodes.slice(0, 40).map(n => ({ name: n.name, role: n.role, value: n.value }))));
  throw error;
 });
 const button = nodes.find(n => n.name === 'Fixture button' && n.role === 'push button');
 assert.equal((await request({ cmd: 'click', id: button.id })).ok, true);
 await until(async () => {
  lastFixtureNodes = (await request({ cmd: 'observe' })).snapshot?.nodes ?? [];
  return lastFixtureNodes.some(n => n.name === 'Fixture done' || n.value === 'Fixture done');
 }, 'Private semantic click did not update fixture').catch(error => {
  console.log('Owned fixture after click:', JSON.stringify(lastFixtureNodes.slice(-30).map(n => ({ name: n.name, role: n.role, value: n.value }))));
  throw error;
 });
 const original = (await request({ cmd: 'daemon_info' })).daemon_info;
 assert.equal((await request({ cmd: 'stop' })).input_stopped, true);
 const blocked = await request({ cmd: 'keypress', key: 'ctrl+l' }); assert.equal(blocked.ok, false);
 await runtime.restartInput();
 await until(async () => { const info = (await request({ cmd: 'daemon_info' })).daemon_info; return info && !info.input_stopped && info.instance_id !== original.instance_id; }, 'Explicit daemon-only resume not verified');
 await until(async () => (await request({ cmd: 'observe' })).snapshot?.nodes?.some(n => n.name === 'Fixture done' || n.value === 'Fixture done'), 'Firefox page was not preserved across daemon resume');
 assert.equal((await fetch(creds.url)).status, 200);
 assert.equal((await runtime.viewerCredentials()).password, creds.password, 'Viewer password should survive daemon-only restart');
 console.log('PASS: owned Docker browser, localhost HTTP + authenticated RFB, Firefox AT-SPI native click, sticky Stop, daemon-only resume preserving browser/viewer; zero screenshots/host GUI/accounts.');
} catch (error) {
 if (handle) {
  const diagnostic = await exec('docker', ['stats', '--no-stream', '--format', 'fixture_pids={{.PIDs}} fixture_memory={{.MemUsage}}', handle.containerId], { timeout: 5000 }).catch(() => ({ stdout: 'Fixture stats unavailable' }));
  console.log(diagnostic.stdout.trim());
 }
 throw error;
} finally {
 viewer?.close();
 if (attempted) await runtime.stop();
}
