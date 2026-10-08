#!/usr/bin/env node
// Offline, aggregate-only reader for opt-in computer-use debug reports.
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_BYTES = 1024 * 1024;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) / 2)];
  return low + (sorted[Math.floor(sorted.length / 2)] - low) / 2;
};
const covered = (runs, measure) => {
  const values = runs.map(measure);
  const known = values.filter(nonnegative);
  const full = known.length === runs.length && runs.length > 0;
  const sum = full ? known.reduce((a, b) => a + b, 0) : null;
  return { knownRuns: known.length, total: nonnegative(sum) ? sum : null,
    median: full ? median(known) : null };
};

function args(argv) {
  let label, dir, json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label' && label === undefined && argv[i + 1] !== undefined) label = argv[++i];
    else if (argv[i] === '--dir' && dir === undefined && argv[i + 1] !== undefined) dir = argv[++i];
    else if (argv[i] === '--json' && !json) json = true;
    else throw new Error('Usage: node scripts/compare-computer-use.mjs --label neutral-label [--dir path] [--json]');
  }
  if (!LABEL.test(label ?? '')) throw new Error('Use a neutral ASCII label (letters, digits, _ or -, at most 64 characters); never task contents');
  if (dir === undefined) dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'pi-computer', 'debug');
  if (!dir) throw new Error('Invalid report directory');
  return { label, dir, json };
}

