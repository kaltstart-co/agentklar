import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountQuota,
  CatalogModel,
  CatalogSnapshot,
  HarnessCatalog,
  Project,
  QuotaBucket,
} from "../src/contracts.ts";
import { recommendationSchema, recommendWorker, recommendWorkers, selectedWorkerEligibility } from "../src/recommend.ts";
import { createService } from "../src/service.ts";
import { normalizeToolEvidence } from "../src/capabilities.ts";

const now = Date.parse("2026-10-01T04:00:00Z");
const p: Project = {
  id: randomUUID(),
  name: "Advice",
  path: tmpdir(),
  preference: "balanced",
  roles: [],
  createdAt: new Date(now).toISOString(),
};
const models = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"];
function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    description: "",
    resolvedModel: null,
    isDefault: false,
    inputModalities: ["text", "image"],
    ...extra,
  };
}
function catalog(
  harness: "codex" | "claude" = "codex",
  ids = models,
  quota: Partial<AccountQuota> = {},
): HarnessCatalog {
  return {
    harness,
    models: ids.map((id) => model(id)),
    modelsStatus: "available",
    modelsMessage: null,
    modelsTruncated: false,
    quota: {
      status: "available",
      message: null,
      ordinaryUsageAllowed: true,
      buckets: [],
      ...quota,
    },
  };
}
function bucket(
  usedPercent: number,
  extra: Partial<QuotaBucket> = {},
): QuotaBucket {
  return {
    id: "codex",
    name: null,
    normalModel: null,
    primary: {
      usedPercent,
      windowDurationMins: 300,
      resetsAt: now / 1000 + 300,
    },
    secondary: null,
    spendControlReached: false,
    ...extra,
  };
}
function advise(
  input = {},
  catalogs = [catalog()],
  project = p,
  installed = { codex: true, claude: true },
) {
  const snapshot: CatalogSnapshot = {
    projectId: project.id,
    checkedAt: new Date(now).toISOString(),
    harnesses: catalogs,
  };
  return recommendWorker(
    project,
    recommendationSchema.parse(input),
    snapshot,
    installed,
    now,
  );
}

test("required tools preserve pins and reject missing, stale, historical and wrong-harness evidence", () => {
  const native = catalog("claude", ["claude-sonnet-5"]);
  const evidence = normalizeToolEvidence({ harness: "claude", modelId: "claude-sonnet-5", tools: ["WebSearch"], source: "native-model-metadata", checkedAt: new Date(now).toISOString(), complete: true });
  native.models[0].toolEvidence = evidence;
  assert.equal(advise({ harness: "claude", model: "claude-sonnet-5", requiresTools: ["web_search"] }, [native]).choice?.model, "claude-sonnet-5");
  assert.equal(advise({ harness: "claude", model: "claude-sonnet-5", requiresTools: ["web_search"], readOnly: true }, [native]).choice, null);
  for (const changed of [undefined, { ...evidence, complete: false }, { ...evidence, source: "native-session" as const }, { ...evidence, harness: "opencode" as const }, { ...evidence, checkedAt: new Date(now - 300001).toISOString() }]) {
    native.models[0].toolEvidence = changed;
    const result = advise({ harness: "claude", model: "claude-sonnet-5", requiresTools: ["web_search"] }, [native]);
    assert.equal(result.choice, null); assert.match(result.reasons.join(" "), /Pinned.*No replacement/);
    const snapshot = { projectId: p.id, checkedAt: new Date(now).toISOString(), harnesses: [native] };
    assert.equal(selectedWorkerEligibility({ harness: "claude", model: "claude-sonnet-5" }, { catalog: snapshot, installed: { codex: false, claude: true } }, false, now, "task-pin", { requiresTools: ["web_search"] }).eligible, false);
  }
  assert.equal(advise({ requiresTools: ["image_generation"] }).choice, null);
});

