import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync, fsyncSync, fchmodSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { applyEdits, getNodeValue, modify, parseTree, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { Project } from "./contracts.ts";
import { projectRootIdentity } from "./project-root.ts";

export class NativeChangeError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 422 | 503 = 422) { super(message); }
}
export const nativeSettingHarness = z.enum(["codex", "claude"]);
export const nativeSettingInput = z.object({ harness: nativeSettingHarness, field: z.enum(["model", "effort"]), value: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).nullable() }).strict().superRefine((input, ctx) => {
  if (input.field === "effort" && input.value !== null && !(input.harness === "claude" ? ["low", "medium", "high", "xhigh"] : ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).includes(input.value))
    ctx.addIssue({ code: "custom", message: "This effort is not a supported persistent native setting." });
});
export const nativePreviewId = z.object({ previewId: z.uuid() }).strict();
export const nativeChangeId = z.object({ changeId: z.uuid() }).strict();
export type NativeSettingInput = z.infer<typeof nativeSettingInput>;
export type NativeChangeOptions = { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number };
export const nativeHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const nativeObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeChangeError("Native metadata has an unsupported shape.", 503);
  return value as Record<string, unknown>;
};

let writing = false;
export async function guardNativeChange<T>(action: () => Promise<T>): Promise<T> {
  if (writing) throw new NativeChangeError("Another native settings change is in progress.", 409);
  writing = true;
  try { return await action(); } finally { writing = false; }
}

/** Native configuration stays in memory; callers persist hashes and managed fields only. */
export function nativeFile(path: string) {
  if (!isAbsolute(path)) throw new NativeChangeError("Native file path must be absolute.");
  let parent = dirname(path);
  for (;;) {
    try { projectRootIdentity(parent); break; }
    catch (error) {
      try { lstatSync(parent); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT" && dirname(parent) !== parent) { parent = dirname(parent); continue; }
      }
      throw new NativeChangeError("Native settings parent is unavailable or is a link.");
    }
  }
  const parentIdentity = `${parent}:${projectRootIdentity(parent)}`;
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2 * 1024 * 1024) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new Error();
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let length = 0, count: number;
    do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
    const bytes = buffer.subarray(0, length), after = fstatSync(fd);
    if (bytes.length > 2 * 1024 * 1024 || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), mode = before.mode & 0o777;
    return { path, text: text as string | null, mode: mode as number | null, fingerprint: nativeHash([path, text, mode, parentIdentity]), parentIdentity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: null as string | null, mode: null as number | null, fingerprint: nativeHash([path, null, parentIdentity]), parentIdentity };
    throw new NativeChangeError("Native settings file cannot be read safely.");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function nativeJson(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length || !tree || tree.type !== "object") throw new NativeChangeError("Native settings JSON is unsupported.");
  // Duplicate top-level keys would make a managed-field edit ambiguous.
  const names = tree.children?.map(node => String(getNodeValue(node.children![0]))) ?? [];
  if (new Set(names).size !== names.length) throw new NativeChangeError("Native settings has duplicate top-level keys.");
  return nativeObject(getNodeValue(tree));
}

/** Runs metadata/config commands only. Output and errors are never saved verbatim. */
export function runNativeCommand(command: string, args: string[], cwd: string, options: NativeChangeOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "", bytes = 0, failed = false;
    const kill = () => { try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} };
    const timeout = setTimeout(() => { failed = true; kill(); }, options.timeoutMs ?? 15000);
    const consume = (data: Buffer, stdout: boolean) => {
      bytes += data.length;
      if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) { failed = true; kill(); }
      else if (stdout) output += data.toString("utf8");
    };
    child.stdout.on("data", data => consume(data, true)); child.stderr.on("data", data => consume(data, false));
    child.on("error", () => { failed = true; });
    child.on("close", code => {
      clearTimeout(timeout); kill();
      if (failed || code !== 0) reject(new NativeChangeError("Native command did not complete within its limits. Inspect native settings before retrying.", 503));
      else resolve(output);
    });
  });
}

