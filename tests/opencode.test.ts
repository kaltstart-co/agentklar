import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeWorker, openCodeApproval, openCodeDbPath, openCodeModels, readOpenCodeCatalog, type OpenCodeConnect } from "../src/opencode.ts";
import { createService, processGroupAlive } from "../src/service.ts";
import type { Approval, Run } from "../src/contracts.ts";
import { captureOpenCodeScope } from "../src/opencode-scope.ts";
import { satisfiesRequiredTools } from "../src/capabilities.ts";

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await pause(); } assert.fail("timed out"); }
const models = { connected: ["opencode"], default: { opencode: "mimo-free" }, all: [
  { id: "opencode", key: "PRIVATE", options: { token: "PRIVATE" }, models: {
    "mimo-free": { id: "mimo-free", name: "MiMo", capabilities: { input: { text: true, image: true }, toolcall: true }, headers: { Authorization: "PRIVATE" } },
    "no-tools": { id: "no-tools", capabilities: { input: { text: true }, toolcall: false } },
  } }, { id: "unconnected", models: { x: { id: "x", capabilities: { input: { text: true }, toolcall: true } } } },
] };
const baseRun = (readOnly = false): Run => ({ id: randomUUID(), projectId: randomUUID(), harness: "opencode", prompt: "fixture task",
  readOnly, state: "running", result: "", tokens: null, createdAt: "now", updatedAt: "now" });

test("OpenCode model tools remain advertised metadata without agent or session coverage", async () => {
  const requests: unknown[] = [];
  const catalog = await readOpenCodeCatalog("fixture", "/tmp/project", new AbortController().signal, async () => ({
    client: { provider: { list: async () => ({ data: models }) }, tool: { list: async (request: unknown) => { requests.push(request); return { data: [{ id: "websearch", description: "PRIVATE", parameters: { secret: "PRIVATE" } }] }; } } } as any,
    close: async () => {}, exited: new Promise<void>(() => {}),
  }));
  assert.deepEqual(requests, [{ directory: "/tmp/project", provider: "opencode", model: "mimo-free" }]);
  const tools = catalog.models[0].toolEvidence;
  assert.deepEqual(tools?.tools, ["websearch"]); assert.equal(tools?.complete, false);
  assert.equal(satisfiesRequiredTools(tools, "opencode/mimo-free", ["web_search"]), false);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE/);
});

function fake(readOnly = false) {
  let run = baseRun(readOnly);
  let done = 0;
  let closed = 0;
  let started = 0;
  let reply = "";
  let replyResult = true;
  let childrenResult: unknown = [];
  const operations: string[] = [];
  let exit!: () => void;
  const exited = new Promise<void>(resolve => { exit = resolve; });
  let waiter: ((value: unknown) => void) | undefined;
  const queued: unknown[] = [];
  const emit = (value: unknown) => { if (waiter) { const send = waiter; waiter = undefined; send(value); } else queued.push(value); };
  const approvals: { request: Approval; answer: (decision: string) => void }[] = [];
  let messages: unknown[] = [];
  let prompt: () => Promise<unknown> = async () => ({ data: { info: { finish: "stop" } } });
  const sessionID = "ses_fixture";
  const path = "/tmp/agentklar-opencode-fixture";
  const client = {
    global: { health: async () => ({ data: { healthy: true } }) },
    provider: { list: async () => ({ data: models }) },
    event: { subscribe: async () => ({ stream: (async function* () {
      yield { type: "server.connected" };
      while (true) yield queued.length ? queued.shift() : await new Promise(resolve => { waiter = resolve; });
    })() }) },
    session: {
      create: async () => { started++; return { data: { id: sessionID, directory: path } }; },
      prompt: async () => prompt(),
      messages: async () => ({ data: messages }),
      children: async () => ({ data: childrenResult }),
      abort: async () => { operations.push("abort"); return { data: true }; },
    },
    permission: { reply: async ({ reply: decision }: { reply: string }) => { reply = decision; return { data: replyResult }; } },
  };
  const callbacks = {
    update: (patch: Partial<Run>) => { run = { ...run, ...patch }; },
    event: () => {},
    approval: (request: Approval, answer: (decision: string) => void) => approvals.push({ request, answer }),
    done: () => { done++; },
  };
  const connect: OpenCodeConnect = async (_command, _path, spawned) => {
    spawned(undefined, async () => { closed++; operations.push("close"); });
    return { client: client as any, close: async () => { closed++; operations.push("close"); }, exited };
  };
  const worker = (scope?: Run["openCodeScope"], dbPath?: ConstructorParameters<typeof OpenCodeWorker>[6]) => {
    if (scope) run = { ...run, openCodeScope: scope };
    return new OpenCodeWorker("fixture", run, path, callbacks, connect, {}, dbPath);
  };
  const final = (finish: string, tokens = 10) => ({ info: { id: "msg_fixture", sessionID, role: "assistant", time: { completed: Date.now() }, finish,
    providerID: "opencode", modelID: "mimo-free", tokens: { total: tokens } }, parts: [{ type: "text", text: "Done" }] });
  return { worker, emit, setPrompt: (fn: typeof prompt) => { prompt = fn; }, setMessages: (items: unknown[]) => { messages = items; },
    setReplyResult: (value: boolean) => { replyResult = value; },
    setChildrenResult: (value: unknown) => { childrenResult = value; },
    final, approvals, exit, run: () => run, done: () => done, closed: () => closed, started: () => started, reply: () => reply,
    operations, sessionID, path };
}

