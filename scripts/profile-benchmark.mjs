#!/usr/bin/env node
// Read-only IPC profiling against a child daemon on an isolated temporary socket.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1]) throw new Error(`missing value for ${name}`);
  return args[i + 1];
};
const count = Number(option('--count', '30'));
const warmup = Number(option('--warmup', '3'));
if (![count, warmup].every(Number.isSafeInteger) || count < 1 || count > 10000 || warmup < 0 || warmup > 1000) {
  throw new Error('count must be 1..10000 and warmup 0..1000');
}
const executable = resolve(option('--daemon', join(root, 'daemon/target/debug/pi-turbo-daemon')));
const temporary = await mkdtemp(join(tmpdir(), 'pi-profile-'));
const socket = join(temporary, 'bench.sock');
await writeFile(join(temporary, 'config.toml'), '');
const child = spawn(executable, [], {
  env: { ...process.env, COMPUTER_USE_SOCKET: socket, COMPUTER_USE_CONFIG: join(temporary, 'config.toml'), COMPUTER_USE_OVERLAY: 'false', COMPUTER_USE_DEBUG: 'false' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
let client;
let pending;
let buffer = '';
const delay = ms => new Promise(done => setTimeout(done, ms));
async function connect() {
  return new Promise((yes, no) => {
    const stream = net.createConnection(socket);
    stream.once('connect', () => yes(stream));
    stream.once('error', no);
  });
}
function send(payload) {
  return new Promise((yes, no) => {
    if (pending) return no(new Error('concurrent request'));
    const timeout = setTimeout(() => { pending = null; no(new Error('IPC timeout')); }, 30000);
    pending = { yes, no, timeout };
    client.write(JSON.stringify(payload) + '\n', error => {
      if (error && pending) { clearTimeout(timeout); pending = null; no(error); }
    });
  });
}
function percentile(sorted, p) { return sorted[Math.ceil(sorted.length * p) - 1]; }
let metricsSupported = false;
async function measure(payload) {
  try {
    const timed = async () => {
      const start = performance.now();
      const sample = await send(payload);
      const elapsed = performance.now() - start;
      if (!sample.response.ok) throw new Error(sample.response.error || 'request failed');
      if (sample.response.png_base64 || sample.response.visual) throw new Error('unexpected image in read-only benchmark');
      return { elapsed, bytes: sample.bytes, characters: sample.characters };
    };
    const cold = await timed(); // First request, including any lazy backend initialization.
    for (let i = 0; i < warmup; i++) await timed();
    if (metricsSupported) {
      try {
        const reset = (await send({ cmd: 'metrics', reset: true })).response;
        metricsSupported = reset.ok === true && reset.metrics?.stages != null;
      } catch { metricsSupported = false; }
    }
    const samples = [];
    for (let i = 0; i < count; i++) samples.push(await timed());
    const values = samples.map(sample => sample.elapsed).sort((a, b) => a - b);
    const bytes = samples.map(sample => sample.bytes).sort((a, b) => a - b);
    const characters = samples.map(sample => sample.characters).sort((a, b) => a - b);
    const result = { count, cold_ms: cold.elapsed, cold_response_bytes: cold.bytes,
      cold_response_characters: cold.characters,
      p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95),
      response_bytes_total: bytes.reduce((sum, n) => sum + n, 0),
      response_bytes_p50: percentile(bytes, 0.5), response_bytes_p95: percentile(bytes, 0.95),
      response_characters_p50: percentile(characters, 0.5), response_characters_p95: percentile(characters, 0.95),
      // These lengths are raw IPC JSON, NOT model context or tool-output token counts.
      stages: null, capture_mode: null, capture_transport: null,
      transferred_pixels: null, capture_count: null };
    if (metricsSupported) {
      try {
        const reply = (await send({ cmd: 'metrics' })).response;
        if (reply.ok && reply.metrics?.stages) {
          Object.assign(result, { stages: reply.metrics.stages, capture_mode: reply.metrics.capture_mode,
            capture_transport: reply.metrics.capture_transport ?? null,
            transferred_pixels: reply.metrics.transferred_pixels, capture_count: reply.metrics.capture_count });
        } else metricsSupported = false;
      } catch { metricsSupported = false; } // Preserve already-measured wall/byte samples.
    }
    return result;
  } catch (error) {
    // Headless environments can lack X11; report this request as unavailable.
    return { unavailable: String(error.message) };
  }
}
try {
  let last;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`child daemon exited: ${stderr}`);
    try { client = await connect(); break; } catch (error) { last = error; await delay(100); }
  }
  if (!client) throw new Error(`child daemon did not start: ${last}; ${stderr}`);
  client.setEncoding('utf8');
  client.on('data', data => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = pending;
      pending = null;
      if (waiter) {
        clearTimeout(waiter.timeout);
        try {
          waiter.yes({ response: JSON.parse(line), bytes: Buffer.byteLength(line, 'utf8'), characters: Array.from(line).length });
        } catch (error) { waiter.no(error); }
      }
    }
  });
  client.on('error', error => { if (pending) { pending.no(error); clearTimeout(pending.timeout); pending = null; } });
  client.on('close', () => { if (pending) { pending.no(new Error('socket closed')); clearTimeout(pending.timeout); pending = null; } });
  try {
    const probe = (await send({ cmd: 'metrics' })).response;
    metricsSupported = probe.ok === true && probe.metrics?.stages != null;
  } catch { metricsSupported = false; }
  const results = {};
  for (const [label, payload] of Object.entries({
    ping: { cmd: 'ping' },
    observe: { cmd: 'observe' },
    dirty_regions: { cmd: 'dirty_regions' },
    search_seen: { cmd: 'search_seen', query: 'benchmark-unlikely-match', limit: 1 },
  })) results[label] = await measure(payload);
  console.log(JSON.stringify({ isolated: true, read_only: true, warmup,
    response_lengths: 'raw IPC JSON, excluding newline; not model-visible output or tokens',
    metrics_supported: metricsSupported, results }, null, 2));
} finally {
  client?.destroy();
  if (child.exitCode === null) child.kill('SIGTERM'); // only our spawned process
  await rm(temporary, { recursive: true, force: true });
}
