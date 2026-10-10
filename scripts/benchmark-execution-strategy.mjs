#!/usr/bin/env node
// Offline, test-owned fixture execution. This is NOT an agent/model decision benchmark.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = '04cd834';
const sourceFiles = [
  '.pi/extensions/computer-use/instructions.ts', '.pi/extensions/computer-use/routing.ts',
  '.pi/extensions/computer-use/tools.ts', 'daemon/src/input.rs',
];
const newSourceFiles = ['daemon/src/clipboard.rs'];
export const scenarioIds = [
  'create-200-line-text-file', 'open-file-in-gui-editor', 'run-python-and-check-stdout',
  'local-website-button', 'bulgarian-english-file-to-browser-form', 'edit-config',
  'open-existing-project-in-vscode', 'mixed-filesystem-and-gui',
];
const digest = content => createHash('sha256').update(content).digest('hex');
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 });
  if (result.status !== 0) throw new Error('Pinned baseline source is unavailable (git show failed)');
  return result.stdout;
}
export async function provenance() {
  const baselineCommit = git('rev-parse', `${BASELINE}^{commit}`).trim();
  assert.ok(baselineCommit.startsWith(BASELINE), 'incorrect baseline');
  const files = {};
  let legacyTypeTextUnchanged = false;
  for (const file of sourceFiles) {
    const before = git('show', `${baselineCommit}:${file}`); // never read baseline from working tree
    const current = await readFile(join(root, file));
    files[file] = { baseline_sha256: digest(before), working_tree_sha256: digest(current) };
    if (file === 'daemon/src/input.rs') {
      // Compare the actual retained function bodies, not the intervening source:
      // new paste-only methods can legitimately be inserted between them.
      // A missing/ambiguous signature or unbalanced body fails closed.
      const functionBody = (source, signature) => {
        const start = source.indexOf(signature);
        if (start < 0 || source.indexOf(signature, start + signature.length) !== -1) return null;
        const open = source.indexOf('{', start + signature.length);
        if (open < 0) return null;
        let depth = 0;
        for (let index = open; index < source.length; index++) {
          if (source[index] === '{') depth++;
          else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
        }
        return null;
      };
      const signatures = [
        'pub fn type_text(&self, text: &str) -> InputResult<()> {',
        'fn type_events(', 'fn validate_physical_text(', 'fn char_keysym(',
        'fn lookup(&self, symbol: u32) -> Option<(u8, bool)> {',
      ];
      legacyTypeTextUnchanged = signatures.every(signature => {
        const oldBody = functionBody(before, signature);
        return oldBody !== null && oldBody === functionBody(current.toString('utf8'), signature);
      });
    }
  }
  for (const file of newSourceFiles) {
    const current = await readFile(join(root, file)).catch(() => null);
    files[file] = { baseline_sha256: null, working_tree_sha256: current ? digest(current) : null };
  }
  return { baseline_commit: baselineCommit, working_tree_head: git('rev-parse', 'HEAD').trim(),
    sources: files, legacy_type_text_source_unchanged: legacyTypeTextUnchanged,
    baseline_native_binary_identity: null,
    note: 'git show verifies source provenance only. An installed/native binary is not attributed to this commit.' };
}
const fixture = {
  lines: Array.from({ length: 200 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')}: owned fixture — ред ${i + 1}`).join('\n') + '\n',
  python: 'print("fixture stdout: 42")\n',
  config: 'enabled = false\nname = "fixture"\n',
};
function percent(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}
async function executeFixture(id, dir) {
  let operations = 0;
  const put = async (name, value) => { operations++; await writeFile(join(dir, name), value, { flag: 'wx', mode: 0o600 }); };
  const get = async name => { operations++; return readFile(join(dir, name), 'utf8'); };
  if (id === scenarioIds[0]) {
    await put('200-lines.txt', fixture.lines);
    const observed = await get('200-lines.txt');
    assert.equal(observed, fixture.lines);
    assert.equal(observed.trimEnd().split('\n').length, 200);
  } else if (id === scenarioIds[2]) {
    await put('program.py', fixture.python);
    // Fixed program, -I isolated Python, no shell, network, provider, or user files.
    const child = spawnSync('python3', ['-I', '-S', 'program.py'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
    });
    operations++; // one actual process invocation, not a Pi tool call
    assert.equal(child.status, 0, 'fixture Python failed');
    assert.equal(child.stdout, 'fixture stdout: 42\n');
    assert.equal(child.stderr, '');
  } else if (id === scenarioIds[5]) {
    await put('settings.toml', fixture.config);
    const initial = await get('settings.toml');
    assert.equal(initial, fixture.config);
    operations++;
    await writeFile(join(dir, 'settings.toml'), initial.replace('enabled = false', 'enabled = true'), { flag: 'w', mode: 0o600 });
    assert.equal(await get('settings.toml'), 'enabled = true\nname = "fixture"\n');
  } else throw new Error('GUI fixture must not be silently simulated');
  return operations;
}
function unavailable(id) {
  return { id, status: 'skipped', reason: id === scenarioIds[4]
    ? 'No isolated private browser, local HTTP fixture, and verified registered desktop_paste_text path are provided by this runner.'
    : 'No isolated private X display and verified registered desktop_* GUI replay are provided by this runner.',
    fixture_execution: null, baseline: null, optimized: null };
}
export async function benchmark({ samples = 3, gui = false } = {}) {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20) throw new Error('samples must be 1..20');
  const source = await provenance();
  const results = [];
  let guiBinaryHash = null;
  let controlledInputComparison = null;
  for (const id of scenarioIds) {
    if (![scenarioIds[0], scenarioIds[2], scenarioIds[5]].includes(id)) {
      results.push(unavailable(id));
      continue;
    }
    const times = [];
    const calls = [];
    try {
      for (let i = 0; i < samples; i++) {
        const dir = await mkdtemp(join(tmpdir(), 'pi-execution-fixture-'));
        try {
          const start = performance.now();
          calls.push(await executeFixture(id, dir));
          times.push(performance.now() - start);
        } finally { await rm(dir, { recursive: true, force: true }); }
      }
      results.push({ id, status: 'fixture_pass', fixture_execution: {
        sample_count: samples, wall_ms_p50: percent(times, 0.5), wall_ms_p95: percent(times, 0.95),
        operations_per_sample: calls, operation_unit: 'instrumented Node fs calls / fixed Python process spawn, not Pi tool calls',
        verified_result: true, desktop_calls: 0, image_blocks: 0,
        keyboard_events: null, model_messages: null, model_tokens: null, billed_cost: null,
      }, baseline: null, optimized: null });
    } catch {
      results.push({ id, status: 'fixture_failed', reason: 'Fixture operation or verification failed; no measurements are eligible.',
        fixture_execution: null, baseline: null, optimized: null });
    }
  }
  if (gui) {
    // Only the isolation wrapper may start the private browser/daemon. Never
    // pass inherited DISPLAY to a browser or silently fall back to host GUI.
    const child = spawnSync('bash', [join(root, 'tests/test-execution-gui-isolation.sh')], {
      cwd: root, encoding: 'utf8', timeout: 175_000, maxBuffer: 128 * 1024,
    });
    const report = child.stdout?.split('\n').reverse().map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).find(value => value?.schema_version === 1 && value?.isolated === true);
    const valid = report?.network === 'private net namespace, loopback HTTP only'
      && /^[a-f0-9]{64}$/.test(report?.working_tree_native_binary_sha256 ?? '')
      && report?.browser_profile === 'test-owned private' && report?.model_provider_calls === 0
      && Array.isArray(report.cases) && report.cases.length === 5
      && new Set(report.cases.map(row => row.id)).size === 5;
    if (valid) {
      guiBinaryHash = report.working_tree_native_binary_sha256;
      const comparison = report.controlled_input_comparison;
      if (source.legacy_type_text_source_unchanged === true
        && comparison?.scope === 'same_working_tree_native_binary_private_browser_fixture'
        && comparison?.legacy_type_text?.verified_result === true
        && comparison?.clipboard_paste?.verified_result === true) controlledInputComparison = comparison;
    }
    for (const id of [scenarioIds[1], scenarioIds[3], scenarioIds[4], scenarioIds[6], scenarioIds[7]]) {
      const index = results.findIndex(row => row.id === id);
      const found = valid ? report.cases.find(row => row.id === id) : null;
      if (found && ['fixture_pass', 'fixture_failed', 'skipped'].includes(found.status)
        && (found.status !== 'fixture_pass' || (found.fixture_execution?.verified_result === true
          && found.fixture_execution.image_blocks === 0))) results[index] = found;
      else results[index] = { ...unavailable(id), reason: child.status === 77
        ? 'Private network/PID/X/browser prerequisite unavailable.'
        : 'Private GUI fixture setup or output failed; no GUI measurement eligible.' };
    }
  }
  return { schema_version: 1, experiment: 'fixture_execution_not_agent_strategy', isolated: true,
    model_provider_calls: 0, source, gui_working_tree_native_binary_sha256: guiBinaryHash,
    controlled_input_comparison: controlledInputComparison, results,
    warnings: [
      'The baseline is a pinned source snapshot, not a baseline agent run or an authenticated native binary.',
      'Filesystem/process samples are deterministic fixture operations; zero desktop calls is not evidence that an agent selected CLI tools.',
      'Controlled same-binary legacy typing vs paste is a low-level browser fixture comparison, NOT an old-extension agent run, real Pi tool call, or proof of overall speed, token, billing, or quota savings.',
      'Only explicitly passed isolated GUI fixture rows are eligible; other GUI cases and baseline/optimized outcomes remain null.',
    ] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const gui = args.includes('--gui');
    if (args.filter(arg => arg === '--gui').length > 1) throw new Error('Duplicate --gui');
    const options = args.filter(arg => arg !== '--gui');
    if (options.length !== 0 && (options.length !== 2 || options[0] !== '--samples' || !/^(?:[1-9]|1\d|20)$/.test(options[1])))
      throw new Error('Usage: node scripts/benchmark-execution-strategy.mjs [--samples 1..20] [--gui]');
    const report = await benchmark({ samples: options.length ? Number(options[1]) : 3, gui });
    console.log(JSON.stringify(report, null, 2));
    if (report.results.some(row => row.status === 'fixture_failed')) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
