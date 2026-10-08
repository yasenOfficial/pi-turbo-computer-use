#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function findPiPackage() {
	const explicit = process.env.PI_CODING_AGENT_PACKAGE;
	const currentRelease = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	const candidates = [explicit, currentRelease && path.join(currentRelease, "node_modules/@earendil-works/pi-coding-agent/package.json")].filter(Boolean);
	const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
	if (existsSync(releases)) {
		for (const release of readdirSync(releases).sort().reverse()) {
			candidates.push(path.join(releases, release, "node_modules/@earendil-works/pi-coding-agent/package.json"));
		}
	}
	const packageJson = candidates.find(existsSync);
	if (!packageJson) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE to its package.json path");
	return packageJson;
}

const sdkPackage = findPiPackage();
const sdkRequire = createRequire(sdkPackage);
const jitiPath = sdkRequire.resolve("jiti");
const { createJiti } = await import(pathToFileURL(jitiPath));
const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-computer-extension-"));
const socketPath = path.join(tempDir, "daemon.sock");
const previousSocket = process.env.COMPUTER_USE_SOCKET;
const previousBinary = process.env.COMPUTER_USE_DAEMON;
const previousState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = path.join(tempDir, "private-state");
process.env.COMPUTER_USE_SOCKET = socketPath;
// A live listener must be reused even when no startup binary is available.
process.env.COMPUTER_USE_DAEMON = path.join(tempDir, "intentionally-absent-binary");

function mixedDesktopResponse({ delta = false, title = "GTK Editor", duplicate = false, links = true } = {}) {
	const desktop = [
		{ id: "desktop-app", name: "Shell", role: "application" },
		{ id: "desktop-frame", name: "Desktop", role: "frame", parent: "desktop-app" },
		...Array.from({ length: 600 }, (_, i) => ({ id: `desktop-${i}`, role: "push button",
			parent: "desktop-frame", name: `UNRELATED_DESKTOP_${i}_${"X".repeat(130)}` })),
	];
	const gtk = [
		{ id: "gtk-app", name: "GTK App", role: "application" },
		{ id: "gtk-frame", name: "GTK Editor", role: "frame", parent: "gtk-app" },
		{ id: "gtk-page", name: "Main area", role: "panel", parent: links ? "gtk-frame" : undefined,
			children: links ? ["gtk-save", "gtk-child-only"] : [] },
		{ id: "gtk-save", name: "Save GTK Document", role: "push button", parent: links ? "gtk-page" : undefined, focused: true },
		{ id: "gtk-child-only", name: "Export GTK Document", role: "push button" },
	];
	if (duplicate) gtk.push({ id: "gtk-duplicate", name: "GTK Editor", role: "frame", parent: "gtk-app" });
	const nodes = [...desktop, ...gtk];
	const windows = Array.from({ length: 24 }, (_, i) => ({ id: `window-${i}`,
		title: i === 17 ? title : `Background ${i}`, active: i === 17 }));
	return { ok: true, windows, ...(delta ? { delta: { from: 41, generation: 42, changed: nodes,
		removed: ["removed-desktop", "removed-gtk"] } } : { snapshot: { root: "desktop-app", generation: 42, nodes } }) };
}
function xedShellResponse({ delta = false, shell = "search", partial = false, crowded = false, stageUnknown = false } = {}) {
	const response = mixedDesktopResponse({ delta, title: "Xed" });
	const data = delta ? response.delta : response.snapshot;
	const key = delta ? "changed" : "nodes";
	const nodes = data[key];
	nodes.find(({ id }) => id === "gtk-frame").name = "Xed";
	if (crowded) nodes.push(...Array.from({ length: 180 }, (_, index) => ({
		id: `xed-${index}`, parent: "gtk-page", role: "push button", name: `Xed action ${index}`,
	})));
	// A different app's showing menu is never a Cinnamon shell popup.
	nodes.push(
		{ id: "background-app", role: "application", name: "Unrelated" },
		{ id: "background-window", role: "window", name: "", visible: true, parent: "background-app" },
		{ id: "background-menu", role: "menu", name: "UNRELATED_MENU", visible: true, parent: "background-window" },
		{ id: "cinnamon-app", role: "application", name: "Cinnamon" },
		{ id: "shell-stage", role: "window", name: "", visible: stageUnknown ? null : true, parent: partial ? "missing-app" : "cinnamon-app" },
		{ id: "shell-panel", role: "panel", name: "Menu panel", parent: "shell-stage", visible: true },
		{ id: "shell-search", role: "entry", name: "Search applications", parent: "shell-panel",
			focused: shell === "search", visible: shell !== "hidden" },
		{ id: "shell-menu", role: "menu", name: "Applications", parent: "shell-panel", visible: shell === "menu" },
		{ id: "shell-item", role: "menu item", name: "Text Editor", parent: "shell-menu", visible: shell === "menu" },
		{ id: "shell-idle-menu", role: "menu", name: "HIDDEN_MENU", parent: "shell-panel", visible: false },
	);
	return response;
}
const rawFixtureChars = JSON.stringify(mixedDesktopResponse()).length;
assert.ok(rawFixtureChars > 90_000, "fixture should reproduce large IPC observations");

