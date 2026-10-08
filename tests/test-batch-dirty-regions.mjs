#!/usr/bin/env node
// Opt-in X11 integration check for batch actions and screenshot-free dirty-region diffs.
import assert from "node:assert/strict";
import { extensionHarness } from "./extension-harness.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "..");
const socket = process.env.COMPUTER_USE_SOCKET;
if (!socket) throw new Error("COMPUTER_USE_SOCKET must point to this test's isolated daemon socket");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findPiPackage() {
	const explicit = process.env.PI_CODING_AGENT_PACKAGE;
	const currentRelease = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	const candidates = [explicit, currentRelease && path.join(currentRelease, "node_modules/@earendil-works/pi-coding-agent/package.json")].filter(Boolean);
	const releases = path.join(homedir(), ".local/share/pi-codex-ultra/releases");
	if (existsSync(releases)) {
		for (const release of readdirSync(releases).sort().reverse())
			candidates.push(path.join(releases, release, "node_modules/@earendil-works/pi-coding-agent/package.json"));
	}
	const packageJson = candidates.find(existsSync);
	if (!packageJson) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE to its package.json path");
	return packageJson;
}

const sdkRequire = createRequire(findPiPackage());
const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")));
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { typebox: sdkRequire.resolve("typebox"), "@earendil-works/pi-tui": sdkRequire.resolve("@earendil-works/pi-tui") },
});
const extensionPath = path.join(root, ".pi/extensions/computer-use/index.ts");
const extension = await jiti.import(extensionPath, { default: true });
const tools = new Map();
const modelTextChars = new Map();
const harness = extensionHarness(tools);
extension(harness.pi);
for (const name of ["desktop_ping", "desktop_wait", "desktop_batch", "desktop_dirty_regions", "desktop_search_seen"])
	assert.ok(tools.has(name), `${name} was not registered`);

async function execute(name, args = {}) {
	const result = await tools.get(name).execute(`batch-dirty-regions-${name}`, args);
	modelTextChars.set(name, result.content.filter((part) => part.type === "text").reduce((sum, part) => sum + part.text.length, 0));
	assert.equal(result.content.some((part) => part.type === "image"), false, `${name} unexpectedly emitted an image`);
	const response = result.details.response;
	assert.equal(Object.hasOwn(response, "png_base64"), false, `${name} unexpectedly returned a screenshot`);
	return response;
}

function screenDiff(response) {
	assert.ok(response.screen_diff && typeof response.screen_diff === "object", "response must contain screen_diff");
	assert.ok(Array.isArray(response.screen_diff.regions), "screen_diff must contain dirty regions");
	return response.screen_diff;
}

