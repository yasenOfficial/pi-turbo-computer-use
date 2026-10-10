import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { binaryBuildId, DaemonVersion } from "./version.js";
import { accessSync, closeSync, constants, fchmodSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerUseClient, computerUseClient } from "./client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RELEASE = path.join(ROOT, "daemon/target/release/pi-turbo-daemon");
const FALLBACK = path.join(os.homedir(), ".local/bin/pi-turbo-daemon");
const CONFIG = path.join(ROOT, "config/default.toml");
const DEADLINE_MS = 12_000;

type ProbeResult = "ready" | "missing" | "uncertain";

/** A connect-only probe: never sends an IPC command or repeats an action. */
export function probeSocket(socketPath: string, timeoutMs = 300): Promise<ProbeResult> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (result?: ProbeResult, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(result!);
		};
		const timer = setTimeout(() => finish("uncertain"), timeoutMs);
		socket.once("connect", () => finish("ready"));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish("missing");
			else finish(undefined, new Error(`Cannot probe computer-use socket ${socketPath}: ${error.message}. Refusing to replace a possibly running daemon.`));
		});
	});
}

function executable(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		const fd = openSync(file, "r");
		try {
			const magic = Buffer.alloc(4);
			return readSync(fd, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
		} finally { closeSync(fd); }
	} catch { return false; }
}

function selectBinary(env: NodeJS.ProcessEnv): string {
	if (env.COMPUTER_USE_DAEMON !== undefined) {
		const binary = env.COMPUTER_USE_DAEMON;
		if (!path.isAbsolute(binary) || !executable(binary)) throw new Error(`COMPUTER_USE_DAEMON must name an absolute executable ELF daemon binary (not a script): ${binary}`);
		return binary;
	}
	if (executable(RELEASE)) return RELEASE;
	if (executable(FALLBACK)) return FALLBACK;
	throw new Error(`Computer-use daemon binary not found. Build the release binary at ${RELEASE} (scripts/install.sh installs ${FALLBACK}), or set COMPUTER_USE_DAEMON to an absolute executable ELF binary. No build is run by Pi.`);
}

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Runtime-local startup singleflight. The daemon's socket lock arbitrates across Pi processes. */
export class DesktopDaemonStartup {
	private pending?: Promise<void>;
	private compatibilityPending?: Promise<string[]>;
	private spawned?: { pid: number; token: string };
	private stopped = false;

	constructor(
		readonly socketPath = computerUseClient.socketPath,
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly deadlineMs = DEADLINE_MS,
		private readonly launch: (binary: string, env: NodeJS.ProcessEnv, logFd: number) => ChildProcess =
			(binary, childEnv, logFd) => spawn(binary, [], { env: childEnv, detached: true, stdio: ["ignore", "ignore", logFd] }),
	) {}

	markStopped(): void { this.stopped = true; }

