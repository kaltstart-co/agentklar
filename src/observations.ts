import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.ts";
import type { Project } from "./contracts.ts";
import { projectRootIdentity } from "./project-root.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const observationEvents = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "StopFailure", "SessionEnd"] as const;
export const observationSchema = z.object({
  eventId: z.uuid(), session: z.string().regex(/^[a-f0-9]{64}$/),
  cwd: z.string().min(1).max(4096), event: z.enum(observationEvents),
  observedAt: z.iso.datetime(),
}).strict();
export type ObservedSession = {
  id: string; projectId: string; harness: "claude";
  state: "idle" | "working" | "needs_attention" | "ended";
  event: typeof observationEvents[number]; createdAt: string; observedAt: string;
};
type Grant = { projectId: string; ownerId: string; root: string; tokenHash: string; enabled: boolean };

/** Native lifecycle evidence only. Silence and Stop never mean a task succeeded. */
export class NativeObservations {
  constructor(private store: Pick<Store, "db" | "projects">, private now = () => Date.now()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS native_observation_grants(projectId TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_observed_sessions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_observation_receipts(id TEXT PRIMARY KEY,receivedAt INTEGER NOT NULL);`);
  }
  enable(project: Project, token: string, ownerId: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid observation capability.");
    const grant: Grant = { projectId: project.id, ownerId, root: projectRootIdentity(project.path), tokenHash: hash(token), enabled: true };
    this.store.db.prepare("INSERT INTO native_observation_grants VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET data=excluded.data")
      .run(project.id, JSON.stringify(grant));
  }
  disable(projectId: string, ownerId?: string) {
    const grant = this.grant(projectId);
    if (!grant || (ownerId && grant.ownerId !== ownerId)) return;
    grant.enabled = false;
    this.store.db.prepare("UPDATE native_observation_grants SET data=? WHERE projectId=?").run(JSON.stringify(grant), projectId);
  }
  private grant(projectId: string): Grant | undefined {
    const row = this.store.db.prepare("SELECT data FROM native_observation_grants WHERE projectId=?").get(projectId);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  status(projectId: string) { return { enabled: this.grant(projectId)?.enabled === true, harness: "claude" }; }
  accept(projectId: string, token: string, input: z.infer<typeof observationSchema>): boolean {
    const grant = this.grant(projectId), project = this.store.projects().find(p => p.id === projectId);
    if (!grant?.enabled || !project || !timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(grant.tokenHash, "hex")) || input.cwd !== project.path) return false;
    try { if (projectRootIdentity(project.path) !== grant.root) return false; } catch { return false; }
    const date = Date.parse(input.observedAt), now = this.now();
    if (date > now + 5000 || date < now - 300000) return false;
    // Scope session IDs to the grant. Reinstalling cannot join another installation's records.
    const id = hash(`${projectId}:${grant.ownerId}:${input.session}`), receiptId = hash(`${projectId}:${grant.ownerId}:${input.eventId}`), db = this.store.db;
    if (db.prepare("SELECT id FROM native_observation_receipts WHERE id=?").get(receiptId)) return true;
    const row = db.prepare("SELECT data FROM native_observed_sessions WHERE id=?").get(id);
    const previous: ObservedSession | undefined = row ? JSON.parse(row.data as string) : undefined;
    const state = { SessionStart: "idle", UserPromptSubmit: "working", Notification: "needs_attention", Stop: "idle", StopFailure: "needs_attention", SessionEnd: "ended" } as const;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO native_observation_receipts VALUES(?,?)").run(receiptId, now);
      if (!previous || date >= Date.parse(previous.observedAt)) {
        const session: ObservedSession = { id, projectId, harness: "claude", state: state[input.event], event: input.event,
          createdAt: previous?.createdAt ?? input.observedAt, observedAt: input.observedAt };
        db.prepare("INSERT INTO native_observed_sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
          .run(id, projectId, JSON.stringify(session));
      }
      db.prepare("DELETE FROM native_observation_receipts WHERE receivedAt<?").run(now - 600000);
      db.prepare("DELETE FROM native_observed_sessions WHERE projectId=? AND id NOT IN (SELECT id FROM native_observed_sessions WHERE projectId=? ORDER BY json_extract(data,'$.observedAt') DESC,rowid DESC LIMIT 100)").run(projectId, projectId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return true;
  }
  list(projectId?: string) {
    const rows = projectId
      ? this.store.db.prepare("SELECT data FROM native_observed_sessions WHERE projectId=? ORDER BY json_extract(data,'$.observedAt') DESC,rowid DESC LIMIT 100").all(projectId)
      : this.store.db.prepare("SELECT data FROM native_observed_sessions ORDER BY json_extract(data,'$.observedAt') DESC,rowid DESC LIMIT 100").all();
    return rows.map(row => {
      const session: ObservedSession = JSON.parse(row.data as string);
      return { ...session, recent: this.now() - Date.parse(session.observedAt) <= 300000, trackingEnabled: this.status(session.projectId).enabled };
    });
  }
}

// Bundled in the reviewed Claude plugin. Redacts input before making a local request.
// It never reads the transcript, sends prompt text, prints output, or returns a permission decision.
export const observationHookScript = `const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
let size=0,chunks=[];
process.stdin.on('data',chunk=>{size+=chunk.length;if(size<=1048576)chunks.push(chunk);else chunks=[];});
process.stdin.on('end',async()=>{try{
 if(size>1048576)return;
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));chunks=[];
 if(input.agent_id || !['SessionStart','UserPromptSubmit','Notification','Stop','StopFailure','SessionEnd'].includes(input.hook_event_name))return;
 if(input.hook_event_name==='Notification' && input.notification_type!=='permission_prompt')return;
 if(typeof input.session_id!=='string'||input.session_id.length>256||typeof input.cwd!=='string')return;
 const cfg=JSON.parse(readFileSync(join(__dirname,'observation.json'),'utf8'));
 if(input.cwd!==cfg.cwd)return;
 const body={eventId:randomUUID(),session:createHash('sha256').update(input.session_id).digest('hex'),cwd:input.cwd,event:input.hook_event_name,observedAt:new Date().toISOString()};
 await fetch(cfg.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.token},body:JSON.stringify(body),signal:AbortSignal.timeout(1000)});
}catch{}});
process.stdin.on('error',()=>{});
`;
