#!/usr/bin/env node
import assert from "node:assert/strict";
import { extensionHarness } from "./extension-harness.mjs";
import { createRequire } from "node:module";
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

const sdkRequire = createRequire(findPiPackage());
const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")));
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { typebox: sdkRequire.resolve("typebox"), "@earendil-works/pi-tui": sdkRequire.resolve("@earendil-works/pi-tui") },
});
const extensionPath = path.resolve(".pi/extensions/computer-use/index.ts");
const extension = await jiti.import(extensionPath, { default: true });
const tools = new Map();
const harness = extensionHarness(tools);
extension(harness.pi);
for (const name of ["desktop_ping", "desktop_observe", "desktop_changes"])
	assert.ok(tools.has(name), `${name} was not registered`);

async function execute(name, args = {}) {
	return tools.get(name).execute(`live-test-${name}`, args);
}

async function main() {
try {
	await harness.emit("before_agent_start");
	const ping = await execute("desktop_ping");
	assert.equal(ping.details.response.ok, true);

	let observed;
	try {
		observed = await execute("desktop_observe", {});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/AT-SPI unavailable|connect to AT-SPI bus|org\.a11y\.Bus/i.test(message)) {
			console.log(`SKIP: live accessibility integration unavailable (${message})`);
			return;
		}
		throw error;
	}

	const response = observed.details.response;
	assert.equal(response.ok, true);
	assert.ok(response.snapshot || response.delta, "observe returned neither a snapshot nor a delta");
	assert.equal(Object.hasOwn(response, "png_base64"), false, "default observe unexpectedly returned a screenshot");
	assert.equal(observed.content.some((part) => part.type === "image"), false, "default observe unexpectedly emitted an image");
	const generation = response.snapshot?.generation ?? response.delta?.generation;
	assert.equal(typeof generation, "number", "observe did not report a generation");

	const changes = await execute("desktop_changes", { since: generation });
	const changesResponse = changes.details.response;
	assert.equal(changesResponse.ok, true);
	assert.equal(Object.hasOwn(changesResponse, "png_base64"), false, "changes unexpectedly returned a screenshot");
	assert.equal(changes.content.some((part) => part.type === "image"), false, "changes unexpectedly emitted an image");
	const changedGeneration = changesResponse.delta?.generation ?? changesResponse.snapshot?.generation;
	assert.ok(Number.isInteger(changedGeneration) && changedGeneration >= generation,
		"changes returned a regressed or missing generation");

	const repeated = await execute("desktop_observe", { since: generation });
	const repeatedResponse = repeated.details.response;
	const repeatedGeneration = repeatedResponse.delta?.generation ?? repeatedResponse.snapshot?.generation;
	assert.ok(Number.isInteger(repeatedGeneration) && repeatedGeneration >= changedGeneration,
		"repeated observation returned a regressed or missing generation");
	assert.equal(Object.hasOwn(repeatedResponse, "png_base64"), false, "default observe unexpectedly returned a screenshot");
	assert.equal(repeated.content.some((part) => part.type === "image"), false, "default observe unexpectedly emitted an image");
	console.log(`Live X11 integration passed: ping, observe, changes; generations ${generation}→${changedGeneration}→${repeatedGeneration}; no screenshots or desktop input.`);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await harness.emit("agent_settled");
	await harness.emit("session_shutdown");
}
}

await main();
