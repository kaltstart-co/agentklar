import { requestedTaskBody } from "./requested-task.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/service.ts";
import { install, waitUnregistered } from "../src/launchd.ts";

test("stop waits until launchd no longer reports the registered job", async () => {
  let checks = 0;
  await waitUnregistered("gui/501/com.agentklar.test", (args) => {
    assert.deepEqual(args, ["print", "gui/501/com.agentklar.test"]);
    return ++checks < 3;
  });
  assert.equal(checks, 3);
});

test("an unrelated launchd label appearing during install is not adopted", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-launchd-conflict-"));
  const home = join(dir, "home"), plist = join(dir, "LaunchAgents", "agentklar.plist");
  let prints = 0;
  const control = (args: string[]) => {
    if (args[0] === "print") return ++prints === 2;
    assert.fail("bootstrap must not run after another job claims the label");
  };
  try {
    await assert.rejects(install({ home, port: 4451, label: "com.agentklar.test", plist,
      journal: join(home, "launchd-install.json"), target: "gui/501/com.agentklar.test", domain: "gui/501" }, control),
      /already registered/);
    assert.equal(prints, 2);
    for (const path of [plist, join(home, "launchd-install.json"), join(home, "operator-key")])
      assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("managed startup preserves the installation npm prefix without registering a real job", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-launchd-prefix-"));
  const home = join(dir, "home"), plist = join(dir, "LaunchAgents", "agentklar.plist");
  const previous = process.env.NPM_CONFIG_PREFIX;
  const prefix = join(dir, "private-node");
  process.env.NPM_CONFIG_PREFIX = prefix;
  let captured = false;
  const control = (args: string[]) => {
    if (args[0] === "print") return false;
    assert.equal(args[0], "bootstrap");
    const converted = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
    assert.equal(converted.status, 0, converted.stderr);
    const env = JSON.parse(converted.stdout).EnvironmentVariables;
    assert.equal(env.NPM_CONFIG_PREFIX, prefix);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.AGENTKLAR_HOME, home);
    captured = true;
    throw new Error("Captured startup; no real job launched");
  };
  try {
    await assert.rejects(install({ home, port: 4452, label: "com.agentklar.test.prefix", plist,
      journal: join(home, "launchd-install.json"), target: "gui/501/com.agentklar.test.prefix", domain: "gui/501" }, control), /no real job launched/);
    assert.equal(captured, true);
    assert.equal(existsSync(plist), false);
  } finally {
    if (previous === undefined) delete process.env.NPM_CONFIG_PREFIX; else process.env.NPM_CONFIG_PREFIX = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private operator opens fresh browser links and stops new work during shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-operator-"));
  const project = join(dir, "project");
  mkdirSync(project);
  let launches = 0;
  const service = createService(join(dir, "home"), 4317,
    () => { launches++; return { stop() {} }; }, process.execPath, null, undefined, {},
    { id: "managed-id", key: "operator-secret" });
  const base = "http://127.0.0.1:4317";
  const operator = { "x-agentklar-operator-key": "operator-secret", "x-agentklar-service-id": "managed-id" };
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = operator) =>
    service.app.request(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(requestedTaskBody(path, body)) }) });
  try {
    const unauthenticated = await call("/api/projects", "GET", undefined, {});
    assert.equal(unauthenticated.status, 401);
    assert.match((await unauthenticated.json()).error, /agentklar service open/);
    for (const extra of [{ Authorization: `Bearer ${service.bearer}` }, { Origin: base }, { Cookie: "x=y" }] as Record<string, string>[])
      assert.equal((await call("/api/operator/status", "GET", undefined, { ...operator, ...extra })).status, 403);
    assert.equal((await call("/api/operator/status", "GET", undefined, { Authorization: `Bearer ${service.bearer}` })).status, 403);
    assert.equal((await call("/api/operator/status")).headers.get("cache-control"), "no-store");
    const first = service.setupUrl;
    const opened = await (await call("/api/operator/open", "POST", {})).json() as { url: string };
    assert.notEqual(opened.url, first);
    assert.equal((await service.app.request(first)).status, 403);
    const setup = await service.app.request(opened.url);
    assert.equal(setup.status, 302);
    assert.equal((await service.app.request(opened.url)).status, 403);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const p = await (await call("/api/projects", "POST", { name: "one", path: project },
      { Cookie: cookie, Origin: base, "Content-Type": "application/json" })).json() as { id: string };
    const task = { projectId: p.id, prompt: "wait", idempotencyKey: "first" };
    assert.equal((await call("/api/tasks/start", "POST", task,
      { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" })).status, 202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(launches, 1);
    assert.equal((await call("/api/operator/quiesce", "POST", { force: false, extra: true })).status, 400);
    assert.equal((await call("/api/operator/quiesce", "POST", { force: false })).status, 409);
    assert.equal((await call("/api/operator/quiesce", "POST", { force: true })).status, 200);
    assert.equal((await call("/api/tasks/start", "POST", { ...task, idempotencyKey: "second" },
      { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" })).status, 503);
    assert.equal((await call("/api/operator/resume", "POST", {})).status, 200);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
