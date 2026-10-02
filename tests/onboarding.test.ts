import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-onboarding-")));
  const home = join(dir, "service"), projectPath = join(dir, "project"), nativeHome = join(dir, "native");
  for (const path of [home, projectPath, nativeHome]) mkdirSync(path);
  const mode = join(dir, "mode"), started = join(dir, "started"), command = join(dir, "claude.mjs");
  writeFileSync(mode, "");
  writeFileSync(command, `#!${process.execPath}\n` + String.raw`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const mode = readFileSync(process.env.TEST_MODE,'utf8');
writeFileSync(process.env.TEST_STARTED,'started');
if(mode === 'delay') await new Promise(resolve => setTimeout(resolve,350));
if(mode === 'fail') { process.stderr.write('NATIVE_PRIVATE_SECRET'); process.exit(1); }
const file = join(process.env.CLAUDE_CONFIG_DIR,'.claude.json');
const config = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {};
const args = process.argv.slice(2), cwd = process.cwd();
config.projects ??= {}; config.projects[cwd] ??= {}; const servers = config.projects[cwd].mcpServers ??= {};
if(args[1] === 'add') {
 const split = args.indexOf('--'), env = {};
 for(let i=0;i<split;i++) if(args[i] === '--env') { const value=args[++i],eq=value.indexOf('='); env[value.slice(0,eq)]=value.slice(eq+1); }
 servers.agentklar = {type:'stdio',command:args[split+1],args:args.slice(split+2),env};
} else if(args[1] === 'remove') delete servers.agentklar;
else process.exit(1);
writeFileSync(file,JSON.stringify(config));
`, { mode: 0o700 });
  const operator = { "x-agentklar-operator-key": "private-test-key", "x-agentklar-service-id": "test-owner" };
  let launches = 0;
  const makeService = () => createService(home, 4317, () => { launches++; return { stop() {} }; },
    null, command, undefined, { env: { ...process.env, HOME: nativeHome, CLAUDE_CONFIG_DIR: nativeHome,
      CODEX_HOME: nativeHome, XDG_CONFIG_HOME: nativeHome, TEST_MODE: mode, TEST_STARTED: started }, timeoutMs: 1500 },
    { id: "test-owner", key: "private-test-key" }, { userHome: nativeHome }, {}, null, {}, null);
  let service = makeService(), cookie = "";
  async function authenticate() { cookie = (await service.app.request(service.setupUrl)).headers.get("set-cookie")!.split(";")[0]; }
  await authenticate();
  const base = "http://127.0.0.1:4317";
  const ui = () => ({ Cookie: cookie, Origin: base, "Content-Type": "application/json" });
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string,string> = operator) => service.app.request(base + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const project = await (await call("/api/operator/onboarding/project", "POST", { name: "Example", path: projectPath })).json();
  const setup = (operation: string, fields = {}, headers: Record<string,string> = operator) => call("/api/operator/onboarding/setup", "POST", {
    projectId: project.id, harness: "claude", operation, ...fields,
  }, headers);
  return { dir, mode, started, project, projectPath, nativeHome, operator, base, call, setup, ui,
    get service() { return service; }, get launches() { return launches; },
    restart: async () => { await service.close(); service = makeService(); await authenticate(); },
    cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("shared onboarding starts empty, saves with CAS and survives restart", async () => {
  const f = await fixture();
  try {
    const fresh = await (await f.call("/api/operator/onboarding")).json();
    assert.deepEqual(fresh.preferences, { revision: 0, projectId: null, mainHarness: null, updatedAt: null });
    assert.equal(fresh.projects[0].id, f.project.id);
    assert.equal(fresh.harnesses.find((h: {id:string}) => h.id === "claude").available, true);
    assert.equal(JSON.stringify(fresh).includes("private-test-key"), false);
    const input = { projectId: f.project.id, mainHarness: "claude", expectedRevision: 0 };
    const saved = await (await f.call("/api/onboarding", "PUT", input, f.ui())).json();
    assert.equal(saved.revision, 1); assert.equal(saved.mainHarness, "claude");
    assert.equal((await f.call("/api/operator/onboarding/preferences", "POST", input)).status, 409);
    assert.equal((await f.call("/api/operator/onboarding/preferences", "POST", { ...input, projectId: randomUUID(), expectedRevision: 1 })).status, 404);
    assert.equal((await f.call("/api/operator/onboarding/preferences", "POST", { ...input, mainHarness: "codex", expectedRevision: 1 })).status, 422);
    assert.equal((await f.call("/api/operator/onboarding/preferences", "POST", { ...input, extra: true })).status, 400);
    await f.restart();
    assert.deepEqual(await (await f.call("/api/onboarding", "GET", undefined, f.ui())).json(), saved);
    const cleared = await (await f.call("/api/operator/onboarding/preferences", "POST", { ...input, mainHarness: null, expectedRevision: 1 })).json();
    assert.equal(cleared.mainHarness, null); assert.equal(cleared.revision, 2);
  } finally { await f.cleanup(); }
});

test("onboarding separates operator identity from UI cookies and Bearer access", async () => {
  const f = await fixture();
  try {
    const bearer = { Authorization: `Bearer ${f.service.bearer}` };
    for (const headers of [bearer, { ...f.ui(), ...bearer }]) {
      assert.equal((await f.call("/api/onboarding", "GET", undefined, headers)).status, 403);
      assert.equal((await f.call("/api/onboarding", "PUT", {}, headers)).status, 403);
    }
    assert.equal((await f.call("/api/onboarding", "GET", undefined, {})).status, 401);
    const { Origin: ignored, ...withoutOrigin } = f.ui();
    assert.equal((await f.call("/api/onboarding", "PUT", {}, withoutOrigin)).status, 403);
    for (const headers of [f.ui(), bearer, { ...f.operator, Cookie: "anything" },
      { ...f.operator, Origin: f.base }, { ...f.operator, Authorization: "invalid" },
      { ...f.operator, "x-agentklar-service-id": "different-owner" }, {}]) {
      assert.equal((await f.call("/api/operator/onboarding", "GET", undefined, headers)).status, 403);
      assert.equal((await f.setup("preview", {}, headers)).status, 403);
    }
    assert.equal((await f.call("/api/operator/onboarding")).headers.get("cache-control"), "no-store");
    assert.equal((await f.call("/api/approvals/fake/answer", "POST", {}, f.operator)).status, 401);
  } finally { await f.cleanup(); }
});

test("operator project registration reuses the UI rules and existing canonical project", async () => {
  const f = await fixture();
  try {
    const existing = await f.call("/api/projects", "POST", { name: "Duplicate", path: f.projectPath }, f.ui());
    assert.equal(existing.status, 200); assert.equal((await existing.json()).id, f.project.id);
    for (const input of [{ name: "bad", path: "relative" }, { name: "bad", path: join(f.dir, "absent") },
      { name: "bad", path: f.mode }, { name: "bad", path: f.projectPath, command: "anything" }]) {
      assert.equal((await f.call("/api/operator/onboarding/project", "POST", input)).status, 400);
    }
    assert.equal(f.service.store.projects().length, 1);
    assert.equal((await f.setup("apply", { previewId: randomUUID(), changeId: randomUUID() })).status, 400);
    assert.equal((await f.setup("status", { projectId: randomUUID() })).status, 404);
  } finally { await f.cleanup(); }
});

test("operator setup uses reviewed IDs and preserves interrupted recovery across restart", async () => {
  const f = await fixture();
  try {
    assert.equal((await (await f.setup("status")).json()).status, "missing");
    assert.equal((await f.setup("apply", { previewId: randomUUID() })).status, 404);
    const preview = await (await f.setup("preview")).json();
    writeFileSync(f.mode, "fail");
    const failed = await f.setup("apply", { previewId: preview.id });
    assert.equal(failed.status, 503); assert.equal((await failed.text()).includes("NATIVE_PRIVATE_SECRET"), false);
    assert.equal((await (await f.setup("status")).json()).change.state, "interrupted");
    await f.restart();
    assert.equal((await (await f.setup("status")).json()).change.state, "interrupted");
    writeFileSync(f.mode, "");
    const fresh = await (await f.setup("preview")).json();
    const applied = await (await f.setup("apply", { previewId: fresh.id })).json();
    assert.equal(applied.state, "applied");
    await f.restart();
    const status = await (await f.setup("status")).json();
    assert.equal(status.status, "configured"); assert.equal(status.canUndo, true);
    assert.equal((await (await f.setup("undo", { changeId: applied.id })).json()).state, "undone");
    assert.equal((await (await f.setup("status")).json()).status, "missing");
    assert.equal(f.launches, 0);
  } finally { await f.cleanup(); }
});

test("native setup blocks workers, drains on close and honors quiescence", async () => {
  const f = await fixture();
  try {
    const preview = await (await f.setup("preview")).json();
    writeFileSync(f.mode, "delay");
    const pending = f.setup("apply", { previewId: preview.id });
    for (let n = 0; n < 100 && !existsSync(f.started); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(f.started), true);
    assert.equal((await f.call("/api/operator/quiesce", "POST", { force: false })).status, 409);
    assert.equal((await f.call("/api/tasks/start", "POST", { projectId: f.project.id, prompt: "never start", harness: "claude", idempotencyKey: "blocked" }, f.ui())).status, 409);
    assert.equal((await f.call(`/api/projects/${f.project.id}/setup/claude/undo`, "POST", { changeId: randomUUID() }, f.ui())).status, 409);
    const closing = f.service.close();
    assert.equal((await f.setup("preview")).status, 503);
    assert.equal((await pending).status, 200);
    await closing;
    assert.equal(f.launches, 0);
    await f.restart();
    assert.equal((await (await f.setup("status")).json()).status, "configured");
    assert.equal((await f.call("/api/operator/quiesce", "POST", { force: false })).status, 200);
    for (const [path, body] of [["preferences", { projectId: f.project.id, mainHarness: null, expectedRevision: 0 }],
      ["project", { name: "new", path: f.projectPath }], ["setup", { projectId: f.project.id, harness: "claude", operation: "status" }]] as const) {
      assert.equal((await f.call(`/api/operator/onboarding/${path}`, "POST", body)).status, 503);
    }
    assert.equal((await f.call("/api/onboarding", "PUT", { projectId: f.project.id, mainHarness: null, expectedRevision: 0 }, f.ui())).status, 503);
    assert.equal((await f.call(`/api/projects/${f.project.id}/setup/claude`, "GET", undefined, f.ui())).status, 503);
  } finally { await f.cleanup(); }
});
