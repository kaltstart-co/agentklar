import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";
import { Peers, type PeerEnvelope, type PeerTransport, PeerError, peerSaveSchema, sshPeerTransport } from "../src/peers.ts";
import { deviceSettings } from "../src/devices.ts";

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-peers-"))), a = join(dir, "a"), b = join(dir, "b");
  mkdirSync(a);
  const git = (...args: string[]) => execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  git("-C", a, "init"); git("-C", a, "config", "user.email", "fixture@example.test"); git("-C", a, "config", "user.name", "Fixture");
  writeFileSync(join(a, "one.txt"), "one\n"); git("-C", a, "add", "."); git("-C", a, "commit", "-m", "base"); git("clone", a, b);
  const baseCommit = git("-C", a, "rev-parse", "HEAD");
  let starts = 0;
  const make = (home: string, port: number) => createService(home, port, () => { starts++; return { stop() {}, closed: Promise.resolve() }; }, process.execPath, null);
  let coordinator = make(join(dir, "coordinator"), 4321);
  let owner = make(join(dir, "owner"), 4322);
  const project = (service: typeof owner, path: string) => { const p = { id: randomUUID(), name: "fixture", path, roles: [], preference: "balanced" as const, createdAt: new Date().toISOString() }; service.store.saveProject(p); return p; };
  const localProject = project(coordinator, a), remoteProject = project(owner, b);
  const localDevice = deviceSettings(coordinator.store.db).device, remoteDevice = deviceSettings(owner.store.db).device;
  const call = (service: typeof owner, port: number) => async (path: string, method = "GET", body?: unknown) => {
    const response = await service.app.request(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  let ownerPeers = new Peers(owner.store, remoteDevice, call(owner, 4322));
  const grant = ownerPeers.grant({ sourceDeviceId: localDevice.id, projectId: remoteProject.id });
  let loseAck = false, offline = false;
  const transport: PeerTransport = async (_peer, request) => {
    if (offline) throw new PeerError("fixture disconnected", 503);
    const reply = await ownerPeers.owner(request);
    if (loseAck) { loseAck = false; throw new PeerError("fixture acknowledgement lost", 503); }
    return reply;
  };
  let peers = new Peers(coordinator.store, localDevice, call(coordinator, 4321), transport);
  const peer = peers.saveConnection({ label: "Other computer", deviceId: remoteDevice.id, sshHost: "fixture-host", command: "agentklar", projectId: localProject.id, remoteProjectId: remoteProject.id, grantId: grant.id, grantToken: grant.token });
  return { dir, get peers() { return peers; }, get ownerPeers() { return ownerPeers; }, grant, get coordinator() { return coordinator; }, get owner() { return owner; }, peer, localDevice, remoteDevice, remoteProject, localProject, baseCommit,
    get starts() { return starts; }, setLoseAck() { loseAck = true; }, setOffline(v: boolean) { offline = v; },
    async restartOwner() { await owner.close(); owner = make(join(dir, "owner"), 4322); ownerPeers = new Peers(owner.store, deviceSettings(owner.store.db).device, call(owner, 4322)); },
    async restartCoordinator() { await coordinator.close(); coordinator = make(join(dir, "coordinator"), 4321); peers = new Peers(coordinator.store, deviceSettings(coordinator.store.db).device, call(coordinator, 4321), transport); },
    async close() { await coordinator.close(); await owner.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function waitForStart(f: ReturnType<typeof fixture>) { for (let i = 0; i < 100 && f.starts === 0; i++) await new Promise(r => setTimeout(r, 10)); assert.equal(f.starts, 1); }

test("two owners preserve one remote worker after lost acknowledgement, reconnect and scoped cancel", async () => {
  const f = fixture();
  try {
    assert.equal((await f.peers.test({ peerId: f.peer.id })).device!.id, f.remoteDevice.id);
    const input = { peerId: f.peer.id, idempotencyKey: "one", baseCommit: f.baseCommit, task: { prompt: "fixture task", model: "gpt-6.1-sol" } };
    f.setLoseAck();
    const unknown = await f.peers.start(input);
    assert.equal(unknown.connection, "unknown"); assert.equal(unknown.ownerRunId, undefined);
    await waitForStart(f);
    assert.equal(f.owner.store.runs().length, 1);
    const observed = await f.peers.status(unknown.id);
    assert.equal(observed.connection, "observed"); assert.equal(observed.ownerRunId, f.owner.store.runs()[0].id);
    assert.equal(f.starts, 1);
    assert.equal((await f.peers.start(input)).id, unknown.id);
    await assert.rejects(f.peers.start({ ...input, task: { prompt: "changed" } }), /different inputs/);
    f.setOffline(true);
    const stale = await f.peers.status(unknown.id);
    assert.equal(stale.connection, "unknown"); assert.deepEqual(stale.lastKnownRun, observed.lastKnownRun);
    assert.equal(f.owner.store.runs()[0].state, "running");
    await f.restartCoordinator();
    assert.equal(f.peers.list()[0].id, unknown.id);
    assert.equal(f.owner.store.runs()[0].state, "running");
    f.setOffline(false);
    const cancelled = await f.peers.cancel(unknown.id);
    assert.equal((cancelled.lastKnownRun as { state: string }).state, "cancelled");
    assert.doesNotMatch(JSON.stringify(f.peers.settings()), new RegExp(f.grant.token));
    assert.doesNotMatch(JSON.stringify(f.peers.list()), new RegExp(f.grant.token));
  } finally { await f.close(); }
});

test("peer grants reject wrong devices, other runs, unknown versions, revocation and mismatched Git base", async () => {
  const f = fixture();
  try {
    const envelope: PeerEnvelope = { version: 1, sourceDeviceId: f.localDevice.id, targetDeviceId: f.remoteDevice.id, grantId: f.grant.id, token: f.grant.token, operation: "hello", requestId: randomUUID() };
    await assert.rejects(f.ownerPeers.owner({ ...envelope, targetDeviceId: randomUUID() }), /Wrong owner/);
    await assert.rejects(f.ownerPeers.owner({ ...envelope, version: 2 }));
    await assert.rejects(f.ownerPeers.owner({ ...envelope, operation: "cancel", runId: randomUUID() }), /outside/);
    await assert.rejects(f.ownerPeers.owner({ ...envelope, operation: "approval" }));
    const bad = await f.peers.start({ peerId: f.peer.id, idempotencyKey: "wrong-base", baseCommit: "a".repeat(40), task: { prompt: "wrong" } }).catch(e => e);
    assert.match(bad.message, /Git base/); assert.equal(f.owner.store.runs().length, 0);
    await assert.rejects(f.ownerPeers.owner({ ...envelope, operation: "start", baseCommit: "a".repeat(40), task: { prompt: "wrong", readOnly: false } }), /Git base/);
    f.ownerPeers.revoke({ grantId: f.grant.id });
    await assert.rejects(f.ownerPeers.owner(envelope), /revoked/);
    assert.equal(f.starts, 0);
    assert.equal(peerSaveSchema.safeParse({ ...f.peer, sshHost: "-oProxyCommand=bad", grantToken: f.grant.token }).success, false);
  } finally { await f.close(); }
});

test("MCP cannot create device grants or answer approvals through the peer endpoint", async () => {
  const f = fixture();
  try {
    for (const path of ["/api/peers/settings", "/api/peers/settings/grant"]) {
      const response = await f.coordinator.app.request(`http://127.0.0.1:4321${path}`, { method: path.endsWith("grant") ? "POST" : "GET", headers: { Authorization: `Bearer ${f.coordinator.bearer}`, "Content-Type": "application/json" }, ...(path.endsWith("grant") ? { body: JSON.stringify({ sourceDeviceId: f.remoteDevice.id, projectId: f.localProject.id }) } : {}) });
      assert.equal(response.status, 403);
    }
  } finally { await f.close(); }
});


test("stdio peer bridge reaches only the owner's scoped loopback endpoint", async () => {
  const f = fixture();
  const server = serve({ fetch: f.owner.app.fetch, hostname: "127.0.0.1", port: 4322 });
  try {
    const script = `import { startPeerStdio } from ${JSON.stringify(new URL("../src/peer-cli.ts", import.meta.url).href)}; startPeerStdio().catch(e => { console.error(e.message); process.exitCode = 1; });`;
    const request = { version: 1, sourceDeviceId: f.localDevice.id, targetDeviceId: f.remoteDevice.id, grantId: f.grant.id, token: f.grant.token, operation: "hello", requestId: randomUUID() };
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { env: { ...process.env, AGENTKLAR_HOME: join(f.dir, "owner"), AGENTKLAR_PORT: "4322" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", d => output += d); child.stderr.on("data", d => error += d);
    child.stdin.end(JSON.stringify(request) + "\n");
    const exit = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(exit, 0, error);
    const reply = JSON.parse(output);
    assert.equal(reply.id, request.requestId); assert.equal(reply.status, 200); assert.equal(reply.body.device.id, f.remoteDevice.id);
    assert.doesNotMatch(output + error, new RegExp(f.grant.token));
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await f.close(); }
});


test("remote committed snapshots allow dirty roots without copying unsaved or untracked files", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.localProject.path, "one.txt"), "source unsaved\n");
    writeFileSync(join(f.localProject.path, "untracked.txt"), "not transferred\n");
    writeFileSync(join(f.remoteProject.path, "one.txt"), "owner unsaved\n");
    const dispatch = await f.peers.start({ peerId: f.peer.id, idempotencyKey: "committed", baseCommit: f.baseCommit, task: { prompt: "Use only the committed snapshot" } });
    assert.equal(dispatch.connection, "observed");
    await waitForStart(f);
    const workspace = f.owner.store.runs()[0].workspace!;
    assert.equal(workspace.kind, "worktree");
    assert.equal(readFileSync(join(workspace.path!, "one.txt"), "utf8"), "one\n");
    assert.equal(existsSync(join(workspace.path!, "untracked.txt")), false);
    assert.equal(readFileSync(join(f.localProject.path, "one.txt"), "utf8"), "source unsaved\n");
    assert.equal(readFileSync(join(f.remoteProject.path, "one.txt"), "utf8"), "owner unsaved\n");
  } finally { await f.close(); }
});


test("owner restart reports interruption without recovering or relaunching native work", async () => {
  const f = fixture();
  try {
    const input = { peerId: f.peer.id, idempotencyKey: "owner-restart", baseCommit: f.baseCommit, task: { prompt: "bounded task" } };
    const dispatch = await f.peers.start(input);
    await waitForStart(f);
    await f.restartOwner();
    const observed = await f.peers.status(dispatch.id);
    assert.equal(observed.lastKnownRun?.state, "interrupted");
    assert.equal((await f.peers.start(input)).ownerRunId, dispatch.ownerRunId);
    assert.equal(f.starts, 1);
    assert.equal(f.owner.store.runs().length, 1);
  } finally { await f.close(); }
});


test("SSH peer uses the exported Node path when the remote shell has no Node in PATH", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-ssh-path-"))), originalPath = process.env.PATH;
  try {
    const command = join(dir, "owner command.mjs");
    writeFileSync(command, `#!/usr/bin/env node
let input = ''; for await (const chunk of process.stdin) input += chunk; const request = JSON.parse(input); process.stdout.write(JSON.stringify({id:request.requestId,status:200,body:{ok:true}})+'\\n');
`);
    chmodSync(command, 0o700);
    const ssh = join(dir, "ssh");
    writeFileSync(ssh, '#!/bin/sh\nfor argument do remote_command="$argument"; done\nexec /bin/sh -c "$remote_command"\n');
    chmodSync(ssh, 0o700);
    process.env.PATH = dir;
    const peer = { id: randomUUID(), label: "Fixture", deviceId: randomUUID(), sshHost: "fixture", command, nodePath: process.execPath, projectId: randomUUID(), remoteProjectId: randomUUID(), grantId: randomUUID(), grantToken: "a".repeat(64) };
    const request: PeerEnvelope = { version: 1, sourceDeviceId: randomUUID(), targetDeviceId: peer.deviceId, grantId: peer.grantId, token: peer.grantToken, operation: "hello", requestId: randomUUID() };
    assert.equal((await sshPeerTransport(peer, request)).status, 200);
    const { nodePath, ...legacy } = peer;
    await assert.rejects(sshPeerTransport(legacy, request), /SSH peer command ended/);
    assert.equal(peerSaveSchema.safeParse(peer).success, false); // Stored record's id is not a save input.
    const { id, ...save } = peer;
    assert.equal(peerSaveSchema.safeParse(save).success, true);
    assert.equal(peerSaveSchema.safeParse({ ...save, command: "agentklar" }).success, false);
  } finally { process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); }
});


