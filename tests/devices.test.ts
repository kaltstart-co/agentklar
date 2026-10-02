import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceSettings, installationFingerprint, selectedInstallation } from "../src/devices.ts";
import { createService } from "../src/service.ts";

test("device identity and installations persist; updates work while stale saves and missing choices are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-device-"));
  const oldPath = process.env.PATH;
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  try {
    process.env.PATH = dir;
    const path = join(dir, "claude");
    writeFileSync(path, "#!/bin/sh\nprintf '2.1.284\\n'\n"); chmodSync(path, 0o700);
    const first = deviceSettings(db);
    const id = first.device.id;
    assert.equal(first.selected("claude", "fallback"), "fallback");
    const item = first.status({ claude: "fallback" }).find((e) => e.harness === "claude")!.installations.find((e) => e.path === path)!;
    assert.equal(item.version, "2.1.284");
    assert.equal(first.save("claude", path, "0".repeat(64)), false);
    assert.equal(first.save("claude", path, item.fingerprint), true);
    const next = deviceSettings(db);
    assert.equal(next.device.id, id);
    assert.equal(next.selected("claude", "fallback"), path);
    writeFileSync(path, "#!/bin/sh\nprintf '2.1.285\\n'\n");
    assert.notEqual(installationFingerprint(path), item.fingerprint);
    assert.equal(next.save("claude", path, item.fingerprint), false);
    assert.equal(next.selected("claude", "fallback"), path);
    rmSync(path);
    assert.equal(next.selected("claude", "fallback"), null);
    assert.equal(next.save("claude", path, item.fingerprint), false);
    assert.equal(next.save("codex", process.execPath, installationFingerprint(process.execPath)!), false);
    const appPath = (version: string) => join(dir, "Library/Application Support/Claude/claude-code", version, "claude.app/Contents/MacOS/claude");
    const priorApp = appPath("2.1.280"), updatedApp = appPath("2.1.284");
    mkdirSync(join(updatedApp, ".."), { recursive: true });
    writeFileSync(updatedApp, "#!/bin/sh\nexit 0\n"); chmodSync(updatedApp, 0o700);
    assert.equal(selectedInstallation("claude", priorApp, [path, updatedApp]), updatedApp);
    assert.equal(selectedInstallation("claude", priorApp, [process.execPath]), null);
  } finally { process.env.PATH = oldPath; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("installation changes require trusted UI and snapshot reports actual worker command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-device-service-"));
  const oldPath = process.env.PATH;
  const path = join(dir, "codex");
  writeFileSync(path, "#!/bin/sh\nprintf '0.159.2\\n'\n"); chmodSync(path, 0o700);
  process.env.PATH = dir;
  let service = createService(dir, 4317, undefined, process.execPath, null);
  try {
    const headers = { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" };
    const snapshot = await (await service.app.request("http://127.0.0.1:4317/api/snapshot", { headers })).json();
    assert.ok(snapshot.device.id); assert.ok(snapshot.device.label);
    assert.equal(snapshot.harnesses.find((h: {id:string}) => h.id === "codex").executable, process.execPath);
    const response = await service.app.request("http://127.0.0.1:4317/api/native-installations", { method: "POST", headers, body: JSON.stringify({ harness: "codex", path: process.execPath, fingerprint: installationFingerprint(process.execPath) }) });
    assert.equal(response.status, 403);
    const setup = await service.app.request(service.setupUrl);
    const ui = { Cookie: setup.headers.get("set-cookie")!.split(";")[0], Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" };
    const saved = await service.app.request("http://127.0.0.1:4317/api/native-installations", { method: "POST", headers: ui, body: JSON.stringify({ harness: "codex", path, fingerprint: installationFingerprint(path) }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).restartRequired, true);
    const current = await (await service.app.request("http://127.0.0.1:4317/api/snapshot", { headers: ui })).json();
    assert.equal(current.harnesses.find((h: {id:string}) => h.id === "codex").executable, process.execPath);
    await service.close();
    service = createService(dir, 4317, undefined, process.execPath, null);
    const next = await (await service.app.request("http://127.0.0.1:4317/api/snapshot", { headers: { Authorization: `Bearer ${service.bearer}` } })).json();
    assert.equal(next.device.id, snapshot.device.id);
    assert.equal(next.harnesses.find((h: {id:string}) => h.id === "codex").executable, path);
  } finally { await service.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});
