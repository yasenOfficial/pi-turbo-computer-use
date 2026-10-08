import { createConnection, type Socket } from "node:net";
import { DEFAULT_SOCKET_PATH, DEFAULT_TIMEOUT_MS, type ComputerUseClientOptions, type DaemonRequest, type DaemonResponse } from "./types.js";

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

const INPUT_COMMANDS = new Set(["batch", "click", "double_click", "drag", "focus_window", "launch_app", "set_text", "type", "keypress", "scroll"]);
const INPUT_OUTCOME_WARNING = "Operation outcome is uncertain: the daemon may still be executing input after this connection closes. Do not automatically retry. Observe the desktop first; if input continues, use the emergency-stop hotkey or desktop_stop (sticky until daemon restart).";

/** Newline-delimited JSON client. Each request owns a socket, so concurrent tool
 * calls cannot accidentally consume each other's responses.
 */
export class ComputerUseClient {
	readonly socketPath: string;
	readonly timeoutMs: number;

	constructor(options: ComputerUseClientOptions = {}) {
		this.socketPath = options.socketPath ?? process.env.COMPUTER_USE_SOCKET ?? DEFAULT_SOCKET_PATH;
		this.timeoutMs = options.timeoutMs ?? (Number(process.env.COMPUTER_USE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
	}

	request(request: DaemonRequest, signal?: AbortSignal): Promise<DaemonResponse> {
		if (signal?.aborted) return Promise.reject(new Error("Computer-use request was cancelled"));

		return new Promise((resolve, reject) => {
			let socket: Socket | undefined;
			let buffer = "";
			let settled = false;
			let sent = false;
			const uncertain = (message: string) => `${message} ${sent ? INPUT_COMMANDS.has(request.cmd)
				? INPUT_OUTCOME_WARNING : "Request was sent; completion is uncertain."
				: "Request was not sent."}`;
			const finish = (error?: Error, response?: DaemonResponse) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				socket?.destroy();
				if (error) reject(error);
				else resolve(response ?? {});
			};
			const abort = () => finish(new Error(uncertain("Computer-use request was cancelled.")));
			// A requested event wait may legitimately exceed the regular IPC timeout.
			const waitMs = request.cmd === "wait" ? Number(request.timeout_ms ?? request.milliseconds ?? 30_000) : 0;
			const batchWaitMs = request.cmd === "batch" && Array.isArray(request.actions)
				? request.actions.reduce((total, action) => {
					if (!action || typeof action !== "object" || Array.isArray(action)) return total;
					const item = action as Record<string, unknown>;
					if (item.type !== "wait") return total;
					const duration = Number(item.timeout_ms ?? item.milliseconds ?? 30_000);
					return total + (Number.isFinite(duration) ? Math.min(120_000, Math.max(0, duration)) : 30_000);
				}, 0)
				: 0;
			const requestWaitMs = Math.max(Number.isFinite(waitMs) ? Math.min(Math.max(0, waitMs), 120_000) : 0, batchWaitMs);
			const deadlineMs = Math.max(this.timeoutMs, requestWaitMs > 0 ? requestWaitMs + 5_000 : 0);
			const timer = setTimeout(() => finish(new Error(uncertain(`Timed out waiting for daemon at ${this.socketPath}.`))), deadlineMs);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) { abort(); return; }

			try {
				socket = createConnection(this.socketPath);
				socket.setEncoding("utf8");
				socket.once("connect", () => {
					if (settled || signal?.aborted) return;
					sent = true; // Even a partial write may have dispatched the operation.
					socket?.write(`${JSON.stringify(request)}\n`);
				});
				socket.on("data", (chunk: string) => {
					buffer += chunk;
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const line = buffer.slice(0, newline).trim();
					if (!line) return finish(new Error(uncertain("Daemon returned an empty response.")));
					try {
						const parsed: unknown = JSON.parse(line);
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
							return finish(new Error(uncertain("Daemon response must be a JSON object.")));
						}
						const response = parsed as DaemonResponse;
						// Preserve partial batch steps and launch_app ambiguity matches for model-facing errors.
						if ((response.ok === false || response.error) && !(request.cmd === "batch" && response.batch) && request.cmd !== "launch_app") {
							const detail = response.error ?? "daemon rejected the request";
							return finish(new Error(typeof detail === "string" ? detail : JSON.stringify(detail)));
						}
						finish(undefined, response);
					} catch (error) {
						finish(new Error(uncertain(`Invalid JSON response from daemon: ${errorMessage(error)}.`)));
					}
				});
				socket.once("error", (error) => finish(new Error(uncertain(`Computer-use daemon connection failed: ${error.message}.`))));
				socket.once("end", () => {
					if (!settled) finish(new Error(uncertain("Daemon closed the connection before returning a complete response.")));
				});
			} catch (error) {
				finish(new Error(`Could not connect to computer-use daemon: ${errorMessage(error)}`));
			}
		});
	}
}

export const computerUseClient = new ComputerUseClient();
