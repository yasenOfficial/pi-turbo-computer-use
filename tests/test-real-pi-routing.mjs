#!/usr/bin/env node
// Isolated SDK session and fake streaming provider; never reaches a real provider or desktop.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const releases = path.join(os.homedir(), ".local/share/pi-codex-ultra/releases");
const sdk = [process.env.PI_CODING_AGENT_PACKAGE,
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT && path.join(process.env.PI_CODEX_ULTRA_RELEASE_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	...(existsSync(releases) ? readdirSync(releases).sort().reverse().map(r => path.join(releases, r, "node_modules/@earendil-works/pi-coding-agent/package.json")) : [])].find(p => p && existsSync(p));
if (!sdk) throw new Error("Compatible Pi SDK not found; set PI_CODING_AGENT_PACKAGE");
const sdkDir = path.dirname(sdk);
const { Check } = createRequire(sdk)("typebox/value");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(sdkDir, "dist/index.js")));
const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-routing-fixture-"));
const extensionPath = path.join(tmp, "routing-fixture.ts");
const routingPath = path.resolve(import.meta.dirname, "../.pi/extensions/computer-use/routing.ts");
const loadoutPath = path.resolve(import.meta.dirname, "../.pi/extensions/computer-use/loadout.ts");
const debugPath = path.resolve(import.meta.dirname, "../.pi/extensions/computer-use/debug.ts");
const debugDir = path.join(tmp, "private-debug");
const aiPath = path.join(path.dirname(sdkDir), "pi-ai/dist/index.js");
let session;
try {
	await writeFile(extensionPath, `import { ComputerUseRouting } from ${JSON.stringify(routingPath)};
import { DesktopLoadout } from ${JSON.stringify(loadoutPath)};
import { ComputerUseDebug } from ${JSON.stringify(debugPath)};
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentTools } from ${JSON.stringify(aiPath)};
const models = ['gpt-sol','gpt-luna','gpt-original'].map(id => ({ id, name:id, api:'routing-fixture', provider:'routing-fixture', baseUrl:'http://127.0.0.1/never', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:100000,maxTokens:1000 }));
let count = 0;
export default function(pi) {
  pi.registerTool({name:'desktop_launch_app', label:'Fixture GIO metadata (no desktop)', description:'Synthetic discovery only',
    parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},
    execute:async (_id,args)=>({content:[{type:'text',text:JSON.stringify({ok:true,launch_status:'lookup',launch_attempted:false,
      app_matches:[{app_id:'com.st.STM32CubeIDE.desktop',name:'STM32CubeIDE'}]})}],details:undefined})});
  pi.registerTool({name:'desktop_observe',label:'Fixture compact observation (no desktop)',description:'Synthetic omitted semantic node',
    parameters:{type:'object',properties:{},additionalProperties:false},
    execute:async()=>({content:[{type:'text',text:JSON.stringify({ok:true,semantic_scope:'overview',snapshot:{nodes:[]},omitted_nodes:1})}],details:undefined})});
  pi.registerTool({name:'desktop_inspect',label:'Fixture semantic inspect (no desktop)',description:'Synthetic live node',
    parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},
    execute:async()=>({content:[{type:'text',text:JSON.stringify({ok:true,node:{id:'live-editor',role:'text',name:'Verified editor'}})}],details:undefined})});
  const providerConfig = { api:'routing-fixture', apiKey:'fixture-test-only', models, streamSimple(model, context) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const index = count++;
      const activePhase = getCurrentTools(context.messages).find(tool => tool.name === 'desktop_model_phase');
      const rules = getCurrentSystemMessage(context.messages)?.sections?.computer_use_routing ?? '';
      (globalThis.__routingFixturePhases ??= []).push({index,model:model.id,rule:rules,
        phase:activePhase?.parameters?.properties?.phase?.const,
        schema:activePhase?.parameters,
        required:activePhase?.parameters?.required ?? [],
        messages:context.messages.length, hasOtherTools:getCurrentTools(context.messages).some(tool=>tool.name==='desktop_inspect')});
      if(index === 1) globalThis.__routingFixtureLookupVisible = JSON.stringify(context.messages).includes('com.st.STM32CubeIDE.desktop');
      if(index === 2) {
        globalThis.__routingFixtureLunaGuidanceVisible = JSON.stringify(context.messages).includes('lookup does not launch');
        globalThis.__routingFixtureArtifactCount = JSON.stringify(context.messages).split('int main(void) { return 0; }').length - 1;
      }
      if(index === 3) {
        const history = JSON.stringify(context.messages);
        globalThis.__routingFixtureEscalationCount = history.split('reasoning blocker after fresh semantic alternatives').length - 1;
        globalThis.__routingFixtureVerifiedCount = history.split('fixture current state observed').length - 1;
      }
      if(index === 6) globalThis.__routingFixtureOmissionVisible = context.messages.some(m => m.role === 'toolResult' &&
        m.toolName === 'desktop_observe' && m.content.some(c => c.type === 'text' && c.text.includes('"omitted_nodes":1')));
      if(index === 7) globalThis.__routingFixtureLiveEditorVisible = context.messages.some(m => m.role === 'toolResult' &&
        m.toolName === 'desktop_inspect' && m.content.some(c => c.type === 'text' && c.text.includes('Verified editor')));
      const tool = index === 0 ? {name:'desktop_launch_app',arguments:{query:'STM32CubeIDE'}}
        : index === 1 || index === 4 ? { name:'desktop_model_phase', arguments:{phase:'execute',plan:'Use discovered com.st.STM32CubeIDE.desktop; write exact C artifact int main(void) { return 0; } then verify.'} }
        : index === 2 ? { name:'desktop_model_phase', arguments:{phase:'escalate',reason:'reasoning blocker after fresh semantic alternatives',verified_state:'fixture current state observed'} }
        : index === 5 ? {name:'desktop_observe',arguments:{}}
        : index === 6 ? {name:'desktop_inspect',arguments:{id:'live-editor'}} : undefined;
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
  const loadout = new DesktopLoadout(pi);
  const routing = new ComputerUseRouting(pi,mode,available=>loadout.setRoutingAvailable(available));
  const debug = new ComputerUseDebug(pi,mode,routing,{now:()=>performance.now(),directory:${JSON.stringify(debugDir)}});
  pi.registerCommand('fixture-debug',{handler:async (args,ctx)=>{ globalThis.__routingFixtureDebugNotice = await debug.command(args,ctx); }});
  pi.registerCommand('fixture-hybrid',{handler:async (_args,ctx)=>{ await routing.command('hybrid',ctx); loadout.sync(enabled,true); }});
  pi.registerCommand('fixture-summary',{handler:async (_args,ctx)=>{ globalThis.__routingFixtureSummary = routing.summary(ctx); }});
  pi.registerCommand('fixture-off',{handler:async (_args,ctx)=>{ enabled = false; routing.refreshLabel(ctx); loadout.sync(false,routing.isHybrid()); }});
  pi.registerCommand('fixture-on',{handler:async (_args,ctx)=>{ enabled = true; routing.refreshLabel(ctx); loadout.sync(true,routing.isHybrid()); }});
  pi.registerCommand('fixture-remove-luna',{handler:async ()=>{ pi.registerProvider('routing-fixture',
    {...providerConfig, models: models.filter(m => !m.id.endsWith('-luna'))}); }});
  pi.on('session_start',async (event,ctx)=>{ debug.start(ctx,event.reason); await routing.start(ctx); loadout.sync(enabled,routing.isHybrid()); });
  pi.on('session_tree',(_event,ctx)=>routing.start(ctx));
  pi.on('before_agent_start',async (event,ctx)=>{ await routing.beforeStart(event,ctx); loadout.sync(enabled,routing.isHybrid()); });
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
	assert.equal(existsSync(debugDir), false, "debug factory and commands have not written to disk");
	await session.prompt("/fixture-debug on fake-routing");
	assert.match(globalThis.__routingFixtureDebugNotice, /Debug ON/);
	assert.equal(existsSync(debugDir), false, "opt-in alone cannot create reports");
	const reports = async () => Promise.all((await readdir(debugDir)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
		.map(async name => JSON.parse(await readFile(path.join(debugDir, name), "utf8"))));
	const settledBefore = globalThis.__routingFixtureSettled ?? 0;
	await session.prompt("Fixture desktop task");
	assert.equal(globalThis.__routingFixtureSettled, settledBefore + 1, "no premature settlement during either handoff");
	const answers = session.messages.filter(m => m.role === "assistant");
	assert.deepEqual(answers.map(m => m.model), ["gpt-sol", "gpt-sol", "gpt-luna", "gpt-sol"]);
	const phases = globalThis.__routingFixturePhases;
	assert.deepEqual(phases.slice(0, 4).map(({model,phase})=>[model,phase]),
		[["gpt-sol","execute"],["gpt-sol","execute"],["gpt-luna","escalate"],["gpt-sol",undefined]],
		"real Pi receives a request-local role and only the eligible handoff tool");
	assert.ok(phases.slice(0, 2).every(p => /phase plan.*Sol/.test(p.rule) && !p.rule.includes("Current routing phase execute")));
	assert.match(phases[0].rule, /native file\/API\/CLI tools can finish.*WITHOUT desktop_model_phase/);
	assert.match(phases[0].rule, /Honor explicit GUI intent/);
	assert.match(phases[2].rule, /phase execute.*Luna.*ALREADY executing/);
	assert.match(phases[2].rule, /native file\/API\/CLI tools for ordinary file steps/);
	assert.match(phases[3].rule, /phase escalated.*Sol.*no execute/);
	assert.ok(phases.slice(0,4).every(p=>p.hasOtherTools), "unrelated tool declarations survive phase changes");
	assert.ok(phases[0].required.includes("plan"));
	assert.ok(phases[2].required.includes("verified_state"));
	assert.equal(Check(phases[0].schema, {phase:"execute",plan:"bounded"}), true);
	assert.equal(Check(phases[0].schema, {phase:"escalate",reason:"error",verified_state:"live"}), false);
	assert.equal(Check(phases[2].schema, {phase:"escalate",reason:"verified blocker",verified_state:"live"}), true);
	assert.equal(Check(phases[2].schema, {phase:"execute",plan:"again"}), false);
	assert.equal(phases[3].required.length, 0, "no final Sol bounce declaration");
	assert.equal(globalThis.__routingFixtureLookupVisible, true, "synthetic lookup result reaches Sol before physical handoff");
	assert.equal(globalThis.__routingFixtureLunaGuidanceVisible, true, "Luna receives handoff safety guidance in the real session");
	assert.equal(globalThis.__routingFixtureArtifactCount, 1, "concrete Sol artifact survives exactly once in preceding assistant arguments");
	assert.equal(globalThis.__routingFixtureEscalationCount, 1, "verified reason survives exactly once in assistant arguments");
	assert.equal(globalThis.__routingFixtureVerifiedCount, 1, "verified state survives exactly once in assistant arguments");
	const phaseResults = session.messages.filter(m => m.role === "toolResult" && m.toolName === "desktop_model_phase");
	assert.equal(phaseResults.length, 2);
	assert.ok(phaseResults.every(m => !JSON.stringify(m.content).includes("int main(void) { return 0; }") &&
		!JSON.stringify(m.content).includes("fixture current state observed")), "phase results contain no copied artifact or verified state");
	assert.equal(answers[0].content[0].name, "desktop_launch_app", "Sol queried synthetic metadata, not a real desktop");
	assert.deepEqual(errors, []);
	assert.equal(session.model.id, "gpt-sol", "settlement restores physical model without a final model request");
	assert.match(globalThis.__routingFixtureLabel, /gpt-sol → gpt-luna$/);
	const first = (await reports()).find(report => report.outcome === "completed" && report.modelCalls.length === 4);
	assert.ok(first, "first real SDK run persisted a settled private report");
	assert.equal(first.routing, "hybrid");
	assert.deepEqual(first.modelCalls.map(call => call.modelId), ["gpt-sol", "gpt-sol", "gpt-luna", "gpt-sol"]);
	assert.equal(first.modelCalls[0].selectedThinkingLevel, session.thinkingLevel,
		"real turn_start records Pi's selected thinking level; provider-native effort may be absent");
	assert.equal(first.usage.totalTokens, 8);
	assert.equal(first.usage.input, 4); assert.equal(first.usage.output, 4);
	assert.equal(first.timeline[0].assistantMessagesBeforeRun, 0);
	assert.equal(first.totalTaskTokens, null, "observed SDK usage is not provider quota");
	assert.equal(first.taskSuccess, null, "completion does not judge correctness");
	await session.prompt("Second fixture desktop task");
	assert.deepEqual(session.messages.filter(m => m.role === "assistant").map(m => m.model).slice(4), ["gpt-sol", "gpt-luna", "gpt-luna", "gpt-luna"],
		"compact omission is resolved with synthetic live inspection on Luna, not speculative escalation");
	assert.deepEqual(phases.slice(4,8).map(({model,phase})=>[model,phase]),
		[["gpt-sol","execute"],["gpt-luna","escalate"],["gpt-luna","escalate"],["gpt-luna","escalate"]]);
	assert.equal(session.messages.filter(m => m.role === "assistant")[5].content[0].name, "desktop_observe");
	assert.equal(globalThis.__routingFixtureOmissionVisible, true, "Luna receives compact observation with omitted_nodes:1 before inspecting");
	assert.equal(session.messages.filter(m => m.role === "assistant")[6].content[0].name, "desktop_inspect");
	assert.equal(globalThis.__routingFixtureLiveEditorVisible, true, "Luna sees verified live editor before final answer");
	assert.equal(session.messages.some(m => m.role === "toolResult" && m.toolName === "desktop_inspect" &&
		JSON.stringify(m.content).includes("Verified editor")), true, "Luna receives safe live semantic recovery");
	assert.equal(session.model.id, "gpt-sol", "normal completion restores original physical selection");
	const second = (await reports()).find(report => report.outcome === "completed" && report.modelCalls.length === 4 &&
		report.timeline[0].assistantMessagesBeforeRun === 4);
	assert.ok(second, "second real SDK run wrote a separate report");
	assert.deepEqual(second.modelCalls.map(call => call.modelId), ["gpt-sol", "gpt-luna", "gpt-luna", "gpt-luna"]);
	assert.equal(second.usage.totalTokens, 8);
	assert.equal(second.timeline[0].assistantMessagesBeforeRun, 4, "same-session history is visible as a count only");
	const reportsBeforeOff = (await reports()).length;
	await session.prompt("/fixture-off");
	await session.prompt("Ordinary OFF question");
	assert.equal(session.messages.filter(m => m.role === "assistant").at(-1).model, "gpt-sol",
		"OFF leaves ordinary questions on the physical model");
	assert.equal(globalThis.__routingFixtureLabel, undefined, "OFF hides routing label");
	assert.equal((await reports()).length, reportsBeforeOff, "OFF ordinary question cannot be logged even if debug is ON");
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
	const missingReports = (await reports()).filter(report => report.modelCalls.length === 1 && report.timeline[0].assistantMessagesBeforeRun >= 8);
	assert.ok(missingReports.length >= 1, "missing Luna still makes one ordinary model request, not an invisible fallback");
	assert.deepEqual(missingReports.at(-1).modelCalls.map(call => call.modelId), ["gpt-sol"]);
	assert.equal(missingReports.at(-1).routing, "hybrid", "configuration is hybrid even though only Sol was available");
	assert.deepEqual(errors, []);
	console.log("Real Pi fake provider: Sol → Luna → Sol, recoverable omitted control on Luna without escalation, OFF ordinary turn; physical footer, one native session");
} finally {
	session?.dispose();
	await rm(tmp, { recursive: true, force: true });
}
