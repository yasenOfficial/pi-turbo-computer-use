import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computerUseClient } from "./client.js";
import type { DesktopDaemonStartup } from "./daemon.js";
import type { DaemonRequest, JsonValue } from "./types.js";

interface CommandDefinition {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	readOnly?: boolean;
}

const id = Type.Optional(Type.String({ description: "Semantic accessibility node id from an observation" }));
const xy = {
	x: Type.Optional(Type.Integer({ description: "Absolute horizontal screen coordinate" })),
	y: Type.Optional(Type.Integer({ description: "Absolute vertical screen coordinate" })),
};
const target = Type.Optional(Type.Object({
	role: Type.Optional(Type.String()), name: Type.Optional(Type.String()), id: Type.Optional(Type.String()),
}));
const waitCondition = Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), role: Type.Optional(Type.String()) });
const assertExpected = Type.Object({
	name: Type.Optional(Type.String({ maxLength: 240 })),
	value: Type.Optional(Type.Union([Type.String({ maxLength: 16_384 }), Type.Null()])),
	enabled: Type.Optional(Type.Boolean()), visible: Type.Optional(Type.Boolean()), focused: Type.Optional(Type.Boolean()),
}, { additionalProperties: false, minProperties: 1 });
const batchAction = Type.Union([
	Type.Object({ type: Type.Literal("click"), id, target, ...xy, physical: Type.Optional(Type.Boolean()), button: Type.Optional(Type.String()), clicks: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }),
	Type.Object({ type: Type.Literal("double_click"), id, target, ...xy }),
	Type.Object({ type: Type.Literal("wait"), since: Type.Optional(Type.Integer({ minimum: 0 })), condition: Type.Optional(waitCondition), timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })), milliseconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })) }),
	Type.Object({ type: Type.Literal("set_text"), id, text: Type.String(), target }),
	Type.Object({ type: Type.Literal("assert"), target: waitCondition, expected: assertExpected }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("keypress"), key: Type.String() }),
	Type.Object({ type: Type.Literal("focus_window"), title: Type.String() }),
	Type.Object({ type: Type.Literal("scroll"), direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]), amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), ...xy }),
	Type.Object({ type: Type.Literal("drag"), from_x: Type.Integer(), from_y: Type.Integer(), to_x: Type.Integer(), to_y: Type.Integer(), button: Type.Optional(Type.String()), steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) }),
]);
const commands: CommandDefinition[] = [
	{
		name: "desktop_batch", label: "Desktop batch",
		description: "Run 1–24 ordered desktop actions/checks in one IPC request. Use wait for transitions, then assert exact live name/value/enabled/visible/focused fields of a unique semantic target (value:null means no value). No rollback; stop at first failure by default. Assertions never read password values.",
		parameters: Type.Object({ actions: Type.Array(batchAction, { minItems: 1, maxItems: 24 }), stop_on_error: Type.Optional(Type.Boolean()), include_changes: Type.Optional(Type.Boolean()) }),
	},
	{
		name: "desktop_launch_app", label: "Launch installed app",
		description: "For authorized GUI presentation, query installed app metadata by product name (query; no dispatch), or launch by verified exact desktop ID / localized name. Select the intended app_id from bounded matches; never guess a versioned ID. accepted is not window readiness: wait/observe. No commands, paths or arguments.",
		parameters: Type.Union([
			Type.Object({ query: Type.String({ minLength: 1, maxLength: 240, pattern: "^(?=.*\\S)[^\\x00-\\x1F\\x7F-\\x9F]+$", description: "Find up to 20 installed app candidates without launching; select an exact returned app_id before dispatch" }) }, { additionalProperties: false }),
			Type.Object({ app_id: Type.String({ minLength: 9, maxLength: 240, pattern: "^[A-Za-z0-9_-][A-Za-z0-9._-]*\\.desktop$" }) }, { additionalProperties: false }),
			Type.Object({ name: Type.String({ minLength: 1, maxLength: 240, pattern: "^(?=.*\\S)[^\\x00-\\x1F\\x7F-\\x9F]+$" }) }, { additionalProperties: false }),
		]),
	},
	{
		name: "desktop_dirty_regions", label: "Screen dirty regions",
		description: "On demand, detect changed screen tiles and report merged dirty rectangles. No image is sent.",
		parameters: Type.Object({}), readOnly: true,
	},
	{
		name: "desktop_observe", label: "Observe desktop",
		description: "Read X11 windows and accessible UI only when GUI interaction is needed or explicitly requested; use Pi read/write/edit/bash for files/code/commands. A uniquely matched active frame shows its linked descendants plus a proved showing Cinnamon popup; otherwise output is a short overview (up to 24 top nodes), not proof other nodes are inaccessible. Counts show omissions; use desktop_search_seen to find omitted controls and desktop_inspect for a selected node. Daemon history remains complete. Screenshot off by default.",
		parameters: Type.Object({
			since: Type.Optional(Type.Integer({ minimum: 0, description: "Return a delta from this generation" })),
			screenshot: Type.Optional(Type.Boolean({ default: false, description: "Capture a screenshot (off by default)" })),
		}), readOnly: true,
	},
	{
		name: "desktop_metrics", label: "Desktop metrics",
		description: "Read bounded daemon stage timing diagnostics; reset counters only when explicitly requested.",
		parameters: Type.Object({ reset: Type.Optional(Type.Boolean({ description: "Clear metrics counters after reading them (default false)" })) }), readOnly: true,
	},
	{
		name: "desktop_search_seen", label: "Search seen UI",
		description: "Search bounded in-memory accessible UI metadata from this daemon lifetime. Current/stale IDs are hints only: observe and revalidate the current AT-SPI node before acting. Never click a historical result directly. No images or editable values are stored. App-provided names and X11 window titles can contain sensitive text unrelated to editable fields.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 240, description: "Case-insensitive query ranked by exact name, name prefix/token, substring, then role/window; current then recent within rank" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		}), readOnly: true,
	},
	{
		name: "desktop_changes", label: "Desktop changes",
		description: "Read X11 windows and accessibility changes since a generation (or the last observation). A uniquely matched active frame scopes linked changes plus a proved showing Cinnamon popup; otherwise output is a short overview (up to 24 top nodes). Removed IDs retain their unfiltered scope; search_seen/inspect can recover omitted control detail.",
		parameters: Type.Object({ since: Type.Optional(Type.Integer({ minimum: 0 })) }), readOnly: true,
	},
	{
		name: "desktop_click", label: "Click",
		description: "Click a semantic node id, or an absolute screen position.",
		parameters: Type.Object({
			id,
			...xy,
			button: Type.Optional(Type.String()),
			clicks: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Number of clicks (1–5)" })),
			physical: Type.Optional(Type.Boolean({ description: "Force physical pointer input" })),
		}),
	},
	{
		name: "desktop_double_click", label: "Double-click",
		description: "Physically double-click a semantic node id or absolute screen position.",
		parameters: Type.Object({ id, ...xy }),
	},
	{
		name: "desktop_drag", label: "Drag",
		description: "Drag the pointer between absolute screen coordinates.",
		parameters: Type.Object({
			from_x: Type.Integer(), from_y: Type.Integer(), to_x: Type.Integer(), to_y: Type.Integer(),
			button: Type.Optional(Type.String()), steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
		}),
	},
	{
		name: "desktop_focus_window", label: "Focus window",
		description: "Focus a window by title.",
		parameters: Type.Object({ title: Type.String() }),
	},
	{
		name: "desktop_inspect_visual", label: "Inspect visually",
		description: "Capture the full screen or the visual crop of an accessibility node.",
		parameters: Type.Object({
			id,
			incremental: Type.Optional(Type.Boolean({ description: "Return only changed image patches (requires id)" })),
			since_visual: Type.Optional(Type.Integer({ minimum: 0, description: "Revision from the previous incremental visual response" })),
		}), readOnly: true,
	},
	{
		name: "desktop_set_text", label: "Set text",
		description: "Replace the complete value of a revalidated editable semantic node with id, using native AT-SPI. Without id this is legacy SHORT layout-dependent typing. Use Pi write/edit for ordinary files/code, desktop_paste_text for GUI insertion/long Unicode; never retry uncertain text input via another method.",
		parameters: Type.Object({ id, text: Type.String() }),
	},
	{
		name: "desktop_type", label: "Type text",
		description: "Set text semantically when id is supplied; otherwise type SHORT layout-dependent text into the focused control using native keyboard input. For long or Unicode text explicitly choose desktop_paste_text; never automatically retry a failed setter/typing operation as paste.",
		parameters: Type.Object({ id, text: Type.String() }),
	},
	{
		name: "desktop_paste_text", label: "Paste text into verified field",
		description: "Paste up to 65536 UTF-8 bytes via the native clipboard into an already focused, visible, enabled, non-password editable field. Use a fresh exact semantic target (id/name/role) when available; a supplied target never falls back to declared focus. Without target, supply the exact active window_title; semantic focus is tried first. Only if no known focused text field exists, after explicitly focusing the intended GUI field, set focus_verified:true to allow declared active-window focus (not independent proof). No implicit caret/selection, Ctrl+A or submit. The daemon preselects Ctrl+V only when the active layout maps Latin v, otherwise Shift+Insert; apps may not support either, and it never switches layout or retries another shortcut. Clipboard is restored when possible; dispatched is not proof of field contents. On uncertain outcome do not retry automatically; observe/read back. Unsupported Wayland fails before input. For short layout-dependent legacy typing only, use desktop_type explicitly; it is not an automatic fallback.",
		parameters: Type.Object({
			text: Type.String({ maxLength: 65_536 }),
			target: Type.Optional(Type.Object({
				id: Type.Optional(Type.String({ maxLength: 240 })),
				name: Type.Optional(Type.String({ maxLength: 240 })),
				role: Type.Optional(Type.String({ maxLength: 240 })),
			}, { minProperties: 1, additionalProperties: false })),
			window_title: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
			focus_verified: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
	},
	{
		name: "desktop_keypress", label: "Press key",
		description: "Press a key or key chord using the daemon's key notation.",
		parameters: Type.Object({ key: Type.String({ description: "For example Return or Ctrl+L" }) }),
	},
	{
		name: "desktop_scroll", label: "Scroll",
		description: "Scroll in a direction, optionally at an absolute screen position.",
		parameters: Type.Object({
			...xy,
			direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
			amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		}),
	},
	{
		name: "desktop_inspect", label: "Inspect node",
		description: "Inspect one accessibility node by semantic id.",
		parameters: Type.Object({ id: Type.String() }), readOnly: true,
	},
	{
		name: "desktop_screenshot", label: "Screenshot",
		description: "Capture the screen, or a rectangular absolute screen region, as an image. Provide all of x, y, width, and height for a region; omit all four for the full screen.",
		parameters: Type.Object({
			x: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
			y: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
			width: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
			height: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
		}), readOnly: true,
	},
	{
		name: "desktop_wait", label: "Wait",
		description: "Wait for accessibility changes, optionally from a generation, up to 120 seconds.",
		parameters: Type.Object({
			since: Type.Optional(Type.Integer({ minimum: 0 })),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
			milliseconds: Type.Optional(Type.Integer({ minimum: 0 })),
			condition: Type.Optional(Type.Object({
				id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), role: Type.Optional(Type.String()),
			})),
		}), readOnly: true,
	},
	{
		name: "desktop_stop", label: "Stop daemon input",
		description: "Permanently disable input until the daemon is restarted.",
		parameters: Type.Object({}),
	},
	{
		name: "desktop_ping", label: "Ping daemon",
		description: "Check whether the computer-use daemon is reachable.",
		parameters: Type.Object({}), readOnly: true,
	},
];

function asJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(asJsonValue);
	if (typeof value === "object") {
		const object: { [key: string]: JsonValue } = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) object[key] = asJsonValue(item);
		}
		return object;
	}
	throw new Error("Tool arguments must contain only JSON values");
}

