import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ComputerUseMode } from "./mode.js";

const PREF = "computer-use-routing-preference-v1";
const TASK = "computer-use-routing-task-v1";
const SECTION = "computer_use_routing";
type Ref = { provider: string; id: string };
type Phase = "plan" | "execute" | "escalated";
type Task = { id: string; phase: Phase; active: boolean; disabled?: boolean };
type Preference = { hybrid: boolean; sol?: Ref; luna?: Ref; original?: Ref };
const ref = (model: Model<any>): Ref => ({ provider: model.provider, id: model.id });
const same = (a?: Ref, b?: Ref): boolean => !!a && !!b && a.provider === b.provider && a.id === b.id;
const isRef = (value: any): value is Ref => !!value && typeof value.provider === "string" && !!value.provider && typeof value.id === "string" && !!value.id;
const oldVirtual = (model?: Model<any>): boolean => model?.provider === "computer-use" && model.id === "sol-luna";
function newest(models: Model<any>[]): Model<any> | undefined {
	const version = (id: string) => (id.replace(/-(sol|luna)$/, "").match(/\d+/g) ?? []).map(Number);
	return models.reduce<Model<any> | undefined>((best, model) => {
		if (!best) return model;
		const a = version(model.id), b = version(best.id);
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? model : best;
		}
		return model.id > best.id ? model : best;
	}, undefined);
}

