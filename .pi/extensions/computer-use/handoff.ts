import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ComputerUseMode } from "./mode.js";
import { SAVED_LOGIN_POLICY } from "./instructions.js";

/** Local user handoff only. No daemon, credentials, background agent, or nested model. */
export function registerComputerUseHandoff(pi: ExtensionAPI, mode: ComputerUseMode): void {
	pi.registerTool({
		name: "desktop_request_user",
		label: "Computer use · Action required",
		exposure: "model-only",
		description: "Hand a genuinely blocked desktop task back to the user, with an Action required desktop notification at final settlement instead of a completion notification. Use for unavailable or ambiguous saved login, MFA/2FA/CAPTCHA, required permission/clarification, or a verified technical blocker after safe alternatives are exhausted. Explain one concrete next step, then end the turn and wait for the user's reply. This tool does not log in, access credentials, perform desktop input, or grant permission. Never put passwords, tokens, or MFA codes in instructions.",
		promptGuidelines: [
			"For desktop tasks, work autonomously through authorized, safe steps until the requested result is verified. Do not stop at the first recoverable UI error: inspect current state and try a materially different safe approach within a small bounded retry budget. Never repeat uncertain input or expand permission. Do not hand off an ordinary login if the matching account has browser-native saved-password autofill; use the authorized normal login flow. If an unavailable/ambiguous saved login, MFA/2FA/CAPTCHA or other genuine user-only blocker prevents completion, call desktop_request_user with a concrete user step before your final reply. Do not report a blocked task as completed. After the user replies, re-observe and continue in this same session; never wait in a background loop or start another agent.",
			SAVED_LOGIN_POLICY,
		],
		parameters: Type.Object({
			reason: Type.Union([Type.Literal("login"), Type.Literal("mfa"), Type.Literal("captcha"),
				Type.Literal("approval"), Type.Literal("clarification"), Type.Literal("technical")]),
			instructions: Type.String({ minLength: 1, maxLength: 1000,
				description: "Brief actionable instruction in the user's language. No secrets or private chat content." }),
		}, { additionalProperties: false }),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Computer-use request was cancelled");
			const instructions = params.instructions.trim();
			if (!instructions) throw new Error("Action required needs a concrete user instruction");
			mode.requestUser(params.reason, instructions, ctx, signal);
			return {
				content: [{ type: "text", text: JSON.stringify({ status: "action_required", reason: params.reason,
					instructions, next: "Explain the blocker and this step to the user, then end the turn. Wait for their reply; do not perform further desktop operations." }) }],
				details: { status: "action_required", reason: params.reason },
			};
		},
	});
	const blockedSiblings = new Set<string>();
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		blockedSiblings.clear();
		const calls = event.message.content.filter((part) => part.type === "toolCall");
		if (calls.some((call) => call.name === "desktop_request_user")) {
			for (const call of calls) {
				if (call.name.startsWith("desktop_") && !["desktop_request_user", "desktop_stop", "desktop_ping", "desktop_metrics"].includes(call.name)) blockedSiblings.add(call.id);
			}
		}
	});
	pi.on("before_agent_start", () => blockedSiblings.clear());
	pi.on("tool_call", event => {
		if (blockedSiblings.has(event.toolCallId)) return { block: true, reason: "Action required must not run alongside desktop actions. End the turn and wait for the user." };
		if (mode.isWaitingForUser() && event.toolName.startsWith("desktop_")
			&& !["desktop_request_user", "desktop_stop", "desktop_ping", "desktop_metrics"].includes(event.toolName)) {
			return { block: true, reason: "Computer use is waiting for a user action. Explain the required step and end the turn; resume only after their reply." };
		}
	});
}
