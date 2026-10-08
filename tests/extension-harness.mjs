// Lifecycle-aware fake Pi API for isolated integration tests; no model calls.
export function extensionHarness(tools) {
	const handlers = new Map();
	const commands = new Map();
	const messages = [];
	const entries = [];
	return {
		entries,
		commands,
		messages,
		pi: {
			registerTool(tool) { tools.set(tool.name, tool); },
			registerCommand(name, options) { commands.set(name, options); },
			getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
			getActiveTools() { return [...tools.keys()]; },
			sendUserMessage(content, options) { messages.push({ content, options }); },
			appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
			on(name, handler) {
				const listeners = handlers.get(name) ?? [];
				listeners.push(handler);
				handlers.set(name, listeners);
				return () => {
					const index = listeners.indexOf(handler);
					if (index >= 0) listeners.splice(index, 1);
				};
			},
		},
		async emit(name, context = { signal: undefined, mode: "print", hasUI: false,
			sessionManager: { getBranch: () => entries } }, event = {}) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, context));
			return results;
		},
	};
}