test("preference, host classification and native headroom produce transparent policy tiers", () => {
  const scenarios = [
    ["balanced", "routine", null, "efficient"],
    ["balanced", "standard", null, "balanced"],
    ["balanced", "hard", null, "capable"],
    ["economical", "standard", 80, "efficient"],
    ["economical", "hard", 80, "balanced"],
    ["best", "routine", 95, "capable"],
    ["best", "hard", 95, "capable"],
    ["balanced", "standard", 50, "capable"],
    ["balanced", "standard", 80, "efficient"],
    ["balanced", "hard", 80, "balanced"],
  ] as const;
  for (const [preference, complexity, used, tier] of scenarios) {
    const advice = advise(
      { complexity },
      [
        catalog("codex", models, {
          buckets: used === null ? [] : [bucket(used)],
        }),
      ],
      { ...p, preference },
    );
    assert.equal(
      advice.choice?.tier,
      tier,
      `${preference} ${complexity} ${used}`,
    );
    assert.match(advice.choice!.reasons[0], /Saved .* preference/);
    assert.equal(advice.confidence, "limited");
    assert.equal(advice.sources.length, 3);
    if (used !== null)
      assert.match(
        advice.choice!.reasons.join(" "),
        /product rules.*subscription units is unknown/,
      );
  }
  assert.match(
    advise({}, [catalog("codex", models, { buckets: [bucket(95)] })], {
      ...p,
      preference: "best",
    }).choice!.warnings.join(" "),
    /headroom is low/,
  );
});

test("only native offered reviewed IDs are automatic candidates; hard work has a balanced floor", () => {
  assert.equal(
    advise({ complexity: "hard" }, [catalog("codex", ["gpt-5.6-luna"])]).choice,
    null,
  );
  assert.equal(
    advise({ complexity: "hard" }, [catalog("codex", ["gpt-5.6-sol"])]).choice
      ?.tier,
    "balanced",
  );
  const advice = advise({ complexity: "routine" }, [
    catalog("codex", ["gpt-5.5", "gpt-99-luna", "gpt-5.6-luna"]),
  ]);
  assert.equal(advice.choice?.model, "gpt-5.6-luna");
  assert.equal(advice.alternatives.length, 0);
  assert.equal(
    advise({}, [catalog("codex", ["native-expensive-default"])]).choice,
    null,
  );
  assert.equal(
    advise({}, [catalog("codex", ["gpt-5.6-terra", "gpt-5.6-sol"])]).choice
      ?.model,
    "gpt-5.6-sol",
  );
});

test("task and saved role model pins are authoritative; their block returns no replacement", () => {
  const role = {
    id: "review",
    name: "Review",
    harness: "codex",
    model: "gpt-6-astra",
    responsibility: "Review code",
  };
  const project = { ...p, preference: "economical" as const, roles: [role] };
  assert.equal(
    advise({ roleId: "review" }, [catalog()], project).choice?.basis,
    "role-pin",
  );
  const task = advise(
    { roleId: "review", model: "gpt-5.6-sol" },
    [catalog()],
    project,
  );
  assert.equal(task.choice?.model, "gpt-5.6-sol");
  assert.equal(task.choice?.basis, "task-pin");
  assert.equal(task.choice?.roleId, "review");
  const blocked = advise(
    { roleId: "review" },
    [catalog("codex", models, { ordinaryUsageAllowed: false })],
    project,
  );
  assert.equal(blocked.choice, null);
  assert.deepEqual(blocked.alternatives, []);
  assert.match(
    blocked.reasons.join(" "),
    /Pinned codex model gpt-6-astra.*blocked.*No replacement/,
  );
  assert.throws(() => advise({ roleId: "missing" }), /Role not found/);
  assert.throws(
    () => advise({ roleId: "review", harness: "claude" }, [catalog()], project),
    /must match/,
  );
  assert.throws(
    () =>
      advise({ roleId: "review" }, [], {
        ...project,
        roles: [{ ...role, harness: "unknown-harness" }],
      }),
    /no worker adapter/,
  );
});

test("custom pins keep unknown text advice, use default Codex, and never invent image support", () => {
  const advice = advise({ model: "custom-native" });
  assert.equal(advice.choice?.harness, "codex");
  assert.equal(advice.choice?.tier, "unknown");
  assert.match(
    advice.choice!.warnings.join(" "),
    /absent.*capability.*access.*unknown/,
  );
  assert.equal(
    advise({ model: "custom-native", requiresImages: true }).choice,
    null,
  );
  assert.equal(
    advise({ model: "gpt-5.6-sol" }, [catalog()], p, {
      codex: false,
      claude: true,
    }).choice,
    null,
  );
  assert.equal(
    advise({}, [catalog()], p, { codex: false, claude: true }).choice,
    null,
  );
});

