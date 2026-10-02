import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Run } from "./contracts.ts";
import type { NativeCallbacks } from "./native.ts";
import { composeWorkerPrompt } from "./prompt.ts";
import { verifyNativeWorktree } from "./workspace.ts";
import { normalizeToolEvidence, readOnlyClaudeToolEvidence } from "./capabilities.ts";

const reads = ["Read", "Glob", "Grep"];
const actions = {
  Bash: z
    .object({
      command: z.string().min(1),
      description: z.string().optional(),
      timeout: z.number().optional(),
      run_in_background: z.literal(false).optional(),
      dangerouslyDisableSandbox: z.literal(false).optional(),
    })
    .strict(),
  Edit: z
    .object({
      file_path: z.string().min(1),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    })
    .strict(),
  Write: z
    .object({ file_path: z.string().min(1), content: z.string() })
    .strict(),
};

// The SDK owns the wire protocol; this class owns only its local process group.
export class ClaudeWorker {
  child?: ChildProcessWithoutNullStreams;
  abort = new AbortController();
  closed: Promise<void>;
  private childClosed?: Promise<void>;
  private finished = false;
  private sessionId?: string;
  private result?: SDKResultMessage;
  private killing = false;
  private escalation?: NodeJS.Timeout;
  private cancelPermissions = new Set<() => void>();

  constructor(
    private command: string,
    private run: Run,
    private path: string,
    private callbacks: NativeCallbacks,
    queryFactory: typeof query = query,
  ) {
    this.closed = this.start(queryFactory);
  }

