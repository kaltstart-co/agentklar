import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  CatalogCache,
  parseQuota,
  parseClaudeQuota,
  readCodexCatalog,
  readClaudeAuth,
  readClaudeCatalog,
  readMuseCatalog,
  type CatalogReader,
} from "../src/catalog.ts";
import { createService } from "../src/service.ts";
import { executable } from "../src/harnesses.ts";
import type { CatalogSnapshot, Project } from "../src/contracts.ts";

const fixture = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [mode,log] = process.argv.slice(2);
appendFileSync(log+'.pid',String(process.pid));
if(mode==='helpers'){
 const helper=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
 appendFileSync(log+'.helper',String(helper.pid));
}
const row = n => ({model:'m'+n, displayName:'Model '+n, description:'Vendor description', isDefault:n===0,inputModalities:['text'],hidden:false});
const quota = {ordinaryUsageAllowed:false,accountId:'SECRET_ACCOUNT',rateLimitsByLimitId:{codex:{limitId:'codex',limitName:'Codex',normalModelSlug:null,primary:{usedPercent:42,windowDurationMins:300,resetsAt:2000000000},secondary:null,spendControlReached:null,credits:{balance:'SECRET_BALANCE'}}},rateLimits:{limitId:'legacy'}};
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); appendFileSync(log,JSON.stringify(r)+'\\n');
 if(r.method==='initialized')return;
 if(mode==='hang'||mode==='helpers') {process.on('SIGTERM',()=>{});return;}
 if(mode==='huge'){process.stdout.write('x'.repeat(1024*1024+1));return;}
 const reply = result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
 const fail = ()=>process.stdout.write(JSON.stringify({id:r.id,error:{message:'SECRET_TOKEN email@example.com'}})+'\\n');
 if(r.method==='initialize')return reply({});
 if(r.method==='account/rateLimits/read')return mode==='quota-fail'?fail():reply(quota);
 if(r.method==='model/list') {
  if(mode==='collision')process.stdout.write(JSON.stringify({id:r.id,method:'request/approval',params:{secret:'SECRET'}})+'\\n');
  if(mode==='long')return reply({data:[{...row(0),model:'x'.repeat(121)}, {...row(1),description:'d'.repeat(801)}],nextCursor:null});
  if(mode==='partial' && r.params.cursor)return fail();
  if(mode==='models-fail')return fail();
  if(mode==='repeat')return reply({data:[row(0)],nextCursor:'again'});
  if(mode==='cap')return reply({data:Array.from({length:101},(_,n)=>row(n)),nextCursor:'more'});
  if(!r.params.cursor)return reply({data:[row(0),row(0),{model:'hidden',hidden:true}],nextCursor:'next'});
  return reply({data:[row(1)],nextCursor:null});
 }
 throw new Error('Unexpected method '+r.method);
});
`;
const museFixture = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [mode, log] = process.argv.slice(2);
appendFileSync(log+'.pid', String(process.pid));
const row = (modelId, providerId='muse', profileId=null) => ({modelId, displayLabel:modelId, description:'Native model', isDefault:modelId==='muse-spark-1.3-contributor', providerId, profileId});
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line); appendFileSync(log, JSON.stringify(request)+'\\n');
 if(mode==='hang'){process.on('SIGTERM',()=>{});return;}
 if(mode==='huge'){process.stdout.write('x'.repeat(1024*1024+1));return;}
 if(request.method==='initialized')return;
 const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
 if(request.method==='initialize')return reply({});
 if(request.method==='model/list')return mode==='malformed' ? reply({models:{}}) : reply({source:mode==='fake'?'fakeCatalog':mode==='config'?'configCatalog':mode==='bundled'?'bundledCatalog':'providerCatalog',providerId:'muse',profileId:null,models:[row('muse-spark-1.3'),row('muse-spark-1.3-contributor'),row('muse-spark-1.3'),row('foreign','other')]});
 throw new Error('Unexpected method '+request.method);
});
`;
const claudeAuthFixture = `
import { appendFileSync } from 'node:fs';
const [mode, log] = process.argv.slice(2);
appendFileSync(log + '.pid', String(process.pid));
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (mode === 'large') { process.stdout.write('x'.repeat(20000)); setInterval(() => {}, 1000); }
else if (mode === 'large-error') { process.stderr.write('x'.repeat(20000)); setInterval(() => {}, 1000); }
else if (mode === 'bad') { process.stdout.write('not-json'); process.exitCode = 1; }
else {
 const loggedIn = mode === 'in' || mode === 'true-exit-one';
 process.stdout.write(JSON.stringify({ loggedIn, authMethod: mode === 'other-auth' ? 'apiKey' : loggedIn ? 'oauth' : 'none', apiProvider: mode === 'third-party' ? 'thirdParty' : 'firstParty', email: 'SECRET_EMAIL', token: 'SECRET_TOKEN', configDirectory: 'SECRET_PATH' }));
 process.exitCode = mode === 'false-exit-zero' ? 0 : mode === 'true-exit-one' ? 1 : loggedIn ? 0 : 1;
}
`;
function project(): Project {
  return {
    id: randomUUID(),
    name: "one",
    path: tmpdir(),
    preference: "balanced",
    roles: [],
    createdAt: "now",
  };
}
function snapshot(p: Project): CatalogSnapshot {
  return { projectId: p.id, checkedAt: "fixture", harnesses: [] };
}

