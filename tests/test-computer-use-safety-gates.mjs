#!/usr/bin/env node
// Composed Pi handler fixtures: no daemon, desktop input, model, or OS notifications.
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
	...(existsSync(releases) ? readdirSync(releases).sort().reverse().map((release) =>
		path.join(releases, release, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])];
const sdk = candidates.find((candidate) => candidate && existsSync(candidate));
if (!sdk) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE");
const requireSdk = createRequire(sdk);
const { createJiti } = await import(pathToFileURL(requireSdk.resolve("jiti")));
const jiti = createJiti(import.meta.url, { moduleCache: false,
	alias: { typebox: requireSdk.resolve("typebox"), "@earendil-works/pi-tui": requireSdk.resolve("@earendil-works/pi-tui") } });
const base = path.join(root, ".pi/extensions/computer-use");
const { ComputerUseMode } = await jiti.import(path.join(base, "mode.ts"));
const { ComputerUseRouting } = await jiti.import(path.join(base, "routing.ts"));
const { registerComputerUseHandoff } = await jiti.import(path.join(base, "handoff.ts"));
const { registerVisualPolicy } = await jiti.import(path.join(base, "visual-policy.ts"));

const region = { x: 10, y: 20, width: 30, height: 40 };
const permission = { basis: "semantic_blocker", reason: "Inaccessible live control after semantic search and inspection",
	checks: ["desktop_search_seen returned stale id", "desktop_inspect found no live control"],
	capture: "desktop_screenshot", target: region };
const handoff = { reason: "technical", instructions: "Please complete this step, then reply." };
function fixture() {
	const tools = new Map();
	const harness = extensionHarness(tools);
	const ctx = { mode: "print", hasUI: false, signal: undefined, sessionManager: { getBranch: () => harness.entries },
		ui: { notify() { throw new Error("Unexpected UI notification"); } } };
	const mode = new ComputerUseMode(harness.pi, async () => { throw new Error("Unexpected OS notification"); });
	registerComputerUseHandoff(harness.pi, mode);
	registerVisualPolicy(harness.pi, mode);
	mode.start(ctx, "startup");
	const executed = [];
	let nextId = 0;
	const gate = async (name, input = {}, id = `t${++nextId}`) =>
		(await harness.emit("tool_call", ctx, { toolCallId: id, toolName: name, input })).filter((result) => result?.block);
	// Mimic Pi: blocked calls never reach execute. Other desktop tools are inert mocks.
	const call = async (name, input = {}, id) => {
		const blocks = await gate(name, input, id);
		if (blocks.length) return { blocks };
		executed.push(name);
		const tool = tools.get(name);
		return { blocks, result: tool ? await tool.execute(id ?? `t${nextId}`, input, undefined, undefined, ctx) : undefined };
	};
	const message = (calls) => harness.emit("message_end", ctx, { message: { role: "assistant",
		content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })) } });
	const newPrompt = async (prompt = "ordinary user question") => {
		const event = { prompt, systemPromptOptions: { sections: {} } };
		mode.beforeStart(event, ctx);
		await harness.emit("before_agent_start", ctx, event);
		return event;
	};
	return { tools, harness, ctx, mode, gate, call, message, newPrompt, executed };
}

const off = fixture();
assert.equal(off.mode.isEnabled(), false);
for (const [name, args] of [
	["desktop_model_phase", {}], ["desktop_visual_permission", permission], ["desktop_request_user", handoff],
	["desktop_batch", { actions: [] }], ["desktop_launch_app", { app_id: "example.desktop" }],
	["desktop_observe", {}], ["desktop_observe", { screenshot: true }],
	["desktop_screenshot", region], ["desktop_inspect_visual", { id: "n1" }],
	["desktop_set_text", { id: "n1", text: "test" }], ["desktop_paste_text", { text: "test", target: { id: "n1" } }], ["desktop_click", { id: "n1" }],
]) {
	const blocks = await off.gate(name, args);
	assert.ok(blocks.some((result) => /OFF/.test(result.reason)), `${name} must be blocked by OFF`);
}
assert.equal(off.executed.length, 0);
for (const name of ["desktop_ping", "desktop_metrics", "desktop_stop"]) {
	assert.equal((await off.gate(name)).length, 0, `${name} remains available in OFF`);
}
const offPrompt = await off.newPrompt("Please take a screenshot");
assert.equal(offPrompt.systemPromptOptions.sections.computer_use_mode, undefined);
assert.equal(off.mode.isEnabled(), false, "a new user prompt never automatically enables computer use");
assert.ok((await off.gate("desktop_observe")).some((result) => /OFF/.test(result.reason)));

const on = fixture();
on.mode.setEnabled(true, on.ctx); // Explicit user toggle; no classifier or prompt enables it.
assert.equal((await on.gate("desktop_observe")).length, 0, "ON allows semantic observation");
assert.equal((await on.gate("desktop_search_seen", { query: "Save" })).length, 0);
assert.equal((await on.gate("desktop_inspect", { id: "n1" })).length, 0);
assert.equal((await on.gate("desktop_screenshot", region)).some((result) => result.block), true,
	"ON is not itself visual permission");
on.mode.setEnabled(false, on.ctx);
assert.ok((await on.gate("desktop_observe")).some((result) => /OFF/.test(result.reason)));
await on.newPrompt("Resume the desktop task");
assert.equal(on.mode.isEnabled(), false, "OFF remains OFF across user prompts");

