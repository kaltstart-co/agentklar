import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createOpenCode2Client, openCode2Event, openCode2Message, openCode2Providers } from "../src/opencode2.ts";
import { OpenCodeWorker, openCodeModels, type OpenCodeConnect } from "../src/opencode.ts";
import type { Approval, Run } from "../src/contracts.ts";

const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await pause(); } assert.fail("timed out"); }
const nativeProviders = [{ id: "opencode", activation: "auto", headers: { Authorization: "PRIVATE" } }, { id: "disabled", activation: "disabled" }];
const nativeModels = [{ id: "fixture", providerID: "opencode", name: "Fixture", capabilities: { tools: true, input: ["text", "image"] }, headers: { token: "PRIVATE" } }];

test("OpenCode 2 catalog and messages keep native identities and strip provider configuration", () => {
  const normalized = openCode2Providers(nativeProviders, nativeModels);
  assert.deepEqual(openCodeModels(normalized).map(m => m.id), ["opencode/fixture"]);
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE/);
  const message = openCode2Message({ type: "assistant", id: "msg_fixture", model: { id: "fixture", providerID: "opencode" },
    tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 4, write: 5 } }, content: [{ type: "text", text: "Done" }] }, "ses_fixture");
  assert.equal(message.info.tokens?.total, 15);
  assert.equal(message.info.sessionID, "ses_fixture");
  assert.equal(openCode2Message({ type: "assistant", tokens: { input: -1 } }, "ses_fixture").info.tokens?.total, undefined);
  assert.equal(openCode2Event({ type: "session.status", data: { sessionID: "ses_fixture", status: { type: "idle" } } }).type, "session.idle");
  assert.deepEqual((openCode2Event({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_fixture" } }).properties as Record<string, unknown>).info,
    { id: "ses_child", parentID: "ses_fixture" });
});

async function fixture(mode: "complete" | "permission" | "changed" | "failed" | "truncated" | "cancel" | "repeated" | "reannounced") {
  const directory = "/tmp/agentklar-opencode2-protocol", sessionID = "ses_fixture";
  const paths: { method: string; path: string; body: any }[] = [];
  let events: ServerResponse | undefined, run: Run = { id: randomUUID(), projectId: randomUUID(), harness: "opencode", model: "opencode/fixture",
    prompt: "Fixture", readOnly: false, result: "", tokens: null, state: "running", createdAt: "now", updatedAt: "now" };
  let reply: string | undefined, outcome = "succeeded", done = 0, closed = 0;
  const approval = { id: "per_fixture", sessionID, action: "bash", resources: ["pwd"], metadata: { command: "pwd", cwd: directory },
    source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" } };
  let approvalCount = 0;
  let reviewed: { approval: Approval; answer: (value: string) => void } | undefined;
  const emit = (type: string, data: unknown) => events!.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  const finish = () => { outcome = mode === "failed" ? "failed" : "succeeded"; emit("session.status", { sessionID, status: { type: "idle" } }); emit("session.execution.succeeded", { sessionID }); };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Basic fixture");
    const url = new URL(req.url!, "http://127.0.0.1"), chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    paths.push({ method: req.method!, path: url.pathname, body });
    const json = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (url.pathname === "/api/event") { events = res; res.setHeader("Content-Type", "text/event-stream"); emit("server.connected", {}); return; }
    if (url.pathname === "/api/provider") { json({ location: { directory }, data: nativeProviders }); return; }
    if (url.pathname === "/api/model") { json({ location: { directory }, data: nativeModels }); return; }
    if (url.pathname === "/api/session" && req.method === "POST") { assert.deepEqual(body, { title: "AgentKlar worker", location: { directory } }); json({ data: { id: sessionID, location: { directory } } }); return; }
    if (url.pathname === "/api/session" && req.method === "GET") { assert.equal(url.searchParams.get("parentID"), sessionID); json({ data: [], cursor: {} }); return; }
    if (url.pathname.endsWith("/model")) { setImmediate(() => emit("session.status", { sessionID, status: { type: "idle" } })); assert.deepEqual(body, { model: { providerID: "opencode", id: "fixture" } }); res.statusCode = 204; res.end(); return; }
    if (url.pathname.endsWith("/prompt")) {
      assert.equal(typeof body.text, "string"); assert.equal(body.permissions, undefined);
      json({ data: { id: "inb_fixture" } });
      emit("session.execution.started", { sessionID }); setImmediate(() => { if (["permission", "changed", "repeated", "reannounced"].includes(mode)) emit("permission.asked", approval); else if (mode !== "cancel") finish(); }); return;
    }
    if (url.pathname.endsWith("/permission/per_fixture")) { json({ data: ["changed", "reannounced"].includes(mode) ? { ...approval, metadata: { command: "rm -rf important" } } : approval }); return; }
    if (url.pathname.endsWith("/permission/per_fixture/reply")) { reply = body.decision; assert.ok(["once", "reject"].includes(reply!)); res.statusCode = 204; res.end(); setImmediate(finish); return; }
    if (url.pathname.endsWith("/interrupt")) { assert.deepEqual(body, { resume: false }); json({ data: { interrupted: true } }); return; }
    if (url.pathname.endsWith("/message")) { if (mode === "complete" && url.searchParams.has("cursor")) { json({ data: [], cursor: {} }); return; } assert.equal(url.searchParams.get("order"), url.searchParams.has("cursor") ? null : "asc");
      json({ data: [{ type: "assistant", id: "msg_finished", model: { id: "fixture", providerID: "opencode" }, finish: "stop", time: { completed: 10 },
        tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 4, write: 5 } }, content: [{ type: "text", text: "Done" }] }],
        cursor: mode === "truncated" ? { next: "more" } : mode === "complete" ? { previous: "boundary-start", next: "boundary-end" } : {} }); return; }
    if (url.pathname === `/api/session/${sessionID}`) { json({ data: { outcome, time: { idle: 12 } } }); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const client = createOpenCode2Client(`http://127.0.0.1:${port}`, directory, "Basic fixture");
  const connect: OpenCodeConnect = async () => ({ client: client as any, protocol: 2, close: async () => { closed++; server.closeAllConnections(); server.close(); }, exited: new Promise(() => {}) });
  const worker = new OpenCodeWorker("fixture", run, directory, {
    update: patch => { run = { ...run, ...patch }; }, event: () => {}, done: () => { done++; }, approval: (value, answer) => {
      approvalCount++;
      if (!reviewed) {
        reviewed = { approval: value, answer };
        if (["repeated", "reannounced"].includes(mode)) setImmediate(() => emit("permission.asked",
          mode === "reannounced" ? { ...approval, metadata: { command: "rm -rf important" } } : approval));
      }
    },
  }, connect);
  return { worker, run: () => run, paths, reviewed: () => reviewed, reply: () => reply, closed: () => closed, done: () => done, approvalCount: () => approvalCount };
}

test("OpenCode 2 worker completes only successful root outcome and full typed timeline", async () => {
  for (const mode of ["complete", "failed", "truncated"] as const) {
    const f = await fixture(mode); await f.worker.closed;
    assert.equal(f.run().state, mode === "complete" ? "completed" : "failed");
    assert.equal(f.run().result, mode === "complete" ? "Done" : "");
    if (mode === "complete") { assert.equal(f.run().tokens, 15); assert.equal(f.run().effectiveModel, "opencode/fixture"); }
    assert.equal(f.closed(), 1); assert.equal(f.done(), 1);
    assert.equal(f.paths.some(p => p.path.endsWith("/interrupt")), mode !== "complete");
  }
});

test("OpenCode 2 native approval stays pending until explicit once or reject and checks unchanged request", async () => {
  for (const [mode, decision] of [["permission", "accept"], ["permission", "decline"], ["changed", "accept"]] as const) {
    const f = await fixture(mode); await until(() => !!f.reviewed());
    assert.equal(f.reply(), undefined); assert.equal(f.run().state, "needs_attention");
    f.reviewed()!.answer(decision); await f.worker.closed;
    assert.equal(f.reply(), mode === "changed" ? undefined : decision === "accept" ? "once" : "reject");
    assert.equal(f.run().state, mode === "changed" ? "needs_attention" : "completed");
    assert.equal(f.paths.some(p => p.body?.decision === "always"), false);
  }
});


test("OpenCode 2 repeated permissions preserve the first reviewed request", async () => {
  for (const mode of ["repeated", "reannounced"] as const) {
    const f = await fixture(mode); await until(() => !!f.reviewed());
    if (mode === "reannounced") await f.worker.closed;
    else await new Promise(resolve => setTimeout(resolve, 30));
    f.reviewed()!.answer("accept"); await f.worker.closed;
    assert.equal(f.approvalCount(), 1);
    assert.equal(f.reply(), mode === "repeated" ? "once" : undefined);
    assert.equal(f.paths.some(p => p.path.endsWith("/permission/per_fixture/reply")), mode === "repeated");
    assert.equal(f.run().state, mode === "repeated" ? "completed" : "needs_attention");
  }
});

test("OpenCode 2 cancellation interrupts owned root before process cleanup", async () => {
  const f = await fixture("cancel"); await until(() => f.paths.some(p => p.path.endsWith("/prompt")));
  f.worker.stop(); await f.worker.closed;
  assert.equal(f.run().state, "cancelled"); assert.equal(f.run().result, "");
  assert.ok(f.paths.some(p => p.path.endsWith("/interrupt"))); assert.equal(f.closed(), 1);
});

test("OpenCode 2 waits for its native startup catalog to settle", async () => {
  let snapshots = 0;
  const nativeFetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const data = path === "/api/provider" ? nativeProviders : (++snapshots === 1 ? [] : nativeModels);
    return new Response(JSON.stringify({ location: { directory: "/tmp/project" }, data }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = createOpenCode2Client("http://127.0.0.1:1234", "/tmp/project", "Basic private", nativeFetch);
  assert.deepEqual(openCodeModels((await client.provider.list()).data).map(model => model.id), ["opencode/fixture"]);
  assert.equal(snapshots, 2);
});