function assertStopped(pid: number, label: string) {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // A killed orphan can remain as a zombie until PID 1 reaps it. It cannot run or hold pipes.
    const state = stat.charAt(stat.lastIndexOf(") ") + 2);
    assert.ok(["Z", "X", "x"].includes(state), `${label}: PID ${pid} is still running (Linux state ${state})`);
    return;
  }
  assert.throws(() => process.kill(pid, 0), `${label}: PID ${pid} is still alive`);
}

test("Muse probe reads only the native model list and removes incompatible routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-muse-catalog-"));
  const file = join(dir, "muse.mjs"), log = join(dir, "wire");
  writeFileSync(file, museFixture);
  try {
    const result = await readMuseCatalog(process.execPath, dir, new AbortController().signal, [file, "ok", log]);
    assert.equal(result.harness, "muse");
    assert.equal(result.modelsStatus, "available");
    assert.deepEqual(result.models.map((m) => m.id), ["muse-spark-1.3", "muse-spark-1.3-contributor"]);
    assert.equal(result.models[1].isDefault, true);
    assert.equal(result.modelsTruncated, true);
    assert.match(result.modelsMessage!, /native model list.*does not verify sign-in or model access/i);
    assert.equal(result.quota.status, "unavailable");
    assert.equal(result.quota.ordinaryUsageAllowed, null);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((r) => r.method), ["initialize", "initialized", "model/list"]);
    assert.deepEqual(calls[0].params.capabilities, { experimentalApi: false, userInputDialogs: false });
    assert.deepEqual(calls[2].params, {});
    assert.ok(calls.every((r) => !JSON.stringify(r).includes("session")));
    assertStopped(Number(readFileSync(log + ".pid", "utf8")), "Muse probe");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Muse discovery falls back to the user's local bin when PATH omits it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-muse-path-"));
  const localBin = join(dir, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const muse = join(localBin, "muse");
  writeFileSync(muse, "#!/bin/sh\nexit 0\n");
  chmodSync(muse, 0o755);
  try { assert.equal(executable("muse", "", dir), muse); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Muse probe rejects fake and malformed lists and stops on overflow or abort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-muse-failure-"));
  const file = join(dir, "muse.mjs");
  writeFileSync(file, museFixture);
  try {
    for (const mode of ["config", "bundled"]) {
      const result = await readMuseCatalog(process.execPath, dir, new AbortController().signal, [file, mode, join(dir, mode)]);
      assert.equal(result.modelsStatus, "available", mode);
      assert.match(result.modelsMessage!, /does not verify sign-in/i);
    }
    for (const mode of ["fake", "malformed", "huge", "hang"]) {
      const log = join(dir, mode);
      const controller = new AbortController();
      const reading = readMuseCatalog(process.execPath, dir, controller.signal, [file, mode, log], 2000);
      if (mode === "hang") {
        for (let attempt = 0; attempt < 100 && !existsSync(log + ".pid"); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(existsSync(log + ".pid"));
        controller.abort();
      }
      const result = await reading;
      assert.equal(result.modelsStatus, "unavailable", mode);
      assert.deepEqual(result.models, [], mode);
      assert.equal(result.quota.status, "unavailable", mode);
      assertStopped(Number(readFileSync(log + ".pid", "utf8")), mode);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Codex metadata probe sends only discovery methods, pages and deduplicates; quota uses map without private fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-catalog-"));
  const file = join(dir, "native.mjs"),
    log = join(dir, "wire");
  writeFileSync(file, fixture);
  try {
    const result = await readCodexCatalog(
      process.execPath,
      dir,
      new AbortController().signal,
      [file, "ok", log],
    );
    assert.equal(result.modelsStatus, "available");
    assert.deepEqual(
      result.models.map((m) => m.id),
      ["m0", "m1"],
    );
    assert.equal(result.models[0].isDefault, true);
    assert.deepEqual(result.models[0].inputModalities, ["text"]);
    assert.equal(result.modelsTruncated, false);
    assert.equal(result.quota.ordinaryUsageAllowed, false);
    assert.equal(result.quota.buckets.length, 1);
    assert.equal(result.quota.buckets[0].id, "codex");
    assert.doesNotMatch(
      JSON.stringify(result),
      /SECRET|accountId|credits|email/,
    );
    const requests = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      requests.map((r) => r.method),
      [
        "initialize",
        "initialized",
        "model/list",
        "account/rateLimits/read",
        "model/list",
      ],
    );
    assert.equal(requests[0].params.capabilities.experimentalApi, false);
    assert.equal(requests[3].params.excludeResetCreditDetails, true);
    assert.equal(requests[4].params.cursor, "next");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe failures stay separate and sanitized; repeated cursors, oversized frames and timeout are bounded", async () => {
  assert.throws(() => assertStopped(process.pid, "live control"));
  const dir = mkdtempSync(join(tmpdir(), "agentklar-probe-"));
  const file = join(dir, "native.mjs");
  writeFileSync(file, fixture);
  try {
    for (const mode of [
      "models-fail",
      "quota-fail",
      "repeat",
      "cap",
      "huge",
      "hang",
      "helpers",
      "collision",
      "long",
      "partial",
    ]) {
      const log = join(dir, mode);
      const result = await readCodexCatalog(
        process.execPath,
        dir,
        new AbortController().signal,
        [file, mode, log],
        // Parallel test startup can take over 100 ms before this fixture writes its PID.
        2000,
      );
      const pidText = readFileSync(log + ".pid", "utf8").trim();
      const pid = Number(pidText);
      assert.ok(Number.isSafeInteger(pid) && pid > 0, `${mode}: invalid child PID ${JSON.stringify(pidText)}`);
      assert.throws(() => process.kill(pid, 0), `${mode}: child PID ${pid} is still alive`);
      if (mode === "helpers") {
        const helperText = readFileSync(log + ".helper", "utf8").trim();
        const helper = Number(helperText);
        assert.ok(Number.isSafeInteger(helper) && helper > 0, `${mode}: invalid helper PID ${JSON.stringify(helperText)}`);
        assertStopped(helper, `${mode}: helper`);
      }
      assert.doesNotMatch(JSON.stringify(result), /SECRET|email@example/);
      if (mode === "models-fail") {
        assert.equal(result.modelsStatus, "unavailable");
        assert.equal(result.quota.status, "available");
      }
      if (mode === "quota-fail") {
        assert.equal(result.modelsStatus, "available");
        assert.equal(result.quota.status, "unavailable");
      }
      if (mode === "repeat" || mode === "cap") {
        assert.equal(result.modelsTruncated, true);
        assert.ok(result.models.length <= 100);
      }
      if (mode === "huge" || mode === "hang" || mode === "helpers")
        assert.equal(result.modelsStatus, "unavailable");
      if (mode === "collision") assert.equal(result.modelsStatus, "available");
      if (mode === "long") {
        assert.equal(result.modelsTruncated, true);
        assert.equal(result.models.length, 1);
        assert.equal(result.models[0].description.length, 800);
      }
      if (mode === "partial") {
        assert.equal(result.modelsStatus, "unavailable");
        assert.equal(result.modelsTruncated, true);
        assert.equal(result.models.length, 1);
      }
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (mode === "repeat")
        assert.equal(calls.filter((r) => r.method === "model/list").length, 2);
      if (mode === "cap")
        assert.equal(calls.filter((r) => r.method === "model/list").length, 1);
    }
    const absent = await readCodexCatalog(
      join(dir, "absent"),
      dir,
      new AbortController().signal,
      [],
      100,
    );
    assert.equal(absent.modelsStatus, "unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota keeps malformed values unknown, accepts reported percentages and falls back only when multi-bucket view is empty", () => {
  assert.equal(parseQuota(null).status, "unavailable");
  const parsed = parseQuota({
    ordinaryUsageAllowed: "true",
    rateLimitsByLimitId: {
      one: {
        primary: {
          usedPercent: 120,
          windowDurationMins: "300",
          resetsAt: 1e16,
        },
        secondary: { usedPercent: NaN },
        spendControlReached: "false",
      },
    },
    rateLimits: { limitId: "legacy" },
  });
  assert.equal(parsed.ordinaryUsageAllowed, null);
  assert.equal(parsed.buckets[0].primary!.usedPercent, 120);
  assert.equal(parsed.buckets[0].primary!.windowDurationMins, null);
  assert.equal(parsed.buckets[0].primary!.resetsAt, null);
  assert.equal(parsed.buckets[0].secondary, null);
  assert.equal(parsed.buckets[0].spendControlReached, null);
  assert.equal(
    parseQuota({
      rateLimitsByLimitId: {},
      rateLimits: { limitId: "legacy", primary: { usedPercent: 0 } },
    }).buckets[0].id,
    "legacy",
  );
  assert.deepEqual(parseQuota({ ordinaryUsageAllowed: true }).buckets, []);
  assert.equal(
    parseQuota({ ordinaryUsageAllowed: true }).ordinaryUsageAllowed,
    true,
  );
  assert.equal(
    parseQuota({
      rateLimitsByLimitId: { one: null },
      rateLimits: { limitId: "legacy" },
    }).status,
    "unavailable",
  );
});

test("Claude SDK discovery waits on empty input, preserves native settings and closes without a prompt", async () => {
  let options!: Options,
    closed = false,
    input!: AsyncIterable<unknown>,
    next!: Promise<IteratorResult<unknown>>;
  const factory = ((args: {
    prompt: AsyncIterable<unknown>;
    options: Options;
  }) => {
    options = args.options;
    input = args.prompt;
    next = input[Symbol.asyncIterator]().next();
    return {
      supportedModels: async () => [
        {
          value: "default",
          displayName: "Default",
          description: "Native vendor description",
          resolvedModel: "native-model",
        },
        { value: "default", displayName: "Duplicate" },
      ],
      close() {
        closed = true;
      },
    };
  }) as unknown as typeof query;
  const result = await readClaudeCatalog(
    "claude",
    tmpdir(),
    new AbortController().signal,
    factory,
  );
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].isDefault, true);
  assert.equal(result.models[0].resolvedModel, "native-model");
  assert.equal(result.models[0].inputModalities, null);
  assert.equal(result.quota.status, "unavailable");
  assert.equal(closed, true);
  assert.equal((await next).done, true);
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.settingSources, ["user", "project", "local"]);
  assert.deepEqual(options.tools, []);
  assert.equal(options.abortController!.signal.aborted, true);
  const fail = ((args: { options: Options }) => ({
    supportedModels: async () => {
      throw new Error("SECRET_TOKEN");
    },
    close() {},
  })) as unknown as typeof query;
  assert.doesNotMatch(
    JSON.stringify(
      await readClaudeCatalog(
        "claude",
        tmpdir(),
        new AbortController().signal,
        fail,
      ),
    ),
    /SECRET/,
  );
  const hang = (() => ({
    supportedModels: () => new Promise(() => {}),
    close() {
      closed = true;
    },
  })) as unknown as typeof query;
  assert.equal(
    (
      await readClaudeCatalog(
        "claude",
        tmpdir(),
        new AbortController().signal,
        hang,
        20,
      )
    ).modelsStatus,
    "unavailable",
  );
});

test("Claude quota keeps zero and unknown windows, accepts resets and excludes private usage", () => {
  const raw = {
    rate_limits_available: true,
    accountId: "SECRET_ACCOUNT", session: { total_cost_usd: "SECRET_COST" },
    behaviors: { data: "SECRET_TRANSCRIPT" },
    rate_limits: {
      five_hour: { utilization: 0, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: { utilization: 100, resets_at: "bad" },
      seven_day_sonnet: { utilization: -1, resets_at: "2030-01-01T00:00:00Z" },
      seven_day_oauth_apps: { utilization: 50, resets_at: "2030-01-01T02:00:00+02:00" },
      model_scoped: [{ display_name: "Fable", utilization: 25, resets_at: "2030-01-02T00:00:00Z" }],
      extra_usage: { used_credits: "SECRET_CREDIT" },
    },
  };
  const quota = parseClaudeQuota(raw);
  assert.equal(quota.status, "available");
  assert.equal(quota.ordinaryUsageAllowed, null);
  assert.deepEqual(quota.buckets[0].primary, { usedPercent: 0, windowDurationMins: 300, resetsAt: 1893456000 });
  assert.equal(quota.buckets[0].secondary, null);
  assert.equal(quota.buckets.find(b => b.normalModel === "opus")!.secondary!.resetsAt, null);
  assert.equal(quota.buckets.find(b => b.normalModel === "sonnet")!.secondary, null);
  assert.equal(quota.buckets.find(b => b.id === "seven_day_oauth_apps")!.secondary!.resetsAt, 1893456000);
  assert.equal(quota.buckets.find(b => b.name === "Fable")!.secondary!.windowDurationMins, 10080);
  assert.match(quota.message!, /experimental/);
  assert.doesNotMatch(JSON.stringify(quota), /SECRET|credits|behaviors|accountId/);
  for (const malformed of [null, {}, { rate_limits_available: false, rate_limits: raw.rate_limits },
    { rate_limits_available: true, rate_limits: null }]) {
    assert.equal(parseClaudeQuota(malformed).status, "unavailable");
  }
  for (const utilization of [NaN, Infinity, -1, 101, "0", undefined]) {
    assert.equal(parseClaudeQuota({ rate_limits_available: true,
      rate_limits: { five_hour: { utilization } } }).buckets[0].primary, null);
  }
  for (const resets_at of ["2030-02-30T00:00:00Z", "not a date", "2030-01-01", -1, null]) {
    assert.equal(parseClaudeQuota({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 0, resets_at } } }).buckets[0].primary!.resetsAt, null);
  }
  assert.equal(parseClaudeQuota({ rate_limits_available: true, rate_limits: {
    model_scoped: Array.from({ length: 100 }, () => ({ display_name: "Model", utilization: 0 })) } }).buckets.length, 17);
});

test("Claude model and experimental quota reads fail independently under the same bound", async () => {
  for (const mode of ["success", "models-fail", "quota-fail", "quota-hang", "models-hang"]) {
    let requested: unknown, closed = false;
    const factory = (() => ({
      supportedModels: async () => {
        if (mode === "models-fail") throw new Error("SECRET_MODEL");
        if (mode === "models-hang") return new Promise(() => {});
        return [{ value: "haiku", displayName: "Haiku" }];
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: unknown) => {
        requested = options;
        if (mode === "quota-fail") throw new Error("SECRET_QUOTA");
        if (mode === "quota-hang") return new Promise(() => {});
        return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 0 } } };
      },
      close() { closed = true; },
    })) as unknown as typeof query;
    const result = await readClaudeCatalog("claude", tmpdir(), new AbortController().signal, factory, 30);
    assert.deepEqual(requested, { skipBehaviors: true });
    assert.equal(result.modelsStatus, mode.startsWith("models-") ? "unavailable" : "available", mode);
    assert.equal(result.quota.status, mode.startsWith("quota-") ? "unavailable" : "available", mode);
    assert.equal(closed, true);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test("Claude native auth probe keeps only status, bounds output and owns its child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-claude-auth-"));
  const file = join(dir, "auth.mjs");
  writeFileSync(file, claudeAuthFixture);
  try {
    for (const [mode, expected] of [
      ["in", "signed_in"], ["out", "sign_in_required"],
      ["third-party", "unknown"], ["bad", "unknown"],
      ["other-auth", "unknown"], ["false-exit-zero", "unknown"],
      ["true-exit-one", "unknown"], ["large", "unknown"],
      ["large-error", "unknown"], ["hang", "unknown"],
    ] as const) {
      const log = join(dir, mode);
      const result = await readClaudeAuth(process.execPath, dir, new AbortController().signal, [file, mode, log], 2000);
      assert.equal(result.status, expected, mode);
      assert.equal(result.source, "claude-auth-status");
      if (expected === "sign_in_required") {
        assert.match(result.message, /does not check your Claude Desktop sign-in/);
        assert.ok(result.message.includes(`'${process.execPath}' auth login`));
      }
      assert.doesNotMatch(JSON.stringify(result), /SECRET|email|configDirectory|token/i);
      assertStopped(Number(readFileSync(log + ".pid", "utf8")), mode);
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), [mode, log]);
    }
    const log = join(dir, "abort");
    const controller = new AbortController();
    const pending = readClaudeAuth(process.execPath, dir, controller.signal, [file, "hang", log], 2000);
    for (let attempt = 0; attempt < 100 && !existsSync(log + ".pid"); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    assert.equal((await pending).status, "unknown");
    assertStopped(Number(readFileSync(log + ".pid", "utf8")), "abort");
    assert.equal((await readClaudeAuth(process.execPath, dir, controller.signal, [file, "in", join(dir, "unused")])).status, "unknown");
    assert.equal((await readClaudeAuth(join(dir, "missing"), dir, new AbortController().signal)).status, "unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("project cache coalesces refresh, expires after 30 seconds and aborts owned reads on close", async () => {
  let now = 0,
    calls = 0,
    release!: () => void;
  const p = project();
  const cache = new CatalogCache(
    async (p) => {
      calls++;
      await new Promise<void>((r) => {
        release = r;
      });
      return snapshot(p);
    },
    { codex: null, claude: null },
    () => now,
  );
  assert.equal(cache.get(p.id), null);
  const a = cache.refresh(p),
    b = cache.refresh(p);
  assert.equal(a, b);
  release();
  await a;
  await cache.refresh(p);
  assert.equal(calls, 1);
  now = 30000;
  const c = cache.refresh(p);
  assert.equal(calls, 2);
  release();
  await c;
  const other = project();
  assert.equal(cache.get(other.id), null);
  await cache.close();
  assert.equal(cache.get(p.id), null);
  let aborted = false;
  const cancelling = new CatalogCache(
    (p, commands, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(snapshot(p));
        }),
      ),
    { codex: null, claude: null },
  );
  const waiting = cancelling.refresh(p);
  await cancelling.close();
  await waiting;
  assert.equal(aborted, true);
});