test("Claude aliases use exact resolved models and never infer a tier from alias text", () => {
  const c = catalog("claude", []);
  c.models = [
    model("haiku", { resolvedModel: "claude-opus-4-8", inputModalities: null }),
    model("sonnet", {
      resolvedModel: "claude-sonnet-4-6",
      inputModalities: null,
    }),
    model("fable", { resolvedModel: "claude-fable-5", inputModalities: null }),
    model("default", {
      resolvedModel: "claude-opus-4-8",
      inputModalities: null,
    }),
  ];
  assert.equal(
    advise({ harness: "claude", complexity: "hard" }, [c]).choice?.model,
    "claude-opus-4-8",
  );
  assert.equal(
    advise({ harness: "claude", model: "haiku" }, [c]).choice?.tier,
    "capable",
  );
  assert.equal(
    advise({ harness: "claude", model: "haiku" }, [c]).choice?.model,
    "haiku",
  );
  assert.equal(
    advise({ harness: "claude", model: "default" }, [c]).choice?.model,
    "default",
  );
  assert.equal(
    advise({ harness: "claude", model: "default" }, [c]).choice?.tier,
    "capable",
  );
  assert.equal(
    advise({ harness: "claude", model: "fable" }, [c]).choice?.tier,
    "unknown",
  );
  c.models = [
    model("fable", { resolvedModel: "claude-opus-4-8", inputModalities: null }),
  ];
  assert.equal(advise({ harness: "claude" }, [c]).choice, null);
  assert.match(
    advise({ harness: "claude", model: "fable" }, [c]).choice!.warnings.join(
      " ",
    ),
    /usage credits/,
  );
  c.models = [model("haiku", { inputModalities: null })];
  assert.equal(advise({ harness: "claude" }, [c]).choice, null);
  assert.equal(
    advise({ harness: "claude", model: "haiku" }, [c]).choice?.tier,
    "unknown",
  );
});

test("known Claude sign-in block excludes automatic choice and keeps pins fixed", () => {
  const claude = catalog("claude", ["claude-sonnet-4-6"]);
  claude.auth = { status: "sign_in_required", source: "claude-auth-status", message: "Sign in" };
  const blocked = advise({ harness: "claude" }, [claude]);
  assert.equal(blocked.choice, null);
  assert.doesNotMatch(blocked.reasons.join(" "), /Policy order|LiveBench/);
  const pinned = advise({ harness: "claude", model: "claude-sonnet-4-6" }, [claude]);
  assert.equal(pinned.choice, null);
  assert.match(pinned.reasons.join(" "), /Pinned claude.*sign-in.*No replacement/i);
  assert.equal(advise({}, [claude, catalog()]).choice?.harness, "codex");
  claude.auth.status = "unknown";
  assert.equal(advise({ harness: "claude", model: "claude-sonnet-4-6" }, [claude]).choice?.harness, "claude");
  claude.auth.status = "signed_in";
  assert.equal(advise({ harness: "claude", model: "claude-sonnet-4-6" }, [claude]).choice?.harness, "claude");
});

test("image advice requires native image evidence for both automatic choices and pins", () => {
  const c = catalog();
  c.models = [
    model("gpt-6-astra", { inputModalities: ["text"] }),
    model("gpt-5.6-sol"),
  ];
  assert.equal(
    advise({ requiresImages: true, complexity: "hard" }, [c]).choice?.model,
    "gpt-5.6-sol",
  );
  assert.equal(
    advise({ requiresImages: true, model: "gpt-6-astra" }, [c]).choice,
    null,
  );
  const claude = catalog("claude", ["claude-sonnet-4-6"]);
  claude.models[0].inputModalities = null;
  assert.equal(
    advise({ requiresImages: true, harness: "claude" }, [claude]).choice,
    null,
  );
});

test("allowance false blocks automatic candidates; unknown is neither blocked nor allowed", () => {
  const c = catalog("codex", ["gpt-5.6-sol"], { ordinaryUsageAllowed: false });
  const claude = catalog("claude", ["claude-sonnet-4-6"], {
    ordinaryUsageAllowed: null,
  });
  assert.equal(advise({}, [c, claude]).choice?.harness, "claude");
  assert.match(
    advise({}, [c, claude]).choice!.warnings.join(" "),
    /allowance is unknown/,
  );
  c.quota.ordinaryUsageAllowed = true;
  assert.equal(advise({}, [claude, c]).choice?.harness, "codex");
  c.quota.ordinaryUsageAllowed = null;
  assert.equal(advise({}, [c]).choice?.model, "gpt-5.6-sol");
});

