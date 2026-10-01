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
import { Store } from "./store.ts";
import { harnesses, executable } from "./harnesses.ts";
import { NativeWorker, type NativeCallbacks } from "./native.ts";
import { ClaudeWorker } from "./claude.ts";
import { MuseWorker } from "./muse.ts";
import { OpenCodeWorker } from "./opencode.ts";
import { CatalogCache, readCatalog, type CatalogReader } from "./catalog.ts";
import { BenchmarkCache } from "./benchmarks.ts";
import type { Run, Project, ProjectRun, ProjectLead, RoutingDecision, FollowUpContext } from "./contracts.ts";
import { sourceFromHeader } from "./launch-source.ts";
import { recommendationSchema, recommendWorker } from "./recommend.ts";
import { Instructions, InstructionError, instructionFileSchema, instructionPreviewSchema } from "./instructions.ts";
import { NativeSetup, SetupError, type NativeSetupOptions } from "./setup.ts";
import { ProjectSkills, SkillError, skillPreviewInput, skillIdInput, skillRemoveInput } from "./skills.ts";
import { runHandoff } from "./handoff.ts";
import { createWorktree, gitBase, gitCheckout, plannedWorktree, verifyWorktree } from "./workspace.ts";
import { projectRootIdentity } from "./project-root.ts";
const role = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    harness: z.string().min(1).max(80),
    model: z.string().min(1).max(120).optional(),
    responsibility: z.string().max(4000),
  })
  .strict();
