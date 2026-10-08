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
  const providerConfig = { api:'routing-fixture', apiKey:'fixture-test-only', models, streamSimple(model, context) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const index = count++;
      const tool = index === 0 || index === 3 ? { name:'desktop_model_phase', arguments:{phase:'execute',plan:'Observe then verify'} }
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
  }};
  pi.registerProvider('routing-fixture', providerConfig);
  let enabled = false;
  const mode = { isEnabled:()=>enabled, isWaitingForUser:()=>false, setRoutingLabel:(label)=>{ globalThis.__routingFixtureLabel = label; } };
  const routing = new ComputerUseRouting(pi,mode);
  pi.registerCommand('fixture-hybrid',{handler:async (_args,ctx)=>{ await routing.command('hybrid',ctx); }});
  pi.registerCommand('fixture-summary',{handler:async (_args,ctx)=>{ globalThis.__routingFixtureSummary = routing.summary(ctx); }});
  pi.registerCommand('fixture-off',{handler:async (_args,ctx)=>{ enabled = false; routing.refreshLabel(ctx); }});
  pi.registerCommand('fixture-on',{handler:async (_args,ctx)=>{ enabled = true; routing.refreshLabel(ctx); }});
  pi.registerCommand('fixture-remove-luna',{handler:async ()=>{ pi.registerProvider('routing-fixture',
    {...providerConfig, models: models.filter(m => !m.id.endsWith('-luna'))}); }});
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
	assert.equal(globalThis.__routingFixtureLabel, undefined, "hybrid configured while OFF does not show a bar");
	assert.equal(session.model.id, "gpt-sol", "physical /model selection remains unchanged");
	await session.prompt("/fixture-on");
	assert.match(globalThis.__routingFixtureLabel, /gpt-sol → gpt-luna$/,
		"explicit ON refreshes routing label without a model request");
	assert.equal(session.modelRuntime.getModel("computer-use", "sol-luna"), undefined, "no virtual footer entry");
	await session.prompt("/fixture-summary");
	assert.match(globalThis.__routingFixtureSummary, /Sol gpt-sol; Luna gpt-luna/);
	assert.equal(session.messages.filter(m => m.role === "assistant").length, 0, "summary cannot request a model");
	const settledBefore = globalThis.__routingFixtureSettled ?? 0;
	await session.prompt("Fixture desktop task");
	assert.equal(globalThis.__routingFixtureSettled, settledBefore + 1, "no premature settlement during either handoff");
	const answers = session.messages.filter(m => m.role === "assistant");
	assert.deepEqual(answers.map(m => m.model), ["gpt-sol", "gpt-luna", "gpt-sol"]);
	assert.deepEqual(errors, []);
	assert.equal(session.model.id, "gpt-sol", "settlement restores physical model without a final model request");
	assert.match(globalThis.__routingFixtureLabel, /gpt-sol → gpt-luna$/);
	await session.prompt("Second fixture desktop task");
	assert.deepEqual(session.messages.filter(m => m.role === "assistant").map(m => m.model).slice(3), ["gpt-sol", "gpt-luna"],
		"normal completion switches once, not a speculative escalation");
	assert.equal(session.model.id, "gpt-sol", "normal completion restores original physical selection");
	await session.prompt("/fixture-off");
	await session.prompt("Ordinary OFF question");
	assert.equal(session.messages.filter(m => m.role === "assistant").at(-1).model, "gpt-sol",
		"OFF leaves ordinary questions on the physical model");
	assert.equal(globalThis.__routingFixtureLabel, undefined, "OFF hides routing label");
	await session.prompt("/fixture-on");
	await session.prompt("/fixture-remove-luna");
	assert.equal(session.extensionRunner.getModelRegistry().getAvailable().some(m =>
		m.provider === "routing-fixture" && m.id === "gpt-luna"), false, "test provider no longer offers Luna");
	const failedStart = await session.extensionRunner.emitBeforeAgentStart("Missing Luna test", undefined, { cwd: tmp });
	assert.match(failedStart.systemPromptOptions.sections.computer_use_routing, /Hybrid model selection failed: No authenticated Luna.*No desktop action permitted/);
	assert.equal((await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "fixture-no-luna", toolName: "desktop_model_phase", input: { phase: "execute", plan: "do not run" } }))?.block, true);
	const responsesBeforeFailure = session.messages.filter(m => m.role === "assistant").length;
	await session.prompt("Missing Luna task");
	assert.equal(session.messages.filter(m => m.role === "assistant").length, responsesBeforeFailure + 1,
		"SDK still makes an ordinary error-reporting model request; do not claim handler cancellation");
	assert.equal(session.model.id, "gpt-sol", "failed planning selection never chooses Luna or changes physical model");
	assert.deepEqual(errors, []);
	console.log("Real Pi fake provider: Sol → Luna → Sol, normal Sol → Luna, OFF ordinary turn; physical footer, one native session");
} finally {
	session?.dispose();
	await rm(tmp, { recursive: true, force: true });
}