async function codexConfig(command: string, cwd: string, options: NativeChangeOptions, edit?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server", "--stdio"], { cwd, env: options.env ?? process.env, stdio: "pipe", detached: process.platform !== "win32" });
    let buffer = "", bytes = 0, finished = false;
    const kill = () => { try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} };
    const finish = (error?: Error, value?: unknown) => { if (finished) return; finished = true; clearTimeout(timeout); kill(); error ? reject(error) : resolve(value); };
    const timeout = setTimeout(() => finish(new NativeChangeError("Native config read or write timed out.", 503)), options.timeoutMs ?? 15000);
    const send = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.stdout.on("data", data => {
      bytes += data.length;
      if (bytes > (options.maxOutputBytes ?? 2 * 1024 * 1024)) return finish(new NativeChangeError("Native configuration exceeded the response limit.", 503));
      buffer += data.toString(); let newline;
      while ((newline = buffer.indexOf("\n")) !== -1 && !finished) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown>; try { message = nativeObject(JSON.parse(line)); } catch { return finish(new NativeChangeError("Native config protocol is unsupported.", 503)); }
        if (message.method) continue;
        if (message.error) return finish(new NativeChangeError("Native config request was refused. No replacement was attempted.", 409));
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: edit ? "config/value/write" : "config/read", params: edit ?? { cwd, includeLayers: true } });
        } else if (message.id === 2) finish(undefined, message.result);
      }
    });
    child.stderr.on("data", data => { bytes += data.length; if (bytes > (options.maxOutputBytes ?? 2 * 1024 * 1024)) finish(new NativeChangeError("Native configuration exceeded the response limit.", 503)); });
    child.on("error", () => finish(new NativeChangeError("Native Codex CLI is unavailable.", 503)));
    child.on("close", () => { if (!finished) finish(new NativeChangeError("Native config connection closed before a response.", 503)); });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agentklar-settings", version: "1.0.0" }, capabilities: { experimentalApi: false } } });
  });
}

export type NativeSettingPreview = { id: string; projectId: string; harness: "codex" | "claude"; field: "model" | "effort"; key: string; scope: string; path: string; before: string | null; after: string | null; expiresAt: string; message: string };
export type NativeSettingChange = Omit<NativeSettingPreview, "expiresAt"> & { state: "prepared" | "applied" | "undoing" | "undone" | "interrupted"; createdAt: string; canUndo: boolean };
type SavedPreview = NativeSettingPreview & { fingerprint: string; root: string; version: string | null; mode: number | null; existed: boolean };
type SavedChange = NativeSettingChange & { root: string; afterFingerprint: string | null; existed: boolean };

