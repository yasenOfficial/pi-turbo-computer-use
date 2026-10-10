import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { benchmark, provenance, scenarioIds } from '../scripts/benchmark-execution-strategy.mjs';

const runner = resolve('scripts/benchmark-execution-strategy.mjs');
test('pinned baseline source is read with git show, never inferred from installed binary', async () => {
  const source = await provenance();
  assert.match(source.baseline_commit, /^04cd834[0-9a-f]{33}$/);
  assert.equal(source.baseline_native_binary_identity, null);
  assert.equal(source.legacy_type_text_source_unchanged, true);
  assert.equal(Object.keys(source.sources).length, 5);
  assert.equal(source.sources['daemon/src/clipboard.rs'].baseline_sha256, null);
  for (const entry of Object.values(source.sources).filter(item => item.baseline_sha256 !== null)) {
    assert.match(entry.baseline_sha256, /^[0-9a-f]{64}$/);
    assert.match(entry.working_tree_sha256, /^[0-9a-f]{64}$/);
  }
});

test('regression: baseline GUI-first Sol plan vs current CLI-first plan with explicit GUI preserved', async () => {
  const old = spawnSync('git', ['show', '04cd834:.pi/extensions/computer-use/routing.ts'],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(old.status, 0);
  const current = await readFile(resolve('.pi/extensions/computer-use/routing.ts'), 'utf8');
  const instructions = await readFile(resolve('.pi/extensions/computer-use/instructions.ts'), 'utf8');
  assert.match(old.stdout, /Call desktop_model_phase\(\{phase:'execute',plan\}\) exactly once/);
  assert.doesNotMatch(old.stdout, /If existing Pi native file\/API\/CLI tools can finish/);
  assert.match(current, /If existing Pi native file\/API\/CLI tools can finish/);
  assert.match(current, /Honor explicit GUI intent/);
  assert.match(instructions, /Do not replace an explicitly requested browser\/UI action/);
  assert.match(instructions, /Pi read the specified file, then enter it in a verified GUI field/);
  // Policy text is not evidence that an actual model chose those tools.
});

test('eight requested cases: real isolated filesystem/process fixture verification, GUI never fabricated', async () => {
  const report = await benchmark({ samples: 2 });
  assert.deepEqual(report.results.map(row => row.id), scenarioIds);
  assert.equal(report.model_provider_calls, 0);
  for (const row of report.results) {
    assert.equal(row.baseline, null);
    assert.equal(row.optimized, null);
    if ([scenarioIds[0], scenarioIds[2], scenarioIds[5]].includes(row.id)) {
      assert.equal(row.status, 'fixture_pass');
      assert.equal(row.fixture_execution.sample_count, 2);
      assert.equal(row.fixture_execution.verified_result, true);
      assert.equal(row.fixture_execution.desktop_calls, 0);
      assert.equal(row.fixture_execution.model_tokens, null);
      assert.equal(row.fixture_execution.keyboard_events, null);
      assert.ok(row.fixture_execution.wall_ms_p50 >= 0);
      assert.ok(row.fixture_execution.wall_ms_p95 >= row.fixture_execution.wall_ms_p50);
    } else {
      assert.equal(row.status, 'skipped');
      assert.equal(row.fixture_execution, null);
    }
  }
});

test('GUI worker refuses direct invocation with an inherited host display/runtime', () => {
  const guard = spawnSync('bash', [resolve('tests/test-execution-gui-isolation.sh'), '--worker'], {
    encoding: 'utf8', timeout: 3000,
    env: { ...process.env, DISPLAY: ':0', PI_EXECUTION_PRIVATE_DISPLAY: ':0',
      HOME: '/tmp/home', XDG_RUNTIME_DIR: '/tmp/runtime' },
  });
  assert.notEqual(guard.status, 0);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /fixture is not on its private display\/home\/runtime/);
});

test('explicit opt-in GUI replay uses only private Xephyr/net/PID namespace and real daemon IPC',
  { skip: process.env.PI_EXECUTION_GUI_TEST !== '1' }, async () => {
    const result = spawnSync(process.execPath, [runner, '--samples', '1', '--gui'],
      { encoding: 'utf8', timeout: 190_000 });
    assert.equal(result.status, 0, result.stderr.slice(0, 400));
    const report = JSON.parse(result.stdout);
    for (const id of [scenarioIds[1], scenarioIds[3], scenarioIds[4], scenarioIds[6], scenarioIds[7]]) {
      const row = report.results.find(item => item.id === id);
      if (id === scenarioIds[6] && row.status === 'skipped') {
        assert.equal(row.fixture_execution, null);
        continue;
      }
      assert.equal(row.status, 'fixture_pass', row.reason);
      assert.equal(row.fixture_execution.verified_result, true);
      assert.ok(row.fixture_execution.daemon_requests > 0);
      assert.equal(row.fixture_execution.image_blocks, 0);
      assert.equal(row.fixture_execution.agent_tool_calls, null);
      assert.equal(row.baseline, null);
    }
    assert.match(report.gui_working_tree_native_binary_sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.results[4].fixture_execution.reported_paste_keyboard_events, 4);
    assert.equal(report.results[7].fixture_execution.reported_paste_keyboard_events, 4);
    const comparison = report.controlled_input_comparison;
    assert.equal(comparison.status, 'verified');
    assert.equal(comparison.scope, 'same_working_tree_native_binary_private_browser_fixture');
    assert.equal(comparison.payload_ascii_characters, 150);
    assert.equal(comparison.legacy_type_text.verified_result, true);
    assert.equal(comparison.clipboard_paste.verified_result, true);
    assert.deepEqual([comparison.legacy_type_text.dom_trusted_keydown,
      comparison.legacy_type_text.dom_trusted_keyup, comparison.legacy_type_text.dom_trusted_paste], [150, 150, 0]);
    assert.deepEqual([comparison.clipboard_paste.dom_trusted_keydown,
      comparison.clipboard_paste.dom_trusted_keyup, comparison.clipboard_paste.dom_trusted_paste], [2, 2, 1]);
    assert.equal(comparison.clipboard_paste.native_reported_paste_keyboard_events, 4);
    assert.equal(comparison.legacy_type_text.agent_tool_calls, null);
    assert.doesNotMatch(result.stdout, /Първи ред|Second line: English|\/tmp\/pi-execution-gui/);
  });

test('CLI is bounded, outputs safe aggregate metadata only, and rejects unexpected options', () => {
  const run = (...args) => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 15000 });
  const output = run('--samples', '1');
  assert.equal(output.status, 0, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.results.length, 8);
  assert.doesNotMatch(output.stdout + output.stderr, /fixture stdout: 42|Line 001:|name = "fixture"|\/home\/yasen|png_base64/);
  for (const invalid of [['--samples', '0'], ['--samples', '21'], ['--json'], ['--samples', '1', '--extra']]) {
    const bad = run(...invalid);
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, '');
  }
});
