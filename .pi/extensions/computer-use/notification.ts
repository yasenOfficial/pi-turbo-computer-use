import { execFile } from "node:child_process";

const title = "Pi · Computer use";
const messages = {
	completed: "Задачата приключи. Виж резултата в Pi.",
	error: "Работата с компютъра завърши с грешка.",
	action_required: "Задачата чака твое действие. Виж указанията в Pi, изпълни ги и напиши „готово“.",
} as const;

/** Best-effort generic notification. Abort is a successful no-op, never a popup. */
export async function sendDesktopCompletion(
	outcome: keyof typeof messages | "aborted",
	runner: typeof execFile = execFile,
): Promise<boolean> {
	if (outcome === "aborted") return true;
	return new Promise((resolve) => {
		try {
			runner("notify-send", [
				"--app-name=Pi", "--icon=computer", `--expire-time=${outcome === "action_required" ? 0 : 5000}`, "--",
				outcome === "action_required" ? "Pi · Action required" : title, messages[outcome],
			], { timeout: 2000 }, (error) => resolve(error === null));
		} catch {
			resolve(false);
		}
	});
}
