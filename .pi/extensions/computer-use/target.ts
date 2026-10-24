import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { BrowserDockerRuntime } from "../../../scripts/browser-docker.mjs";
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
type Runtime = Pick<BrowserDockerRuntime, "build" | "prepare" | "start" | "status" | "stop" | "viewerInfo" | "restartInput" | "migrateLegacyProfile" | "acquireControl" | "releaseControl">;

/** Viewer health is only a localhost static-asset readiness check, not browser automation. */
function checkViewer(url: string): Promise<void> {
 let viewer: URL;
 try { viewer = new URL(url); }
 catch { throw new Error("Invalid Docker viewer URL; Computer use remains OFF."); }
 if (viewer.protocol !== "http:" || viewer.hostname !== "127.0.0.1" || !/^\/[1-9][0-9]{0,4}$/.test(`/${viewer.port}`) ||
  +viewer.port > 65535 || viewer.pathname !== "/vnc.html" || viewer.username || viewer.password || viewer.search || viewer.hash)
  throw new Error("Unsafe Docker viewer URL; Computer use remains OFF.");
 return new Promise((resolve, reject) => {
  const request = httpRequest(viewer, { method: "GET", timeout: 3000 }, response => {
   response.resume();
   if (response.statusCode === 200) resolve();
   else reject(new Error("Docker viewer is not ready; Computer use remains OFF."));
  });
  request.once("timeout", () => request.destroy(new Error("Docker viewer readiness timed out; Computer use remains OFF.")));
  request.once("error", () => reject(new Error("Docker viewer is unavailable; Computer use remains OFF.")));
  request.end();
 });
}

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
 private browserOperation?: Promise<unknown>;
 private browserStage: "prepare" | "mutating" | "checking" = "prepare";
 private browserOffPending?: Promise<string>;
 private readonly controlOwner = randomUUID();
 private controlPending?: Promise<void>;
 private ownsControl = false;
 private controlHolds = 0;
 private controlReservations = 0;
 private readonly host = new DesktopDaemonStartup();
 constructor(private readonly pi: ExtensionAPI, private readonly mode: ComputerUseMode,
  private readonly workflow: DesktopWorkflow,
  private readonly runtimeFactory: (sessionId: string) => Runtime = () => {
   throw new Error("Browser runtime was not initialized by the extension loader; Computer use remains OFF.");
  },
  private readonly viewerHealth: (url: string) => Promise<void> = checkViewer) {}
 label(ctx: ExtensionContext): void { this.mode.setTargetLabel(this.selected === "docker" ? "Docker browser" : "Host desktop", ctx); }
 restore(ctx: ExtensionContext): void {
  if (this.active || this.changing || this.pausing || this.browserOffPending || this.ownsControl || this.controlPending)
   throw new Error("Cannot restore desktop target while a Docker run still owns control; settle or abort it first.");
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
 /** Atomic, runtime-owned, cross-Pi control claim. Hold across the whole agent
  * run (not each tool) to prevent another chat from interleaving input. */
 async acquireControl(ctx: ExtensionContext, target: Target, signal?: AbortSignal): Promise<void> {
  if (target === "host") return;
  if (signal?.aborted) throw new Error("Docker control was cancelled before any desktop request.");
  if (!this.ownsControl) {
   if (!this.controlPending) {
    const runtime = this.docker(ctx);
    if (typeof runtime.acquireControl !== "function" || typeof runtime.releaseControl !== "function")
     throw new Error("Shared browser control is unavailable; Computer use remains OFF. No Docker input was sent.");
    const pending = runtime.acquireControl(this.controlOwner).then(async () => {
     this.ownsControl = true; this.controlHolds = 1 + this.controlReservations; this.controlReservations = 0;
     // A previous chat may have released its lock after an uncertain IPC
     // disconnect while its daemon request or workflow is still active. Only
     // the first claim for a new ON run needs this metadata-only check.
     if (this.mode.isEnabled() && this.selected === "docker") {
      try { await this.assertNoOtherWorkflow(ctx); }
      catch (error) {
       try { await runtime.releaseControl(this.controlOwner); this.ownsControl = false; this.controlHolds = 0; }
       catch { throw new Error("Shared browser control could not be released after a busy daemon; Computer use remains OFF."); }
       throw error;
      }
     }
    }, error => { this.controlReservations = 0; throw error; });
    this.controlPending = pending;
    void pending.finally(() => { if (this.controlPending === pending) this.controlPending = undefined; }).catch(() => {});
   }
   await this.controlPending;
  }
  if (signal?.aborted) throw new Error("Docker control was cancelled before any desktop request.");
 }
 async releaseControl(ctx: ExtensionContext): Promise<void> {
  await this.controlPending?.catch(() => {});
  if (!this.ownsControl) return;
  if (this.controlHolds > 1) { this.controlHolds--; return; }
  try { await this.docker(ctx).releaseControl(this.controlOwner); }
  catch {
   this.mode.setEnabled(false, ctx);
   throw new Error("Shared browser control release is unconfirmed; Computer use OFF. Inspect private state before new input.");
  }
  this.ownsControl = false; this.controlHolds = 0;
 }
 private async assertNoOtherWorkflow(ctx: ExtensionContext, legacy = false): Promise<void> {
  const { socketPath } = await this.running(ctx, legacy);
  const info = await new DaemonVersion(socketPath, process.env).info();
  if (info.busy || info.active_workflows > 0)
   throw new Error("The shared browser is busy in another Pi workflow. Computer use remains OFF; wait for it to settle. No input or restart was sent.");
 }
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
   throw new Error("Shared Docker browser socket changed since selection; use /browser use explicitly to verify and repin it. No host fallback.");
  this.socketIdentity = identity;
 }
 private async running(ctx: ExtensionContext, allowLegacyMigration = false): Promise<Handle> {
  const state = await this.docker(ctx).status();
  if (state.status !== "running" || !state.handle?.socketPath) throw new Error("Shared Docker browser is not running. No host fallback; use /browser use explicitly to prepare or restart it.");
  if (state.authentication !== "none" && !(allowLegacyMigration && state.authentication === "legacy-password" && state.requiresRecreate === true))
   throw new Error("Legacy Docker browser needs explicit /computer-use docker migrate while OFF. Do not stop or replace it before migration: its temporary browser data may be lost. No desktop request was sent.");
  if (this.handle && (this.handle.socketPath !== state.handle.socketPath || this.handle.containerId !== state.handle.containerId))
   throw new Error("Shared Docker browser identity changed; desktop operation blocked. Use /browser use explicitly to verify and repin it. No host fallback.");
  await this.verifySocket(state.handle.socketPath);
  this.handle = state.handle;
  return state.handle;
 }
 private assertIdle(ctx: ExtensionContext): void {
  if (this.changing || this.pausing || this.browserOffPending || !ctx.isIdle() || this.active) throw new Error("Change the desktop target only when Pi and all desktop operations are idle; abort or wait first.");
 }
 private async change(ctx: ExtensionContext, operation: () => Promise<string>, claimDocker = false, pinDocker = false): Promise<string> {
  this.assertIdle(ctx); this.changing = true; this.generation++;
  try {
   await this.workflow.close();
   if (pinDocker && this.selected !== "docker") {
    // Even if the shared lock fails, explicit Docker start never leaves a
    // previously selected host as the implicit fallback target.
    this.selected = "docker"; this.handle = undefined; this.socketIdentity = undefined;
    this.pi.appendEntry(ENTRY, { target: "docker" }); this.label(ctx);
   }
   // Explicit advanced lifecycle commands still cannot race another Pi chat's
   // shared browser. Host selection only releases our own settled claim.
   if (claimDocker) await this.acquireControl(ctx, "docker");
   else await this.releaseControl(ctx);
   return await operation();
  } finally {
   try { if (claimDocker) await this.releaseControl(ctx); }
   finally { this.changing = false; this.label(ctx); }
  }
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
   if (action === "migrate") return this.migrateLegacy(ctx);
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
    return "Shared Docker browser stopped; its common private profile is retained for an explicit future start from any Pi chat. Docker remains selected (OFF); no host fallback.";
   }
   throw new Error("Use docker build|start|status|stop|pause|resume|migrate.");
  }, true, action === "start");
 }
 /** Explicit /browser use is the only automatic preparation/start/migration entry point. */
 browserUse(ctx: ExtensionContext): Promise<string> {
  this.assertIdle(ctx);
  const generation = ++this.generation;
  this.changing = true;
  this.browserStage = "prepare";
  const check = () => {
   if (generation !== this.generation || this.browserOffPending)
    throw new Error("Browser use was cancelled; Computer use remains OFF. No host fallback.");
  };
  this.mode.setEnabled(false, ctx);
  const operation = (async () => {
   try {
    await this.workflow.close(); check();
    // Pin Docker before the first build, status or container operation.
    if (this.selected !== "docker") {
     this.selected = "docker"; this.handle = undefined; this.socketIdentity = undefined;
     this.pi.appendEntry(ENTRY, { target: "docker" }); this.label(ctx);
    }
    // Atomic claim prevents another Pi chat from acting while this command
    // prepares, migrates, upgrades or checks the one shared browser.
    await this.acquireControl(ctx, "docker"); check();
    // Another Pi chat may have stopped/recreated this one shared container.
    // Only an explicit /browser use may repin its verified CID/socket; ordinary
    // desktop calls retain their previous identity and fail closed on changes.
    this.handle = undefined; this.socketIdentity = undefined;
    // Source-fingerprint caching avoids a build on ordinary subsequent uses.
    // This may take minutes on the first explicit invocation; cancellation
    // during preparation prevents the later start, even if build cannot abort.
    const prepared = await this.docker(ctx).prepare(); check();
    const state = await this.docker(ctx).status(); check();
    if (state.status === "running" && state.authentication === "legacy-password") {
     await this.assertNoOtherWorkflow(ctx, true); check();
     this.browserStage = "mutating";
     await this.migrateLegacy(ctx, check); check();
    } else if (state.status === "running" && state.authentication === "none") {
     await this.assertNoOtherWorkflow(ctx); check();
     if (!state.imageId || !prepared.imageId || !/^sha256:[a-f0-9]{64}$/.test(state.imageId) ||
      !/^sha256:[a-f0-9]{64}$/.test(prepared.imageId))
      throw new Error("Running Docker image identity is unverified; Computer use remains OFF. No browser was replaced.");
     if (state.imageId !== prepared.imageId) {
      this.browserStage = "mutating";
      const { socketPath } = await this.running(ctx); check();
      this.stopped = true;
      let response: DaemonResponse;
      try { response = await new ComputerUseClient({ socketPath }).request({ cmd: "stop" }); }
      catch { throw new Error("Outdated Docker browser Stop was not confirmed; no replacement was started. Computer use remains OFF."); }
      check();
      if (response.ok !== true || response.input_stopped !== true)
       throw new Error("Docker Stop was not acknowledged; outdated browser was NOT replaced. Computer use remains OFF.");
      await this.docker(ctx).stop(); check();
      this.handle = undefined; this.socketIdentity = undefined;
      const handle = await this.docker(ctx).start(); this.handle = handle; check();
      this.stopped = false;
      await this.waitReady(ctx); check();
      this.workflow.resetAfterExplicitDaemonRestart();
     } else {
      await this.running(ctx); check();
      const info = await new DaemonVersion(this.handle!.socketPath, process.env).info(); check();
      if (info.input_stopped) this.stopped = true;
      if (this.stopped) {
       this.browserStage = "mutating";
       await this.docker(ctx).restartInput(); check();
       this.socketIdentity = undefined; this.stopped = false;
       await this.waitReady(ctx, true); check();
       this.workflow.resetAfterExplicitDaemonRestart();
      }
     }
    } else if (state.status === "absent" || (state.status === "stopped" && state.authentication === "none")) {
     if (state.status === "stopped" && (!state.imageId || !/^sha256:[a-f0-9]{64}$/.test(state.imageId)))
      throw new Error("Stopped Docker image identity is unverified; Computer use remains OFF.");
     this.browserStage = "mutating";
     if (state.status === "stopped") { await this.docker(ctx).stop(); check(); }
     this.handle = undefined; this.socketIdentity = undefined;
     const handle = await this.docker(ctx).start(); this.handle = handle; check();
     this.stopped = false;
     await this.waitReady(ctx); check();
     this.workflow.resetAfterExplicitDaemonRestart();
    } else throw new Error("Browser state is incomplete or unsafe. Computer use remains OFF; inspect /computer-use docker status. No host fallback.");
    this.browserStage = "checking";
    await this.compatible(ctx); check();
    const viewer = await this.docker(ctx).viewerInfo(); check();
    if (viewer.authentication !== "none") throw new Error("Browser viewer is not passwordless; Computer use remains OFF.");
    await this.waitViewerHealthy(viewer.url, check); check();
    this.mode.setEnabled(true, ctx);
    return `Docker browser ready; Computer use ON. Viewer (localhost only, no password): ${viewer.url}. Private browser profile is retained across stop/start.`;
   } finally {
    try { await this.releaseControl(ctx); }
    catch {
     this.mode.setEnabled(false, ctx);
     throw new Error("Shared browser control could not be released; Computer use remains OFF. No host fallback.");
    } finally { this.changing = false; this.label(ctx); }
   }
  })();
  this.browserOperation = operation;
  void operation.finally(() => { if (this.browserOperation === operation) this.browserOperation = undefined; }).catch(() => {});
  return operation;
 }

 private async waitViewerHealthy(url: string, check: () => void): Promise<void> {
  const end = Date.now() + 5_000;
  while (true) {
   check();
   try { await this.viewerHealth(url); check(); return; }
   catch {
    check();
    if (Date.now() >= end) throw new Error("Docker localhost viewer did not become ready within 5 seconds; Computer use remains OFF.");
    await new Promise(resolve => setTimeout(resolve, Math.min(200, end - Date.now())));
   }
  }
 }

 /** Explicit /browser use off: abort Pi, stop Docker input, remove only the owned
  * container, and retain its private profile. Never touch host GUI or daemon. */
 browserOff(ctx: ExtensionContext): Promise<string> {
  if (this.browserOffPending) return this.browserOffPending;
  this.interrupt(); const generation = this.generation;
  this.mode.setEnabled(false, ctx); ctx.abort();
  const operation = (async () => {
   try {
    if (this.browserOperation && this.browserStage === "mutating") {
     // Wait for the bounded Docker start/import/stop to settle before cleanup;
     // cancellation checks prohibit late ON or a subsequent unrequested start.
     let timeout: ReturnType<typeof setTimeout> | undefined;
     try {
      await Promise.race([this.browserOperation.catch(() => {}), new Promise<never>((_, reject) => {
       timeout = setTimeout(() => reject(new Error("Browser operation still settling; Computer use OFF. Container cleanup is unconfirmed; inspect status before retrying /browser use off.")), 165_000);
       timeout.unref?.();
      })]);
     } finally { if (timeout) clearTimeout(timeout); }
    }
    if (this.selected !== "docker") {
     // Do not Stop the host daemon or switch routing while host tools are live.
     if (this.active) throw new Error("Host desktop work may still be settling; Computer use OFF. Wait before using /browser use off again.");
     this.selected = "docker"; this.handle = undefined; this.socketIdentity = undefined;
     this.pi.appendEntry(ENTRY, { target: "docker" }); this.label(ctx);
    }
    // A different Pi chat may currently own an active workflow. Never tear
    // down its shared browser while it still holds the cross-session claim.
    // OFF locally and report a blocker; the other chat must settle first.
    if (this.ownsControl) this.controlHolds++;
    else if (this.controlPending) this.controlReservations++;
    await this.acquireControl(ctx, "docker");
    // Explicit shared OFF may address a container another chat recreated while
    // this chat was idle. Never repin with an in-flight desktop tool: that tool
    // must see its stale identity and fail closed instead of crossing targets.
    if (this.active === 0) { this.handle = undefined; this.socketIdentity = undefined; }
    const state = await this.docker(ctx).status();
    if (state.status === "running") this.stopped = true;
    if (state.status === "absent") return "Docker browser is OFF. No owned container is running; private profile is retained. Target stays Docker.";
    if (state.status === "running" && state.authentication === "legacy-password" && state.requiresRecreate === true) {
     // This explicit OFF authorizes preserving a legacy profile before removal.
     // No replacement container is started. A failed/pending import leaves the
     // old browser in place; never discard an unmigrated profile.
     await this.docker(ctx).prepare();
     if (generation !== this.generation) throw new Error("Browser cleanup changed during migration preparation; Computer use OFF.");
     await this.migrateLegacy(ctx, () => {
      if (generation !== this.generation) throw new Error("Browser cleanup changed during migration; Computer use OFF.");
     }, false);
     return "Docker browser OFF; legacy profile migrated to the private volume, input stopped and old container removed. /browser use explicitly starts the passwordless browser later.";
    }
    if (state.status === "stopped" && state.authentication === "none") {
     // A stopped container has no running daemon/input to Stop. Its exact
     // record/volume still go through the runtime's ownership validation.
     await this.workflow.close();
     await this.docker(ctx).stop();
     this.handle = undefined; this.socketIdentity = undefined;
     if ((await this.docker(ctx).status()).status !== "absent") throw new Error("Stopped browser removal was not verified; Computer use OFF.");
     return "Docker browser OFF; stopped owned container removed, private profile retained. No input was running.";
    }
    if (state.status !== "running" || state.authentication !== "none")
     throw new Error("Browser cleanup is unconfirmed or legacy profile is unsafe; Computer use OFF. Inspect status before retrying.");
    // Explicit Stop has no aborted turn signal; require native acknowledgement
    // before removing the browser container. No other daemon is contacted.
    let response: DaemonResponse;
    try { response = await this.request(ctx, "docker", { cmd: "stop" }); }
    catch { throw new Error("Docker Stop could not be confirmed. Computer use OFF; browser container was not removed. Inspect status before retrying."); }
    if (response.ok !== true || response.input_stopped !== true)
     throw new Error("Docker Stop was not acknowledged. Computer use OFF; browser container was not removed. Inspect status before retrying.");
    await this.workflow.close();
    await this.docker(ctx).stop();
    this.handle = undefined; this.socketIdentity = undefined;
    const after = await this.docker(ctx).status();
    if (after.status !== "absent") throw new Error("Browser removal was not verified; Computer use OFF. Inspect status.");
    return "Shared Docker browser OFF for all Pi chats; this Pi run aborted, Docker input stopped and owned container removed. Common private profile retained; /browser use explicitly starts it again.";
   } finally {
    try { await this.releaseControl(ctx); }
    finally { this.label(ctx); }
   }
  })();
  this.browserOffPending = operation;
  void operation.finally(() => { if (this.browserOffPending === operation) this.browserOffPending = undefined; }).catch(() => {});
  return operation;
 }

 private async migrateLegacy(ctx: ExtensionContext, check: () => void = () => {}, restart = true): Promise<string> {
  if (this.selected !== "docker") throw new Error("Select Docker before migrating its legacy browser profile.");
  const state = await this.docker(ctx).status(); check();
  if (state.status !== "running" || state.authentication !== "legacy-password" || state.requiresRecreate !== true)
   throw new Error("Migration requires the selected running legacy Docker browser; no browser was changed.");
  // The sole exception to the legacy IPC ban: an explicit user command, pinned
  // to the verified legacy socket/CID. Never use the aborted turn's signal.
  const { socketPath } = await this.running(ctx, true); check();
  this.stopped = true;
  let response: DaemonResponse;
  try { response = await new ComputerUseClient({ socketPath }).request({ cmd: "stop" }); }
  catch { throw new Error("Legacy Docker Stop was not confirmed. Migration did not start; source browser remains. Do not retry uncertain input automatically."); }
  if (response.ok !== true || response.input_stopped !== true)
   throw new Error("Legacy Docker Stop was not acknowledged. Migration did not start; source browser remains.");
  check();
  // Runtime imports directly into its verified private volume; no archive,
  // password, or raw error text reaches a Pi transcript or log.
  try { await this.docker(ctx).migrateLegacyProfile(); }
  catch { throw new Error("Legacy profile migration was not completed. Original browser remains; Computer use OFF. Inspect private migration state before any further attempt; do not stop the source."); }
  check();
  try { await this.docker(ctx).stop(); }
  catch { throw new Error("Legacy profile was copied to the private volume, but verified removal of the old browser failed. Computer use OFF; inspect status before explicit recovery. No replacement was started."); }
  this.handle = undefined; this.socketIdentity = undefined; check();
  if (!restart) {
   const after = await this.docker(ctx).status(); check();
   if (after.status !== "absent") throw new Error("Migrated legacy container removal was not verified; Computer use OFF.");
   return "Legacy profile copied to private persistent volume; old browser removed. Computer use OFF.";
  }
  this.browserStage = "mutating";
  let handle: Handle;
  try { handle = await this.docker(ctx).start(); }
  catch { throw new Error("Legacy profile was copied and the old browser removed, but starting the new browser failed. Private profile is retained; Computer use OFF. Explicitly inspect status and start when safe."); }
  this.handle = handle; this.stopped = false; check();
  await this.waitReady(ctx); check();
  this.workflow.resetAfterExplicitDaemonRestart();
  return "Legacy browser profile migrated to the private persistent Docker volume. Old container removed; new passwordless localhost viewer started. Computer use remains OFF. Use /computer-use docker status for the viewer link, then /computer-use on explicitly.";
 }
 interrupt(): void { this.generation++; }
 assertDispatchAllowed(command: string): void {
  if (this.selected === "docker" && !this.mode.isEnabled() && !["stop", "ping", "metrics", "daemon_info"].includes(command))
   throw new Error("Computer use is OFF; Docker desktop request was not sent. No host fallback.");
 }
 async enable(ctx: ExtensionContext): Promise<void> {
  const generation = this.generation;
  if (this.changing || this.pausing || this.browserOffPending) throw new Error("Docker target change, pause or shutdown is in progress.");
  if (this.selected !== "docker") return;
  if (this.stopped) throw new Error("Docker input stopped. Run /computer-use docker resume explicitly (or stop/start for a new browser) before enabling.");
  await this.compatible(ctx);
  if (generation !== this.generation || this.changing || this.pausing || this.browserOffPending || this.selected !== "docker" || this.stopped)
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
