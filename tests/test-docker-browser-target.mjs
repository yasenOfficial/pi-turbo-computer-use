#!/usr/bin/env node
// Isolated Unix-socket fixture only: never launches a real host desktop or Docker container.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensionHarness } from './extension-harness.mjs';

const releases = path.join(os.homedir(), '.local/share/pi-codex-ultra/releases');
const sdk = [process.env.PI_CODING_AGENT_PACKAGE, ...readdirSync(releases).sort().reverse().map(r => path.join(releases, r, 'node_modules/@earendil-works/pi-coding-agent/package.json'))].find(p => p && existsSync(p));
const { createJiti } = await import(pathToFileURL(createRequire(sdk).resolve('jiti')));
const sdkRequire = createRequire(sdk);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
 typebox: sdkRequire.resolve('typebox'), '@earendil-works/pi-tui': sdkRequire.resolve('@earendil-works/pi-tui'),
} });
const { ComputerUseMode } = jiti('../.pi/extensions/computer-use/mode.ts');
const { DesktopTarget } = jiti('../.pi/extensions/computer-use/target.ts');
const { DesktopWorkflow } = jiti('../.pi/extensions/computer-use/workflow.ts');
const { registerComputerUseTools } = jiti('../.pi/extensions/computer-use/tools.ts');
const { registerComputerUseCommand } = jiti('../.pi/extensions/computer-use/command.ts');
const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-docker-target-'));
const socket = path.join(dir, 'docker.sock');
const previous = process.env.COMPUTER_USE_SOCKET;
process.env.COMPUTER_USE_SOCKET = path.join(dir, 'unavailable-host.sock');
const seen = [];
let daemonStopped = false, stopAcknowledged = true, staleStopInfo = 0;
const server = createServer(client => {
 let buffer = '';
 client.on('data', chunk => {
  buffer += chunk;
  const end = buffer.indexOf('\n'); if (end < 0) return;
  const request = JSON.parse(buffer.slice(0, end)); seen.push(request);
  if (request.cmd === 'stop') daemonStopped = true;
  const stoppedForInfo = request.cmd === 'daemon_info' && staleStopInfo > 0 ? (staleStopInfo--, true) : daemonStopped;
  const response = request.cmd === 'daemon_info' ? { ok: true, daemon_info: {
   protocol_version: 1, build_id: 'a'.repeat(16), instance_id: 'b'.repeat(32), pid: 123,
   capabilities: ['atspi_direct_properties', 'verified_focus', 'launch_app', 'clipboard_paste', 'app_discovery'],
   managed: false, input_stopped: stoppedForInfo, busy: false, active_workflows: 0,
  } } : { ok: true, input_stopped: request.cmd === 'stop' && stopAcknowledged };
  client.end(JSON.stringify(response) + '\n');
 });
});
await new Promise(resolve => server.listen(socket, resolve));
await chmod(socket, 0o600);
try {
 const tools = new Map(), harness = extensionHarness(tools);
 const notes = [], sessionId = 'fixture-session'; let idle = true, aborted = 0;
 const ctx = { mode: 'tui', hasUI: true, signal: undefined, sessionManager: {
  getBranch: () => harness.entries, getSessionId: () => sessionId,
 }, ui: { notify: text => notes.push(text), setWidget() {} }, isIdle: () => idle, abort: () => { aborted++; } };
 const mode = new ComputerUseMode(harness.pi, async () => true);
 let target; const workflow = new DesktopWorkflow(req => target.lease(req, ctx), 600_000);
 const handle = { id: 'fixture', name: 'fixture', containerId: 'fixture-id', socketPath: socket };
 let state = 'absent', starts = 0, stops = 0, resumes = 0, viewerReads = 0, builds = 0, migrations = 0;
 let legacyViewer = false, migrationComplete = false, profileRetained = false;
 const runtime = { async acquireControl() {}, async releaseControl() {},
  async status() { return state === 'running'
  ? { status: state, handle, authentication: legacyViewer ? 'legacy-password' : 'none', ...(legacyViewer ? { requiresRecreate: true } : {}) }
  : { status: state }; },
  async start() { if (state !== 'absent') throw Error('stop first'); state = 'running'; daemonStopped = false;
   if (migrationComplete) legacyViewer = false; starts++; return handle; },
  async restartInput() { assert.equal(state, 'running'); assert.equal(daemonStopped, true);
   resumes++; daemonStopped = false; staleStopInfo = 1; },
  async migrateLegacyProfile() { assert.equal(state, 'running'); assert.equal(legacyViewer, true);
   assert.equal(daemonStopped, true, 'legacy daemon Stop must be acknowledged before any archive transfer');
   migrations++; migrationComplete = true; profileRetained = true; return { message: 'Private profile copied' }; },
  async stop() { if (legacyViewer && !migrationComplete) throw Error('Unmigrated legacy profile');
   state = 'absent'; stops++; },
  async build() { builds++; return { message: 'built', imageId: 'fixture' }; },
  async prepare() { return { built: false, imageId: 'fixture' }; },
  async viewerInfo() { viewerReads++; return { url: 'http://127.0.0.1:6080/vnc.html',
   authentication: legacyViewer ? 'legacy-password' : 'none', ...(legacyViewer ? { requiresRecreate: true } : {}) }; } };
 target = new DesktopTarget(harness.pi, mode, workflow, id => { assert.equal(id, sessionId); return runtime; });
 registerComputerUseTools(harness.pi, workflow, undefined, target);
 registerComputerUseCommand(harness.pi, mode, undefined, undefined, undefined, target);
 mode.start(ctx, 'startup'); target.restore(ctx);
 const cmd = async value => { await harness.commands.get('computer-use').handler(value, ctx); return notes.at(-1); };
 assert.equal(mode.isEnabled(), false); assert.equal(target.target, 'host');
 assert.equal(builds, 0); assert.equal(starts, 0);
 await cmd('docker build'); assert.equal(builds, 1); assert.equal(target.target, 'host');
 const started = await cmd('docker start'); assert.equal(target.target, 'docker'); assert.equal(mode.isEnabled(), false);
 assert.match(started, /Passwordless localhost viewer.*same private browser profile is reused/);
 assert.equal(starts, 1); assert.ok(seen.every(r => r.cmd === 'daemon_info'), 'startup only performs metadata handshake');
 const viewerStatus = await cmd('docker status');
 assert.match(viewerStatus, /Viewer \(localhost only, no password\): http:\/\/127\.0\.0\.1:6080\/vnc\.html/);
 assert.match(viewerStatus, /profile is retained across stop\/start/);
 assert.doesNotMatch(viewerStatus, /Viewer password:/);
 const readsBeforeHeadless = viewerReads;
 const headlessNotices = [];
 await harness.commands.get('computer-use').handler('docker status', { ...ctx, hasUI: false,
  ui: { ...ctx.ui, notify: message => headlessNotices.push(message) } });
 assert.match(headlessNotices.at(-1), /Viewer URL requires user UI/);
 assert.doesNotMatch(headlessNotices.at(-1), /127\.0\.0\.1:6080|password:/);
 assert.equal(viewerReads, readsBeforeHeadless, 'noninteractive status does not request viewer metadata');
 // Even when runtime.status() claims the same running container, final IPC
 // paths must be real private sockets, not host-socket symlinks/regular files.
 const beforeUnsafe = seen.length;
 await new Promise(resolve => server.close(resolve));
 await symlink(process.env.COMPUTER_USE_SOCKET, socket);
 assert.match(await cmd('on'), /socket.*unsafe/);
 assert.equal(mode.isEnabled(), false); assert.equal(seen.length, beforeUnsafe);
 await unlink(socket);
 await new Promise(resolve => server.listen(socket, resolve));
 await chmod(socket, 0o600);
 assert.ok(!JSON.stringify(harness.entries).includes('password'), 'viewer authentication never persisted');
 assert.match(await cmd('docker resume'), /not stopped/);
 assert.equal(resumes, 0, 'resume never restarts live input');
 await cmd('on'); assert.equal(mode.isEnabled(), true);
 await tools.get('desktop_ping').execute('ping', {}, undefined, undefined, ctx);
 await tools.get('desktop_metrics').execute('metrics', {}, undefined, undefined, ctx);
 await tools.get('desktop_click').execute('click', { id: 'test-node' }, undefined, undefined, ctx);
 assert.ok(seen.some(r => r.cmd === 'control_activity' && r.action === 'begin'));
 assert.ok(seen.some(r => r.cmd === 'click'));
 await workflow.close(); await target.releaseControl(ctx);
 mode.start(ctx, 'reload'); target.restore(ctx);
 assert.equal(target.target, 'docker'); assert.equal(mode.isEnabled(), false, 'reload never restores Docker ON');
 assert.equal(starts, 1, 'reload reuses selected identity without restarting container');
 await cmd('on'); assert.equal(mode.isEnabled(), true, 'reload requires explicit validated ON');
 // Tree navigation to an earlier host-ON branch must not silently route the
 // previously authorized Docker task onto the host desktop.
 const hostBranch = [
  { type: 'custom', customType: 'computer-use-mode-v1', data: { enabled: true } },
  { type: 'custom', customType: 'computer-use-target-v1', data: { target: 'host' } },
 ];
 const hostBranchCtx = { ...ctx, sessionManager: { getBranch: () => hostBranch, getSessionId: () => sessionId } };
 await workflow.close(); await target.releaseControl(ctx);
 mode.restore(hostBranchCtx);
 assert.equal(mode.isEnabled(), true, 'older branch had host ON');
 target.restore(hostBranchCtx);
 assert.equal(target.target, 'host'); assert.equal(mode.isEnabled(), false, 'Docker → host branch switch forces OFF');
 mode.restore(ctx); target.restore(ctx);
 assert.equal(target.target, 'docker'); assert.equal(mode.isEnabled(), false);
 await cmd('on');
 const forkHarness = extensionHarness(new Map());
 for (const entry of harness.entries) forkHarness.entries.push({ ...entry });
 const forkCtx = { ...ctx, sessionManager: { getBranch: () => forkHarness.entries, getSessionId: () => 'fork-session' } };
 const forkMode = new ComputerUseMode(forkHarness.pi, async () => true);
 const forkWorkflow = new DesktopWorkflow(async () => ({ ok: true }));
 const forkTarget = new DesktopTarget(forkHarness.pi, forkMode, forkWorkflow, id => {
  assert.equal(id, 'fork-session');
  return { ...runtime, status: async () => ({ status: 'absent' }) };
 });
 forkMode.start(forkCtx, 'startup'); forkTarget.restore(forkCtx);
 assert.equal(forkTarget.target, 'docker', 'fork retains Docker intent, never selects host implicitly');
 assert.equal(forkMode.isEnabled(), false);
 await assert.rejects(forkTarget.enable(forkCtx), /not running/);
 await cmd('off');
 await tools.get('desktop_ping').execute('off-ping', {}, undefined, undefined, ctx);
 await tools.get('desktop_metrics').execute('off-metrics', {}, undefined, undefined, ctx);
 await assert.rejects(tools.get('desktop_observe').execute('off-observe', {}, undefined, undefined, ctx), /OFF/);
 await cmd('on');
 // A pending ON validation must not override an intervening user pause.
 let releaseStatus; const pendingStatus = new Promise(resolve => { releaseStatus = resolve; });
 const normalStatus = runtime.status;
 runtime.status = async () => { await pendingStatus; return normalStatus(); };
 const staleEnable = assert.rejects(target.enable(ctx), /changed during validation|input stopped/);
 const firstStopCount = seen.filter(r => r.cmd === 'stop').length;
 const pausing = cmd('docker pause');
 releaseStatus();
 const pauseResult = await pausing;
 assert.match(pauseResult, /daemon input stopped/);
 assert.equal(seen.filter(r => r.cmd === 'stop').length, firstStopCount + 1, 'pause waits for native Docker Stop acknowledgement');
 assert.equal(daemonStopped, true);
 await staleEnable;
 assert.equal(mode.isEnabled(), false);
 runtime.status = normalStatus;
 assert.match(await cmd('docker status'), /Docker daemon input: stopped/);
 assert.match(await cmd('on'), /stopped/);
 idle = false;
 assert.match(await cmd('docker resume'), /idle/, 'daemon restart requires Pi idle');
 idle = true;
 assert.match(await cmd('docker resume'), /remains OFF/);
 assert.equal(resumes, 1); assert.equal(starts, 1, 'daemon-only restart preserves container and viewer');
 assert.match(await cmd('docker status'), /Docker daemon input: ready/);
 assert.equal(mode.isEnabled(), false);
 assert.equal(daemonStopped, false);
 await cmd('on'); assert.equal(mode.isEnabled(), true);
 idle = false; assert.match(await cmd('host'), /idle/); assert.equal(target.target, 'docker'); idle = true;
 const inFlight = target.pin();
 await cmd('off'); assert.match(await cmd('host'), /idle/); assert.equal(target.target, 'docker');
 inFlight.release(); await cmd('on');
 await tools.get('desktop_stop').execute('stop', {}, undefined, undefined, ctx);
 await cmd('off'); assert.match(await cmd('on'), /stopped/);
 const secondPause = await cmd('docker pause');
 assert.match(secondPause, /daemon input stopped/);
 assert.equal(mode.isEnabled(), false); assert.equal(aborted, 2);
 await workflow.close(); await target.releaseControl(ctx);
 mode.start(ctx, 'reload'); target.restore(ctx);
 assert.equal(target.target, 'docker'); assert.equal(mode.isEnabled(), false);
 assert.match(await cmd('docker resume'), /remains OFF/);
 assert.equal(resumes, 2, 'reload discovers native Stop via daemon_info; only explicit resume restarts input');
 await cmd('on'); assert.equal(mode.isEnabled(), true);
 // An unacknowledged Stop must NEVER be reported as safe manual takeover.
 stopAcknowledged = false;
 const failedStopCount = seen.filter(r => r.cmd === 'stop').length;
 assert.match(await cmd('docker pause'), /Stop was not confirmed/);
 assert.equal(seen.filter(r => r.cmd === 'stop').length, failedStopCount + 1, 'uncertain Stop is not automatically replayed');
 assert.equal(mode.isEnabled(), false); assert.equal(aborted, 3);
 assert.match(await cmd('on'), /stopped/);
 stopAcknowledged = true;
 assert.match(await cmd('docker resume'), /remains OFF/);
 assert.equal(resumes, 3);
 assert.match(await cmd('docker stop'), /profile is retained/); assert.equal(stops, 1); assert.equal(target.target, 'docker');
 assert.match(await cmd('on'), /stopped/); assert.equal(mode.isEnabled(), false);
 await assert.rejects(tools.get('desktop_ping').execute('ping', {}, undefined, undefined, ctx), /not running/);
 assert.equal(seen.filter(r => r.cmd === 'ping').length, 2, 'unavailable Docker never pings host');
 assert.match(await cmd('docker start'), /same private browser profile is reused/); assert.equal(starts, 2);
 await cmd('on'); assert.equal(mode.isEnabled(), true, 'new explicitly started browser resets Docker Stop');
 await cmd('off');
 // A pre-v2 live browser is metadata-only here. Never read a password,
 // dispatch daemon IPC, stop it, or silently replace its ephemeral profile.
 legacyViewer = true;
 const beforeLegacyIpc = seen.length, beforeLegacyStops = stops;
 const legacyStatus = await cmd('docker status');
 assert.match(legacyStatus, /legacy password viewer.*Do not stop or replace before explicit \/computer-use docker migrate/);
 assert.match(legacyStatus, /http:\/\/127\.0\.0\.1:6080\/vnc\.html/);
 assert.doesNotMatch(legacyStatus, /Viewer password:|PRIVATE-FIXTURE/);
 assert.equal(seen.length, beforeLegacyIpc, 'legacy status does not read daemon or password');
 assert.match(await cmd('on'), /Legacy Docker browser needs explicit \/computer-use docker migrate/);
 assert.equal(mode.isEnabled(), false);
 assert.match(await cmd('docker stop'), /Docker browser was NOT stopped/);
 assert.match(await cmd('docker resume'), /Legacy Docker browser needs explicit \/computer-use docker migrate/);
 assert.equal(stops, beforeLegacyStops); assert.equal(resumes, 3);
 assert.equal(seen.length, beforeLegacyIpc, 'legacy browser is not sent desktop requests');
 idle = false;
 assert.match(await cmd('docker migrate'), /idle/, 'busy user session must not begin migration');
 idle = true;
 assert.equal(migrations, 0); assert.equal(stops, beforeLegacyStops);
 const beforeMigrationStop = seen.filter(r => r.cmd === 'stop').length;
 const migrated = await cmd('docker migrate');
 assert.match(migrated, /profile migrated.*private persistent Docker volume.*passwordless localhost viewer started.*remains OFF/);
 assert.equal(seen.filter(r => r.cmd === 'stop').length, beforeMigrationStop + 1);
 assert.equal(migrations, 1); assert.equal(stops, beforeLegacyStops + 1); assert.equal(starts, 3);
 assert.equal(profileRetained, true); assert.equal(mode.isEnabled(), false); assert.equal(target.target, 'docker');
 assert.match(await cmd('docker status'), /Viewer \(localhost only, no password\)/);
 assert.match(await cmd('docker migrate'), /requires the selected running legacy/);
 assert.match(await cmd('docker stop'), /profile is retained/);
 assert.equal(profileRetained, true, 'stop does not erase copied profile');
 await cmd('host'); assert.equal(target.target, 'host'); assert.equal(mode.isEnabled(), false);
 assert.equal(viewerReads, 11, 'viewer metadata requested only on explicit start/resume/migrate readiness and status');
 // A failed import is fail-closed: Stop was acknowledged but the source is
 // preserved, no successor is started, and a repeated migration is not queued.
 const failedHarness = extensionHarness(new Map());
 const failedCtx = { ...ctx, sessionManager: { getBranch: () => [
  { type: 'custom', customType: 'computer-use-target-v1', data: { target: 'docker' } },
 ], getSessionId: () => 'failed-import-fixture' } };
 const failedMode = new ComputerUseMode(failedHarness.pi, async () => true);
 const failedWorkflow = new DesktopWorkflow(async () => ({ ok: true }));
 let failedStarts = 0, failedStops = 0, failedMigrations = 0;
 const failedRuntime = { ...runtime,
  status: async () => ({ status: 'running', handle, authentication: 'legacy-password', requiresRecreate: true }),
  migrateLegacyProfile: async () => { failedMigrations++; throw Error('private archive failure'); },
  stop: async () => { failedStops++; }, start: async () => { failedStarts++; return handle; } };
 const failedTarget = new DesktopTarget(failedHarness.pi, failedMode, failedWorkflow, () => failedRuntime);
 failedMode.start(failedCtx, 'startup'); failedTarget.restore(failedCtx);
 assert.equal(failedTarget.target, 'docker'); assert.equal(failedMode.isEnabled(), false);
 const failedStopBefore = seen.filter(r => r.cmd === 'stop').length;
 stopAcknowledged = false;
 await assert.rejects(failedTarget.command('docker migrate', failedCtx), /Stop was not acknowledged.*Migration did not start/);
 assert.equal(seen.filter(r => r.cmd === 'stop').length, failedStopBefore + 1);
 assert.equal(failedMigrations, 0); assert.equal(failedStops, 0); assert.equal(failedStarts, 0);
 assert.equal(failedMode.isEnabled(), false, 'unacknowledged Stop never authorizes input');
 stopAcknowledged = true;
 // A separate, deliberate user command can attempt migration after confirming Stop.
 await assert.rejects(failedTarget.command('docker migrate', failedCtx), /migration was not completed.*Original browser remains/);
 assert.equal(seen.filter(r => r.cmd === 'stop').length, failedStopBefore + 2);
 assert.equal(failedMigrations, 1); assert.equal(failedStops, 0); assert.equal(failedStarts, 0);
 assert.equal(failedMode.isEnabled(), false); assert.equal(failedTarget.target, 'docker');
 await assert.rejects(failedTarget.enable(failedCtx), /Docker input stopped/);
 await failedWorkflow.stop();
 await workflow.stop(); await forkWorkflow.stop();
 // Stop detaches its lease synchronously, but a subsequent target switch must
 // await the delayed END instead of routing it to a new backend.
 let resolveEnd; const endPending = new Promise(resolve => { resolveEnd = resolve; });
 const closingWorkflow = new DesktopWorkflow(req => req.action === 'end' ? endPending : Promise.resolve({ ok: true }), 600_000);
 await closingWorkflow.beforeExecute('desktop_click');
 const firstClose = closingWorkflow.stop();
 let finished = false;
 const secondClose = closingWorkflow.close().then(() => { finished = true; });
 await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(finished, false);
 resolveEnd({ ok: true }); await Promise.all([firstClose, secondClose]); assert.equal(finished, true);
 console.log('Docker browser target routing: explicit lifecycle, pinned IPC/leases, acknowledged Stop, explicit daemon-only resume, OFF and fail-closed stop passed');
} finally {
 await new Promise(resolve => server.close(resolve));
 process.env.COMPUTER_USE_SOCKET = previous;
 await rm(dir, { recursive: true, force: true });
}