const MAX_NODES = 90;
const MAX_UNSCOPED_NODES = 24;
const MAX_TEXT = 20_000;
const MAX_OBSERVATION_TEXT = 6_000;
const MAX_FIELD = 240;

function pasteParameters(params: unknown): void {
	if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid paste parameters; no desktop action was sent");
	const fields = params as Record<string, unknown>;
	if (Object.keys(fields).some(key => !["text", "target", "window_title", "focus_verified"].includes(key)) ||
		typeof fields.text !== "string" || Buffer.byteLength(fields.text, "utf8") > 65_536 ||
		(fields.focus_verified !== undefined && typeof fields.focus_verified !== "boolean") ||
		(fields.window_title !== undefined && (typeof fields.window_title !== "string" || !fields.window_title || Buffer.byteLength(fields.window_title, "utf8") > 240)))
		throw new Error("Invalid paste text, title or UTF-8 byte length; no desktop action was sent");
	if (fields.target !== undefined) {
		const target = fields.target;
		if (!target || typeof target !== "object" || Array.isArray(target) || !Object.keys(target).length ||
			Object.entries(target).some(([key, value]) => !["id", "name", "role"].includes(key) || typeof value !== "string" || Buffer.byteLength(value, "utf8") > 240))
			throw new Error("Invalid paste target selector (maximum 240 UTF-8 bytes per field); no desktop action was sent");
	} else if (fields.window_title === undefined) {
		throw new Error("Paste without a target requires an exact active window_title; no desktop action was sent");
	}
}

