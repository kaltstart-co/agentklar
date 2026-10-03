import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityWorker, antigravityWorkerSupported, parseAntigravityModels, parseAntigravityQuota, readAntigravityCatalog } from "../src/antigravity.ts";
import type { Run } from "../src/contracts.ts";
const usage = "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-09T07:15:33Z\nGemini Models\tFive Hour Limit Remaining\t75%\t2026-10-02T12:15:33Z\nClaude and GPT models\tWeekly Limit Remaining\t0%\t2026-10-09T07:15:33Z";

test("Antigravity models preserve offered native IDs without assuming access or ranking", () => {
  const value = parseAntigravityModels("gemini-3.6-flash-low\tGemini Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet\n");
  assert.equal(value.models.length, 2);
  assert.equal(value.models[0]?.id, "gemini-3.6-flash-low");
  assert.equal(value.models[0]?.isDefault, false);
  assert.equal(value.models[0]?.resolvedModel, null);
  assert.equal(value.models[0]?.inputModalities, null);
  for (const malformed of ["native diagnostic", "x\tName\textra", "x\tName\nx\tDuplicate", "x\tName\u001b", "x".repeat(64_001)])
    assert.deepEqual(parseAntigravityModels(malformed).models, []);
});

test("Antigravity quotas separate known native groups and convert remaining percentages", () => {
  const quota = parseAntigravityQuota(usage, "2026-10-02T07:15:33Z");
  assert.equal(quota.status, "available");
  assert.equal(quota.ordinaryUsageAllowed, null);
  assert.equal(quota.buckets.length, 2);
  assert.deepEqual(quota.buckets[0]?.primary, { usedPercent: 25, windowDurationMins: 300, resetsAt: Date.parse("2026-10-02T12:15:33Z") / 1000 });
  assert.equal(quota.buckets[0]?.secondary?.usedPercent, 0);
  assert.equal(quota.buckets[1]?.secondary?.usedPercent, 100);
  assert.equal(quota.buckets[1]?.primary, null);
  assert.equal(quota.buckets[1]?.normalModel, null);
});

test("Antigravity unknown or malformed quota windows remain unknown", () => {
  for (const malformed of ["", "Other models\tWeekly Limit Remaining\t100%\t2026-10-09T07:15:33Z", usage.replace("75%", "101%"), usage.replace("75%", "-1%"), usage.replace("2026-10-02", "2026-02-30"), usage + "\n" + usage]) {
    const quota = parseAntigravityQuota(malformed);
    assert.equal(quota.status, "unavailable");
    assert.equal(quota.ordinaryUsageAllowed, null);
    assert.deepEqual(quota.buckets, []);
  }
});

test("Antigravity catalog uses only native metadata commands and never leaks failed diagnostics", async () => {
  const calls: string[][] = [];
  const catalog = await readAntigravityCatalog("fixture", "/tmp", new AbortController().signal, async (_command, args) => {
    calls.push(args);
    return args[0] === "models" ? "native\tNative Model" : usage;
  });
  assert.deepEqual(calls, [["models"], ["-p", "/usage"]]);
  assert.equal(catalog.modelsStatus, "available");
  assert.equal(catalog.quota.status, "available");
  const failed = await readAntigravityCatalog("fixture", "/tmp", new AbortController().signal, async () => { throw new Error("PRIVATE AUTH PAYLOAD"); });
  assert.equal(failed.modelsStatus, "unavailable");
  assert.equal(failed.quota.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE AUTH/);
  const abort = new AbortController(); abort.abort();
  const cancelled = await readAntigravityCatalog("fixture", "/tmp", abort.signal, async () => "native\tNative");
  assert.equal(cancelled.modelsStatus, "unavailable");
  assert.equal(cancelled.quota.status, "unavailable");
});

test("Antigravity worker refuses execution because native headless input cannot accept permission replies", async () => {
  let done = 0;
  let patch: Partial<Run> = {};
  const worker = new AntigravityWorker("/does/not/exist", {} as Run, "/does/not/exist", {
    update: value => { patch = value; }, event: () => assert.fail("Unexpected event"),
    approval: () => assert.fail("Unverified approval"), done: () => { done++; },
  });
  await worker.closed;
  assert.equal(antigravityWorkerSupported, false);
  assert.equal(patch.state, "needs_attention");
  assert.match(patch.error!, /headless input rejects permission replies/);
  assert.equal(done, 1);
});

test("Antigravity metadata subprocess is bounded and cancellation leaves no catalog claims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-agy-metadata-"));
  const fake = join(dir, "agy-fixture");
  try {
    writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "models") process.stdout.write("native\\tNative Model\\n");
else process.stdout.write(${JSON.stringify(usage)});
process.stderr.write("PRIVATE AUTH PAYLOAD");
`);
    chmodSync(fake, 0o700);
    const catalog = await readAntigravityCatalog(fake, dir, new AbortController().signal);
    assert.equal(catalog.modelsStatus, "available");
    assert.equal(catalog.quota.status, "available");
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE AUTH/);
    writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write("x".repeat(64001));setInterval(()=>{},1000);\n`);
    const oversized = await readAntigravityCatalog(fake, dir, new AbortController().signal);
    assert.equal(oversized.modelsStatus, "unavailable");
    assert.equal(oversized.quota.status, "unavailable");
    writeFileSync(fake, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 100);
    const cancelled = await readAntigravityCatalog(fake, dir, abort.signal);
    clearTimeout(timer);
    assert.equal(cancelled.modelsStatus, "unavailable");
    assert.equal(cancelled.quota.status, "unavailable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
