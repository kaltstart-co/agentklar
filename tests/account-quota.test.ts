import assert from "node:assert/strict";
import test from "node:test";
import { accountQuotaCoverage, unavailableAccountQuota } from "../src/account-quota.ts";
import { parseQuota, parseClaudeQuota, readCatalog } from "../src/catalog.ts";
import { workerHarnesses, type Project } from "../src/contracts.ts";

test("every supported catalog harness declares a quota source or an honest native fallback", () => {
  assert.deepEqual(Object.keys(accountQuotaCoverage).sort(), [...workerHarnesses, "antigravity"].sort());
  for (const harness of [...workerHarnesses, "antigravity"] as const) {
    const unknown = unavailableAccountQuota(harness);
    assert.equal(unknown.status, "unavailable");
    assert.equal(unknown.ordinaryUsageAllowed, null);
    assert.deepEqual(unknown.buckets, []);
    assert.ok(unknown.message);
    assert.match(unavailableAccountQuota(harness, false).message!, /executable was not found on this host/);
  }
  for (const harness of ["opencode", "gemini", "cursor-agent", "zcode"] as const)
    assert.equal(accountQuotaCoverage[harness].source, null);
  assert.match(unavailableAccountQuota("opencode").message!, /session tokens and cost/);
  assert.match(unavailableAccountQuota("gemini").message!, /\/stats model/);
});

test("an absent native CLI cannot claim its account quota was read", async () => {
  const project = { id: "quota-coverage", path: "/private/tmp" } as Project;
  const result = await readCatalog(project, { codex: null, claude: null }, new AbortController().signal);
  assert.equal(result.harnesses.length, workerHarnesses.length + 1);
  for (const catalog of result.harnesses) {
    assert.equal(catalog.quota.status, "unavailable");
    assert.match(catalog.quota.message!, /executable was not found/);
    assert.equal(catalog.quota.ordinaryUsageAllowed, null);
    assert.deepEqual(catalog.quota.buckets, []);
  }
});

test("bucket names and an available flag cannot establish quota without any valid limit", () => {
  const codex = parseQuota({ rateLimitsByLimitId: { codex: { limitName: "Codex", primary: {}, secondary: null } } });
  assert.equal(codex.status, "unavailable");
  assert.equal(codex.ordinaryUsageAllowed, null);
  for (const limits of [{}, { five_hour: { utilization: "0" } }, { seven_day: { utilization: NaN } }]) {
    const claude = parseClaudeQuota({ rate_limits_available: true, rate_limits: limits });
    assert.equal(claude.status, "unavailable");
    assert.equal(claude.ordinaryUsageAllowed, null);
  }
  assert.equal(parseQuota({ ordinaryUsageAllowed: false }).status, "available");
  assert.equal(parseQuota({ rateLimits: { primary: { usedPercent: 0 } } }).status, "available");
  assert.equal(parseClaudeQuota({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 0 } } }).status, "available");
});