test("only relevant shared/model buckets affect headroom or spend controls", () => {
  const unrelated = bucket(99, {
    id: "other",
    normalModel: "other-model",
    spendControlReached: true,
  });
  const scoped = bucket(99, {
    id: "model",
    normalModel: "gpt-6-astra",
    spendControlReached: true,
  });
  const c = catalog("codex", models, { buckets: [unrelated, scoped] });
  assert.equal(advise({}, [c]).choice?.model, "gpt-5.6-sol");
  assert.match(
    advise({}, [c]).choice!.warnings.join(" "),
    /headroom is unknown/,
  );
  c.quota.buckets.push(bucket(80));
  assert.equal(advise({}, [c]).choice?.model, "gpt-5.6-luna");
  assert.equal(advise({ model: "gpt-6-astra" }, [c]).choice, null);
  const claude = catalog("claude", []);
  claude.models = [model("sonnet", { resolvedModel: "claude-sonnet-4-6" })];
  claude.quota.buckets = [
    bucket(50, {
      id: "specific",
      normalModel: "claude-sonnet-4-6",
      spendControlReached: true,
    }),
  ];
  assert.equal(advise({ harness: "claude" }, [claude]).choice, null);
});

test("headroom takes applicable minimum; expired reset windows never imply recovery", () => {
  const c = catalog("codex", models, {
    buckets: [
      bucket(10, {
        secondary: {
          usedPercent: 90,
          windowDurationMins: 10080,
          resetsAt: null,
        },
      }),
    ],
  });
  assert.equal(advise({}, [c]).choice?.tier, "efficient");
  c.quota.buckets = [
    bucket(100, {
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: now / 1000 - 1,
      },
    }),
  ];
  const stale = advise({}, [c]);
  assert.equal(stale.choice?.tier, "balanced");
  assert.match(stale.choice!.warnings.join(" "), /recovery is unknown/);
  c.quota.ordinaryUsageAllowed = false;
  assert.equal(advise({}, [c]).choice, null);
});

test("bounded advice omits raw quota, vendor descriptions and account data", () => {
  const c = catalog(
    "codex",
    Array.from({ length: 100 }, (_, i) => `unreviewed-${i}`),
  );
  c.models.push(
    ...models.map((id) => model(id, { description: "SECRET_ACCOUNT" })),
  );
  c.quota.buckets = [bucket(42, { name: "SECRET_ACCOUNT" })];
  const advice = advise({}, [c]);
  assert.ok(advice.alternatives.length <= 3);
  assert.ok(advice.warnings.length <= 8);
  assert.ok(JSON.stringify(advice).length < 10000);
  assert.doesNotMatch(
    JSON.stringify(advice),
    /SECRET_ACCOUNT|ordinaryUsageAllowed|resetsAt|usedPercent/,
  );
});