test("routing metadata is scoped to saved device/project/base and rejects stale evidence", async () => {
 const f=fixture();
 try {
  let body:any={deviceId:f.remoteDevice.id,projectId:f.remoteProject.id,baseCommit:f.baseCommit,catalog:{projectId:f.remoteProject.id,checkedAt:new Date().toISOString(),harnesses:[]},installed:{codex:true,claude:false}};
  const peers=new Peers(f.coordinator.store,f.localDevice,async()=>({status:200,body:{}}),async(_peer,request)=>{assert.equal(request.operation,"routing");assert.equal(request.baseCommit,f.baseCommit);return {status:200,body};});
  assert.equal((await peers.routing(f.peer.id,f.baseCommit)).device?.peerId,f.peer.id);
  body={...body,deviceId:randomUUID()};await assert.rejects(peers.routing(f.peer.id,f.baseCommit),/saved device/);
  body={...body,deviceId:f.remoteDevice.id,catalog:{...body.catalog,checkedAt:new Date(Date.now()-6*60_000).toISOString()}};
  await assert.rejects(peers.routing(f.peer.id,f.baseCommit),/stale/);
  const request:PeerEnvelope={version:1,sourceDeviceId:f.localDevice.id,targetDeviceId:f.remoteDevice.id,grantId:f.grant.id,token:f.grant.token,operation:"routing",baseCommit:"0".repeat(40)};
  await assert.rejects(f.ownerPeers.owner(request),/HEAD differs/);
 } finally {await f.coordinator.close();await f.owner.close();rmSync(f.dir,{recursive:true,force:true});}
});
