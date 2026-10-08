import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Registered desktop tools remain behind the mode and visual-policy tool_call gates.
// This only controls declarations sent to the model; it is not authorization.
const OFF = ["desktop_stop", "desktop_ping", "desktop_metrics"] as const;
const ON = [
	...OFF,
	"desktop_observe", "desktop_changes", "desktop_search_seen", "desktop_inspect",
	"desktop_batch", "desktop_launch_app", "desktop_set_text", "desktop_focus_window",
	"desktop_keypress", "desktop_scroll", "desktop_click", "desktop_wait",
	"desktop_request_user", "desktop_visual_permission",
] as const;
const CAPTURES = new Set(["desktop_screenshot", "desktop_inspect_visual"]);

/** Session-local model declaration selection. Call sync only after tools are registered and mode is restored. */
export class DesktopLoadout {
	private enabled = false;
	private hybrid = false;
	private routingAvailable = true;
	private capture?: string;

	constructor(private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">) {}

	/** Reset any pending capture on run/session/settlement or mode transition. */
	sync(enabled: boolean, hybrid = false): void {
		this.enabled = enabled;
		this.hybrid = hybrid;
		this.capture = undefined;
		this.apply();
	}

	/** Routing declarations only; never clears a pending visual permit or non-desktop tools. */
	setRoutingAvailable(available: boolean): void {
		if (this.routingAvailable === available) return;
		this.routingAvailable = available;
		this.apply();
	}

	/** Invoke ONLY after visual-policy successfully grants this exact capture. Not a permission check. */
	allowCapture(name: string): void {
		if (!this.enabled || !CAPTURES.has(name)) return;
		this.capture = name;
		this.apply();
	}

	/** Invoke on capture attempt (including failure/block), abort, Stop, settlement and session change. */
	clearCapture(): void {
		if (this.capture === undefined) return;
		this.capture = undefined;
		this.apply();
	}

	private apply(): void {
		const registered = new Set(this.pi.getAllTools().map(tool => tool.name));
		const selected = this.enabled ? ON : OFF;
		const desktop = [...selected, ...(this.enabled && this.hybrid && this.routingAvailable ? ["desktop_model_phase"] : []),
			...(this.enabled && this.capture ? [this.capture] : [])].filter(name => registered.has(name));
		const active = this.pi.getActiveTools();
		const next = [...active.filter(name => !name.startsWith("desktop_")), ...desktop];
		// Avoid needless transcript/tool-set deltas on every lifecycle notification.
		if (active.length !== next.length || active.some((name, index) => name !== next[index])) this.pi.setActiveTools(next);
	}
}
