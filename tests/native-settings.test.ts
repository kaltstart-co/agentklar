import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NativeSettings, nativeSettingInput } from "../src/native-settings.ts";
import { nativeFixture } from "./fixtures/native-change.ts";

for (const harness of ["claude", "codex"] as const) test(`${harness} managed default preview/apply/undo preserves private and unrelated settings across restart`, async () => {
  const f = nativeFixture();
  const path = harness === "claude" ? join(f.folder, ".claude/settings.local.json") : join(f.codex, "config.toml");
  if (harness === "claude") mkdirSync(join(f.folder, ".claude"));
  const original = { model: "native-old", hooks: { untouched: "PRIVATE_SETTING" }, apiKey: "PRIVATE_CREDENTIAL" };
  writeFileSync(path, JSON.stringify(original));
  try {
    let manager = new NativeSettings(f.db, { codex: f.command, claude: f.command }, f.options);
    const preview = await manager.preview(f.project, { harness, field: "model", value: "native-new" });
    assert.equal(preview.before, "native-old"); assert.equal(preview.after, "native-new");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
    assert.doesNotMatch(JSON.stringify(preview), /PRIVATE/);
    const changed = await manager.apply(f.project, preview.id); assert.equal(changed.state, "applied");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...original, model: "native-new" });
    manager = new NativeSettings(f.db, { codex: f.command, claude: f.command }, f.options);
    assert.equal((await manager.read(f.project, harness)).changes[0].canUndo, true);
    assert.equal((await manager.undo(f.project, changed.id)).state, "undone");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
    assert.doesNotMatch(JSON.stringify(f.db.prepare("SELECT data FROM native_setting_changes").all()), /PRIVATE/);
    assert.doesNotMatch(readFileSync(f.calls, "utf8"), /thread\/|turn\/|exec/);
  } finally { f.close(); }
});

test("Claude clears an absent managed default and rejects stale preview/undo and linked settings", async () => {
  const f = nativeFixture(), manager = new NativeSettings(f.db, { codex: f.command, claude: f.command }, f.options);
  const path = join(f.folder, ".claude/settings.local.json");
  try {
    const preview = await manager.preview(f.project, { harness: "claude", field: "effort", value: "high" });
    const changed = await manager.apply(f.project, preview.id);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).effortLevel, "high");
    await manager.undo(f.project, changed.id); assert.equal(existsSync(path), false);
    const stale = await manager.preview(f.project, { harness: "claude", field: "model", value: "haiku" });
    writeFileSync(path, '{"model":"external"}');
    await assert.rejects(manager.apply(f.project, stale.id), /changed/);
    const valid = await manager.preview(f.project, { harness: "claude", field: "model", value: "haiku" });
    const applied = await manager.apply(f.project, valid.id);
    writeFileSync(path, '{"model":"haiku","other":"new"}');
    await assert.rejects(manager.undo(f.project, applied.id), /changed/);
    rmSync(path); symlinkSync(join(f.root, "mode"), path);
    await assert.rejects(manager.read(f.project, "claude"), /safely/);
    assert.equal(nativeSettingInput.safeParse({ harness: "claude", field: "effort", value: "max" }).success, false);
    assert.equal(nativeSettingInput.safeParse({ harness: "claude", field: "auth", value: "token" }).success, false);
  } finally { f.close(); }
});

test("Codex refuses selected profiles and keeps an interrupted native write recoverable without private errors", async () => {
  const f = nativeFixture(), manager = new NativeSettings(f.db, { codex: f.command, claude: f.command }, f.options);
  try {
    writeFileSync(f.mode, "profile");
    await assert.rejects(manager.read(f.project, "codex"), /profile/);
    writeFileSync(f.mode, "");
    const preview = await manager.preview(f.project, { harness: "codex", field: "effort", value: "high" });
    writeFileSync(f.mode, "write-after");
    await assert.rejects(manager.apply(f.project, preview.id), /refused/);
    const state = await manager.read(f.project, "codex");
    assert.equal(state.changes[0].state, "interrupted"); assert.equal(state.changes[0].canUndo, true);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE/);
    writeFileSync(f.mode, "");
    await manager.undo(f.project, state.changes[0].id);
    assert.equal((await manager.read(f.project, "codex")).effort, null);
  } finally { f.close(); }
});