test("OpenCode catalog keeps only connected text-and-tool models and no provider secrets", async () => {
  assert.deepEqual(openCodeModels(models).map(item => item.id), ["opencode/mimo-free"]);
  assert.equal(JSON.stringify(openCodeModels(models)).includes("PRIVATE"), false);
  const f = fake();
  const catalog = await readOpenCodeCatalog("fixture", f.path, new AbortController().signal,
    async (_command, _path, spawned) => { spawned(undefined, async () => {}); return {
      client: { provider: { list: async () => ({ data: models }) } } as any, close: async () => {}, exited: new Promise<void>(() => {}),
    }; });
  assert.equal(catalog.modelsStatus, "available");
  assert.deepEqual(catalog.connectedProviderIds, ["opencode"]);
  assert.equal(catalog.models[0].isDefault, false);
  assert.equal(JSON.stringify(catalog).includes("PRIVATE"), false);
});

test("OpenCode connected provider metadata ignores unknown and malformed IDs", async () => {
  const value = { ...models, connected: ["opencode", "opencode", "unknown", "bad\nvalue", { secret: "PRIVATE" }] };
  const catalog = await readOpenCodeCatalog("fixture", "/tmp/project", new AbortController().signal, async () => ({
    client: { provider: { list: async () => ({ data: value }) } } as any,
    close: async () => {}, exited: new Promise<void>(() => {}),
  }));
  assert.deepEqual(catalog.connectedProviderIds, ["opencode"]);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE|bad\\nvalue/);
});

