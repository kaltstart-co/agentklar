import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { operatorRequest } from "../src/launchd.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedMainHarnesses, nativeLaunch, openNativeHarness, runMenu, terminalText, type MenuClient, type TerminalPrompts } from "../src/cli.ts";
import type { Harness, Project } from "../src/contracts.ts";
const project = { id: "project", name: "Project", path: "/tmp/project", roles: [], preference: "balanced", createdAt: "now" } as Project;
const codex: Harness = { id: "codex", name: "Codex", executable: "/native/codex", available: true, hostSupported: true, workerSupported: true, reason: "Installed" };
function fixture(answers: (string | boolean | symbol)[], status = "missing", interrupted = false, saved = false, main = codex) {
  const calls: { route: string; body?: any }[] = [], notes: string[] = [], views: string[] = [];
  const preferences = { revision: 0, projectId: saved ? project.id : null, mainHarness: saved ? main.id : null, updatedAt: null };
  const ui: TerminalPrompts = {
    select: async () => answers.shift() as string | symbol,
    confirm: async () => answers.shift() as boolean | symbol,
    text: async () => answers.shift() as string | symbol,
    note: (text, title) => notes.push(title + "\n" + text),
  };
  const client: MenuClient = {
    request: async (route, body: any) => {
      calls.push({ route, body });
      if (route === "onboarding") return { preferences, projects: [project, { ...project, id: "other", name: "Other", path: "/tmp/other" }], harnesses: [main, { ...codex, id: "claude", available: false }, { ...codex, id: "zcode" }] };
      if (route === "onboarding/project") return { ...project, path: body.path };
      if (route === "onboarding/preferences") return { ...preferences, ...body, revision: preferences.revision + 1 };
      if (body.operation === "status") return { status, message: "Native status", canUndo: interrupted, change: interrupted ? { id: "change", state: "interrupted" } : null };
      if (body.operation === "preview") return { id: "preview", scope: "User", configPath: "/native/config", cwd: null, command: "native add agentklar", entry: { command: "agentklar", args: ["mcp"] } };
      if (body.operation === "apply") { status = "configured"; return { state: "applied" }; }
      if (body.operation === "undo") { status = "missing"; return { state: "undone" }; }
      throw new Error("Unexpected operation");
    },
    open: async view => { views.push(view); }, launch: async () => { views.push("native"); },
  };
  return { ui, client, calls, notes, views };
}
test("terminal setup previews before explicit apply, pins installed main and opens focused dashboard", async () => {
  const f = fixture(["project", "codex", true, "team", "native", "exit"]);
  await runMenu(f.ui, f.client, "/cwd");
  assert.deepEqual(f.calls.filter(c => c.route === "onboarding/setup").map(c => c.body.operation), ["status", "preview", "apply", "status"]);
  assert.deepEqual(f.calls.find(c => c.body?.operation === "apply")?.body, { projectId: "project", harness: "codex", operation: "apply", previewId: "preview" });
  assert.ok(f.notes.some(n => n.includes("Exact connection preview") && n.includes('/native/config') && n.includes('"args": [\n    "mcp"')));
  assert.deepEqual(f.calls.find(c => c.route === "onboarding/preferences")?.body, { projectId: "project", mainHarness: "codex", expectedRevision: 0 });
  assert.deepEqual(f.views, ["team", "native"]);
  assert.ok(f.calls.every(c => !/approve|runs|tasks/.test(c.route)));
});
test("declined preview never applies; cancellation and interrupted status refuse replacement", async () => {
  const declined = fixture(["project", "codex", false, "exit"]);
  await runMenu(declined.ui, declined.client);
  assert.ok(!declined.calls.some(c => c.body?.operation === "apply"));
  assert.equal(declined.calls.find(c => c.route === "onboarding/preferences")?.body.mainHarness, null);
  const cancelled = fixture(["project", "codex", Symbol("cancel")]);
  await assert.rejects(runMenu(cancelled.ui, cancelled.client));
  assert.ok(!cancelled.calls.some(c => c.body?.operation === "apply" || c.route === "onboarding/preferences"));
  const conflict = fixture(["project", "codex", false, "exit"], "conflict", true);
  await runMenu(conflict.ui, conflict.client);
  assert.deepEqual(conflict.calls.filter(c => c.route === "onboarding/setup").map(c => c.body.operation), ["status"]);
  assert.ok(conflict.notes.some(n => n.includes("needs attention")));
  assert.equal(conflict.calls.find(c => c.route === "onboarding/preferences")?.body.mainHarness, null);
  const unavailable = fixture(["project", "codex", "exit"], "unavailable");
  await runMenu(unavailable.ui, unavailable.client);
  assert.equal(unavailable.calls.find(c => c.route === "onboarding/preferences")?.body.mainHarness, null);
  const interrupted = fixture([false, "exit"], "configured", true, true);
  await runMenu(interrupted.ui, interrupted.client);
  assert.equal(interrupted.calls.find(c => c.route === "onboarding/preferences")?.body.mainHarness, null);
});
test("setup undo targets the managed change and cwd registration uses a structured path", async () => {
  const f = fixture(["cwd", "codex", true, "exit"], "conflict", true);
  await runMenu(f.ui, f.client, "/tmp/Project with spaces");
  assert.deepEqual(f.calls.find(c => c.route === "onboarding/project")?.body, { name: "Project with spaces", path: "/tmp/Project with spaces" });
  assert.deepEqual(f.calls.find(c => c.body?.operation === "undo")?.body, { projectId: "project", harness: "codex", operation: "undo", changeId: "change" });
});
test("native main launch preserves native environment/cwd with no permission or model flags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-cli-"));
  const prior = process.env.AGENTKLAR_CLI_TEST_NATIVE;
  try {
    const executable = join(dir, "native.cjs"), output = join(dir, "result.json");
    writeFileSync(executable, "require('node:fs').writeFileSync('result.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),native:process.env.AGENTKLAR_CLI_TEST_NATIVE}));");
    chmodSync(executable, 0o700);
    const h = { ...codex, executable };
    process.env.AGENTKLAR_CLI_TEST_NATIVE = "unchanged";
    assert.deepEqual(nativeLaunch(h), { command: process.execPath, args: [executable.replace(/^\/var\//, "/private/var/")] });
    await openNativeHarness(h, { ...project, path: dir });
    const result = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(result.args, []); assert.equal(result.native, "unchanged"); assert.ok(result.cwd.endsWith(dir.split('/').at(-1)!));
    assert.throws(() => nativeLaunch({ ...h, id: "zcode" }));
    assert.equal(installedMainHarnesses([codex, { ...codex, id: "zcode" }, { ...codex, available: false }]).length, 1);
    assert.doesNotMatch(terminalText("x\x1b[31m\ny"), /\x1b|\n/);
  } finally { if (prior === undefined) delete process.env.AGENTKLAR_CLI_TEST_NATIVE; else process.env.AGENTKLAR_CLI_TEST_NATIVE = prior; rmSync(dir, { recursive: true, force: true }); }
});
test("noninteractive bare CLI keeps usage; setup gives plain guidance without a service call", () => {
  const bare = execFileSync(process.execPath, ["bin/agentklar.mjs"], { encoding: "utf8" });
  assert.match(bare, /Usage: agentklar setup/); assert.doesNotMatch(bare, /\x1b/);
  try { execFileSync(process.execPath, ["bin/agentklar.mjs", "setup"], { encoding: "utf8", stdio: "pipe" }); assert.fail("setup should require a terminal"); }
  catch (error: any) { assert.equal(error.status, 1); assert.match(error.stderr, /Setup needs an interactive terminal/); assert.equal(error.stdout, ""); }
});

test("operator setup transport permits a bounded native operation beyond the status timeout", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentklar-cli-http-")), key = "a".repeat(64), id = randomUUID();
  writeFileSync(join(home, "operator-key"), key, { mode: 0o600 });
  const server = createServer((request, response) => {
    assert.equal(request.headers["x-agentklar-operator-key"], key);
    assert.equal(request.headers["x-agentklar-service-id"], id);
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    setTimeout(() => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ status: "configured" })); }, 2700);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const entry = { id, port: (server.address() as { port: number }).port };
    const result = await operatorRequest({ home }, entry, "onboarding/setup", { projectId: "project", harness: "codex", operation: "status" }, 65536);
    assert.equal(result.status, "configured");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

test("configured return opens the compact menu without project chooser or preference rewrite", async () => {
  const f = fixture(["exit"], "configured", false, true);
  await runMenu(f.ui, f.client);
  assert.deepEqual(f.calls.map(c => c.route), ["onboarding", "onboarding/setup"]);
  assert.equal(f.calls[1].body.operation, "status");
});
test("new Claude project needs its own configured connection before saving main", async () => {
  const claude = { ...codex, id: "claude", name: "Claude Code" };
  const f = fixture(["project", "other", false, "exit"], "configured", false, true, claude);
  const request = f.client.request;
  f.client.request = async (route, body: any) => {
    const value = await request(route, body);
    if (body?.projectId === "other" && body.operation === "status") return { status: "missing", message: "Local project entry missing", canUndo: false, change: null };
    return value;
  };
  await runMenu(f.ui, f.client);
  assert.deepEqual(f.calls.filter(c => c.route === "onboarding/setup").map(c => [c.body.projectId, c.body.operation]), [["project", "status"], ["other", "status"], ["other", "preview"]]);
  assert.deepEqual(f.calls.find(c => c.route === "onboarding/preferences")?.body, { projectId: "other", mainHarness: null, expectedRevision: 0 });
  assert.ok(!f.calls.some(c => c.body?.operation === "apply"));
});
test("operator response preserves a Unicode project path split across HTTP chunks", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentklar-cli-unicode-")), id = randomUUID();
  writeFileSync(join(home, "operator-key"), "b".repeat(64), { mode: 0o600 });
  const path = "/tmp/项目", bytes = Buffer.from(JSON.stringify({ path }));
  const split = bytes.indexOf(Buffer.from("项")) + 1;
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.write(bytes.subarray(0, split));
    setTimeout(() => response.end(bytes.subarray(split)), 15);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await operatorRequest({ home }, { id, port: (server.address() as { port: number }).port }, "onboarding", undefined, 65536);
    assert.equal(result.path, path);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});
