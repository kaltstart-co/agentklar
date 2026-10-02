import { requestedTaskBody } from "./requested-task.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "../src/store.ts";
import { createService } from "../src/service.ts";
import type { NativeCallbacks } from "../src/native.ts";
import { Changes, changePacketSchema, type ChangePacket } from "../src/changes.ts";
import { gitBase, plannedWorktree, createWorktree } from "../src/workspace.ts";
import type { Project, Run } from "../src/contracts.ts";
const git = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-changes-"))), source = join(dir, "source"), recipient = join(dir, "recipient"); mkdirSync(source);
  git(source, "init"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
  mkdirSync(join(source, "src")); writeFileSync(join(source, "src/main.ts"), "export const answer = 1;\n"); writeFileSync(join(source, "src/staged.ts"), "export const stage = 1;\n"); writeFileSync(join(source, ".gitignore"), "ignored/\n");
  git(source, "add", "."); git(source, "commit", "-m", "base"); execFileSync("git", ["clone", source, recipient], { stdio: "ignore" });
  const ownerStore = new Store(join(dir, "owner")), store = new Store(join(dir, "receiver"));
  const project = (path: string): Project => ({ id: randomUUID(), name: "Fixture", path, preference: "balanced", roles: [], createdAt: new Date().toISOString() });
  const ownerProject = project(source), target = project(recipient); ownerStore.saveProject(ownerProject); store.saveProject(target);
  const id = randomUUID(), workspace = await createWorktree(plannedWorktree({ kind: "worktree", ...gitBase(source), rootRunId: id }, join(dir, "owner")), new AbortController().signal, () => {});
  const run: Run = { id, projectId: ownerProject.id, prompt: "Implement developer files", state: "completed", result: "Worker finished", readOnly: false, tokens: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspace };
  return { dir, source, recipient, ownerStore, store, ownerProject, target, run, path: workspace.path!, owner: new Changes(ownerStore, join(dir, "owner")), changes: new Changes(store, join(dir, "receiver")), device: randomUUID(), close() { ownerStore.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function redigest(packet: ChangePacket, patch: string): ChangePacket {
  const { digest, ...original } = packet;
  const body = changePacketSchema.omit({ digest: true }).parse({ ...original, patch });
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

test("handoff combines committed, staged, unstaged and untracked developer files without changing owner index", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.path, "src/main.ts"), "export const answer = 42;\n"); writeFileSync(join(f.path, "src/committed.ts"), "export const committed = true;\n");
    git(f.path, "add", "."); git(f.path, "commit", "-m", "worker implementation");
    writeFileSync(join(f.path, "src/staged.ts"), "export const stage = 2;\n"); git(f.path, "add", "src/staged.ts");
    writeFileSync(join(f.path, "src/staged.ts"), "export const stage = 3;\n"); writeFileSync(join(f.path, "src/NewView.tsx"), 'export function NewView() { return <main>Hello</main>; }\n');
    mkdirSync(join(f.path, "ignored")); writeFileSync(join(f.path, "ignored/private.bin"), Buffer.from([0,1,2]));
    const beforeStatus = git(f.path, "status", "--porcelain=v1"), beforeIndex = git(f.path, "write-tree");
    const packet = f.owner.export(f.run, f.ownerProject, f.device, false);
    assert.deepEqual(packet.files.map(file => file.path), ["src/NewView.tsx", "src/committed.ts", "src/main.ts", "src/staged.ts"]);
    assert.ok(packet.ignoredPaths.includes("ignored/")); assert.equal(git(f.path, "status", "--porcelain=v1"), beforeStatus); assert.equal(git(f.path, "write-tree"), beforeIndex);
    const preview = f.changes.prepare(f.target.id, packet);
    const freshPacket = f.owner.export(f.run, f.ownerProject, f.device, false);
    assert.equal(f.changes.prepare(f.target.id, freshPacket).id, preview.id);
    // The lead can advance and edit its own checkout while the packet stays frozen.
    git(f.recipient, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "lead advance");
    writeFileSync(join(f.recipient, "src/main.ts"), "lead unsaved work\n");
    const result = await f.changes.apply(preview.id, packet.digest, packet.baseCommit);
    assert.equal(result.workspace.baseCommit, packet.baseCommit);
    assert.equal(readFileSync(join(result.workspace.path!, "src/staged.ts"), "utf8"), "export const stage = 3;\n");
    assert.match(readFileSync(join(result.workspace.path!, "src/NewView.tsx"), "utf8"), /Hello/);
    assert.equal(readFileSync(join(f.recipient, "src/main.ts"), "utf8"), "lead unsaved work\n");
    assert.equal(git(f.path, "write-tree"), beforeIndex);
    // A lost response never causes a second application/worktree.
    assert.deepEqual(await f.changes.apply(preview.id, packet.digest, packet.baseCommit), result);
    const reloaded = new Changes(f.store, join(f.dir, "receiver"));
    assert.deepEqual(await reloaded.apply(preview.id, packet.digest, packet.baseCommit), result);
    assert.equal(reloaded.forSource(f.device, f.run.id)[0].applied?.workspace.path, result.workspace.path);
    assert.match(git(result.workspace.path!, "status", "--porcelain=v1"), /A  src\/NewView/);
  } finally { f.close(); }
});

