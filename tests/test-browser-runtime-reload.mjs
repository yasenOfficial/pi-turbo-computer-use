#!/usr/bin/env node
// Pi's REAL extension resource loader, in one process, against a test-owned
// browser runtime file. Never opens Docker, a GUI, or the user's browser state.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const releases = path.join(os.homedir(), '.local/share/pi-codex-ultra/releases');
const sdkPackage = [process.env.PI_CODING_AGENT_PACKAGE,
 process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
 ...(existsSync(releases) ? readdirSync(releases).sort().reverse().map(r => path.join(releases, r,
  'node_modules/@earendil-works/pi-coding-agent/package.json')) : [])].find(p => p && existsSync(p));
if (!sdkPackage) throw Error('Pi SDK unavailable');
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
 await import(pathToFileURL(path.join(path.dirname(sdkPackage), 'dist/index.js')));
const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-browser-reload-fixture-'));
const previousState = process.env.XDG_STATE_HOME, previousSocket = process.env.COMPUTER_USE_SOCKET;
process.env.XDG_STATE_HOME = path.join(tmp, 'private-state');
process.env.COMPUTER_USE_SOCKET = path.join(tmp, 'unavailable-host.sock');
let session;
try {
 const extensionDir = path.join(tmp, 'fixture/.pi/extensions/computer-use');
 const runtimeFile = path.join(tmp, 'fixture/scripts/browser-docker.mjs');
 const extensionPath = path.join(extensionDir, 'index.ts');
 await mkdir(extensionDir, { recursive: true });
 await mkdir(path.dirname(runtimeFile), { recursive: true });
 for (const file of readdirSync(path.join(root, '.pi/extensions/computer-use')))
  if (file.endsWith('.ts') || file === 'runtime-loader.mjs')
   await copyFile(path.join(root, '.pi/extensions/computer-use', file), path.join(extensionDir, file));
 const oldRuntime = `export class BrowserDockerRuntime {
  constructor({ sessionId }) { this.sessionId = sessionId; }
}\n`;
 await writeFile(runtimeFile, oldRuntime);
 // Simulate the incompatible OLD native ESM namespace already cached by Pi.
 const stale = await import(pathToFileURL(runtimeFile));
 assert.equal(stale.BrowserDockerRuntime.prototype.acquireControl, undefined);
 const cwd = path.join(tmp, 'unrelated-session');
 await mkdir(cwd);
 const agentDir = path.join(tmp, 'agent');
 const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
 const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [extensionPath], noContextFiles: true });
 await resources.reload();
 assert.match(JSON.stringify(resources.getExtensions().errors), /lacks shared control safety methods/,
  'incompatible old class fails closed at factory load');
 ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: resources,
  sessionManager: SessionManager.inMemory(cwd) }));
 const errors = [];
 await session.bindExtensions({ mode: 'print', onError: e => errors.push(e) });
 const notices = [];
 const ctx = { mode: 'print', hasUI: false, isIdle: () => true, signal: undefined, abort() {},
  sessionManager: session.sessionManager, ui: { notify: text => notices.push(text) } };
 const command = () => resources.getExtensions().extensions.find(e => e.path === extensionPath)?.commands.get('browser');
 assert.equal(command(), undefined, 'incompatible old runtime never registered /browser');
 // The source at the SAME absolute .mjs path gains the two control methods;
 // old native namespace stays cached, but Pi /reload must load new source.
 await writeFile(runtimeFile, `export class BrowserDockerRuntime {
  constructor({ sessionId }) { this.sessionId = sessionId; }
  async acquireControl() { throw Error('TEST_NEW_NATIVE_CLASS'); }
  async releaseControl() {}
}\n`);
 assert.match((await readFile(runtimeFile, 'utf8')), /TEST_NEW_NATIVE_CLASS/);
 assert.equal(stale.BrowserDockerRuntime.prototype.acquireControl, undefined,
  'incompatible native namespace really stayed cached');
 await session.reload();
 assert.deepEqual(resources.getExtensions().errors, []);
 assert.ok(command(), 'real Pi reload registered /browser after native runtime upgrade');
 notices.length = 0;
 await command().handler('use', ctx);
 assert.match(notices.at(-1), /TEST_NEW_NATIVE_CLASS/, 'same-process Pi reload loads the changed runtime constructor');
 assert.doesNotMatch(notices.at(-1), /Shared browser control is unavailable/);
 assert.deepEqual(errors, []);
 console.log('Real Pi /reload refreshes on-disk native Docker runtime class without Docker, daemon, model or GUI');
} finally {
 session?.dispose();
 if (previousState === undefined) delete process.env.XDG_STATE_HOME;
 else process.env.XDG_STATE_HOME = previousState;
 if (previousSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
 else process.env.COMPUTER_USE_SOCKET = previousSocket;
 await rm(tmp, { recursive: true, force: true });
}
