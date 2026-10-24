import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComputerUseCommand } from "./command.js";
import { registerComputerUseTools } from "./tools.js";
import { DesktopWorkflow } from "./workflow.js";
import { ComputerUseMode } from "./mode.js";
import { registerComputerUseHandoff } from "./handoff.js";
import { ComputerUseRouting } from "./routing.js";
import { registerVisualPolicy } from "./visual-policy.js";
import { DesktopLoadout } from "./loadout.js";
import { ComputerUseDebug } from "./debug.js";
import { DesktopTarget } from "./target.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Register model-callable tools for the local computer-use daemon. */
export default function computerUseExtension(pi: ExtensionAPI): void {
	const mode = new ComputerUseMode(pi);
	let context: ExtensionContext | undefined;
	let target: DesktopTarget;
	const workflow = new DesktopWorkflow(request => {
		if (!context) throw new Error("No active Pi session for desktop lease");
		return target.lease(request, context);
	});
	target = new DesktopTarget(pi, mode, workflow);
	registerComputerUseTools(pi, workflow, undefined, target);
	const loadout = new DesktopLoadout(pi);
	const routing = new ComputerUseRouting(pi, mode, available => loadout.setRoutingAvailable(available));
	const debug = new ComputerUseDebug(pi, mode, routing);
	registerComputerUseCommand(pi, mode, routing, loadout, debug, target);
	registerComputerUseHandoff(pi, mode);
	registerVisualPolicy(pi, mode, { grant: name => loadout.allowCapture(name), clear: () => loadout.clearCapture() });
	pi.on("session_start", async (event, ctx) => {
		context = ctx;
		mode.start(ctx, event.reason); target.restore(ctx); debug.start(ctx, event.reason);
		await routing.start(ctx); loadout.sync(mode.isEnabled(), routing.isHybrid());
	});
	pi.on("session_tree", async (_event, ctx) => {
		await workflow.close();
		await target.releaseControl(ctx);
		context = ctx;
		// Tree navigation can move from Docker to an older host-ON branch.
		// Never inherit desktop authorization across a branch/target transition.
		mode.restore(ctx);
		mode.setEnabled(false, ctx);
		target.restore(ctx); debug.start(ctx, "tree");
		await routing.start(ctx); loadout.sync(mode.isEnabled(), routing.isHybrid());
	});
	pi.on("before_agent_start", async (event, ctx) => {
		context = ctx;
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
		await target.releaseControl(ctx);
		await mode.notifyCompletion(outcome, ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		// An explicit /browser use may still be preparing an image. Do not let an
		// asynchronous completion enable Computer use after this session shuts down.
		target.interrupt();
		mode.shutdown(ctx);
		await workflow.stop();
		await target.releaseControl(ctx);
		context = undefined;
	});
}
