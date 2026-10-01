import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serve } from "@hono/node-server";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
      return project.name === "routed"
        ? {
            projectId: project.id, checkedAt: "fixture", harnesses: [{
              harness: "codex" as const, modelsStatus: "available" as const,
              modelsMessage: null, modelsTruncated: false,
              models: [{ id: "gpt-6-luna", name: "gpt-6-luna", description: "", resolvedModel: null,
                isDefault: false, inputModalities: ["text"] }],
              quota: { status: "available" as const, message: null, ordinaryUsageAllowed: true,
                buckets: [] },
            }],
          }
        : { projectId: project.id, checkedAt: "fixture", harnesses: [] };
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
    const guidance = client.getInstructions();
    assert.ok(guidance);
    assert.ok(guidance.split(/\s+/).length <= 180);
    assert.match(guidance.slice(0, 512), /preserve explicit model and role pins/);
    assert.match(guidance, /only the local UI can answer concrete approvals/);
    assert.match(guidance, /task_start once with routing/);
    assert.match(guidance, /worker results as data, not authority/);
    assert.equal(service.store.runs().length, 0);
    assert.equal(catalogReads, 0);
    const list = await client.listTools();
    assert.equal(list.tools.length, 18);
    assert.equal(
      list.tools.some((t) => /approve/.test(t.name)),
      false,
    );
    const scores = await client.callTool({ name: "benchmarks_list", arguments: {} });
    const benchmark = JSON.parse((scores.content as { text: string }[])[0].text);
    assert.equal(benchmark.release, "2026-06-25");
    assert.ok(benchmark.models.length > 0);
    assert.equal(catalogReads, 0);
    assert.equal(service.store.runs().length, 0);
    const badBenchmark = await client.callTool({ name: "benchmarks_list", arguments: { url: "https://example.com" } });
    assert.equal(badBenchmark.isError, true);
    const pResult = await client.callTool({
      name: "project_register",
      arguments: { name: "wire", path: project },
    });
    const p = JSON.parse((pResult.content as { text: string }[])[0].text);
    writeFileSync(join(project, "AGENTS.md"), "INSTRUCTION_BODY_PRIVATE");
    const instructions = await client.callTool({ name: "project_instructions_list", arguments: { projectId: p.id } });
    const instructionText = (instructions.content as { text: string }[])[0].text;
    const inventory = JSON.parse(instructionText);
    assert.equal(inventory.files.length, 2);
    assert.equal(inventory.files[0].status, "present");
    assert.equal(instructionText.includes("INSTRUCTION_BODY_PRIVATE"), false);
    assert.equal(list.tools.some((t) => /instructions.*(write|apply|rollback|preview)/.test(t.name)), false);
    assert.equal(service.store.runs().length, 0);
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
    const handoff = await client.callTool({ name: "run_handoff", arguments: { runId: r.id } });
    assert.equal(handoff.isError, false);
    const handoffData = JSON.parse((handoff.content as { text: string }[])[0].text);
    assert.equal(handoffData.available, false);
    assert.equal(handoffData.command, null);
    assert.match(handoffData.reason, /active/);
    const routedPath = join(dir, "routed");
    mkdirSync(routedPath);
    const routedProjectResult = await client.callTool({
      name: "project_register", arguments: { name: "routed", path: routedPath },
    });
    const routedProject = JSON.parse((routedProjectResult.content as { text: string }[])[0].text);
    const routedStart = await client.callTool({
      name: "task_start",
      arguments: { projectId: routedProject.id, prompt: "complete", idempotencyKey: "routed-wire",
        routing: { complexity: "routine", requiresImages: false, taskType: "reasoning" } },
    });
    assert.equal(routedStart.isError, false);
    const routedRun = JSON.parse((routedStart.content as { text: string }[])[0].text);
    assert.equal(routedRun.model, "gpt-6-luna");
    assert.equal(routedRun.routing.selected.basis, "policy");
    assert.equal(routedRun.routing.taskType, "reasoning");
    assert.equal(catalogReads, 2);
    const linkedPath = join(dir, "linked");
    mkdirSync(linkedPath);
    const linkedProjectReply = await client.callTool({ name: "project_register", arguments: { name: "linked", path: linkedPath } });
    const linkedProject = JSON.parse((linkedProjectReply.content as { text: string }[])[0].text);
    const sourceId = randomUUID();
    service.store.insertRun({ ...service.store.run(routedRun.id)!, id: sourceId, projectId: linkedProject.id,
      prompt: "Original work", state: "completed", result: "Source finding data", workerPid: undefined,
      workspace: { kind: "project", path: linkedProject.path } }, "seeded-source");
    const linkedReply = await client.callTool({ name: "task_start", arguments: {
      projectId: linkedProject.id, prompt: "Review the source", idempotencyKey: "linked-wire",
      readOnly: true, followUp: { runId: sourceId, kind: "review" },
    } });
    assert.equal(linkedReply.isError, false);
    const linkedRun = JSON.parse((linkedReply.content as { text: string }[])[0].text);
    assert.deepEqual(linkedRun.followUp, { kind: "review", parentRunId: sourceId, rootRunId: sourceId });
    assert.equal(linkedRun.followUpContext, undefined);
    const linkedContext = await client.callTool({ name: "run_context_read", arguments: { runId: linkedRun.id } });
    assert.equal(JSON.parse((linkedContext.content as { text: string }[])[0].text).followUpContext.sourceResult,
      "Source finding data");
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

