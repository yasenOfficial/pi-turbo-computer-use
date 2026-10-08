import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent, AgentActivityOutcome } from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { COMPUTER_USE_INSTRUCTIONS } from "./instructions.js";
import { sendDesktopCompletion } from "./notification.js";

const ENTRY = "computer-use-mode-v1";
const TIMING_ENTRY = "computer-use-timing-v1";
const WIDGET = "computer-use-mode";
const SECTION = "computer_use_mode";

/** Stateless, terminal-width-aware line; uses Pi's renderer, not a separate TUI. */
export function formatComputerUseDuration(durationMs: number): string {
	const seconds = Math.floor(Math.max(0, durationMs) / 1000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
		: `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function computerUseBar(width: number, suffix = ""): string {
	const label = ` Computer use ON${suffix} `;
	const room = Math.max(0, width - visibleWidth(label));
	return truncateToWidth("─".repeat(Math.floor(room / 2)) + label + "─".repeat(Math.ceil(room / 2)), Math.max(0, width), "");
}

type Activity = {
	requested: boolean;
	usedDesktop: boolean;
	cancelled: boolean;
	outcome: AgentActivityOutcome;
	signals: Map<AbortSignal, () => void>;
	startedAt: number;
	finishedAt?: number;
	ctx: ExtensionContext;
	actionRequired?: string;
};

export type ComputerUseOutcome = AgentActivityOutcome | "action_required";
type Timing = { durationMs: number; outcome: ComputerUseOutcome };
type TimerRuntime = {
	now: () => number;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};

/** Local session mode and settlement notification tracking. No startup/socket/timer work. */
export class ComputerUseMode {
	private enabled = false;
	private activity?: Activity;
	private notificationWarningShown = false;
	private lastTiming?: Timing;
	private ticker?: ReturnType<typeof setInterval>;
	constructor(private readonly pi: ExtensionAPI,
		private readonly notify = sendDesktopCompletion,
		private readonly timer: TimerRuntime = { now: () => performance.now(), setInterval, clearInterval }) {}

	isEnabled(): boolean { return this.enabled; }

	private render(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET, this.enabled ? (_tui, theme) => ({
			render: (width: number) => [theme.fg("accent", computerUseBar(width, this.timingSuffix()))],
			invalidate() {},
		}) : undefined, { placement: "aboveEditor" });
	}

	start(ctx: ExtensionContext, reason: string): void {
		// A fresh Pi process or session replacement must never restore a saved ON.
		this.restore(ctx, reason === "reload");
	}

	restore(ctx: ExtensionContext, restoreMode = true): void {
		this.discard();
		this.enabled = false;
		this.lastTiming = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY) {
				const data = entry.data as { enabled?: unknown } | undefined;
				if (typeof data?.enabled === "boolean") this.enabled = data.enabled;
			} else if (entry.type === "custom" && entry.customType === TIMING_ENTRY) {
				const data = entry.data as Partial<Timing> | undefined;
				if (typeof data?.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0
					&& ["completed", "aborted", "error", "action_required"].includes(data.outcome ?? "")) this.lastTiming = data as Timing;
			}
		}
		if (!restoreMode) {
			if (this.enabled) this.pi.appendEntry(ENTRY, { enabled: false });
			this.enabled = false;
		}
		this.render(ctx);
	}

	setEnabled(enabled: boolean, ctx: ExtensionContext): void {
		// Persist only the boolean, outside model context and on the current branch.
		this.pi.appendEntry(ENTRY, { enabled });
		this.enabled = enabled;
		if (this.activity) this.activity.ctx = ctx;
		this.render(ctx);
		this.syncTicker();
	}

	beforeStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
		const activity = this.ensureActivity(ctx);
		// A new user prompt may resume the work; observe the live desktop again.
		activity.actionRequired = undefined;
		activity.requested ||= this.enabled || Boolean(event.prompt?.startsWith(COMPUTER_USE_INSTRUCTIONS + "\n\nUser task (verbatim):\n"));
		this.watch(ctx.signal);
		this.render(ctx);
		this.syncTicker();
		if (this.enabled) {
			event.systemPromptOptions.sections[SECTION] = `Computer use mode is ON for this session. The user can submit desktop tasks directly without a slash-command prefix. Answer ordinary questions directly when no desktop interaction is needed. This mode does not authorize unrequested actions, enrollment, schedule changes, credential extraction, or destructive operations. Browser-native saved-login use is authorized only within the task and the saved-login rules below.\n${COMPUTER_USE_INSTRUCTIONS}`;
		} else {
			delete event.systemPromptOptions?.sections?.[SECTION];
		}
	}

	toolStarted(name: string, ctx: ExtensionContext): void {
		if (!name.startsWith("desktop_") || ["desktop_ping", "desktop_metrics"].includes(name)) return;
		const activity = this.ensureActivity(ctx);
		activity.usedDesktop = true;
		if (name === "desktop_stop") this.cancel(activity);
		this.watch(ctx.signal);
		this.render(ctx);
		this.syncTicker();
	}

	requestUser(reason: string, instructions: string, ctx: ExtensionContext, signal?: AbortSignal): void {
		const activity = this.ensureActivity(ctx);
		if (activity.cancelled || ctx.signal?.aborted || signal?.aborted) throw new Error("Computer-use request was cancelled");
		activity.requested = true;
		activity.actionRequired = reason;
		this.watch(ctx.signal);
		this.watch(signal);
		this.render(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Action required: ${instructions}`, "warning");
	}

	isWaitingForUser(): boolean { return Boolean(this.activity?.actionRequired); }

	setOutcome(outcome: AgentActivityOutcome): void {
		if (this.activity) {
			this.activity.outcome = outcome;
			if (outcome === "aborted") this.cancel(this.activity);
		}
	}

	private watch(signal?: AbortSignal): void {
		const activity = this.activity;
		if (!activity || !signal || activity.signals.has(signal)) return;
		const listener = () => { this.cancel(activity); };
		activity.signals.set(signal, listener);
		signal.addEventListener("abort", listener, { once: true });
		if (signal.aborted) listener();
	}

	/** Detach before awaiting cleanup/notifications so a later run cannot be cleared. */
	takeCompletion(): ComputerUseOutcome | undefined {
		const activity = this.activity;
		this.discard();
		if (!activity || !(activity.requested || activity.usedDesktop)) return;
		const outcome = activity.cancelled || activity.outcome === "aborted" ? "aborted"
			: activity.actionRequired ? "action_required" : activity.outcome;
		this.lastTiming = { durationMs: this.elapsed(activity), outcome };
		this.pi.appendEntry(TIMING_ENTRY, this.lastTiming);
		this.render(activity.ctx);
		if (outcome !== "aborted") return outcome;
	}

	async notifyCompletion(outcome?: ComputerUseOutcome, ctx?: ExtensionContext): Promise<void> {
		// User cancellation is silent, including an abort observed during lease cleanup.
		if (!outcome || outcome === "aborted" || ctx?.signal?.aborted) return;
		const sent = await this.notify(outcome);
		if (!sent && !this.notificationWarningShown && ctx?.hasUI) {
			this.notificationWarningShown = true;
			ctx.ui.notify("Computer use: системната нотификация не беше доставена. Проверете notify-send и desktop notification service.", "warning");
		}
	}

	private ensureActivity(ctx: ExtensionContext): Activity {
		const activity = this.activity ??= { requested: false, usedDesktop: false, cancelled: false,
			outcome: "completed", signals: new Map(), startedAt: this.timer.now(), ctx };
		activity.ctx = ctx;
		return activity;
	}

	private elapsed(activity: Activity): number {
		return Math.max(0, (activity.finishedAt ?? this.timer.now()) - activity.startedAt);
	}

	private timingSuffix(): string {
		const activity = this.activity;
		if (activity && (activity.requested || activity.usedDesktop))
			return ` · ${formatComputerUseDuration(this.elapsed(activity))}${activity.cancelled ? " (abort)" : activity.actionRequired ? " · Action required" : ""}`;
		if (!this.lastTiming) return "";
		return ` · последно: ${formatComputerUseDuration(this.lastTiming.durationMs)}${this.lastTiming.outcome === "aborted" ? " (abort)" : this.lastTiming.outcome === "error" ? " (error)" : this.lastTiming.outcome === "action_required" ? " · Action required" : ""}`;
	}

	private cancel(activity: Activity): void {
		activity.cancelled = true;
		activity.finishedAt ??= this.timer.now();
		if (this.activity === activity) {
			this.stopTicker();
			this.render(activity.ctx);
		}
	}

	private syncTicker(): void {
		const activity = this.activity;
		const needed = this.enabled && activity && (activity.requested || activity.usedDesktop) && !activity.cancelled
			&& activity.ctx.mode === "tui" && activity.ctx.hasUI;
		if (!needed) { this.stopTicker(); return; }
		if (this.ticker) return;
		this.ticker = this.timer.setInterval(() => {
			if (this.activity === activity) this.render(activity.ctx);
		}, 1000);
		this.ticker.unref?.();
	}

	private stopTicker(): void {
		if (this.ticker) this.timer.clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private discard(): void {
		this.stopTicker();
		const activity = this.activity;
		this.activity = undefined;
		for (const [signal, listener] of activity?.signals ?? []) signal.removeEventListener("abort", listener);
	}

	shutdown(ctx: ExtensionContext): void {
		this.discard();
		if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
	}
}
