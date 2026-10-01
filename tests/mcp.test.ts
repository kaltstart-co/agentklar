import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serve } from "@hono/node-server";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createService } from "../src/service.ts";
import { NativeWorker } from "../src/native.ts";
test("SDK stdio wire lists and calls tools; closing MCP leaves service worker alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-mcp-"));
  const project = join(dir, "project");
  mkdirSync(project);
  const home = join(dir, "home");
  const port = 24000 + Math.floor(Math.random() * 10000);
  let catalogReads = 0;
  const service = createService(
    home,
    port,
    (cmd, r, p, cb) =>
      new NativeWorker(cmd, r, p, cb, [resolve("tests/fixtures/native.mjs")]),
    process.execPath,
    null,
    async (project) => {
      catalogReads++;
      return { projectId: project.id, checkedAt: "fixture", harnesses: [] };
    },
  );
  const http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port });
  const transport = new StdioClientTransport({
    command: "npm",
    args: ["--prefix", resolve("."), "run", "--silent", "mcp"],
    env: {
      ...(process.env as Record<string, string>),
      AGENTKLAR_HOME: home,
      AGENTKLAR_PORT: String(port),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 14);
    assert.equal(
      list.tools.some((t) => /approve/.test(t.name)),
      false,
    );
    const pResult = await client.callTool({
      name: "project_register",
      arguments: { name: "wire", path: project },
    });
    const p = JSON.parse((pResult.content as { text: string }[])[0].text);
    const cached = await client.callTool({
      name: "models_list",
      arguments: { projectId: p.id, refresh: false },
    });
    assert.equal(
      JSON.parse((cached.content as { text: string }[])[0].text),
      null,
    );
    assert.equal(catalogReads, 0);
    const models = await client.callTool({
      name: "models_list",
      arguments: { projectId: p.id },
    });
    assert.equal(
      JSON.parse((models.content as { text: string }[])[0].text).projectId,
      p.id,
    );
    assert.equal(catalogReads, 1);
    const recommendation = await client.callTool({
      name: "recommend_worker",
      arguments: { projectId: p.id, model: "custom-native-model" },
    });
    const advice = JSON.parse(
      (recommendation.content as { text: string }[])[0].text,
    );
    assert.equal(advice.choice, null);
    assert.match(
      advice.reasons.join(" "),
      /Pinned codex model custom-native-model/,
    );
    assert.equal(service.store.runs().length, 0);
    assert.equal(catalogReads, 1);
    const invalidAdvice = await client.callTool({
      name: "recommend_worker",
      arguments: { projectId: p.id, complexity: "unreviewed" },
    });
    assert.equal(invalidAdvice.isError, true);
    const unknown = await client.callTool({
      name: "models_list",
      arguments: { projectId: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(unknown.isError, true);
    const started = await client.callTool({
      name: "task_start",
      arguments: {
        projectId: p.id,
        prompt: "wait",
        idempotencyKey: "wire",
        readOnly: true,
      },
    });
    const r = JSON.parse((started.content as { text: string }[])[0].text);
    assert.equal(r.state, "running");
    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(service.store.run(r.id)?.state, "running");
    assert.equal(service.store.run(r.id)?.threadId, "owned-thread");
  } finally {
    await client.close().catch(() => {});
    await service.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("MCP response character budget carries explicit truncation", async () => {
  const { bounded } = await import("../src/mcp.ts");
  const text = bounded({ result: "x".repeat(100000) });
  assert.ok(text.length <= 24000);
  const result = JSON.parse(text);
  assert.equal(result.truncated, true);
  assert.match(result.message, /shortened/);
});

test("independent MCP stdio clients share saved context with stale writer protection and compact run reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-shared-mcp-"));
  const home = join(dir, "home");
  const secondPath = join(dir, "second");
  mkdirSync(secondPath);
  const port = 24000 + Math.floor(Math.random() * 10000);
  const service = createService(
    home,
    port,
    (cmd, run, path, callbacks) =>
      new NativeWorker(cmd, run, path, callbacks, [
        resolve("tests/fixtures/native.mjs"),
      ]),
    process.execPath,
  );
  const http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port });
  const clients = [
    new Client({ name: "codex-host", version: "1" }),
    new Client({ name: "claude-host", version: "1" }),
  ];
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const reply = await client.callTool({ name, arguments: args });
    return {
      error: !!reply.isError,
      data: JSON.parse((reply.content as { text: string }[])[0].text),
    };
  };
  try {
    for (const client of clients)
      await client.connect(
        new StdioClientTransport({
          command: "npm",
          args: ["--prefix", resolve("."), "run", "--silent", "mcp"],
          env: {
            ...(process.env as Record<string, string>),
            AGENTKLAR_HOME: home,
            AGENTKLAR_PORT: String(port),
          },
          stderr: "pipe",
        }),
      );
    const p = (
      await call(clients[0], "project_register", { name: "shared", path: dir })
    ).data;
    const other = (
      await call(clients[1], "project_register", {
        name: "other",
        path: secondPath,
      })
    ).data;
    const readArgs = { projectId: p.id };
    assert.equal(
      (await call(clients[0], "project_context_read", readArgs)).data.revision,
      0,
    );
    assert.equal(
      (await call(clients[1], "project_context_read", readArgs)).data.revision,
      0,
    );
    const update = {
      ...readArgs,
      brief: "MCP_SAVED_BRIEF",
      memory: "one",
      handoff: "two",
      expectedRevision: 0,
    };
    const saved = await call(clients[0], "project_context_update", update);
    assert.equal(saved.error, false);
    assert.equal(saved.data.updatedVia, "mcp");
    assert.deepEqual(
      (await call(clients[1], "project_context_read", readArgs)).data,
      saved.data,
    );
    const stale = await call(clients[1], "project_context_update", {
      ...update,
      memory: "stale writer",
    });
    assert.equal(stale.error, true);
    assert.match(stale.data.error, /changed.*Read the latest/);
    assert.equal(
      (await call(clients[1], "project_context_read", { projectId: other.id }))
        .data.revision,
      0,
    );
    const unknown = { projectId: "00000000-0000-4000-8000-000000000000" };
    assert.equal(
      (await call(clients[1], "project_context_read", unknown)).error,
      true,
    );
    assert.equal(
      (
        await call(clients[1], "project_context_update", {
          ...update,
          ...unknown,
        })
      ).error,
      true,
    );
    const invalid = await clients[1].callTool({
      name: "project_context_update",
      arguments: { ...update, memory: "m".repeat(4001) },
    });
    assert.equal(invalid.isError, true);
    const startArgs = {
      ...readArgs,
      prompt: "wait",
      idempotencyKey: "saved",
      readOnly: true,
    };
    const started = (await call(clients[0], "task_start", startArgs)).data;
    assert.equal(started.contextRevision, 1);
    assert.equal(started.contextSnapshot, undefined);
    await call(clients[1], "project_context_update", {
      ...update,
      brief: "new brief",
      expectedRevision: 1,
    });
    const inspect = (
      await call(clients[1], "run_context_read", { runId: started.id })
    ).data;
    assert.deepEqual(inspect.contextSnapshot, saved.data);
    assert.equal(
      (await call(clients[1], "task_start", startArgs)).data.id,
      started.id,
    );
    for (const name of ["run_status", "run_result", "run_stop"]) {
      const reply = await call(clients[1], name, { runId: started.id });
      assert.equal(reply.data.contextRevision, 1);
      assert.equal(reply.data.contextSnapshot, undefined);
      assert.doesNotMatch(JSON.stringify(reply.data), /MCP_SAVED_BRIEF/);
    }
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await service.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