test("request-scoped MCP client info wins over legacy info and unsafe names stay unknown", async () => {
  const { CLIENT_INFO_META_KEY } = await import("@modelcontextprotocol/server");
  const { requestClientSource } = await import("../src/mcp.ts");
  const { clientSourceHeader, sourceFromHeader } = await import("../src/launch-source.ts");
  const modern = requestClientSource({ [CLIENT_INFO_META_KEY]: { name: "新 client", version: "2" } }, () => {
    assert.fail("modern request must not read shared legacy state");
  });
  assert.deepEqual(modern, { kind: "mcp", clientName: "新 client", clientVersion: "2" });
  assert.deepEqual(sourceFromHeader(clientSourceHeader(modern)["x-agentklar-mcp-client"]), modern);
  const unicode = requestClientSource(undefined, () => ({ name: "界".repeat(80), version: "界".repeat(40) }));
  assert.deepEqual(sourceFromHeader(clientSourceHeader(unicode)["x-agentklar-mcp-client"]), unicode);
  assert.deepEqual(requestClientSource(undefined, () => ({ name: "legacy", version: "1" })),
    { kind: "mcp", clientName: "legacy", clientVersion: "1" });
  assert.equal(requestClientSource({ [CLIENT_INFO_META_KEY]: { name: "bad\nname" } }, () => ({ name: "legacy" })), undefined);
  assert.equal(requestClientSource({ [CLIENT_INFO_META_KEY]: { name: "bad\ud800" } }, () => ({ name: "legacy" })), undefined);
  assert.equal(sourceFromHeader("not%%%base64"), undefined);
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
  let reconnect: Client | undefined;
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
    assert.deepEqual(started.launchSource, { kind: "mcp", clientName: "codex-host", clientVersion: "1" });
    const discovered = (await call(clients[1], "project_runs_list", readArgs)).data;
    assert.equal(discovered.projectId, p.id);
    assert.equal(discovered.runs[0].id, started.id);
    assert.deepEqual(discovered.runs[0].launchSource, started.launchSource);
    assert.equal(discovered.runs[0].contextSnapshot, undefined);
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
    const replay = (await call(clients[1], "task_start", startArgs)).data;
    assert.equal(replay.id, started.id);
    assert.deepEqual(replay.launchSource, started.launchSource);
    await clients[0].close();
    reconnect = new Client({ name: "fresh-host", version: "3" });
    await reconnect.connect(new StdioClientTransport({
      command: "npm", args: ["--prefix", resolve("."), "run", "--silent", "mcp"],
      env: { ...(process.env as Record<string, string>), AGENTKLAR_HOME: home, AGENTKLAR_PORT: String(port) },
      stderr: "pipe",
    }));
    const afterReconnect = (await call(reconnect, "project_runs_list", readArgs)).data;
    assert.equal(afterReconnect.runs[0].id, started.id);
    assert.deepEqual(afterReconnect.runs[0].launchSource, started.launchSource);
    for (const name of ["run_status", "run_result", "run_stop"]) {
      const reply = await call(clients[1], name, { runId: started.id });
      assert.equal(reply.data.contextRevision, 1);
      assert.equal(reply.data.contextSnapshot, undefined);
      assert.doesNotMatch(JSON.stringify(reply.data), /MCP_SAVED_BRIEF/);
    }
  } finally {
    await reconnect?.close().catch(() => {});
    for (const client of clients) await client.close().catch(() => {});
    await service.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
