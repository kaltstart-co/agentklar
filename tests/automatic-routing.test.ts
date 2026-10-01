import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogSnapshot, Project, Run } from "../src/contracts.ts";
import { createService, type WorkerFactory } from "../src/service.ts";

const models = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"];
function snapshot(project: Project, options: { blocked?: boolean; images?: boolean } = {}): CatalogSnapshot {
  return {
    projectId: project.id, checkedAt: "2026-10-01T00:00:00.000Z",
    harnesses: [{
      harness: "codex", modelsStatus: "available", modelsMessage: null,
      modelsTruncated: false,
      models: models.map((id) => ({
        id, name: id, description: "PRIVATE_NATIVE_DESCRIPTION", resolvedModel: null,
        isDefault: false, inputModalities: options.images === false ? ["text"] : ["text", "image"],
      })),
      quota: { status: "available", message: "PRIVATE_QUOTA", ordinaryUsageAllowed: !options.blocked,
        buckets: [] },
    }],
  };
}
function fixture(reader: (project: Project) => Promise<CatalogSnapshot>, operator = false, claude = false) {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-routing-"));
  const home = join(dir, "home");
  const projectPath = join(dir, "project");
  mkdirSync(projectPath);
  const launched: Run[] = [];
  const factory: WorkerFactory = (_command, run) => {
    launched.push(run);
    return { stop: () => {}, closed: Promise.resolve() };
  };
  const make = () => createService(home, 4317, factory, process.execPath, claude ? process.execPath : null,
    async (project) => reader(project), {}, operator ? { id: "service", key: "secret" } : undefined);
  let service = make();
  const call = (path: string, body?: unknown, headers?: Record<string, string>) => service.app.request(
    `http://127.0.0.1:4317${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: headers || { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const register = async () => (await (await call("/api/projects", { name: "routing", path: projectPath })).json()) as Project;
  return {
    get service() { return service; }, launched, call, register,
    restart: async () => { await service.close(); service = make(); },
    cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("automatic launch saves the policy choice, preserves pins, and gives bounded no-choice errors", async () => {
  let catalogReads = 0;
  const t = fixture(async (p) => { catalogReads++; return snapshot(p); });
  try {
    const p = await t.register();
    const update = await t.service.app.request(`http://127.0.0.1:4317/api/projects/${p.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${t.service.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ preference: "economical", roles: [{ id: "pinned", name: "Pinned", harness: "codex", model: "gpt-6-astra", responsibility: "Review" }] }),
    });
    assert.equal(update.status, 200);
    const base = { projectId: p.id, prompt: "complete", idempotencyKey: "economical", routing: {} };
    const response = await t.call("/api/tasks/start", base);
    assert.equal(response.status, 202);
    const run = await response.json() as Run;
    assert.equal(run.model, "gpt-6-luna");
    assert.equal(run.routing?.preference, "economical");
    assert.equal(run.routing?.selected.basis, "policy");
    assert.equal(run.routing?.catalogCheckedAt, "2026-10-01T00:00:00.000Z");
    assert.equal(JSON.stringify(run).includes("PRIVATE_"), false);
    assert.equal(t.launched.length, 1);
    const prior = await t.call("/api/tasks/start", base);
    assert.equal((await prior.json()).id, run.id);
    assert.equal(t.launched.length, 1);
    assert.equal(catalogReads, 1);
    await t.restart();
    const changed = await t.service.app.request(`http://127.0.0.1:4317/api/projects/${p.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${t.service.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ preference: "best" }),
    });
    assert.equal(changed.status, 200);
    const replay = await t.call("/api/tasks/start", base);
    assert.equal((await replay.json()).id, run.id);
    assert.equal(t.launched.length, 1);
    assert.equal(catalogReads, 1);
    const pinned = await t.call("/api/tasks/start", { ...base, idempotencyKey: "pin", roleId: "pinned" });
    assert.equal(pinned.status, 202);
    assert.equal((await pinned.json()).routing.selected.basis, "role-pin");
    await t.restart();
    const taskPin = await t.call("/api/tasks/start", { ...base, idempotencyKey: "task-pin", roleId: "pinned", model: "gpt-6.1-sol" });
    assert.equal(taskPin.status, 202);
    assert.equal((await taskPin.json()).routing.selected.basis, "task-pin");
  } finally { await t.cleanup(); }

  for (const options of [{ blocked: true }, { images: false }]) {
    const t = fixture(async (p) => snapshot(p, options));
    try {
      const p = await t.register();
      const response = await t.call("/api/tasks/start", {
        projectId: p.id, prompt: "inspect image", idempotencyKey: "blocked",
        routing: { requiresImages: true },
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.match(body.error, /No suitable model/);
      assert.match(body.warnings.join(" "), "blocked" in options ? /blocked/ : /image input/);
      assert.equal(JSON.stringify(body).includes("PRIVATE_"), false);
      assert.equal(t.service.store.runs().length, 0);
      assert.equal(t.launched.length, 0);
    } finally { await t.cleanup(); }
  }
});

test("unpinned routing can select another installed harness, while a blocked Codex pin stays fixed", async () => {
  const t = fixture(async (project) => ({
    ...snapshot(project, { blocked: true }),
    harnesses: [
      ...snapshot(project, { blocked: true }).harnesses,
      {
        harness: "claude", modelsStatus: "available", modelsMessage: null, modelsTruncated: false,
        models: [{ id: "sonnet", name: "Sonnet", description: "PRIVATE_CLAUDE_TEXT",
          resolvedModel: "claude-sonnet-4-6", isDefault: false, inputModalities: null }],
        quota: { status: "unavailable", message: null, ordinaryUsageAllowed: null, buckets: [] },
      },
    ],
  }), false, true);
  try {
    const p = await t.register();
    const base = { projectId: p.id, prompt: "complete", idempotencyKey: "cross", routing: {} };
    const response = await t.call("/api/tasks/start", base);
    assert.equal(response.status, 202);
    const run = await response.json() as Run;
    assert.equal(run.harness, "claude");
    assert.equal(run.model, "claude-sonnet-4-6");
    assert.equal(run.routing?.selected.harness, "claude");
    assert.equal(JSON.stringify(run).includes("PRIVATE_"), false);
    await t.restart();
    const blocked = await t.call("/api/tasks/start", {
      ...base, idempotencyKey: "codex-pin", harness: "codex", model: "gpt-6.1-sol",
    });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).reasons.join(" "), /Pinned codex model gpt-6.1-sol/);
    assert.equal(t.service.store.runs().length, 1);
    assert.equal(t.launched.length, 1);
  } finally { await t.cleanup(); }
});

test("Muse catalog rows do not become worker choices and a Muse role pin is rejected", async () => {
  const t = fixture(async (project) => ({
    ...snapshot(project),
    harnesses: [
      ...snapshot(project).harnesses,
      {
        harness: "muse", modelsStatus: "available", modelsMessage: "Muse native model list", modelsTruncated: false,
        models: [{ id: "muse-spark-1.3", name: "Muse Spark", description: "", resolvedModel: null,
          isDefault: true, inputModalities: null }],
        quota: { status: "unavailable", message: null, ordinaryUsageAllowed: null, buckets: [] },
      },
    ],
  }));
  try {
    const p = await t.register();
    const advice = await t.call(`/api/projects/${p.id}/recommend`, { complexity: "standard" });
    assert.equal(advice.status, 200);
    const choices = await advice.json();
    assert.equal(choices.choice.harness, "codex");
    assert.ok(choices.alternatives.every((choice: { harness: string }) => choice.harness !== "muse"));
    const update = await t.service.app.request(`http://127.0.0.1:4317/api/projects/${p.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${t.service.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ roles: [{ id: "muse-role", name: "Muse role", harness: "muse", model: "muse-spark-1.3", responsibility: "Research" }] }),
    });
    assert.equal(update.status, 200);
    const pinned = await t.call("/api/tasks/start", { projectId: p.id, prompt: "Work", idempotencyKey: "muse-pin", roleId: "muse-role", routing: {} });
    assert.equal(pinned.status, 400);
    assert.match((await pinned.json()).error, /no worker adapter/i);
    assert.equal(t.launched.length, 0);
  } finally { await t.cleanup(); }
});

