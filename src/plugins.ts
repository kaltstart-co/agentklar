import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Project } from "./contracts.ts";
import { projectRootIdentity } from "./project-root.ts";
import { NativeChangeError, nativeFile, nativeHash, nativeJson, nativeObject, runNativeCommand, guardNativeChange, type NativeChangeOptions } from "./native-settings.ts";
import { NativeObservations, observationEvents, observationHookScript } from "./observations.ts";

export const pluginPreviewInput = z.object({ observeActivity: z.boolean().default(false) }).strict();
const packageRoot = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url));
const skillRelative = "skills/agentklar-workflow/SKILL.md";
const bundleName = "agentklar-workflow";
export type PluginPreview = { id: string; projectId: string; harness: "claude"; name: string; version: string; source: string; sourceHash: string; pluginId: string; scope: "Local project"; files: { path: string; bytes: number; hash: string }[]; manifest: Record<string, unknown>; capabilities: { skills: string[]; agents: number; hooks: number; mcpServers: number }; commands: string[][]; expiresAt: string; message: string };
export type PluginChange = Omit<PluginPreview, "commands" | "expiresAt" | "manifest" | "files"> & { id: string; state: "prepared" | "applied" | "undoing" | "undone" | "interrupted"; createdAt: string; installed: boolean; recognized: boolean; canUndo: boolean };
type Preview = PluginPreview & { root: string; stage: string; stageIdentity: string; fingerprints: string[]; marketplace: string; observeToken?: string };
type Change = PluginChange & { root: string; stage: string; stageIdentity: string; fingerprints: string[] | null; marketplace: string; installPath: string | null; fileHashes: PluginPreview["files"]; sourceSkillHash: string; phase: "prepared" | "marketplace" | "installed" | "uninstalled" };

