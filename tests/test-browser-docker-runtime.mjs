import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CID = 'b'.repeat(64), NID = 'c'.repeat(64), HELPER_ID = 'd'.repeat(64);
const OLD_IMAGE_ID = `sha256:${'e'.repeat(64)}`;
const owner = 'org.pi-computer.browser';
function fake() {
  const calls = [], image = { Id: IMAGE_ID, Config: { Labels: { [owner]: 'v1', [`${owner}.schema`]: 'persistent-noauth-v2' }, User: `${process.getuid()}:${process.getuid()}`, Entrypoint: ['/usr/local/bin/browser-entrypoint'] } };
  let state, network, volume, helper, missingLegacyImage = false, missingV2Image = false;
  let missingTag = false, unsafeTag = false;
  const run = async args => {
    calls.push(args);
    if (args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (args[0] === 'build') { missingTag = false; return ''; }
    if (args[0] === 'image' && args.at(-1) === 'pi-computer-browser:local' && missingTag) return 'null';
    if (args[0] === 'image' && args.at(-1) === 'pi-computer-browser:local' && unsafeTag)
      return JSON.stringify({ ...image, Config: { ...image.Config, Labels: { [owner]: 'foreign' } } });
    if (args[0] === 'image' && args.at(-1) === OLD_IMAGE_ID && missingLegacyImage) return 'null';
    if (args[0] === 'image' && missingV2Image) return 'null';
    if (args[0] === 'image') return JSON.stringify(args.at(-1) === OLD_IMAGE_ID ? {
      ...image, Id: OLD_IMAGE_ID, Config: { ...image.Config, Labels: { [owner]: 'v1' } },
    } : image);
    if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify(volume ?? null);
    if (args[0] === 'volume' && args[1] === 'create') {
      volume = { Name: args.at(-1), Driver: 'local', Scope: 'local', Options: null,
        Labels: { [owner]: 'v1', [`${owner}.schema`]: 'persistent-noauth-v2',
          [`${owner}.key`]: args.find(x => x.startsWith(`${owner}.key=`)).split('=')[1],
          [`${owner}.uid`]: String(process.getuid()) } };
      return volume.Name;
    }
    if (args[0] === 'network' && args[1] === 'create') {
      network = { Id: NID, Name: args.at(-1), Driver: 'bridge', Internal: false,
        Labels: { [owner]: 'v1', 'org.pi-computer.browser.id': args.at(-1).slice('pi-computer-net-'.length) } };
      return NID;
    }
    if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify(network ?? null);
    if (args[0] === 'run') {
      const value = option => args[args.indexOf(option) + 1];
      const id = value('--name').slice('pi-computer-browser-'.length);
      const mounts = args.flatMap((a, i) => a === '--mount' ? [args[i + 1]] : []);
      const ipc = mounts[0].match(/src=([^,]+),dst=/)[1];
      state = { Id: CID, Name: `/${value('--name')}`, Image: IMAGE_ID,
        Config: { Image: IMAGE_ID, User: value('--user'), Entrypoint: ['/usr/local/bin/browser-entrypoint'],
          Labels: { [owner]: 'v1', [`${owner}.schema`]: 'persistent-noauth-v2', 'org.pi-computer.browser.id': id }, Env: ['DISPLAY=:99', 'HOME=/home/browser'] },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: value('--network'), PidMode: '', IpcMode: 'private',
          PidsLimit: 512, Memory: 2147483648, MemorySwap: 2147483648, NanoCpus: 2000000000,
          ShmSize: 268435456, AutoRemove: false,
          CapDrop: ['ALL'], CapAdd: null,
          SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': '', '/home/browser': '', '/run/user/browser': '' },
          PortBindings: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
        Mounts: [{ Type: 'bind', Source: ipc, Destination: '/ipc', RW: true },
          { Type: 'volume', Name: volume.Name, Driver: 'local', Destination: '/home/browser/profile', RW: true }],
        NetworkSettings: { Networks: { [value('--network')]: {} }, Ports: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } }, State: { Running: true } };
      return CID;
    }
    if (args[0] === 'create') {
      const get = key => args[args.indexOf(key) + 1];
      helper = { Id: HELPER_ID, Name: `/${get('--name')}`, Image: IMAGE_ID,
        Config: { Image: IMAGE_ID, User: get('--user'), Entrypoint: ['/usr/local/bin/browser-profile-import'],
          Labels: { [owner]: 'v1', [`${owner}.schema`]: 'persistent-noauth-v2' } },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: 'none', PidsLimit: 16,
          Memory: 134217728, MemorySwap: 134217728, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
          PortBindings: {} }, Mounts: [{ Type: 'volume', Name: volume.Name,
          Driver: 'local', Destination: '/home/browser/profile', RW: true }], State: { Running: false, ExitCode: 0 } };
      return HELPER_ID;
    }
    if (args[0] === 'container') return JSON.stringify(args.at(-1) === HELPER_ID ? helper : state ?? null);
    if (args[0] === 'exec') return args.at(-1) === 'restart' ? '' : 'aB3+/cZ9';
    if (args[0] === 'pause') { state.State.Paused = true; return ''; }
    if (args[0] === 'unpause') { state.State.Paused = false; return ''; }
    if (args[0] === 'stop') { state.State.Running = false; return ''; }
    if (args[0] === 'rm') { if (args.at(-1) === HELPER_ID) helper = null; else state = null; return ''; }
    if (args[0] === 'network' && args[1] === 'rm') { network = null; return ''; }
    throw Error('Unexpected Docker operation');
  };
  return { run, calls, image, get state() { return state; }, get network() { return network; },
    get volume() { return volume; }, set volume(value) { volume = value; }, get helper() { return helper; },
    set missingLegacyImage(value) { missingLegacyImage = value; },
    set missingV2Image(value) { missingV2Image = value; },
    set missingTag(value) { missingTag = value; }, set unsafeTag(value) { unsafeTag = value; } };
}
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-browser-test-'));
  try {
    const runtimeDir = path.join(dir, 'runtime'), stateDir = path.join(dir, 'state');
    await fs.mkdir(runtimeDir, { mode: 0o700 });
    const mock = fake(), opts = { sessionId: 'private-session', runtimeDir, stateDir, uid: process.getuid(), docker: mock.run };
    await fn({ runtime: new BrowserDockerRuntime(opts), reload: (overrides = {}) => new BrowserDockerRuntime({ ...opts, ...overrides }), mock, dir, opts });
  } finally { await fs.rm(dir, { force: true, recursive: true }); }
}
test('import is inert; explicit build, isolated run, reload, viewer and retained profile', async () => fixture(async ({ runtime, reload, mock, dir }) => {
  assert.deepEqual(await runtime.status(), { status: 'absent' });
  assert.equal(mock.calls.length, 0);
  await assert.rejects(() => runtime.start(), /Build.*explicitly/);
  await runtime.build();
  assert.equal(mock.calls.filter(a => a[0] === 'build').length, 1);
  const build = mock.calls.find(a => a[0] === 'build');
  assert.equal(build[build.indexOf('--build-arg') + 1], `BROWSER_UID=${process.getuid()}`);
  const handle = await runtime.start();
  assert.equal(handle.containerId, CID);
  assert.ok(handle.socketPath.startsWith(path.join(dir, 'runtime/pi-computer-docker')));
  assert.ok(!JSON.stringify(handle).includes('aB3+/cZ9'));
  const run = mock.calls.find(a => a[0] === 'run');
  for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus', '--network', '--mount', '--publish']) assert.ok(run.includes(flag), flag);
  assert.equal(run[run.indexOf('--pids-limit') + 1], '512');
  assert.equal(run[run.indexOf('--memory') + 1], '2g');
  assert.equal(run[run.indexOf('--memory-swap') + 1], '2g');
  assert.equal(run[run.indexOf('--cpus') + 1], '2');
  assert.equal(run[run.indexOf('--publish') + 1], '127.0.0.1::6080');
  assert.ok(!run.includes('--privileged') && !run.includes('--network=host'));
  assert.equal(run.filter(a => a === '--mount').length, 2);
  assert.equal(run[run.indexOf('--mount') + 1], `type=bind,src=${path.dirname(handle.socketPath)},dst=/ipc`);
  assert.equal(run[run.lastIndexOf('--mount') + 1], `type=volume,src=${mock.volume.Name},dst=/home/browser/profile`);
  const fresh = reload();
  assert.equal((await fresh.status()).status, 'running');
  assert.equal((await fresh.status()).imageId, IMAGE_ID);
  assert.ok(!JSON.stringify(await fresh.status()).includes('aB3+/cZ9'));
  assert.deepEqual(await fresh.viewerInfo(), { url: 'http://127.0.0.1:49152/vnc.html', authentication: 'none' });
  assert.equal(await fresh.restartInput(), undefined);
  assert.deepEqual(mock.calls.find(a => a[0] === 'exec' && a.at(-1) === 'restart'),
    ['exec', '--user', `${process.getuid()}:${process.getuid()}`, CID, '/usr/local/bin/browser-daemon-control', 'restart']);
  await fresh.stop();
  assert.deepEqual(await fresh.status(), { status: 'absent' });
  assert.equal(mock.calls.filter(a => a[0] === 'rm').length, 1);
  assert.equal(mock.calls.filter(a => a[0] === 'network' && a[1] === 'rm').length, 1);
  assert.equal(mock.calls.filter(a => a[0] === 'volume' && a[1] === 'rm').length, 0);
  await reload().start();
  assert.equal(mock.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 1);
  assert.equal(mock.calls.filter(a => a[0] === 'run').length, 2);
}));
test('atomic cross-chat control is idempotent for its owner and refuses foreign release', async () => fixture(async ({ runtime, reload, mock }) => {
  const a = randomUUID(), b = randomUUID();
  const other = reload({ sessionId: 'other-pi-chat' });
  await runtime.acquireControl(a);
  await runtime.acquireControl(a); // no reference-count; extension owns run leases
  await assert.rejects(() => other.acquireControl(b), /another Pi chat/);
  await assert.rejects(() => other.releaseControl(b), /refusing release/);
  const lock = path.join(runtime.stateDir, `${runtime.key}.control`);
  assert.equal((await fs.lstat(lock)).mode & 0o777, 0o700);
  assert.equal((await fs.lstat(path.join(lock, 'owner.json'))).mode & 0o777, 0o600);
  assert.equal(mock.calls.length, 0); // no Docker process/socket for control
  await runtime.releaseControl(a);
  assert.equal(await fs.stat(lock).then(() => true, error => error.code), 'ENOENT');
  await other.acquireControl(b);
  await other.releaseControl(b);
}));
test('incomplete and tampered control claims fail closed without removing another owner', async () => fixture(async ({ runtime, reload }) => {
  const lock = path.join(runtime.stateDir, `${runtime.key}.control`);
  await fs.mkdir(runtime.stateDir, { mode: 0o700 });
  await fs.mkdir(lock, { mode: 0o700 });
  await assert.rejects(() => runtime.acquireControl(randomUUID()), /Unsafe browser/);
  await assert.rejects(() => runtime.releaseControl(randomUUID()), /Unsafe browser/);
  await fs.symlink('/tmp/not-an-owner', path.join(lock, 'owner.json'));
  await assert.rejects(() => reload().acquireControl(randomUUID()), /Unsafe browser/);
  assert.equal((await fs.lstat(lock)).isDirectory(), true);
}));
test('different Pi chats share one verified container and one retained profile volume', async () => fixture(async ({ runtime, reload, mock }) => {
  const second = reload({ sessionId: 'another-independent-pi-chat' });
  assert.equal(second.key, runtime.key);
  assert.equal(second.file, runtime.file);
  assert.equal(second.profileFile, runtime.profileFile);
  await runtime.build();
  const first = await runtime.start();
  assert.equal((await second.status()).handle.containerId, first.containerId);
  await assert.rejects(() => second.start(), /already exists/);
  await second.stop();
  await second.start();
  assert.equal(mock.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 1);
  assert.equal(mock.calls.filter(a => a[0] === 'run').length, 2);
}));
test('older per-chat v2 owner metadata adopts exactly one verified profile without copying data', async () => fixture(async ({ runtime, reload, mock, dir }) => {
  await runtime.build(); await runtime.start();
  const oldKey = createHash('sha256').update('private-session').digest('hex');
  const oldName = `pi-computer-profile-${oldKey}`;
  const oldState = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  oldState.key = oldKey; oldState.profileVolume = oldName;
  await fs.writeFile(path.join(dir, 'state', `${oldKey}.json`), JSON.stringify(oldState), { mode: 0o600 });
  await fs.unlink(runtime.file);
  await fs.unlink(runtime.profileFile);
  await fs.writeFile(path.join(dir, 'state', `profile-${oldKey}.json`), JSON.stringify({
    key: oldKey, name: oldName, uid: process.getuid(), schema: 'persistent-noauth-v2',
  }), { mode: 0o600 });
  mock.volume.Name = oldName; mock.volume.Labels[`${owner}.key`] = oldKey;
  mock.state.Mounts[1].Name = oldName;
  const another = reload({ sessionId: 'new-pi-chat' });
  assert.equal((await another.status()).status, 'running');
  assert.equal((await another.status()).handle.containerId, CID);
  assert.equal(JSON.parse(await fs.readFile(runtime.profileFile, 'utf8')).volumeKey, oldKey);
  assert.equal(mock.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 1);
  await another.stop();
  await another.start();
  assert.equal(mock.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 1);
  assert.equal(mock.calls.findLast(a => a[0] === 'run')[mock.calls.findLast(a => a[0] === 'run').lastIndexOf('--mount') + 1],
    `type=volume,src=${oldName},dst=/home/browser/profile`);
}));
test('interrupted adoption cannot launch a second Firefox on an archived live owner', async () => fixture(async ({ runtime, reload, mock, dir }) => {
  await runtime.build(); await runtime.start();
  const oldKey = createHash('sha256').update('private-session').digest('hex');
  const oldVolume = `pi-computer-profile-${oldKey}`;
  const oldState = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  oldState.key = oldKey; oldState.profileVolume = oldVolume;
  await fs.writeFile(path.join(dir, 'state', `${oldKey}.json`), JSON.stringify(oldState), { mode: 0o600 });
  await fs.unlink(runtime.file); await fs.unlink(runtime.profileFile);
  await fs.writeFile(path.join(dir, 'state', `profile-${oldKey}.json`), JSON.stringify({
    key: oldKey, name: oldVolume, uid: process.getuid(), schema: 'persistent-noauth-v2',
  }), { mode: 0o600 });
  mock.volume.Name = oldVolume; mock.volume.Labels[`${owner}.key`] = oldKey;
  mock.state.Mounts[1].Name = oldVolume;
  const another = reload({ sessionId: 'another-chat' });
  await another.status(); // verified adoption, with archived former owner
  await fs.unlink(runtime.file); // simulate interruption before shared owner save
  await assert.rejects(() => another.status(), /Unsafe browser/);
  await assert.rejects(() => another.start(), /Unsafe browser/);
  assert.equal(mock.calls.filter(a => a[0] === 'run').length, 1);
}));
test('one verified legacy per-chat owner is shared across chats without touching its profile', async () => fixture(async ({ runtime, reload, mock, dir }) => {
  await runtime.build(); await runtime.start();
  const oldKey = createHash('sha256').update('private-session').digest('hex');
  const state = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  state.key = oldKey; state.imageId = OLD_IMAGE_ID;
  delete state.schema; delete state.profileVolume;
  await fs.writeFile(path.join(dir, 'state', `${oldKey}.json`), JSON.stringify(state), { mode: 0o600 });
  await fs.unlink(runtime.file);
  await fs.unlink(runtime.profileFile);
  mock.state.Image = OLD_IMAGE_ID; mock.state.Config.Image = OLD_IMAGE_ID;
  delete mock.state.Config.Labels[`${owner}.schema`]; mock.state.Mounts.pop();
  mock.missingLegacyImage = true;
  const other = reload({ sessionId: 'new-chat' });
  assert.equal((await other.status()).authentication, 'legacy-password');
  assert.equal((await runtime.status()).handle.containerId, CID);
  assert.ok(!mock.calls.some(a => a[0] === 'stop' || a[0] === 'exec'));
  assert.equal(mock.calls.filter(a => a[0] === 'run').length, 1);
}));
test('multiple old per-chat browser records refuse adoption rather than selecting a profile', async () => fixture(async ({ reload, dir, mock }) => {
  await fs.mkdir(path.join(dir, 'state'), { mode: 0o700 });
  for (const key of ['1'.repeat(64), '2'.repeat(64)])
    await fs.writeFile(path.join(dir, 'state', `${key}.json`), JSON.stringify({ key }), { mode: 0o600 });
  await assert.rejects(() => reload({ sessionId: 'new-chat' }).status(), /Unsafe browser/);
  assert.equal(mock.calls.length, 0);
}));
test('prepare builds only for missing, stale or unpinned sources; returns non-secret reuse metadata', async () => fixture(async ({ reload, mock, dir }) => {
  const root = path.join(dir, 'source');
  await fs.mkdir(path.join(root, 'daemon/src/nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'docker/browser'), { recursive: true });
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs'])
    await fs.writeFile(path.join(root, 'daemon', name), `fixture-${name}`);
  for (const name of ['Dockerfile', 'entrypoint.sh', 'session.sh', 'daemon-control.sh', 'profile-import.sh'])
    await fs.writeFile(path.join(root, 'docker/browser', name), `fixture-${name}`);
  await fs.writeFile(path.join(root, 'daemon/src/nested/main.rs'), 'fn main() {}');
  const runtime = reload({ repositoryRoot: root });
  mock.missingTag = true;
  assert.deepEqual(await runtime.prepare(), { built: true, imageId: IMAGE_ID });
  assert.equal(mock.calls.filter(a => a[0] === 'build').length, 1);
  const pin = JSON.parse(await fs.readFile(runtime.imageFile, 'utf8'));
  assert.match(pin.sourceFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(await reload({ repositoryRoot: root }).prepare(), { built: false, imageId: IMAGE_ID });
  assert.equal(mock.calls.filter(a => a[0] === 'build').length, 1);
  await fs.writeFile(path.join(root, 'daemon/src/nested/main.rs'), 'fn main() { /* changed */ }');
  assert.deepEqual(await runtime.prepare(), { built: true, imageId: IMAGE_ID });
  assert.equal(mock.calls.filter(a => a[0] === 'build').length, 2);
  await fs.writeFile(runtime.imageFile, JSON.stringify({ imageId: IMAGE_ID }));
  assert.deepEqual(await runtime.prepare(), { built: true, imageId: IMAGE_ID });
  assert.equal(mock.calls.filter(a => a[0] === 'build').length, 3);
  mock.unsafeTag = true;
  await assert.rejects(() => runtime.prepare(), /Unsafe browser/);
  assert.equal(mock.calls.filter(a => a[0] === 'build').length, 3);
}));
test('prepare never pins sources that change during build', async () => fixture(async ({ reload, mock, dir }) => {
  const root = path.join(dir, 'source');
  await fs.mkdir(path.join(root, 'daemon/src'), { recursive: true });
  await fs.mkdir(path.join(root, 'docker/browser'), { recursive: true });
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs'])
    await fs.writeFile(path.join(root, 'daemon', name), `fixture-${name}`);
  for (const name of ['Dockerfile', 'entrypoint.sh', 'session.sh', 'daemon-control.sh', 'profile-import.sh'])
    await fs.writeFile(path.join(root, 'docker/browser', name), `fixture-${name}`);
  const source = path.join(root, 'daemon/src/main.rs');
  await fs.writeFile(source, 'fn main() {}');
  const runtime = reload({ repositoryRoot: root });
  const real = mock.run;
  runtime.docker = async args => {
    const result = await real(args);
    if (args[0] === 'build') await fs.writeFile(source, 'fn main() { /* changed during build */ }');
    return result;
  };
  await assert.rejects(() => runtime.prepare(), /sources changed during build/);
  await assert.rejects(() => fs.readFile(runtime.imageFile), { code: 'ENOENT' });
}));
test('OFF cleanup can run while preparation is still building; prepare never starts a container', async () => fixture(async ({ runtime, mock }) => {
  const real = mock.run;
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  runtime.docker = async args => {
    if (args[0] === 'build') { entered(); await blocked; }
    return real(args);
  };
  const preparing = runtime.prepare();
  await began;
  try {
    await runtime.stop(); // different session lifecycle lock; no image-build wait
    assert.ok(!mock.calls.some(a => a[0] === 'run'));
  } finally { release(); }
  assert.equal((await preparing).built, true);
  assert.ok(!mock.calls.some(a => a[0] === 'run'));
}));
test('unavailable Docker fails preparation without attempting a build', async () => fixture(async ({ runtime, mock }) => {
  const real = mock.run;
  runtime.docker = args => args[0] === 'image' ? Promise.reject(Error('synthetic Docker unavailable')) : real(args);
  await assert.rejects(() => runtime.prepare(), /synthetic Docker unavailable/);
  assert.equal(mock.calls.filter(a => a[0] === 'build').length, 0);
}));
test('foreign and tampered persistent volumes fail closed without removing user data', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build();
  const foreign = { Name: `pi-computer-profile-${runtime.key}`, Driver: 'local', Scope: 'local', Labels: {} };
  mock.volume = foreign;
  await assert.rejects(() => runtime.start(), /Unsafe browser/);
  assert.equal(mock.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 0);
  mock.volume = null;
  await runtime.start();
  mock.volume.Options = { type: 'none', device: '/home/user', o: 'bind' };
  await assert.rejects(() => reload().status(), /Unsafe browser/);
  await assert.rejects(() => reload().stop(), /Unsafe browser/);
  assert.ok(!mock.calls.some(a => a[0] === 'volume' && a[1] === 'rm'));
}));
test('legacy ephemeral session cannot be stopped or have its password read', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  const state = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  delete state.schema; delete state.profileVolume;
  await fs.writeFile(runtime.file, JSON.stringify(state));
  delete mock.image.Config.Labels[`${owner}.schema`];
  delete mock.state.Config.Labels[`${owner}.schema`];
  mock.state.Mounts.pop();
  const legacy = reload();
  assert.equal((await legacy.status()).authentication, 'legacy-password');
  assert.deepEqual(await legacy.viewerInfo(), { url: 'http://127.0.0.1:49152/vnc.html',
    authentication: 'legacy-password', requiresRecreate: true });
  await assert.rejects(() => legacy.stop(), /Legacy ephemeral browser profile/);
  assert.ok(!mock.calls.some(a => a[0] === 'stop' || a[0] === 'rm' || a[0] === 'exec'));
}));
test('explicit migration streams only pinned IDs with fixed source freeze, then permits legacy stop and volume reuse', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  const state = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  delete state.schema; delete state.profileVolume; state.imageId = OLD_IMAGE_ID;
  await fs.writeFile(runtime.file, JSON.stringify(state));
  mock.state.Image = OLD_IMAGE_ID; mock.state.Config.Image = OLD_IMAGE_ID;
  delete mock.state.Config.Labels[`${owner}.schema`]; mock.state.Mounts.pop();
  const legacy = reload();
  const transfers = [];
  legacy.archiveTransfer = async (source, importer, uid) => {
    assert.notEqual(mock.state.State.Paused, true); // source must remain exec-able
    transfers.push([source, importer, uid]);
  };
  const result = await legacy.migrateLegacyProfile();
  assert.match(result.message, /copied/);
  assert.deepEqual(transfers, [[CID, HELPER_ID, process.getuid()]]);
  const create = mock.calls.find(a => a[0] === 'create');
  assert.ok(create.includes('--network') && create[create.indexOf('--network') + 1] === 'none');
  for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--memory-swap', '--mount'])
    assert.ok(create.includes(flag), flag);
  assert.equal(create.filter(a => a === '--mount').length, 1);
  assert.equal(create[create.indexOf('--mount') + 1], `type=volume,src=${mock.volume.Name},dst=/home/browser/profile`);
  assert.equal(create[create.indexOf('--entrypoint') + 1], '/usr/local/bin/browser-profile-import');
  assert.equal(create.at(-1), IMAGE_ID);
  assert.equal(mock.state.State.Paused, undefined);
  assert.ok(!mock.calls.some(a => a[0] === 'pause' || a[0] === 'unpause'));
  assert.ok(mock.calls.some(a => a[0] === 'exec' && a.includes('/bin/bash') && a.includes('-c')));
  assert.ok(!mock.calls.some(a => a[0] === 'volume' && a[1] === 'rm'));
  await reload().stop();
  await reload().start();
  assert.equal(mock.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 1);
}));
test('tampered import helper is refused before pausing source or reading profile', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  const state = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  delete state.schema; delete state.profileVolume; state.imageId = OLD_IMAGE_ID;
  await fs.writeFile(runtime.file, JSON.stringify(state));
  mock.state.Image = OLD_IMAGE_ID; mock.state.Config.Image = OLD_IMAGE_ID;
  delete mock.state.Config.Labels[`${owner}.schema`]; mock.state.Mounts.pop();
  const legacy = reload();
  let copied = false;
  legacy.archiveTransfer = async () => { copied = true; };
  const real = mock.run;
  legacy.docker = async args => {
    const result = await real(args);
    if (args[0] === 'create') mock.helper.Config.User = '0:0';
    return result;
  };
  await assert.rejects(() => legacy.migrateLegacyProfile(), /Unsafe browser/);
  assert.equal(copied, false);
  assert.equal(mock.state.State.Paused, undefined);
  assert.ok(!mock.calls.some(a => a[0] === 'pause'));
  assert.ok(!mock.calls.some(a => a[0] === 'rm' && a.at(-1) === HELPER_ID));
  await assert.rejects(() => reload().stop(), /Legacy ephemeral/);
}));
test('foreign import helper mount is rejected without profile transfer', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  const state = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  delete state.schema; delete state.profileVolume; state.imageId = OLD_IMAGE_ID;
  await fs.writeFile(runtime.file, JSON.stringify(state));
  mock.state.Image = OLD_IMAGE_ID; mock.state.Config.Image = OLD_IMAGE_ID;
  delete mock.state.Config.Labels[`${owner}.schema`]; mock.state.Mounts.pop();
  const legacy = reload();
  legacy.archiveTransfer = async () => { throw Error('archive must not be opened'); };
  const real = mock.run;
  legacy.docker = async args => {
    const result = await real(args);
    if (args[0] === 'create') mock.helper.Mounts[0].Name = 'another-users-profile';
    return result;
  };
  await assert.rejects(() => legacy.migrateLegacyProfile(), /Unsafe browser/);
  assert.ok(!mock.calls.some(a => a[0] === 'pause'));
  assert.equal(mock.state.State.Paused, undefined);
}));
test('failed transfer invokes fixed Firefox thaw and quarantines partial volume', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  const state = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  delete state.schema; delete state.profileVolume; state.imageId = OLD_IMAGE_ID;
  await fs.writeFile(runtime.file, JSON.stringify(state));
  mock.state.Image = OLD_IMAGE_ID; mock.state.Config.Image = OLD_IMAGE_ID;
  delete mock.state.Config.Labels[`${owner}.schema`]; mock.state.Mounts.pop();
  const legacy = reload();
  legacy.archiveTransfer = async () => { throw Error('synthetic transfer failure'); };
  await assert.rejects(() => legacy.migrateLegacyProfile(), /synthetic transfer failure/);
  assert.equal(mock.state.State.Paused, undefined);
  assert.ok(mock.calls.some(a => a[0] === 'exec' && a.includes('/bin/bash')));
  await assert.rejects(() => reload().stop(), /Legacy ephemeral/);
  await assert.rejects(() => reload().migrateLegacyProfile(), /already attempted/);
  assert.ok(!mock.calls.some(a => a[0] === 'stop'));
}));
test('GC of pinned legacy image allows strict container inspection, but never v2', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  const state = JSON.parse(await fs.readFile(runtime.file, 'utf8'));
  delete state.schema; delete state.profileVolume; state.imageId = OLD_IMAGE_ID;
  await fs.writeFile(runtime.file, JSON.stringify(state));
  mock.state.Image = OLD_IMAGE_ID; mock.state.Config.Image = OLD_IMAGE_ID;
  delete mock.state.Config.Labels[`${owner}.schema`]; mock.state.Mounts.pop();
  mock.missingLegacyImage = true;
  assert.equal((await reload().status()).authentication, 'legacy-password');
  mock.state.Image = IMAGE_ID;
  await assert.rejects(() => reload().status(), /Unsafe browser/);
}));
test('missing v2 image cannot be used even with a pinned container', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  mock.missingV2Image = true;
  await assert.rejects(() => reload().status(), /Unsafe browser/);
  await assert.rejects(() => reload().stop(), /Unsafe browser/);
}));
test('crashed/stopped owned container with cleared published port can still be inspected and removed', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  mock.state.State.Running = false;
  mock.state.NetworkSettings.Ports['6080/tcp'] = null;
  const status = await reload().status();
  assert.equal(status.status, 'stopped');
  assert.equal(status.imageId, IMAGE_ID);
  assert.equal(status.viewerUrl, undefined);
  await assert.rejects(() => reload().viewerCredentials(), /not running/);
  await assert.rejects(() => reload().restartInput(), /not running/);
  await reload().stop();
  assert.ok(mock.calls.some(a => a[0] === 'rm' && a[1] === CID));
  assert.ok(!mock.calls.some(a => a[0] === 'stop'));
}));
test('failed run after pinned network creation is recoverable without adopting by name', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build();
  const real = mock.run;
  runtime.docker = args => args[0] === 'run' ? Promise.reject(Error('synthetic create failure')) : real(args);
  await assert.rejects(() => runtime.start(), /synthetic create failure/);
  assert.equal((await reload().status()).status, 'incomplete');
  await reload().stop();
  assert.equal((await reload().status()).status, 'absent');
  assert.ok(mock.calls.some(a => a[0] === 'network' && a[1] === 'rm' && a[2] === NID));
}));
test('ambiguous run result never deletes an unpinned container', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build();
  const real = mock.run;
  runtime.docker = async args => {
    if (args[0] !== 'run') return real(args);
    await real(args);
    throw Error('lost run response');
  };
  await assert.rejects(() => runtime.start(), /lost run response/);
  await assert.rejects(() => reload().stop(), /Unsafe browser/);
  assert.ok(!mock.calls.some(a => a[0] === 'network' && a[1] === 'rm'));
}));
test('same session cannot race a second start; lock clears after settlement', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build();
  const real = mock.run;
  let entered, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  runtime.docker = async args => {
    if (args[0] === 'network' && args[1] === 'create') { entered(); await blocked; }
    return real(args);
  };
  const first = runtime.start();
  await began;
  await assert.rejects(() => reload().start(), /lifecycle is locked/);
  release();
  await first;
  await reload().stop();
}));
test('host IPC socket cannot be a symlink', async () => fixture(async ({ runtime, mock }) => {
  await runtime.build();
  const handle = await runtime.start();
  await fs.symlink('/tmp/not-a-daemon', handle.socketPath);
  await assert.rejects(() => runtime.status(), /Unsafe browser/);
  await assert.rejects(() => runtime.viewerCredentials(), /Unsafe browser/);
  await assert.rejects(() => runtime.restartInput(), /Unsafe browser/);
  assert.ok(!mock.calls.some(a => a[0] === 'exec'));
}));
test('unsafe image/container alterations refuse inspection, viewer and deletion', async () => fixture(async ({ runtime, mock }) => {
  await runtime.build(); await runtime.start();
  mock.state.Mounts.push({ Type: 'bind', Source: '/home/user', Destination: '/host', RW: true });
  await assert.rejects(() => runtime.status(), /Unsafe browser/);
  await assert.rejects(() => runtime.viewerCredentials(), /Unsafe browser/);
  await assert.rejects(() => runtime.stop(), /Unsafe browser/);
  assert.equal(mock.calls.filter(a => a[0] === 'rm').length, 0);
}));
test('foreign identity, network and privilege tampering fail closed', async () => fixture(async ({ runtime, mock }) => {
  await runtime.build(); await runtime.start();
  mock.state.HostConfig.Privileged = true;
  await assert.rejects(() => runtime.status(), /Unsafe browser/);
  mock.state.HostConfig.Privileged = false;
  mock.state.Config.Labels[owner] = 'forged';
  await assert.rejects(() => runtime.stop(), /Unsafe browser/);
  mock.state.Config.Labels[owner] = 'v1';
  mock.network.Driver = 'host';
  await assert.rejects(() => runtime.status(), /Unsafe browser/);
}));
test('port publication may not move to a non-loopback address', async () => fixture(async ({ runtime, mock }) => {
  await runtime.build(); await runtime.start();
  mock.state.NetworkSettings.Ports['6080/tcp'][0].HostIp = '0.0.0.0';
  await assert.rejects(() => runtime.status(), /Unsafe browser/);
  await assert.rejects(() => runtime.viewerCredentials(), /Unsafe browser/);
  await assert.rejects(() => runtime.stop(), /Unsafe browser/);
}));
test('private AT-SPI activation precedes Firefox and uses the dedicated profile', async () => {
  const root = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
  const [dockerfile, entrypoint, session] = await Promise.all(['Dockerfile', 'entrypoint.sh', 'session.sh']
    .map(name => fs.readFile(path.join(root, 'docker/browser', name), 'utf8')));
  assert.match(dockerfile, /libglib2\.0-bin libatk-bridge2\.0-0/);
  assert.match(dockerfile, /GTK_MODULES=gail:atk-bridge/);
  assert.match(dockerfile, /TOKIO_WORKER_THREADS=2/);
  assert.match(entrypoint, /accessibility\.force_disabled.*-1/);
  for (const preference of ['browser.aboutwelcome.enabled', 'browser.startup.homepage_override.mstone',
    'startup.homepage_welcome_url', 'browser.startup.page', 'browser.startup.homepage',
    'browser.newtabpage.enabled', 'datareporting.policy.dataSubmissionEnabled', 'toolkit.telemetry.enabled']) {
    assert.ok(entrypoint.includes(`user_pref("${preference}"`), preference);
  }
  for (const preference of ['dom.ipc.processCount', 'dom.ipc.processCount.webIsolated', 'media.ipc.processCount']) {
    assert.ok(entrypoint.includes(`user_pref("${preference}"`), preference);
  }
  assert.match(entrypoint, /\$HOME\/profile\/user\.js/);
  assert.ok(!entrypoint.includes('viewer-password'));
  assert.match(session, /-nopw/);
  assert.ok(!session.includes('-passwdfile'));
  assert.match(dockerfile, /persistent-noauth-v2/);
  assert.match(session, /IsEnabled ScreenReaderEnabled/);
  assert.ok(session.indexOf('gdbus call --session') < session.indexOf('firefox-esr --no-remote'));
  assert.ok(!session.includes('--system'));
});
test('remote Docker endpoint is refused before any build', async () => fixture(async ({ mock, runtime }) => {
  const normal = mock.run;
  runtime.docker = args => args[0] === 'context' ? JSON.stringify('tcp://example.invalid:2375') : normal(args);
  await assert.rejects(() => runtime.build(), /Unsafe browser/);
  assert.ok(!mock.calls.some(a => a[0] === 'build'));
}));
