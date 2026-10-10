#!/usr/bin/env node
// Isolated Unix socket protocol fixture: never touches a real desktop or clipboard.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const releases = path.join(os.homedir(), '.local/share/pi-codex-ultra/releases');
const sdk = [process.env.PI_CODING_AGENT_PACKAGE,
  process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
  ...(existsSync(releases) ? readdirSync(releases).sort().reverse().map(r => path.join(releases, r, 'node_modules/@earendil-works/pi-coding-agent/package.json')) : [])].find(p => p && existsSync(p));
if (!sdk) throw new Error('Pi SDK not found');
const sdkRequire = createRequire(sdk);
const { createJiti } = await import(pathToFileURL(sdkRequire.resolve('jiti')));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { typebox: sdkRequire.resolve('typebox') } });
const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-paste-fixture-'));
const socket = path.join(dir, 'fixture.sock');
const oldSocket = process.env.COMPUTER_USE_SOCKET;
process.env.COMPUTER_USE_SOCKET = socket;
const received = [];
let reply = { ok: true, paste: { status: 'dispatched', method: 'clipboard', shortcut: 'ctrl_v', paste_sent: true,
  clipboard_restore_status: 'restored', clipboard_restored: true, keyboard_events: 4, verified: false, focus_verification: 'semantic' } };
