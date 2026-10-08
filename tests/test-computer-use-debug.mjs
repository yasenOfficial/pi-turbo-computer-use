#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, lstatSync, mkdtempSync, symlinkSync, statSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const sdk = [process.env.PI_CODING_AGENT_PACKAGE, ...readdirSync(releases).sort().reverse().map(r => path.join(releases, r, "node_modules/@earendil-works/pi-coding-agent/package.json"))].find(p => p && existsSync(p));
const require = createRequire(sdk);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { ComputerUseDebug } = await jiti.import(path.resolve(import.meta.dirname, "../.pi/extensions/computer-use/debug.ts"));
const root = mkdtempSync(path.join(os.tmpdir(), "pi-computer-debug-test-"));
const directory = path.join(root, "private", "reports");
const entries = [], handlers = new Map(), notices = [];
let now = 100, mode = false, hybrid = false, idle = true, branch = entries, sessionId = "test-session";
const pi = { on: (name, fn) => handlers.set(name, [...handlers.get(name) ?? [], fn]), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), getActiveTools: () => ["desktop_observe", "read"], getAllTools: () => ["desktop_batch", "desktop_launch_app", "desktop_model_phase", "desktop_request_user", "read"].map(name => ({ name })) };
let signal;
const ctx = { hasUI: true, ui: { notify: (...x) => notices.push(x) }, isIdle: () => idle, get signal() { return signal; },
	getSystemPrompt: () => "PRIVATE_SYSTEM_SENTINEL", getContextUsage: () => ({ tokens: 25, contextWindow: 4000, percent: 0.625 }), model: { provider: "fixture", id: "fixture-sol", api: "fixture" }, thinkingLevel: "medium",
	sessionManager: { getBranch: () => branch, getSessionId: () => sessionId } };
