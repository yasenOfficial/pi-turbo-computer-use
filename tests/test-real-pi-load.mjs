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
	const desktopNames = session.getActiveToolNames().filter((name) => name.startsWith("desktop_"));
	assert.equal(desktopNames.length, 24, `expected 24 model-active desktop tools, got ${desktopNames.join(", ")}`);
	assert.equal(session.getAllTools().filter(({ name }) => name.startsWith("desktop_")).length, 24);
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
	assert.ok(desktopNames.includes("desktop_launch_app"), "launch is model-active and direct");
	for (const name of desktopNames) {
		const definition = session.getToolDefinition(name);
		assert.ok(definition?.parameters, `${name} has no model-facing parameter schema`);
	}
	const notices = [];
	await slashCommand.handler("", { ui: { notify: (text) => notices.push(text) } });
	assert.match(notices.at(-1), /24 registered desktop_\* tools/);
	await slashCommand.handler("instructions", { ui: { notify: (text) => notices.push(text) } });
	assert.match(notices.at(-1), /Never automatically retry input/);
	assert.match(notices.at(-1), /desktop_launch_app/);
	const messageCount = session.messages.length;
	const toolCall = (toolName, suffix) => session.extensionRunner.emitToolCall({ type: "tool_call",
		toolCallId: `load-gate-${suffix}`, toolName, input: {} });
	assert.match((await toolCall("desktop_observe", "off-observe"))?.reason ?? "", /OFF/,
		"real Pi tool_call blocks observation at fresh OFF startup");
	assert.match((await toolCall("desktop_click", "off-click"))?.reason ?? "", /OFF/);
	assert.match((await toolCall("desktop_request_user", "off-handoff"))?.reason ?? "", /OFF/);
	assert.match((await toolCall("desktop_model_phase", "off-phase"))?.reason ?? "", /OFF/);
	assert.equal((await toolCall("desktop_stop", "off-stop"))?.block, undefined, "emergency Stop is available while OFF");
	assert.equal((await toolCall("desktop_ping", "off-ping"))?.block, undefined);
	assert.equal((await toolCall("desktop_metrics", "off-metrics"))?.block, undefined);
	await session.prompt("/computer-use"); // Real Pi dispatch path; help must not prompt a model.
	await session.prompt("/computer-use instructions");
	await session.prompt("/computer-use status");
	await session.prompt("/computer-use models status");
	assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "computer-use-routing-preference-v1").length, 0,
		"status must not change routing preferences");
	await session.prompt("/computer-use on");
	assert.equal((await toolCall("desktop_observe", "on-observe"))?.block, undefined, "ON allows semantic observation");
	assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "computer-use-mode-v1").at(-1).data.enabled, true);
	const onPrompt = await session.extensionRunner.emitBeforeAgentStart("Провери календара", undefined, { cwd, sections: { other: "keep" } });
	assert.match(onPrompt.systemPromptOptions.sections.computer_use_mode, /desktop_\* tools only/);
	assert.equal(onPrompt.systemPromptOptions.sections.other, "keep");
	await session.reload(); // Same session: persisted boolean restores without model/desktop work.
	const restored = await session.extensionRunner.emitBeforeAgentStart("Провери waiting list", undefined, { cwd });
	assert.match(restored.systemPromptOptions.sections.computer_use_mode, /Computer use mode is ON/);
	await session.prompt("/computer-use toggle");
	const offPrompt = await session.extensionRunner.emitBeforeAgentStart("обикновен въпрос", undefined, { cwd });
	assert.equal(offPrompt.systemPromptOptions.sections.computer_use_mode, undefined);
	assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "computer-use-mode-v1").at(-1).data.enabled, false);
	await session.reload(); // Discard fixture activity; no settlement and no OS notification.
	await session.prompt("/computer-use on");
	// Reproduce starting Pi on an existing branch with a stored ON entry.
	await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
	const freshStartup = await session.extensionRunner.emitBeforeAgentStart("ordinary prompt", undefined, { cwd });
	assert.equal(freshStartup.systemPromptOptions.sections.computer_use_mode, undefined, "fresh Pi startup must default OFF even on a saved ON branch");
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
	console.log(`Real Pi extension load passed: /computer-use help, models status, toggle, default OFF startup, prompt injection and reload persistence, ${desktopNames.length} model-active desktop tools; no daemon, notification or model call.`);
} finally {
	session?.dispose();
	if (previousSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
	else process.env.COMPUTER_USE_SOCKET = previousSocket;
	if (previousDaemon === undefined) delete process.env.COMPUTER_USE_DAEMON;
	else process.env.COMPUTER_USE_DAEMON = previousDaemon;
	await rm(tempDir, { recursive: true, force: true });
}
