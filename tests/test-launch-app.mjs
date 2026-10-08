#!/usr/bin/env node
// Native GIO launch integration: only temporary, test-owned .desktop entries
// running a marker-only Node helper. No host app, UI, X server, or session bus.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const bin = path.resolve(process.env.DAEMON_BIN || fileURLToPath(new URL("../daemon/target/release/pi-turbo-daemon", import.meta.url)));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForMarker(file, expected) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const contents = await readFile(file, "utf8").catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (contents === expected) return;
		if (contents !== null) throw new Error(`unexpected marker contents in ${file}: ${JSON.stringify(contents)}`);
		await pause(25);
	}
	throw new Error(`GIO accepted dispatch but marker was not created: ${file}`);
}

async function missing(file) {
	await assert.rejects(stat(file), (error) => error.code === "ENOENT", `unexpected fixture execution: ${file}`);
}

async function main() {
	await access(bin, constants.X_OK);
	const probe = spawnSync(bin, ["--build-info"], { encoding: "utf8", timeout: 5000 });
	assert.equal(probe.status, 0, probe.stderr);
	assert.ok(JSON.parse(probe.stdout).capabilities.includes("app_discovery"));
	const root = await mkdtemp(path.join(tmpdir(), "pi-gio-launch-"));
	let daemon;
	let daemonClosed = false;
	let lines;
	let stderr = "";
	const waitForClose = (ms) => daemonClosed ? Promise.resolve(true) : new Promise((resolve) => {
		const onClose = () => { clearTimeout(timer); resolve(true); };
		const timer = setTimeout(() => { daemon.off("close", onClose); resolve(false); }, ms);
		daemon.once("close", onClose);
	});
	try {
		const data = path.join(root, "data");
		const apps = path.join(data, "applications");
		const emptySystemData = path.join(root, "empty-system-data");
		const home = path.join(root, "home");
		const runtime = path.join(root, "runtime");
		await Promise.all([mkdir(apps, { recursive: true }), mkdir(emptySystemData), mkdir(home), mkdir(runtime, { mode: 0o700 })]);
		const config = path.join(root, "daemon.toml");
		await writeFile(config, "[daemon]\noverlay = false\n", { mode: 0o600 });
		const helper = path.join(root, "marker.mjs");
		await writeFile(helper, [
			'import { appendFileSync } from "node:fs";',
			'if (process.argv.length !== 4) process.exit(31);',
			'appendFileSync(process.argv[2], `${process.argv[3]}\\n`, { flag: "a" });',
			'',
		].join("\n"));

		const fixtures = [
			{ id: "pi-test-id.desktop", name: "Pi GIO By ID", marker: "by-id" },
			{ id: "pi-test-name.desktop", name: "Pi GIO Exact Café", marker: "by-name" },
			{ id: "pi-test-ambiguous-a.desktop", name: "Pi GIO Ambiguous", marker: "ambiguous-a" },
			{ id: "pi-test-ambiguous-b.desktop", name: "Pi GIO Ambiguous", marker: "ambiguous-b" },
			{ id: "pi-test-hidden.desktop", name: "Pi GIO Hidden", marker: "hidden", hidden: "Hidden=true" },
			{ id: "pi-test-nodisplay.desktop", name: "Pi GIO NoDisplay", marker: "nodisplay", hidden: "NoDisplay=true" },
			{ id: "pi-test-stopped.desktop", name: "Pi GIO Stopped", marker: "stopped" },
			{ id: "stm32cubeide-1.18.desktop", name: "Éditeur STM32CubeIDE 1.18", marker: "cubeide" },
			...Array.from({ length: 25 }, (_, i) => ({
				id: `pi-test-cube-${String(i).padStart(2, "0")}.desktop`, name: `Pi GIO Cube ${i}`, marker: `cube-${i}`,
			})),
		];
		const marker = (fixture) => path.join(root, `${fixture.marker}.marker`);
		for (const fixture of fixtures) {
			// Fixed test fixture only: the IPC never supplies an Exec/path. %c tests
			// GIO's desktop-entry field-code expansion and preserves the display name.
			await writeFile(path.join(apps, fixture.id), [
				"[Desktop Entry]", "Type=Application", `Name=${fixture.name}`,
				`Exec=${process.execPath} ${helper} ${marker(fixture)} %c`,
				fixture.hidden || "", "",
			].join("\n"));
		}
		const env = {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			XDG_DATA_HOME: data,
			XDG_DATA_DIRS: emptySystemData,
			XDG_RUNTIME_DIR: runtime,
			XDG_CURRENT_DESKTOP: "PiTurboTest",
			GSETTINGS_BACKEND: "memory",
			GIO_USE_VFS: "local",
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, "no-session-bus")}`,
			COMPUTER_USE_CONFIG: config,
			COMPUTER_USE_OVERLAY: "0", // override even an inherited env setting
			COMPUTER_USE_DEBUG: "0",
		};
		delete env.DISPLAY;
		delete env.XAUTHORITY;
		delete env.AT_SPI_BUS_ADDRESS;
		delete env.DBUS_STARTER_ADDRESS;
		delete env.DBUS_STARTER_BUS_TYPE;
		daemon = spawn(bin, ["--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
		daemon.once("close", () => { daemonClosed = true; });
		daemon.stderr.setEncoding("utf8");
		daemon.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
		lines = readline.createInterface({ input: daemon.stdout });
		const iter = lines[Symbol.asyncIterator]();
		async function request(payload) {
			if (daemon.exitCode !== null) throw new Error(`daemon exited ${daemon.exitCode}: ${stderr}`);
			let timer;
			let line;
			try {
				line = await Promise.race([
					(async () => {
						await new Promise((resolve, reject) => daemon.stdin.write(`${JSON.stringify(payload)}\n`, (error) => error ? reject(error) : resolve()));
						return iter.next();
					})(),
					new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`daemon IPC timeout: ${JSON.stringify(payload)}; stderr: ${stderr}`)), 10000); }),
				]);
			} finally {
				clearTimeout(timer);
			}
			if (line.done) throw new Error(`daemon closed stdout: ${stderr}`);
			return JSON.parse(line.value);
		}
		assert.equal((await request({ cmd: "ping" })).ok, true, stderr);
		const info = await request({ cmd: "daemon_info" });
		assert.ok(info.daemon_info.capabilities.includes("app_discovery"));
		const lookup = async (query) => request({ cmd: "launch_app", query });
		const found = await lookup(" stm32CUBEIDE ");
		assert.equal(found.ok, true);
		assert.equal(found.app_discovery, true);
		assert.equal(found.launch_status, "lookup");
		assert.equal(found.launch_attempted, false);
		assert.equal(found.app_matches_total, 1);
		assert.equal(found.app_matches_truncated, false);
		assert.deepEqual(found.app_matches, [{ app_id: fixtures[7].id, name: fixtures[7].name }]);
		assert.equal(Object.hasOwn(found, "launch"), false);
		const byId = await lookup("STM32CUBEIDE-1.18.DESKTOP");
		assert.deepEqual(byId.app_matches, found.app_matches);
		const many = await lookup("pi-test-cube-");
		assert.equal(many.app_matches_total, 25);
		assert.equal(many.app_matches_truncated, true);
		assert.deepEqual(many.app_matches.map((m) => m.app_id), fixtures.slice(8, 28).map((f) => f.id));
		const none = await lookup("missing-test-owned-registry-entry");
		assert.equal(none.ok, true);
		assert.deepEqual(none.app_matches, []);
		assert.equal(none.app_matches_total, 0);
		assert.equal(none.app_matches_truncated, false);
		assert.deepEqual((await lookup("Pi GIO Hidden")).app_matches, []);
		assert.deepEqual((await lookup("Pi GIO NoDisplay")).app_matches, []);
		for (const fixture of fixtures) await missing(marker(fixture));
		const rejected = async (payload) => {
			const reply = await request({ cmd: "launch_app", ...payload });
			assert.equal(reply.ok, false, JSON.stringify(reply));
			assert.equal(Object.hasOwn(reply, "launch"), false, JSON.stringify(reply));
			if (!Object.hasOwn(payload, "exec")) assert.equal(reply.launch_attempted, false);
			return reply;
		};
		await rejected({ app_id: "/tmp/pi-test-id.desktop" });
		await rejected({ app_id: "../pi-test-id.desktop" });
		await rejected({ app_id: fixtures[0].id, name: fixtures[0].name });
		for (const payload of [{ query: "" }, { query: "  " }, { query: "a\n" },
			{ query: "é".repeat(121) }, { query: "cube", app_id: fixtures[7].id },
			{ query: "cube", name: fixtures[7].name }, { query: "cube", exec: "/bin/true" }]) {
			await rejected(payload);
		}
		await rejected({});
		await rejected({ app_id: "pi-test-unknown.desktop" });
		await rejected({ app_id: fixtures[0].id, exec: "/bin/true" });
		const ambiguous = await rejected({ name: "Pi GIO Ambiguous" });
		assert.match(ambiguous.error, /ambiguous/i);
		assert.equal(ambiguous.launch_status, "ambiguous");
		assert.equal(ambiguous.app_matches_total, 2);
		assert.equal(ambiguous.app_matches_truncated, false);
		assert.deepEqual(new Set(ambiguous.app_matches.map((m) => m.app_id)), new Set([fixtures[2].id, fixtures[3].id]));
		await rejected({ name: "pi gio exact café" }); // exact, not fuzzy/case-folded
		await rejected({ app_id: fixtures[4].id });
		await rejected({ app_id: fixtures[5].id });
		for (const fixture of fixtures) await missing(marker(fixture));

		for (const [fixture, selector] of [
			[fixtures[0], { app_id: fixtures[0].id }],
			[fixtures[1], { name: fixtures[1].name }],
			[fixtures[7], { app_id: found.app_matches[0].app_id }],
		]) {
			const response = await request({ cmd: "launch_app", ...selector });
			assert.equal(response.ok, true, JSON.stringify(response));
			assert.deepEqual(response.launch, { app_id: fixture.id, name: fixture.name, accepted: true });
			assert.equal(response.launch_status, "accepted");
			assert.equal(response.launch_attempted, true);
			assert.equal(Object.hasOwn(response, "snapshot"), false);
			// An acknowledgement is NOT readiness; only the subsequent marker
			// check demonstrates the test-owned process actually executed.
			await waitForMarker(marker(fixture), `${fixture.name}\n`);
		}
		assert.equal((await request({ cmd: "stop" })).input_stopped, true);
		const stopped = await rejected({ app_id: fixtures[6].id });
		assert.equal(stopped.launch_status, "stopped");
		const stoppedLookup = await rejected({ query: "CubeIDE" });
		assert.equal(stoppedLookup.launch_status, "stopped");
		assert.equal(stoppedLookup.launch_attempted, false);
		assert.match(stopped.error, /input stopped/i);
		assert.equal((await request({ cmd: "ping" })).input_stopped, true);
		await pause(100);
		for (const fixture of fixtures.slice(2).filter((fixture) => fixture !== fixtures[7])) await missing(marker(fixture));
		assert.equal(await readFile(marker(fixtures[0]), "utf8"), `${fixtures[0].name}\n`);
		assert.equal(await readFile(marker(fixtures[1]), "utf8"), `${fixtures[1].name}\n`);
		assert.equal(await readFile(marker(fixtures[7]), "utf8"), `${fixtures[7].name}\n`);
		console.log("Native GIO launch_app: bounded query-only discovery, exact launch, validation and stop verified.");
	} finally {
		if (daemon) {
			lines?.close();
			daemon.stdin?.destroy();
			if (!daemonClosed) {
				daemon.kill("SIGTERM");
				if (!await waitForClose(2000)) {
					daemon.kill("SIGKILL");
					await waitForClose(1000);
				}
			}
		}
		await rm(root, { recursive: true, force: true });
	}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