// Never read a path other than a UUID.json entry; open without following links and bound the read.
async function readReport(dir, name) {
  let handle;
  try {
    const file = path.join(dir, name);
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) return null;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_BYTES) return null;
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || Array.isArray(data) || data.schemaVersion !== 1 || data.id?.toLowerCase() !== name.slice(0, -5).toLowerCase()
      || !UUID.test(data.sessionId ?? '') || !LABEL.test(data.label ?? '') || !['single', 'hybrid'].includes(data.routing)
      || !['completed', 'aborted', 'error', 'action_required', 'continued', 'interrupted'].includes(data.outcome)
      || typeof data.complete !== 'boolean' || ![true, false, null].includes(data.taskSuccess)
      || typeof data.userRated !== 'boolean' || (data.userRated ? typeof data.taskSuccess !== 'boolean' : data.taskSuccess !== null)
      || !nonnegative(data.elapsedMs) || !Array.isArray(data.modelCalls) || !Array.isArray(data.tools)
      || !data.usage || typeof data.usage !== 'object' || !data.usageSamples || typeof data.usageSamples !== 'object'
      || !count(data.omittedEvents) || !count(data.costSamples)
      || !(data.catalogCostEstimate === null || nonnegative(data.catalogCostEstimate))) return null;
    if (data.modelCalls.length > 2000 || data.tools.length > 2000 || (data.complete && data.omittedEvents !== 0)) return null;
    const compactFields = ['compactionStarts', 'compactionSuccesses', 'compactionFailures', 'overflowRetryOffered', 'compactionCostSamples'];
    if (compactFields.some(field => !count(data[field])) || !data.compactionUsage || typeof data.compactionUsage !== 'object'
      || !data.compactionUsageSamples || typeof data.compactionUsageSamples !== 'object'
      || !(data.compactionCatalogCostEstimate === null || nonnegative(data.compactionCatalogCostEstimate))) return null;
    const observedAssistantMessages = count(data.observedAssistantMessages) ? data.observedAssistantMessages : null;
    const uncertainUsageMessages = count(data.uncertainUsageMessages) ? data.uncertainUsageMessages : null;
    if ((data.uncertainAssistantUsageMessages !== undefined && !count(data.uncertainAssistantUsageMessages))
      || (data.usageMayContainPlaceholders !== undefined && typeof data.usageMayContainPlaceholders !== 'boolean')) return null;
    const assistantUsageUncertain = uncertainUsageMessages !== 0 || (data.uncertainAssistantUsageMessages ?? 0) > 0
      || data.usageMayContainPlaceholders === true;
    const modelCoverage = observedAssistantMessages !== null && observedAssistantMessages > 0
      && observedAssistantMessages === data.modelCalls.length && uncertainUsageMessages !== null
      && uncertainUsageMessages <= observedAssistantMessages;
    const compactionCoverage = data.compactionSuccesses > 0 && data.compactionStarts >= data.compactionSuccesses + data.compactionFailures;
    // Explicitly project a fixed allowlist. Never echo timeline, errors, prompts, paths or arbitrary properties.
    const models = [];
    for (const row of data.modelCalls) {
      if (!row || typeof row !== 'object' || !SAFE.test(row.provider ?? '') || !SAFE.test(row.modelId ?? '')
        || [row.thinkingLevel, row.selectedThinkingLevel, row.providerThinkingLevel].some(value => value !== undefined && !SAFE.test(value))) return null;
      models.push({ provider: row.provider, modelId: row.modelId,
        messageThinkingLevel: row.thinkingLevel ?? null, selectedThinkingLevel: row.selectedThinkingLevel ?? null,
        providerThinkingLevel: row.providerThinkingLevel ?? null,
        modelTurnMs: nonnegative(row.modelTurnMs) ? row.modelTurnMs : null,
        stopError: row.stopReason === 'error' ? true : typeof row.stopReason === 'string' ? false : null });
    }
    const tools = [];
    for (const row of data.tools) {
      if (!row || typeof row !== 'object') return null;
      tools.push({ atMs: nonnegative(row.atMs) ? row.atMs : null,
        elapsedMs: nonnegative(row.elapsedMs) ? row.elapsedMs : null,
        nested: typeof row.nested === 'boolean' ? row.nested : null,
        images: count(row.images) ? row.images : null,
        error: typeof row.error === 'boolean' ? row.error : null });
    }
    const usage = {};
    for (const field of FIELDS) {
      const samples = data.usageSamples[field];
      usage[field] = modelCoverage && !assistantUsageUncertain && count(samples)
        && samples === observedAssistantMessages && nonnegative(data.usage[field]) ? data.usage[field] : null;
    }
    const compactionUsage = {};
    for (const field of FIELDS) {
      compactionUsage[field] = compactionCoverage && count(data.compactionUsageSamples[field])
        && data.compactionUsageSamples[field] === data.compactionSuccesses && nonnegative(data.compactionUsage[field])
        && (field !== 'totalTokens' || data.compactionUsage.totalTokens > 0)
        ? data.compactionUsage[field] : null;
    }
    // Only event type and duration are examined; timeline payloads are never retained or echoed.
    const ends = Array.isArray(data.timeline) ? data.timeline.filter(row => row?.type === 'compaction_end') : [];
    const failures = Array.isArray(data.timeline) ? data.timeline.filter(row => row?.type === 'compaction_failed') : [];
    const duration = (events, expected) => events.length === expected && events.every(row => nonnegative(row.elapsedMs))
      ? events.reduce((sum, row) => sum + row.elapsedMs, 0) : null;
    return { sessionId: data.sessionId.toLowerCase(), label: data.label, routing: data.routing,
      outcome: data.outcome, complete: data.complete, omittedEvents: data.omittedEvents,
      taskSuccess: data.taskSuccess, userRated: data.userRated,
      elapsedMs: data.elapsedMs, models, tools, usage, observedAssistantMessages, uncertainUsageMessages,
      catalogCostEstimate: modelCoverage && !assistantUsageUncertain && data.costSamples === observedAssistantMessages
        && nonnegative(data.catalogCostEstimate) ? data.catalogCostEstimate : null,
      compaction: { starts: data.compactionStarts, successes: data.compactionSuccesses,
        failures: data.compactionFailures, overflowRetryOffered: data.overflowRetryOffered,
        successDurationMs: duration(ends, data.compactionSuccesses), failureDurationMs: duration(failures, data.compactionFailures),
        usage: compactionUsage,
        catalogCostEstimate: compactionCoverage && compactionUsage.totalTokens !== null
          && data.compactionCostSamples === data.compactionSuccesses
          && nonnegative(data.compactionCatalogCostEstimate) ? data.compactionCatalogCostEstimate : null },
      initialAssistantMessages: Array.isArray(data.timeline) ? (() => {
        const start = data.timeline.find(row => row?.type === 'run_start');
        return count(start?.assistantMessagesBeforeRun) ? start.assistantMessagesBeforeRun : null;
      })() : null };
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

