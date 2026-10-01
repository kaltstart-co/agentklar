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
  const service = createService(
    home,
    port,
    (cmd, r, p, cb) =>
      new NativeWorker(cmd, r, p, cb, [resolve("tests/fixtures/native.mjs")]),
    process.execPath,
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
    assert.equal(list.tools.length, 9);
    assert.equal(
      list.tools.some((t) => /approve/.test(t.name)),
      false,
    );
    const pResult = await client.callTool({
      name: "project_register",
      arguments: { name: "wire", path: project },
    });
    const p = JSON.parse((pResult.content as { text: string }[])[0].text);
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
