import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComputerUseCommand } from "./command.js";
import { registerComputerUseTools } from "./tools.js";
import { DesktopDaemonStartup } from "./daemon.js";
import { DesktopWorkflow } from "./workflow.js";
import { ComputerUseMode } from "./mode.js";
import { registerComputerUseHandoff } from "./handoff.js";
import { ComputerUseRouting } from "./routing.js";
import { registerVisualPolicy } from "./visual-policy.js";
import { DesktopLoadout } from "./loadout.js";
import { ComputerUseDebug } from "./debug.js";

/** Register model-callable tools for the local computer-use daemon. */
export default function computerUseExtension(pi: ExtensionAPI): void {
	const workflow = new DesktopWorkflow();
	registerComputerUseTools(pi, workflow, new DesktopDaemonStartup());
	const mode = new ComputerUseMode(pi);
	const routing = new ComputerUseRouting(pi, mode);
	const loadout = new DesktopLoadout(pi);
	const debug = new ComputerUseDebug(pi, mode, routing);
	registerComputerUseCommand(pi, mode, routing, loadout, debug);
	registerComputerUseHandoff(pi, mode);
	registerVisualPolicy(pi, mode, { grant: name => loadout.allowCapture(name), clear: () => loadout.clearCapture() });
	pi.on("session_start", async (event, ctx) => {
		mode.start(ctx, event.reason); debug.start(ctx, event.reason);
		await routing.start(ctx); loadout.sync(mode.isEnabled(), routing.isHybrid());
	});
	pi.on("session_tree", async (_event, ctx) => {
		mode.restore(ctx); debug.start(ctx, "tree");
		await routing.start(ctx); loadout.sync(mode.isEnabled(), routing.isHybrid());
	});
	pi.on("before_agent_start", async (event, ctx) => {
		mode.beforeStart(event, ctx);
		await routing.beforeStart(event, ctx);
		loadout.sync(mode.isEnabled(), routing.isHybrid());
		await workflow.newRun(ctx.signal);
	});
	pi.on("tool_execution_start", (event, ctx) => { mode.toolStarted(event.toolName, ctx); });
	pi.on("agent_before_settle", (event) => { mode.setOutcome(event.outcome); });
	// agent_end can be followed by retries, compaction, and queued work.
	pi.on("agent_settled", async (_event, ctx) => {
		const outcome = mode.takeCompletion();
		loadout.clearCapture();
		await workflow.close();
		await mode.notifyCompletion(outcome, ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		mode.shutdown(ctx);
		await workflow.stop();
	});
}
