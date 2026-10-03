import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Approval, Run } from "./contracts.ts";
import type { NativeCallbacks } from "./native.ts";
import { composeWorkerPrompt } from "./prompt.ts";

type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes("\0");
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const maxMessage = 256_000;

/** ACP display titles are not authority to approve a command. */
export function acpApproval(value: unknown, runId: string, cwd: string): Approval | null {
  const call = object(value);
  if (!call || !text(call.toolCallId, 200) || call._meta || Buffer.byteLength(JSON.stringify(call)) > 48_000) return null;
  let details: unknown;
  let kind: Approval["kind"];
  if (call.kind === "execute") {
    const input = object(call.rawInput);
    if (!input || !text(input.command, 16_000) || !input.command.trim() ||
      Object.keys(input).some(key => key !== "command" && key !== "cwd") ||
      (input.cwd !== undefined && (!text(input.cwd) || input.cwd !== cwd))) return null;
    details = { command: input.command, cwd };
    kind = "command";
  } else if (call.kind === "edit") {
    if (!Array.isArray(call.content) || !call.content.length || call.content.length > 8 || call.rawInput !== undefined) return null;
    const changes = [];
    for (const item of call.content) {
      if (!object(item) || item.type !== "diff" || !text(item.path) || !isAbsolute(item.path) ||
        typeof item.oldText !== "string" || typeof item.newText !== "string" ||
        Buffer.byteLength(item.oldText) + Buffer.byteLength(item.newText) > 32_000 ||
        item.oldText.includes("\0") || item.newText.includes("\0")) return null;
      changes.push({ path: item.path, oldText: item.oldText, newText: item.newText });
    }
    details = { changes, cwd };
    kind = "file";
  } else return null;
  return { id: randomUUID(), runId, kind, title: kind === "command" ? "Approve command" : "Approve file changes",
    details, decisions: ["accept", "decline", "cancel"], createdAt: new Date().toISOString() };
}

