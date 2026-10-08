import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPUTER_USE_INSTRUCTIONS, computerUseMessage } from "./instructions.js";
import type { ComputerUseMode } from "./mode.js";

/** A command in the current Pi session; no daemon or agent activity at registration time. */
export function registerComputerUseCommand(pi: ExtensionAPI, mode?: ComputerUseMode): void {
	pi.registerCommand("computer-use", {
		description: "Toggle persistent computer-use mode, or send a desktop task; no arguments for help",
		getArgumentCompletions: (prefix) => {
			const values = ["toggle", "on", "off", "instructions", "status"].filter((value) => value.startsWith(prefix));
			return values.length ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const task = args.trim();
			if (["toggle", "on", "off"].includes(task) && mode) {
				mode.setEnabled(task === "on" || (task === "toggle" && !mode.isEnabled()), ctx);
				ctx.ui.notify(`Computer use ${mode.isEnabled() ? "ON — пиши desktop задачите директно." : "OFF — използвай /computer-use <задача> за отделна задача."} Изключването не прекъсва текуща задача и не отменя emergency Stop.`, "info");
				return;
			}
			if (task === "instructions") {
				ctx.ui.notify(COMPUTER_USE_INSTRUCTIONS, "info");
				return;
			}
			if (!task || task === "status") {
				const tools = pi.getAllTools().filter(({ name }) => name.startsWith("desktop_"));
				const active = new Set(pi.getActiveTools());
				const enabled = tools.filter(({ name }) => active.has(name)).length;
				ctx.ui.notify(`Computer-use: ${tools.length} registered desktop_* tools (${enabled} active). Mode: ${mode?.isEnabled() ? "ON" : "OFF"}. Daemon connectivity and input state not checked; use desktop_ping to check.\nUsage: /computer-use toggle (or on/off) enables direct desktop prompts and a persistent ON bar. /computer-use <task> submits a one-off task (queued as follow-up if busy). Desktop notifications are sent at final settlement; blockers use Action required (desktop_request_user), user abort is silent. /computer-use instructions shows the rules; /computer-use status shows tool availability.`, "info");
				return;
			}
			try {
				// ExtensionCommandContext does not expose sendUserMessage; the documented
				// ExtensionAPI method is bound to this runtime/session. Explicit followUp
				// avoids interrupting a busy run; idle sends start a normal user turn.
				pi.sendUserMessage(computerUseMessage(args), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			} catch (error) {
				ctx.ui.notify(`Could not submit computer-use task: ${error instanceof Error ? error.message : String(error)}. Check this Pi session and try again.`, "error");
			}
		},
	});
}
