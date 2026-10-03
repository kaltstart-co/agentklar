import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Activities, workReportSchema } from "../src/activity.ts";
import { Store } from "../src/store.ts";
import { createService } from "../src/service.ts";
import { clientSourceHeader } from "../src/launch-source.ts";
import type { Project } from "../src/contracts.ts";
const project = (store: Store, path: string) => {
  const p: Project = {
    id: randomUUID(),
    path,
    name: "Fixture",
    preference: "balanced",
    roles: [],
    createdAt: "now",
  };
  store.saveProject(p);
  return p;
};
const input = (projectId: string) =>
  workReportSchema.parse({
    projectId,
    activityId: randomUUID(),
    reportId: randomUUID(),
    expectedRevision: 0,
    title: "Build feature",
    state: "working",
    summary: "Started",
  });
const source = {
  kind: "mcp" as const,
  clientName: "Codex",
  clientVersion: "1",
};
test("activity durable revisions, replay receipts and project/source ownership do not create workers", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "activity-"))),
    db = join(dir, "state.sqlite");
  let store = new Store(db);
  try {
    const p = project(store, dir),
      other = project(store, join(dir, "other")),
      reports = new Activities(store),
      first = input(p.id);
    assert.throws(() => reports.report(first, undefined), /identify/);
    assert.throws(() => reports.report(first, { kind: "ui" }), /identify/);
    assert.throws(
      () => reports.report({ ...first, projectId: randomUUID() }, source),
      /Project not found/,
    );
    const created = reports.report(first, source);
    assert.equal(created.revision, 1);
    assert.equal(created.result, "");
    assert.deepEqual(reports.report(first, source), created);
    assert.throws(
      () => reports.report({ ...first, summary: "changed" }, source),
      /different inputs/,
    );
    assert.throws(
      () => reports.report({ ...first, reportId: randomUUID() }, source),
      /changed/,
    );
    assert.throws(
      () =>
        reports.report(
          {
            ...first,
            projectId: other.id,
            reportId: randomUUID(),
            expectedRevision: 1,
          },
          source,
        ),
      /another project/,
    );
    assert.throws(
      () =>
        reports.report(
          { ...first, reportId: randomUUID(), expectedRevision: 1 },
          { kind: "mcp", clientName: "Claude" },
        ),
      /another project or harness/,
    );
    const finished = reports.report(
      {
        ...first,
        reportId: randomUUID(),
        expectedRevision: 1,
        state: "finished",
        summary: "Done",
        result: "Changes complete",
      },
      source,
    );
    assert.equal(finished.revision, 2);
    assert.deepEqual(finished.source, source);
    assert.equal(finished.createdAt, created.createdAt);
    assert.deepEqual(reports.list(other.id), []);
    assert.equal(store.runs().length, 0);
    assert.equal(store.approvals().length, 0);
    store.db.close();
    store = new Store(db);
    const restarted = new Activities(store);
    assert.deepEqual(restarted.list(p.id), [finished]);
    assert.deepEqual(restarted.report(first, source), created);
    assert.equal(restarted.list(p.id)[0].revision, 2);
    assert.equal(store.runs().length, 0);
    assert.equal(store.approvals().length, 0);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work report API requires authenticated harness source and keeps project results separate", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "activity-api-"))),
    home = join(dir, "home"),
    port = 34000 + Math.floor(Math.random() * 1000);
  let service = createService(
    home,
    port,
    () => {
      throw new Error("must not launch");
    },
    null,
    null,
  );
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {
      Authorization: `Bearer ${service.bearer}`,
    },
  ) => {
    const response = await service.app.request(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const p = project(service.store, dir),
      other = project(service.store, join(dir, "other")),
      first = input(p.id),
      h = {
        Authorization: `Bearer ${service.bearer}`,
        ...clientSourceHeader(source),
      };
    assert.equal(
      (await call("/api/work/report", "POST", first, {})).status,
      401,
    );
    assert.equal((await call("/api/work/report", "POST", first)).status, 400);
    const setup = await service.app.request(service.setupUrl),
      cookie = setup.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await call("/api/work/report", "POST", first, {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${port}`,
          ...clientSourceHeader(source),
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/api/work/report", "POST", { ...first, unknown: true }, h))
        .status,
      400,
    );
    const made = await call("/api/work/report", "POST", first, h);
    assert.equal(made.status, 200);
    assert.equal((made.body as { revision: number }).revision, 1);
    assert.equal(
      (
        await call(
          "/api/work/report",
          "POST",
          { ...first, summary: "conflict" },
          h,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          "/api/work/report",
          "POST",
          {
            ...first,
            reportId: randomUUID(),
            projectId: other.id,
            expectedRevision: 1,
          },
          h,
        )
      ).status,
      403,
    );
    const finished = {
      ...first,
      reportId: randomUUID(),
      expectedRevision: 1,
      state: "finished",
      result: "Reported completion",
    };
    assert.equal(
      (await call("/api/work/report", "POST", finished, h)).status,
      200,
    );
    assert.equal(service.store.runs().length, 0);
    assert.equal(service.store.approvals().length, 0);
    const own = await call(`/api/projects/${p.id}/work`),
      outside = await call(`/api/projects/${other.id}/work`);
    assert.equal(own.status, 200);
    assert.equal(outside.status, 200);
    assert.equal(
      JSON.stringify(outside.body).includes(first.activityId),
      false,
    );
    assert.equal(
      JSON.stringify(own.body).includes("Reported completion"),
      true,
    );
    await service.close();
    service = createService(
      home,
      port,
      () => {
        throw new Error("must not launch");
      },
      null,
      null,
    );
    const persisted = await call(`/api/projects/${p.id}/work`);
    assert.equal(
      JSON.stringify(persisted.body).includes("Reported completion"),
      true,
    );
    assert.equal(
      (
        await call("/api/work/report", "POST", finished, {
          Authorization: `Bearer ${service.bearer}`,
          ...clientSourceHeader(source),
        })
      ).status,
      200,
    );
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
