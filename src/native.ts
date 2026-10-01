import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Run, Approval } from "./contracts.ts";
import { randomUUID } from "node:crypto";
import { composeWorkerPrompt } from "./prompt.ts";
export type NativeCallbacks = {
  update: (patch: Partial<Run>) => void;
  event: (kind: string, text: string) => void;
  approval: (a: Approval, answer: (decision: string) => void) => void;
  done: () => void;
};
export class NativeWorker {
  child: ChildProcessWithoutNullStreams;
  sequence = 0;
  pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  threadId?: string;
  turnId?: string;
  stopped = false;
  finished = false;
  closed: Promise<void>;
  resolveClosed!: () => void;
  fileChanges = new Map<string, unknown>();
  early: any[] = [];
  constructor(
    command: string,
    private run: Run,
    private path: string,
    private callbacks: NativeCallbacks,
    args = ["app-server", "--stdio"],
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = spawn(command, args, {
      cwd: path,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    if (this.child.pid) callbacks.update({ workerPid: this.child.pid });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.message(JSON.parse(line));
      } catch {
        callbacks.event("protocol", "Native response could not be read.");
      }
    });
    // Native stderr can contain auth payloads. Store a bounded generic diagnostic only.
    this.child.stderr.on("data", () => {});
    this.child.on("error", (e) => this.finish("failed", e.message));
    this.child.on("close", () => {
      if (!this.finished) {
        this.finished = true;
        callbacks.update({
          state: this.stopped ? "cancelled" : "failed",
          error: this.stopped
            ? undefined
            : "Native worker exited before its root turn completed.",
        });
      }
      let groupAlive = false;
      try {
        if (this.child.pid) {
          process.kill(
            process.platform === "win32" ? this.child.pid : -this.child.pid,
            0,
          );
          groupAlive = true;
        }
      } catch {}
      if (!groupAlive) callbacks.update({ workerPid: undefined });
      else
        callbacks.event(
          "attention",
          "Owned process group may still be alive. New work is blocked until it exits.",
        );
      callbacks.done();
      this.resolveClosed();
    });
    void this.start().catch((e) => {
      if (!this.stopped) this.finish("failed", e.message);
    });
  }
  send(message: unknown) {
    if (!this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native ${method} request timed out`));
      }, 30000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async start() {
    await this.request("initialize", {
      clientInfo: { name: "agentklar", title: "AgentKlar", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized" });
    const { thread, model } = await this.request("thread/start", {
      cwd: this.path,
      ...(this.run.model ? { model: this.run.model } : {}),
      ...(this.run.readOnly ? { sandbox: "read-only" } : {}),
    });
    if (this.stopped) return;
    this.threadId = thread.id;
    this.callbacks.update({
      threadId: this.threadId,
      effectiveModel: typeof model === "string" ? model : undefined,
    });
    const { turn } = await this.request("turn/start", {
      threadId: this.threadId,
      input: [
        {
          type: "text",
          text: composeWorkerPrompt(this.run),
          text_elements: [],
        },
      ],
    });
    if (this.stopped) {
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: turn.id,
      }).catch(() => {});
      return;
    }
    this.turnId = turn.id;
    this.callbacks.update({ turnId: this.turnId });
    for (const m of this.early.splice(0)) this.message(m);
  }
  message(m: any) {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error
          ? p.reject(new Error(m.error.message || "Native request failed"))
          : p.resolve(m.result);
      }
      return;
    }
    const p = m.params || {};
    if (p.threadId && p.threadId !== this.threadId) return;
    if (
      m.method &&
      m.method.startsWith("item/") &&
      p.threadId !== this.threadId
    )
      return;
    if (!this.turnId && p.threadId === this.threadId) {
      this.early.push(m);
      return;
    }
    const turnId = p.turnId || p.turn?.id;
    if (turnId && turnId !== this.turnId) return;
    if (m.id !== undefined && m.method) {
      const command = m.method === "item/commandExecution/requestApproval";
      const file = m.method === "item/fileChange/requestApproval";
      if (
        (command &&
          typeof p.command === "string" &&
          (!p.kind || p.kind === "command") &&
          !p.networkApprovalContext &&
          !p.additionalPermissions) ||
        (file &&
          !p.grantRoot &&
          this.fileChanges.has(p.itemId) &&
          JSON.stringify(this.fileChanges.get(p.itemId)).length <= 32000)
      ) {
        const allowed = ["accept", "decline", "cancel"];
        const decisions = Array.isArray(p.availableDecisions)
          ? p.availableDecisions.filter(
              (d: unknown) => typeof d === "string" && allowed.includes(d),
            )
          : allowed;
        const details = command
          ? { command: p.command, cwd: p.cwd, reason: p.reason }
          : { changes: this.fileChanges.get(p.itemId), reason: p.reason };
        this.callbacks.update({ state: "needs_attention" });
        this.callbacks.approval(
          {
            id: randomUUID(),
            runId: this.run.id,
            kind: command ? "command" : "file",
            title: command ? "Approve command" : "Approve file changes",
            details,
            decisions,
            createdAt: new Date().toISOString(),
          },
          (decision) => {
            this.send({ id: m.id, result: { decision } });
            this.callbacks.update({ state: "running" });
          },
        );
      } else {
        this.send({
          id: m.id,
          error: {
            code: -32601,
            message:
              "AgentKlar cannot answer this native request. Use your native harness.",
          },
        });
        this.finish(
          "needs_attention",
          `Unsupported native request: ${m.method}`,
        );
        this.callbacks.event(
          "attention",
          `Unsupported native request: ${m.method}. Stop the worker and continue in your native harness.`,
        );
      }
      return;
    }
    if (m.method === "item/started" && p.item?.type === "fileChange")
      this.fileChanges.set(p.item.id, p.item.changes);
    if (m.method === "item/agentMessage/delta" && typeof p.delta === "string")
      this.callbacks.event("output", p.delta);
    if (m.method === "item/completed" && p.item?.type === "agentMessage")
      this.callbacks.update({
        result: (p.item.text || "").slice(0, 24000),
        resultTruncated: (p.item.text || "").length > 24000,
      });
    if (
      m.method === "thread/tokenUsage/updated" &&
      typeof p.tokenUsage?.last?.totalTokens === "number"
    )
      this.callbacks.update({ tokens: p.tokenUsage.last.totalTokens });
    if (
      m.method === "turn/completed" &&
      p.threadId === this.threadId &&
      p.turn?.id === this.turnId
    )
      this.finish(
        p.turn.status === "completed"
          ? "completed"
          : p.turn.status === "interrupted"
            ? "interrupted"
            : "failed",
        p.turn.error?.message,
      );
  }
  finish(state: Run["state"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    this.callbacks.update({ state, ...(error ? { error } : {}) });
    this.kill();
  }
  kill() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Worker stopped"));
    }
    this.pending.clear();
    try {
      if (process.platform !== "win32" && this.child.pid)
        process.kill(-this.child.pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch {}
    const child = this.child;
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, 1500);
    timer.unref();
  }
  stop() {
    if (this.finished) return;
    this.stopped = true;
    if (this.threadId && this.turnId)
      this.send({
        id: ++this.sequence,
        method: "turn/interrupt",
        params: { threadId: this.threadId, turnId: this.turnId },
      });
    this.finish("cancelled");
  }
}
