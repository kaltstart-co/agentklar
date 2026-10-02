import { randomUUID, createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { executables } from "./harnesses.ts";
import { workerHarnesses, type NativeInstallation, type NativeInstallationStatus } from "./contracts.ts";

export { workerHarnesses };
const versions = new Map<string, string | null>();
export function installationFingerprint(path: string): string | null {
  try {
    accessSync(path, constants.X_OK);
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return createHash("sha256").update(JSON.stringify([realpathSync(path), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode])).digest("hex");
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
  return {
    device,
    selected(harness: string, fallback: string | null) {
      const path = saved(harness);
      if (path === null) return fallback;
      return selectedInstallation(harness, path);
    },
    status(commands: Record<string, string | null>): NativeInstallationStatus[] {
      return workerHarnesses.map((harness) => ({ harness, selected: commands[harness] ?? null, saved: saved(harness), restartRequired: saved(harness) !== null && this.selected(harness, null) !== commands[harness], installations: nativeInstallations(harness) }));
    },
    save(harness: string, path: string, fingerprint: string) {
      if (!workerHarnesses.includes(harness as typeof workerHarnesses[number]) || !executables(harness).includes(path) || installationFingerprint(path) !== fingerprint) return false;
      db.prepare("INSERT INTO native_installations VALUES(?,?,?) ON CONFLICT(harness) DO UPDATE SET path=excluded.path,fingerprint=excluded.fingerprint").run(harness, path, fingerprint);
      return true;
    },
  };
}