const debug = new ComputerUseDebug(pi, { isEnabled: () => mode }, { isHybrid: () => hybrid }, { now: () => now, wallNow: () => Date.UTC(2026, 0, 2), directory });
const emit = async (name, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
const run = async () => emit("before_agent_start", { prompt: "PRIVATE_PROMPT_SENTINEL", systemPromptOptions: { sections: {} } });
debug.start(ctx, "startup");
await run(); await emit("agent_settled");
assert.equal(existsSync(directory), false, "factory and OFF runs do not access files");
assert.match(await debug.command("on neutral-A", ctx), /Debug ON/);
assert.equal(existsSync(directory), false, "opt-in alone does not touch disk");
await run(); await emit("agent_settled");
await emit("session_before_compact", { reason: "manual", willRetry: false, customInstructions: "PRIVATE_COMPACTION_SENTINEL" });
await emit("session_compact_failed", { reason: "manual", willRetry: false, aborted: false, errorMessage: "PRIVATE_ERROR_SENTINEL" });
assert.equal(existsSync(directory), false, "computer use OFF never logs questions or idle compactions");
for (const label of ["on space label", "on a/b", `on ${"x".repeat(65)}`, "on bad💻"])
	await assert.rejects(() => debug.command(label, ctx));
entries.push({ type: "message", message: { role: "assistant", content: "PRIVATE_HISTORY_SENTINEL" } });
mode = true; hybrid = true;
const abort = new AbortController(); signal = abort.signal;
await run(); now += 3;
await emit("turn_start", { turnIndex: 0 }); now += 4;
await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "PRIVATE_DELTA_SENTINEL" } });
await emit("model_select", { model: { provider: "fixture", id: "fixture-luna", api: "fixture" }, source: "set" });
await emit("message_end", { message: { role: "assistant", provider: "fixture", model: "fixture-sol", api: "fixture", thinkingLevel: "high", stopReason: "toolUse", errorMessage: "PRIVATE_ERROR_SENTINEL", diagnostics: [{ detail: "PRIVATE_DIAG_SENTINEL" }], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0 } } } });
now += 2;
await emit("tool_execution_start", { toolCallId: "PRIVATE_ID_SENTINEL", toolName: "desktop_batch", args: { actions: [{ type: "click", value: "PRIVATE_ARGUMENT_SENTINEL" }, { type: "type", text: "PRIVATE_ARGUMENT_SENTINEL" }] } });
await emit("tool_execution_start", { toolCallId: "another", toolName: "read", args: { file: "PRIVATE_ARGUMENT_SENTINEL" } });
await emit("tool_execution_start", { toolCallId: "unknown", toolName: "PRIVATE_TOOL_SENTINEL" });
await emit("tool_execution_end", { toolCallId: "unknown", toolName: "PRIVATE_TOOL_SENTINEL", isError: true });
now += 5;
await emit("tool_execution_end", { toolCallId: "another", toolName: "read", isError: false, result: { content: [{ type: "image", data: "PRIVATE_IMAGE_SENTINEL" }] } });
now += 5;
await emit("tool_execution_end", { toolCallId: "PRIVATE_ID_SENTINEL", toolName: "desktop_batch", isError: false, result: { structuredContent: { steps: [{ ok: true }, { ok: false, error: "PRIVATE_RESULT_SENTINEL" }] }, content: [{ type: "text", text: "PRIVATE_RESULT_SENTINEL" }] } });
await emit("agent_before_settle", { outcome: "completed" }); now += 10;
await emit("agent_settled"); await emit("agent_settled");
const files = readdirSync(directory); assert.equal(files.length, 1);
assert.equal(statSync(directory).mode & 0o777, 0o700);
assert.equal(statSync(path.join(directory, files[0])).mode & 0o777, 0o600);
const text = readFileSync(path.join(directory, files[0]), "utf8");
assert.doesNotMatch(text, /PRIVATE_/);
const report = JSON.parse(text);
assert.equal(report.schemaVersion, 1); assert.equal(report.label, "neutral-A"); assert.equal(report.routing, "hybrid");
assert.equal(report.startedAt, "2026-01-02T00:00:00.000Z"); assert.equal(report.userRated, false);
assert.equal(report.timeline[0].initialContextTokensEstimate, 25);
assert.equal(report.timeline[0].contextWindow, 4000);
assert.equal(report.timeline[0].assistantMessagesBeforeRun, 1);
assert.equal(report.outcome, "completed"); assert.equal(report.taskSuccess, null); assert.equal(report.elapsedMs, 29);
assert.equal(report.modelCalls[0].modelTurnMs, 4); assert.equal(report.modelCalls[0].firstContentMs, 4);
assert.equal(report.modelCalls[0].thinkingLevel, "high"); assert.equal(report.modelCalls[0].selectedThinkingLevel, "medium");
assert.equal(report.usage.totalTokens, 18); assert.equal(report.observedAssistantMessages, 1);
assert.equal(report.totalTaskTokens, null); assert.equal(report.retryCount, null);
assert.deepEqual(report.compactionUsage, {});
assert.equal(report.catalogCostEstimate, 0); assert.equal(report.billingCost, null);
assert.equal(report.tools[0].elapsedMs, 10); assert.equal(report.tools[1].elapsedMs, 5);
assert.equal(report.tools[0].batchErrors, 1); assert.equal(report.tools[0].action_click, 1);
assert.equal(report.tools[1].images, 1); assert.equal(report.tools[1].imageEncodedChars, "PRIVATE_IMAGE_SENTINEL".length);
assert.equal(report.tools[2].name, "other");
assert.match(await debug.command("report", ctx), /neutral-A.*completed/);
assert.match(await debug.command("result pass", ctx), /user-rated pass/);
assert.equal(JSON.parse(readFileSync(path.join(directory, files[0]), "utf8")).taskSuccess, true);
assert.equal(JSON.parse(readFileSync(path.join(directory, files[0]), "utf8")).userRated, true);
assert.equal(statSync(path.join(directory, files[0])).mode & 0o777, 0o600);
assert.match(await debug.command("report", ctx), /User-rated task pass/);
assert.match(await debug.command("result fail", ctx), /user-rated fail/);
assert.equal(JSON.parse(readFileSync(path.join(directory, files[0]), "utf8")).taskSuccess, false);
debug.start(ctx, "reload"); assert.match(await debug.command("report", ctx), /User-rated task fail/);
await debug.command("on nested-images", ctx);
await run();
await emit("tool_execution_start", { toolCallId: "parent-tool", toolName: "read" });
await emit("tool_execution_start", { toolCallId: "parent-tool/1", parentToolCallId: "parent-tool", toolName: "read" });
await emit("tool_execution_end", { toolCallId: "parent-tool/1", parentToolCallId: "parent-tool", toolName: "read",
	isError: false, result: { content: [{ type: "image", data: "PRIVATE_NESTED_IMAGE_SENTINEL" }] } });
