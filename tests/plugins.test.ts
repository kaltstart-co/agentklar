import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { NativePlugins } from "../src/plugins.ts";
import { nativeFixture } from "./fixtures/native-change.ts";

test("native plugin protocol lifecycle uses exact package/content/local scope and survives manager restart", async () => {
  const f = nativeFixture();
  const local = join(f.folder, ".claude/settings.local.json");
  mkdirSync(join(f.folder, ".claude")); writeFileSync(local, '{"model":"haiku","other":"PRIVATE_KEEP"}');
  try {
    let plugins = new NativePlugins(f.db, f.home, f.command, f.options);
    const before = readFileSync(local, "utf8"), preview = await plugins.preview(f.project);
    assert.equal(readFileSync(local, "utf8"), before);
    assert.equal(existsSync(join(f.native, "plugins/installed_plugins.json")), false);
    assert.equal(preview.files.length, 3); assert.equal(preview.capabilities.hooks, 0); assert.equal(preview.capabilities.mcpServers, 0);
    assert.match(preview.commands[1].join(" "), /install .* --scope local --json/);
    assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_KEEP/);
    const changed = await plugins.apply(f.project, preview.id);
    assert.equal(changed.state, "applied"); assert.equal(changed.installed, true); assert.equal(changed.recognized, true);
    assert.equal(JSON.parse(readFileSync(local, "utf8")).other, "PRIVATE_KEEP");
    plugins = new NativePlugins(f.db, f.home, f.command, f.options);
    assert.equal((await plugins.status(f.project)).changes[0].canUndo, true);
    const undone = await plugins.undo(f.project, changed.id); assert.equal(undone.state, "undone");
    const remaining = JSON.parse(readFileSync(local, "utf8")); assert.equal(remaining.model, "haiku"); assert.equal(remaining.other, "PRIVATE_KEEP");
    assert.deepEqual(JSON.parse(readFileSync(join(f.native, "plugins/installed_plugins.json"), "utf8")), {});
    assert.doesNotMatch(JSON.stringify(f.db.prepare("SELECT data FROM native_plugin_changes").all()), /PRIVATE_KEEP/);
    assert.doesNotMatch(readFileSync(f.calls, "utf8"), /thread\/|turn\/|eval/);
  } finally { f.close(); }
});

test("staged bundle and native settings edits invalidate plugin apply and undo", async () => {
  const f = nativeFixture(), plugins = new NativePlugins(f.db, f.home, f.command, f.options);
  try {
    const first = await plugins.preview(f.project), stage = first.commands[0][3];
    const manifest = join(stage, "plugins/agentklar-workflow/.claude-plugin/plugin.json");
    writeFileSync(manifest, '{"name":"changed","hooks":{}}');
    await assert.rejects(plugins.apply(f.project, first.id), /changed/);
    assert.equal(existsSync(join(f.native, "plugins/installed_plugins.json")), false);
    const second = await plugins.preview(f.project);
    const local = join(f.folder, ".claude/settings.local.json"); mkdirSync(join(f.folder, ".claude")); writeFileSync(local, '{"external":true}');
    await assert.rejects(plugins.apply(f.project, second.id), /changed/);
    const third = await plugins.preview(f.project), applied = await plugins.apply(f.project, third.id);
    const config = JSON.parse(readFileSync(local, "utf8")); config.external = false; writeFileSync(local, JSON.stringify(config));
    await assert.rejects(plugins.undo(f.project, applied.id), /changed/);
    assert.equal((await plugins.status(f.project)).changes[0].canUndo, false);
  } finally { f.close(); }
});

for (const failure of ["install-before", "install-after", "details-bad"] as const) test(`interrupted ${failure} keeps a guarded native cleanup receipt`, async () => {
  const f = nativeFixture(), plugins = new NativePlugins(f.db, f.home, f.command, f.options);
  try {
    const preview = await plugins.preview(f.project); writeFileSync(f.mode, failure);
    await assert.rejects(plugins.apply(f.project, preview.id));
    const status = await plugins.status(f.project); assert.equal(status.changes[0].state, "interrupted"); assert.equal(status.changes[0].canUndo, true);
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_NATIVE_ERROR/);
    writeFileSync(f.mode, ""); await plugins.undo(f.project, status.changes[0].id);
    assert.deepEqual(JSON.parse(readFileSync(join(f.native, "plugins/known_marketplaces.json"), "utf8")), {});
  } finally { f.close(); }
});

