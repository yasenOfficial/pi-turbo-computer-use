#!/usr/bin/env node
// All calls inject a fake execFile runner; never send a real desktop notification.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendDesktopCompletion } from "../.pi/extensions/computer-use/notification.ts";

test("completion notifications use fixed Bulgarian copy and bounded notify-send argv", async () => {
	const bodies = {
		completed: "Задачата приключи. Виж резултата в Pi.",
		error: "Работата с компютъра завърши с грешка.",
	};
	for (const [outcome, body] of Object.entries(bodies)) {
		let calls = 0;
		const runner = (file, args, options, callback) => {
			calls++;
			assert.equal(file, "notify-send");
			assert.deepEqual(args, ["--app-name=Pi", "--icon=computer", "--expire-time=5000", "--", "Pi · Computer use", body]);
			assert.deepEqual(options, { timeout: 2000 });
			assert.equal(typeof callback, "function");
			callback(null, "", "");
		};
		assert.equal(await sendDesktopCompletion(outcome, runner), true);
		assert.equal(calls, 1);
	}
});

test("Action required notification is distinct, persistent and contains no dynamic private text", async () => {
	let calls = 0;
	assert.equal(await sendDesktopCompletion("action_required", (file, args, options, cb) => {
		calls++;
		assert.equal(file, "notify-send");
		assert.deepEqual(args, ["--app-name=Pi", "--icon=computer", "--expire-time=0", "--",
			"Pi · Action required", "Задачата чака твое действие. Виж указанията в Pi, изпълни ги и напиши „готово“."]);
		assert.deepEqual(options, { timeout: 2000 });
		cb(null, "", "");
	}), true);
	assert.equal(calls, 1);
});

test("abort never launches a notification process", async () => {
	let calls = 0;
	assert.equal(await sendDesktopCompletion("aborted", () => { calls++; throw new Error("must not run"); }), true);
	assert.equal(calls, 0);
});

test("notification failures are best effort", async () => {
	let calls = 0;
	const failed = (_file, _args, _options, callback) => {
		calls++;
		callback(Object.assign(new Error("notify-send timed out"), { code: "ETIMEDOUT" }));
	};
	assert.equal(await sendDesktopCompletion("completed", failed), false);
	assert.equal(calls, 1);
	assert.equal(await sendDesktopCompletion("error", () => { throw new Error("missing notify-send"); }), false);
});