test("OpenCode database metadata read is bounded and keeps raw native output out of records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-opencode-db-path-"));
  try {
    const cli = join(dir, "opencode");
    const db = join(dir, "database with trailing space ");
    writeFileSync(cli, "#!/bin/sh\nprintf '%s\\n' \"$FIXTURE_DB\"\n"); chmodSync(cli, 0o700);
    const env = { ...process.env, FIXTURE_DB: db };
    assert.equal(await openCodeDbPath(cli, dir, env, new AbortController().signal), db);
    writeFileSync(cli, "#!/bin/sh\nprintf '\\377'\n");
    assert.equal(await openCodeDbPath(cli, dir, env, new AbortController().signal), null);
    writeFileSync(cli, "#!/bin/sh\nprintf '%05000d' 1\n");
    assert.equal(await openCodeDbPath(cli, dir, env, new AbortController().signal), null);
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal(await openCodeDbPath(cli, dir, env, cancelled.signal), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OpenCode worker saves verified database scope before prompting, but a failed probe does not block work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-opencode-worker-db-"));
  const dataHome = join(dir, "data");
  const db = join(dataHome, "opencode", "sessions.db");
  mkdirSync(join(dataHome, "opencode"), { recursive: true }); writeFileSync(db, "fixture");
  try {
    for (const available of [true, false]) {
      const f = fake(); f.setMessages([f.final("stop")]);
      const scope = captureOpenCodeScope({ HOME: process.env.HOME, XDG_DATA_HOME: dataHome });
      f.setPrompt(async () => {
        assert.equal(f.run().openCodeScope?.dbPath, available ? realpathSync(db) : undefined);
        f.emit({ type: "session.idle", properties: { sessionID: f.sessionID } });
        return { data: { info: { finish: "stop" } } };
      });
      await f.worker(scope, async () => available ? db : null).closed;
      assert.equal(f.run().state, "completed");
      assert.equal(f.run().openCodeScope?.dataDir, available ? realpathSync(join(dataHome, "opencode")) : scope.dataDir);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OpenCode approvals require exact bounded native action evidence", () => {
  const path = "/private/tmp/project/marker.txt";
  const edit = { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["private/tmp/project/marker.txt"],
    metadata: { filepath: path, diff: `Index: ${path}\n@@ -0,0 +1 @@\n+hello` }, tool: { messageID: "msg_1", callID: "call_1" } };
  assert.equal(openCodeApproval(edit, "run")?.kind, "file");
  assert.equal(openCodeApproval({ ...edit, patterns: ["*"] }, "run"), null);
  assert.equal(openCodeApproval({ ...edit, patterns: ["private/tmp/project/marker.txt", "*"] }, "run"), null);
  assert.equal(openCodeApproval({ ...edit, metadata: { ...edit.metadata, diff: "Index: /other\n+hello" } }, "run"), null);
  assert.equal(openCodeApproval({ ...edit, metadata: { ...edit.metadata, filepath: "bad\npath" } }, "run"), null);
  assert.equal(openCodeApproval({ ...edit, tool: undefined }, "run"), null);
  const bash = { ...edit, permission: "bash", metadata: { command: "echo hello" } };
  assert.equal(openCodeApproval(bash, "run")?.details && (openCodeApproval(bash, "run")!.details as any).command, "echo hello");
  assert.equal(openCodeApproval({ ...bash, metadata: {} }, "run"), null);
});

test("OpenCode completes only confirmed root stop, sums complete root steps and ignores unrelated events", async () => {
  const f = fake();
  f.setMessages([f.final("tool-calls", 7), f.final("stop", 11)]);
  f.setPrompt(async () => { f.emit({ type: "session.idle", properties: { sessionID: "unrelated" } });
    f.emit({ type: "permission.asked", properties: { sessionID: "unrelated" } });
    f.emit({ type: "session.idle", properties: { sessionID: f.sessionID } });
    return { data: { info: { finish: "tool-calls" } } }; });
  const worker = f.worker(); await worker.closed;
  assert.equal(f.run().state, "completed");
  assert.equal(f.run().tokens, 18);
  assert.equal(f.run().result, "Done");
  assert.equal(f.approvals.length, 0);
  assert.equal(f.done(), 1);
  assert.equal(f.closed(), 1);
});

test("OpenCode declined native edit stays unfinished and never writes a successful result", async () => {
  const f = fake();
  const path = "/private/tmp/project/marker.txt";
  f.setMessages([f.final("tool-calls")]);
  f.setPrompt(async () => { f.emit({ type: "permission.asked", properties: { id: "per_1", sessionID: f.sessionID,
    permission: "edit", patterns: ["private/tmp/project/marker.txt"],
    metadata: { filepath: path, diff: `Index: ${path}\n+hello` }, tool: { messageID: "msg_1", callID: "call_1" } } });
    await until(() => f.reply() === "reject");
    f.emit({ type: "session.idle", properties: { sessionID: f.sessionID } });
    return { data: { info: { finish: "tool-calls" } } }; });
  const worker = f.worker();
  await until(() => f.approvals.length === 1);
  f.approvals[0].answer("decline");
  await worker.closed;
  assert.equal(f.reply(), "reject");
  assert.equal(f.run().state, "needs_attention");
  assert.equal(f.run().tokens, null);
});

test("OpenCode can recover after a native decline if its later root reply really finishes", async () => {
  const f = fake();
  f.setMessages([f.final("tool-calls"), f.final("stop")]);
  f.setPrompt(async () => { f.emit({ type: "permission.asked", properties: { id: "per_1", sessionID: f.sessionID,
    permission: "bash", patterns: ["echo hello"], metadata: { command: "echo hello" }, tool: { messageID: "msg_1", callID: "call_1" } } });
    await until(() => f.reply() === "reject");
    f.emit({ type: "session.idle", properties: { sessionID: f.sessionID } });
    return { data: { info: { finish: "tool-calls" } } }; });
  const worker = f.worker(); await until(() => f.approvals.length === 1);
  f.approvals[0].answer("decline"); await worker.closed;
  assert.equal(f.run().state, "completed");
});

test("OpenCode does not complete when native child-session metadata is malformed", async () => {
  const f = fake(); f.setChildrenResult({ unexpected: true }); f.setMessages([f.final("stop")]);
  f.setPrompt(async () => { f.emit({ type: "session.idle", properties: { sessionID: f.sessionID } });
    return { data: { info: { finish: "stop" } } }; });
  await f.worker().closed;
  assert.equal(f.run().state, "needs_attention");
  assert.equal(f.run().tokens, null);
});

test("OpenCode stops on owned questions, a reconnected stream and an unconfirmed permission reply", async () => {
  for (const kind of ["question.asked", "question.v2.asked", "permission.v2.asked", "server.connected"]) {
    const f = fake(); f.setPrompt(async () => new Promise(() => {}));
    const worker = f.worker(); await until(() => f.run().threadId === f.sessionID);
    f.emit({ type: kind, properties: { sessionID: f.sessionID } });
    await worker.closed;
    assert.equal(f.run().state, "needs_attention", kind);
  }
  const f = fake(); f.setReplyResult(false); f.setPrompt(async () => new Promise(() => {}));
  const worker = f.worker(); await until(() => f.run().threadId === f.sessionID);
  f.emit({ type: "permission.asked", properties: { id: "per_1", sessionID: f.sessionID,
    permission: "bash", patterns: ["echo hello"], metadata: { command: "echo hello" }, tool: { messageID: "msg_1", callID: "call_1" } } });
  await until(() => f.approvals.length === 1); f.approvals[0].answer("accept");
  await worker.closed;
  assert.equal(f.run().state, "needs_attention");
});

test("OpenCode rejects read-only before native startup and stops on owned child approval or server death", async () => {
  const ro = fake(true); await ro.worker().closed;
  assert.equal(ro.started(), 0); assert.equal(ro.run().state, "needs_attention");
  const child = fake();
  child.setPrompt(async () => new Promise(() => {}));
  const worker = child.worker();
  await until(() => child.run().threadId === child.sessionID);
  child.emit({ type: "session.updated", properties: { info: { id: "ses_child", parentID: child.sessionID } } });
  child.emit({ type: "permission.asked", properties: { id: "per_2", sessionID: "ses_child" } });
  await worker.closed;
  assert.equal(child.run().state, "needs_attention");
  assert.equal(child.approvals.length, 0);
  const death = fake();
  death.setPrompt(async () => new Promise(() => {}));
  const dying = death.worker(); await until(() => death.run().threadId === death.sessionID);
  death.exit(); await dying.closed;
  assert.equal(death.run().state, "failed");
});

test("OpenCode cancellation asks the native session to stop before closing its server", async () => {
  const f = fake(); f.setPrompt(async () => new Promise(() => {}));
  const worker = f.worker(); await until(() => f.run().threadId === f.sessionID);
  worker.stop(); await worker.closed;
  assert.equal(f.run().state, "cancelled");
  assert.deepEqual(f.operations, ["abort", "close"]);
});

test("OpenCode cancellation during database metadata does not start a prompt", async () => {
  const f = fake();
  let prompts = 0;
  f.setPrompt(async () => { prompts++; return { data: f.final("stop") }; });
  const scope = captureOpenCodeScope({ HOME: process.env.HOME });
  const worker = f.worker(scope, async () => new Promise<string | null>(() => {}));
  await until(() => f.run().threadId === f.sessionID);
  worker.stop();
  await worker.closed;
  assert.equal(f.run().state, "cancelled");
  assert.equal(prompts, 0);
});

test("OpenCode API rejects read-only and accepts a manual worker without changing setup adapters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-opencode-api-"));
  const projectPath = join(dir, "project"); mkdirSync(projectPath);
  const starts: Run[] = [];
  const childEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, "native-data");
  const service = createService(join(dir, "state"), 4317,
    (_command, run, _path, callbacks, nativeEnv) => { starts.push(run); childEnvs.push(nativeEnv);
      queueMicrotask(() => { callbacks.update({ state: "completed" }); callbacks.done(); }); return { stop: () => {} }; },
    null, null, undefined, {}, undefined, {}, {}, null, {}, "/bin/true");
  const headers = { authorization: `Bearer ${service.bearer}`, "content-type": "application/json" };
  const call = (path: string, body: unknown) => service.app.request("http://127.0.0.1:4317" + path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const project = await (await call("/api/projects", { name: "fixture", path: projectPath })).json();
    const task = { projectId: project.id, prompt: "test", harness: "opencode", idempotencyKey: randomUUID() };
    assert.equal((await call("/api/tasks/start", { ...task, readOnly: true })).status, 400);
    assert.equal(starts.length, 0);
    const started = await call("/api/tasks/start", { ...task, idempotencyKey: randomUUID() });
    assert.equal(started.status, 202);
    await until(() => starts.length === 1);
    assert.equal(starts[0].harness, "opencode");
    assert.equal(starts[0].openCodeScope?.env.XDG_DATA_HOME, join(dir, "native-data"));
    assert.equal(childEnvs[0]?.XDG_DATA_HOME, starts[0].openCodeScope?.env.XDG_DATA_HOME);
  } finally {
    await service.close();
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode cancellation during native startup closes the owned process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-opencode-startup-"));
  const command = join(dir, "stalled-opencode");
  writeFileSync(command, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  chmodSync(command, 0o755);
  let run = baseRun();
  let done = 0;
  const worker = new OpenCodeWorker(command, run, dir, {
    update: patch => { run = { ...run, ...patch }; }, event: () => {}, approval: () => {}, done: () => { done++; },
  });
  try {
    await until(() => !!run.workerPid);
    const pid = run.workerPid!;
    worker.stop();
    await worker.closed;
    await until(() => !processGroupAlive(pid));
    assert.equal(run.state, "cancelled");
    assert.equal(done, 1);
  } finally { worker.stop(); rmSync(dir, { recursive: true, force: true }); }
});