test("Claude sign-in status changes only after a fresh catalog read", async () => {
  let now = 0, signedIn = false, reads = 0;
  const p = project();
  const cache = new CatalogCache(async (project) => ({
    projectId: project.id, checkedAt: String(++reads),
    harnesses: [{
      harness: "claude", models: [], modelsStatus: "unavailable", modelsMessage: null,
      modelsTruncated: false, quota: { status: "unavailable", message: null, ordinaryUsageAllowed: null, buckets: [] },
      auth: { status: signedIn ? "signed_in" : "sign_in_required", source: "claude-auth-status", message: "fixture" },
    }],
  }), { codex: null, claude: null }, () => now);
  try {
    assert.equal((await cache.refresh(p)).harnesses[0].auth?.status, "sign_in_required");
    signedIn = true;
    assert.equal((await cache.refresh(p)).harnesses[0].auth?.status, "sign_in_required");
    now = 30000;
    assert.equal((await cache.refresh(p)).harnesses[0].auth?.status, "signed_in");
    assert.equal(reads, 2);
  } finally { await cache.close(); }
});

test("authenticated project API reads only on demand, isolates cache and does not persist catalogs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-catalog-api-"));
  const otherPath = join(dir, "other");
  mkdirSync(otherPath);
  let calls = 0;
  const reader: CatalogReader = async (p) => {
    calls++;
    return snapshot(p);
  };
  const home = join(dir, "home");
  let service = createService(home, 4317, undefined, null, null, reader);
  const request = (path: string, method = "GET", body?: unknown, auth = true) =>
    service.app.request("http://127.0.0.1:4317" + path, {
      method,
      headers: {
        ...(auth ? { Authorization: "Bearer " + service.bearer } : {}),
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const p = await (
      await request("/api/projects", "POST", { name: "one", path: dir })
    ).json();
    const other = await (
      await request("/api/projects", "POST", { name: "two", path: otherPath })
    ).json();
    const path = "/api/projects/" + p.id + "/catalog";
    assert.equal((await request(path, "POST", undefined, false)).status, 401);
    assert.equal(
      (await request("/api/projects/" + randomUUID() + "/catalog", "POST"))
        .status,
      404,
    );
    assert.equal(await (await request(path)).json(), null);
    await request("/api/snapshot");
    assert.equal(calls, 0);
    const [a, b] = await Promise.all([
      request(path, "POST"),
      request(path, "POST"),
    ]);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(calls, 1);
    assert.equal((await (await request(path)).json()).projectId, p.id);
    assert.equal(
      await (await request("/api/projects/" + other.id + "/catalog")).json(),
      null,
    );
    const poll = await (await request("/api/snapshot")).json();
    assert.equal(poll.catalog, undefined);
    assert.equal(poll.checkedAt, undefined);
    assert.equal(calls, 1);
    await service.close();
    service = createService(home, 4317, undefined, null, null, reader);
    assert.equal(await (await request(path)).json(), null);
    assert.equal(service.store.runs().length, 0);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