await emit("tool_execution_end", { toolCallId: "parent-tool", toolName: "read",
	isError: false, result: { content: [{ type: "image", data: "PRIVATE_NESTED_IMAGE_SENTINEL" }] } });
await emit("agent_settled");
const nestedText = readdirSync(directory).map(file => readFileSync(path.join(directory, file), "utf8"))
	.find(body => JSON.parse(body).label === "nested-images");
assert.doesNotMatch(nestedText, /PRIVATE_/);
const nestedReport = JSON.parse(nestedText);
assert.equal(nestedReport.tools.length, 2);
assert.deepEqual(nestedReport.tools.map(row => row.images), [1, 1]);
assert.deepEqual(nestedReport.tools.map(row => row.nested), [false, true]);
assert.equal(nestedReport.imageOccurrences, 2, "all span occurrences may include the same returned image twice");
assert.equal(nestedReport.transcriptResultImages, 1, "nested result is absent from root transcript tool results");
assert.match(await debug.command("report", ctx), /result images 1/);
await debug.command("on launch-metadata", ctx);
await run();
const launchCases = ["lookup", "not_found", "ambiguous", "accepted", "dispatch_failed", "stopped", "invalid"];
for (const [index, status] of launchCases.entries()) {
	const toolCallId = `fixture-launch-${index}`;
	await emit("tool_execution_start", { toolCallId, toolName: "desktop_launch_app",
		args: index === 0 ? { query: "PRIVATE_QUERY_SENTINEL" } : { name: "PRIVATE_APP_NAME_SENTINEL", app_id: "PRIVATE_APPID_SENTINEL.desktop" } });
	now += 1;
	await emit("tool_execution_end", { toolCallId, toolName: "desktop_launch_app", isError: status !== "accepted" && status !== "lookup",
		result: { content: [{ type: "text", text: "PRIVATE_RESULT_SENTINEL" }], details: { response: {
			launch_status: status, launch_attempted: status === "accepted", app_matches_total: index === 0 ? 0 : index,
			app_matches_truncated: index > 0, app_matches: [{ app_id: "PRIVATE_CANDIDATE_SENTINEL", name: "PRIVATE_NAME_SENTINEL" }],
			error: "PRIVATE_ERROR_SENTINEL" } } } });
}
await emit("tool_execution_start", { toolCallId: "fixture-unknown-launch", toolName: "desktop_launch_app",
	args: { app_id: "PRIVATE_APPID_SENTINEL.desktop" } });
await emit("tool_execution_end", { toolCallId: "fixture-unknown-launch", toolName: "desktop_launch_app", isError: false,
	result: { details: { response: { launch_status: "PRIVATE_UNKNOWN_STATUS_SENTINEL", launch_attempted: "true",
		app_matches_total: -1, app_matches_truncated: "true", app_matches: ["PRIVATE_CANDIDATE_SENTINEL"] } }, content: [] } });