for (const [siblingName, input] of [
	["desktop_observe", {}], ["desktop_batch", { actions: [{ type: "click", id: "n1" }] }],
	["desktop_screenshot", region], ["desktop_visual_permission", permission],
]) {
	for (const order of ["handoff-first", "action-first"]) {
		const f = fixture();
		f.mode.setEnabled(true, f.ctx);
		const calls = [["h", "desktop_request_user", handoff], ["a", siblingName, input]];
		await f.message(order === "handoff-first" ? calls : calls.toReversed());
		const ordered = order === "handoff-first" ? calls : calls.toReversed();
		for (const [id, name, args] of ordered) {
			const result = await f.call(name, args, id);
			if (id === "a") assert.ok(result.blocks.some((block) => /Action required must not run alongside/.test(block.reason)),
				`${siblingName} blocked before handoff execution (${order})`);
			else assert.equal(result.blocks.length, 0, "handoff itself remains available");
		}
		assert.equal(f.mode.isWaitingForUser(), true);
		assert.deepEqual(f.executed, ["desktop_request_user"], "no sibling desktop action executes");
	}
}

const waiting = fixture();
waiting.mode.setEnabled(true, waiting.ctx);
assert.equal((await waiting.call("desktop_visual_permission", permission)).blocks.length, 0);
assert.equal((await waiting.call("desktop_request_user", handoff)).blocks.length, 0);
assert.equal(waiting.mode.isWaitingForUser(), true);
for (const [name, args] of [
	["desktop_observe", {}], ["desktop_visual_permission", permission], ["desktop_screenshot", region],
	["desktop_inspect_visual", { id: "n1" }],
]) {
	assert.ok((await waiting.call(name, args)).blocks.length, `Action required blocks later ${name}`);
}
assert.deepEqual(waiting.executed, ["desktop_visual_permission", "desktop_request_user"]);
await waiting.newPrompt("I completed the requested step");
assert.equal(waiting.mode.isEnabled(), true);
assert.equal(waiting.mode.isWaitingForUser(), false);
assert.equal((await waiting.gate("desktop_observe")).length, 0, "new prompt permits fresh semantic re-observation");
assert.ok((await waiting.gate("desktop_screenshot", region)).length, "old permit cannot survive the new run");

// Composed production handoff execute: a blocked technical request cannot set Action required.
// Synthetic physical models and tool calls only; no provider, daemon, desktop or notification.
async function hybridFixture() {
	const f = fixture();
	const models = ["gpt-original", "gpt-sol", "gpt-luna"].map(id => ({ id, provider: "test-account", api: "fixture" }));
	let current = models[0];
	Object.defineProperty(f.ctx, "model", { get: () => current });
	f.ctx.modelRegistry = { getAvailable: () => models };
	f.harness.pi.setModel = async (model) => {
		const previousModel = current;
		current = model;
		await f.harness.emit("model_select", f.ctx, { model, previousModel });
		return true;
	};
	const routing = new ComputerUseRouting(f.harness.pi, f.mode);
	f.mode.setEnabled(true, f.ctx);
	await routing.command("hybrid", f.ctx);
	const event = { prompt: "Fixture desktop task", systemPromptOptions: { sections: {} } };
	f.mode.beforeStart(event, f.ctx);
	await routing.beforeStart(event, f.ctx);
	assert.equal(current.id, "gpt-sol");
	await f.call("desktop_model_phase", { phase: "execute", plan: "Observe verified state, then execute" });
	assert.equal(current.id, "gpt-luna");
	return { ...f, routing, getModel: () => current.id };
}
const hybrid = await hybridFixture();
const technical = await hybrid.call("desktop_request_user", handoff);
assert.match(technical.blocks[0]?.reason ?? "", /Technical user handoff requires Sol review/);
assert.equal(hybrid.mode.isWaitingForUser(), false, "blocked direct execute must not set Action required");
assert.deepEqual(hybrid.executed, ["desktop_model_phase"], "host gate never executes the blocked request");
assert.equal((await hybrid.call("desktop_observe")).blocks.length, 0, "semantic observation remains available");
await hybrid.call("desktop_model_phase", { phase: "escalate", reason: "Verified blocker after safe alternatives",
	verified_state: "Observed current form and launcher" });
assert.equal(hybrid.getModel(), "gpt-sol");
assert.equal((await hybrid.call("desktop_request_user", handoff)).blocks.length, 0, "Sol may hand off exhausted technical blocker");
assert.equal(hybrid.mode.isWaitingForUser(), true);
for (const reason of ["login", "mfa", "captcha", "approval", "clarification"]) {
	const f = await hybridFixture();
	assert.equal((await f.call("desktop_request_user", { reason, instructions: "Please complete this step, then reply." })).blocks.length, 0,
		`${reason} must bypass technical-only Sol review`);
	assert.equal(f.mode.isWaitingForUser(), true);
}
const emergency = await hybridFixture();
assert.equal((await emergency.call("desktop_stop")).blocks.length, 0, "emergency Stop cannot be blocked by technical review");
assert.ok((await emergency.call("desktop_request_user", handoff)).blocks.length, "Stop disables subsequent requests");
await emergency.harness.emit("agent_settled", emergency.ctx);
assert.equal(emergency.getModel(), "gpt-original", "Stop settlement restores owned physical model metadata");
console.log("Computer-use safety gates passed: OFF/ON, handoff composition, Luna technical review, immediate security handoffs, Stop and visual policy.");
