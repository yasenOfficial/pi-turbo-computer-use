import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerUseMode } from "./mode.js";

type Capture = "desktop_screenshot" | "desktop_inspect_visual" | "desktop_observe";
type Target = { id: string } | { x: number; y: number; width: number; height: number } | { full_screen: true };
type Permit = { capture: Capture; target: Target };

function captureTarget(name: string, input: Record<string, unknown>): Target | undefined {
	if (name === "desktop_observe") return input.screenshot === true ? { full_screen: true } : undefined;
	if (name === "desktop_inspect_visual") return input.id === undefined ? { full_screen: true }
		: typeof input.id === "string" && input.id.trim() ? { id: input.id } : undefined;
	if (name !== "desktop_screenshot") return undefined;
	const fields = ["x", "y", "width", "height"] as const;
	if (fields.every((field) => input[field] === undefined)) return { full_screen: true };
	if (fields.every((field) => Number.isInteger(input[field]) && (input[field] as number) >= 0 &&
		(field === "x" || field === "y" || (input[field] as number) > 0))) {
		return { x: input.x as number, y: input.y as number, width: input.width as number, height: input.height as number };
	}
	return undefined;
}

function sameTarget(a: Target, b: Target): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Model-declared, single-use capture authorization; this cannot verify the user's actual intent. */
export function registerVisualPolicy(pi: ExtensionAPI, mode?: Pick<ComputerUseMode, "isWaitingForUser">,
	declarations?: { grant: (name: string) => void; clear: () => void }): void {
	let permit: Permit | undefined;
	// message_end precedes tool execution: reject BOTH siblings before either can run.
	const mixedCallIds = new Set<string>();
	let stopped = false;
	let grantSignal: AbortSignal | undefined;
	let onAbort: (() => void) | undefined;
	const clear = (consuming = false) => {
		permit = undefined;
		if (!consuming) declarations?.clear();
		if (grantSignal && onAbort) grantSignal.removeEventListener("abort", onAbort);
		grantSignal = undefined;
		onAbort = undefined;
	};
	// Stop remains sticky within this extension runtime, including session changes.
	// Restarting the daemon after Stop also requires reloading the extension.
	const reset = () => { clear(); mixedCallIds.clear(); };
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		mixedCallIds.clear();
		const calls = event.message.content.filter((part) => part.type === "toolCall");
		if (calls.some((call) => call.name === "desktop_visual_permission") && calls.some((call) =>
			call.name === "desktop_screenshot" || call.name === "desktop_inspect_visual" ||
			(call.name === "desktop_observe" && call.arguments?.screenshot === true))) {
			clear(); // Also invalidate an unused permit from an earlier message.
			for (const call of calls) {
				if (call.name === "desktop_visual_permission" || call.name === "desktop_screenshot" ||
					call.name === "desktop_inspect_visual" || (call.name === "desktop_observe" && call.arguments?.screenshot === true))
					mixedCallIds.add(call.id);
			}
		}
	});
	pi.registerTool({
		name: "desktop_visual_permission",
		label: "Desktop visual capture permission",
		exposure: "model-only",
		description: "Declare why ONE exact desktop image is necessary. Call this separately; grant and capture in the same assistant message are BOTH blocked regardless of execution order. Use only for an explicit user screenshot request or after a concrete semantic blocker remains after bounded AT-SPI/windows/GIO attempts. Model declaration is visible in the tool transcript, not independent proof of user intent. No OS notification. Never use shell/IPC screenshots. Permission expires on use, abort, settlement, or next run.",
		parameters: Type.Object({
			basis: Type.Union([Type.Literal("explicit_user_request"), Type.Literal("semantic_blocker")]),
			reason: Type.String({ minLength: 20, maxLength: 500, description: "For explicit requests cite the user's screenshot request; for blockers explain the concrete inaccessible UI and why semantic attempts failed. For full screen state why missing layout requires it (or cite the explicit full-screen request)." }),
			checks: Type.Array(Type.String({ minLength: 3, maxLength: 240 }), { maxItems: 5,
				description: "Bounded semantic attempts (e.g. desktop_observe, desktop_search_seen, desktop_inspect, windows/GIO) and their results; required for semantic_blocker. Omitted compact output is not proof of inaccessibility." }),
			capture: Type.Union([Type.Literal("desktop_screenshot"), Type.Literal("desktop_inspect_visual"), Type.Literal("desktop_observe")]),
			target: Type.Union([
			Type.Object({ id: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false }),
			Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
			Type.Object({ full_screen: Type.Literal(true) }, { additionalProperties: false }),
		]),
		}, { additionalProperties: false }),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_id, params, signal, _update, ctx) {
			clear(); // Invalid requests cannot leave an earlier authorization alive.
			if (stopped || mode?.isWaitingForUser() || signal?.aborted || ctx.signal?.aborted) throw new Error("Visual permission unavailable: stopped, awaiting user, or cancelled");
			const reason = params.reason.trim();
			const checks = params.checks.map((check) => check.trim());
			if (reason.length < 20 || checks.some((check) => check.length < 3 ||
				(!/\b(?:desktop_\w+|AT-SPI|GIO)\b/i.test(check) && check.length < 12)) ||
				(params.basis === "semantic_blocker" && !checks.length)) throw new Error("Provide a concrete reason and bounded semantic checks");
			if (params.basis === "explicit_user_request" && !/\b(?:user|requested|asked)\b/i.test(reason))
				throw new Error("Cite the user's explicit screenshot request in the reason");
			const target = params.target;
			if ((params.capture === "desktop_observe" && !("full_screen" in target)) ||
				(params.capture === "desktop_inspect_visual" && ("x" in target)) ||
				(params.capture === "desktop_screenshot" && ("id" in target))) throw new Error("Capture target does not match the named desktop tool");
			if ("full_screen" in target && !/(layout|full.screen|whole screen|entire screen)/i.test(reason))
				throw new Error("Full-screen capture needs a stated missing-layout need or explicit full-screen request");
			permit = { capture: params.capture, target };
			grantSignal = signal ?? ctx.signal;
			if (grantSignal) {
				onAbort = () => clear();
				grantSignal.addEventListener("abort", onAbort, { once: true });
				if (grantSignal.aborted) { clear(); throw new Error("Visual permission cancelled"); }
			}
			declarations?.grant(params.capture);
			return { content: [{ type: "text", text: JSON.stringify({ granted: true, single_use: true,
				capture: params.capture, target, basis: params.basis, reason, checks }) }],
				details: { capture: params.capture, target, basis: params.basis, reason, checks } };
		},
	});
	pi.on("tool_call", (event, ctx) => {
		if (mixedCallIds.delete(event.toolCallId)) {
			clear();
			return { block: true, reason: "Visual permission and capture must be in separate assistant messages: grant first, then request one matching capture." };
		}
		if (event.toolName === "desktop_stop") { clear(); stopped = true; return; }
		if (event.toolName !== "desktop_screenshot" && event.toolName !== "desktop_inspect_visual" &&
			!(event.toolName === "desktop_observe" && event.input.screenshot === true)) return;
		// Consume before checking: wrong target, invalid arguments, cancellation, or downstream block
		// must never leave a permit reusable. Parallel sibling captures cannot share it.
		const current = permit;
		clear(true); // Keep the current declaration through execution; withdraw on tool_execution_end.
		const target = captureTarget(event.toolName, event.input);
		if (stopped || mode?.isWaitingForUser() || ctx.signal?.aborted || !current || current.capture !== event.toolName ||
			!target || !sameTarget(current.target, target)) {
			declarations?.clear();
			return { block: true, reason: "Visual capture blocked: request one matching desktop_visual_permission after semantic checks or an explicit user screenshot request." };
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (["desktop_screenshot", "desktop_inspect_visual", "desktop_observe"].includes(event.toolName) && !permit) declarations?.clear();
	});
	pi.on("before_agent_start", reset);
	pi.on("agent_settled", reset);
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);
}
