import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComputerUseCommand } from "./command.js";
import { registerComputerUseTools } from "./tools.js";
import { DesktopDaemonStartup } from "./daemon.js";
import { DesktopWorkflow } from "./workflow.js";
import { ComputerUseMode } from "./mode.js";
import { registerComputerUseHandoff } from "./handoff.js";
import { ComputerUseRouting } from "./routing.js";
import { registerVisualPolicy } from "./visual-policy.js";

/** Register model-callable tools for the local computer-use daemon. */
export default function computerUseExtension(pi: ExtensionAPI): void {
	const workflow = new DesktopWorkflow();
	registerComputerUseTools(pi, workflow, new DesktopDaemonStartup());
	const mode = new ComputerUseMode(pi);
	const routing = new ComputerUseRouting(pi, mode);
	registerComputerUseCommand(pi, mode, routing);
	registerComputerUseHandoff(pi, mode);
	registerVisualPolicy(pi, mode);
	pi.on("session_start", async (event, ctx) => { mode.start(ctx, event.reason); await routing.start(ctx); });
	pi.on("session_tree", async (_event, ctx) => { mode.restore(ctx); await routing.start(ctx); });
	pi.on("before_agent_start", async (event, ctx) => {
		mode.beforeStart(event, ctx);
		await routing.beforeStart(event, ctx);
		await workflow.newRun(ctx.signal);
	});
	pi.on("tool_execution_start", (event, ctx) => { mode.toolStarted(event.toolName, ctx); });
	pi.on("agent_before_settle", (event) => { mode.setOutcome(event.outcome); });
	// agent_end can be followed by retries, compaction, and queued work.
	pi.on("agent_settled", async (_event, ctx) => {
		const outcome = mode.takeCompletion();
		await workflow.close();
		await mode.notifyCompletion(outcome, ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		mode.shutdown(ctx);
		await workflow.stop();
	});
}
