import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installation, selectRelease, serviceLock, swapPackage, validatePackage, verifyArchive, versionParts, boundedDownload, recoverUpdate, prepareRecoveryRuntime } from "../src/update.ts";

const version = "0.1.0-beta.28";
const base = `https://github.com/kaltstart-co/agentklar/releases/download/v${version}/`;
function release(v = version) {
  const prefix = `https://github.com/kaltstart-co/agentklar/releases/download/v${v}/`;
  return { draft: false, prerelease: v.includes("beta"), tag_name: `v${v}`, assets: [`agentklar-${v}.tgz`, "SHA256.txt"].map(name => ({ name, browser_download_url: prefix + name })) };
}
function packageFixture(root: string, v: string, compatibility = 1) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agentklar", version: v, agentklarDataCompatibility: compatibility, engines: { node: ">=24 <25" }, bin: { agentklar: "bin/agentklar.mjs" } }));
  for (const entry of ["bin/agentklar.mjs", "dist/server/server.js", "dist/server/mcp.js", "dist/server/update.js", "dist/web/index.html"]) {
    mkdirSync(dirname(join(root, entry)), { recursive: true }); writeFileSync(join(root, entry), "fixture");
  }
}

test("release discovery includes verified betas and refuses foreign, duplicate or unsupported assets", () => {
  assert.equal(selectRelease([release("0.1.0-beta.9"), release()]).version, version);
  assert.equal(selectRelease([release(), release("0.1.0")]).version, "0.1.0");
  for (const bad of ["0.1.0-beta.028", "0.1.0-beta.999999999", "1.0.0", "0.1.1", "v0.1.0", "0.1.0-beta.28;echo x"]) assert.throws(() => versionParts(bad));
  const wrong = release(); wrong.assets[0]!.browser_download_url = "https://other.example/file";
  assert.throws(() => selectRelease([wrong]));
  const duplicate = release(); duplicate.assets.push(duplicate.assets[0]!);
  assert.throws(() => selectRelease([duplicate]));
  assert.throws(() => selectRelease([{ ...release(), draft: true }]));
});

test("checksum validation rejects altered or missing release bytes", () => {
  const archive = Buffer.from("release bytes"), hash = createHash("sha256").update(archive).digest("hex");
  const selected = selectRelease([release()]);
  verifyArchive(selected, archive, `${hash}  agentklar-${version}.tgz\n`);
  assert.throws(() => verifyArchive(selected, Buffer.from("changed"), `${hash}  agentklar-${version}.tgz`));
  assert.throws(() => verifyArchive(selected, archive, `${hash}  other.tgz`));
  assert.throws(() => verifyArchive(selected, archive, `${hash}  agentklar-${version}.tgz\n${hash}  agentklar-${version}.tgz`));
});

test("download limits are enforced without accepting failed responses", async () => {
  const fake = (async () => new Response("12345")) as typeof fetch;
  assert.equal((await boundedDownload(base + "SHA256.txt", 5, fake)).toString(), "12345");
  await assert.rejects(boundedDownload(base + "SHA256.txt", 4, fake), /too large/);
  await assert.rejects(boundedDownload(base + "SHA256.txt", 5, (async () => new Response("no", { status: 404 })) as typeof fetch), /download failed/);
});

