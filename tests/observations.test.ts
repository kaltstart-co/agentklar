import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { Store } from "../src/store.ts";
import { createService } from "../src/service.ts";
import { NativeObservations, observationSchema, observationHookScript } from "../src/observations.ts";
import { NativePlugins } from "../src/plugins.ts";
import { nativeFixture } from "./fixtures/native-change.ts";
import type { Project } from "../src/contracts.ts";

const project = (path: string): Project => ({ id: randomUUID(), name: "Fixture", path, preference: "balanced", roles: [], createdAt: "" });
const event = (cwd: string, now = Date.now(), kind = "SessionStart") => observationSchema.parse({ eventId: randomUUID(), session: createHash("sha256").update(randomUUID()).digest("hex"), cwd, event: kind, observedAt: new Date(now).toISOString() });

test("native observation consent, replay, stale ordering and revocation persist without workers", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "observation-"))), home = join(root, "service"), path = join(root, "project");
  mkdirSync(path); let now = Date.now(), store = new Store(home);
  try {
    const p = project(path), token = randomBytes(32).toString("hex"); store.saveProject(p);
    let observations = new NativeObservations(store, () => now), start = event(path, now);
    assert.equal(observations.accept(p.id, token, start), false);
    observations.enable(p, token, "plugin-change");
    assert.equal(observations.accept(p.id, "wrong", start), false);
    assert.equal(observations.accept(p.id, token, { ...start, cwd: root }), false);
    assert.equal(observations.accept(p.id, token, start), true);
    assert.equal(observations.accept(p.id, token, start), true); assert.equal(observations.list().length, 1);
    now += 1000;
    const stop = { ...start, eventId: randomUUID(), event: "Stop" as const, observedAt: new Date(now).toISOString() };
    assert.equal(observations.accept(p.id, token, stop), true); assert.equal(observations.list()[0].state, "idle");
    assert.equal(observations.accept(p.id, token, { ...start, eventId: randomUUID(), event: "UserPromptSubmit" }), true);
    assert.equal(observations.list()[0].state, "idle");
    now += 1000;
    assert.equal(observations.accept(p.id, token, { ...start, eventId: randomUUID(), event: "StopFailure", observedAt: new Date(now).toISOString() }), true);
    assert.equal(observations.list()[0].state, "needs_attention");
    assert.throws(() => observationSchema.parse({ ...start, prompt: "PRIVATE_PROMPT" }));
    assert.equal(observations.accept(p.id, token, { ...start, observedAt: new Date(now + 6000).toISOString() }), false);
    store.close(); store = new Store(home); observations = new NativeObservations(store, () => now);
    assert.equal(observations.list()[0].state, "needs_attention"); assert.equal(observations.status(p.id).enabled, true);
    observations.disable(p.id, "unrelated-plugin"); assert.equal(observations.status(p.id).enabled, true);
    observations.disable(p.id); assert.equal(observations.accept(p.id, token, event(path, now)), false);
    assert.equal(observations.list()[0].trackingEnabled, false);
    now += 300001; assert.equal(observations.list()[0].recent, false);
    assert.equal(store.runs().length, 0); assert.equal(store.approvals().length, 0);
    assert.doesNotMatch(JSON.stringify(store.db.prepare("SELECT data FROM native_observation_grants").all()), new RegExp(token));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recently updated older native sessions survive the 100-session limit", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "observation-retain-"))), store = new Store(join(root, "service"));
  try {
    const p = project(root), token = randomBytes(32).toString("hex"); let now = Date.now(); store.saveProject(p);
    const observations = new NativeObservations(store, () => now); observations.enable(p, token, "plugin");
    const first = event(root, now); observations.accept(p.id, token, first);
    for (let i = 0; i < 99; i++) { now++; observations.accept(p.id, token, event(root, now)); }
    now++; observations.accept(p.id, token, { ...first, eventId: randomUUID(), event: "UserPromptSubmit", observedAt: new Date(now).toISOString() });
    const oldId = observations.list()[0].id;
    now++; observations.accept(p.id, token, event(root, now));
    assert.equal(observations.list().length, 100); assert.ok(observations.list().some(row => row.id === oldId));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("reviewed plugin enables only opted-in observation and undo revokes its narrow token", async () => {
  const f = nativeFixture();
  try {
    const observations = new NativeObservations({ db: f.db, projects: () => [f.project] });
    const plugins = new NativePlugins(f.db, f.home, f.command, { ...f.options, observations, port: 4321 });
    const plain = await plugins.preview(f.project); assert.equal(plain.capabilities.hooks, 0);
    const preview = await plugins.preview(f.project, true); assert.equal(preview.capabilities.hooks, 6);
    assert.equal(observations.status(f.project.id).enabled, false);
    const stage = preview.commands[0][3], cfg = JSON.parse(readFileSync(join(stage, "plugins/agentklar-workflow/scripts/observation.json"), "utf8"));
    assert.ok(cfg.token); assert.ok(!JSON.stringify(preview).includes(cfg.token));
    const applied = await plugins.apply(f.project, preview.id);
    assert.equal(observations.status(f.project.id).enabled, true);
    assert.ok(!JSON.stringify(applied).includes(cfg.token));
    assert.ok(!JSON.stringify(f.db.prepare("SELECT data FROM native_plugin_changes").all()).includes(cfg.token));
    assert.equal(observations.accept(f.project.id, cfg.token, event(f.folder)), true);
    await plugins.undo(f.project, applied.id);
    assert.equal(observations.status(f.project.id).enabled, false);
    assert.equal(observations.accept(f.project.id, cfg.token, event(f.folder)), false);
  } finally { f.close(); }
});

test("bundled hook redacts native input before transport and stays silent", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "observation-hook-"))), received: unknown[] = [];
  const server = createServer(async (req, res) => { let text = ""; for await (const chunk of req) text += chunk; received.push(JSON.parse(text)); res.end("{}"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    writeFileSync(join(root, "observe.cjs"), observationHookScript);
    writeFileSync(join(root, "observation.json"), JSON.stringify({ cwd: root, url: `http://127.0.0.1:${address.port}`, token: "narrow-fixture" }));
    const child = spawn(process.execPath, [join(root, "observe.cjs")], { stdio: "pipe" }); let output = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session", cwd: root, prompt: "PRIVATE_PROMPT", transcript_path: "PRIVATE_TRANSCRIPT", tool_input: "PRIVATE_TOOL" }));
    const [code] = await once(child, "close"); assert.equal(code, 0); assert.equal(output, ""); assert.equal(received.length, 1);
    assert.equal(observationSchema.safeParse(received[0]).success, true);
    assert.doesNotMatch(JSON.stringify(received), /PRIVATE_|transcript|prompt|tool_input/);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("observation endpoint cannot authorize any other API or alter permissions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "observation-api-"))), path = join(root, "project"); mkdirSync(path);
  const service = createService(join(root, "service"), 4317, () => { throw Error("No worker may start"); }, null, null);
  try {
    const p = project(path), token = randomBytes(32).toString("hex"), observations = new NativeObservations(service.store); service.store.saveProject(p); observations.enable(p, token, "fixture");
    const base = "http://127.0.0.1:4317", route = `/api/native-observe/${p.id}`, headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const send = (input: unknown, custom = headers) => service.app.request(base + route, { method: "POST", headers: custom, body: JSON.stringify(input) });
    const accepted = await send(event(path)); assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), {});
    assert.equal((await send(event(path), { ...headers, Origin: base } as typeof headers)).status, 403);
    assert.equal((await send({ ...event(path), prompt: "PRIVATE" })).status, 400);
    assert.equal((await send({ large: "x".repeat(8193) })).status, 413);
    assert.equal((await service.app.request(base + "/api/snapshot", { headers })).status, 401);
    assert.equal((await service.app.request(base + `/api/projects/${p.id}/observations/disable`, { method: "POST", headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" }, body: "{}" })).status, 403);
    const opened = await service.app.request(service.setupUrl), cookie = opened.headers.get("set-cookie")!.split(";")[0];
    const uiHeaders = { cookie, Origin: base, "Content-Type": "application/json" };
    const snapshot = await (await service.app.request(base + "/api/snapshot", { headers: uiHeaders })).json(); assert.equal(snapshot.observedSessions.length, 1);
    assert.equal((await service.app.request(base + `/api/projects/${p.id}/observations/disable`, { method: "POST", headers: uiHeaders, body: "{}" })).status, 200);
    assert.equal((await send(event(path))).status, 403); assert.equal(service.store.runs().length, 0); assert.equal(service.store.approvals().length, 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});


test("remote workspace observation metadata needs its viewing grant and reveals no capability", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "observation-remote-"))), path = join(root, "project"); mkdirSync(path);
  const port = 4317, service = createService(join(root, "service"), port, () => { throw Error("No worker may start"); }, null, null);
  try {
    const otherPath = join(root, "other"); mkdirSync(otherPath);
    const p = project(path), other = project(otherPath), token = randomBytes(32).toString("hex"), observations = new NativeObservations(service.store);
    service.store.saveProject(p); service.store.saveProject(other); observations.enable(p, token, "fixture"); observations.accept(p.id, token, event(path));
    const sourceDeviceId = randomUUID(), base = `http://127.0.0.1:${port}`;
    const opened = await service.app.request(service.setupUrl), cookie = opened.headers.get("set-cookie")!.split(";")[0];
    const headers = { cookie, Origin: base, "Content-Type": "application/json" };
    const snapshot = await (await service.app.request(base + "/api/snapshot", { headers })).json();
    const grant = async (workspaceRead: boolean) => (await service.app.request(base + "/api/remote-settings/grant", {
      method: "POST", headers, body: JSON.stringify({ sourceDeviceId, rootPath: root, workspaceRead }),
    })).json();
    const read = (grant: { grantId: string; token: string }, projectId: string) => service.app.request(base + "/api/peer-setup", {
      method: "POST", headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "setup", version: 1, sourceDeviceId, targetDeviceId: snapshot.device.id,
        grantId: grant.grantId, token: grant.token, requestId: randomUUID(), operation: "projectWorkspace", payload: { projectId } }),
    });
    assert.equal((await read(await grant(false), p.id)).status, 403);
    const allowed = await grant(true), response = await read(allowed, p.id); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.observedSessions.length, 1); assert.equal(body.observedSessions[0].harness, "claude");
    assert.doesNotMatch(JSON.stringify(body), new RegExp(token + "|tokenHash|ownerId|PRIVATE_PROMPT"));
    assert.equal((await (await read(allowed, other.id)).json()).observedSessions.length, 0);
    assert.equal(service.store.runs().length, 0); assert.equal(service.store.approvals().length, 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
