#!/usr/bin/env node
// Load the extension through Pi's real resource loader, without a daemon or model request.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const extensionPath = path.join(root, ".pi/extensions/computer-use/index.ts");
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const candidates = [
	process.env.PI_CODING_AGENT_PACKAGE,
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	...(existsSync(releases) ? readdirSync(releases).sort().reverse().map((release) =>
		path.join(releases, release, "node_modules/@earendil-works/pi-coding-agent/package.json")) : []),
];
const sdkPackage = candidates.find((candidate) => candidate && existsSync(candidate));
if (!sdkPackage) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE to its package.json path");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
	await import(pathToFileURL(path.join(path.dirname(sdkPackage), "dist/index.js")));
const { Check } = createRequire(sdkPackage)("typebox/value");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-real-extension-load-"));
let session;
const previousSocket = process.env.COMPUTER_USE_SOCKET;
const previousDaemon = process.env.COMPUTER_USE_DAEMON;
process.env.COMPUTER_USE_SOCKET = path.join(tempDir, "must-not-exist.sock");
process.env.COMPUTER_USE_DAEMON = path.join(tempDir, "must-not-start");
try {
	// No personal Pi configuration, credentials, project resources, or persisted session.
	const cwd = tempDir;
	const agentDir = path.join(tempDir, "agent");
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	assert.equal(settingsManager.isProjectTrusted(), true);
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		additionalExtensionPaths: [extensionPath],
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const loaded = resourceLoader.getExtensions();
	assert.deepEqual(loaded.errors, [], `extension load failed: ${JSON.stringify(loaded.errors)}`);
	const loadedExtension = loaded.extensions.find((extension) => extension.path === extensionPath);
	assert.ok(loadedExtension, "extension was not loaded from disk");
	const slashCommand = loadedExtension.commands.get("computer-use");
	assert.ok(slashCommand, "real Pi loader did not register /computer-use");
	({ session } = await createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
	}));
	const extensionErrors = [];
	await session.bindExtensions({ mode: "print", onError: error => extensionErrors.push(error) });
	const activeDesktop = () => session.getActiveToolNames().filter((name) => name.startsWith("desktop_"));
	const registeredDesktop = session.getAllTools().filter(({ name }) => name.startsWith("desktop_"));
	assert.equal(registeredDesktop.length, 24, "all desktop tools remain registered behind the hard OFF gate");
	assert.deepEqual(activeDesktop(), ["desktop_stop", "desktop_ping", "desktop_metrics"],
		"real Pi fresh startup declares only Stop and metadata tools");
	const otherTools = session.getActiveToolNames().filter(name => !name.startsWith("desktop_"));
	for (const name of ["desktop_request_user", "desktop_model_phase", "desktop_visual_permission"])
		assert.equal(session.getAllTools().find(t => t.name === name)?.exposure, "model-only", `${name} must not be callable by scripts`);
	const phaseSchema = session.getToolDefinition("desktop_model_phase")?.parameters;
	assert.ok(phaseSchema);
	assert.equal(Check(phaseSchema, { phase: "execute", plan: "Inspect first, then act" }), true);
	assert.equal(Check(phaseSchema, { phase: "escalate", reason: "Blocked", verified_state: "Observed current state" }), true);
	assert.equal(Check(phaseSchema, { phase: "plan", plan: "Invalid" }), false);
	assert.equal(Check(phaseSchema, { phase: "execute", plan: "ok", unexpected: true }), false);
	const permissionSchema = session.getToolDefinition("desktop_visual_permission")?.parameters;
	assert.ok(permissionSchema);
	assert.equal(Check(permissionSchema, { basis: "explicit_user_request", reason: "The user requested a full screen screenshot", checks: [],
		capture: "desktop_screenshot", target: { full_screen: true } }), true);
	assert.equal(Check(permissionSchema, { basis: "semantic_blocker", reason: "Short", checks: [], capture: "desktop_screenshot",
		target: { full_screen: true } }), false);
	for (const name of registeredDesktop.map(({ name }) => name)) {
		const definition = session.getToolDefinition(name);
		assert.ok(definition?.parameters, `${name} has no model-facing parameter schema`);
	}
	const notices = [];
	await slashCommand.handler("", { ui: { notify: (text) => notices.push(text) } });
	assert.match(notices.at(-1), /24 registered desktop_\* tools/);
	await slashCommand.handler("instructions", { ui: { notify: (text) => notices.push(text) } });
	assert.match(notices.at(-1), /removed/);
	assert.deepEqual(slashCommand.getArgumentCompletions("").map(({ value }) => value), ["toggle", "on", "off", "models", "models hybrid", "models single"]);
	const messageCount = session.messages.length;
	const toolCall = (toolName, suffix) => session.extensionRunner.emitToolCall({ type: "tool_call",
		toolCallId: `load-gate-${suffix}`, toolName, input: {} });
	assert.match((await toolCall("desktop_observe", "off-observe"))?.reason ?? "", /OFF/,
		"real Pi tool_call blocks observation at fresh OFF startup");
	assert.match((await toolCall("desktop_click", "off-click"))?.reason ?? "", /OFF/);
	assert.match((await toolCall("desktop_request_user", "off-handoff"))?.reason ?? "", /OFF/);
	assert.match((await toolCall("desktop_model_phase", "off-phase"))?.reason ?? "", /OFF/);
	assert.equal((await toolCall("desktop_ping", "off-ping"))?.block, undefined);
	assert.equal((await toolCall("desktop_metrics", "off-metrics"))?.block, undefined);
	await session.prompt("/computer-use"); // Real Pi dispatch path; help must not prompt a model.
	await session.prompt("/computer-use instructions");
	await session.prompt("/computer-use status");
	await session.prompt("/computer-use models");
	assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "computer-use-routing-preference-v1").length, 0,
		"summary must not change routing preferences");
	await session.prompt("/computer-use on");
	assert.equal(activeDesktop().length, 17, `expected ON baseline, got ${activeDesktop().join(", ")}`);
	for (const name of ["desktop_launch_app", "desktop_observe", "desktop_batch", "desktop_request_user", "desktop_visual_permission"])
		assert.ok(activeDesktop().includes(name), `${name} is required in the ON baseline`);
	for (const name of ["desktop_screenshot", "desktop_inspect_visual", "desktop_model_phase", "desktop_drag", "desktop_type", "desktop_dirty_regions"])
		assert.ok(!activeDesktop().includes(name), `${name} must stay inactive until eligible`);
	assert.deepEqual(session.getActiveToolNames().filter(name => !name.startsWith("desktop_")), otherTools,
		"mode changes preserve unrelated active tools");
	assert.equal((await toolCall("desktop_observe", "on-observe"))?.block, undefined, "ON allows semantic observation");
	assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "computer-use-mode-v1").at(-1).data.enabled, true);
	const onPrompt = await session.extensionRunner.emitBeforeAgentStart("Провери календара", undefined, { cwd, sections: { other: "keep" } });
	assert.match(onPrompt.systemPromptOptions.sections.computer_use_mode, /desktop_\* tools only/);
	assert.match(onPrompt.systemPromptOptions.sections.computer_use_mode, /desktop_visual_permission/);
	assert.match(onPrompt.systemPromptOptions.sections.computer_use_mode, /uncertain input/);
	assert.equal(onPrompt.systemPromptOptions.sections.computer_use_mode.split("For the user's requested desktop task").length, 2,
		"saved-login policy occurs once in the ON system section");
	assert.equal(onPrompt.systemPromptOptions.sections.other, "keep");
	// Real resource-loaded extension callbacks: permission changes declarations only.
	// No image tool is executed and the fixture has no daemon or model credentials.
	const region = { x: 5, y: 6, width: 70, height: 50 };
	const grantParams = { basis: "explicit_user_request", reason: "The user asked for a screenshot of this small region",
		checks: [], capture: "desktop_screenshot", target: region };
	const permission = loadedExtension.tools.get("desktop_visual_permission")?.definition;
	assert.ok(permission, "model-only permission is registered in the real resource loader");
	const grantResult = await permission.execute("real-permit", grantParams, undefined, undefined, { signal: undefined });
	assert.equal(JSON.parse(grantResult.content[0].text).single_use, true);
	assert.equal(activeDesktop().length, 18, "successful grant adds exactly one capture declaration");
	assert.ok(activeDesktop().includes("desktop_screenshot") && !activeDesktop().includes("desktop_inspect_visual"));
	assert.equal((await toolCall("desktop_observe", "semantic-after-grant"))?.block, undefined);
	await session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "semantic-after-grant",
		toolName: "desktop_observe", result: undefined, isError: false });
	assert.ok(activeDesktop().includes("desktop_screenshot"), "semantic observation does not withdraw pending capture");
	const captureGate = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "real-capture-gate",
		toolName: "desktop_screenshot", input: region });
	assert.equal(captureGate?.block, undefined, "the exact permitted crop passes the hard tool_call gate");
	assert.ok(activeDesktop().includes("desktop_screenshot"), "keep declaration until tool_execution_end");
	await session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "real-capture-gate",
		toolName: "desktop_screenshot", result: undefined, isError: false });
	assert.equal(activeDesktop().length, 17, "completion withdraws the one-shot capture declaration");
	assert.ok(!activeDesktop().includes("desktop_screenshot"));
	assert.match((await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "real-reuse",
		toolName: "desktop_screenshot", input: region }))?.reason ?? "", /Visual capture blocked/);
	const abortGrant = new AbortController();
	await permission.execute("real-abort", grantParams, abortGrant.signal, undefined, { signal: undefined });
	assert.equal(activeDesktop().length, 18);
	abortGrant.abort();
	assert.equal(activeDesktop().length, 17, "abort withdraws an unused capture declaration");
	assert.match((await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "real-abort-gate",
		toolName: "desktop_screenshot", input: region }))?.reason ?? "", /Visual capture blocked/);
	assert.equal(existsSync(process.env.COMPUTER_USE_SOCKET), false, "grant and gate never start a daemon");
	await session.reload(); // Same session: persisted boolean restores without model/desktop work.
	const restored = await session.extensionRunner.emitBeforeAgentStart("Провери waiting list", undefined, { cwd });
	assert.match(restored.systemPromptOptions.sections.computer_use_mode, /Computer use mode is ON/);
	assert.equal(activeDesktop().length, 17, "reload restores the ON baseline, not optional captures");
	await session.prompt("/computer-use toggle");
	const offPrompt = await session.extensionRunner.emitBeforeAgentStart("обикновен въпрос", undefined, { cwd });
	assert.equal(offPrompt.systemPromptOptions.sections.computer_use_mode, undefined);
	assert.deepEqual(activeDesktop(), ["desktop_stop", "desktop_ping", "desktop_metrics"], "toggle OFF withdraws observations");
	assert.equal((await toolCall("desktop_stop", "off-stop"))?.block, undefined, "emergency Stop is available while OFF");
	assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "computer-use-mode-v1").at(-1).data.enabled, false);
	await session.reload(); // Discard fixture activity; no settlement and no OS notification.
	await session.prompt("/computer-use on");
	assert.equal(activeDesktop().length, 17);
	// Reproduce starting Pi on an existing branch with a stored ON entry.
	await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
	const freshStartup = await session.extensionRunner.emitBeforeAgentStart("ordinary prompt", undefined, { cwd });
	assert.equal(freshStartup.systemPromptOptions.sections.computer_use_mode, undefined, "fresh Pi startup must default OFF even on a saved ON branch");
	assert.deepEqual(activeDesktop(), ["desktop_stop", "desktop_ping", "desktop_metrics"]);
	assert.match((await toolCall("desktop_observe", "restarted-off"))?.reason ?? "", /OFF/,
		"startup reset also restores the OFF tool gate");
	assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "computer-use-mode-v1").at(-1).data.enabled, false);
	await session.reload();
	const stillOff = await session.extensionRunner.emitBeforeAgentStart("ordinary prompt", undefined, { cwd });
	assert.equal(stillOff.systemPromptOptions.sections.computer_use_mode, undefined, "reload must not resurrect old ON state");
	await session.reload();
	assert.deepEqual(extensionErrors, [], "real event handlers must not fail");
	assert.equal(session.messages.length, messageCount, "help/mode commands must not start an agent turn");
	assert.equal(existsSync(process.env.COMPUTER_USE_SOCKET), false, "load/help/mode must not start a daemon");
	console.log(`Real Pi extension load passed: 24 registered desktop tools, 3 OFF/17 ON active, help, mode toggle, default OFF startup, system-only prompt rules and reload persistence; no daemon, notification or model call.`);
} finally {
	session?.dispose();
	if (previousSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
	else process.env.COMPUTER_USE_SOCKET = previousSocket;
	if (previousDaemon === undefined) delete process.env.COMPUTER_USE_DAEMON;
	else process.env.COMPUTER_USE_DAEMON = previousDaemon;
	await rm(tempDir, { recursive: true, force: true });
}
