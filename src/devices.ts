import { randomUUID, createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { executables } from "./harnesses.ts";
import { workerHarnesses, type NativeInstallation, type NativeInstallationStatus } from "./contracts.ts";

export { workerHarnesses };
const versions = new Map<string, string | null>();
function fileIdentity(path: string) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Not a file");
  return [realpathSync(path), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
}
function npmPackageIdentity(entry: string) {
  let folder = dirname(entry);
  for (let n = 0; n < 6 && folder.includes("/node_modules/"); n++, folder = dirname(folder)) {
    try { return fileIdentity(join(folder, "package.json")); } catch {}
  }
  return null;
}
export function installationFingerprint(path: string): string | null {
  try {
    accessSync(path, constants.X_OK);
    const identity = fileIdentity(path), entry = String(identity[0]), related: unknown[] = [];
    // npm normally links its entry point. Include its package metadata so a
    // stable entry script cannot keep an obsolete cached --version result.
    if (entry.includes("/node_modules/")) related.push(npmPackageIdentity(entry));
    // Some npm installations use a small shell wrapper instead of a symlink.
    // Inspect only literal basedir targets; never run a shell to resolve them.
    if (Number(identity[3]) <= 65536) {
      const text = readFileSync(entry, "utf8");
      if (text.startsWith("#!") && /\b(?:sh|bash)\b/.test(text.split("\n", 1)[0]!)) {
        for (const match of text.matchAll(/\$(?:basedir|\{basedir\})(\/[^"'\s]*?node_modules\/[^"'\s]+)/g)) {
          if (related.length >= 8) break;
          const target = resolve(dirname(entry), "." + match[1]);
          try { const targetIdentity = fileIdentity(target); related.push([targetIdentity, npmPackageIdentity(String(targetIdentity[0]))]); } catch { related.push([target, "missing"]); }
        }
      }
    }
    return createHash("sha256").update(JSON.stringify([identity, related])).digest("hex");
  } catch { return null; }
}
export function nativeInstallations(harness: string): NativeInstallation[] {
  return executables(harness).flatMap((path) => {
    const fingerprint = installationFingerprint(path);
    if (!fingerprint) return [];
    if (!versions.has(fingerprint)) {
      const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
      // Keep only a version number, never arbitrary native diagnostics.
      versions.set(fingerprint, result.status === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null : null);
    }
    return [{ path, fingerprint, version: versions.get(fingerprint)! }];
  });
}
export function selectedInstallation(harness: string, path: string, candidates = executables(harness)): string | null {
  // Desktop replaces its versioned CLI folder during normal updates. Keep
  // the chosen app installation, rather than pinning an obsolete version.
  const family = harness === "claude" ? path.match(/^(.*\/Claude\/claude-code)\/\d+\.\d+\.\d+\/claude\.app\/Contents\/MacOS\/claude$/)?.[1] : undefined;
  if (family) return candidates.find((candidate) => candidate.startsWith(family + "/") && /^\d+\.\d+\.\d+\/claude\.app\/Contents\/MacOS\/claude$/.test(candidate.slice(family.length + 1)) && installationFingerprint(candidate)) ?? null;
  return installationFingerprint(path) ? path : null;
}
export function deviceSettings(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS local_device(id INTEGER PRIMARY KEY CHECK(id=1), deviceId TEXT NOT NULL); CREATE TABLE IF NOT EXISTS native_installations(harness TEXT PRIMARY KEY,path TEXT NOT NULL,fingerprint TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO local_device VALUES(1,?)").run(randomUUID());
  const device = { id: String(db.prepare("SELECT deviceId FROM local_device WHERE id=1").get()!.deviceId), label: hostname(), platform: process.platform };
  const saved = (harness: string) => (db.prepare("SELECT path FROM native_installations WHERE harness=?").get(harness)?.path as string | undefined) ?? null;
  const baseline = new Map<string, { path: string | null; fingerprint: string | null; version: string | null }>();
  function remember(harness: string, path: string | null) {
    if (!baseline.has(harness)) {
      const fingerprint = path ? installationFingerprint(path) : null;
      baseline.set(harness, { path, fingerprint, version: fingerprint ? versions.get(fingerprint) ?? null : null });
    }
    return baseline.get(harness)!;
  }
  return {
    device,
    selected(harness: string, fallback: string | null) {
      const path = saved(harness);
      const selected = path === null ? fallback : selectedInstallation(harness, path);
      remember(harness, selected);
      return selected;
    },
    status(commands: Record<string, string | null>): NativeInstallationStatus[] {
      return workerHarnesses.map((harness) => {
        const selected = commands[harness] ?? null, start = remember(harness, selected);
        const installations = nativeInstallations(harness);
        const choice = saved(harness) ?? start.path ?? installations[0]?.path ?? null;
        const path = choice ? selectedInstallation(harness, choice) : null;
        const fingerprint = path ? installationFingerprint(path) : null;
        if (start.fingerprint && versions.has(start.fingerprint)) start.version = versions.get(start.fingerprint)!;
        const current = { path, fingerprint, version: fingerprint ? versions.get(fingerprint) ?? null : null };
        const changed = path !== start.path || fingerprint !== start.fingerprint;
        return { harness, selected, saved: saved(harness), restartRequired: changed, changed, baseline: { ...start }, current, installations };
      });
    },
    save(harness: string, path: string, fingerprint: string) {
      if (!workerHarnesses.includes(harness as typeof workerHarnesses[number]) || !executables(harness).includes(path) || installationFingerprint(path) !== fingerprint) return false;
      db.prepare("INSERT INTO native_installations VALUES(?,?,?) ON CONFLICT(harness) DO UPDATE SET path=excluded.path,fingerprint=excluded.fingerprint").run(harness, path, fingerprint);
      return true;
    },
  };
}