function compactRun(r: Run): Run {
  const { contextSnapshot, followUpContext, nativeHome, nativeHomeEnv, ...metadata } = r;
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
    harness: z.enum(["codex", "claude", "muse", "opencode"]).optional(),
    model: z.string().min(1).max(120).optional(),
    readOnly: z.boolean().default(false),
    includeProjectContext: z.boolean().default(true),
    routing: z.object({
      complexity: z.enum(["routine", "standard", "hard"]).default("standard"),
      requiresImages: z.boolean().default(false),
      taskType: z.enum(["coding", "reasoning", "data-analysis", "language"]).default("coding"),
    }).strict().optional(),
    followUp: z.object({ runId: z.uuid(), kind: z.enum(["review", "fix"]) }).strict().optional(),
    workspace: z.enum(["project", "worktree"]).optional(),
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
) => { stop: () => void; closed?: Promise<void> };
export type Operator = { id: string; key: string };
export function createService(
  home: string,
  port = 4317,
  factory: WorkerFactory = (command, run, path, callbacks) =>
    run.harness === "claude"
      ? new ClaudeWorker(command, run, path, callbacks)
      : run.harness === "muse"
      ? new MuseWorker(command, run, path, callbacks)
      : run.harness === "opencode"
      ? new OpenCodeWorker(command, run, path, callbacks)
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
) {
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
  const app = new Hono();
  const instructions = new Instructions(store.db);
  const skills = new ProjectSkills(store.db, home, skillOptions);
  const personalSkills: Project = { id: "__personal_skills__", name: "Personal skills", path: personalHome, preference: "balanced", roles: [], createdAt: "" };
  const nativeSetup = new NativeSetup(store.db, home, port, { codex: nativeCommand, claude: claudeCommand, muse: museCommand, opencode: opencodeCommand }, setupOptions);
  const catalogs = new CatalogCache(catalogReader, {
    codex: nativeCommand,
    claude: claudeCommand,
    muse: museCommand,
    opencode: opencodeCommand,
  });
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
    if (lead && lead.deadline <= leadNow()) { leads.delete(projectId); return undefined; }
    return lead;
  };
  const leadReply = (projectId: string) => {
    const lead = currentLead(projectId);
    return { projectId, lead: lead ? publicLead(lead) : null };
  };
  const secretPath = join(home, "mcp-token");
  if (!existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  const bearer = readFileSync(secretPath, "utf8").trim();
  const session = randomBytes(32).toString("hex");
  let setup = randomBytes(32).toString("hex");
  let setupExpires = Date.now() + 5 * 60_000;
  let quiesced = false;
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
  app.onError((e, c) => c.json({ error: e.message }, e instanceof InstructionError || e instanceof SetupError || e instanceof SkillError ? e.status : 500));
  app.use("*", async (c, next) => {
    const host = c.req.header("host") || new URL(c.req.url).host;
    if (![`127.0.0.1:${port}`, "127.0.0.1:5173"].includes(host))
      return c.json({ error: "Local loopback host required" }, 403);
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin))
      return c.json({ error: "Remote origins are not allowed" }, 403);
    if (c.req.path.startsWith("/api/operator/")) {
      if (!operator || c.req.header("authorization") || c.req.header("origin") || c.req.header("cookie") ||
          !matches(c.req.header("x-agentklar-operator-key"), operator.key) ||
          !matches(c.req.header("x-agentklar-service-id"), operator.id))
        return c.json({ error: "Local service operator required" }, 403);
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
    if (c.req.path.includes("/setup/") && (!ui || mcp || (c.req.method !== "GET" && (!origin || !origins.has(origin)))))
      return c.json({ error: "Only the trusted local UI may read or change native MCP setup" }, 403);
    if (
      (c.req.path.startsWith("/api/approvals/") ||
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
    await next();
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/operator/status", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ id: operator!.id, pid: process.pid, quiesced,
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
    quiesced = true;
    const activeRuns = store.runs().filter((r) => ["running", "needs_attention"].includes(r.state) || workers.has(r.id) || (r.workerPid !== undefined && processGroupAlive(r.workerPid))).length;
    if (activeRuns && !body.force) { if (!stopping) quiesced = false; return c.json({ error: `${activeRuns} active run(s); use --force to stop them` }, 409); }
    return c.json({ ok: true, activeRuns });
  });
  app.post("/api/operator/resume", (c) => {
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
  app.get("/api/projects/:id/runs", (c) => {
    c.header("Cache-Control", "no-store");
    const projectId = c.req.param("id");
    if (!z.uuid().safeParse(projectId).success) return c.json({ error: "Invalid project ID" }, 400);
    if (!store.projects().some((p) => p.id === projectId)) return c.json({ error: "Project not found" }, 404);
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => !["limit", "cursor"].includes(key)) ||
        params.getAll("limit").length > 1 || params.getAll("cursor").length > 1)
      return c.json({ error: "Invalid run list query" }, 400);
    const limitText = params.get("limit") ?? "20";
    const cursorText = params.get("cursor");
    const limit = Number(limitText);
    const before = cursorText === null ? Number.MAX_SAFE_INTEGER : Number(cursorText);
    if (!/^[1-9]\d*$/.test(limitText) || !Number.isSafeInteger(limit) || limit > 20 ||
        (cursorText !== null && (!/^[1-9]\d*$/.test(cursorText) || !Number.isSafeInteger(before))))
      return c.json({ error: "limit must be 1–20 and cursor a positive integer" }, 400);
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
    return c.json({ projectId, runs, nextCursor: hasMore ? nextCursor : null, hasMore });
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
    if (action === "release") {
      if (!current || current.bridgeId !== bridgeId || current.claimId !== parsed.data.observedClaimId)
        return c.json({ error: "Lead claim changed", ...leadReply(projectId) }, 409);
      leads.delete(projectId);
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
    leads.set(projectId, lead);
    return c.json(leadReply(projectId));
  });
  app.delete("/api/projects/:id/lead", async (c) => {
    c.header("Cache-Control", "no-store");
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    if (!matches(getCookie(c, `agentklar_session_${port}`), session) ||
        matches(c.req.header("authorization"), `Bearer ${bearer}`))
      return c.json({ error: "Local UI required" }, 403);
    const projectId = c.req.param("id");
    if (!z.uuid().safeParse(projectId).success) return c.json({ error: "Invalid project ID" }, 400);
    if (!store.projects().some((p) => p.id === projectId)) return c.json({ error: "Project not found" }, 404);
    const parsed = z.object({ observedClaimId: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Provide the observed lead claim ID" }, 400);
    if (stopping) return c.json({ error: "Local service is stopping" }, 503);
    if (currentLead(projectId)?.claimId !== parsed.data.observedClaimId)
      return c.json({ error: "Lead claim changed", ...leadReply(projectId) }, 409);
    leads.delete(projectId);
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
    const harness = z.enum(["codex", "claude", "muse", "opencode"]).safeParse(c.req.param("harness"));
    if (!harness.success) return c.json({ error: "Unknown native setup harness" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(await nativeSetup.status(project, harness.data));
  });
  for (const operation of ["preview", "apply", "undo"] as const)
    app.post(`/api/projects/:id/setup/:harness/${operation}`, async (c) => {
      const project = store.projects().find((p) => p.id === c.req.param("id"));
      if (!project) return c.json({ error: "Project not found" }, 404);
      const harness = z.enum(["codex", "claude", "muse", "opencode"]).safeParse(c.req.param("harness"));
      if (!harness.success) return c.json({ error: "Unknown native setup harness" }, 400);
      const schema = operation === "preview" ? z.object({}).strict() : operation === "apply" ? z.object({ previewId: z.uuid() }).strict() : z.object({ changeId: z.uuid() }).strict();
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Provide only the saved preview or managed change ID." }, 400);
      c.header("Cache-Control", "no-store");
      return c.json(operation === "preview" ? await nativeSetup.preview(project, harness.data) : operation === "apply" ? await nativeSetup.apply(project, harness.data, (parsed.data as unknown as { previewId: string }).previewId) : await nativeSetup.undo(project, harness.data, (parsed.data as unknown as { changeId: string }).changeId));
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
      ? c.json(catalogs.get(id))
      : c.json({ error: "Project not found" }, 404);
  });
  app.post("/api/projects/:id/catalog", async (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await catalogs.refresh(project));
    } catch {
      return c.json({ error: "Native catalog could not be read." }, 503);
    }
  });
  app.post("/api/projects/:id/recommend", async (c) => {
    const project = store.projects().find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const parsed = recommendationSchema.safeParse(
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
    if (selected && !["codex", "claude", "muse", "opencode"].includes(selected.harness))
      return c.json(
        { error: "This role harness has no worker adapter yet." },
        400,
      );
    c.header("Cache-Control", "no-store");
    try {
      const catalog = await catalogs.refresh(project);
      return c.json(
        recommendWorker(project, parsed.data, catalog, {
          codex: !!nativeCommand,
          claude: !!claudeCommand,
          muse: !!museCommand,
          opencode: !!opencodeCommand,
        }, Date.now(), benchmarks.get()),
      );
    } catch {
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
  app.get("/api/harnesses", (c) => c.json(harnesses()));
  app.get("/api/snapshot", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      projects: store.projects(),
      runs: store.runs().map(compactRun),
      approvals: store.approvals(),
      harnesses: harnesses(),
      leads: Object.fromEntries(store.projects().flatMap((p) => {
        const lead = currentLead(p.id);
        return lead ? [[p.id, publicLead(lead)]] : [];
      })),
    });
  });
  app.post("/api/projects", async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(120),
        path: z.string().min(1).max(4096),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "Provide a name and absolute existing project folder." },
        400,
      );
    try {
      if (!isAbsolute(parsed.data.path)) throw new Error();
      const path = realpathSync(parsed.data.path);
      if (!statSync(path).isDirectory()) throw new Error();
      const prior = store.projects().find((p) => p.path === path);
      if (prior) return c.json(prior);
      const p: Project = {
        id: randomUUID(),
        name: parsed.data.name,
        path,
        preference: "balanced",
        roles: [],
        createdAt: new Date().toISOString(),
      };
      store.saveProject(p);
      return c.json(p, 201);
    } catch {
      return c.json(
        { error: "Project path must be an absolute existing folder." },
        400,
      );
    }
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
    const updated = { ...p, ...parsed.data };
    store.saveProject(updated);
    return c.json(updated);
  });
  app.post("/api/tasks/start", async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
    if (!parsed.success)
      return c.json(
        { error: parsed.error.issues[0]?.message || "Invalid task" },
        400,
      );
    const data = parsed.data;
    const p = store.projects().find((p) => p.id === data.projectId);
    if (!p) return c.json({ error: "Project not found" }, 404);
    const { includeProjectContext, ...originalInputs } = data;
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
    if (data.followUp && data.readOnly !== (data.followUp.kind === "review"))
      return c.json({ error: "Reviews must be read only; fixes must allow workspace changes" }, 400);
    if (data.followUp) {
      const linked = linkedSource(p.id, data.followUp);
      if (linked.error) return c.json({ error: linked.error }, 409);
    }
    const linkedAtStart = data.followUp ? linkedSource(p.id, data.followUp).source : undefined;
    if (data.followUp && !linkedAtStart) return c.json({ error: "Linked run changed before launch" }, 409);
    const workspaceChoice = linkedAtStart ? (linkedAtStart.workspace?.kind || "project") : (data.workspace || "project");
    if (linkedAtStart && data.workspace && data.workspace !== workspaceChoice)
      return c.json({ error: "Linked work must use its original workspace." }, 409);
    const target = linkedAtStart || (workspaceChoice === "project" ? {
      projectId: p.id, workspace: { kind: "project", path: p.path },
    } as Run : null);
    const busyError = () => {
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
    if (!["codex", "claude", "muse", "opencode"].includes(harness))
      return c.json({ error: "This harness has no worker adapter yet." }, 400);
    if ((harness === "muse" || harness === "opencode") && data.readOnly)
      return c.json({ error: `${harness === "muse" ? "Muse" : "OpenCode"} cannot enforce read-only work. Choose Codex or Claude Code for a review.` }, 400);
    let model = data.model || selected?.model;
    let routing: RoutingDecision | undefined;
    if (data.routing) {
      let advice;
      try {
        const catalog = await catalogs.refresh(p);
        advice = recommendWorker(p, {
          roleId: data.roleId,
          harness: data.harness,
          model: data.model,
          ...data.routing,
        }, catalog, { codex: !!nativeCommand, claude: !!claudeCommand, muse: !!museCommand, opencode: !!opencodeCommand }, Date.now(), benchmarks.get());
      } catch {
        if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
        return c.json({ error: "Native routing evidence could not be read. Retry or choose a model manually." }, 503);
      }
      // Metadata discovery awaits. Recheck every condition that can change before insert.
      if (quiesced || stopping) return c.json({ error: "Local service is stopping." }, 503);
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
      if ((harness === "muse" || harness === "opencode") && data.readOnly)
        return c.json({ error: `${harness === "muse" ? "Muse" : "OpenCode"} cannot enforce read-only work. Choose Codex or Claude Code for a review.` }, 400);
      routing = {
        selected: {
          harness: choice.harness, model: choice.model, roleId: choice.roleId,
          basis: choice.basis, tier: choice.tier,
          ...(choice.benchmark ? { benchmark: choice.benchmark } : {}),
        },
        preference: advice.preference,
        complexity: advice.complexity,
        taskType: advice.taskType,
        benchmarkMethod: advice.benchmarkMethod,
        requiresImages: advice.requiresImages,
        catalogCheckedAt: advice.catalogCheckedAt,
        policyVersion: advice.policyVersion,
        reasons: [...new Set([...choice.reasons, ...advice.reasons])].slice(0, 3),
        warnings: [...new Set([...choice.warnings, ...advice.warnings])].slice(0, 3),
      };
    }
    const command = harness === "claude" ? claudeCommand : harness === "muse" ? museCommand : harness === "opencode" ? opencodeCommand : nativeCommand;
    if (!command)
      return c.json(
        {
          error: `Install ${harness === "claude" ? "Claude Code" : harness === "muse" ? "Muse" : harness === "opencode" ? "OpenCode" : "Codex"} and set up its native CLI first.`,
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
      harness: harness as "codex" | "claude" | "muse" | "opencode",
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
    store.insertRun(r, data.idempotencyKey);
    store.event(
      r.id,
      "started",
      workspace.kind === "worktree" && !workspace.verified && !workspace.nativeName
        ? "Preparing separate Git worktree."
        : `${harness === "claude" ? "Claude Code" : harness === "muse" ? "Muse" : harness === "opencode" ? "OpenCode" : "Codex"} worker started.`,
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
        const worker = factory(command, ready, ready.workspace?.path || p.path, callbacks);
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
  app.get("/api/runs/:id", (c) => {
    const r = store.run(c.req.param("id"));
    return r ? c.json(compactRun(r)) : c.json({ error: "Run not found" }, 404);
  });
  app.get("/api/runs/:id/handoff", (c) => {
    const run = store.run(c.req.param("id"));
    if (!run) return c.json({ error: "Run not found" }, 404);
    c.header("Cache-Control", "no-store");
    const project = store.projects().find((p) => p.id === run.projectId);
    const cli = run.harness === "codex" || run.harness === "claude" || run.harness === "muse" || run.harness === "opencode" ? executable(run.harness) : null;
    return c.json(runHandoff(run, project,
      activeRuns().some((item) => sameWorkspace(item, run)), cli));
  });
  app.get("/api/runs/:id/context", (c) => {
    const r = store.run(c.req.param("id"));
    return r
      ? c.json({ runId: r.id, contextSnapshot: r.contextSnapshot ?? null, followUpContext: r.followUpContext ?? null })
      : c.json({ error: "Run not found" }, 404);
  });
  app.get("/api/runs/:id/tail", (c) => {
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
        })
      : c.json({ error: "Run not found" }, 404);
  });
  app.post("/api/runs/:id/stop", (c) => {
    const r = store.run(c.req.param("id"));
    if (!r) return c.json({ error: "Run not found" }, 404);
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
    const a = store.approvals().find((a) => a.id === c.req.param("id"));
    if (!a) return c.json({ error: "Approval no longer pending" }, 404);
    const data = await c.req.json().catch(() => null);
    if (
      typeof data?.decision !== "string" ||
      !a.decisions.includes(data.decision)
    )
      return c.json({ error: "Unsupported decision" }, 400);
    const answer = answers.get(a.id);
    if (!answer) return c.json({ error: "Native worker unavailable" }, 409);
    answer(data.decision);
    answers.delete(a.id);
    store.db.prepare("DELETE FROM approvals WHERE id=?").run(a.id);
    return c.json({ ok: true });
  });
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
