#!/usr/bin/env node
// Opt-in slash-command integration in a private test session. No real host GUI,
// user container/profile, provider calls, accounts, screenshots or notifications.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { BrowserDockerRuntime } from '../scripts/browser-docker.mjs';
import { extensionHarness } from './extension-harness.mjs';
if (process.env.RUN_BROWSER_USE_REAL !== '1') {
 console.log('SKIP: set RUN_BROWSER_USE_REAL=1 for the owned Docker command fixture'); process.exit(77);
}
const root = path.resolve(import.meta.dirname, '..');
const release = process.env.PI_CODEX_ULTRA_RELEASE_ROOT; assert.ok(release);
const require = createRequire(path.join(release, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
 typebox: require.resolve('typebox'), '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
} });
const { DesktopTarget } = await jiti.import(path.join(root, '.pi/extensions/computer-use/target.ts'));
const { ComputerUseMode } = await jiti.import(path.join(root, '.pi/extensions/computer-use/mode.ts'));
const { DesktopWorkflow } = await jiti.import(path.join(root, '.pi/extensions/computer-use/workflow.ts'));
const { registerComputerUseCommand } = await jiti.import(path.join(root, '.pi/extensions/computer-use/command.ts'));
const exec = promisify(execFile), sessionId = `command-fixture-${randomUUID()}`;
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'pbu-'));
const runtimeDir = path.join(fixtureDir, 'r'), stateDir = path.join(fixtureDir, 's');
await mkdir(runtimeDir, { mode: 0o700 }); await mkdir(stateDir, { mode: 0o700 });
// Shared production ownership must never be visible to this private fixture.
const runtime = new BrowserDockerRuntime({ sessionId, runtimeDir, stateDir }), harness = extensionHarness(new Map());
const messages = []; let idle = true, aborted = 0, target;
const ctx = { mode: 'tui', hasUI: true, signal: undefined,
 sessionManager: { getSessionId: () => sessionId, getBranch: () => harness.entries },
 isIdle: () => idle, abort: () => { aborted++; idle = true; },
 ui: { notify: (message, level) => messages.push({ message, level }), setWidget() {} },
};
const mode = new ComputerUseMode(harness.pi, async () => true);
const workflow = new DesktopWorkflow(request => target.lease(request, ctx));
target = new DesktopTarget(harness.pi, mode, workflow, id => { assert.equal(id, sessionId); return runtime; });
registerComputerUseCommand(harness.pi, mode, undefined, undefined, undefined, target);
mode.start(ctx, 'startup'); target.restore(ctx);
async function command(value) {
 messages.length = 0; await harness.commands.get('browser').handler(value, ctx);
 const failures = messages.filter(m => m.level === 'error');
 assert.deepEqual(failures, [], 'Slash command failed (private fixture diagnostic)');
 return messages.at(-1)?.message ?? '';
}
async function cleanupProfile() {
 const name = `pi-computer-profile-${runtime.key}`; let volume;
 try { volume = JSON.parse((await exec('docker', ['volume', 'inspect', '--format', '{{json .}}', name])).stdout); } catch { return; }
 assert.equal(volume.Name, name); assert.equal(volume.Driver, 'local');
 assert.equal(volume.Labels['org.pi-computer.browser.key'], runtime.key);
 assert.equal(volume.Labels['org.pi-computer.browser.uid'], String(process.getuid()));
 await exec('docker', ['volume', 'rm', name]);
}
try {
 const first = await command('use'); assert.equal(mode.isEnabled(), true); assert.equal(target.target, 'docker');
 const state = await runtime.status(); assert.equal(state.status, 'running'); assert.equal(state.authentication, 'none');
 assert.ok(first.includes(state.viewerUrl)); assert.equal((await fetch(state.viewerUrl)).status, 200);
 const pinTime = (await stat(runtime.imageFile)).mtimeMs;
 await command('use'); assert.equal((await runtime.status()).handle.containerId, state.handle.containerId);
 assert.equal((await stat(runtime.imageFile)).mtimeMs, pinTime, 'Repeated use must reuse the image, not rebuild');
 await exec('docker', ['exec', '--user', `${process.getuid()}:${process.getuid()}`, state.handle.containerId,
  'sh', '-c', 'printf %s browser-command-fixture > /home/browser/profile/command-fixture.txt']);
 await command('use pause'); assert.equal(mode.isEnabled(), false);
 await command('use'); assert.equal(mode.isEnabled(), true);
 assert.equal((await runtime.status()).handle.containerId, state.handle.containerId, 'Resume must preserve the browser container');
 idle = false; await command('use off'); assert.equal(mode.isEnabled(), false); assert.ok(aborted >= 2);
 assert.equal((await runtime.status()).status, 'absent');
 await command('use'); assert.equal(mode.isEnabled(), true);
 const again = await runtime.status(); assert.notEqual(again.handle.containerId, state.handle.containerId);
 await exec('docker', ['exec', '--user', `${process.getuid()}:${process.getuid()}`, again.handle.containerId,
  'grep', '-Fxq', 'browser-command-fixture', '/home/browser/profile/command-fixture.txt']);
 await command('use off'); await command('use off'); assert.equal(mode.isEnabled(), false);
 assert.equal((await runtime.status()).status, 'absent');
 console.log('PASS: /browser use automatically prepares/checks/enables, repeat reuses image/container, pause/use preserves browser, off aborts/removes, later use reuses profile. No host GUI or real user data.');
} finally {
 mode.setEnabled(false, ctx); await workflow.close(); await target.releaseControl(ctx);
 await runtime.stop(); await cleanupProfile(); await rm(fixtureDir, { recursive: true, force: true });
}