for (const [index, total] of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN].entries()) {
	const toolCallId = `fixture-invalid-count-${index}`;
	await emit("tool_execution_start", { toolCallId, toolName: "desktop_launch_app", args: { query: "PRIVATE_QUERY_SENTINEL" } });
	await emit("tool_execution_end", { toolCallId, toolName: "desktop_launch_app", isError: false,
		result: { details: { response: { app_matches_total: total } }, content: [] } });
}
for (const [index, phase] of ["execute", "escalate", "PRIVATE_PHASE_SENTINEL"].entries()) {
	const toolCallId = `fixture-phase-${index}`;
	await emit("tool_execution_start", { toolCallId, toolName: "desktop_model_phase",
		args: { phase, plan: "PRIVATE_PLAN_SENTINEL", reason: "PRIVATE_REASON_SENTINEL", verified_state: "PRIVATE_STATE_SENTINEL" } });
	await emit("tool_execution_end", { toolCallId, toolName: "desktop_model_phase", isError: index === 1,
		result: { details: { phase }, content: [{ type: "text", text: "PRIVATE_PHASE_RESULT_SENTINEL" }] } });
}
for (const [index, reason] of ["mfa", "PRIVATE_HANDOFF_REASON_SENTINEL"].entries()) {
	const toolCallId = `fixture-request-${index}`;
	await emit("tool_execution_start", { toolCallId, toolName: "desktop_request_user",
		args: { reason, instructions: "PRIVATE_INSTRUCTIONS_SENTINEL" } });
	await emit("tool_execution_end", { toolCallId, toolName: "desktop_request_user", isError: index === 1,
		result: { details: { reason }, content: [{ type: "text", text: "PRIVATE_HANDOFF_RESULT_SENTINEL" }] } });
}
await emit("agent_settled");
const launchText = readdirSync(directory).map(file => readFileSync(path.join(directory, file), "utf8"))
	.find(body => JSON.parse(body).label === "launch-metadata");
assert.ok(launchText); assert.doesNotMatch(launchText, /PRIVATE_/);
const launchRows = JSON.parse(launchText).tools;
assert.deepEqual(launchRows.slice(0, 7).map(row => row.launchStatus), launchCases);
assert.deepEqual(launchRows.slice(0, 7).map(row => row.launchMode), ["lookup", ...Array(6).fill("dispatch")]);
assert.equal(launchRows[0].appMatchesTotal, 0);
assert.equal(launchRows[0].appMatchesTruncated, false);
assert.equal(launchRows[0].launchAttempted, false);
assert.equal(launchRows[3].launchAttempted, true);
assert.equal(launchRows[7].launchMode, "dispatch");
for (const row of launchRows.slice(7, 11)) {
	assert.equal(row.launchStatus, undefined, "unknown status is never copied into the report");
	assert.equal(row.launchAttempted, undefined, "invalid type cannot imply dispatch");
	assert.equal(row.appMatchesTotal, undefined, "negative, fractional, unsafe and missing counts are omitted");
	assert.equal(row.appMatchesTruncated, undefined);
}
assert.deepEqual(launchRows.slice(11, 14).map(row => row.handoffPhase), ["execute", "escalate", undefined]);
assert.deepEqual(launchRows.slice(11, 14).map(row => row.error), [false, true, false]);
assert.deepEqual(launchRows.slice(14, 16).map(row => row.requestReason), ["mfa", undefined]);
await debug.command("on unended-turn", ctx);
await run(); await emit("turn_start", { turnIndex: 99 }); now += 2;
await emit("agent_settled");
const unended = readdirSync(directory).map(file => JSON.parse(readFileSync(path.join(directory, file), "utf8")))
	.find(item => item.label === "unended-turn");
assert.equal(unended.outcome, "completed", "host settlement alone does not prove turn coverage");
assert.equal(unended.complete, false, "a turn_start with no assistant message_end is incomplete");
assert.equal(unended.observedAssistantMessages, 0);
await debug.command("on duplicate-tool-id", ctx);
await run();
await emit("tool_execution_start", { toolCallId: "duplicate-id", toolName: "read" }); now += 3;
await emit("tool_execution_start", { toolCallId: "duplicate-id", toolName: "read" }); now += 4;
await emit("tool_execution_end", { toolCallId: "duplicate-id", toolName: "read", isError: false,
	result: { content: [{ type: "text", text: "fixture" }] } });
await emit("agent_settled");
const duplicate = readdirSync(directory).map(file => JSON.parse(readFileSync(path.join(directory, file), "utf8")))
	.find(item => item.label === "duplicate-tool-id");
