import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CID = 'b'.repeat(64), NID = 'c'.repeat(64);
const owner = 'org.pi-computer.browser';
function fake() {
  const calls = [], image = { Id: IMAGE_ID, Config: { Labels: { [owner]: 'v1' }, User: `${process.getuid()}:${process.getuid()}`, Entrypoint: ['/usr/local/bin/browser-entrypoint'] } };
  let state, network, container;
  const run = async args => {
    calls.push(args);
    if (args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (args[0] === 'build') return '';
    if (args[0] === 'image') return JSON.stringify(image);
    if (args[0] === 'network' && args[1] === 'create') {
      network = { Id: NID, Name: args.at(-1), Driver: 'bridge', Internal: false,
        Labels: { [owner]: 'v1', 'org.pi-computer.browser.id': args.at(-1).slice('pi-computer-net-'.length) } };
      return NID;
    }
    if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify(network ?? null);
    if (args[0] === 'run') {
      const value = option => args[args.indexOf(option) + 1];
      const id = value('--name').slice('pi-computer-browser-'.length);
      const ipc = value('--mount').match(/src=([^,]+),dst=/)[1];
      state = { Id: CID, Name: `/${value('--name')}`, Image: IMAGE_ID,
        Config: { Image: IMAGE_ID, User: value('--user'), Entrypoint: ['/usr/local/bin/browser-entrypoint'],
          Labels: { [owner]: 'v1', 'org.pi-computer.browser.id': id }, Env: ['DISPLAY=:99', 'HOME=/home/browser'] },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: value('--network'), PidMode: '', IpcMode: 'private',
          PidsLimit: 512, Memory: 2147483648, MemorySwap: 2147483648, NanoCpus: 2000000000,
          ShmSize: 268435456, AutoRemove: false,
          CapDrop: ['ALL'], CapAdd: null,
          SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': '', '/home/browser': '', '/run/user/browser': '' },
          PortBindings: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
        Mounts: [{ Type: 'bind', Source: ipc, Destination: '/ipc', RW: true }],
        NetworkSettings: { Networks: { [value('--network')]: {} }, Ports: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } }, State: { Running: true } };
      return CID;
    }
    if (args[0] === 'container') return JSON.stringify(state ?? null);
    if (args[0] === 'exec') return args.at(-1) === 'restart' ? '' : 'aB3+/cZ9';
    if (args[0] === 'stop') { state.State.Running = false; return ''; }
    if (args[0] === 'rm') { state = null; return ''; }
    if (args[0] === 'network' && args[1] === 'rm') { network = null; return ''; }
    throw Error('Unexpected Docker operation');
  };
  return { run, calls, get state() { return state; }, get network() { return network; } };
}
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-browser-test-'));
  try {
    const runtimeDir = path.join(dir, 'runtime'), stateDir = path.join(dir, 'state');
    await fs.mkdir(runtimeDir, { mode: 0o700 });
    const mock = fake(), opts = { sessionId: 'private-session', runtimeDir, stateDir, uid: process.getuid(), docker: mock.run };
    await fn({ runtime: new BrowserDockerRuntime(opts), reload: () => new BrowserDockerRuntime(opts), mock, dir });
  } finally { await fs.rm(dir, { force: true, recursive: true }); }
}
test('import is inert; explicit build, isolated run, reload, credentials and scoped stop', async () => fixture(async ({ runtime, reload, mock, dir }) => {
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
  assert.equal(run.filter(a => a === '--mount').length, 1);
  assert.equal(run[run.indexOf('--mount') + 1], `type=bind,src=${path.dirname(handle.socketPath)},dst=/ipc`);
  assert.ok(!run[run.indexOf('--mount') + 1].includes(',rw')); // bind defaults to read-write
  const fresh = reload();
  assert.equal((await fresh.status()).status, 'running');
  assert.ok(!JSON.stringify(await fresh.status()).includes('aB3+/cZ9'));
  assert.deepEqual(await fresh.viewerCredentials(), { url: 'http://127.0.0.1:49152/vnc.html', password: 'aB3+/cZ9' });
  assert.equal(await fresh.restartInput(), undefined);
  assert.deepEqual(mock.calls.find(a => a[0] === 'exec' && a.at(-1) === 'restart'),
    ['exec', '--user', `${process.getuid()}:${process.getuid()}`, CID, '/usr/local/bin/browser-daemon-control', 'restart']);
  await fresh.stop();
  assert.deepEqual(await fresh.status(), { status: 'absent' });
  assert.equal(mock.calls.filter(a => a[0] === 'rm').length, 1);
  assert.equal(mock.calls.filter(a => a[0] === 'network' && a[1] === 'rm').length, 1);
}));
test('crashed/stopped owned container with cleared published port can still be inspected and removed', async () => fixture(async ({ runtime, reload, mock }) => {
  await runtime.build(); await runtime.start();
  mock.state.State.Running = false;
  mock.state.NetworkSettings.Ports['6080/tcp'] = null;
  const status = await reload().status();
  assert.equal(status.status, 'stopped');
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
test('unsafe image/container alterations refuse inspection, credentials and deletion', async () => fixture(async ({ runtime, mock }) => {
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
test('private AT-SPI activation precedes Firefox and uses only the ephemeral profile', async () => {
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