test("authenticated recommendation API validates inputs, refreshes on demand and starts no worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-recommend-"));
  let reads = 0,
    starts = 0;
  const service = createService(
    join(dir, "home"),
    4317,
    () => {
      starts++;
      return { stop() {} };
    },
    "codex-fixture",
    null,
    async (project) => {
      reads++;
      return {
        projectId: project.id,
        checkedAt: new Date().toISOString(),
        harnesses: [catalog()],
      };
    },
  );
  const request = (path: string, body: unknown, auth = true) =>
    service.app.request(`http://127.0.0.1:4317${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${service.bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const project = await (
      await request("/api/projects", { name: "one", path: dir })
    ).json();
    const path = `/api/projects/${project.id}/recommend`;
    assert.equal((await request(path, {}, false)).status, 401);
    assert.equal(
      (await request(`/api/projects/${randomUUID()}/recommend`, {})).status,
      404,
    );
    for (const body of [
      { complexity: "invented" },
      { quota: {} },
      { roleId: "missing" },
      { model: "m".repeat(121) },
      { requiresImages: "true" },
      { harness: "unknown-harness" },
    ])
      assert.equal((await request(path, body)).status, 400);
    const boundedError = await (
      await request(path, { ["x".repeat(10000)]: true })
    ).json();
    assert.ok(boundedError.error.length <= 240);
    assert.equal(reads, 0);
    const response = await request(path, {});
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const advice = await response.json();
    assert.equal(advice.choice.model, "gpt-5.6-sol");
    assert.equal(advice.complexity, "standard");
    assert.equal(advice.requiresImages, false);
    await request(path, { complexity: "hard" });
    assert.equal(reads, 1);
    assert.equal(starts, 0);
    assert.equal(service.store.runs().length, 0);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recommendation reads native discovery protocol through the service without inference methods", async () => {
  const { readCodexCatalog } = await import("../src/catalog.ts");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "agentklar-advice-protocol-"));
  const fixture = join(dir, "native.mjs"),
    log = join(dir, "methods.jsonl");
  writeFileSync(
    fixture,
    `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      appendFileSync(process.argv[2], JSON.stringify(request.method) + '\\n');
      if (request.method === 'initialized') return;
      let result;
      if (request.method === 'initialize') result = {};
      else if (request.method === 'model/list') result = {
        data: [{ model: 'gpt-5.6-sol', displayName: 'Sol', inputModalities: ['text', 'image'] }], nextCursor: null
      };
      else if (request.method === 'account/rateLimits/read') result = { ordinaryUsageAllowed: true };
      else throw new Error('Unexpected inference method');
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
    });
  `,
  );
  let starts = 0;
  const service = createService(
    join(dir, "home"),
    4317,
    () => {
      starts++;
      return { stop() {} };
    },
    process.execPath,
    null,
    async (project, commands, signal) => ({
      projectId: project.id,
      checkedAt: new Date().toISOString(),
      harnesses: [
        await readCodexCatalog(commands.codex!, project.path, signal, [
          fixture,
          log,
        ]),
      ],
    }),
  );
  const request = (path: string, body: unknown) =>
    service.app.request(`http://127.0.0.1:4317${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${service.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const project = await (
      await request("/api/projects", { name: "protocol", path: dir })
    ).json();
    const advice = await (
      await request(`/api/projects/${project.id}/recommend`, {})
    ).json();
    assert.equal(advice.choice.model, "gpt-5.6-sol");
    assert.deepEqual(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      ["initialize", "initialized", "model/list", "account/rateLimits/read"],
    );
    assert.equal(starts, 0);
    assert.equal(service.store.runs().length, 0);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("fresh exhausted allowance excludes automatic work but preserves an explicit pin", () => {
  const c = catalog("codex", models, { buckets: [bucket(100)] });
  assert.equal(advise({}, [c]).choice, null);
  const pinned = advise({ model: "gpt-5.6-sol" }, [c]);
  assert.equal(pinned.choice?.model, "gpt-5.6-sol");
  assert.match(pinned.choice!.warnings.join(" "), /exhausted.*paid overage/);
  c.quota.observedAt = new Date(now - 300_001).toISOString();
  c.quota.ordinaryUsageAllowed = false;
  const stale = advise({}, [c]);
  assert.equal(stale.choice?.tier, "balanced");
  assert.match(stale.choice!.warnings.join(" "), /older than five minutes/);
  c.quota.observedAt = new Date(now + 1).toISOString();
  assert.equal(advise({}, [c]).choice?.tier, "balanced");
});

test("observed Muse account windows reach pin advice without inventing access or model tiers", async () => {
  const { withObservedMuseQuota } = await import("../src/catalog.ts");
  const muse = { ...catalog(), harness: "muse" as const, models: [model("spark")] };
  const snapshot = { projectId: p.id, checkedAt: new Date(now).toISOString(), harnesses: [muse] };
  const usage = { observedAtMs: now - 1000, weekly: { usedPercent: 42, resetsAtMs: now + 10000 }, window: { usedPercent: 100, resetsAtMs: now + 10000, windowDurationMins: 300 } };
  const runs = [{ harness: "muse", museSubscriptionUsage: usage }] as unknown as import("../src/contracts.ts").Run[];
  const observed = withObservedMuseQuota(snapshot, runs);
  assert.equal(snapshot.harnesses[0].quota.observedAt, undefined);
  assert.equal(observed.harnesses[0].quota.ordinaryUsageAllowed, null);
  const advice = recommendWorker(p, recommendationSchema.parse({ harness: "muse", model: "spark" }), observed, { codex: false, claude: false, muse: true }, now);
  assert.equal(advice.choice?.tier, "unknown");
  assert.match(advice.choice!.reasons.join(" "), /observed at.*not a live balance/);
  assert.match(advice.choice!.warnings.join(" "), /exhausted/);
  const old = withObservedMuseQuota(snapshot, [{ ...runs[0], museSubscriptionUsage: { ...usage, observedAtMs: now - 300_001 } }]);
  const stale = recommendWorker(p, recommendationSchema.parse({ harness: "muse", model: "spark" }), old, { codex: false, claude: false, muse: true }, now);
  assert.doesNotMatch(stale.choice!.warnings.join(" "), /exhausted/);
});


