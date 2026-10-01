import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Options,
  SDKMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeWorker } from "../src/claude.ts";
import { executable } from "../src/harnesses.ts";
import type { Approval, Run } from "../src/contracts.ts";
import { createService, processGroupAlive } from "../src/service.ts";

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause();
  }
  assert.fail("timed out");
}
const init = {
  type: "system",
  subtype: "init",
  session_id: "root",
  model: "native-model",
} as SDKMessage;
const result = {
  type: "result",
  subtype: "success",
  session_id: "root",
  result: "root result",
  is_error: false,
  permission_denials: [],
  usage: {
    input_tokens: 2,
    output_tokens: 3,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 5,
  },
  modelUsage: {
    main: {
      inputTokens: 2,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 5,
    },
    auxiliary: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 6,
      cacheCreationInputTokens: 5,
    },
  },
} as unknown as SDKMessage;
function fixture(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  let current: Run = {
    id: randomUUID(),
    projectId: randomUUID(),
    harness: "claude",
    prompt: "test",
    model: "requested-model",
    readOnly: false,
    state: "running",
    result: "",
    tokens: null,
    createdAt: "now",
    updatedAt: "now",
  };
  const approvals: {
    approval: Approval;
    answer: (decision: string) => void;
  }[] = [];
  const events: string[] = [];
  let options!: Options;
  const factory = ((args: { options: Options }) => {
    options = args.options;
    // Exercise the adapter's real detached child ownership with no model call.
    options.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: tmpdir(),
      env: process.env,
      signal: options.abortController!.signal,
    });
    return script(options);
  }) as unknown as typeof query;
  const start = (readOnly = false) => {
    current.readOnly = readOnly;
    return new ClaudeWorker(
      process.execPath,
      current,
      tmpdir(),
      {
        update: (patch) => {
          current = { ...current, ...patch };
        },
        event: (_, text) => events.push(text),
        approval: (approval, answer) => approvals.push({ approval, answer }),
        done: () => {},
      },
      factory,
    );
  };
  return {
    start,
    approvals,
    events,
    state: () => current,
    options: () => options,
  };
}

test("Claude executable discovery uses PATH files and newest numeric desktop version", () => {
  const home = mkdtempSync(join(tmpdir(), "agentklar-discovery-"));
  try {
    const base = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    const installed = (version: string) => {
      const directory = join(base, version, "claude.app", "Contents", "MacOS");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, "claude");
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o700);
      return path;
    };
    installed("2.1.9");
    const newest = installed("2.1.10");
    installed("not-a-version");
    const invalidPath = join(home, "bad-path");
    mkdirSync(join(invalidPath, "claude"), { recursive: true });
    assert.equal(executable("claude", invalidPath, home), newest);
    assert.equal(executable("claude", "", home), newest);
    const pathDir = join(home, "bin");
    mkdirSync(pathDir);
    writeFileSync(join(pathDir, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(pathDir, "claude"), 0o700);
    assert.equal(executable("claude", pathDir, home), join(pathDir, "claude"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude preserves native settings and waits for root result plus drained stream", async () => {
  let drain!: () => void;
  const gate = new Promise<void>((resolve) => {
    drain = resolve;
  });
  const f = fixture(async function* () {
    yield init;
    yield {
      ...init,
      session_id: "child",
      model: "child-model",
      parent_tool_use_id: "agent",
    } as unknown as SDKMessage;
    yield {
      ...init,
      session_id: "other-root",
      model: "other-model",
    } as unknown as SDKMessage;
    yield {
      type: "assistant",
      session_id: "root",
      parent_tool_use_id: "agent",
      message: { content: [{ type: "text", text: "child result" }] },
    } as SDKMessage;
    yield {
      ...result,
      session_id: "child",
      result: "child result",
    } as SDKMessage;
    yield result;
    await gate;
  });
  const worker = f.start();
  try {
    await wait(() => f.state().threadId === "root");
    await pause(30);
    assert.equal(f.state().state, "running");
    assert.equal(f.state().effectiveModel, "native-model");
    assert.equal(f.state().result, "");
    assert.equal(f.state().tokens, null);
    assert.deepEqual(f.events, []);
    const options = f.options();
    assert.equal(options.pathToClaudeCodeExecutable, process.execPath);
    assert.deepEqual(options.settingSources, ["user", "project", "local"]);
    assert.deepEqual(options.systemPrompt, {
      type: "preset",
      preset: "claude_code",
    });
    assert.equal(options.model, "requested-model");
    assert.equal(options.permissionMode, undefined);
    assert.equal(options.env, undefined);
    assert.equal(options.fallbackModel, undefined);
    drain();
    await worker.closed;
    assert.equal(f.state().state, "completed");
    assert.equal(f.state().result, "root result");
    assert.equal(f.state().tokens, 40);
    assert.equal(f.state().workerPid, undefined);
  } finally {
    drain();
    worker.stop();
    await worker.closed;
  }
});

test("Claude cancellation kills its owned group and never completes from assistant text", async () => {
  const f = fixture(async function* (options) {
    yield init;
    yield {
      type: "assistant",
      session_id: "root",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "I am done" }] },
    } as SDKMessage;
    await new Promise<void>((resolve) =>
      options.abortController!.signal.addEventListener(
        "abort",
        () => resolve(),
        { once: true },
      ),
    );
  });
  const worker = f.start();
  await wait(() => f.events.length > 0);
  const pid = f.state().workerPid!;
  assert.equal(f.state().state, "running");
  assert.ok(processGroupAlive(pid));
  worker.stop();
  await worker.closed;
  assert.equal(f.state().state, "cancelled");
  assert.equal(f.state().tokens, null);
  assert.equal(processGroupAlive(pid), false);
});

