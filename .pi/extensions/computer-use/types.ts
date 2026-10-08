export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** One line sent to the computer-use daemon. */
export interface DaemonRequest {
	cmd: string;
	[key: string]: JsonValue | undefined;
}

/** Search results are metadata hints, never durable/actionable node references. */
export interface SeenHit {
	id: string;
	name: string;
	role: string;
	bounds?: { x: number; y: number; width: number; height: number };
	window?: string;
	last_seen_ms: number;
	generation: number;
	source: "current" | "stale";
}

export interface SeenSearch {
	generation: number;
	results: SeenHit[];
}

/** The daemon may return command-specific data; retain it without narrowing. */
export type DaemonResponse = Record<string, unknown>;

export interface ComputerUseClientOptions {
	socketPath?: string;
	timeoutMs?: number;
}

export const DEFAULT_SOCKET_PATH = `/run/user/${typeof process !== "undefined" ? process.getuid?.() ?? process.env.UID ?? "" : ""}/pi-computer.sock`;
export const DEFAULT_TIMEOUT_MS = 30_000;