/** Native CLI owns its account, settings, tools, and saved session. No client filesystem or terminal proxy. */
export class AcpWorker {
  child?: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  private resolveClosed!: () => void;
  private finished = false;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private sessionId?: string;
  private promptStarted = false;
  private result = "";
  private truncated = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: () => void; timer?: NodeJS.Timeout }>();
  private permissions = new Map<string | number, (decision: string) => void>();
  private seenRequests = new Set<string | number>();
  private termination?: NodeJS.Timeout;
  private escalation?: NodeJS.Timeout;
  constructor(command: string, private run: Run, private cwd: string, private callbacks: NativeCallbacks,
    options: { args?: string[]; handshakeTimeoutMs?: number } = {}) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    if (run.readOnly) {
      queueMicrotask(() => { this.finish("needs_attention", "This ACP worker cannot enforce read-only work. Choose Codex or Claude Code for a review."); callbacks.done(); this.resolveClosed(); });
      return;
    }
    this.child = spawn(command, options.args ?? ["acp"], {
      cwd, stdio: "pipe", detached: process.platform !== "win32",
    });
    if (this.child.pid) callbacks.update({ workerPid: this.child.pid });
    this.child.stdout.on("data", chunk => this.receive(Buffer.from(chunk)));
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.finish("failed", "Native ACP connection closed."));
    this.child.on("error", () => this.finish("failed", "Native ACP worker could not start. Check its native CLI."));
    this.child.on("close", async () => {
      if (!this.finished) this.finish("failed", "Native ACP worker exited before its root turn completed.");
      clearTimeout(this.termination); clearTimeout(this.escalation);
      if (this.alive()) callbacks.event("attention", "Stopping remaining owned ACP processes before closing the worker.");
      // closed is the service shutdown boundary. A referenced timer keeps cleanup
      // alive even when this direct child and the HTTP server have already exited.
      while (this.alive()) {
        this.kill("SIGKILL");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      callbacks.update({ workerPid: undefined });
      callbacks.done(); this.resolveClosed();
    });
    void this.start(options.handshakeTimeoutMs ?? 15_000).catch(() => {
      if (!this.finished) this.finish("needs_attention", "Native ACP session could not start. Check sign-in, model access and ACP support in the native CLI.");
    });
  }
  private alive() {
    try { if (!this.child?.pid) return false; process.kill(process.platform === "win32" ? this.child.pid : -this.child.pid, 0); return true; } catch { return false; }
  }
  private kill(signal: NodeJS.Signals) {
    try { if (process.platform !== "win32" && this.child?.pid) process.kill(-this.child.pid, signal); else this.child?.kill(signal); } catch {}
  }
  private send(message: unknown) {
    if (this.child?.stdin.writable && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  private request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    if (this.finished) return Promise.reject(new Error("Worker stopped"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const fail = () => reject(new Error("ACP request failed"));
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => { this.pending.delete(id); fail(); }, timeoutMs);
      timer?.unref(); this.pending.set(id, { resolve, reject: fail, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  private async start(timeoutMs: number) {
    const initialized = await this.request("initialize", { protocolVersion: 1, clientInfo: { name: "agentklar", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, timeoutMs);
    if (initialized?.protocolVersion !== 1) throw new Error("Unsupported ACP version");
    // session/new uses the CLI's existing selected account. authenticate can change native settings.
    const session = await this.request("session/new", { cwd: this.cwd, mcpServers: [] }, timeoutMs);
    if (!text(session?.sessionId, 200)) throw new Error("Missing ACP session");
    this.sessionId = session.sessionId;
    this.callbacks.update({ threadId: this.sessionId });
    const models = object(session.models);
    let model = text(models?.currentModelId, 120) ? models.currentModelId : undefined;
    if (this.run.model) {
      if (!Array.isArray(models?.availableModels) || !models.availableModels.some((entry: any) => entry?.modelId === this.run.model))
        throw new Error("Native model pin not offered");
      if (model !== this.run.model) {
        const ack = await this.request("session/set_model", { sessionId: this.sessionId, modelId: this.run.model }, timeoutMs);
        if (!object(ack)) throw new Error("Invalid model acknowledgement");
      }
      model = this.run.model;
    }
    if (this.finished) return;
    this.callbacks.update({ threadId: this.sessionId, ...(model ? { effectiveModel: model } : {}) });
    this.promptStarted = true;
    const reply = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: composeWorkerPrompt(this.run) }] });
    if (this.finished) return;
    if (this.permissions.size) { this.finish("needs_attention", "Native turn ended with an unsettled approval."); return; }
    const usage = object(reply?.usage);
    // Streaming usage is context-window occupancy, not a cumulative turn total.
    if (counter(usage?.totalTokens)) this.callbacks.update({ tokens: usage.totalTokens });
    if (reply?.stopReason === "end_turn") this.finish("completed");
    else if (reply?.stopReason === "cancelled") this.finish("interrupted");
    else if (["max_tokens", "max_turn_requests", "refusal"].includes(reply?.stopReason))
      this.finish("needs_attention", "Native ACP turn stopped before completion. Continue in the native harness.");
    else this.finish("failed", "Native ACP turn returned an unsupported completion result.");
  }
  private receive(chunk: Buffer) {
    if (this.finished) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > maxMessage) { this.finish("failed", "Native ACP message exceeded its limit."); return; }
      const line = this.buffer.subarray(0, end).toString("utf8"); this.buffer = this.buffer.subarray(end + 1);
      if (!line.trim()) continue;
      try { this.message(JSON.parse(line)); } catch { this.finish("failed", "Native ACP message could not be read."); return; }
      if (this.finished) return;
    }
    if (this.buffer.length > maxMessage) this.finish("failed", "Native ACP message exceeded its limit.");
  }
  private message(value: unknown) {
    const message = object(value);
    if (!message || message.jsonrpc !== "2.0") throw new Error("Invalid ACP envelope");
    if (message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error !== undefined || !Object.hasOwn(message, "result")) pending.reject(); else pending.resolve(message.result);
      return;
    }
    const params = object(message.params);
    const requestId = message.id;
    if (requestId !== undefined) {
      if (!(typeof requestId === "number" && Number.isSafeInteger(requestId)) && !text(requestId, 200)) throw new Error("Invalid ACP request ID");
      if (this.seenRequests.has(requestId) || this.seenRequests.size >= 1024) throw new Error("Duplicate or excessive ACP requests");
      this.seenRequests.add(requestId);
      if (message.method === "session/request_permission") { this.permission(requestId, params); return; }
      if (message.method === "cursor/ask_question" || message.method === "cursor/create_plan") {
        this.send({ jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "cancelled" } } });
        this.finish("needs_attention", "Native worker needs a question or plan decision. Continue in its native harness."); return;
      }
      this.send({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "Unsupported ACP client method" } });
      this.finish("needs_attention", "Native worker requested an unsupported client action. Continue in its native harness."); return;
    }
    if (message.method !== "session/update") return;
    const update = object(params?.update);
    if (update?.sessionUpdate !== "agent_message_chunk") return;
    if (!this.promptStarted || params?.sessionId !== this.sessionId || update._meta || params?._meta) throw new Error("Unexpected ACP session update");
    const content = object(update.content);
    if (content?.type !== "text" || typeof content.text !== "string") return;
    const addition = content.text.slice(0, Math.max(0, 32_000 - this.result.length));
    this.truncated ||= addition.length !== content.text.length; this.result += addition;
    this.callbacks.update({ result: this.result, resultTruncated: this.truncated });
    if (addition) this.callbacks.event("output", addition);
  }
  private permission(id: string | number, params: RecordValue | null) {
    const approval = this.promptStarted && params?.sessionId === this.sessionId && !params?._meta
      ? acpApproval(params?.toolCall, this.run.id, this.cwd) : null;
    const options = Array.isArray(params?.options) ? params.options : [];
    const allow = options.filter((entry: any) => entry?.kind === "allow_once" && text(entry.optionId, 200));
    const deny = options.filter((entry: any) => entry?.kind === "reject_once" && text(entry.optionId, 200));
    if (!approval || allow.length !== 1 || deny.length !== 1 ||
      new Set(options.map((entry: any) => entry?.optionId)).size !== options.length || this.permissions.size >= 8) {
      this.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      this.finish("needs_attention", "Native worker requested an unsupported or incomplete approval. Continue in its native harness."); return;
    }
    this.callbacks.update({ state: "needs_attention" });
    const settle = (decision: string) => {
      if (!this.permissions.delete(id)) return;
      const cancelled = decision === "cancel" || this.finished || !["accept", "decline"].includes(decision);
      this.send({ jsonrpc: "2.0", id, result: { outcome: cancelled ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: decision === "accept" ? allow[0].optionId : deny[0].optionId } } });
      if (cancelled && !this.finished) this.stop();
      else if (!this.finished && !this.permissions.size) this.callbacks.update({ state: "running" });
    };
    this.permissions.set(id, settle); this.callbacks.approval(approval, settle);
  }
  private finish(state: Run["state"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    for (const settle of [...this.permissions.values()]) settle("cancel");
    if (state !== "completed" && this.sessionId && this.promptStarted) this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(); }
    this.pending.clear();
    this.callbacks.update({ state, ...(error ? { error } : {}) });
    if (this.child) {
      // Give the pipe a bounded chance to deliver cancellation replies before terminating.
      this.termination = setTimeout(() => this.kill("SIGTERM"), 100); this.termination.unref();
      this.escalation = setTimeout(() => this.kill("SIGKILL"), 1500); this.escalation.unref();
    }
  }
  stop() { this.finish("cancelled"); }
}
