import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readOpenCodeCatalog } from "./opencode.ts";
import type {
  AccountQuota,
  CatalogModel,
  CatalogSnapshot,
  HarnessCatalog,
  Project,
  QuotaWindow,
} from "./contracts.ts";

const modelFailure =
  "Native model catalog could not be read. Check your native CLI settings and sign-in.";
const quotaFailure =
  "Native account limits could not be read. Check your native Codex CLI.";
const claudeQuota =
  "Claude Code does not expose account quota through this supported native SDK read.";
const museQuota =
  "Model refresh does not read Muse account usage. A completed Muse task may show an observed account snapshot.";
const opencodeQuota = "OpenCode account limits are not exposed by this native catalog read.";
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.slice(0, max) : null;
const identifier = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && v.length <= 120 ? v : null;
const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;
const integer = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
function window(v: unknown): QuotaWindow | null {
  const r = record(v);
  const reset = integer(r?.resetsAt);
  return r &&
    typeof r.usedPercent === "number" &&
    Number.isFinite(r.usedPercent) &&
    r.usedPercent >= 0
    ? {
        usedPercent: r.usedPercent,
        windowDurationMins: integer(r.windowDurationMins),
        resetsAt: reset !== null && reset <= 8640000000000 ? reset : null,
      }
    : null;
}
function unavailableQuota(message: string): AccountQuota {
  return {
    status: "unavailable",
    message,
    ordinaryUsageAllowed: null,
    buckets: [],
  };
}
export function parseQuota(value: unknown): AccountQuota {
  const r = record(value);
  if (!r) return unavailableQuota(quotaFailure);
  const multi = record(r.rateLimitsByLimitId);
  const entries =
    multi && Object.keys(multi).length
      ? Object.entries(multi)
      : r.rateLimits
        ? [["codex", r.rateLimits] as const]
        : [];
  const buckets = entries.slice(0, 20).flatMap(([key, value]) => {
    const b = record(value);
    const id = b?.limitId == null ? identifier(key) : identifier(b.limitId);
    return b && id
      ? [
          {
            id,
            name: text(b.limitName, 160),
            normalModel: identifier(b.normalModelSlug),
            primary: window(b.primary),
            secondary: window(b.secondary),
            spendControlReached: bool(b.spendControlReached),
          },
        ]
      : [];
  });
  const allowed = bool(r.ordinaryUsageAllowed);
  if (!buckets.length && allowed === null)
    return unavailableQuota(quotaFailure);
  return {
    status: "available",
    message:
      entries.length > 20
        ? "Account limit buckets were shortened to 20."
        : null,
    ordinaryUsageAllowed: allowed,
    buckets,
  };
}
function model(
  value: unknown,
  harness: "codex" | "claude" | "muse",
): CatalogModel | null {
  const r = record(value);
  if (!r || r.hidden === true) return null;
  const id = identifier(
    harness === "codex" ? r.model : harness === "muse" ? r.modelId : r.value,
  );
  if (!id) return null;
  return {
    id,
    name: text(harness === "muse" ? r.displayLabel : r.displayName, 160) || id,
    description: text(r.description, 800) || "",
    resolvedModel: harness === "claude" ? identifier(r.resolvedModel) : null,
    isDefault: harness === "claude" ? id === "default" : r.isDefault === true,
    inputModalities:
      harness === "codex" && Array.isArray(r.inputModalities)
        ? r.inputModalities
            .slice(0, 8)
            .flatMap((v) => (text(v, 40) ? [text(v, 40)!] : []))
        : null,
  };
}
function empty(harness: HarnessCatalog["harness"]): HarnessCatalog {
  return {
    harness,
    models: [],
    modelsStatus: "unavailable",
    modelsMessage: modelFailure,
    modelsTruncated: false,
    quota: unavailableQuota(
      harness === "claude" ? claudeQuota : harness === "muse" ? museQuota : harness === "opencode" ? opencodeQuota : quotaFailure,
    ),
  };
}

type ClaudeAuth = NonNullable<HarnessCatalog["auth"]>;
const authMessage: Record<ClaudeAuth["status"], string> = {
  signed_in: "Claude Code reports that its native CLI is signed in. Model access is not verified.",
  sign_in_required: "Claude Code worker sign-in is required. Sign in with the native Claude Code CLI, then refresh models.",
  unknown: "Claude Code worker sign-in could not be checked. Refresh models or check the native CLI.",
};
const authResult = (status: ClaudeAuth["status"]): ClaudeAuth => ({
  status, source: "claude-auth-status", message: authMessage[status],
});

