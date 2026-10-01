import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { MuseWorker } from "../src/muse.ts";
import type { Approval, Run } from "../src/contracts.ts";
import { processGroupAlive } from "../src/service.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await pause();
  }
  assert.fail("timed out");
}

function fixture(readOnly = false) {
  let run: Run = {
    id: randomUUID(), projectId: randomUUID(), harness: "muse", prompt: "test",
    readOnly, state: "running", result: "", tokens: null,
    createdAt: "now", updatedAt: "now",
  };
  let resolveTurn!: (value: unknown) => void;
  const completed = new Promise<unknown>((resolve) => { resolveTurn = resolve; });
  let approvalHandler: ((request: unknown) => Promise<unknown>) | undefined;
  const approvals: { value: Approval; answer: (decision: string) => void }[] = [];
  const events: { kind: string; text: string }[] = [];
  let closed = 0;
  let connected = 0;
  let done = 0;
  const turnId = randomUUID();
  const sessionId = randomUUID();
  const session = {
    sessionId,
    opening: { result: { session: { modelId: "echo" } } },
    onApproval: (handler: typeof approvalHandler) => { approvalHandler = handler; },
    onApprovalError: () => {},
    sendUserTurn: async () => ({
      turnId,
      completed,
      async *items() {
        yield { itemId: "child", turnId: randomUUID(), kind: "agentMessage", text: "child text" };
        yield { itemId: "root", turnId, kind: "agentMessage", text: "hello" };
        yield { itemId: "root", turnId, kind: "agentMessage", text: "hello world" };
      },
    }),
    fold: {
      sessionState: { get: () => ({ cumulative: { totalTokens: 12 } }) },
      items: { list: () => [] },
    },
  };
  const callbacks = {
    update: (patch: Partial<Run>) => { run = { ...run, ...patch }; },
    event: (kind: string, text: string) => events.push({ kind, text }),
    approval: (value: Approval, answer: (decision: string) => void) => approvals.push({ value, answer }),
    done: () => { done++; },
  };
  const connect = async () => {
    connected++;
    return { client: { startSession: async () => session } as any,
      close: async () => { closed++; }, home: "/tmp/muse-home" };
  };
  const start = () => new MuseWorker("muse", run, tmpdir(), callbacks, connect);
  const finish = () => resolveTurn({ kind: "completed", params: { terminal: "completed" } });
  return { start, finish, sessionId, turnId, approvals, events,
    approval: (request: unknown) => approvalHandler!(request),
    run: () => run, closed: () => closed, connected: () => connected, done: () => done,
    session };
}

test("Muse uses root turn completion and reports only root output", async () => {
  const f = fixture();
  const worker = f.start();
  await until(() => f.run().turnId === f.turnId);
  assert.equal(f.run().threadId, f.sessionId);
  assert.equal(f.run().effectiveModel, "echo");
  assert.equal(f.run().nativeHome, "/tmp/muse-home");
  assert.equal(f.run().state, "running");
  assert.deepEqual(f.events.map((event) => event.text), ["hello", " world"]);
  f.finish();
  await worker.closed;
  assert.equal(f.run().state, "completed");
  assert.equal(f.run().result, "hello world");
  assert.equal(f.run().tokens, 12);
  assert.equal(f.closed(), 1);
  assert.equal(f.done(), 1);
});

test("Muse accepts only a concrete native once approval", async () => {
  const f = fixture();
  const worker = f.start();
  await until(() => f.run().turnId === f.turnId);
  const answer = f.approval({
    approvalId: randomUUID(), rawArgs: "{}", toolName: "shell", subject: { kind: "shell", command: "pwd" },
    availableChoices: [
      { choiceId: "persist", scope: "localPersistent", decision: "approved" },
      { choiceId: "once", scope: "once", decision: "approved" },
      { choiceId: "deny", scope: "once", decision: "denied" },
    ],
  });
  await until(() => f.approvals.length === 1);
  assert.equal(f.run().state, "needs_attention");
  assert.deepEqual(f.approvals[0].value.decisions, ["accept", "decline", "cancel"]);
  f.approvals[0].answer("accept");
  assert.deepEqual(await answer, { choiceId: "once" });
  assert.equal(f.run().state, "running");
  f.finish();
  await worker.closed;
  assert.equal(f.run().state, "completed");
});

test("Muse refuses broad approvals and read-only runs", async () => {
  const readOnly = fixture(true);
  const readWorker = readOnly.start();
  await readWorker.closed;
  assert.equal(readOnly.run().state, "needs_attention");
  assert.equal(readOnly.connected(), 0);

  const f = fixture();
  const worker = f.start();
  await until(() => f.run().turnId === f.turnId);
  assert.throws(() => f.approval({
    approvalId: randomUUID(), rawArgs: "{}", toolName: "shell", subject: { kind: "shell", command: "pwd" },
    availableChoices: [{ choiceId: "persist", scope: "localPersistent", decision: "approved" }],
  }));
  await worker.closed;
  assert.equal(f.run().state, "needs_attention");
  assert.equal(f.approvals.length, 0);
  assert.equal(f.closed(), 1);
});

