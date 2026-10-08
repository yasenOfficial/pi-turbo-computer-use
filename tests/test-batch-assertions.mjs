#!/usr/bin/env node
// Isolated TypeBox/tool contract: synthetic daemon replies, no desktop or socket.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extensionHarness } from "./extension-harness.mjs";

const releases = path.join(homedir(), ".local/share/pi-codex-ultra/releases");
const candidates = [process.env.PI_CODING_AGENT_PACKAGE,
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	...(existsSync(releases) ? readdirSync(releases).sort().reverse().map((release) =>
		path.join(releases, release, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])];
const sdk = candidates.find((candidate) => candidate && existsSync(candidate));
if (!sdk) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE");
const requireSdk = createRequire(sdk);
const { Check } = requireSdk("typebox/value");
const { createJiti } = await import(pathToFileURL(requireSdk.resolve("jiti")));
const jiti = createJiti(import.meta.url, { moduleCache: true,
	alias: { typebox: requireSdk.resolve("typebox"), "@earendil-works/pi-tui": requireSdk.resolve("@earendil-works/pi-tui") } });
const base = path.resolve(import.meta.dirname, "../.pi/extensions/computer-use");
const { registerComputerUseTools } = await jiti.import(path.join(base, "tools.ts"));
const { computerUseClient } = await jiti.import(path.join(base, "client.ts"));
const tools = new Map();
registerComputerUseTools(extensionHarness(tools).pi);
const batch = tools.get("desktop_batch");
assert.ok(batch, "desktop_batch registered");
const valid = (actions) => Check(batch.parameters, { actions });
const target = { id: "n4", role: "entry", name: "Search" };
assert.equal(valid([{ type: "assert", target, expected: { value: null, enabled: false } }]), true);
assert.equal(valid([{ type: "assert", target: { role: "entry" }, expected: { name: "Ready", focused: true, visible: false } }]), true);
for (const action of [
	{ type: "assert", target, expected: {} },
	{ type: "assert", target, expected: { name: "x".repeat(241) } },
	{ type: "assert", target, expected: { value: "x".repeat(16_385) } },
	{ type: "assert", target, expected: { focused: null } },
	{ type: "assert", target, expected: { enabled: false, unrecognized: true } },
	{ type: "assert", target, expected: { visible: true }, extra: "not allowed" },
]) assert.equal(valid([action]), false, `invalid assertion schema accepted: ${Object.keys(action.expected)}`);

const sent = [];
const responses = [];
const originalRequest = computerUseClient.request;
computerUseClient.request = async (request) => {
	sent.push(request);
	assert.equal(request.cmd, "batch");
	const reply = responses.shift();
	if (!reply) throw new Error("missing isolated response fixture");
	return reply;
};
const execute = async (actions) => batch.execute("assert-fixture", { actions, include_changes: false });
try {
	const actions = [
		{ type: "wait", condition: { id: "n4" }, timeout_ms: 100 },
		{ type: "assert", target, expected: { value: null, enabled: false } },
		{ type: "keypress", key: "Return" },
	];
	responses.push({ ok: false, error: "assertion mismatch", batch: { completed: false, elapsedMs: 5, steps: [
		{ index: 0, type: "wait", ok: true, matched: true, elapsedMs: 2 },
		{ index: 1, type: "assert", ok: false, matched: false, elapsedMs: 3, error: "assertion mismatch",
			assertion: { nodeId: "n4", role: "entry", matched: false,
				expected: { value: null, enabled: false }, actual: { value: "unexpected", enabled: false } } },
	] } });
	const failed = await execute(actions);
	assert.equal(failed.isError, true);
	assert.deepEqual(sent[0], { cmd: "batch", actions, include_changes: false }, "target and null/false survive native request translation");
	assert.deepEqual(failed.details.response.steps.map(({ index, type, matched }) => [index, type, matched]),
		[[0, "wait", true], [1, "assert", false]]);
	assert.equal(failed.details.response.completed, false);
	assert.equal(failed.details.response.steps[1].assertion.actual.value, "unexpected");
	assert.equal(failed.details.response.steps.length, 2, "fixture stops before the third input; no native execution is implied");
	assert.equal(failed.content.some((item) => item.type === "image"), false);

	// Force model-text fallback: retain ordered step outcomes and node ids while
	// omitting oversized readbacks. This fixture checks rendering, not AT-SPI.
	const giant = "X".repeat(16_384);
	responses.push({ ok: false, error: "assertion mismatch", batch: { completed: false, elapsedMs: 4,
		steps: [0, 1].map((index) => ({ index, type: "assert", ok: index === 0,
			matched: index === 0, elapsedMs: 2, ...(index ? { error: "assertion mismatch" } : {}),
			assertion: { nodeId: `n${index}`, role: "entry", matched: index === 0,
				expected: { value: giant }, actual: { value: giant } } })) } });
	const bounded = await execute([{ type: "assert", target: { id: "n0" }, expected: { value: giant } }]);
	assert.ok(bounded.content[0].text.length <= 20_000, "model text is bounded");
	assert.deepEqual(bounded.details.response.steps.map((step) => [step.assertion.nodeId, step.matched]),
		[["n0", true], ["n1", false]]);
	assert.equal(bounded.details.response.steps[1].assertion.readback_omitted, true);
	assert.equal(Object.hasOwn(bounded.details.response.steps[1].assertion, "actual"), false);
	assert.equal(responses.length, 0);
} finally {
	computerUseClient.request = originalRequest;
}
console.log("Batch assertion schema and synthetic tool response checks passed (no native desktop actions).");
