#!/usr/bin/env node
// Isolated declaration fixtures: no desktop/daemon, model, or real profile.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const candidates = [process.env.PI_CODING_AGENT_PACKAGE,
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	...(existsSync(releases) ? readdirSync(releases).sort().reverse().map(r => path.join(releases, r, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])];
const sdk = candidates.find(p => p && existsSync(p));
if (!sdk) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE");
const require = createRequire(sdk);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { DesktopLoadout } = await jiti.import(path.join(root, ".pi/extensions/computer-use/loadout.ts"));
const { COMPUTER_USE_INSTRUCTIONS, SAVED_LOGIN_POLICY } = await jiti.import(path.join(root, ".pi/extensions/computer-use/instructions.ts"));

const all = ["read", "bash", "another_extension", "desktop_drag", "desktop_double_click", "desktop_dirty_regions",
	"desktop_type", "desktop_screenshot", "desktop_inspect_visual", "desktop_observe", "desktop_changes",
	"desktop_search_seen", "desktop_inspect", "desktop_batch", "desktop_launch_app", "desktop_set_text", "desktop_paste_text",
	"desktop_focus_window", "desktop_keypress", "desktop_scroll", "desktop_click", "desktop_wait",
	"desktop_request_user", "desktop_visual_permission", "desktop_model_phase", "desktop_stop", "desktop_ping", "desktop_metrics"];
let active = [...all];
let changes = 0;
const pi = { getAllTools: () => all.map(name => ({ name })), getActiveTools: () => [...active],
	setActiveTools: tools => { changes++; active = [...tools]; } };
const loadout = new DesktopLoadout(pi);
const desktop = () => active.filter(name => name.startsWith("desktop_"));
const nonDesktop = () => active.filter(name => !name.startsWith("desktop_"));
loadout.sync(false);
assert.deepEqual(desktop(), ["desktop_stop", "desktop_ping", "desktop_metrics"]);
assert.deepEqual(nonDesktop(), ["read", "bash", "another_extension"]);
const offChanges = changes;
loadout.sync(false);
assert.equal(changes, offChanges, "idempotent OFF does not make transcript/tool deltas");
loadout.allowCapture("desktop_screenshot");
assert.deepEqual(desktop(), ["desktop_stop", "desktop_ping", "desktop_metrics"], "grant callback cannot activate a capture while OFF");
loadout.sync(true);
for (const name of ["desktop_observe", "desktop_changes", "desktop_search_seen", "desktop_inspect", "desktop_batch",
	"desktop_launch_app", "desktop_set_text", "desktop_paste_text", "desktop_focus_window", "desktop_keypress", "desktop_scroll",
	"desktop_click", "desktop_wait", "desktop_request_user", "desktop_visual_permission"]) assert.ok(desktop().includes(name), name);
for (const name of ["desktop_double_click", "desktop_drag", "desktop_type", "desktop_dirty_regions",
	"desktop_inspect_visual", "desktop_screenshot", "desktop_model_phase"]) assert.ok(!desktop().includes(name), name);
assert.deepEqual(nonDesktop(), ["read", "bash", "another_extension"]);
assert.equal(desktop().length, 18);
const onChanges = changes;
loadout.sync(true);
assert.equal(changes, onChanges);
loadout.allowCapture("desktop_observe");
assert.equal(changes, onChanges, "observe screenshot:true is guarded by visual policy, not a new declaration");
loadout.allowCapture("desktop_screenshot");
assert.equal(desktop().filter(name => name === "desktop_screenshot").length, 1);
loadout.allowCapture("desktop_inspect_visual");
assert.ok(!desktop().includes("desktop_screenshot"), "granting a different capture withdraws the first");
assert.ok(desktop().includes("desktop_inspect_visual"));
loadout.clearCapture();
assert.ok(!desktop().includes("desktop_inspect_visual"));
loadout.clearCapture();
loadout.sync(true, true);
assert.ok(desktop().includes("desktop_model_phase"), "phase tool is exposed only in hybrid mode");
assert.equal(desktop().length, 19);
loadout.allowCapture("desktop_screenshot");
const captureWithPhase = changes;
loadout.setRoutingAvailable(false);
assert.equal(desktop().includes("desktop_model_phase"), false, "escalated/disabled routing cannot advertise a bounce");
assert.ok(desktop().includes("desktop_screenshot"), "phase change must preserve granted capture declaration");
assert.equal(changes, captureWithPhase + 1);
assert.deepEqual(nonDesktop(), ["read", "bash", "another_extension"]);
loadout.setRoutingAvailable(false);
assert.equal(changes, captureWithPhase + 1, "phase declaration changes are idempotent");
loadout.setRoutingAvailable(true);
assert.ok(desktop().includes("desktop_model_phase"), "new active task restores a single phase tool");
assert.ok(desktop().includes("desktop_screenshot"), "phase reset must not consume visual permit");
loadout.sync(false);
assert.deepEqual(desktop(), ["desktop_stop", "desktop_ping", "desktop_metrics"]);
loadout.sync(true);
assert.ok(!desktop().includes("desktop_screenshot"), "transition clears single-use declaration");
all.splice(all.indexOf("desktop_wait"), 1);
loadout.sync(true);
assert.ok(!desktop().includes("desktop_wait"), "do not activate unregistered/unavailable tools");
assert.deepEqual(nonDesktop(), ["read", "bash", "another_extension"]);

assert.ok(COMPUTER_USE_INSTRUCTIONS.length < 4100, "bounded ON instructions; no unsupported quota claim");
assert.equal(COMPUTER_USE_INSTRUCTIONS.split(SAVED_LOGIN_POLICY).length, 2, "saved-login policy appears once");
for (const phrase of ["OFF forbids", "desktop_visual_permission", "single-use", "AT-SPI", "search_seen",
	"revalidation", "smallest useful rectangle", "never parallel", "uncertain input", "desktop_request_user"])
	assert.ok(COMPUTER_USE_INSTRUCTIONS.includes(phrase), phrase);
console.log("Desktop loadout and compact policy fixtures passed (no desktop/daemon/model).");
