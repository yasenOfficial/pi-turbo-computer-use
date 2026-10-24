// Native ESM bridge: Pi's TS/Jiti loader may preserve an earlier .mjs namespace
// across /reload. Import a source-addressed module on each explicit factory load.
// This performs filesystem reads only; it never starts a container or daemon.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function loadBrowserDockerRuntime() {
 const source = new URL('../../../scripts/browser-docker.mjs', import.meta.url);
 const digest = createHash('sha256').update(await readFile(source)).digest('hex');
 const { BrowserDockerRuntime } = await import(`${source.href}?source=${digest}`);
 return BrowserDockerRuntime;
}