assert.equal(duplicate.tools.length, 2);
assert.equal(duplicate.tools[0].elapsedMs, undefined, "the overwritten first span never received an end event");
assert.equal(duplicate.tools[0].error, undefined);
assert.equal(duplicate.tools[1].elapsedMs, 4);
assert.equal(duplicate.tools[1].error, false);
assert.equal(duplicate.complete, false, "an empty span map cannot hide an overwritten unfinished row");
await debug.command("on compaction-fixture", ctx);
await run();
await emit("turn_start", { turnIndex: 1 }); now += 3;
await emit("message_end", { message: { role: "assistant", api: "fixture", provider: "fixture", model: "fixture-sol",
	stopReason: "error", errorMessage: "PRIVATE_FAILED_PROVIDER_SENTINEL" } });
await emit("session_before_compact", { reason: "overflow", willRetry: true, customInstructions: "PRIVATE_COMPACTION_SENTINEL" });
now += 7;
await emit("session_compact", { reason: "overflow", willRetry: true, fromExtension: false,
	compactionEntry: { summary: "PRIVATE_COMPACTION_SENTINEL", details: { token: "PRIVATE_DETAILS_SENTINEL" }, usage: {
		input: 7, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 12, cost: { total: 0.003 } } } });
await emit("session_before_compact", { reason: "threshold", willRetry: false, customInstructions: "PRIVATE_COMPACTION_SENTINEL" });
now += 2;
await emit("session_compact_failed", { reason: "threshold", willRetry: false, aborted: false,
	fromExtension: true, errorMessage: "PRIVATE_COMPACTION_ERROR_SENTINEL" });
await emit("agent_before_settle", { outcome: "completed" }); await emit("agent_settled");
const compactReport = readdirSync(directory).map(file => readFileSync(path.join(directory, file), "utf8"))
	.find(body => JSON.parse(body).label === "compaction-fixture");
assert.ok(compactReport); assert.doesNotMatch(compactReport, /PRIVATE_/);
const compactData = JSON.parse(compactReport);
assert.equal(compactData.compactionStarts, 2); assert.equal(compactData.compactionSuccesses, 1);
assert.equal(compactData.compactionFailures, 1); assert.equal(compactData.overflowRetryOffered, 1);
assert.equal(compactData.timeline.find(row => row.type === "compaction_end").elapsedMs, 7);
assert.equal(compactData.timeline.find(row => row.type === "compaction_failed").elapsedMs, 2);
assert.equal(compactData.compactionUsage.totalTokens, 12); assert.equal(compactData.compactionUsageSamples.totalTokens, 1);
assert.equal(compactData.compactionCatalogCostEstimate, 0.003);
assert.equal(compactData.usage.totalTokens, undefined, "failed assistant usage is unknown, not estimated");
assert.equal(compactData.uncertainUsageMessages, 1);
assert.equal(compactData.totalTaskTokens, null);
assert.match(await debug.command("report", ctx), /observed assistant tokens unknown/);
await debug.command("on missing-usage", ctx);
await run();
await emit("turn_start", { turnIndex: 2 });
await emit("message_end", { message: { role: "assistant", api: "fixture", provider: "fixture", model: "fixture-luna",
	stopReason: "error", usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } } });
await emit("tool_execution_start", { toolCallId: "missing-output", toolName: "read" });
await emit("tool_execution_end", { toolCallId: "missing-output", toolName: "read", isError: false });
await emit("agent_settled");
const missing = readdirSync(directory).map(file => JSON.parse(readFileSync(path.join(directory, file), "utf8")))
	.find(item => item.label === "missing-usage");
