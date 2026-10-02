import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, renameSync, symlinkSync } from "node:fs";
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

test("status detects same-path replacement and disappearance against startup without changing its selected command", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-device-update-")), db = new DatabaseSync(":memory:"), prior = process.env.PATH;
  const path = join(dir, "codex");
  const binary = (file: string, version: string) => { writeFileSync(file, `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o700 }); };
  try {
    process.env.PATH = dir; binary(path, "1.2.3");
    const devices = deviceSettings(db), command = devices.selected("codex", path);
    const status = () => devices.status({ codex: command }).find(item => item.harness === "codex")!;
    const initial = status();
    assert.equal(initial.changed, false); assert.equal(initial.baseline!.version, "1.2.3");
    binary(join(dir, "replacement"), "1.2.4"); renameSync(join(dir, "replacement"), path);
    const updated = status();
    assert.equal(updated.selected, path); assert.equal(updated.current!.path, path);
    assert.equal(updated.changed, true); assert.equal(updated.restartRequired, true);
    assert.equal(updated.baseline!.version, "1.2.3"); assert.equal(updated.current!.version, "1.2.4");
    assert.notEqual(updated.baseline!.fingerprint, updated.current!.fingerprint);
    rmSync(path);
    const missing = status();
    assert.equal(missing.restartRequired, true); assert.equal(missing.current!.path, null);
    assert.equal(missing.current!.fingerprint, null); assert.equal(missing.selected, path);
  } finally { process.env.PATH = prior; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Claude desktop version-folder replacement is discovered while its startup choice stays unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-device-desktop-")), db = new DatabaseSync(":memory:");
  const priorHome = process.env.HOME, priorPath = process.env.PATH;
  const app = (version: string) => join(dir, "Library/Application Support/Claude/claude-code", version, "claude.app/Contents/MacOS/claude");
  const add = (version: string) => { const path = app(version); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o700 }); return path; };
  try {
    process.env.HOME = dir; process.env.PATH = dir;
    const old = add("2.1.280"), devices = deviceSettings(db);
    assert.equal(devices.save("claude", old, installationFingerprint(old)!), true);
    const command = devices.selected("claude", null);
    assert.equal(devices.status({ claude: command }).find(item => item.harness === "claude")!.changed, false);
    const current = add("2.1.284"); rmSync(join(dir, "Library/Application Support/Claude/claude-code/2.1.280"), { recursive: true });
    const updated = devices.status({ claude: command }).find(item => item.harness === "claude")!;
    assert.equal(updated.selected, old); assert.equal(updated.saved, old); assert.equal(updated.current!.path, current);
    assert.equal(updated.baseline!.version, "2.1.280"); assert.equal(updated.current!.version, "2.1.284"); assert.equal(updated.restartRequired, true);
    const restarted = deviceSettings(db), newCommand = restarted.selected("claude", null);
    assert.equal(newCommand, current);
    assert.equal(restarted.status({ claude: newCommand }).find(item => item.harness === "claude")!.restartRequired, false);
  } finally { process.env.HOME = priorHome; process.env.PATH = priorPath; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("npm entry metadata and stable shell-wrapper targets invalidate version fingerprints", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-device-wrapper-")), prior = process.env.PATH, db = new DatabaseSync(":memory:");
  const target = join(dir, "node_modules/native/cli"), wrapper = join(dir, "codex"), manifest = join(dir, "node_modules/native/package.json");
  try {
    process.env.PATH = dir; mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "#!/bin/sh\nprintf '1.2.3\\n'\n", { mode: 0o700 });
    writeFileSync(manifest, '{"version":"1.2.3"}');
    symlinkSync(target, join(dir, "linked"));
    const linked = installationFingerprint(join(dir, "linked"));
    writeFileSync(manifest, '{"version":"1.2.4","updated":true}');
    assert.notEqual(installationFingerprint(join(dir, "linked")), linked);
    writeFileSync(wrapper, `#!/bin/sh\nbasedir='${dir}'\nexec "$basedir/node_modules/native/cli" "$@"\n`, { mode: 0o700 });
    const devices = deviceSettings(db), command = devices.selected("codex", wrapper);
    const initial = devices.status({ codex: command }).find(item => item.harness === "codex")!;
    assert.equal(initial.current!.version, "1.2.3");
    writeFileSync(manifest, '{"version":"1.2.5","updated":"again"}');
    const metadataChange = devices.status({ codex: command }).find(item => item.harness === "codex")!;
    assert.equal(metadataChange.changed, true); assert.equal(metadataChange.current!.version, "1.2.3");
    writeFileSync(target, "#!/bin/sh\nprintf '1.2.400\\n'\n");
    const updated = devices.status({ codex: command }).find(item => item.harness === "codex")!;
    assert.equal(updated.changed, true); assert.equal(updated.current!.version, "1.2.400"); assert.equal(updated.baseline!.version, "1.2.3");
  } finally { process.env.PATH = prior; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a harness installed after startup needs restart; an unavailable explicit choice does not switch installations", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-device-new-")), prior = process.env.PATH, db = new DatabaseSync(":memory:");
  const priorHome = process.env.HOME;
  const path = join(dir, "muse");
  try {
    process.env.PATH = dir; process.env.HOME = dir;
    const devices = deviceSettings(db), command = devices.selected("muse", null);
    assert.equal(devices.status({ muse: command }).find(item => item.harness === "muse")!.restartRequired, false);
    writeFileSync(path, "#!/bin/sh\nprintf '1.2.3\\n'\n", { mode: 0o700 });
    const discovered = devices.status({ muse: command }).find(item => item.harness === "muse")!;
    assert.equal(discovered.baseline!.path, null); assert.equal(discovered.current!.path, path); assert.equal(discovered.restartRequired, true);
    assert.equal(devices.save("muse", path, installationFingerprint(path)!), true);
    rmSync(path);
    const alternatives = join(dir, "alternative"); mkdirSync(alternatives);
    writeFileSync(join(alternatives, "muse"), "#!/bin/sh\nprintf '2.0.0\\n'\n", { mode: 0o700 });
    process.env.PATH = `${dir}:${alternatives}`;
    const unavailable = devices.status({ muse: command }).find(item => item.harness === "muse")!;
    assert.equal(unavailable.current!.path, null); assert.equal(unavailable.saved, path);
    assert.equal(unavailable.installations.length, 1);
  } finally { process.env.PATH = prior; process.env.HOME = priorHome; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
