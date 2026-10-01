import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, accessSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Project, SetupHarness, SetupEntry, SetupStatus, SetupPreview, SetupChange } from "./contracts.ts";
import { projectRootIdentity } from "./project-root.ts";

export class SetupError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 422 | 503 = 422) { super(message); }
}
export type NativeSetupOptions = { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function nativeObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SetupError("Native MCP configuration is unsupported. Inspect it through native settings.");
  return value as Record<string, unknown>;
}
function optionalObject(value: unknown) { return value === undefined ? {} : nativeObject(value); }
function canonicalHome(path: string): string {
  try { return realpathSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw new SetupError("Native config home is unavailable. Inspect its native home setting.");
    return join(canonicalHome(dirname(path)), basename(path));
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
function entryHash(value: unknown) { return hash(canonical(value)); }
function projectRoot(project: Project) {
  try {
    return projectRootIdentity(project.path);
  } catch { throw new SetupError("Project folder is unavailable, changed, or lacks a stable creation time. Use a real folder on a supported filesystem."); }
}
// Native config is read only in memory. Never return, log or save it.
function configRead(path: string): { text: string | null; fingerprint: string } {
  let fd: number | undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 2 * 1024 * 1024) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) throw new Error();
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let bytes = 0, count: number;
    do { count = readSync(fd, buffer, bytes, buffer.length - bytes, null); bytes += count; } while (count && bytes < buffer.length);
    const after = fstatSync(fd);
    if (bytes > 2 * 1024 * 1024 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    return { text, fingerprint: hash([path, st.dev, st.ino, st.mode, buffer.subarray(0, bytes).toString("base64")]) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { text: null, fingerprint: hash([path, null]) };
    throw new SetupError("Native configuration cannot be read safely. Use native MCP settings to inspect it.");
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function nativeSetupCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, options: NativeSetupOptions = {}, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", shell: false });
    let stdout = "", stderr = "", bytes = 0, failure = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    function kill(sig: NodeJS.Signals) {
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, sig); } catch {}
    }
    function fail(message: string) {
      if (failure) return;
      failure = message;
      kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 250);
    }
    const abort = () => fail("Native MCP command was interrupted. Refresh status before trying again.");
    const timer = setTimeout(() => fail("Native MCP command timed out. Refresh status before trying again."), options.timeoutMs ?? 10000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    function collect(data: Buffer, isError: boolean) {
      bytes += data.length;
      if (bytes > (options.maxOutputBytes ?? 65536)) { fail("Native MCP command output exceeded its limit. Refresh status before trying again."); return; }
      if (isError) stderr += data.toString("utf8"); else stdout += data.toString("utf8");
    }
    child.stdout.on("data", (data: Buffer) => collect(data, false)); child.stderr.on("data", (data: Buffer) => collect(data, true));
    child.on("error", () => fail("Native MCP command could not start. Check the installed native CLI."));
    child.on("close", (code) => {
      // Clean up only this owned process group, including descendants that outlive the command.
      kill("SIGKILL"); clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (failure) reject(new SetupError(failure, 503)); else resolve({ code, stdout, stderr });
    });
  });
}
type ReadState = { target: string; fingerprint: string; entry: unknown | null; entryHash: string | null; root: string; shadow: boolean };
type SavedPreview = SetupPreview & Omit<ReadState, "entry"> & { expires: number };
type SavedChange = SetupChange & { target: string; entry: SetupEntry; entryHash: string; root: string; projectPath: string };
const changeMetadata = ({ target, entry, entryHash, root, projectPath, ...change }: SavedChange): SetupChange => change;
export class NativeSetup {
  private env: NodeJS.ProcessEnv;
  private previews = new Map<string, SavedPreview>();
  private busy = false;
  private closing = false;
  private active = new Set<Promise<unknown>>();
  private operations = new Set<Promise<unknown>>();
  private abort = new AbortController();
  readonly entry: SetupEntry;
  private neutral: string;
  constructor(private db: DatabaseSync, private home: string, private port: number, private commands: Record<SetupHarness, string | null>, private options: NativeSetupOptions = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.entry = { type: "stdio", command: process.execPath, args: ["--import", fileURLToPath(import.meta.resolve("tsx")), fileURLToPath(new URL("./mcp.ts", import.meta.url))], env: { AGENTKLAR_HOME: realpathSync(home), AGENTKLAR_PORT: String(port) } };
    this.neutral = mkdtempSync(join(tmpdir(), "agentklar-setup-cwd-"));
    db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS native_setup_changes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL)");
    for (const row of db.prepare("SELECT data FROM native_setup_changes").all()) {
      const change: SavedChange = JSON.parse(row.data as string);
      if (change.state === "prepared") this.save({ ...change, state: "interrupted", message: "Service stopped during native setup. Refresh status, then undo only if the entry is unchanged.", updatedAt: new Date().toISOString() });
    }
  }
  private tracked<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new SetupError("Service is shutting down.", 503));
    const promise = action();
    this.operations.add(promise);
    return promise.finally(() => { this.operations.delete(promise); });
  }
  status(project: Project, harness: SetupHarness) { return this.tracked(() => this.statusOperation(project, harness)); }
  preview(project: Project, harness: SetupHarness) { return this.tracked(() => this.previewOperation(project, harness)); }
  apply(project: Project, harness: SetupHarness, id: string) { return this.tracked(() => this.applyOperation(project, harness, id)); }
  undo(project: Project, harness: SetupHarness, id: string) { return this.tracked(() => this.undoOperation(project, harness, id)); }
  private target(harness: SetupHarness) {
    const userHome = this.env.HOME || homedir();
    const nativeHome = harness === "codex" ? this.env.CODEX_HOME || join(userHome, ".codex") : this.env.CLAUDE_CONFIG_DIR || userHome;
    if (!isAbsolute(nativeHome)) throw new SetupError("Native config home must be an absolute path. Restart AgentKlar with the native home setting.");
    return join(canonicalHome(nativeHome), harness === "codex" ? "config.toml" : ".claude.json");
  }
  private supported(harness: SetupHarness) {
    if (process.platform === "win32") throw new SetupError("Native setup currently supports macOS and Linux. Use your native MCP settings on Windows.");
    if (Number(process.versions.node.split(".")[0]) !== 24) throw new SetupError("Native setup requires Node 24. Restart AgentKlar with Node 24.");
    for (const path of [this.entry.command, ...this.entry.args.filter((arg) => isAbsolute(arg))]) {
      try { accessSync(path, path === this.entry.command ? constants.X_OK : constants.R_OK); } catch { throw new SetupError("MCP bridge files are unavailable. Install this checkout's dependencies and restart AgentKlar."); }
    }
    if (!this.commands[harness]) throw new SetupError(`Install ${harness === "codex" ? "Codex" : "Claude Code"} through its native setup first.`);
  }
  private async command(harness: SetupHarness, args: string[], project: Project) {
    if (this.closing) throw new SetupError("Service is shutting down.", 503);
    this.supported(harness);
    const promise = nativeSetupCommand(this.commands[harness]!, args, harness === "codex" ? this.neutral : project.path, this.env, this.options, this.abort.signal);
    this.active.add(promise); try { return await promise; } finally { this.active.delete(promise); }
  }
  private async codexConfig(project: Project) {
    if (this.closing) throw new SetupError("Service is shutting down.", 503);
    const command = this.commands.codex!;
    const promise = new Promise<unknown>((resolve, reject) => {
      const child = spawn(command, ["app-server", "--stdio"], { cwd: project.path, env: this.env, stdio: "pipe", detached: true, shell: false });
      let output = "", bytes = 0, result: unknown, completed = false, failed = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (sig: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, sig); } catch {} };
      const stop = () => { if (escalation) return; kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 250); };
      const fail = () => { failed = true; stop(); };
      const timer = setTimeout(fail, this.options.timeoutMs ?? 10000);
      this.abort.signal.addEventListener("abort", fail, { once: true });
      child.on("error", fail); child.stdin.on("error", fail);
      const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
      child.stdout.on("data", (data: Buffer) => {
        if (failed || completed) return;
        bytes += data.length; output += data.toString("utf8");
        if (bytes > (this.options.maxOutputBytes ?? 2 * 1024 * 1024)) return fail();
        let index: number;
        while ((index = output.indexOf("\n")) !== -1) {
          const line = output.slice(0, index); output = output.slice(index + 1);
          try {
            const response = record(JSON.parse(line));
            if ("method" in response) continue;
            if (response.id === 1) {
              if (response.error !== undefined) return fail();
              send({ jsonrpc: "2.0", method: "initialized" });
              send({ jsonrpc: "2.0", id: 2, method: "config/read", params: { includeLayers: true, cwd: project.path } });
            } else if (response.id === 2) {
              if (response.error !== undefined) return fail();
              result = response.result; completed = true; stop();
            }
          } catch { fail(); }
        }
      });
      child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > (this.options.maxOutputBytes ?? 2 * 1024 * 1024)) fail(); });
      child.on("close", () => {
        kill("SIGKILL"); clearTimeout(timer); if (escalation) clearTimeout(escalation); this.abort.signal.removeEventListener("abort", fail);
        if (failed || !completed) reject(new SetupError("Codex MCP configuration could not be read. Check its native settings.", 503)); else resolve(result);
      });
      if (this.abort.signal.aborted) fail();
      else send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agentklar_setup", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
    });
    this.active.add(promise); try { return record(await promise); } finally { this.active.delete(promise); }
  }
  private async read(project: Project, harness: SetupHarness): Promise<ReadState> {
    if (this.closing) throw new SetupError("Service is shutting down.", 503);
    this.supported(harness);
    const root = projectRoot(project), target = this.target(harness), before = configRead(target);
    let entry: unknown | null, shadow = false, provenance: unknown = null;
    if (harness === "claude") {
      try {
        const config = before.text === null ? {} : nativeObject(JSON.parse(before.text));
        const projects = optionalObject(config.projects);
        const selected = optionalObject(projects[project.path]);
        const servers = optionalObject(selected.mcpServers);
        if (Object.hasOwn(servers, "agentklar")) nativeObject(servers.agentklar);
        entry = servers.agentklar ?? null;
        shadow = Object.hasOwn(optionalObject(config.mcpServers), "agentklar");
        const committed = configRead(join(project.path, ".mcp.json"));
        if (committed.text !== null) {
          const projectConfig = nativeObject(JSON.parse(committed.text));
          if (Object.hasOwn(optionalObject(projectConfig.mcpServers), "agentklar")) shadow = true;
        }
      } catch (e) { if (e instanceof SetupError) throw e; throw new SetupError("Claude MCP configuration is unsupported. Inspect it through native settings."); }
    } else {
      const config = await this.codexConfig(project);
      if (!Array.isArray(config.layers)) throw new SetupError("Codex config provenance is unavailable. Inspect native MCP settings.");
      let users = 0;
      entry = null;
      for (const raw of config.layers) {
        const layer = record(raw), name = record(layer.name);
        const nativeEntry = record(record(layer.config).mcp_servers).agentklar;
        if (name.type === "user") {
          users++;
          let file: string;
          try { file = realpathSync(String(name.file)); } catch { file = String(name.file); }
          let expected: string;
          try { expected = realpathSync(target); } catch { expected = target; }
          if (file !== expected || name.profile != null) throw new SetupError("Codex user config target or profile differs. Inspect native MCP settings.");
          if (nativeEntry !== undefined && (nativeEntry === null || typeof nativeEntry !== "object" || Array.isArray(nativeEntry))) throw new SetupError("Codex MCP entry is unsupported. Inspect native MCP settings.");
          entry = nativeEntry ?? null;
        } else if (nativeEntry !== undefined) shadow = true;
      }
      if (users > 1 || (users === 0 && before.text !== null)) throw new SetupError("Codex user config provenance is unavailable. Inspect native MCP settings.");
      // Fingerprint every layer, including parent, managed and system settings.
      provenance = config.layers.map((raw) => { const layer = record(raw); return [layer.name, layer.version]; });
    }
    if (configRead(target).fingerprint !== before.fingerprint || projectRoot(project) !== root) throw new SetupError("Native settings changed while checking. Refresh status.", 409);
    const projectConfig = harness === "claude" ? configRead(join(project.path, ".mcp.json")).fingerprint : this.codexProjectFingerprint(project);
    return { target, fingerprint: hash([before.fingerprint, projectConfig, provenance]), entry, entryHash: entry === null ? null : entryHash(entry), root, shadow };
  }
  private codexProjectFingerprint(project: Project) {
    // A changed project override invalidates a reviewed global setup preview.
    return configRead(join(project.path, ".codex", "config.toml")).fingerprint;
  }
  private exact(harness: SetupHarness, value: unknown) {
    if (harness === "claude") return entryHash(value) === entryHash(this.entry);
    return entryHash(value) === entryHash({ command: this.entry.command, args: this.entry.args, env: this.entry.env });
  }
  private latest(project: Project, harness: SetupHarness) {
    const rows = this.db.prepare("SELECT data FROM native_setup_changes WHERE projectId=? ORDER BY rowid DESC").all(project.id);
    return rows.map((row) => JSON.parse(row.data as string) as SavedChange).find((change) => change.harness === harness);
  }
  private async statusOperation(project: Project, harness: SetupHarness): Promise<SetupStatus> {
    const change = this.latest(project, harness);
    const base = { harness, projectId: project.id, scope: harness === "codex" ? "User" as const : "Local project" as const, checkedAt: new Date().toISOString(), change: change ? changeMetadata(change) : null, canUndo: false };
    try {
      const current = await this.read(project, harness);
      const configured = current.entry !== null && this.exact(harness, current.entry);
      const canUndo = !!change && ["applied", "interrupted"].includes(change.state) && (change.operation === "apply" || change.state === "interrupted") && change.target === current.target && change.root === current.root && change.entryHash === current.entryHash && !current.shadow;
      return { ...base, canUndo, status: current.shadow || (current.entry !== null && !configured) ? "conflict" : configured ? "configured" : "missing", message: current.shadow ? "Another native scope defines agentklar. Resolve it in native MCP settings before using setup here." : configured ? "AgentKlar entry is configured. Start or restart your native session to load it. Native trust and permissions still apply." : current.entry !== null ? "A different agentklar entry exists. Resolve it in native MCP settings; AgentKlar will not overwrite it." : "AgentKlar has no entry in this native scope." };
    } catch (e) { return { ...base, status: "unavailable", message: e instanceof SetupError ? e.message : "Native MCP status is unavailable." }; }
  }
  private async previewOperation(project: Project, harness: SetupHarness): Promise<SetupPreview> {
    const current = await this.read(project, harness);
    if (current.shadow || current.entry !== null) throw new SetupError(current.entry !== null && this.exact(harness, current.entry) ? "AgentKlar is already configured. Start or restart a native session." : "A native agentklar entry already exists or another scope defines it. Resolve it in native settings first.", 409);
    const args = this.addArgs(harness);
    const preview: SetupPreview = { id: randomUUID(), projectId: project.id, harness, scope: harness === "codex" ? "User" : "Local project", configPath: current.target, cwd: harness === "codex" ? null : project.path, command: [this.commands[harness]!, ...args].map(quote).join(" "), entry: this.entry, createdAt: new Date().toISOString() };
    for (const [id, saved] of this.previews) if (saved.expires <= Date.now()) this.previews.delete(id);
    // ponytail: one local service holds at most 100 previews; use session limits if multi-user support is added.
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!);
    const { entry: nativeEntry, ...snapshot } = current;
    this.previews.set(preview.id, { ...preview, ...snapshot, expires: Date.now() + 600000 });
    return preview;
  }
  private addArgs(harness: SetupHarness) {
    const env = Object.entries(this.entry.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    return harness === "codex" ? ["mcp", "add", "agentklar", ...env, "--", this.entry.command, ...this.entry.args] : ["mcp", "add", "--scope", "local", "--transport", "stdio", "agentklar", ...env, "--", this.entry.command, ...this.entry.args];
  }
  private async exclusive<T>(action: () => Promise<T>) {
    // ponytail: native writes share one lock across this local service; use per-config locks if throughput matters.
    if (this.busy) throw new SetupError("A native setup change is still running. Refresh status when it finishes.", 409);
    this.busy = true; try { return await action(); } finally { this.busy = false; }
  }
  private async applyOperation(project: Project, harness: SetupHarness, id: string): Promise<SetupChange> {
    return this.exclusive(async () => {
      const preview = this.previews.get(id);
      if (!preview || preview.projectId !== project.id || preview.harness !== harness || preview.expires <= Date.now()) throw new SetupError("Setup preview expired or was not found. Preview setup again.", 404);
      const current = await this.read(project, harness);
      if (current.target !== preview.target || current.fingerprint !== preview.fingerprint || current.root !== preview.root || current.entry !== null || current.shadow) throw new SetupError("Native settings changed. Refresh status and preview setup again.", 409);
      const now = new Date().toISOString();
      const change: SavedChange = { id: randomUUID(), projectId: project.id, harness, operation: "apply", state: "prepared", message: null, createdAt: now, updatedAt: now, target: current.target, root: current.root, projectPath: project.path, entry: this.entry, entryHash: "" };
      // Desired native metadata is durable before add, so interrupted changes remain explicitly recoverable.
      change.entryHash = entryHash(harness === "claude" ? this.entry : { command: this.entry.command, args: this.entry.args, env: this.entry.env });
      this.save(change); this.previews.delete(id);
      return this.finish(change, project, async () => {
        const result = await this.command(harness, this.addArgs(harness), project);
        if (result.code !== 0) throw new SetupError("Native add did not finish successfully. Refresh status before trying again.", 503);
        const after = await this.read(project, harness);
        if (after.target !== change.target || after.root !== change.root || after.shadow || !this.exact(harness, after.entry)) throw new SetupError("Native add could not be verified. Refresh status and inspect native MCP settings.", 503);
        change.entryHash = after.entryHash!;
      }, "applied");
    });
  }
  private async undoOperation(project: Project, harness: SetupHarness, id: string): Promise<SetupChange> {
    return this.exclusive(async () => {
      const row = this.db.prepare("SELECT data FROM native_setup_changes WHERE id=? AND projectId=?").get(id, project.id);
      if (!row) throw new SetupError("Managed setup change not found.", 404);
      const change: SavedChange = JSON.parse(row.data as string);
      if (change.harness !== harness || !["applied", "interrupted"].includes(change.state) || (change.state === "applied" && change.operation !== "apply")) throw new SetupError("This setup change cannot be undone.", 409);
      const current = await this.read(project, harness);
      if (change.target !== current.target || change.projectPath !== project.path || change.root !== current.root || change.entryHash !== current.entryHash || current.shadow) throw new SetupError("Native entry has changed or is absent. AgentKlar will not remove it. Inspect native MCP settings.", 409);
      change.state = "prepared"; change.operation = "undo"; change.message = null; change.updatedAt = new Date().toISOString(); this.save(change);
      return this.finish(change, project, async () => {
        const result = await this.command(harness, harness === "codex" ? ["mcp", "remove", "agentklar"] : ["mcp", "remove", "--scope", "local", "agentklar"], project);
        if (result.code !== 0) throw new SetupError("Native removal did not finish successfully. Refresh status and inspect native MCP settings.", 503);
        const after = await this.read(project, harness);
        if (after.target !== change.target || after.root !== change.root || after.entry !== null) throw new SetupError("Native removal could not be verified. Inspect native MCP settings.", 503);
      }, "undone");
    });
  }
  private async finish(change: SavedChange, project: Project, action: () => Promise<void>, state: "applied" | "undone") {
    try { await action(); change.state = state; change.message = null; }
    catch (e) { change.state = "interrupted"; change.message = e instanceof SetupError ? e.message : "Native setup was interrupted. Refresh status and inspect native MCP settings."; change.updatedAt = new Date().toISOString(); this.save(change); throw new SetupError(change.message, 503); }
    change.updatedAt = new Date().toISOString(); this.save(change); return changeMetadata(change);
  }
  private save(change: SavedChange) { this.db.prepare("INSERT INTO native_setup_changes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(change.id, change.projectId, JSON.stringify(change)); }
  async close() { this.closing = true; this.abort.abort(); await Promise.allSettled([...this.operations, ...this.active]); rmSync(this.neutral, { recursive: true, force: true }); }
}
