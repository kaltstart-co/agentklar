import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync, symlinkSync, linkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/service.ts";
import { Instructions } from "../src/instructions.ts";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-instructions-"));
  const project = join(dir, "project"); mkdirSync(project);
  const home = join(dir, "home");
  let starts = 0;
  let service = createService(home, 4317, () => { starts++; return { stop() {} }; }, null, null);
  let cookie = "";
  async function setup() {
    const response = await service.app.request(service.setupUrl);
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  }
  await setup();
  const headers = () => ({ Cookie: cookie, Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" });
  const call = (path: string, method = "GET", body?: unknown, auth: Record<string, string> = headers()) => service.app.request(`http://127.0.0.1:4317${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const p = await (await call("/api/projects", "POST", { name: "test", path: project })).json();
  const base = `/api/projects/${p.id}/instructions`;
  const preview = async (text: string, expectedHash: string | null = null, file = "agents") => (await call(`${base}/preview`, "POST", { file, text, expectedHash })).json();
  const apply = async (previewId: string) => (await call(`${base}/apply`, "POST", { previewId })).json();
  return { dir, home, project, p, base, call, preview, apply, get service() { return service; }, get starts() { return starts; }, get cookie() { return cookie; }, restart: async () => { await service.close(); service = createService(home, 4317, () => { starts++; return { stop() {} }; }, null, null); await setup(); }, cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("instruction create, modify, durable undo and metadata-only inventory start no workers", async () => {
  const f = await fixture();
  try {
    const inventory = await (await f.call(f.base)).json();
    assert.equal(inventory.files.length, 2); assert.ok(inventory.files.every((x: { status: string }) => x.status === "missing"));
    const missing = await (await f.call(`${f.base}/agents`)).json(); assert.equal(missing.exists, false); assert.equal(missing.hash, null);
    const draft = await f.preview("private native instructions");
    assert.equal(draft.before, null); assert.equal(statExists(join(f.project, "AGENTS.md")), false);
    const createUmask = process.umask(0o077);
    let first;
    try { first = await f.apply(draft.id); } finally { process.umask(createUmask); }
    assert.equal(first.state, "applied"); assert.equal(statSync(join(f.project, "AGENTS.md")).mode & 0o777, 0o600);
    chmodSync(join(f.project, "AGENTS.md"), 0o666);
    const loaded = await (await f.call(`${f.base}/agents`)).json();
    const secondDraft = await f.preview("\ufeffnew instruction text\n", loaded.hash);
    const oldUmask = process.umask(0o077);
    let second;
    try { second = await f.apply(secondDraft.id); } finally { process.umask(oldUmask); }
    assert.equal(second.state, "applied"); assert.equal(statSync(join(f.project, "AGENTS.md")).mode & 0o777, 0o666);
    assert.equal(readFileSync(join(f.project, "AGENTS.md"), "utf8"), "\ufeffnew instruction text\n");
    await f.restart();
    const history = await (await f.call(f.base)).json(); assert.equal(history.changes.length, 2); assert.equal(JSON.stringify(history).includes("native instructions"), false); assert.equal(JSON.stringify(history).includes("new instruction text"), false);
    const undo = await (await f.call(`${f.base}/rollback`, "POST", { changeId: second.id })).json(); assert.equal(undo.state, "rolled_back"); assert.equal(readFileSync(join(f.project, "AGENTS.md"), "utf8"), loaded.text); assert.equal(statSync(join(f.project, "AGENTS.md")).mode & 0o777, 0o666);
    assert.equal((await f.call(`${f.base}/rollback`, "POST", { changeId: second.id })).status, 409);
    chmodSync(join(f.project, "AGENTS.md"), 0o600);
    assert.equal((await f.call(`${f.base}/rollback`, "POST", { changeId: first.id })).status, 200); assert.equal(statExists(join(f.project, "AGENTS.md")), false);
    assert.equal(JSON.stringify(await (await f.call("/api/snapshot")).json()).includes("instruction text"), false);
    assert.equal(f.service.store.context(f.p.id).revision, 0); assert.equal(f.starts, 0); assert.equal(f.service.store.runs().length, 0);
  } finally { await f.cleanup(); }
});
function statExists(path: string) { try { statSync(path); return true; } catch { return false; } }
test("external text and permission changes survive preview, apply and rollback conflicts", async () => {
  const f = await fixture(); const path = join(f.project, "AGENTS.md");
  try {
    const draft = await f.preview("my draft"); writeFileSync(path, "external edit");
    assert.equal((await f.call(`${f.base}/apply`, "POST", { previewId: draft.id })).status, 409); assert.equal(readFileSync(path, "utf8"), "external edit");
    assert.equal((await f.call(`${f.base}/preview`, "POST", { file: "agents", text: "my draft", expectedHash: null })).status, 409);
    const loaded = await (await f.call(`${f.base}/agents`)).json(); const next = await f.preview("mine", loaded.hash);
    chmodSync(path, 0o600); assert.equal((await f.call(`${f.base}/apply`, "POST", { previewId: next.id })).status, 409); assert.equal(statSync(path).mode & 0o777, 0o600);
    const changed = await f.apply((await f.preview("mine", loaded.hash)).id); writeFileSync(path, "external later");
    assert.equal((await f.call(`${f.base}/rollback`, "POST", { changeId: changed.id })).status, 409); assert.equal(readFileSync(path, "utf8"), "external later");
    writeFileSync(path, "mine"); chmodSync(path, 0o644); assert.equal((await f.call(`${f.base}/rollback`, "POST", { changeId: changed.id })).status, 409);
    assert.equal(statSync(path).mode & 0o777, 0o644);
  } finally { await f.cleanup(); }
});
test("instruction boundaries reject MCP content/writes, missing UI Origin, remote CORS and invalid input", async () => {
  const f = await fixture();
  try {
    const bearer = { Authorization: `Bearer ${f.service.bearer}`, Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" };
    assert.equal((await f.call(f.base, "GET", undefined, bearer)).status, 200);
    assert.equal((await f.call(`${f.base}/agents`, "GET", undefined, bearer)).status, 403);
    for (const op of ["preview", "apply", "rollback"]) assert.equal((await f.call(`${f.base}/${op}`, "POST", {}, bearer)).status, 403);
    assert.equal((await f.call(f.base, "GET", undefined, {})).status, 401);
    const setup = await f.service.app.request("http://127.0.0.1:4317/api/projects"); assert.equal(setup.status, 401);
    assert.equal((await f.call(`${f.base}/preview`, "POST", {}, { Cookie: f.cookie, "Content-Type": "application/json" })).status, 403);
    assert.equal((await f.call(`${f.base}/agents`, "GET", undefined, { ...bearer, Cookie: f.cookie })).status, 403);
    assert.equal((await f.call(`${f.base}/preview`, "POST", {}, { Origin: "https://evil.example", Cookie: "x" })).status, 403);
    assert.equal((await f.call(`${f.base}/agents/extra`, "POST", {}, bearer)).status, 403);
    assert.equal((await f.call(`${f.base}/unknown`)).status, 400);
    for (const body of [{ file: "gemini", text: "x", expectedHash: null }, { file: "../other", text: "x", expectedHash: null }, { file: "agents", text: "x", expectedHash: null, path: "/tmp/other" }, { file: "agents", text: "x" }]) assert.equal((await f.call(`${f.base}/preview`, "POST", body)).status, 400);
    assert.equal((await f.call(`/api/projects/${randomUUID()}/instructions`)).status, 404);
    assert.equal((await f.call(`${f.base}/apply`, "POST", { previewId: randomUUID() })).status, 404);
    const draft = await f.preview("x"); assert.equal((await f.call(`${f.base}/apply`, "POST", { previewId: draft.id, extra: true })).status, 400);
  } finally { await f.cleanup(); }
});
test("instruction reads reject symlinks, directories, hardlinks and changed project roots", async () => {
  const f = await fixture(); const path = join(f.project, "AGENTS.md"); const outside = join(f.dir, "outside.md"); writeFileSync(outside, "outside");
  try {
    symlinkSync(outside, path); assert.equal((await f.call(`${f.base}/agents`)).status, 422); rmSync(path);
    mkdirSync(path); assert.equal((await f.call(`${f.base}/agents`)).status, 422); rmSync(path, { recursive: true });
    linkSync(outside, path); assert.equal((await f.call(`${f.base}/agents`)).status, 422); rmSync(path);
    const draft = await f.preview("draft");
    renameSync(f.project, join(f.dir, "original")); symlinkSync(join(f.dir, "original"), f.project);
    assert.equal((await f.call(`${f.base}/apply`, "POST", { previewId: draft.id })).status, 422); assert.equal(readFileSync(outside, "utf8"), "outside");
    const list = await (await f.call(f.base)).json(); assert.ok(list.files.every((x: { status: string }) => x.status === "unavailable"));
  } finally { await f.cleanup(); }
});
test("instruction UTF-8 byte limit preserves BOM and rejects binary, malformed UTF-8 and invalid Unicode", async () => {
  const f = await fixture(); const path = join(f.project, "AGENTS.md");
  try {
    assert.equal((await f.call(`${f.base}/preview`, "POST", { file: "agents", text: "é".repeat(16385), expectedHash: null })).status, 400);
    for (const text of ["nul\0text", "\ud800", "binary\x01"]) assert.equal((await f.call(`${f.base}/preview`, "POST", { file: "agents", text, expectedHash: null })).status, 400);
    writeFileSync(path, Buffer.from([0xff, 0xfe])); assert.equal((await f.call(`${f.base}/agents`)).status, 422);
    writeFileSync(path, Buffer.alloc(32769, 65)); assert.equal((await f.call(`${f.base}/agents`)).status, 422);
    writeFileSync(path, "\ufeffinstructions"); const doc = await (await f.call(`${f.base}/agents`)).json(); assert.equal(doc.text, "\ufeffinstructions"); assert.equal(doc.bytes, 15);
    writeFileSync(path, "a".repeat(32768)); assert.equal((await f.call(`${f.base}/agents`)).status, 200);
  } finally { await f.cleanup(); }
});
test("prepared journal survives restart without silent recovery and permits explicit verified undo", async () => {
  const f = await fixture(); const path = join(f.project, "AGENTS.md");
  try {
    const change = await f.apply((await f.preview("saved after text")).id);
    const row = f.service.store.db.prepare("SELECT data FROM instruction_changes WHERE id=?").get(change.id)!;
    const saved = JSON.parse(row.data as string); assert.equal(saved.afterText, "saved after text"); assert.equal(saved.beforeText, null);
    saved.state = "prepared";
    f.service.store.db.prepare("UPDATE instruction_changes SET data=? WHERE id=?").run(JSON.stringify(saved), change.id);
    await f.restart(); assert.equal(readFileSync(path, "utf8"), "saved after text");
    const list = await (await f.call(f.base)).json(); assert.equal(list.changes[0].state, "interrupted"); assert.match(list.changes[0].message, /not recovered automatically/);
    assert.equal((await f.call(`${f.base}/rollback`, "POST", { changeId: change.id })).status, 200); assert.equal(statExists(path), false);
  } finally { await f.cleanup(); }
});
test("preview expiry/cap and 50-change retention preserve unfinished journals and expose only 20 metadata rows", async () => {
  const f = await fixture();
  try {
    const manager = new Instructions(f.service.store.db);
    const old = Date.now; let current = old(); Date.now = () => current;
    try { const preview = manager.preview(f.p, "agents", "x", null); current += 600001; assert.throws(() => manager.apply(f.p, preview.id), /expired/); }
    finally { Date.now = old; }
    const first = manager.preview(f.p, "agents", "x", null);
    for (let i = 0; i < 100; i++) manager.preview(f.p, "agents", "x", null);
    assert.throws(() => manager.apply(f.p, first.id), /not found/);
    let expected: string | null = null;
    for (let i = 0; i < 52; i++) { const change = manager.apply(f.p, manager.preview(f.p, "agents", String(i), expected).id); expected = change.afterHash; if (i === 0) { const row = f.service.store.db.prepare("SELECT data FROM instruction_changes WHERE id=?").get(change.id)!; const data = JSON.parse(row.data as string); data.state = "interrupted"; f.service.store.db.prepare("UPDATE instruction_changes SET data=? WHERE id=?").run(JSON.stringify(data), change.id); } }
    assert.equal(manager.list(f.p).changes.length, 20);
    assert.equal(f.service.store.db.prepare("SELECT COUNT(*) AS n FROM instruction_changes").get()!.n, 51);
  } finally { await f.cleanup(); }
});
test("Codex override presence is disclosed without reading or editing its contents", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.project, "AGENTS.md"), "root text"); writeFileSync(join(f.project, "AGENTS.override.md"), "PRIVATE_OVERRIDE_BODY");
    const list = await (await f.call(f.base)).json(); assert.equal(list.files[0].status, "present"); assert.match(list.files[0].message, /AGENTS.override.md exists/); assert.equal(JSON.stringify(list).includes("PRIVATE_OVERRIDE_BODY"), false);
    assert.equal((await f.call(`${f.base}/override`)).status, 400);
  } finally { await f.cleanup(); }
});