test("multi-device ranks all candidates, preserves device identity and role ownership", () => {
  const source = (ids:string[], peerId?:string, quota:Partial<AccountQuota>={}) => ({catalog:{projectId:p.id,checkedAt:new Date(now).toISOString(),harnesses:[catalog("codex",ids,quota)]},installed:{codex:true,claude:false},device:{id:peerId || "local",label:peerId || "Local",...(peerId ? {peerId} : {})}});
  const input = recommendationSchema.parse({model:"gpt-5.6-sol"});
  const local = source(["gpt-5.6-sol"]), remote = source(["gpt-5.6-sol"],"remote");
  const tied = recommendWorkers(p,input,[remote,local],now);
  assert.equal(tied.choice?.device?.id,"local");
  assert.equal(tied.alternatives.length,0); // Exact model pins do not suggest replacements.
  const empty = source(["gpt-5.6-sol"],undefined,{buckets:[bucket(100)]});
  assert.equal(recommendWorkers(p,input,[empty,remote],now).choice?.device?.peerId,"remote");
  const exhausted = recommendWorkers(p,input,[empty,source(["gpt-5.6-sol"],"remote",{buckets:[bucket(100)]})],now);
  assert.equal(exhausted.choice?.model,"gpt-5.6-sol");
  assert.ok(exhausted.choice?.warnings.some(w => w.includes("exhausted")));
  assert.equal(recommendWorkers(p,input,[source(["gpt-6-astra"],"remote")],now).choice,null);
  assert.equal(recommendWorkers(p,input,[source(["gpt-6-astra"])],now).choice?.model,"gpt-5.6-sol");
  const roleProject = {...p,roles:[{id:"worker",name:"Worker",responsibility:"Code",harness:"codex" as const,model:"gpt-5.6-sol",peerId:"remote"}]};
  assert.equal(recommendWorkers(roleProject,recommendationSchema.parse({roleId:"worker"}),[local],now).choice,null);
  assert.equal(recommendWorkers(roleProject,recommendationSchema.parse({roleId:"worker"}),[local,remote],now).choice?.device?.peerId,"remote");
  const automatic = recommendWorkers(p,recommendationSchema.parse({}),[source(["gpt-5.6-sol"],"remote"),local],now);
  assert.equal(automatic.choice?.device?.id,"local");
  assert.equal(automatic.alternatives[0]?.device?.peerId,"remote");
  assert.equal(automatic.choice?.catalogCheckedAt,new Date(now).toISOString());
});


test("owner eligibility checks selected exact native model without a replacement", () => {
 const source = {catalog:{projectId:p.id,checkedAt:new Date(now).toISOString(),harnesses:[catalog("codex",["gpt-5.6-sol"],{buckets:[bucket(100)]})]},installed:{codex:true,claude:false}};
 const choice={harness:"codex" as const,model:"gpt-5.6-sol"};
 assert.equal(selectedWorkerEligibility(choice,source,false,now).eligible,false);
 assert.equal(selectedWorkerEligibility(choice,source,false,now,"task-pin").eligible,true);
 source.catalog.harnesses[0].quota.ordinaryUsageAllowed=false;
 assert.equal(selectedWorkerEligibility(choice,source,false,now,"task-pin").eligible,false);
 source.catalog.harnesses[0].quota.ordinaryUsageAllowed=true;
 source.catalog.checkedAt=new Date(now-6*60_000).toISOString();
 assert.equal(selectedWorkerEligibility(choice,source,false,now).eligible,true);
 assert.equal(selectedWorkerEligibility({...choice,model:"absent"},source,false,now).eligible,false);
 source.catalog.harnesses[0].models[0].inputModalities=["text"];
 assert.equal(selectedWorkerEligibility(choice,source,true,now).eligible,false);
});


test("peer Claude competes with local Codex at the same policy tier using its own allowance", () => {
 const make=(h:"codex"|"claude",ids:string[],allowed:boolean,peerId?:string)=>({catalog:{projectId:p.id,checkedAt:new Date(now).toISOString(),harnesses:[catalog(h,ids,{ordinaryUsageAllowed:allowed ? true : null})]},installed:{codex:h==="codex",claude:h==="claude"},device:{id:peerId || "local",label:peerId || "Local",...(peerId ? {peerId} : {})}});
 const local=make("codex",["gpt-6.1-sol"],false);
 const remote=make("claude",["claude-sonnet-5-5"],true,"peer-claude");
 const advice=recommendWorkers(p,recommendationSchema.parse({}),[local,remote],now);
 assert.equal(advice.choice?.harness,"claude");
 assert.equal(advice.choice?.tier,"balanced");
 assert.equal(advice.choice?.device?.peerId,"peer-claude");
 assert.equal(advice.alternatives[0]?.harness,"codex");
 assert.equal(advice.alternatives[0]?.device?.id,"local");
 assert.equal(advice.benchmarkMethod,"policy-fallback");
 assert.equal(advice.policyVersion,"2026-10-02.4");
});

