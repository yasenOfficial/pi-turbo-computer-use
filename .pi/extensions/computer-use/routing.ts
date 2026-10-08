import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ComputerUseMode } from "./mode.js";

const PROVIDER = "computer-use";
const ID = "sol-luna";
const PREF = "computer-use-routing-preference-v1";
const TASK = "computer-use-routing-task-v1";
const SECTION = "computer_use_routing";
const STATUS = "computer-use-routing";
type Ref = { provider: string; id: string };
type Phase = "plan" | "execute" | "escalated";
type Task = { id: string; phase: Phase; active: boolean; disabled?: boolean };
type State = { taskId: string; phase: Phase };
type Preference = { hybrid: boolean; sol?: Ref; luna?: Ref; original?: Ref };
const isRef = (value: any): value is Ref => Boolean(value && typeof value.provider === "string" && value.provider && typeof value.id === "string" && value.id);
const ref = (model: Model<any>): Ref => ({ provider: model.provider, id: model.id });
const same = (a: Ref | undefined, b: Ref | undefined): boolean => !!a && !!b && a.provider === b.provider && a.id === b.id;
const virtual = (model: Model<any> | undefined): boolean => model?.provider === PROVIDER && model.id === ID;

/** Same native Pi turn; no nested model invocation or background work. */
export class ComputerUseRouting {
	private preference: Preference = { hybrid: false };
	private task?: Task;
	private dispatched?: Ref;
	private mixedCallIds = new Set<string>();
	constructor(private readonly pi: ExtensionAPI, private readonly mode: ComputerUseMode) {
		if (typeof pi.registerVirtualModel === "function") pi.registerVirtualModel<State>({ provider: PROVIDER, id: ID, name: "Computer use · Sol → Luna", thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
			route: (request, ctx) => this.route(request, ctx),
		});
		pi.registerTool({ name: "desktop_model_phase", label: "Computer use · model handoff", exposure: "model-only",
			description: "In hybrid desktop tasks only: Sol passes a bounded plan to Luna with phase execute; Luna may request one Sol escalation with a reason and current verified state. No desktop action; call alone, never in a batch with other tools. No escalation on tool error or retry.",
			parameters: Type.Object({ phase: Type.Union([Type.Literal("execute"), Type.Literal("escalate")]),
				plan: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
				reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
				verified_state: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
			}, { additionalProperties: false }),
			execute: async (_id, input, signal, _onUpdate, ctx) => {
				if (signal?.aborted || ctx.signal?.aborted) throw new Error("Computer-use routing cancelled");
				if (!mode.isEnabled()) throw new Error("Computer use is OFF; desktop_model_phase is unavailable");
				if (mode.isWaitingForUser()) throw new Error("Action required: wait for the user's reply");
				if (!virtual(ctx.model) || !this.preference.hybrid || !this.task?.active) throw new Error("No active hybrid desktop task");
				const expected = input.phase === "execute" ? "plan" : "execute";
				const physical = input.phase === "execute" ? this.preference.sol : this.preference.luna;
				if (this.task.phase !== expected || !same(this.dispatched, physical)) throw new Error("Wrong model or phase for desktop_model_phase; no transition performed");
				if (input.phase === "execute" && (!input.plan?.trim() || input.reason || input.verified_state)) throw new Error("Sol handoff requires a bounded plan only");
				if (input.phase === "escalate" && (!input.reason?.trim() || !input.verified_state?.trim() || input.plan)) throw new Error("Escalation requires a reason and current verified state, not a plan");
				// A tool error alone is never evidence for escalation. Only an explicit verified blocker is.
				if (input.phase === "escalate" && !input.verified_state.trim()) throw new Error("Re-observe and verify current state before escalating");
				const phase = input.phase === "execute" ? "execute" : "escalated";
				this.task = { ...this.task, phase };
				pi.appendEntry(TASK, this.task);
				this.status(ctx);
				return { content: [{ type: "text", text: input.phase === "execute"
					? `Handoff accepted. Next native request routes to Luna. Plan: ${input.plan.trim()}`
					: `One escalation accepted. Next native request routes to Sol; remain on Sol for this task. Reason: ${input.reason.trim()}. Verified state: ${input.verified_state.trim()}` }], details: { phase } };
			},
		});
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			this.mixedCallIds.clear();
			const calls = event.message.content.filter((part) => part.type === "toolCall");
			if (calls.some((call) => call.name === "desktop_model_phase") && calls.length !== 1)
				for (const call of calls) this.mixedCallIds.add(call.id);
		});
		pi.on("tool_call", (event, ctx) => this.guard(event, ctx));
		pi.on("model_select", (event, ctx) => {
			if (this.task?.active && virtual(event.previousModel) && !virtual(event.model)) this.deactivate(ctx, true);
		});
		pi.on("agent_settled", (_event, ctx) => {
			this.deactivate(ctx);
			this.dispatched = undefined;
			this.mixedCallIds.clear();
			this.status(ctx);
		});
		pi.on("session_shutdown", (_event, ctx) => { this.dispatched = undefined; this.task = undefined; this.clear(ctx); });
	}

	private available(ctx: ExtensionContext): Model<any>[] {
		return ctx.modelRegistry.getAvailable().filter((m) => m.api !== "pi-virtual" && !virtual(m));
	}
	private resolve(ctx: ExtensionContext, target: Ref | undefined, label: string): Model<any> {
		if (!target) throw new Error(`No ${label} model selected; configure models ${label} provider/id`);
		const model = this.available(ctx).find((m) => same(ref(m), target));
		if (!model) throw new Error(`${label} ${target.provider}/${target.id} is unavailable or missing authentication; configure models ${label} provider/id`);
		return model;
	}
	private choose(ctx: ExtensionContext): Preference {
		const models = this.available(ctx);
		let sol = this.preference.sol;
		if (!sol) {
			if (ctx.model && !virtual(ctx.model) && /-sol$/.test(ctx.model.id) && models.some(m => same(ref(m), ref(ctx.model!)))) sol = ref(ctx.model);
			else {
				const candidates = models.filter(m => /-sol$/.test(m.id));
				if (candidates.length !== 1) throw new Error(`Sol target ${candidates.length ? "ambiguous" : "unavailable"}; configure models sol provider/id`);
				sol = ref(candidates[0]);
			}
		}
		this.resolve(ctx, sol, "sol");
		let luna = this.preference.luna;
		if (!luna) {
			const family = { provider: sol.provider, id: sol.id.replace(/-sol$/, "-luna") };
			if (family.id !== sol.id && models.some(m => same(ref(m), family))) luna = family;
			else {
				const candidates = models.filter(m => m.provider === sol!.provider && /-luna$/.test(m.id));
				if (candidates.length !== 1) throw new Error(`Luna target ${candidates.length ? "ambiguous" : "unavailable"} for ${sol.provider}; configure models luna provider/id`);
				luna = ref(candidates[0]);
			}
		}
		this.resolve(ctx, luna, "luna");
		if (same(sol, luna)) throw new Error("Sol and Luna must be different physical models");
		return { ...this.preference, sol, luna };
	}
	private persist(): void { this.pi.appendEntry(PREF, this.preference); }
	private status(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS, this.preference.hybrid && virtual(ctx.model)
			? `Hybrid ${this.task?.active ? this.task.phase : "idle"} · Sol → Luna${this.task?.phase === "escalated" ? " → Sol" : ""}` : undefined);
	}
	private clear(ctx: ExtensionContext): void { if (ctx.hasUI) ctx.ui.setStatus(STATUS, undefined); }
	private deactivate(ctx: ExtensionContext, disabled = false): void {
		if (!this.task?.active) return;
		this.task = { ...this.task, active: false, disabled };
		this.pi.appendEntry(TASK, this.task);
		this.status(ctx);
	}
	start(ctx: ExtensionContext): void {
		this.preference = { hybrid: false };
		this.task = undefined;
		this.dispatched = undefined;
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
		this.status(ctx);
	}
	/** args after `models `; parent owns slash command dispatch. */
	async command(args: string, ctx: ExtensionContext): Promise<string> {
		const text = args.trim();
		if (text === "status") return `Models: ${this.preference.hybrid ? "hybrid" : "single"}${typeof this.pi.registerVirtualModel !== "function" ? " (hybrid unavailable: upgrade Pi SDK for registerVirtualModel)" : ""}; Sol ${this.preference.sol ? `${this.preference.sol.provider}/${this.preference.sol.id}` : "auto"}; Luna ${this.preference.luna ? `${this.preference.luna.provider}/${this.preference.luna.id}` : "auto"}; phase ${this.task?.active ? this.task.phase : "idle"}.`;
		if (text === "hybrid") {
			if (typeof this.pi.registerVirtualModel !== "function") throw new Error("Computer-use hybrid requires a Pi SDK with registerVirtualModel (docs/virtual-models.md); upgrade Pi or use models single.");
			const selected = this.choose(ctx);
			const original = virtual(ctx.model) ? this.preference.original : ctx.model ? ref(ctx.model) : undefined;
			if (!original) throw new Error("Select an authenticated physical model before enabling hybrid (needed for ordinary prompts)");
			this.resolve(ctx, original, "original");
			const vm = ctx.modelRegistry.find(PROVIDER, ID);
			if (!vm) throw new Error("Virtual model computer-use/sol-luna is not registered; reload with a compatible Pi SDK");
			if (!await this.pi.setModel(vm)) throw new Error("Unable to select computer-use/sol-luna; check SDK model availability");
			this.preference = { ...selected, original, hybrid: true }; this.persist(); this.status(ctx);
			return "Hybrid selected: computer-use/sol-luna (visible in /model).";
		}
		if (text === "single") {
			if (virtual(ctx.model)) {
				const original = this.resolve(ctx, this.preference.original, "original");
				if (!await this.pi.setModel(original)) throw new Error("Cannot restore original physical model; hybrid selection unchanged");
			}
			this.preference = { ...this.preference, hybrid: false }; this.task = undefined; this.persist(); this.clear(ctx);
			return "Single physical model selected; hybrid routing disabled.";
		}
		const match = /^(sol|luna)\s+([^\s/]+)\/([^\s/]+)$/.exec(text);
		if (match) {
			const key = match[1] as "sol" | "luna";
			const target = { provider: match[2], id: match[3] };
			this.resolve(ctx, target, key);
			if (!new RegExp(`-${key}$`).test(target.id)) throw new Error(`${key} model id must end in -${key}`);
			if (this.task?.active) throw new Error("Cannot reconfigure physical models during an active task");
			this.preference = { ...this.preference, [key]: target }; this.persist(); this.status(ctx);
			return `${key} set to ${target.provider}/${target.id}.`;
		}
		throw new Error("Usage: models hybrid|single|status|sol provider/id|luna provider/id");
	}
	beforeStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
		this.dispatched = undefined;
		this.mixedCallIds.clear();
		const active = this.preference.hybrid && virtual(ctx.model) && this.mode.isEnabled();
		this.task = { id: randomUUID(), phase: "plan", active: Boolean(active) };
		this.pi.appendEntry(TASK, this.task);
		if (active) {
			this.choose(ctx); // fail closed before any request when auth or selection changed
			event.systemPromptOptions.sections[SECTION] = "Hybrid desktop task: Sol plans using semantic inspection only (focus_window is permitted for inspection). Sol must call desktop_model_phase({phase:'execute',plan}) alone to hand off; Luna executes and verifies. Luna may call desktop_model_phase({phase:'escalate',reason,verified_state}) alone at most once after re-observing a verified blocker, not on a tool error/retry. Sol then remains responsible; never repeat uncertain input. No parallel companion desktop actions. Both models obey the computer-use rules in the mode section. desktop_visual_permission is an orchestration tool, not physical desktop input.";
		} else delete event.systemPromptOptions.sections[SECTION];
		this.status(ctx);
	}
	private route(request: ModelRouteRequest<State>, ctx: ExtensionContext) {
		if (request.signal?.aborted) throw new Error("Computer-use routing cancelled");
		const task = this.task;
		if (request.reason === "direct") {
			const target = (request.previous && this.available(ctx).find(m => same(ref(m), ref(request.previous!.model))))
				?? this.resolve(ctx, this.dispatched ?? this.preference.original ?? this.preference.sol, "direct");
			return { model: target, thinkingLevel: request.thinkingLevel };
		}
		if (task?.disabled && request.reason !== "user") throw new Error("Computer-use routing disabled for this task. Start a new user task to resume.");
		if (task?.active && !this.mode.isEnabled()) throw new Error("Computer use is OFF; routing cannot continue this task");
		if (!this.preference.hybrid || !task?.active) {
			const model = this.resolve(ctx, this.preference.original, "original");
			this.dispatched = ref(model);
			return { model, thinkingLevel: request.thinkingLevel };
		}
		// The request state is branch-local and durable across compaction. The task entry
		// records tool handoffs before Pi's next route and resets on each user prompt.
		const phase = task.phase;
		const chosen = phase === "execute" ? this.preference.luna : this.preference.sol;
		const model = this.resolve(ctx, chosen, phase === "execute" ? "luna" : "sol");
		if (request.reason === "retry") {
			const sticky = request.failed ?? request.previous;
			if (sticky && !same(ref(sticky.model), ref(model))) {
				// Never treat a failed model request as a handoff or a reason to escalate.
				const failed = this.resolve(ctx, ref(sticky.model), "retry");
				this.dispatched = ref(failed);
				return { model: failed, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel, state: request.state };
			}
		}
		if (request.reason === "continuation" && !same(ref(model), this.dispatched) && this.dispatched &&
			!((phase === "execute" && same(this.dispatched, this.preference.sol)) || (phase === "escalated" && same(this.dispatched, this.preference.luna))))
			throw new Error("Physical model changed midtask; routing disabled until a new task");
		this.dispatched = ref(model);
		return { model, thinkingLevel: request.thinkingLevel,
			state: request.state?.taskId === task.id && request.state.phase === phase ? request.state : { taskId: task.id, phase } };
	}
	/** Optional parent hook if its own tool-call registration order needs an explicit guard. */
	guard(event: { toolName: string; toolCallId?: string; input?: unknown }, ctx: ExtensionContext): { block: true; reason: string } | undefined {
		if (this.task?.disabled && event.toolName.startsWith("desktop_") &&
			!["desktop_stop", "desktop_ping", "desktop_metrics"].includes(event.toolName))
			return { block: true, reason: "Computer-use routing disabled for this task; wait for a new user request" };
		if (!this.preference.hybrid || !this.task?.active) return;
		if (event.toolName === "desktop_stop") { this.deactivate(ctx, true); return; }
		if (!this.mode.isEnabled() && event.toolName.startsWith("desktop_") &&
			!["desktop_ping", "desktop_metrics"].includes(event.toolName))
			return { block: true, reason: "Computer use is OFF" };
		if (!virtual(ctx.model) && event.toolName.startsWith("desktop_") && event.toolName !== "desktop_stop") {
			this.deactivate(ctx, true);
			return { block: true, reason: "Physical model changed midtask; desktop routing disabled" };
		}
		if (!virtual(ctx.model)) return;
		if (event.toolCallId && this.mixedCallIds.has(event.toolCallId)) return { block: true, reason: "desktop_model_phase must be the only tool call in its assistant message" };
		if (ctx.signal?.aborted) return { block: true, reason: "Computer-use routing cancelled" };
		if (this.mode.isWaitingForUser() && event.toolName !== "desktop_stop") return { block: true, reason: "Action required: wait for the user's reply" };
		if (event.toolName === "desktop_model_phase") return;
		if (!event.toolName.startsWith("desktop_") || ["desktop_focus_window", "desktop_observe", "desktop_inspect", "desktop_search_seen", "desktop_changes", "desktop_dirty_regions", "desktop_wait", "desktop_ping", "desktop_metrics", "desktop_stop", "desktop_request_user", "desktop_visual_permission", "desktop_screenshot", "desktop_inspect_visual"].includes(event.toolName)) return;
		if (this.task.phase === "plan" || (this.task.phase === "execute" && !same(this.dispatched, this.preference.luna))) {
			return { block: true, reason: "Planning cannot mutate the desktop; hand off a plan to Luna alone first" };
		}
		if (this.task.phase === "escalated" && !same(this.dispatched, this.preference.sol)) return { block: true, reason: "Escalation handoff pending; no companion desktop actions" };
	}
}
