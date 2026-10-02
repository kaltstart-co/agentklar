import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Approval, Run } from "./contracts.ts";
import type { NativeCallbacks } from "./native.ts";
import { composeWorkerPrompt } from "./prompt.ts";
const record = (v: unknown): Record<string, any> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const text = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max && !v.includes("\0");
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const tools = ["Read", "Glob", "Grep", "Bash", "Write", "Edit"];
/** The desktop bundle needs its shipped public provider file; native overrides win. */
export function zcodeEnvironment(command: string, args: string[], nativeEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...nativeEnv };
  if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE !== undefined || env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE !== undefined) return env;
  const entry = command.endsWith(".cjs") ? command : args[0];
  if (!entry || !isAbsolute(entry)) return env;
  try {
    const bundled = realpathSync(entry), glm = dirname(bundled), resources = dirname(glm);
    if (basename(bundled) !== "zcode.cjs" || basename(glm) !== "glm" || basename(resources) !== "Resources") return env;
    const config = join(resources, "config", "provider", "zcode-builtin.json");
    if (!lstatSync(config).isFile()) return env;
    accessSync(config, constants.R_OK);
    // Native bootstrap copies this seed to its normal cache before runtime.
    // An explicit personal config would skip that bootstrap, so it is left alone above.
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config;

  } catch { /* Ordinary native CLI installs keep their own environment. */ }
  return env;
}
export function zcodeModel(value: string) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || !text(value, 120)) throw new Error("Use a native provider/model pin");
  const providerId = value.slice(0, slash), tail = value.slice(slash + 1), dollar = tail.indexOf("$");
  if (dollar === 0 || dollar === tail.length - 1 || (dollar >= 0 && tail.indexOf("$", dollar + 1) >= 0)) throw new Error("Invalid model pin");
  return { providerId, modelId: dollar < 0 ? tail : tail.slice(0, dollar),
    ...(dollar < 0 ? {} : { options: { reasoningLevel: tail.slice(dollar + 1) } }) };
}
export function zcodeApproval(params: unknown, runId: string, cwd: string): Approval | null {
  const p = record(params), input = record(p?.input);
  if (!p || !input || p.origin || !text(p.toolCallId, 200) || Buffer.byteLength(JSON.stringify(input)) > 40_000) return null;
  let details: unknown, kind: Approval["kind"];
  if (p.toolName === "Bash") {
    if (!text(input.command, 16_000) || !input.command.trim() || input.run_in_background ||
      Object.keys(input).some(k => !["command", "description", "timeout", "run_in_background"].includes(k))) return null;
    details = { command: input.command, cwd }; kind = "command";
  } else if (p.toolName === "Write" || p.toolName === "Edit") {
    if (!text(input.file_path) || !isAbsolute(input.file_path)) return null;
    if (p.toolName === "Write") {
      if (typeof input.content !== "string" || input.content.includes("\0") || Object.keys(input).some(k => !["file_path", "content"].includes(k))) return null;
    } else if (typeof input.old_string !== "string" || !input.old_string || typeof input.new_string !== "string" ||
      input.old_string.includes("\0") || input.new_string.includes("\0") ||
      Object.keys(input).some(k => !["file_path", "old_string", "new_string", "replace_all"].includes(k))) return null;
    details = { ...input, tool: p.toolName, cwd }; kind = "file";
  } else return null;
  return { id: randomUUID(), runId, kind, title: kind === "command" ? "Approve command" : "Approve file change",
    details, decisions: ["accept", "decline", "cancel"], createdAt: new Date().toISOString() };
}