async function main() {
	let dialog;
	let dialogOutput = "";
	const title = `Pi batch dirty-region test ${process.pid}`;
	const marker = `pi-batch-${process.pid}-${Date.now()}`;
	try {
		await harness.emit("before_agent_start");
		const ping = await execute("desktop_ping");
		assert.equal(ping.ok, true, "isolated daemon is not responding");

		// Only act after the uniquely named test dialog is visible. The final
		// click is likewise resolved by its accessible button name, never screen coordinates.
		dialog = spawn("zenity", ["--entry", `--title=${title}`, "--text=Temporary local integration test"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		dialog.stdout.setEncoding("utf8");
		dialog.stdout.on("data", (chunk) => { dialogOutput += chunk; });
		const wait = await execute("desktop_wait", {
			condition: { name: title, role: "dialog" },
			timeout_ms: 12000,
		});
		assert.equal(wait.matched, true, "temporary Zenity dialog was not discovered; no input was sent");
		const seenBefore = await execute("desktop_search_seen", { query: "OK", limit: 50 });
		assert.equal(seenBefore.ok, true);
		const okButton = seenBefore.seen.results.find(hit => hit.window === title && hit.name === "OK");
		assert.ok(okButton && okButton.source === "current", "test-owned GTK button was not indexed as current");
		const owned = await execute("desktop_search_seen", { query: title, limit: 50 });
		const entries = owned.seen.results.filter(hit => hit.window === title && hit.role === "text" && hit.source === "current");
		assert.equal(entries.length, 1, "test-owned dialog must have exactly one text field; no input sent");
		// History is a hint only: inspect revalidates IDs in the fresh live tree.
		const entry = await execute("desktop_inspect", { id: entries[0].id });
		assert.equal(entry.node.role, "text");
		const validatedOK = await execute("desktop_inspect", { id: okButton.id });
		assert.equal(validatedOK.node.name, "OK");
		const rejected = await execute("desktop_batch", { actions: [
			{ type: "wait", condition: { name: title, role: "dialog" }, timeout_ms: 500 },
			{ type: "click", target: { role: "push button", name: "intentionally absent test button" } },
			{ type: "keypress", key: "Return" },
		] });
		assert.equal(rejected.ok, false, "invalid selector should fail the batch");
		assert.equal(rejected.steps.length, 2, "batch should stop before the third input action");
		assert.equal(dialog.exitCode, null, "failed batch accidentally closed test dialog");
		// Keep the temporary dialog near the top-left so its changes stay bounded
		// without moving an unrelated user window.
		const moved = spawnSync("wmctrl", ["-r", title, "-e", "0,80,80,-1,-1"], { encoding: "utf8" });
		if (moved.error) console.error(`wmctrl unavailable; continuing without repositioning: ${moved.error.message}`);
		else assert.equal(moved.status, 0, `could not move test dialog: ${moved.stderr}`);

		// Let GTK finish initial painting before establishing a stable baseline.
		await pause(120);
		const baselineStarted = performance.now();
		const baseline = await execute("desktop_dirty_regions");
		const baselineMs = performance.now() - baselineStarted;
		assert.equal(baseline.ok, true);
		const baseDiff = screenDiff(baseline);
		assert.equal(baseDiff.baseline, true, "first dirty-region capture should establish a baseline");
		assert.equal(baseDiff.capture_mode, "full_root", "root XDamage alone cannot certify selective capture on Cinnamon");
		assert.equal(baseDiff.regions.length, 1, "baseline should report one full-screen region");
		assert.deepEqual(baseDiff.regions[0], { x: 0, y: 0, width: baseDiff.screen_width, height: baseDiff.screen_height });
		// No unchanged assertion: live desktops can animate carets, clocks, or wallpaper.

		const batchStarted = performance.now();
		const batch = await execute("desktop_batch", {
			actions: [
				{ type: "wait", condition: { name: title, role: "dialog" }, timeout_ms: 1000 },
				{ type: "focus_window", title },
				{ type: "set_text", id: entry.node.id, text: marker },
				{ type: "click", id: validatedOK.node.id },
			],
			stop_on_error: true,
			include_changes: true,
		});
		const batchMs = performance.now() - batchStarted;
		const successBatchChars = modelTextChars.get("desktop_batch");
		assert.equal(batch.ok, true, `batch failed: ${JSON.stringify(batch)}`);
		assert.ok(Array.isArray(batch.steps), "batch response omitted step results");
		assert.equal(batch.steps.length, 4, "batch did not complete all requested actions");
		for (const [index, step] of batch.steps.entries())
			assert.equal(step.ok, true, `batch step ${index} (${step.type ?? "unknown"}) failed: ${JSON.stringify(step)}`);
		assert.ok(batch.changes || batch.delta, "batch response omitted its final semantic change");

		const exitCode = dialog.exitCode ?? await Promise.race([
			new Promise((resolve) => dialog.once("exit", (code) => resolve(code))),
			pause(5000).then(() => "timeout"),
		]);
		assert.equal(exitCode, 0, `temporary Zenity dialog did not close successfully (exit ${exitCode})`);
		assert.equal(dialogOutput.trim(), marker, "marker did not reach Zenity's output");
		const seenAfter = await execute("desktop_search_seen", { query: "OK", limit: 50 });
		assert.equal(seenAfter.ok, true);
		assert.ok(seenAfter.seen.results.some(hit => hit.id === okButton.id && hit.source === "stale"),
			"closed GTK button should remain a stale, non-actionable search hint");
		const privateQuery = await execute("desktop_search_seen", { query: marker, limit: 50 });
		assert.deepEqual(privateQuery.seen.results, [], "editable text must not be indexed");

		// GTK rendering and screen capture can lag the semantic action briefly.
		let mutated;
		let changeMs = 0;
		for (let attempt = 0; attempt < 8; attempt++) {
			const captureStarted = performance.now();
			mutated = await execute("desktop_dirty_regions");
			changeMs = performance.now() - captureStarted;
			if (screenDiff(mutated).regions.length > 0) break;
			await pause(40);
		}
		assert.ok(mutated && screenDiff(mutated).regions.length > 0, "dialog mutation produced no changed tile regions after bounded paint retries");
		// The isolated daemon must cancel a long batch wait promptly when its
		// emergency stop is requested; the following keypress must never execute.
		const cancelStarted = performance.now();
		const pending = execute("desktop_batch", { actions: [
			{ type: "wait", condition: { name: "deliberately absent window", role: "dialog" }, timeout_ms: 5000 },
			{ type: "keypress", key: "Return" },
		] });
		await pause(100);
		await execute("desktop_stop");
		const cancelled = await Promise.race([pending, pause(1500).then(() => "timeout")]);
		assert.notEqual(cancelled, "timeout", "emergency stop did not cancel batch wait");
		assert.equal(cancelled.ok, false);
		assert.equal(cancelled.steps.length, 1, "post-stop input must not execute");
		const cancelMs = performance.now() - cancelStarted;
		const finalDiff = screenDiff(mutated);
		assert.equal(finalDiff.capture_mode, "full_root", "report true capture mode rather than claiming partial reads");
		console.log(JSON.stringify({ passed: true, batch_steps: batch.steps.length,
			batch_ms: Math.round(batchMs), dirty_region_baseline_ms: Math.round(baselineMs),
			dirty_region_check_ms: Math.round(changeMs), regions: finalDiff.regions,
			screen: `${finalDiff.screen_width}x${finalDiff.screen_height}`, model_images: 0,
			cancelled_wait_ms: Math.round(cancelMs),
			search_seen_current: okButton.source, search_seen_after: "stale", private_search_hits: privateQuery.seen.results.length,
			batch_model_chars: successBatchChars, cancelled_batch_model_chars: modelTextChars.get("desktop_batch"),
			dirty_region_model_chars: modelTextChars.get("desktop_dirty_regions") }));
	} finally {
		// If an assertion fails, dismiss only the spawned test window, never send
		// a generic click/key to whatever happens to be active on the user's desktop.
		if (dialog && dialog.exitCode === null) dialog.kill("SIGTERM");
		await harness.emit("agent_settled");
		await harness.emit("session_shutdown");
	}
}

await main();