test("Muse cancellation remains cancelled after a late root terminal", async () => {
  const f = fixture();
  const worker = f.start();
  await until(() => f.run().turnId === f.turnId);
  worker.stop();
  f.finish();
  await worker.closed;
  assert.equal(f.run().state, "cancelled");
  assert.equal(f.run().tokens, null);
});

test("Muse leaves usage unknown when a child ran", async () => {
  const f = fixture();
  (f.session.fold.items as any).list = () => [{ kind: "subagent" }];
  const worker = f.start();
  await until(() => f.run().turnId === f.turnId);
  f.finish();
  await worker.closed;
  assert.equal(f.run().tokens, null);
});

test("Muse reports the model used by the root turn when it differs from session start", async () => {
  const f = fixture();
  (f.session.fold.sessionState as any).get = (family: string) =>
    family === "session/tokenUsage"
      ? { turnId: f.turnId, modelId: "actual-model", cumulative: { totalTokens: 12 } }
      : undefined;
  const worker = f.start();
  await until(() => f.run().turnId === f.turnId);
  assert.equal(f.run().effectiveModel, "echo");
  f.finish();
  await worker.closed;
  assert.equal(f.run().effectiveModel, "actual-model");
});

test("Muse speaks MSP through the SDK and completes from a real wire terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-muse-wire-"));
  const command = join(dir, "fixture.mjs");
  writeFileSync(command, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
const fingerprint = ${JSON.stringify(EXPECTED_SCHEMA_FINGERPRINT)};
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") send({ id: frame.id, result: {
    schema: { fingerprint }, museHome: ${JSON.stringify(dir)}, sessionDurability: "ephemeral"
  } });
  if (frame.method === "session/start") send({ id: frame.id, result: {
    session: { sessionId: "fixture-session", modelId: "echo" }, viewCursor: "v:0"
  } });
  if (frame.method === "turn/start") {
    const turnId = frame.params.commandId;
    send({ id: frame.id, result: { commandId: turnId, status: "accepted",
      disposition: "started", startedNewTurn: true, turnId } });
    setTimeout(() => {
      const sourceRange = { stream: { kind: "session", id: "fixture-session" }, first: {}, last: {} };
      send({ method: "item/completed", params: { sessionId: "fixture-session", viewCursor: "v:1",
        sourceRange, item: { itemId: "answer", kind: "agentMessage", status: "completed",
          revision: 1, turnId, text: "wire result" } } });
      send({ method: "session/tokenUsage", params: { sessionId: "fixture-session", turnId,
        viewCursor: "v:2", sourceRange, cumulative: { totalTokens: 7, promptTokens: 5, outputTokens: 2 },
        promptTokens: 5, totalTokens: 7, usage: { inputTokens: 5, outputTokens: 2,
          cachedTokens: 0, reasoningTokens: 0 } } });
      send({ method: "turn/completed", params: { sessionId: "fixture-session", turnId,
        viewCursor: "v:3", sourceRange, terminal: "completed" } });
    }, 10);
  }
});
`, { mode: 0o700 });
  chmodSync(command, 0o700);
  let run: Run = { id: randomUUID(), projectId: randomUUID(), harness: "muse", prompt: "fixture",
    readOnly: false, state: "running", result: "", tokens: null, createdAt: "now", updatedAt: "now" };
  const events: string[] = [];
  try {
    const worker = new MuseWorker(command, run, dir, {
      update: (patch) => { run = { ...run, ...patch }; },
      event: (_, text) => events.push(text),
      approval: () => assert.fail("unexpected approval"),
      done: () => {},
    });
    await worker.closed;
    assert.equal(run.state, "completed");
    assert.equal(run.result, "wire result");
    assert.equal(run.tokens, 7);
    assert.equal(run.threadId, "fixture-session");
    assert.equal(run.workerPid, undefined);
    assert.deepEqual(events, ["wire result"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Muse stop during a stalled handshake kills its owned process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-muse-stall-"));
  const command = join(dir, "stall.mjs");
  writeFileSync(command, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
  chmodSync(command, 0o700);
  let run: Run = { id: randomUUID(), projectId: randomUUID(), harness: "muse", prompt: "stall",
    readOnly: false, state: "running", result: "", tokens: null, createdAt: "now", updatedAt: "now" };
  try {
    const worker = new MuseWorker(command, run, dir, {
      update: (patch) => { run = { ...run, ...patch }; },
      event: () => {}, approval: () => assert.fail("unexpected approval"), done: () => {},
    });
    await until(() => !!run.workerPid);
    const pid = run.workerPid!;
    assert.ok(processGroupAlive(pid));
    worker.stop();
    await worker.closed;
    assert.equal(run.state, "cancelled");
    assert.equal(processGroupAlive(pid), false);
    assert.equal(run.workerPid, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