/** Vendor-shipped ZCode Protocol v1, not ACP or Codex app-server. Native account and permission rules stay native. */
export class ZCodeWorker {
  child?: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  private resolveClosed!: () => void;
  private finished = false;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private sessionId?: string;
  private turnId?: string;
  private inputId = randomUUID();
  private sending = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: () => void; timer: NodeJS.Timeout }>();
  private approvals = new Map<string, { params: string; settle: (decision: string) => void }>();
  private seen = new Set<string>();
  private termination?: NodeJS.Timeout;
  private escalation?: NodeJS.Timeout;
  constructor(command: string, private run: Run, private cwd: string, private callbacks: NativeCallbacks,
    options: { args?: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    if (run.readOnly) {
      queueMicrotask(() => { this.finish("needs_attention", "ZCode cannot enforce read-only work. Choose Codex or Claude Code for a review."); callbacks.done(); this.resolveClosed(); }); return;
    }
    const args = options.args ?? ["app-server", "--stdio"];
    this.child = spawn(command, args, { cwd, env: zcodeEnvironment(command, args, options.env ?? process.env), stdio: "pipe", detached: process.platform !== "win32" });
    if (this.child.pid) callbacks.update({ workerPid: this.child.pid });
    this.child.stdout.on("data", chunk => this.receive(Buffer.from(chunk)));
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.finish("failed", "Native ZCode connection closed."));
    this.child.on("error", () => this.finish("failed", "Native ZCode app-server could not start."));
    this.child.on("close", async () => {
      if (!this.finished) this.finish("failed", "ZCode exited before its root turn completed.");
      clearTimeout(this.termination); clearTimeout(this.escalation);
      if (this.alive()) callbacks.event("attention", "Stopping remaining owned ZCode processes before closing the worker.");
      // Service shutdown awaits closed. A referenced timer keeps group cleanup alive.
      while (this.alive()) {
        this.kill("SIGKILL");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      callbacks.update({ workerPid: undefined });
      callbacks.done(); this.resolveClosed();
    });
    void this.start(options.timeoutMs ?? 15_000).catch(() => {
      if (!this.finished) this.finish("needs_attention", "ZCode session could not start. Check native sign-in, model pin and app-server support.");
    });
  }
  private alive() {
    try { if (!this.child?.pid) return false; process.kill(process.platform === "win32" ? this.child.pid : -this.child.pid, 0); return true; } catch { return false; }
  }
  private kill(signal: NodeJS.Signals) {
    try { if (process.platform !== "win32" && this.child?.pid) process.kill(-this.child.pid, signal); else this.child?.kill(signal); } catch {}
  }
  private send(value: unknown) { if (this.child?.stdin.writable && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + "\n"); }
  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    if (this.finished) return Promise.reject(new Error("Stopped"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, fail = () => reject(new Error("Native request failed"));
      const timer = setTimeout(() => { this.pending.delete(id); fail(); }, timeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject: fail, timer }); this.send({ id, method, params });
    });
  }
  private async start(timeout: number) {
    // Avoid setModel/create-model: shipped implementations can persist workspace last-used selection.
    const model = this.run.model ? zcodeModel(this.run.model) : undefined;
    const snapshot = await this.request("session/create", { workspace: { workspacePath: this.cwd, workspaceKey: this.cwd },
      mode: "build", titleGenerationEnabled: false, toolAllowlist: tools,
      toolDenylist: ["Agent", "Task", "Workflow", "CronCreate", "OffPeakCreate", "SendMessage"],
      offPeakToolEnabled: false, dynamicWorkflowEnabled: false }, timeout);
    if (snapshot?.protocol?.name !== "ZCode Protocol" || snapshot.protocol.version !== 1 ||
      !text(snapshot?.session?.sessionId, 200) || snapshot.session.mode !== "build" || snapshot.settings?.mode?.current !== "build" ||
      snapshot.settings?.permission?.mode !== "build") throw new Error("Unsupported native session");
    this.sessionId = snapshot.session.sessionId;
    this.callbacks.update({ threadId: this.sessionId });
    if (model && (!Array.isArray(snapshot.settings?.model?.available) ||
      !snapshot.settings.model.available.some((m: any) => m?.ref?.providerId === model.providerId && m?.ref?.modelId === model.modelId && !m.disabledReason &&
        (!model.options || m.ref.options?.reasoningLevel === model.options.reasoningLevel)))) throw new Error("Native model not offered");
    await this.request("session/subscribe", { sessionId: this.sessionId, deliveryKind: "desktop-continuous", includeSnapshot: false }, timeout);
    if (this.finished) return;
    this.sending = true;
    const accepted = await this.request("session/send", { sessionId: this.sessionId, inputId: this.inputId, queryId: this.inputId,
      content: composeWorkerPrompt(this.run), ...(model ? { modelSelection: model } : {}) }, timeout);
    if (this.finished) return;
    if (accepted?.accepted !== true || accepted.sessionId !== this.sessionId) throw new Error("Task not admitted");
    // Admission alone never completes the run. Completion arrives as a matching root session/event.
  }
  private receive(chunk: Buffer) {
    if (this.finished) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      if (end > 256_000) { this.finish("failed", "ZCode protocol message exceeded its limit."); return; }
      const line = this.buffer.subarray(0, end).toString("utf8"); this.buffer = this.buffer.subarray(end + 1);
      if (!line.trim()) continue;
      try { this.message(JSON.parse(line)); } catch { this.finish("failed", "ZCode protocol message could not be read."); return; }
      if (this.finished) return;
    }
    if (this.buffer.length > 256_000) this.finish("failed", "ZCode protocol message exceeded its limit.");
  }
  private message(value: unknown) {
    const m = record(value); if (!m) throw new Error("Invalid envelope");
    if (!m.method) {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error !== undefined || !Object.hasOwn(m, "result")) p.reject(); else p.resolve(m.result); return;
    }
    if (m.id !== undefined) {
      if (!text(m.id, 200) && !(typeof m.id === "number" && Number.isSafeInteger(m.id))) throw new Error("Invalid server request");
      if (m.method === "interaction/requestPermission") { this.permission(m.id, m.params); return; }
      this.send({ id: m.id, error: { code: -32601, message: "Unsupported native client action" } });
      // Native source explicitly falls back to its own defaults for absent runtime preference clients.
      if (m.method === "session/requestRuntimePreferences") return;
      this.finish("needs_attention", "ZCode needs an unsupported native client action. Continue in ZCode."); return;
    }
    if (m.method !== "session/event") return;
    const e = record(m.params), p = record(e?.payload);
    if (!e || e.sessionId !== this.sessionId) return;
    if (e.type === "turn.started") {
      if (!this.sending || p?.inputId !== this.inputId || p.backgroundSource || p.originMeta || !text(e.turnId, 200) || this.turnId) return;
      this.turnId = e.turnId; this.callbacks.update({ turnId: this.turnId }); return;
    }
    if (!this.turnId || e.turnId !== this.turnId) return;
    if (e.type === "turn.failed") { this.finish("failed", "ZCode root turn failed. Check its native session."); return; }
    if (e.type !== "turn.completed") return;
    if (p?.inputId !== this.inputId || p.backgroundSubagentResultConsumed || this.approvals.size) {
      this.finish("needs_attention", "ZCode completion could not be tied to the approved root work."); return;
    }
    if (typeof p.response !== "string" || !count(p.tokenCount)) throw new Error("Invalid completion");
    this.callbacks.update({ result: p.response.slice(0, 32_000), resultTruncated: p.response.length > 32_000, tokens: p.tokenCount });
    if (p.resultType === "success") this.finish("completed");
    else if (p.resultType === "cancelled") this.finish("interrupted");
    else this.finish("needs_attention", "ZCode stopped before completing its root turn.");
  }
  private permission(id: string | number, value: unknown) {
    const p = record(value), nativeId = p?.requestId;
    const deny = () => this.send({ id, result: { decision: "deny", reason: "Unsupported AgentKlar approval" } });
    if (!p || !text(nativeId, 200) || !this.turnId || p?.sessionId !== this.sessionId || p.turnId !== this.turnId) { deny(); this.finish("needs_attention", "ZCode approval ownership could not be verified."); return; }
    const existing = this.approvals.get(nativeId);
    if (existing) {
      if (existing.params !== JSON.stringify(p)) { deny(); this.finish("needs_attention", "ZCode changed a pending approval."); }
      return; // The server reannounces one request with multiple transport IDs; the first reply settles all aliases.
    }
    const approval = zcodeApproval(p, this.run.id, this.cwd);
    if (!approval || this.seen.has(nativeId) || this.seen.size >= 1024 || this.approvals.size >= 8 ||
      !Array.isArray(p.options) || !p.options.some((o: any) => o?.kind === "allow_once")) {
      deny(); this.finish("needs_attention", "ZCode requested an unsupported or incomplete approval. Continue in ZCode."); return;
    }
    this.seen.add(nativeId); this.callbacks.update({ state: "needs_attention" });
    const settle = (decision: string) => {
      if (!this.approvals.delete(nativeId)) return;
      const allow = !this.finished && decision === "accept";
      this.send({ id, result: { decision: allow ? "allow" : "deny", reason: allow ? "Approved once in AgentKlar" : "Declined in AgentKlar" } });
      if (decision === "cancel" && !this.finished) this.stop();
      else if (!this.finished && !this.approvals.size) this.callbacks.update({ state: "running" });
    };
    this.approvals.set(nativeId, { params: JSON.stringify(p), settle }); this.callbacks.approval(approval, settle);
  }
  private finish(state: Run["state"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    for (const p of [...this.approvals.values()]) p.settle("cancel");
    if (state !== "completed" && this.sessionId) this.send({ id: ++this.sequence, method: "session/stop", params: { sessionId: this.sessionId } });
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(); } this.pending.clear();
    this.callbacks.update({ state, ...(error ? { error } : {}) });
    if (this.child) {
      this.termination = setTimeout(() => this.kill("SIGTERM"), 100); this.termination.unref();
      this.escalation = setTimeout(() => this.kill("SIGKILL"), 1500); this.escalation.unref();
    }
  }
  stop() { this.finish("cancelled"); }
}