function daemonCommand(toolName: string): string {
	const commands: Record<string, string> = { desktop_set_text: "set_text", desktop_type: "type", desktop_batch: "batch", desktop_dirty_regions: "dirty_regions" };
	const command = commands[toolName] ?? toolName.replace(/^desktop_/, "");
	const supported = new Set([
		"observe", "changes", "click", "double_click", "drag", "focus_window", "inspect", "inspect_visual",
		"set_text", "type", "paste_text", "keypress", "scroll", "screenshot", "wait", "stop", "ping", "batch", "dirty_regions", "search_seen", "metrics", "launch_app",
	]);
	if (!supported.has(command)) throw new Error(`Unsupported desktop command: ${toolName}`);
	return command;
}

function nodePriority(value: unknown): number {
	if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
	const node = value as Record<string, unknown>;
	const role = typeof node.role === "string" ? node.role.toLowerCase() : "";
	const named = typeof node.name === "string" && node.name.trim().length > 0;
	const actionable = /button|link|entry|text|check|radio|combo|menu|tab|slider|spin|toggle|list item|tree item/.test(role);
	return (actionable ? 2 : 0) + (named ? 1 : 0) + (node.focused === true ? (actionable ? 10 : 5) : 0) + (typeof node.value === "string" ? 2 : 0);
}

function conciseNode(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const node = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of ["id", "role", "name", "value", "value_read_failed", "enabled", "visible", "focused", "actions", "parent", "bounds"]) {
		const field = node[key];
		if (field === undefined) continue;
		if (typeof field === "string") {
			const limit = key === "value" ? MAX_TEXT / 2 : MAX_FIELD;
			result[key] = field.length > limit ? `${field.slice(0, limit)}…` : field;
		}
		else result[key] = field;
	}
	return result;
}

