#!/usr/bin/env node
// Opt-in, local-only GUI demo: opens a temporary Zenity dialog, fills it via
// AT-SPI, clicks OK and measures the *model-facing text* without calling an LLM.
import assert from 'node:assert/strict';
import { extensionHarness } from './extension-harness.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(import.meta.dirname, '..');
const socket = path.join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `pi-demo-${process.pid}.sock`);
const packages = path.join(homedir(), '.local/share/pi-codex-ultra/releases');
const release = [process.env.PI_CODING_AGENT_PACKAGE,
  process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
  ...readdirSync(packages).sort().reverse().map(p => path.join(packages, p, 'node_modules/@earendil-works/pi-coding-agent/package.json'))].find(p => p && existsSync(p));
if (!release) throw new Error('Pi SDK not found');
const sdkRequire = createRequire(release);
const { createJiti } = await import(pathToFileURL(sdkRequire.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { typebox: sdkRequire.resolve('typebox'), '@earendil-works/pi-tui': sdkRequire.resolve('@earendil-works/pi-tui') } });
const previousSocket = process.env.COMPUTER_USE_SOCKET;
process.env.COMPUTER_USE_SOCKET = socket;
const env = { ...process.env, COMPUTER_USE_SOCKET: socket };
const daemon = spawn(process.env.DAEMON_BIN ?? path.join(root, 'daemon/target/release/pi-turbo-daemon'), [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
const title = `Pi Turbo Token Demo ${process.pid}`;
let daemonLog = '';
daemon.stderr.on('data', data => { daemonLog += data.toString(); });
let dialog;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tools = new Map();
const harness = extensionHarness(tools);
const metrics = [];
async function invoke(name, params = {}) {
  const t = performance.now();
  const result = await tools.get(name).execute(`demo-${name}`, params);
  const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const raw = JSON.stringify(result.details.response);
  const images = result.content.filter(part => part.type === 'image');
  const data = { step: name, ms: Math.round((performance.now() - t) * 10) / 10, chars: text.length,
    utf8_bytes: Buffer.byteLength(text), approx_tokens: Math.ceil(text.length / 4),
    raw_bytes: Buffer.byteLength(raw), images: images.length,
    image_png_bytes: images.reduce((sum, image) => sum + Buffer.from(image.data, 'base64').length, 0),
    visual_patches: result.details.response.visual?.patches?.length ?? 0,
    visual_size: result.details.response.visual ? `${result.details.response.visual.width}x${result.details.response.visual.height}` : undefined,
    nodes: result.details.response.snapshot?.nodes?.length ?? result.details.response.delta?.changed?.length ?? 0,
    semantic_scope: result.details.response.snapshot?.semantic_scope,
    frame_roles: result.details.response.snapshot?.nodes?.filter(n => ['frame','window','dialog'].includes(n.role)).map(n => `${n.role}:${n.name?.slice(0,30)}`) };
  metrics.push(data);
  return result.details.response;
}
try {
  const extension = await jiti.import(path.join(root, '.pi/extensions/computer-use/index.ts'), { default: true });
  extension(harness.pi);
  await harness.emit('before_agent_start');
  // Wait for the actual socket; no desktop input until the dialog is observed.
  for (let i = 0; i < 60; i++) { if (existsSync(socket)) break; await pause(50); }
  assert.ok(existsSync(socket), `daemon did not start: ${daemonLog}`);
  const ping = await invoke('desktop_ping');
  assert.equal(ping.input_stopped, false, 'benchmark daemon input is stopped');
  // Cold desktop observation before the demo dialog measures the real
  // inaccessible-browser/Cinnamon fallback rather than hiding that cost.
  await invoke('desktop_observe');
  let dialogOutput = '';
  dialog = spawn('zenity', ['--entry', `--title=${title}`, '--text=Local AT-SPI demo (no network)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  dialog.stdout.on('data', data => { dialogOutput += data.toString(); });
  const wait = await invoke('desktop_wait', { condition: { name: title, role: 'dialog' }, timeout_ms: 12000 });
  assert.equal(wait.matched, true, 'demo dialog was not discovered by AT-SPI');
  await invoke('desktop_focus_window', { title });
  const observed = await invoke('desktop_observe');
  // Compact observations can omit container ancestors. Scope search hints to
  // our unique dialog and then revalidate both IDs against the current tree.
  const history = await invoke('desktop_search_seen', { query: title, limit: 50 });
  const owned = history.seen.results.filter(node => node.window === title && node.source === 'current');
  const entries = owned.filter(node => node.role === 'text');
  const buttons = owned.filter(node => node.role === 'push button' && node.name === 'OK');
  assert.equal(entries.length, 1, 'test-owned text field not uniquely accessible');
  assert.equal(buttons.length, 1, 'test-owned OK button not uniquely accessible');
  const entry = (await invoke('desktop_inspect', { id: entries[0].id })).node;
  const ok = (await invoke('desktop_inspect', { id: buttons[0].id })).node;
  assert.ok(entry && ok, 'historical IDs did not survive live revalidation');
  const baseline = await invoke('desktop_inspect_visual', { id: entry.id, incremental: true });
  const unchanged = await invoke('desktop_inspect_visual', { id: entry.id, incremental: true, since_visual: baseline.visual.revision });
  assert.ok(Array.isArray(unchanged.visual.patches), 'incremental crop omitted patch metadata');
  // A live entry can blink its caret; deterministic unchanged hashes are unit-tested.
  const marker = `pi-demo-${process.pid}`;
  await invoke('desktop_set_text', { id: entry.id, text: marker });
  const changed = await invoke('desktop_changes', { since: observed.snapshot.generation });
  let revision = unchanged.visual.revision;
  let rendered = false;
  for (let attempt = 0; attempt < 8 && !rendered; attempt++) {
    const visualChange = await invoke('desktop_inspect_visual', { id: entry.id, incremental: true, since_visual: revision });
    revision = visualChange.visual.revision;
    rendered = visualChange.visual.patches.length > 0;
    if (!rendered) await pause(25); // Semantic text changes may precede GTK paint.
  }
  assert.ok(rendered, 'updated text produced no visual patch within 200 ms');
  assert.ok(changed.delta || changed.snapshot, 'missing changed state');
  await invoke('desktop_click', { id: ok.id });
  const exitCode = dialog.exitCode ?? await Promise.race([
    new Promise(resolve => dialog.once('exit', resolve)),
    pause(5000).then(() => 'timeout'),
  ]);
  assert.equal(exitCode, 0, `dialog did not close (exit ${exitCode})`);
  assert.equal(dialogOutput.trim(), marker, 'semantic value did not reach the application');
  console.log(JSON.stringify({ success: true, marker_verified: true, model_api_calls: 0,
    note: 'approx_tokens uses characters/4; images would require separate model-specific accounting', metrics }, null, 2));
} finally {
  if (dialog && dialog.exitCode === null) dialog.kill();
  await harness.emit('agent_settled');
  await harness.emit('session_shutdown');
  daemon.kill();
  if (previousSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
  else process.env.COMPUTER_USE_SOCKET = previousSocket;
  await unlink(socket).catch(() => {});
}