function unrankedSource(harness: "muse" | "opencode", allowed: boolean | null = true) {
  return { catalog: { projectId: p.id, checkedAt: new Date(now).toISOString(), harnesses: [{ ...catalog(), harness, models: [model(harness === "muse" ? "spark" : "provider/native", { isDefault: harness === "muse" })], quota: { status: "available" as const, message: null, ordinaryUsageAllowed: allowed, buckets: [] as QuotaBucket[] } }] }, installed: { codex: false, claude: false, [harness]: true } };
}

for (const harness of ["muse", "opencode"] as const) test(`${harness}-only Automatic uses a fresh native choice only with positive ordinary usage evidence`, () => {
  const source = unrankedSource(harness);
  const advice = recommendWorkers(p, recommendationSchema.parse({}), [source], now);
  assert.equal(advice.choice?.harness, harness);
  assert.equal(advice.choice?.model, source.catalog.harnesses[0].models[0].id);
  assert.equal(advice.choice?.tier, "unknown");
  assert.equal(advice.choice?.basis, "policy");
  assert.equal(advice.benchmarkMethod, "policy-fallback");
  assert.equal(advice.choice?.benchmark, undefined);
  assert.match(advice.choice!.reasons.join(" "), /no reviewed candidate.*no cost or quality rank/);
  assert.match(advice.choice!.warnings.join(" "), /ranking.*unknown/);
  assert.doesNotMatch(advice.reasons.join(" "), /Choices prefer the target tier/);
  const unknown = unrankedSource(harness, null);
  const firstRun = recommendWorkers(p, recommendationSchema.parse({}), [unknown], now);
  assert.equal(firstRun.choice, null);
  assert.match(firstRun.reasons[0], /Choose Muse or OpenCode.*turn off Choose model automatically/);
});

test("unranked fallback preserves allowance, image, freshness and quality floors", () => {
  const eligible = () => unrankedSource("muse");
  for (const change of [
    (source: ReturnType<typeof eligible>) => { source.catalog.harnesses[0].quota.ordinaryUsageAllowed = false; },
    (source: ReturnType<typeof eligible>) => { source.catalog.checkedAt = new Date(now - 300_001).toISOString(); },
    (source: ReturnType<typeof eligible>) => { source.catalog.checkedAt = new Date(now + 1).toISOString(); },
    (source: ReturnType<typeof eligible>) => { source.catalog.harnesses[0].modelsTruncated = true; },
    (source: ReturnType<typeof eligible>) => { source.catalog.harnesses[0].models[0].id = "contributor-native"; },
  ]) {
    const source = eligible(); change(source);
    assert.equal(recommendWorkers(p, recommendationSchema.parse({}), [source], now).choice, null);
  }
  const exhausted = eligible();
  exhausted.catalog.harnesses[0].quota.buckets = [bucket(100, { id: "muse" })];
  assert.equal(recommendWorkers(p, recommendationSchema.parse({}), [exhausted], now).choice, null);
  const blocked = eligible();
  blocked.catalog.harnesses[0].quota.buckets = [bucket(20, { id: "muse", spendControlReached: true })];
  assert.equal(recommendWorkers(p, recommendationSchema.parse({}), [blocked], now).choice, null);
  const images = eligible(); images.catalog.harnesses[0].models[0].inputModalities = ["text"];
  assert.equal(recommendWorkers(p, recommendationSchema.parse({ requiresImages: true }), [images], now).choice, null);
  assert.equal(recommendWorkers(p, recommendationSchema.parse({ complexity: "hard" }), [eligible()], now).choice, null);
  assert.equal(recommendWorkers({ ...p, preference: "best" }, recommendationSchema.parse({}), [eligible()], now).choice, null);
  const ambiguous = unrankedSource("opencode");
  ambiguous.catalog.harnesses[0].models.push(model("other-provider/model"));
  assert.equal(recommendWorkers(p, recommendationSchema.parse({}), [ambiguous], now).choice, null);
});