/** One native plugin package; existing individual skill installs remain separate. */
export class NativePlugins {
  private previews = new Map<string, Preview>();
  private nativeHome: string;
  constructor(private db: DatabaseSync, private home: string, private command: string | null, private options: NativeChangeOptions & { sourceRoot?: string; observations?: NativeObservations; port?: number } = {}) {
    const env = options.env ?? process.env;
    this.nativeHome = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
    if (!isAbsolute(this.nativeHome)) throw new NativeChangeError("CLAUDE_CONFIG_DIR must be absolute.");
    db.exec("CREATE TABLE IF NOT EXISTS native_plugin_changes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL)");
    for (const row of db.prepare("SELECT data FROM native_plugin_changes").all()) {
      const change = JSON.parse(row.data as string) as Change;
      if (["prepared", "undoing"].includes(change.state)) this.save({ ...change, state: "interrupted", message: "Native plugin change was interrupted. Refresh its receipt and inspect native settings." });
    }
  }
  private save(change: Change) { this.db.prepare("INSERT INTO native_plugin_changes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(change.id, change.projectId, JSON.stringify(change)); }
  private publicChange(change: Change): PluginChange {
    const { root, stage, stageIdentity, fingerprints, marketplace, installPath, fileHashes, sourceSkillHash, phase, ...safe } = change; return safe;
  }
  private run(project: Project, args: string[]) {
    if (!this.command) throw new NativeChangeError("Native Claude Code is unavailable. Choose its installed CLI first.", 503);
    return runNativeCommand(this.command, args, project.path, this.options);
  }
  private fingerprints(project: Project) {
    return [join(project.path, ".claude", "settings.local.json"), join(this.nativeHome, "settings.json"), join(this.nativeHome, "plugins", "installed_plugins.json"), join(this.nativeHome, "plugins", "known_marketplaces.json")].map(path => nativeFile(path).fingerprint);
  }
  private async listing(project: Project) {
    let rows: unknown; try { rows = JSON.parse(await this.run(project, ["plugin", "list", "--json"])); } catch (error) { if (error instanceof NativeChangeError) throw error; throw new NativeChangeError("Native plugin listing is unsupported.", 503); }
    if (!Array.isArray(rows) || rows.length > 1000) throw new NativeChangeError("Native plugin listing is incomplete or too large.", 503);
    return rows.map(nativeObject);
  }
  private row(rows: Record<string, unknown>[], pluginId: string, project: Project) {
    const found = rows.filter(row => row.id === pluginId);
    if (found.length > 1) throw new NativeChangeError("Plugin has multiple native installations. Inspect its native scopes.", 409);
    const row = found[0];
    if (row && (row.scope !== "local" || row.projectPath !== project.path)) throw new NativeChangeError("Plugin belongs to another native scope or project. It will not be changed.", 409);
    return row;
  }
  private hashFiles(root: string): PluginPreview["files"] {
    projectRootIdentity(root);
    const files: PluginPreview["files"] = []; let directories = 0;
    const visit = (directory: string, relative = "") => {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name), rel = relative ? `${relative}/${name}` : name, st = lstatSync(path);
        if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink !== 1)) throw new NativeChangeError("Plugin bundle contains unsupported linked files.", 409);
        if (rel.length > 200 || rel.split("/").length > 6) throw new NativeChangeError("Plugin bundle paths exceed review limits.", 409);
        if (st.isDirectory()) { if (++directories > 12) throw new NativeChangeError("Plugin bundle has too many directories.", 409); projectRootIdentity(path); visit(path, rel); }
        else {
          if (files.length >= 10 || st.size > 32768) throw new NativeChangeError("Plugin bundle exceeds its reviewed file limits.", 409);
          const file = nativeFile(path);
          files.push({ path: rel, bytes: Buffer.byteLength(file.text!), hash: nativeHash(file.text) });
        }
      }
    };
    visit(root); return files;
  }
  private packageMatches(root: string, expected: PluginPreview["files"]) { return nativeHash(this.hashFiles(root)) === nativeHash(expected); }
  private verifyOwnership(project: Project, change: Pick<Change, "root" | "stage" | "stageIdentity" | "fileHashes" | "marketplace" | "pluginId">, phase: "marketplace" | "installed" | "uninstalled" | "removed") {
    if (projectRootIdentity(project.path) !== change.root || projectRootIdentity(change.stage) !== change.stageIdentity || !this.packageMatches(change.stage, change.fileHashes)) throw new NativeChangeError("Reviewed plugin bundle or project changed.", 409);
    const settings = nativeJson(nativeFile(join(project.path, ".claude", "settings.local.json")).text);
    const markets = nativeJson(nativeFile(join(this.nativeHome, "plugins", "known_marketplaces.json")).text);
    const entries = settings.extraKnownMarketplaces === undefined ? {} : nativeObject(settings.extraKnownMarketplaces);
    const enabled = settings.enabledPlugins === undefined ? {} : nativeObject(settings.enabledPlugins);
    for (const path of [join(this.nativeHome, "settings.json"), join(project.path, ".claude", "settings.json")]) {
      const other = nativeJson(nativeFile(path).text);
      if ((other.extraKnownMarketplaces !== undefined && nativeObject(other.extraKnownMarketplaces)[change.marketplace] !== undefined) || (other.enabledPlugins !== undefined && nativeObject(other.enabledPlugins)[change.pluginId] !== undefined)) throw new NativeChangeError("Managed plugin or marketplace also belongs to another native scope.", 409);
    }
    if (phase === "removed") {
      if (markets[change.marketplace] !== undefined || entries[change.marketplace] !== undefined || enabled[change.pluginId] !== undefined) throw new NativeChangeError("Native removal did not remove the managed local entries.", 503);
      return;
    }
    const expectedSource = { source: "directory", path: change.stage };
    for (const entry of [markets[change.marketplace], entries[change.marketplace]]) {
      const value = nativeObject(entry), source = nativeObject(value.source);
      if (source.source !== expectedSource.source || source.path !== expectedSource.path || Object.keys(source).length !== 2 || (value.installLocation !== undefined && value.installLocation !== change.stage)) throw new NativeChangeError("Native marketplace source or local ownership changed. External entries will not be removed.", 409);
    }
    if (phase === "installed" ? enabled[change.pluginId] !== true : enabled[change.pluginId] !== undefined) throw new NativeChangeError("Native local plugin enablement differs from the managed operation.", 409);
  }
  private async owned(project: Project, change: Change, rows: Record<string, unknown>[]) {
    this.verifyOwnership(project, change, change.phase === "installed" ? "installed" : "marketplace");
    if (projectRootIdentity(project.path) !== change.root || projectRootIdentity(change.stage) !== change.stageIdentity || !this.packageMatches(change.stage, change.fileHashes)) return false;
    if (nativeHash(this.fingerprints(project)) !== nativeHash(change.fingerprints)) return false;
    const row = this.row(rows, change.pluginId, project);
    if (!row && ["marketplace", "uninstalled"].includes(change.phase)) return !rows.some(row => typeof row.id === "string" && row.id.endsWith(`@${change.marketplace}`));
    if (!row || row.enabled !== true || row.version !== change.version || row.installPath !== change.installPath || row.installPath !== join(this.nativeHome, "plugins", "cache", change.marketplace, bundleName, change.version)) return false;
    const pluginPath = join(change.stage, "plugins", bundleName);
    return this.packageMatches(row.installPath, this.hashFiles(pluginPath));
  }
  async status(project: Project) {
    projectRootIdentity(project.path);
    let rows: Record<string, unknown>[] = [], available = Boolean(this.command), message = "Native plugin cache presence does not prove a running session has loaded it.";
    try { rows = await this.listing(project); } catch { available = false; message = "Native plugin listing is unavailable. Check the selected Claude CLI; no settings were changed."; }
    const changes: PluginChange[] = [];
    for (const row of this.db.prepare("SELECT data FROM native_plugin_changes WHERE projectId=? ORDER BY rowid DESC LIMIT 20").all(project.id)) {
      const saved = JSON.parse(row.data as string) as Change;
      try { saved.installed = Boolean(this.row(rows, saved.pluginId, project)); saved.canUndo = available && ["applied", "interrupted"].includes(saved.state) && await this.owned(project, saved, rows); }
      catch { saved.canUndo = false; }
      changes.push(this.publicChange(saved));
    }
    return { projectId: project.id, harness: "claude" as const, available, changes, message, observation: this.options.observations?.status(project.id), bundle: { name: bundleName, scope: "Local project", description: "The AgentKlar workflow skill, with optional Claude session tracking. Preview its exact components before installing." } };
  }
  async preview(project: Project, observeActivity = false): Promise<PluginPreview> {
    if (observeActivity && (!this.options.observations || !this.options.port)) throw new NativeChangeError("Native session tracking is unavailable in this runtime.", 503);
    const root = projectRootIdentity(project.path), rows = await this.listing(project);
    const help = await this.run(project, ["plugin", "install", "--help"]);
    if (!help.includes("--scope") || !help.includes("--json")) throw new NativeChangeError("This Claude CLI lacks the reviewed plugin commands.", 503);
    const sourceRoot = this.options.sourceRoot ?? packageRoot;
    const source = nativeFile(join(sourceRoot, skillRelative));
    if (!source.text || Buffer.byteLength(source.text) > 32768 || !source.text.startsWith("---\n") || !source.text.includes("name: agentklar-workflow")) throw new NativeChangeError("Bundled workflow skill is missing or unsupported.");
    const packageInfo = nativeJson(nativeFile(join(sourceRoot, "package.json")).text), version = packageInfo.version;
    if (packageInfo.name !== "agentklar" || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new NativeChangeError("Bundled release version is unsupported.");
    const marketplace = `agentklar-local-${nativeHash(project.id).slice(0, 12)}`, pluginId = `${bundleName}@${marketplace}`;
    if (rows.some(row => row.id === pluginId)) throw new NativeChangeError("This workflow plugin is already installed. Inspect its native scope before replacing it.", 409);
    for (const [id, saved] of this.previews) if (Date.parse(saved.expiresAt) <= Date.now()) this.previews.delete(id);
    if (this.previews.size >= 20) throw new NativeChangeError("Too many open plugin previews.", 409);
    projectRootIdentity(this.home);
    const stage = join(this.home, "plugin-bundles", randomUUID()), plugin = join(stage, "plugins", bundleName);
    nativeFile(join(stage, ".guard"));
    mkdirSync(join(stage, ".claude-plugin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(plugin, "skills", bundleName), { recursive: true, mode: 0o700 });
    const manifest = { name: bundleName, version, description: "Coordinate existing AgentKlar projects through native MCP tools", author: { name: "AgentKlar" } };
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    writeFileSync(join(plugin, skillRelative), source.text, { flag: "wx", mode: 0o600 });
    const observeToken = observeActivity ? randomBytes(32).toString("hex") : undefined;
    if (observeToken) {
      mkdirSync(join(plugin, "hooks"), { mode: 0o700 });
      mkdirSync(join(plugin, "scripts"), { mode: 0o700 });
      writeFileSync(join(plugin, "scripts", "observe.cjs"), observationHookScript, { flag: "wx", mode: 0o600 });
      writeFileSync(join(plugin, "scripts", "observation.json"), JSON.stringify({ cwd: project.path, url: `http://127.0.0.1:${this.options.port}/api/native-observe/${project.id}`, token: observeToken }), { flag: "wx", mode: 0o600 });
      const hooks = Object.fromEntries(observationEvents.map(event => [event, [{ ...(event === "Notification" ? { matcher: "permission_prompt" } : {}), hooks: [{ type: "command", command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/scripts/observe.cjs"], timeout: 2 }] }]]));
      writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    writeFileSync(join(stage, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: marketplace, owner: { name: "AgentKlar" }, description: "Reviewed local AgentKlar workflow bundle", plugins: [{ name: bundleName, source: `./plugins/${bundleName}`, version }] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await this.run(project, ["plugin", "validate", stage]);
    if (projectRootIdentity(project.path) !== root) throw new NativeChangeError("Project changed during plugin preview.", 409);
    const files = this.hashFiles(stage), preview: Preview = { id: randomUUID(), projectId: project.id, harness: "claude", name: bundleName, version, source: `bundled:agentklar@${version}`, sourceHash: nativeHash(files), pluginId, scope: "Local project", files, manifest, capabilities: { skills: [bundleName], agents: 0, hooks: observeActivity ? observationEvents.length : 0, mcpServers: 0 }, commands: [["plugin", "marketplace", "add", stage, "--scope", "local"], ["plugin", "install", pluginId, "--scope", "local", "--json"]], expiresAt: new Date(Date.now() + 600000).toISOString(), message: observeActivity ? "Tracks Claude session start, responding, permission waiting, reply end and session end in Work. Prompts and transcripts are discarded before sending. No approvals or workers are created. Restart the native session to load the hooks." : "Installs a real native plugin for this project. Native permissions still apply. Start a new native session or reload plugins; no model call is made here.", root, stage, stageIdentity: projectRootIdentity(stage), fingerprints: this.fingerprints(project), marketplace, observeToken };
    this.previews.set(preview.id, preview);
    const { root: identity, stage: path, stageIdentity, fingerprints, marketplace: name, observeToken: secret, ...safe } = preview; return safe;
  }
  private result(output: string, operation: string, pluginId: string) {
    let value: Record<string, unknown>; try { value = nativeObject(JSON.parse(output)); } catch { throw new NativeChangeError("Native plugin receipt is unsupported.", 503); }
    if (value.command !== operation || value.outcome !== "ok" || value.pluginId !== pluginId || value.scope !== "local") throw new NativeChangeError("Native plugin receipt did not confirm this exact operation.", 503);
  }
  async apply(project: Project, id: string): Promise<PluginChange> {
    return guardNativeChange(async () => {
      const preview = this.previews.get(id);
      if (!preview || preview.projectId !== project.id || Date.parse(preview.expiresAt) <= Date.now()) throw new NativeChangeError("Plugin preview expired or was not found.", 404);
      const rows = await this.listing(project);
      if (rows.some(row => row.id === preview.pluginId) || projectRootIdentity(project.path) !== preview.root || projectRootIdentity(preview.stage) !== preview.stageIdentity || !this.packageMatches(preview.stage, preview.files) || nativeHash(this.fingerprints(project)) !== nativeHash(preview.fingerprints)) throw new NativeChangeError("Native plugin, staged bundle or settings changed. Preview again.", 409);
      const { commands, expiresAt, manifest, files, observeToken, ...rest } = preview;
      const change: Change = { ...rest, id: randomUUID(), state: "prepared", phase: "prepared", createdAt: new Date().toISOString(), installed: false, recognized: false, canUndo: false, installPath: null, fileHashes: files, sourceSkillHash: files.find(file => file.path.endsWith(skillRelative))!.hash };
      this.save(change); this.previews.delete(id);
      try {
        for (const args of commands) {
          const output = await this.run(project, args);
          if (args[1] === "install") { this.result(output, "install", change.pluginId); this.verifyOwnership(project, change, "installed"); }
          else { this.verifyOwnership(project, change, "marketplace"); change.phase = "marketplace"; change.fingerprints = this.fingerprints(project); this.save(change); }
        }
        const row = this.row(await this.listing(project), change.pluginId, project);
        if (!row || row.version !== change.version || row.enabled !== true || row.installPath !== join(this.nativeHome, "plugins", "cache", change.marketplace, bundleName, change.version)) throw new NativeChangeError("Native listing did not confirm the exact enabled plugin.", 503);
        change.phase = "installed";
        change.installPath = row.installPath;
        if (!this.packageMatches(change.installPath, this.hashFiles(join(change.stage, "plugins", bundleName)))) throw new NativeChangeError("Native installed plugin content differs from the preview.", 503);
        const details = await this.run(project, ["plugin", "details", bundleName]);
        if (!details.includes(change.pluginId) || !/Skills \(1\)\s+agentklar-workflow/.test(details) || !new RegExp(`Hooks \\(${change.capabilities.hooks}\\)`).test(details) || !/MCP servers \(0\)/.test(details) || !/Agents \(0\)/.test(details)) throw new NativeChangeError("Native component recognition was not confirmed.", 503);
        this.verifyOwnership(project, change, "installed");
        change.fingerprints = this.fingerprints(project); change.installed = true; change.recognized = true; change.canUndo = true; change.state = "applied";
        change.message = "Native listing and component inventory recognize the reviewed plugin. Start a new native session to use it; no model execution was tested.";
        if (observeToken) this.options.observations!.enable(project, observeToken, change.id);
      } catch (error) {
        this.options.observations?.disable(project.id, change.id);
        change.state = "interrupted"; change.message = "Native plugin change did not finish. Its private bundle and receipt remain for inspection; no automatic replacement or rollback ran.";
        try { const row = this.row(await this.listing(project), change.pluginId, project); if (row?.version === change.version && row.enabled === true && row.installPath === join(this.nativeHome, "plugins", "cache", change.marketplace, bundleName, change.version) && this.packageMatches(String(row.installPath), this.hashFiles(join(change.stage, "plugins", bundleName)))) { this.verifyOwnership(project, change, "installed"); change.phase = "installed"; change.installPath = String(row.installPath); change.installed = true; change.fingerprints = this.fingerprints(project); change.canUndo = true; } else if (!row) { this.verifyOwnership(project, change, "marketplace"); change.phase = "marketplace"; change.fingerprints = this.fingerprints(project); change.canUndo = true; } } catch {}
        this.save(change); throw error;
      }
      this.save(change); return this.publicChange(change);
    });
  }
  async undo(project: Project, id: string): Promise<PluginChange> {
    return guardNativeChange(async () => {
      const row = this.db.prepare("SELECT data FROM native_plugin_changes WHERE id=? AND projectId=?").get(id, project.id);
      if (!row) throw new NativeChangeError("Native plugin change not found.", 404);
      const change = JSON.parse(row.data as string) as Change;
      if (!["applied", "interrupted"].includes(change.state) || !await this.owned(project, change, await this.listing(project))) throw new NativeChangeError("Native plugin or settings changed. Undo will not overwrite them.", 409);
      this.options.observations?.disable(project.id, change.id);
      change.state = "undoing"; change.canUndo = false; this.save(change);
      try {
        if (change.phase === "installed") {
          this.result(await this.run(project, ["plugin", "uninstall", change.pluginId, "--scope", "local", "--json", "--keep-data"]), "uninstall", change.pluginId);
          if ((await this.listing(project)).some(row => row.id === change.pluginId)) throw new NativeChangeError("Native uninstall did not remove the managed plugin.", 503);
          this.verifyOwnership(project, change, "uninstalled");
          change.phase = "uninstalled"; change.installed = false; change.fingerprints = this.fingerprints(project); this.save(change);
        }
        this.verifyOwnership(project, change, "uninstalled");
        await this.run(project, ["plugin", "marketplace", "remove", change.marketplace, "--scope", "local"]);
        this.verifyOwnership(project, change, "removed");
        change.installed = false; change.state = "undone"; change.message = "Managed native plugin and marketplace removed. Native plugin data and cache policy remain with Claude.";
      } catch (error) {
        change.state = "interrupted"; change.message = "Native plugin undo did not finish. Inspect its native registry and saved receipt.";
        if (change.phase === "installed") {
          try {
            const rows = await this.listing(project);
            if (!rows.some(row => row.id === change.pluginId || (typeof row.id === "string" && row.id.endsWith(`@${change.marketplace}`)))) {
              this.verifyOwnership(project, change, "uninstalled");
              change.phase = "uninstalled"; change.installed = false; change.fingerprints = this.fingerprints(project); change.canUndo = true;
            }
          } catch {}
        }
        this.save(change); throw error;
      }
      this.save(change); return this.publicChange(change);
    });
  }
}