assert.equal(missing.uncertainUsageMessages, 1);
assert.equal(missing.usage.totalTokens, 0, "reported zero is preserved, but cannot be treated as free quota");
assert.equal(missing.totalTaskTokens, null);
assert.equal(missing.imageOccurrences, null);
assert.equal(missing.transcriptResultImages, null);
assert.match(await debug.command("report", ctx), /observed assistant tokens unknown, result images unknown/);
await debug.command("on neutral-A", ctx);
await run(); now += 3; await run(); now += 3; await emit("agent_settled");
const reports = readdirSync(directory).map(f => JSON.parse(readFileSync(path.join(directory, f), "utf8")));
assert.ok(reports.some(r => r.outcome === "continued" && !r.complete));
idle = false; await assert.rejects(() => debug.command("off", ctx), /settle/);
await assert.rejects(() => debug.command("result pass", ctx), /settle/); idle = true;
await run(); now += 10; abort.abort(); now += 20; await emit("agent_before_settle", { outcome: "completed" });
await emit("agent_settled");
const aborted = readdirSync(directory).map(f => JSON.parse(readFileSync(path.join(directory, f), "utf8"))).find(r => r.outcome === "aborted");
assert.equal(aborted.elapsedMs, 10); assert.equal(aborted.complete, false); assert.equal(notices.length, 0);
signal = undefined; await debug.command("off", ctx);
const count = readdirSync(directory).length; await run(); await emit("agent_settled"); assert.equal(readdirSync(directory).length, count);
// New startup/reset must not restore ON, even with a saved branch entry; reload may only restore identical session.
await debug.command("on same-branch", ctx); debug.start(ctx, "startup"); assert.equal(entries.at(-1).data.enabled, false);
debug.start(ctx, "reload"); await run(); await emit("agent_settled"); assert.equal(readdirSync(directory).length, count);
await debug.command("on same-branch", ctx); debug.start(ctx, "reload"); await run(); await emit("agent_settled"); assert.equal(readdirSync(directory).length, count + 1);
debug.start(ctx, "reload"); assert.match(await debug.command("report", ctx), /same-branch.*completed/);
sessionId = "another-session"; debug.start(ctx, "reload");
assert.match(await debug.command("report", ctx), /No debug report/);
await run(); await emit("agent_settled"); assert.equal(readdirSync(directory).length, count + 1);
// A symlink at the destination (or a non-private directory) must not receive data.
const target = path.join(root, "target"); symlinkSync(directory, target);
const unsafe = new ComputerUseDebug(pi, { isEnabled: () => true }, { isHybrid: () => false }, { now: () => now, directory: target });
await unsafe.command("on", ctx); await run(); await emit("agent_settled");
assert.ok(lstatSync(target).isSymbolicLink()); assert.equal(readdirSync(directory).length, count + 1);
// A successful request-user handoff is a wait, not proof of task success.
await debug.command("on final", ctx);
await run(); await emit("tool_execution_start", { toolCallId: "wait", toolName: "desktop_request_user" });
await emit("tool_execution_end", { toolCallId: "wait", toolName: "desktop_request_user", isError: false });
await emit("agent_before_settle", { outcome: "completed" }); await emit("agent_settled");
const waiting = readdirSync(directory).map(f => JSON.parse(readFileSync(path.join(directory, f), "utf8"))).find(r => r.outcome === "action_required");
assert.equal(waiting.taskSuccess, null);
await run(); await emit("session_shutdown"); await emit("agent_settled");
assert.ok(readdirSync(directory).map(f => JSON.parse(readFileSync(path.join(directory, f), "utf8"))).some(r => r.outcome === "interrupted" && !r.complete));
await run();
for (let i = 0; i < 2100; i++) await emit("model_select", { model: ctx.model, source: "set" });
await emit("agent_settled");
const capped = readdirSync(directory).map(f => ({ body: readFileSync(path.join(directory, f), "utf8"), size: statSync(path.join(directory, f)).size }))
	.find(f => JSON.parse(f.body).omittedEvents > 0);