  private options(): Options {
    const workspace = this.run.workspace;
    const freshWorktree = workspace?.kind === "worktree" && !!workspace.nativeName && !workspace.path;
    return {
      cwd: this.path,
      ...(workspace?.kind === "worktree" ? { projectConfigRoot: workspace.repoRoot } : {}),
      ...(freshWorktree ? { extraArgs: { worktree: workspace.nativeName! }, settings: { worktree: { baseRef: "head" } } } : {}),
      pathToClaudeCodeExecutable: this.command,
      abortController: this.abort,
      ...(this.run.model ? { model: this.run.model } : {}),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      canUseTool: this.permission,
      ...(this.run.readOnly
        ? {
            tools: reads,
            hooks: { PreToolUse: [{ hooks: [this.readOnlyHook] }] },
          }
        : {}),
      // Discard stderr: native diagnostics may include private auth details.
      stderr: () => {},
      spawnClaudeCodeProcess: (options) => {
        if (this.finished) throw new Error("Worker stopped before launch");
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: "pipe",
          detached: process.platform !== "win32",
        });
        this.child = child;
        this.childClosed = new Promise((resolve) =>
          child.once("close", resolve),
        );
        // The SDK may kill its process on abort. Always kill our whole group.
        const directKill = child.kill.bind(child);
        child.kill = (signal = "SIGTERM") => {
          try {
            if (process.platform !== "win32" && child.pid) {
              process.kill(-child.pid, signal);
              return true;
            }
            return directKill(signal);
          } catch {
            return false;
          }
        };
        options.signal.addEventListener("abort", () => this.kill(), {
          once: true,
        });
        child.stderr.on("data", () => {});
        if (child.pid) this.callbacks.update({ workerPid: child.pid });
        return child;
      },
    };
  }

  private readOnlyHook: HookCallback = async (input) => {
    if (
      input.hook_event_name !== "PreToolUse" ||
      reads.includes(input.tool_name)
    )
      return {};
    this.finish(
      "needs_attention",
      "Claude read-only workers can only use Read, Glob and Grep. Continue this task in your native harness if it needs other tools.",
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "AgentKlar read-only tool restriction",
      },
    };
  };

  private permission: CanUseTool = async (name, input, options) => {
    const schema = Object.hasOwn(actions, name)
      ? actions[name as keyof typeof actions]
      : undefined;
    if (this.finished || options.signal.aborted)
      return { behavior: "deny", message: "Worker stopped", interrupt: true };
    if (
      this.run.readOnly ||
      !schema ||
      !schema.safeParse(input).success ||
      options.blockedPath ||
      JSON.stringify(input).length > 32000
    ) {
      this.finish(
        "needs_attention",
        "Unsupported Claude permission request. Continue in your native harness.",
      );
      return {
        behavior: "deny",
        message: "AgentKlar cannot approve this native request",
        interrupt: true,
      };
    }
    this.callbacks.update({ state: "needs_attention" });
    return new Promise((resolve) => {
      const settle = (decision: string) => {
        if (!this.cancelPermissions.delete(cancel)) return;
        options.signal.removeEventListener("abort", cancel);
        if (decision === "cancel") this.stop();
        else if (!this.finished && !this.cancelPermissions.size)
          this.callbacks.update({ state: "running" });
        resolve(
          decision === "accept" && !this.finished
            ? { behavior: "allow", updatedInput: input }
            : {
                behavior: "deny",
                message: "User declined the action",
                ...(decision === "cancel" ? { interrupt: true } : {}),
              },
        );
      };
      const cancel = () => settle("cancel");
      this.cancelPermissions.add(cancel);
      options.signal.addEventListener("abort", cancel, { once: true });
      this.callbacks.approval(
        {
          id: randomUUID(),
          runId: this.run.id,
          kind: name === "Bash" ? "command" : "file",
          title: name === "Bash" ? "Approve command" : "Approve file changes",
          details: { tool: name, cwd: this.path, ...input },
          decisions: ["accept", "decline", "cancel"],
          createdAt: new Date().toISOString(),
        },
        settle,
      );
    });
  };

  private message(m: SDKMessage) {
    if (this.finished) return;
    if ("parent_tool_use_id" in m && m.parent_tool_use_id !== null) return;
    if (this.sessionId && "session_id" in m && m.session_id !== this.sessionId)
      return;
    if (m.type === "system" && m.subtype === "init") {
      const workspace = this.run.workspace;
      if (workspace?.kind === "worktree") {
        if (workspace.path && m.cwd !== workspace.path)
          throw new Error("Claude opened a different worktree than this run owns.");
        if (!workspace.path) {
          const verified = verifyNativeWorktree(workspace, m.cwd);
          this.path = verified.path!;
          this.run.workspace = verified;
          this.callbacks.update({ workspace: verified });
        }
      }
      this.sessionId = m.session_id;
      this.callbacks.update({
        threadId: m.session_id,
        effectiveModel: m.model,
        nativeTools: this.run.readOnly ? readOnlyClaudeToolEvidence(m.model, new Date().toISOString()) : normalizeToolEvidence({ harness: "claude", modelId: m.model, tools: m.tools, source: "native-session", checkedAt: new Date().toISOString(), complete: true }),
      });
    }
    if (m.type === "assistant") {
      for (const content of m.message.content)
        if (content.type === "text")
          this.callbacks.event("output", content.text);
    }
    if (m.type === "result") {
      // A child report or text block is never the root completion signal.
      this.result = m;
      if (!this.sessionId) {
        this.sessionId = m.session_id;
        this.callbacks.update({ threadId: m.session_id });
      }
    }
  }

  private async start(queryFactory: typeof query) {
    try {
      const prompt = composeWorkerPrompt(this.run);
      const stream = queryFactory({ prompt, options: this.options() });
      for await (const message of stream) this.message(message);
      if (!this.finished) {
        const result = this.result;
        if (!result)
          this.finish(
            "failed",
            "Claude worker exited before its root result completed.",
          );
        else {
          // Final query totals include subagents; result.usage is main-loop only.
          const counts = Object.values(result.modelUsage ?? {}).flatMap(
            (usage) => [
              usage?.inputTokens,
              usage?.outputTokens,
              usage?.cacheReadInputTokens,
              usage?.cacheCreationInputTokens,
            ],
          );
          const total = counts.reduce((a, b) => a + b, 0);
          this.callbacks.update({
            tokens:
              counts.length &&
              counts.every((n) => Number.isSafeInteger(n) && n >= 0) &&
              Number.isSafeInteger(total)
                ? total
                : null,
          });
          if (this.run.workspace?.kind === "worktree" && !this.run.workspace.verified) {
            this.finish("failed", "Claude worktree was not verified before the result.");
          } else if (result.subtype === "success" && !result.is_error) {
            this.callbacks.update({
              result: result.result.slice(0, 24000),
              resultTruncated: result.result.length > 24000,
            });
            const unfinished =
              result.permission_denials.length ||
              result.deferred_tool_use ||
              (result.queued_turn_count ?? 0) > 0 ||
              (result.terminal_reason &&
                result.terminal_reason !== "completed");
            this.finish(
              unfinished ? "needs_attention" : "completed",
              unfinished
                ? "Claude left a denied or unfinished native action. Review in your native harness."
                : undefined,
            );
          } else
            this.finish(
              "failed",
              "Claude could not complete the task. Check sign-in, model access and limits in your native Claude Code CLI.",
            );
        }
      }
    } catch (error) {
      if (!this.finished)
        this.finish(
          "failed",
          error instanceof Error && /worktree/i.test(error.message)
            ? "Claude worktree could not be verified. Its folder and changes were kept for inspection."
            : "Claude worker could not run. Check sign-in, model access and limits in your native Claude Code CLI.",
        );
    } finally {
      this.kill();
      await this.childClosed;
      let alive = false;
      try {
        if (this.child?.pid) {
          process.kill(
            process.platform === "win32" ? this.child.pid : -this.child.pid,
            0,
          );
          alive = true;
        }
      } catch {}
      if (!alive) {
        clearTimeout(this.escalation);
        this.callbacks.update({ workerPid: undefined });
      } else
        this.callbacks.event(
          "attention",
          "Owned process group may still be alive. New work is blocked until it exits.",
        );
      this.callbacks.done();
    }
  }

  private finish(state: Run["state"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    this.callbacks.update({ state, ...(error ? { error } : {}) });
    this.abort.abort();
    for (const cancel of this.cancelPermissions) cancel();
    this.kill();
  }

  private kill() {
    const child = this.child;
    if (!child || this.killing) return;
    this.killing = true;
    child.kill("SIGTERM");
    this.escalation = setTimeout(() => child.kill("SIGKILL"), 1500);
    this.escalation.unref();
  }

  stop() {
    this.finish("cancelled");
  }
}