function scopeActiveWindow(response: Record<string, unknown>): Record<string, unknown> {
	const activeWindows = Array.isArray(response.windows) ? response.windows.filter((window) =>
		window && typeof window === "object" && !Array.isArray(window) && (window as Record<string, unknown>).active === true) as Record<string, unknown>[] : [];
	if (activeWindows.length !== 1) return response;
	const active = activeWindows[0];
	if (typeof active.title !== "string" || !active.title) return response;
	const key = response.snapshot ? "snapshot" : "delta";
	// Delta-only changes often lack a frame; never infer ownership from a title
	// alone. Similarly, do not scope a mixed/ambiguous response.
	if (response.snapshot && response.delta) return response;
	const data = response[key] as Record<string, unknown> | undefined;
	const collection = key === "snapshot" ? "nodes" : "changed";
	if (!data || !Array.isArray(data[collection])) return response;
	const nodes = data[collection] as unknown[];
	const frames = nodes.filter((node) => node && typeof node === "object" && !Array.isArray(node) &&
		["frame", "dialog"].includes((node as Record<string, unknown>).role as string) &&
		(node as Record<string, unknown>).name === active.title) as Record<string, unknown>[];
	if (frames.length !== 1 || typeof frames[0].id !== "string" || !frames[0].id) return response;
	const frame = frames[0];
	const byId = new Map<string, Record<string, unknown>>();
	const children = new Map<string, string[]>();
	for (const candidate of nodes) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const node = candidate as Record<string, unknown>;
		if (typeof node.id !== "string" || !node.id || byId.has(node.id)) return response;
		byId.set(node.id, node);
		if (typeof node.parent === "string") {
			const siblings = children.get(node.parent) ?? [];
			siblings.push(node.id);
			children.set(node.parent, siblings);
		}
	}
	// Some trees carry children but omit parent links. Honor explicit child IDs
	// only when they do not contradict the child's own parent reference.
	for (const node of byId.values()) {
		if (!Array.isArray(node.children)) continue;
		for (const id of node.children) {
			if (typeof id !== "string") continue;
			const child = byId.get(id);
			if (!child || (typeof child.parent === "string" && child.parent !== node.id)) continue;
			const siblings = children.get(node.id as string) ?? [];
			siblings.push(id);
			children.set(node.id as string, siblings);
		}
	}
	const included = new Set<string>();
	const queue: string[] = [frame.id];
	const queued = new Set<string>(queue);
	for (let index = 0; index < queue.length && index < nodes.length; index++) {
		const id = queue[index];
		if (included.has(id) || !byId.has(id)) continue;
		included.add(id);
		for (const child of children.get(id) ?? []) {
			if (!queued.has(child)) { queued.add(child); queue.push(child); }
		}
	}
	// If no descendant relationship is available, a title match alone cannot
	// safely exclude controls. Fall back to the original unscoped observation.
	if (included.size === 1 && nodes.length > 1) return response;
	const visited = new Set<string>();
	let parent = frame.parent;
	for (let i = 0; typeof parent === "string" && i < nodes.length && !visited.has(parent); i++) {
		visited.add(parent);
		const ancestor = byId.get(parent);
		if (!ancestor) break;
		if (ancestor.role === "application") included.add(parent);
		parent = ancestor.parent;
	}
	const shellRoots: string[] = [];
	const shellIncluded = new Set<string>();
	// EWMH can still report the editor as active while a Cinnamon popup has
	// keyboard focus. Only a linked, showing shell stage with a showing menu or
	// focused showing search control proves that its tree belongs in this view.
	for (const stage of byId.values()) {
		if (stage.role !== "window" || stage.name !== "" || stage.visible === false || typeof stage.id !== "string") continue;
		const app = typeof stage.parent === "string" ? byId.get(stage.parent) : undefined;
		if (app?.role !== "application" || typeof app.name !== "string" || app.name.toLowerCase() !== "cinnamon" || typeof app.id !== "string") continue;
		const shellIds = new Set<string>();
		const shellQueue = [stage.id];
		for (let i = 0; i < shellQueue.length && i < nodes.length; i++) {
			const id = shellQueue[i];
			const node = byId.get(id);
			if (!node || shellIds.has(id) || node.visible === false) continue;
			shellIds.add(id);
			for (const child of children.get(id) ?? []) shellQueue.push(child);
		}
		const showingPopup = [...shellIds].some((id) => {
			const node = byId.get(id)!;
			return node.visible === true && (
				node.role === "menu" || node.role === "popup menu" ||
				((node.role === "entry" || node.role === "text") && node.focused === true));
		});
		if (!showingPopup) continue;
		shellRoots.push(stage.id);
		included.add(app.id);
		shellIncluded.add(app.id);
		for (const id of shellIds) { included.add(id); shellIncluded.add(id); }
	}
	const scoped = nodes.filter((node) => node && typeof node === "object" && !Array.isArray(node) &&
		included.has((node as Record<string, unknown>).id as string));
	// Keep the proved popup ahead of a large active app's equally ranked controls
	// when the model-facing node/text budgets prune the scoped result.
	if (shellRoots.length) scoped.sort((a, b) =>
		Number(shellIncluded.has((b as Record<string, unknown>).id as string)) -
		Number(shellIncluded.has((a as Record<string, unknown>).id as string)));
	const result: Record<string, unknown> = { ...response, [key]: { ...data, [collection]: scoped,
		semantic_scope: shellRoots.length ? "active_window_with_shell" : "active_window", scope_root: frame.id,
		...(shellRoots.length ? { shell_scope_roots: shellRoots } : {}), out_of_scope_nodes: nodes.length - scoped.length,
		...(key === "delta" && Array.isArray(data.removed) ? { removed_scope: "unfiltered" } : {}) } };
	// Other EWMH windows remain discoverable, but do not let dozens of unrelated
	// titles crowd out the active window's reachable controls in the model text.
	if (Array.isArray(response.windows) && response.windows.length > 12) {
		result.windows = [active, ...response.windows.filter((window) => window !== active)].slice(0, 12);
		result.omitted_windows = (Number(response.omitted_windows) || 0) + response.windows.length - 12;
	}
	return result;
}

function conciseResponse(response: Record<string, unknown>, maxNodes = MAX_NODES): Record<string, unknown> {
	// Put the independent X11 window list first: it must remain visible even
	// when a long AT-SPI tree fills the tool's text budget.
	const result: Record<string, unknown> = {};
	if (Array.isArray(response.windows)) {
		result.windows = [...response.windows]
			.sort((a, b) => Number((b as Record<string, unknown>).active === true) - Number((a as Record<string, unknown>).active === true))
			.map((window) => {
				if (!window || typeof window !== "object" || Array.isArray(window)) return window;
				const item = window as Record<string, unknown>;
				return { ...item, title: typeof item.title === "string" && item.title.length > MAX_FIELD ? `${item.title.slice(0, MAX_FIELD)}…` : item.title };
			});
	}
	const windows = result.windows;
	Object.assign(result, response);
	if (windows !== undefined) result.windows = windows;
	delete result.png_base64;
	for (const key of ["snapshot", "delta"]) {
		const value = result[key];
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const data = { ...(value as Record<string, unknown>) };
		result[key] = data;
		const collectionKey = key === "snapshot" ? "nodes" : "changed";
		const entries = data[collectionKey];
		if (Array.isArray(entries)) {
			const ranked = entries.map((entry, index) => ({ entry, index, score: nodePriority(entry) }));
			const useful = ranked.filter(({ entry, score }) => score > 0 ||
				(entry && typeof entry === "object" && ["application", "frame", "window", "desktop frame"].includes(String((entry as Record<string, unknown>).role))));
			useful.sort((a, b) => b.score - a.score || a.index - b.index);
			data[collectionKey] = useful.slice(0, maxNodes).map(({ entry }) => conciseNode(entry));
			data.omitted_nodes = (Number(data.omitted_nodes) || 0) + entries.length - data[collectionKey].length;
		}
	}
	if (result.node) result.node = conciseNode(result.node);
	if (result.visual && typeof result.visual === "object" && !Array.isArray(result.visual)) {
		const visual = result.visual as Record<string, unknown>;
		result.visual = {
			...visual,
			patches: Array.isArray(visual.patches) ? visual.patches.map((patch) => {
				if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
				const { png_base64: _png, ...metadata } = patch as Record<string, unknown>;
				return metadata;
			}) : visual.patches,
		};
	}
	return result;
}