test("patch digest/base and malicious paths fail before any recipient worktree is created", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.path, "src/main.ts"), "export const answer = 2;\n");
    const packet = f.owner.export(f.run, f.ownerProject, f.device, false), before = git(f.recipient, "worktree", "list", "--porcelain");
    assert.throws(() => f.changes.prepare(f.target.id, { ...packet, patch: packet.patch + "changed" }), /digest/);
    for (const path of ["../outside.txt", ".git/config", "/outside.txt"]) {
      const malicious = redigest(packet, `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+unsafe\n`);
      assert.throws(() => f.changes.prepare(f.target.id, malicious));
    }
    const preview = f.changes.prepare(f.target.id, packet);
    await assert.rejects(f.changes.apply(preview.id, "a".repeat(64), packet.baseCommit), /digest or base/);
    await assert.rejects(f.changes.apply(preview.id, packet.digest, "a".repeat(40)), /digest or base/);
    assert.equal(git(f.recipient, "worktree", "list", "--porcelain"), before);
  } finally { f.close(); }
});

test("binary and symlink changes reject clearly, and active or changed source identity cannot export", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.path, "binary.dat"), Buffer.from([0,1,2]));
    assert.throws(() => f.owner.export(f.run, f.ownerProject, f.device, false), /Binary/); rmSync(join(f.path, "binary.dat"));
    symlinkSync("src/main.ts", join(f.path, "linked.ts"));
    assert.throws(() => f.owner.export(f.run, f.ownerProject, f.device, false), /Symlink/); rmSync(join(f.path, "linked.ts"));
    writeFileSync(join(f.path, "new.ts"), "export const value = 1;\n");
    assert.throws(() => f.owner.export(f.run, f.ownerProject, f.device, true), /active/);
    assert.throws(() => f.owner.export({ ...f.run, workspace: { ...f.run.workspace!, branch: "other" } } as Run, f.ownerProject, f.device, false), /identity/);
  } finally { f.close(); }
});


test("interruption after Git apply persists its destination and recovers the exact tree without reapplying", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.path, "new.ts"), "export const recovered = true;\n");
    const packet = f.owner.export(f.run, f.ownerProject, f.device, false), preview = f.changes.prepare(f.target.id, packet);
    const original = f.store.db.prepare.bind(f.store.db);
    let failed = false;
    f.store.db.prepare = ((sql: string) => {
      const statement = original(sql);
      if (!sql.startsWith("UPDATE change_previews")) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === "run") return (...args: Parameters<typeof statement.run>) => {
          if (!failed && JSON.parse(String(args[0])).applied) { failed = true; throw new Error("Simulated interruption before recording success"); }
          return target.run(...args);
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof f.store.db.prepare;
    await assert.rejects(f.changes.apply(preview.id, packet.digest, packet.baseCommit), /separate destination/);
    f.store.db.prepare = original;
    const pending = f.changes.read(preview.id);
    assert.equal(pending.application?.state, "interrupted"); assert.equal(pending.applied, undefined);
    assert.equal(readFileSync(join(pending.application!.workspace.path!, "new.ts"), "utf8"), "export const recovered = true;\n");
    const trees = git(f.recipient, "worktree", "list", "--porcelain");
    const reloaded = new Changes(f.store, join(f.dir, "receiver"));
    const result = await reloaded.apply(preview.id, packet.digest, packet.baseCommit);
    assert.equal(result.workspace.path, pending.application!.workspace.path);
    assert.equal(git(f.recipient, "worktree", "list", "--porcelain"), trees);
    assert.equal(readFileSync(join(f.recipient, "src/main.ts"), "utf8"), "export const answer = 1;\n");
  } finally { f.close(); }
});


