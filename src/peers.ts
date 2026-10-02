import { workerHarnesses, type WorkerHarness } from "./contracts.ts";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { toolCapabilities } from "./capabilities.ts";
import type { Run, CatalogSnapshot, RoutingDecision } from "./contracts.ts";
import type { RecommendationSource } from "./recommend.ts";
import type { Store } from "./store.ts";
import { changePacketSchema, type ChangePacket } from "./changes.ts";
import { gitBase } from "./workspace.ts";
import { z } from "zod";
import {humanEnvelopeSchema,humanAnswerSchema,type HumanEnvelope,type HumanCall,type HumanGrant,type HumanConfiguration} from "./peer-human.ts";

const uuid = z.uuid();
const nodePath = z.string().startsWith("/").max(1000).refine(value => !/[\0\r\n]/.test(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const routingEvidenceSchema = z.object({
  selected:z.object({harness:z.enum(workerHarnesses),model:z.string().min(1).max(120),roleId:z.string().max(80).optional(),basis:z.enum(["task-pin","role-pin","policy"]),tier:z.enum(["efficient","balanced","capable","unknown"]),device:z.object({id:uuid,label:z.string().max(120),peerId:uuid.optional()}).strict().optional(),catalogCheckedAt:z.string().datetime().optional(),benchmark:z.object({provider:z.literal("LiveBench"),metric:z.string().max(120),score:z.number().finite(),release:z.string().max(120),checkedAt:z.string().datetime(),measuredEffort:z.literal("max"),sourceRow:z.string().max(200),sourceUrl:z.string().max(500),contentHash:z.string().max(128),referenceOnly:z.literal(true)}).strict().optional()}).strict(),
  preference:z.enum(["economical","balanced","best"]),complexity:z.enum(["routine","standard","hard"]),requiresImages:z.boolean(),requiresTools:z.array(z.enum(toolCapabilities)).max(2).optional(),catalogCheckedAt:z.string().datetime(),policyVersion:z.string().max(80),reasons:z.array(z.string().max(1000)).max(12),warnings:z.array(z.string().max(1000)).max(12),taskType:z.enum(["coding","reasoning","data-analysis","language"]).optional(),benchmarkMethod:z.enum(["reference-tie-break","policy-fallback","pin"]).optional()
}).strict();
const task = z.object({ routingEvidence:routingEvidenceSchema.optional(), prompt: z.string().trim().min(1).max(32000), harness: z.enum(workerHarnesses).optional(), model: z.string().min(1).max(120).optional(), readOnly: z.boolean().default(false), followUp: z.object({ runId: uuid, kind: z.enum(["review", "fix"]) }).strict().optional(), includeProjectContext: z.literal(false).optional(), routing: z.object({ complexity: z.enum(["routine", "standard", "hard"]).default("standard"), requiresImages: z.boolean().default(false), requiresTools: z.array(z.enum(toolCapabilities)).max(2).optional(), taskType: z.enum(["coding", "reasoning", "data-analysis", "language"]).default("coding") }).strict().optional() }).strict();
const base = z.string().regex(/^[0-9a-f]{40,64}$/);
export const peerSaveSchema = z.object({ label: z.string().trim().min(1).max(120), deviceId: uuid, sshHost: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,199}$/), command: z.string().regex(/^(?:agentklar|\/[a-zA-Z0-9_./ -]{1,500})$/), nodePath: nodePath.optional(), projectId: uuid, remoteProjectId: uuid, grantId: uuid, grantToken: z.string().regex(/^[0-9a-f]{64}$/) }).strict().refine(value => !value.nodePath || value.command.startsWith("/"), "A pinned Node executable requires an absolute AgentKlar script path.");
export const peerDispatchSchema = z.object({ peerId: uuid, idempotencyKey: z.string().min(1).max(200), baseCommit: base, task }).strict();
const envelope = z.object({ version: z.literal(1), sourceDeviceId: uuid, targetDeviceId: uuid, grantId: uuid, token: z.string().regex(/^[0-9a-f]{64}$/), operation: z.enum(["hello", "catalog", "start", "status", "cancel", "changes", "context", "routing"]), requestId: uuid.optional(), runId: uuid.optional(), baseCommit: base.optional(), task: task.optional() }).strict();
export type PeerEnvelope = z.infer<typeof envelope>;
export type PeerConnection = z.infer<typeof peerSaveSchema> & { id: string; lastObservedAt?: string; lastError?: string };
type Device = { id: string; label: string; platform: string };
type Reply = { status: number; body: unknown };
export type PeerTransport = (peer: PeerConnection, request: PeerEnvelope | HumanEnvelope) => Promise<Reply>;
export type HumanAction = {id:string;dispatchId:string;ownerRunId:string;approvalId:string;requestId:string;expectedDigest:string;decision:string;state:"pending"|"acknowledged"|"rejected";createdAt:string;receipt?:unknown;error?:string;review?:{digest:string;decisions:string[];readAt:string};rejectedHistory?:{requestId:string;expectedDigest:string;decision:string;error?:string;recordedAt:string}[]};
type Dispatch = { id: string; launchHash?: string; prompt: string; createdAt: string; projectId: string; peerId: string; ownerDeviceId: string; key: string; digest: string; request: PeerEnvelope; ownerRunId?: string; lastObservedAt?: string; lastKnownRun?: Run; connection: "unknown" | "observed"; error?: string };
export type RemoteDispatch = Omit<Dispatch, "request" | "digest" | "key"> & {routing?:RoutingDecision};
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
    if (Buffer.byteLength(output) > (request.operation === "changes" ? 768_000 : 128_000)) return finish(new PeerError("Peer reply exceeded the allowed size.", 502));
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
  constructor(private store: Store, private device: Device, private call: (path: string, method?: string, body?: unknown) => Promise<Reply>, private transport: PeerTransport = sshPeerTransport, private humanCall?:HumanCall) {
    store.db.exec("CREATE TABLE IF NOT EXISTS peer_grants(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_connections(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_dispatches(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(projectId,key));");
    store.db.exec("CREATE TABLE IF NOT EXISTS peer_human_grants(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_human_configurations(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_request_origins(key TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_run_origins(runId TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peer_human_actions(id TEXT PRIMARY KEY,data TEXT NOT NULL);");
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
  async routing(peerId: string, baseCommit: string): Promise<RecommendationSource> {
    const peer = this.peer(uuid.parse(peerId));
    const body = await this.send(peer, this.request(peer, "routing", {baseCommit: base.parse(baseCommit)})) as {deviceId: string; projectId: string; baseCommit: string; catalog: CatalogSnapshot; installed: RecommendationSource["installed"]};
    if (body?.deviceId !== peer.deviceId || body.projectId !== peer.remoteProjectId || body.baseCommit !== baseCommit || body.catalog?.projectId !== peer.remoteProjectId || !Array.isArray(body.catalog.harnesses)) throw new PeerError("Routing metadata does not match the saved device, project and Git base.", 409);
    const checked = Date.parse(body.catalog.checkedAt), now = Date.now();
    if (!Number.isFinite(checked) || checked > now || now - checked > 5 * 60_000) throw new PeerError("Remote catalog is stale; refresh its native model evidence.", 409);
    const installed = z.object({codex:z.boolean(),claude:z.boolean(),muse:z.boolean().optional(),opencode:z.boolean().optional(),gemini:z.boolean().optional(),"cursor-agent":z.boolean().optional(),zcode:z.boolean().optional()}).strict().parse(body.installed);
    return {catalog:body.catalog, installed, device:{id:peer.deviceId,label:peer.label,peerId:peer.id}};
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
    if (request.operation === "routing") {
      if (!request.baseCommit || request.task || request.runId) throw new PeerError("Routing needs an exact Git base and no task or run payload.");
      const project = this.store.projects().find(p => p.id === grant.projectId);
      if (!project || gitBase(project.path).baseCommit !== request.baseCommit) throw new PeerError("Mapped owner project HEAD differs from the explicit Git base.", 409);
      return this.call(`/api/projects/${grant.projectId}/routing-metadata`);
    }
    if (request.operation === "start") {
      if (!request.requestId || !request.baseCommit || !request.task) throw new PeerError("Provide a request ID, exact Git base and task.");
      const key = `peer:${request.sourceDeviceId}:${request.requestId}`;
      const prior = this.store.existing(grant.projectId, key);
      if (request.task.followUp) {
        const parent = this.store.run(request.task.followUp.runId);
        if (!parent || parent.projectId !== grant.projectId || !(this.store.db.prepare("SELECT key FROM runs WHERE id=?").get(parent.id)?.key as string)?.startsWith(`peer:${request.sourceDeviceId}:`)) throw new PeerError("Follow-up source is outside this peer grant.", 403);
      }
      if (!prior && !request.task.followUp) {
        const project = this.store.projects().find(p => p.id === grant.projectId);
        if (!project) throw new PeerError("Mapped project not found", 404);
        if (gitBase(project.path).baseCommit !== request.baseCommit) throw new PeerError("Mapped owner project HEAD differs from the explicit Git base. Synchronize it explicitly before launch.", 409);
      }
      const recorded = this.store.db.prepare("SELECT data FROM peer_request_origins WHERE key=?").get(key);
      const origin = {grantId:grant.id,sourceDeviceId:request.sourceDeviceId,projectId:grant.projectId};
      if (recorded && JSON.stringify(JSON.parse(recorded.data as string)) !== JSON.stringify(origin)) throw new PeerError("This request belongs to another parent grant.",403);
      if (!prior && !recorded) this.store.db.prepare("INSERT OR IGNORE INTO peer_request_origins(key,data) VALUES(?,?)").run(key,JSON.stringify(origin));
      const reply = await this.call("/api/tasks/start", "POST", { ...request.task, projectId: grant.projectId, idempotencyKey: key, ...(request.task.followUp ? {} : { workspace: "worktree", baseCommit: request.baseCommit }), includeProjectContext: false });
      const accepted = reply.body as {id?:string;projectId?:string};
      if (reply.status < 400 && accepted?.id && accepted.projectId === grant.projectId && this.store.db.prepare("SELECT data FROM peer_request_origins WHERE key=?").get(key)) this.store.db.prepare("INSERT OR IGNORE INTO peer_run_origins(runId,data) VALUES(?,?)").run(accepted.id,JSON.stringify(origin));
      return reply;
    }
    const run = request.runId && this.store.run(request.runId);
    if (!run || run.projectId !== grant.projectId || !(this.store.db.prepare("SELECT key FROM runs WHERE id=?").get(run.id)?.key as string)?.startsWith(`peer:${request.sourceDeviceId}:`)) throw new PeerError("Run is outside this peer grant.", 403);
    if (request.operation === "context") return this.call(`/api/runs/${run.id}/context`);
    if (request.operation === "changes") {
      const reply = await this.call(`/api/runs/${run.id}/changes?includePatch=true&compact=false`);
      return reply.status >= 400 ? reply : { status: reply.status, body: changePacketSchema.strip().parse(reply.body) };
    }
    return this.call(`/api/runs/${run.id}${request.operation === "cancel" ? "/stop" : ""}`, request.operation === "cancel" ? "POST" : "GET");
  }
  humanSettings() {
    return {grants:this.rows<HumanGrant>("peer_human_grants").map(({tokenHash,...grant})=>grant),actionIntents:this.rows<HumanAction>("peer_human_actions").sort((a,b)=>Number(b.state==="pending")-Number(a.state==="pending") || b.createdAt.localeCompare(a.createdAt)).slice(0,100),connections:this.rows<HumanConfiguration>("peer_human_configurations").map(c=>({peerId:c.id,humanGrantId:c.humanGrantId,configured:true as const}))};
  }
  humanGrant(input:unknown) {
    const {grantId}=z.object({grantId:uuid}).strict().parse(input);
    const parent=this.rows<{id:string;sourceDeviceId:string;projectId:string;revoked:boolean}>("peer_grants").find(g=>g.id===grantId && !g.revoked);
    if(!parent) throw new PeerError("A live parent peer grant is required.",403);
    const token=randomBytes(32).toString("hex"),grant:HumanGrant={id:randomUUID(),grantId,sourceDeviceId:parent.sourceDeviceId,ownerDeviceId:this.device.id,projectId:parent.projectId,tokenHash:hash(token),revoked:false};
    this.save("peer_human_grants",grant);
    const {tokenHash,revoked,...publicGrant}=grant;
    return {...publicGrant,token};
  }
  humanRevoke(input:unknown) {
    const {humanGrantId}=z.object({humanGrantId:uuid}).strict().parse(input);
    const grant=this.rows<HumanGrant>("peer_human_grants").find(g=>g.id===humanGrantId);
    if(!grant) throw new PeerError("Human grant not found.",404);
    this.save("peer_human_grants",{...grant,revoked:true});return {ok:true};
  }
  humanSave(input:unknown) {
    const data=z.object({peerId:uuid,humanGrantId:uuid,token:z.string().regex(/^[0-9a-f]{64}$/)}).strict().parse(input),peer=this.peer(data.peerId);
    this.save("peer_human_configurations",{id:peer.id,humanGrantId:data.humanGrantId,token:data.token,grantId:peer.grantId,deviceId:peer.deviceId,remoteProjectId:peer.remoteProjectId});
    return {peerId:peer.id,humanGrantId:data.humanGrantId,configured:true};
  }
  humanRemove(input:unknown) {const {peerId}=z.object({peerId:uuid}).strict().parse(input);this.store.db.prepare("DELETE FROM peer_human_configurations WHERE id=?").run(peerId);return {ok:true};}
  async humanOwner(input:unknown):Promise<Reply> {
    const request=humanEnvelopeSchema.parse(input);
    const grant=this.rows<HumanGrant>("peer_human_grants").find(g=>g.id===request.humanGrantId);
    if(!grant || grant.revoked || request.targetDeviceId!==this.device.id || grant.ownerDeviceId!==this.device.id || grant.sourceDeviceId!==request.sourceDeviceId || !timingSafeEqual(Buffer.from(grant.tokenHash),Buffer.from(hash(request.token)))) throw new PeerError("Human capability is missing, revoked or does not match.",403);
    const parent=this.rows<{id:string;sourceDeviceId:string;projectId:string;revoked:boolean}>("peer_grants").find(g=>g.id===grant.grantId);
    if(!parent || parent.revoked || parent.sourceDeviceId!==grant.sourceDeviceId || parent.projectId!==grant.projectId) throw new PeerError("Parent peer grant is revoked or does not match.",403);
    const run=this.store.run(request.runId),saved=this.store.db.prepare("SELECT data FROM peer_run_origins WHERE runId=?").get(request.runId);
    const origin=saved && JSON.parse(saved.data as string) as {grantId:string;sourceDeviceId:string;projectId:string}|undefined;
    if(!run || run.projectId!==grant.projectId || !origin || origin.grantId!==grant.grantId || origin.sourceDeviceId!==grant.sourceDeviceId || origin.projectId!==grant.projectId) throw new PeerError("This run has no exact origin for this human capability. Use the owner UI.",403);
    if(!this.humanCall) throw new PeerError("Owner human approval channel is unavailable.",503);
    if(request.operation==="list") {if(request.approvalId || request.expectedDigest || request.decision) throw new PeerError("List does not accept approval or decision fields.");return this.humanCall(run.id,"list",{});}
    if(request.operation==="read") {if(!request.approvalId || request.expectedDigest || request.decision) throw new PeerError("Read requires only an exact approval ID.");return this.humanCall(run.id,"read",{approvalId:request.approvalId});}
    const answer=humanAnswerSchema.parse({approvalId:request.approvalId,requestId:request.requestId,expectedDigest:request.expectedDigest,decision:request.decision});
    return this.humanCall(run.id,"answer",answer);
  }
  private humanConfiguration(peer:PeerConnection) {
    const config=this.rows<HumanConfiguration>("peer_human_configurations").find(c=>c.id===peer.id);
    if(!config || config.grantId!==peer.grantId || config.deviceId!==peer.deviceId || config.remoteProjectId!==peer.remoteProjectId) throw new PeerError("Import a separate owner-issued human capability for this mapping.",403);
    return config;
  }
  private async humanRequest(dispatchId:string,operation:HumanEnvelope["operation"],fields:Partial<HumanEnvelope>={}) {
    const dispatch=this.dispatch(uuid.parse(dispatchId));
    if(!dispatch.ownerRunId) throw new PeerError("Owner run is unknown. Query its status before requesting approvals.",409);
    const peer=this.peer(dispatch.peerId),config=this.humanConfiguration(peer);
    const request=humanEnvelopeSchema.parse({version:1,channel:"human",sourceDeviceId:this.device.id,targetDeviceId:peer.deviceId,humanGrantId:config.humanGrantId,token:config.token,operation,runId:dispatch.ownerRunId,requestId:randomUUID(),...fields});
    const reply=await this.transport(peer,request);
    if(reply.status>=400) throw new PeerError(typeof (reply.body as {error?:string})?.error === "string" ? (reply.body as {error:string}).error.slice(0,240) : "Owner rejected this human request.",reply.status);
    return reply.body;
  }
  humanList(dispatchId:string) {return this.humanRequest(dispatchId,"list");}
  async humanRead(dispatchId:string,approvalId:string) {
    const body=await this.humanRequest(dispatchId,"read",{approvalId:z.string().min(1).max(200).parse(approvalId)}) as Record<string,unknown>;
    let actionIntent=this.rows<HumanAction>("peer_human_actions").find(a=>a.dispatchId===dispatchId && a.approvalId===approvalId);
    if(actionIntent?.state==="rejected") {actionIntent={...actionIntent,review:undefined};this.save("peer_human_actions",actionIntent);}
    const approval=body.approval as {id?:string;runId?:string;decisions?:unknown}|null;
    if(actionIntent?.state==="rejected" && approval?.id===approvalId && approval.runId===actionIntent.ownerRunId && typeof body.digest==="string" && /^[0-9a-f]{64}$/.test(body.digest) && Array.isArray(approval.decisions) && approval.decisions.length<=50 && approval.decisions.every(d=>typeof d==="string" && d.length<=200)) {
      actionIntent={...actionIntent,review:{digest:body.digest,decisions:approval.decisions,readAt:new Date().toISOString()}};
      this.save("peer_human_actions",actionIntent);
    }
    return {...body,...(actionIntent ? {actionIntent} : {})};
  }
  async humanAnswer(dispatchId:string,input:unknown) {
    const answer=humanAnswerSchema.parse(input),dispatch=this.dispatch(uuid.parse(dispatchId));
    if(!dispatch.ownerRunId) throw new PeerError("Owner run is unknown.",409);
    this.humanConfiguration(this.peer(dispatch.peerId));
    const actions=this.rows<HumanAction>("peer_human_actions"),id=`${dispatch.id}:${answer.approvalId}`,saved=actions.find(a=>a.id===id),prior=saved?.state==="rejected" ? undefined : saved;
    if(saved?.state==="rejected" && (!saved.review || saved.review.digest!==answer.expectedDigest || !saved.review.decisions.includes(answer.decision) || saved.requestId===answer.requestId)) throw new PeerError("Read the complete current owner approval again before submitting a new reviewed action.",409);
    if(!prior && actions.filter(a=>a.state==="pending").length>=100) throw new PeerError("Resolve saved pending human actions before creating more.",409);
    if(prior && (prior.requestId!==answer.requestId || prior.expectedDigest!==answer.expectedDigest || prior.decision!==answer.decision || prior.ownerRunId!==dispatch.ownerRunId)) throw new PeerError("This approval already has a saved action. Retry its same request ID, digest and decision.",409);
    const action:HumanAction=prior || {id,dispatchId:dispatch.id,ownerRunId:dispatch.ownerRunId,...answer,state:"pending",createdAt:new Date().toISOString(),...(saved?.state==="rejected" ? {rejectedHistory:[...(saved.rejectedHistory || []),{requestId:saved.requestId,expectedDigest:saved.expectedDigest,decision:saved.decision,error:saved.error,recordedAt:new Date().toISOString()}].slice(-10)} : {})};
    this.save("peer_human_actions",action);
    try {
      const receipt=await this.humanRequest(dispatch.id,"answer",answer);
      const latest=this.rows<HumanAction>("peer_human_actions").find(a=>a.id===id);
      if(latest?.requestId===answer.requestId) this.save("peer_human_actions",{...latest,state:"acknowledged",receipt});
      return receipt;
    } catch(error) {
      const latest=this.rows<HumanAction>("peer_human_actions").find(a=>a.id===id);
      if(latest?.requestId===answer.requestId && latest.state==="pending" && error instanceof PeerError && [400,401,403,404,409,413].includes(error.status)) this.save("peer_human_actions",{...latest,state:"rejected",error:error.message});
      throw error;
    }
  }
  private saveDispatch(d: Dispatch) { this.store.db.prepare("INSERT INTO peer_dispatches(id,projectId,key,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(d.id, d.projectId, d.key, JSON.stringify(d)); }
  private publicDispatch({ request, digest, key, ...d }: Dispatch) { return {...d,...(request.task?.routingEvidence ? {routing: request.task?.routingEvidence as RoutingDecision} : {})}; }
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
      if (!project || (!data.task.followUp && gitBase(project.path).baseCommit !== data.baseCommit)) throw new PeerError("Local project HEAD differs from the explicit Git base.", 409);
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
  async followUpSource(projectId: string, dispatchId: string) {
    let dispatch = this.dispatch(uuid.parse(dispatchId));
    if (dispatch.projectId !== projectId) throw new PeerError("Follow-up dispatch belongs to another project.", 403);
    const observed = await this.status(dispatch.id);
    if (observed.connection !== "observed" || !observed.ownerRunId) throw new PeerError("Owner status is unavailable. Reconnect before starting linked work.", 503);
    dispatch = this.dispatch(dispatch.id);
    return { dispatch: this.publicDispatch(dispatch), mapping: this.resolveMapping(projectId, dispatch.peerId), baseCommit: dispatch.request.baseCommit! };
  }
  async context(dispatchId: string) {
    const dispatch = this.dispatch(uuid.parse(dispatchId));
    if (!dispatch.ownerRunId) throw new PeerError("Owner run is unknown. Query status before reading its context.", 409);
    const peer = this.peer(dispatch.peerId);
    return this.send(peer, this.request(peer, "context", { runId: dispatch.ownerRunId }));
  }
  async changes(dispatchId: string): Promise<ChangePacket> {
    const dispatch = this.dispatch(uuid.parse(dispatchId));
    if (!dispatch.ownerRunId) throw new PeerError("Owner run is unknown. Query status before preparing changes.", 409);
    const peer = this.peer(dispatch.peerId);
    const packet = changePacketSchema.parse(await this.send(peer, this.request(peer, "changes", { runId: dispatch.ownerRunId })));
    if (packet.sourceRunId !== dispatch.ownerRunId || packet.sourceProjectId !== peer.remoteProjectId || packet.sourceDeviceId !== peer.deviceId || packet.baseCommit !== dispatch.request.baseCommit) throw new PeerError("Changes do not match the saved source run, device, project or Git base.", 409);
    return packet;
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
