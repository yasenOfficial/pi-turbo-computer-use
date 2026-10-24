#!/usr/bin/env node
// Loopback fixture only: never contacts Docker, the user's viewer or a GUI.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const releases = path.join(os.homedir(), '.local/share/pi-codex-ultra/releases');
const sdkPackage = [process.env.PI_CODING_AGENT_PACKAGE,
 process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
 ...(existsSync(releases) ? readdirSync(releases).sort().reverse().map(r => path.join(releases, r,
  'node_modules/@earendil-works/pi-coding-agent/package.json')) : [])].find(p => p && existsSync(p));
if (!sdkPackage) throw Error('Pi SDK unavailable');
const sdk = createRequire(sdkPackage);
const { WebSocketServer } = sdk('ws');
const { createJiti } = await import(pathToFileURL(sdk.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false,
 alias: { typebox: sdk.resolve('typebox'), '@earendil-works/pi-tui': sdk.resolve('@earendil-works/pi-tui') } });
const { checkViewer } = await jiti.import(path.resolve(import.meta.dirname, '../.pi/extensions/computer-use/target.ts'));

async function fixture(mode, run) {
 const clientMessages = [];
 const server = createServer((_req, response) => {
  response.writeHead(mode === 'http404' ? 404 : 200, { 'Content-Type': 'text/html' });
  response.end('test-owned noVNC page');
 });
 const wsServer = new WebSocketServer({ server, path: '/websockify', handleProtocols: protocols =>
  protocols.has('binary') ? 'binary' : false });
 wsServer.on('connection', peer => {
  if (mode === 'noVnc') { peer.close(); return; }
  if (mode === 'stall') return;
  peer.send(Buffer.from('RFB 003.008\n', 'ascii'));
  peer.on('message', (data, isBinary) => {
   assert.equal(isBinary, true, 'the RFB handshake must use binary WebSocket frames');
   clientMessages.push(Buffer.from(data));
   if (clientMessages.length === 1) {
    assert.equal(data.toString('ascii'), 'RFB 003.008\n');
    peer.send(Buffer.from(mode === 'password' ? [1, 2] : [1, 1]));
   } else if (clientMessages.length === 2) {
    assert.deepEqual([...data], [1], 'only choose unauthenticated RFB');
    peer.send(Buffer.alloc(4));
   } else if (clientMessages.length === 3) {
    assert.deepEqual([...data], [1], 'only shared ClientInit, never GUI input');
    const init = Buffer.alloc(24 + 7);
    init.writeUInt16BE(1280, 0); init.writeUInt16BE(720, 2);
    init.writeUInt32BE(7, 20); init.write('fixture', 24);
    peer.send(init);
   } else assert.fail('viewer probe must never request framebuffer or send desktop input');
  });
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  await run(`http://127.0.0.1:${server.address().port}/vnc.html`, clientMessages);
 } finally {
  for (const peer of wsServer.clients) peer.terminate();
  await new Promise(resolve => wsServer.close(resolve));
  await new Promise(resolve => server.close(resolve));
 }
}
await assert.rejects(checkViewer('http://example.com/vnc.html'), /Unsafe Docker viewer URL/);
await assert.rejects(checkViewer('http://127.0.0.1:6080/vnc.html?password=secret'), /Unsafe Docker viewer URL/);
await fixture('http404', async url => assert.rejects(checkViewer(url), /viewer page is unavailable/));
await fixture('noVnc', async url => assert.rejects(checkViewer(url), /proxy\/VNC backend is unavailable/));
await fixture('stall', async url => {
 const start = Date.now();
 await assert.rejects(checkViewer(url), /proxy\/VNC backend is unavailable/);
 assert.ok(Date.now() - start < 4000, 'silent VNC backend must time out within 3 seconds');
});
await fixture('password', async (url, received) => {
 await assert.rejects(checkViewer(url), /proxy\/VNC backend is unavailable/);
 assert.equal(received.length, 1, 'must refuse password authentication without attempting a password');
});
await fixture('ok', async (url, received) => {
 await checkViewer(url);
 await new Promise(resolve => setTimeout(resolve, 30));
 assert.equal(received.length, 3, 'only RFB metadata handshake, no framebuffer request or input');
});
console.log('Loopback viewer probe: HTTP-only failure, VNC disconnect/password refusal, bounded read-only RFB success');
