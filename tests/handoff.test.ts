import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService, processGroupAlive } from "../src/service.ts";
import { runHandoff } from "../src/handoff.ts";
import type { Project, Run } from "../src/contracts.ts";

const makeRun = (projectId: string, overrides: Partial<Run> = {}): Run => ({
  id: randomUUID(), projectId, harness: "codex", prompt: "saved prompt", readOnly: false,
  state: "completed", result: "private result", createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z", tokens: null, threadId: randomUUID(),
  nativeHome: "/tmp/native home", ...overrides,
});

test("native handoff uses fixed argv and quotes every POSIX shell value", () => {
  const root = mkdtempSync(join(tmpdir(), "agentklar-handoff-"));
  try {
    const folder = join(root, "project '$(touch injected)'");
    const nativeHome = join(root, "home '$(touch home-injected)'");
    const cli = join(root, "codex '$(touch cli-injected)'");
    const output = join(root, "output");
    mkdirSync(folder);
    mkdirSync(nativeHome);
    writeFileSync(cli, "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$CODEX_HOME\" \"$@\" > \"$TEST_OUTPUT\"\n");
    chmodSync(cli, 0o700);
    const project: Project = { id: randomUUID(), name: "test", path: realpathSync(folder),
      preference: "balanced", roles: [], createdAt: "2026-10-01T00:00:00Z" };
    const run = makeRun(project.id, { readOnly: true, model: "gpt-6-luna", nativeHome });
    const packet = runHandoff(run, project, false, cli);
    assert.equal(packet.available, true, packet.reason || "");
    assert.deepEqual(packet.command?.argv, ["resume", "--cd", project.path, "--sandbox", "read-only",
      "--model=gpt-6-luna", run.threadId]);
    assert.deepEqual(packet.command?.env, { CODEX_HOME: nativeHome });
    assert.equal(packet.command?.cwd, project.path);
    assert.equal(packet.command?.shell, "posix");
    const shell = spawnSync("sh", ["-c", packet.command!.display], {
      env: { ...process.env, TEST_OUTPUT: output }, cwd: root, encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(existsSync(join(root, "injected")), false);
    assert.equal(existsSync(join(root, "home-injected")), false);
    assert.equal(existsSync(join(root, "cli-injected")), false);
    const observed = readFileSync(output, "utf8").trimEnd().split("\n");
    assert.deepEqual(observed, [project.path, nativeHome, ...packet.command!.argv]);
    const claude = runHandoff({ ...run, harness: "claude", readOnly: false, nativeHomeEnv: "set" }, project, false, cli);
    assert.deepEqual(claude.command?.argv, ["--resume", run.threadId, "--model=gpt-6-luna"]);
    assert.deepEqual(claude.command?.env, { CLAUDE_CONFIG_DIR: nativeHome });
    assert.deepEqual(claude.command?.envUnset, []);
    writeFileSync(cli, "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"${CLAUDE_CONFIG_DIR+x}\" \"${CLAUDE_CONFIG_DIR-}\" \"$@\" > \"$TEST_OUTPUT\"\n");
    const inherited = { ...process.env, CLAUDE_CONFIG_DIR: join(root, "wrong scope"), TEST_OUTPUT: output };
    const explicitShell = spawnSync("sh", ["-c", claude.command!.display], { cwd: root, env: inherited, encoding: "utf8" });
    assert.equal(explicitShell.status, 0, explicitShell.stderr);
    assert.deepEqual(readFileSync(output, "utf8").trimEnd().split("\n"),
      [project.path, "x", nativeHome, ...claude.command!.argv]);
    const unset = runHandoff({ ...run, harness: "claude", readOnly: false,
      nativeHome: join(homedir(), ".claude"), nativeHomeEnv: "unset" }, project, false, cli);
    assert.equal(unset.available, true);
    assert.deepEqual(unset.command?.env, {});
    assert.deepEqual(unset.command?.envUnset, ["CLAUDE_CONFIG_DIR"]);
    const unsetShell = spawnSync("sh", ["-c", unset.command!.display], { cwd: root, env: inherited, encoding: "utf8" });
    assert.equal(unsetShell.status, 0, unsetShell.stderr);
    assert.deepEqual(readFileSync(output, "utf8").trimEnd().split("\n"),
      [project.path, "", "", ...unset.command!.argv]);
    const contextAlias = runHandoff({ ...run, harness: "claude", readOnly: false, nativeHomeEnv: "set", model: "sonnet[1m]" }, project, false, cli);
    assert.deepEqual(contextAlias.command?.argv, ["--resume", run.threadId, "--model=sonnet[1m]"]);
    assert.equal(runHandoff({ ...run, harness: "claude", nativeHomeEnv: "set" }, project, false, cli).available, false);
    assert.match(runHandoff({ ...run, harness: "claude", nativeHomeEnv: "set" }, project, false, cli).reason!, /SDK tool hook/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Muse handoff pins its recorded XDG data home and safely quotes resume values", () => {
  const root = mkdtempSync(join(tmpdir(), "agentklar-muse-handoff-"));
  try {
    const folder = join(root, "project '$(touch project-injected)'");
    const data = join(root, "data '$(touch data-injected)'");
    const museHome = join(data, "muse");
    const cli = join(root, "muse '$(touch cli-injected)'");
    const output = join(root, "output");
    mkdirSync(folder);
    mkdirSync(museHome, { recursive: true });
    writeFileSync(cli, "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$XDG_DATA_HOME\" \"$@\" > \"$TEST_OUTPUT\"\n");
    chmodSync(cli, 0o700);
    const project: Project = { id: randomUUID(), name: "test", path: realpathSync(folder),
      preference: "balanced", roles: [], createdAt: "2026-10-01T00:00:00Z" };
    const run = makeRun(project.id, { harness: "muse", nativeHome: museHome, model: "muse-spark-1.3" });
    const packet = runHandoff(run, project, false, cli);
    assert.equal(packet.available, true, packet.reason || "");
    assert.deepEqual(packet.command?.argv, ["resume", run.threadId, "--workspace", project.path, "--model", "muse-spark-1.3"]);
    assert.deepEqual(packet.command?.env, { XDG_DATA_HOME: data });
    const shell = spawnSync("sh", ["-c", packet.command!.display], {
      cwd: root, env: { ...process.env, TEST_OUTPUT: output }, encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
    assert.deepEqual(readFileSync(output, "utf8").trimEnd().split("\n"), [project.path, data, ...packet.command!.argv]);
    for (const name of ["project-injected", "data-injected", "cli-injected"])
      assert.equal(existsSync(join(root, name)), false);
    for (const [patch, reason] of [
      [{ readOnly: true }, /read-only/],
      [{ nativeHome: join(data, "other") }, /directory layout/],
      [{ nativeHome: join(root, "missing", "muse") }, /data home is missing/],
      [{ nativeHome: "/tmp/unsafe\n/muse" }, /session home/],
      [{ model: "--unsafe" }, /model name/],
    ] as const) {
      const rejected = runHandoff({ ...run, ...patch }, project, false, cli);
      assert.equal(rejected.available, false);
      assert.match(rejected.reason!, reason);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff refuses missing, unsafe and active native state", () => {
  const root = mkdtempSync(join(tmpdir(), "agentklar-handoff-state-"));
  try {
    const folder = join(root, "project");
    mkdirSync(folder);
    const cli = join(root, "codex");
    writeFileSync(cli, "#!/bin/sh\nexit 0\n");
    chmodSync(cli, 0o700);
    const project: Project = { id: randomUUID(), name: "test", path: realpathSync(folder),
      preference: "balanced", roles: [], createdAt: "2026-10-01T00:00:00Z" };
    const run = makeRun(project.id);
    const cases: [Partial<Run>, Project | undefined, boolean, string | null, RegExp][] = [
      [{ state: "running" }, project, false, cli, /still active/],
      [{}, project, true, cli, /active worker/],
      [{}, undefined, false, cli, /project no longer exists/],
      [{}, { ...project, path: join(root, "missing") }, false, cli, /folder is missing/],
      [{ threadId: "not-a-uuid" }, project, false, cli, /session UUID/],
      [{ nativeHome: undefined }, project, false, cli, /session home/],
      [{ model: "--dangerously-bypass-approvals-and-sandbox" }, project, false, cli, /model name/],
      [{ nativeHome: "/tmp/home\n$(touch x)" }, project, false, cli, /session home/],
      [{ nativeHome: "/" + "'".repeat(4000) }, project, false, cli, /too long/],
      [{ harness: "claude", readOnly: false, nativeHomeEnv: undefined }, project, false, cli, /config environment scope/],
      [{ harness: "claude", readOnly: false, nativeHomeEnv: "invalid" as Run["nativeHomeEnv"] }, project, false, cli, /config environment scope/],
      [{ harness: "claude", readOnly: false, nativeHomeEnv: "unset", nativeHome: "/tmp/other-home/.claude" }, project, false, cli, /current user home differs/],
      [{ harness: "other" as Run["harness"] }, project, false, cli, /supported native harness/],
      [{}, project, false, null, /CLI is unavailable/],
    ];
    for (const [patch, p, busy, command, reason] of cases) {
      const packet = runHandoff({ ...run, ...patch }, p, busy, command);
      assert.equal(packet.available, false);
      assert.equal(packet.command, null);
      assert.match(packet.reason!, reason);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude launch records set versus unset config scope across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentklar-claude-scope-"));
  const projectPath = join(root, "project");
  const cli = join(root, "claude");
  mkdirSync(projectPath);
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  chmodSync(cli, 0o700);
  const original = process.env.CLAUDE_CONFIG_DIR;
  try {
    for (const mode of ["unset", "set"] as const) {
      const nativeHome = mode === "set" ? join(root, "custom claude") : join(homedir(), ".claude");
      if (mode === "set") process.env.CLAUDE_CONFIG_DIR = nativeHome;
      else delete process.env.CLAUDE_CONFIG_DIR;
      const home = join(root, `state-${mode}`);
      let service = createService(home, 4317, () => ({ stop() {}, closed: Promise.resolve() }), null, cli);
      try {
        const project: Project = { id: randomUUID(), name: "test", path: realpathSync(projectPath),
          preference: "balanced", roles: [], createdAt: "2026-10-01T00:00:00Z" };
        service.store.saveProject(project);
        const response = await service.app.request("http://127.0.0.1:4317/api/tasks/start", {
          method: "POST", headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project.id, prompt: "test", idempotencyKey: mode, harness: "claude" }),
        });
        assert.equal(response.status, 202);
        const started = await response.json();
        assert.equal(started.nativeHomeEnv, undefined);
        const saved = service.store.run(started.id)!;
        assert.equal(saved.nativeHomeEnv, mode);
        assert.equal(saved.nativeHome, nativeHome);
        await new Promise((resolve) => setImmediate(resolve));
        service.store.saveRun({ ...saved, state: "completed", threadId: randomUUID() });
        await service.close();
        service = createService(home, 4317, () => ({ stop() {}, closed: Promise.resolve() }), null, cli);
        const persisted = service.store.run(started.id)!;
        assert.equal(persisted.nativeHomeEnv, mode);
        const packet = runHandoff(persisted, project, false, cli);
        assert.equal(packet.available, true);
        assert.deepEqual(packet.command?.envUnset, mode === "unset" ? ["CLAUDE_CONFIG_DIR"] : []);
        assert.deepEqual(packet.command?.env, mode === "set" ? { CLAUDE_CONFIG_DIR: nativeHome } : {});
      } finally { await service.close(); }
    }
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated handoff is compact and survives restart; another active run and process group block it", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentklar-handoff-api-"));
  const projectPath = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(projectPath);
  mkdirSync(bin);
  const cli = join(bin, "codex");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  chmodSync(cli, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath || ""}`;
  let service = createService(join(root, "state"), 4317);
  const call = (id: string) => service.app.request(`http://127.0.0.1:4317/api/runs/${id}/handoff`, {
    headers: { Authorization: `Bearer ${service.bearer}` },
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const project: Project = { id: randomUUID(), name: "test", path: realpathSync(projectPath),
      preference: "balanced", roles: [], createdAt: "2026-10-01T00:00:00Z" };
    service.store.saveProject(project);
    const run = makeRun(project.id, { result: "SECRET_RESULT_".repeat(3000), prompt: "SECRET_PROMPT_".repeat(3000) });
    service.store.insertRun(run, "first");
    assert.equal((await service.app.request(`http://127.0.0.1:4317/api/runs/${run.id}/handoff`)).status, 401);
    assert.equal((await call(randomUUID())).status, 404);
    const ready = await (await call(run.id)).json();
    assert.equal(ready.available, true);
    assert.equal(ready.command.executable, cli);
    assert.ok(JSON.stringify(ready).length < 1800);
    assert.equal(JSON.stringify(ready).includes("SECRET_"), false);
    const other = makeRun(project.id, { state: "running" });
    service.store.insertRun(other, "other");
    assert.match((await (await call(run.id)).json()).reason, /active worker/);
    service.store.saveRun({ ...other, state: "interrupted" });
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    assert.ok(child.pid);
    service.store.saveRun({ ...other, workerPid: child.pid });
    assert.equal(processGroupAlive(child.pid!), true);
    assert.match((await (await call(run.id)).json()).reason, /process group/);
    const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    process.kill(-child.pid!, "SIGTERM");
    await closed;
    child = undefined;
    service.store.saveRun({ ...other, workerPid: undefined });
    await service.close();
    service = createService(join(root, "state"), 4317);
    const restored = await (await call(run.id)).json();
    assert.equal(restored.available, true);
    assert.deepEqual(restored.command.env, { CODEX_HOME: "/tmp/native home" });
    assert.equal(service.store.run(run.id)?.result, run.result);
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await service.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});
