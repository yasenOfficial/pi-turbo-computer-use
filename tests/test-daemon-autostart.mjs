#!/usr/bin/env node
// Private sockets and an injected Node fake daemon; never touches the host desktop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { existsSync, readdirSync, chmodSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extensionHarness } from "./extension-harness.mjs";

const dir = await mkdtemp(path.join(os.tmpdir(), "pi-autostart-"));
const oldSocket = process.env.COMPUTER_USE_SOCKET;
process.env.COMPUTER_USE_SOCKET = path.join(dir, "tools.sock");
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const packagePath = [process.env.PI_CODING_AGENT_PACKAGE, ...(existsSync(releases) ? readdirSync(releases).sort().reverse().map((name) =>
	path.join(releases, name, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])].find((file) => file && existsSync(file));
if (!packagePath) throw new Error("Pi SDK not found; set PI_CODING_AGENT_PACKAGE");
const require = createRequire(packagePath);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, { alias: { typebox: require.resolve("typebox") } });
const root = path.resolve(import.meta.dirname, "..");
const { DesktopDaemonStartup, probeSocket } = await jiti.import(path.join(root, ".pi/extensions/computer-use/daemon.ts"));
// This suite isolates transport/startup races with Node fixtures, not ELF build identity.
// Production compatibility and authenticated upgrades are covered by test-daemon-upgrade.mjs.
DesktopDaemonStartup.prototype.ensureCompatible = DesktopDaemonStartup.prototype.ensure;
const { registerComputerUseTools } = await jiti.import(path.join(root, ".pi/extensions/computer-use/tools.ts"));
const fake = path.join(dir, "fake.mjs");
const requests = path.join(dir, "requests.log");
await writeFile(fake, `import {createServer} from 'node:net';
import {appendFileSync} from 'node:fs';
const server = createServer(s => { let data=''; s.on('data', c => { data += c; if (data.includes('\\n')) { const req=JSON.parse(data.split('\\n')[0]); appendFileSync(process.env.FAKE_REQUESTS, req.cmd+'\\n'); s.end(JSON.stringify({ok:true, pong:true, cmd:req.cmd})+'\\n'); } }); });
server.listen(process.env.COMPUTER_USE_SOCKET);
`);
const logEnv = { ...process.env, COMPUTER_USE_DAEMON: process.execPath, XDG_STATE_HOME: dir, COMPUTER_USE_CONFIG: path.join(dir, "explicit.toml"), FAKE_REQUESTS: requests };
await writeFile(logEnv.COMPUTER_USE_CONFIG, `[daemon]\nsocket = "${path.join(dir, "wrong-from-toml.sock")}"\n`);
const children = [];
let launches = 0;
let observedEnv;
const launch = (binary, env, fd) => {
	launches++;
	assert.equal(binary, process.execPath);
	observedEnv = env;
	const child = spawn(binary, [fake], { env, detached: true, stdio: ["ignore", "ignore", fd] });
	children.push(child);
	return child;
};
const tools = new Map();
const { pi, emit, commands } = extensionHarness(tools);
const workflow = { beforeExecute: async (name) => { if (name !== "desktop_stop") assert.equal(await probeSocket(process.env.COMPUTER_USE_SOCKET), "ready", "lease must begin after readiness"); } };
const startup = new DesktopDaemonStartup(process.env.COMPUTER_USE_SOCKET, logEnv, 1800, launch);
registerComputerUseTools(pi, workflow, startup);
const call = (name, params = {}, signal) => tools.get(name).execute("id", params, signal);
try {
	assert.equal(tools.size, 21);
	await emit("session_start");
	assert.equal(launches, 0);
	assert.equal(commands.size, 0);
	const [a, b] = await Promise.all([call("desktop_ping"), call("desktop_metrics")]);
	assert.equal(launches, 1, "parallel cold calls singleflight");
	assert.equal(a.details.response.cmd, "ping");
	assert.equal(b.details.response.ok, true);
	assert.equal(observedEnv.COMPUTER_USE_SOCKET, process.env.COMPUTER_USE_SOCKET);
	assert.equal(observedEnv.COMPUTER_USE_CONFIG, logEnv.COMPUTER_USE_CONFIG);
	assert.notEqual(observedEnv.COMPUTER_USE_SOCKET, path.join(dir, "wrong-from-toml.sock"));
	await call("desktop_ping");
	assert.deepEqual((await readFile(requests, "utf8")).trim().split("\n"), ["ping", "metrics", "ping"], "probes send no commands; each action is sent exactly once");
	assert.equal(launches, 1, "working daemon must not restart");
	await call("desktop_stop");
	children[0].kill();
	await new Promise((resolve) => setTimeout(resolve, 80));
	workflow.beforeExecute = async () => {};
	await assert.rejects(call("desktop_ping"), /connection failed/);
	assert.equal(launches, 1, "sticky stop must not revive input even after death");

	const disabledPath = path.join(dir, "disabled.sock");
	const disabled = new DesktopDaemonStartup(disabledPath, { ...logEnv, COMPUTER_USE_AUTOSTART: "0" }, 200, launch);
	await disabled.ensure();
	assert.equal(launches, 1);
	const missing = new DesktopDaemonStartup(path.join(dir, "missing.sock"), { ...logEnv, COMPUTER_USE_DAEMON: path.join(dir, "absent") }, 200, launch);
	await assert.rejects(missing.ensure(), /absolute executable ELF daemon binary/);
	const invalid = new DesktopDaemonStartup(path.join(dir, "invalid.sock"), { ...logEnv, COMPUTER_USE_DAEMON: "relative" }, 200, launch);
	await assert.rejects(invalid.ensure(), /absolute executable/);
	assert.equal(launches, 1);
	const script = path.join(dir, "forbidden.sh");
	await writeFile(script, "#!/bin/sh\nexit 0\n"); chmodSync(script, 0o700);
	await assert.rejects(new DesktopDaemonStartup(path.join(dir, "script.sock"), { ...logEnv, COMPUTER_USE_DAEMON: script }, 200, launch).ensure(), /not a script/);
	assert.equal(launches, 1);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(new DesktopDaemonStartup(path.join(dir, "cancel.sock"), logEnv, 200, launch).ensure(aborted.signal), /cancelled/);
	assert.equal(launches, 1);

	const stopTools = new Map();
	const stopStartup = new DesktopDaemonStartup(path.join(dir, "never-start.sock"), logEnv, 200, launch);
	registerComputerUseTools(extensionHarness(stopTools).pi, undefined, stopStartup);
	// Stop does not probe, spawn, or acquire a lease when no daemon exists.
	await assert.rejects(stopTools.get("desktop_stop").execute("stop", {}), /connection failed/);
	assert.equal(launches, 1);
	await stopStartup.ensure();
	assert.equal(launches, 1);

	const badPath = path.join(dir, "bad.sock");
	const badSockets = new Set();
	const bad = createServer((socket) => { badSockets.add(socket); socket.on("close", () => badSockets.delete(socket)); socket.on("error", () => {}); socket.end("not JSON\n"); });
	await new Promise((resolve) => bad.listen(badPath, resolve));
	try {
		const badStartup = new DesktopDaemonStartup(badPath, logEnv, 200, launch);
		await badStartup.ensure();
		assert.equal(launches, 1, "connected but incompatible listener must not be replaced");
		const { ComputerUseClient } = await jiti.import(path.join(root, ".pi/extensions/computer-use/client.ts"));
		await assert.rejects(new ComputerUseClient({ socketPath: badPath }).request({ cmd: "ping" }), /Invalid JSON response/);
		assert.equal(launches, 1);
	} finally { for (const socket of badSockets) socket.destroy(); await new Promise((resolve) => bad.close(resolve)); }
	const deniedPath = path.join(dir, "denied.sock");
	const denied = createServer((socket) => socket.destroy());
	await new Promise((resolve) => denied.listen(deniedPath, resolve));
	await chmod(deniedPath, 0o000);
	try {
		await assert.rejects(new DesktopDaemonStartup(deniedPath, logEnv, 200, launch).ensure(), /Refusing to replace/);
		assert.equal(launches, 1, "EACCES cannot authorize startup");
	} finally { await chmod(deniedPath, 0o600); await new Promise((resolve) => denied.close(resolve)); }
	const dead = new DesktopDaemonStartup(path.join(dir, "failed.sock"), logEnv, 350,
		(binary, env, fd) => { launches++; const child = spawn(process.execPath, ["-e", "process.exit(3)"], { env, detached: true, stdio: ["ignore", "ignore", fd] }); children.push(child); return child; });
	await assert.rejects(dead.ensure(), /did not become ready.*exit 3.*Desktop action was not sent/);
	let hung;
	const noSocket = new DesktopDaemonStartup(path.join(dir, "never-ready.sock"), logEnv, 220,
		(binary, env, fd) => { hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, detached: true, stdio: ["ignore", "ignore", fd] }); children.push(hung); return hung; });
	await assert.rejects(noSocket.ensure(), /did not become ready.*Desktop action was not sent/);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(hung.signalCode, "SIGTERM", "timed-out own startup child must not persist");
	const defaultSocket = path.join(dir, "default-config.sock");
	const defaultEnv = { ...logEnv, FAKE_REQUESTS: path.join(dir, "default-requests.log") };
	delete defaultEnv.COMPUTER_USE_CONFIG;
	await new DesktopDaemonStartup(defaultSocket, defaultEnv, 1800, launch).ensure();
	assert.equal(observedEnv.COMPUTER_USE_CONFIG, path.join(root, "config/default.toml"), "config is resolved from the extension, not cwd");
	assert.equal(observedEnv.COMPUTER_USE_SOCKET, defaultSocket);
	children.at(-1).kill();

	// Stop during the gap between spawn and socket bind: its immediate IPC
	// cannot connect, but queued calls must never reach a newly live daemon.
	const raceSocket = path.join(dir, "race.sock");
	const raceRequests = path.join(dir, "race-requests.log");
	const slowFake = path.join(dir, "slow-fake.mjs");
	await writeFile(slowFake, `import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';
await new Promise(resolve => setTimeout(resolve, 350));
let stopped = false;
createServer(s => { let line=''; s.on('error', () => {}); s.on('data', c => {
 line += c; if (!line.includes('\\n')) return;
 const req = JSON.parse(line.split('\\n')[0]);
 appendFileSync(process.env.FAKE_REQUESTS, req.cmd+'\\n');
 if (req.cmd === 'stop' && process.env.FAKE_STOP_ACK !== '0') stopped = true;
 s.end(JSON.stringify({ok:true, input_stopped:stopped, cmd:req.cmd})+'\\n');
}); }).listen(process.env.COMPUTER_USE_SOCKET);
`);
	process.env.COMPUTER_USE_SOCKET = raceSocket;
	const raceJiti = createJiti(import.meta.url, { moduleCache: false, alias: { typebox: require.resolve("typebox") } });
	const { DesktopDaemonStartup: RaceStartup } = await raceJiti.import(path.join(root, ".pi/extensions/computer-use/daemon.ts"));
	RaceStartup.prototype.ensureCompatible = RaceStartup.prototype.ensure;
	const { registerComputerUseTools: registerRaceTools } = await raceJiti.import(path.join(root, ".pi/extensions/computer-use/tools.ts"));
	const raceEnv = { ...logEnv, FAKE_REQUESTS: raceRequests };
	let raceLaunches = 0;
	const raceStartup = new RaceStartup(raceSocket, raceEnv, 2000, (binary, env, fd) => {
		raceLaunches++;
		const child = spawn(binary, [slowFake], { env, detached: true, stdio: ["ignore", "ignore", fd] });
		children.push(child);
		return child;
	});
	const raceTools = new Map();
	let leaseBegins = 0;
	registerRaceTools(extensionHarness(raceTools).pi, { beforeExecute: async (name) => { if (name !== "desktop_stop") leaseBegins++; } }, raceStartup);
	const queuedClick = raceTools.get("desktop_click").execute("click", { x: 1, y: 1 });
	const queuedObserve = raceTools.get("desktop_observe").execute("observe", {});
	// Wait for the child to exist, but Stop while its socket is still absent.
	for (let i = 0; !raceLaunches && i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(raceLaunches, 1);
	assert.equal(await probeSocket(raceSocket), "missing");
	await assert.rejects(raceTools.get("desktop_stop").execute("stop", {}), /connection failed/);
	const queued = await Promise.allSettled([queuedClick, queuedObserve]);
	assert.ok(queued.every((item) => item.status === "rejected" && /cancelled by desktop_stop/.test(item.reason.message)), "queued tools must not proceed past startup");
	assert.equal(leaseBegins, 0, "no lease may begin after Stop cancels cold startup");
	assert.deepEqual((await readFile(raceRequests, "utf8")).trim().split("\n"), ["stop"], "one internal Stop, zero desktop actions");
	await assert.rejects(raceTools.get("desktop_click").execute("later", { x: 1, y: 1 }), /input was stopped/);
	assert.equal(raceLaunches, 1);
	await raceTools.get("desktop_ping").execute("check", {});
	assert.equal(raceLaunches, 1, "read-only check must not auto-restart after Stop");
	children.at(-1).kill();
	const noAckSocket = path.join(dir, "stop-no-ack.sock");
	const noAckLog = path.join(dir, "stop-no-ack-requests.log");
	const noAckStartup = new RaceStartup(noAckSocket, { ...raceEnv, FAKE_STOP_ACK: "0", FAKE_REQUESTS: noAckLog }, 2000,
		(binary, env, fd) => { const child = spawn(binary, [slowFake], { env, detached: true, stdio: ["ignore", "ignore", fd] }); children.push(child); return child; });
	const noAckPending = noAckStartup.ensure();
	await new Promise((resolve) => setTimeout(resolve, 75));
	noAckStartup.markStopped();
	await assert.rejects(noAckPending, /Stop could not be confirmed.*emergency-stop hotkey/);
	assert.equal((await readFile(noAckLog, "utf8")).trim(), "stop");
	children.at(-1).kill();

	// A competing Pi can be warming even if our own spawn was cancelled before
	// it began. Trigger Stop synchronously from binary selection, then bind the
	// other process's socket later; only that contender may be stopped.
	const winnerSocket = path.join(dir, "competing-winner.sock");
	const winnerRequests = path.join(dir, "winner-requests.log");
	let winnerStartup;
	let winnerChild;
	let ownSpawns = 0;
	let selected = false;
	const winnerEnv = { ...raceEnv };
	Object.defineProperty(winnerEnv, "COMPUTER_USE_DAEMON", { enumerable: true, get() {
		if (!selected) {
			selected = true;
			winnerStartup.markStopped();
			setTimeout(() => {
				winnerChild = spawn(process.execPath, [slowFake], { detached: true, stdio: "ignore",
					env: { ...logEnv, COMPUTER_USE_SOCKET: winnerSocket, FAKE_REQUESTS: winnerRequests } });
				children.push(winnerChild);
			}, 20);
		}
		return process.execPath;
	} });
	winnerStartup = new RaceStartup(winnerSocket, winnerEnv, 1700, () => { ownSpawns++; throw new Error("stopped startup must never launch"); });
	const winnerTools = new Map();
	registerRaceTools(extensionHarness(winnerTools).pi, undefined, winnerStartup);
	await assert.rejects(winnerTools.get("desktop_click").execute("queued-winner", { x: 1, y: 1 }), /cancelled by desktop_stop/);
	assert.equal(ownSpawns, 0, "interrupted startup cannot spawn its own daemon");
	assert.deepEqual((await readFile(winnerRequests, "utf8")).trim().split("\n"), ["stop"], "competing winner receives explicit Stop, no desktop action");
	const { ComputerUseClient: WinnerClient } = await raceJiti.import(path.join(root, ".pi/extensions/computer-use/client.ts"));
	assert.equal((await new WinnerClient({ socketPath: winnerSocket }).request({ cmd: "ping" })).input_stopped, true);
	winnerChild.kill();

	// Stop can also arrive before the initial connect probe finishes; a lock
	// winner binding afterward still needs the explicit Stop.
	const earlySocket = path.join(dir, "probe-stop.sock");
	const earlyRequests = path.join(dir, "probe-stop-requests.log");
	const early = new RaceStartup(earlySocket, raceEnv, 1700, () => { ownSpawns++; throw new Error("early Stop must not spawn"); });
	const earlyPending = early.ensure();
	early.markStopped();
	const earlyChild = spawn(process.execPath, [slowFake], { detached: true, stdio: "ignore",
		env: { ...logEnv, COMPUTER_USE_SOCKET: earlySocket, FAKE_REQUESTS: earlyRequests } });
	children.push(earlyChild);
	await assert.rejects(earlyPending, /cancelled by desktop_stop/);
	assert.equal(ownSpawns, 0);
	assert.equal((await readFile(earlyRequests, "utf8")).trim(), "stop");
	assert.equal((await new WinnerClient({ socketPath: earlySocket }).request({ cmd: "ping" })).input_stopped, true);
	earlyChild.kill();

	// Without a winner, the Stop-only monitor expires within this one startup
	// deadline, without spawning or leaving a polling supervisor.
	const noWinner = new RaceStartup(path.join(dir, "no-winner.sock"), raceEnv, 170,
		() => { ownSpawns++; throw new Error("no winner must not spawn"); });
	const noWinnerPending = noWinner.ensure();
	noWinner.markStopped();
	await assert.rejects(noWinnerPending, /cancelled by desktop_stop/);
	assert.equal(ownSpawns, 0);

	// Native Stop rejections may omit input_stopped. The client throws most
	// failed replies, but launch_app preserves its failed response for choices.
	const nativeSocket = path.join(dir, "native-stop.sock");
	process.env.COMPUTER_USE_SOCKET = nativeSocket;
	const nativeJiti = createJiti(import.meta.url, { moduleCache: false, alias: { typebox: require.resolve("typebox") } });
	const { DesktopDaemonStartup: NativeStartup } = await nativeJiti.import(path.join(root, ".pi/extensions/computer-use/daemon.ts"));
	NativeStartup.prototype.ensureCompatible = NativeStartup.prototype.ensure;
	const { registerComputerUseTools: registerNativeTools } = await nativeJiti.import(path.join(root, ".pi/extensions/computer-use/tools.ts"));
	const nativeRequests = [];
	const nativeServer = createServer((socket) => { let buffer = ""; socket.on("error", () => {}); socket.on("data", (data) => {
		buffer += data;
		if (!buffer.includes("\n")) return;
		const request = JSON.parse(buffer.split("\n")[0]);
		nativeRequests.push(request);
		const error = request.cmd === "keypress" && request.key === "sticky" ? "input stopped; restart daemon to re-enable"
			: request.cmd === "keypress" && request.key === "emergency" ? "emergency stop active. Restart required"
			: request.cmd === "launch_app" ? "emergency stop active. Restart required"
			: request.cmd === "keypress" && request.key === "non-sticky" ? "Editor says input stopped; unrelated UI error" : undefined;
		socket.end(`${JSON.stringify(error ? { ok: false, error } : { ok: true })}\n`);
	}); });
	await new Promise((resolve) => nativeServer.listen(nativeSocket, resolve));
	let stoppedNativeTools;
	let unexpectedStarts = 0;
	try {
		const newTools = () => {
			const manager = new NativeStartup(nativeSocket, logEnv, 300, () => { unexpectedStarts++; throw new Error("must not spawn"); });
			const registered = new Map();
			registerNativeTools(extensionHarness(registered).pi, undefined, manager);
			return registered;
		};
		const nativeTools = newTools();
		stoppedNativeTools = nativeTools;
		await assert.rejects(nativeTools.get("desktop_keypress").execute("not-stopped", { key: "non-sticky" }), /Editor says input stopped/);
		await assert.rejects(nativeTools.get("desktop_keypress").execute("still-allowed", { key: "non-sticky" }), /Editor says input stopped/);
		await nativeTools.get("desktop_ping").execute("still-usable", {});
		await assert.rejects(nativeTools.get("desktop_keypress").execute("stopped", { key: "sticky" }), /^Error: input stopped;/);
		await assert.rejects(nativeTools.get("desktop_click").execute("blocked", { x: 1, y: 1 }), /input was stopped/);
		const emergencyTools = newTools();
		await assert.rejects(emergencyTools.get("desktop_keypress").execute("emergency", { key: "emergency" }), /emergency stop active/);
		await assert.rejects(emergencyTools.get("desktop_click").execute("blocked", { x: 1, y: 1 }), /input was stopped/);
		const launchTools = newTools();
		const launch = await launchTools.get("desktop_launch_app").execute("rejected", { app_id: "example.desktop" });
		assert.equal(launch.isError, true);
		await assert.rejects(launchTools.get("desktop_click").execute("blocked", { x: 1, y: 1 }), /input was stopped/);
		assert.deepEqual(nativeRequests.map(({ cmd }) => cmd), ["keypress", "keypress", "ping", "keypress", "keypress", "launch_app"], "stopped actions never reach daemon");
		assert.equal(unexpectedStarts, 0);
	} finally { await new Promise((resolve) => nativeServer.close(resolve)); }
	await assert.rejects(stoppedNativeTools.get("desktop_ping").execute("after-death", {}), /connection failed/);
	assert.equal(unexpectedStarts, 0, "native Stop rejection must prevent respawn after daemon death");
	console.log("Daemon autostart passed: lazy load, singleflight, socket/config, sticky native errors and cold-start Stop, disabled, invalid binaries/listeners and startup failures.");
} finally {
	for (const child of children) if (child.exitCode === null) child.kill();
	if (oldSocket === undefined) delete process.env.COMPUTER_USE_SOCKET;
	else process.env.COMPUTER_USE_SOCKET = oldSocket;
	await rm(dir, { recursive: true, force: true });
}