const received = [];
const activity = [];
let legacyMode = false;
const daemon = createServer((socket) => {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const request = JSON.parse(buffer.slice(0, newline));
		if (request.cmd === "daemon_info") {
			socket.end(JSON.stringify({ ok: true, daemon_info: { protocol_version: 1, build_id: "1234567890abcdef",
				pid: process.pid, instance_id: "1".repeat(32), managed: false, input_stopped: false, busy: false,
				active_workflows: 0, capabilities: ["atspi_direct_properties", "verified_focus", "launch_app"] } }) + "\n");
			return;
		}
		if (request.cmd === "control_activity") activity.push(request);
		else received.push(request);
		if (request.cmd === "launch_app" && request.app_id?.startsWith("malformed-")) {
			const reply = { "malformed-empty.desktop": "\n", "malformed-json.desktop": "not-json\n",
				"malformed-array.desktop": "[]\n" }[request.app_id];
			socket.end(reply); return;
		}
		const response = request.cmd === "control_activity" && legacyMode ? { ok: false, error: "unknown command" }
			: request.cmd === "launch_app" ? request.name === "Editor" ? { ok: false,
				error: "ambiguous desktop application; use app_id", app_matches: [
					{ app_id: "org.example.Editor.desktop", name: "Editor" },
					{ app_id: "org.other.Editor.desktop", name: "Editor" }] }
				: request.app_id === "missing.desktop" ? { ok: false, error: "installed visible desktop application not found" }
				: request.app_id === "invalid selector" ? { ok: false, error: "app_id must be a desktop ID basename" }
				: { ok: true, launch: { app_id: request.app_id ?? "org.example.Editor.desktop",
					name: "Editor", accepted: true } }
			: request.cmd === "observe" && [50, 51, 52, 53, 56, 57].includes(request.since)
				? xedShellResponse({ shell: { 50: "search", 51: "menu", 52: "idle", 53: "hidden", 56: "menu", 57: "search" }[request.since],
					crowded: request.since === 56, stageUnknown: request.since === 57 })
			: request.cmd === "changes" && [54, 55].includes(request.since)
				? xedShellResponse({ delta: true, shell: "search", partial: request.since === 55 })
			: request.cmd === "observe" && [42, 43, 44, 45, 46].includes(request.since)
			? request.since === 46 ? (() => {
				const observed = mixedDesktopResponse();
				observed.snapshot.nodes = observed.snapshot.nodes.filter(({ id }) => id.startsWith("desktop-"));
				return observed;
			})() : mixedDesktopResponse({ title: request.since === 43 ? "GTK Editor - Modified" : "GTK Editor",
				duplicate: request.since === 44, links: request.since !== 45 })
			: request.cmd === "changes" && [40, 41].includes(request.since) ? (() => {
				const observed = mixedDesktopResponse({ delta: true });
				if (request.since === 40) observed.delta.removed = Array.from({ length: 2_000 }, (_, i) => `removed-${i}`);
				return observed;
			})()
			: request.cmd === "search_seen" && request.query === "UNRELATED_DESKTOP_599"
				? { ok: true, seen: { generation: 42, results: [{ id: "desktop-599", name: "UNRELATED_DESKTOP_599",
					role: "push button", generation: 42, last_seen_ms: 100, source: "current" }] } }
			: request.cmd === "inspect" ? { ok: true, node: { id: request.id, name: "UNRELATED_DESKTOP_599", role: "push button" } }
			: request.cmd === "search_seen" ? { ok: true, seen: { generation: 12,
			results: Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, name: request.query === "large" ? "S".repeat(i === 0 ? 600 : 240) : `Save ${i}`,
				role: request.query === "large" ? "R".repeat(i === 0 ? 600 : 240) : "button",
				window: request.query === "large" ? "W".repeat(i === 0 ? 600 : 240) : "Editor",
				bounds: { x: i, y: 2, width: 30, height: 20 }, generation: 12, last_seen_ms: 1234,
				source: i === 0 ? "current" : "stale", value: "PRIVATE_NOT_INDEXED" })) } }
			: request.cmd === "batch" ? { ok: false, error: "step failed", batch: { completed: false, elapsedMs: 11,
				steps: [{ index: 0, type: "keypress", ok: true, elapsedMs: 5 },
					{ index: 1, type: "click", ok: false, error: "not found", elapsedMs: 6 }] },
				changes: { from: 1, generation: 2,
					changed: request.actions.length > 1 ? Array.from({ length: 300 }, (_, i) =>
						({ id: `changed${i}`, role: "button", name: "C".repeat(200), value: "V".repeat(1000) })) : [],
					removed: request.actions.length > 1 ? Array.from({ length: 90 }, (_, i) => `removed${i}`) : [] } }
			: request.cmd === "metrics" ? { ok: true, metrics: { requests: 7, stages: { capture: { count: 2, total_ms: 13 } } } }
			: request.cmd === "dirty_regions" ? { ok: true, screen_diff: { revision: 3, capture_mode: "full_root",
				dirty_tiles: 1500, summarized: true, regions: Array.from({ length: 500 }, (_, i) =>
					({ x: i, y: 1, width: 5, height: 5, extra: "X".repeat(80) })) } }
			: request.cmd === "observe" || request.cmd === "changes" ? { ok: true,
				windows: Array.from({ length: 80 }, (_, i) => ({ id: `w${i}`, title: i === 44 ? "Focused Editor" : "W".repeat(250), active: i === 44 })),
				...(request.cmd === "observe" ? { snapshot: { generation: 7, root: "n0",
					nodes: Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`,
						role: "push button", name: i === 399 ? "Top focused action" : "N".repeat(240),
						focused: i === 399, value: "V".repeat(1000) })) } }
					: { delta: { from: 6, generation: 7,
						changed: Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, role: "push button",
							name: i === 399 ? "Top focused action" : "N".repeat(240), focused: i === 399, value: "V".repeat(1000) })),
						removed: Array.from({ length: 80 }, (_, i) => `removed${i}`) } }),
				png_base64: "PRIVATE_SCREEN_IMAGE" }
			: { ok: true, pong: true };
		if (request.key === "slow" || (request.cmd === "launch_app" && request.app_id === "slow.desktop")) {
			setTimeout(() => socket.end(`${JSON.stringify(response)}\n`), 200); return;
		}
		socket.end(`${JSON.stringify(response)}\n`);
	});
});

try {
	await new Promise((resolve, reject) => daemon.listen(socketPath, resolve).once("error", reject));
	// Standalone jiti has no Pi host-package mapping; map the real host packages.
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: { typebox: sdkRequire.resolve("typebox"), "@earendil-works/pi-tui": sdkRequire.resolve("@earendil-works/pi-tui") },
	});
	const extensionPath = path.resolve(".pi/extensions/computer-use/index.ts");
	const extension = await jiti.import(extensionPath, { default: true });
	// Faithful host fixture: Pi retains every handler per event, in registration order.
	// Direct tool.execute calls below intentionally test IPC wire formats only; tool_call
	// permission/phase gates are exercised independently in the routing/visual tests.
	const entries = [];
	const notifications = [];
	const physicalModel = { provider: "fixture", id: "fixture-sol", api: "fixture" };
	const fixtureContext = { mode: "print", hasUI: false, signal: undefined, model: physicalModel,
		modelRegistry: { getAvailable: () => [physicalModel], find: (provider, id) =>
			provider === physicalModel.provider && id === physicalModel.id ? physicalModel : undefined },
		sessionManager: { getBranch: () => entries }, isIdle: () => true,
		ui: { notify: (message, level) => notifications.push({ message, level }), setStatus: () => {} } };
	function listenerRegistry() {
		const handlers = new Map();
		const listeners = new Map();
		return { handlers, count: (name) => listeners.get(name)?.length ?? 0, on(name, handler) {
			if (!listeners.has(name)) {
				listeners.set(name, []);
				handlers.set(name, async (event = {}, context = fixtureContext) => {
					const results = [];
					for (const listener of listeners.get(name)) results.push(await listener(event, context));
					return results;
				});
			}
			listeners.get(name).push(handler);
			return () => {
				const list = listeners.get(name);
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		} };
	}
	const tools = new Map();
	let activeTools = [];
	const { handlers, on, count } = listenerRegistry();
	const commands = new Map();
	const sent = [];
	extension({ registerTool: (tool) => { tools.set(tool.name, tool); activeTools.push(tool.name); }, registerVirtualModel: () => {},
		registerCommand: (name, options) => commands.set(name, options),
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		setModel: async () => true,
		sendUserMessage: (content, options) => sent.push({ content, options }), on });
	assert.equal(activity.length, 0, "extension factory must not open sockets");
	for (const name of ["tool_call", "session_start", "session_tree", "before_agent_start", "tool_execution_start", "agent_before_settle", "agent_settled", "session_shutdown", "model_select", "message_end"])
		assert.ok(handlers.has(name), `missing lifecycle listener: ${name}`);
	assert.ok(count("tool_call") >= 3 && count("before_agent_start") >= 2 && count("agent_settled") >= 3,
		"routing, visual policy, and mode/workflow handlers must coexist per event");
	assert.equal(tools.get("desktop_observe").promptGuidelines.length, 1);
	assert.match(tools.get("desktop_observe").promptGuidelines[0], /Minimize images and model round trips/);
	assert.match(tools.get("desktop_observe").promptGuidelines[0], /Do not recapture information already available semantically/);
	assert.equal(tools.size, 24, `expected all 24 registered tools, got ${tools.size}`);
	await handlers.get("session_start")({ reason: "startup" }, fixtureContext);
	assert.deepEqual(activeTools.filter(name => name.startsWith("desktop_")),
		["desktop_stop", "desktop_ping", "desktop_metrics"], "fresh startup exposes only emergency/metadata desktop tools");
	assert.equal(tools.get("desktop_model_phase").exposure, "model-only");
	assert.equal(tools.get("desktop_visual_permission").exposure, "model-only");
	assert.equal(tools.get("desktop_request_user").exposure, "model-only");
	assert.ok(tools.has("desktop_ping"), "desktop_ping was not registered");
	const command = commands.get("computer-use");
	assert.ok(command, "slash command was not registered");
	const ctx = (idle) => ({ ...fixtureContext, isIdle: () => idle });
	await command.handler("", ctx(true));
	assert.match(notifications.at(-1).message, /24 registered desktop_\* tools \(3 active\)/);
	assert.match(notifications.at(-1).message, /connectivity and input state not checked/);
	assert.deepEqual(command.getArgumentCompletions("").map(({ value }) => value), ["toggle", "on", "off", "models", "models hybrid", "models single", "debug on", "debug off", "debug report", "debug result pass", "debug result fail"]);
	assert.deepEqual(command.getArgumentCompletions("debug ").map(({ value }) => value), ["debug on", "debug off", "debug report", "debug result pass", "debug result fail"]);
	const debugDirectory = path.join(process.env.XDG_STATE_HOME, "pi-computer", "debug");
	const debugPrefs = () => entries.filter(entry => entry.customType === "computer-use-debug-v1");
	await command.handler("debug", ctx(true));
	assert.match(notifications.at(-1).message, /No debug report/);
	await command.handler("debug report", ctx(false));
	assert.match(notifications.at(-1).message, /No debug report/);
	await command.handler("debug on bench-test", ctx(true));
	assert.match(notifications.at(-1).message, /Debug ON.*Computer use ON separately/);
	assert.deepEqual({ enabled: debugPrefs().at(-1).data.enabled, label: debugPrefs().at(-1).data.label }, { enabled: true, label: "bench-test" });
	assert.equal(activeTools.filter(name => name.startsWith("desktop_")).length, 3, "debug opt-in never enables computer use");
	const savedDebugCount = debugPrefs().length;
	await command.handler("debug on unsafe/label", ctx(true));
	assert.match(notifications.at(-1).message, /neutral ASCII label/);
	assert.equal(debugPrefs().length, savedDebugCount, "invalid label cannot change opt-in");
	await command.handler("debug result pass", ctx(true));
	assert.match(notifications.at(-1).message, /No report for this session/);
	assert.equal(sent.length, 0, "debug commands never become user tasks");
	assert.equal(existsSync(debugDirectory), false, "debug factory and opt-in command never create files");
	await handlers.get("before_agent_start")({ prompt: "PRIVATE_ORDINARY_QUESTION", systemPromptOptions: { sections: {} } }, fixtureContext);
	assert.equal(existsSync(debugDirectory), false, "OFF ordinary prompt cannot create a debug report");
	await handlers.get("session_start")({ reason: "reload" }, fixtureContext);
	assert.equal(debugPrefs().length, savedDebugCount, "same-branch reload preserves opt-in without resetting metadata");
	await handlers.get("session_start")({ reason: "startup" }, fixtureContext);
	assert.equal(debugPrefs().at(-1).data.enabled, false, "fresh startup resets saved debug ON");
	await command.handler("debug on bench-test", ctx(true));
	await command.handler("debug off", ctx(true));
	assert.equal(debugPrefs().at(-1).data.enabled, false);
	assert.equal(existsSync(debugDirectory), false, "OFF mode and debug settings never write report files");
	for (const removed of ["status", "instructions"]) {
		await command.handler(removed, ctx(true));
		assert.match(notifications.at(-1).message, /removed/);
	}
	await command.handler("models", ctx(false));
	assert.match(notifications.at(-1).message, /Models: single/);
	assert.equal(sent.length, 0, "help, removed subcommands and routing summary must not submit a task");
	assert.equal(received.length, 0, "command help must not contact the daemon");
	assert.equal(activity.length, 0, "command help must not start workflow activity");
	const guard = async (toolName, input = {}) => (await handlers.get("tool_call")({ toolName, input }, fixtureContext))
		.filter((result) => result?.block);
	for (const toolName of ["desktop_observe", "desktop_click", "desktop_request_user", "desktop_model_phase", "desktop_visual_permission"])
		assert.match((await guard(toolName))[0]?.reason ?? "", /OFF/, `${toolName} must be blocked while OFF`);
	for (const toolName of ["desktop_ping", "desktop_metrics"])
		assert.equal((await guard(toolName)).length, 0, `${toolName} must remain available while OFF`);
	await command.handler("  Open the editor and save  ", ctx(true));
	assert.equal(sent.length, 0, "OFF must not queue the desktop task or turn mode ON");
	assert.match(notifications.at(-1).message, /OFF.*не е изпратена/);
	await command.handler("on", ctx(true));
	assert.equal(entries.at(-1).data.enabled, true);
	assert.equal(activeTools.filter(name => name.startsWith("desktop_")).length, 17, "ON declares only baseline tools");
	for (const name of ["desktop_screenshot", "desktop_inspect_visual", "desktop_model_phase", "desktop_type", "desktop_drag"])
		assert.ok(!activeTools.includes(name), `${name} must not be in the default ON loadout`);
	const { SAVED_LOGIN_POLICY } = await jiti.import(path.resolve(".pi/extensions/computer-use/instructions.ts"));
	const onStart = { prompt: "Check current window", systemPromptOptions: { sections: { other: "keep" } } };
	await handlers.get("before_agent_start")(onStart, fixtureContext);
	assert.equal(onStart.prompt, "Check current window", "ON instructions belong to the system section, not the user task");
	assert.equal(onStart.systemPromptOptions.sections.other, "keep");
	assert.ok(onStart.systemPromptOptions.sections.computer_use_mode.includes(SAVED_LOGIN_POLICY));
	assert.match(onStart.systemPromptOptions.sections.computer_use_mode, /desktop_visual_permission/);
	assert.match(onStart.systemPromptOptions.sections.computer_use_mode, /uncertain input/);
	// Exercise the real index → visual-policy → loadout callback chain without executing a capture.
	const region = { x: 5, y: 6, width: 70, height: 50 };
	const grantParams = { basis: "explicit_user_request", reason: "The user asked for a screenshot of this small region",
		checks: [], capture: "desktop_screenshot", target: region };
	const receivedBeforeGrant = received.length;
	const activityBeforeGrant = activity.length;
	assert.equal((await guard("desktop_screenshot", region))[0]?.block, true, "inactive capture is still denied by the hard gate");
	const granted = await tools.get("desktop_visual_permission").execute("fixture-permit", grantParams, undefined, undefined, fixtureContext);
	assert.equal(JSON.parse(granted.content[0].text).single_use, true);
	assert.equal(activeTools.filter(name => name.startsWith("desktop_")).length, 18);
	assert.ok(activeTools.includes("desktop_screenshot") && !activeTools.includes("desktop_inspect_visual"));
	assert.equal((await guard("desktop_observe")).length, 0, "ordinary semantic checks do not consume permission");
	await handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "fixture-semantic",
		toolName: "desktop_observe", result: undefined, isError: false }, fixtureContext);
	assert.ok(activeTools.includes("desktop_screenshot"), "semantic checks retain the granted capture declaration");
	assert.equal((await guard("desktop_screenshot", region)).length, 0, "exact granted crop passes the tool_call gate");
	assert.ok(activeTools.includes("desktop_screenshot"), "declaration stays active until execution ends");
	await handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "fixture-capture",
		toolName: "desktop_screenshot", result: undefined, isError: false }, fixtureContext);
	assert.equal(activeTools.filter(name => name.startsWith("desktop_")).length, 17);
	assert.ok(!activeTools.includes("desktop_screenshot"));
	assert.equal((await guard("desktop_screenshot", region))[0]?.block, true, "capture permit cannot be reused");
	const cancelledGrant = new AbortController();
	await tools.get("desktop_visual_permission").execute("fixture-abort", grantParams, cancelledGrant.signal, undefined, fixtureContext);
	assert.ok(activeTools.includes("desktop_screenshot"));
	cancelledGrant.abort();
	assert.equal(activeTools.filter(name => name.startsWith("desktop_")).length, 17, "abort withdraws the unused capture");
	assert.equal((await guard("desktop_screenshot", region))[0]?.block, true);
	assert.equal(received.length, receivedBeforeGrant, "grant, gate, and synthetic completion do not contact the daemon");
	assert.equal(activity.length, activityBeforeGrant, "visual declaration changes do not begin a workflow");
	await command.handler("off", ctx(true));
	assert.equal((await guard("desktop_stop")).length, 0, "emergency Stop stays available while OFF");
	await command.handler("on", ctx(true));
	assert.equal((await guard("desktop_observe")).length, 0, "ON allows ordinary semantic observations");
	for (const removed of ["instructions", "status", "models status", "models list", "models luna provider/id", "models sol provider/id"]) {
		await command.handler(removed, ctx(true));
		assert.equal(sent.length, 0, "removed subcommands must not become desktop tasks while ON");
	}
	await command.handler("  Open the editor and save  ", ctx(true));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].options, undefined);
	assert.equal(sent[0].content, "  Open the editor and save  ", "slash task is verbatim without duplicated policy");
	assert.ok(!sent[0].content.includes(SAVED_LOGIN_POLICY));
	await command.handler("Inspect the current window", ctx(false));
	assert.deepEqual(sent[1].options, { deliverAs: "followUp" });
	assert.equal(sent[1].content, "Inspect the current window");
	assert.equal(received.length, 0, "task submission itself must not use the daemon");
	const { registerComputerUseCommand } = await jiti.import(path.resolve(".pi/extensions/computer-use/command.ts"));
	let failedCommand;
	registerComputerUseCommand({ registerCommand: (_name, options) => { failedCommand = options; },
		sendUserMessage: () => { throw new Error("session is closed"); } }, { isEnabled: () => true });
	await failedCommand.handler("Try it", ctx(true));
	assert.match(notifications.at(-1).message, /Could not submit computer-use task: session is closed.*try again/);
	assert.equal(notifications.at(-1).level, "error");

	const result = await tools.get("desktop_ping").execute("smoke", {});
	assert.equal(received.length, 1);
	assert.deepEqual(received[0], { cmd: "ping" });
	assert.equal(JSON.parse(result.content[0].text).ok, true);
	assert.equal(result.details.command, "desktop_ping");
	assert.equal(activity.length, 0, "ping does not begin workflow");
	const batch = await tools.get("desktop_batch").execute("batch-smoke", { actions: [{ type: "keypress", key: "Return" }] });
	assert.deepEqual(received[1], { cmd: "batch", actions: [{ type: "keypress", key: "Return" }] });
	assert.equal(activity.length, 1);
	assert.equal(activity[0].action, "begin");
	assert.match(activity[0].token, /^[0-9a-f-]{36}$/);
	assert.equal(activity[0].ttl_ms, 30_000);
	assert.equal(batch.isError, true, "partial batch must retain failed status");
	assert.deepEqual(JSON.parse(batch.content[0].text).steps.map(({ ok }) => ok), [true, false]);
	assert.deepEqual(JSON.parse(batch.content[0].text).steps.map(({ elapsedMs }) => elapsedMs), [5, 6]);
	assert.equal(batch.details.response.steps.length, 2);
	const hugeBatch = await tools.get("desktop_batch").execute("oversize-batch", { actions: [{ type: "keypress", key: "Return" }, { type: "click", id: "n10" }] });
	const partial = JSON.parse(hugeBatch.content[0].text);
	assert.ok(hugeBatch.content[0].text.length <= 20_000);
	assert.equal(partial.truncated, true);
	assert.deepEqual(partial.steps.map(({ elapsedMs }) => elapsedMs), [5, 6]);
	assert.equal(partial.changes.generation, 2);
	assert.equal(partial.changes.omitted_nodes, 298);
	assert.equal(partial.changes.omitted_removed, 82);
	assert.ok(tools.has("desktop_dirty_regions"), "desktop_dirty_regions was not registered");
	const dirty = await tools.get("desktop_dirty_regions").execute("dirty-regions-smoke", {});
	assert.deepEqual(received[3], { cmd: "dirty_regions" });
	assert.ok(dirty.content[0].text.length <= 20_000);
	const summary = JSON.parse(dirty.content[0].text).screen_diff;
	assert.equal(summary.dirty_tiles, 1500);
	assert.equal(summary.region_count, 500);
	assert.equal(summary.omitted_regions, 500);
	assert.ok(tools.has("desktop_search_seen"), "desktop_search_seen was not registered");
	const seen = await tools.get("desktop_search_seen").execute("seen-smoke", { query: "Save", limit: 5 });
	assert.deepEqual(received[4], { cmd: "search_seen", query: "Save", limit: 5 });
	const seenText = seen.content[0].text;
	assert.ok(seenText.length <= 20_000);
	assert.equal(JSON.parse(seenText).seen.results.length, 50);
	assert.equal(JSON.parse(seenText).seen.results[0].source, "current");
	assert.equal(JSON.parse(seenText).seen.results[1].source, "stale");
	assert.ok(!seenText.includes("PRIVATE_NOT_INDEXED"));
	assert.equal(seen.content.length, 1, "search must never send images");
	const metrics = await tools.get("desktop_metrics").execute("metrics-smoke", { reset: true });
	assert.deepEqual(received[5], { cmd: "metrics", reset: true });
	assert.equal(JSON.parse(metrics.content[0].text).metrics.requests, 7);
	assert.equal(metrics.content.length, 1);
	const large = await tools.get("desktop_search_seen").execute("large-smoke", { query: "large" });
	assert.ok(large.content[0].text.length <= 20_000);
	const bounded = JSON.parse(large.content[0].text);
	assert.deepEqual(large.details.response, bounded, "tool details must use the same bounded representation");
	assert.ok(large.details.response.seen.results[0].name.length <= 240);
	assert.ok(large.details.response.seen.results[0].role.length <= 240);
	assert.ok(large.details.response.seen.results[0].window.length <= 240);
	assert.equal(bounded.seen.results.length, 50, "prefer compact fields to dropping ranked hits");
	assert.equal(bounded.seen.fields_truncated, true);
	assert.ok(bounded.seen.results[0].name.length < 240);
	assert.equal(bounded.seen.results[0].source, "current");
	const observe = await tools.get("desktop_observe").execute("observe-smoke", {});
	assert.ok(observe.content[0].text.length <= 6_000, "unscoped observation must fit short model budget");
	const observed = JSON.parse(observe.content[0].text);
	assert.equal(observed.ok, true);
	assert.deepEqual(observe.details.response, observed);
	assert.equal(observed.snapshot.generation, 7);
	assert.equal(observed.snapshot.root, "n0");
	assert.equal(observed.windows[0].title, "Focused Editor");
	assert.equal(observed.omitted_windows + observed.windows.length, 80);
	assert.equal(observed.snapshot.omitted_nodes + observed.snapshot.nodes.length, 400);
	assert.ok(observed.snapshot.nodes.length > 0 && observed.snapshot.nodes.length <= 24);
	assert.equal(observed.snapshot.nodes[0].name, "Top focused action");
	assert.equal(observe.content.length, 1, "observation never sends images by default");
	assert.ok(!observe.content[0].text.includes("PRIVATE_SCREEN_IMAGE"));
	const changes = await tools.get("desktop_changes").execute("changes-smoke", { since: 6 });
	assert.ok(changes.content[0].text.length <= 6_000, "unscoped delta must fit short model budget");
	const deltaResult = JSON.parse(changes.content[0].text);
	assert.equal(deltaResult.delta.from, 6);
	assert.equal(deltaResult.delta.generation, 7);
	assert.equal(deltaResult.delta.changed[0].name, "Top focused action");
	assert.equal(deltaResult.delta.omitted_nodes + deltaResult.delta.changed.length, 400);
	assert.ok(deltaResult.delta.changed.length > 0 && deltaResult.delta.changed.length <= 24);
	assert.equal(deltaResult.delta.omitted_removed + deltaResult.delta.removed.length, 80);
	assert.equal(deltaResult.windows[0].title, "Focused Editor");
	const gtkResult = await tools.get("desktop_observe").execute("gtk-scope", { since: 42 });
	assert.ok(gtkResult.content[0].text.length < 5_000, "the unrelated 600-node desktop must not exhaust model context");
	const gtk = JSON.parse(gtkResult.content[0].text);
	assert.equal(gtk.snapshot.generation, 42);
	assert.equal(gtk.snapshot.root, "desktop-app", "do not change daemon root semantics");
	assert.equal(gtk.snapshot.scope_root, "gtk-frame");
	assert.equal(gtk.snapshot.semantic_scope, "active_window");
	assert.equal(gtk.snapshot.out_of_scope_nodes + gtk.snapshot.nodes.length + (gtk.snapshot.omitted_nodes ?? 0), 607);
	assert.equal(gtk.windows[0].title, "GTK Editor");
	assert.equal(gtk.omitted_windows + gtk.windows.length, 24);
	assert.equal(gtk.snapshot.omitted_nodes, 0, "small active graph should remain intact");
	assert.deepEqual(new Set(gtk.snapshot.nodes.map(({ id }) => id)),
		new Set(["gtk-app", "gtk-frame", "gtk-page", "gtk-save", "gtk-child-only"]));
	assert.ok(gtk.snapshot.nodes.some(({ name, focused }) => name === "Save GTK Document" && focused));
	assert.ok(!gtkResult.content[0].text.includes("UNRELATED_DESKTOP_"));
	assert.deepEqual(gtkResult.details.response, gtk);
	const gtkDelta = JSON.parse((await tools.get("desktop_changes").execute("gtk-delta", { since: 41 })).content[0].text);
	assert.equal(gtkDelta.delta.semantic_scope, "active_window");
	assert.equal(gtkDelta.delta.from, 41);
	assert.equal(gtkDelta.delta.generation, 42);
	assert.equal(gtkDelta.delta.out_of_scope_nodes + gtkDelta.delta.changed.length + (gtkDelta.delta.omitted_nodes ?? 0), 607);
	assert.equal(gtkDelta.delta.removed_scope, "unfiltered", "removed IDs have no provable frame ownership");
	assert.deepEqual(gtkDelta.delta.removed, ["removed-desktop", "removed-gtk"]);
	assert.ok(!JSON.stringify(gtkDelta).includes("UNRELATED_DESKTOP_"));
	for (const [since, visibleId] of [[50, "shell-search"], [51, "shell-menu"]]) {
		const result = await tools.get("desktop_observe").execute(`xed-shell-${since}`, { since });
		assert.ok(result.content[0].text.length <= 6_000, "scoped shell view must fit observation budget");
		const snapshot = JSON.parse(result.content[0].text).snapshot;
		assert.equal(snapshot.semantic_scope, "active_window_with_shell");
		assert.equal(snapshot.scope_root, "gtk-frame");
		assert.deepEqual(snapshot.shell_scope_roots, ["shell-stage"]);
		assert.equal(snapshot.out_of_scope_nodes + snapshot.nodes.length + (snapshot.omitted_nodes ?? 0), 617);
		const ids = new Set(snapshot.nodes.map(({ id }) => id));
		for (const id of ["gtk-frame", "gtk-save", "cinnamon-app", "shell-stage", "shell-panel", visibleId])
			assert.ok(ids.has(id), `${id} lost when Xed stays active`);
		assert.ok(!ids.has("shell-idle-menu") && !ids.has("background-menu") && !ids.has("desktop-599"));
		assert.deepEqual(result.details.response.snapshot, snapshot);
	}
	const unknownStage = JSON.parse((await tools.get("desktop_observe").execute("xed-stage-unknown", { since: 57 })).content[0].text).snapshot;
	assert.equal(unknownStage.semantic_scope, "active_window_with_shell", "showing focused control proves popup even if stage state is unknown");
	assert.ok(unknownStage.nodes.some(({ id }) => id === "shell-search"));
	const crowdedShell = JSON.parse((await tools.get("desktop_observe").execute("xed-crowded-menu", { since: 56 })).content[0].text).snapshot;
	assert.equal(crowdedShell.semantic_scope, "active_window_with_shell");
	assert.ok(crowdedShell.nodes.some(({ id }) => id === "shell-menu"), "showing popup survives 90-node/model text budgets");
	assert.ok(!crowdedShell.nodes.some(({ id }) => id === "background-menu" || id === "shell-idle-menu"));
	for (const since of [52, 53]) {
		const snapshot = JSON.parse((await tools.get("desktop_observe").execute(`xed-no-shell-${since}`, { since })).content[0].text).snapshot;
		assert.equal(snapshot.semantic_scope, "active_window", "idle/hidden Cinnamon menus are not popup evidence");
		assert.ok(!snapshot.nodes.some(({ id }) => id.startsWith("shell-") || id === "cinnamon-app" || id === "background-menu"));
	}
	const shellDelta = JSON.parse((await tools.get("desktop_changes").execute("xed-shell-delta", { since: 54 })).content[0].text).delta;
	assert.equal(shellDelta.semantic_scope, "active_window_with_shell");
	assert.deepEqual(shellDelta.shell_scope_roots, ["shell-stage"]);
	assert.ok(shellDelta.changed.some(({ id }) => id === "shell-search"));
	assert.equal(shellDelta.removed_scope, "unfiltered");
	const partialShell = JSON.parse((await tools.get("desktop_changes").execute("xed-shell-partial", { since: 55 })).content[0].text).delta;
	assert.equal(partialShell.semantic_scope, "active_window");
	assert.ok(!partialShell.changed.some(({ id }) => id === "shell-search"), "missing shell ancestry must not be guessed in a delta");
	const removedHeavy = JSON.parse((await tools.get("desktop_changes").execute("gtk-many-removed", { since: 40 })).content[0].text);
	assert.equal(removedHeavy.delta.removed_scope, "unfiltered");
	assert.equal(removedHeavy.delta.removed.length + removedHeavy.delta.omitted_removed, 2_000);
	const overviewLengths = [];
	for (const since of [43, 44, 45]) {
		const overview = await tools.get("desktop_observe").execute(`no-guess-${since}`, { since });
		overviewLengths.push(overview.content[0].text.length);
		assert.ok(overview.content[0].text.length <= 6_000, "cold/mismatched output must stay concise");
		const uncertainScope = JSON.parse(overview.content[0].text);
		assert.equal(uncertainScope.snapshot.semantic_scope, undefined, "unknown title does not mean inaccessible");
		assert.equal(uncertainScope.snapshot.generation, 42);
		assert.equal(uncertainScope.snapshot.root, "desktop-app");
		assert.equal(uncertainScope.windows[0].title, since === 43 ? "GTK Editor - Modified" : "GTK Editor");
		assert.ok(uncertainScope.snapshot.nodes.length > 0 && uncertainScope.snapshot.nodes.length <= 24);
		assert.equal(uncertainScope.snapshot.omitted_nodes + uncertainScope.snapshot.nodes.length, since === 44 ? 608 : 607);
		assert.deepEqual(overview.details.response, uncertainScope);
	}
	const desktopOnly = JSON.parse((await tools.get("desktop_observe").execute("desktop-fallback", { since: 46 })).content[0].text);
	assert.equal(desktopOnly.snapshot.semantic_scope, "background_desktop_only");
	assert.equal(desktopOnly.snapshot.out_of_scope_nodes, 602);
	assert.equal(desktopOnly.snapshot.omitted_nodes, 0);
	assert.deepEqual(desktopOnly.snapshot.nodes, []);
	const rediscovered = JSON.parse((await tools.get("desktop_search_seen").execute("find-omitted", { query: "UNRELATED_DESKTOP_599" })).content[0].text);
	assert.equal(rediscovered.seen.results[0].id, "desktop-599");
	const inspected = JSON.parse((await tools.get("desktop_inspect").execute("inspect-omitted", { id: "desktop-599" })).content[0].text);
	assert.equal(inspected.node.id, "desktop-599");
	const before = received.length;
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => tools.get("desktop_keypress").execute("preabort", { key: "slow" }, controller.signal), /cancelled/i);
	assert.equal(received.length, before, "pre-send abort must never dispatch input");
	const inFlight = new AbortController();
	const pending = tools.get("desktop_keypress").execute("abort-after-send", { key: "slow" }, inFlight.signal);
	while (received.length === before) await new Promise((resolve) => setTimeout(resolve, 2));
	inFlight.abort();
	await assert.rejects(pending, /outcome is uncertain.*Do not automatically retry.*emergency[- ]stop.*sticky/i);
	const { ComputerUseClient } = await jiti.import(path.resolve(".pi/extensions/computer-use/client.ts"));
	const impatient = new ComputerUseClient({ socketPath, timeoutMs: 25 });
	await assert.rejects(() => impatient.request({ cmd: "keypress", key: "slow" }),
		/outcome is uncertain.*Do not automatically retry.*emergency[- ]stop.*sticky/i);
	assert.equal(received.filter(({ cmd }) => cmd === "stop").length, 0, "abort/timeout must not automatically stop the daemon");
	await handlers.get("agent_settled")();
	assert.deepEqual(activity.map(({ action }) => action), ["begin", "end"]);
	assert.equal(activity[0].token, activity[1].token);
	const runAbort = new AbortController();
	await handlers.get("before_agent_start")({ prompt: "fixture ordinary task", systemPromptOptions: { sections: {} } },
		{ ...fixtureContext, signal: runAbort.signal });
	await tools.get("desktop_inspect").execute("second-run", { id: "n1" });
	assert.deepEqual(activity.map(({ action }) => action), ["begin", "end", "begin"]);
	runAbort.abort();
	for (let i = 0; i < 30 && activity.at(-1).action !== "end"; i++)
		await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(activity.at(-1).action, "end", "run abort closes the active workflow while idle");
	await handlers.get("session_shutdown")({}, { mode: "print", hasUI: false });
	assert.equal(activity.length, 4, "shutdown cleanup is idempotent");
	const { DesktopWorkflow } = await jiti.import(path.resolve(".pi/extensions/computer-use/workflow.ts"));
	const calls = [];
	const controller2 = new AbortController();
	const workflow = new DesktopWorkflow(async (request) => { calls.push(request); return { ok: true }; }, 12);
	await Promise.all([
		workflow.beforeExecute("desktop_observe", controller2.signal),
		workflow.beforeExecute("desktop_batch", controller2.signal),
	]);
	assert.deepEqual(calls.map(({ action }) => action), ["begin"], "parallel executes share a lease");
	await new Promise((resolve) => setTimeout(resolve, 45));
	assert.ok(calls.some(({ action }) => action === "renew"), "renewal continues without tool calls");
	assert.equal(new Set(calls.map(({ token }) => token)).size, 1);
	controller2.abort();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(calls.at(-1).action, "end", "abort releases the lease");
	const afterAbort = calls.length;
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(calls.length, afterAbort, "no renew timers survive abort");
	await workflow.beforeExecute("desktop_observe");
	await workflow.stop();
	const stoppedCount = calls.length;
	await workflow.beforeExecute("desktop_observe");
	assert.equal(calls.length, stoppedCount, "stop never reacquires the lease");

	let releaseBegin;
	const delayed = [];
	const racing = new DesktopWorkflow(async (request) => {
		delayed.push(request.action);
		if (request.action === "begin") await new Promise((resolve) => { releaseBegin = resolve; });
		return { ok: true };
	});
	const starting = racing.beforeExecute("desktop_observe");
	const closing = racing.close();
	releaseBegin();
	await Promise.all([starting, closing]);
	assert.deepEqual(delayed, ["begin", "end"], "late begin is ended, not renewed");

	let unblockStopBegin;
	const urgentCalls = [];
	const urgent = new DesktopWorkflow(async (request) => {
		urgentCalls.push(request.action);
		if (request.action === "begin") await new Promise((resolve) => { unblockStopBegin = resolve; });
		return { ok: true };
	});
	const firstAction = urgent.beforeExecute("desktop_wait");
	await urgent.beforeExecute("desktop_stop");
	assert.deepEqual(urgentCalls, ["begin"], "stop does not await a stalled begin");
	unblockStopBegin();
	await firstAction;
	for (let i = 0; i < 30 && urgentCalls.at(-1) !== "end"; i++)
		await new Promise((resolve) => setTimeout(resolve, 2));
	assert.deepEqual(urgentCalls, ["begin", "end"]);
	await urgent.beforeExecute("desktop_observe");
	assert.equal(urgentCalls.length, 2, "stop permanently prevents new leases");

	let releaseRenew;
	let renewStarted;
	const renewalStarted = new Promise((resolve) => { renewStarted = resolve; });
	const renewalCalls = [];
	const duringRenew = new DesktopWorkflow((request) => {
		renewalCalls.push(request.action);
		if (request.action === "renew") {
			renewStarted();
			return new Promise((resolve) => { releaseRenew = resolve; });
		}
		return Promise.resolve({ ok: true });
	}, 5);
	await duringRenew.beforeExecute("desktop_observe");
	await renewalStarted;
	await duringRenew.beforeExecute("desktop_stop");
	assert.deepEqual(renewalCalls, ["begin", "renew"], "stop does not await stalled renewal");
	releaseRenew({ ok: true });
	for (let i = 0; i < 30 && renewalCalls.at(-1) !== "end"; i++)
		await new Promise((resolve) => setTimeout(resolve, 2));
	assert.deepEqual(renewalCalls, ["begin", "renew", "end"]);

	let rejectStaleRenew;
	let oldRenewStarted;
	let freshRenewStarted;
	const oldRenewReady = new Promise((resolve) => { oldRenewStarted = resolve; });
	const freshRenewReady = new Promise((resolve) => { freshRenewStarted = resolve; });
	const leaseCalls = [];
	let oldToken;
	const overlapping = new DesktopWorkflow((request) => {
		leaseCalls.push(request);
		if (request.action === "begin" && !oldToken) oldToken = request.token;
		if (request.action === "renew" && request.token === oldToken) {
			oldRenewStarted();
			return new Promise((_resolve, reject) => { rejectStaleRenew = reject; });
		}
		if (request.action === "renew") freshRenewStarted();
		return Promise.resolve({ ok: true });
	}, 15);
	await overlapping.beforeExecute("desktop_observe");
	await oldRenewReady;
	const oldClose = overlapping.close(); // Detached now; old renewal is still pending.
	await overlapping.beforeExecute("desktop_inspect");
	const freshToken = leaseCalls.filter(({ action }) => action === "begin").at(-1).token;
	assert.notEqual(freshToken, oldToken);
	rejectStaleRenew(new Error("obsolete renewal failed"));
	await oldClose;
	let renewTimeout;
	try {
		await Promise.race([
			freshRenewReady,
			new Promise((_resolve, reject) => {
				renewTimeout = setTimeout(() => reject(new Error("fresh lease renewal was lost")), 300);
			}),
		]);
	} finally { clearTimeout(renewTimeout); }
	assert.ok(leaseCalls.some(({ action, token }) => action === "renew" && token === freshToken),
		"stale renewal failure must not cancel fresh renewal");
	assert.equal(leaseCalls.some(({ action, token }) => action === "end" && token === freshToken), false,
		"fresh lease must remain active until explicitly closed");
	await overlapping.close();
	assert.equal(leaseCalls.filter(({ action, token }) => action === "end" && token === freshToken).length, 1);

	let rejectOldBegin;
	const generations = [];
	const reset = new DesktopWorkflow((request) => {
		generations.push(request);
		if (request.action === "begin" && generations.length === 1)
			return new Promise((_resolve, reject) => { rejectOldBegin = reject; });
		return Promise.resolve({ ok: true });
	});
	const oldBegin = reset.beforeExecute("desktop_observe");
	const nextRun = reset.newRun();
	rejectOldBegin(new Error("obsolete begin failure"));
	await Promise.all([oldBegin, nextRun]);
	await reset.beforeExecute("desktop_observe");
	assert.deepEqual(generations.map(({ action }) => action), ["begin", "begin"], "obsolete failure cannot disable next run");
	await reset.close();
	assert.equal(generations.at(-1).action, "end");

	// Exercise the new tool after existing index-sensitive assertions, with its own workflow.
	const launchTools = new Map();
	const { handlers: launchHandlers, on: onLaunch } = listenerRegistry();
	extension({ registerTool: (tool) => launchTools.set(tool.name, tool), registerCommand: () => {},
		registerVirtualModel: () => {}, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		on: onLaunch });
	const launchTool = launchTools.get("desktop_launch_app");
	assert.ok(launchTool, "launch must be registered as a direct model tool");
	assert.equal(launchTool.annotations.readOnlyHint, false);
	const { Check } = sdkRequire("typebox/value");
	const schema = launchTool.parameters;
	for (const valid of [{ app_id: "xed.desktop" }, { app_id: "org.x.editor.desktop" }, { name: "Éditeur" }])
		assert.equal(Check(schema, valid), true, `expected valid selector: ${JSON.stringify(valid)}`);
	for (const invalid of [{}, { app_id: "xed.desktop", name: "Editor" },
		{ app_id: "xed.desktop", exec: "evil" }, { name: "Editor", args: [] },
		{ app_id: "../xed.desktop" }, { app_id: "/usr/share/applications/xed.desktop" },
		{ app_id: ".hidden.desktop" }, { app_id: "evil;cmd.desktop" },
		{ app_id: "a".repeat(241) + ".desktop" }, { app_id: "xed" },
		{ name: "" }, { name: "   " }, { name: "a".repeat(241) }, { name: "a\ncmd" }])
		assert.equal(Check(schema, invalid), false, `invalid selector accepted: ${JSON.stringify(invalid)}`);
	const launchActivityStart = activity.length;
	const launchReceivedStart = received.length;
	const launched = await launchTool.execute("launch-id", { app_id: "xed.desktop" });
	assert.deepEqual(received[launchReceivedStart], { cmd: "launch_app", app_id: "xed.desktop" });
	assert.equal(activity.length, launchActivityStart + 1, "launch begins the normal workflow lease");
	assert.equal(activity.at(-1).action, "begin");
	assert.equal(launched.isError, false);
	assert.deepEqual(JSON.parse(launched.content[0].text), { ok: true,
		launch: { app_id: "xed.desktop", name: "Editor", accepted: true } });
	assert.deepEqual(launched.details.response, JSON.parse(launched.content[0].text));
	assert.equal(launched.content.length, 1, "launch sends no screenshot");
	const ambiguous = await launchTool.execute("launch-name", { name: "Editor" });
	assert.deepEqual(received[launchReceivedStart + 1], { cmd: "launch_app", name: "Editor" });
	assert.equal(ambiguous.isError, true);
	assert.deepEqual(JSON.parse(ambiguous.content[0].text), { ok: false,
		error: "ambiguous desktop application; use app_id", app_matches: [
			{ app_id: "org.example.Editor.desktop", name: "Editor" },
			{ app_id: "org.other.Editor.desktop", name: "Editor" }] });
	assert.deepEqual(ambiguous.details.response, JSON.parse(ambiguous.content[0].text));
	const missing = await launchTool.execute("launch-missing", { app_id: "missing.desktop" });
	assert.equal(missing.isError, true);
	assert.match(JSON.parse(missing.content[0].text).error, /not found/);
	assert.equal(received.filter(({ cmd, app_id }) => cmd === "launch_app" && app_id === "missing.desktop").length, 1,
		"missing entry is never retried automatically");
	// Daemon validation is the backstop if a client bypasses the Pi parameter schema.
	const invalidDaemon = await launchTool.execute("launch-invalid-daemon", { app_id: "invalid selector" });
	assert.equal(invalidDaemon.isError, true);
	assert.match(JSON.parse(invalidDaemon.content[0].text).error, /basename/);
	const slowLaunchClient = new ComputerUseClient({ socketPath, timeoutMs: 25 });
	await assert.rejects(() => slowLaunchClient.request({ cmd: "launch_app", app_id: "slow.desktop" }),
		/outcome is uncertain.*Do not automatically retry.*emergency[- ]stop.*sticky/i);
	assert.equal(received.filter(({ cmd, app_id }) => cmd === "launch_app" && app_id === "slow.desktop").length, 1);
	for (const app_id of ["malformed-empty.desktop", "malformed-json.desktop", "malformed-array.desktop"]) {
		await assert.rejects(() => slowLaunchClient.request({ cmd: "launch_app", app_id }),
			/outcome is uncertain.*Do not automatically retry/i);
		assert.equal(received.filter((request) => request.cmd === "launch_app" && request.app_id === app_id).length, 1);
	}
	await launchHandlers.get("agent_settled")();
	assert.deepEqual(activity.slice(launchActivityStart).map(({ action }) => action), ["begin", "end"]);
	await launchHandlers.get("session_shutdown")({}, { mode: "print", hasUI: false });
	const stoppedLaunch = new DesktopWorkflow(async (request) => {
		if (request.action === "begin") throw new Error("launch unexpectedly acquired a lease after stop");
		return { ok: true };
	});
	await stoppedLaunch.beforeExecute("desktop_stop");
	await stoppedLaunch.beforeExecute("desktop_launch_app");
	// A stopped lease does not authorize launch: the daemon's independent safety gate rejects it.

	legacyMode = true;
	const legacyTools = new Map();
	const { handlers: legacyHandlers, on: onLegacy } = listenerRegistry();
	extension({ registerTool: (tool) => legacyTools.set(tool.name, tool), registerCommand: () => {},
		registerVirtualModel: () => {}, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		on: onLegacy });
	const oldWarnings = console.warn;
	const warnings = [];
	console.warn = (message) => warnings.push(message);
	try {
		const legacy = new DesktopWorkflow(async () => { throw new Error("unsupported command"); });
		await legacy.beforeExecute("desktop_observe");
		await legacy.beforeExecute("desktop_click");
		assert.equal(warnings.length, 1, "old daemon is diagnosed once, without blocking tools");
		await legacy.close();
		const priorActivity = activity.length;
		const oldResult = await legacyTools.get("desktop_observe").execute("old-daemon", {});
		assert.equal(JSON.parse(oldResult.content[0].text).ok, true, "older daemon must still serve desktop tools");
		await legacyTools.get("desktop_click").execute("old-daemon-click", { id: "n1" });
		assert.equal(activity.length, priorActivity + 1, "do not flood old daemon with failed begins");
		assert.equal(warnings.length, 2, "one warning per extension instance");
		await legacyHandlers.get("agent_settled")();
		await legacyHandlers.get("session_shutdown")({}, { mode: "print", hasUI: false });
	} finally { console.warn = oldWarnings; }
	console.log(`Extension runtime smoke test passed: ${tools.size} tools; mixed-desktop fixture ${rawFixtureChars} raw chars -> ${gtkResult.content[0].text.length} scoped / ${overviewLengths.join(", ")} unscoped model chars; no model call.`);
} finally {
	await new Promise((resolve) => daemon.close(resolve));
	if (previousSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
	else process.env.COMPUTER_USE_SOCKET = previousSocket;
	if (previousBinary === undefined) delete process.env.COMPUTER_USE_DAEMON;
	else process.env.COMPUTER_USE_DAEMON = previousBinary;
	if (previousState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = previousState;
	await rm(tempDir, { recursive: true, force: true });
}
