#!/usr/bin/env node
// Pure extension/UI fixtures: no daemon, model, or actual desktop notification.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extensionHarness } from "./extension-harness.mjs";

const root = path.resolve(import.meta.dirname, "..");
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const candidates = [process.env.PI_CODING_AGENT_PACKAGE,
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	...readdirSync(releases).sort().reverse().map(r => path.join(releases, r, "node_modules/@earendil-works/pi-coding-agent/package.json"))];
const sdk = candidates.find(p => p && existsSync(p));
const require = createRequire(sdk);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, { moduleCache: false,
	alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"), typebox: require.resolve("typebox") } });
const { ComputerUseMode, computerUseBar, formatComputerUseDuration } = await jiti.import(path.join(root, ".pi/extensions/computer-use/mode.ts"));
const { registerComputerUseCommand } = await jiti.import(path.join(root, ".pi/extensions/computer-use/command.ts"));
const { registerComputerUseHandoff } = await jiti.import(path.join(root, ".pi/extensions/computer-use/handoff.ts"));
const { computerUseMessage, SAVED_LOGIN_POLICY } = await jiti.import(path.join(root, ".pi/extensions/computer-use/instructions.ts"));
const { visibleWidth } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));

const harness = extensionHarness(new Map([["desktop_observe", {}]]));
const widgets = new Map();
const notices = [];
const ctx = { mode: "tui", hasUI: true, signal: undefined, isIdle: () => true,
	sessionManager: { getBranch: () => harness.entries },
	ui: { setWidget: (key, value, options) => widgets.set(key, { value, options }),
		notify: (message, level) => notices.push({ message, level }) } };
