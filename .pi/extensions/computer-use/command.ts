import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPUTER_USE_INSTRUCTIONS, computerUseMessage } from "./instructions.js";
import type { ComputerUseMode } from "./mode.js";
import type { ComputerUseRouting } from "./routing.js";

/** A command in the current Pi session; no daemon or agent activity at registration time. */
export function registerComputerUseCommand(pi: ExtensionAPI, mode?: ComputerUseMode, routing?: ComputerUseRouting): void {
	pi.registerCommand("computer-use", {
		description: "Toggle persistent computer-use mode, or send a desktop task; no arguments for help",
		getArgumentCompletions: (prefix) => {
			const values = ["toggle", "on", "off", "instructions", "status", "models hybrid", "models single", "models status", "models sol ", "models luna "].filter((value) => value.startsWith(prefix));
			return values.length ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const task = args.trim();
			if (task === "models" || task.startsWith("models ")) {
				if (!routing) { ctx.ui.notify("Hybrid routing is unavailable in this extension runtime.", "warning"); return; }
				if (!ctx.isIdle()) { ctx.ui.notify("Change routing only while Pi is idle; abort or wait for the current task first.", "warning"); return; }
				try { ctx.ui.notify(await routing.command(task.slice(6).trim() || "status", ctx), "info"); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
				return;
			}
			if (["toggle", "on", "off"].includes(task) && mode) {
				mode.setEnabled(task === "on" || (task === "toggle" && !mode.isEnabled()), ctx);
				ctx.ui.notify(`Computer use ${mode.isEnabled() ? "ON — пиши desktop задачите директно." : "OFF — desktop наблюдението и действията са блокирани."} Изключването не прекъсва текуща задача и не отменя emergency Stop.`, "info");
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
				ctx.ui.notify(`Computer-use: ${tools.length} registered desktop_* tools (${enabled} active). Mode: ${mode?.isEnabled() ? "ON" : "OFF"}. Daemon connectivity and input state not checked; use desktop_ping to check.\nUsage: /computer-use toggle (or on/off) controls direct desktop prompts and a persistent ON bar. OFF blocks desktop observations/actions except emergency Stop and metadata-only ping/metrics. /computer-use <task> requires ON (queued as follow-up if busy). Desktop notifications are sent at final settlement; blockers use Action required (desktop_request_user), user abort is silent. /computer-use models hybrid selects visible same-session Sol planning → Luna execution → one Sol escalation; models single restores the original model; models status shows configured targets. /computer-use instructions shows the rules; /computer-use status shows tool availability.`, "info");
				return;
			}
			if (!mode?.isEnabled()) {
				ctx.ui.notify("Computer use е OFF. Задачата не е изпратена. Първо изпълни /computer-use on; режимът няма да се включи автоматично.", "warning");
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
