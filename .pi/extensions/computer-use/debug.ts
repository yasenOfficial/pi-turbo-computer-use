import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ComputerUseMode } from "./mode.js";
import type { ComputerUseRouting } from "./routing.js";

const ENTRY = "computer-use-debug-v1";
const REPORT_ENTRY = "computer-use-debug-report-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_EVENTS = 2000;
const MAX_BYTES = 1024 * 1024;
const INITIAL_BYTES = MAX_BYTES - 64; // Reserve room for a later explicit user rating.
const DEFAULT_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-computer", "debug");
type EventRow = Record<string, string | number | boolean | null | undefined>;
type Run = {
	id: string; label?: string; started: number; startedAt: string;
	mode: "single" | "hybrid"; events: EventRow[]; omitted: number; modelCalls: EventRow[];
	tools: EventRow[]; usage: Record<string, number>; usageFields: Record<string, number>; modelMessages: number; uncertainUsageMessages: number;
	compactionUsage: Record<string, number>; compactionUsageSamples: Record<string, number>;
	compactionStarts: number; compactionSuccesses: number; compactionFailures: number; overflowRetryOffered: number;
	compaction?: { at: number; reason: string };
	compactionCostReported: number; compactionCostSamples: number;
	costReported: number; costSamples: number; signals: Map<AbortSignal, () => void>;
	spans: Map<string, { row: EventRow; at: number }>; turn?: { at: number; first?: number; selectedThinkingLevel?: string };
	abortedAt?: number; actionRequired: boolean; outcomeHint?: string;
};
const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const safe = (v: unknown): string => typeof v === "string" && SAFE.test(v) ? v : "other";
const model = (m: any): EventRow => ({ provider: safe(m?.provider), modelId: safe(m?.id ?? m?.model), api: safe(m?.api) });
const actionTypes = new Set(["click", "double_click", "drag", "scroll", "keypress", "focus_window", "set_text", "wait", "assert"]);
const stopReasons = new Set(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);
const TOOL_NAME = /^[A-Za-z0-9_]{1,80}$/;
const compactionReasons = new Set(["manual", "threshold", "overflow"]);

