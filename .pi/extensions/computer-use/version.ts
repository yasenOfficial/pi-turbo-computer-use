import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComputerUseClient } from "./client.js";

type Info = { protocol_version: number; build_id: string; capabilities: string[]; pid: number;
	instance_id: string; managed: boolean; input_stopped: boolean; busy: boolean; active_workflows: number };
type Owner = { socket: string; pid: number; instance_id: string; token: string };
const REQUIRED = ["atspi_direct_properties", "verified_focus", "launch_app"];
const expected = new Map<string, { signature: string; id: string }>();

export async function binaryBuildId(binary: string): Promise<string> {
	const s = statSync(binary);
	const signature = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
	if (expected.get(binary)?.signature === signature) return expected.get(binary)!.id;
	// Legacy binaries may ignore unknown flags and start a desktop backend.
	// Never execute a version probe unless this offline command is embedded.
	if (s.size > 64 * 1024 * 1024 || !readFileSync(binary).includes(Buffer.from("pi-computer-build-info-v1")))
		throw new Error("Installed daemon has no safe offline build probe; desktop action was not sent");
	const output = await new Promise<string>((resolve, reject) => execFile(binary, ["--build-info"],
		{ timeout: 2000, maxBuffer: 16_384, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout)));
	const info = JSON.parse(output);
	if (info.probe_marker !== "pi-computer-build-info-v1" || info.protocol_version !== 1 || !/^[a-f0-9]{16}$/.test(info.build_id) ||
		!REQUIRED.every((cap) => info.capabilities?.includes(cap))) throw new Error("Installed daemon build lacks required safety capabilities");
	expected.set(binary, { signature, id: info.build_id });
	return info.build_id;
}

/** Metadata-only compatibility checks. Never inspect AT-SPI before this passes. */
export class DaemonVersion {
	private readonly client: ComputerUseClient;
	private readonly ownerPath: string;
	constructor(private readonly socket: string, env: NodeJS.ProcessEnv) {
		this.client = new ComputerUseClient({ socketPath: socket, timeoutMs: 1500 });
		const home = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), ".local/state");
		this.ownerPath = path.join(home, "pi-computer", `owner-${createHash("sha256").update(socket).digest("hex")}.json`);
	}
	async info(): Promise<Info> {
		let response;
		try { response = await this.client.request({ cmd: "daemon_info" }); }
		catch { throw new Error("Desktop observation blocked: running daemon has no verifiable safety handshake (legacy build). It cannot be safely auto-upgraded without authenticated ownership; no browser action was sent."); }
		const info = response.daemon_info as Info;
		if (!info || info.protocol_version !== 1 || !/^[a-f0-9]{16}$/.test(info.build_id) ||
			!/^[a-f0-9]{32}$/.test(info.instance_id) || !Number.isInteger(info.pid) || info.pid <= 0 ||
			!Array.isArray(info.capabilities) || typeof info.managed !== "boolean" || typeof info.input_stopped !== "boolean" ||
			typeof info.busy !== "boolean" || !Number.isInteger(info.active_workflows) || info.active_workflows < 0)
			throw new Error("Desktop observation blocked: invalid daemon safety handshake; no browser action was sent.");
		return info;
	}
	safe(info: Info): boolean { return REQUIRED.every((cap) => info.capabilities.includes(cap)); }
	remember(info: Info, spawned?: { pid: number; token: string }): void {
		if (!spawned || spawned.pid !== info.pid || !info.managed) return;
		const directory = path.dirname(this.ownerPath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const d = lstatSync(directory);
		if (!d.isDirectory() || d.uid !== process.getuid?.() || (d.mode & 0o077) !== 0) throw new Error("Unsafe daemon ownership directory");
		const temp = `${this.ownerPath}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify({ socket: this.socket, pid: info.pid, instance_id: info.instance_id, token: spawned.token }),
				{ flag: "wx", mode: 0o600 });
			renameSync(temp, this.ownerPath);
		} finally { try { unlinkSync(temp); } catch {} }
	}
	private owner(info: Info): Owner | undefined {
		let fd: number | undefined;
		try {
			fd = openSync(this.ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const s = fstatSync(fd);
			if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 4096) return;
			const o = JSON.parse(readFileSync(fd, "utf8")) as Owner;
			if (o.socket === this.socket && o.pid === info.pid && o.instance_id === info.instance_id &&
				/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(o.token)) return o;
		} catch {} finally { if (fd !== undefined) closeSync(fd); }
	}
	async upgradeIfIdle(info: Info, buildId: string): Promise<boolean> {
		if (info.build_id === buildId || info.input_stopped || info.busy || info.active_workflows > 0 || !info.managed) return false;
		const owner = this.owner(info);
		if (!owner) return false;
		const response = await this.client.request({ cmd: "shutdown_if_idle", instance_id: info.instance_id, token: owner.token });
		if (response.ok !== true) throw new Error("Daemon upgrade was not accepted; no desktop action was sent");
		return true;
	}
}