function budgetObservation(response: Record<string, unknown>, budget: number): Record<string, unknown> {
	const windows = Array.isArray(response.windows) ? response.windows : undefined;
	const ordered = windows && [...windows].sort((a, b) =>
		Number((b as Record<string, unknown>)?.active === true) - Number((a as Record<string, unknown>)?.active === true));
	// First shorten values/titles, then remove the lowest-ranked semantic nodes
	// and inactive windows. Never throw away the active window or the top focused
	// actionable node just because the full accessibility tree is large.
	for (const tier of [
		{ nodes: 90, windows: 64, field: 160, value: 400, removed: 30 },
		{ nodes: 60, windows: 24, field: 96, value: 120, removed: 20 },
		{ nodes: 35, windows: 8, field: 64, value: 0, removed: 10 },
		{ nodes: 16, windows: 3, field: 48, value: 0, removed: 4 },
		{ nodes: 1, windows: 1, field: 32, value: 0, removed: 0 },
	]) {
		const compact: Record<string, unknown> = { ...response, output_compacted: true };
		if (typeof compact.error === "string") compact.error = compact.error.slice(0, MAX_FIELD);
		if (ordered) {
			compact.windows = ordered.slice(0, tier.windows).map((window) => {
				if (!window || typeof window !== "object" || Array.isArray(window)) return window;
				const item = window as Record<string, unknown>;
				return { id: item.id, title: typeof item.title === "string" ? item.title.slice(0, tier.field) : item.title,
					active: item.active, bounds: item.bounds };
			});
			compact.omitted_windows = (Number(response.omitted_windows) || 0) + ordered.length - (compact.windows as unknown[]).length;
		}
		for (const key of ["snapshot", "delta"] as const) {
			const value = response[key];
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const original = value as Record<string, unknown>;
			const data = { ...original };
			const collection = key === "snapshot" ? "nodes" : "changed";
			if (Array.isArray(original[collection])) {
				const all = original[collection] as unknown[];
				data[collection] = all.slice(0, tier.nodes).map((node) => {
					if (!node || typeof node !== "object" || Array.isArray(node)) return node;
					const item = node as Record<string, unknown>;
					const compactNode = { ...item };
					for (const field of ["name", "role"] as const) {
						if (typeof compactNode[field] === "string") compactNode[field] = compactNode[field].slice(0, tier.field);
					}
					if (typeof compactNode.value === "string") {
						if (tier.value) compactNode.value = compactNode.value.slice(0, tier.value);
						else delete compactNode.value;
					}
					if (Array.isArray(compactNode.actions)) compactNode.actions = compactNode.actions.slice(0, 4);
					return compactNode;
				});
				data.omitted_nodes = (Number(original.omitted_nodes) || 0) + all.length - (data[collection] as unknown[]).length;
			}
			if (key === "delta" && Array.isArray(original.removed)) {
				data.removed = original.removed.slice(0, tier.removed);
				data.omitted_removed = (Number(original.omitted_removed) || 0) + original.removed.length - (data.removed as unknown[]).length;
			}
			compact[key] = data;
		}
		if (JSON.stringify(compact).length <= budget) return compact;
	}
	// Defensive last tier for malformed, unbounded daemon metadata. Preserve
	// root/generation, the active window and one top-ranked actionable node.
	const boundedId = (value: unknown) => typeof value === "string" ? value.slice(0, MAX_FIELD) : undefined;
	const boundedNode = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const node = value as Record<string, unknown>;
		return { id: boundedId(node.id), role: typeof node.role === "string" ? node.role.slice(0, 32) : undefined,
			name: typeof node.name === "string" ? node.name.slice(0, 32) : undefined, focused: node.focused === true };
	};
	const minimal: Record<string, unknown> = { ok: response.ok, output_compacted: true };
	for (const key of ["snapshot", "delta"] as const) {
		const value = response[key] as Record<string, unknown> | undefined;
		if (!value) continue;
		const collection = key === "snapshot" ? "nodes" : "changed";
		const nodes = Array.isArray(value[collection]) ? value[collection] as unknown[] : [];
		minimal[key] = { generation: value.generation, ...(key === "snapshot" ? { root: boundedId(value.root) } : { from: value.from }),
			semantic_scope: value.semantic_scope, scope_root: boundedId(value.scope_root),
			...(Array.isArray(value.shell_scope_roots) ? { shell_scope_roots: value.shell_scope_roots.slice(0, 4).map(boundedId) } : {}),
			out_of_scope_nodes: value.out_of_scope_nodes,
			[collection]: nodes.length ? [boundedNode(nodes[0])] : [],
			omitted_nodes: (Number(value.omitted_nodes) || 0) + Math.max(0, nodes.length - 1),
			...(key === "delta" ? { removed: [], removed_scope: value.removed_scope,
				omitted_removed: Array.isArray(value.removed) ? value.removed.length : 0 } : {}) };
	}
	if (ordered?.length) {
		const item = ordered[0] as Record<string, unknown>;
		minimal.windows = [{ id: boundedId(item.id), title: String(item.title ?? "").slice(0, 32), active: item.active === true }];
	}
	if (ordered) minimal.omitted_windows = (Number(response.omitted_windows) || 0) + Math.max(0, ordered.length - 1);
	return minimal;
}