test("concurrent routing rechecks idempotency, busy state, and saved settings after discovery", async () => {
  let release!: (value: CatalogSnapshot) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const metadata = new Promise<CatalogSnapshot>((resolve) => { release = resolve; });
  const t = fixture(async () => { started(); return metadata; });
  try {
    const p = await t.register();
    const base = { projectId: p.id, prompt: "complete", idempotencyKey: "same", routing: {} };
    const first = t.call("/api/tasks/start", base);
    await entered;
    const replay = t.call("/api/tasks/start", base);
    const different = t.call("/api/tasks/start", { ...base, idempotencyKey: "other" });
    const conflicting = t.call("/api/tasks/start", { ...base, prompt: "different input" });
    release(snapshot(p));
    const results = await Promise.all([first, replay, different, conflicting]);
    const ids = await Promise.all(results.slice(0, 2).map(async (r) => (await r.json()).id));
    assert.equal(ids[0], ids[1]);
    assert.equal(results[2]!.status, 409);
    assert.equal(results[3]!.status, 409);
    assert.match((await results[3]!.json()).error, /Idempotency key/);
    assert.equal(t.service.store.runs().length, 1);
    assert.equal(t.launched.length, 1);
  } finally { await t.cleanup(); }

  for (const change of ["manual", "settings"] as const) {
    let release!: (value: CatalogSnapshot) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const metadata = new Promise<CatalogSnapshot>((resolve) => { release = resolve; });
    const t = fixture(async () => { started(); return metadata; });
    try {
      const p = await t.register();
      const pending = t.call("/api/tasks/start", { projectId: p.id, prompt: "auto", idempotencyKey: "auto", routing: {} });
      await entered;
      if (change === "manual") {
        assert.equal((await t.call("/api/tasks/start", { projectId: p.id, prompt: "manual", idempotencyKey: "manual" })).status, 202);
      } else {
        const response = await t.service.app.request(`http://127.0.0.1:4317/api/projects/${p.id}`, {
          method: "PATCH", headers: { Authorization: `Bearer ${t.service.bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ preference: "best" }),
        });
        assert.equal(response.status, 200);
      }
      release(snapshot(p));
      const response = await pending;
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, change === "manual" ? /Project busy/ : /settings changed/);
      assert.equal(t.service.store.runs().length, change === "manual" ? 1 : 0);
    } finally { await t.cleanup(); }
  }
});

test("quiesce and close prevent pending metadata from launching a worker", async () => {
  for (const action of ["quiesce", "close"] as const) {
    let release!: (value: CatalogSnapshot) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const metadata = new Promise<CatalogSnapshot>((resolve) => { release = resolve; });
    const t = fixture(async () => { started(); return metadata; }, true);
    try {
      const p = await t.register();
      const pending = t.call("/api/tasks/start", { projectId: p.id, prompt: "auto", idempotencyKey: "auto", routing: {} });
      await entered;
      if (action === "quiesce") {
        const response = await t.call("/api/operator/quiesce", { force: false }, {
          "x-agentklar-operator-key": "secret", "x-agentklar-service-id": "service", "Content-Type": "application/json",
        });
        assert.equal(response.status, 200);
      } else {
        const closing = t.service.close();
        const resume = await t.call("/api/operator/resume", {}, {
          "x-agentklar-operator-key": "secret", "x-agentklar-service-id": "service", "Content-Type": "application/json",
        });
        assert.equal(resume.status, 503);
        release(snapshot(p));
        assert.equal((await pending).status, 503);
        await closing;
        assert.equal(t.launched.length, 0);
        continue;
      }
      release(snapshot(p));
      assert.equal((await pending).status, 503);
      assert.equal(t.service.store.runs().length, 0);
      assert.equal(t.launched.length, 0);
    } finally { await t.cleanup(); }
  }
});
