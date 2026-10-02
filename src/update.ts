import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { managedUpdate, privateText, readUpdateMaintenance, type UpdateService } from "./launchd.ts";

const repository = "kaltstart-co/agentklar";
const releasesUrl = `https://api.github.com/repos/${repository}/releases?per_page=100`;
export const dataCompatibility = 1;
const root = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
export const currentVersion: string = manifest.version;
export type Installation = { mode: "global-npm" | "source" | "unsupported"; supported: boolean; reason: string };
export type Release = { version: string; url: string; checksumUrl: string };
export type UpdateStatus = { lifecycle: "managed" | "foreground" | "source" | "unsupported"; current: string; latest: string | null; checkedAt: string | null; available: boolean; installation: Installation; command: string; error?: string };

export function versionParts(value: unknown): number[] {
  if (typeof value !== "string") throw new Error("Unsupported release version.");
  const match = /^(0)\.(1)\.(0)(?:-beta\.(0|[1-9][0-9]{0,5}))?$/.exec(value);
  if (!match) throw new Error("Unsupported release version.");
  return [0, 1, 0, match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4])];
}
export function newer(a: string, b: string) { return versionParts(a)[3]! > versionParts(b)[3]!; }
function run(program: string, args: string[], timeout = 180000) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024, shell: false });
  if (result.error || result.status !== 0) throw new Error(`${program === "npm" ? "npm" : "Package check"} failed. No native settings were changed.`);
  return result.stdout.trim();
}
export function installation(packageRoot = root, npmRoot = () => run("npm", ["root", "-g"], 10000)): Installation {
  try {
    const actual = realpathSync(packageRoot);
    if (!actual.endsWith("/lib/node_modules/agentklar")) return { mode: "source", supported: false, reason: "Source checkout: update the checkout, run npm ci and npm run build, then restart." };
    const parent = dirname(actual);
    const prefix = dirname(dirname(parent));
    const entry = join(prefix, "bin", "agentklar");
    if (process.getuid?.() === 0 || !lstatSync(resolve(packageRoot)).isDirectory() || lstatSync(resolve(packageRoot)).isSymbolicLink() ||
        realpathSync(npmRoot()) !== parent || !lstatSync(entry).isSymbolicLink() || realpathSync(entry) !== join(actual, "bin", "agentklar.mjs"))
      throw new Error("unsupported");
    accessSync(parent, constants.W_OK); accessSync(actual, constants.W_OK);
    return { mode: "global-npm", supported: true, reason: "Run agentklar update in a terminal. Managed macOS startup restarts after the update; stop a foreground service first." };
  } catch { return { mode: "unsupported", supported: false, reason: "Automatic updates require a writable regular global npm install and its matching CLI. Do not use sudo." }; }
}
export async function boundedDownload(url: string, maximum: number, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const signal = AbortSignal.timeout(15000);
  let destination = url;
  let response: Response | undefined;
  const allowed = new Set(["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(destination);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !allowed.has(parsed.hostname)) throw new Error("Unexpected official download destination.");
    response = await fetcher(destination, { signal, credentials: "omit", headers: { Accept: parsed.hostname === "api.github.com" ? "application/vnd.github+json" : "application/octet-stream", "User-Agent": "AgentKlar-update" }, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("Official download redirected too many times.");
    destination = new URL(location, destination).href;
  }
  if (!response?.ok || !response.body) throw new Error("Official release download failed. Retry later.");
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximum) throw new Error("Official release download is too large.");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}
export function selectRelease(value: unknown): Release {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid official release list.");
  const candidates: Release[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || item.draft !== false || typeof item.tag_name !== "string") continue;
    const version = item.tag_name.slice(1);
    try { if (item.tag_name !== `v${version}`) continue; versionParts(version); } catch { continue; }
    if (item.prerelease !== version.includes("-beta.")) continue;
    if (!Array.isArray(item.assets) || item.assets.length > 100) continue;
    const base = `https://github.com/${repository}/releases/download/v${version}/`;
    const asset = `agentklar-${version}.tgz`;
    const exact = (name: string) => item.assets.filter((a: any) => a && a.name === name && a.browser_download_url === base + name).length === 1;
    if (exact(asset) && exact("SHA256.txt")) candidates.push({ version, url: base + asset, checksumUrl: base + "SHA256.txt" });
  }
  candidates.sort((a, b) => versionParts(b.version)[3]! - versionParts(a.version)[3]!);
  if (!candidates[0]) throw new Error("No supported official release with verification files was found.");
  return candidates[0];
}
export async function latestRelease(fetcher: typeof fetch = fetch) {
  return selectRelease(JSON.parse((await boundedDownload(releasesUrl, 1024 * 1024, fetcher)).toString("utf8")));
}
export function verifyArchive(release: Release, archive: Buffer, checksum: string) {
  const name = `agentklar-${release.version}.tgz`;
  const entries = checksum.trim().split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *]([^\s]+)$/.exec(line));
  const matches = entries.filter(entry => entry?.[2] === name);
  if (matches.length !== 1 || matches[0]![1]!.toLowerCase() !== createHash("sha256").update(archive).digest("hex"))
    throw new Error("Release checksum did not match. The installed package was kept.");
}
export function validatePackage(path: string, version: string) {
  const packageFile = join(path, "package.json");
  if (!lstatSync(packageFile).isFile() || lstatSync(packageFile).isSymbolicLink()) throw new Error("Invalid staged package.");
  const data = JSON.parse(readFileSync(packageFile, "utf8"));
  if (data.name !== "agentklar" || data.version !== version || data.engines?.node !== ">=24 <25" || data.agentklarDataCompatibility !== dataCompatibility || data.bin?.agentklar !== "bin/agentklar.mjs")
    throw new Error("Release package or data compatibility is unsupported. The installed package was kept.");
  for (const entry of ["bin/agentklar.mjs", "dist/server/server.js", "dist/server/mcp.js", "dist/server/update.js", "dist/web/index.html"]) {
    const st = lstatSync(join(path, entry));
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("A release entry point is invalid.");
  }
}
let status: UpdateStatus | undefined;
let checkPending: Promise<UpdateStatus> | undefined;
export function updateStatus(): UpdateStatus {
  const mode = status?.installation || installation();
  const lifecycle = mode.supported ? (process.env.AGENTKLAR_SERVICE_ID ? "managed" : "foreground") : mode.mode === "source" ? "source" : "unsupported";
  return structuredClone(status || { lifecycle, current: currentVersion, latest: null, checkedAt: null, available: false, installation: mode, command: "agentklar update" });
}
export function checkUpdate(fetcher: typeof fetch = fetch): Promise<UpdateStatus> {
  return checkPending ??= (async () => {
    try {
      const release = await latestRelease(fetcher);
      status = { lifecycle: updateStatus().lifecycle, current: currentVersion, latest: release.version, checkedAt: new Date().toISOString(), available: newer(release.version, currentVersion), installation: installation(), command: "agentklar update" };
    } catch {
      status = { lifecycle: updateStatus().lifecycle, current: currentVersion, latest: null, checkedAt: new Date().toISOString(), available: false, installation: installation(), command: "agentklar update", error: "Could not check the official release. Retry later." };
    }
    return updateStatus();
  })().finally(() => { checkPending = undefined; });
}
export function serviceLock(home: string): () => void {
  const path = join(home, "service-lock.sqlite");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try { db.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE"); }
  catch { db.close(); throw new Error("AgentKlar is running. Finish work and stop the foreground service before updating."); }
  return () => db.close();
}

type Lifecycle = { info?: UpdateService; paused?: () => boolean; running: boolean; stop: () => Promise<void>; start: (version: string, commit?: () => void) => Promise<void> };
export async function swapPackage(target: string, replacement: string, recovery: string, lifecycle?: Lifecycle, lock?: string, home?: string) {
  const previous = join(recovery, "previous");
  const journal = join(recovery, "journal.json");
  const original = statSync(target); const staged = statSync(replacement);
  if (original.dev !== staged.dev || original.isDirectory() === false || staged.isDirectory() === false || lstatSync(target).isSymbolicLink() || lstatSync(replacement).isSymbolicLink()) throw new Error("Update needs regular package folders on the same filesystem.");
  const oldVersion = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
  const nextVersion = JSON.parse(readFileSync(join(replacement, "package.json"), "utf8")).version;
  const record = (phase: string) => {
    const temporary = join(recovery, "journal-next.json");
    writeFileSync(temporary, JSON.stringify({ phase, target, replacement, previous, recovery, home, service: lifecycle?.info, oldVersion, nextVersion, original: { dev: original.dev, ino: original.ino }, staged: { dev: staged.dev, ino: staged.ino } }), { mode: 0o600 });
    renameSync(temporary, journal);
    if (lock) writeFileSync(join(lock, "recovery.json"), JSON.stringify({ recovery, target, pid: process.pid, journalHash: createHash("sha256").update(readFileSync(journal)).digest("hex") }), { mode: 0o600 });
  };
  let movedOld = false, movedNew = false, stopped = false;
  record("prepared");
  if (lock) console.log(`Recovery command (keeps saved work): ${recoveryCommand(recovery)}`);
  try {
    if (lifecycle?.running) { await lifecycle.stop(); stopped = true; }
    record("stopped");
    const before = lstatSync(target), ready = lstatSync(replacement);
    if (before.dev !== original.dev || before.ino !== original.ino || ready.dev !== staged.dev || ready.ino !== staged.ino) throw new Error("Package folders changed before update.");
    renameSync(target, previous); movedOld = true; record("old-saved");
    renameSync(replacement, target); movedNew = true; record("replaced");
    if (stopped) await lifecycle!.start(nextVersion, () => record("committed"));
    record("complete");
  } catch (error) {
    if (["committed", "complete"].includes(JSON.parse(privateText(journal)).phase)) throw new Error(`The updated package is committed. Run ${recoveryCommand(recovery)} to check and resume it. No package rollback was attempted.`);
    try {
      if (movedNew) {
        if (lifecycle && stopped) await lifecycle.stop();
        const current = lstatSync(target);
        if (current.dev !== staged.dev || current.ino !== staged.ino) throw new Error("Replacement package changed.");
        renameSync(target, replacement);
      }
      if (movedOld) {
        const old = lstatSync(previous);
        if (existsSync(target) || old.dev !== original.dev || old.ino !== original.ino) throw new Error("Previous package changed.");
        renameSync(previous, target);
      }
      if (stopped || lifecycle?.paused?.()) await lifecycle!.start(oldVersion);
      record("restored");
    } catch { record("recovery-required"); throw new Error(`Update could not restore the previous service. Recovery files were kept at ${recovery}.`); }
    throw new Error(`Update failed; the previous package was kept or restored. Recovery files: ${recovery}. ${error instanceof Error ? error.message : ""}`);
  }
}
export function prepareRecoveryRuntime(recovery: string) {
  const runtime = join(recovery, "runtime");
  mkdirSync(join(runtime, "dist", "server"), { recursive: true, mode: 0o700 });
  copyFileSync(join(root, "package.json"), join(runtime, "package.json"));
  for (const name of ["update.js", "launchd.js"]) copyFileSync(join(root, "dist", "server", name), join(runtime, "dist", "server", name));
  writeFileSync(join(recovery, "recover.mjs"), 'import { fileURLToPath } from "node:url";\nimport { main } from "./runtime/dist/server/update.js";\nawait main(["--recover", fileURLToPath(new URL(".", import.meta.url))]);\n', { mode: 0o600, flag: "wx" });
}
function recoveryCommand(recovery: string) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `${quote(process.execPath)} ${quote(join(recovery, "recover.mjs"))}`;
}
function privateDirectory(path: string) {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error("Recovery folder ownership or permissions changed.");
}
export async function recoverUpdate(folder: string, expectedTarget?: string, lifecycleOverride?: Lifecycle) {
  const recovery = realpathSync(resolve(folder)); privateDirectory(recovery);
  const parent = realpathSync(dirname(recovery));
  const target = expectedTarget || join(realpathSync(run("npm", ["root", "-g"], 10000)), "agentklar");
  if (dirname(target) !== parent || !/^\.agentklar-update-[0-9a-f-]{36}$/.test(recovery.slice(parent.length + 1))) throw new Error("Recovery does not belong to this global package.");
  const lock = join(parent, ".agentklar-update-lock"); privateDirectory(lock);
  const lockIdentity = lstatSync(lock);
  const owned = JSON.parse(privateText(join(lock, "recovery.json")));
  if (!Number.isSafeInteger(owned.pid) || owned.pid <= 0) throw new Error("Recovery owner is invalid.");
  try { process.kill(owned.pid, 0); throw new Error("The update process is still running. Wait for it to finish before recovery."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const text = privateText(join(recovery, "journal.json"));
  if (owned.recovery !== recovery || owned.target !== target || owned.journalHash !== createHash("sha256").update(text).digest("hex")) throw new Error("Recovery journal changed. No files were changed.");
  const journal = JSON.parse(text);
  if (journal.recovery !== recovery || journal.target !== target || journal.previous !== join(recovery, "previous") || journal.replacement !== join(recovery, "staging/lib/node_modules/agentklar") ||
      !["prepared", "stopped", "old-saved", "replaced", "committed", "complete", "restored", "recovery-required"].includes(journal.phase)) throw new Error("Recovery paths or phase are unsupported.");
  versionParts(journal.oldVersion); versionParts(journal.nextVersion);
  const matches = (path: string, identity: { dev: number; ino: number }) => {
    if (!identity || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) throw new Error("Recovery identity is invalid.");
    if (!existsSync(path)) return false;
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino) throw new Error("Recovery package folder changed. No files were changed.");
    return true;
  };
  const committed = ["committed", "complete"].includes(journal.phase);
  const targetIdentity = existsSync(target) ? lstatSync(target) : undefined;
  const oldAtTarget = !!targetIdentity && !committed && targetIdentity.dev === journal.original?.dev && targetIdentity.ino === journal.original?.ino;
  if (oldAtTarget) { if (!matches(target, journal.original)) throw new Error("Previous package is missing."); }
  else if (existsSync(target)) { if (!matches(target, journal.staged)) throw new Error("Replacement package is missing."); }
  const oldSaved = matches(journal.previous, journal.original);
  const stagedSaved = matches(journal.replacement, journal.staged);
  if (committed ? !existsSync(target) || !oldSaved || stagedSaved : oldAtTarget ? oldSaved || !stagedSaved : !oldSaved || (existsSync(target) === stagedSaved)) throw new Error("Recovery package ownership is ambiguous.");
  const restoreFrom = oldAtTarget ? target : journal.previous;
  validatePackage(restoreFrom, journal.oldVersion);
  if (existsSync(target) && !oldAtTarget) validatePackage(target, journal.nextVersion);
  if (!expectedTarget) {
    const prefix = dirname(dirname(parent));
    const cli = join(prefix, "bin", "agentklar");
    if (process.getuid?.() === 0 || !lstatSync(cli).isSymbolicLink() || resolve(dirname(cli), readlinkSync(cli)) !== join(target, "bin", "agentklar.mjs")) throw new Error("Global CLI ownership changed.");
  }
  let lifecycle = lifecycleOverride;
  if (journal.service && !lifecycle) {
    if (process.platform !== "darwin" || typeof journal.service.home !== "string" || realpathSync(journal.service.home) !== journal.service.home || !Number.isInteger(journal.service.port) || typeof journal.service.running !== "boolean") throw new Error("Saved service ownership is invalid.");
    const marker = readUpdateMaintenance(journal.service.home, journal.service.id);
    if ((!committed && !["prepared", "restored"].includes(journal.phase) && journal.service.running && (!marker || marker.transaction !== journal.service.transaction || marker.recovery !== recovery)) || (marker && (marker.transaction !== journal.service.transaction || marker.recovery !== recovery))) throw new Error("Recovery maintenance ownership changed.");
    lifecycle = await managedUpdate(join(target, "dist/server/server.js"), recovery, journal.oldVersion, journal.service);
  }
  const claim = join(lock, "recovery-owner.json");
  if (existsSync(claim)) {
    const prior = JSON.parse(privateText(claim));
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error("Recovery owner changed.");
    try { process.kill(prior.pid, 0); throw new Error("Another recovery is still running."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    rmSync(claim);
  }
  writeFileSync(claim, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: "wx" });
  const releaseHome = !lifecycle?.running ? serviceLock(journal.service?.home || journal.home || process.env.AGENTKLAR_HOME || join(homedir(), ".agentklar", "local-v1")) : undefined;
  const savePhase = (phase: string) => {
    journal.phase = phase;
    const next = JSON.stringify(journal);
    const temporary = join(recovery, "journal-next.json");
    writeFileSync(temporary, next, { mode: 0o600 }); renameSync(temporary, join(recovery, "journal.json"));
    writeFileSync(join(lock, "recovery.json"), JSON.stringify({ recovery, target, pid: process.pid, journalHash: createHash("sha256").update(next).digest("hex") }), { mode: 0o600 });
  };
  try {
    if (committed) {
      if (lifecycle?.running) await lifecycle.start(journal.nextVersion);
      console.log("The updated package was already committed. Its saved work was kept.");
    } else {
      if (["prepared", "restored"].includes(journal.phase) && oldAtTarget && lifecycle?.running && !lifecycle.paused?.()) {
        await lifecycle.start(journal.oldVersion);
      } else {
        if (lifecycle?.running) await lifecycle.stop();
        if (!oldAtTarget) {
          if (existsSync(target)) { renameSync(target, journal.replacement); savePhase("old-saved"); }
          renameSync(journal.previous, target); savePhase("restored");
        }
        if (lifecycle?.running) await lifecycle.start(journal.oldVersion);
      }
      console.log(`Previous AgentKlar ${journal.oldVersion} restored. Saved work and native settings were kept.`);
    }
    savePhase(committed ? "complete" : "restored");
    const current = lstatSync(lock);
    if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) throw new Error("Update lock changed. It was kept.");
    rmSync(lock, { recursive: true });
  } finally { releaseHome?.(); }
}

export async function main(args: string[]) {
  if (args[0] === "--recover" && args.length === 2) { await recoverUpdate(args[1]!); return; }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("Use agentklar update [--check] or agentklar update --recover <private recovery folder>");
  if (args[0] === "--check") {
    const result = await checkUpdate();
    if (result.error) throw new Error(result.error);
    console.log(`Installed: ${result.current}. Available: ${result.latest}. ${result.available ? "Run agentklar update." : "No newer compatible release."}\n${result.installation.reason}`);
    return;
  }
  const mode = installation();
  if (!mode.supported) throw new Error(mode.reason);
  if (manifest.agentklarDataCompatibility !== dataCompatibility) throw new Error("This installed package lacks the supported data compatibility marker.");
  versionParts(currentVersion);
  validatePackage(root, currentVersion);
  const release = await latestRelease();
  if (!newer(release.version, currentVersion)) return console.log(`AgentKlar ${currentVersion} has no newer compatible release.`);
  const home = process.env.AGENTKLAR_HOME || join(homedir(), ".agentklar", "local-v1");
  const parent = dirname(realpathSync(root));
  const lock = join(parent, ".agentklar-update-lock");
  const recovery = join(parent, `.agentklar-update-${randomUUID()}`);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error(`An update or recovery is already pending. Inspect ${lock} before retrying.`); }
  const lockIdentity = lstatSync(lock);
  mkdirSync(recovery, { mode: 0o700 });
  writeFileSync(join(lock, "recovery.json"), JSON.stringify({ recovery, target: realpathSync(root), pid: process.pid }), { mode: 0o600, flag: "wx" });
  let releaseHome: (() => void) | undefined;
  try {
    const lifecycle = process.platform === "darwin" ? await managedUpdate(join(realpathSync(root), "dist/server/server.js"), recovery, currentVersion) : undefined;
    if (!lifecycle?.running) releaseHome = serviceLock(home);
    const [archive, checksum] = await Promise.all([boundedDownload(release.url, 32 * 1024 * 1024), boundedDownload(release.checksumUrl, 65536)]);
    verifyArchive(release, archive, checksum.toString("utf8"));
    const tarball = join(recovery, `agentklar-${release.version}.tgz`);
    writeFileSync(tarball, archive, { mode: 0o600, flag: "wx" });
    const prefix = join(recovery, "staging");
    run("npm", ["install", "-g", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
    const replacement = join(prefix, "lib", "node_modules", "agentklar");
    validatePackage(replacement, release.version);
    if (run(process.execPath, [join(replacement, "bin/agentklar.mjs"), "--version"], 10000) !== release.version) throw new Error("Staged CLI version did not match.");
    prepareRecoveryRuntime(recovery);
    await swapPackage(realpathSync(root), replacement, recovery, lifecycle, lock, realpathSync(home));
    releaseHome?.(); releaseHome = undefined;
    console.log(`AgentKlar updated to ${release.version}. Previous package and recovery record: ${recovery}.`);
    console.log(lifecycle?.running ? "Run agentklar service open for a fresh local browser session. Save open drafts before reloading." : "Run agentklar start to open AgentKlar.");
  } finally {
    releaseHome?.();
    // An interrupted transaction keeps its lock and journal for inspection.
    const journal = join(recovery, "journal.json");
    const phase = existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")).phase : "prepared";
    if (["prepared", "complete", "restored"].includes(phase)) {
      const currentLock = lstatSync(lock);
      if (currentLock.dev === lockIdentity.dev && currentLock.ino === lockIdentity.ino) rmSync(lock, { recursive: true });
    }
  }
}
