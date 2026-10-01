import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/service.ts";
import { benchmarkSources } from "../src/benchmarks.ts";
import type { Project, Run } from "../src/contracts.ts";

const categories = { Reasoning: ["theory_of_mind", "zebra_puzzle", "spatial", "logic_with_navigation"], Coding: ["code_generation", "code_completion"], "Agentic Coding": ["javascript", "typescript", "python"], Mathematics: ["AMPS_Hard", "integrals_with_game", "math_comp", "olympiad"], "Data Analysis": ["consecutive_events", "tablejoin", "tablereformat"], Language: ["connections", "plot_unscrambling", "typos"], IF: ["paraphrase", "simplify", "story_generation", "summarize"] };
const columns = Object.values(categories).flat();
const csv = ["model," + columns.join(","), ...["gpt-6.1-sol-max", "gpt-6-sol-max"].map((id, i) => id + "," + columns.map(col => categories["Agentic Coding"].includes(col) ? 50 + i * 20 : 60 - i * 10).join(","))].join("\n");
test("benchmark API refresh is explicit, authenticated, fixed-source, durable and drives compact run evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-benchmark-api-"));
  const home = join(dir, "home"), path = join(dir, "project"); mkdirSync(path);
  let calls = 0, fail = false;
  const launched: Run[] = [];
  const make = () => createService(home, 4317, (_cmd, run) => { launched.push(run); return { stop() {}, closed: Promise.resolve() }; }, process.execPath, null,
    async (project) => ({ projectId: project.id, checkedAt: new Date().toISOString(), harnesses: [{ harness: "codex", modelsStatus: "available", modelsMessage: null, modelsTruncated: false,
      models: ["gpt-6.1-sol", "gpt-6-sol"].map(id => ({ id, name: id, description: "PRIVATE_NATIVE", resolvedModel: null, isDefault: false, inputModalities: ["text"] })),
      quota: { status: "available", message: null, ordinaryUsageAllowed: true, buckets: [] } }] }), {}, undefined, {}, {
      fetcher: async (url, options) => { calls++; assert.ok(Object.values(benchmarkSources).includes(String(url))); assert.equal(options?.body, undefined); assert.equal(options?.credentials, "omit"); if (fail) throw new Error("offline"); return new Response(String(url).endsWith(".csv") ? csv : JSON.stringify(categories)); },
    });
  let service = make();
  const call = (route: string, body?: unknown, headers?: Record<string, string>) => service.app.request(`http://127.0.0.1:4317${route}`, { method: body === undefined ? "GET" : "POST", headers: headers || { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await call("/api/benchmarks", undefined, {})).status, 401);
    assert.equal((await call("/api/benchmarks?url=https://example.com")).status, 400);
    assert.equal((await call("/api/benchmarks/refresh?release=new", {})).status, 400);
    const seed = await (await call("/api/benchmarks")).json(); assert.ok(seed.models.length); assert.equal(calls, 0);
    assert.equal((await call("/api/benchmarks/refresh", { url: "https://example.com", project: "PRIVATE" })).status, 400); assert.equal(calls, 0);
    const setup = await service.app.request(service.setupUrl);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await call("/api/benchmarks/refresh", {}, { Cookie: cookie, "Content-Type": "application/json" })).status, 403);
    assert.equal((await call("/api/benchmarks/refresh", {}, { Cookie: cookie, Origin: "https://example.com", "Content-Type": "application/json" })).status, 403);
    const refreshes = await Promise.all([call("/api/benchmarks/refresh", {}), call("/api/benchmarks/refresh", {})]);
    assert.ok(refreshes.every(response => response.status === 200)); assert.equal(calls, 2);
    const refreshed = await refreshes[0].json();
    fail = true; assert.equal((await call("/api/benchmarks/refresh", {})).status, 503);
    assert.deepEqual(await (await call("/api/benchmarks")).json(), refreshed);
    const p = await (await call("/api/projects", { name: "benchmarks", path })).json() as Project;
    const advice = await (await call(`/api/projects/${p.id}/recommend`, { taskType: "coding" })).json();
    assert.equal(advice.choice.model, "gpt-6-sol"); assert.equal(advice.benchmarkMethod, "reference-tie-break");
    const reasoning = await (await call(`/api/projects/${p.id}/recommend`, { taskType: "reasoning" })).json(); assert.equal(reasoning.choice.model, "gpt-6.1-sol");
    const beforeStart = calls;
    const reply = await call("/api/tasks/start", { projectId: p.id, prompt: "PRIVATE_PROJECT", idempotencyKey: "measured", routing: { taskType: "coding" } }); assert.equal(reply.status, 202);
    const run = await reply.json() as Run;
    assert.equal(run.routing?.selected.benchmark?.metric, "Agentic Coding"); assert.equal(run.routing?.selected.benchmark?.score, 70);
    assert.equal(run.routing?.taskType, "coding"); assert.equal(run.routing?.benchmarkMethod, "reference-tie-break"); assert.equal(calls, beforeStart);
    assert.equal(JSON.stringify(run.routing).includes("PRIVATE_NATIVE"), false); assert.equal(JSON.stringify(run.routing).includes('"models"'), false);
    assert.equal(launched.length, 1);
    await service.close(); service = make();
    assert.deepEqual(await (await call("/api/benchmarks")).json(), refreshed);
    assert.deepEqual(service.store.run(run.id)?.routing, run.routing);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
