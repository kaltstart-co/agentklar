import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.ts";
import type { LaunchSource } from "./contracts.ts";

export const workReportSchema = z.object({
  projectId: z.uuid(), activityId: z.uuid(), reportId: z.uuid(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  title: z.string().trim().min(1).max(200),
  state: z.enum(["working", "blocked", "finished", "cancelled"]),
  summary: z.string().max(4000), result: z.string().max(8000).default(""),
}).strict();
type Input = z.infer<typeof workReportSchema>;
export type Activity = Input & { revision: number; source: Extract<LaunchSource, {kind: "mcp"}>; createdAt: string; updatedAt: string };
export class ActivityError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Reports are shared task notes, never execution, permission or usage evidence. */
export class Activities {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS harness_activity(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_activity_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  list(projectId?: string): Activity[] {
    const rows = projectId
      ? this.store.db.prepare("SELECT data FROM harness_activity WHERE projectId=? ORDER BY rowid DESC LIMIT 100").all(projectId)
      : this.store.db.prepare("SELECT data FROM harness_activity ORDER BY rowid DESC LIMIT 100").all();
    return rows.map(row => JSON.parse(row.data as string));
  }
  report(input: Input, source: LaunchSource | undefined): Activity {
    if (source?.kind !== "mcp") throw new ActivityError("A connected harness must identify this report.", 400);
    if (!this.store.projects().some(p => p.id === input.projectId)) throw new ActivityError("Project not found.", 404);
    const digest = createHash("sha256").update(JSON.stringify({ input, clientName: source.clientName })).digest("hex");
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = db.prepare("SELECT digest,data FROM harness_activity_receipts WHERE id=?").get(input.reportId);
      if (receipt) {
        if (receipt.digest !== digest) throw new ActivityError("Report ID already has different inputs.", 409);
        db.exec("COMMIT");
        return JSON.parse(receipt.data as string);
      }
      const row = db.prepare("SELECT data FROM harness_activity WHERE id=?").get(input.activityId);
      const previous: Activity | undefined = row ? JSON.parse(row.data as string) : undefined;
      if (previous && (previous.projectId !== input.projectId || previous.source.clientName !== source.clientName))
        throw new ActivityError("This report belongs to another project or harness.", 403);
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw new ActivityError("Work report changed. Read its current revision before updating.", 409);
      const now = new Date().toISOString();
      const activity: Activity = { ...input, revision: input.expectedRevision + 1,
        source: previous?.source ?? source, createdAt: previous?.createdAt ?? now, updatedAt: now };
      db.prepare("INSERT INTO harness_activity VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(input.activityId, input.projectId, JSON.stringify(activity));
      db.prepare("INSERT INTO harness_activity_receipts VALUES(?,?,?)")
        .run(input.reportId, digest, JSON.stringify(activity));
      db.exec("COMMIT");
      return activity;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
