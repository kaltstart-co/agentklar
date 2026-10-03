import { requestedTaskBody } from "./requested-task.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createService } from "../src/service.ts";
import type { CatalogSnapshot, Project } from "../src/contracts.ts";
import { nativeFixture } from "./fixtures/native-change.ts";

const base = "http://127.0.0.1:4349";
async function fixture(reader?: (project: Project) => Promise<CatalogSnapshot>) {
  const f = nativeFixture(), gate = join(f.root, "gate"), entered = join(f.root, "entered");
  writeFileSync(f.command, `#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';\nif(existsSync(${JSON.stringify(gate)})){writeFileSync(${JSON.stringify(entered)},'entered');while(existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,5));}\nawait import(${JSON.stringify(resolve("tests/fixtures/native-config-plugin.mjs"))});\n`, { mode: 0o700 });
  let launches = 0;
  const service = createService(f.home, 4349, () => { launches++; return { stop() {}, closed: Promise.resolve() }; },
    f.command, f.command, reader, { env: f.options.env }, undefined, {}, {}, null, {}, null, undefined, { "cursor-agent": null });
  const project = { ...f.project, id: randomUUID() }; service.store.saveProject(project);
  const opened = await service.app.request(service.setupUrl);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0];
  const headers = { cookie, Origin: base, "Content-Type": "application/json" };
  const call = (path: string, body?: unknown, custom: Record<string, string> = headers) => service.app.request(base + path, {
    method: body === undefined ? "GET" : "POST", headers: custom, ...(body === undefined ? {} : { body: JSON.stringify(requestedTaskBody(path, body)) }),
  });
  const delayed = (path: string) => {
    let release!: (body: unknown) => void;
    const stream = new ReadableStream({ start(controller) { release = body => { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); }; } });
    const response = service.app.request(new Request(base + path, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit));
    return { response, release };
  };
  return { ...f, service, project, call, delayed, gate, entered, headers, get launches() { return launches; },
    async cleanup() { if (existsSync(gate)) unlinkSync(gate); await service.close(); f.close(); } };
}
async function waitFor(check: () => boolean) {
  const until = Date.now() + 2500;
  while (!check()) { if (Date.now() > until) throw Error("Native fixture did not start"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("native management requires the local UI and exact origin", async () => {
  const f = await fixture();
  try {
    const path = `/api/projects/${f.project.id}/native-settings/claude`;
    assert.equal((await f.call(path, undefined, { Authorization: `Bearer ${f.service.bearer}` })).status, 403);
    assert.equal((await f.call(path)).status, 200);
    const body = { harness: "claude", field: "model", value: "haiku" };
    const route = `/api/projects/${f.project.id}/native-settings/preview`;
    assert.equal((await f.call(route, body, { ...f.headers, Origin: "https://evil.example" })).status, 403);
    const preview = await f.call(route, body); assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("Cache-Control"), "no-store");
    assert.equal(existsSync(join(f.folder, ".claude/settings.local.json")), false);
  } finally { await f.cleanup(); }
});

test("native write rechecks workers after waiting for its request body", async () => {
  const f = await fixture();
  try {
    const preview = await (await f.call(`/api/projects/${f.project.id}/native-settings/preview`, { harness: "claude", field: "model", value: "haiku" })).json();
    const pending = f.delayed(`/api/projects/${f.project.id}/native-settings/apply`);
    await new Promise(resolve => setImmediate(resolve));
    const started = await f.call("/api/tasks/start", { projectId: f.project.id, prompt: "fixture", idempotencyKey: "native-write-race" });
    assert.equal(started.status, 202);
    pending.release({ previewId: preview.id });
    const refused = await pending.response;
    assert.equal(refused.status, 409); assert.match((await refused.json()).error, /active workers/);
    assert.equal(existsSync(join(f.folder, ".claude/settings.local.json")), false);
    assert.equal(f.launches, 1);
  } finally { await f.cleanup(); }
});

test("worker metadata cannot admit a run during a native write", async () => {
  let release!: (catalog: CatalogSnapshot) => void, started!: () => void;
  const waiting = new Promise<CatalogSnapshot>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async () => { started(); return waiting; });
  try {
    const preview = await (await f.call(`/api/projects/${f.project.id}/native-settings/preview`, { harness: "codex", field: "model", value: "gpt-6.1-sol" })).json();
    const task = f.call("/api/tasks/start", { projectId: f.project.id, prompt: "fixture", idempotencyKey: "metadata-race", routing: {} });
    await entered;
    writeFileSync(f.gate, "wait");
    const apply = f.call(`/api/projects/${f.project.id}/native-settings/apply`, { previewId: preview.id });
    await waitFor(() => existsSync(f.entered));
    release({ projectId: f.project.id, checkedAt: new Date().toISOString(), harnesses: [] });
    const refused = await task; assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /native settings or plugin change/);
    assert.equal(f.launches, 0); assert.equal(f.service.store.runs().length, 0);
    unlinkSync(f.gate); assert.equal((await apply).status, 200);
    assert.equal(JSON.parse(readFileSync(join(f.codex, "config.toml"), "utf8")).model, "gpt-6.1-sol");
  } finally { release({ projectId: f.project.id, checkedAt: "", harnesses: [] }); await f.cleanup(); }
});

test("required tools with unknown native evidence never start a worker", async () => {
  const f = await fixture(async project => ({ projectId: project.id, checkedAt: new Date().toISOString(), harnesses: [] }));
  try {
    const response = await f.call("/api/tasks/start", { projectId: f.project.id, prompt: "search", harness: "claude", model: "haiku", idempotencyKey: "missing-search", routing: { requiresTools: ["web_search"] } });
    assert.equal(response.status, 409); assert.equal(f.launches, 0); assert.equal(f.service.store.runs().length, 0);
  } finally { await f.cleanup(); }
});