test("Claude readOnly hook denies Bash, writes, MCP, skills and agents before native permission rules", async () => {
  const f = fixture(async function* (options) {
    yield init;
    await new Promise<void>((resolve) =>
      options.abortController!.signal.addEventListener(
        "abort",
        () => resolve(),
        { once: true },
      ),
    );
  });
  const worker = f.start(true);
  await wait(() => !!f.state().threadId);
  const options = f.options();
  assert.deepEqual(options.tools, ["Read", "Glob", "Grep"]);
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  for (const tool_name of ["Read", "Glob", "Grep"])
    assert.deepEqual(
      await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input: {},
          tool_use_id: "one",
          session_id: "root",
          transcript_path: "",
          cwd: tmpdir(),
        },
        "one",
        { signal: new AbortController().signal },
      ),
      {},
    );
  for (const tool_name of [
    "Bash",
    "Edit",
    "Write",
    "mcp__server__write",
    "Skill",
    "Agent",
  ])
    assert.equal(
      (
        (await hook(
          {
            hook_event_name: "PreToolUse",
            tool_name,
            tool_input: {},
            tool_use_id: "one",
            session_id: "root",
            transcript_path: "",
            cwd: tmpdir(),
          },
          "one",
          { signal: new AbortController().signal },
        )) as any
      ).hookSpecificOutput.permissionDecision,
      "deny",
    );
  await worker.closed;
  assert.equal(f.state().state, "needs_attention");
  assert.equal(f.approvals.length, 0);
});

test("Claude concrete one-action approvals and unsupported scopes stop safely", async () => {
  for (const [name, input, blockedPath, supported] of [
    ["Bash", { command: "printf ok" }, undefined, true],
    [
      "Edit",
      { file_path: "one.txt", old_string: "old", new_string: "new" },
      undefined,
      true,
    ],
    ["Write", { file_path: "one.txt", content: "new" }, undefined, true],
    [
      "Bash",
      { command: "printf ok", dangerouslyDisableSandbox: true },
      undefined,
      false,
    ],
    [
      "Bash",
      { command: "printf ok", run_in_background: true },
      undefined,
      false,
    ],
    [
      "Write",
      { file_path: "/outside/one.txt", content: "new" },
      "/outside",
      false,
    ],
    ["AskUserQuestion", { questions: [] }, undefined, false],
    ["mcp__server__write", {}, undefined, false],
    ["toString", {}, undefined, false],
  ] as const) {
    let response: any;
    const f = fixture(async function* (options) {
      yield init;
      response = await options.canUseTool!(name, input, {
        signal: options.abortController!.signal,
        toolUseID: "tool",
        requestId: "request",
        ...(blockedPath ? { blockedPath } : {}),
      });
      yield result;
    });
    const worker = f.start();
    if (supported) {
      await wait(() => f.approvals.length === 1);
      assert.equal(f.state().state, "needs_attention");
      assert.deepEqual(f.approvals[0].approval.decisions, [
        "accept",
        "decline",
        "cancel",
      ]);
      assert.deepEqual(f.approvals[0].approval.details, {
        tool: name,
        cwd: tmpdir(),
        ...input,
      });
      f.approvals[0].answer("accept");
    }
    await worker.closed;
    assert.equal(f.state().state, supported ? "completed" : "needs_attention");
    assert.equal(response.behavior, supported ? "allow" : "deny");
    assert.equal(response.updatedPermissions, undefined);
    if (!supported) assert.equal(f.approvals.length, 0);
  }
});

