import { randomUUID } from "node:crypto";
import { computerUseClient } from "./client.js";

const TTL_MS = 30_000;
const RENEW_MS = 10_000;

type Lease = {
	token: string;
	begin: Promise<boolean>;
	pending?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	signals: Set<AbortSignal>;
};

/** One lease per desktop workflow, not per call or per model turn. No resources until execute. */
export class DesktopWorkflow {
	private lease?: Lease;
	private stopped = false;
	private unsupported = false;
	private warned = false;
	private runSignal?: AbortSignal;

	constructor(
		private readonly request: (request: { cmd: string; action: string; token: string; ttl_ms?: number }) => Promise<unknown> =
			(request) => computerUseClient.request(request),
		private readonly renewMs = RENEW_MS,
	) {}

	private diagnostic(error: unknown): void {
		if (this.warned) return;
		this.warned = true;
		console.warn(`Computer-use workflow glow unavailable (desktop tools still work): ${error instanceof Error ? error.message : String(error)}`);
	}

	private schedule(lease: Lease): void {
		if (this.lease !== lease) return;
		lease.timer = setTimeout(() => {
			lease.timer = undefined;
			if (this.lease !== lease) return;
			lease.pending = this.request({ cmd: "control_activity", action: "renew", token: lease.token, ttl_ms: TTL_MS })
				.then(() => { lease.pending = undefined; this.schedule(lease); })
				.catch((error: unknown) => {
					lease.pending = undefined;
					if (this.lease === lease) {
						this.diagnostic(error);
						void this.close();
					}
				});
		}, this.renewMs);
		lease.timer.unref?.();
	}

	async beforeExecute(name: string, signal?: AbortSignal): Promise<void> {
		if (name === "desktop_stop") {
			// Emergency stop must not wait on a stalled lease IPC request.
			void this.stop().catch((error: unknown) => this.diagnostic(error));
			return;
		}
		if (this.runSignal?.aborted) throw new Error("Desktop workflow was cancelled");
		if (["desktop_ping", "desktop_metrics"].includes(name) || this.stopped || this.unsupported || signal?.aborted) return;
		if (!this.lease) {
			const lease: Lease = { token: randomUUID(), begin: Promise.resolve(false), signals: new Set() };
			this.lease = lease;
			// Assign the lease before making the request: parallel tools share this begin.
			lease.begin = this.request({ cmd: "control_activity", action: "begin", token: lease.token, ttl_ms: TTL_MS })
				.then(() => {
					if (this.lease === lease) this.schedule(lease);
					return true;
				})
				.catch((error: unknown) => {
					if (this.lease === lease) {
						this.unsupported = true;
						this.diagnostic(error);
					}
					return false;
				});
		}
		const lease = this.lease;
		this.watchSignal(this.runSignal);
		this.watchSignal(signal);
		await lease.begin;
		if (this.lease === lease && this.unsupported) await this.close();
		if (this.runSignal?.aborted) throw new Error("Desktop workflow was cancelled");
	}

	/** Called on run cancellation (including while the model is thinking). */
	watchSignal(signal?: AbortSignal): void {
		if (!signal || !this.lease || this.lease.signals.has(signal)) return;
		this.lease.signals.add(signal);
		signal.addEventListener("abort", this.onAbort, { once: true });
		if (signal.aborted) void this.close();
	}

	private readonly onAbort = () => { void this.close(); };

	async close(): Promise<void> {
		const lease = this.lease;
		if (!lease) return;
		this.lease = undefined;
		if (lease.timer) clearTimeout(lease.timer);
		for (const signal of lease.signals) signal.removeEventListener("abort", this.onAbort);
		// End only after begin/renew: a late reply must not recreate an ended lease.
		const begun = await lease.begin;
		await lease.pending;
		if (begun) {
			try { await this.request({ cmd: "control_activity", action: "end", token: lease.token }); }
			catch (error) { this.diagnostic(error); }
		}
	}

	async newRun(signal?: AbortSignal): Promise<void> {
		await this.close();
		this.unsupported = false;
		this.runSignal = signal;
	}

	stop(): Promise<void> {
		this.stopped = true;
		this.runSignal = undefined;
		// close detaches the lease and cancels renewal synchronously, before its
		// promise waits on any begin/renew/end IPC. Shutdown can await that promise.
		return this.close();
	}
}
