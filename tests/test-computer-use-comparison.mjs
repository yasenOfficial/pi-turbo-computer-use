import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = path.resolve('scripts/compare-computer-use.mjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sentinel = 'PRIVATE_PROMPT_ERROR_TIMELINE_SENTINEL';
function fixture(n, changes = {}) {
  const modelCalls = changes.modelCalls ?? [{ provider: 'provider.test', modelId: 'sol-1',
    selectedThinkingLevel: 'high', thinkingLevel: 'medium', providerThinkingLevel: 'low',
    modelTurnMs: 30, stopReason: 'stop' }];
  return { schemaVersion: 1, id: id(n), sessionId: id(n + 100), label: 'bench-blink', routing: 'single',
    startedAt: '2025-01-01T00:00:00.000Z',
    outcome: 'completed', complete: true, taskSuccess: true, userRated: true, elapsedMs: 100,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    usageSamples: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 1 },
    observedAssistantMessages: modelCalls.length, uncertainUsageMessages: 0,
    retryCount: null, totalTaskTokens: null,
    costSamples: 1, catalogCostEstimate: 0, billingCost: null, omittedEvents: 0, modelCalls,
    compactionStarts: 0, compactionSuccesses: 0, compactionFailures: 0, overflowRetryOffered: 0,
    compactionUsage: {}, compactionUsageSamples: {}, compactionCatalogCostEstimate: null,
    compactionCostSamples: 0,
    tools: [{ nested: false, atMs: 10, elapsedMs: 30, images: 1, error: false },
      { nested: false, atMs: 20, elapsedMs: 30, images: 0, error: true }],
    timeline: [{ type: 'run_start', assistantMessagesBeforeRun: 0 }, { type: sentinel, error: sentinel }],
    prompt: sentinel, errors: sentinel, ...changes };
}
async function put(dir, n, data) { await writeFile(path.join(dir, `${id(n)}.json`), JSON.stringify(data)); }
function run(dir, ...args) { return spawnSync(process.execPath, [script, '--label', 'bench-blink', '--dir', dir, ...args], { encoding: 'utf8' }); }

