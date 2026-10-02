import {
  constants, openSync, closeSync, fstatSync, lstatSync, readSync,
  opendirSync, realpathSync, type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import type { NativeInventory, NativeInventorySource, SetupHarness } from "./contracts.ts";

type Group = NativeInventory["harnesses"][number];
type Scope = NativeInventorySource["scope"];
type Kind = NativeInventorySource["kind"];
export type InventoryOptions = {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  /** Test-only mutation between the opening and final consistency checks. */
  beforeRead?: (path: string) => void;
};
const maxManifestBytes = 32 * 1024;
const maxTotalBytes = 256 * 1024;
const maxSources = 40;
const maxExtensions = 24;
const maxDirectories = 200;
const maxResponseCharacters = 22000;
const pathLimit = 160;
const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.@/-]{0,119}$/.test(value) ? value : null;
const stamp = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const statusFor = (error: unknown): NativeInventorySource["status"] =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";

// Check every existing ancestor. Do not follow a native symlink or special file.
function checked(path: string, directory: boolean): { status: NativeInventorySource["status"]; stat?: Stats } {
  if (!isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path)) return { status: "unsupported" };
  try {
    const root = parse(path).root;
    const pieces = path.slice(root.length).split(/[\\/]/).filter(Boolean);
    let current = root;
    for (let i = 0; i < pieces.length; i++) {
      current = join(current, pieces[i]);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory())) return { status: "unsafe" };
      if (i === pieces.length - 1) {
        if (directory ? !stat.isDirectory() : !stat.isFile()) return { status: "unsafe" };
        if (realpathSync(current) !== current) return { status: "unsafe" };
        return { status: "present", stat };
      }
    }
    return { status: "unsafe" };
  } catch (error) { return { status: statusFor(error) }; }
}