const completed = [];
const mode = new ComputerUseMode(harness.pi, async outcome => { completed.push(outcome); return true; });
registerComputerUseCommand(harness.pi, mode);
const command = harness.commands.get("computer-use");
mode.restore(ctx);
assert.equal(mode.isEnabled(), false);
assert.equal(widgets.get("computer-use-mode").value, undefined);
assert.ok(command.getArgumentCompletions("t").some(c => c.value === "toggle"));
await command.handler("on", ctx);
assert.equal(mode.isEnabled(), true);
assert.equal(harness.messages.length, 0, "toggle must not start a model run");
assert.equal(harness.entries.at(-1).data.enabled, true);
assert.equal(widgets.get("computer-use-mode").options.placement, "aboveEditor");
const component = widgets.get("computer-use-mode").value({}, { fg: (_color, text) => text });
for (const width of [0, 1, 8, 16, 17, 20, 80, 192]) {
	const line = component.render(width)[0];
	assert.equal(visibleWidth(line), width);
	assert.equal(line, computerUseBar(width));
}
assert.match(component.render(80)[0], /^─+ Computer use ON ─+$/);
component.invalidate();
const start = prompt => ({ prompt, systemPromptOptions: { sections: { unrelated: "keep" } } });
const direct = start("Провери календара");
mode.beforeStart(direct, ctx);
assert.equal(direct.prompt, "Провери календара", "direct input remains unchanged");
assert.match(direct.systemPromptOptions.sections.computer_use_mode, /desktop_\* tools only/);
assert.match(direct.systemPromptOptions.sections.computer_use_mode, /does not authorize/);
assert.ok(direct.systemPromptOptions.sections.computer_use_mode.includes(SAVED_LOGIN_POLICY));
assert.match(SAVED_LOGIN_POLICY, /authorizes browser-native saved-password autofill/);
assert.match(SAVED_LOGIN_POLICY, /unless the task explicitly forbids login/);
assert.match(SAVED_LOGIN_POLICY, /verify the intended site's domain and the intended existing account/);
assert.match(SAVED_LOGIN_POLICY, /never reveal, inspect password values, extract, copy, log, or send passwords/);
assert.match(SAVED_LOGIN_POLICY, /MFA\/2FA.*require desktop_request_user/);
assert.ok(computerUseMessage("Провери календара").includes(SAVED_LOGIN_POLICY));
assert.equal(direct.systemPromptOptions.sections.unrelated, "keep");
mode.setOutcome("completed");
assert.equal(completed.length, 0, "no notification before final settlement");
await mode.notifyCompletion(mode.takeCompletion(), ctx);
await mode.notifyCompletion(mode.takeCompletion(), ctx);
assert.deepEqual(completed, ["completed"], "one notification per settlement");

// Persistence after reload, branch restoration, and OFF cleanup.
const reloaded = new ComputerUseMode(harness.pi, async outcome => { completed.push(outcome); return true; });
reloaded.restore(ctx);
assert.equal(reloaded.isEnabled(), true);
await command.handler("toggle", ctx);
assert.equal(mode.isEnabled(), false);
assert.equal(widgets.get("computer-use-mode").value, undefined);
mode.beforeStart(direct, ctx);
assert.equal(direct.systemPromptOptions.sections.computer_use_mode, undefined, "OFF removes our section");
await mode.notifyCompletion(mode.takeCompletion(), ctx);
assert.equal(completed.length, 1, "ordinary OFF reply does not notify");
reloaded.restore(ctx);
assert.equal(reloaded.isEnabled(), false);
reloaded.restore({ ...ctx, sessionManager: { getBranch: () => harness.entries.slice(0, 1) } });
assert.equal(reloaded.isEnabled(), true, "restore uses active branch, not abandoned entries");
reloaded.restore({ ...ctx, mode: "rpc", sessionManager: { getBranch: () => [] } });
assert.equal(reloaded.isEnabled(), false);

// OFF never queues a one-off task, even when busy; enabling is an explicit command.
await command.handler("Провери waiting list", { ...ctx, isIdle: () => false });
assert.equal(mode.isEnabled(), false);
assert.equal(harness.messages.length, 0);
assert.match(notices.at(-1).message, /OFF.*не е изпратена/);
assert.equal((await harness.emit("tool_call", ctx, { toolName: "desktop_observe", input: {} }))[0].block, true);
assert.equal((await harness.emit("tool_call", ctx, { toolName: "desktop_stop", input: {} }))[0], undefined);
await command.handler("on", ctx);
assert.equal((await harness.emit("tool_call", ctx, { toolName: "desktop_observe", input: {} }))[0], undefined);
await command.handler("Провери waiting list", { ...ctx, isIdle: () => false });
assert.equal(mode.isEnabled(), true);
assert.equal(harness.messages.length, 1);
assert.deepEqual(harness.messages[0].options, { deliverAs: "followUp" });
assert.equal(harness.messages[0].content, "Провери waiting list", "command submits the verbatim task, not duplicated rules");
const queuedStart = start(harness.messages[0].content);
mode.beforeStart(queuedStart, ctx);
assert.ok(queuedStart.systemPromptOptions.sections.computer_use_mode.includes(SAVED_LOGIN_POLICY),
	"the ON system section, not the user task, carries the saved-login rules");
mode.setOutcome("error");
await mode.notifyCompletion(mode.takeCompletion(), ctx);
assert.equal(completed.at(-1), "error");
await command.handler("off", ctx);

// Direct toolStarted below is a lifecycle/transport fixture, not a model-issued tool_call:
// the OFF gate above prevents desktop_observe from reaching it in a real Pi turn.
mode.beforeStart(start("Прочети файла"), ctx);
mode.toolStarted("desktop_ping", ctx);
mode.toolStarted("desktop_metrics", ctx);
assert.equal(mode.takeCompletion(), undefined);
mode.beforeStart(start("Провери календара"), ctx);
mode.toolStarted("desktop_observe", ctx);
mode.setOutcome("completed");
await mode.notifyCompletion(mode.takeCompletion(), ctx);
assert.equal(completed.at(-1), "completed");

// Aggregate retries/follow-ups until settled, not agent_end or each model turn.
mode.beforeStart(start(computerUseMessage("Календар")), ctx);
mode.toolStarted("desktop_observe", ctx);
mode.setOutcome("error");
mode.beforeStart(start("queued follow-up"), ctx);
mode.setOutcome("completed");
await mode.notifyCompletion(mode.takeCompletion(), ctx);
assert.equal(completed.at(-1), "completed");

// Abort, emergency Stop, and shutdown/reload are completely silent.
const notificationsBeforeAbort = completed.length;
const abort = new AbortController();
mode.beforeStart(start(computerUseMessage("Календар")), { ...ctx, signal: abort.signal });
abort.abort();
mode.setOutcome("completed");
assert.equal(mode.takeCompletion(), undefined);
await mode.notifyCompletion(mode.takeCompletion(), ctx);
mode.beforeStart(start("stop"), ctx);
mode.toolStarted("desktop_stop", ctx);
assert.equal(mode.takeCompletion(), undefined);
await mode.notifyCompletion(mode.takeCompletion(), ctx);
mode.beforeStart(start(computerUseMessage("Календар")), ctx);
mode.setOutcome("aborted");
assert.equal(mode.takeCompletion(), undefined, "boundary abort without a signal is also silent");
await mode.notifyCompletion("aborted", ctx);
await mode.notifyCompletion("completed", { ...ctx, signal: abort.signal });
assert.equal(completed.length, notificationsBeforeAbort, "abort/Stop must not call the notification helper");
mode.beforeStart(start(computerUseMessage("Календар")), ctx);
mode.shutdown(ctx);
assert.equal(mode.takeCompletion(), undefined, "shutdown must not notify success");
assert.equal(widgets.get("computer-use-mode").value, undefined);

// Suppressed abort does not even warn when notification support is missing.
const warningsBeforeAbort = notices.filter(n => n.level === "warning").length;
// Failed notification reports once without breaking the task.
const unavailable = new ComputerUseMode(harness.pi, async () => false);
await unavailable.notifyCompletion("aborted", ctx);
await unavailable.notifyCompletion("completed", { ...ctx, signal: abort.signal });
assert.equal(notices.filter(n => n.level === "warning").length, warningsBeforeAbort);
await unavailable.notifyCompletion("completed", ctx);
await unavailable.notifyCompletion("completed", ctx);
assert.equal(notices.filter(n => n.level === "warning").length, warningsBeforeAbort + 1);
// Monotonic whole-request timing, isolated per session, with no real clock/timers.
let now = 1000;
const ticks = new Map();
let nextTick = 0;
let unrefs = 0;
const timer = { now: () => now,
	setInterval: (callback, ms) => {
		assert.equal(ms, 1000);
		const handle = { id: ++nextTick, unref: () => { unrefs++; } };
		ticks.set(handle, callback); return handle;
	},
	clearInterval: handle => ticks.delete(handle) };
const timedHarness = extensionHarness(new Map());
const timedWidgets = new Map();
let paints = 0;
const timedCtx = { ...ctx, sessionManager: { getBranch: () => timedHarness.entries },
	ui: { ...ctx.ui, setWidget: (key, value) => { paints++; timedWidgets.set(key, value); } } };
const timingNotifications = [];
const timed = new ComputerUseMode(timedHarness.pi, async outcome => { timingNotifications.push(outcome); return true; }, timer);
const bar = () => timedWidgets.get("computer-use-mode")?.({}, { fg: (_color, text) => text }).render(100)[0];
const savedTiming = () => timedHarness.entries.filter(e => e.customType === "computer-use-timing-v1").at(-1)?.data;
timed.start(timedCtx, "startup");
assert.equal(timed.isEnabled(), false);
assert.equal(ticks.size, 0);
timed.setEnabled(true, timedCtx);
assert.equal(ticks.size, 0, "idle ON is not a running timer");
timed.beforeStart(start("Календар"), timedCtx);
assert.equal(ticks.size, 1);
assert.equal(unrefs, 1);
assert.match(bar(), /Computer use ON · 00:00/);
now = 3500;
for (const callback of ticks.values()) callback();
assert.match(bar(), /Computer use ON · 00:02/);
// Repeated turns and queued follow-ups must not reset the original start time.
timed.beforeStart(start("follow-up"), timedCtx);
timed.toolStarted("desktop_observe", timedCtx);
assert.equal(ticks.size, 1);
now = 24750;
timed.setOutcome("completed");
assert.equal(timed.takeCompletion(), "completed");
assert.equal(ticks.size, 0);
assert.deepEqual(savedTiming(), { durationMs: 23750, outcome: "completed" });
assert.match(bar(), /Computer use ON · time: 00:23/);
assert.equal(timed.takeCompletion(), undefined);
assert.equal(timedHarness.entries.filter(e => e.customType === "computer-use-timing-v1").length, 1);
const settledPaints = paints;
now += 10000;
assert.match(bar(), /time: 00:23/);
assert.equal(paints, settledPaints, "settled timer never refreshes the UI");
for (const width of [0, 1, 16, 35, 80, 150])
	assert.equal(visibleWidth(computerUseBar(width, " · time: 00:23 (abort)")), width);
assert.equal(formatComputerUseDuration(0), "00:00");
assert.equal(formatComputerUseDuration(59999), "00:59");
assert.equal(formatComputerUseDuration(60000), "01:00");
assert.equal(formatComputerUseDuration(3600000), "01:00:00");

// An unrelated session stays OFF; fresh startup resets even a persisted ON.
const otherHarness = extensionHarness(new Map());
const otherCtx = { ...timedCtx, sessionManager: { getBranch: () => otherHarness.entries } };
const other = new ComputerUseMode(otherHarness.pi, async () => true, timer);
other.start(otherCtx, "startup");
assert.equal(other.isEnabled(), false);
assert.equal(otherHarness.entries.length, 0);
assert.equal(timed.isEnabled(), true);
const resumed = new ComputerUseMode(timedHarness.pi, async () => true, timer);
resumed.start(timedCtx, "startup");
assert.equal(resumed.isEnabled(), false);
assert.equal(timedHarness.entries.at(-1).data.enabled, false);
assert.equal(timed.isEnabled(), true, "another runtime does not mutate live instance state");
resumed.start(timedCtx, "reload");
assert.equal(resumed.isEnabled(), false, "startup reset remains OFF on later reload");
resumed.setEnabled(true, timedCtx);
resumed.start(timedCtx, "reload");
assert.equal(resumed.isEnabled(), true, "deliberate ON survives reload in the same session");
assert.match(bar(), /time: 00:23/);
resumed.start(timedCtx, "resume");
assert.equal(resumed.isEnabled(), false, "session replacement defaults OFF");

// Abort freezes elapsed immediately, is silent, and leaves a tagged last duration.
timed.beforeStart(start("Календар"), timedCtx);
const timedAbort = new AbortController();
timed.toolStarted("desktop_observe", { ...timedCtx, signal: timedAbort.signal });
now += 3200;
timedAbort.abort();
assert.equal(ticks.size, 0);
assert.match(bar(), /00:03 \(abort\)/);
now += 5000; // Cleanup time is not counted after a user's abort.
assert.equal(timed.takeCompletion(), undefined);
assert.deepEqual(savedTiming(), { durationMs: 3200, outcome: "aborted" });
await timed.notifyCompletion(undefined, timedCtx);
assert.deepEqual(timingNotifications, []);
assert.match(bar(), /time: 00:03 \(abort\)/);

// Switching OFF stops display refresh, not timing; tools retain initial thinking time.
timed.beforeStart(start("Календар"), timedCtx);
timed.setEnabled(false, timedCtx);
assert.equal(ticks.size, 0);
now += 1200;
assert.equal(timed.takeCompletion(), "completed");
assert.deepEqual(savedTiming(), { durationMs: 1200, outcome: "completed" });
const previousTiming = savedTiming();
timed.beforeStart(start("ordinary OFF question"), timedCtx);
now += 2000;
assert.equal(timed.takeCompletion(), undefined);
assert.equal(savedTiming(), previousTiming, "ordinary OFF answer does not overwrite last time");
timed.beforeStart(start("desktop task while OFF"), timedCtx);
now += 4000;
timed.toolStarted("desktop_observe", timedCtx);
now += 1000;
assert.equal(timed.takeCompletion(), "completed");
assert.equal(savedTiming().durationMs, 5000, "thinking before the first desktop call is included");

// Reload/shutdown discards partial measurements and clears the running interval.
timed.setEnabled(true, timedCtx);
timed.beforeStart(start("unfinished"), timedCtx);
assert.equal(ticks.size, 1);
const savedBeforeShutdown = savedTiming();
timed.shutdown(timedCtx);
assert.equal(ticks.size, 0);
assert.equal(timed.takeCompletion(), undefined);
assert.equal(savedTiming(), savedBeforeShutdown);
assert.equal(timedWidgets.get("computer-use-mode"), undefined);
// Real registered handoff tool: no desktop backend is contacted, no model is spawned.
const handoffTools = new Map();
const handoffHarness = extensionHarness(handoffTools);
const handoffNotices = [];
const handoffCtx = { ...ctx, sessionManager: { getBranch: () => handoffHarness.entries },
	ui: { ...ctx.ui, notify: (text, level) => handoffNotices.push({ text, level }) } };
const handoffSent = [];
const handoffMode = new ComputerUseMode(handoffHarness.pi, async outcome => { handoffSent.push(outcome); return true; }, timer);
registerComputerUseHandoff(handoffHarness.pi, handoffMode);
const handoff = handoffTools.get("desktop_request_user");
assert.equal(handoff.exposure, "model-only");
assert.match(handoff.description, /Never put passwords/);
assert.equal(handoff.promptGuidelines.length, 1, "handoff guidelines must not duplicate the ON saved-login policy");
assert.ok(!handoff.promptGuidelines[0].includes(SAVED_LOGIN_POLICY));
assert.match(handoff.promptGuidelines[0], /never hand off a matching browser-native autofill/);
const { Check } = require("typebox/value");
assert.equal(Check(handoff.parameters, { reason: "login", instructions: "Влез в сайта и напиши готово." }), true);
assert.equal(Check(handoff.parameters, { reason: "login", instructions: "step", password: "secret" }), false);
assert.equal(Check(handoff.parameters, { reason: "made-up", instructions: "step" }), false);
handoffMode.setEnabled(true, handoffCtx);
const handoffStart = start("Провери календара");
handoffMode.beforeStart(handoffStart, handoffCtx);
assert.ok(handoffStart.systemPromptOptions.sections.computer_use_mode.includes(SAVED_LOGIN_POLICY));
const asked = await handoff.execute("handoff-1", { reason: "login", instructions: "Влез в отворения сайт и напиши готово." }, undefined, undefined, handoffCtx);
assert.equal(JSON.parse(asked.content[0].text).status, "action_required");
assert.equal(handoffSent.length, 0, "OS notification is final-only, so abort can suppress it");
assert.match(handoffNotices.at(-1).text, /Action required/);
assert.equal(handoffMode.isWaitingForUser(), true);
const blocked = await handoffHarness.emit("tool_call", handoffCtx, { toolName: "desktop_click" });
assert.ok(blocked.some(result => result?.block), "handoff blocker still applies when mode is ON");
for (const toolName of ["desktop_stop", "desktop_ping", "desktop_metrics", "desktop_request_user", "read"])
	assert.equal((await handoffHarness.emit("tool_call", handoffCtx, { toolName }))[0], undefined);
handoffMode.setOutcome("completed"); // Model can settle normally without task success.
const needsUser = handoffMode.takeCompletion();
assert.equal(needsUser, "action_required", "normal settlement must not mislabel a login blocker as completion");
await handoffMode.notifyCompletion(needsUser, handoffCtx);
await handoffMode.notifyCompletion(handoffMode.takeCompletion(), handoffCtx);
assert.deepEqual(handoffSent, ["action_required"]);
const waitTiming = handoffHarness.entries.filter(e => e.customType === "computer-use-timing-v1").at(-1).data;
assert.equal(waitTiming.outcome, "action_required");
// Next user reply resumes only through a fresh turn, with no background polling.
handoffMode.beforeStart(start("готово"), handoffCtx);
assert.equal(handoffMode.isWaitingForUser(), false);
assert.equal((await handoffHarness.emit("tool_call", handoffCtx, { toolName: "desktop_observe" }))[0], undefined);
handoffMode.toolStarted("desktop_observe", handoffCtx);
handoffMode.setOutcome("completed");
await handoffMode.notifyCompletion(handoffMode.takeCompletion(), handoffCtx);
assert.deepEqual(handoffSent, ["action_required", "completed"]);
// Pre-aborted execution cannot set a handoff; post-handoff abort suppresses popup.
const cancelledHandoff = new AbortController();
cancelledHandoff.abort();
await assert.rejects(handoff.execute("cancelled", { reason: "mfa", instructions: "Завърши MFA." }, cancelledHandoff.signal, undefined, handoffCtx), /cancelled/);
assert.equal(handoffMode.isWaitingForUser(), false);
const laterAbort = new AbortController();
handoffMode.beforeStart(start(computerUseMessage("Календар")), handoffCtx); // Event ctx may have no signal; actual tool signal must still be watched.
await handoff.execute("cancel-later", { reason: "mfa", instructions: "Завърши MFA и напиши готово." }, laterAbort.signal, undefined, handoffCtx);
laterAbort.abort();
handoffMode.setOutcome("completed"); // Even a normal boundary cannot override the actual tool abort.
assert.equal(handoffMode.takeCompletion(), undefined);
assert.equal(handoffSent.length, 2);
handoffMode.shutdown(handoffCtx);
// Routing is part of the ON widget only; it never replaces Pi's standard footer.
const barHarness = extensionHarness(new Map());
const barMode = new ComputerUseMode(barHarness.pi, async () => { throw new Error("No notification expected"); });
const barWidgets = new Map();
const barCtx = { ...ctx, sessionManager: { getBranch: () => barHarness.entries },
	ui: { ...ctx.ui, setWidget: (key, value, options) => barWidgets.set(key, { value, options }),
		setStatus: () => { throw new Error("Routing must not add standard-footer status"); },
		setFooter: () => { throw new Error("Standard footer must remain untouched"); } } };
barMode.setRoutingLabel("gpt-sol → gpt-luna · изпълнява: Luna", barCtx);
assert.equal(barWidgets.get("computer-use-mode").value, undefined, "routing is invisible while OFF");
barMode.setEnabled(true, barCtx);
const barComponent = barWidgets.get("computer-use-mode").value({}, { fg: (_color, text) => text });
assert.match(barComponent.render(120)[0], /Computer use ON · gpt-sol → gpt-luna · изпълнява: Luna/);
for (const width of [0, 1, 8, 20, 40, 80, 120, 192]) assert.ok(visibleWidth(barComponent.render(width)[0]) <= width);
barMode.setRoutingLabel("single · gpt-sol", barCtx);
assert.match(barComponent.render(120)[0], /Computer use ON · single · gpt-sol/);
barMode.setEnabled(false, barCtx);
assert.equal(barWidgets.get("computer-use-mode").value, undefined);
barMode.shutdown(barCtx);

console.log("Computer-use mode passed: session-isolated ON/OFF, default OFF startup, reload/branch persistence, monotonic whole-request/last timer, silent abort/Stop, ticker cleanup and notifications; no desktop or model calls.");