function responseText(response: Record<string, unknown>, budget = MAX_TEXT): string {
	let text = JSON.stringify(response);
	if (text.length <= budget) return text;
	// Never cut serialized JSON mid-token. Prefer retaining all 50 ranked
	// results with shorter fields; only drop trailing hits when even metadata
	// alone cannot fit. Explicit counts make any loss visible to the caller.
	const seen = response.seen as Record<string, unknown> | undefined;
	if (seen && Array.isArray(seen.results)) {
		const original = seen.results;
		for (const cap of [120, 80, 48, 24, 0]) {
			const results = original.map((hit) => {
				if (!hit || typeof hit !== "object" || Array.isArray(hit)) return hit;
				const record = hit as Record<string, unknown>;
				return Object.fromEntries(Object.entries(record).map(([key, value]) =>
					[ key, typeof value === "string" && ["name", "window", "role"].includes(key)
						? Array.from(value).slice(0, cap).join("") : value ]));
			});
			const compact = { ...response, seen: { ...seen, results, fields_truncated: true } };
			text = JSON.stringify(compact);
			if (text.length <= budget) return text;
			if (cap === 0) {
				while (results.length > 0) {
					results.pop();
					text = JSON.stringify({ ...response, seen: { ...seen, results,
						fields_truncated: true, omitted_results: original.length - results.length } });
					if (text.length <= budget) return text;
				}
			}
		}
	}
	const diff = response.screen_diff as Record<string, unknown> | undefined;
	if (diff) {
		const { regions: _regions, ...summary } = diff;
		text = JSON.stringify({ ok: response.ok, screen_diff: { ...summary,
			region_count: diff.region_count, omitted_regions: Array.isArray(diff.regions) ? diff.regions.length : 0 } });
		if (text.length <= budget) return text;
	}
	if (response.snapshot || response.delta || response.windows) {
		const compact = budgetObservation(response, budget);
		text = JSON.stringify(compact);
		if (text.length <= budget) return text;
	}
	// Preserve partial batch failures even when a giant changeset overflows.
	const steps = Array.isArray(response.steps) ? response.steps.map((step) => {
		if (!step || typeof step !== "object" || Array.isArray(step)) return step;
		const item = step as Record<string, unknown>;
		return { index: item.index, type: typeof item.type === "string" ? item.type.slice(0, 40) : item.type, ok: item.ok,
			elapsedMs: item.elapsedMs ?? item.elapsed_ms,
			...(typeof item.error === "string" ? { error: item.error.slice(0, MAX_FIELD) } : {}), matched: item.matched,
			...(item.assertion && typeof item.assertion === "object" ? { assertion: {
				nodeId: (item.assertion as Record<string, unknown>).nodeId,
				matched: (item.assertion as Record<string, unknown>).matched,
				readback_omitted: true,
			} } : {}) };
	}) : undefined;
	const error = typeof response.error === "string" ? response.error.slice(0, MAX_FIELD) : undefined;
	const changes = response.changes as Record<string, unknown> | undefined;
	const removed = Array.isArray(changes?.removed) ? changes.removed : [];
	const changed = Array.isArray(changes?.changed) ? changes.changed : [];
	return JSON.stringify({ ok: response.ok, truncated: true, ...(error ? { error } : {}),
		...(steps ? { completed: response.completed, elapsed_ms: response.elapsed_ms, steps: steps.slice(0, 24) } : {}),
		...(changes ? { changes: { from: changes.from, generation: changes.generation,
			changed: changed.slice(0, 2).map((node) => {
				const item = node as Record<string, unknown>;
				return { id: typeof item.id === "string" ? item.id.slice(0, MAX_FIELD) : item.id,
					role: typeof item.role === "string" ? item.role.slice(0, 80) : item.role,
					name: typeof item.name === "string" ? item.name.slice(0, 80) : item.name };
			}),
			omitted_nodes: (Number(changes.omitted_nodes) || 0) + Math.max(0, changed.length - 2),
			removed: removed.slice(0, 8).map((id) => typeof id === "string" ? id.slice(0, MAX_FIELD) : id),
			omitted_removed: (Number(changes.omitted_removed) || 0) + Math.max(0, removed.length - 8) } } : {}),
		message: "Response exceeds text budget; request a narrower scope" });
}

