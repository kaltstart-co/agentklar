import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { nativeInventory } from "../src/inventory.ts";

test("invalid manifests cannot evade the total read budget or leak nested secrets", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-inventory-review-")));
  const home = join(root, "home"), project = join(root, "project"), codex = join(root, "custom-codex");
  for (const path of [home, project, codex]) mkdirSync(path);
  const secret = "NEVER_EXPORT_PRIVATE_NATIVE_VALUE";
  const files: { path: string; text: string; modified: number }[] = [];
  try {
    for (let i = 0; i < 30; i++) {
      const path = join(codex, `plugins/cache/fixture/package-${i}/1/plugin.json`);
      mkdirSync(dirname(path), { recursive: true });
      const text = JSON.stringify({ name: "invalid name", version: "1", nested: { credentials: { token: secret } }, padding: "x".repeat(30000) });
      writeFileSync(path, text);
      files.push({ path, text, modified: statSync(path).mtimeMs });
    }
    let readBytes = 0, attempts = 0;
    const output = nativeInventory(randomUUID(), project, {
      userHome: home,
      env: { CODEX_HOME: codex },
      beforeRead(path) { attempts++; readBytes += statSync(path).size; },
    });
    assert.ok(attempts > 0 && attempts < files.length);
    assert.ok(readBytes <= 256 * 1024);
    assert.equal(output.truncated, true);
    const group = output.harnesses.find(item => item.harness === "codex")!;
    assert.equal(group.extensions.length, 0);
    assert.equal(group.extensionsTruncated, true);
    assert.ok(group.sources.some(item => item.status === "invalid"));
    assert.ok(group.sources.some(item => item.status === "oversized"));
    assert.doesNotMatch(JSON.stringify(output), new RegExp(secret));
    assert.ok(JSON.stringify(output).length <= 22000);
    for (const file of files) {
      assert.equal(readFileSync(file.path, "utf8"), file.text);
      assert.equal(statSync(file.path).mtimeMs, file.modified);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
