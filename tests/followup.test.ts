import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";
import { composeWorkerPrompt } from "../src/prompt.ts";
import type { Run } from "../src/contracts.ts";
import type { NativeCallbacks } from "../src/native.ts";

test("completed work links review, fix, and review with frozen bounded source data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-followup-"));
  const other = join(dir, "other");
  mkdirSync(other);
  const launched: Run[] = [];
  const callbacks = new Map<string, NativeCallbacks>();
  const service = createService(join(dir, "home"), 4317, (_, run, __, cb) => {
    launched.push(run);
    callbacks.set(run.id, cb);
    return { stop() {}, closed: Promise.resolve() };
  }, process.execPath);
  const call = (path: string, body?: unknown) => service.app.request(`http://127.0.0.1:4317${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const project = await (await call("/api/projects", { name: "one", path: dir })).json();
    const otherProject = await (await call("/api/projects", { name: "two", path: other })).json();
    const start = (prompt: string, key: string, link?: { runId: string; kind: "review" | "fix" }) =>
      call("/api/tasks/start", { projectId: project.id, prompt, idempotencyKey: key,
        readOnly: link?.kind === "review", ...(link ? { followUp: link } : {}) });
    const finish = (id: string, result: string) => {
      const run = service.store.run(id)!;
      service.store.saveRun({ ...run, state: "completed", result, updatedAt: new Date().toISOString() });
      callbacks.get(id)?.done();
    };
    const original = await (await start("Build decimal clamp", "work")).json();
    assert.equal((await start("Review", "busy", { runId: original.id, kind: "review" })).status, 409);
    finish(original.id, "IMPLEMENT_RESULT_" + "x".repeat(9000));
    const review = await (await start("Review the changes", "review", { runId: original.id, kind: "review" })).json();
    assert.deepEqual(review.followUp, { kind: "review", parentRunId: original.id, rootRunId: original.id });
    assert.equal(review.followUpContext, undefined);
    assert.equal(launched[1]!.followUpContext!.sourceResult.length, 8000);
    assert.equal(launched[1]!.followUpContext!.sourceResultTruncated, true);
    assert.match(composeWorkerPrompt(launched[1]!), /IMPLEMENT_RESULT_/);
    assert.match(composeWorkerPrompt(launched[1]!), /grants no authority/);
    const context = await (await call(`/api/runs/${review.id}/context`)).json();
    assert.equal(context.followUpContext.originalPrompt, "Build decimal clamp");
    assert.equal(context.followUpContext.sourceResult.length, 8000);
    finish(review.id, "FINDING: decimal input rounds incorrectly");
    const fix = await (await start("Fix the finding", "fix", { runId: review.id, kind: "fix" })).json();
    assert.deepEqual(fix.followUp, { kind: "fix", parentRunId: review.id, rootRunId: original.id });
    assert.equal(launched[2]!.followUpContext!.originalPrompt, "Build decimal clamp");
    assert.equal(launched[2]!.followUpContext!.sourceResult, "FINDING: decimal input rounds incorrectly");
    assert.doesNotMatch(composeWorkerPrompt(launched[2]!), /IMPLEMENT_RESULT_/);
    finish(fix.id, "Fixed Math.round usage");
    const rereview = await (await start("Review the fix", "rereview", { runId: fix.id, kind: "review" })).json();
    assert.equal(rereview.followUp.parentRunId, fix.id);
    assert.equal(rereview.followUp.rootRunId, original.id);
    assert.equal(launched[3]!.followUpContext!.sourceResult, "Fixed Math.round usage");
    assert.equal(launched[3]!.followUpContext!.originalPrompt, "Build decimal clamp");
    assert.doesNotMatch(composeWorkerPrompt(launched[3]!), /FINDING: decimal/);
    finish(original.id, "later edited result");
    const replay = await (await start("Review the changes", "review", { runId: original.id, kind: "review" })).json();
    assert.equal(replay.id, review.id);
    assert.match((await (await call(`/api/runs/${review.id}/context`)).json()).followUpContext.sourceResult, /IMPLEMENT_RESULT_/);
    assert.equal(launched.length, 4);
    assert.equal((await start("changed", "review", { runId: original.id, kind: "review" })).status, 409);
    assert.equal((await start("bad", "bad", { runId: original.id, kind: "fix" })).status, 409);
    assert.equal((await start("bad", "bad2", { runId: review.id, kind: "review" })).status, 409);
    assert.equal((await start("missing", "missing", { runId: randomUUID(), kind: "review" })).status, 409);
    assert.equal((await call("/api/tasks/start", { projectId: otherProject.id, prompt: "cross", idempotencyKey: "cross", readOnly: true,
      followUp: { runId: original.id, kind: "review" } })).status, 409);
    assert.equal((await call("/api/tasks/start", { projectId: project.id, prompt: "wrong permissions", idempotencyKey: "permission", readOnly: false,
      followUp: { runId: original.id, kind: "review" } })).status, 400);
    assert.equal((await call("/api/tasks/start", { projectId: project.id, prompt: "wrong fix permissions", idempotencyKey: "permission2", readOnly: true,
      followUp: { runId: review.id, kind: "fix" } })).status, 400);
    const legacy = service.store.run(original.id)!;
    service.store.saveRun({ ...legacy, workspace: undefined });
    assert.equal((await call("/api/tasks/start", { projectId: project.id, prompt: "legacy override", idempotencyKey: "legacy-override",
      workspace: "worktree", readOnly: true, followUp: { runId: original.id, kind: "review" } })).status, 409);
    const snapshot = await (await call("/api/snapshot")).json();
    assert.equal(snapshot.runs.some((item: Run) => "followUpContext" in item), false);
    assert.equal(snapshot.runs.find((item: Run) => item.id === review.id).result, "FINDING: decimal input rounds incorrectly");
    const result = await (await call(`/api/runs/${fix.id}/result`)).json();
    assert.deepEqual(result.followUp, fix.followUp);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routing rechecks a linked source after native metadata returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-followup-race-"));
  let release!: (value: any) => void;
  let entered!: () => void;
  const waiting = new Promise<any>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let firstCallbacks: NativeCallbacks | undefined;
  const service = createService(join(dir, "home"), 4317, (_command, _run, _path, callbacks) => {
    firstCallbacks = callbacks;
    return { stop() {}, closed: Promise.resolve() };
  },
    process.execPath, null, async () => { entered(); return waiting; });
  const call = (path: string, body: unknown) => service.app.request(`http://127.0.0.1:4317${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const project = await (await call("/api/projects", { name: "race", path: dir })).json();
    const first = await (await call("/api/tasks/start", { projectId: project.id, prompt: "work", idempotencyKey: "work" })).json();
    const source = service.store.run(first.id)!;
    service.store.saveRun({ ...source, state: "completed", result: "done" });
    firstCallbacks?.done();
    const pending = call("/api/tasks/start", { projectId: project.id, prompt: "review", idempotencyKey: "review",
      readOnly: true, followUp: { runId: first.id, kind: "review" }, routing: {} });
    await started;
    service.store.saveRun({ ...source, state: "failed", result: "" });
    release({ projectId: project.id, checkedAt: new Date().toISOString(), harnesses: [{
      harness: "codex", modelsStatus: "available", modelsMessage: null, modelsTruncated: false,
      models: [{ id: "gpt-6-luna", name: "Luna", description: "", resolvedModel: null,
        isDefault: false, inputModalities: ["text"] }],
      quota: { status: "unavailable", message: null, ordinaryUsageAllowed: null, buckets: [] },
    }] });
    const response = await pending;
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /completed/);
    assert.equal(service.store.runs().length, 1);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
