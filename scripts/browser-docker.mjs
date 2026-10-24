// Browser-only Docker lifecycle. Importing this module never starts a process.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'pi-computer-browser:local';
const OWNER = 'org.pi-computer.browser';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const deny = () => { throw new Error('Unsafe browser container state; refusing operation'); };
function json(value) { try { return JSON.parse(value); } catch { return deny(); } }
async function dockerCommand(args, { input } = {}) {
  // Never expose Docker stderr/stdout (build output, container configuration, etc.).
  if (input !== undefined) throw new Error('Docker stdin not supported');
  // Rust --locked builds may take considerably longer than lifecycle probes.
  // Keep all build output private, including Docker's stderr and failure text.
  const building = args[0] === 'build';
  try { const { stdout } = await exec('docker', args, {
    maxBuffer: building ? 32 * 1024 * 1024 : 8 * 1024 * 1024,
    timeout: building ? 900_000 : 30_000,
  }); return stdout.trim(); }
  catch (error) {
    // Docker missing objects are a normal stopped-container case; do not
    // propagate stderr (which can include paths or configuration details).
    if (args[1] === 'inspect' && /No such (object|container|image|network):/.test(error?.stderr || '')) {
      const absent = new Error('Docker object absent'); absent.code = 'NOT_FOUND'; throw absent;
    }
    throw new Error('Docker operation failed (details withheld)');
  }
}
async function secureDir(dir, uid, create = false) {
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700) deny();
}
async function record(file, uid) {
  let info;
  try { info = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size > 4096) deny();
  return json(await fs.readFile(file, 'utf8'));
}
async function save(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try { await fs.rename(tmp, file); } finally { await fs.rm(tmp, { force: true }); }
}
function validState(s, key) {
  if (!s || s.key !== key || !UUID.test(s.id) || s.name !== `pi-computer-browser-${s.id}` ||
    s.network !== `pi-computer-net-${s.id}` || (s.containerId !== null && !ID.test(s.containerId)) ||
    !IMAGE_ID.test(s.imageId) || !s.socketPath?.endsWith(`/${s.id}/ipc/pi-computer.sock`) ||
    !path.isAbsolute(s.socketPath) || (s.networkId !== null && !ID.test(s.networkId))) deny();
}
function imageSafe(image, uid) {
  if (!IMAGE_ID.test(image.Id) || image.Config?.Labels?.[OWNER] !== 'v1' ||
    image.Config?.User !== `${uid}:${uid}` || image.Config?.Entrypoint?.length !== 1 ||
    image.Config.Entrypoint[0] !== '/usr/local/bin/browser-entrypoint') deny();
}
function containerSafe(info, s, ipc, uid) {
  if (info.Id !== s.containerId || info.Name !== `/${s.name}` || info.Image !== s.imageId ||
    info.Config?.Image !== s.imageId || info.Config?.Labels?.[OWNER] !== 'v1' ||
    info.Config?.Labels?.['org.pi-computer.browser.id'] !== s.id ||
    info.Config?.User !== `${uid}:${uid}` || info.Config?.Entrypoint?.[0] !== '/usr/local/bin/browser-entrypoint' ||
    info.HostConfig?.Privileged !== false || info.HostConfig?.ReadonlyRootfs !== true ||
    info.HostConfig?.NetworkMode !== s.network || info.HostConfig?.PidMode !== '' ||
    info.HostConfig?.IpcMode !== 'private' || info.HostConfig?.PidsLimit !== 512 ||
    info.HostConfig?.Memory !== 2147483648 || info.HostConfig?.MemorySwap !== 2147483648 ||
    info.HostConfig?.NanoCpus !== 2000000000 ||
    info.HostConfig?.ShmSize !== 268435456 || info.HostConfig?.AutoRemove !== false ||
    info.HostConfig?.CapDrop?.length !== 1 || info.HostConfig.CapDrop[0] !== 'ALL' || info.HostConfig?.CapAdd?.length ||
    info.HostConfig?.Devices?.length || info.HostConfig?.DeviceRequests?.length ||
    info.HostConfig?.VolumesFrom?.length || info.HostConfig?.Binds?.length ||
    info.HostConfig?.SecurityOpt?.length !== 1 || info.HostConfig.SecurityOpt[0] !== 'no-new-privileges' ||
    info.Mounts?.length !== 1 || info.Mounts[0].Type !== 'bind' || info.Mounts[0].Source !== ipc ||
    info.Mounts[0].Destination !== '/ipc' || info.Mounts[0].RW !== true ||
    Object.keys(info.HostConfig?.Tmpfs || {}).sort().join(',') !== '/home/browser,/run/user/browser,/tmp' ||
    (info.Config?.Env || []).some(e => /^(DISPLAY|HOME|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|COMPUTER_USE_SOCKET|COMPUTER_USE_OVERLAY|MOZ_ENABLE_WAYLAND|MOZ_ACCESSIBILITY_ENABLED|NO_AT_BRIDGE|GTK_MODULES|GNOME_ACCESSIBILITY|ACCESSIBILITY_ENABLED|GSETTINGS_BACKEND|GTK_USE_PORTAL|TOKIO_WORKER_THREADS)=/.test(e) && ![
      'DISPLAY=:99', 'HOME=/home/browser', 'XDG_RUNTIME_DIR=/run/user/browser', 'COMPUTER_USE_SOCKET=/ipc/pi-computer.sock',
      'COMPUTER_USE_OVERLAY=0', 'XDG_SESSION_TYPE=x11', 'MOZ_ENABLE_WAYLAND=0', 'MOZ_ACCESSIBILITY_ENABLED=1', 'NO_AT_BRIDGE=0',
      'GTK_MODULES=gail:atk-bridge', 'GNOME_ACCESSIBILITY=1', 'ACCESSIBILITY_ENABLED=1',
      'GSETTINGS_BACKEND=memory', 'GTK_USE_PORTAL=0', 'TOKIO_WORKER_THREADS=2',
    ].includes(e))) deny();
  const bindings = info.HostConfig?.PortBindings?.['6080/tcp'];
  const published = info.NetworkSettings?.Ports?.['6080/tcp'];
  // Docker may clear NetworkSettings.Ports after a crash/stop. The immutable
  // configured binding must remain loopback, but no active port is required
  // to inspect and remove our verified stopped container.
  if (Object.keys(info.HostConfig?.PortBindings || {}).join() !== '6080/tcp' || bindings?.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1' ||
      (!['', '0'].includes(bindings[0].HostPort) &&
       (!/^[1-9][0-9]{0,4}$/.test(bindings[0].HostPort) || +bindings[0].HostPort > 65535)) ||
      Object.keys(info.NetworkSettings?.Networks || {}).join() !== s.network) deny();
  if (info.State?.Running !== true) {
    if (published != null && (published.length !== 1 || published[0]?.HostIp !== '127.0.0.1' ||
        !/^[1-9][0-9]{0,4}$/.test(published[0]?.HostPort) || +published[0].HostPort > 65535)) deny();
    return null;
  }
  // Docker accepts an empty HostPort for auto-allocation; the actual assigned
  // numeric port is only guaranteed in NetworkSettings.Ports after creation.
  if (!['', '0', published?.[0]?.HostPort].includes(bindings[0].HostPort) ||
      Object.keys(info.NetworkSettings?.Ports || {}).join() !== '6080/tcp' || published?.length !== 1 ||
      published[0].HostIp !== '127.0.0.1' || !/^[1-9][0-9]{0,4}$/.test(published[0].HostPort) ||
      +published[0].HostPort > 65535) deny();
  return +published[0].HostPort;
}
/** Inject docker(args), runtimeDir, stateDir, uid and repositoryRoot only for isolated tests. */
export class BrowserDockerRuntime {
  constructor({ sessionId, docker = dockerCommand, runtimeDir = process.env.XDG_RUNTIME_DIR,
    stateDir = path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || '', '.local/state'), 'pi-computer/docker'),
    uid = process.getuid(), repositoryRoot = ROOT } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 2048 || typeof runtimeDir !== 'string' ||
      !path.isAbsolute(runtimeDir) || typeof stateDir !== 'string' || !path.isAbsolute(stateDir) ||
      !Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid browser runtime configuration');
    this.key = digest(sessionId); this.docker = docker; this.runtimeDir = runtimeDir;
    this.stateDir = stateDir; this.uid = uid; this.root = repositoryRoot;
    this.file = path.join(stateDir, `${this.key}.json`);
    this.imageFile = path.join(stateDir, 'image.json');
    this.base = path.join(runtimeDir, 'pi-computer-docker');
  }
  async #dirs() {
    await secureDir(this.runtimeDir, this.uid);
    await secureDir(this.stateDir, this.uid, true);
    await secureDir(this.base, this.uid, true);
  }
  async #owned() { await this.#dirs(); const s = await record(this.file, this.uid); if (s) validState(s, this.key); return s; }
  async #locked(action, lockName = this.key) {
    await this.#dirs();
    // Atomic same-session lock across instances/reloads. A lock left by a
    // killed process is intentionally not broken automatically; manual review
    // is safer than starting or deleting an ambiguously owned container.
    const lock = path.join(this.stateDir, `${lockName}.lock`);
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch { throw new Error('Browser lifecycle is locked; inspect private state before manual recovery'); }
    try { return await action(); } finally { await fs.rmdir(lock); }
  }
  async #localDocker() {
    // A remote Docker daemon would publish on a different machine, making the
    // localhost viewer URL misleading. Reject it rather than silently routing.
    if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix:///')) deny();
    const host = json(await this.docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
    if (typeof host !== 'string' || !host.startsWith('unix:///')) deny();
  }
  async #inspect(args) {
    try { return json(await this.docker(args)); }
    catch (e) { if (e?.code === 'NOT_FOUND') return null; throw e; }
  }
  async #network(s) {
    const n = await this.#inspect(['network', 'inspect', '--format', '{{json .}}', s.networkId]);
    if (!n || n.Id !== s.networkId || n.Name !== s.network || n.Driver !== 'bridge' || n.Internal !== false ||
       n.Labels?.[OWNER] !== 'v1' || n.Labels?.['org.pi-computer.browser.id'] !== s.id) deny();
  }
  async #checked(s) {
    if (!s.containerId || !s.networkId) deny();
    const ipc = path.join(this.base, s.id, 'ipc');
    if (s.socketPath !== path.join(ipc, 'pi-computer.sock')) deny();
    await secureDir(path.join(this.base, s.id), this.uid);
    await secureDir(ipc, this.uid);
    // The host IPC client must never follow a swapped symlink to a host
    // daemon. During startup the socket may not exist yet.
    let socket;
    try { socket = await fs.lstat(s.socketPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (socket && (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== this.uid ||
        (socket.mode & 0o7777) !== 0o600)) deny();
    await this.#network(s);
    const image = await this.#inspect(['image', 'inspect', '--format', '{{json .}}', s.imageId]);
    if (!image) deny(); imageSafe(image, this.uid);
    const info = await this.#inspect(['container', 'inspect', '--format', '{{json .}}', s.containerId]);
    if (!info) return null;
    const port = containerSafe(info, s, ipc, this.uid);
    return { info, port };
  }
  async build() { return this.#locked(() => this.#locked(async () => {
    await this.#dirs(); await this.#localDocker();
    // Stage exactly the Rust inputs and owned Dockerfiles, never the repository
    // root, .git, local profiles, artifacts, .env, target, or private state.
    const stage = await fs.mkdtemp(path.join(this.stateDir, 'build-'));
    try {
      await fs.mkdir(path.join(stage, 'daemon/src'), { recursive: true });
      await fs.mkdir(path.join(stage, 'docker/browser'), { recursive: true });
      const copyRegular = async (from, to) => {
        if (!(await fs.lstat(from)).isFile()) deny();
        await fs.copyFile(from, to);
      };
      for (const f of ['Cargo.toml', 'Cargo.lock', 'build.rs']) await copyRegular(path.join(this.root, 'daemon', f), path.join(stage, 'daemon', f));
      const copySources = async (source, dest) => {
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
          if (entry.isDirectory()) { await fs.mkdir(path.join(dest, entry.name)); await copySources(path.join(source, entry.name), path.join(dest, entry.name)); }
          else if (entry.isFile() && entry.name.endsWith('.rs')) await fs.copyFile(path.join(source, entry.name), path.join(dest, entry.name));
          else deny(); // No symlinks, hidden files, profiles, or extra build-context data.
        }
      };
      await copySources(path.join(this.root, 'daemon/src'), path.join(stage, 'daemon/src'));
      for (const f of ['Dockerfile', 'entrypoint.sh', 'session.sh', 'daemon-control.sh'])
        await copyRegular(path.join(this.root, 'docker/browser', f), path.join(stage, 'docker/browser', f));
      await this.docker(['build', '--pull', '--build-arg', `BROWSER_UID=${this.uid}`, '--label', `${OWNER}=v1`, '--tag', IMAGE,
        '--file', path.join(stage, 'docker/browser/Dockerfile'), stage]);
      const image = json(await this.docker(['image', 'inspect', '--format', '{{json .}}', IMAGE])); imageSafe(image, this.uid);
      await save(this.imageFile, { imageId: image.Id });
      return { message: 'Browser image built explicitly', imageId: image.Id };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }, 'image-build')); }
  async start() { return this.#locked(async () => {
    if (await this.#owned()) throw new Error('Browser session already exists; inspect or stop it first');
    await this.#localDocker();
    const pin = await record(this.imageFile, this.uid);
    if (!pin || !IMAGE_ID.test(pin.imageId)) throw new Error('Build the browser image explicitly before starting');
    const image = json(await this.docker(['image', 'inspect', '--format', '{{json .}}', IMAGE])); imageSafe(image, this.uid);
    if (image.Id !== pin.imageId) deny();
    const id = randomUUID(), name = `pi-computer-browser-${id}`, network = `pi-computer-net-${id}`;
    const dir = path.join(this.base, id), ipc = path.join(dir, 'ipc');
    await secureDir(ipc, this.uid, true); await secureDir(dir, this.uid);
    const s = { key: this.key, id, name, network, containerId: null, networkId: null, imageId: image.Id, socketPath: path.join(ipc, 'pi-computer.sock') };
    // Persist before creating resources; on uncertain failure refuse, never adopt by name.
    await save(this.file, s);
    const nid = (await this.docker(['network', 'create', '--driver', 'bridge', '--label', `${OWNER}=v1`, '--label', `org.pi-computer.browser.id=${id}`, network])).trim();
    if (!ID.test(nid)) deny(); s.networkId = nid; await save(this.file, s);
    await this.#network(s);
    const cid = (await this.docker(['run', '--detach', '--name', name, '--label', `${OWNER}=v1`, '--label', `org.pi-computer.browser.id=${id}`,
      '--network', network, '--publish', '127.0.0.1::6080', '--user', `${this.uid}:${this.uid}`, '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '512', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2', '--shm-size', '256m',
      '--tmpfs', `/tmp:rw,nosuid,nodev,size=128m,uid=${this.uid},gid=${this.uid},mode=700`,
      '--tmpfs', `/run/user/browser:rw,nosuid,nodev,size=32m,uid=${this.uid},gid=${this.uid},mode=700`,
      '--tmpfs', `/home/browser:rw,nosuid,nodev,size=1g,uid=${this.uid},gid=${this.uid},mode=700`,
      '--mount', `type=bind,src=${ipc},dst=/ipc`, '--env', 'COMPUTER_USE_SOCKET=/ipc/pi-computer.sock',
      '--env', 'COMPUTER_USE_OVERLAY=0', s.imageId])).trim();
    if (!ID.test(cid)) deny(); s.containerId = cid; await save(this.file, s);
    const checked = await this.#checked(s);
    if (!checked?.info.State?.Running) throw new Error('Browser container exited during startup; stop it before retrying');
    return Object.freeze({ id, name, containerId: cid, socketPath: s.socketPath });
  }); }
  async status() {
    const s = await this.#owned();
    if (!s) return { status: 'absent' };
    await this.#localDocker();
    if (!s.containerId || !s.networkId) return { status: 'incomplete' };
    const checked = await this.#checked(s);
    if (!checked) return { status: 'stopped' };
    const { info, port } = checked;
    return { status: info.State?.Running === true ? 'running' : 'stopped',
      handle: { id: s.id, name: s.name, containerId: s.containerId, socketPath: s.socketPath },
      ...(port === null ? {} : { viewerUrl: `http://127.0.0.1:${port}/vnc.html` }) };
  }
  async viewerCredentials() {
    const s = await this.#owned(); if (!s) throw new Error('No browser session');
    await this.#localDocker();
    const checked = await this.#checked(s);
    if (!checked?.info.State?.Running) throw new Error('Browser is not running');
    // Only caller-provided user UI may receive this object; never put it in status/logs.
    const password = (await this.docker(['exec', '--user', `${this.uid}:${this.uid}`, s.containerId, 'cat', '/run/user/browser/viewer-password'])).trim();
    if (!/^[A-Za-z0-9+/]{8}$/.test(password)) deny();
    return { url: `http://127.0.0.1:${checked.port}/vnc.html`, password };
  }
  async restartInput() { return this.#locked(async () => {
    const s = await this.#owned(); if (!s) throw new Error('No browser session');
    await this.#localDocker();
    const checked = await this.#checked(s);
    if (!checked?.info.State?.Running) throw new Error('Browser is not running');
    // Explicit user-authorized resume only. This fixed, image-owned helper
    // signals the supervisor to replace its daemon child; it cannot run any
    // caller-supplied command and never restarts Firefox or the VNC viewer.
    await this.docker(['exec', '--user', `${this.uid}:${this.uid}`, s.containerId,
      '/usr/local/bin/browser-daemon-control', 'restart']);
  }); }
  async stop() { return this.#locked(async () => {
    const s = await this.#owned(); if (!s) return;
    await this.#localDocker();
    if (!s.containerId) {
      // A failed run may have created a container before its ID was returned.
      // Never adopt/delete an object by name: require it to be absent first.
      const uncertain = await this.#inspect(['container', 'inspect', '--format', '{{json .}}', s.name]);
      if (uncertain) deny();
      if (!s.networkId) {
        // Likewise a lost network-create response cannot be safely adopted.
        if (await this.#inspect(['network', 'inspect', '--format', '{{json .}}', s.network])) deny();
      } else {
        await this.#network(s);
        await this.docker(['network', 'rm', s.networkId]);
      }
    } else {
      const checked = await this.#checked(s);
      if (checked) {
        if (checked.info.State?.Running) await this.docker(['stop', '--time', '10', s.containerId]);
        await this.docker(['rm', s.containerId]);
      }
      await this.#network(s);
      await this.docker(['network', 'rm', s.networkId]);
    }
    await secureDir(path.join(this.base, s.id), this.uid);
    await secureDir(path.join(this.base, s.id, 'ipc'), this.uid);
    await fs.rm(path.join(this.base, s.id), { recursive: true, force: true });
    await fs.unlink(this.file);
  }); }
}