export class NativeSettings {
  private previews = new Map<string, SavedPreview>();
  constructor(private db: DatabaseSync, private commands: { codex: string | null; claude: string | null }, private options: NativeChangeOptions = {}) {
    db.exec("CREATE TABLE IF NOT EXISTS native_setting_changes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL)");
    for (const row of db.prepare("SELECT data FROM native_setting_changes").all()) {
      const change = JSON.parse(row.data as string) as SavedChange;
      if (["prepared", "undoing"].includes(change.state)) this.save({ ...change, state: "interrupted", message: "Settings change was interrupted. Inspect the native file before recovery." });
    }
  }
  private save(change: SavedChange) { this.db.prepare("INSERT INTO native_setting_changes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(change.id, change.projectId, JSON.stringify(change)); }
  private publicChange(change: SavedChange): NativeSettingChange { const { root, afterFingerprint, existed, ...safe } = change; return safe; }
  private async snapshot(project: Project, harness: "codex" | "claude") {
    const root = projectRootIdentity(project.path), env = this.options.env ?? process.env;
    if (harness === "claude") {
      const file = nativeFile(join(project.path, ".claude", "settings.local.json")), config = nativeJson(file.text);
      return { ...file, config, root, version: null as string | null, scope: "Local project" };
    }
    if (!this.commands.codex) throw new NativeChangeError("Install native Codex before editing its defaults.", 503);
    const nativeHome = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
    if (!isAbsolute(nativeHome)) throw new NativeChangeError("CODEX_HOME must be absolute.");
    const path = join(nativeHome, "config.toml"), before = nativeFile(path);
    const response = nativeObject(await codexConfig(this.commands.codex, project.path, this.options));
    const layers = Array.isArray(response.layers) ? response.layers.map(nativeObject) : [];
    const users = layers.filter(layer => nativeObject(layer.name).type === "user");
    if (users.length !== 1) throw new NativeChangeError("Native Codex user config provenance is unavailable.", 503);
    const user = users[0]!, name = nativeObject(user.name);
    if (name.file !== path || name.profile != null || typeof user.version !== "string" || user.version.length > 200) throw new NativeChangeError("Codex config path or selected profile differs. Use native settings.", 409);
    if (nativeFile(path).fingerprint !== before.fingerprint || projectRootIdentity(project.path) !== root) throw new NativeChangeError("Native settings changed while checking. Refresh.", 409);
    return { ...before, config: nativeObject(user.config), root, version: user.version, scope: "User · all Codex projects" };
  }
  private value(config: Record<string, unknown>, key: string) {
    const value = config[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value)) throw new NativeChangeError("Existing native default is outside the supported setting format.");
    return value;
  }
  async read(project: Project, harness: "codex" | "claude") {
    const snapshot = await this.snapshot(project, harness);
    const changes = this.db.prepare("SELECT data FROM native_setting_changes WHERE projectId=? ORDER BY rowid DESC LIMIT 20").all(project.id).map(row => {
      const saved = JSON.parse(row.data as string) as SavedChange;
      saved.canUndo = ["applied", "interrupted"].includes(saved.state) && saved.root === snapshot.root && saved.path === snapshot.path && saved.afterFingerprint === snapshot.fingerprint;
      return this.publicChange(saved);
    }).filter(change => change.harness === harness);
    return { projectId: project.id, harness, scope: snapshot.scope, path: snapshot.path, model: this.value(snapshot.config, "model"), effort: this.value(snapshot.config, harness === "codex" ? "model_reasoning_effort" : "effortLevel"), changes, message: "Defaults affect new native sessions. Native model support, explicit flags, profiles, managed settings and account access still apply." };
  }
  async preview(project: Project, raw: NativeSettingInput): Promise<NativeSettingPreview> {
    const input = nativeSettingInput.parse(raw), current = await this.snapshot(project, input.harness);
    const key = input.field === "model" ? "model" : input.harness === "codex" ? "model_reasoning_effort" : "effortLevel";
    for (const [id, saved] of this.previews) if (Date.parse(saved.expiresAt) <= Date.now()) this.previews.delete(id);
    if (this.previews.size >= 100) throw new NativeChangeError("Too many open native setting previews.", 409);
    const preview: SavedPreview = { id: randomUUID(), projectId: project.id, ...input, key, path: current.path, scope: current.scope, before: this.value(current.config, key), after: input.value, expiresAt: new Date(Date.now() + 600000).toISOString(), message: "Only this default changes. Restart or start a native session to check effective settings; model access and effort support remain native decisions.", fingerprint: current.fingerprint, root: current.root, version: current.version, mode: current.mode, existed: current.text !== null };
    this.previews.set(preview.id, preview);
    const { fingerprint, root, version, mode, existed, value, ...safe } = preview as SavedPreview & { value: unknown };
    return safe;
  }
  private async write(project: Project, harness: "codex" | "claude", key: string, value: string | null, snapshot: Awaited<ReturnType<NativeSettings["snapshot"]>>, removeEmptyFile = false) {
    if (harness === "codex") {
      const response = nativeObject(await codexConfig(this.commands.codex!, project.path, this.options, { keyPath: key, value, mergeStrategy: "replace", filePath: snapshot.path, expectedVersion: snapshot.version }));
      if (!["ok", "okOverridden"].includes(String(response.status)) || response.filePath !== snapshot.path) throw new NativeChangeError("Native config write could not be verified.", 503);
      return;
    }
    if (nativeFile(snapshot.path).fingerprint !== snapshot.fingerprint) throw new NativeChangeError("Native settings changed. Preview again.", 409);
    mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
    projectRootIdentity(dirname(snapshot.path));
    const text = applyEdits(snapshot.text ?? "{}\n", modify(snapshot.text ?? "{}\n", [key], value ?? undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    nativeJson(text);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new NativeChangeError("Native settings would exceed the file size limit.");
    if (removeEmptyFile && Object.keys(nativeJson(text)).length === 0) { unlinkSync(snapshot.path); return; }
    const temp = join(dirname(snapshot.path), `.agentklar-setting-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, snapshot.mode ?? 0o600);
      fchmodSync(fd, snapshot.mode ?? 0o600); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
      const current = nativeFile(snapshot.path);
      // Creating a missing parent changes its identity; the contents and mode must still match.
      if (current.text !== snapshot.text || current.mode !== snapshot.mode || projectRootIdentity(project.path) !== snapshot.root) throw new NativeChangeError("Native file or project changed during writing.", 409);
      renameSync(temp, snapshot.path);
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  async apply(project: Project, id: string): Promise<NativeSettingChange> {
    return guardNativeChange(async () => {
      const preview = this.previews.get(id);
      if (!preview || preview.projectId !== project.id || Date.parse(preview.expiresAt) <= Date.now()) throw new NativeChangeError("Native setting preview expired or was not found.", 404);
      const current = await this.snapshot(project, preview.harness);
      if (current.fingerprint !== preview.fingerprint || current.root !== preview.root || current.version !== preview.version) throw new NativeChangeError("Native settings changed. Preview again.", 409);
      const { fingerprint, version, mode, expiresAt, value, ...rest } = preview as SavedPreview & { value: unknown };
      const change: SavedChange = { ...rest, id: randomUUID(), state: "prepared", createdAt: new Date().toISOString(), afterFingerprint: null, canUndo: false };
      this.save(change); this.previews.delete(id);
      try {
        await this.write(project, change.harness, change.key, change.after, current);
        const after = await this.snapshot(project, change.harness);
        if (this.value(after.config, change.key) !== change.after || after.root !== change.root) throw new NativeChangeError("Native setting result could not be verified.", 503);
        change.afterFingerprint = after.fingerprint; change.state = "applied"; change.canUndo = true;
      } catch (error) {
        change.state = "interrupted"; change.message = "Native change did not finish. Inspect the file; no automatic rollback ran.";
        try { const after = await this.snapshot(project, change.harness); if (after.root === change.root && this.value(after.config, change.key) === change.after) { change.afterFingerprint = after.fingerprint; change.canUndo = true; } } catch {}
        this.save(change); throw error;
      }
      this.save(change); return this.publicChange(change);
    });
  }
  async undo(project: Project, id: string): Promise<NativeSettingChange> {
    return guardNativeChange(async () => {
      const row = this.db.prepare("SELECT data FROM native_setting_changes WHERE id=? AND projectId=?").get(id, project.id);
      if (!row) throw new NativeChangeError("Native setting change not found.", 404);
      const change = JSON.parse(row.data as string) as SavedChange, current = await this.snapshot(project, change.harness);
      if (!["applied", "interrupted"].includes(change.state) || current.root !== change.root || current.fingerprint !== change.afterFingerprint || this.value(current.config, change.key) !== change.after) throw new NativeChangeError("Native settings changed. Undo will not overwrite them.", 409);
      change.state = "undoing"; change.canUndo = false; this.save(change);
      try {
        await this.write(project, change.harness, change.key, change.before, current, !change.existed);
        const after = await this.snapshot(project, change.harness);
        if (after.root !== change.root || this.value(after.config, change.key) !== change.before) throw new NativeChangeError("Native undo result could not be verified.", 503);
        change.state = "undone"; change.message = "Managed native default restored. Start a new native session to check it.";
      }
      catch (error) { change.state = "interrupted"; change.message = "Undo did not finish. Inspect native settings."; this.save(change); throw error; }
      this.save(change); return this.publicChange(change);
    });
  }
}