test("unranked choices never replace reviewed candidates, explicit pins or device ownership", () => {
  const muse = unrankedSource("muse");
  const codex = { catalog: { projectId: p.id, checkedAt: new Date(now).toISOString(), harnesses: [catalog()] }, installed: { codex: true, claude: false } };
  assert.equal(recommendWorkers(p, recommendationSchema.parse({}), [muse, codex], now).choice?.harness, "codex");
  assert.equal(recommendWorkers(p, recommendationSchema.parse({ harness: "codex" }), [muse], now).choice, null);
  assert.equal(recommendWorkers(p, recommendationSchema.parse({ model: "gpt-5.6-sol" }), [muse], now).choice, null);
  const pinned = recommendWorkers(p, recommendationSchema.parse({ harness: "muse", model: "explicit-model" }), [muse], now);
  assert.equal(pinned.choice?.model, "explicit-model");
  assert.equal(pinned.choice?.basis, "task-pin");
  const roleProject = { ...p, roles: [{ id: "native", name: "Native", responsibility: "Implement", harness: "muse" as const, peerId: "mapped" }] };
  assert.equal(recommendWorkers(roleProject, recommendationSchema.parse({ roleId: "native" }), [muse], now).choice, null);
  const remote = { ...muse, device: { id: "owner", label: "Owner", peerId: "mapped" } };
  assert.equal(recommendWorkers(roleProject, recommendationSchema.parse({ roleId: "native" }), [muse, remote], now).choice?.device?.peerId, "mapped");
});

test("Claude general and exact family windows constrain advice without leaking unknown model scopes", async () => {
  const { parseClaudeQuota } = await import("../src/catalog.ts");
  const claude = catalog("claude", ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]);
  const reset = new Date(now + 3600000).toISOString();
  const limits = (extra: Record<string, unknown>) => parseClaudeQuota({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 10, resets_at: reset }, seven_day: { utilization: 20, resets_at: reset }, ...extra } });
  claude.quota = limits({ five_hour: { utilization: 90, resets_at: reset } });
  const low = advise({ harness: "claude" }, [claude]);
  assert.equal(low.choice?.tier, "efficient");
  assert.match(low.choice!.reasons.join(" "), /10% remaining/);
  claude.quota = limits({ five_hour: { utilization: 100, resets_at: reset } });
  assert.equal(advise({ harness: "claude" }, [claude]).choice, null);
  claude.quota = limits({ seven_day_oauth_apps: { utilization: 100, resets_at: reset } });
  assert.equal(advise({ harness: "claude" }, [claude]).choice, null);
  claude.quota = limits({ seven_day_opus: { utilization: 100, resets_at: reset }, seven_day_sonnet: { utilization: 30, resets_at: reset }, model_scoped: [{ display_name: "Unknown family", utilization: 100, resets_at: reset }] });
  assert.equal(advise({ harness: "claude", complexity: "hard" }, [claude]).choice?.model, "claude-sonnet-4-6");
  const pin = advise({ harness: "claude", model: "claude-opus-4-8" }, [claude]);
  assert.match(pin.choice!.warnings.join(" "), /exhausted/);
  claude.models = [model("opus", { resolvedModel: "claude-sonnet-4-6" }), model("sonnet", { resolvedModel: "claude-opus-4-8" })];
  assert.equal(advise({ harness: "claude", complexity: "hard" }, [claude]).choice?.model, "claude-sonnet-4-6");
  assert.match(advise({ harness: "claude", model: "sonnet" }, [claude]).choice!.warnings.join(" "), /exhausted/);
  assert.doesNotMatch(advise({ harness: "claude", model: "opus" }, [claude]).choice!.warnings.join(" "), /exhausted/);
});

test("owner recheck keeps unranked Automatic allowance positive while preserving explicit pins", () => {
  const source = unrankedSource("opencode");
  const choice = { harness: "opencode" as const, model: "provider/native" };
  assert.equal(selectedWorkerEligibility(choice, source, false, now).eligible, true);
  source.catalog.harnesses[0].quota.ordinaryUsageAllowed = null;
  assert.equal(selectedWorkerEligibility(choice, source, false, now).eligible, false);
  assert.equal(selectedWorkerEligibility(choice, source, false, now, "task-pin").eligible, true);
  source.catalog.harnesses[0].quota.ordinaryUsageAllowed = true;
  source.catalog.checkedAt = new Date(now - 300_001).toISOString();
  assert.equal(selectedWorkerEligibility(choice, source, false, now).eligible, false);
});
