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
import { Store } from "./store.ts";
import { harnesses, executable } from "./harnesses.ts";
import { NativeWorker, type NativeCallbacks } from "./native.ts";
import { ClaudeWorker } from "./claude.ts";
import type { Run, Project } from "./contracts.ts";
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
  const { contextSnapshot, ...metadata } = r;
  return {
    ...metadata,
    contextRevision: contextSnapshot?.revision ?? null,
    prompt: r.prompt.slice(0, 300),
    promptTruncated: r.prompt.length > 300,
    result: r.result.slice(0, 1000),
    resultTruncated: !!r.resultTruncated || r.result.length > 1000,
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
    harness: z.enum(["codex", "claude"]).optional(),
    model: z.string().min(1).max(120).optional(),
    readOnly: z.boolean().default(false),
    includeProjectContext: z.boolean().default(true),
  })
  .strict();
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
export function createService(
  home: string,
  port = 4317,
  factory: WorkerFactory = (command, run, path, callbacks) =>
    run.harness === "claude"
      ? new ClaudeWorker(command, run, path, callbacks)
      : new NativeWorker(command, run, path, callbacks),
  nativeCommand: string | null = executable("codex"),
  claudeCommand: string | null = executable("claude"),
) {
  const release = ownHome(home);
  let store: Store;
  try {
    store = new Store(home);
  } catch (e) {
    release();
    throw e;
  }
  const app = new Hono();
  const workers = new Map<
    string,
    { stop: () => void; closed?: Promise<void> }
  >();
  const answers = new Map<string, (decision: string) => void>();
  const secretPath = join(home, "mcp-token");
  if (!existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  const bearer = readFileSync(secretPath, "utf8").trim();
  const session = randomBytes(32).toString("hex");
  let setup = randomBytes(32).toString("hex");
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    "http://127.0.0.1:5173",
  ]);
  const matches = (a: string | undefined, b: string) =>
    !!a &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  app.onError((e, c) => c.json({ error: e.message }, 500));
  app.use("*", async (c, next) => {
    const host = c.req.header("host") || new URL(c.req.url).host;
    if (![`127.0.0.1:${port}`, "127.0.0.1:5173"].includes(host))
      return c.json({ error: "Local loopback host required" }, 403);
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin))
      return c.json({ error: "Remote origins are not allowed" }, 403);
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
        { error: "Open the one-time setup URL printed by the local service." },
        401,
      );
    if (
      c.req.path.startsWith("/api/approvals/") &&
      (!ui || !origin || !origins.has(origin) || mcp)
    )
      return c.json(
        { error: "Only the trusted local UI may answer native approvals" },
        403,
      );
    if (c.req.method !== "GET" && !mcp && (!origin || !origins.has(origin)))
      return c.json({ error: "Exact local Origin required" }, 403);
    await next();
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/setup", (c) => {
    if (!setup || !matches(c.req.query("token"), setup))
      return c.text(
        "Setup link expired. Restart the local service to get a new link.",
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
  app.get("/api/projects", (c) => c.json(store.projects()));
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
  app.get("/api/snapshot", (c) =>
    c.json({
      projects: store.projects(),
      runs: store.runs().map(compactRun),
      approvals: store.approvals(),
      harnesses: harnesses(),
    }),
  );
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
    if (
      store
        .runs()
        .some(
          (r) =>
            r.projectId === p.id &&
            (["running", "needs_attention"].includes(r.state) ||
              workers.has(r.id) ||
              (r.workerPid !== undefined && processGroupAlive(r.workerPid))),
        )
    )
      return c.json(
        { error: "Project busy. Wait for or stop its active worker." },
        409,
      );
    const selected = data.roleId
      ? p.roles.find((r) => r.id === data.roleId)
      : undefined;
    if (data.roleId && !selected)
      return c.json({ error: "Role not found" }, 400);
    const harness = data.harness || selected?.harness || "codex";
    if (selected && data.harness && data.harness !== selected.harness)
      return c.json(
        { error: "Task harness must match the selected role harness." },
        400,
      );
    if (!["codex", "claude"].includes(harness))
      return c.json({ error: "This harness has no worker adapter yet." }, 400);
    const command = harness === "claude" ? claudeCommand : nativeCommand;
    if (!command)
      return c.json(
        {
          error: `Install ${harness === "claude" ? "Claude Code" : "Codex"} and sign in through its native CLI first.`,
        },
        409,
      );
    const now = new Date().toISOString();
    const context = data.includeProjectContext
      ? store.context(p.id)
      : undefined;
    const r: Run = {
      id: randomUUID(),
      harness: harness as "codex" | "claude",
      projectId: p.id,
      roleId: data.roleId,
      prompt: data.prompt,
      model: data.model || selected?.model,
      roleSnapshot: selected,
      ...(context && (context.brief || context.memory || context.handoff)
        ? { contextSnapshot: context }
        : {}),
      readOnly: data.readOnly,
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
      `${harness === "claude" ? "Claude Code" : "Codex"} worker started.`,
    );
    queueMicrotask(() => {
      try {
        const worker = factory(command, r, p.path, {
          update: (patch) => {
            const current = store.run(r.id);
            if (
              current &&
              (["running", "needs_attention"].includes(current.state) ||
                (Object.keys(patch).length === 1 && "workerPid" in patch))
            )
              store.saveRun({
                ...current,
                ...patch,
                updatedAt: new Date().toISOString(),
              });
          },
          event: (kind, text) => store.event(r.id, kind, text),
          approval: (a, answer) => {
            store.saveApproval(a);
            answers.set(a.id, answer);
          },
          done: () => {
            workers.delete(r.id);
            store.clearApprovals(r.id);
            for (const [id] of answers)
              if (!store.approvals().some((a) => a.id === id))
                answers.delete(id);
          },
        });
        workers.set(r.id, worker);
      } catch (e) {
        store.saveRun({
          ...r,
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
  app.get("/api/runs/:id/context", (c) => {
    const r = store.run(c.req.param("id"));
    return r
      ? c.json({ runId: r.id, contextSnapshot: r.contextSnapshot ?? null })
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
          threadId: r.threadId,
          turnId: r.turnId,
          effectiveModel: r.effectiveModel,
          harness: r.harness || "codex",
          contextRevision: r.contextSnapshot?.revision ?? null,
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
  return {
    app,
    store,
    bearer,
    setupUrl: `http://127.0.0.1:${port}/setup?token=${setup}`,
    close: async () => {
      const current = [...workers.values()];
      for (const w of current) w.stop();
      await Promise.all(current.map((w) => w.closed));
      store.close();
      release();
    },
  };
}