function modelResponse(response: Record<string, unknown>, command: string, payload: Record<string, JsonValue>): Record<string, unknown> {
	if (command === "desktop_paste_text") {
		const raw = response.paste;
		const paste = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
		const allowed = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value) ? value : undefined;
		return { ok: response.ok === true,
			paste: {
				status: allowed(paste.status, ["dispatched", "uncertain", "not_pasted"]),
				method: allowed(paste.method, ["clipboard"]),
				shortcut: allowed(paste.shortcut, ["ctrl_v", "shift_insert"]),
				paste_sent: typeof paste.paste_sent === "boolean" ? paste.paste_sent : undefined,
				clipboard_restore_status: allowed(paste.clipboard_restore_status, ["restored", "unchanged", "skipped_new_owner", "unavailable"]),
				clipboard_restored: typeof paste.clipboard_restored === "boolean" ? paste.clipboard_restored : undefined,
				keyboard_events: paste.keyboard_events === null || (Number.isSafeInteger(paste.keyboard_events) && (paste.keyboard_events === 0 || paste.keyboard_events === 4)) ? paste.keyboard_events : undefined,
				verified: paste.verified === false ? false : undefined,
				focus_verification: allowed(paste.focus_verification, ["semantic", "declared_active_window"]),
			},
			...(response.ok === false ? { error: "Paste not confirmed; do not retry automatically. Observe the intended field and use the reported restoration status before further input." } : {}) };
	}
	if (command === "desktop_launch_app") {
		return { ok: response.ok,
			...(typeof response.launch_status === "string" ? { launch_status: response.launch_status } : {}),
			...(typeof response.launch_attempted === "boolean" ? { launch_attempted: response.launch_attempted } : {}),
			...(typeof response.app_matches_total === "number" ? { app_matches_total: response.app_matches_total } : {}),
			...(typeof response.app_matches_truncated === "boolean" ? { app_matches_truncated: response.app_matches_truncated } : {}),
			...(response.launch ? { launch: response.launch } : {}),
			...(Array.isArray(response.app_matches) ? { app_matches: response.app_matches.slice(0, 20).map((match) => {
				const app = match as Record<string, unknown>;
				return { app_id: app.app_id, name: typeof app.name === "string" ? Array.from(app.name).slice(0, MAX_FIELD).join("") : app.name };
			}) } : {}),
			...(response.error ? { error: response.error } : {}) };
	}
	if (command === "desktop_metrics") {
		return { ok: response.ok, metrics: response.metrics,
			...(response.error ? { error: response.error } : {}) };
	}
	if (command === "desktop_search_seen") {
		const seen = response.seen as Record<string, unknown> | undefined;
		const results = Array.isArray(seen?.results) ? seen.results.slice(0, 50).map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
			const hit = entry as Record<string, unknown>;
			return { id: typeof hit.id === "string" ? hit.id.slice(0, MAX_FIELD) : hit.id,
				name: typeof hit.name === "string" ? hit.name.slice(0, MAX_FIELD) : hit.name,
				role: typeof hit.role === "string" ? hit.role.slice(0, MAX_FIELD) : hit.role,
				bounds: hit.bounds, window: typeof hit.window === "string" ? hit.window.slice(0, MAX_FIELD) : hit.window,
				last_seen_ms: hit.last_seen_ms, generation: hit.generation, source: hit.source };
		}).filter(Boolean) : [];
		return { ok: response.ok, seen: seen ? { generation: seen.generation, results } : undefined,
			...(response.error ? { error: typeof response.error === "string" ? response.error.slice(0, MAX_FIELD) : response.error } : {}) };
	}
	if (command === "desktop_dirty_regions") {
		const diff = response.screen_diff as Record<string, unknown> | undefined;
		const regions = Array.isArray(diff?.regions) ? diff.regions : [];
		return { ok: response.ok, screen_diff: diff ? {
			revision: diff.revision, capture_mode: diff.capture_mode, baseline: diff.baseline,
			screen_width: diff.screen_width, screen_height: diff.screen_height, tile_size: diff.tile_size,
			dirty_tiles: diff.dirty_tiles, region_count: regions.length,
			regions, summarized: diff.summarized,
		} : undefined, ...(response.error ? { error: response.error } : {}) };
	}
	if (command === "desktop_batch") {
		const batch = response.batch as Record<string, unknown> | undefined;
		const steps = Array.isArray(batch?.steps) ? batch.steps : [];
		const changes = response.changes as Record<string, unknown> | undefined;
		const changed = Array.isArray(changes?.changed) ? changes.changed : [];
		const useful = changed.filter((node) => nodePriority(node) > 0);
		const removed = Array.isArray(changes?.removed) ? changes.removed : [];
		return { ok: response.ok, completed: batch?.completed, elapsed_ms: batch?.elapsedMs,
			input_stopped: response.input_stopped, steps,
			...(changes ? { changes: { from: changes.from, generation: changes.generation,
				changed: useful.slice(0, 30).map(conciseNode),
				omitted_nodes: changed.length - Math.min(30, useful.length),
				removed: removed.slice(0, 30), omitted_removed: Math.max(0, removed.length - 30) } } : {}),
			...(response.error ? { error: response.error } : {}) };
	}
	if (command === "desktop_wait" && payload.condition && typeof payload.condition === "object" && !Array.isArray(payload.condition)) {
		const condition = payload.condition as Record<string, JsonValue>;
		const snapshot = response.snapshot as Record<string, unknown> | undefined;
		const delta = response.delta as Record<string, unknown> | undefined;
		const nodes = [...(Array.isArray(snapshot?.nodes) ? snapshot.nodes : []), ...(Array.isArray(delta?.changed) ? delta.changed : [])];
		const node = nodes.find((candidate) => candidate && typeof candidate === "object" &&
			(condition.id === undefined || candidate.id === condition.id) &&
			(condition.name === undefined || (typeof candidate.name === "string" && candidate.name.includes(condition.name))) &&
			(condition.role === undefined || candidate.role === condition.role));
		return { ok: response.ok, matched: response.matched, generation: snapshot?.generation ?? delta?.generation,
			...(node ? { node: conciseNode(node) } : {}), ...(response.error ? { error: response.error } : {}) };
	}
	// Scope the ORIGINAL linked graph before ranking/pruning nodes. This changes
	// model-facing data only; daemon snapshots and historical hints remain full.
	const original = response.snapshot as Record<string, unknown> | undefined;
	const frames = Array.isArray(original?.nodes) ? original.nodes.filter((n) => n && typeof n === "object" && ["frame", "window", "dialog"].includes((n as Record<string, unknown>).role as string)) as Record<string, unknown>[] : [];
	const scoped = command === "desktop_observe" || command === "desktop_changes" ? scopeActiveWindow(response) : response;
	const isObservation = command === "desktop_observe" || command === "desktop_changes";
	const activeScope = [scoped.snapshot, scoped.delta].some((data) => data && typeof data === "object" &&
		["active_window", "active_window_with_shell"].includes((data as Record<string, unknown>).semantic_scope as string));
	const visible = conciseResponse(scoped, isObservation && !activeScope ? MAX_UNSCOPED_NODES : MAX_NODES);
	if (command === "desktop_observe" || command === "desktop_changes") {
		const active = Array.isArray(response.windows) ? response.windows.find((w) => w && typeof w === "object" && (w as Record<string, unknown>).active === true) as Record<string, unknown> | undefined : undefined;
		const snapshot = visible.snapshot as Record<string, unknown> | undefined;
		// Cinnamon/Nemo sometimes expose a 600-node desktop tree while the
		// actual focused browser/terminal has no AT-SPI objects at all.
		// Do not spend thousands of tokens on that unrelated desktop tree.
		if (active && active.title !== "Desktop" && frames.length > 0 &&
			frames.every((n) => !n.name || n.name === "Desktop") && snapshot &&
			snapshot.semantic_scope !== "active_window" && Array.isArray(snapshot.nodes)) {
			snapshot.nodes = [];
			// Only a background desktop tree was observed. Do not claim the
			// unmatched active window itself is inaccessible.
			snapshot.semantic_scope = "background_desktop_only";
			snapshot.out_of_scope_nodes = Array.isArray(original?.nodes) ? original.nodes.length : 0;
			snapshot.omitted_nodes = 0;
		}
	}
	return visible;
}

