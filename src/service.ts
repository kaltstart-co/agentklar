import { workerHarnesses, type WorkerHarness } from "./contracts.ts";
import { readUpdateMaintenance } from "./launchd.ts";
import { currentVersion, checkUpdate, updateStatus } from "./update.ts";
import { nativeInventory } from "./inventory.ts";
import { Control, ControlError } from "./control.ts";
import { Approvals, ApprovalError, approvalAnswerSchema } from "./approvals.ts";
import { Peers, PeerError, routingEvidenceSchema, type PeerTransport } from "./peers.ts";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { deviceSettings } from "./devices.ts";
import { composeWorkerPrompt } from "./prompt.ts";
import { Changes, ChangeError, type ChangePacket, type ChangeApply } from "./changes.ts";
import { Store } from "./store.ts";
import { harnesses, executable } from "./harnesses.ts";
import { NativeWorker, type NativeCallbacks } from "./native.ts";
import { ClaudeWorker } from "./claude.ts";
import { MuseWorker } from "./muse.ts";
import { OpenCodeWorker } from "./opencode.ts";
import { AcpWorker } from "./acp.ts";
import { captureOpenCodeScope } from "./opencode-scope.ts";
import { CatalogCache, readCatalog, withObservedMuseQuota, type CatalogReader } from "./catalog.ts";
import { BenchmarkCache } from "./benchmarks.ts";
import type { Run, Project, ProjectRun, ProjectLead, RoutingDecision, FollowUpContext } from "./contracts.ts";
import { sourceFromHeader } from "./launch-source.ts";
import { recommendationSchema, recommendWorker, recommendWorkers, type RecommendationSource, selectedWorkerEligibility } from "./recommend.ts";
import { toolCapabilities } from "./capabilities.ts";
import { ZCodeWorker } from "./zcode.ts";
import { Instructions, InstructionError, instructionFileSchema, instructionPreviewSchema } from "./instructions.ts";
import { NativeSetup, SetupError, type NativeSetupOptions } from "./setup.ts";
import { Onboarding, onboardingPreferencesInput, onboardingProjectInput, onboardingSetupInput, setupHarness } from "./onboarding.ts";
import { ProjectSkills, SkillError, skillPreviewInput, skillIdInput, skillRemoveInput } from "./skills.ts";
import { NativePlugins, pluginPreviewInput } from "./plugins.ts";
import { NativeSettings, NativeChangeError, nativeSettingHarness, nativeSettingInput, nativePreviewId, nativeChangeId } from "./native-settings.ts";
import { runHandoff } from "./handoff.ts";
import { createWorktree, gitBase, gitCheckout, plannedWorktree, verifyWorktree } from "./workspace.ts";
import { projectRootIdentity } from "./project-root.ts";
const role = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    harness: z.string().min(1).max(80),
    model: z.string().min(1).max(120).optional(),
    peerId: z.uuid().optional(),
    responsibility: z.string().max(4000),
  })
  .strict();
function compactRun(r: Run): Run {
  const { contextSnapshot, followUpContext, nativeHome, nativeHomeEnv, openCodeScope, ...metadata } = r;
  return {
    ...metadata,
    contextRevision: contextSnapshot?.revision ?? null,
    prompt: r.prompt.slice(0, 300),
    promptTruncated: r.prompt.length > 300,
    result: r.result.slice(0, 1000),
    resultTruncated: !!r.resultTruncated || r.result.length > 1000,
  };
}
function projectRun(r: Run): ProjectRun {
  return {
    id: r.id,
    projectId: r.projectId,
    harness: r.harness,
    roleId: r.roleId,
    prompt: r.prompt.slice(0, 120),
    promptTruncated: r.prompt.length > 120,
    readOnly: r.readOnly,
    state: r.state,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    followUp: r.followUp,
    workspaceKind: r.workspace?.kind || "project",
    launchSource: r.launchSource,
  };
}
export const contextUpdateSchema = z
  .object({
    brief: z.string().max(2000),
    memory: z.string().max(4000),
    handoff: z.string().max(2000),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export const startSchema = z
  .object({
    projectId: z.uuid(),
    prompt: z.string().trim().min(1).max(32000),
    idempotencyKey: z.string().min(1).max(200),
    roleId: z.string().optional(),
    harness: z.enum(workerHarnesses).optional(),
    model: z.string().min(1).max(120).optional(),
    readOnly: z.boolean().default(false),
    includeProjectContext: z.boolean().default(true),
    routing: z.object({
      complexity: z.enum(["routine", "standard", "hard"]).default("standard"),
      requiresImages: z.boolean().default(false),
      requiresTools: z.array(z.enum(toolCapabilities)).max(2).optional(),
      taskType: z.enum(["coding", "reasoning", "data-analysis", "language"]).default("coding"),
      deviceScope: z.enum(["local", "connected"]).optional(),
    }).strict().optional(),
    routingEvidence: routingEvidenceSchema.optional(),
    followUp: z.object({ runId: z.uuid(), kind: z.enum(["review", "fix"]) }).strict().optional(),
    workspace: z.enum(["project", "worktree"]).optional(),
    baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  })
  .strict();
const leadActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim") }).strict(),
  z.object({ action: z.literal("takeover"), observedClaimId: z.uuid() }).strict(),
  z.object({ action: z.literal("release"), observedClaimId: z.uuid() }).strict(),
]);
const leadRenewSchema = z.object({
  claims: z.array(z.object({ projectId: z.uuid(), claimId: z.uuid() }).strict()).min(1).max(16)
    .refine((claims) => new Set(claims.map((item) => item.projectId)).size === claims.length),
}).strict();
export function processGroupAlive(pid: number) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
function ownHome(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "service-lock.sqlite");
  const guard = new DatabaseSync(path);
  try {
    guard.exec(
      "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE;",
    );
    chmodSync(path, 0o600);
  } catch {
    guard.close();
    throw new Error("Local service is already running for this data home.");
  }
  return () => guard.close();
}