export function nativeInventory(projectId: string, projectPath: string, options: InventoryOptions = {}): NativeInventory {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? env.HOME ?? homedir();
  const result: NativeInventory = { projectId, checkedAt: new Date().toISOString(), activationUnknown: true, harnesses: [], truncated: false };
  let bytes = 0, sources = 0, extensions = 0, directories = 0, manifestFiles = 0;
  const group = (harness: SetupHarness, coverage: string[]): Group => {
    const value: Group = { harness, sources: [], extensions: [], extensionsTruncated: false, coverage };
    result.harnesses.push(value);
    return value;
  };
  const shortened = (path: string) => ({ path: path.slice(0, pathLimit), pathTruncated: path.length > pathLimit });
  const note = (g: Group, path: string | null, scope: Scope, kind: Kind, status: NativeInventorySource["status"], inspection: "metadata" | "manifest" = "metadata") => {
    if (sources >= maxSources) { result.truncated = true; return; }
    const entry: NativeInventorySource = {
      ...(path === null ? { path: null, pathTruncated: false } : shortened(path)), scope, kind, status, inspection,
      message: inspection === "metadata" ? "File presence only; values are not inspected." : "Only package name and version are inspected.",
    };
    g.sources.push(entry);
    if (JSON.stringify(result).length > maxResponseCharacters) { g.sources.pop(); result.truncated = true; return; }
    sources++;
  };
  const metadata = (g: Group, path: string | null, scope: Scope, kind: Kind, directory = false) => {
    if (path === null) { note(g, null, scope, kind, "unsupported"); return; }
    const found = checked(path, directory);
    let status = found.status;
    if (found.stat && !directory) {
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = fstatSync(fd);
        const after = checked(path, false);
        if (!opened.isFile() || stamp(opened) !== stamp(found.stat) || !after.stat || stamp(after.stat) !== stamp(opened)) status = "changed";
      } catch (error) { status = statusFor(error); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    note(g, path, scope, kind, status);
  };
  const manifest = (g: Group, path: string, scope: "user" | "project", evidence: "cached-package" | "project-manifest") => {
    if (extensions >= maxExtensions || manifestFiles >= 64) { g.extensionsTruncated = true; result.truncated = true; return; }
    manifestFiles++;
    const found = checked(path, false);
    if (!found.stat) { note(g, path, scope, "plugin-manifest", found.status, "manifest"); return; }
    if (found.stat.size > maxManifestBytes || bytes + found.stat.size > maxTotalBytes) {
      note(g, path, scope, "plugin-manifest", "oversized", "manifest");
      g.extensionsTruncated = true; result.truncated = true; return;
    }
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!opened.isFile() || stamp(opened) !== stamp(found.stat)) { note(g, path, scope, "plugin-manifest", "changed", "manifest"); return; }
      const buffer = Buffer.alloc(opened.size);
      options.beforeRead?.(path);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, size);
        if (!n) break;
        size += n;
      }
      bytes += size;
      const after = checked(path, false);
      if (size !== buffer.length || stamp(fstatSync(fd)) !== stamp(opened) || !after.stat || stamp(after.stat) !== stamp(opened)) {
        note(g, path, scope, "plugin-manifest", "changed", "manifest"); return;
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid manifest");
      const name = identifier((value as Record<string, unknown>).name);
      if (!name) { note(g, path, scope, "plugin-manifest", "invalid", "manifest"); return; }
      const version = identifier((value as Record<string, unknown>).version);
      note(g, path, scope, "plugin-manifest", "present", "manifest");
      const entry = { name, version, sourcePath: path.slice(0, pathLimit), pathTruncated: path.length > pathLimit, scope, evidence, activationUnknown: true as const };
      g.extensions.push(entry);
      if (JSON.stringify(result).length > maxResponseCharacters) { g.extensions.pop(); result.truncated = true; g.extensionsTruncated = true; return; }
      extensions++;
    } catch (error) {
      note(g, path, scope, "plugin-manifest", error instanceof SyntaxError || error instanceof TypeError ? "invalid" : "unreadable", "manifest");
    } finally { if (fd !== undefined) closeSync(fd); }
  };
  const children = (g: Group, path: string): string[] => {
    if (directories >= maxDirectories) { g.extensionsTruncated = true; result.truncated = true; return []; }
    const before = checked(path, true);
    if (!before.stat) return [];
    directories++;
    const names: string[] = [];
    let dir: ReturnType<typeof opendirSync> | undefined;
    try {
      dir = opendirSync(path);
      for (let i = 0; i <= 64; i++) {
        const item = dir.readSync();
        if (!item) break;
        if (i === 64) { g.extensionsTruncated = true; result.truncated = true; break; }
        if (item.isDirectory() && item.name !== "node_modules" && !item.name.startsWith(".")) names.push(item.name);
      }
      const after = checked(path, true);
      if (!after.stat || stamp(after.stat) !== stamp(before.stat)) { note(g, path, "user", "plugin-cache", "changed"); return []; }
      return names;
    } catch { note(g, path, "user", "plugin-cache", "unreadable"); return []; }
    finally { dir?.closeSync(); }
  };
  const cache = (g: Group, root: string | null, compatibility: string, portableManifest = true) => {
    metadata(g, root, "user", "plugin-cache", true);
    if (!root) return;
    // Native layout: marketplace/package/version. Never descend into package code.
    for (const market of children(g, root)) for (const name of children(g, join(root, market))) for (const version of children(g, join(root, market, name))) {
      if (extensions >= maxExtensions || manifestFiles >= 64) { g.extensionsTruncated = true; result.truncated = true; return; }
      const packageRoot = join(root, market, name, version);
      const portable = join(packageRoot, "plugin.json");
      const path = !portableManifest || checked(portable, false).status === "missing" ? join(packageRoot, compatibility, "plugin.json") : portable;
      manifest(g, path, "user", "cached-package");
    }
  };
  const home = (variable: string, fallback: string) => {
    const value = env[variable] === undefined ? fallback : env[variable]!;
    return isAbsolute(value) && !/[\0\r\n]/.test(value) ? value : null;
  };
  const source = (root: string | null, ...parts: string[]) => root === null ? null : join(root, ...parts);
  const codexHome = home("CODEX_HOME", join(userHome, ".codex"));
  const claudeHome = home("CLAUDE_CONFIG_DIR", join(userHome, ".claude"));
  const xdg = home("XDG_CONFIG_HOME", join(userHome, ".config"));
  const codex = group("codex", ["Known user/project files and cached packages only. Cache presence does not prove installation or activation.", "TOML is not parsed. Ancestor, managed and session overrides are outside this inventory."]);
  metadata(codex, source(codexHome, "config.toml"), "user", "config");
  metadata(codex, join(projectPath, ".codex", "config.toml"), "project", "config");
  metadata(codex, join(userHome, ".agents", "plugins", "marketplace.json"), "user", "marketplace");
  metadata(codex, join(projectPath, ".agents", "plugins", "marketplace.json"), "project", "marketplace");
  metadata(codex, join(projectPath, ".claude-plugin", "marketplace.json"), "project", "marketplace");
  const claude = group("claude", ["Known user/project files and cache manifests only; activation is unknown.", "Desktop synced packages, installed registries, managed settings, ancestors and session overrides are not resolved."]);
  metadata(claude, source(claudeHome, "settings.json"), "user", "config");
  metadata(claude, source(env.CLAUDE_CONFIG_DIR === undefined ? userHome : claudeHome, ".claude.json"), "user", "config");
  metadata(claude, join(projectPath, ".claude", "settings.json"), "project", "config");
  metadata(claude, join(projectPath, ".claude", "settings.local.json"), "project", "config");
  metadata(claude, join(projectPath, ".mcp.json"), "project", "config");
  metadata(claude, source(claudeHome, "plugins", "synced"), "user", "desktop-sync", true);
  const muse = group("muse", ["Known config file presence only. Extension metadata and effective settings are not verified."]);
  metadata(muse, source(xdg, "muse", "settings.json"), "user", "config");
  metadata(muse, join(projectPath, ".mcp.json"), "project", "config");
  const opencode = group("opencode", ["Known local files/directories only; extension names and activation are not inspected.", "Remote, inline, ancestor and managed layers are outside this inventory."]);
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    metadata(opencode, source(xdg, "opencode", file), "user", "config");
    metadata(opencode, join(projectPath, file), "project", "config");
    metadata(opencode, join(projectPath, ".opencode", file), "project", "config");
  }
  metadata(opencode, join(projectPath, ".opencode", "plugins"), "project", "extension-directory", true);
  metadata(opencode, join(projectPath, ".opencode", "skills"), "project", "extension-directory", true);
  if (env.OPENCODE_CONFIG !== undefined) metadata(opencode, home("OPENCODE_CONFIG", ""), "environment", "config");
  if (env.OPENCODE_CONFIG_DIR !== undefined) metadata(opencode, home("OPENCODE_CONFIG_DIR", ""), "environment", "extension-directory", true);
  const antigravity = group("antigravity", ["Known MCP source presence only. Worker extension coverage and activation are unknown."]);
  metadata(antigravity, join(userHome, ".gemini", "config", "mcp_config.json"), "user", "config");
  metadata(antigravity, join(projectPath, ".agents", "mcp_config.json"), "project", "config");
  // Inspect fixed manifests after config sources so a large cache cannot hide them.
  manifest(claude, join(projectPath, ".claude-plugin", "plugin.json"), "project", "project-manifest");
  cache(codex, source(codexHome, "plugins", "cache"), ".codex-plugin");
  cache(claude, source(claudeHome, "plugins", "cache"), ".claude-plugin", false);
  return result;
}
