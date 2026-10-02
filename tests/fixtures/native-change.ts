import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function nativeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-native-change-"))), home = join(root, "service"), native = join(root, "native"), codex = join(root, "codex"), folder = join(root, "project");
  for (const dir of [home, native, codex, folder]) mkdirSync(dir);
  const mode = join(root, "mode"), calls = join(root, "calls"), command = join(root, "native-cli");
  writeFileSync(mode, ""); writeFileSync(calls, "");
  writeFileSync(command, `#!${process.execPath}\nimport ${JSON.stringify(resolve("tests/fixtures/native-config-plugin.mjs"))};\n`, { mode: 0o700 });
  const db = new DatabaseSync(":memory:"), project = { id: "project-1", name: "Project", path: folder, preference: "balanced" as const, roles: [], createdAt: "" };
  const options = { env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: native, CODEX_HOME: codex, NATIVE_CHANGE_MODE: mode, NATIVE_CHANGE_CALLS: calls }, timeoutMs: 2000 };
  return { root, home, native, codex, folder, mode, calls, command, db, project, options, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
