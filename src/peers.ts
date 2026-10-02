import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Run, CatalogSnapshot } from "./contracts.ts";
import type { Store } from "./store.ts";
import { gitBase } from "./workspace.ts";
import { z } from "zod";

const uuid = z.uuid();
const nodePath = z.string().startsWith("/").max(1000).refine(value => !/[\0\r\n]/.test(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const task = z.object({ prompt: z.string().trim().min(1).max(32000), harness: z.enum(["codex", "claude", "muse", "opencode"]).optional(), model: z.string().min(1).max(120).optional(), readOnly: z.boolean().default(false), includeProjectContext: z.literal(false).optional(), routing: z.object({ complexity: z.enum(["routine", "standard", "hard"]).default("standard"), requiresImages: z.boolean().default(false), taskType: z.enum(["coding", "reasoning", "data-analysis", "language"]).default("coding") }).strict().optional() }).strict();
const base = z.string().regex(/^[0-9a-f]{40,64}$/);
export const peerSaveSchema = z.object({ label: z.string().trim().min(1).max(120), deviceId: uuid, sshHost: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,199}$/), command: z.string().regex(/^(?:agentklar|\/[a-zA-Z0-9_./ -]{1,500})$/), nodePath: nodePath.optional(), projectId: uuid, remoteProjectId: uuid, grantId: uuid, grantToken: z.string().regex(/^[0-9a-f]{64}$/) }).strict().refine(value => !value.nodePath || value.command.startsWith("/"), "A pinned Node executable requires an absolute AgentKlar script path.");
export const peerDispatchSchema = z.object({ peerId: uuid, idempotencyKey: z.string().min(1).max(200), baseCommit: base, task }).strict();
const envelope = z.object({ version: z.literal(1), sourceDeviceId: uuid, targetDeviceId: uuid, grantId: uuid, token: z.string().regex(/^[0-9a-f]{64}$/), operation: z.enum(["hello", "catalog", "start", "status", "cancel"]), requestId: uuid.optional(), runId: uuid.optional(), baseCommit: base.optional(), task: task.optional() }).strict();
export type PeerEnvelope = z.infer<typeof envelope>;
export type PeerConnection = z.infer<typeof peerSaveSchema> & { id: string; lastObservedAt?: string; lastError?: string };
type Device = { id: string; label: string; platform: string };
type Reply = { status: number; body: unknown };
export type PeerTransport = (peer: PeerConnection, request: PeerEnvelope) => Promise<Reply>;
type Dispatch = { id: string; launchHash?: string; prompt: string; createdAt: string; projectId: string; peerId: string; ownerDeviceId: string; key: string; digest: string; request: PeerEnvelope; ownerRunId?: string; lastObservedAt?: string; lastKnownRun?: Run; connection: "unknown" | "observed"; error?: string };
export type RemoteDispatch = Omit<Dispatch, "request" | "digest" | "key">;
export class PeerError extends Error { constructor(message: string, public status = 400) { super(message); } }
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/** A short-lived transport process never owns or stops a native worker. */
export const sshPeerTransport: PeerTransport = (peer, request) => new Promise((resolve, reject) => {
  const program = peer.nodePath ? `${shellQuote(peer.nodePath)} ${shellQuote(peer.command)}` : shellQuote(peer.command);
  const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", peer.sshHost, `${program} peer --stdio`], { stdio: ["pipe", "pipe", "ignore"] });
  let output = "", done = false;
  const finish = (error?: Error, reply?: Reply) => { if (done) return; done = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(reply!); };
  const timer = setTimeout(() => finish(new PeerError("Peer did not acknowledge in time. Its owned worker may still be running; query this dispatch again.", 503)), 35_000);
  child.on("error", () => finish(new PeerError("SSH could not start. Check your existing SSH setup.", 503)));
  child.on("exit", () => { if (!done) finish(new PeerError("SSH peer command ended without a verified reply. Check SSH access, the remote command and the running owner service. Owner status is unknown.", 503)); });
  child.stdout.on("data", data => {
    output += data.toString();
    if (Buffer.byteLength(output) > 128_000) return finish(new PeerError("Peer reply exceeded the allowed size.", 502));
    const newline = output.indexOf("\n");
    if (newline < 0) return;
    try {
      const value = JSON.parse(output.slice(0, newline));
      if (value.id !== request.requestId || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) throw new Error();
      finish(undefined, { status: value.status, body: value.body });
    } catch { finish(new PeerError("Peer sent an invalid reply.", 502)); }
  });
  child.stdin.end(JSON.stringify(request) + "\n");
});

