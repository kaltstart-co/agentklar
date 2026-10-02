import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createService } from "../src/service.ts";
import { RoutingPresets, routingRulesSchema } from "../src/routing-presets.ts";
import { Peers } from "../src/peers.ts";
import { deviceSettings } from "../src/devices.ts";
import { recommendWorker, recommendationSchema } from "../src/recommend.ts";
import type { Project, RoutingPreset, RoutingRules, Run, CatalogSnapshot } from "../src/contracts.ts";

const rules: RoutingRules = { routine: "balanced", standard: "efficient", hard: "capable", adjustToAllowance: false, lowAllowancePercent: 10, highAllowancePercent: 70 };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-presets-"));
  const launches: Run[] = [];
  const make = () => createService(join(dir, "home"), 4317, (_cmd, run, _path, callbacks) => {
    launches.push(run); callbacks.update({ state: "completed" });
    return { stop() {}, closed: Promise.resolve().then(() => callbacks.done()) };
  }, process.execPath, null, async project => ({ projectId: project.id, checkedAt: new Date().toISOString(), harnesses: [{
    harness: "codex", modelsStatus: "available", modelsMessage: null, modelsTruncated: false,
    models: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].map(id => ({ id, name: id, description: "", resolvedModel: null, isDefault: false, inputModalities: ["text"] })),
    quota: { status: "available", message: null, ordinaryUsageAllowed: true, buckets: [] },
  }] }), {}, undefined, {}, {}, null, {}, null);
  let service = make();
  const call = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) => service.app.request(`http://127.0.0.1:4317${path}`, {
    method, headers: headers ?? { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { dir, launches, call, get service() { return service; },
    register: async () => await (await call("/api/projects", "POST", { name: "Presets", path: dir })).json() as Project,
    restart: async () => { await service.close(); service = make(); },
    close: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("preset API validates custom rules, protects builtins, and saves project snapshots across restart", async () => {
  const f = fixture();
  try {
    assert.deepEqual((await (await f.call("/api/routing-presets")).json()).map((preset: RoutingPreset) => preset.id), ["economical", "balanced", "best"]);
    assert.equal((await f.call("/api/routing-presets", "POST", { name: "", rules })).status, 400);
    for (const changed of [{ lowAllowancePercent: -1 }, { highAllowancePercent: 101 }, { lowAllowancePercent: 70 }, { routine: "unknown" }, { extra: true }])
      assert.equal((await f.call("/api/routing-presets", "POST", { name: "Invalid", rules: { ...rules, ...changed } })).status, 400);
    assert.equal((await f.call("/api/routing-presets", "POST", { name: "Bad\nName", rules })).status, 400);
    const created = await f.call("/api/routing-presets", "POST", { name: " My rules ", rules });
    assert.equal(created.status, 201);
    const preset = await created.json() as RoutingPreset;
    assert.match(preset.id, /^[a-f0-9-]{36}$/); assert.equal(preset.name, "My rules");
    assert.equal((await f.call("/api/routing-presets/balanced", "PUT", { name: "Replace", rules })).status, 403);
    assert.equal((await f.call(`/api/routing-presets/${randomUUID()}`, "PUT", { name: "Missing", rules })).status, 404);
    const project = await f.register();
    const route = `/api/projects/${project.id}`;
    assert.equal((await f.call(route, "PATCH", { routingPresetId: "missing" })).status, 404);
    assert.equal((await f.call(route, "PATCH", { routingPresetId: preset.id, preference: "best" })).status, 400);
    const applied = await (await f.call(route, "PATCH", { routingPresetId: preset.id, delegationMode: "automatic" })).json() as Project;
    assert.deepEqual(applied.routingPreset, preset); assert.equal(applied.preference, "balanced");
    const routed = await f.call("/api/tasks/start", "POST", { projectId: project.id, prompt: "Route fake work", idempotencyKey: "preset", routing: { complexity: "standard" } });
    assert.equal(routed.status, 202);
    const run = await routed.json() as Run;
    assert.equal(run.model, "gpt-6-luna"); assert.deepEqual(run.routing?.routingPreset, { id: preset.id, name: preset.name });
    const changed = await (await f.call(`/api/routing-presets/${preset.id}`, "PUT", { name: "New rules", rules: { ...rules, standard: "capable" } })).json() as RoutingPreset;
    assert.equal(changed.id, preset.id);
    assert.deepEqual(f.service.store.projects()[0].routingPreset, preset);
    assert.deepEqual(f.service.store.run(run.id)?.routing?.routingPreset, { id: preset.id, name: preset.name });
    const roles = [{ id: "review", name: "Review", harness: "codex", responsibility: "Review" }];
    assert.deepEqual((await (await f.call(route, "PATCH", { roles })).json()).routingPreset, preset);
    await f.restart();
    assert.deepEqual((await (await f.call("/api/routing-presets")).json()).at(-1), changed);
    assert.deepEqual(f.service.store.projects()[0].routingPreset, preset);
    assert.equal(f.service.store.projects()[0].delegationMode, "automatic");
    const legacy = await (await f.call(route, "PATCH", { preference: "economical" })).json() as Project;
    assert.equal(legacy.routingPreset, undefined); assert.deepEqual(legacy.roles, roles);
    const builtin = await (await f.call(route, "PATCH", { routingPresetId: "best" })).json() as Project;
    assert.equal(builtin.preference, "best"); assert.equal(builtin.routingPreset?.id, "best");
  } finally { await f.close(); }
});

test("custom preset storage caps creation at 50 and allows updates at the limit", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const presets = new RoutingPresets(db);
    for (let index = 0; index < 50; index++) presets.save({ name: `Preset ${index}`, rules });
    assert.equal(presets.list().length, 53);
    assert.throws(() => presets.save({ name: "Overflow", rules }), /At most 50/);
    const id = presets.list().at(-1)!.id;
    assert.equal(presets.save({ name: "Updated", rules }, id).id, id);
    assert.equal(routingRulesSchema.safeParse({ ...rules, lowAllowancePercent: NaN }).success, false);
    assert.equal(routingRulesSchema.safeParse({ ...rules, highAllowancePercent: Infinity }).success, false);
  } finally { db.close(); }
});

test("snapshot rules choose actual model tiers and apply custom allowance thresholds", () => {
  const now = Date.now();
  const project: Project = { id: randomUUID(), name: "Rules", path: tmpdir(), preference: "balanced", roles: [], createdAt: new Date(now).toISOString(), routingPreset: { id: randomUUID(), name: "Custom", rules } };
  const advise = (complexity: "routine" | "standard" | "hard", remaining: number | null = null, override: Partial<RoutingRules> = {}) => {
    const snapshot: CatalogSnapshot = { projectId: project.id, checkedAt: new Date(now).toISOString(), harnesses: [{ harness: "codex", modelsStatus: "available", modelsMessage: null, modelsTruncated: false,
      models: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].map(id => ({ id, name: id, description: "", resolvedModel: null, isDefault: false, inputModalities: ["text"] })),
      quota: { status: "available", message: null, ordinaryUsageAllowed: true, buckets: remaining === null ? [] : [{ id: "codex", name: null, normalModel: null, spendControlReached: null, primary: { usedPercent: 100 - remaining, windowDurationMins: 300, resetsAt: now / 1000 + 300 }, secondary: null }] },
    }] };
    return recommendWorker({ ...project, routingPreset: { ...project.routingPreset!, rules: { ...rules, ...override } } }, recommendationSchema.parse({ complexity }), snapshot, { codex: true, claude: false }, now);
  };
  assert.equal(advise("routine").choice?.model, "gpt-6.1-sol");
  assert.equal(advise("standard").choice?.model, "gpt-6-luna");
  assert.equal(advise("hard").choice?.model, "gpt-6-astra");
  assert.equal(advise("hard", null, { hard: "efficient" }).choice?.model, "gpt-6-luna");
  assert.equal(advise("hard", 10, { adjustToAllowance: true }).choice?.tier, "balanced");
  assert.equal(advise("routine", 10, { adjustToAllowance: true }).choice?.tier, "efficient");
  assert.equal(advise("standard", 70, { adjustToAllowance: true }).choice?.tier, "capable");
  assert.equal(advise("routine", 70, { adjustToAllowance: true }).choice?.tier, "balanced");
  assert.equal(advise("standard", 69, { adjustToAllowance: true }).choice?.tier, "efficient");
  assert.deepEqual(advise("routine").routingPreset, { id: project.routingPreset!.id, name: "Custom" });
});

test("manual projects block new MCP launches, allow human requests and UI starts, and preserve idempotent returns", async () => {
  const f = fixture();
  try {
    const project = await f.register();
    assert.equal(project.delegationMode, undefined);
    const route = "/api/tasks/start";
    const task = { projectId: project.id, prompt: "Fake worker", idempotencyKey: "manual" };
    assert.equal((await f.call(route, "POST", task)).status, 403);
    assert.equal(f.launches.length, 0);
    assert.equal((await f.call(route, "POST", { ...task, delegation: "automatic" })).status, 400);
    const spoofed = { Authorization: `Bearer ${f.service.bearer}`, "Content-Type": "application/json", "x-agentklar-peer-internal": "fake" };
    assert.equal((await f.call(route, "POST", task, spoofed)).status, 403);
    const mapping = { id: randomUUID(), projectId: project.id, label: "Fixture", deviceId: randomUUID(), sshHost: "fixture", command: "agentklar", remoteProjectId: randomUUID(), grantId: randomUUID(), grantToken: "a".repeat(64) };
    f.service.store.db.prepare("INSERT INTO peer_connections(id,data) VALUES(?,?)").run(mapping.id, JSON.stringify(mapping));
    assert.equal((await f.call("/api/peers/dispatch", "POST", { peerId: mapping.id, idempotencyKey: "blocked-peer", baseCommit: "a".repeat(40), task: { prompt: "Fake remote worker" } })).status, 403);
    const requested = { ...task, delegation: "requested" };
    const first = await f.call(route, "POST", requested); assert.equal(first.status, 202);
    const run = await first.json() as Run;
    assert.equal((await (await f.call(route, "POST", requested)).json()).id, run.id); assert.equal(f.launches.length, 1);
    assert.equal((await (await f.call(route, "POST", task)).json()).id, run.id); assert.equal(f.launches.length, 1);
    const setup = await f.service.app.request(f.service.setupUrl);
    const ui = { Cookie: setup.headers.get("set-cookie")!.split(";")[0]!, Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" };
    const uiTask = { ...task, idempotencyKey: "ui" };
    const uiReply = await f.call(route, "POST", uiTask, ui); assert.equal(uiReply.status, 202);
    const uiRun = await uiReply.json() as Run;
    assert.equal((await (await f.call(route, "POST", uiTask)).json()).id, uiRun.id);
    await f.call(`/api/projects/${project.id}`, "PATCH", { delegationMode: "automatic" });
    assert.equal((await f.call(route, "POST", { ...task, idempotencyKey: "automatic" })).status, 202);
    assert.equal(f.launches.length, 3);
    await f.call(`/api/projects/${project.id}`, "PATCH", { delegationMode: "manual" });
    assert.equal((await f.call(route, "POST", { ...task, idempotencyKey: "automatic" })).status, 200);
    assert.equal((await f.call(route, "POST", { ...task, idempotencyKey: "blocked-again" })).status, 403);
  } finally { await f.close(); }
});

test("a scoped peer grant can launch on a manual owner project without a forwarded request marker", async () => {
  const f = fixture();
  try {
    const path = join(f.dir, "repo"); mkdirSync(path);
    const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(path, "README"), "Fixture"); git("add", "README"); git("commit", "-m", "Fixture");
    const project: Project = { id: randomUUID(), name: "Owner", path: realpathSync(path), preference: "balanced", roles: [], createdAt: new Date().toISOString() };
    f.service.store.saveProject(project);
    const device = deviceSettings(f.service.store.db).device;
    const peers = new Peers(f.service.store, device, async () => { throw new Error("Use the service's scoped owner path."); });
    const sourceDeviceId = randomUUID();
    const grant = peers.grant({ sourceDeviceId, projectId: project.id });
    const response = await f.call("/api/peer", "POST", { version: 1, sourceDeviceId, targetDeviceId: device.id,
      grantId: grant.id, token: grant.token, operation: "start", requestId: randomUUID(), baseCommit: git("rev-parse", "HEAD"), task: { prompt: "Scoped fake worker", harness: "codex" } });
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal(f.service.store.projects().find(p => p.id === project.id)?.delegationMode, undefined);
    for (let attempt = 0; attempt < 100 && !f.launches.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.launches.length, 1);
  } finally { await f.close(); }
});
