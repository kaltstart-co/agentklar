import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRootIdentity, rootStamp } from "../src/project-root.ts";

test("root identity distinguishes reused inode and stays stable during ordinary edits", () => {
  const first = rootStamp({ dev: 1n, ino: 2n, birthtimeNs: 100n });
  const replacement = rootStamp({ dev: 1n, ino: 2n, birthtimeNs: 101n });
  assert.notEqual(first, replacement);
  assert.notEqual(first, "1:2"); // Older saved identity must not authorize an undo.
  assert.throws(() => rootStamp({ dev: 1n, ino: 2n, birthtimeNs: 0n }));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-root-")));
  const project = join(dir, "project");
  mkdirSync(project);
  try {
    const before = projectRootIdentity(project);
    writeFileSync(join(project, "file.txt"), "ordinary project edit");
    assert.equal(projectRootIdentity(project), before);
    rmSync(project, { recursive: true });
    mkdirSync(project);
    assert.notEqual(projectRootIdentity(project), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
