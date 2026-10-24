import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerUseMode } from "./mode.js";
import type { ComputerUseRouting } from "./routing.js";
import type { DesktopLoadout } from "./loadout.js";
import type { ComputerUseDebug } from "./debug.js";
import type { DesktopTarget } from "./target.js";

/** A command in the current Pi session; no daemon or agent activity at registration time. */
export function registerComputerUseCommand(pi: ExtensionAPI, mode?: ComputerUseMode, routing?: ComputerUseRouting, loadout?: DesktopLoadout, debug?: ComputerUseDebug, target?: DesktopTarget): void {
	pi.registerCommand("computer-use", {
		description: "Toggle persistent computer-use mode, or send a desktop task; no arguments for help",
		getArgumentCompletions: (prefix) => {
			const values = ["toggle", "on", "off", "models", "models hybrid", "models single", "debug on", "debug off", "debug report", "debug result pass", "debug result fail", "host", "docker build", "docker start", "docker status", "docker stop", "docker pause", "docker resume", "docker migrate"].filter((value) => value.startsWith(prefix));
			return values.length ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const task = args.trim();
			if (task === "host" || task === "docker" || task.startsWith("docker ")) {
				if (!target) { ctx.ui.notify("Docker target routing is unavailable.", "warning"); return; }
				try { ctx.ui.notify(await target.command(task, ctx), "info"); routing?.refreshLabel(ctx); loadout?.sync(mode?.isEnabled() === true, routing?.isHybrid()); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Docker command failed", "error"); }
				return;
			}
			if (task === "debug" || task.startsWith("debug ")) {
				if (!debug) { ctx.ui.notify("Debug reporting is unavailable in this runtime.", "warning"); return; }
				try { ctx.ui.notify(await debug.command(task.slice(5).trim() || "report", ctx), "info"); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Debug command failed", "warning"); }
				return;
			}
			if (task === "models" || task.startsWith("models ")) {
				if (!routing) { ctx.ui.notify("Hybrid routing is unavailable in this extension runtime.", "warning"); return; }
				if (task === "models") { ctx.ui.notify(routing.summary(ctx), "info"); return; }
				if (!ctx.isIdle()) { ctx.ui.notify("Change routing only while Pi is idle; abort or wait for the current task first.", "warning"); return; }
				try {
					ctx.ui.notify(await routing.command(task.slice(6).trim(), ctx), "info");
					loadout?.sync(mode?.isEnabled() === true, routing.isHybrid());
				}
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
				return;
			}
			if (["toggle", "on", "off"].includes(task) && mode) {
				const enabled = task === "on" || (task === "toggle" && !mode.isEnabled());
				if (enabled && target) {
					try { await target.enable(ctx); }
					catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Selected desktop target unavailable", "error"); return; }
				}
				if (!enabled) target?.interrupt();
				mode.setEnabled(enabled, ctx);
				routing?.refreshLabel(ctx);
				loadout?.sync(mode.isEnabled(), routing?.isHybrid());
				ctx.ui.notify(`Computer use ${mode.isEnabled() ? "ON — пиши desktop задачите директно." : "OFF — desktop наблюдението и действията са блокирани."} Изключването не прекъсва текуща задача и не отменя emergency Stop.`, "info");
				return;
			}
			if (["instructions", "status"].includes(task)) {
				ctx.ui.notify("This subcommand was removed. Use /computer-use for help or /computer-use models for routing information.", "warning");
				return;
			}
			if (!task) {
				const tools = pi.getAllTools().filter(({ name }) => name.startsWith("desktop_"));
				const active = new Set(pi.getActiveTools());
				const enabled = tools.filter(({ name }) => active.has(name)).length;
				ctx.ui.notify(`Computer-use: ${tools.length} registered desktop_* tools (${enabled} active). Mode: ${mode?.isEnabled() ? "ON" : "OFF"}. Target: ${target?.target ?? "host"}. Daemon connectivity and input state not checked; use desktop_ping to check.\nUsage: /computer-use toggle (or on/off) controls direct desktop prompts and a persistent ON bar. OFF blocks desktop observations/actions except emergency Stop and metadata-only ping/metrics. /computer-use <task> requires ON (queued as follow-up if busy). Desktop notifications are sent at final settlement; blockers use Action required (desktop_request_user), user abort is silent. /computer-use models hybrid automatically selects Sol/Luna from the currently selected account/provider for visible same-session Sol planning → Luna execution → one Sol escalation; models single restores the original model; /computer-use models shows routing information. No provider/model IDs need to be entered. Docker target: /computer-use docker build (explicit image build), docker start (selects isolated container, reuses its private persistent browser profile, stays OFF), docker status (localhost passwordless viewer link; legacy containers require explicit docker migrate before removal), docker migrate (OFF+idle; acknowledge legacy Stop, import into a private persistent profile, then replace the browser; never automatic), docker pause (OFF + abort + sticky daemon Stop; wait for acknowledgement before manual takeover), docker resume (explicit daemon-only restart, stays OFF), docker stop (OFF first; keeps the private profile; refuses unmigrated legacy ephemeral containers), /computer-use host (OFF first, explicit host selection). Docker failure never falls back to host. Optional private metrics: /computer-use debug on <neutral-label>, debug report, debug result pass|fail, debug off. Debug never enables computer use or records raw task/UI/image content.`, "info");
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
				pi.sendUserMessage(args, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			} catch (error) {
				ctx.ui.notify(`Could not submit computer-use task: ${error instanceof Error ? error.message : String(error)}. Check this Pi session and try again.`, "error");
			}
		},
	});
}
