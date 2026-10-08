#!/usr/bin/env node
// Isolated SDK session and fake streaming provider; never reaches a real provider or desktop.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const sdk = [process.env.PI_CODING_AGENT_PACKAGE,
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	...(existsSync(releases) ? readdirSync(releases).sort().reverse().map(r => path.join(releases, r, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])].find(p => p && existsSync(p));
if (!sdk) throw new Error("Compatible Pi SDK not found; set PI_CODING_AGENT_PACKAGE");
const sdkDir = path.dirname(sdk);
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(sdkDir, "dist/index.js")));
const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-routing-fixture-"));
const extensionPath = path.join(tmp, "routing-fixture.ts");
const routingPath = path.resolve(import.meta.dirname, "../.pi/extensions/computer-use/routing.ts");
const aiPath = path.join(path.dirname(sdkDir), "pi-ai/dist/index.js");
let session;
try {
	await writeFile(extensionPath, `import { ComputerUseRouting } from ${JSON.stringify(routingPath)};
import { createAssistantMessageEventStream } from ${JSON.stringify(aiPath)};
const models = ['gpt-sol','gpt-luna','gpt-original'].map(id => ({ id, name:id, api:'routing-fixture', provider:'routing-fixture', baseUrl:'http://127.0.0.1/never', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:100000,maxTokens:1000 }));
let count = 0;
export default function(pi) {
  pi.registerProvider('routing-fixture', { api:'routing-fixture', apiKey:'fixture-test-only', models, streamSimple(model, context) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const index = count++;
      const tool = index === 0 ? { name:'desktop_model_phase', arguments:{phase:'execute',plan:'Observe then verify'} }
        : index === 1 ? { name:'desktop_model_phase', arguments:{phase:'escalate',reason:'verified blocker',verified_state:'fixture state observed'} } : undefined;
      const content = tool ? [{type:'toolCall', id:'fixture-'+index, name:tool.name, arguments:tool.arguments}] : [{type:'text',text:'Fixture complete'}];
      const message = {role:'assistant', api:model.api, provider:model.provider, model:model.id, content,
        stopReason:tool?'toolUse':'stop', usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
      stream.push({type:'start',partial:message});
      if(tool) stream.push({type:'toolcall_start',contentIndex:0,partial:message});
      if(tool) stream.push({type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message});
      stream.push({type:'done',reason:message.stopReason,message}); stream.end();
    });
    return stream;
  }});
  const mode = { isEnabled:()=>true, isWaitingForUser:()=>false };
  const routing = new ComputerUseRouting(pi,mode);
  pi.registerCommand('fixture-hybrid',{handler:async (_args,ctx)=>{ await routing.command('hybrid',ctx); }});
  pi.on('session_start',(_event,ctx)=>routing.start(ctx));
  pi.on('session_tree',(_event,ctx)=>routing.start(ctx));
  pi.on('before_agent_start',(event,ctx)=>routing.beforeStart(event,ctx));
  pi.on('agent_settled',()=>{ globalThis.__routingFixtureSettled = (globalThis.__routingFixtureSettled ?? 0) + 1; });
}
`);
	const settingsManager = SettingsManager.create(tmp, path.join(tmp, "agent"), { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({ cwd: tmp, agentDir: path.join(tmp, "agent"), settingsManager, additionalExtensionPaths: [extensionPath], noContextFiles: true });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await createAgentSession({ cwd: tmp, agentDir: path.join(tmp, "agent"), settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(tmp) }));
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: e => errors.push(e) });
	const fixture = resourceLoader.getExtensions().extensions.find(e => e.path === extensionPath);
	assert.ok(fixture?.commands.get("fixture-hybrid"), "real resource loader registered fixture command");
	const original = session.modelRuntime.getModel("routing-fixture", "gpt-sol");
	assert.ok(original, "real registry sees fixture physical model");
	await session.setModel(original);
	await session.prompt("/fixture-hybrid");
	assert.equal(session.model.provider, "computer-use", "visible virtual selection");
	const settledBefore = globalThis.__routingFixtureSettled ?? 0;
	await session.prompt("Fixture desktop task");
	assert.equal(globalThis.__routingFixtureSettled, settledBefore + 1, "no premature settlement during either handoff");
	const answers = session.messages.filter(m => m.role === "assistant");
	assert.deepEqual(answers.map(m => m.model), ["gpt-sol", "gpt-luna", "gpt-sol"]);
	assert.deepEqual(errors, []);
	assert.equal(session.model.provider, "computer-use", "virtual selection stays in footer model");
	console.log("Real Pi fake provider: loaded fixture, one native session Sol → Luna → Sol without premature settlement");
} finally {
	session?.dispose();
	await rm(tmp, { recursive: true, force: true });
}
