import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import { BrowserDockerRuntime } from "../../../scripts/browser-docker.mjs";
import { ComputerUseClient } from "./client.js";
import { DesktopDaemonStartup } from "./daemon.js";
import { DaemonVersion } from "./version.js";
import type { DaemonRequest, DaemonResponse } from "./types.js";
import type { ComputerUseMode } from "./mode.js";
import type { DesktopWorkflow } from "./workflow.js";

const ENTRY = "computer-use-target-v1";
const STARTUP_WAIT_MS = 20_000;
type Target = "host" | "docker";
type Handle = { socketPath: string; id: string; containerId: string; name: string };
type Runtime = Pick<BrowserDockerRuntime, "build" | "start" | "status" | "stop" | "viewerInfo" | "restartInput" | "migrateLegacyProfile">;

/** Target identity is pinned for a tool's entire lifetime. Docker never consults the host startup or socket. */
export class DesktopTarget {
 private selected: Target = "host";
 private runtime?: Runtime;
 private handle?: Handle;
 private socketIdentity?: string;
 private stopped = false;
 private active = 0;
 private generation = 0;
 private changing = false;
 private pausing = false;
 private readonly host = new DesktopDaemonStartup();
 constructor(private readonly pi: ExtensionAPI, private readonly mode: ComputerUseMode,
  private readonly workflow: DesktopWorkflow,
  private readonly runtimeFactory: (sessionId: string) => Runtime = sessionId => new BrowserDockerRuntime({ sessionId })) {}
 label(ctx: ExtensionContext): void { this.mode.setTargetLabel(this.selected === "docker" ? "Docker browser" : "Host desktop", ctx); }
 restore(ctx: ExtensionContext): void {
  if (this.active || this.changing || this.pausing) throw new Error("Cannot restore desktop target during an in-flight operation; no target switch was made.");
  this.generation++;
  const previousTarget = this.selected;
  // A fork may carry a Docker selection but has its own session identity and no adopted container.
  this.selected = "host"; this.handle = undefined; this.socketIdentity = undefined; this.runtime = undefined; this.stopped = false;
  for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === ENTRY &&
   (entry.data as { target?: unknown })?.target === "docker") this.selected = "docker";
  else if (entry.type === "custom" && entry.customType === ENTRY && (entry.data as { target?: unknown })?.target === "host") this.selected = "host";
  // A persisted selection is not evidence that its container still runs. Explicit ON
  // must validate the Docker daemon again after reload, resume, or tree navigation.
  if (this.mode.isEnabled() && (this.selected === "docker" || this.selected !== previousTarget)) this.mode.setEnabled(false, ctx);
  this.label(ctx);
 }
 get target(): Target { return this.selected; }
 private docker(ctx: ExtensionContext): Runtime { return this.runtime ??= this.runtimeFactory(ctx.sessionManager.getSessionId()); }
 private async verifySocket(socketPath: string): Promise<void> {
  // Runtime.status() checks private directory ownership and the container/image
  // identity. Recheck the final socket immediately before EACH IPC connection,
  // including daemon_info, Stop, ping, metrics, and workflow renew/end. Never
  // connect through a symlink, stale regular file, or permissive socket.
  let stat;
  try { stat = await lstat(socketPath); }
  catch { throw new Error("Docker browser socket is unavailable; no host fallback or desktop request was sent."); }
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600)
   throw new Error("Docker browser socket has unsafe type, owner, or permissions; no desktop request was sent.");
  const identity = `${stat.dev}:${stat.ino}`;
  if (this.socketIdentity && this.socketIdentity !== identity)
   throw new Error("Docker browser socket changed since selection; stop/start the container explicitly. No host fallback.");
  this.socketIdentity = identity;
 }
 private async running(ctx: ExtensionContext, allowLegacyMigration = false): Promise<Handle> {
  const state = await this.docker(ctx).status();
  if (state.status !== "running" || !state.handle?.socketPath) throw new Error("Docker browser is not running. No host fallback; use /computer-use docker start explicitly after stopping the old session.");
  if (state.authentication !== "none" && !(allowLegacyMigration && state.authentication === "legacy-password" && state.requiresRecreate === true))
   throw new Error("Legacy Docker browser needs explicit /computer-use docker migrate while OFF. Do not stop or replace it before migration: its temporary browser data may be lost. No desktop request was sent.");
  if (this.handle && (this.handle.socketPath !== state.handle.socketPath || this.handle.containerId !== state.handle.containerId))
   throw new Error("Docker browser identity changed; desktop operation blocked. No host fallback.");
  await this.verifySocket(state.handle.socketPath);
  this.handle = state.handle;
  return state.handle;
 }
 private assertIdle(ctx: ExtensionContext): void {
  if (this.changing || this.pausing || !ctx.isIdle() || this.active) throw new Error("Change the desktop target only when Pi and all desktop operations are idle; abort or wait first.");
 }
 private async change(ctx: ExtensionContext, operation: () => Promise<string>): Promise<string> {
  this.assertIdle(ctx); this.changing = true; this.generation++;
  try { await this.workflow.close(); return await operation(); }
  finally { this.changing = false; this.label(ctx); }
 }
 async command(subcommand: string, ctx: ExtensionContext): Promise<string> {
  if (subcommand === "host") return this.change(ctx, async () => {
   if (this.mode.isEnabled()) throw new Error("Turn computer use OFF before selecting the host desktop.");
   this.selected = "host"; this.handle = undefined; this.socketIdentity = undefined; this.pi.appendEntry(ENTRY, { target: "host" });
   return "Host desktop selected (OFF). /computer-use on is required before desktop actions.";
  });
  if (!subcommand.startsWith("docker ")) throw new Error("Use docker build|start|status|stop|pause|resume|migrate, or host.");
  const action = subcommand.slice(7);
  if (action === "pause") {
   if (this.selected !== "docker") throw new Error("Select Docker before pausing it.");
   if (this.changing || this.pausing) throw new Error("Docker target change or pause is already in progress.");
   this.pausing = true;
   this.interrupt(); this.mode.setEnabled(false, ctx);
   // A Stop request bypasses the aborted turn's signal. Mark sticky BEFORE IPC
   // so another dispatched tool cannot slip input in during the handshake.
   this.stopped = true;
   ctx.abort();
   const closing = this.workflow.close(); // detach renewals immediately; no wait before Stop
   try {
    const response = await this.request(ctx, "docker", { cmd: "stop" });
    if (response.ok !== true || response.input_stopped !== true)
     throw new Error("Docker daemon did not acknowledge input_stopped: true");
    await closing;
    return "Docker browser paused: Computer use OFF; Docker daemon input stopped. Browser and viewer stay open. Use /computer-use docker resume explicitly after manual takeover, then /computer-use on.";
   } catch {
    // An in-flight input may have completed before Stop; failed/uncertain Stop
    // is never described as successful manual takeover or retried automatically.
    void closing.catch(() => {});
    throw new Error("Docker pause Stop was not confirmed. Computer use remains OFF; do not take over until the browser is safe. Use the emergency stop or inspect Docker status. No host fallback.");
   } finally { this.pausing = false; }
  }
  if (action === "status") {
   const state = await this.docker(ctx).status();
   if (state.status !== "running") return `Docker browser: ${state.status}. Target: ${this.selected}. Computer use: ${this.mode.isEnabled() ? "ON" : "OFF"}. Persistent profile (new containers) is retained across stop/start. No host fallback.`;
   const legacy = state.authentication !== "none";
   // Never read a password, even for a legacy viewer. An old container has
   // ephemeral profile data; stopping/replacing it is a separate user decision.
   if (!ctx.hasUI) return `Docker browser: running${legacy ? " (legacy password viewer; explicit /computer-use docker migrate required before stopping)" : " (passwordless localhost viewer)"}. Target: ${this.selected}. Viewer URL requires user UI.`;
   const viewer = await this.docker(ctx).viewerInfo();
   if (legacy || viewer.authentication !== "none") return `Docker browser: running (legacy password viewer). Viewer (localhost only): ${viewer.url}. Do not stop or replace before explicit /computer-use docker migrate while OFF: its temporary profile may be lost. No password was read.`;
   let input = "unavailable or unverified";
   if (this.selected === "docker") {
    try {
     const { socketPath } = await this.running(ctx);
     const info = await new DaemonVersion(socketPath, process.env).info();
     if (info.input_stopped) this.stopped = true;
     input = info.input_stopped ? "stopped" : this.stopped ? "not confirmed (local Stop remains sticky)" : "ready";
    } catch { /* Viewer can remain available while the daemon is restarting or unsafe. */ }
   }
   return `Docker browser: running. Target: ${this.selected}. Docker daemon input: ${input}. Viewer (localhost only, no password): ${viewer.url}. Persistent browser profile is retained across stop/start.`;
  }
  return this.change(ctx, async () => {
   if (this.mode.isEnabled()) throw new Error("Turn computer use OFF before changing the Docker container.");
   if (action === "migrate") {
    if (this.selected !== "docker") throw new Error("Select Docker before migrating its legacy browser profile.");
    const state = await this.docker(ctx).status();
    if (state.status !== "running" || state.authentication !== "legacy-password" || state.requiresRecreate !== true)
     throw new Error("Migration requires the selected running legacy Docker browser; no browser was changed.");
    // This is the ONLY path allowed to address the legacy daemon. Keep its
    // verified socket/CID pinned, mark Stop sticky before sending any IPC, and
    // never use the aborted run's signal. A failed acknowledgement must not
    // initiate profile transfer or replace the source container.
    const { socketPath } = await this.running(ctx, true);
    this.stopped = true;
    let response: DaemonResponse;
    try { response = await new ComputerUseClient({ socketPath }).request({ cmd: "stop" }); }
    catch { throw new Error("Legacy Docker Stop was not confirmed. Migration did not start; source browser remains. Do not retry uncertain input automatically."); }
    if (response.ok !== true || response.input_stopped !== true)
     throw new Error("Legacy Docker Stop was not acknowledged. Migration did not start; source browser remains.");
    // Runtime imports directly into the verified private volume; never expose
    // its archive, paths, passwords, or error details to the model or logs.
    try { await this.docker(ctx).migrateLegacyProfile(); }
    catch { throw new Error("Legacy profile migration was not completed. Original browser remains; Computer use OFF. Inspect private migration state before any further attempt; do not stop the source."); }
    try { await this.docker(ctx).stop(); }
    catch { throw new Error("Legacy profile was copied to the private volume, but verified removal of the old browser failed. Computer use OFF; inspect status before explicit recovery. No replacement was started."); }
    this.handle = undefined; this.socketIdentity = undefined;
    let handle: Handle;
    try { handle = await this.docker(ctx).start(); }
    catch { throw new Error("Legacy profile was copied and the old browser removed, but starting the new browser failed. Private profile is retained; Computer use OFF. Explicitly inspect status and start when safe."); }
    this.handle = handle; this.stopped = false;
    await this.waitReady(ctx);
    this.workflow.resetAfterExplicitDaemonRestart();
    return "Legacy browser profile migrated to the private persistent Docker volume. Old container removed; new passwordless localhost viewer started. Computer use remains OFF. Use /computer-use docker status for the viewer link, then /computer-use on explicitly.";
   }
   if (action === "resume") {
    if (this.selected !== "docker") throw new Error("Select Docker before resuming it.");
    // Sticky Stop must not bypass the new-profile identity check. In particular,
    // never run a daemon restart against an old live ephemeral-profile container.
    await this.running(ctx);
    if (!this.stopped) {
     // This is metadata only. A restarted/unexpected daemon must not be
     // implicitly restarted or substituted when input was already enabled.
     const { socketPath } = await this.running(ctx);
     const info = await new DaemonVersion(socketPath, process.env).info();
     if (!info.input_stopped) throw new Error("Docker input is not stopped; resume did not restart anything. Use /computer-use on or pause first.");
     this.stopped = true;
    }
    await this.docker(ctx).restartInput(); // fixed image-owned daemon-only control
    this.socketIdentity = undefined; // explicit restart is allowed to replace the Unix socket
    this.stopped = false;
    try { await this.waitReady(ctx, true); }
    catch { this.stopped = true; throw new Error("Docker daemon restart was not verified. Computer use remains OFF; inspect status before another explicit resume or stop."); }
    this.workflow.resetAfterExplicitDaemonRestart();
    return "Docker daemon input resumed; browser/viewer preserved. Computer use remains OFF. Run /computer-use on explicitly for agent control.";
   }
   if (action === "build") {
    const result = await this.docker(ctx).build();
    return result.message;
   }
   if (action === "start") {
    // Persist the selection first: even failed/uncertain Docker startup must never fall back to host.
    this.selected = "docker"; this.pi.appendEntry(ENTRY, { target: "docker" });
    this.socketIdentity = undefined;
    const handle = await this.docker(ctx).start(); this.handle = handle; this.stopped = false;
    await this.waitReady(ctx);
    this.workflow.resetAfterExplicitDaemonRestart();
    return "Docker browser started and selected (Computer use OFF). Passwordless localhost viewer; the same private browser profile is reused across stop/start. Use /computer-use docker status for the viewer link, then /computer-use on for agent control.";
   }
   if (action === "stop") {
    if (this.selected !== "docker") throw new Error("Select Docker first; host emergency Stop is separate.");
    this.stopped = true; this.handle = undefined;
    // Runtime validates the exact migrated legacy CID before removing it;
    // without a completed import, legacy stop is refused and data survives.
    try { await this.docker(ctx).stop(); }
    catch { throw new Error("Docker browser was NOT stopped. Legacy containers require completed /computer-use docker migrate before removal; inspect status and retained profile. No host fallback."); }
    this.socketIdentity = undefined;
    return "Docker browser stopped; its private profile is retained for an explicit future start in this Pi session. Docker remains selected (OFF); no host fallback.";
   }
   throw new Error("Use docker build|start|status|stop|pause|resume|migrate.");
  });
 }
 interrupt(): void { this.generation++; }
 assertDispatchAllowed(command: string): void {
  if (this.selected === "docker" && !this.mode.isEnabled() && !["stop", "ping", "metrics", "daemon_info"].includes(command))
   throw new Error("Computer use is OFF; Docker desktop request was not sent. No host fallback.");
 }
 async enable(ctx: ExtensionContext): Promise<void> {
  const generation = this.generation;
  if (this.changing || this.pausing) throw new Error("Docker target change or pause is in progress.");
  if (this.selected !== "docker") return;
  if (this.stopped) throw new Error("Docker input stopped. Run /computer-use docker resume explicitly (or stop/start for a new browser) before enabling.");
  await this.compatible(ctx);
  if (generation !== this.generation || this.changing || this.pausing || this.selected !== "docker" || this.stopped)
   throw new Error("Docker target or mode changed during validation; Computer use remains OFF.");
 }
 private async waitReady(ctx: ExtensionContext, replacingStoppedDaemon = false): Promise<void> {
  const end = Date.now() + STARTUP_WAIT_MS;
  while (true) {
   // A supervisor may acknowledge restart before the old stopped daemon has
   // exited or the new socket is bound. Only this explicit resume may repin it.
   if (replacingStoppedDaemon) { this.stopped = false; this.socketIdentity = undefined; }
   try {
    await this.compatible(ctx);
    const viewer = await this.docker(ctx).viewerInfo();
    if (viewer.authentication !== "none") throw new Error("Viewer is not the passwordless persistent-profile version");
    return;
   }
   catch { if (Date.now() >= end) throw new Error("Docker browser readiness timed out. Target remains Docker and OFF; inspect status before another explicit operation. No host fallback."); }
   await new Promise(resolve => setTimeout(resolve, 200));
  }
 }
 private async compatible(ctx: ExtensionContext, capability?: string): Promise<void> {
  if (this.stopped) throw new Error("Docker input stopped; run /computer-use docker resume explicitly (or stop/start for a new browser). No host fallback.");
  const { socketPath } = await this.running(ctx);
  const version = new DaemonVersion(socketPath, process.env);
  const info = await version.info();
  if (info.input_stopped) { this.stopped = true; throw new Error("Docker daemon input stopped; run /computer-use docker resume explicitly (or stop/start for a new browser). No host fallback."); }
  if (!version.safe(info) || (capability && !info.capabilities.includes(capability)))
   throw new Error("Docker daemon lacks required safety capability; no desktop action was sent. No host fallback.");
 }
 /** Called before any async tool work; switch is refused while this pin is held. */
 pin(): { target: Target; release: () => void } {
  if (this.changing) throw new Error("Desktop target is changing; tool not sent.");
  this.active++; const target = this.selected; let released = false;
  return { target, release: () => { if (!released) { released = true; this.active--; } } };
 }
 startup(ctx: ExtensionContext, target: Target) {
  if (target === "host") return this.mode.isEnabled() ? this.host : {
   assertInputAllowed: () => this.host.assertInputAllowed(), markStopped: () => this.host.markStopped(),
   ensure: async () => {}, ensureCompatible: async () => { throw new Error("Computer use OFF; no desktop action sent."); },
  };
  return {
   assertInputAllowed: () => { if (this.stopped) throw new Error("Docker input stopped; run /computer-use docker resume explicitly (or stop/start for a new browser). No host fallback."); },
   markStopped: () => { this.stopped = true; },
   ensure: async () => { await this.running(ctx); },
   ensureCompatible: async (_signal?: AbortSignal, capability?: string) => this.compatible(ctx, capability),
  };
 }
 async request(ctx: ExtensionContext, target: Target, request: DaemonRequest, signal?: AbortSignal): Promise<DaemonResponse> {
  if (target === "host") return new ComputerUseClient({ socketPath: this.host.socketPath }).request(request, signal);
  this.assertDispatchAllowed(request.cmd === "control_activity" && request.action === "end" ? "daemon_info" : request.cmd);
  const { socketPath } = await this.running(ctx);
  this.assertDispatchAllowed(request.cmd === "control_activity" && request.action === "end" ? "daemon_info" : request.cmd);
  return new ComputerUseClient({ socketPath }).request(request, signal);
 }
 /** Leases are bound to their opening target/socket, never redirected by a later selection. */
 async lease(request: { cmd: string; action: string; token: string; ttl_ms?: number }, ctx: ExtensionContext): Promise<unknown> {
  return this.request(ctx, this.selected, request);
 }
}
