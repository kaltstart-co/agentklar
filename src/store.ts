import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type {
  Project,
  ProjectContext,
  Run,
  RunEvent,
  Approval,
} from "./contracts.ts";
export class Store {
  db: DatabaseSync;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    this.db = new DatabaseSync(join(home, "state.sqlite"));
    chmodSync(join(home, "state.sqlite"), 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(projectId,key)); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,runId TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,textTruncated INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,runId TEXT NOT NULL,data TEXT NOT NULL);`,
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS project_context(projectId TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL)",
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(events)")
        .all()
        .some((r) => r.name === "textTruncated")
    )
      this.db.exec(
        "ALTER TABLE events ADD COLUMN textTruncated INTEGER NOT NULL DEFAULT 0",
      );
    for (const r of this.runs())
      if (["running", "needs_attention"].includes(r.state))
        this.saveRun({
          ...r,
          state: "interrupted",
          error: "Local service restarted. This worker was not recovered.",
          updatedAt: new Date().toISOString(),
        });
    this.db.exec("DELETE FROM approvals");
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT data FROM projects ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  saveProject(p: Project) {
    this.db
      .prepare(
        "INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(p.id, p.path, JSON.stringify(p));
  }
  context(projectId: string): ProjectContext {
    const row = this.db
      .prepare("SELECT data FROM project_context WHERE projectId=?")
      .get(projectId);
    return row
      ? JSON.parse(row.data as string)
      : {
          projectId,
          revision: 0,
          brief: "",
          memory: "",
          handoff: "",
          updatedAt: null,
          updatedVia: null,
        };
  }
  saveContext(context: ProjectContext, expectedRevision: number): boolean {
    // One SQLite statement checks the revision and saves, including the first write.
    return (
      this.db
        .prepare(
          `INSERT INTO project_context(projectId,revision,data)
      SELECT ?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM project_context WHERE projectId=?)
      ON CONFLICT(projectId) DO UPDATE SET revision=excluded.revision,data=excluded.data
      WHERE project_context.revision=?`,
        )
        .run(
          context.projectId,
          context.revision,
          JSON.stringify(context),
          expectedRevision,
          context.projectId,
          expectedRevision,
        ).changes === 1
    );
  }
  runs(): Run[] {
    return this.db
      .prepare("SELECT data FROM runs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  run(id: string): Run | undefined {
    const r = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
    return r ? JSON.parse(r.data as string) : undefined;
  }
  existing(projectId: string, key: string): Run | undefined {
    const r = this.db
      .prepare("SELECT data FROM runs WHERE projectId=? AND key=?")
      .get(projectId, key);
    return r ? JSON.parse(r.data as string) : undefined;
  }
  insertRun(r: Run, key: string) {
    this.db
      .prepare("INSERT INTO runs VALUES(?,?,?,?)")
      .run(r.id, r.projectId, key, JSON.stringify(r));
  }
  saveRun(r: Run) {
    this.db
      .prepare("UPDATE runs SET data=? WHERE id=?")
      .run(JSON.stringify(r), r.id);
  }
  event(runId: string, kind: string, text: string) {
    this.db
      .prepare(
        "INSERT INTO events(runId,kind,text,createdAt,textTruncated) VALUES(?,?,?,?,?)",
      )
      .run(
        runId,
        kind,
        text.slice(0, 16000),
        new Date().toISOString(),
        text.length > 16000 ? 1 : 0,
      );
  }
  events(runId: string, after = 0): RunEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE runId=? AND id>? ORDER BY id LIMIT 200",
      )
      .all(runId, after)
      .reduce((acc, row) => {
        const e = row as unknown as RunEvent;
        const used = acc.reduce((n, v) => n + v.text.length, 0);
        if (used < 24000)
          acc.push({
            ...e,
            text: e.text.slice(0, 24000 - used),
            textTruncated: !!e.textTruncated || e.text.length > 24000 - used,
          });
        return acc;
      }, [] as RunEvent[]);
  }
  approvals(): Approval[] {
    return this.db
      .prepare("SELECT data FROM approvals ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  saveApproval(a: Approval) {
    this.db
      .prepare("INSERT INTO approvals VALUES(?,?,?)")
      .run(a.id, a.runId, JSON.stringify(a));
  }
  clearApprovals(runId: string) {
    this.db.prepare("DELETE FROM approvals WHERE runId=?").run(runId);
  }
  close() {
    this.db.close();
  }
}
