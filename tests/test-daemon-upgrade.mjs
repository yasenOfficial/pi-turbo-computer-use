#!/usr/bin/env node
// Authenticated version monitoring against real test-owned daemons. No desktop/bus/model.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, chmodSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'daemon/target/release/pi-turbo-daemon');
const base = mkdtempSync(path.join(os.tmpdir(), 'pi-version-test-'));
const releases = path.join(os.homedir(), '.local/share/pi-codex-ultra/releases');
const pkg = [process.env.PI_CODING_AGENT_PACKAGE,
  process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
  ...readdirSync(releases).sort().reverse().map(r => path.join(releases, r, 'node_modules/@earendil-works/pi-coding-agent/package.json'))].find(p => p && existsSync(p));
const require = createRequire(pkg);
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url);
const { DesktopDaemonStartup } = await jiti.import(path.join(root, '.pi/extensions/computer-use/daemon.ts'));
const { ComputerUseClient } = await jiti.import(path.join(root, '.pi/extensions/computer-use/client.ts'));
const { binaryBuildId } = await jiti.import(path.join(root, '.pi/extensions/computer-use/version.ts'));
const children = [];
const servers = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const initial = JSON.parse(execFileSync(source, ['--build-info'], { encoding: 'utf8' }));
// Fixture-only ELF metadata variation. Never mutate the repository binary.
function install(file, buildId) {
  const bytes = readFileSync(source);
  const old = Buffer.from(initial.build_id);
  let count = 0;
  for (let at = bytes.indexOf(old); at >= 0; at = bytes.indexOf(old, at + old.length)) {
    Buffer.from(buildId).copy(bytes, at); count++;
  }
  assert.ok(count > 0, 'compiled build ID must be in the isolated fixture');
  writeFileSync(file + '.tmp', bytes, { mode: 0o700 });
  renameSync(file + '.tmp', file);
  assert.equal(JSON.parse(execFileSync(file, ['--build-info'], { encoding: 'utf8' })).build_id, buildId);
}
const installed = path.join(base, 'daemon');
const socket = path.join(base, 'ipc');
const config = path.join(base, 'config.toml');
writeFileSync(config, '[daemon]\noverlay = false\n');
const env = { ...process.env, COMPUTER_USE_DAEMON: installed, COMPUTER_USE_CONFIG: config,
  COMPUTER_USE_SOCKET: socket, COMPUTER_USE_OVERLAY: '0', XDG_STATE_HOME: base,
  DISPLAY: '', XAUTHORITY: '', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' };
const launch = (file, e, fd) => {
  const child = spawn(file, [], { env: e, detached: true, stdio: ['ignore', 'ignore', fd] });
  children.push(child); return child;
};
const client = new ComputerUseClient({ socketPath: socket, timeoutMs: 2000 });
const info = async () => (await client.request({ cmd: 'daemon_info' })).daemon_info;
try {
  await assert.rejects(binaryBuildId('/usr/bin/true'), /no safe offline build probe/);
  install(installed, initial.build_id);
  let manager = new DesktopDaemonStartup(socket, env, 8000, launch);
  await Promise.all([manager.ensureCompatible(), manager.ensureCompatible(), manager.ensureCompatible()]);
  const first = await info();
  assert.equal(first.managed, true);
  assert.equal(first.build_id, initial.build_id);
  assert.equal(children.length, 1);
  const stateDir = path.join(base, 'pi-computer');
  const record = path.join(stateDir, readdirSync(stateDir).find(n => n.startsWith('owner-')));
  assert.equal(statSync(record).mode & 0o777, 0o600);
  const owner = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(owner.pid, first.pid);
  assert.equal(owner.instance_id, first.instance_id);
  assert.ok(!JSON.stringify(first).includes(owner.token), 'metadata must not expose upgrade token');
  const wrong = await client.request({ cmd: 'shutdown_if_idle', instance_id: first.instance_id, token: '00000000-0000-0000-0000-000000000000' }).catch(() => null);
  assert.equal(wrong, null, 'wrong token is rejected');
  assert.equal((await info()).pid, first.pid);

  const nextId = initial.build_id === 'aaaaaaaaaaaaaaaa' ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa';
  install(installed, nextId);
  // Simulate /reload: a fresh manager authenticates via the private persisted owner record.
  manager = new DesktopDaemonStartup(socket, env, 8000, launch);
  const token = '11111111-2222-3333-4444-555555555555';
  await client.request({ cmd: 'control_activity', action: 'begin', token, ttl_ms: 30000 });
  await manager.ensureCompatible();
  assert.equal((await info()).pid, first.pid, 'active workflow cannot be restarted');
  await client.request({ cmd: 'control_activity', action: 'end', token });
  await Promise.all([manager.ensureCompatible(), manager.ensureCompatible()]);
  const second = await info();
  assert.equal(second.build_id, nextId);
  assert.notEqual(second.pid, first.pid);
  assert.equal(children.length, 2, 'idle upgrade starts exactly one replacement');
  assert.equal(children[0].exitCode, 0, 'old daemon exits cooperatively, not by signal');

  install(installed, initial.build_id);
  await client.request({ cmd: 'stop' });
  await assert.rejects(manager.ensureCompatible(), /input stopped/);
  assert.equal((await info()).pid, second.pid, 'Stop forbids auto-upgrade');
  assert.equal(children.length, 2);

  const legacySocket = path.join(base, 'legacy');
  let legacyCommands = [];
  const legacy = createServer(s => { let text = ''; s.on('data', c => {
    text += c;
    if (text.includes('\n')) { legacyCommands.push(JSON.parse(text.split('\n')[0]).cmd); s.end('{"ok":false,"error":"unknown command"}\n'); }
  }); });
  servers.push(legacy);
  await new Promise(r => legacy.listen(legacySocket, r));
  const legacyManager = new DesktopDaemonStartup(legacySocket, env, 1000, () => { throw Error('must not replace legacy listener'); });
  await assert.rejects(legacyManager.ensureCompatible(), /legacy build/);
  assert.deepEqual(legacyCommands, ['daemon_info'], 'legacy protection must never issue AT-SPI observation');
  const unsafeSocket = path.join(base, 'unsafe');
  const unsafeCommands = [];
  const unsafe = createServer(s => { let text = ''; s.on('data', c => {
    text += c;
    if (text.includes('\n')) {
      unsafeCommands.push(JSON.parse(text.split('\n')[0]).cmd);
      s.end(JSON.stringify({ ok: true, daemon_info: { ...second, managed: false, input_stopped: false,
        busy: false, active_workflows: 0, capabilities: ['launch_app'] } }) + '\n');
    }
  }); });
  servers.push(unsafe);
  await new Promise(r => unsafe.listen(unsafeSocket, r));
  const unsafeManager = new DesktopDaemonStartup(unsafeSocket, env, 1000, () => { throw Error('must not replace unsafe unowned daemon'); });
  await assert.rejects(unsafeManager.ensureCompatible(), /lacks required safety fixes/);
  assert.deepEqual(unsafeCommands, ['daemon_info']);
  console.log('Real daemon version monitoring passed: private ownership, reload, active-workflow deferral, authenticated idle upgrade, concurrency, sticky Stop and legacy fail-closed. No desktop input.');
} finally {
  for (const server of servers) await new Promise(r => server.close(r));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  await pause(100);
  rmSync(base, { recursive: true, force: true });
}