function toolWallUnion(tools) {
  if (tools.some(t => t.atMs === null || t.elapsedMs === null)) return null;
  const intervals = tools.map(t => [t.atMs, t.atMs + t.elapsedMs]).sort((a, b) => a[0] - b[0]);
  let total = 0, end = 0;
  for (const [start, finish] of intervals) { total += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish); }
  return total;
}
function describe(run) {
  // Sets reflect actual assistant messages, not the selected/planned model. No account identity is recorded.
  return JSON.stringify([...new Map(run.models.map(m => [JSON.stringify([m.provider, m.modelId, m.selectedThinkingLevel, m.messageThinkingLevel, m.providerThinkingLevel]), {
    provider: m.provider, modelId: m.modelId, selectedThinkingLevel: m.selectedThinkingLevel,
    messageThinkingLevel: m.messageThinkingLevel, providerThinkingLevel: m.providerThinkingLevel }])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function summarize(routing, descriptor, runs, sessionCounts) {
  const candidates = runs.filter(r => r.complete && r.outcome === 'completed' && r.userRated && r.taskSuccess === true);
  const rejectedNonFreshEligibleContext = candidates.filter(r => r.initialAssistantMessages !== 0).length;
  const rejectedRepeatedSessionEligible = candidates.filter(r => r.initialAssistantMessages === 0 && sessionCounts.get(r.sessionId) !== 1).length;
  const eligible = candidates.filter(r => r.initialAssistantMessages === 0 && sessionCounts.get(r.sessionId) === 1);
  const elapsed = eligible.map(r => r.elapsedMs);
  const perTools = measure => covered(eligible, r => r.tools.every(t => measure(t) !== null) ? r.tools.reduce((n, t) => n + measure(t), 0) : null);
  const rootImages = r => r.tools.some(t => t.nested === null) ? null
    : r.tools.filter(t => !t.nested).every(t => t.images !== null)
      ? r.tools.filter(t => !t.nested).reduce((n, t) => n + t.images, 0) : null;
  return { routing, actualModels: JSON.parse(descriptor), accountIdentity: 'unknown', runs: runs.length,
    complete: runs.filter(r => r.complete).length,
    partial: runs.filter(r => !r.complete).length,
    truncated: runs.filter(r => r.omittedEvents > 0).length,
    ratedPass: runs.filter(r => r.userRated && r.taskSuccess === true).length,
    ratedFail: runs.filter(r => r.userRated && r.taskSuccess === false).length,
    unrated: runs.filter(r => !r.userRated).length,
    distinctSessions: new Set(runs.map(r => r.sessionId)).size,
    repeatedSessionRuns: runs.length - new Set(runs.map(r => r.sessionId)).size,
    nonFreshContextRuns: runs.filter(r => r.initialAssistantMessages !== null && r.initialAssistantMessages > 0).length,
    unknownInitialContextRuns: runs.filter(r => r.initialAssistantMessages === null).length,
    observedCompactionCounts: { starts: runs.reduce((n, r) => n + r.compaction.starts, 0),
      successes: runs.reduce((n, r) => n + r.compaction.successes, 0),
      failures: runs.reduce((n, r) => n + r.compaction.failures, 0),
      overflowRetryOffered: runs.reduce((n, r) => n + r.compaction.overflowRetryOffered, 0) },
    eligible: eligible.length,
    rejectedNonFreshEligibleContext, rejectedRepeatedSessionEligible,
    completedUnratedElapsedMedianMs: median(runs.filter(r => r.complete && r.outcome === 'completed' && !r.userRated).map(r => r.elapsedMs)),
    eligibleMetrics: { elapsedMs: { median: median(elapsed), min: elapsed.length ? Math.min(...elapsed) : null, max: elapsed.length ? Math.max(...elapsed) : null },
      modelMessages: covered(eligible, r => r.models.length), toolCalls: covered(eligible, r => r.tools.length),
      rootToolResultImageBlocks: covered(eligible, rootImages),
      observedToolErrors: perTools(t => t.error === null ? null : Number(t.error)),
      observedModelStopErrors: covered(eligible, r => r.models.every(m => m.stopError !== null) ? r.models.filter(m => m.stopError).length : null),
      toolWallUnionMs: covered(eligible, r => toolWallUnion(r.tools)),
      hostObservedModelTurnMs: covered(eligible, r => r.models.every(m => m.modelTurnMs !== null) ? r.models.reduce((n, m) => n + m.modelTurnMs, 0) : null),
      observedAssistantUsage: Object.fromEntries(FIELDS.map(field => [field, covered(eligible, r => r.usage[field])])),
      uncertainUsageMessages: covered(eligible, r => r.uncertainUsageMessages),
      catalogCostEstimate: covered(eligible, r => r.catalogCostEstimate),
      compaction: { starts: covered(eligible, r => r.compaction.starts),
        successes: covered(eligible, r => r.compaction.successes), failures: covered(eligible, r => r.compaction.failures),
        overflowRetryOffered: covered(eligible, r => r.compaction.overflowRetryOffered),
        successDurationMs: covered(eligible, r => r.compaction.successDurationMs),
        failureDurationMs: covered(eligible, r => r.compaction.failureDurationMs),
        usage: Object.fromEntries(FIELDS.map(field => [field, covered(eligible, r => r.compaction.usage[field])])),
        catalogCostEstimate: covered(eligible, r => r.compaction.catalogCostEstimate) },
      totalTaskTokens: null, realBillingCost: null } };
}

async function main() {
  const { label, dir, json } = args(process.argv.slice(2));
  const stat = await lstat(dir).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Report directory is missing or unsafe');
  const entries = await readdir(dir);
  let rejectedReports = 0;
  const runs = [];
  for (const name of entries) {
    if (!UUID.test(name.slice(0, -5)) || !name.endsWith('.json')) continue;
    const report = await readReport(dir, name);
    if (!report) rejectedReports++;
    else if (report.label === label) runs.push(report);
  }
  if (!runs.length) throw new Error('No matching valid reports. Enable /computer-use debug on neutral-label in fresh sessions, complete tasks, and rate via /computer-use debug result pass|fail.');
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.routing}:${describe(run)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  // A session repeated in a different routing/model group is still not a fresh independent run.
  const sessionCounts = new Map();
  for (const run of runs) sessionCounts.set(run.sessionId, (sessionCounts.get(run.sessionId) ?? 0) + 1);
  const summaries = [...groups.values()].map(group => summarize(group[0].routing, describe(group[0]), group, sessionCounts))
    .sort((a, b) => a.routing.localeCompare(b.routing) || JSON.stringify(a.actualModels).localeCompare(JSON.stringify(b.actualModels)));
  const distinctSessions = new Set(runs.map(r => r.sessionId)).size;
  const result = { label, scannedMatchingReports: runs.length, rejectedReports,
    distinctSessions, repeatedSessionRuns: runs.length - distinctSessions, groups: summaries,
    warnings: [
      'A shared label does not prove identical task, environment or fresh session; inspect repeatedSessionRuns and initial-context counts.',
      'Actual provider/model IDs and selected, message, provider thinking levels are reported separately (null = absent); account identity and configuration version are not recorded. Verify both independently.',
      'Eligible performance uses only complete, completed, user-rated pass runs with known zero assistant messages before the run and exactly one matching report per session across all groups. Exclusion counts are sequential; no winner is inferred.',
      'Host elapsed, model-turn spans and overlapping tool-wall union are different measures; do not add them. Any uncertain assistant usage makes all assistant usage fields and catalog cost unknown.',
      'Root tool-result image blocks exclude nested spans; they are not distinct captures, model-billed images or quota.',
      'Assistant-message usage and compaction-entry usage are separate observed subtotals; failed/absent compactions and SDK retries may consume unobserved tokens. No deduplicated total task tokens are available.',
      'Compaction durations are host-observed for matching end/failure events only; partial or truncated event coverage is unknown.',
      'Catalog cost is an estimate, not real billing/subscription cost or quota; zero estimated cost does not mean free.' ] };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Computer use comparison: ${label} (${runs.length} matching, ${rejectedReports} rejected)`);
    for (const group of summaries) {
      console.log(`\n${group.routing} actual models ${JSON.stringify(group.actualModels)} (account unknown)`);
      console.log(`runs ${group.runs}, complete/partial/truncated ${group.complete}/${group.partial}/${group.truncated}, rated pass/fail/unrated ${group.ratedPass}/${group.ratedFail}/${group.unrated}, eligible ${group.eligible} (excluded nonfresh/unknown context ${group.rejectedNonFreshEligibleContext}, repeated session ${group.rejectedRepeatedSessionEligible}); distinct sessions ${group.distinctSessions}, repeated ${group.repeatedSessionRuns}, nonfresh context ${group.nonFreshContextRuns}, unknown context ${group.unknownInitialContextRuns}`);
      console.log(`observed compaction counts (all runs): ${JSON.stringify(group.observedCompactionCounts)}`);
      console.log(`eligible metrics (unknown = null): ${JSON.stringify(group.eligibleMetrics)}`);
      console.log(`completed unrated elapsed median (preview, not comparable): ${group.completedUnratedElapsedMedianMs ?? 'unknown'}`);
    }
    console.log(`\nAll groups: distinct sessions ${distinctSessions}, repeated session runs ${result.repeatedSessionRuns}`);
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  }
}
main().catch(error => { const message = error instanceof Error ? error.message : '';
  console.error(`Comparison error: ${message.startsWith('No matching') || message.startsWith('Usage:') || message.startsWith('Use a neutral') || message.startsWith('Report directory') ? message : 'Unable to read reports or arguments'}`); process.exitCode = 1; });