/** Opt-in metadata-only observer. Never stores raw prompts, tool arguments/outputs or stream payloads. */
export class ComputerUseDebug {
	private enabled = false;
	private label?: string;
	private sessionId?: string;
	private run?: Run;
	private last?: { path: string; outcome: string; elapsedMs: number; label?: string; routing?: "single" | "hybrid"; tokens?: number; images?: number; taskSuccess?: boolean };
	private warningShown = false;
	private rating = false;
	constructor(private readonly pi: ExtensionAPI, private readonly mode: Pick<ComputerUseMode, "isEnabled">,
		private readonly routing: Pick<ComputerUseRouting, "isHybrid">,
		private readonly runtime: { now: () => number; directory: string; wallNow?: () => number } = { now: () => performance.now(), directory: DEFAULT_DIR }) {
		pi.on("before_agent_start", async (event, ctx) => { void event; await this.begin(ctx); });
		pi.on("turn_start", (_e, ctx) => {
			if (!this.run) return;
			const selectedThinkingLevel = safe(ctx.thinkingLevel ?? this.pi.getThinkingLevel?.());
			this.run.turn = { at: this.runtime.now(), selectedThinkingLevel };
			this.push("turn_start", { selectedThinkingLevel }, ctx);
		});
		pi.on("message_update", (e) => {
			const turn = this.run?.turn;
			if (turn && turn.first === undefined && ["text_delta", "thinking_delta", "toolcall_delta"].includes(e.assistantMessageEvent.type)) turn.first = this.runtime.now();
		});
		pi.on("message_end", (e, ctx) => {
			const run = this.run;
			if (!run || e.message.role !== "assistant") return;
			const msg = e.message;
			run.modelMessages++;
			const row: EventRow = { ...model(msg), thinkingLevel: msg.thinkingLevel === undefined ? undefined : safe(msg.thinkingLevel),
				selectedThinkingLevel: run.turn?.selectedThinkingLevel,
				providerThinkingLevel: msg.providerThinkingLevel === undefined ? undefined : safe(msg.providerThinkingLevel),
				stopReason: stopReasons.has(msg.stopReason) ? msg.stopReason : "other",
				modelTurnMs: run.turn ? this.duration(run.turn.at, run) : undefined,
				firstContentMs: run.turn?.first !== undefined ? Math.max(0, run.turn.first - run.turn.at) : undefined };
			const usage = msg.usage;
			// Zero or absent totals (especially on errors/aborts) can be SDK placeholders.
			if (!number(usage?.totalTokens)) run.uncertainUsageMessages++;
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning"] as const) {
				const value = number(usage?.[field]);
				if (value !== undefined) { row[field] = value; run.usage[field] = (run.usage[field] ?? 0) + value; run.usageFields[field] = (run.usageFields[field] ?? 0) + 1; }
			}
			const cost = number(usage?.cost?.total);
			if (cost !== undefined) { row.catalogCostEstimate = cost; run.costReported += cost; run.costSamples++; }
			// The SDK's errorMessage, diagnostics, responseId and provider stream data are deliberately ignored.
			this.push("assistant_message", row, ctx);
			if (run.modelCalls.length < MAX_EVENTS) run.modelCalls.push(row); else run.omitted++;
			run.turn = undefined;
		});
		pi.on("model_select", (e, ctx) => { this.push("model_select", { ...model(e.model), source: safe(e.source) }, ctx); });
		pi.on("session_before_compact", (e) => {
			const run = this.run;
			if (!run) return; // Idle/manual compaction outside a run is not attributed to a desktop task.
			const reason = compactionReasons.has(e.reason) ? e.reason : "other";
			run.compactionStarts++;
			run.compaction = { at: this.runtime.now(), reason };
			this.push("compaction_start", { reason, willRetry: !!e.willRetry });
		});
		pi.on("session_compact", (e) => {
			const run = this.run;
			if (!run) return;
			const reason = compactionReasons.has(e.reason) ? e.reason : "other";
			const elapsedMs = run.compaction?.reason === reason ? this.duration(run.compaction.at, run) : undefined;
			run.compaction = undefined;
			run.compactionSuccesses++;
			if (reason === "overflow" && e.willRetry) run.overflowRetryOffered++;
			const usage = e.compactionEntry?.usage;
			const row: EventRow = { reason, willRetry: !!e.willRetry, fromExtension: !!e.fromExtension, elapsedMs };
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning"] as const) {
				const value = number(usage?.[field]);
				if (value !== undefined) { row[field] = value; run.compactionUsage[field] = (run.compactionUsage[field] ?? 0) + value;
					run.compactionUsageSamples[field] = (run.compactionUsageSamples[field] ?? 0) + 1; }
			}
			const cost = number(usage?.cost?.total);
			if (cost !== undefined) { row.catalogCostEstimate = cost; run.compactionCostReported += cost; run.compactionCostSamples++; }
			// summary, details, IDs and model attribution are intentionally not inspected or retained.
			this.push("compaction_end", row);
		});
		pi.on("session_compact_failed", (e) => {
			const run = this.run;
			if (!run) return;
			const reason = compactionReasons.has(e.reason) ? e.reason : "other";
			const elapsedMs = run.compaction?.reason === reason ? this.duration(run.compaction.at, run) : undefined;
			run.compaction = undefined;
			run.compactionFailures++;
			this.push("compaction_failed", { reason, willRetry: !!e.willRetry, aborted: !!e.aborted,
				fromExtension: !!e.fromExtension, elapsedMs }); // Never store errorMessage.
		});
		pi.on("tool_execution_start", (e, ctx) => {
			const run = this.run;
			if (!run) return;
			const row: EventRow = { name: this.toolName(e.toolName), nested: !!e.parentToolCallId, atMs: this.duration(run.started, run) };
			if (["desktop_set_text", "desktop_type"].includes(e.toolName) && typeof e.args?.text === "string")
				row.inputTextBytes = Buffer.byteLength(e.args.text);
			if (e.toolName === "desktop_batch" && Array.isArray(e.args?.actions)) {
				row.batchActions = Math.min(e.args.actions.length, 24);
				row.inputTextBytes = e.args.actions.slice(0, 24).reduce((sum: number, action: any) =>
					sum + (action?.type === "set_text" && typeof action.text === "string" ? Buffer.byteLength(action.text) : 0), 0);
				// Only enumerated action types, never values, node ids, coordinates or assertions.
				for (const action of e.args.actions.slice(0, 24)) {
					const type = actionTypes.has(action?.type) ? action.type : "other";
					row[`action_${type}`] = (Number(row[`action_${type}`]) || 0) + 1;
				}
			}
			if (run.tools.length < MAX_EVENTS) { run.tools.push(row); run.spans.set(e.toolCallId, { row, at: this.runtime.now() }); }
			else run.omitted++;
			this.watch(ctx.signal);
			if (e.toolName === "desktop_stop") this.abort(run);
		});
		pi.on("tool_execution_end", (e, ctx) => {
			const run = this.run;
			if (!run) return;
			const span = run.spans.get(e.toolCallId);
			if (span) {
				span.row.elapsedMs = this.duration(span.at, run);
				span.row.error = !!e.isError;
				if (e.toolName === "desktop_batch") {
					const result = e.result?.structuredContent ?? e.result?.details?.response;
					if (Array.isArray(result?.steps)) {
						span.row.batchSteps = Math.min(result.steps.length, 24);
						span.row.batchErrors = result.steps.slice(0, 24).filter((s: any) => s?.error || s?.ok === false).length;
						span.row.batchMatched = result.steps.slice(0, 24).filter((s: any) => s?.matched === true || s?.assertion?.matched === true).length;
					}
				}
				if (Array.isArray(e.result?.content)) {
					span.row.images = e.result.content.filter((block: any) => block?.type === "image").length;
					span.row.imageEncodedChars = e.result.content.reduce((sum: number, block: any) => sum + (block?.type === "image" && typeof block.data === "string" ? block.data.length : 0), 0);
					span.row.textBytes = e.result.content.reduce((sum: number, block: any) => sum + (block?.type === "text" && typeof block.text === "string" ? Buffer.byteLength(block.text) : 0), 0);
				}
				run.spans.delete(e.toolCallId);
			}
			if (e.toolName === "desktop_request_user" && !e.isError) run.actionRequired = true;
			this.push("tool_end", { name: this.toolName(e.toolName), error: !!e.isError }, ctx);
		});
		pi.on("agent_before_settle", (e) => { if (this.run && this.run.abortedAt === undefined) this.run.outcomeHint = e.outcome; });
		pi.on("agent_settled", (_e, ctx) => this.finish(ctx));
		pi.on("session_shutdown", (_e, ctx) => this.finish(ctx, "interrupted"));
	}

	/** Reload alone may restore the opt-in, and only for the identical session/branch. */
	start(ctx: ExtensionContext, reason: string): void {
		this.enabled = false;
		this.label = undefined;
		this.sessionId = ctx.sessionManager.getSessionId?.() ?? (reason === "reload" ? this.sessionId : undefined) ?? randomUUID();
		let saved: any;
		this.last = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === ENTRY) saved = entry.data;
			if (entry.customType === REPORT_ENTRY) {
				const data = entry.data as any;
				if (data?.sessionId === this.sessionId && UUID.test(data.id ?? "")
					&& ["completed", "aborted", "error", "action_required", "continued", "interrupted"].includes(data.outcome)
					&& number(data.elapsedMs) !== undefined) this.last = {
						path: path.join(this.runtime.directory, `${data.id}.json`), outcome: data.outcome,
						elapsedMs: data.elapsedMs, label: LABEL.test(data.label ?? "") ? data.label : undefined,
						routing: ["single", "hybrid"].includes(data.routing) ? data.routing : undefined,
						tokens: number(data.tokens), images: number(data.images),
						taskSuccess: typeof data.taskSuccess === "boolean" && data.userRated === true ? data.taskSuccess : undefined,
					};
			}
		}
		if (reason === "reload" && saved?.sessionId === this.sessionId && saved?.enabled === true) {
			this.enabled = true;
			this.label = LABEL.test(saved.label ?? "") ? saved.label : undefined;
		} else if (saved?.enabled === true) this.pi.appendEntry(ENTRY, { enabled: false, sessionId: this.sessionId });
	}

	async command(args: string, ctx: ExtensionCommandContext): Promise<string> {
		const text = args.trim();
		if (text === "report") return this.last
			? `Debug ${this.last.label ?? "unlabeled"} (${this.last.routing ?? "unknown"}): ${this.last.outcome}, ${Math.round(this.last.elapsedMs)} ms, observed assistant tokens ${this.last.tokens ?? "unknown"}, result images ${this.last.images ?? "unknown"}. Private report: ${this.last.path}. ${this.last.taskSuccess === undefined ? "Task correctness not assessed." : `User-rated task ${this.last.taskSuccess ? "pass" : "fail"}.`}`
			: "No debug report in this extension runtime yet.";
		if (text === "result pass" || text === "result fail") return this.rate(text === "result pass", ctx);
		if (text !== "off" && text !== "on" && !/^on [^\s]+$/.test(text)) throw new Error("Usage: debug on [neutral-label] | off | report | result pass|fail");
		if (!ctx.isIdle() || this.run) throw new Error("Wait for the current task to settle before changing debug settings");
		if (text.startsWith("on ") && !LABEL.test(text.slice(3))) throw new Error("Use a neutral ASCII label (letters, digits, _ or -, at most 64 characters)");
		this.enabled = text !== "off";
		this.label = text.startsWith("on ") ? text.slice(3) : undefined;
		this.sessionId = ctx.sessionManager.getSessionId?.() ?? this.sessionId ?? randomUUID();
		this.pi.appendEntry(ENTRY, { enabled: this.enabled, label: this.label, sessionId: this.sessionId });
		return this.enabled ? "Debug ON; turn Computer use ON separately. Only subsequent Computer use ON runs are recorded." : "Debug OFF; existing private reports are retained.";
	}

	/** Explicit user judgement, not the agent's completion outcome. Never accepts a file path. */
	private async rate(pass: boolean, ctx: ExtensionCommandContext): Promise<string> {
		if (!ctx.isIdle() || this.run || this.rating) throw new Error("Wait for the current task to settle before rating");
		const last = this.last;
		if (!last || (ctx.sessionManager.getSessionId?.() ?? this.sessionId) !== this.sessionId) throw new Error("No report for this session to rate");
		const id = path.basename(last.path, ".json");
		const target = path.join(this.runtime.directory, `${id}.json`);
		if (!UUID.test(id) || last.path !== target) throw new Error("Invalid private report reference");
		this.rating = true;
		let temp: string | undefined;
		try {
			await this.secureDirectory();
			const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			let oldStat;
			let body: string;
			try {
				oldStat = await file.stat();
				if (!oldStat.isFile() || oldStat.uid !== process.getuid() || oldStat.nlink !== 1
					|| (oldStat.mode & 0o777) !== 0o600 || oldStat.size > MAX_BYTES) throw new Error("Unsafe report file");
				body = await file.readFile("utf8");
			} finally { await file.close(); }
			const report = JSON.parse(body);
			if (!report || Array.isArray(report) || report.schemaVersion !== 1 || report.id !== id
				|| report.sessionId !== this.sessionId || report.outcome !== last.outcome
				|| ![null, true, false].includes(report.taskSuccess)
				|| typeof report.userRated !== "boolean") throw new Error("Invalid report contents");
			report.taskSuccess = pass;
			report.userRated = true;
			const updated = JSON.stringify(report);
			if (Buffer.byteLength(updated) > MAX_BYTES) throw new Error("Report exceeds size limit");
			if (this.last !== last) throw new Error("Report changed during rating");
			const current = await lstat(target);
			if (!current.isFile() || current.isSymbolicLink() || current.dev !== oldStat.dev || current.ino !== oldStat.ino
				|| current.uid !== process.getuid() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) throw new Error("Report changed during rating");
			temp = `${target}.${randomUUID()}.tmp`;
			const output = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { await output.writeFile(updated); await output.sync(); } finally { await output.close(); }
			await rename(temp, target); // Atomic replacement in the same private directory, never follows the target.
			temp = undefined;
			last.taskSuccess = pass;
			this.pi.appendEntry(REPORT_ENTRY, { id, sessionId: this.sessionId, outcome: last.outcome,
				elapsedMs: last.elapsedMs, label: last.label, routing: last.routing, tokens: last.tokens,
				images: last.images, taskSuccess: pass, userRated: true });
			return `Last report user-rated ${pass ? "pass" : "fail"}; model completion is not independent verification.`;
		} catch {
			throw new Error("Unable to rate private report safely; verify its owner, permissions and location");
		} finally {
			if (temp) await unlink(temp).catch(() => {});
			this.rating = false;
		}
	}

	private toolName(name: string): string {
		return TOOL_NAME.test(name) && this.pi.getAllTools().some(tool => tool.name === name) ? name : "other";
	}
	private duration(at: number, run: Run): number { return Math.max(0, (run.abortedAt ?? this.runtime.now()) - at); }
	private push(type: string, data: EventRow, _ctx?: ExtensionContext): void {
		const run = this.run;
		if (!run) return;
		if (run.events.length < MAX_EVENTS) run.events.push({ type, atMs: this.duration(run.started, run), ...data });
		else run.omitted++;
	}
	private watch(signal?: AbortSignal): void {
		const run = this.run;
		if (!run || !signal || run.signals.has(signal)) return;
		const listener = () => this.abort(run);
		run.signals.set(signal, listener);
		signal.addEventListener("abort", listener, { once: true });
		if (signal.aborted) listener();
	}
	private abort(run: Run): void { run.abortedAt ??= this.runtime.now(); }
	private async begin(ctx: ExtensionContext): Promise<void> {
		if (this.run) await this.finish(ctx, "continued");
		if (!this.enabled || !this.mode.isEnabled()) return;
		const run: Run = { id: randomUUID(), label: this.label, started: this.runtime.now(), startedAt: new Date(this.runtime.wallNow?.() ?? Date.now()).toISOString(), mode: this.routing.isHybrid() ? "hybrid" : "single", events: [], omitted: 0, modelCalls: [], tools: [],
			usage: {}, usageFields: {}, modelMessages: 0, uncertainUsageMessages: 0, compactionUsage: {}, compactionUsageSamples: {},
			compactionStarts: 0, compactionSuccesses: 0, compactionFailures: 0, overflowRetryOffered: 0,
			compactionCostReported: 0, compactionCostSamples: 0, costReported: 0, costSamples: 0,
			signals: new Map(), spans: new Map(), actionRequired: false };
		this.run = run;
		this.watch(ctx.signal);
		const context = ctx.getContextUsage?.();
		this.push("run_start", { ...model(ctx.model), thinkingLevel: safe(ctx.thinkingLevel), activeToolCountAtBeforeStart: this.pi.getActiveTools().length,
			systemPromptCharsAtBeforeStart: ctx.getSystemPrompt()?.length ?? 0,
			initialContextTokensEstimate: number(context?.tokens), contextWindow: number(context?.contextWindow),
			assistantMessagesBeforeRun: ctx.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant").length });
	}
	private async finish(ctx: ExtensionContext, forced?: string): Promise<void> {
		const run = this.run;
		if (!run) return;
		this.run = undefined; // Detach synchronously; a second settlement cannot write twice.
		for (const [signal, listener] of run.signals) signal.removeEventListener("abort", listener);
		const elapsedMs = this.duration(run.started, run);
		const outcome = run.abortedAt !== undefined || ctx.signal?.aborted ? "aborted" : forced ?? (run.actionRequired ? "action_required" : run.outcomeHint ?? "completed");
		const complete = !forced && run.abortedAt === undefined && !ctx.signal?.aborted && !run.omitted
			&& !run.spans.size && !run.compaction && !run.turn
			&& run.tools.every(row => number(row.elapsedMs) !== undefined && typeof row.error === "boolean");
		const imagesKnown = run.omitted === 0 && run.spans.size === 0 && run.tools.every(row => number(row.images) !== undefined);
		const report = { schemaVersion: 1, id: run.id, sessionId: this.sessionId, label: run.label, routing: run.mode,
			startedAt: run.startedAt,
			outcome, complete, taskSuccess: null, userRated: false, elapsedMs, timingScope: "host-observed (not provider/network-only)",
			usageScope: "observed assistant message_end only; zero/absent usage may be a placeholder; missing fields unknown; tool usage excluded; not total task tokens or provider billing; SDK auto-retry/backoff events are not extension events",
			retryCount: null, totalTaskTokens: null,
			observedAssistantMessages: run.modelMessages, uncertainUsageMessages: run.uncertainUsageMessages,
			usage: run.usage, usageSamples: run.usageFields,
			catalogCostEstimate: run.costSamples ? run.costReported : null, costSamples: run.costSamples,
			compactionScope: "compaction entry usage separate; absent/failed compactions may consume unknown tokens; no model attribution or deduplicated task total",
			compactionStarts: run.compactionStarts, compactionSuccesses: run.compactionSuccesses,
			compactionFailures: run.compactionFailures, overflowRetryOffered: run.overflowRetryOffered,
			compactionUsage: run.compactionUsage, compactionUsageSamples: run.compactionUsageSamples,
			compactionCatalogCostEstimate: run.compactionCostSamples ? run.compactionCostReported : null,
			compactionCostSamples: run.compactionCostSamples, billingCost: null,
			imageScope: "per-tool images count tool_execution_end occurrences; nested results may reappear in parents. transcriptResultImages counts root tool results only, before any tool_result transforms; missing results or truncation are unknown",
			imageOccurrences: imagesKnown ? run.tools.reduce((sum, row) => sum + (number(row.images) ?? 0), 0) : null as number | null,
			transcriptResultImages: imagesKnown ? run.tools.filter(row => row.nested === false).reduce((sum, row) => sum + (number(row.images) ?? 0), 0) : null as number | null,
			omittedEvents: run.omitted, modelCalls: run.modelCalls, tools: run.tools, timeline: run.events };
		try {
			// Drop chunks rather than serializing a near-1MiB report once per removed row.
			// At most logarithmically many serializations per bounded array.
			let body = JSON.stringify(report);
			for (const rows of [report.timeline, report.tools, report.modelCalls]) {
				while (Buffer.byteLength(body) > INITIAL_BYTES && rows.length) {
					const removed = Math.max(1, Math.ceil(rows.length / 4));
					rows.splice(-removed);
					report.omittedEvents += removed;
					report.complete = false;
					report.imageOccurrences = null;
					report.transcriptResultImages = null;
					body = JSON.stringify(report);
				}
			}
			if (Buffer.byteLength(body) > INITIAL_BYTES) throw new Error("Debug report too large");
			await this.secureDirectory();
			const target = path.join(this.runtime.directory, `${run.id}.json`);
			const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { await file.writeFile(body); } finally { await file.close(); }
			// This summary is an observed-assistant subtotal only. Unknown provider retries,
			// missing usage, compaction and truncation must not be presented as task tokens.
			const tokens = report.omittedEvents === 0 && run.compactionStarts === 0 && run.compactionSuccesses === 0
				&& run.compactionFailures === 0 && run.uncertainUsageMessages === 0 && run.modelMessages > 0
				&& run.usageFields.totalTokens === run.modelMessages ? number(run.usage.totalTokens) : undefined;
			const images = number(report.transcriptResultImages);
			this.last = { path: target, outcome, elapsedMs, label: run.label, routing: run.mode, tokens, images };
			this.pi.appendEntry(REPORT_ENTRY, { id: run.id, sessionId: this.sessionId, outcome, elapsedMs, label: run.label, routing: run.mode, tokens, images, taskSuccess: null, userRated: false });
		} catch {
			// Debugging is best-effort: never fail the desktop task or expose paths/error messages.
			if (!this.warningShown && ctx.hasUI && !ctx.signal?.aborted) { this.warningShown = true; ctx.ui.notify("Private debug report could not be saved", "warning"); }
		}
	}
	private async secureDirectory(): Promise<void> {
		const dir = path.resolve(this.runtime.directory);
		let current = path.parse(dir).root;
		for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			try {
				const stat = await lstat(current);
				// Root-owned / and /home are trusted ancestors; /tmp must be sticky.
				// All other ancestors must belong to this user. Never follow a symlink.
				const protectedParent = (stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0;
				if (!stat.isDirectory() || stat.isSymbolicLink() || !protectedParent
					|| (stat.uid !== process.getuid() && stat.uid !== 0)) throw new Error("Unsafe debug directory");
				if (current === dir && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) throw new Error("Debug directory must be owned and private");
			} catch (e: any) {
				if (e?.code !== "ENOENT") throw e;
				await mkdir(current, { mode: 0o700 });
			}
		}
	}
}
