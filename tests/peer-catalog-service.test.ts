import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";
import { Peers, type PeerTransport } from "../src/peers.ts";
import { deviceSettings } from "../src/devices.ts";
import type { CatalogSnapshot, Project } from "../src/contracts.ts";

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-peer-catalog-")));
  const sourcePort = 4317, ownerPort = 4318;
  let discoveries = 0, transports = 0, starts = 0, wrongProject = false;
  let beforeReply: (() => Promise<void>) | undefined;
  const factory = () => { starts++; throw new Error("Catalog reads must not start workers"); };
  const owner = createService(join(dir, "owner"), ownerPort, factory, null, null, async project => {
    discoveries++;
    const snapshot: CatalogSnapshot = { projectId: wrongProject ? randomUUID() : project.id, checkedAt: new Date().toISOString(), harnesses: [{
      harness: "opencode", modelsStatus: "available", modelsMessage: null, modelsTruncated: false,
      models: [{ id: "zai-coding-plan/glm-5", name: "GLM", description: "Remote model", resolvedModel: null, isDefault: false, inputModalities: ["text"] }],
      quota: { status: "unavailable", message: "Native allowance unavailable", ordinaryUsageAllowed: null, buckets: [] },
    }] };
    return snapshot;
  }, {}, undefined, {}, {}, null, {}, null, undefined, { gemini: null, "cursor-agent": null, zcode: null });
  const call = (service: typeof owner, port: number) => async (path: string, method = "GET", body?: unknown) => {
    const response = await service.app.request(`http://127.0.0.1:${port}${path}`, {
      method, headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const transport: PeerTransport = async (_peer, envelope) => {
    transports++;
    assert.equal(envelope.operation, "catalog");
    const reply = await call(owner, ownerPort)("/api/peer", "POST", envelope);
    await beforeReply?.();
    return reply;
  };
  const source = createService(join(dir, "source"), sourcePort, factory, null, null,
    async project => ({ projectId: project.id, checkedAt: new Date().toISOString(), harnesses: [] }),
    {}, undefined, {}, {}, null, {}, null, transport, { gemini: null, "cursor-agent": null, zcode: null });
  const project = (service: typeof owner, name: string) => {
    const path = join(dir, name); mkdirSync(path);
    const value: Project = { id: randomUUID(), name, path, preference: "balanced", roles: [], createdAt: new Date().toISOString() };
    service.store.saveProject(value); return value;
  };
  const localProject = project(source, "local"), otherProject = project(source, "other"), remoteProject = project(owner, "remote");
  const sourceDevice = deviceSettings(source.store.db).device, ownerDevice = deviceSettings(owner.store.db).device;
  const ownerPeers = new Peers(owner.store, ownerDevice, call(owner, ownerPort));
  const peers = new Peers(source.store, sourceDevice, call(source, sourcePort));
  const grant = ownerPeers.grant({ sourceDeviceId: sourceDevice.id, projectId: remoteProject.id });
  const mapping = peers.saveConnection({ label: "Mac mini", deviceId: ownerDevice.id, projectId: localProject.id,
    remoteProjectId: remoteProject.id, sshHost: "fixture-host", command: "agentklar", grantId: grant.id, grantToken: grant.token });
  const path = `/api/peers/${mapping.id}/catalog?projectId=${localProject.id}`;
  const request = (route = path, authenticated = true) => source.app.request(`http://127.0.0.1:${sourcePort}${route}`,
    { headers: authenticated ? { Authorization: `Bearer ${source.bearer}` } : {} });
  return { source, owner, ownerPeers, mapping, grant, localProject, otherProject, remoteProject, path, request,
    get discoveries() { return discoveries; }, get transports() { return transports; }, get starts() { return starts; },
    wrongProject() { wrongProject = true; }, beforeReply(callback: () => Promise<void>) { beforeReply = callback; },
    async close() { await source.close(); await owner.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("peer catalog requires authentication and the exact saved local project mapping", async () => {
  const f = fixture();
  try {
    assert.equal((await f.request(f.path, false)).status, 401);
    for (const path of [
      `/api/peers/${f.mapping.id}/catalog`,
      `/api/peers/not-a-peer/catalog?projectId=${f.localProject.id}`,
      `/api/peers/${f.mapping.id}/catalog?projectId=invalid`,
    ]) assert.equal((await f.request(path)).status, 400);
    assert.equal((await f.request(`/api/peers/${randomUUID()}/catalog?projectId=${f.localProject.id}`)).status, 404);
    assert.equal((await f.request(`/api/peers/${f.mapping.id}/catalog?projectId=${randomUUID()}`)).status, 404);
    assert.equal((await f.request(`/api/peers/${f.mapping.id}/catalog?projectId=${f.otherProject.id}`)).status, 409);
    assert.equal(f.transports, 0);
    assert.equal(f.discoveries, 0);
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const snapshot = await response.json();
    assert.equal(snapshot.projectId, f.remoteProject.id);
    assert.equal(snapshot.harnesses[0].models[0].id, "zai-coding-plan/glm-5");
    assert.equal(f.discoveries, 1);
    assert.equal(f.starts, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(f.grant.token));
    f.ownerPeers.revoke({ grantId: f.grant.id });
    assert.equal((await f.request()).status, 403);
    assert.equal(f.discoveries, 1, "A revoked grant must not discover native metadata");
  } finally { await f.close(); }
});

test("peer catalog rejects metadata for another remote project", async () => {
  const f = fixture();
  try {
    f.wrongProject();
    const response = await f.request();
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /saved remote project/);
    assert.equal(f.starts, 0);
  } finally { await f.close(); }
});

test("peer catalog rejects a saved mapping changed during discovery", async () => {
  const f = fixture();
  try {
    f.beforeReply(async () => {
      const row = f.source.store.db.prepare("SELECT data FROM peer_connections WHERE id=?").get(f.mapping.id)!;
      const saved = JSON.parse(row.data as string);
      f.source.store.db.prepare("UPDATE peer_connections SET data=? WHERE id=?").run(JSON.stringify({ ...saved, deviceId: randomUUID() }), f.mapping.id);
    });
    const response = await f.request();
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /mapping changed/);
    assert.equal(f.starts, 0);
  } finally { await f.close(); }
});
