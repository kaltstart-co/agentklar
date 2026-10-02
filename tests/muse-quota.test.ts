import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMuseQuota } from "../src/muse-quota.ts";
import { readMuseCatalog, withObservedMuseQuota } from "../src/catalog.ts";
import { recommendWorker, recommendationSchema } from "../src/recommend.ts";
import type { CatalogSnapshot, Run, Project } from "../src/contracts.ts";

const observed = Date.UTC(2026, 9, 2);
const payload = { usage: { observedAtMs: observed, tier: "PRIVATE_TIER", accountId: "PRIVATE_ACCOUNT",
  weekly: { usedPercent: 0, resetsAtMs: observed + 7 * 86400_000 },
  window: { usedPercent: 112, resetsAtMs: observed + 5 * 3600_000, windowDurationMins: 300 }, credits: "PRIVATE_CREDITS" } };

test("Muse quota preserves explicit zero, documented over-quota percentages and host observation time", () => {
  const quota = parseMuseQuota(payload);
  assert.equal(quota.status, "available");
  assert.equal(quota.observedAt, new Date(observed).toISOString());
  assert.equal(quota.ordinaryUsageAllowed, null);
  assert.equal(quota.buckets[0].primary?.usedPercent, 112);
  assert.equal(quota.buckets[0].secondary?.usedPercent, 0);
  assert.equal(quota.buckets[0].primary?.resetsAt, (observed + 5 * 3600_000) / 1000);
  assert.match(quota.message!, /not a live balance/);
  assert.doesNotMatch(JSON.stringify(quota), /PRIVATE_/);
});

test("Muse missing or invalid observations remain unavailable, never zero", () => {
  for (const value of [{}, { usage: null }, { usage: { ...payload.usage, observedAtMs: Infinity } },
    { usage: { ...payload.usage, window: { ...payload.usage.window, windowDurationMins: 0 } } },
    { usage: { ...payload.usage, weekly: { ...payload.usage.weekly, usedPercent: -1 } } },
    { usage: { ...payload.usage, weekly: { ...payload.usage.weekly, resetsAtMs: 9e15 } } }]) {
    const quota = parseMuseQuota(value);
    assert.equal(quota.status, "unavailable"); assert.equal(quota.ordinaryUsageAllowed, null);
    assert.deepEqual(quota.buckets, []);
  }
});

test("Pinned Muse MSP explicitly requires integer percentages; fractions stay unknown", () => {
  // SDK1.4.2 SubscriptionUsageWeekly/Window: integer >= 0, over100 is valid.
  for (const usage of [
    { ...payload.usage, weekly: { ...payload.usage.weekly, usedPercent: 0.5 } },
    { ...payload.usage, window: { ...payload.usage.window, usedPercent: 112.5 } },
    { ...payload.usage, weekly: { ...payload.usage.weekly, usedPercent: Infinity } },
    { ...payload.usage, observedAtMs: observed + 0.5 },
    { ...payload.usage, window: { ...payload.usage.window, windowDurationMins: 300.5 } },
  ]) {
    const quota = parseMuseQuota({ usage });
    assert.equal(quota.status, "unavailable");
    assert.deepEqual(quota.buckets, []);
    assert.equal(quota.ordinaryUsageAllowed, null);
  }
});

test("Older completed-worker usage cannot overwrite a newer native catalog observation", () => {
  const snapshot: CatalogSnapshot = { projectId: "p", checkedAt: new Date(observed).toISOString(), harnesses: [{ harness: "muse", models: [], modelsStatus: "available", modelsMessage: null, modelsTruncated: false, quota: parseMuseQuota(payload) }] };
  const run = { harness: "muse", museSubscriptionUsage: { observedAtMs: observed - 1,
    weekly: { usedPercent: 80, resetsAtMs: observed + 1000 }, window: { usedPercent: 80, resetsAtMs: observed + 1000, windowDurationMins: 300 } } } as Run;
  assert.deepEqual(withObservedMuseQuota(snapshot, [run]).harnesses[0].quota, snapshot.harnesses[0].quota);
  run.museSubscriptionUsage!.observedAtMs = observed + 1;
  assert.equal(withObservedMuseQuota(snapshot, [run]).harnesses[0].quota.buckets[0].primary?.usedPercent, 80);
});

test("Muse catalog reads only discovery RPCs; model and usage failures stay independent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-muse-quota-"));
  const file = join(dir, "native.mjs"), log = join(dir, "calls");
  writeFileSync(file, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
const [mode,log]=process.argv.slice(2); createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line); appendFileSync(log,JSON.stringify(r)+'\\n'); if(r.method==='initialized')return;
const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
const fail=()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{message:'PRIVATE_TOKEN'}})+'\\n');
if(r.method==='initialize')return reply({});
if(r.method==='model/list')return mode==='models-fail'?fail():reply({source:'providerCatalog',providerId:'muse',profileId:null,models:[{modelId:'native',displayLabel:'Native',providerId:'muse',profileId:null}]});
if(r.method==='usage/read')return mode==='quota-fail'?fail():reply(${JSON.stringify(payload)});
throw Error('Unexpected RPC'); });`);
  try {
    for (const mode of ["ok", "models-fail", "quota-fail"]) {
      writeFileSync(log, "");
      const result = await readMuseCatalog(process.execPath, dir, new AbortController().signal, [file, mode, log]);
      assert.equal(result.modelsStatus, mode === "models-fail" ? "unavailable" : "available");
      assert.equal(result.quota.status, mode === "quota-fail" ? "unavailable" : "available");
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(calls.map(r => r.method), ["initialize", "initialized", "model/list", "usage/read"]);
      assert.deepEqual(calls.at(-1).params, {});
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("Native Muse quota reaches routing with original freshness/reset bounds and unknown access", () => {
  const project = { id: "p", name: "Quota", path: tmpdir(), preference: "balanced", roles: [], createdAt: new Date(observed).toISOString() } as Project;
  const quota = parseMuseQuota(payload);
  const catalog = { projectId: project.id, checkedAt: new Date(observed).toISOString(), harnesses: [{ harness: "muse" as const,
    models: [{ id: "spark", name: "Spark", description: "", resolvedModel: null, isDefault: false, inputModalities: null }],
    modelsStatus: "available" as const, modelsMessage: null, modelsTruncated: false, quota }] };
  const input = recommendationSchema.parse({ harness: "muse", model: "spark" });
  const advise = (now: number) => recommendWorker(project, input, catalog, { codex: false, claude: false, muse: true }, now);
  const fresh = advise(observed + 1000);
  assert.equal(fresh.choice?.model, "spark");
  assert.match(fresh.choice!.warnings.join(" "), /exhausted/);
  assert.match(fresh.choice!.warnings.join(" "), /included usage allowance is unknown/);
  assert.equal(fresh.choice!.tier, "unknown");
  const stale = advise(observed + 300001);
  assert.doesNotMatch(stale.choice!.warnings.join(" "), /exhausted/);
  assert.match(stale.choice!.warnings.join(" "), /older than five minutes/);
  quota.buckets[0].primary!.resetsAt = observed / 1000;
  const reset = advise(observed + 1000);
  assert.doesNotMatch(reset.choice!.warnings.join(" "), /exhausted/);
});