/** Physical model handoffs in the host's native agent loop; no virtual footer or nested model. */
export class ComputerUseRouting {
	private preference: Preference = { hybrid: false };
	private task?: Task;
	private owned?: Ref;
	private expected?: Ref;
	private switching = false;
	private mixedCallIds = new Set<string>();
	constructor(private readonly pi: ExtensionAPI, private readonly mode: ComputerUseMode) {
		pi.registerTool({ name: "desktop_model_phase", label: "Computer use · model handoff", exposure: "model-only",
			description: "Sol hands a bounded plan (verified window/launcher or discovery step, no guessed selectors) to Luna alone; Luna must escalate a re-observed verified technical blocker for Sol review before technical user handoff. Never batch, escalate from one error, or repeat uncertain input.",
			parameters: Type.Object({ phase: Type.Union([Type.Literal("execute"), Type.Literal("escalate")]),
				plan: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
				reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
				verified_state: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
			}, { additionalProperties: false }),
			execute: async (_id, input, signal, _update, ctx) => {
				if (signal?.aborted || ctx.signal?.aborted) throw new Error("Computer-use routing cancelled");
				if (!this.mode.isEnabled()) throw new Error("Computer use is OFF");
				if (this.mode.isWaitingForUser()) throw new Error("Action required: wait for the user's reply");
				const task = this.task;
				if (!this.preference.hybrid || !task?.active || task.disabled || this.switching) throw new Error("No active hybrid desktop task or model switch in progress");
				const from = input.phase === "execute" ? this.preference.sol : this.preference.luna;
				const to = input.phase === "execute" ? this.preference.luna : this.preference.sol;
				const expected = input.phase === "execute" ? "plan" : "execute";
				if (task.phase !== expected || !same(ctx.model ? ref(ctx.model) : undefined, from) || !same(this.owned, from)) throw new Error("Wrong physical model or phase; no handoff performed");
				if (input.phase === "execute" && (!input.plan?.trim() || input.reason || input.verified_state)) throw new Error("Sol handoff requires a bounded plan only");
				if (input.phase === "escalate" && (!input.reason?.trim() || !input.verified_state?.trim() || input.plan)) throw new Error("Escalation requires a reason and current verified state, not a plan");
				await this.switchTo(ctx, to, task.id, signal);
				// No state transition on a failed/uncertain model switch, abort, OFF, or manual override.
				if (this.task !== task || !task.active || task.disabled || !this.mode.isEnabled() || signal?.aborted || ctx.signal?.aborted) {
					this.deactivate(ctx, true);
					throw new Error("Model changed but task was cancelled or disabled; do not replay input");
				}
				const phase: Phase = input.phase === "execute" ? "execute" : "escalated";
				this.task = { ...task, phase };
				this.pi.appendEntry(TASK, this.task);
				this.label(ctx);
				return { content: [{ type: "text", text: input.phase === "execute"
					? `Next native request uses Luna. Plan: ${input.plan.trim()} Resolve unknown/versioned/localized apps with desktop_launch_app({query:product}) first (lookup does not launch); choose a verified returned app_id. For a launch failure, change semantic method, not guessed selectors. After accepted/uncertain dispatch, observe, never replay. Before technical user handoff, re-observe bounded alternatives and escalate a verified blocker to Sol for review.`
					: `Next native request uses Sol; stay on Sol. Reason: ${input.reason.trim()}. Verified: ${input.verified_state.trim()}` }], details: { phase } };
			},
		});
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			this.mixedCallIds.clear();
			const calls = event.message.content.filter(part => part.type === "toolCall");
			if (calls.length > 1 && calls.some(call => call.name === "desktop_model_phase"))
				for (const call of calls) this.mixedCallIds.add(call.id);
		});
		pi.on("tool_call", (event, ctx) => this.guard(event, ctx));
		pi.on("model_select", (event, ctx) => {
			if (this.expected && same(this.expected, ref(event.model))) return;
			if (this.task?.active) this.deactivate(ctx, true);
			// User-selected physical models set the account for the next task; never switch it back.
			this.owned = undefined;
			if (event.model && !oldVirtual(event.model) && !this.task?.active) {
				this.preference.original = ref(event.model);
				if (this.preference.hybrid) {
					try { Object.assign(this.preference, this.choose(ctx, event.model)); }
					catch { this.preference.sol = undefined; this.preference.luna = undefined; }
				}
				this.pi.appendEntry(PREF, this.preference);
				this.label(ctx);
			}
		});
		pi.on("agent_settled", async (_event, ctx) => {
			const task = this.task;
			// Stop/abort disables input, not ownership of the physical model. A manual
			// selection clears owned in model_select and must never be overwritten here.
			const restore = this.owned && same(ctx.model ? ref(ctx.model) : undefined, this.owned) ? this.preference.original : undefined;
			this.deactivate(ctx);
			if (restore && !same(ctx.model ? ref(ctx.model) : undefined, restore) && this.task?.id === task?.id) {
				try { await this.switchTo(ctx, restore, undefined, undefined, true); }
				catch { this.deactivate(ctx, true); } // No automatic retry of an uncertain switch.
			}
			this.owned = undefined;
			this.mixedCallIds.clear();
			this.label(ctx);
		});
		pi.on("session_shutdown", (_event, ctx) => { this.task = undefined; this.owned = undefined; this.mode.setRoutingLabel(undefined, ctx); });
	}

	private available(ctx: ExtensionContext): Model<any>[] {
		return ctx.modelRegistry.getAvailable().filter(m => m.api !== "pi-virtual");
	}
	private resolve(ctx: ExtensionContext, target: Ref | undefined, role: string): Model<any> {
		if (!target) throw new Error(`No saved ${role} physical model; choose an authenticated model in /model`);
		const found = this.available(ctx).find(m => same(ref(m), target));
		if (!found) throw new Error(`${role} ${target.provider}/${target.id} unavailable on this account; check /model or /login in Pi`);
		return found;
	}
	private choose(ctx: ExtensionContext, original: Model<any>): { sol: Ref; luna: Ref } {
		const models = this.available(ctx).filter(m => m.provider === original.provider);
		const sol = /-sol$/.test(original.id) ? original : newest(models.filter(m => /-sol$/.test(m.id)));
		if (!sol) throw new Error(`No authenticated Sol on current account ${original.provider}; check /model or /login`);
		const luna = models.find(m => m.id === sol.id.replace(/-sol$/, "-luna")) ?? newest(models.filter(m => /-luna$/.test(m.id)));
		if (!luna) throw new Error(`No authenticated Luna on current account ${original.provider}; check /model or /login`);
		return { sol: ref(sol), luna: ref(luna) };
	}
	/** Refresh the existing above-editor mode bar after an explicit ON/OFF toggle. */
	refreshLabel(ctx: ExtensionContext): void { this.label(ctx); }
	private label(ctx: ExtensionContext): void {
		const p = this.preference;
		const ids = p.hybrid ? p.sol && p.luna ? `${p.sol.id} → ${p.luna.id}` : "Sol → Luna"
			: `single · ${ctx.model?.id ?? "unknown"}`;
		const phase = this.task?.active ? this.task.phase === "plan" ? " · план: Sol"
			: this.task.phase === "execute" ? " · изпълнява: Luna" : " · блокаж: Sol" : "";
		this.mode.setRoutingLabel(this.mode.isEnabled() ? ids + phase : undefined, ctx);
	}
	private deactivate(ctx: ExtensionContext, disabled = false): void {
		if (!this.task?.active) return;
		this.task = { ...this.task, active: false, disabled };
		this.pi.appendEntry(TASK, this.task);
		this.label(ctx);
	}
	private async switchTo(ctx: ExtensionContext, target: Ref | undefined, taskId?: string, signal?: AbortSignal,
		restoreAtSettlement = false): Promise<void> {
		if (this.switching) throw new Error("Model switch already in progress");
		// Settlement only restores Pi's selected model metadata; it performs no desktop
		// input or agent request. Allow that cleanup even after the run signal aborts.
		if (signal?.aborted || (ctx.signal?.aborted && !restoreAtSettlement)) throw new Error("Computer-use routing cancelled");
		if (taskId && (!this.mode.isEnabled() || !this.task?.active || this.task.id !== taskId)) throw new Error("Hybrid task is no longer active");
		const model = this.resolve(ctx, target, "target");
		if (same(ctx.model ? ref(ctx.model) : undefined, ref(model))) { if (taskId) this.owned = ref(model); return; }
		this.switching = true;
		this.expected = ref(model);
		try {
			if (!await this.pi.setModel(model)) throw new Error(`Unable to select ${model.provider}/${model.id}; check /model or /login`);
			if (!same(ctx.model ? ref(ctx.model) : undefined, ref(model))) throw new Error("Physical model changed during handoff; do not retry uncertain input");
			if (taskId) this.owned = ref(model);
		} finally { this.expected = undefined; this.switching = false; }
	}
	/** Restore branch metadata only; migrate a leftover old virtual selection to its saved physical model. */
	async start(ctx: ExtensionContext): Promise<void> {
		this.preference = { hybrid: false };
		this.task = undefined;
		this.owned = undefined;
		this.mixedCallIds.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PREF) {
				const p = entry.data as Preference;
				if (typeof p?.hybrid === "boolean") this.preference = { hybrid: p.hybrid, sol: isRef(p.sol) ? p.sol : undefined,
					luna: isRef(p.luna) ? p.luna : undefined, original: isRef(p.original) ? p.original : undefined };
			} else if (entry.type === "custom" && entry.customType === TASK) {
				const t = entry.data as Task;
				if (typeof t?.id === "string" && ["plan", "execute", "escalated"].includes(t.phase) && typeof t.active === "boolean") this.task = t;
			}
		}
		if (oldVirtual(ctx.model)) await this.switchTo(ctx, this.preference.original);
		if (ctx.model && !oldVirtual(ctx.model) && !this.task?.active) this.preference.original = ref(ctx.model);
		if (this.task?.active) {
			const target = this.task.phase === "execute" ? this.preference.luna : this.preference.sol;
			if (target && same(ctx.model ? ref(ctx.model) : undefined, target)) this.owned = target;
			else this.deactivate(ctx, true);
		}
		this.label(ctx);
	}
	isHybrid(): boolean { return this.preference.hybrid; }
	summary(ctx: ExtensionContext): string {
		const p = this.preference;
		return `Models: ${p.hybrid ? "hybrid" : "single"}; account ${ctx.model?.provider ?? "unknown"}; Sol ${p.sol?.id ?? "not selected"}; Luna ${p.luna?.id ?? "not selected"}; current ${ctx.model?.id ?? "unknown"}; phase ${this.task?.active ? this.task.phase : "idle"}. Use /computer-use models hybrid or single.`;
	}
	async command(args: string, ctx: ExtensionContext): Promise<string> {
		const text = args.trim();
		if (text === "hybrid") {
			if (this.task?.active) throw new Error("Wait for the active task to settle before changing routing");
			const physical = this.resolve(ctx, ctx.model && !oldVirtual(ctx.model) ? ref(ctx.model) : this.preference.original, "current");
			const selected = this.choose(ctx, physical);
			this.preference = { hybrid: true, original: ref(physical), ...selected };
			this.pi.appendEntry(PREF, this.preference);
			this.label(ctx);
			return "Hybrid ready on current account; physical /model selection unchanged.";
		}
		if (text === "single") {
			if (this.task?.active) throw new Error("Wait for the active task to settle before changing routing");
			this.preference = { ...this.preference, hybrid: false };
			this.pi.appendEntry(PREF, this.preference);
			this.label(ctx);
			return "Single physical model; current /model selection unchanged.";
		}
		throw new Error("Usage: models hybrid|single (bare models shows the summary)");
	}
	/** Called after mode.beforeStart and awaited before the native run begins. */
	async beforeStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
		this.mixedCallIds.clear();
		this.owned = undefined;
		const active = this.preference.hybrid && this.mode.isEnabled();
		const selected = ctx.model && !oldVirtual(ctx.model) ? ref(ctx.model) : this.preference.original;
		if (selected) this.preference.original = selected;
		const task: Task = { id: randomUUID(), phase: "plan", active };
		this.task = task;
		this.pi.appendEntry(TASK, task);
		if (active) {
			try {
				const original = this.resolve(ctx, selected, "current");
				const targets = this.choose(ctx, original); // New user task may use a newly selected account.
				this.preference = { ...this.preference, original: ref(original), ...targets };
				this.pi.appendEntry(PREF, this.preference);
				await this.switchTo(ctx, targets.sol, task.id);
				if (this.task !== task || !this.mode.isEnabled() || ctx.signal?.aborted) throw new Error("Hybrid task cancelled before planning");
				event.systemPromptOptions.sections[SECTION] = "Hybrid desktop task: Sol plans using semantic inspection, verified focus of observed windows and desktop_launch_app({query:product}) metadata lookup (never launch or other input); include a verified window title or discovered launcher ID, or instruct Luna to query if unknown. Call desktop_model_phase({phase:'execute',plan}) alone. Luna must escalate a re-observed verified blocker for Sol review before technical user handoff, via desktop_model_phase({phase:'escalate',reason,verified_state}) alone after bounded materially different alternatives. No automatic escalation from one error or repeat of uncertain input. Both models follow computer-use mode rules. desktop_visual_permission is orchestration, not desktop input.";
			} catch (error) {
				this.deactivate(ctx, true);
				if (ctx.signal?.aborted) return; // User abort is notification-silent.
				const reason = error instanceof Error && /^No authenticated (Sol|Luna) on current account /.test(error.message)
					? error.message : "Hybrid model selection failed on the current account; check /model or /login in Pi";
				event.systemPromptOptions.sections[SECTION] = `Hybrid model selection failed: ${reason}. No desktop action permitted. Explain the missing model; do not call desktop tools or silently fall back to another account.`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				this.label(ctx);
				return; // Pi reports handler exceptions but still starts the agent; fail closed in tool_call.
			}
		} else {
			delete event.systemPromptOptions.sections[SECTION];
			if (oldVirtual(ctx.model)) await this.switchTo(ctx, this.preference.original);
			// OFF does not change an already selected physical model or start desktop work.
		}
		this.label(ctx);
	}
	guard(event: { toolName: string; toolCallId?: string; input?: Record<string, unknown> }, ctx: ExtensionContext): { block: true; reason: string } | undefined {
		if (event.toolName === "desktop_stop" && this.task?.active) { this.deactivate(ctx, true); return; }
		if (this.task?.disabled && event.toolName.startsWith("desktop_") && !["desktop_stop", "desktop_ping", "desktop_metrics"].includes(event.toolName))
			return { block: true, reason: "Computer-use routing disabled for this task; wait for a new user request" };
		if (!this.mode.isEnabled() && event.toolName.startsWith("desktop_") && !["desktop_stop", "desktop_ping", "desktop_metrics"].includes(event.toolName))
			return { block: true, reason: "Computer use is OFF" };
		if (!this.preference.hybrid || !this.task?.active) return;
		if (this.switching && event.toolName.startsWith("desktop_")) return { block: true, reason: "Model handoff in progress; no companion desktop actions" };
		if (event.toolCallId && this.mixedCallIds.has(event.toolCallId)) return { block: true, reason: "desktop_model_phase must be the only tool call in its message" };
		if (ctx.signal?.aborted || this.mode.isWaitingForUser()) return { block: true, reason: "Computer-use task cancelled or waiting for user" };
		const expected = this.task.phase === "execute" ? this.preference.luna : this.preference.sol;
		if (!same(ctx.model ? ref(ctx.model) : undefined, expected) || !same(this.owned, expected)) {
			this.deactivate(ctx, true);
			return { block: true, reason: "Physical model changed midtask; desktop routing disabled" };
		}
		if (event.toolName === "desktop_model_phase") return;
		// Only the executing Luna's technical handoff needs Sol review. Security
		// and clarification requests remain immediate; this cannot prove the
		// model's stated alternatives were actually tried.
		if (this.task.phase === "execute" && event.toolName === "desktop_request_user" && event.input?.reason === "technical")
			return { block: true, reason: "Technical user handoff requires Sol review: re-observe, try bounded materially different safe alternative when authorized, then escalate a verified blocker alone via desktop_model_phase. No automatic escalation/replay." };
		if (event.toolName === "desktop_launch_app" && this.task.phase === "plan") {
			const input = event.input;
			const query = input?.query;
			if (input && !Array.isArray(input) && Object.keys(input).length === 1 && typeof query === "string" &&
				query.trim().length > 0 && Buffer.byteLength(query, "utf8") <= 240 && !/[\x00-\x1f\x7f-\x9f]/u.test(query)) return;
			return { block: true, reason: "Sol may only query installed app metadata (query alone, <=240 UTF-8 bytes, no controls); actual launch requires Luna handoff" };
		}
		if (!event.toolName.startsWith("desktop_") || ["desktop_focus_window", "desktop_observe", "desktop_inspect", "desktop_search_seen", "desktop_changes", "desktop_dirty_regions", "desktop_wait", "desktop_ping", "desktop_metrics", "desktop_request_user", "desktop_visual_permission", "desktop_screenshot", "desktop_inspect_visual"].includes(event.toolName)) return;
		if (this.task.phase === "plan") return { block: true, reason: "Sol planning cannot mutate the desktop; hand off a plan alone first" };
	}
}
