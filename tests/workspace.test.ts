import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { runHandoff } from "../src/handoff.ts";
import type { Run } from "../src/contracts.ts";
import type { NativeCallbacks } from "../src/native.ts";
import { ClaudeWorker } from "../src/claude.ts";
import { gitBase } from "../src/workspace.ts";
import type { Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for worker launch");
};

test("two workspaces run at once; review and fix keep their original worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-workspace-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "AgentKlar Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "local-only.txt"), "unsaved");
  const callbacks = new Map<string, NativeCallbacks>();
  const paths = new Map<string, string>();
  const service = createService(join(dir, "home"), 4317, (_cmd, run, path, cb) => {
    callbacks.set(run.id, cb);
    paths.set(run.id, path);
    return { stop: () => cb.done(), closed: Promise.resolve() };
  }, process.execPath);
  const call = (path: string, body?: unknown) => service.app.request(`http://127.0.0.1:4317${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const start = (projectId: string, prompt: string, workspace?: "project" | "worktree", followUp?: { runId: string; kind: "review" | "fix" }) =>
    call("/api/tasks/start", { projectId, prompt, idempotencyKey: prompt,
      ...(workspace ? { workspace } : {}), readOnly: followUp?.kind === "review", ...(followUp ? { followUp } : {}) });
  const finish = (id: string, result: string) => {
    const run = service.store.run(id)!;
    service.store.saveRun({ ...run, state: "completed", result, threadId: randomUUID() });
    callbacks.get(id)?.done();
  };
  try {
    const project = await (await call("/api/projects", { name: "repo", path: repo })).json();
    const first = await (await start(project.id, "build", "worktree")).json() as Run;
    assert.equal(first.workspace?.kind, "worktree");
    const tree = first.workspace!.path!;
    await wait(() => paths.has(first.id) || service.store.run(first.id)?.state === "failed");
    assert.equal(service.store.run(first.id)?.state, "running", service.store.run(first.id)?.error);
    assert.equal(paths.get(first.id), tree);
    assert.equal(git(tree, "rev-parse", "HEAD"), base);
    assert.equal(existsSync(join(tree, "local-only.txt")), false);
    const registeredTree = await (await call("/api/projects", { name: "same tree", path: tree })).json();
    assert.equal((await start(registeredTree.id, "cross-project collision", "project")).status, 409);
    const second = await (await start(project.id, "other", "project")).json() as Run;
    await wait(() => paths.has(second.id));
    assert.equal(paths.get(second.id), project.path);
    mkdirSync(join(repo, "nested"));
    const nested = await (await call("/api/projects", { name: "nested", path: join(repo, "nested") })).json();
    assert.equal((await start(nested.id, "nested collision", "project")).status, 409);
    assert.equal((await start(project.id, "third", "worktree")).status, 409);
    assert.equal((await start(project.id, "same main", "project")).status, 409);
    finish(first.id, "changed tree");
    writeFileSync(join(tree, "tracked.txt"), "worktree edit");
    const review = await (await start(project.id, "review", undefined, { runId: first.id, kind: "review" })).json() as Run;
    await wait(() => paths.has(review.id));
    assert.equal(paths.get(review.id), tree);
    assert.deepEqual(review.workspace, service.store.run(first.id)?.workspace);
    assert.equal((await start(project.id, "wrong workspace", "project", { runId: first.id, kind: "review" })).status, 409);
    finish(review.id, "fix tracked file");
    const fix = await (await start(project.id, "fix", undefined, { runId: review.id, kind: "fix" })).json() as Run;
    await wait(() => paths.has(fix.id));
    assert.equal(paths.get(fix.id), tree);
    finish(fix.id, "fixed");
    assert.equal(existsSync(tree), true);
    assert.equal(git(tree, "status", "--porcelain").includes("tracked.txt"), true);
    const handoff = runHandoff(service.store.run(fix.id)!, project, false, process.execPath);
    assert.equal(handoff.available, true, handoff.reason || undefined);
    assert.equal(handoff.command?.cwd, tree);
    assert.equal(handoff.command?.argv.includes(tree), true);
    const result = await (await call(`/api/runs/${fix.id}/result`)).json();
    assert.equal(result.workspace.path, tree);
    assert.equal(result.workspace.branch, fix.workspace?.kind === "worktree" ? fix.workspace.branch : undefined);
    git(tree, "checkout", "-qb", "other-branch");
    assert.equal(runHandoff(service.store.run(fix.id)!, project, false, process.execPath).available, false);
    assert.equal((await start(project.id, "changed branch review", undefined, { runId: fix.id, kind: "review" })).status, 409);
    git(tree, "checkout", "-q", result.workspace.branch);
    git(tree, "add", "tracked.txt");
    git(tree, "commit", "-qm", "keep worktree edit");
    assert.equal(runHandoff(service.store.run(fix.id)!, project, false, process.execPath).available, true);
    const rereview = await (await start(project.id, "new commit review", undefined, { runId: fix.id, kind: "review" })).json() as Run;
    await wait(() => paths.has(rereview.id));
    assert.equal(paths.get(rereview.id), tree);
    finish(rereview.id, "still okay");
    git(repo, "worktree", "remove", "--force", tree);
    git(repo, "worktree", "add", "-q", tree, result.workspace.branch);
    const replaced = runHandoff(service.store.run(fix.id)!, project, false, process.execPath);
    assert.equal(replaced.available, false);
    assert.equal((await start(project.id, "replaced tree review", undefined, { runId: fix.id, kind: "review" })).status, 409);
    finish(second.id, "done");
    git(repo, "checkout", "--detach", "-q", "HEAD");
    const detached = await (await start(project.id, "detached base", "worktree")).json() as Run;
    await wait(() => paths.has(detached.id) || service.store.run(detached.id)?.state === "failed");
    assert.equal(service.store.run(detached.id)?.state, "running", service.store.run(detached.id)?.error);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude verifies its native worktree before accepting a result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-claude-tree-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "AgentKlar Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "base");
  const base = gitBase(realpathSync(repo));
  const id = randomUUID();
  const tree = join(base.repoRoot, ".claude", "worktrees", id);
  mkdirSync(join(base.repoRoot, ".claude", "worktrees"), { recursive: true });
  git(repo, "worktree", "add", "-qb", `worktree-${id}`, tree, "HEAD");
  const makeRun = (): Run => ({ id, projectId: randomUUID(), harness: "claude", prompt: "test",
    readOnly: false, state: "running", result: "", tokens: null, createdAt: "now", updatedAt: "now",
    workspace: { kind: "worktree", ...base, rootRunId: id, nativeName: id, plannedPath: tree } });
  const runCase = async (initCwd: string) => {
    let run = makeRun();
    let options!: Options;
    const fakeQuery = ((args: { options: Options }) => {
      options = args.options;
      return (async function* () {
        yield { type: "system", subtype: "init", cwd: initCwd, session_id: randomUUID(), model: "native" } as SDKMessage;
        yield { type: "result", subtype: "success", session_id: run.threadId || "none", result: "ok",
          is_error: false, permission_denials: [], modelUsage: {} } as unknown as SDKMessage;
      })();
    }) as unknown as typeof query;
    const callbacks: NativeCallbacks = { update: (patch) => { run = { ...run, ...patch }; },
      event: () => {}, approval: () => {}, done: () => {} };
    const worker = new ClaudeWorker(process.execPath, run, base.repoRoot, callbacks, fakeQuery);
    await worker.closed;
    return { run, options };
  };
  try {
    const wrong = await runCase(base.repoRoot);
    assert.equal(wrong.run.state, "failed");
    assert.equal(wrong.run.workspace?.kind === "worktree" && wrong.run.workspace.verified, undefined);
    const right = await runCase(tree);
    assert.equal(right.options.extraArgs?.worktree, id);
    assert.equal(right.options.projectConfigRoot, base.repoRoot);
    assert.equal(right.run.state, "completed");
    assert.equal(right.run.workspace?.path, tree);
    assert.equal(right.run.workspace?.kind === "worktree" && right.run.workspace.verified, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stopping during Git preparation keeps a durable record and starts no worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-cancel-tree-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "AgentKlar Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "base");
  const hook = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nsleep 2\n");
  chmodSync(hook, 0o700);
  const home = join(dir, "home");
  let launched = 0;
  const service = createService(home, 4317, () => { launched++; return { stop() {}, closed: Promise.resolve() }; }, process.execPath);
  const call = (path: string, body: unknown) => service.app.request(`http://127.0.0.1:4317${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const project = await (await call("/api/projects", { name: "repo", path: repo })).json();
    const response = await call("/api/tasks/start", { projectId: project.id, prompt: "cancel me",
      idempotencyKey: "cancel me", workspace: "worktree" });
    assert.equal(response.status, 202);
    const run = await response.json() as Run;
    assert.equal(run.workspace?.kind, "worktree");
    assert.equal(run.workspace?.verified, false);
    await call(`/api/runs/${run.id}/stop`, {});
    await service.close();
    assert.equal(launched, 0);
    const restored = new Store(home);
    try {
      const stored = restored.run(run.id);
      assert.equal(stored?.state, "cancelled");
      assert.equal(stored?.workspace?.path, run.workspace?.path);
      assert.equal(stored?.workspace?.kind === "worktree" ? stored.workspace.branch : undefined,
        run.workspace?.kind === "worktree" ? run.workspace.branch : undefined);
    } finally { restored.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