const server = createServer(connection => {
  let buffer = '';
  connection.setEncoding('utf8');
  connection.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    received.push(JSON.parse(buffer.slice(0, newline)));
    connection.end(JSON.stringify(reply) + '\n');
  });
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const { registerComputerUseTools } = await jiti.import(path.join(root, '.pi/extensions/computer-use/tools.ts'));
  const tools = new Map();
  const requirements = [];
  let allowed = true;
  const startup = { assertInputAllowed() { if (!allowed) throw new Error('stopped'); },
    async ensureCompatible(_signal, capability) { requirements.push(capability); if (capability && capability !== 'clipboard_paste') throw new Error('wrong capability'); } };
  registerComputerUseTools({ registerTool(tool) { tools.set(tool.name, tool); } }, undefined, startup);
  assert.equal(tools.size, 22);
  const tool = tools.get('desktop_paste_text');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.deepEqual(tool.parameters.required, ['text']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.target.minProperties, 1);
  assert.equal(tool.parameters.properties.target.additionalProperties, false);
  const target = { name: 'fixture field', role: 'entry' };
  const input = { text: 'Здравей 👋', target, window_title: 'Test-owned browser' };
  const result = await tool.execute('semantic', input);
  assert.deepEqual(received, [{ cmd: 'paste_text', ...input }]);
  assert.deepEqual(requirements, ['clipboard_paste']);
  assert.equal(result.isError, false);
  assert.equal(result.details.response.paste.verified, false);
  assert.equal(result.details.response.paste.status, 'dispatched');
  assert.equal(result.details.response.paste.shortcut, 'ctrl_v');
  assert.equal(result.content.length, 1, 'no image, no clipboard contents');
  reply = { ok: false, error: 'PRIVATE_OLD_CLIPBOARD_SENTINEL', clipboard: 'PRIVATE_SECRET',
    paste: { status: 'uncertain', method: 'clipboard', shortcut: 'shift_insert', paste_sent: true, clipboard_restore_status: 'skipped_new_owner',
      clipboard_restored: false, keyboard_events: null, verified: false, focus_verification: 'declared_active_window',
      text: 'PRIVATE_PASTED_TEXT_SENTINEL' } };
  const uncertain = await tool.execute('declared', { text: 'new text', window_title: 'Test-owned browser', focus_verified: true });
  assert.equal(uncertain.isError, true);
  assert.equal(uncertain.details.response.paste.paste_sent, true);
  assert.equal(uncertain.details.response.paste.shortcut, 'shift_insert');
  assert.equal(uncertain.details.response.paste.keyboard_events, null);
  assert.equal(uncertain.details.response.paste.focus_verification, 'declared_active_window');
  assert.equal(received.length, 2, 'uncertain result is not replayed');
  assert.doesNotMatch(JSON.stringify(uncertain), /PRIVATE_|Test-owned browser|new text/);
  reply = { ok: false, paste: { status: 'not_pasted', method: 'clipboard', shortcut: 'ctrl_v', paste_sent: false,
    clipboard_restore_status: 'unchanged', clipboard_restored: false, keyboard_events: 0,
    verified: false, focus_verification: 'semantic' } };
  const notPasted = await tool.execute('no-shortcut', input);
  assert.equal(notPasted.isError, true);
  assert.deepEqual(notPasted.details.response.paste, reply.paste);
  assert.equal(received.length, 3);
  reply = { ok: true, paste: { ...reply.paste, shortcut: 'PRIVATE_UNSUPPORTED_SHORTCUT_SENTINEL' } };
  const unknown = await tool.execute('unknown-shortcut', input);
  assert.equal(Object.hasOwn(unknown.details.response.paste, 'shortcut'), false, 'unrecognized shortcut is never echoed');
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE_/);
  assert.equal(received.length, 4);
  reply = null; // Malformed daemon response after a sent request must not cause replay.
  await assert.rejects(() => tool.execute('uncertain-transport', input), /outcome may be uncertain; do not retry automatically/);
  assert.equal(received.length, 5);
  for (const bad of [
    { text: 'é'.repeat(32769), target }, { text: 'a', target: { name: 'é'.repeat(121) } },
    { text: 'a', target: {} }, { text: 'a', target: { id: 'ok', extra: 'unsafe' } },
    { text: 'a' }, { text: 'a', window_title: 'é'.repeat(121) },
    { text: 'a', window_title: '' }, { text: 'a', target, focus_verified: 'true' },
    { text: 'a', target, extra: 'unsafe' },
  ]) await assert.rejects(() => tool.execute('invalid', bad), /Invalid paste|requires an exact active window_title/);
  assert.equal(received.length, 5, 'invalid byte lengths and shapes never started IPC');
  allowed = false;
  await assert.rejects(() => tool.execute('stopped', input), /stopped/);
  assert.equal(received.length, 5);
  allowed = true;
  startup.ensureCompatible = async (_signal, cap) => { requirements.push(cap); throw new Error('missing clipboard_paste'); };
  await assert.rejects(() => tool.execute('old-daemon', input), /missing clipboard_paste/);
  assert.equal(received.length, 5, 'missing capability blocks dispatch');
  // Debug opt-in records only scalar counters/enums, never text, title, selector or clipboard contents.
  const { ComputerUseDebug } = await jiti.import(path.join(root, '.pi/extensions/computer-use/debug.ts'));
  const handlers = new Map(), entries = [];
  const pi = { on(name, fn) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    getActiveTools() { return ['desktop_paste_text']; },
    getAllTools() { return [{ name: 'desktop_paste_text' }]; } };
  const reportDir = path.join(dir, 'reports');
  const ctx = { signal: undefined, hasUI: false, isIdle: () => true, model: { provider: 'fixture', id: 'fixture', api: 'fixture' },
    getSystemPrompt: () => '', sessionManager: { getBranch: () => entries, getSessionId: () => 'paste-fixture' } };
  const emit = async (name, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  const debug = new ComputerUseDebug(pi, { isEnabled: () => true }, { isHybrid: () => false },
    { now: () => 100, directory: reportDir });
  debug.start(ctx, 'startup');
  await debug.command('on paste-fixture', ctx);
  await emit('before_agent_start');
  await emit('tool_execution_start', { toolCallId: '1', toolName: 'desktop_paste_text', args: {
    text: 'PRIVATE_TEXT_SENTINEL', window_title: 'PRIVATE_WINDOW_SENTINEL', target: { id: 'PRIVATE_TARGET_SENTINEL' }, focus_verified: true } });
  await emit('tool_execution_end', { toolCallId: '1', toolName: 'desktop_paste_text', result: uncertain, isError: true });
  await emit('tool_execution_start', { toolCallId: '2', toolName: 'desktop_paste_text', args: { text: 'PRIVATE_OTHER_TEXT' } });
  await emit('tool_execution_end', { toolCallId: '2', toolName: 'desktop_paste_text', result: unknown, isError: false });
  await emit('agent_settled');
  const { readdir, readFile } = await import('node:fs/promises');
  const report = JSON.parse(await readFile(path.join(reportDir, (await readdir(reportDir))[0]), 'utf8'));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|Test-owned browser|new text/);
  assert.equal(report.tools[0].inputTextBytes, Buffer.byteLength('PRIVATE_TEXT_SENTINEL'));
  assert.equal(report.tools[0].focusDeclared, true);
  assert.equal(report.tools[0].pasteSent, true);
  assert.equal(report.tools[0].pasteStatus, 'uncertain');
  assert.equal(report.tools[0].pasteShortcut, 'shift_insert');
  assert.equal(report.tools[0].clipboardRestoreStatus, 'skipped_new_owner');
  assert.equal(report.tools[0].pasteKeyboardEvents, null);
  assert.equal(Object.hasOwn(report.tools[1], 'pasteShortcut'), false);
  console.log('Paste schema, UTF-8 preflight, capability gate, IPC response redaction, debug safety, no replay and Stop passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  if (oldSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
  else process.env.COMPUTER_USE_SOCKET = oldSocket;
  await rm(dir, { recursive: true, force: true });
}