export class Peers {
  private launch = { nodePath: process.execPath, command: fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../bin/agentklar.mjs" : "../../bin/agentklar.mjs", import.meta.url)) };
  constructor(private store: Store, private device: Device, private call: (path: string, method?: string, body?: unknown) => Promise<Reply>, private transport: PeerTransport = sshPeerTransport) {
    store.db.exec("CREATE TABLE IF NOT EXISTS peer_grants(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_connections(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_dispatches(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(projectId,key));");
  }
  private rows<T>(table: string): T[] { return this.store.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(r => JSON.parse(r.data as string)); }
  private save<T extends { id: string }>(table: string, value: T) { this.store.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, JSON.stringify(value)); }
  settings() {
    return { device: this.device, launch: this.launch, projects: this.store.projects().map(({ id, name, path }) => ({ id, name, path })),
      peers: this.rows<PeerConnection>("peer_connections").map(({ grantToken, ...peer }) => peer),
      grants: this.rows<{ id: string; sourceDeviceId: string; projectId: string; tokenHash: string; revoked: boolean }>("peer_grants").map(({ tokenHash, ...grant }) => grant) };
  }
  grant(input: unknown) {
    const data = z.object({ sourceDeviceId: uuid, projectId: uuid }).strict().parse(input);
    if (!this.store.projects().some(p => p.id === data.projectId)) throw new PeerError("Project not found", 404);
    if (data.sourceDeviceId === this.device.id) throw new PeerError("Choose another device's ID.");
    const token = randomBytes(32).toString("hex"), grant = { id: randomUUID(), ...data, tokenHash: hash(token), revoked: false };
    this.save("peer_grants", grant);
    const { tokenHash, revoked, ...publicGrant } = grant;
    return { ...publicGrant, token, launch: this.launch };
  }
  revoke(input: unknown) {
    const { grantId } = z.object({ grantId: uuid }).strict().parse(input);
    const grant = this.rows<{ id: string; revoked: boolean }>("peer_grants").find(g => g.id === grantId);
    if (!grant) throw new PeerError("Grant not found", 404);
    this.save("peer_grants", { ...grant, revoked: true });
    return { ok: true };
  }
  saveConnection(input: unknown) {
    const data = peerSaveSchema.parse(input);
    if (!this.store.projects().some(p => p.id === data.projectId)) throw new PeerError("Local project not found", 404);
    if (data.deviceId === this.device.id) throw new PeerError("Choose another device's ID.");
    const peer = { ...data, id: randomUUID() }; this.save("peer_connections", peer);
    const { grantToken, ...publicPeer } = peer; return publicPeer;
  }
  resolveMapping(projectId: string, peerId: string) { const { grantToken, ...peer } = this.peer(uuid.parse(peerId)); if (peer.projectId !== projectId) throw new PeerError("Device mapping belongs to another project.", 409); return peer; }
  private peer(id: string) { const peer = this.rows<PeerConnection>("peer_connections").find(p => p.id === id); if (!peer) throw new PeerError("Peer mapping not found", 404); return peer; }
  private request(peer: PeerConnection, operation: PeerEnvelope["operation"], fields: Partial<PeerEnvelope> = {}): PeerEnvelope {
    return { version: 1, sourceDeviceId: this.device.id, targetDeviceId: peer.deviceId, grantId: peer.grantId, token: peer.grantToken, operation, requestId: randomUUID(), ...fields };
  }
  private async send(peer: PeerConnection, request: PeerEnvelope) {
    const response = await this.transport(peer, request);
    if (response.status >= 400) {
      const error = response.body as { error?: string };
      throw new PeerError(typeof error?.error === "string" ? error.error.slice(0, 240) : "Peer rejected this request.", response.status);
    }
    return response.body;
  }
  async catalog(peerId: string): Promise<CatalogSnapshot> {
    const peer = this.peer(uuid.parse(peerId));
    const snapshot = await this.send(peer, this.request(peer, "catalog")) as CatalogSnapshot;
    if (snapshot?.projectId !== peer.remoteProjectId || !Array.isArray(snapshot.harnesses)) throw new PeerError("Catalog does not match the saved remote project.", 502);
    return snapshot;
  }
  async test(input: unknown) {
    const { peerId } = z.object({ peerId: uuid }).strict().parse(input), peer = this.peer(peerId);
    try {
      const body = await this.send(peer, this.request(peer, "hello")) as { device?: Device; projectId?: string };
      if (body.device?.id !== peer.deviceId || body.projectId !== peer.remoteProjectId) throw new PeerError("Peer device identity does not match the saved mapping.", 409);
      const checkedAt = new Date().toISOString(); this.save("peer_connections", { ...peer, lastObservedAt: checkedAt, lastError: undefined });
      return { device: body.device, checkedAt };
    } catch (e) { this.save("peer_connections", { ...peer, lastError: e instanceof PeerError ? e.message : "Peer connection failed." }); throw e; }
  }
  async owner(input: unknown): Promise<Reply> {
    const request = envelope.parse(input);
    if (request.targetDeviceId !== this.device.id) throw new PeerError("Wrong owner device", 409);
    const grant = this.rows<{ id: string; sourceDeviceId: string; projectId: string; tokenHash: string; revoked: boolean }>("peer_grants").find(g => g.id === request.grantId);
    const supplied = hash(request.token);
    if (!grant || grant.revoked || grant.sourceDeviceId !== request.sourceDeviceId || !timingSafeEqual(Buffer.from(grant.tokenHash), Buffer.from(supplied))) throw new PeerError("Peer grant is missing, revoked or does not match.", 403);
    if (request.operation === "hello") return { status: 200, body: { version: 1, device: this.device, projectId: grant.projectId } };
    if (request.operation === "catalog") return this.call(`/api/projects/${grant.projectId}/catalog`, "POST");
    if (request.operation === "start") {
      if (!request.requestId || !request.baseCommit || !request.task) throw new PeerError("Provide a request ID, exact Git base and task.");
      const key = `peer:${request.sourceDeviceId}:${request.requestId}`;
      const prior = this.store.existing(grant.projectId, key);
      if (!prior) {
        const project = this.store.projects().find(p => p.id === grant.projectId);
        if (!project) throw new PeerError("Mapped project not found", 404);
        if (gitBase(project.path).baseCommit !== request.baseCommit) throw new PeerError("Mapped owner project HEAD differs from the explicit Git base. Synchronize it explicitly before launch.", 409);
      }
      return this.call("/api/tasks/start", "POST", { ...request.task, projectId: grant.projectId, idempotencyKey: key, workspace: "worktree", includeProjectContext: false, baseCommit: request.baseCommit });
    }
    const run = request.runId && this.store.run(request.runId);
    if (!run || run.projectId !== grant.projectId || !(this.store.db.prepare("SELECT key FROM runs WHERE id=?").get(run.id)?.key as string)?.startsWith(`peer:${request.sourceDeviceId}:`)) throw new PeerError("Run is outside this peer grant.", 403);
    return this.call(`/api/runs/${run.id}${request.operation === "cancel" ? "/stop" : ""}`, request.operation === "cancel" ? "POST" : "GET");
  }
  private saveDispatch(d: Dispatch) { this.store.db.prepare("INSERT INTO peer_dispatches(id,projectId,key,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(d.id, d.projectId, d.key, JSON.stringify(d)); }
  private publicDispatch({ request, digest, key, ...d }: Dispatch) { return d; }
  private dispatch(id: string) { const d = this.rows<Dispatch>("peer_dispatches").find(d => d.id === id); if (!d) throw new PeerError("Dispatch not found", 404); return d; }
  existing(projectId: string, key: string) { const prior = this.rows<Dispatch>("peer_dispatches").find(d => d.projectId === projectId && d.key === key); return prior && this.publicDispatch(prior); }
  historyRows(projectId: string, before: number, limit: number) {
    uuid.parse(projectId);
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(before);
    z.number().int().min(1).max(100).parse(limit);
    return this.store.db.prepare("SELECT rowid,data FROM peer_dispatches WHERE projectId=? AND rowid<? ORDER BY rowid DESC LIMIT ?")
      .all(projectId, before, limit + 1)
      .map(row => ({ rowid: Number(row.rowid), dispatch: this.publicDispatch(JSON.parse(row.data as string) as Dispatch) }));
  }
  list() { return this.rows<Dispatch>("peer_dispatches").map(d => this.publicDispatch(d)); }
  async start(input: unknown, launchHash?: string, displayPrompt?: string) {
    const data = peerDispatchSchema.parse(input), peer = this.peer(data.peerId);
    const digest = hash(data), prior = this.rows<Dispatch>("peer_dispatches").find(d => d.projectId === peer.projectId && d.key === data.idempotencyKey);
    if (prior && prior.digest !== digest && (!launchHash || prior.launchHash !== launchHash)) throw new PeerError("Dispatch key already used with different inputs.", 409);
    if (prior?.ownerRunId) return this.publicDispatch(prior);
    let d = prior;
    if (!d) {
      const project = this.store.projects().find(p => p.id === peer.projectId);
      if (!project || gitBase(project.path).baseCommit !== data.baseCommit) throw new PeerError("Local project HEAD differs from the explicit Git base.", 409);
      const id = randomUUID();
      d = { id, ...(launchHash ? { launchHash } : {}), prompt: (displayPrompt ?? data.task.prompt).slice(0, 300), createdAt: new Date().toISOString(), projectId: peer.projectId, peerId: peer.id, ownerDeviceId: peer.deviceId, key: data.idempotencyKey, digest, request: this.request(peer, "start", { requestId: id, baseCommit: data.baseCommit, task: data.task }), connection: "unknown" };
      this.saveDispatch(d);
    }
    return this.observe(d, d.request);
  }
  async status(id: string) {
    const d = this.dispatch(uuid.parse(id));
    return this.observe(d, d.ownerRunId ? this.request(this.peer(d.peerId), "status", { runId: d.ownerRunId }) : d.request);
  }
  async cancel(id: string) {
    const d = this.dispatch(uuid.parse(id));
    if (!d.ownerRunId) throw new PeerError("Owner acceptance is unknown. Query status before cancelling.", 409);
    return this.observe(d, this.request(this.peer(d.peerId), "cancel", { runId: d.ownerRunId }));
  }
  private async observe(d: Dispatch, request: PeerEnvelope) {
    try {
      const run = await this.send(this.peer(d.peerId), request) as Run;
      if (!run || !uuid.safeParse(run.id).success || run.projectId !== this.peer(d.peerId).remoteProjectId) throw new PeerError("Peer returned a run outside the saved project mapping.", 502);
      d = { ...this.dispatch(d.id), ownerRunId: run.id, lastKnownRun: run, lastObservedAt: new Date().toISOString(), connection: "observed", error: undefined };
    } catch (e) { d = { ...this.dispatch(d.id), connection: "unknown", error: e instanceof PeerError ? e.message : "Peer connection failed. Owner status is unknown." }; }
    this.saveDispatch(d); return this.publicDispatch(d);
  }
}