test('offline comparison uses only safe aggregates and separates routing / actual model / thinking', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-computer-use-'));
  try {
    await put(dir, 1, fixture(1));
    await put(dir, 2, fixture(2, { routing: 'hybrid', modelCalls: [
      { provider: 'provider.test', modelId: 'sol-1', selectedThinkingLevel: 'high', modelTurnMs: 20 },
      { provider: 'provider.test', modelId: 'luna-1', selectedThinkingLevel: 'low', modelTurnMs: 40 }],
      usageSamples: { input: 1, output: 2, cacheRead: 2, cacheWrite: 2, totalTokens: 2 }, elapsedMs: 120 }));
    await put(dir, 3, fixture(3, { taskSuccess: null, userRated: false, elapsedMs: 1000 }));
    await put(dir, 4, fixture(4, { complete: false, omittedEvents: 1, elapsedMs: 9000 }));
    await put(dir, 5, fixture(5, { label: 'other-label' }));
    await put(dir, 6, fixture(6, { taskSuccess: false,
      timeline: [{ type: 'run_start', assistantMessagesBeforeRun: 1 }] }));
    const out = run(dir, '--json');
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout + out.stderr, /PRIVATE_PROMPT_ERROR_TIMELINE_SENTINEL/);
    const result = JSON.parse(out.stdout);
    assert.equal(result.scannedMatchingReports, 5);
    assert.equal(result.repeatedSessionRuns, 0);
    assert.equal(result.groups.length, 2);
    const single = result.groups.find(g => g.routing === 'single');
    assert.equal(single.runs, 4);
    assert.equal(single.complete, 3);
    assert.equal(single.partial, 1);
    assert.equal(single.truncated, 1);
    assert.equal(single.ratedFail, 1);
    assert.equal(single.nonFreshContextRuns, 1);
    assert.equal(single.unrated, 1);
    assert.equal(single.eligible, 1);
    assert.equal(single.rejectedNonFreshEligibleContext, 0);
    assert.equal(single.rejectedRepeatedSessionEligible, 0);
    assert.deepEqual(single.eligibleMetrics.elapsedMs, { median: 100, min: 100, max: 100 });
    assert.equal(single.completedUnratedElapsedMedianMs, 1000);
    assert.equal(single.eligibleMetrics.toolWallUnionMs.total, 40);
    assert.equal(single.eligibleMetrics.rootToolResultImageBlocks.total, 1);
    assert.equal(single.eligibleMetrics.observedToolErrors.total, 1);
    assert.equal(single.eligibleMetrics.catalogCostEstimate.total, 0);
    assert.equal(single.eligibleMetrics.realBillingCost, null);
    assert.equal(single.eligibleMetrics.totalTaskTokens, null);
    assert.equal(single.actualModels[0].selectedThinkingLevel, 'high');
    assert.equal(single.actualModels[0].messageThinkingLevel, 'medium');
    assert.equal(single.actualModels[0].providerThinkingLevel, 'low');
    assert.equal(single.observedCompactionCounts.starts, 0);
    assert.match(result.warnings.join(' '), /zero estimated cost does not mean free/);
    const hybrid = result.groups.find(g => g.routing === 'hybrid');
    assert.equal(hybrid.actualModels.length, 2);
    assert.equal(hybrid.eligibleMetrics.observedAssistantUsage.input.total, null); // one usage sample for two messages
    assert.equal(hybrid.eligibleMetrics.observedAssistantUsage.input.knownRuns, 0);
    assert.equal(hybrid.accountIdentity, 'unknown');
    const text = run(dir);
    assert.equal(text.status, 0);
    assert.doesNotMatch(text.stdout, /PRIVATE_PROMPT_ERROR_TIMELINE_SENTINEL/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('uncertain SDK usage hides every assistant field; only root result image blocks are counted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-computer-use-'));
  try {
    await put(dir, 11, fixture(11, { uncertainUsageMessages: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      usageSamples: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 1 },
      tools: [{ nested: false, atMs: 10, elapsedMs: 30, images: 1, error: false },
        { nested: true, atMs: 15, elapsedMs: 10, images: 1, error: false }] }));
    await put(dir, 12, fixture(12, { modelCalls: [{ provider: 'provider.test', modelId: 'sol-2',
      selectedThinkingLevel: 'high', stopReason: 'stop' }], usageMayContainPlaceholders: true }));
    await put(dir, 13, fixture(13, { modelCalls: [{ provider: 'provider.test', modelId: 'sol-3',
      selectedThinkingLevel: 'high', stopReason: 'stop' }], uncertainAssistantUsageMessages: 1,
      tools: [{ atMs: 10, elapsedMs: 30, images: 1, error: false }] }));
    const output = run(dir, '--json');
    assert.equal(output.status, 0, output.stderr);
    const groups = JSON.parse(output.stdout).groups;
    const uncertain = groups.find(g => g.actualModels[0].modelId === 'sol-1').eligibleMetrics;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      assert.equal(uncertain.observedAssistantUsage[field].knownRuns, 0, field);
      assert.equal(uncertain.observedAssistantUsage[field].total, null, field);
    }
    assert.equal(uncertain.catalogCostEstimate.total, null);
    assert.equal(uncertain.rootToolResultImageBlocks.total, 1);
    assert.equal(uncertain.toolCalls.total, 2);
    assert.equal(uncertain.toolWallUnionMs.total, 30);
    const flag = groups.find(g => g.actualModels[0].modelId === 'sol-2').eligibleMetrics;
    assert.equal(flag.observedAssistantUsage.input.total, null);
    assert.equal(flag.observedAssistantUsage.cacheRead.total, null);
    assert.equal(flag.catalogCostEstimate.total, null);
    const missingNested = groups.find(g => g.actualModels[0].modelId === 'sol-3').eligibleMetrics;
    assert.equal(missingNested.observedAssistantUsage.output.total, null);
    assert.equal(missingNested.rootToolResultImageBlocks.knownRuns, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fresh cohort excludes repeated sessions across groups and unknown or nonzero initial context', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-computer-use-'));
  try {
    await put(dir, 21, fixture(21));
    await put(dir, 22, fixture(22, { sessionId: id(121), routing: 'hybrid' }));
    await put(dir, 23, fixture(23, { timeline: [] }));
    await put(dir, 24, fixture(24, { timeline: [{ type: 'run_start', assistantMessagesBeforeRun: 1 }] }));
    const output = run(dir, '--json');
    assert.equal(output.status, 0, output.stderr);
    const comparison = JSON.parse(output.stdout);
    assert.equal(comparison.repeatedSessionRuns, 1);
    const single = comparison.groups.find(g => g.routing === 'single');
    const hybrid = comparison.groups.find(g => g.routing === 'hybrid');
    assert.equal(single.eligible, 0);
    assert.equal(single.rejectedRepeatedSessionEligible, 1);
    assert.equal(single.rejectedNonFreshEligibleContext, 2);
    assert.equal(hybrid.eligible, 0);
    assert.equal(hybrid.rejectedRepeatedSessionEligible, 1);
    assert.equal(single.eligibleMetrics.elapsedMs.median, null);
    assert.equal(hybrid.eligibleMetrics.rootToolResultImageBlocks.total, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compaction report fields match debug observer schema; unknown token coverage stays separate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-computer-use-'));
  try {
    // Mirrors debug.ts overflow success + threshold failure: only compaction entry has token usage.
    const modelCalls = [{ provider: 'fixture', modelId: 'fixture-sol', selectedThinkingLevel: 'high',
      stopReason: 'error', modelTurnMs: 3 }];
    await put(dir, 7, fixture(7, { modelCalls, observedAssistantMessages: 1, uncertainUsageMessages: 1,
      usage: {}, usageSamples: {}, catalogCostEstimate: null, costSamples: 0,
      compactionStarts: 2, compactionSuccesses: 1, compactionFailures: 1, overflowRetryOffered: 1,
      compactionUsage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 12 },
      compactionUsageSamples: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 1 },
      compactionCatalogCostEstimate: 0.003, compactionCostSamples: 1,
      timeline: [{ type: 'run_start', assistantMessagesBeforeRun: 0 },
        { type: 'compaction_end', elapsedMs: 7, summary: sentinel },
        { type: 'compaction_failed', elapsedMs: 2, errorMessage: sentinel }] }));
    await put(dir, 8, fixture(8, { modelCalls: [{ provider: 'fixture', modelId: 'fixture-sol',
      selectedThinkingLevel: 'low', modelTurnMs: 3, stopReason: 'stop' }],
      usage: { input: 0, output: 0, totalTokens: 0 }, uncertainUsageMessages: 1,
      usageSamples: { input: 1, output: 1, totalTokens: 1 }, catalogCostEstimate: 0 }));
    const output = run(dir, '--json');
    assert.equal(output.status, 0, output.stderr);
    assert.doesNotMatch(output.stdout + output.stderr, /PRIVATE_PROMPT_ERROR_TIMELINE_SENTINEL/);
    const groups = JSON.parse(output.stdout).groups;
    assert.equal(groups.length, 2); // selected thinking level, not optional message.thinkingLevel
    const high = groups.find(g => g.actualModels[0].selectedThinkingLevel === 'high');
    const compact = high.eligibleMetrics.compaction;
    assert.deepEqual(high.observedCompactionCounts, { starts: 2, successes: 1, failures: 1, overflowRetryOffered: 1 });
    assert.equal(compact.successDurationMs.total, 7);
    assert.equal(compact.failureDurationMs.total, 2);
    assert.equal(compact.usage.totalTokens.total, 12);
    assert.equal(compact.catalogCostEstimate.total, 0.003);
    assert.equal(high.eligibleMetrics.observedAssistantUsage.totalTokens.total, null);
    assert.equal(high.eligibleMetrics.totalTaskTokens, null);
    const low = groups.find(g => g.actualModels[0].selectedThinkingLevel === 'low');
    assert.equal(low.eligibleMetrics.observedAssistantUsage.input.total, null);
    assert.equal(low.eligibleMetrics.observedAssistantUsage.output.total, null);
    assert.equal(low.eligibleMetrics.observedAssistantUsage.totalTokens.total, null); // zero placeholder
    assert.equal(low.eligibleMetrics.compaction.usage.totalTokens.knownRuns, 0);
    assert.equal(low.eligibleMetrics.compaction.successDurationMs.total, 0);
    assert.equal(low.eligibleMetrics.compaction.catalogCostEstimate.total, null);
    assert.equal(low.eligibleMetrics.catalogCostEstimate.total, null); // failed message's zero cost is not proof
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('incomplete compaction usage samples and absent assistant messages remain unknown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-computer-use-'));
  try {
    await put(dir, 10, fixture(10, { modelCalls: [], observedAssistantMessages: 0, uncertainUsageMessages: 0,
      usage: {}, usageSamples: {}, catalogCostEstimate: null, costSamples: 0,
      compactionStarts: 2, compactionSuccesses: 2,
      compactionUsage: { totalTokens: 12, input: 7 }, compactionUsageSamples: { totalTokens: 1, input: 1 },
      compactionCostSamples: 1, compactionCatalogCostEstimate: 0.003,
      timeline: [{ type: 'run_start', assistantMessagesBeforeRun: 0 },
        { type: 'compaction_end', elapsedMs: 7, errorMessage: sentinel },
        { type: 'compaction_end', errorMessage: sentinel }] }));
    const output = run(dir, '--json');
    assert.equal(output.status, 0, output.stderr);
    const group = JSON.parse(output.stdout).groups[0];
    assert.deepEqual(group.actualModels, []);
    assert.equal(group.eligibleMetrics.modelMessages.total, 0);
    assert.equal(group.eligibleMetrics.observedAssistantUsage.totalTokens.total, null);
    assert.equal(group.eligibleMetrics.compaction.usage.totalTokens.knownRuns, 0);
    assert.equal(group.eligibleMetrics.compaction.catalogCostEstimate.total, null);
    assert.equal(group.eligibleMetrics.compaction.successDurationMs.total, null);
    assert.doesNotMatch(output.stdout, /PRIVATE_PROMPT_ERROR_TIMELINE_SENTINEL/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects unsafe or malformed UUID reports; ignores all other files without reading them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-computer-use-'));
  try {
    await put(dir, 1, fixture(1, { timeline: [{ type: 'run_start', assistantMessagesBeforeRun: 2 }] }));
    await writeFile(path.join(dir, `${id(2)}.json`), '{not json');
    await writeFile(path.join(dir, `${id(3)}.json`), 'x'.repeat(1024 * 1024 + 1));
    await symlink(path.join(dir, `${id(1)}.json`), path.join(dir, `${id(4)}.json`));
    await put(dir, 5, fixture(5, { modelCalls: [{ provider: `${sentinel}/unsafe`, modelId: 'x', selectedThinkingLevel: 'low' }] }));
    await writeFile(path.join(dir, 'private-unrelated.json'), sentinel);
    const out = run(dir, '--json');
    assert.equal(out.status, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    assert.equal(result.rejectedReports, 4);
    assert.equal(result.scannedMatchingReports, 1);
    assert.equal(result.groups[0].nonFreshContextRuns, 1);
    assert.equal(result.groups[0].eligible, 0);
    assert.equal(result.groups[0].rejectedNonFreshEligibleContext, 1);
    assert.doesNotMatch(out.stdout + out.stderr, /PRIVATE_PROMPT_ERROR_TIMELINE_SENTINEL/);
    assert.equal(run(dir, '--label', sentinel).status, 1); // duplicate option
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('requires label and reports no-match without disclosing file contents', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-computer-use-'));
  try {
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1);
    const noMatch = run(dir);
    assert.equal(noMatch.status, 1);
    assert.match(noMatch.stderr, /\/computer-use debug/);
    assert.doesNotMatch(noMatch.stderr, /\/computer debug/);
    assert.equal(run(dir, '--bad').status, 1);
    assert.equal(spawnSync(process.execPath, [script, '--label', 'task contents'], { encoding: 'utf8' }).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
