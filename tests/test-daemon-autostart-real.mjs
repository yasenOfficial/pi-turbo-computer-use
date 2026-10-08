#!/usr/bin/env node
// Real release daemon on an isolated socket. No model, DISPLAY, bus or desktop actions.
// Build beforehand: cargo build --release --manifest-path daemon/Cargo.toml
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "daemon/target/release/pi-turbo-daemon");
if (!existsSync(binary)) throw new Error(`Build the real release daemon first: cargo build --release --manifest-path ${path.join(root, "daemon/Cargo.toml")}`);
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const packagePath = [process.env.PI_CODING_AGENT_PACKAGE, ...(existsSync(releases) ? readdirSync(releases).sort().reverse().map((name) =>
	path.join(releases, name, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])].find((file) => file && existsSync(file));
if (!packagePath) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE");
const require = createRequire(packagePath);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url);
const { DesktopDaemonStartup } = await jiti.import(path.join(root, ".pi/extensions/computer-use/daemon.ts"));
const { ComputerUseClient } = await jiti.import(path.join(root, ".pi/extensions/computer-use/client.ts"));
const dir = await mkdtemp(path.join(os.tmpdir(), "pi-autostart-real-"));
const socketPath = path.join(dir, "real.sock");
const configPath = path.join(dir, "daemon.toml");
let child;
try {
	// An intentionally conflicting TOML socket proves child env uses the exact client path.
	await writeFile(configPath, `[daemon]\nsocket = "${path.join(dir, "wrong-from-toml.sock")}"\noverlay = false\n`);
	const env = { ...process.env, COMPUTER_USE_DAEMON: binary, COMPUTER_USE_CONFIG: configPath,
		COMPUTER_USE_SOCKET: path.join(dir, "wrong-from-parent-env.sock"), COMPUTER_USE_OVERLAY: "0",
		DISPLAY: "", XAUTHORITY: "", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
		XDG_STATE_HOME: dir, XDG_RUNTIME_DIR: dir };
	let starts = 0;
	const launch = (file, childEnv, fd) => {
		assert.equal(file, binary);
		assert.equal(childEnv.COMPUTER_USE_SOCKET, socketPath);
		assert.equal(childEnv.COMPUTER_USE_CONFIG, configPath);
		starts++;
		child = spawn(file, [], { env: childEnv, detached: true, stdio: ["ignore", "ignore", fd] });
		return child;
	};
	const startup = new DesktopDaemonStartup(socketPath, env, 12_000, launch);
	await Promise.all([startup.ensure(), startup.ensure(), startup.ensure()]);
	assert.equal(starts, 1, "concurrent Pi calls must share one actual daemon spawn");
	assert.ok(child?.pid, "only this test's daemon is eligible for cleanup");
	const client = new ComputerUseClient({ socketPath, timeoutMs: 2000 });
	assert.deepEqual((await client.request({ cmd: "ping" })).input_stopped, false);
	const reuse = new DesktopDaemonStartup(socketPath, env, 1000, () => { throw new Error("working daemon must not be spawned over"); });
	await reuse.ensure();
	assert.equal(starts, 1);
	startup.markStopped();
	const stopped = await client.request({ cmd: "stop" });
	assert.equal(stopped.input_stopped, true);
	assert.equal((await client.request({ cmd: "ping" })).input_stopped, true);
	child.kill(); // Never kill an existing daemon: this PID came from our launch above.
	for (let i = 0; child.exitCode === null && child.signalCode === null && i < 50; i++)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.notEqual(child.signalCode, null, "test-owned daemon must exit before checking sticky startup");
	await startup.ensure();
	assert.equal(starts, 1, "Stop must prevent a replacement after daemon death");
	await assert.rejects(client.request({ cmd: "ping" }), /connection failed/);
	console.log("Real release daemon autostart passed: one private spawn, working reuse, ping, sticky Stop; no desktop input or model calls.");
} finally {
	if (child?.exitCode === null && child.signalCode === null) child.kill();
	await rm(dir, { recursive: true, force: true });
}
