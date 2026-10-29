#!/usr/bin/env node
// Isolated lifecycle fixture; never touches a real Docker container or host GUI.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensionHarness } from './extension-harness.mjs';

const releases = path.join(os.homedir(), '.local/share/pi-codex-ultra/releases');
const sdk = [process.env.PI_CODING_AGENT_PACKAGE,
 ...readdirSync(releases).sort().reverse().map(r => path.join(releases, r, 'node_modules/@earendil-works/pi-coding-agent/package.json'))]
 .find(p => p && existsSync(p));
const require = createRequire(sdk);
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
 typebox: require.resolve('typebox'), '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
} });
const { ComputerUseMode } = jiti('../.pi/extensions/computer-use/mode.ts');
const { DesktopTarget } = jiti('../.pi/extensions/computer-use/target.ts');
const { DesktopWorkflow } = jiti('../.pi/extensions/computer-use/workflow.ts');
const { registerComputerUseCommand } = jiti('../.pi/extensions/computer-use/command.ts');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-browser-use-'));
const socketPath = path.join(tmp, 'docker-owned.sock');
const oldHostSocket = process.env.COMPUTER_USE_SOCKET;
process.env.COMPUTER_USE_SOCKET = path.join(tmp, 'host-must-not-exist.sock');
let daemonStopped = false, acknowledge = true, otherBusy = false, otherWorkflows = 0, memoryConstrained = false;
const received = [];
const server = createServer(socket => {
 let buffer = '';
 socket.on('data', data => {
  buffer += data;
  const newline = buffer.indexOf('\n'); if (newline < 0) return;
  const input = JSON.parse(buffer.slice(0, newline)); received.push(input);
  if (input.cmd === 'stop') daemonStopped = true;
  const output = input.cmd === 'daemon_info' && memoryConstrained ? { ok: false } : input.cmd === 'daemon_info' ? { ok: true, daemon_info: {
   protocol_version: 1, build_id: 'a'.repeat(16), instance_id: 'b'.repeat(32), pid: 456,
   capabilities: ['atspi_direct_properties', 'verified_focus', 'launch_app'], managed: false,
   input_stopped: daemonStopped, busy: otherBusy, active_workflows: otherWorkflows,
  } } : { ok: true, input_stopped: input.cmd === 'stop' && acknowledge };
  socket.end(JSON.stringify(output) + '\n');
 });
});
await new Promise(resolve => server.listen(socketPath, resolve));
await chmod(socketPath, 0o600);
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
try {
 const harness = extensionHarness(new Map());
 const notes = []; let idle = true, aborted = 0, health = 0;
 const ctx = { mode: 'tui', hasUI: true, signal: undefined, isIdle: () => idle, abort: () => { aborted++; },
  sessionManager: { getBranch: () => harness.entries, getSessionId: () => 'browser-use-fixture' },
  ui: { notify: (message, level) => notes.push({ message, level }), setWidget() {} } };
 const mode = new ComputerUseMode(harness.pi, async () => true);
 let target;
 const workflow = new DesktopWorkflow(request => target.lease(request, ctx), 600_000);
 let state = 'absent', legacy = false, migrated = false, prepareCalls = 0, starts = 0, stops = 0, imports = 0,
  resumes = 0, resourceChecks = 0, failResources = false, prepareGate, startGate, failPrepare = false;
 let pinnedImage = `sha256:${'a'.repeat(64)}`, runningImage = pinnedImage;
 let transientHealthFailures = 0, healthGate;
 let claimedOwner, claims = 0, releases = 0;
 const handle = { id: 'fixture', name: 'fixture', containerId: 'fixture-id', socketPath };
 const runtime = {
  async acquireControl(owner) { if (claimedOwner && claimedOwner !== owner) throw Error('Shared browser is claimed by another chat');
   claimedOwner = owner; claims++; },
  async releaseControl(owner) { assert.equal(claimedOwner, owner); claimedOwner = undefined; releases++; },
  async prepare() { prepareCalls++; if (prepareGate) await prepareGate.promise;
   if (failPrepare) throw Error('Preparation rejected; no container started');
   return { built: prepareCalls === 1, imageId: pinnedImage }; },
  async status() { return state === 'absent' ? { status: 'absent' } : { status: state, handle, imageId: runningImage,
   authentication: legacy ? 'legacy-password' : 'none', ...(legacy ? { requiresRecreate: true } : {}) }; },
  async start() { starts++; if (startGate) await startGate.promise;
   assert.equal(state, 'absent'); state = 'running'; daemonStopped = false; runningImage = pinnedImage;
   if (migrated) legacy = false;
   return handle; },
  async stop() { assert.ok(!legacy || migrated, 'unmigrated legacy source must survive'); stops++; state = 'absent'; },
  async migrateLegacyProfile() { assert.equal(legacy, true); assert.equal(daemonStopped, true);
   imports++; migrated = true; return { message: 'private import complete' }; },
  async ensureResources() {
   assert.ok(claimedOwner, 'resource mutation requires the shared claim');
   assert.equal(mode.isEnabled(), false, 'resource mutation happens only while OFF');
   resourceChecks++; if (failResources) throw Error('Browser resource limit update was not verified');
   memoryConstrained = false;
  },
  async restartInput() { assert.equal(daemonStopped, true); daemonStopped = false; resumes++; },
  async viewerInfo() { return { url: 'http://127.0.0.1:6080/vnc.html', authentication: legacy ? 'legacy-password' : 'none' }; },
  async build() { throw Error('Explicit build must not be called by /browser use'); },
 };
 target = new DesktopTarget(harness.pi, mode, workflow, id => {
  assert.equal(id, 'browser-use-fixture'); return runtime;
 }, async url => {
  health++; assert.equal(url, 'http://127.0.0.1:6080/vnc.html');
  if (healthGate) await healthGate.promise;
  if (transientHealthFailures-- > 0) throw Error('transient localhost viewer connection reset');
 });
 registerComputerUseCommand(harness.pi, mode, undefined, undefined, undefined, target);
 mode.start(ctx, 'startup'); target.restore(ctx);
 const browser = harness.commands.get('browser');
 assert.ok(browser); assert.deepEqual(browser.getArgumentCompletions('').map(({ value }) => value), ['use', 'use off', 'use pause']);
 assert.equal(state, 'absent'); assert.equal(prepareCalls, 0, 'loading and session start do not prepare anything');
 assert.equal(resourceChecks, 0, 'loading/session start never changes container resources');
 // Explicit browser use may switch from an idle host-ON branch, but must
 // withdraw host desktop authorization before touching Docker lifecycle.
 mode.setEnabled(true, ctx);
 let prepareObservedMode;
 const originalPrepare = runtime.prepare;
 runtime.prepare = async () => { prepareObservedMode = { enabled: mode.isEnabled(), target: target.target }; return originalPrepare(); };
 const command = async args => { await browser.handler(args, ctx); return notes.at(-1); };
 const first = await command('use');
 assert.deepEqual(prepareObservedMode, { enabled: false, target: 'docker' }, 'Docker is pinned and host ON withdrawn before preparation');
 assert.match(first.message, /Computer use ON.*127\.0\.0\.1:6080/);
 assert.equal(first.level, 'info'); assert.equal(target.target, 'docker'); assert.equal(mode.isEnabled(), true);
 assert.equal(prepareCalls, 1); assert.equal(starts, 1); assert.equal(health, 1);
 assert.equal(claimedOwner, undefined); assert.equal(claims, 1); assert.equal(releases, 1);
 assert.ok(harness.entries.some(e => e.customType === 'computer-use-target-v1' && e.data.target === 'docker'));
 // Capacity recovery must precede daemon_info: a memory-starved daemon
 // cannot answer the normal workflow handshake until its cap is raised.
 memoryConstrained = true;
 await command('use'); assert.equal(starts, 1, 'repeated use reuses owned browser');
 assert.equal(memoryConstrained, false);
 assert.equal(prepareCalls, 2); assert.equal(health, 2); assert.equal(resourceChecks, 1);
 // A failed in-place capacity upgrade must not restart/replace the browser
 // or enable input. Only another explicit use may retry it.
 failResources = true;
 const beforeCapacityFailure = { starts, stops, health };
 const capacityFailure = await command('use');
 assert.equal(capacityFailure.level, 'error'); assert.match(capacityFailure.message, /resource limit update/);
 assert.equal(mode.isEnabled(), false); assert.equal(state, 'running');
 assert.deepEqual({ starts, stops, health }, beforeCapacityFailure);
 failResources = false;
 await command('use'); assert.equal(mode.isEnabled(), true);
 idle = false;
 const off = await command('use off'); idle = true;
 assert.match(off.message, /Shared Docker browser OFF for all Pi chats.*Common private profile retained/);
 assert.equal(mode.isEnabled(), false); assert.equal(state, 'absent'); assert.equal(stops, 1); assert.ok(aborted > 0);
 assert.equal(received.filter(r => r.cmd === 'stop').length, 1, 'Stop goes only to verified Docker socket');
 await command('use'); assert.equal(starts, 2); assert.equal(mode.isEnabled(), true);
 await command('use pause'); assert.equal(mode.isEnabled(), false); assert.equal(daemonStopped, true);
 await command('use'); assert.equal(resumes, 1, 'explicit use resets sticky Stop daemon-only');
 assert.equal(starts, 2); assert.equal(mode.isEnabled(), true);
 await command('use off'); assert.equal(stops, 2);
 // A user invoking /browser use explicitly authorizes migration, unlike idle status/reload.
 state = 'running'; legacy = true; migrated = false; daemonStopped = false;
 const oldStops = received.filter(r => r.cmd === 'stop').length;
 await command('use');
 assert.equal(imports, 1); assert.equal(starts, 3); assert.equal(stops, 3);
 assert.equal(received.filter(r => r.cmd === 'stop').length, oldStops + 1);
 assert.equal(legacy, false); assert.equal(state, 'running'); assert.equal(mode.isEnabled(), true);
 await command('use off'); assert.equal(state, 'absent');
 // A failing preparation pins Docker OFF before any startup; no host fallback.
 failPrepare = true; const beforeFailStarts = starts;
 const failed = await command('use'); assert.equal(failed.level, 'error');
 assert.equal(starts, beforeFailStarts); assert.equal(target.target, 'docker'); assert.equal(mode.isEnabled(), false);
 failPrepare = false;
 // Off while build is pending returns without waiting for a potentially long image build.
 prepareGate = deferred(); const waiting = command('use');
 await new Promise(resolve => setTimeout(resolve, 0));
 assert.equal(mode.isEnabled(), false);
 const stoppedDuringBuild = await command('use off');
 assert.match(stoppedDuringBuild.message, /No owned container/);
 prepareGate.release(); await waiting; prepareGate = undefined;
 assert.equal(starts, beforeFailStarts); assert.equal(mode.isEnabled(), false);
 // Off while container start is in flight waits for it to settle, then stops it.
 startGate = deferred(); const starting = command('use');
 for (let i = 0; i < 40 && starts === beforeFailStarts; i++) await new Promise(resolve => setTimeout(resolve, 5));
 assert.equal(starts, beforeFailStarts + 1);
 const offDuringStart = command('use off');
 assert.equal(mode.isEnabled(), false);
 startGate.release(); await starting;
 assert.match((await offDuringStart).message, /Shared Docker browser OFF/);
 startGate = undefined; assert.equal(state, 'absent'); assert.equal(mode.isEnabled(), false);
 // Native Stop not acknowledged: never claim completion or remove the browser.
 await command('use'); acknowledge = false;
 const stopBeforeUncertain = stops;
 const uncertain = await command('use off');
 assert.equal(uncertain.level, 'error'); assert.equal(stops, stopBeforeUncertain);
 assert.equal(mode.isEnabled(), false); assert.equal(target.target, 'docker');
 acknowledge = true;
 await command('use off'); assert.equal(state, 'absent');
 // A stopped v2 container has no daemon/input to acknowledge: remove its
 // verified record and retain the same private profile, without sending Stop.
 state = 'stopped'; legacy = false;
 const stoppedStopCount = received.filter(r => r.cmd === 'stop').length;
 const stoppedResult = await command('use off');
 assert.match(stoppedResult.message, /stopped owned container removed.*private profile retained/);
 assert.equal(state, 'absent');
 assert.equal(received.filter(r => r.cmd === 'stop').length, stoppedStopCount);
 // OFF from a live legacy session imports the profile, acknowledges native
 // Stop, and removes only the old container; it must NOT launch a replacement.
 state = 'running'; legacy = true; migrated = false; daemonStopped = false;
 const beforeLegacyStarts = starts, beforeLegacyImports = imports;
 const legacyOff = await command('use off');
 assert.match(legacyOff.message, /legacy profile migrated.*old container removed/);
 assert.equal(imports, beforeLegacyImports + 1); assert.equal(starts, beforeLegacyStarts);
 assert.equal(state, 'absent'); assert.equal(mode.isEnabled(), false);
 // Read-only localhost viewer health retries are bounded; never retry input.
 transientHealthFailures = 2;
 const healthBeforeRetry = health;
 await command('use');
 assert.equal(health - healthBeforeRetry, 3); assert.equal(mode.isEnabled(), true);
 // A fresh image pin replaces the verified stale container, retaining volume.
 pinnedImage = `sha256:${'c'.repeat(64)}`;
 const beforeUpgradeStarts = starts, beforeUpgradeStops = stops;
 await command('use');
 assert.equal(starts, beforeUpgradeStarts + 1); assert.equal(stops, beforeUpgradeStops + 1);
 assert.equal(runningImage, pinnedImage); assert.equal(mode.isEnabled(), true);
 pinnedImage = `sha256:${'d'.repeat(64)}`;
 acknowledge = false;
 const beforeRejectedUpgradeStarts = starts, beforeRejectedUpgradeStops = stops;
 const rejectedUpgrade = await command('use');
 assert.equal(rejectedUpgrade.level, 'error');
 assert.match(rejectedUpgrade.message, /Stop was not acknowledged/);
 assert.equal(starts, beforeRejectedUpgradeStarts); assert.equal(stops, beforeRejectedUpgradeStops);
 assert.equal(mode.isEnabled(), false); assert.equal(state, 'running');
 acknowledge = true;
 await command('use'); // Only a second explicit user command may retry the upgrade.
 assert.equal(starts, beforeRejectedUpgradeStarts + 1);
 await command('use off');
 // Aborting during a pending viewer health check cannot flip ON afterward.
 healthGate = deferred(); const checkedBefore = health;
 const checking = command('use');
 for (let i = 0; i < 40 && health === checkedBefore; i++) await new Promise(resolve => setTimeout(resolve, 5));
 assert.ok(health > checkedBefore); assert.equal(mode.isEnabled(), false);
 const offDuringHealth = await command('use off');
 assert.match(offDuringHealth.message, /Shared Docker browser OFF/);
 healthGate.release(); await checking; healthGate = undefined;
 assert.equal(mode.isEnabled(), false); assert.equal(state, 'absent');
 await workflow.stop();
 // Two Pi sessions share one browser runtime. A run holds the atomic claim
 // across calls; a second chat cannot prepare or automate concurrently. Only
 // its own explicit /browser use may repin a CID changed by the other chat.
 let sharedState = 'absent', sharedId = 0, sharedOwner;
 const sharedImage = `sha256:${'e'.repeat(64)}`;
 const sharedRuntime = {
  async acquireControl(owner) { if (sharedOwner && sharedOwner !== owner) throw Error('Shared browser claimed by another Pi chat'); sharedOwner = owner; },
  async releaseControl(owner) { assert.equal(sharedOwner, owner); sharedOwner = undefined; },
  async prepare() { return { built: false, imageId: sharedImage }; },
  async status() { return sharedState === 'absent' ? { status: 'absent' } : { status: 'running', imageId: sharedImage,
   authentication: 'none', handle: { id: 'shared-fixture', name: 'shared-fixture', containerId: `cid-${sharedId}`, socketPath } }; },
  async start() { sharedId++; sharedState = 'running'; daemonStopped = false;
   return { id: 'shared-fixture', name: 'shared-fixture', containerId: `cid-${sharedId}`, socketPath }; },
  async stop() { sharedState = 'absent'; },
  async viewerInfo() { return { url: 'http://127.0.0.1:6080/vnc.html', authentication: 'none' }; },
  async ensureResources() { assert.ok(sharedOwner, 'resource upgrade requires exclusive shared control'); },
  async restartInput() { daemonStopped = false; },
  async migrateLegacyProfile() { throw Error('No legacy fixture'); },
 };
 const shared = session => {
  const h = extensionHarness(new Map());
  const context = { ...ctx, sessionManager: { getBranch: () => h.entries, getSessionId: () => session } };
  const m = new ComputerUseMode(h.pi, async () => true);
  const w = new DesktopWorkflow(async () => ({ ok: true }));
  const t = new DesktopTarget(h.pi, m, w, () => sharedRuntime, async () => {});
  m.start(context, 'startup'); t.restore(context);
  return { t, m, w, context };
 };
 const alpha = shared('alpha'), beta = shared('beta');
 await alpha.t.browserUse(alpha.context);
 otherBusy = true; otherWorkflows = 1;
 await assert.rejects(beta.t.browserUse(beta.context), /busy in another Pi workflow/);
 assert.equal(beta.m.isEnabled(), false); assert.equal(sharedState, 'running');
 otherBusy = false; otherWorkflows = 0;
 // An uncertain prior workflow can remain active even after its Pi claim is
 // gone. The next first tool claim checks daemon metadata and releases cleanly.
 otherWorkflows = 1;
 await assert.rejects(alpha.t.acquireControl(alpha.context, 'docker'), /busy in another Pi workflow/);
 assert.equal(sharedOwner, undefined, 'busy-daemon rejection releases the cross-Pi claim');
 otherWorkflows = 0;
 await alpha.t.acquireControl(alpha.context, 'docker'); // first active agent run
 await assert.rejects(beta.t.browserUse(beta.context), /claimed by another Pi chat/);
 assert.equal(beta.m.isEnabled(), false); assert.equal(sharedId, 1);
 await assert.rejects(beta.t.browserOff(beta.context), /claimed by another Pi chat/);
 assert.equal(sharedState, 'running', 'OFF in another chat cannot tear down an active claimed workflow');
 await alpha.t.releaseControl(alpha.context); // agent_settled
 await beta.t.browserUse(beta.context);
 await beta.t.acquireControl(beta.context, 'docker');
 await assert.rejects(alpha.t.acquireControl(alpha.context, 'docker'), /claimed by another Pi chat/);
 await beta.t.releaseControl(beta.context);
 await beta.t.browserOff(beta.context);
 await beta.t.browserUse(beta.context);
 assert.equal(sharedId, 2, 'other chat recreated the single shared owned container');
 await assert.rejects(alpha.t.request(alpha.context, 'docker', { cmd: 'observe' }), /identity changed/);
 await alpha.t.browserOff(alpha.context); // explicit shared OFF repins only with no active tool
 assert.equal(sharedState, 'absent'); assert.equal(alpha.m.isEnabled(), false);
 await beta.t.browserUse(beta.context);
 assert.equal(sharedId, 3);
 await alpha.t.browserUse(alpha.context); // explicit user request repins the new CID
 assert.equal(alpha.m.isEnabled(), true);
 await alpha.w.stop(); await beta.w.stop();
 console.log('Browser use: shared control claim, explicit CID repin, migration, image upgrade, bounded health, abort and fail-closed OFF passed');
} finally {
 await new Promise(resolve => server.close(resolve));
 if (oldHostSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
 else process.env.COMPUTER_USE_SOCKET = oldHostSocket;
 await rm(tmp, { recursive: true, force: true });
}
