import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";
import { NativeWorker } from "../src/native.ts";
import { Store } from "../src/store.ts";
import type { Run } from "../src/contracts.ts";
const fixture = resolve("tests/fixtures/native.mjs");
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("timed out");
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-test-"));
  const home = join(dir, "state");
  const project = join(dir, "project");
  mkdirSync(project);
  const s = createService(
    home,
    4317,
    (cmd, r, p, cb) => new NativeWorker(cmd, r, p, cb, [fixture]),
    process.execPath,
  );
  const auth = {
    Authorization: `Bearer ${s.bearer}`,
    "Content-Type": "application/json",
  };
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = auth,
  ) =>
    s.app.request("http://127.0.0.1:4317" + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    s,
    dir,
    home,
    project,
    call,
    cleanup: async () => {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("durable runs, explicit project scope, idempotency, busy, canonical paths and root events", async () => {
  const t = setup();
  try {
    const p = await (
      await t.call("/api/projects", "POST", { name: "one", path: t.project })
    ).json();
    const p2dir = join(t.dir, "second");
    mkdirSync(p2dir);
    const p2 = await (
      await t.call("/api/projects", "POST", { name: "two", path: p2dir })
    ).json();
    const alias = join(t.dir, "alias");
    symlinkSync(t.project, alias);
    assert.equal(
      (
        await (
          await t.call("/api/projects", "POST", { name: "alias", path: alias })
        ).json()
      ).id,
      p.id,
    );
    const body = {
      projectId: p.id,
      prompt: "wait",
      idempotencyKey: "one",
      readOnly: true,
    };
    const r = await (await t.call("/api/tasks/start", "POST", body)).json();
    assert.equal(t.s.store.run(r.id)?.nativeHome,
      process.env.CODEX_HOME === undefined ? join(homedir(), ".codex") :
        isAbsolute(process.env.CODEX_HOME) ? process.env.CODEX_HOME : undefined);
    await wait(() => !!t.s.store.run(r.id)?.turnId);
    assert.equal(
      (await (await t.call("/api/tasks/start", "POST", body)).json()).id,
      r.id,
    );
    assert.equal(
      (
        await t.call("/api/tasks/start", "POST", {
          ...body,
          model: "different",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await t.call("/api/tasks/start", "POST", {
          ...body,
          idempotencyKey: "other",
        })
      ).status,
      409,
    );
    assert.equal(t.s.store.run(r.id)?.state, "running");
    const other = await (
      await t.call("/api/tasks/start", "POST", {
        projectId: p2.id,
        prompt: "complete",
        idempotencyKey: "other",
      })
    ).json();
    await wait(() => t.s.store.run(other.id)?.state === "completed");
    assert.equal(t.s.store.run(other.id)?.tokens, 12);
    assert.equal(t.s.store.run(other.id)?.result, "fixture result");
    assert.equal(t.s.store.run(r.id)?.state, "running");
    await t.call(`/api/runs/${r.id}/stop`, "POST");
    await wait(() => !t.s.store.run(r.id)?.workerPid);
    assert.equal(t.s.store.run(r.id)?.state, "cancelled");
    assert.equal(
      (
        await t.call("/api/tasks/start", "POST", {
          projectId: p.id,
          prompt: "",
          idempotencyKey: "bad",
        })
      ).status,
      400,
    );
    assert.equal(
      (await t.call("/api/projects", "POST", { name: "bad", path: "relative" }))
        .status,
      400,
    );
    assert.equal((await t.call(`/api/runs/${r.id}/tail?after=-1`)).status, 400);
    await t.s.close();
    const restored = new Store(t.home);
    assert.equal(restored.run(other.id)?.state, "completed");
    restored.close();
    rmSync(t.dir, { recursive: true, force: true });
  } catch (e) {
    await t.cleanup();
    throw e;
  }
});
test("local ownership is exclusive before recovery and restart marks active work interrupted", async () => {
  const t = setup();
  try {
    const p = await (
      await t.call("/api/projects", "POST", { name: "one", path: t.project })
    ).json();
    const r = await (
      await t.call("/api/tasks/start", "POST", {
        projectId: p.id,
        prompt: "wait",
        idempotencyKey: "one",
      })
    ).json();
    await wait(() => !!t.s.store.run(r.id)?.turnId);
    assert.throws(() => createService(t.home, 4318), /already running/);
    assert.equal(t.s.store.run(r.id)?.state, "running");
    await t.s.close();
    const db = new Store(t.home);
    const active: Run = {
      ...db.run(r.id)!,
      state: "running",
      workerPid: undefined,
    };
    db.saveRun(active);
    db.close();
    const restarted = new Store(t.home);
    assert.equal(restarted.run(r.id)?.state, "interrupted");
    restarted.close();
    rmSync(t.dir, { recursive: true, force: true });
  } catch (e) {
    await t.cleanup();
    throw e;
  }
});
test("MCP cannot approve; local cookie plus exact Origin required; one-time setup", async () => {
  const t = setup();
  try {
    assert.equal(
      (await t.call("/api/snapshot", "GET", undefined, {})).status,
      401,
    );
    assert.equal(
      (
        await t.call("/api/snapshot", "GET", undefined, {
          Origin: "https://evil.example",
          Authorization: `Bearer ${t.s.bearer}`,
        })
      ).status,
      403,
    );
    assert.equal(
      (await t.s.app.request("http://evil.example:4317/api/health")).status,
      403,
    );
    const p = await (
      await t.call("/api/projects", "POST", { name: "one", path: t.project })
    ).json();
    const r = await (
      await t.call("/api/tasks/start", "POST", {
        projectId: p.id,
        prompt: "approval",
        idempotencyKey: "one",
      })
    ).json();
    await wait(() => t.s.store.approvals().length === 1);
    const a = t.s.store.approvals()[0];
    assert.equal(
      (await t.call("/api/approvals/" + a.id, "POST", { decision: "accept" }))
        .status,
      403,
    );
    const setup = await t.s.app.request(t.s.setupUrl);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await t.s.app.request(t.s.setupUrl)).status, 403);
    assert.equal(
      (
        await t.call(
          "/api/approvals/" + a.id,
          "POST",
          { decision: "accept" },
          { Cookie: cookie, "Content-Type": "application/json" },
        )
      ).status,
      403,
    );
    const headers = {
      Cookie: cookie,
      Origin: "http://127.0.0.1:4317",
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await t.call(
          "/api/approvals/" + a.id,
          "POST",
          { decision: "acceptForSession" },
          headers,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call(
          "/api/approvals/" + a.id,
          "POST",
          { decision: "accept" },
          headers,
        )
      ).status,
      200,
    );
    await wait(() => t.s.store.run(r.id)?.state === "completed");
  } finally {
    await t.cleanup();
  }
});
test("unsupported native requests and wider permission scopes need attention; file preview is concrete", async () => {
  const t = setup();
  try {
    const p = await (
      await t.call("/api/projects", "POST", { name: "one", path: t.project })
    ).json();
    for (const prompt of ["network", "unsupported"]) {
      const r = await (
        await t.call("/api/tasks/start", "POST", {
          projectId: p.id,
          prompt,
          idempotencyKey: prompt,
        })
      ).json();
      await wait(() => t.s.store.run(r.id)?.state === "needs_attention");
      assert.equal(t.s.store.approvals().length, 0);
      await t.call(`/api/runs/${r.id}/stop`, "POST");
      await wait(() => !t.s.store.run(r.id)?.workerPid);
    }
    const file = await (
      await t.call("/api/tasks/start", "POST", {
        projectId: p.id,
        prompt: "file",
        idempotencyKey: "file",
      })
    ).json();
    await wait(() => t.s.store.approvals().length === 1);
    assert.match(JSON.stringify(t.s.store.approvals()[0].details), /test.txt/);
    await t.call(`/api/runs/${file.id}/stop`, "POST");
  } finally {
    await t.cleanup();
  }
});
test("selected role context reaches native worker with a historical snapshot and actual model", async () => {
  const t = setup();
  try {
    const p = await (
      await t.call("/api/projects", "POST", { name: "one", path: t.project })
    ).json();
    const roles = [
      {
        id: "reviewer",
        name: "Reviewer",
        harness: "codex",
        model: "pinned-model",
        responsibility: "Inspect every changed function.",
      },
    ];
    assert.equal(
      (
        await t.call("/api/projects/" + p.id, "PATCH", {
          roles,
          preference: "economical",
        })
      ).status,
      200,
    );
    const r = await (
      await t.call("/api/tasks/start", "POST", {
        projectId: p.id,
        prompt: "Review",
        roleId: "reviewer",
        idempotencyKey: "role",
      })
    ).json();
    await wait(() => t.s.store.run(r.id)?.state === "completed");
    const done = t.s.store.run(r.id)!;
    assert.match(done.result, /Inspect every changed function/);
    assert.equal(done.model, "pinned-model");
    assert.equal(done.effectiveModel, "native-fixture-model");
    assert.deepEqual(done.roleSnapshot, roles[0]);
    await t.call("/api/projects/" + p.id, "PATCH", { roles: [] });
    assert.deepEqual(t.s.store.run(r.id)?.roleSnapshot, roles[0]);
  } finally {
    await t.cleanup();
  }
});
test("possibly surviving owned group blocks a new worker after restart without killing it", async () => {
  const { spawn } = await import("node:child_process");
  const t = setup();
  const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    const p = await (
      await t.call("/api/projects", "POST", { name: "one", path: t.project })
    ).json();
    const now = new Date().toISOString();
    const r: Run = {
      id: randomUUID(),
      projectId: p.id,
      prompt: "orphan",
      state: "running",
      result: "",
      readOnly: false,
      tokens: null,
      createdAt: now,
      updatedAt: now,
      workerPid: orphan.pid,
    };
    t.s.store.insertRun(r, "orphan");
    await t.s.close();
    const restarted = createService(t.home, 4317, undefined, process.execPath);
    try {
      assert.equal(restarted.store.run(r.id)?.state, "interrupted");
      const response = await restarted.app.request(
        "http://127.0.0.1:4317/api/tasks/start",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${restarted.bearer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectId: p.id,
            prompt: "new",
            idempotencyKey: "new",
          }),
        },
      );
      assert.equal(response.status, 409);
      assert.equal(orphan.exitCode, null);
    } finally {
      await restarted.close();
    }
  } finally {
    if (orphan.pid) process.kill(-orphan.pid, "SIGTERM");
    await new Promise<void>((resolve) => orphan.once("exit", () => resolve()));
    rmSync(t.dir, { recursive: true, force: true });
  }
});
test("compact previews and event budgets mark every clipped response", async () => {
  const t = setup();
  try {
    const p = await (
      await t.call("/api/projects", "POST", { name: "one", path: t.project })
    ).json();
    const body = {
      projectId: p.id,
      prompt: "p".repeat(4000),
      idempotencyKey: "bounds",
    };
    const r = await (await t.call("/api/tasks/start", "POST", body)).json();
    assert.equal(r.prompt.length, 300);
    assert.equal(r.promptTruncated, true);
    await wait(() => t.s.store.run(r.id)?.state === "completed");
    t.s.store.saveRun({ ...t.s.store.run(r.id)!, result: "r".repeat(4000) });
    for (let i = 0; i < 4; i++)
      t.s.store.event(r.id, "output", "x".repeat(20000));
    const status = await (await t.call("/api/runs/" + r.id)).json();
    assert.equal(status.result.length, 1000);
    assert.equal(status.resultTruncated, true);
    const full = await (await t.call("/api/runs/" + r.id + "/result")).json();
    assert.equal(full.result.length, 4000);
    assert.equal(full.resultTruncated, false);
    const tail = await (await t.call("/api/runs/" + r.id + "/tail")).json();
    assert.equal(tail.truncated, true);
    assert.ok(
      tail.events.reduce(
        (n: number, e: { text: string }) => n + e.text.length,
        0,
      ) <= 24000,
    );
    assert.ok(
      tail.events.some((e: { textTruncated?: boolean }) => e.textTruncated),
    );
    assert.equal(tail.hasMore, true);
  } finally {
    await t.cleanup();
  }
});
test("browser sessions for two local ports coexist without cookie collision", async () => {
  const first = setup();
  const otherHome = join(first.dir, "second-home");
  const second = createService(otherHome, 4318, undefined, process.execPath);
  try {
    const a = await first.s.app.request(first.s.setupUrl);
    const b = await second.app.request(second.setupUrl);
    const ac = a.headers.get("set-cookie")!.split(";")[0];
    const bc = b.headers.get("set-cookie")!.split(";")[0];
    assert.match(ac, /^agentklar_session_4317=/);
    assert.match(bc, /^agentklar_session_4318=/);
    const cookie = ac + "; " + bc;
    assert.equal(
      (await first.call("/api/snapshot", "GET", undefined, { Cookie: cookie }))
        .status,
      200,
    );
    assert.equal(
      (
        await second.app.request("http://127.0.0.1:4318/api/snapshot", {
          headers: { Cookie: cookie },
        })
      ).status,
      200,
    );
    assert.equal(
      (await first.call("/api/snapshot", "GET", undefined, { Cookie: bc }))
        .status,
      401,
    );
  } finally {
    await second.close();
    await first.cleanup();
  }
});
