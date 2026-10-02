import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";
import { Peers, PeerError, type PeerTransport } from "../src/peers.ts";
import { deviceSettings } from "../src/devices.ts";

test("independent owner grant survives coordinator handoff and lost acknowledgement without a second worker", { timeout: 15000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-control-review-")));
  const local = join(dir, "local"), remote = join(dir, "remote");
  mkdirSync(local);
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("-C", local, "init");
  git("-C", local, "config", "user.email", "fixture@example.test");
  git("-C", local, "config", "user.name", "Fixture");
  writeFileSync(join(local, "one.txt"), "base\n");
  git("-C", local, "add", ".");
  git("-C", local, "commit", "-m", "base");
  git("clone", local, remote);
  let launches = 0, loseAck = true;
  const owner = createService(join(dir, "owner"), 4332, () => {
    launches++;
    return { stop() {}, closed: Promise.resolve() };
  }, process.execPath, null);
  const transport: PeerTransport = async (_peer, envelope) => {
    const reply = await owner.app.request("http://127.0.0.1:4332/api/peer", {
      method: "POST", headers: { Authorization: `Bearer ${owner.bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(envelope),
    });
    const result = { status: reply.status, body: await reply.json() };
    if (loseAck && envelope.operation === "start") { loseAck = false; throw new PeerError("Lost acknowledgement", 503); }
    return result;
  };
  const source = createService(join(dir, "source"), 4331, () => { throw new Error("Unexpected local worker"); }, process.execPath, null, undefined, undefined, undefined, undefined, undefined, null, undefined, null, transport);
  const call = async (service: typeof source, port: number, path: string, method = "GET", body?: unknown, bridge = "a", ui = false) => {
    const cookie = ui ? (await service.app.request(service.setupUrl)).headers.get("set-cookie")!.split(";")[0] : undefined;
    const response = await service.app.request(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(ui ? { Cookie: cookie!, Origin: `http://127.0.0.1:${port}` } : { Authorization: `Bearer ${service.bearer}`, "x-agentklar-bridge-id": bridge.repeat(64) }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const project = (service: typeof source, path: string) => {
      const p = { id: randomUUID(), name: "Control review", path, roles: [], preference: "balanced" as const, createdAt: new Date().toISOString() };
      service.store.saveProject(p); return p;
    };
    const a = project(source, local), b = project(owner, remote);
    const sourceDevice = deviceSettings(source.store.db).device, ownerDevice = deviceSettings(owner.store.db).device;
    const ownerPeers = new Peers(owner.store, ownerDevice, async () => { throw new Error("Fixture settings only"); });
    const grant = ownerPeers.grant({ sourceDeviceId: sourceDevice.id, projectId: b.id });
    const sourcePeers = new Peers(source.store, sourceDevice, async () => { throw new Error("Fixture settings only"); }, transport);
    const mapping = sourcePeers.saveConnection({ label: "Owner", deviceId: ownerDevice.id, sshHost: "fixture", command: "agentklar", projectId: a.id, remoteProjectId: b.id, grantId: grant.id, grantToken: grant.token });
    for (const [service, port, p, bridge] of [[source, 4331, a, "a"], [owner, 4332, b, "c"]] as const) {
      assert.equal((await call(service, port, `/api/projects/${p.id}/lead`, "POST", { action: "claim" }, bridge)).status, 200);
      const status = await call(service, port, `/api/projects/${p.id}/control`);
      assert.equal((await call(service, port, `/api/projects/${p.id}/control`, "PUT", { mode: "coordinated", expectedRevision: status.body.revision }, bridge, true)).status, 200);
    }
    const ownerClaimId = (await call(owner, 4332, `/api/projects/${b.id}/control`)).body.lead.claimId;
    const input = { peerId: mapping.id, idempotencyKey: "lost-ack", baseCommit: git("-C", local, "rev-parse", "HEAD"), task: { prompt: "Fixture work", model: "gpt-6.1-sol" } };
    const unknown = await call(source, 4331, "/api/peers/dispatch", "POST", input);
    assert.equal(unknown.status, 200); assert.equal(unknown.body.connection, "unknown");
    for (let i = 0; i < 100 && launches === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(launches, 1); assert.equal(owner.store.runs().length, 1);
    const packet = (await call(source, 4331, `/api/projects/${a.id}/control/prepare`, "POST", {})).body;
    const accepted = await call(source, 4331, `/api/projects/${a.id}/control/packets/${packet.id}/accept`, "POST", { requestId: randomUUID(), expectedDigest: packet.digest, expectedContextRevision: packet.context.revision, expectedControlRevision: packet.control.revision }, "b");
    assert.equal(accepted.status, 200);
    const replay = await call(source, 4331, "/api/peers/dispatch", "POST", input);
    assert.equal(replay.status, 200); assert.equal(replay.body.id, unknown.body.id); assert.equal(replay.body.connection, "observed");
    assert.equal(owner.store.runs().length, 1); assert.equal(launches, 1);
    assert.equal((await call(source, 4331, "/api/peers/dispatch", "POST", { ...input, idempotencyKey: "stale-new" })).status, 409);
    assert.equal((await call(source, 4331, `/api/peers/dispatch/${unknown.body.id}/cancel`, "POST", {})).status, 409);
    assert.equal(owner.store.runs()[0].state, "running");
    const cancelled = await call(source, 4331, `/api/peers/dispatch/${unknown.body.id}/cancel`, "POST", {}, "b");
    assert.equal(cancelled.status, 200); assert.equal(cancelled.body.lastKnownRun.state, "cancelled");
    assert.equal((await call(owner, 4332, `/api/projects/${b.id}/control`)).body.lead.claimId, ownerClaimId);
    assert.equal(launches, 1);
  } finally { await source.close(); await owner.close(); rmSync(dir, { recursive: true, force: true }); }
});
