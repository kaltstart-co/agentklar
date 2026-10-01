import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  Connection,
  MuseClient,
  checkServedFingerprint,
  readSessionDurability,
  type DuplexTransport,
  type Session,
  type Turn,
} from "@muse-code/sdk";
import type { ApprovalRequestParams } from "@muse-code/sdk/dist/src/msp.js";
import type { MuseSubscriptionUsage, Run } from "./contracts.ts";
import type { NativeCallbacks } from "./native.ts";
import { composeWorkerPrompt } from "./prompt.ts";

type Host = { client: MuseClient; close: () => Promise<void>; readUsage?: () => Promise<unknown>; pid?: number; home?: string; schemaWarning?: boolean };
type Connect = (command: string, cwd: string, onSpawn: (pid: number | undefined, close: () => Promise<void>) => void) => Promise<Host>;

const wait = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
});
const validCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const validStamp = (n: unknown): n is number =>
  validCount(n) && (n as number) >= Date.UTC(2000, 0, 1) && (n as number) <= 8_640_000_000_000_000;

function subscriptionUsage(value: unknown): MuseSubscriptionUsage | null {
  const usage = record(record(value)?.usage);
  const weekly = record(usage?.weekly);
  const window = record(usage?.window);
  if (!usage || !weekly || !window ||
      !validStamp(usage.observedAtMs) || !validStamp(weekly.resetsAtMs) ||
      !validStamp(window.resetsAtMs) || !validCount(weekly.usedPercent) ||
      !validCount(window.usedPercent) || !validCount(window.windowDurationMins) ||
      window.windowDurationMins === 0) return null;
  return {
    observedAtMs: usage.observedAtMs,
    weekly: { resetsAtMs: weekly.resetsAtMs, usedPercent: weekly.usedPercent },
    window: { resetsAtMs: window.resetsAtMs, usedPercent: window.usedPercent,
      windowDurationMins: window.windowDurationMins },
  };
}

function processGroupAlive(pid: number) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The SDK owns MSP framing, command IDs, session routing and event folding.
// This transport only makes the owned process group visible to AgentKlar.
async function connectMuse(command: string, cwd: string, onSpawn: (pid: number | undefined, close: () => Promise<void>) => void): Promise<Host> {
  const child: ChildProcessWithoutNullStreams = spawn(command, ["serve"], {
    cwd,
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
  child.stderr.on("data", () => {}); // Native diagnostics may contain auth data.
  child.on("error", () => {});
  child.stdout.setEncoding("utf8");
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let closing: Promise<void> | undefined;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, name);
      else child.kill(name);
    } catch {}
  };
  const close = () => closing ??= (async () => {
    if (!child.stdin.destroyed) child.stdin.end();
    await Promise.race([exited, wait(1500)]);
    if (child.pid && processGroupAlive(child.pid)) signal("SIGTERM");
    await Promise.race([exited, wait(1500)]);
    if (child.pid && processGroupAlive(child.pid)) signal("SIGKILL");
    await Promise.race([exited, wait(1500)]);
  })();
  onSpawn(child.pid, close);
  const transport: DuplexTransport = {
    incoming: child.stdout as AsyncIterable<string>,
    write: (chunk) => new Promise<void>((resolve, reject) =>
      child.stdin.write(chunk, (error) => error ? reject(error) : resolve())),
    close: async (flushed) => {
      if (flushed) await Promise.race([flushed.catch(() => {}), wait(1500)]);
      await close();
    },
  };
  const connection = new Connection(transport);
  let handshakeTimer: NodeJS.Timeout | undefined;
  try {
    const initialized = await Promise.race([
      connection.request("initialize", {
        clientInfo: { name: "agentklar", title: "AgentKlar", version: "0.1.0" },
        capabilities: { experimentalApi: true, userInputDialogs: false },
      }),
      new Promise<never>((_, reject) => {
        handshakeTimer = setTimeout(() => reject(new Error("Muse handshake timed out")), 15000);
        handshakeTimer.unref();
      }),
    ]) as unknown as Parameters<typeof readSessionDurability>[0];
    if (typeof initialized.schema?.fingerprint !== "string")
      throw new Error("Muse handshake lacks a schema fingerprint");
    connection.notify("initialized");
    await connection.flush();
    return {
      client: new MuseClient(connection, { durability: readSessionDurability(initialized) }),
      close: () => connection.close(),
      readUsage: () => connection.request("usage/read", {}),
      pid: child.pid,
      home: isAbsolute(initialized.museHome) ? initialized.museHome : undefined,
      schemaWarning: !!checkServedFingerprint(initialized.schema.fingerprint),
    };
  } catch (error) {
    await connection.close().catch(() => close());
    throw error;
  } finally {
    clearTimeout(handshakeTimer);
  }
}

