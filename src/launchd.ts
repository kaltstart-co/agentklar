import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

type Install = { id: string; label: string; home: string; port: number; plistHash: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw e;
    return join(canonical(dirname(path)), basename(path));
  }
}
export function privateText(path: string): string {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o077) || st.size > 65536)
    throw new Error(`Unsafe private file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.nlink !== 1 || opened.size !== st.size)
      throw new Error(`Private file changed while reading: ${path}`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function operatorKey(home: string): string {
  const key = privateText(join(home, "operator-key")).trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid operator key");
  return key;
}
function command(program: string, args: string[], input?: string, timeout = 10000) {
  const result = spawnSync(program, args, { encoding: "utf8", input, timeout, maxBuffer: 65536, shell: false });
  if (result.error) throw result.error;
  return result;
}
function launchctl(args: string[], required = true) {
  const result = command("/bin/launchctl", args, undefined, args[0] === "print" ? 1000 : 10000);
  if (required && result.status !== 0) throw new Error(`launchctl ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return result.status === 0;
}
export async function waitUnregistered(target: string, control: typeof launchctl = launchctl) {
  const deadline = Date.now() + 5000;
  while (control(["print", target], false)) {
    if (Date.now() >= deadline) throw new Error("launchd shutdown is still pending. Managed files were kept; check status and retry.");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
function paths(homeOverride?: string, portOverride?: number) {
  if (process.platform !== "darwin") throw new Error("Background startup is supported on macOS only.");
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node 24 for AgentKlar.");
  const rawHome = homeOverride || process.env.AGENTKLAR_HOME || join(homedir(), ".agentklar", "local-v1");
  if (!isAbsolute(rawHome)) throw new Error("AGENTKLAR_HOME must be absolute.");
  const home = canonical(rawHome);
  const port = portOverride ?? Number(process.env.AGENTKLAR_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid AGENTKLAR_PORT.");
  const label = `com.agentklar.local.${hash(home).slice(0, 16)}`;
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const journal = join(home, "launchd-install.json");
  const target = `gui/${process.getuid!()}/${label}`;
  const domain = `gui/${process.getuid!()}`;
  return { home, port, label, plist, journal, target, domain };
}
function installed(p: ReturnType<typeof paths>): Install | null {
  if (!existsSync(p.journal)) {
    if (existsSync(p.plist)) throw new Error("A launchd entry already uses this AgentKlar label. It is not owned by this install.");
    return null;
  }
  const entry = JSON.parse(privateText(p.journal)) as Install;
  if (entry.home !== p.home || entry.label !== p.label || entry.port !== p.port || !/^[0-9a-f-]{36}$/.test(entry.id))
    throw new Error("Saved launchd ownership does not match this service home and port.");
  if (!existsSync(p.plist) || hash(privateText(p.plist)) !== entry.plistHash)
    throw new Error("Managed launchd entry is missing or changed. Inspect it before continuing.");
  operatorKey(p.home);
  return entry;
}
function ensureLog(path: string) {
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  privateText(path);
}
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(700);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}
async function healthy(p: ReturnType<typeof paths>, entry: Install) {
  for (let i = 0; i < 16; i++) {
    try { await operatorRequest(p, entry, "status"); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("launchd registered AgentKlar, but its health is unclear. Use status or inspect its private error log.");
}
export async function install(p: ReturnType<typeof paths>, control: typeof launchctl = launchctl) {
  if (installed(p)) return console.log("AgentKlar background startup is already installed.");
  if (existsSync(join(p.home, "operator-key"))) throw new Error("An operator key already exists without a managed install. Inspect it first.");
  if (control(["print", p.target], false)) throw new Error("This launchd label is already registered. No existing job was changed.");
  if (await portBusy(p.port)) throw new Error(`Port ${p.port} is already in use. Stop the foreground service or choose another AGENTKLAR_PORT.`);
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(p.plist), { recursive: true, mode: 0o700 });
  const source = import.meta.url.endsWith(".ts");
  const root = realpathSync(fileURLToPath(new URL(source ? "../" : "../../", import.meta.url)));
  const server = fileURLToPath(new URL(source ? "./server.ts" : "./server.js", import.meta.url));
  const program = source ? [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), server] : [process.execPath, server];
  const id = randomUUID();
  const env: Record<string, string> = { AGENTKLAR_HOME: p.home, AGENTKLAR_PORT: String(p.port), AGENTKLAR_SERVICE_ID: id };
  for (const name of ["PATH", "NPM_CONFIG_PREFIX", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
    if (process.env[name]) env[name] = process.env[name]!;
  const plistData = { Label: p.label, ProgramArguments: program,
    WorkingDirectory: root, EnvironmentVariables: env, RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 30, Umask: 63,
    StandardOutPath: join(p.home, "launchd.out.log"), StandardErrorPath: join(p.home, "launchd.err.log") };
  const converted = command("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], JSON.stringify(plistData));
  if (converted.status !== 0) throw new Error("Could not create launchd plist.");
  const xml = converted.stdout;
  const entry: Install = { id, label: p.label, home: p.home, port: p.port, plistHash: hash(xml) };
  const keyPath = join(p.home, "operator-key");
  const made = new Map<string, string>();
  let bootstrapAttempted = false;
  try {
    ensureLog(plistData.StandardOutPath);
    ensureLog(plistData.StandardErrorPath);
    const key = randomBytes(32).toString("hex");
    writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" }); made.set(keyPath, hash(key));
    const journalText = JSON.stringify(entry);
    writeFileSync(p.journal, journalText, { mode: 0o600, flag: "wx" }); made.set(p.journal, hash(journalText));
    writeFileSync(p.plist, xml, { mode: 0o600, flag: "wx" }); made.set(p.plist, hash(xml));
    if (control(["print", p.target], false)) throw new Error("This launchd label is already registered. No existing job was changed.");
    bootstrapAttempted = true;
    control(["bootstrap", p.domain, p.plist]);
  } catch (e) {
    // A failed bootstrap may still have registered the job. Keep its ownership record for safe cleanup.
    if (!bootstrapAttempted || !control(["print", p.target], false))
      for (const [path, expected] of [...made].reverse())
        try { if (hash(privateText(path)) === expected) unlinkSync(path); } catch {}
    throw e;
  }
  await healthy(p, entry);
  console.log("AgentKlar will start at login. Use `agentklar service open` to open it.");
}
export async function operatorRequest(p: { home: string }, entry: { id: string; port: number }, route: string, body?: unknown, limit = 4096) {
  const response = await fetch(`http://127.0.0.1:${entry.port}/api/operator/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "connection": "close", "x-agentklar-operator-key": operatorKey(p.home), "x-agentklar-service-id": entry.id,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(route === "onboarding/setup" ? 35000 : 2500),
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("Local service response is too large.");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  if (response.status === 409) throw new Error(String(value.error));
  if (!response.ok) throw new Error("The service at this port is not this managed AgentKlar instance.");
  if (route === "status" && (value.id !== entry.id || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
      !Number.isSafeInteger(value.activeRuns) || Number(value.activeRuns) < 0 || typeof value.quiesced !== "boolean"))
    throw new Error("The service at this port is not this managed AgentKlar instance.");
  return value;
}
export async function managedCliState(): Promise<"not-installed" | "stopped" | "running"> {
  const p = paths(), entry = installed(p);
  if (!entry) return "not-installed";
  if (!launchctl(["print", p.target], false)) return "stopped";
  const state = await operatorRequest(p, entry, "status");
  if (state.quiesced) throw new Error("AgentKlar is paused. Finish its update or run `agentklar service start` before setup.");
  return "running";
}
export async function managedOnboarding(route: string, body?: unknown): Promise<unknown> {
  if (!["onboarding", "onboarding/project", "onboarding/preferences", "onboarding/setup"].includes(route))
    throw new Error("Unsupported terminal setup operation.");
  const p = paths(), entry = installed(p);
  if (!entry || !launchctl(["print", p.target], false)) throw new Error("Start the managed AgentKlar service before setup.");
  const state = await operatorRequest(p, entry, "status");
  if (state.quiesced) throw new Error("AgentKlar is paused. Finish its update or resume it before setup.");
  return operatorRequest(p, entry, route, body, 65536);
}
export async function openManagedDashboard(view: "work" | "team" | "connections" | "devices") {
  const p = paths(), entry = installed(p);
  if (!entry || !launchctl(["print", p.target], false)) throw new Error("Start AgentKlar before opening the dashboard.");
  await operatorRequest(p, entry, "status");
  const value = await operatorRequest(p, entry, "open", {}), url = String(value.url);
  if (!new RegExp(`^http://127\\.0\\.0\\.1:${entry.port}/setup\\?token=[0-9a-f]{64}$`).test(url)) throw new Error("Invalid local setup URL.");
  if (command("/usr/bin/open", [`${url}#${view}`]).status !== 0) throw new Error("Browser could not open. Use `agentklar service open`.");
}
async function stop(p: ReturnType<typeof paths>, entry: Install, force: boolean) {
  if (!launchctl(["print", p.target], false)) return console.log("AgentKlar is already stopped.");
  try {
    await operatorRequest(p, entry, "status");
  await operatorRequest(p, entry, "quiesce", { force });
  } catch (e) {
    if (!force) throw e;
    console.log("Managed service is unhealthy; forcing launchd to stop its registered job.");
  }
  try { launchctl(["bootout", p.target]); }
  catch (e) { await operatorRequest(p, entry, "resume", {}).catch(() => {}); throw e; }
  await waitUnregistered(p.target);
  console.log("AgentKlar stopped until you start it or log in again.");
}
export async function main(args = process.argv.slice(2)) {
  const [action, ...flags] = args;
  if (!["install", "status", "open", "stop", "start", "uninstall"].includes(action || "") ||
      flags.some((x) => x !== "--force" && x !== "--print") ||
      (flags.includes("--force") && !["stop", "uninstall"].includes(action!)) ||
      (flags.includes("--print") && action !== "open"))
    throw new Error("Use: agentklar service install|status|open [--print]|stop [--force]|start|uninstall [--force]");
  const p = paths();
  if (action === "install") return install(p);
  const entry = installed(p);
  if (!entry) return console.log("AgentKlar background startup is not installed.");
  if (action === "status") {
    const registered = launchctl(["print", p.target], false);
    if (!registered) return console.log("Installed; stopped.");
    try { const state = await operatorRequest(p, entry, "status"); console.log(`Installed; ${state.quiesced ? "paused for stop (run start to resume)" : "running"} on http://127.0.0.1:${entry.port}; ${state.activeRuns} active run(s).`); }
    catch { console.log("Installed; registered with launchd; service health is unclear."); }
    return;
  }
  if (action === "start") {
    if (!launchctl(["print", p.target], false)) {
      if (await portBusy(entry.port)) throw new Error(`Port ${entry.port} is already in use. Stop the foreground service first.`);
      launchctl(["bootstrap", p.domain, p.plist]);
    }
    else {
      const state = await operatorRequest(p, entry, "status").catch(() => null);
      if (state) {
        if (state.quiesced) { await operatorRequest(p, entry, "resume", {}); return console.log("AgentKlar resumed."); }
        return console.log("AgentKlar is already running.");
      }
      launchctl(["kickstart", p.target]);
    }
    await healthy(p, entry);
    console.log("AgentKlar is running.");
    return;
  }
  if (action === "open") {
    if (!launchctl(["print", p.target], false)) throw new Error("AgentKlar is stopped. Run start first.");
    const value = await operatorRequest(p, entry, "open", {});
    const url = String(value.url);
    if (!new RegExp(`^http://127\\.0\\.0\\.1:${entry.port}/setup\\?token=[0-9a-f]{64}$`).test(url)) throw new Error("Invalid local setup URL.");
    console.log(url);
    if (!flags.includes("--print") && command("/usr/bin/open", [url]).status !== 0) throw new Error("Browser could not open. Use the printed link.");
    return;
  }
  await stop(p, entry, flags.includes("--force"));
  if (action === "uninstall") {
    installed(p);
    unlinkSync(p.plist);
    unlinkSync(p.journal);
    unlinkSync(join(p.home, "operator-key"));
    console.log("AgentKlar login startup removed. Local projects and run history remain.");
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });

export type UpdateMaintenance = { transaction: string; serviceId: string; recovery: string };
export function readUpdateMaintenance(home: string, serviceId?: string): UpdateMaintenance | null {
  const path = join(home, "update-maintenance.json");
  if (!existsSync(path)) return null;
  const text = privateText(path);
  if (text.length > 1024) throw new Error("Invalid update maintenance marker. Inspect recovery before starting.");
  const entry = JSON.parse(text) as UpdateMaintenance;
  if (!/^[0-9a-f-]{36}$/.test(entry.transaction) || typeof entry.recovery !== "string" || !isAbsolute(entry.recovery) ||
      !/^[0-9a-f-]{36}$/.test(entry.serviceId) || (serviceId !== undefined && entry.serviceId !== serviceId))
    throw new Error("Update maintenance belongs to a different service. Inspect recovery before starting.");
  return entry;
}

/** Only operates the existing owned launchd job at the unchanged package path. */
export type UpdateService = { home: string; port: number; id: string; running: boolean; transaction: string };
export async function managedUpdate(expectedServer: string, recovery: string, expectedVersion: string, saved?: UpdateService) {
  const p = paths(saved?.home, saved?.port);
  const entry = installed(p);
  if (!entry) { if (saved) throw new Error("Saved managed service is missing."); return undefined; }
  if (saved && entry.id !== saved.id) throw new Error("Saved service ownership changed.");
  const existing = readUpdateMaintenance(p.home, entry.id);
  if (existing && (!saved || existing.transaction !== saved.transaction || existing.recovery !== recovery)) throw new Error("An earlier update is paused. Inspect its recovery record before retrying.");
  const converted = command("/usr/bin/plutil", ["-convert", "json", "-o", "-", p.plist]);
  if (converted.status !== 0) throw new Error("Could not inspect managed startup.");
  const plist = JSON.parse(converted.stdout);
  if (plist.ProgramArguments?.length !== 2 || plist.ProgramArguments[0] !== process.execPath || plist.ProgramArguments[1] !== expectedServer || plist.WorkingDirectory !== dirname(dirname(dirname(expectedServer))))
    throw new Error("Managed startup belongs to a different package. Inspect it before updating.");
  const running = saved?.running ?? launchctl(["print", p.target], false);
  if (running && !saved) {
    const state = await operatorRequest(p, entry, "status");
    if (state.version !== expectedVersion || state.quiesced) throw new Error("The running service does not match this package, or is paused. Inspect status before updating.");
  }
  const marker = join(p.home, "update-maintenance.json");
  const transaction = saved?.transaction || randomUUID();
  const text = existing ? privateText(marker) : JSON.stringify({ transaction, serviceId: entry.id, recovery });
  let marked = !!existing;
  let identity: { dev: number; ino: number } | undefined = existing ? lstatSync(marker) : undefined;
  const unchanged = () => { const current = lstatSync(marker); if (!marked || !identity || current.dev !== identity.dev || current.ino !== identity.ino || privateText(marker) !== text) throw new Error("Update maintenance changed. Recovery files were kept."); };
  return {
    running,
    info: { home: p.home, port: p.port, id: entry.id, running, transaction },
    paused: () => marked,
    stop: async () => {
      if (!launchctl(["print", p.target], false)) return;
      if (!marked) {
        await operatorRequest(p, entry, "quiesce", { force: false });
        try { writeFileSync(marker, text, { mode: 0o600, flag: "wx" }); identity = lstatSync(marker); marked = true; }
        catch (error) { await operatorRequest(p, entry, "resume", {}).catch(() => {}); throw error; }
      }
      unchanged(); installed(p);
      const state = await operatorRequest(p, entry, "status").catch(() => null);
      if (state && (state.activeRuns !== 0 || !state.quiesced)) throw new Error("The service has active work or is not paused. Recovery was refused.");
      // The replacement starts paused under our unchanged marker, even when health fails.
      launchctl(["bootout", p.target]);
      await waitUnregistered(p.target);
    },
    start: async (version: string, commit?: () => void) => {
      if (saved && !marked) {
        const state = await operatorRequest(p, entry, "status");
        if (state.version !== version) throw new Error("Committed service version changed.");
        if (state.quiesced) await operatorRequest(p, entry, "resume", {});
        return;
      }
      unchanged(); installed(p);
      if (!launchctl(["print", p.target], false)) {
        if (await portBusy(p.port)) throw new Error("Service port is occupied. Recovery files were kept.");
        launchctl(["bootstrap", p.domain, p.plist]);
      }
      await healthy(p, entry);
      const state = await operatorRequest(p, entry, "status");
      if (state.version !== version || state.quiesced !== true || state.activeRuns !== 0) throw new Error("Restarted service version or state did not match the update.");
      commit?.();
      unchanged(); unlinkSync(marker); marked = false;
      try { await operatorRequest(p, entry, "resume", {}); }
      catch {
        const resumed = await operatorRequest(p, entry, "status").catch(() => null);
        if (!resumed || resumed.version !== version || resumed.quiesced) throw new Error("Update installed; resume is unclear. Run the printed recovery command to check and resume it.");
      }
    },
  };
}