export async function readClaudeAuth(
  command: string,
  cwd: string,
  signal: AbortSignal,
  args = ["auth", "status"],
  timeoutMs = 8000,
): Promise<ClaudeAuth> {
  if (signal.aborted) return authResult("unknown");
  const child = spawn(command, args, {
    cwd, stdio: "pipe", detached: process.platform !== "win32",
  });
  const owned = ownChild(child);
  let output = "", bytes = 0, errorBytes = 0, overflow = false, timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 16384) { overflow = true; owned.stop(); }
    else output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > 16384) { overflow = true; owned.stop(); }
  });
  child.stdin.on("error", () => {});
  child.stdin.end();
  const timeout = setTimeout(() => { timedOut = true; owned.stop(); }, timeoutMs);
  const abort = () => owned.stop();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", resolve);
    });
    if (overflow || timedOut || signal.aborted || code === null) return authResult("unknown");
    const payload = record(JSON.parse(output));
    if (payload?.apiProvider !== "firstParty") return authResult("unknown");
    if (code === 0 && payload.loggedIn === true) return authResult("signed_in");
    if (code === 1 && payload.loggedIn === false && payload.authMethod === "none")
      return authResult("sign_in_required");
  } catch {
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    owned.stop();
    await owned.ended;
  }
  return authResult("unknown");
}
function clipped(value: unknown) {
  const r = record(value);
  return (
    !!r &&
    ((typeof r.description === "string" && r.description.length > 800) ||
      (typeof r.displayName === "string" && r.displayName.length > 160) ||
      (typeof r.displayLabel === "string" && r.displayLabel.length > 160) ||
      (Array.isArray(r.inputModalities) &&
        (r.inputModalities.length > 8 ||
          r.inputModalities.some(
            (v) => typeof v === "string" && v.length > 40,
          ))))
  );
}

// Each probe owns this child only. A close cancels escalation before any PID reuse.
function ownChild(child: ChildProcessWithoutNullStreams) {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const ended = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true;
      clearTimeout(timer);
      resolve();
    }),
  );
  const directKill = child.kill.bind(child);
  const kill = (signal: NodeJS.Signals) => {
    if (closed) return;
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else directKill(signal);
    } catch {}
  };
  child.kill = (signal = "SIGTERM") => {
    kill(signal as NodeJS.Signals);
    return !closed;
  };
  const stop = () => {
    if (closed || timer) return;
    kill("SIGTERM");
    timer = setTimeout(() => kill("SIGKILL"), 500);
    timer.unref();
  };
  child.stderr.on("data", () => {});
  return { stop, ended };
}

