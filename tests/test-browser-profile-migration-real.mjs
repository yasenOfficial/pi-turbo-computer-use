#!/usr/bin/env node
// Opt-in, test-owned legacy -> v2 Docker profile migration. Never use a real session.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';

if (process.env.RUN_BROWSER_PROFILE_MIGRATION_REAL !== '1') {
  console.log('SKIP: set RUN_BROWSER_PROFILE_MIGRATION_REAL=1 after the v2 image build');
  process.exit(77);
}
const exec = promisify(execFile);
// Build from tracked v1 sources into a unique fixture tag; never export/commit
// a running container or replace the global v2 tag or image pin.
const REV = '1a87115';
let LEGACY;
const legacyTag = `pi-computer-browser:legacy-fixture-${randomUUID()}`;
const OWNER = 'org.pi-computer.browser', SCHEMA = 'persistent-noauth-v2';
const ID = /^[0-9a-f]{64}$/, IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const uid = process.getuid();
assert.ok(uid > 0 && (!process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('unix:///')),
  'Local, non-root Docker only');
// AF_UNIX paths are limited to 107 bytes on Linux; keep the private root short.
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pbm-'));
await fs.chmod(fixture, 0o700);
const runtimeDir = path.join(fixture, 'runtime'), stateDir = path.join(fixture, 'state');
await fs.mkdir(runtimeDir, { mode: 0o700 }); await fs.mkdir(stateDir, { mode: 0o700 });
const sessionId = `fixture-migrate-${randomUUID()}`;
const options = { sessionId, runtimeDir, stateDir, uid };
let oldRuntime, runtime, source, current, migrated = false, legacyBuilt = false, phase = 'preflight';
async function docker(args) {
  try { return (await exec('docker', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch (e) {
    if (args[1] === 'inspect' && /no such (object|container|image|network|volume)/i.test(e.stderr || '')) {
      const missing = new Error('Docker object absent'); missing.code = 'NOT_FOUND'; throw missing;
    }
    throw Error('Private fixture Docker operation failed (details withheld)');
  }
}
const oldDocker = args => docker(args[0] === 'image' && args[1] === 'inspect' && args.at(-1) === 'pi-computer-browser:local'
  ? [...args.slice(0, -1), LEGACY] : args);
const inspect = async (kind, id) => JSON.parse(await docker([kind, 'inspect', '--format', '{{json .}}', id]));
async function buildLegacy() {
  const stage = path.join(fixture, 'build-context');
  await fs.mkdir(stage, { mode: 0o700 });
  const { stdout } = await exec('git', ['ls-tree', '-r', '--name-only', REV, 'daemon', 'docker/browser'],
    { timeout: 10_000, maxBuffer: 64 * 1024 });
  const names = stdout.trim().split('\n');
  const fixed = ['daemon/Cargo.toml', 'daemon/Cargo.lock', 'daemon/build.rs',
    'docker/browser/Dockerfile', 'docker/browser/entrypoint.sh', 'docker/browser/session.sh',
    'docker/browser/daemon-control.sh'];
  assert.ok(fixed.every(name => names.includes(name)) && names.some(name => name === 'daemon/src/main.rs'));
  assert.ok(names.every(name => fixed.includes(name) || /^daemon\/src\/(?:[a-z_]+\/)*[a-z_]+\.rs$/.test(name)),
    'Only the exact tracked v1 build allowlist may enter the fixture context');
  for (const name of names) {
    const { stdout: contents } = await exec('git', ['show', `${REV}:${name}`],
      { encoding: 'buffer', timeout: 10_000, maxBuffer: 1024 * 1024 });
    const target = path.join(stage, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, contents, { mode: 0o600 });
  }
  // Output is discarded even on failure: build layers must never be included
  // in test diagnostics. Only this uniquely named test image can be removed.
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['build', '--pull=false', '--build-arg', `BROWSER_UID=${uid}`,
      '--label', `${OWNER}=v1`, '--label', `${OWNER}.fixture=${sessionId}`,
      '--tag', legacyTag, '--file', path.join(stage, 'docker/browser/Dockerfile'), stage],
    { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 900_000);
    child.once('error', () => { clearTimeout(timer); reject(Error('Private v1 fixture build failed')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Private v1 fixture build failed')); });
  });
  legacyBuilt = true;
  const image = await inspect('image', legacyTag);
  assert.ok(IMAGE_ID.test(image.Id));
  assert.equal(image.Config.Labels[`${OWNER}.fixture`], sessionId);
  return image.Id;
}
async function assertOwned(handle, legacy) {
  assert.ok(handle && ID.test(handle.containerId));
  const info = await inspect('container', handle.containerId);
  assert.equal(info.Id, handle.containerId);
  assert.equal(info.Name, `/${handle.name}`);
  assert.equal(info.Name, `/pi-computer-browser-${handle.id}`);
  assert.equal(info.Config.Labels[OWNER], 'v1');
  assert.equal(info.Config.Labels[`${OWNER}.id`], handle.id);
  assert.equal(info.Config.User, `${uid}:${uid}`);
  assert.equal(info.Image, legacy ? LEGACY : v2id);
  assert.equal(info.Mounts.find(m => m.Destination === '/ipc')?.Source,
    path.join(runtimeDir, 'pi-computer-docker', handle.id, 'ipc'));
  if (!legacy) assert.equal(info.Mounts.find(m => m.Destination === '/home/browser/profile')?.Name,
    `pi-computer-profile-${runtime.key}`);
  return info;
}
let v2id;
async function ping(handle) {
  assert.ok(handle.socketPath === path.join(runtimeDir, 'pi-computer-docker', handle.id, 'ipc', 'pi-computer.sock'));
  for (let n = 0; n < 100; n++) {
    try {
      const response = await new Promise((resolve, reject) => {
        const socket = createConnection(handle.socketPath); let data = '', done = false;
        const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => finish(Error('Private fixture IPC timeout')), 3000);
        socket.on('error', () => finish(Error('Private fixture IPC unavailable')));
        socket.on('connect', () => socket.write('{"cmd":"ping"}\n'));
        socket.on('data', chunk => { data += chunk; if (data.includes('\n')) {
          try { finish(null, JSON.parse(data.split('\n')[0])); } catch { finish(Error('Invalid fixture IPC')); }
        } });
      });
      if (response.ok) return;
    } catch { /* daemon starting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Private fixture daemon did not start');
}
async function marker(handle, create) {
  await assertOwned(handle, create);
  const args = ['exec', '--user', `${uid}:${uid}`, handle.containerId];
  if (create) await docker([...args, 'sh', '-c', 'printf %s "$1" > /home/browser/profile/migration-fixture.txt', 'fixture', sessionId]);
  else {
    await docker([...args, 'grep', '-Fxq', sessionId, '/home/browser/profile/migration-fixture.txt']);
    assert.equal(await docker([...args, 'stat', '-c', '%a:%u', '/home/browser/profile']), `700:${uid}`);
    await docker([...args, 'test', '-f', '/home/browser/profile/user.js']);
  }
}
async function cleanupVolume() {
  if (!runtime) return;
  const name = `pi-computer-profile-${runtime.key}`;
  let volume;
  try { volume = await inspect('volume', name); }
  catch (e) { if (e.code === 'NOT_FOUND') return; throw e; }
  assert.equal(volume.Name, name); assert.equal(volume.Driver, 'local');
  assert.equal(volume.Labels[OWNER], 'v1'); assert.equal(volume.Labels[`${OWNER}.schema`], SCHEMA);
  assert.equal(volume.Labels[`${OWNER}.key`], runtime.key);
  assert.equal(volume.Labels[`${OWNER}.uid`], String(uid));
  await docker(['volume', 'rm', name]);
}
try {
  const { stdout: oldSource } = await exec('git', ['show', '1a87115:scripts/browser-docker.mjs'],
    { timeout: 10_000, maxBuffer: 256 * 1024 });
  const oldModule = path.join(fixture, 'legacy.mjs'); await fs.writeFile(oldModule, oldSource, { mode: 0o600 });
  const { BrowserDockerRuntime: LegacyRuntime } = await import(`file://${oldModule}`);
  phase = 'legacy build'; LEGACY = await buildLegacy();
  const oldImage = await inspect('image', LEGACY);
  assert.equal(oldImage.Id, LEGACY); assert.equal(oldImage.Config.Labels[OWNER], 'v1');
  assert.equal(oldImage.Config.Labels[`${OWNER}.fixture`], sessionId);
  assert.equal(oldImage.Config.Labels[`${OWNER}.schema`], undefined);
  assert.equal(oldImage.Config.User, `${uid}:${uid}`);
  const image = await inspect('image', 'pi-computer-browser:local'); v2id = image.Id;
  assert.ok(IMAGE_ID.test(v2id) && v2id !== LEGACY);
  assert.equal(image.Config.Labels[OWNER], 'v1'); assert.equal(image.Config.Labels[`${OWNER}.schema`], SCHEMA);
  assert.equal(image.Config.User, `${uid}:${uid}`);
  await fs.writeFile(path.join(stateDir, 'image.json'), JSON.stringify({ imageId: LEGACY }), { mode: 0o600 });
  oldRuntime = new LegacyRuntime({ ...options, docker: oldDocker });
  runtime = new BrowserDockerRuntime({ ...options, docker });
  phase = 'legacy start'; source = await oldRuntime.start(); await assertOwned(source, true); await ping(source);
  await marker(source, true);
  // Switch only the private pin; the old container stays alive until import is verified.
  await fs.writeFile(path.join(stateDir, 'image.json'), JSON.stringify({ imageId: v2id }), { mode: 0o600 });
  phase = 'profile import'; await runtime.migrateLegacyProfile();
  assert.equal((await assertOwned(source, true)).State.Paused, false);
  await runtime.stop(); source = undefined; migrated = true;
  phase = 'v2 start'; current = await runtime.start(); await assertOwned(current, false); await ping(current);
  await marker(current, false);
  assert.equal((await runtime.viewerInfo()).authentication, 'none');
  const previousId = current.containerId;
  phase = 'v2 recreation'; await runtime.stop(); current = await runtime.start();
  assert.notEqual(current.containerId, previousId);
  await ping(current); await marker(current, false);
  console.log('PASS: isolated legacy profile import, v2 no-auth viewer, and marker retention across removal/recreation');
} catch (e) {
  console.error(`Private fixture failed during ${phase} (Docker details withheld)`);
  throw e;
} finally {
  // Runtime stop only reads the private session record and validates its exact
  // owned container/network before deletion. On failed import use the old API.
  if (current) await runtime.stop();
  else if (source) {
    const info = await assertOwned(source, true);
    if (info.State.Paused) await docker(['unpause', source.containerId]);
    await oldRuntime.stop();
  } else if (migrated) await runtime.stop();
  else if (oldRuntime) await oldRuntime.stop();
  await cleanupVolume();
  if (legacyBuilt) {
    const image = await inspect('image', legacyTag);
    assert.equal(image.Id, LEGACY);
    assert.equal(image.Config.Labels[`${OWNER}.fixture`], sessionId);
    await docker(['image', 'rm', legacyTag]);
  }
  await fs.rm(fixture, { recursive: true, force: true });
}
