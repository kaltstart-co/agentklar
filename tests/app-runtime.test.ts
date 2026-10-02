import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptAppStartup, useAppRuntime } from "../src/launchd.ts";

function fixture(failure: "busy" | "health" | "resume" | null) {
  const calls: string[] = [];
  let paused = false;
  const lifecycle = {
    paused: () => paused,
    async stop() { calls.push("stop"); if (failure === "busy") throw new Error("Active work"); paused = true; },
    replaceStartup(xml: string) { assert.equal(paused, true); calls.push(xml); },
    async start(version: string, commit?: () => void) {
      calls.push(version);
      if (version === "new" && failure === "health") throw new Error("Wrong health version");
      commit?.(); paused = false;
      if (version === "new" && failure === "resume") throw new Error("Acknowledgment lost");
    },
  };
  const run = () => adoptAppStartup(lifecycle, "old plist", "new plist", "old", "new", phase => calls.push(phase));
  return { calls, run };
}

test("app runtime adoption refuses active work before changing startup", async () => {
  const f = fixture("busy");
  await assert.rejects(f.run(), /Active work/);
  assert.deepEqual(f.calls, ["stop", "restored"]);
});
test("new runtime health failure restores the prior startup and service", async () => {
  const f = fixture("health");
  await assert.rejects(f.run(), /Wrong health version/);
  assert.deepEqual(f.calls, ["stop", "new plist", "replaced", "new", "stop", "old plist", "old", "restored"]);
});
test("accepted runtime is committed before resume and cannot roll back after acknowledgment loss", async () => {
  const f = fixture("resume");
  await assert.rejects(f.run(), /No rollback/);
  assert.deepEqual(f.calls, ["stop", "new plist", "replaced", "new", "committed"]);
});
test("source CLI cannot choose a target or adopt an app runtime", { skip: process.platform !== "darwin" }, async () => {
  await assert.rejects(useAppRuntime(), /verified bundled/);
});