test("install detection requires the existing global CLI and package compatibility", () => {
  const temp = mkdtempSync(join(tmpdir(), "agentklar-update-install-"));
  try {
    const target = join(temp, "lib/node_modules/agentklar"); packageFixture(target, version);
    mkdirSync(join(temp, "bin")); symlinkSync(join(target, "bin/agentklar.mjs"), join(temp, "bin/agentklar"));
    assert.equal(installation(target, () => dirname(target)).supported, process.getuid?.() !== 0);
    assert.equal(installation(target, () => temp).supported, false);
    validatePackage(target, version);
    packageFixture(target, version, 2); assert.throws(() => validatePackage(target, version), /compatibility/);
    packageFixture(target, version); rmSync(join(target, "dist/server/mcp.js")); assert.throws(() => validatePackage(target, version));
    assert.equal(installation(temp).mode, "source");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("foreground service ownership blocks the update without stopping the owner", () => {
  const home = mkdtempSync(join(tmpdir(), "agentklar-update-lock-"));
  const owner = new DatabaseSync(join(home, "service-lock.sqlite"));
  try {
    owner.exec("CREATE TABLE owner(id); BEGIN EXCLUSIVE");
    assert.throws(() => serviceLock(home), /running/);
    owner.exec("ROLLBACK");
    const releaseLock = serviceLock(home); releaseLock();
    owner.exec("BEGIN EXCLUSIVE; ROLLBACK");
  } finally { owner.close(); rmSync(home, { recursive: true, force: true }); }
});

for (const scenario of ["success", "busy", "rename failure", "new service fails"] as const) test(`package swap: ${scenario} preserves work and the previous package`, async () => {
  const temp = mkdtempSync(join(tmpdir(), "agentklar-update-swap-"));
  const target = join(temp, "agentklar"), replacement = join(temp, "staged"), recovery = join(temp, "recovery");
  mkdirSync(recovery); packageFixture(target, "0.1.0-beta.27"); packageFixture(replacement, version);
  const work = join(temp, "state.sqlite"); writeFileSync(work, "saved work and native choices");
  let stopped = 0; const started: string[] = [];
  const lifecycle = { running: true, stop: async () => { if (scenario === "busy") throw new Error("active worker"); stopped++; }, start: async (v: string) => { started.push(v); if (scenario === "new service fails" && v === version) throw new Error("not healthy"); } };
  try {
    if (scenario === "rename failure") lifecycle.stop = async () => { stopped++; rmSync(replacement, { recursive: true }); };
    if (scenario === "success") {
      await swapPackage(target, replacement, recovery, lifecycle);
      assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, version);
      assert.ok(existsSync(join(recovery, "previous"))); assert.deepEqual(started, [version]);
    } else {
      await assert.rejects(swapPackage(target, replacement, recovery, lifecycle), /previous package/);
      assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, "0.1.0-beta.27");
      assert.equal(started.at(-1), scenario === "busy" ? undefined : "0.1.0-beta.27");
    }
    assert.equal(readFileSync(work, "utf8"), "saved work and native choices");
    assert.equal(stopped, scenario === "busy" ? 0 : scenario === "new service fails" ? 2 : 1);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("release redirects cannot contact another host", async () => {
  const destinations: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    destinations.push(String(url));
    return new Response(null, { status: 302, headers: { location: "https://untrusted.example/payload" } });
  }) as typeof fetch;
  await assert.rejects(boundedDownload(base + "SHA256.txt", 100, fake), /Unexpected official/);
  assert.deepEqual(destinations, [base + "SHA256.txt"]);
});

test("startup maintenance cannot be bypassed by ordinary resume or API writes", async () => {
  const { createService } = await import("../src/service.ts");
  const home = mkdtempSync(join(tmpdir(), "agentklar-update-maintenance-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const marker = join(home, "update-maintenance.json");
  writeFileSync(marker, JSON.stringify({ transaction: "22222222-2222-4222-8222-222222222222", serviceId: id, recovery: join(home, "recovery") }), { mode: 0o600 });
  const service = createService(home, 4317, undefined, null, null, undefined, {}, { id, key: "secret" });
  const operator = { "x-agentklar-operator-key": "secret", "x-agentklar-service-id": id };
  const base = "http://127.0.0.1:4317";
  try {
    const state = await (await service.app.request(base + "/api/operator/status", { headers: operator })).json();
    assert.equal(state.quiesced, true);
    const resumed = await service.app.request(base + "/api/operator/resume", { method: "POST", headers: operator, body: "{}" });
    assert.equal(resumed.status, 409);
    assert.equal((await service.app.request(base + "/api/projects", { method: "POST", headers: { authorization: `Bearer ${service.bearer}` }, body: "{}" })).status, 503);
    assert.equal((await service.app.request(base + "/api/update", { headers: { authorization: `Bearer ${service.bearer}` } })).status, 403);
    const setup = await service.app.request(service.setupUrl);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const update = await service.app.request(base + "/api/update", { headers: { cookie } });
    assert.equal(update.status, 200);
    const metadata = await update.json();
    assert.equal(metadata.checkedAt, null);
    assert.equal(metadata.latest, null);
    assert.ok(!JSON.stringify(metadata).includes(home));
  } finally { await service.close(); rmSync(home, { recursive: true, force: true }); }
});

test("in-flight UI writes refuse normal operator quiesce until they settle", async () => {
  const { createService } = await import("../src/service.ts");
  const home = mkdtempSync(join(tmpdir(), "agentklar-update-fence-"));
  const service = createService(home, 4317, undefined, null, null, undefined, {}, { id: "test-id", key: "secret" });
  const base = "http://127.0.0.1:4317";
  const headers = { "x-agentklar-operator-key": "secret", "x-agentklar-service-id": "test-id" };
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const enteredWrite = new Promise<void>(resolve => { entered = resolve; });
  service.app.post("/api/test-save", async c => { entered(); await waiting; return c.json({ ok: true }); });
  try {
    const save = service.app.request(base + "/api/test-save", { method: "POST", headers: { authorization: `Bearer ${service.bearer}` }, body: "{}" });
    await enteredWrite;
    const quiesce = () => service.app.request(base + "/api/operator/quiesce", { method: "POST", headers, body: JSON.stringify({ force: false }) });
    assert.equal((await quiesce()).status, 409);
    finish(); await save;
    assert.equal((await quiesce()).status, 200);
    assert.equal((await service.app.request(base + "/api/test-save", { method: "POST", headers: { authorization: `Bearer ${service.bearer}` }, body: "{}" })).status, 503);
  } finally { finish(); await service.close(); rmSync(home, { recursive: true, force: true }); }
});

for (const phase of ["old-saved", "replaced", "restored", "changed-journal"] as const) test(`interrupted update recovery: ${phase}`, async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-recovery-")));
  const parent = join(temp, "lib/node_modules"); mkdirSync(parent, { recursive: true });
  const target = join(parent, "agentklar");
  const recovery = join(parent, ".agentklar-update-11111111-1111-4111-8111-111111111111"); mkdirSync(recovery, { mode: 0o700 });
  const replacement = join(recovery, "staging/lib/node_modules/agentklar");
  const previous = join(recovery, "previous");
  const lock = join(parent, ".agentklar-update-lock"); mkdirSync(lock, { mode: 0o700 });
  packageFixture(target, "0.1.0-beta.27"); packageFixture(replacement, version);
  const original = statSync(target), staged = statSync(replacement);
  if (phase !== "restored") renameSync(target, previous);
  if (phase === "replaced") renameSync(replacement, target);
  const journal = { phase: phase === "changed-journal" ? "old-saved" : phase, recovery, target, replacement, previous, oldVersion: "0.1.0-beta.27", nextVersion: version, original: { dev: original.dev, ino: original.ino }, staged: { dev: staged.dev, ino: staged.ino } };
  const text = JSON.stringify(journal);
  writeFileSync(join(recovery, "journal.json"), text, { mode: 0o600 });
  writeFileSync(join(lock, "recovery.json"), JSON.stringify({ recovery, target, pid: 2147483647, journalHash: createHash("sha256").update(text).digest("hex") }), { mode: 0o600 });
  let stops = 0; const starts: string[] = [];
  const lifecycle = { running: true, paused: () => false, stop: async () => { stops++; }, start: async (v: string) => { starts.push(v); } };
  try {
    if (phase === "changed-journal") {
      writeFileSync(join(recovery, "journal.json"), JSON.stringify({ ...journal, phase: "complete" }));
      await assert.rejects(recoverUpdate(recovery, target, lifecycle), /journal changed/);
      assert.equal(stops, 0); assert.deepEqual(starts, []); assert.ok(existsSync(previous));
    } else {
      await recoverUpdate(recovery, target, lifecycle);
      assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, "0.1.0-beta.27");
      assert.equal(stops, phase === "restored" ? 0 : 1); assert.deepEqual(starts, ["0.1.0-beta.27"]); assert.equal(existsSync(lock), false);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("resume acknowledgment loss after commit never rolls the package back", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agentklar-update-commit-"));
  const target = join(temp, "agentklar"), replacement = join(temp, "staged"), recovery = join(temp, "recovery");
  mkdirSync(recovery); packageFixture(target, "0.1.0-beta.27"); packageFixture(replacement, version);
  let stops = 0;
  const lifecycle = { running: true, stop: async () => { stops++; }, start: async (_v: string, commit?: () => void) => { commit?.(); throw new Error("resume acknowledgment lost"); } };
  try {
    await assert.rejects(swapPackage(target, replacement, recovery, lifecycle), /committed/);
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, version);
    assert.equal(JSON.parse(readFileSync(join(recovery, "journal.json"), "utf8")).phase, "committed");
    assert.equal(stops, 1); assert.ok(existsSync(join(recovery, "previous")));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("standalone recovery runs in a subprocess when the global package is absent", () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-recovery-driver-")));
  const prefix = join(temp, "prefix"), parent = join(prefix, "lib/node_modules");
  mkdirSync(parent, { recursive: true }); mkdirSync(join(prefix, "bin"));
  const target = join(parent, "agentklar");
  const recovery = join(parent, ".agentklar-update-33333333-3333-4333-8333-333333333333"); mkdirSync(recovery, { mode: 0o700 });
  const replacement = join(recovery, "staging/lib/node_modules/agentklar"), previous = join(recovery, "previous");
  const lock = join(parent, ".agentklar-update-lock"); mkdirSync(lock, { mode: 0o700 });
  packageFixture(target, "0.1.0-beta.27"); packageFixture(replacement, version);
  const original = statSync(target), staged = statSync(replacement);
  prepareRecoveryRuntime(recovery);
  renameSync(target, previous);
  symlinkSync(join(target, "bin/agentklar.mjs"), join(prefix, "bin/agentklar"));
  const home = join(temp, "home"); mkdirSync(home, { mode: 0o700 });
  const journal = { phase: "old-saved", recovery, target, replacement, previous, home, oldVersion: "0.1.0-beta.27", nextVersion: version, original: { dev: original.dev, ino: original.ino }, staged: { dev: staged.dev, ino: staged.ino } };
  const text = JSON.stringify(journal);
  writeFileSync(join(recovery, "journal.json"), text, { mode: 0o600 });
  writeFileSync(join(lock, "recovery.json"), JSON.stringify({ recovery, target, pid: 2147483647, journalHash: createHash("sha256").update(text).digest("hex") }), { mode: 0o600 });
  // Only this fixture npm can run. It reports the temporary global root and rejects every mutation.
  const npm = join(prefix, "bin/npm");
  writeFileSync(npm, `#!${process.execPath}\nif (process.argv.slice(2).join(" ") !== "root -g") process.exit(99);\nconsole.log(${JSON.stringify(parent)});\n`); chmodSync(npm, 0o700);
  try {
    assert.equal(existsSync(target), false);
    const result = spawnSync(process.execPath, [join(recovery, "recover.mjs")], { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: join(prefix, "bin"), AGENTKLAR_HOME: home } });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /Previous AgentKlar .* restored/);
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, "0.1.0-beta.27");
    assert.equal(existsSync(lock), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