test("Claude failures stay bounded and root denials need attention", async () => {
  for (const mode of ["no-result", "throw", "denied", "large"] as const) {
    const f = fixture(async function* () {
      yield init;
      if (mode === "throw") throw new Error("private native auth payload");
      if (mode === "no-result") return;
      yield {
        ...result,
        result: "x".repeat(30000),
        permission_denials: mode === "denied" ? [{}] : [],
      } as SDKMessage;
    });
    const worker = f.start();
    await worker.closed;
    assert.equal(
      f.state().state,
      mode === "large"
        ? "completed"
        : mode === "denied"
          ? "needs_attention"
          : "failed",
    );
    assert.doesNotMatch(f.state().error || "", /private native auth payload/);
    assert.ok(f.state().result.length <= 24000);
    if (mode === "large") assert.equal(f.state().resultTruncated, true);
  }
});

test("Claude missing or invalid query totals stay unknown without main-loop fallback", async () => {
  for (const modelUsage of [
    undefined,
    {},
    {
      model: {
        inputTokens: 1,
        outputTokens: NaN,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    { model: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0 } },
  ]) {
    const f = fixture(async function* () {
      yield init;
      yield { ...result, modelUsage } as unknown as SDKMessage;
    });
    const worker = f.start();
    await worker.closed;
    assert.equal(f.state().state, "completed");
    assert.equal(f.state().tokens, null);
  }
});

test("service selects harness, binds idempotency and rejects role mismatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-claude-service-"));
  const calls: Run[] = [];
  const service = createService(
    join(dir, "state"),
    4317,
    (_, run, __, callbacks) => {
      calls.push(run);
      queueMicrotask(() => {
        callbacks.update({ state: "completed" });
        callbacks.done();
      });
      return { stop() {}, closed: Promise.resolve() };
    },
    process.execPath,
    process.execPath,
  );
  const call = (path: string, body: unknown, method = "POST") =>
    service.app.request(`http://127.0.0.1:4317${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${service.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const project = await (
      await call("/api/projects", { name: "test", path: dir })
    ).json();
    const data = {
      projectId: project.id,
      prompt: "one",
      harness: "claude",
      idempotencyKey: "one",
    };
    const first = await (await call("/api/tasks/start", data)).json();
    await wait(() => calls.length === 1);
    assert.equal(first.harness, "claude");
    assert.equal(calls[0].harness, "claude");
    assert.equal(
      (await (await call("/api/tasks/start", data)).json()).id,
      first.id,
    );
    assert.equal(
      (await call("/api/tasks/start", { ...data, harness: "codex" })).status,
      409,
    );
    assert.equal(
      (
        await call("/api/tasks/start", {
          ...data,
          idempotencyKey: "bad",
          harness: "gemini",
        })
      ).status,
      400,
    );
    await call(
      `/api/projects/${project.id}`,
      {
        roles: [
          {
            id: "claude",
            name: "Reviewer",
            harness: "claude",
            model: "claude-pin",
            responsibility: "review",
          },
        ],
      },
      "PATCH",
    );
    assert.equal(
      (
        await call("/api/tasks/start", {
          ...data,
          idempotencyKey: "mismatch",
          harness: "codex",
          roleId: "claude",
        })
      ).status,
      400,
    );
    const roleRun = await (
      await call("/api/tasks/start", {
        projectId: project.id,
        prompt: "role",
        roleId: "claude",
        idempotencyKey: "role",
      })
    ).json();
    assert.equal(roleRun.harness, "claude");
    assert.equal(roleRun.model, "claude-pin");
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
