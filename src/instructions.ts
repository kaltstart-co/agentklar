import { createHash, randomUUID } from "node:crypto";
import {
  constants, openSync, closeSync, lstatSync, fstatSync, readSync,
  writeFileSync, fsyncSync, fchmodSync, renameSync, unlinkSync, realpathSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  Project, InstructionFileId, InstructionDocument, InstructionPreview,
  InstructionChange, InstructionSnapshot,
} from "./contracts.ts";

export const instructionNames = { agents: "AGENTS.md", claude: "CLAUDE.md" } as const;
const maxBytes = 32768;
export const instructionFileSchema = z.enum(["agents", "claude"]);
export const instructionPreviewSchema = z.object({
  file: instructionFileSchema,
  text: z.string().max(maxBytes),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export class InstructionError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 422 = 422) { super(message); }
}
type ReadFile = InstructionDocument & { mode: number | null };
type SavedPreview = InstructionPreview & { mode: number | null; root: string; expires: number };
type SavedChange = InstructionChange & { beforeText: string | null; afterText: string; mode: number | null; afterMode: number; root: string };
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function validText(text: string) {
  const data = Buffer.from(text, "utf8");
  if (data.length > maxBytes) throw new InstructionError("Instruction text must fit 32 KiB of UTF-8.", 400);
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data) !== text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new InstructionError("Instruction files must contain valid UTF-8 text, without binary control bytes.", 400);
  return data;
}
function rootIdentity(project: Project) {
  try {
    const st = lstatSync(project.path);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(project.path) !== project.path) throw new Error();
    return `${st.dev}:${st.ino}`;
  } catch { throw new InstructionError("Project folder is unavailable or has changed. Register its real folder again."); }
}
function read(project: Project, file: InstructionFileId): ReadFile {
  rootIdentity(project);
  const path = join(project.path, instructionNames[file]);
  let fd: number | undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new InstructionError("Instruction file must be a regular file with one link.");
    if (st.size > maxBytes) throw new InstructionError("Instruction file exceeds 32 KiB.");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) throw new InstructionError("Instruction file changed while it was being read.", 409);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0, count = 0;
    do { count = readSync(fd, buffer, bytes, buffer.length - bytes, null); bytes += count; } while (count && bytes < buffer.length);
    if (bytes > maxBytes || fstatSync(fd).size > maxBytes) throw new InstructionError("Instruction file exceeds 32 KiB.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)); }
    catch { throw new InstructionError("Instruction file is not valid UTF-8."); }
    validText(text);
    return { id: file, path, exists: true, hash: hash(buffer.subarray(0, bytes)), text, bytes, mode: st.mode & 0o777 };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      rootIdentity(project);
      return { id: file, path, exists: false, hash: null, text: "", bytes: 0, mode: null };
    }
    if (e instanceof InstructionError) throw e;
    throw new InstructionError("Instruction file could not be read safely.");
  } finally { if (fd !== undefined) closeSync(fd); }
}
function same(project: Project, file: InstructionFileId, expected: string | null, root: string, expectedMode: number | null) {
  const current = read(project, file);
  if (rootIdentity(project) !== root || current.hash !== expected || current.mode !== expectedMode)
    throw new InstructionError("Instruction file changed. Reload it and review your draft before trying again.", 409);
}
function write(project: Project, file: InstructionFileId, text: string | null, mode: number | null, expected: string | null, root: string, expectedMode: number | null) {
  const path = join(project.path, instructionNames[file]);
  same(project, file, expected, root, expectedMode);
  if (text === null) { unlinkSync(path); syncFolder(project.path); return; }
  const temporary = join(project.path, `.agentklar-instructions-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode ?? 0o644);
    if (mode !== null) fchmodSync(fd, mode);
    writeFileSync(fd, validText(text));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // Standard before-write hash check; external writers are not locked by AgentKlar.
    same(project, file, expected, root, expectedMode);
    renameSync(temporary, path);
    syncFolder(project.path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}
function syncFolder(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function metadata(saved: SavedChange): InstructionChange {
  const { beforeText, afterText, mode, afterMode, root, ...change } = saved;
  return change;
}
function overrideExists(path: string) {
  try { lstatSync(join(path, "AGENTS.override.md")); return true; } catch { return false; }
}
export class Instructions {
  private previews = new Map<string, SavedPreview>();
  constructor(private db: DatabaseSync) {
    db.exec("PRAGMA synchronous=FULL");
    db.exec("CREATE TABLE IF NOT EXISTS instruction_changes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL)");
    for (const row of db.prepare("SELECT data FROM instruction_changes").all()) {
      const change: SavedChange = JSON.parse(row.data as string);
      if (change.state === "prepared") this.save({ ...change, state: "interrupted", updatedAt: new Date().toISOString(), message: "Service stopped during this change. Files were not recovered automatically; inspect the file before undoing." });
    }
  }
  list(project: Project): InstructionSnapshot {
    return {
      projectId: project.id, checkedAt: new Date().toISOString(),
      files: (Object.keys(instructionNames) as InstructionFileId[]).map((id) => {
        try {
          const { hash, bytes, exists, path } = read(project, id);
          return { id, path, status: exists ? "present" as const : "missing" as const, hash, bytes: exists ? bytes : null, message: id === "agents" && overrideExists(project.path) ? "AGENTS.override.md exists; Codex may load it instead under native settings." : null };
        } catch (e) {
          return { id, path: join(project.path, instructionNames[id]), status: "unavailable" as const, hash: null, bytes: null, message: (e as Error).message };
        }
      }),
      changes: this.db.prepare("SELECT data FROM instruction_changes WHERE projectId=? ORDER BY rowid DESC LIMIT 20").all(project.id).map((row) => metadata(JSON.parse(row.data as string))),
    };
  }
  document(project: Project, file: InstructionFileId): InstructionDocument {
    const { mode, ...document } = read(project, file);
    return document;
  }
  preview(project: Project, file: InstructionFileId, text: string, expectedHash: string | null): InstructionPreview {
    const data = validText(text);
    const current = read(project, file);
    if (current.hash !== expectedHash) throw new InstructionError("Instruction file changed. Reload it and review your draft before trying again.", 409);
    for (const [id, preview] of this.previews) if (preview.expires <= Date.now()) this.previews.delete(id);
    // ponytail: 100 previews across this one local service; add per-session limits if it becomes multi-user.
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!);
    const preview: InstructionPreview = { id: randomUUID(), projectId: project.id, file, path: current.path, before: current.exists ? current.text : null, after: text, beforeHash: current.hash, afterHash: hash(data), createdAt: new Date().toISOString() };
    this.previews.set(preview.id, { ...preview, mode: current.mode, root: rootIdentity(project), expires: Date.now() + 600000 });
    return preview;
  }
  apply(project: Project, id: string): InstructionChange {
    const preview = this.previews.get(id);
    if (!preview || preview.projectId !== project.id || preview.expires <= Date.now()) throw new InstructionError("Preview expired or was not found. Preview your draft again.", 404);
    same(project, preview.file, preview.beforeHash, preview.root, preview.mode);
    const change: SavedChange = { id: randomUUID(), projectId: project.id, file: preview.file, path: preview.path, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "prepared", operation: "apply", beforeHash: preview.beforeHash, afterHash: preview.afterHash, message: null, beforeText: preview.before, afterText: preview.after, mode: preview.mode, afterMode: preview.mode ?? (0o644 & ~process.umask()), root: preview.root };
    this.save(change); // Undo text is durable before any filesystem mutation.
    this.previews.delete(id);
    return this.finish(change, () => write(project, change.file, change.afterText, change.mode, change.beforeHash, change.root, change.mode), "applied");
  }
  rollback(project: Project, id: string): InstructionChange {
    const row = this.db.prepare("SELECT data FROM instruction_changes WHERE id=? AND projectId=?").get(id, project.id);
    if (!row) throw new InstructionError("Instruction change not found.", 404);
    const change: SavedChange = JSON.parse(row.data as string);
    if (!["applied", "interrupted"].includes(change.state)) throw new InstructionError("This instruction change cannot be undone again.", 409);
    same(project, change.file, change.afterHash, change.root, change.afterMode);
    change.state = "prepared"; change.operation = "rollback"; change.updatedAt = new Date().toISOString(); change.message = null;
    this.save(change);
    return this.finish(change, () => write(project, change.file, change.beforeText, change.mode, change.afterHash, change.root, change.afterMode), "rolled_back");
  }
  private finish(change: SavedChange, action: () => void, state: "applied" | "rolled_back") {
    try { action(); change.state = state; change.message = null; }
    catch (e) {
      change.state = "interrupted"; change.message = "Change did not finish. Inspect the current file; no automatic recovery will run.";
      change.updatedAt = new Date().toISOString(); this.save(change);
      if (e instanceof InstructionError) throw e;
      throw new InstructionError(change.message);
    }
    change.updatedAt = new Date().toISOString(); this.save(change);
    this.db.prepare("DELETE FROM instruction_changes WHERE projectId=? AND json_extract(data,'$.state') IN ('applied','rolled_back') AND id NOT IN (SELECT id FROM instruction_changes WHERE projectId=? ORDER BY rowid DESC LIMIT 50)").run(change.projectId, change.projectId);
    return metadata(change);
  }
  private save(change: SavedChange) {
    this.db.prepare("INSERT INTO instruction_changes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(change.id, change.projectId, JSON.stringify(change));
  }
}