assert.ok(capped); assert.ok(capped.size <= 1024 * 1024);
assert.ok(JSON.parse(capped.body).timeline.length <= 2000);
assert.equal(JSON.parse(capped.body).complete, false);
// A pre-existing symlink may never be followed by the rating path.
const lastPath = JSON.parse(capped.body).id;
const reportPath = path.join(directory, `${lastPath}.json`);
const backupPath = path.join(directory, "test-owned-backup.json");
renameSync(reportPath, backupPath); symlinkSync(backupPath, reportPath);
const before = readFileSync(backupPath, "utf8");
await assert.rejects(() => debug.command("result pass", ctx), /safely/);
assert.equal(readFileSync(backupPath, "utf8"), before);
rmSync(reportPath); renameSync(backupPath, reportPath);
chmodSync(directory, 0o755);
await assert.rejects(() => debug.command("result pass", ctx), /safely/);
chmodSync(directory, 0o700);
chmodSync(path.join(root, "private"), 0o777);
await assert.rejects(() => debug.command("result pass", ctx), /safely/);
chmodSync(path.join(root, "private"), 0o700);
// Force both bounded arrays over 1 MiB without timing the host: trimming must preserve
// observed aggregate usage, count every removed row, and leave room for a user rating.
await debug.command("on bulk-trim", ctx);
await run();
for (let i = 0; i < 2000; i++) await emit("message_end", { message: {
	role: "assistant", provider: "p".repeat(80), model: "m".repeat(80), api: "a".repeat(80),
	stopReason: "stop", thinkingLevel: "high", providerThinkingLevel: "high",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
await emit("agent_settled");
const bulkFile = readdirSync(directory).find(file =>
	JSON.parse(readFileSync(path.join(directory, file), "utf8")).label === "bulk-trim");
assert.ok(bulkFile);
const bulkPath = path.join(directory, bulkFile);
const bulk = JSON.parse(readFileSync(bulkPath, "utf8"));
assert.ok(statSync(bulkPath).size <= 1024 * 1024 - 64);
assert.ok(bulk.timeline.length < 2000 || bulk.modelCalls.length < 2000, "fixture must exercise size-based chunk trimming");
assert.equal(bulk.complete, false); assert.equal(bulk.usage.totalTokens, 4000);
assert.equal(bulk.usageSamples.totalTokens, 2000);
assert.equal(bulk.omittedEvents, 1 + (2000 - bulk.timeline.length) + (2000 - bulk.modelCalls.length));
assert.equal(bulk.imageOccurrences, null); assert.equal(bulk.transcriptResultImages, null);
assert.match(await debug.command("report", ctx), /observed assistant tokens unknown/);
await debug.command("result pass", ctx);
assert.equal(JSON.parse(readFileSync(bulkPath, "utf8")).taskSuccess, true);
assert.equal(statSync(bulkPath).mode & 0o777, 0o600);
assert.ok(statSync(bulkPath).size <= 1024 * 1024);
// Root-owned /home (unlike the root-owned sticky /tmp fixture) is a trusted ancestor.
if (lstatSync(path.dirname(os.homedir())).uid === 0) {
	const homeFixture = mkdtempSync(path.join(os.homedir(), "pi-computer-debug-test-"));
	try {
		const homeDirectory = path.join(homeFixture, "pi-computer", "debug");
		const homeHandlers = new Map();
		const homePi = { ...pi, on(name, fn) { homeHandlers.set(name, [...homeHandlers.get(name) ?? [], fn]); }, appendEntry() {} };
		const homeDebug = new ComputerUseDebug(homePi, { isEnabled: () => true }, { isHybrid: () => false }, { now: () => now, directory: homeDirectory });
		const homeCtx = { ...ctx, sessionManager: { getBranch: () => [], getSessionId: () => "home-fixture" } };
		homeDebug.start(homeCtx, "startup");
		await homeDebug.command("on", homeCtx);
		for (const fn of homeHandlers.get("before_agent_start") ?? []) await fn({ prompt: "PRIVATE_PROMPT_SENTINEL" }, homeCtx);
		for (const fn of homeHandlers.get("agent_settled") ?? []) await fn({}, homeCtx);
		assert.equal(readdirSync(homeDirectory).length, 1);
	} finally { rmSync(homeFixture, { recursive: true, force: true }); }
}
// Verify that Pi's real resource loader can load the standalone observer without I/O.
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(path.join(path.dirname(sdk), "dist/index.js")));
const entry = path.join(root, "debug-extension.ts");
writeFileSync(entry, `import { ComputerUseDebug } from ${JSON.stringify(path.resolve(import.meta.dirname, "../.pi/extensions/computer-use/debug.ts"))};\nexport default function(pi) { new ComputerUseDebug(pi, { isEnabled: () => false }, { isHybrid: () => false }); }\n`);
const agentDir = path.join(root, "isolated-agent");
const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: true });
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, additionalExtensionPaths: [entry], noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert.ok(loader.getExtensions().extensions.some(ext => ext.path === entry));
console.log("computer-use debug: ok");