	/** Before UI/AT-SPI access, check safety and upgrade only authenticated idle instances. */
	async ensureCompatible(signal?: AbortSignal, requiredCapability?: string): Promise<void> {
		if (signal?.aborted) throw new Error("Computer-use startup was cancelled");
		if (!this.compatibilityPending) {
			const pending = this.checkCompatibility();
			this.compatibilityPending = pending;
			void pending.finally(() => { if (this.compatibilityPending === pending) this.compatibilityPending = undefined; }).catch(() => {});
		}
		const pending = this.compatibilityPending;
		const verify = pending.then((capabilities) => {
			if (requiredCapability && !capabilities.includes(requiredCapability))
				throw new Error(requiredCapability === "clipboard_paste"
					? "Running daemon lacks clipboard_paste; paste was not sent. Build/reload a capable daemon; do not fall back to keyboard typing automatically."
					: `Running daemon lacks ${requiredCapability}; discovery was not sent. Build/reload a capable daemon or use verified semantic UI discovery; do not guess a launcher or retry an uncertain launch.`);
		});
		if (!signal) return verify;
		return new Promise<void>((resolve, reject) => {
			const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Computer-use startup was cancelled")); };
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) { abort(); return; }
			verify.then(() => { signal.removeEventListener("abort", abort); resolve(); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
		});
	}

	private async checkCompatibility(): Promise<string[]> {
		// Validate the offline safety identity before cold UI startup as well.
		if (!this.stopped && this.env.COMPUTER_USE_AUTOSTART !== "0" && await probeSocket(this.socketPath) === "missing")
			await binaryBuildId(selectBinary(this.env));
		await this.ensure();
		const version = new DaemonVersion(this.socketPath, this.env);
		let info = await version.info();
		if (info.input_stopped) { this.markStopped(); throw new Error("input stopped; automatic daemon upgrade is disabled"); }
		if (this.stopped) throw new Error("Computer-use startup was cancelled by desktop_stop; desktop action was not sent.");
		version.remember(info, this.spawned);
		let binary: string | undefined;
		try { binary = selectBinary(this.env); } catch { /* A compatible external daemon requires no local binary. */ }
		const buildId = binary ? await binaryBuildId(binary) : undefined;
		if (this.stopped) throw new Error("Computer-use startup was cancelled by desktop_stop; desktop action was not sent.");
		if (buildId && this.env.COMPUTER_USE_AUTOSTART !== "0" && await version.upgradeIfIdle(info, buildId)) {
			const deadline = Date.now() + 3500;
			while (await probeSocket(this.socketPath) !== "missing") {
				if (Date.now() >= deadline) throw new Error("Authenticated daemon upgrade did not finish; desktop action was not sent");
				await wait(50);
			}
			if (this.stopped) throw new Error("Computer-use upgrade was cancelled by desktop_stop; replacement was not started.");
			await this.ensure();
			info = await version.info();
			version.remember(info, this.spawned);
			if (info.build_id !== buildId) throw new Error("Replacement daemon build does not match the verified binary; desktop action was not sent");
		}
		if (info.input_stopped) this.markStopped();
		if (this.stopped) throw new Error("input stopped; desktop action was not sent");
		if (!version.safe(info)) throw new Error("Desktop observation blocked: daemon lacks required safety fixes and cannot be upgraded while unowned, busy or leased. No browser action was sent.");
		return info.capabilities;
	}

	/** After Stop, a later manual daemon restart must not silently authorize input. */
	assertInputAllowed(): void {
		if (this.stopped) throw new Error("Desktop input was stopped; do not automatically retry or restart it. Deliberately restart the daemon, then use /reload in this same Pi session to reset the extension.");
	}

	async ensure(signal?: AbortSignal): Promise<void> {
		if (this.stopped) {
			if (this.pending) throw new Error("Computer-use startup was cancelled by desktop_stop; desktop action was not sent.");
			return; // Read-only tools can still check the already-running daemon.
		}
		if (this.env.COMPUTER_USE_AUTOSTART === "0") return;
		if (signal?.aborted) throw new Error("Computer-use startup was cancelled");
		if (!this.pending) {
			const pending = this.start();
			this.pending = pending;
			void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
		}
		const pending = this.pending;
		const checked = pending.then(() => {
			if (this.stopped) throw new Error("Computer-use startup was cancelled by desktop_stop; desktop action was not sent.");
		});
		if (!signal) return checked;
		return new Promise<void>((resolve, reject) => {
			const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Computer-use startup was cancelled")); };
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) { abort(); return; }
			checked.then(() => { signal.removeEventListener("abort", abort); resolve(); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
		});
	}

	private async stopColdStart(): Promise<void> {
		// desktop_stop already attempted its immediate request while the socket was
		// absent. Complete that *explicit Stop*, not the queued desktop action,
		// once the spawned daemon (or a competing lock winner) becomes reachable.
		try {
			const response = await new ComputerUseClient({ socketPath: this.socketPath, timeoutMs: 3000 }).request({ cmd: "stop" });
			if (response.ok !== true || response.input_stopped !== true) throw new Error("daemon did not acknowledge input_stopped: true");
		} catch (error) {
			throw new Error(`Desktop action was not sent. Cold-start daemon became reachable, but the requested Stop could not be confirmed at ${this.socketPath}: ${error instanceof Error ? error.message : String(error)}. Use the emergency-stop hotkey and check desktop_ping before any manual restart.`);
		}
	}

	/** Stop can preempt our spawn while another Pi's daemon is still warming.
	 * Keep this one startup attempt alive only until its original deadline; never
	 * launch a replacement or leave a watcher running after it expires.
	 */
	private async waitForStoppedWinner(deadline: number): Promise<void> {
		while (Date.now() < deadline) {
			const state = await probeSocket(this.socketPath);
			if (state === "ready") { await this.stopColdStart(); return; }
			if (state === "uncertain") throw new Error(`Cannot confirm the requested Stop at ${this.socketPath}: socket probe was uncertain. Use the emergency-stop hotkey before any manual restart.`);
			await wait(Math.min(80, Math.max(0, deadline - Date.now())));
		}
		// No listener appeared; no action was sent and we did not spawn a daemon.
	}

	private async start(): Promise<void> {
		const deadline = Date.now() + this.deadlineMs;
		const first = await probeSocket(this.socketPath);
		if (first === "ready") return; // Immediate desktop_stop handles an existing listener.
		if (first === "uncertain") throw new Error(`Computer-use socket ${this.socketPath} did not respond to a connect probe; refusing to spawn over a possibly running daemon.`);
		if (this.stopped) return this.waitForStoppedWinner(deadline);
		let binary: string;
		try { binary = selectBinary(this.env); }
		catch (error) {
			if (this.stopped) return this.waitForStoppedWinner(deadline);
			throw error;
		}
		if (this.stopped) return this.waitForStoppedWinner(deadline);
		// The client socket always wins over a conflicting TOML [daemon].socket.
		const managedToken = randomUUID();
		const childEnv = { ...this.env, COMPUTER_USE_SOCKET: this.socketPath, COMPUTER_USE_MANAGED_TOKEN: managedToken,
			COMPUTER_USE_CONFIG: this.env.COMPUTER_USE_CONFIG ?? (executableConfig() ? CONFIG : undefined) };
		// Keep startup diagnostics private; truncate on each start (never stream logs to Pi/model).
		const stateHome = this.env.XDG_STATE_HOME && path.isAbsolute(this.env.XDG_STATE_HOME)
			? this.env.XDG_STATE_HOME : path.join(os.homedir(), ".local/state");
		const logDir = path.join(stateHome, "pi-computer");
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
		const logPath = path.join(logDir, "daemon-startup.log");
		const logFd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
		let child: ChildProcess | undefined;
		try {
			fchmodSync(logFd, 0o600);
			if (!this.stopped) child = this.launch(binary, childEnv, logFd);
		} finally { closeSync(logFd); }
		if (!child) return this.waitForStoppedWinner(deadline);
		if (child.pid) this.spawned = { pid: child.pid, token: managedToken };
		child.unref();
		// Observe spawn errors/exits without waiting for the daemon's lifetime.
		let failure: string | undefined;
		child.once("error", (error) => { failure = error.message; });
		child.once("exit", (code, signal) => { failure = `exit ${code ?? signal}`; });
		while (Date.now() < deadline) {
			const state = await probeSocket(this.socketPath);
			if (state === "ready") {
				if (this.stopped) await this.stopColdStart();
				return;
			}
			if (state === "uncertain") throw new Error(`Computer-use socket ${this.socketPath} could not be probed; refusing to send desktop input.`);
			// An exited contender may have lost the daemon's cross-process startup lock.
			// Keep waiting for the winner instead of racing a second spawn.
			await wait(80);
		}
		// Only reap our own still-starting child when readiness failed. Never kill
		// a listener, a lock winner from another Pi, or a successfully started daemon.
		if (!failure && await probeSocket(this.socketPath) === "missing") child.kill();
		throw new Error(`Computer-use daemon did not become ready at ${this.socketPath} within ${this.deadlineMs}ms (${failure ?? "still starting"}). Binary: ${binary}; diagnostics: ${logPath}. Check DISPLAY, X11 and configuration. Desktop action was not sent.`);
	}
}

function executableConfig(): boolean {
	try { return statSync(CONFIG).isFile(); } catch { return false; }
}