test("interrupted marketplace removal can retry the same owned cleanup without another uninstall", async () => {
  const f = nativeFixture(), plugins = new NativePlugins(f.db, f.home, f.command, f.options);
  try {
    const preview = await plugins.preview(f.project), changed = await plugins.apply(f.project, preview.id);
    writeFileSync(f.mode, "remove-before"); await assert.rejects(plugins.undo(f.project, changed.id));
    const status = await plugins.status(f.project); assert.equal(status.changes[0].state, "interrupted"); assert.equal(status.changes[0].canUndo, true);
    writeFileSync(f.mode, ""); await plugins.undo(f.project, changed.id);
    assert.equal(readFileSync(f.calls, "utf8").split("\n").filter(line => line.includes('"uninstall"')).length, 1);
  } finally { f.close(); }
});

for (const mode of ["replace-add-registry", "replace-install-registry", "replace-install-local", "replace-details-user", "replace-uninstall-registry"] as const) test(`${mode} never adopts or removes an external marketplace replacement`, async () => {
  const f = nativeFixture(), plugins = new NativePlugins(f.db, f.home, f.command, f.options);
  try {
    const preview = await plugins.preview(f.project);
    let receipt;
    if (mode.startsWith("replace-uninstall")) receipt = await plugins.apply(f.project, preview.id);
    writeFileSync(f.mode, mode);
    if (receipt) await assert.rejects(plugins.undo(f.project, receipt.id), /source|ownership/);
    else await assert.rejects(plugins.apply(f.project, preview.id), /source|ownership|scope/);
    const status = await plugins.status(f.project), change = status.changes[0];
    assert.equal(change.state, "interrupted"); assert.equal(change.canUndo, false);
    const target = mode.endsWith("registry") ? join(f.native, "plugins/known_marketplaces.json") : mode.endsWith("user") ? join(f.native, "settings.json") : join(f.folder, ".claude/settings.local.json");
    const before = readFileSync(target, "utf8"); assert.match(before, /externally-managed-marketplace/);
    writeFileSync(f.mode, ""); await assert.rejects(plugins.undo(f.project, change.id));
    assert.equal(readFileSync(target, "utf8"), before);
    const calls = readFileSync(f.calls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(calls.some(args => args[1] === "marketplace" && args[2] === "remove"), false);
    if (mode === "replace-add-registry") assert.equal(calls.some(args => args[1] === "install" && !args.includes("--help")), false);
  } finally { f.close(); }
});

test("uninstall which removes its plugin then fails keeps remaining cleanup retryable across restart", async () => {
  const f = nativeFixture();
  try {
    let plugins = new NativePlugins(f.db, f.home, f.command, f.options);
    const preview = await plugins.preview(f.project), applied = await plugins.apply(f.project, preview.id);
    writeFileSync(f.mode, "uninstall-after"); await assert.rejects(plugins.undo(f.project, applied.id));
    plugins = new NativePlugins(f.db, f.home, f.command, f.options);
    const status = await plugins.status(f.project);
    assert.equal(status.changes[0].state, "interrupted"); assert.equal(status.changes[0].installed, false); assert.equal(status.changes[0].canUndo, true);
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_NATIVE_ERROR/);
    writeFileSync(f.mode, ""); assert.equal((await plugins.undo(f.project, applied.id)).state, "undone");
    assert.deepEqual(JSON.parse(readFileSync(join(f.native, "plugins/known_marketplaces.json"), "utf8")), {});
    assert.equal(readFileSync(f.calls, "utf8").split("\n").filter(line => line.includes('"uninstall"')).length, 1);
  } finally { f.close(); }
});