async function readJsonRpcCatalog(
  harness: "codex" | "muse",
  command: string,
  cwd: string,
  signal: AbortSignal,
  args: string[],
  timeoutMs = 12000,
): Promise<HarnessCatalog> {
  const result = empty(harness);
  if (signal.aborted) return result;
  const child = spawn(command, args, {
    cwd,
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
  const owned = ownChild(child);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: () => void }
  >();
  let sequence = 0,
    buffer = "",
    bytes = 0,
    failed = false;
  const fail = () => {
    failed = true;
    for (const p of pending.values()) p.reject();
    pending.clear();
    owned.stop();
  };
  child.on("error", fail);
  child.on("close", fail);
  child.stdin.on("error", fail);
  const timeout = setTimeout(fail, timeoutMs);
  signal.addEventListener("abort", fail, { once: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    bytes += Buffer.byteLength(data);
    buffer += data;
    if (bytes > 1024 * 1024 || buffer.length > 256000) return fail();
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const r = record(JSON.parse(line));
        if (!r || "method" in r || typeof r.id !== "number") continue;
        const p = pending.get(r.id);
        if (!p) continue;
        pending.delete(r.id);
        if (r.error !== undefined) p.reject();
        else p.resolve(r.result);
      } catch {
        fail();
      }
    }
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (failed || signal.aborted)
        return reject(new Error("Native metadata unavailable"));
      const id = ++sequence;
      pending.set(id, {
        resolve,
        reject: () => reject(new Error("Native metadata unavailable")),
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    await rpc("initialize", {
      clientInfo: {
        name: "agentklar_catalog",
        version: "0.1.0",
        ...(harness === "codex" ? { title: "AgentKlar catalog" } : {}),
      },
      capabilities: {
        experimentalApi: false,
        ...(harness === "muse" ? { userInputDialogs: false } : {}),
      },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) +
        "\n",
    );
    const modelsRead = async () => {
      if (harness === "muse") {
        const response = record(await rpc("model/list", {}));
        if (!response || !Array.isArray(response.models))
          throw new Error("Invalid catalog");
        const source = response.source;
        if (
          !["providerCatalog", "configCatalog", "bundledCatalog"].includes(
            source as string,
          )
        ) {
          result.modelsMessage =
            "Muse returned a fake, unresolved or unknown catalog source; no usable native model list was confirmed.";
          return;
        }
        const provider = identifier(response.providerId);
        const profile =
          response.profileId === null ? null : identifier(response.profileId);
        if (!provider || (response.profileId !== null && !profile))
          throw new Error("Invalid catalog route");
        const seen = new Set<string>();
        for (const raw of response.models.slice(0, 100)) {
          const route = record(raw);
          if (route?.providerId !== provider || route.profileId !== profile) {
            result.modelsTruncated = true;
            continue;
          }
          const m = model(raw, "muse");
          if (clipped(raw) || !m) result.modelsTruncated = true;
          if (m && !seen.has(m.id)) {
            seen.add(m.id);
            result.models.push(m);
          }
        }
        result.modelsTruncated ||= response.models.length > 100;
        result.modelsStatus = "available";
        result.modelsMessage = `Muse native model list${result.modelsTruncated ? " was shortened or omitted incompatible routes" : ""}. Listing does not verify sign-in or model access.`;
        return;
      }
      let cursor: string | null = null;
      const cursors = new Set<string>();
      const seen = new Set<string>();
      let pages = 0;
      do {
        const response = record(
          await rpc("model/list", {
            limit: 100 - result.models.length,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (!response || !Array.isArray(response.data))
          throw new Error("Invalid catalog");
        for (const raw of response.data.slice(0, 100)) {
          const m = model(raw, "codex");
          if (clipped(raw) || (!m && record(raw)?.hidden !== true))
            result.modelsTruncated = true;
          if (m && !seen.has(m.id) && result.models.length < 100) {
            seen.add(m.id);
            result.models.push(m);
          }
        }
        const next = response.nextCursor;
        cursor =
          typeof next === "string" && next.length <= 4096 && next.length > 0
            ? next
            : null;
        result.modelsTruncated ||=
          response.data.length > 100 ||
          (next !== null && next !== undefined && cursor === null);
        if (
          cursor &&
          (cursors.has(cursor) || ++pages >= 10 || result.models.length >= 100)
        ) {
          result.modelsTruncated = true;
          break;
        }
        if (cursor) cursors.add(cursor);
      } while (cursor);
      result.modelsStatus = "available";
      result.modelsMessage = result.modelsTruncated
        ? "Native catalog shortened; this list may be incomplete."
        : "Native catalog discovery does not verify model access or subscription entitlement.";
    };
    const quotaRead = async () => {
      if (harness === "muse") return;
      result.quota = parseQuota(
        await rpc("account/rateLimits/read", {
          excludeResetCreditDetails: true,
        }),
      );
    };
    const reads = await Promise.allSettled([modelsRead(), quotaRead()]);
    if (reads[0].status === "rejected" && result.models.length)
      result.modelsTruncated = true;
  } catch {
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", fail);
    owned.stop();
    await owned.ended;
  }
  return result;
}

export function readCodexCatalog(
  command: string,
  cwd: string,
  signal: AbortSignal,
  args = ["app-server", "--stdio"],
  timeoutMs = 12000,
) {
  return readJsonRpcCatalog("codex", command, cwd, signal, args, timeoutMs);
}

export function readMuseCatalog(
  command: string,
  cwd: string,
  signal: AbortSignal,
  args = ["serve", "--no-session-log"],
  timeoutMs = 12000,
) {
  return readJsonRpcCatalog("muse", command, cwd, signal, args, timeoutMs);
}

export async function readClaudeCatalog(
  command: string,
  cwd: string,
  signal: AbortSignal,
  queryFactory: typeof query = query,
  timeoutMs = 12000,
): Promise<HarnessCatalog> {
  const result = empty("claude");
  if (signal.aborted) return result;
  const abort = new AbortController();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* input(): AsyncGenerator<never> {
    await wait;
  }
  let stream: ReturnType<typeof query> | undefined;
  let owned: ReturnType<typeof ownChild> | undefined;
  let rejectWait!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectWait = () => reject(new Error("Native metadata unavailable"));
  });
  const stop = () => {
    abort.abort();
    owned?.stop();
    rejectWait();
  };
  const timeout = setTimeout(stop, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  try {
    stream = queryFactory({
      prompt: input(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: command,
        abortController: abort,
        settingSources: ["user", "project", "local"],
        tools: [],
        persistSession: false,
        stderr: () => {},
        spawnClaudeCodeProcess: (options) => {
          if (abort.signal.aborted)
            throw new Error("Catalog stopped before launch");
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: "pipe",
            detached: process.platform !== "win32",
          });
          owned = ownChild(child);
          let bytes = 0;
          child.stdout.on("data", (data) => {
            bytes += Buffer.byteLength(data);
            if (bytes > 1024 * 1024) stop();
          });
          child.on("error", stop);
          return child;
        },
      },
    });
    const models = await Promise.race([stream.supportedModels(), stopped]);
    if (!Array.isArray(models)) return result;
    const seen = new Set<string>();
    for (const raw of models.slice(0, 100)) {
      const m = model(raw, "claude");
      if (clipped(raw) || !m) result.modelsTruncated = true;
      if (m && !seen.has(m.id)) {
        seen.add(m.id);
        result.models.push(m);
      }
    }
    result.modelsTruncated ||= models.length > 100;
    result.modelsStatus = "available";
    result.modelsMessage = result.modelsTruncated
      ? "Native catalog shortened; this list may be incomplete."
      : "Native catalog discovery does not verify sign-in, model access or subscription entitlement.";
  } catch {
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    try {
      stream?.close();
    } catch {}
    abort.abort();
    owned?.stop();
    release();
    await owned?.ended;
  }
  return result;
}

export type CatalogReader = (
  project: Project,
  commands: { codex: string | null; claude: string | null; muse?: string | null; opencode?: string | null },
  signal: AbortSignal,
) => Promise<CatalogSnapshot>;
export const readCatalog: CatalogReader = async (
  project,
  commands,
  signal,
) => ({
  projectId: project.id,
  checkedAt: new Date().toISOString(),
  harnesses: await Promise.all(
    (["codex", "claude", "muse", "opencode"] as const).map(async (harness) => {
      const command = commands[harness];
      if (!command)
        return {
          ...empty(harness),
          modelsMessage: `${harness === "codex" ? "Codex" : harness === "claude" ? "Claude Code" : harness === "muse" ? "Muse" : "OpenCode"} executable was not found.`,
        };
      return harness === "codex"
        ? readCodexCatalog(command, project.path, signal)
        : harness === "claude"
          ? (async () => {
              const [catalog, auth] = await Promise.all([
                readClaudeCatalog(command, project.path, signal),
                readClaudeAuth(command, project.path, signal),
              ]);
              return { ...catalog, auth };
            })()
          : harness === "muse" ? readMuseCatalog(command, project.path, signal)
          : readOpenCodeCatalog(command, project.path, signal);
    }),
  ),
});

export class CatalogCache {
  private cache = new Map<
    string,
    { snapshot: CatalogSnapshot; time: number }
  >();
  private pending = new Map<string, Promise<CatalogSnapshot>>();
  private abort = new AbortController();
  constructor(
    private reader: CatalogReader,
    private commands: {
      codex: string | null;
      claude: string | null;
      muse?: string | null;
      opencode?: string | null;
    },
    private now = Date.now,
  ) {}
  get(id: string) {
    return this.cache.get(id)?.snapshot ?? null;
  }
  refresh(project: Project): Promise<CatalogSnapshot> {
    const existing = this.pending.get(project.id);
    if (existing) return existing;
    const cached = this.cache.get(project.id);
    if (cached && this.now() - cached.time < 30000)
      return Promise.resolve(cached.snapshot);
    const read = this.reader(project, this.commands, this.abort.signal)
      .then((snapshot) => {
        this.cache.set(project.id, { snapshot, time: this.now() });
        return snapshot;
      })
      .finally(() => this.pending.delete(project.id));
    this.pending.set(project.id, read);
    return read;
  }
  async close() {
    this.abort.abort();
    await Promise.allSettled(this.pending.values());
    this.cache.clear();
  }
}
