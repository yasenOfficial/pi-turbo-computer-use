# Private task-level comparison: Sol-only vs Sol → Luna

This is an **opt-in metadata observer in the existing Pi extension**, not a second agent, hidden model, daemon poller or benchmark that operates your desktop automatically. No speed, token, billing or quota improvement has been measured by adding it.

## Run the same scenario in two fresh sessions

First `/reload` to load the extension update. Choose a neutral label such as `bench-blink`; do not put personal information or task text in the label.

**Session A — selected physical Sol throughout:**

```text
/model                              Select your physical Sol on the intended account
/computer-use models single
/computer-use debug on bench-blink
/computer-use on
/computer-use <your task>
```

After the agent has settled, inspect the actual result yourself:

```text
/computer-use debug report
/computer-use debug result pass      Only if you verified the requested result
```

Use `result fail` if it was incorrect. `completed` is an agent outcome, **not evidence that the task succeeded**. An unrated report stays explicitly unrated.

**Session B — a new, fresh Pi session:** use the same physical Sol/account and reasoning setting, replace `models single` with `models hybrid`, enable `debug on bench-blink` and Computer use ON, then submit the identical task. Verify and rate it in that session. Do not run the two sessions concurrently against the shared desktop.

Reset the application to an equivalent starting state yourself, without repeating irreversible actions such as sending messages. Keep the extension/Pi version, daemon build, account, reasoning setting and environment the same. Reports identify physical provider/model IDs and observed reasoning settings, but do not prove matching task text, account identity, code versions or starting desktop state. Repeat with fresh sessions and alternate run order for a useful comparison.

## Compare offline

From this repository:

```sh
node scripts/compare-computer-use.mjs --label bench-blink
# Machine-readable aggregates:
node scripts/compare-computer-use.mjs --label bench-blink --json
```

The reader is read-only and makes no model, network or desktop calls. `--dir /private/report-directory` selects another report directory. It groups by configured routing **and actual observed physical models/reasoning settings**, never assumes that selecting hybrid means Luna was used.

The main performance cohort contains only complete, completed, user-rated pass runs with **zero prior assistant messages** and a session ID used exactly once among matching reports. Failed, unrated, nonfresh, repeated-session and partial runs remain visible in counts; completed unrated duration is a preview only. The script does not announce a winner or infer correctness.

## What is recorded

One bounded JSON file per opted-in Computer use ON run:

- Neutral label, random run/session IDs, start time and routing preference.
- Monotonic host-observed elapsed time through settlement; user abort/Stop freezes the measured activity time. Interrupted or split continuations are partial reports.
- Actual assistant provider/model IDs, selected/message/provider reasoning levels when exposed, stop reasons, usage fields and sample coverage.
- Host turn-to-message-end intervals and first-content-event latency. These are **not network-only inference time or exact provider TTFT**.
- Tool names, start/end intervals, error flags, result text-byte counts and image-block counts/encoded lengths. Nested tool spans are marked; root-only image counts avoid parent/child duplication. Root result counts are observed before any later `tool_result` transformation, not guaranteed final-transcript or distinct-capture counts.
- Batch action types/counts, assertion match/error counts and input text-byte counts, never input text or asserted values.
- Launch lookup/dispatch mode, allowlisted launch status/attempt flag and candidate counts, plus phase and user-handoff reason enums. No launcher query, candidate names/IDs, handoff instructions or plans.
- Model-selection events, compaction timing/outcomes and separately exposed compaction usage. Overflow retry offered is a flag, not confirmation of a retried request.
- Initial context estimates, prior assistant-message count, active-tool count and pre-injection system-prompt character count. Context estimates are **not billed request usage**.

Reports never store raw task/prompt text, UI names/titles/values, tool arguments/readbacks, screenshots/base64, passwords, plans, provider diagnostics or raw errors. Local session metadata contains opt-in/report references and summaries, not model-visible log content.

### Unknowns stay unknown

Assistant tokens are observed `message_end` usage, **not a guaranteed total for every request involved in the task**. Missing fields or possible SDK zero placeholders are unknown in the comparison. Compaction usage is separate and can itself omit aborted or hidden requests. Exact automatic retry/backoff counts and total task tokens remain unknown. Tool usage is excluded to avoid double-counting provider usage.

`catalogCostEstimate` is a reported SDK/catalog estimate, **not real billing or subscription quota**. Zero does not prove a free request. Real billing and quota multipliers are not measured.

Tool-wall time is the union of observed intervals, not their sum. Whole elapsed, model-turn spans, compaction and tool-wall time have different scopes and may overlap; do not add them. Settlement measurement includes earlier extension handlers but excludes cleanup handlers that run later. It is not an exact match to the existing UI timer.

## Privacy, lifecycle and limits

Default location: `$XDG_STATE_HOME/pi-computer/debug`, otherwise `~/.local/state/pi-computer/debug`. The directory is owner-only `0700`, files `0600`; unsafe/symlinked paths are refused. Reports stay outside the public repository by default. They still disclose model choices, timing, labels and byte/count metadata: **review before sharing**.

Debug defaults OFF on startup, resume, new session, fork and tree navigation. `/reload` preserves deliberate opt-in on the same active branch. `/computer-use debug on` does not enable Computer use, does not submit a task and does not call the daemon. OFF ordinary prompts are not recorded. Change debug settings and ratings only while idle; `debug report` can show the last report while busy.

```text
/computer-use debug off
```

This stops future recording, **not** desktop activity, and does not delete existing reports. `/computer-use off` separately blocks computer use; emergency Stop remains separate and sticky. Debug failures never authorize input or retry actions. No OS notifications are added by the observer.

Reports cap each event/model/tool list at 2,000 entries and each file at 1 MiB. Overflow, interruption or missing end events are flagged partial; missing data must not be treated as zero. Recording is in memory during a run and saved at settlement/shutdown, so a process crash can lose that run entirely. Byte counting and file writing add overhead; use the same opt-in settings on both sides of the comparison.

Synthetic lifecycle/privacy tests and a real Pi **fake-provider** Sol/Luna integration test validate the infrastructure. They do not establish real desktop speed, real-provider usage accuracy or quota savings.