export interface DesktopToolLifecycle {
	beforeExecute(name: string, signal?: AbortSignal): Promise<void> | void;
}

export function registerComputerUseTools(pi: ExtensionAPI, lifecycle?: DesktopToolLifecycle, startup?: DesktopDaemonStartup): void {
	for (const command of commands) {
		pi.registerTool({
			name: command.name,
			label: command.label,
			description: command.description,
			...(command.name === "desktop_observe" ? { promptGuidelines: [
				"Prefer existing Pi read/write/edit/bash and supported APIs for files/code/builds; GUI only when needed or explicitly requested. Mix native file reads with verified GUI text insertion, without implicit submit. For GUI observation/input/capture/clipboard follow the mode rules: registered desktop_* tools only, AT-SPI/windows/GIO first, revalidate historical IDs and search compact omissions. Batch verified actions with wait/assert checks; prefer semantic changes over full observations. Do not recapture information already available semantically. Every image needs exact desktop_visual_permission for an explicit request or verified semantic blocker. Minimize images and model round trips; never bypass OFF, Stop or uncertain-input rules.",
			] } : {}),
			parameters: command.parameters,
			annotations: {
				readOnlyHint: command.readOnly === true,
				destructiveHint: command.readOnly !== true,
				openWorldHint: command.readOnly !== true,
			},
			async execute(_toolCallId, params, signal) {
				if (command.name === "desktop_paste_text") pasteParameters(params);
				if (command.name !== "desktop_stop" && !command.readOnly) startup?.assertInputAllowed();
				if (command.name === "desktop_stop") startup?.markStopped();
				else if (command.name === "desktop_ping" || command.name === "desktop_metrics") await startup?.ensure(signal);
				else await startup?.ensureCompatible(signal, command.name === "desktop_launch_app" &&
					typeof (params as Record<string, unknown>).query === "string" ? "app_discovery" :
					command.name === "desktop_paste_text" ? "clipboard_paste" : undefined);
				// A lease begin must never race ahead of cold-start readiness. Check
				// again after it: Stop may arrive while a lease begin is pending.
				if (command.name !== "desktop_stop" && !command.readOnly) startup?.assertInputAllowed();
				await lifecycle?.beforeExecute(command.name, signal);
				if (command.name !== "desktop_stop" && !command.readOnly) startup?.assertInputAllowed();
				const payload = asJsonValue(params) as Record<string, JsonValue>;
				const request: DaemonRequest = { cmd: daemonCommand(command.name), ...payload };
				let response: Record<string, unknown>;
				try { response = await computerUseClient.request(request, signal); }
				catch (error) {
					// Client.request throws the daemon's error text for ordinary failed
					// commands. Only these anchored native Stop rejections are sticky;
					// connection/timeout errors and arbitrary UI text are not evidence.
					if (error instanceof Error && /^(?:input stopped(?:;|$)|emergency stop active(?:$|[.;]))/.test(error.message)) startup?.markStopped();
					if (command.name === "desktop_paste_text") {
						// Never surface daemon/UI diagnostics that might contain field or clipboard data.
						const message = error instanceof Error ? error.message : "";
						throw new Error(/^(?:input stopped(?:;|$)|emergency stop active(?:$|[.;]))/.test(message)
							? "Desktop input stopped; paste was not sent. Do not retry automatically."
							: message.includes("Request was not sent.")
								? "Paste request was not sent; check daemon availability before trying again."
								: "Paste outcome may be uncertain; do not retry automatically. Observe the field and use any reported restoration status before further input.");
					}
					throw error;
				}
				// launch_app and batch preserve failed responses rather than throwing.
				if (response.input_stopped === true ||
					(response.ok === false && typeof response.error === "string" &&
					/^(?:input stopped(?:;|$)|emergency stop active(?:$|[.;]))/.test(response.error))) startup?.markStopped();
				const visible = modelResponse(response, command.name, payload);
				const text = responseText(visible,
					command.name === "desktop_observe" || command.name === "desktop_changes" ? MAX_OBSERVATION_TEXT : MAX_TEXT);
				// Persist the bounded representation, not the pre-budget tree, in tool details.
				const rendered = JSON.parse(text) as Record<string, unknown>;
				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
					{ type: "text", text },
				];
				if ((command.name === "desktop_screenshot" || command.name === "desktop_inspect_visual" || (command.name === "desktop_observe" && payload.screenshot === true)) && typeof response.png_base64 === "string") {
					content.push({ type: "image", data: response.png_base64, mimeType: "image/png" });
				}
				if (command.name === "desktop_inspect_visual" && response.visual && typeof response.visual === "object") {
					const visual = response.visual as Record<string, unknown>;
					if (Array.isArray(visual.patches)) {
						for (const patch of visual.patches) {
							if (patch && typeof patch === "object" && !Array.isArray(patch)) {
								const png = (patch as Record<string, unknown>).png_base64;
								if (typeof png === "string") content.push({ type: "image", data: png, mimeType: "image/png" });
							}
						}
					}
				}
				return {
					content,
					details: { command: command.name, response: rendered },
					isError: response.ok === false,
				};
			},
		});
	}
}