export class MuseWorker {
  closed: Promise<void>;
  private host?: Host;
  private session?: Session;
  private turn?: Turn;
  private finished = false;
  private pending = new Set<(decision: string) => void>();
  private output = new Map<string, string>();
  private outputLength = 0;
  private outputTruncated = false;
  private closing?: Promise<void>;
  private connectingClose?: () => Promise<void>;
  private pid?: number;
  private resolveStopped!: () => void;
  private stopped: Promise<void>;

  constructor(
    private command: string,
    private run: Run,
    private path: string,
    private callbacks: NativeCallbacks,
    connect: Connect = connectMuse,
  ) {
    this.stopped = new Promise((resolve) => { this.resolveStopped = resolve; });
    this.closed = this.start(connect);
  }

  private async untilStopped<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.stopped.then(() => { throw new Error("Worker stopped"); })]);
  }

  private async start(connect: Connect) {
    try {
      if (this.run.readOnly) {
        this.finish("needs_attention", "Muse read-only runs are unavailable because the native session has no read-only tool restriction.");
        return;
      }
      const opening = connect(this.command, this.path, (pid, close) => {
        this.pid = pid;
        this.connectingClose = close;
        if (pid) this.callbacks.update({ workerPid: pid });
        if (this.finished) void close().catch(() => {});
      });
      void opening.then((host) => {
        if (this.finished) void host.close().catch(() => {});
      }).catch(() => {});
      const host = await this.untilStopped(opening);
      this.host = host;
      if (host.pid && !this.pid) {
        this.pid = host.pid;
        this.callbacks.update({ workerPid: host.pid });
      }
      if (host.home) this.callbacks.update({ nativeHome: host.home });
      if (host.schemaWarning) this.callbacks.event("protocol", "Muse uses a different protocol schema than this SDK. Stable fields remain available.");
      if (this.finished) return;
      const session = await this.untilStopped(host.client.startSession({
        workspaceRoot: this.path,
        ...(this.run.model ? { modelId: this.run.model } : {}),
      }));
      this.session = session;
      if (this.finished) return;
      this.callbacks.update({
        threadId: session.sessionId,
        effectiveModel: session.opening?.result.session.modelId ?? undefined,
      });
      session.onApproval((request) => this.approval(request));
      session.onApprovalError(() => this.finish("needs_attention", "Muse could not settle a native approval. Continue in your native harness."));
      const turn = await this.untilStopped(session.sendUserTurn({ input: [{ type: "text", text: composeWorkerPrompt(this.run) }] }));
      this.turn = turn;
      if (this.finished) return;
      this.callbacks.update({ turnId: turn.turnId });
      const items = this.collect(turn);
      const outcome = await this.untilStopped(turn.completed);
      await this.untilStopped(items);
      if (this.finished) return;
      if (outcome.kind === "completed") {
        this.updateResult();
        this.updateUsage(session);
        await this.untilStopped(this.updateSubscriptionUsage(host));
        const terminal = outcome.params.terminal;
        if (terminal === "completed") this.finish("completed");
        else if (terminal === "cancelled" || terminal === "interrupted") this.finish("interrupted");
        else this.finish("failed", "Muse could not complete the task. Check its native CLI for details.");
      } else {
        this.finish("failed", "Muse exited before its root turn completed.");
      }
    } catch {
      if (!this.finished)
        this.finish("failed", "Muse worker could not run. Check sign-in, model access and limits in the native Muse CLI.");
    } finally {
      await (this.host ? this.closeHost() : this.connectingClose?.().catch(() => {}));
      if (this.pid && processGroupAlive(this.pid))
        this.callbacks.event("attention", "Owned Muse process group may still be alive. New work is blocked until it exits.");
      else this.callbacks.update({ workerPid: undefined });
      this.callbacks.done();
    }
  }

  private async collect(turn: Turn) {
    for await (const item of turn.items()) {
      if (this.finished) break;
      if (item.turnId !== turn.turnId || item.kind !== "agentMessage" || typeof item.text !== "string") continue;
      const previous = this.output.get(item.itemId) ?? "";
      if (item.text.startsWith(previous)) {
        const added = item.text.slice(previous.length);
        if (added && this.outputLength < 24000) {
          const bounded = added.slice(0, 24000 - this.outputLength);
          this.callbacks.event("output", bounded);
          this.outputLength += bounded.length;
        }
      }
      const used = [...this.output.values()].reduce((sum, text) => sum + text.length, 0) - previous.length;
      const capacity = Math.max(0, 24001 - used);
      if (item.text.length > capacity || item.truncated || (!this.output.has(item.itemId) && this.output.size >= 64))
        this.outputTruncated = true;
      if (this.output.has(item.itemId) || this.output.size < 64)
        this.output.set(item.itemId, item.text.slice(0, capacity));
    }
  }

  private updateResult() {
    const text = [...this.output.values()].join("\n");
    this.callbacks.update({ result: text.slice(0, 24000), resultTruncated: this.outputTruncated || text.length > 24000 });
  }

  private updateUsage(session: Session) {
    const usage = session.fold.sessionState.get("session/tokenUsage") as
      | { cumulative?: { totalTokens?: number }; modelId?: string; turnId?: string }
      | undefined;
    const modelChanged = session.fold.sessionState.get("session/modelChanged") as
      | { modelId?: string }
      | undefined;
    const model = usage?.turnId === this.turn?.turnId ? usage?.modelId : undefined;
    const effectiveModel = [model, modelChanged?.modelId].find((value) =>
      typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value));
    if (effectiveModel) this.callbacks.update({ effectiveModel });
    // The session counter excludes child agents. Leave totals unknown when a
    // child or workflow ran rather than presenting an understated number.
    const children = session.fold.items.list().some((item) =>
      item.kind === "subagent" || item.kind === "workflow");
    const total = usage?.cumulative?.totalTokens;
    this.callbacks.update({ tokens: !children && validCount(total) ? total : null });
  }

  private async updateSubscriptionUsage(host: Host) {
    if (!host.readUsage) return;
    try {
      const result = await Promise.race([
        host.readUsage().catch(() => undefined),
        wait(750).then(() => undefined),
      ]);
      const usage = subscriptionUsage(result);
      if (!this.finished && usage &&
          usage.observedAtMs >= (this.run.museSubscriptionUsage?.observedAtMs ?? 0))
        this.callbacks.update({ museSubscriptionUsage: usage });
    } catch {} // Account metadata must not change the root turn result.
  }

  private approval(request: ApprovalRequestParams): Promise<{ choiceId: string }> {
    const subject = request.subject;
    let fileArgs: Record<string, unknown> | undefined;
    if (subject.kind === "fileAccess") {
      try {
        const parsed: unknown = JSON.parse(request.rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fileArgs = parsed as Record<string, unknown>;
      } catch {}
    }
    const concrete = subject.kind === "shell"
      ? typeof subject.command === "string" && subject.command.length > 0 && !subject.stages?.length
      : subject.kind === "fileAccess"
        ? typeof subject.path === "string" && isAbsolute(subject.path) && !!subject.access &&
          !subject.stages?.length && !!fileArgs &&
          (subject.access === "read" || typeof fileArgs.content === "string" || typeof fileArgs.patch === "string")
        : false;
    const approve = request.availableChoices.find((choice) =>
      choice.scope === "once" && choice.decision === "approved");
    const deny = request.availableChoices.find((choice) =>
      choice.scope === "once" && choice.decision === "denied");
    if (this.finished || !concrete || !approve || !deny || request.rawArgs.length > 32000 || request.subagentOrigin || request.protectedWrite || subject.origin) {
      this.finish("needs_attention", "Unsupported Muse approval request. Continue in your native harness.");
      throw new Error("Unsupported Muse approval request");
    }
    this.callbacks.update({ state: "needs_attention" });
    return new Promise((resolve) => {
      const settle = (decision: string) => {
        if (!this.pending.delete(settle)) return;
        if (decision === "cancel") this.stop();
        else if (!this.finished && !this.pending.size) this.callbacks.update({ state: "running" });
        resolve({ choiceId: decision === "accept" && !this.finished ? approve.choiceId : deny.choiceId });
      };
      this.pending.add(settle);
      this.callbacks.approval({
        id: randomUUID(), runId: this.run.id,
        kind: subject.kind === "shell" ? "command" : "file",
        title: subject.kind === "shell" ? "Approve command" : "Approve file access",
        details: { subject, tool: request.toolName, ...(fileArgs ? { args: fileArgs } : {}), cwd: this.path },
        decisions: ["accept", "decline", "cancel"],
        createdAt: new Date().toISOString(),
      }, settle);
    });
  }

  private finish(state: Run["state"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    this.resolveStopped();
    this.callbacks.update({ state, ...(error ? { error } : {}) });
    for (const settle of [...this.pending]) settle("cancel");
    void (this.host ? this.closeHost() : this.connectingClose?.().catch(() => {}));
  }

  private closeHost() {
    if (!this.host) return Promise.resolve();
    return this.closing ??= this.host.close().catch(() => {});
  }

  stop() { this.finish("cancelled"); }
}
