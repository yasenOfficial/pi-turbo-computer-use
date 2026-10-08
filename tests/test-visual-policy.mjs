#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extensionHarness } from "./extension-harness.mjs";

const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const candidates = [process.env.PI_CODING_AGENT_PACKAGE,
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	...(existsSync(releases) ? readdirSync(releases).sort().reverse().map((r) => path.join(releases, r, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])];
const sdk = candidates.find((p) => p && existsSync(p));
if (!sdk) throw new Error("Pi SDK missing");
const requireSdk = createRequire(sdk);
const { createJiti } = await import(pathToFileURL(requireSdk.resolve("jiti")));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { typebox: requireSdk.resolve("typebox") } });
const { registerVisualPolicy } = await jiti.import(path.resolve(".pi/extensions/computer-use/visual-policy.ts"));
const tools = new Map();
const harness = extensionHarness(tools);
let waiting = false;
registerVisualPolicy(harness.pi, { isWaitingForUser: () => waiting });
const tool = tools.get("desktop_visual_permission");
assert.equal(tool.exposure, "model-only");
const context = (signal) => ({ signal, mode: "print", hasUI: false });
const gate = async (toolName, input = {}, signal, toolCallId) =>
	(await harness.emit("tool_call", context(signal), { toolName, input, toolCallId }))[0];
const message = async (calls) => harness.emit("message_end", context(), { message: { role: "assistant", content: calls.map(([id, name, args]) =>
	({ type: "toolCall", id, name, arguments: args })) } });
const grant = (overrides = {}, signal) => tool.execute("permit", {
	basis: "semantic_blocker", reason: "Live control inaccessible after search and inspection", checks: ["desktop_search_seen found stale id", "desktop_inspect found no live control"],
	capture: "desktop_screenshot", target: { x: 10, y: 20, width: 30, height: 40 }, ...overrides,
}, signal, undefined, context(signal));
const region = { x: 10, y: 20, width: 30, height: 40 };
assert.equal((await gate("desktop_screenshot", region)).block, true, "OFF mode does not bypass gate");
assert.equal(await gate("desktop_observe", {}), undefined, "semantic observation stays available");
assert.equal(await gate("desktop_observe", { screenshot: false }), undefined);
await assert.rejects(grant({ checks: [] }), /checks/);
await assert.rejects(grant({ reason: "  " }), /reason/);
await assert.rejects(grant({ capture: "desktop_observe", target: { id: "n1" } }), /target/);
await assert.rejects(grant({ capture: "desktop_screenshot", target: { full_screen: true } }), /Full-screen/);
const granted = await grant();
assert.match(granted.content[0].text, /semantic_blocker/);
assert.equal((await gate("desktop_screenshot", { ...region, x: 11 })).block, true, "wrong target consumes permit");
assert.equal((await gate("desktop_screenshot", region)).block, true);
await grant();
assert.equal(await gate("desktop_screenshot", region), undefined);
assert.equal((await gate("desktop_screenshot", region)).block, true, "one-shot");
// Pi emits message_end before running sibling tool calls. Neither execution order
// may grant and capture within the same assistant message, even with a prior permit.
for (const [captureName, input] of [
	["desktop_screenshot", region], ["desktop_inspect_visual", { id: "n1" }],
	["desktop_observe", { screenshot: true }],
]) {
	for (const order of ["grant-first", "capture-first"]) {
		await grant(); // Stale prior permission must be invalidated by the mixed message.
		const calls = [["g", "desktop_visual_permission", {}], ["c", captureName, input]];
		await message(order === "grant-first" ? calls : calls.toReversed());
		const [first, second] = order === "grant-first" ? calls : calls.toReversed();
		for (const [id, name, args] of [first, second]) {
			const result = await gate(name, args, undefined, id);
			assert.equal(result?.block, true, `${captureName} ${order}: ${name} blocked before execute`);
		}
		assert.equal((await gate("desktop_screenshot", region)).block, true, "mixed message clears old permit");
	}
}
await message([["semantic", "desktop_observe", {}]]);
await grant();
assert.equal(await gate("desktop_screenshot", region), undefined, "unrelated assistant messages do not lock later grants");
await grant();
assert.equal((await gate("desktop_inspect_visual", { id: "n1" })).block, true, "wrong tool consumes permit");
await grant({ basis: "explicit_user_request", reason: "User asked for a screenshot of the selected region", checks: [] });
await harness.emit("agent_settled");
assert.equal((await gate("desktop_screenshot", region)).block, true);
await grant();
await harness.emit("before_agent_start");
assert.equal((await gate("desktop_screenshot", region)).block, true, "next run expires permit");
await grant({ capture: "desktop_inspect_visual", target: { id: "n1" } });
assert.equal(await gate("desktop_inspect_visual", { id: "n1", incremental: true }), undefined);
await grant({ capture: "desktop_observe", target: { full_screen: true }, reason: "Missing layout requires full screen to locate the inaccessible dialog" });
assert.equal(await gate("desktop_observe", { screenshot: true }), undefined);
assert.equal((await gate("desktop_observe", { screenshot: true })).block, true);
await grant({ capture: "desktop_screenshot", target: { full_screen: true }, basis: "explicit_user_request", checks: [], reason: "User requested a full-screen screenshot of their desktop" });
assert.equal(await gate("desktop_screenshot", {}), undefined);
const abort = new AbortController();
await grant({}, abort.signal);
abort.abort();
assert.equal((await gate("desktop_screenshot", region)).block, true, "abort expires permit");
await grant();
assert.equal((await gate("desktop_screenshot", region, AbortSignal.abort())).block, true);
waiting = true;
await assert.rejects(grant(), /unavailable/);
assert.equal((await gate("desktop_screenshot", region)).block, true);
waiting = false;
await grant();
await harness.emit("session_start");
assert.equal((await gate("desktop_screenshot", region)).block, true);
await grant();
await harness.emit("session_tree");
assert.equal((await gate("desktop_screenshot", region)).block, true);
await grant();
await harness.emit("session_shutdown");
assert.equal((await gate("desktop_screenshot", region)).block, true);
await grant();
await gate("desktop_stop");
assert.equal((await gate("desktop_screenshot", region)).block, true, "Stop invalidates permit");
await assert.rejects(grant(), /unavailable/);
await harness.emit("session_start");
await assert.rejects(grant(), /unavailable/, "Stop stays sticky across sessions");
console.log("Visual policy passed: exact one-shot capture gate, semantic bypass-free observation, abort, Stop, waiting, and lifecycle expiry.");