export type WorkerFactory = (
  command: string,
  run: Run,
  path: string,
  callbacks: NativeCallbacks,
  nativeEnv?: NodeJS.ProcessEnv,
) => { stop: () => void; closed?: Promise<void> };
export type Operator = { id: string; key: string };
export function createService(
  home: string,
  port = 4317,
  factory: WorkerFactory = (command, run, path, callbacks, nativeEnv) =>
    run.harness === "claude"
      ? new ClaudeWorker(command, run, path, callbacks)
      : run.harness === "muse"
      ? new MuseWorker(command, run, path, callbacks)
      : run.harness === "opencode"
      ? new OpenCodeWorker(command, run, path, callbacks, undefined, nativeEnv)
      : run.harness === "gemini" || run.harness === "cursor-agent"
      ? new AcpWorker(command, run, path, callbacks, run.harness)
      : run.harness === "zcode"
      ? new ZCodeWorker(command.endsWith(".cjs") ? process.execPath : command, run, path, callbacks, command.endsWith(".cjs") ? { args: [command, "app-server", "--stdio"] } : {})
      : new NativeWorker(command, run, path, callbacks),
  nativeCommand: string | null = executable("codex"),
  claudeCommand: string | null = executable("claude"),
  catalogReader: CatalogReader = readCatalog,
  setupOptions: NativeSetupOptions = {},
  operator?: Operator,
  skillOptions: { timeoutMs?: number; sourceOverride?: (source: string) => string; userHome?: string } = {},
  benchmarkOptions: { fetcher?: typeof fetch; timeoutMs?: number } = {},
  museCommand: string | null = executable("muse"),
  leadOptions: { now?: () => number; wallNow?: () => number; leaseMs?: number } = {},
  opencodeCommand: string | null = executable("opencode"),
  peerTransport?: PeerTransport,
  acpCommands: Partial<Record<"gemini" | "cursor-agent" | "zcode", string | null>> = {},
) {
  const startupMaintenance = readUpdateMaintenance(home, operator?.id);
  const personalHome = realpathSync(skillOptions.userHome ?? homedir());
  const release = ownHome(home);
  let store: Store;
  try {
    store = new Store(home);
  } catch (e) {
    release();
    throw e;
  }
  store.db.exec("CREATE TABLE IF NOT EXISTS benchmark_cache (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)");
  let cachedBenchmarks: unknown;
  try {
    const row = store.db.prepare("SELECT snapshot FROM benchmark_cache WHERE id=1").get() as { snapshot: string } | undefined;
    if (row) cachedBenchmarks = JSON.parse(row.snapshot);
  } catch { /* A damaged cache falls back to reviewed bundled data. */ }
  const benchmarks = new BenchmarkCache((snapshot) => {
    store.db.prepare("INSERT INTO benchmark_cache(id,snapshot) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot").run(JSON.stringify(snapshot));
  }, cachedBenchmarks, benchmarkOptions.fetcher, benchmarkOptions.timeoutMs);
  const devices = deviceSettings(store.db);
  nativeCommand = devices.selected("codex", nativeCommand);
  claudeCommand = devices.selected("claude", claudeCommand);
  museCommand = devices.selected("muse", museCommand);
  opencodeCommand = devices.selected("opencode", opencodeCommand);
  const commands: Record<WorkerHarness, string | null> = { codex: nativeCommand, claude: claudeCommand, muse: museCommand, opencode: opencodeCommand,
    gemini: devices.selected("gemini", acpCommands.gemini === undefined ? executable("gemini") : acpCommands.gemini),
    zcode: devices.selected("zcode", acpCommands.zcode === undefined ? executable("zcode") : acpCommands.zcode),
    "cursor-agent": devices.selected("cursor-agent", acpCommands["cursor-agent"] === undefined ? executable("cursor-agent") : acpCommands["cursor-agent"]),
  };
  const selectedHarnesses = () => harnesses().map((h) => Object.hasOwn(commands, h.id)
    ? { ...h, executable: commands[h.id as WorkerHarness]!, available: !!commands[h.id as WorkerHarness], workerSupported: !!commands[h.id as WorkerHarness], hostSupported: !!commands[h.id as WorkerHarness] } : h);
  const app = new Hono();
  const peerInternal = randomBytes(32).toString("hex");
  const peers = new Peers(store, devices.device, async (path, method = "GET", body) => {
    const response = await app.request(`http://127.0.0.1:${port}${path}`, { method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "x-agentklar-peer-internal": peerInternal },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, peerTransport, async (runId, operation, fields) => {
    try {
      if (operation === "list") return { status: 200, body: approvalActions.list(runId) };
      if (operation === "read") return { status: 200, body: approvalActions.read(runId, z.uuid().parse(fields.approvalId)) };
      return { status: 200, body: approvalActions.consume(runId, fields) };
    } catch (error) {
      if (error instanceof ApprovalError) return { status:error.status,body:{error:error.message} };
      if (error instanceof z.ZodError) return { status:400,body:{error:"Invalid concrete approval request."} };
      throw error;
    }
  });
  const changes = new Changes(store, home);
  function appliedView(applied: ChangeApply) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const continuations = ["codex", "claude"].flatMap((harness) => {
      const command = commands[harness as WorkerHarness];
      if (!command || !applied.workspace.path) return [];
      const variable = harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
      const profile = process.env[variable];
      const environment = profile === undefined ? `env -u ${variable}` : `env ${quote(`${variable}=${profile}`)}`;
      return [{ harness, cwd: applied.workspace.path, freshSession: true as const, display: `cd -- ${quote(applied.workspace.path)} && ${environment} ${quote(command)}` }];
    });
    return { ...applied, continuations, staged: true, message: "Imported changes are staged for review in this separate worktree. Inspect git status and git diff --cached before continuing." };
  }
  function sourceHandoffs(id: string) {
    if (!z.uuid().safeParse(id).success) return [];
    const dispatch = peers.list().find((item) => item.id === id);
    const sourceRunId = dispatch?.ownerRunId ?? (dispatch ? undefined : id);
    return sourceRunId ? changes.forSource(dispatch?.ownerDeviceId ?? devices.device.id, sourceRunId)
      .map((handoff) => ({ ...handoff, ...(handoff.applied ? { applied: appliedView(handoff.applied) } : {}) })) : [];
  }
  const changeQuery = z.object({ includePatch: z.enum(["true", "false"]).optional(), compact: z.enum(["true", "false"]).optional(), patchOffset: z.coerce.number().int().nonnegative().max(96000).optional(), patchLimit: z.coerce.number().int().min(1).max(96000).optional() }).strict();
  function packetView(packet: ChangePacket, options: z.infer<typeof changeQuery> = {}) {
    const { patch, ...summary } = packet;
    const compact = options.compact === "true" || (options.compact !== "false" && options.includePatch !== "true");
    const metadata = compact ? { ...summary, files: summary.files.slice(0, 10), fileCount: summary.files.length, filesTruncated: summary.files.length > 10,
      stat: summary.stat.slice(0, 1000), statTruncated: summary.stat.length > 1000, ignoredPaths: summary.ignoredPaths.slice(0, 5), ignoredTruncated: summary.ignoredTruncated || summary.ignoredPaths.length > 5 } : summary;
    if (options.includePatch !== "true") return { ...metadata, patchIncluded: false };
    const offset = options.patchOffset ?? 0, limit = options.patchLimit ?? 96000;
    return { ...metadata, patchIncluded: true, patch: patch.slice(offset, offset + limit), patchOffset: offset, patchNextOffset: offset + limit < patch.length ? offset + limit : null, patchTruncated: offset > 0 || offset + limit < patch.length };
  }
  function changeOptions(params: URLSearchParams) {
    if ([...params.keys()].some((key) => params.getAll(key).length > 1)) throw new ChangeError("Duplicate changes query fields are not supported.", 400);
    const parsed = changeQuery.safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new ChangeError("Invalid changes query. Use includePatch, compact, patchOffset and patchLimit only.", 400);
    return parsed.data;
  }
  async function runChanges(id: string) {
    if (!z.uuid().safeParse(id).success) throw new ChangeError("Invalid source run ID", 400);
    if (peers.list().some((dispatch) => dispatch.id === id)) return peers.changes(id);
    const run = store.run(id);
    if (!run) throw new ChangeError("Source run not found", 404);
    return changes.export(run, store.projects().find((project) => project.id === run.projectId), devices.device.id,
      activeRuns().some((item) => sameWorkspace(item, run)));
  }
  const instructions = new Instructions(store.db);
  const skills = new ProjectSkills(store.db, home, skillOptions);
  const nativeDefaults = new NativeSettings(store.db, { codex: nativeCommand, claude: claudeCommand }, { env: setupOptions.env });
  const nativePlugins = new NativePlugins(store.db, home, claudeCommand, { env: setupOptions.env });
  const nativeOperations = new Set<Promise<unknown>>();
  let nativeWrites = 0;
  async function nativeOperation<T>(action: () => Promise<T>, write = false): Promise<T> {
    if (quiesced || stopping) throw new NativeChangeError("Local service is stopping.", 503);
    if (write) {
      if (activeRuns().length || nativeWrites) throw new NativeChangeError("Wait for active workers and native changes to finish before changing native settings or plugins.", 409);
      nativeWrites++;
    }
    const promise = Promise.resolve().then(action);
    nativeOperations.add(promise);
    try { return await promise; } finally { nativeOperations.delete(promise); if (write) nativeWrites--; }
  }
  const personalSkills: Project = { id: "__personal_skills__", name: "Personal skills", path: personalHome, preference: "balanced", roles: [], createdAt: "" };
  const nativeSetup = new NativeSetup(store.db, home, port, { codex: nativeCommand, claude: claudeCommand, muse: museCommand, opencode: opencodeCommand, antigravity: executable("agy") }, setupOptions);
  const onboarding = new Onboarding(store.db);
  function registerProject(input: z.infer<typeof onboardingProjectInput>) {
    let path: string;
    try {
      if (!isAbsolute(input.path)) throw new Error();
      path = realpathSync(input.path);
      if (!statSync(path).isDirectory()) throw new Error();
    } catch { throw new SetupError("Project path must be an absolute existing folder.", 400); }
    const prior = store.projects().find(p => p.path === path);
    if (prior) return { project: prior, created: false };
    const project: Project = { id: randomUUID(), name: input.name, path, preference: "balanced", roles: [], createdAt: new Date().toISOString() };
    store.saveProject(project);
    return { project, created: true };
  }
  function saveOnboarding(input: z.infer<typeof onboardingPreferencesInput>) {
    if (quiesced || stopping) throw new SetupError("Local service is stopping.", 503);
    if (!store.projects().some(p => p.id === input.projectId)) throw new SetupError("Project not found", 404);
    if (input.mainHarness) {
      const selected = selectedHarnesses().find(h => h.id === input.mainHarness && h.available && h.hostSupported);
      try {
        if (!selected?.executable || !statSync(selected.executable).isFile()) throw new Error();
        accessSync(selected.executable, constants.X_OK);
      } catch { throw new SetupError("Install this harness through its native setup first.", 422); }
    }
    const saved = onboarding.save(input);
    if (!saved) throw new SetupError("Onboarding preferences changed. Refresh and try again.", 409);
    return saved;
  }
  const catalogs = new CatalogCache(catalogReader, { ...commands, antigravity: executable("agy") });
  const installedWorkers = () => Object.fromEntries(workerHarnesses.map(h => [h, !!commands[h]])) as Record<WorkerHarness, boolean>;
  const adviceSchema = recommendationSchema.extend({
    deviceScope: z.enum(["local", "connected"]).default("connected"),
    workspace: z.enum(["project", "worktree"]).optional(),
    followUp: z.object({ runId: z.uuid(), kind: z.enum(["review", "fix"]) }).strict().optional(),
  }).strict();
  function decisionFor(advice: ReturnType<typeof recommendWorker>): RoutingDecision {
    const choice = advice.choice!;
    return { selected: { harness: choice.harness, model: choice.model, roleId: choice.roleId, basis: choice.basis, tier: choice.tier,
      ...(choice.device ? { device: choice.device } : {}), ...(choice.catalogCheckedAt ? { catalogCheckedAt: choice.catalogCheckedAt } : {}), ...(choice.benchmark ? { benchmark: choice.benchmark } : {}) },
      preference: advice.preference, complexity: advice.complexity, taskType: advice.taskType, benchmarkMethod: advice.benchmarkMethod, requiresImages: advice.requiresImages,
      ...(advice.requiresTools?.length ? { requiresTools: advice.requiresTools } : {}),
      catalogCheckedAt: choice.catalogCheckedAt || advice.catalogCheckedAt, policyVersion: advice.policyVersion,
      reasons: [...new Set([...choice.reasons,...advice.reasons])].slice(0,3), warnings: [...new Set([...choice.warnings,...advice.warnings])].slice(0,3) };
  }
  async function deviceAdvice(project: Project, input: z.infer<typeof adviceSchema>) {
    const warnings: string[] = [];
    const sources: RecommendationSource[] = [];
    const role = input.roleId ? project.roles.find(r => r.id === input.roleId) : undefined;
    const linked = input.followUp ? peers.list().find(d => d.id === input.followUp!.runId && d.projectId === project.id) : undefined;
    const peerId = role?.peerId ?? linked?.peerId;
    if (peerId) {
      const mapping = peers.resolveMapping(project.id, peerId);
      const catalog = await peers.catalog(peerId);
      const available = (harness: string) => catalog.harnesses.some(h => h.harness === harness && h.modelsStatus === "available");
      sources.push({ catalog, installed: { codex: available("codex"), claude: available("claude"), muse: available("muse"), opencode: available("opencode") }, device: { id: mapping.deviceId, label: mapping.label, peerId } });
    } else {
      const connected = !role && !input.followUp && input.deviceScope !== "local" && input.workspace === "worktree";
      let baseCommit: string | undefined;
      if (connected) try { baseCommit = gitBase(project.path).baseCommit; } catch { warnings.push("Connected computers excluded: this project has no committed Git base."); }
      const mappings = connected && baseCommit ? peers.settings().peers.filter(p => p.projectId === project.id).slice(0,4) : [];
      if (connected && peers.settings().peers.filter(p => p.projectId === project.id).length > 4) warnings.push("Only the first four saved computer mappings were checked.");
      const bounded = async <T,>(promise: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([promise, new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error("Native discovery timed out")),8000); })]); }
        finally { if(timer) clearTimeout(timer); }
      };
      const localCapacity = !role && !input.followUp && input.workspace === "worktree" && activeRuns(project.id).length >= 2;
      if (localCapacity) warnings.push("This computer is excluded because this project already has two active workers.");
      const reads: Promise<RecommendationSource>[] = [bounded(catalogs.refresh(project)).then(catalog => ({ catalog: withObservedMuseQuota(catalog,store.runs()), installed: localCapacity ? { codex: false, claude: false, muse: false, opencode: false } : installedWorkers(), device: {id:devices.device.id,label:devices.device.label} })),
        ...mappings.map(mapping => bounded(peers.routing(mapping.id,baseCommit!)).then(source => {
          if (JSON.stringify(peers.resolveMapping(project.id,mapping.id)) !== JSON.stringify(mapping)) throw new Error("Saved mapping changed during discovery");
          return source;
        }))];
      const results = await Promise.allSettled(reads);
      for (let i=0;i<results.length;i++) {
        const result=results[i]!;
        if(result.status === "fulfilled") sources.push(result.value);
        else warnings.push(`${i===0 ? devices.device.label : mappings[i-1]!.label}: excluded because native routing metadata or the matching Git base is unavailable.`);
      }
      if(baseCommit && gitBase(project.path).baseCommit !== baseCommit) throw new PeerError("Source Git HEAD changed during device selection. Start again.",409);
      if (!role && !input.followUp && input.workspace !== "worktree" && input.deviceScope !== "local") warnings.push("Current project folder work stays on this computer. Choose a separate worktree to compare connected computers.");
    }

    const advice = recommendWorkers(project, input, sources, Date.now(), benchmarks.get());
    advice.warnings = [...advice.warnings, ...warnings].slice(0, 12);
    return advice;
  }

  function linkedSource(projectId: string, link: { runId: string; kind: "review" | "fix" }) {
    const source = store.run(link.runId);
    if (!source || source.projectId !== projectId)
      return { error: "Linked run not found in this project" } as const;
    if (source.state !== "completed")
      return { error: "Linked run must be completed" } as const;
    if (link.kind === "fix" && source.followUp?.kind !== "review")
      return { error: "A fix must follow a completed review" } as const;
    if (link.kind === "review" && source.followUp?.kind === "review")
      return { error: "A review must follow implementation or a fix" } as const;
    return { source } as const;
  }
  const workers = new Map<
    string,
    { stop: () => void; closed?: Promise<void> }
  >();
  const active = (r: Run) => ["running", "needs_attention"].includes(r.state) || workers.has(r.id) ||
    (r.workerPid !== undefined && processGroupAlive(r.workerPid));
  const activeRuns = (projectId?: string) => store.runs().filter((r) => (!projectId || r.projectId === projectId) && active(r));
  const runPath = (r: Run) => r.workspace?.path || store.projects().find((p) => p.id === r.projectId)?.path;
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  const sameWorkspace = (a: Run, b: Run) => {
    if (a.workspace?.kind === "worktree" && b.workspace?.kind === "worktree" &&
      a.workspace.rootRunId === b.workspace.rootRunId) return true;
    const aPath = runPath(a);
    const bPath = runPath(b);
    if (!aPath || !bPath) return false;
    const aGit = gitCheckout(aPath);
    const bGit = gitCheckout(bPath);
    if (aGit && bGit) return aGit.root === bGit.root;
    if (a.workspace?.kind === "worktree" && !a.workspace.verified && bGit?.commonDir === a.workspace.commonDir) return true;
    if (b.workspace?.kind === "worktree" && !b.workspace.verified && aGit?.commonDir === b.workspace.commonDir) return true;
    return overlaps(aPath, bPath);
  };
  const answers = new Map<string, (decision: string) => void>();
  const approvalActions = new Approvals(store,answers,runId => {
    const run = store.run(runId);
    return !quiesced && !stopping && !!run && ["running","needs_attention"].includes(run.state) && workers.has(runId);
  });
  const control = new Control(store.db);
  const leads = new Map<string, ProjectLead & { bridgeId: string; deadline: number }>();
  const leadNow = leadOptions.now || (() => performance.now());
  const leadWallNow = leadOptions.wallNow || Date.now;
  const leadLeaseMs = leadOptions.leaseMs ?? 90_000;
  const publicLead = (lead: ProjectLead & { bridgeId: string; deadline: number }): ProjectLead => {
    const { bridgeId: _bridgeId, deadline: _deadline, ...publicFields } = lead;
    return publicFields;
  };
  const currentLead = (projectId: string) => {
    const lead = leads.get(projectId);
    if (lead && lead.deadline <= leadNow()) { leads.delete(projectId); control.bump(projectId); return undefined; }
    return lead;
  };
  const initialControl = new WeakMap<Request,Map<string,ReturnType<Control["stamp"]>>>();
  const controlStamp = (c: any, projectId: string) => {
    const bypass=c.req.header("x-agentklar-peer-internal")===peerInternal || !c.req.header("authorization");
    const current=control.stamp(projectId,c.req.header("x-agentklar-bridge-id"),currentLead(projectId),bypass);
    const captured=initialControl.get(c.req.raw)?.get(projectId);
    const stamp=captured?{...captured,bypass}:current;
    control.check(projectId,stamp,currentLead(projectId));
    return stamp;
  };
  const leadReply = (projectId: string) => {
    const lead = currentLead(projectId);
    return { ...control.status(projectId,lead ? publicLead(lead) : null) };
  };
  const secretPath = join(home, "mcp-token");
  if (!existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  const bearer = readFileSync(secretPath, "utf8").trim();
  const session = randomBytes(32).toString("hex");
  let setup = randomBytes(32).toString("hex");
  let setupExpires = Date.now() + 5 * 60_000;
  let mutations = 0;
  let quiesced = !!startupMaintenance;
  let stopping = false;
  const setupUrl = () => `http://127.0.0.1:${port}/setup?token=${setup}`;
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    "http://127.0.0.1:5173",
  ]);
  const matches = (a: string | undefined, b: string) =>
    !!a &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  app.onError((e, c) => c.json({ error: e.message }, e instanceof ControlError || e instanceof ApprovalError || e instanceof PeerError || e instanceof ChangeError ? e.status as 400 : e instanceof InstructionError || e instanceof SetupError || e instanceof SkillError || e instanceof NativeChangeError ? e.status : 500));
  app.use("*", async (c, next) => {
    const host = c.req.header("host") || new URL(c.req.url).host;
    if (![`127.0.0.1:${port}`, "127.0.0.1:5173"].includes(host))
      return c.json({ error: "Local loopback host required" }, 403);
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin))
      return c.json({ error: "Remote origins are not allowed" }, 403);
    if (c.req.path.startsWith("/api/operator/")) {
      if (!operator || c.req.header("authorization") !== undefined || c.req.header("origin") !== undefined || c.req.header("cookie") !== undefined ||
          !matches(c.req.header("x-agentklar-operator-key"), operator.key) ||
          !matches(c.req.header("x-agentklar-service-id"), operator.id))
        return c.json({ error: "Local service operator required" }, 403);
      if (c.req.path.startsWith("/api/operator/onboarding")) {
        const mutation = c.req.method !== "GET";
        if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
        if (mutation) mutations++;
        try { await next(); } finally { if (mutation) mutations--; }
        return;
      }
      return next();
    }
    if (
      c.req.path === "/api/health" ||
      c.req.path === "/setup" ||
      !c.req.path.startsWith("/api/")
    )
      return next();
    const ui = matches(getCookie(c, `agentklar_session_${port}`), session);
    const mcp = matches(c.req.header("authorization"), `Bearer ${bearer}`);
    if (!ui && !mcp)
      return c.json(
        { error: operator ? "Run agentklar service open to open the local UI." : "Open the one-time setup URL printed by the local service." },
        401,
      );
    if (c.req.path === "/api/onboarding" && (!ui || c.req.header("authorization") !== undefined || (c.req.method !== "GET" && (!origin || !origins.has(origin)))))
      return c.json({ error: "Only the trusted local UI may read or save onboarding preferences" }, 403);
    if (/^\/api\/projects\/[^/]+\/control(?:\/recover)?$/.test(c.req.path) && c.req.method !== "GET" && (!ui || !!c.req.header("authorization") || !origin || !origins.has(origin)))
      return c.json({error:"Only the trusted local UI may change project control policy or recover a lead."},403);
    if (c.req.path.startsWith("/api/remote-approvals/") && (!ui || !origin || !origins.has(origin) || !!c.req.header("authorization")))
      return c.json({ error:"Only the trusted local UI with its exact Origin may view or answer remote approvals." },403);
    if (c.req.path.startsWith("/api/peers/settings/human") && (!ui || !!c.req.header("authorization") || (c.req.method !== "GET" && (!origin || !origins.has(origin)))))
      return c.json({ error:"Only the trusted local UI may configure human approval relay." },403);
    if (c.req.path.startsWith("/api/peers/settings") && (!ui || mcp || (c.req.method !== "GET" && (!origin || !origins.has(origin)))))
      return c.json({ error: "Only the trusted local UI may pair devices or change peer grants" }, 403);
    if (c.req.path.startsWith("/api/update") && (!ui || c.req.header("authorization") !== undefined || (c.req.method !== "GET" && (!origin || !origins.has(origin)))))
      return c.json({ error: "Only the trusted local UI may check AgentKlar updates" }, 403);
    if (c.req.path.includes("/setup/") && (!ui || mcp || (c.req.method !== "GET" && (!origin || !origins.has(origin)))))
      return c.json({ error: "Only the trusted local UI may read or change native MCP setup" }, 403);
    if (/^\/api\/projects\/[^/]+\/(?:native-settings|plugins)(?:\/|$)/.test(c.req.path) && (!ui || mcp || (c.req.method !== "GET" && (!origin || !origins.has(origin)))))
      return c.json({ error: "Only the trusted local UI may manage native defaults and plugins" }, 403);
    if (
      (c.req.path.startsWith("/api/approvals/") ||
        (c.req.path === "/api/native-installations" && c.req.method !== "GET") ||
        (c.req.path.includes("/instructions") && c.req.method !== "GET") ||
        (c.req.path.includes("/skills") && c.req.method !== "GET")) &&
      (!ui || !origin || !origins.has(origin) || mcp)
    )
      return c.json(
        { error: "Only the trusted local UI may answer approvals or change native files and skills" },
        403,
      );
    if (/^\/api\/projects\/[^/]+\/instructions\/[^/]+$/.test(c.req.path) && c.req.method === "GET" && (!ui || mcp))
      return c.json({ error: "Only the trusted local UI may read instruction text" }, 403);
    if (/^\/api\/projects\/[^/]+\/skills\/[^/]+$/.test(c.req.path) && c.req.method === "GET")
      return c.json({ error: "Skill previews are available through POST only" }, 403);
    if (c.req.method !== "GET" && !mcp && (!origin || !origins.has(origin)))
      return c.json({ error: "Exact local Origin required" }, 403);
    const mutation = c.req.method !== "GET";
    if (mutation && (quiesced || stopping)) return c.json({ error: "Local service is stopping." }, 503);
    if(c.req.method!=="GET")initialControl.set(c.req.raw,new Map(store.projects().map(p=>[p.id,control.stamp(p.id,c.req.header("x-agentklar-bridge-id"),currentLead(p.id),true)])));
    if (mutation) mutations++;
    try { await next(); } finally { if (mutation) mutations--; }
  });
  app.get("/api/projects/:id/routing-metadata", async c => {
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    const project = store.projects().find(p => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    if (activeRuns(project.id).length >= 2) return c.json({ error: "Mapped project already has two active workers." }, 409);
    const baseCommit = gitBase(project.path).baseCommit;
    const catalog = withObservedMuseQuota(await catalogs.refresh(project), store.runs());
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    if (gitBase(project.path).baseCommit !== baseCommit) return c.json({ error: "Project Git HEAD changed during discovery." }, 409);
    if (activeRuns(project.id).length >= 2) return c.json({ error: "Mapped project already has two active workers." }, 409);
    return c.json({ deviceId: devices.device.id, projectId: project.id, baseCommit, catalog, installed: installedWorkers() });
  });
  app.get("/api/update", c => { c.header("Cache-Control", "no-store"); return c.json(updateStatus()); });
  app.post("/api/update/check", async c => {
    if (!z.object({}).strict().safeParse(await c.req.json().catch(() => null)).success) return c.json({ error: "Provide an empty JSON object." }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(await checkUpdate());
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/onboarding", c => { c.header("Cache-Control", "no-store"); return c.json(onboarding.read()); });
  app.put("/api/onboarding", async c => {
    const parsed = onboardingPreferencesInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide a project, main harness and expected revision only." }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(saveOnboarding(parsed.data));
  });
  app.get("/api/operator/onboarding", c => {
    c.header("Cache-Control", "no-store");
    return c.json({ preferences: onboarding.read(), projects: store.projects(), harnesses: selectedHarnesses() });
  });
  app.post("/api/operator/onboarding/preferences", async c => {
    const parsed = onboardingPreferencesInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide a project, main harness and expected revision only." }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(saveOnboarding(parsed.data));
  });
  app.post("/api/operator/onboarding/project", async c => {
    const parsed = onboardingProjectInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide a name and absolute existing project folder." }, 400);
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    const result = registerProject(parsed.data);
    return c.json(result.project, result.created ? 201 : 200);
  });
  app.post("/api/operator/onboarding/setup", async c => {
    const parsed = onboardingSetupInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide the project, harness, operation and its saved ID only." }, 400);
    const input = parsed.data, project = store.projects().find(p => p.id === input.projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(await nativeOperation(async () => input.operation === "status" ? nativeSetup.status(project, input.harness)
      : input.operation === "preview" ? nativeSetup.preview(project, input.harness)
      : input.operation === "apply" ? nativeSetup.apply(project, input.harness, input.previewId)
      : nativeSetup.undo(project, input.harness, input.changeId), input.operation === "apply" || input.operation === "undo"));
  });
  app.get("/api/operator/status", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ id: operator!.id, pid: process.pid, version: currentVersion, quiesced,
      activeRuns: store.runs().filter((r) => ["running", "needs_attention"].includes(r.state) || workers.has(r.id) || (r.workerPid !== undefined && processGroupAlive(r.workerPid))).length });
  });
  app.post("/api/operator/open", (c) => {
    setup = randomBytes(32).toString("hex");
    setupExpires = Date.now() + 5 * 60_000;
    c.header("Cache-Control", "no-store");
    return c.json({ url: setupUrl() });
  });
  app.post("/api/operator/quiesce", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (stopping) return c.json({ error: "Local service is stopping." }, 503);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.force !== "boolean")
      return c.json({ error: "Provide only a boolean force field" }, 400);
    if (store.approvals().length && !body.force) return c.json({ error: "Native approvals are still pending. Finish the work before stopping." }, 409);
    if (mutations && !body.force) return c.json({ error: "Local changes are still being saved. Retry after they finish." }, 409);
    quiesced = true;
    const activeRuns = store.runs().filter((r) => ["running", "needs_attention"].includes(r.state) || workers.has(r.id) || (r.workerPid !== undefined && processGroupAlive(r.workerPid))).length;
    if (activeRuns && !body.force) { if (!stopping) quiesced = false; return c.json({ error: `${activeRuns} active run(s); use --force to stop them` }, 409); }
    return c.json({ ok: true, activeRuns });
  });
  app.post("/api/operator/resume", (c) => {
    if (readUpdateMaintenance(home, operator!.id)) return c.json({ error: "An update is paused for recovery. Inspect its private recovery record first." }, 409);
    if (stopping) return c.json({ error: "Local service is stopping." }, 503);
    quiesced = false;
    return c.json({ ok: true });
  });
  app.get("/setup", (c) => {
    if (!setup || Date.now() > setupExpires || !matches(c.req.query("token"), setup))
      return c.text(
        operator ? "Setup link expired. Run agentklar service open for a new link." : "Setup link expired. Restart the local service to get a new link.",
        403,
      );
    setup = "";
    setCookie(c, `agentklar_session_${port}`, session, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    return c.redirect("/");
  });
  app.get("/api/benchmarks", (c) => {
    if (new URL(c.req.url).search) return c.json({ error: "Benchmark queries are not supported." }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(benchmarks.get());
  });
  app.post("/api/benchmarks/refresh", async (c) => {
    if (new URL(c.req.url).search) return c.json({ error: "Benchmark queries are not supported." }, 400);
    const parsed = z.object({}).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide an empty JSON object." }, 400);
    if (stopping) return c.json({ error: "Local service is stopping." }, 503);
    c.header("Cache-Control", "no-store");
    try { return c.json(await benchmarks.refresh()); }
    catch { return c.json({ error: "Public benchmark refresh failed. The last good scores are still available." }, 503); }
  });
  app.get("/api/projects", (c) => c.json(store.projects()));
  for (const kind of ["native-settings", "plugins"] as const) {
    app.use(`/api/projects/:id/${kind}/*`, async (c, next) => {
      if (!z.uuid().safeParse(c.req.param("id")).success || new URL(c.req.url).search) return c.json({ error: "Invalid native management request" }, 400);
      if (!store.projects().some(p => p.id === c.req.param("id"))) return c.json({ error: "Project not found" }, 404);
      if (c.req.method !== "GET" && activeRuns().length) return c.json({ error: "Wait for active workers to finish before changing native settings or plugins." }, 409);
      c.header("Cache-Control", "no-store");
      return next();
    });
    for (const operation of ["preview", "apply", "undo"] as const) app.post(`/api/projects/:id/${kind}/${operation}`, async c => {
      const schema = operation === "preview" ? (kind === "plugins" ? pluginPreviewInput : nativeSettingInput) : operation === "apply" ? nativePreviewId : nativeChangeId;
      const input = schema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: "Invalid native change request" }, 400);
      const project = store.projects().find(p => p.id === c.req.param("id"))!;
      return c.json(await nativeOperation(async () => {
        if (kind === "plugins") return operation === "preview" ? nativePlugins.preview(project) : operation === "apply" ? nativePlugins.apply(project, nativePreviewId.parse(input.data).previewId) : nativePlugins.undo(project, nativeChangeId.parse(input.data).changeId);
        return operation === "preview" ? nativeDefaults.preview(project, nativeSettingInput.parse(input.data)) : operation === "apply" ? nativeDefaults.apply(project, nativePreviewId.parse(input.data).previewId) : nativeDefaults.undo(project, nativeChangeId.parse(input.data).changeId);
      }, operation !== "preview"));
    });
  }
  app.get("/api/projects/:id/plugins", async c => {
    const project = store.projects().find(p => p.id === c.req.param("id"));
    if (!project || new URL(c.req.url).search) return c.json({ error: "Project not found or invalid query" }, 404);
    c.header("Cache-Control", "no-store"); return c.json(await nativeOperation(() => nativePlugins.status(project)));
  });
  app.get("/api/projects/:id/native-settings/:harness", async c => {
    const harness = nativeSettingHarness.safeParse(c.req.param("harness"));
    if (!harness.success) return c.json({ error: "Unsupported native settings harness" }, 400);
    return c.json(await nativeOperation(() => nativeDefaults.read(store.projects().find(p => p.id === c.req.param("id"))!, harness.data)));
  });
  app.get("/api/projects/:id/runs", (c) => {
    c.header("Cache-Control", "no-store");
    const projectId = c.req.param("id");
    if (!z.uuid().safeParse(projectId).success) return c.json({ error: "Invalid project ID" }, 400);
    if (!store.projects().some((p) => p.id === projectId)) return c.json({ error: "Project not found" }, 404);
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => !["limit", "cursor", "remoteLimit", "remoteCursor"].includes(key)) ||
        ["limit", "cursor", "remoteLimit", "remoteCursor"].some((key) => params.getAll(key).length > 1))
      return c.json({ error: "Invalid run list query" }, 400);
    const limitText = params.get("limit") ?? "20";
    const cursorText = params.get("cursor");
    const limit = Number(limitText);
    const before = cursorText === null ? Number.MAX_SAFE_INTEGER : Number(cursorText);
    const remoteLimitText = params.get("remoteLimit") ?? "20";
    const remoteCursorText = params.get("remoteCursor");
    const remoteLimit = Number(remoteLimitText);
    const remoteBefore = remoteCursorText === null ? Number.MAX_SAFE_INTEGER : Number(remoteCursorText);
    if (!/^[1-9]\d*$/.test(limitText) || !Number.isSafeInteger(limit) || limit > 20 ||
        (cursorText !== null && (!/^[1-9]\d*$/.test(cursorText) || !Number.isSafeInteger(before))))
      return c.json({ error: "limit must be 1–20 and cursor a positive integer" }, 400);
    if (!/^[1-9]\d*$/.test(remoteLimitText) || !Number.isSafeInteger(remoteLimit) || remoteLimit > 20 ||
        (remoteCursorText !== null && (!/^[1-9]\d*$/.test(remoteCursorText) || !Number.isSafeInteger(remoteBefore))))
      return c.json({ error: "remoteLimit must be 1–20 and remoteCursor a positive integer" }, 400);
    const rows = store.projectRuns(projectId, before, limit + 1);
    const runs: ProjectRun[] = [];
    let nextCursor: string | null = null;
    for (const row of rows.slice(0, limit)) {
      const item = projectRun(row.run);
      if (runs.length && JSON.stringify({ projectId, runs: [...runs, item], nextCursor: String(row.rowid), hasMore: true }).length > 20000)
        break;
      runs.push(item);
      nextCursor = String(row.rowid);
    }
    const hasMore = runs.length < rows.length;
    const remoteRows = peers.historyRows(projectId, remoteBefore, remoteLimit);
    const remoteDispatches = [];
    let remoteNextCursor: string | null = null;
    for (const row of remoteRows.slice(0, remoteLimit)) {
      const item = { ...row.dispatch, ...(row.dispatch.lastKnownRun ? { lastKnownRun: projectRun(row.dispatch.lastKnownRun) } : {}) };
      if (remoteDispatches.length && JSON.stringify({ projectId, runs, nextCursor, hasMore, remoteDispatches: [...remoteDispatches, item], remoteNextCursor: String(row.rowid), remoteDispatchesHasMore: true }).length > 22000) break;
      remoteDispatches.push(item);
      remoteNextCursor = String(row.rowid);
    }
    const remoteDispatchesHasMore = remoteDispatches.length < remoteRows.length;
    return c.json({ projectId, runs, nextCursor: hasMore ? nextCursor : null, hasMore,
      ...(remoteRows.length || remoteCursorText !== null ? { remoteDispatches, remoteDispatchesHasMore, remoteNextCursor: remoteDispatchesHasMore ? remoteNextCursor : null } : {}) });
  });
  app.use("/api/projects/:id/control/*", async (c, next) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json({
      error: "Invalid project ID"
    }, 400);
    if (!store.projects().some(p => p.id === id)) return c.json({
      error: "Project not found"
    }, 404);
    if (c.req.method === "GET") {
      const url = new URL(c.req.url);
      const keys = [...url.searchParams.keys()];
      if (new Set(keys).size !== keys.length || keys.some(k => !(["offset", "limit"].includes(k) && c.req.path.endsWith("/packets")))) return c.json({
        error: "Invalid handoff query"
      }, 400);
    }
    return next();
  });
  const controlStatus = (id: string) => control.status(id, currentLead(id)?publicLead(currentLead(id)!): null);
  app.get("/api/projects/:id/native-inventory", c => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success || new URL(c.req.url).search) return c.json({ error: "Invalid project ID or inventory query" }, 400);
    const project = store.projects().find(p => p.id === id);
    if (!project) return c.json({ error: "Project not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(nativeInventory(id, project.path, { env: setupOptions.env, userHome: skillOptions.userHome }));
  });
  app.get("/api/projects/:id/control", c => {
    if (!z.uuid().safeParse(c.req.param("id")).success || new URL(c.req.url).search) return c.json({
      error: "Invalid project ID or control query"
    }, 400);
    if (!store.projects().some(p => p.id === c.req.param("id"))) return c.json({
      error: "Project not found"
    }, 404);
    return c.json(controlStatus(c.req.param("id")));
  });
  app.put("/api/projects/:id/control", async c => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json({
      error: "Invalid project ID"
    }, 400);
    if (!store.projects().some(p => p.id === id)) return c.json({
      error: "Project not found"
    }, 404);
    const input = z.object({
      mode: z.enum(["advisory", "coordinated"]),
      expectedRevision: z.number().int().nonnegative()
    }).strict().safeParse(await c.req.json().catch (() => null));
    if (!input.success) return c.json({
      error: "Invalid control policy"
    }, 400);
    controlStatus(id);
    control.policy(id, input.data.mode, input.data.expectedRevision);
    return c.json(controlStatus(id));
  });
  app.post("/api/projects/:id/control/recover", async c => {
    const id = c.req.param("id");
    if (!store.projects().some(p => p.id === id)) return c.json({
      error: "Project not found"
    }, 404);
    const input = z.object({
      expectedRevision: z.number().int().nonnegative(),
      observedClaimId: z.uuid().nullable()
    }).strict().safeParse(await c.req.json().catch (() => null));
    if (!input.success) return c.json({
      error: "Invalid observed control state"
    }, 400);
    const status = controlStatus(id);
    if (status.revision !== input.data.expectedRevision || (status.lead?.claimId ?? null) !== input.data.observedClaimId) throw new ControlError("Control changed. Read the current state before recovering.");
    leads.delete(id);
    control.bump(id);
    return c.json(controlStatus(id));
  });
  app.post("/api/projects/:id/control/prepare", async c => {
    const id = c.req.param("id");
    if (!store.projects().some(p => p.id === id)) return c.json({
      error: "Project not found"
    }, 404);
    if (!z.object({
    }).strict().safeParse(await c.req.json().catch (() => null)).success) return c.json({
      error: "Expected empty preparation input"
    }, 400);
    const local = store.runs().filter(r => r.projectId === id);
    const remote = peers.list().filter(r => r.projectId === id);
    const active = (state: string) => ["running", "needs_attention"].includes(state);
    local.sort((a, b) => Number(active(b.state))-Number(active(a.state)));
    remote.sort((a, b) => Number(b.connection === "unknown" || active(b.lastKnownRun?.state ?? ""))-Number(a.connection === "unknown" || active(a.lastKnownRun?.state ?? "")));
    const status = controlStatus(id);
    return c.json(control.prepare({
      projectId: id,
      context: store.context(id),
      control: status,
      observedLead: status.lead,
      work: {
        local: local.slice(0, 10).map(r => ({
          id: r.id,
          state: r.state,
          harness: r.harness || "codex",
          updatedAt: r.updatedAt,
          workspace: r.workspace? {
            kind: r.workspace.kind,
            path: r.workspace.path?.slice(0, 300),
            pathTruncated: (r.workspace.path?.length ?? 0)>300
          }
          : undefined,
          followUp: r.followUp
        })),
        remote: remote.slice(0, 10).map(r => ({
          id: r.id,
          ownerDeviceId: r.ownerDeviceId,
          ownerRunId: r.ownerRunId,
          state: r.lastKnownRun?.state ?? null,
          lastObservedAt: r.lastObservedAt,
          connection: r.connection
        })),
        totalLocal: local.length,
        totalRemote: remote.length,
        pointers: {
          context: `/api/projects/${id}/context`,
          runs: `/api/projects/${id}/runs`,
          remoteRuns: `/api/projects/${id}/runs?remoteLimit=20`
        }
      }
    }));
  });
  app.get("/api/projects/:id/control/packets", c => {
    const parsed = z.object({
      offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      limit: z.coerce.number().int().min(1).max(10).default(10)
    }).safeParse(c.req.query());
    if (!parsed.success) return c.json({
      error: "Invalid handoff page"
    }, 400);
    return c.json(control.list(c.req.param("id"), parsed.data.offset, parsed.data.limit));
  });
  app.get("/api/projects/:id/control/packets/:packetId", c => c.json({
    ...control.read(c.req.param("id"), c.req.param("packetId")),
    receipt: control.receipt(c.req.param("packetId"))
  }));
  app.post("/api/projects/:id/control/packets/:packetId/accept", async c => {
    if (stopping || quiesced) return c.json({
      error: "Service is stopping"
    }, 503);
    if (c.req.header("authorization") !== `Bearer ${bearer}`) return c.json({
      error: "Receiving MCP bridge required"
    }, 403);
    const bridgeId = c.req.header("x-agentklar-bridge-id");
    if (!bridgeId || !/^[a-f0-9]{64}$/.test(bridgeId)) return c.json({
      error: "MCP bridge identity required"
    }, 400);
    const input = z.object({
      requestId: z.uuid(),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
      expectedContextRevision: z.number().int().nonnegative(),
      expectedControlRevision: z.number().int().nonnegative()
    }).strict().safeParse(await c.req.json().catch (() => null));
    if (!input.success) return c.json({
      error: "Invalid handoff acceptance"
    }, 400);
    const id = c.req.param("id");
    const status = controlStatus(id);
    const wall = leadWallNow(),
    seen = new Date(wall).toISOString();
    const source = sourceFromHeader(c.req.header("x-agentklar-mcp-client"));
    const lead = {
      claimId: randomUUID(),
      projectId: id,
      clientName: source?.kind === "mcp"?source.clientName: null,
      ...(source?.kind === "mcp" && source.clientVersion? {
        clientVersion: source.clientVersion
      }
      : {
      }),
      claimedAt: seen,
      lastSeenAt: seen,
      expiresAt: new Date(wall+leadLeaseMs).toISOString()
    };
    if (!control.hasRequest(input.data.requestId) && (!currentLead(id) || currentLead(id)!.bridgeId !== bridgeId)) {
      if ([...leads.keys()].filter(k => currentLead(k)?.bridgeId === bridgeId).length>=16) return c.json({
        error: "One MCP bridge can lead at most 16 projects"
      }, 409);
    }
    const receipt = control.accept(id, c.req.param("packetId"), bridgeId, input.data, store.context(id).revision, status, lead);
    if (receipt.lead.claimId === lead.claimId)leads.set(id, {
      ...lead,
      bridgeId,
      deadline: leadNow()+leadLeaseMs
    });
    return c.json({
      receipt,
      control: controlStatus(id)
    });
  });
  app.get("/api/projects/:id/lead", (c) => {
    c.header("Cache-Control", "no-store");
    const projectId = c.req.param("id");
    if (!z.uuid().safeParse(projectId).success) return c.json({ error: "Invalid project ID" }, 400);
    if (!store.projects().some((p) => p.id === projectId)) return c.json({ error: "Project not found" }, 404);
    if (new URL(c.req.url).search) return c.json({ error: "Lead queries are not supported" }, 400);
    return c.json(leadReply(projectId));
  });
  app.post("/api/projects/:id/lead", async (c) => {
    c.header("Cache-Control", "no-store");
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    if (!matches(c.req.header("authorization"), `Bearer ${bearer}`)) return c.json({ error: "MCP bridge required" }, 403);
    const bridgeId = c.req.header("x-agentklar-bridge-id");
    if (!bridgeId || !/^[a-f0-9]{64}$/.test(bridgeId)) return c.json({ error: "MCP bridge identity required" }, 400);
    const projectId = c.req.param("id");
    if (!z.uuid().safeParse(projectId).success) return c.json({ error: "Invalid project ID" }, 400);
    if (!store.projects().some((p) => p.id === projectId)) return c.json({ error: "Project not found" }, 404);
    const parsed = leadActionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid lead action" }, 400);
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    const current = currentLead(projectId);
    const { action } = parsed.data;
    if(action === "takeover" && controlStatus(projectId).mode === "coordinated")return c.json({error:"Accept a reviewed handoff to take over a coordinated project."},409);
    if (action === "release") {
      if (!current || current.bridgeId !== bridgeId || current.claimId !== parsed.data.observedClaimId)
        return c.json({ error: "Lead claim changed", ...leadReply(projectId) }, 409);
      leads.delete(projectId); control.bump(projectId);
      return c.json(leadReply(projectId));
    }
    if (action === "claim" && current && current.bridgeId !== bridgeId)
      return c.json({ error: "Project lead already connected", ...leadReply(projectId) }, 409);
    if (action === "takeover" && (!current || current.claimId !== parsed.data.observedClaimId))
      return c.json({ error: "Lead claim changed", ...leadReply(projectId) }, 409);
    if ((!current || current.bridgeId !== bridgeId) &&
        [...leads.keys()].filter((id) => currentLead(id)?.bridgeId === bridgeId).length >= 16)
      return c.json({ error: "One MCP bridge can lead at most 16 projects" }, 409);
    const clock = leadNow();
    const wall = leadWallNow();
    const seen = new Date(wall).toISOString();
    const source = sourceFromHeader(c.req.header("x-agentklar-mcp-client"));
    const lead = action === "claim" && current
      ? { ...current, lastSeenAt: seen, expiresAt: new Date(wall + leadLeaseMs).toISOString(), deadline: clock + leadLeaseMs }
      : { claimId: randomUUID(), projectId, clientName: source?.kind === "mcp" ? source.clientName : null,
          ...(source?.kind === "mcp" && source.clientVersion ? { clientVersion: source.clientVersion } : {}),
          claimedAt: seen, lastSeenAt: seen, expiresAt: new Date(wall + leadLeaseMs).toISOString(),
          bridgeId, deadline: clock + leadLeaseMs };
    if (!(action === "claim" && current)) control.bump(projectId);
    leads.set(projectId, lead);
    return c.json(leadReply(projectId));
  });
  app.delete("/api/projects/:id/lead", async (c) => {
    c.header("Cache-Control", "no-store");
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    if (!matches(getCookie(c, `agentklar_session_${port}`), session) ||
        !!c.req.header("authorization"))
      return c.json({ error: "Local UI required" }, 403);
    const projectId = c.req.param("id");
    if (!z.uuid().safeParse(projectId).success) return c.json({ error: "Invalid project ID" }, 400);
    if (!store.projects().some((p) => p.id === projectId)) return c.json({ error: "Project not found" }, 404);
    if(controlStatus(projectId).mode==="coordinated")return c.json({error:"Recover coordinated control using its current control revision."},409);
    const parsed = z.object({ observedClaimId: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide the observed lead claim ID" }, 400);
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    if (currentLead(projectId)?.claimId !== parsed.data.observedClaimId)
      return c.json({ error: "Lead claim changed", ...leadReply(projectId) }, 409);
    leads.delete(projectId); control.bump(projectId);
    return c.json(leadReply(projectId));
  });
  app.post("/api/leads/renew", async (c) => {
    c.header("Cache-Control", "no-store");
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    if (!matches(c.req.header("authorization"), `Bearer ${bearer}`)) return c.json({ error: "MCP bridge required" }, 403);
    const bridgeId = c.req.header("x-agentklar-bridge-id");
    if (!bridgeId || !/^[a-f0-9]{64}$/.test(bridgeId)) return c.json({ error: "MCP bridge identity required" }, 400);
    const parsed = leadRenewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide 1–16 distinct lead claims" }, 400);
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    const renewed: { projectId: string; claimId: string }[] = [];
    for (const item of parsed.data.claims) {
      const current = currentLead(item.projectId);
      if (!current || current.bridgeId !== bridgeId || current.claimId !== item.claimId) continue;
      const clock = leadNow();
      const wall = leadWallNow();
      leads.set(item.projectId, { ...current, lastSeenAt: new Date(wall).toISOString(),
        expiresAt: new Date(wall + leadLeaseMs).toISOString(), deadline: clock + leadLeaseMs });
      renewed.push(item);
    }
    return c.json({ renewed });
  });
  app.get("/api/projects/:id/setup/:harness", async (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const harness = setupHarness.safeParse(c.req.param("harness"));
    if (!harness.success) return c.json({ error: "Unknown native setup harness" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(await nativeOperation(() => nativeSetup.status(project, harness.data)));
  });
  for (const operation of ["preview", "apply", "undo"] as const)
    app.post(`/api/projects/:id/setup/:harness/${operation}`, async (c) => {
      const project = store.projects().find((p) => p.id === c.req.param("id"));
      if (!project) return c.json({ error: "Project not found" }, 404);
      const harness = setupHarness.safeParse(c.req.param("harness"));
      if (!harness.success) return c.json({ error: "Unknown native setup harness" }, 400);
      const schema = operation === "preview" ? z.object({}).strict() : operation === "apply" ? z.object({ previewId: z.uuid() }).strict() : z.object({ changeId: z.uuid() }).strict();
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Provide only the saved preview or managed change ID." }, 400);
      c.header("Cache-Control", "no-store");
      return c.json(await nativeOperation(async () => operation === "preview" ? nativeSetup.preview(project, harness.data) : operation === "apply" ? nativeSetup.apply(project, harness.data, (parsed.data as unknown as { previewId: string }).previewId) : nativeSetup.undo(project, harness.data, (parsed.data as unknown as { changeId: string }).changeId), operation !== "preview"));
    });
  app.get("/api/projects/:id/instructions", (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    c.header("Cache-Control", "no-store");
    return project ? c.json(instructions.list(project)) : c.json({ error: "Project not found" }, 404);
  });
  app.get("/api/projects/:id/skills", (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    c.header("Cache-Control", "no-store");
    return project ? c.json(skills.list(project)) : c.json({ error: "Project not found" }, 404);
  });
  app.get("/api/skills", (c) => {
    c.header("Cache-Control", "no-store");
    const { projectId, ...snapshot } = skills.list(personalSkills);
    return c.json({ scope: "personal", ...snapshot });
  });
  for (const operation of ["preview", "preview-update", "install", "update", "remove"] as const)
    app.post(`/api/projects/:id/skills/${operation}`, async (c) => {
      const project = store.projects().find((p) => p.id === c.req.param("id"));
      if (!project) return c.json({ error: "Project not found" }, 404);
      const schema = operation === "preview" ? skillPreviewInput : (operation === "install" || operation === "update") ? skillIdInput : skillRemoveInput;
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Provide one native harness, a GitHub owner/repo, and one exact skill name or saved ID." }, 400);
      c.header("Cache-Control", "no-store");
      return c.json(operation === "preview" ? await skills.preview(project, parsed.data as typeof skillPreviewInput._output) : operation === "preview-update" ? await skills.previewUpdate(project, (parsed.data as typeof skillRemoveInput._output).installId) : operation === "update" ? skills.update(project, (parsed.data as typeof skillIdInput._output).previewId) : operation === "install" ? skills.install(project, (parsed.data as typeof skillIdInput._output).previewId) : skills.remove(project, (parsed.data as typeof skillRemoveInput._output).installId));
    });
  for (const operation of ["preview", "preview-update", "install", "update", "remove"] as const)
    app.post(`/api/skills/${operation}`, async (c) => {
      const schema = operation === "preview" ? skillPreviewInput : (operation === "install" || operation === "update") ? skillIdInput : skillRemoveInput;
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Provide one native harness, a GitHub owner/repo, and one exact skill name or saved ID." }, 400);
      c.header("Cache-Control", "no-store");
      return c.json(operation === "preview" ? await skills.preview(personalSkills, parsed.data as typeof skillPreviewInput._output) : operation === "preview-update" ? await skills.previewUpdate(personalSkills, (parsed.data as typeof skillRemoveInput._output).installId) : operation === "update" ? skills.update(personalSkills, (parsed.data as typeof skillIdInput._output).previewId) : operation === "install" ? skills.install(personalSkills, (parsed.data as typeof skillIdInput._output).previewId) : skills.remove(personalSkills, (parsed.data as typeof skillRemoveInput._output).installId));
    });
  app.get("/api/projects/:id/instructions/:file", (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const file = instructionFileSchema.safeParse(c.req.param("file"));
    if (!file.success) return c.json({ error: "Unknown instruction file" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(instructions.document(project, file.data));
  });
  app.post("/api/projects/:id/instructions/preview", async (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const parsed = instructionPreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide a native instruction file, UTF-8 text and the hash you read." }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(instructions.preview(project, parsed.data.file, parsed.data.text, parsed.data.expectedHash));
  });
  for (const operation of ["apply", "rollback"] as const)
    app.post(`/api/projects/:id/instructions/${operation}`, async (c) => {
      const project = store.projects().find((p) => p.id === c.req.param("id"));
      if (!project) return c.json({ error: "Project not found" }, 404);
      const schema = operation === "apply" ? z.object({ previewId: z.uuid() }).strict() : z.object({ changeId: z.uuid() }).strict();
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Provide the saved preview or change ID." }, 400);
      c.header("Cache-Control", "no-store");
      return c.json(operation === "apply" ? instructions.apply(project, (parsed.data as unknown as { previewId: string }).previewId) : instructions.rollback(project, (parsed.data as unknown as { changeId: string }).changeId));
    });
  app.get("/api/projects/:id/catalog", (c) => {
    const id = c.req.param("id");
    c.header("Cache-Control", "no-store");
    return store.projects().some((p) => p.id === id)
      ? c.json(catalogs.get(id) ? withObservedMuseQuota(catalogs.get(id)!, store.runs()) : null)
      : c.json({ error: "Project not found" }, 404);
  });
  app.post("/api/projects/:id/catalog", async (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(withObservedMuseQuota(await catalogs.refresh(project), store.runs()));
    } catch {
      return c.json({ error: "Native catalog could not be read." }, 503);
    }
  });
  app.post("/api/projects/:id/recommend", async (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const parsed = adviceSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: (
            parsed.error.issues[0]?.message || "Invalid advice request"
          ).slice(0, 240),
        },
        400,
      );
    const selected = parsed.data.roleId
      ? project.roles.find((r) => r.id === parsed.data.roleId)
      : undefined;
    if (parsed.data.roleId && !selected)
      return c.json({ error: "Role not found" }, 400);
    if (
      selected &&
      parsed.data.harness &&
      selected.harness !== parsed.data.harness
    )
      return c.json(
        { error: "Task harness must match the selected role harness." },
        400,
      );
    if (selected && !(workerHarnesses as readonly string[]).includes(selected.harness))
      return c.json(
        { error: "This role harness has no worker adapter yet." },
        400,
      );
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await deviceAdvice(project, parsed.data));
    } catch (error) {
      if (error instanceof PeerError) return c.json({ error: error.message }, error.status as 400 | 409 | 503);
      return c.json(
        { error: "Native advice evidence could not be read." },
        503,
      );
    }
  });
  app.get("/api/projects/:id/context", (c) => {
    const id = c.req.param("id");
    return store.projects().some((p) => p.id === id)
      ? c.json(store.context(id))
      : c.json({ error: "Project not found" }, 404);
  });
  app.put("/api/projects/:id/context", async (c) => {
    const id = c.req.param("id");
    if (!store.projects().some((p) => p.id === id))
      return c.json({ error: "Project not found" }, 404);
    const parsed = contextUpdateSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: parsed.error.issues[0]?.message || "Invalid project context" },
        400,
      );
    const stamp = controlStamp(c,id);
    control.check(id,stamp,currentLead(id));
    const { expectedRevision, ...text } = parsed.data;
    const context = {
      projectId: id,
      revision: expectedRevision + 1,
      ...text,
      updatedAt: new Date().toISOString(),
      updatedVia:
        c.req.header("authorization") === `Bearer ${bearer}`
          ? ("mcp" as const)
          : ("ui" as const),
    };
    return store.saveContext(context, expectedRevision)
      ? c.json(context)
      : c.json(
          {
            error:
              "Project context changed. Read the latest context and review your edits before saving again.",
          },
          409,
        );
  });
  app.get("/api/harnesses", (c) => c.json(selectedHarnesses()));
  app.get("/api/native-installations", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(devices.status(commands));
  });
  app.post("/api/native-installations", async (c) => {
    const parsed = z.object({ harness: z.enum(workerHarnesses), path: z.string().min(1).max(4096), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose a listed native installation." }, 400);
    if (stopping) return c.json({ error: "Local service is stopping." }, 503);
    if (!devices.save(parsed.data.harness, parsed.data.path, parsed.data.fingerprint)) return c.json({ error: "Installation changed or is no longer available. Refresh installations and choose again." }, 409);
    return c.json({ saved: true, restartRequired: commands[parsed.data.harness] !== parsed.data.path, activeRuns: activeRuns().length });
  });
  app.get("/api/snapshot", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      projects: store.projects(),
      runs: store.runs().map(compactRun),
      approvals: store.approvals(),
      device: devices.device,
      peers: peers.settings().peers,
      remoteDispatches: peers.list(),
      harnesses: selectedHarnesses(),
      controls: Object.fromEntries(store.projects().map(p=>[p.id,control.status(p.id,currentLead(p.id)?publicLead(currentLead(p.id)!):null)])),
      leads: Object.fromEntries(store.projects().flatMap((p) => {
        const lead = currentLead(p.id);
        return lead ? [[p.id, publicLead(lead)]] : [];
      })),
    });
  });
  app.post("/api/projects", async (c) => {
    const parsed = onboardingProjectInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "Provide a name and absolute existing project folder." },
        400,
      );
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    const result = registerProject(parsed.data);
    return c.json(result.project, result.created ? 201 : 200);
  });
  app.patch("/api/projects/:id", async (c) => {
    const p = store.projects().find((p) => p.id === c.req.param("id"));
    if (!p) return c.json({ error: "Project not found" }, 404);
    const parsed = z
      .object({
        preference: z.enum(["economical", "balanced", "best"]).optional(),
        roles: z
          .array(role)
          .max(30)
          .refine(
            (rs) => new Set(rs.map((r) => r.id)).size === rs.length,
            "Role IDs must be unique",
          )
          .optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: parsed.error.issues[0]?.message || "Invalid project settings",
        },
        400,
      );
    for (const chosen of parsed.data.roles ?? []) if (chosen.peerId) peers.resolveMapping(p.id, chosen.peerId);
    const updated = { ...p, ...parsed.data };
    store.saveProject(updated);
    return c.json(updated);
  });
  app.post("/api/tasks/start", async (c) => {
    if (nativeWrites) return c.json({ error: "A native settings or plugin change is still running. Retry after it finishes." }, 409);
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    if (!parsed.success)
      return c.json(
        { error: parsed.error.issues[0]?.message || "Invalid task" },
        400,
      );
    const data = parsed.data;
    if (data.routingEvidence && c.req.header("x-agentklar-peer-internal") !== peerInternal) return c.json({ error: "Routing evidence is accepted only from a scoped peer request." }, 400);
    const p = store.projects().find((p) => p.id === data.projectId);
    if (!p) return c.json({ error: "Project not found" }, 404);
    const { includeProjectContext, ...originalInputs } = data;
    if (originalInputs.routing?.deviceScope === "connected") { const { deviceScope, ...routing } = originalInputs.routing; originalInputs.routing = routing; }
    if (!data.followUp && originalInputs.routing?.requiresTools?.length === 0) { const { requiresTools, ...routing } = originalInputs.routing; originalInputs.routing = routing; }
    const launchHash = createHash("sha256")
      .update(
        JSON.stringify({
          ...originalInputs,
          ...(includeProjectContext ? {} : { includeProjectContext: false }),
        }),
      )
      .digest("hex");
    const prior = store.existing(p.id, data.idempotencyKey);
    if (prior) {
      if (prior.launchHash !== launchHash)
        return c.json(
          { error: "Idempotency key already used for a different task" },
          409,
        );
      return c.json(compactRun(prior));
    }
    const priorDispatch = peers.existing(p.id, data.idempotencyKey);
    if (priorDispatch) {
      if (priorDispatch.launchHash !== launchHash) return c.json({ error: "Idempotency key already used for a different task" }, 409);
      if (priorDispatch.connection === "unknown") {
        try { return c.json(await peers.status(priorDispatch.id)); } catch { return c.json({ ...priorDispatch, error: "Saved owner mapping is unavailable. Restore it to query this existing dispatch; no replacement was started." }); }
      }
      return c.json(priorDispatch);
    }
    const stamp = controlStamp(c,p.id);
    const remoteRole = data.roleId ? p.roles.find((item) => item.id === data.roleId) : undefined;
    if (data.roleId && !remoteRole) return c.json({ error: "Role not found" }, 400);
    if (data.followUp && data.readOnly !== (data.followUp.kind === "review"))
      return c.json({ error: "Reviews must be read only; fixes must allow workspace changes" }, 400);
    const remoteSource = data.followUp ? peers.list().find((item) => item.id === data.followUp!.runId) : undefined;
    const sourceNeeds = remoteSource?.lastKnownRun?.routing ?? (data.followUp ? store.run(data.followUp.runId)?.routing : undefined);
    if (data.followUp && sourceNeeds?.requiresTools?.length && data.routing?.requiresTools === undefined) {
      data.routing = { complexity: data.routing?.complexity ?? "standard", taskType: data.routing?.taskType ?? "coding", requiresImages: data.routing?.requiresImages ?? sourceNeeds.requiresImages, ...data.routing, requiresTools: sourceNeeds.requiresTools };
    }
    if (remoteSource && remoteSource.projectId !== p.id) return c.json({ error: "Linked dispatch not found in this project" }, 404);
    if (remoteSource && remoteRole && !remoteRole.peerId)
      return c.json({ error: "Linked remote work must stay on its owning computer. Prepare and apply a changes handoff before continuing locally." }, 409);
    const recheck = () => {
      if (quiesced || stopping) throw new PeerError("Local service is stopping.", 503);
      if (nativeWrites) throw new PeerError("A native settings or plugin change is still running. Retry after it finishes.", 409);
      const local = store.existing(p.id, data.idempotencyKey);
      const remote = peers.existing(p.id, data.idempotencyKey);
      const existing = local || remote;
      if (existing && existing.launchHash !== launchHash) throw new PeerError("Idempotency key already used for a different task", 409);
      if (existing) return local ? compactRun(local) : remote;
      control.check(p.id,stamp,currentLead(p.id));
      const latest = store.projects().find(project => project.id === p.id);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(p)) throw new PeerError("Project settings changed during selection. Start again.", 409);
    };
    let automaticAdvice: ReturnType<typeof recommendWorker> | undefined;
    let automaticRouting: RoutingDecision | undefined;
    let automaticPeer: string | undefined;
    let automaticBase: string | undefined;
    if (data.routing && !data.roleId && !data.followUp && !data.routingEvidence) {
      if (data.workspace === "worktree") automaticBase = gitBase(p.path).baseCommit;
      const mappings = JSON.stringify(peers.settings().peers);
      automaticAdvice = await deviceAdvice(p, adviceSchema.parse({ harness: data.harness, model: data.model, ...data.routing, readOnly: data.readOnly, workspace: data.workspace || "project", ...(c.req.header("x-agentklar-peer-internal") === peerInternal ? { deviceScope: "local" } : {}) }));
      const replay = recheck(); if (replay) return c.json(replay);
      if (mappings !== JSON.stringify(peers.settings().peers)) return c.json({ error: "Saved computer mappings changed during selection. Start again." }, 409);
      if (automaticBase && gitBase(p.path).baseCommit !== automaticBase) return c.json({ error: "Source Git HEAD changed during selection. Start again." }, 409);
      const choice = automaticAdvice.choice;
      if (!choice) return c.json({ error: "No suitable model found.", reasons: automaticAdvice.reasons.slice(0,4), warnings: automaticAdvice.warnings.slice(0,8) }, 409);
      automaticRouting = decisionFor(automaticAdvice);
      automaticPeer = choice.device?.peerId;
    }
    if (remoteRole?.peerId || remoteSource || automaticPeer) {
      if (data.followUp && !remoteSource) return c.json({ error: "Linked local work cannot continue on another computer. Prepare and apply a changes handoff first." }, 409);
      const source = remoteSource ? await peers.followUpSource(p.id, remoteSource.id) : undefined;
      const replay = recheck(); if (replay) return c.json(replay);
      if (source && source.dispatch.lastKnownRun?.state !== "completed")
        return c.json({ error: "Linked source must be completed on its owning computer." }, 409);
      if (source && data.followUp?.kind === "fix" && source.dispatch.lastKnownRun?.followUp?.kind !== "review")
        return c.json({ error: "A fix must follow a completed review on the owning computer." }, 409);
      if (source && data.followUp?.kind === "review" && source.dispatch.lastKnownRun?.followUp?.kind === "review")
        return c.json({ error: "A review must follow implementation or a fix on the owning computer." }, 409);
      const mappingId = remoteRole?.peerId ?? automaticPeer ?? remoteSource!.peerId;
      const mapping = peers.resolveMapping(p.id, mappingId);
      if (source && (mapping.deviceId !== source.mapping.deviceId || mapping.remoteProjectId !== source.mapping.remoteProjectId))
        return c.json({ error: "Linked work must use the same owning computer and project. Use a changes handoff for another owner." }, 409);
      if (remoteRole && data.harness && data.harness !== remoteRole.harness) return c.json({ error: "Task harness must match the selected role harness." }, 400);
      if (data.workspace === "project") return c.json({ error: "Remote tasks require their separate Git worktree." }, 400);
      const baseCommit = source?.baseCommit ?? automaticBase ?? gitBase(p.path).baseCommit;
      if (data.baseCommit && data.baseCommit !== baseCommit) return c.json({ error: "Requested Git base differs from the linked source or local HEAD." }, 409);
      const harness = automaticRouting?.selected.harness ?? remoteRole?.harness ?? data.harness ?? source?.dispatch.lastKnownRun?.harness ?? "codex";
      const model = automaticRouting?.selected.model ?? data.model ?? remoteRole?.model ?? (!remoteRole ? source?.dispatch.lastKnownRun?.effectiveModel ?? source?.dispatch.lastKnownRun?.model : undefined);
      const prompt = composeWorkerPrompt({ prompt: data.prompt, ...(remoteRole ? { roleSnapshot: remoteRole } : {}), ...(data.includeProjectContext ? { contextSnapshot: store.context(p.id) } : {}) });
      if (prompt.length > 32000) return c.json({ error: "Remote task and project context exceed the supported prompt size. Shorten the task or omit project context." }, 400);
      control.check(p.id,stamp,currentLead(p.id));
      return c.json(await peers.start({ peerId: mappingId, idempotencyKey: data.idempotencyKey, baseCommit,
        task: { prompt, harness, model, readOnly: data.readOnly, includeProjectContext: false,
          ...(source && data.followUp ? { followUp: { runId: source.dispatch.ownerRunId!, kind: data.followUp.kind } } : {}),
          ...(automaticRouting ? { routingEvidence: automaticRouting } : data.routing ? { routing: { complexity: data.routing.complexity, requiresImages: data.routing.requiresImages, ...(data.routing.requiresTools !== undefined ? { requiresTools: data.routing.requiresTools } : {}), taskType: data.routing.taskType } } : {}) } }, launchHash, data.prompt), 202);
    }
    if (data.followUp) {
      const linked = linkedSource(p.id, data.followUp);
      if (linked.error) return c.json({ error: linked.error }, 409);
    }
    const linkedAtStart = data.followUp ? linkedSource(p.id, data.followUp).source : undefined;
    if (data.followUp && !linkedAtStart) return c.json({ error: "Linked run changed before launch" }, 409);
    if (data.baseCommit && data.workspace !== "worktree") return c.json({ error: "An exact Git base requires a separate worktree." }, 400);
    const workspaceChoice = linkedAtStart ? (linkedAtStart.workspace?.kind || "project") : (data.workspace || "project");
    if (linkedAtStart && data.workspace && data.workspace !== workspaceChoice)
      return c.json({ error: "Linked work must use its original workspace." }, 409);
    const target = linkedAtStart || (workspaceChoice === "project" ? {
      projectId: p.id, workspace: { kind: "project", path: p.path },
    } as Run : null);
    const busyError = () => {
      if (nativeWrites) return "A native settings or plugin change is still running. Retry after it finishes.";
      if (activeRuns(p.id).length >= 2) return "Project already has two active workers.";
      if (target && activeRuns().some((r) => sameWorkspace(r, target)))
        return workspaceChoice === "project"
          ? "Project busy. Wait for or stop its active worker."
          : "Workspace busy. Wait for or stop its active worker.";
      return null;
    };
    const initialBusy = busyError();
    if (initialBusy) return c.json({ error: initialBusy }, 409);
    let selected = data.roleId
      ? p.roles.find((r) => r.id === data.roleId)
      : undefined;
    if (data.roleId && !selected)
      return c.json({ error: "Role not found" }, 400);
    if (selected && data.harness && data.harness !== selected.harness)
      return c.json(
        { error: "Task harness must match the selected role harness." },
        400,
      );
    let harness = data.harness || selected?.harness || "codex";
    if (!(workerHarnesses as readonly string[]).includes(harness))
      return c.json({ error: "This harness has no worker adapter yet." }, 400);
    if (harness !== "codex" && harness !== "claude" && data.readOnly)
      return c.json({ error: `${harness} cannot enforce read-only work. Choose Codex or Claude Code for a review.` }, 400);
    let model = data.model || selected?.model;
    let routing: RoutingDecision | undefined = data.routingEvidence;
    if (data.routing && !data.routingEvidence) {
      let advice;
      try {
        advice = automaticAdvice ?? await deviceAdvice(p, adviceSchema.parse({ roleId: data.roleId, harness: data.harness, model: data.model, ...data.routing, readOnly: data.readOnly, workspace: workspaceChoice, followUp: data.followUp }));
      } catch {
        if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
        return c.json({ error: "Native routing evidence could not be read. Retry or choose a model manually." }, 503);
      }
      // Metadata discovery awaits. Recheck every condition that can change before insert.
      if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
      const remoteReplay = recheck(); if (remoteReplay) return c.json(remoteReplay);
      const existing = store.existing(p.id, data.idempotencyKey);
      if (existing) return existing.launchHash === launchHash
        ? c.json(compactRun(existing))
        : c.json({ error: "Idempotency key already used for a different task" }, 409);
      const busy = busyError();
      if (busy) return c.json({ error: busy }, 409);
      const latest = store.projects().find((item) => item.id === p.id);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(p))
        return c.json({ error: "Project settings changed during model selection. Start again." }, 409);
      if (data.followUp) {
        const linked = linkedSource(p.id, data.followUp);
        if (linked.error) return c.json({ error: linked.error }, 409);
        if (JSON.stringify(linked.source.workspace) !== JSON.stringify(linkedAtStart?.workspace))
          return c.json({ error: "Linked workspace changed during model selection." }, 409);
      }
      if (!advice.choice) return c.json({
        error: "No suitable model found. Review native access, model pins, and task requirements.",
        reasons: advice.reasons.slice(0, 4),
        warnings: advice.warnings.filter((warning) => !warning.startsWith("Limited policy advice.")).slice(0, 4),
      }, 409);
      const choice = advice.choice;
      harness = choice.harness;
      model = choice.model;
      if (harness !== "codex" && harness !== "claude" && data.readOnly)
        return c.json({ error: `${harness} cannot enforce read-only work. Choose Codex or Claude Code for a review.` }, 400);
      routing = decisionFor(advice);
    }
    if (data.routingEvidence) {
      const evidence = data.routingEvidence;
      if (evidence.selected.harness !== harness || evidence.selected.model !== model || evidence.selected.device?.id !== devices.device.id)
        return c.json({ error: "Selected remote model or owner differs from the scoped routing evidence." }, 409);
      const catalog = withObservedMuseQuota(await catalogs.refresh(p), store.runs());
      const replay = recheck(); if (replay) return c.json(replay);
      const eligible = selectedWorkerEligibility({ harness: harness as RoutingDecision["selected"]["harness"], model: model! }, { catalog, installed: installedWorkers() }, evidence.requiresImages || Boolean(data.routing?.requiresImages), Date.now(), evidence.selected.basis, { requiresTools: [...new Set([...(evidence.requiresTools || []), ...(data.routing?.requiresTools || [])])], readOnly: data.readOnly });
      if (!eligible.eligible) return c.json({ error: `Selected remote worker is no longer eligible: ${eligible.reason}. No replacement was started.` }, 409);
      const required = [...new Set([...(evidence.requiresTools || []), ...(data.routing?.requiresTools || [])])];
      routing = { ...evidence, requiresImages: evidence.requiresImages || Boolean(data.routing?.requiresImages), ...(required.length ? { requiresTools: required } : {}) };
      const busy = busyError(); if (busy) return c.json({ error: busy }, 409);
    }
    const command = commands[harness as WorkerHarness];
    if (!command)
      return c.json(
        {
          error: `Install ${harnesses().find(h => h.id === harness)?.name || harness} and set up its native CLI first.`,
        },
        409,
      );
    const source = data.followUp ? linkedSource(p.id, data.followUp).source : undefined;
    if (data.followUp && !source)
      return c.json({ error: "Linked run changed before launch" }, 409);
    const clip = (value: string) => ({ text: value.slice(0, 8000), truncated: value.length > 8000 });
    const original = source && clip(source.followUpContext?.originalPrompt ?? source.prompt);
    const result = source && clip(source.result);
    const followUpContext: FollowUpContext | undefined = source && original && result ? {
      originalPrompt: original.text,
      originalPromptTruncated: !!source.followUpContext?.originalPromptTruncated || original.truncated,
      sourceResult: result.text,
      sourceResultTruncated: !!source.resultTruncated || result.truncated,
      sourceRunId: source.id,
      sourceHarness: source.harness || "codex",
      sourceModel: source.effectiveModel || source.model || null,
      sourceState: "completed",
    } : undefined;
    const now = new Date().toISOString();
    const context = data.includeProjectContext
      ? store.context(p.id)
      : undefined;
    const homeVariable = harness === "codex" ? "CODEX_HOME" : harness === "claude" ? "CLAUDE_CONFIG_DIR" : null;
    const configuredHome = homeVariable ? process.env[homeVariable] : undefined;
    const nativeHome = !homeVariable ? undefined : configuredHome === undefined
      ? join(homedir(), harness === "codex" ? ".codex" : ".claude")
      : isAbsolute(configuredHome) ? configuredHome : undefined;
    const openCodeEnv = harness === "opencode" ? { ...process.env } : undefined;
    const openCodeScope = openCodeEnv ? captureOpenCodeScope(openCodeEnv) : undefined;
    const runId = randomUUID();
    let workspace: Run["workspace"];
    if (source) {
      workspace = source.workspace || { kind: "project", path: p.path };
      if (workspace.kind === "worktree") {
        if (!workspace.verified || !workspace.path || !workspace.branch ||
          workspace.rootRunId !== (source.followUp?.rootRunId || source.id))
          return c.json({ error: "Linked worktree has no verified folder." }, 409);
        try {
          if (verifyWorktree(workspace, workspace.path) !== workspace.branch)
            throw new Error();
        } catch { return c.json({ error: "Linked worktree changed or is missing." }, 409); }
      } else if (workspace.path !== p.path)
        return c.json({ error: "Linked project workspace changed." }, 409);
    } else if (workspaceChoice === "project") workspace = { kind: "project", path: p.path };
    else {
      try {
        const base = gitBase(p.path);
        if (data.baseCommit && data.baseCommit !== base.baseCommit) return c.json({ error: "Project HEAD changed from the requested Git base." }, 409);
        workspace = { kind: "worktree", repoRoot: base.repoRoot, commonDir: base.commonDir,
          repoStamp: base.repoStamp, commonStamp: base.commonStamp, baseCommit: base.baseCommit,
          rootRunId: runId, ...(harness === "claude" ? {
            nativeName: runId, plannedPath: join(base.repoRoot, ".claude", "worktrees", runId),
          } : {}) };
        if (harness !== "claude") workspace = plannedWorktree(workspace, home);
      } catch (error) { return c.json({ error: (error as Error).message }, 409); }
    }
    const r: Run = {
      id: runId,
      harness: harness as WorkerHarness,
      projectId: p.id,
      roleId: data.roleId,
      prompt: data.prompt,
      model,
      ...(routing ? { routing } : {}),
      ...(source && data.followUp ? {
        followUp: { kind: data.followUp.kind, parentRunId: source.id, rootRunId: source.followUp?.rootRunId || source.id },
        followUpContext,
      } : {}),
      roleSnapshot: selected,
      ...(context && (context.brief || context.memory || context.handoff)
        ? { contextSnapshot: context }
        : {}),
      readOnly: data.readOnly,
      nativeHome,
      nativeHomeEnv: configuredHome === undefined ? "unset" : "set",
      ...(openCodeScope ? { openCodeScope } : {}),
      workspace,
      ...(c.req.header("authorization") === `Bearer ${bearer}`
        ? { launchSource: sourceFromHeader(c.req.header("x-agentklar-mcp-client")) }
        : { launchSource: { kind: "ui" } as const }),
      state: "running",
      result: "",
      tokens: null,
      createdAt: now,
      updatedAt: now,
      launchHash,
    };
    const finalBusy = busyError();
    if (finalBusy) return c.json({ error: finalBusy }, 409);
    store.insertRun(r, data.idempotencyKey);
    store.event(
      r.id,
      "started",
      workspace.kind === "worktree" && !workspace.verified && !workspace.nativeName
        ? "Preparing separate Git worktree."
        : `${harnesses().find(h => h.id === harness)?.name || harness} worker started.`,
    );
    queueMicrotask(() => {
      const callbacks: NativeCallbacks = {
        update: (patch) => {
          const current = store.run(r.id);
          if (current && (["running", "needs_attention"].includes(current.state) ||
            (Object.keys(patch).length === 1 && ("workerPid" in patch || "workspace" in patch))))
            store.saveRun({ ...current, ...patch, updatedAt: new Date().toISOString() });
        },
        event: (kind, text) => store.event(r.id, kind, text),
        approval: (a, answer) => { store.saveApproval(a); answers.set(a.id, answer); },
        done: () => {
          workers.delete(r.id);
          store.clearApprovals(r.id);
          for (const [id] of answers)
            if (!store.approvals().some((a) => a.id === id)) answers.delete(id);
        },
      };
      const launch = (ready: Run) => {
        control.check(p.id,stamp,currentLead(p.id));
        const worker = factory(command, ready, ready.workspace?.path || p.path, callbacks, openCodeEnv);
        workers.set(r.id, worker);
        return worker;
      };
      try {
        if (quiesced || stopping) {
          store.saveRun({ ...r, state: "interrupted", error: "Local service stopped before worker launch.", updatedAt: new Date().toISOString() });
          return;
        }
        if (workspace.kind === "worktree" && !workspace.nativeName && !workspace.verified) {
          const abort = new AbortController();
          const preparing = { stop: () => abort.abort(), closed: Promise.resolve() as Promise<void> };
          preparing.closed = (async () => {
            try {
              const verified = await createWorktree(workspace, abort.signal, (pid) => callbacks.update({ workerPid: pid }));
              callbacks.update({ workspace: verified });
              const current = store.run(r.id);
              if (abort.signal.aborted || quiesced || stopping || !current || !["running", "needs_attention"].includes(current.state)) return;
              const worker = launch({ ...current, workspace: verified });
              await worker.closed;
            } catch (error) {
              try {
                if (workspace.path && verifyWorktree(workspace, workspace.path) === workspace.branch)
                  callbacks.update({ workspace: { ...workspace, verified: true,
                    workspaceStamp: projectRootIdentity(workspace.path) } });
              } catch { /* Keep planned path and branch so partial Git artifacts can be inspected. */ }
              const current = store.run(r.id);
              if (current && ["running", "needs_attention"].includes(current.state))
                callbacks.update({ state: "failed", error: (error as Error).message });
            } finally {
              if (workers.get(r.id) === preparing) workers.delete(r.id);
            }
          })();
          workers.set(r.id, preparing);
        } else launch(r);
      } catch (e) {
        store.saveRun({
          ...store.run(r.id)!,
          state: "failed",
          error: (e as Error).message,
          updatedAt: new Date().toISOString(),
        });
      }
    });
    return c.json(compactRun(r), 202);
  });
  app.get("/api/runs/:id", async (c) => {
    if (peers.list().some((item) => item.id === c.req.param("id"))) return c.json(await peers.status(c.req.param("id")));
    const r = store.run(c.req.param("id"));
    return r ? c.json(compactRun(r)) : c.json({ error: "Run not found" }, 404);
  });
  app.get("/api/runs/:id/handoff", (c) => {
    const run = store.run(c.req.param("id"));
    if (!run) return c.json({ error: "Run not found" }, 404);
    c.header("Cache-Control", "no-store");
    const project = store.projects().find((p) => p.id === run.projectId);
    const cli = commands[run.harness ?? "codex"] ?? null;
    return c.json(runHandoff(run, project,
      activeRuns().some((item) => sameWorkspace(item, run)), cli));
  });
  app.get("/api/runs/:id/context", async (c) => {
    if (peers.list().some((item) => item.id === c.req.param("id"))) return c.json(await peers.context(c.req.param("id")));
    const r = store.run(c.req.param("id"));
    return r
      ? c.json({ runId: r.id, contextSnapshot: r.contextSnapshot ?? null, followUpContext: r.followUpContext ?? null })
      : c.json({ error: "Run not found" }, 404);
  });
  app.get("/api/runs/:id/changes", async (c) => {
    const options = changeOptions(new URL(c.req.url).searchParams);
    const handoffs = sourceHandoffs(c.req.param("id"));
    try { return c.json({ ...packetView(await runChanges(c.req.param("id")), options), handoffs }); }
    catch (e) {
      if (handoffs.length && (e instanceof ChangeError || e instanceof PeerError)) return c.json({ currentChangesStatus: "unavailable", message: e.message, handoffs });
      throw e;
    }
  });
  app.post("/api/runs/:id/changes/prepare", async (c) => {
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    const parsed = z.object({ projectId: z.uuid(), includePatch: z.boolean().default(false) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose a registered recipient project and optional includePatch boolean." }, 400);
    const packet = await runChanges(c.req.param("id"));
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    const preview = changes.prepare(parsed.data.projectId, packet);
    return c.json({ ...preview, ...(preview.applied ? { applied: appliedView(preview.applied) } : {}), packet: packetView(preview.packet, { includePatch: String(parsed.data.includePatch) as "true" | "false" }) });
  });
  app.get("/api/changes/:id", (c) => {
    const options = changeOptions(new URL(c.req.url).searchParams);
    const preview = changes.read(c.req.param("id"));
    return c.json({ ...preview, ...(preview.applied ? { applied: appliedView(preview.applied) } : {}), packet: packetView(preview.packet, options) });
  });
  app.post("/api/changes/:id/apply", async (c) => {
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    const parsed = z.object({ expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedBaseCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide the exact reviewed digest and Git base." }, 400);
    const applied = await changes.apply(c.req.param("id"), parsed.data.expectedDigest, parsed.data.expectedBaseCommit);
    return c.json(appliedView(applied));
  });
  app.get("/api/runs/:id/tail", (c) => {
    if (peers.list().some((item) => item.id === c.req.param("id"))) return c.json({ error: "Remote event tails are available on the owning computer. Use run_status here for current owner evidence." }, 409);
    if (!store.run(c.req.param("id")))
      return c.json({ error: "Run not found" }, 404);
    const after = Number(c.req.query("after") || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      return c.json({ error: "after must be a nonnegative integer" }, 400);
    const events = store.events(c.req.param("id"), after);
    const nextAfter = events.at(-1)?.id || after;
    const hasMore = !!store.db
      .prepare("SELECT id FROM events WHERE runId=? AND id>? LIMIT 1")
      .get(c.req.param("id"), nextAfter);
    return c.json({
      events,
      nextAfter,
      hasMore,
      truncated: events.some((e) => e.textTruncated) || hasMore,
    });
  });
  app.get("/api/runs/:id/result", (c) => {
    const dispatch = peers.list().find((item) => item.id === c.req.param("id"));
    if (dispatch) return c.json({ dispatchId: dispatch.id, ownerDeviceId: dispatch.ownerDeviceId, ownerRunId: dispatch.ownerRunId ?? null,
      connection: dispatch.connection, lastObservedAt: dispatch.lastObservedAt ?? null, state: dispatch.lastKnownRun?.state ?? null,
      result: dispatch.lastKnownRun?.result ?? "", resultTruncated: dispatch.lastKnownRun?.resultTruncated ?? false,
      ...(sourceHandoffs(dispatch.id).length ? { handoffs: sourceHandoffs(dispatch.id) } : {}),
      message: "Last observed owner result. Use run_status to refresh. Full result and native continuation are available on the owning computer." });
    const r = store.run(c.req.param("id"));
    return r
      ? c.json({
          state: r.state,
          result: r.result,
          resultTruncated: !!r.resultTruncated,
          error: r.error,
          tokens: r.tokens,
          museSubscriptionUsage: r.museSubscriptionUsage,
          threadId: r.threadId,
          turnId: r.turnId,
          effectiveModel: r.effectiveModel,
          harness: r.harness || "codex",
          contextRevision: r.contextSnapshot?.revision ?? null,
          followUp: r.followUp ?? null,
          workspace: r.workspace ?? { kind: "project", path: store.projects().find((p) => p.id === r.projectId)?.path },
          launchSource: r.launchSource,
          ...(sourceHandoffs(r.id).length ? { handoffs: sourceHandoffs(r.id) } : {}),
        })
      : c.json({ error: "Run not found" }, 404);
  });
  app.post("/api/runs/:id/stop", async (c) => {
    const dispatch = peers.list().find(item=>item.id===c.req.param("id"));
    if (dispatch) { controlStamp(c,dispatch.projectId); return c.json(await peers.cancel(dispatch.id)); }
    const r = store.run(c.req.param("id"));
    if (!r) return c.json({ error: "Run not found" }, 404);
    controlStamp(c,r.projectId);
    workers.get(r.id)?.stop();
    if (["running", "needs_attention"].includes(r.state)) {
      store.saveRun({
        ...r,
        state: "cancelled",
        updatedAt: new Date().toISOString(),
      });
      store.clearApprovals(r.id);
    }
    return c.json(compactRun(store.run(r.id)!));
  });
  app.post("/api/approvals/:id", async (c) => {
    const data = await c.req.json().catch(() => null);
    const receipt = approvalActions.local(c.req.param("id"),data?.decision);
    return c.json({ ok:true,receipt });
  });
  app.get("/api/peers/settings/human", c => c.json(peers.humanSettings()));
  for (const [operation, handler] of [["grant", (v: unknown) => peers.humanGrant(v)], ["save", (v: unknown) => peers.humanSave(v)], ["revoke", (v: unknown) => peers.humanRevoke(v)], ["remove", (v: unknown) => peers.humanRemove(v)]] as const)
    app.post(`/api/peers/settings/human/${operation}`, async c => {
      try { return c.json(handler(await c.req.json())); }
      catch (error) { if(error instanceof z.ZodError) return c.json({error:"Invalid human approval settings."},400);throw error; }
    });
  app.post("/api/peer-human",async c => {
    try { const reply=await peers.humanOwner(await c.req.json());return c.json(reply.body as object,reply.status as 200); }
    catch(error) { if(error instanceof z.ZodError) return c.json({error:"Invalid human peer request."},400);throw error; }
  });
  const emptyHumanRead = async (c: { req: { json: () => Promise<unknown> } }) => z.object({}).strict().safeParse(await c.req.json().catch(()=>null)).success;
  app.post("/api/remote-approvals/:dispatchId/list",async c => {
    if(!await emptyHumanRead(c))return c.json({error:"Approval reads require an empty object."},400);
    return c.json(await peers.humanList(c.req.param("dispatchId")) as object);
  });
  app.post("/api/remote-approvals/:dispatchId/:approvalId/read",async c => {
    if(!await emptyHumanRead(c))return c.json({error:"Approval reads require an empty object."},400);
    return c.json(await peers.humanRead(c.req.param("dispatchId"),c.req.param("approvalId")) as object);
  });
  app.post("/api/remote-approvals/:dispatchId/:approvalId/answer",async c => {
    const parsed=approvalAnswerSchema.omit({approvalId:true}).safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:"Provide the reviewed digest, offered decision and stable request ID."},400);
    return c.json(await peers.humanAnswer(c.req.param("dispatchId"),{...parsed.data,approvalId:c.req.param("approvalId")}) as object);
  });
  app.get("/api/peers/settings", c => c.json(peers.settings()));
  for (const [operation, handler] of [["grant", (v: unknown) => peers.grant(v)], ["revoke", (v: unknown) => peers.revoke(v)], ["save", (v: unknown) => peers.saveConnection(v)], ["test", (v: unknown) => peers.test(v)]] as const)
    app.post(`/api/peers/settings/${operation}`, async c => {
      try { return c.json(await handler(await c.req.json())); }
      catch (e) { if (e instanceof z.ZodError) return c.json({ error: "Invalid peer settings." }, 400); throw e; }
    });
  app.post("/api/peer", async c => {
    try { const reply = await peers.owner(await c.req.json()); return c.json(reply.body as object, reply.status as 200); }
    catch (e) { if (e instanceof z.ZodError) return c.json({ error: "Invalid peer request." }, 400); throw e; }
  });
  app.get("/api/peers/dispatch", c => c.json({ dispatches: peers.list() }));
  app.post("/api/peers/dispatch", async c => {
    try { const data = await c.req.json(); const mapping=peers.settings().peers.find(item=>item.id===data.peerId); if(!mapping)return c.json({error:"Peer mapping not found"},404); if(!peers.existing(mapping.projectId,data.idempotencyKey)){const stamp=controlStamp(c,mapping.projectId); control.check(mapping.projectId,stamp,currentLead(mapping.projectId));} return c.json(await peers.start(data)); }
    catch (e) { if (e instanceof z.ZodError) return c.json({ error: "Invalid remote task." }, 400); throw e; }
  });
  app.post("/api/peers/dispatch/:id/status", async c => c.json(await peers.status(c.req.param("id"))));
  app.post("/api/peers/dispatch/:id/cancel", async c => {const d=peers.list().find(item=>item.id===c.req.param("id"));if(!d)return c.json({error:"Dispatch not found"},404);controlStamp(c,d.projectId);return c.json(await peers.cancel(d.id));});
  let closing: Promise<void> | undefined;
  return {
    app,
    store,
    bearer,
    setupUrl: setupUrl(),
    close: () => {
      stopping = true;
      quiesced = true;
      leads.clear();
      return closing ??= (async () => {
        await Promise.allSettled([...nativeOperations]);
        await skills.close();
        await nativeSetup.close();
        await catalogs.close();
        await benchmarks.close();
        const current = [...workers.values()];
        for (const w of current) w.stop();
        await Promise.all(current.map((w) => w.closed));
        store.close();
        release();
      })();
    },
  };
}