test("submodule and non-UTF8 new files reject instead of losing their contents", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.path, "invalid.txt"), Buffer.from([0xff, 0xfe, 0x61]));
    assert.throws(() => f.owner.export(f.run, f.ownerProject, f.device, false), /Non-UTF8/); rmSync(join(f.path, "invalid.txt"));
    git(f.path, "-c", "protocol.file.allow=always", "submodule", "add", f.recipient, "vendor");
    assert.throws(() => f.owner.export(f.run, f.ownerProject, f.device, false), /submodule/);
  } finally { f.close(); }
});


// Real isolated Git state; no native harness or inference is started.
async function interruptedDestination(f: Awaited<ReturnType<typeof fixture>>) {
  writeFileSync(join(f.path, "src/main.ts"), "export const answer = 42;\n");
  const packet = f.owner.export(f.run, f.ownerProject, f.device, false), preview = f.changes.prepare(f.target.id, packet);
  const original = f.store.db.prepare.bind(f.store.db);
  let failed = false;
  f.store.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!sql.startsWith("UPDATE change_previews")) return statement;
    return new Proxy(statement, { get(target, property) {
      if (property === "run") return (...args: Parameters<typeof statement.run>) => {
        if (!failed && JSON.parse(String(args[0])).applied) { failed = true; throw new Error("Lost receipt"); }
        return target.run(...args);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof f.store.db.prepare;
  try { await assert.rejects(f.changes.apply(preview.id, packet.digest, packet.baseCommit), /separate destination/); }
  finally { f.store.db.prepare = original; }
  const intent = f.changes.read(preview.id).application!;
  assert.equal(intent.state, "interrupted");
  // A clean interrupted destination would otherwise be eligible to apply again.
  git(intent.workspace.path!, "reset", "--hard", packet.baseCommit);
  return { packet, preview, path: intent.workspace.path! };
}
function serviceFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const callbacks = new Map<string, NativeCallbacks>();
  const service = createService(join(f.dir, "receiver"), 4317, (_command, run, _path, cb) => {
    callbacks.set(run.id, cb);
    return { stop: () => { cb.update({ state: "cancelled" }); cb.done(); }, closed: Promise.resolve() };
  }, process.execPath);
  const call = async (path: string, body: unknown) => service.app.request(`http://127.0.0.1:4317${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(requestedTaskBody(path, body)),
  });
  return { service, callbacks, call };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Fixture did not reach the expected state");
}

test("registered interrupted apply destination refuses active and surviving workers without changing files or index", async () => {
  const f = await fixture(), pending = await interruptedDestination(f), s = serviceFixture(f);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const registeredResponse = await s.call("/api/projects", { name: "Interrupted destination", path: pending.path });
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json() as Project;
    const started = await s.call("/api/tasks/start", { projectId: registered.id, prompt: "fake worker", workspace: "project", idempotencyKey: randomUUID() });
    assert.equal(started.status, 202);
    const run = await started.json() as Run;
    await waitFor(() => s.callbacks.has(run.id));
    const indexPath = git(pending.path, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const index = readFileSync(indexPath), file = readFileSync(join(pending.path, "src/main.ts"));
    const savedBefore = JSON.stringify(f.changes.read(pending.preview.id));
    const apply = () => s.call(`/api/changes/${pending.preview.id}/apply`, { expectedDigest: pending.packet.digest, expectedBaseCommit: pending.packet.baseCommit });
    const busy = await apply(); assert.equal(busy.status, 409); assert.match((await busy.json()).error, /active or possibly surviving worker/);
    assert.deepEqual(readFileSync(indexPath), index); assert.deepEqual(readFileSync(join(pending.path, "src/main.ts")), file);
    assert.equal(JSON.stringify(f.changes.read(pending.preview.id)), savedBefore);
    const cb = s.callbacks.get(run.id)!; cb.update({ state: "completed" }); cb.done();
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { detached: true, stdio: "ignore" });
    assert.ok(child.pid);
    s.service.store.saveRun({ ...s.service.store.run(run.id)!, state: "completed", workerPid: child.pid });
    const surviving = await apply(); assert.equal(surviving.status, 409); assert.match((await surviving.json()).error, /possibly surviving worker/);
    assert.deepEqual(readFileSync(indexPath), index); assert.deepEqual(readFileSync(join(pending.path, "src/main.ts")), file);
    assert.equal(JSON.stringify(f.changes.read(pending.preview.id)), savedBefore);
    const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
    process.kill(-child.pid!, "SIGKILL"); await exited; child = undefined;
    s.service.store.saveRun({ ...s.service.store.run(run.id)!, workerPid: undefined });
    const recovered = await apply(); assert.equal(recovered.status, 200);
    assert.equal(readFileSync(join(pending.path, "src/main.ts"), "utf8"), "export const answer = 42;\n");
  } finally {
    if (child?.pid) { const exited = new Promise<void>(resolve => child!.once("exit", () => resolve())); try { process.kill(-child.pid, "SIGKILL"); await exited; } catch {} }
    await s.service.close(); f.close();
  }
});

test("async apply reservation refuses destination worker admission but allows an unrelated checkout", async () => {
  const f = await fixture(), s = serviceFixture(f);
  const marker = join(f.dir, "creating"), release = join(f.dir, "release");
  let applying: Promise<Response> | undefined;
  try {
    writeFileSync(join(f.path, "src/main.ts"), "export const answer = 42;\n");
    const packet = f.owner.export(f.run, f.ownerProject, f.device, false), preview = f.changes.prepare(f.target.id, packet);
    // Worktree add checks out the files, then pauses before returning to the apply caller.
    const hook = join(f.recipient, ".git/hooks/post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\n`); chmodSync(hook, 0o700);
    applying = s.call(`/api/changes/${preview.id}/apply`, { expectedDigest: packet.digest, expectedBaseCommit: packet.baseCommit });
    await waitFor(() => existsSync(marker));
    const path = f.changes.read(preview.id).application!.workspace.path!;
    const registered = await (await s.call("/api/projects", { name: "Applying destination", path })).json() as Project;
    const refused = await s.call("/api/tasks/start", { projectId: registered.id, prompt: "blocked fake worker", workspace: "project", idempotencyKey: randomUUID() });
    assert.equal(refused.status, 409); assert.match((await refused.json()).error, /changes handoff being applied/);
    assert.equal(s.callbacks.size, 0);
    const unrelated = await s.call("/api/tasks/start", { projectId: f.target.id, prompt: "unrelated fake worker", workspace: "project", idempotencyKey: randomUUID() });
    assert.equal(unrelated.status, 202);
    const run = await unrelated.json() as Run; await waitFor(() => s.callbacks.has(run.id));
    writeFileSync(release, "continue");
    const applied = await applying; assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()));
    assert.equal(readFileSync(join(path, "src/main.ts"), "utf8"), "export const answer = 42;\n");
    const cb = s.callbacks.get(run.id)!; cb.update({ state: "completed" }); cb.done();
    const admitted = await s.call("/api/tasks/start", { projectId: registered.id, prompt: "after apply", workspace: "project", idempotencyKey: randomUUID() });
    assert.equal(admitted.status, 202);
  } finally {
    writeFileSync(release, "continue"); if (applying) await applying;
    await s.service.close(); f.close();
  }
});
