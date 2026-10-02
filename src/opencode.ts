import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Approval, CatalogModel, HarnessCatalog, Run } from "./contracts.ts";
import type { NativeCallbacks } from "./native.ts";
import { composeWorkerPrompt } from "./prompt.ts";
import { verifiedOpenCodeScope } from "./opencode-scope.ts";
import { normalizeToolEvidence } from "./capabilities.ts";

const object = (v: unknown): Record<string, any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const clean = (v: unknown, max: number) => typeof v === "string" && v.length <= max &&
  (v as string & { isWellFormed: () => boolean }).isWellFormed() && !/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(v) ? v : null;
const plain = (v: unknown, max: number) => { const value = clean(v, max); return value && !/[\r\n\t]/.test(value) ? value : null; };
const id = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(v) ? v : null;
const timeout = (ms: number, message: string) => new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error(message)), ms); t.unref(); });
const alive = (pid: number) => { try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; } catch { return false; } };
const data = (reply: any) => { if (reply?.error || !reply || reply.data === undefined) throw new Error("OpenCode native request failed"); return reply.data; };

export type OpenCodeHost = { client: ReturnType<typeof createOpencodeClient>; close: () => Promise<void>; pid?: number; exited: Promise<void> };
export type OpenCodeConnect = (command: string, cwd: string, spawned: (pid: number | undefined, close: () => Promise<void>) => void,
  nativeEnv?: NodeJS.ProcessEnv) => Promise<OpenCodeHost>;

/** Native metadata only. Output and errors are discarded unless they are one safe path. */
export async function openCodeDbPath(command: string, cwd: string, nativeEnv: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null;
  return new Promise(resolve => {
    const child = spawn(command, ["db", "path"], { cwd, env: nativeEnv, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let interrupted = false;
    const stop = () => { interrupted = true; try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} };
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      signal.removeEventListener("abort", stop);
      stop(); // A wrapper can exit while a child in its process group stays alive.
      resolve(value);
    };
    const timer = setTimeout(stop, 5000);
    const fallback = setTimeout(() => finish(null), 6500);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 4096) stop();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 4096) stop(); });
    child.once("error", () => {});
    child.once("close", code => {
      const bytes = Buffer.concat(chunks);
      const decoded = bytes.toString("utf8");
      const valid = Buffer.from(decoded, "utf8").equals(bytes);
      const output = decoded.replace(/\r?\n$/, "");
      finish(code === 0 && valid && !interrupted && !signal.aborted && outputBytes <= 4096 ? output : null);
    });
  });
}

/** The native CLI owns config, credentials, session state and permission rules. */
export const connectOpenCode: OpenCodeConnect = async (command, cwd, spawned, nativeEnv = process.env) => {
  const password = randomBytes(32).toString("hex");
  const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd, stdio: "pipe", detached: process.platform !== "win32",
    env: { ...nativeEnv, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
  });
  child.stderr.on("data", () => {});
  child.on("error", () => {});
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let closing: Promise<void> | undefined;
  const signal = (name: NodeJS.Signals) => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, name); else child.kill(name); } catch {} };
  const close = () => closing ??= (async () => {
    signal("SIGTERM");
    await Promise.race([exited, new Promise<void>(r => setTimeout(r, 1500))]);
    if (child.pid && alive(child.pid)) signal("SIGKILL");
    await Promise.race([exited, new Promise<void>(r => setTimeout(r, 1500))]);
  })();
  spawned(child.pid, close);
  let output = "";
  let found!: (url: string) => void;
  let failed!: (error: Error) => void;
  const address = new Promise<string>((resolve, reject) => { found = resolve; failed = reject; });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > 8192) { failed(new Error("OpenCode startup output exceeded its limit")); return; }
    const match = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/i);
    if (match) found(match[1]);
  });
  void exited.then(() => failed(new Error("OpenCode server exited during startup")));
  try {
    const baseUrl = await Promise.race([address, timeout(15000, "OpenCode startup timed out")]);
    const client = createOpencodeClient({ baseUrl, directory: cwd,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
    const health = await Promise.race([client.global.health(), timeout(5000, "OpenCode health check timed out")]);
    if (!data(health)?.healthy) throw new Error("OpenCode server did not report healthy");
    return { client, close, pid: child.pid, exited };
  } catch { await close(); throw new Error("OpenCode local server could not start"); }
};

function connectedProviderIds(value: unknown): string[] {
  const response = object(value);
  const connected = Array.isArray(response?.connected) ? response.connected : [];
  const providers = Array.isArray(response?.all) ? response.all : [];
  const known = new Set(providers.map((provider: unknown) => id(object(provider)?.id)).filter(Boolean));
  return [...new Set(connected.map((provider: unknown) => id(provider)).filter((provider: string | null): provider is string => !!provider && known.has(provider)))].slice(0, 100);
}

export function openCodeModels(value: unknown): CatalogModel[] {
  const response = object(value);
  const connected = connectedProviderIds(value);
  const providers = Array.isArray(response?.all) ? response.all : [];
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const raw of providers) {
    const provider = object(raw);
    const providerId = id(provider?.id);
    if (!providerId || !connected.includes(providerId)) continue;
    const entries = object(provider?.models);
    if (!entries) continue;
    for (const [key, item] of Object.entries(entries)) {
      const model = object(item);
      const modelId = id(model?.id);
      const capabilities = object(model?.capabilities);
      const input = object(capabilities?.input);
      if (!modelId || modelId !== key || !input || input.text !== true || capabilities?.toolcall !== true) continue;
      const full = `${providerId}/${modelId}`;
      if (full.length > 120 || seen.has(full)) continue;
      seen.add(full);
      models.push({ id: full, name: plain(model?.name, 160) || full,
        description: plain(model?.description, 400) || "Native OpenCode model. Access, cost and limits are not verified.",
        resolvedModel: full, isDefault: false,
        inputModalities: input.image === true ? ["text", "image"] : ["text"] });
      if (models.length >= 100) return models;
    }
  }
  return models;
}

export async function readOpenCodeCatalog(command: string, cwd: string, signal: AbortSignal, connect: OpenCodeConnect = connectOpenCode): Promise<HarnessCatalog> {
  const unavailable = (message: string): HarnessCatalog => ({ harness: "opencode", models: [], modelsStatus: "unavailable", modelsMessage: message,
    modelsTruncated: false, quota: { status: "unavailable", message: "OpenCode account limits are not exposed by this catalog read.", ordinaryUsageAllowed: null, buckets: [] } });
  if (signal.aborted) return unavailable("OpenCode model refresh was cancelled.");
  let close: (() => Promise<void>) | undefined;
  const onAbort = () => { void close?.().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const host = await Promise.race([connect(command, cwd, (_pid, stop) => { close = stop; if (signal.aborted) void stop(); }), timeout(20000, "OpenCode model refresh timed out")]);
    close = host.close;
    if (signal.aborted) return unavailable("OpenCode model refresh was cancelled.");
    const result = await Promise.race([host.client.provider.list({ directory: cwd }), timeout(8000, "OpenCode model refresh timed out")]);
    const providerData = data(result);
    const models = openCodeModels(providerData);
    const providers = connectedProviderIds(providerData);
    // This endpoint has no agent/session scope. Show advertised names, keep
    // effective worker support unknown, and never use it to satisfy routing.
    if (typeof host.client.tool?.list === "function") {
      for (let offset = 0; offset < Math.min(models.length, 12) && !signal.aborted; offset += 4) {
        await Promise.allSettled(models.slice(offset, offset + 4).map(async model => {
          const slash = model.id.indexOf("/");
          const listed = await Promise.race([host.client.tool.list({ directory: cwd, provider: model.id.slice(0, slash), model: model.id.slice(slash + 1) }), timeout(1500, "Native tool metadata timed out")]);
          model.toolEvidence = normalizeToolEvidence({ harness: "opencode", modelId: model.id, tools: data(listed), source: "native-model-metadata", checkedAt: new Date().toISOString(), complete: false });
        }));
      }
    }
    return { ...unavailable(models.length ? "Native OpenCode models from connected providers. Access and billing are not verified." : "No connected text-and-tool OpenCode models were confirmed."),
      models, connectedProviderIds: providers, modelsStatus: models.length ? "available" : "unavailable", modelsTruncated: models.length >= 100 };
  } catch { return unavailable("OpenCode native model list could not be read. Check its CLI and provider setup."); }
  finally { signal.removeEventListener("abort", onAbort); await close?.().catch(() => {}); }
}

export function openCodeApproval(value: unknown, runId: string): Approval | null {
  const request = object(value);
  const metadata = object(request?.metadata);
  const requestId = id(request?.id);
  const patterns = request?.patterns;
  const tool = object(request?.tool);
  if (!requestId || !metadata || !Array.isArray(patterns) || patterns.length < 1 || patterns.length > 8 ||
    patterns.some(pattern => !plain(pattern, 4096)) || !id(tool?.messageID) || !id(tool?.callID)) return null;
  if (request?.permission === "bash") {
    const command = clean(metadata.command, 16000);
    if (!command?.trim()) return null;
    return { id: randomUUID(), runId, kind: "command", title: "OpenCode command", details: { command }, decisions: ["accept", "decline"], createdAt: new Date().toISOString() };
  }
  if (request?.permission === "edit" || request?.permission === "write") {
    const path = plain(metadata.filepath, 4096);
    const diff = clean(metadata.diff, 24000);
    const content = clean(metadata.content, 24000);
    if (!path || !isAbsolute(path) || !(diff || content) ||
      !patterns.every(pattern => pattern.replace(/^\//, "") === path.slice(1)) ||
      (diff && !diff.split("\n").some(line => line === `Index: ${path}`))) return null;
    return { id: randomUUID(), runId, kind: "file", title: "OpenCode file change",
      details: diff ? { changes: [{ path, diff }] } : { file_path: path, tool: "Write", content },
      decisions: ["accept", "decline"], createdAt: new Date().toISOString() };
  }
  return null;
}

export class OpenCodeWorker {
  closed: Promise<void>;
  private host?: OpenCodeHost;
  private closeOpening?: () => Promise<void>;
  private abort = new AbortController();
  private sessionId?: string;
  private finished = false;
  private terminalState?: Run["state"];
  private pending = new Set<string>();
  private settlements = new Set<Promise<void>>();
  private children = new Set<string>();
  private resolveStop!: () => void;
  private stopped = new Promise<void>(resolve => { this.resolveStop = resolve; });
  private pid?: number;
  constructor(private command: string, private run: Run, private path: string, private callbacks: NativeCallbacks,
    connect: OpenCodeConnect = connectOpenCode, private nativeEnv: NodeJS.ProcessEnv = { ...process.env },
    private dbPath: typeof openCodeDbPath = openCodeDbPath) { this.closed = this.start(connect); }
  private async race<T>(promise: Promise<T>): Promise<T> { return Promise.race([promise, this.stopped.then(() => { throw new Error("Worker stopped"); })]); }
  private async read<T>(promise: Promise<T>, ms = 8000): Promise<T> {
    return this.race(Promise.race([promise, timeout(ms, "OpenCode metadata request timed out")]));
  }
  private finish(state: Run["state"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    this.terminalState = state;
    this.resolveStop();
    this.abort.abort();
    this.callbacks.update({ state, ...(error ? { error } : {}) });
  }
  stop() {
    if (this.finished) return;
    this.finish("cancelled");
  }
  private async permission(value: unknown) {
    const request = object(value);
    if (!request || request.sessionID !== this.sessionId) return;
    const approval = openCodeApproval(request, this.run.id);
    if (!approval) { this.finish("needs_attention", "OpenCode requested an unsupported permission. Continue in its native CLI."); return; }
    this.pending.add(request.id);
    this.callbacks.update({ state: "needs_attention" });
    this.callbacks.approval(approval, decision => {
      if (!this.pending.delete(request.id) || this.finished) return;
      if (decision === "cancel") { this.stop(); return; }
      const settling = this.read(this.host!.client.permission.reply({ requestID: request.id, directory: this.path, reply: decision === "accept" ? "once" : "reject" }))
        .then(data).then(value => {
          if (value !== true) throw new Error("OpenCode did not confirm the permission reply");
          if (!this.finished && !this.pending.size) this.callbacks.update({ state: "running" });
        })
        .catch(() => this.finish("needs_attention", "OpenCode could not settle its native approval."));
      this.settlements.add(settling);
      void settling.finally(() => this.settlements.delete(settling));
    });
  }
  private async start(connect: OpenCodeConnect) {
    try {
      if (this.run.readOnly) { this.finish("needs_attention", "OpenCode cannot enforce read-only work."); return; }
      const opening = connect(this.command, this.path, (pid, close) => {
        this.pid = pid; this.closeOpening = close;
        if (pid) this.callbacks.update({ workerPid: pid });
        if (this.finished) void close();
      }, this.nativeEnv);
      void opening.then(host => { if (this.finished) void host.close(); }).catch(() => {});
      this.host = await this.race(opening);
      void this.host.exited.then(() => { if (!this.finished) this.finish("failed", "OpenCode local server exited before the root task finished."); });
      const { client } = this.host;
      const subscribed = await this.read(client.event.subscribe({ directory: this.path }, { signal: this.abort.signal, sseMaxRetryAttempts: 0 }), 10000);
      const stream = subscribed.stream[Symbol.asyncIterator]();
      const first = await this.race(Promise.race([stream.next(), timeout(10000, "OpenCode event stream timed out")]));
      if (first.done || object(first.value)?.type !== "server.connected") throw new Error("OpenCode event stream did not connect");
      const session = data(await this.read(client.session.create({ directory: this.path, title: "AgentKlar worker" })));
      if (!id(session?.id) || session.directory !== this.path) throw new Error("OpenCode session path was not confirmed");
      this.sessionId = session.id;
      this.callbacks.update({ threadId: session.id });
      if (this.run.openCodeScope && !this.run.openCodeScope.unsupported) {
        try {
          const dbPath = await this.race(this.dbPath(this.command, this.path, this.nativeEnv, this.abort.signal));
          if (dbPath) this.callbacks.update({ openCodeScope: verifiedOpenCodeScope(this.run.openCodeScope, dbPath) });
        } catch { /* Native task can continue without a handoff command. */ }
      }
      if (this.finished) return;
      let idle!: () => void;
      const idled = new Promise<void>(resolve => { idle = resolve; });
      const events = (async () => {
        while (!this.finished) {
          const next = await stream.next();
          if (next.done) throw new Error("OpenCode event stream ended");
          const event = object(next.value); const properties = object(event?.properties);
          if (event?.type === "server.connected") {
            this.finish("needs_attention", "OpenCode event stream reconnected; native approvals may have been missed.");
            return;
          }
          const info = object(properties?.info);
          if ((event?.type === "session.created" || event?.type === "session.updated") && info && id(info.id) &&
              (info.parentID === this.sessionId || this.children.has(info.parentID))) this.children.add(info.id);
          if (event?.type === "permission.asked" && this.children.has(properties?.sessionID)) {
            this.finish("needs_attention", "OpenCode child session requested a permission that AgentKlar cannot review safely.");
            return;
          }
          if ((event?.type === "question.asked" || event?.type === "question.v2.asked" || event?.type === "permission.v2.asked") &&
              (properties?.sessionID === this.sessionId || this.children.has(properties?.sessionID))) {
            this.finish("needs_attention", "OpenCode requested unsupported native input. Continue in its native CLI.");
            return;
          }
          if (event?.type === "permission.asked") await this.permission(properties);
          if (properties?.sessionID !== this.sessionId) continue;
          if (event?.type === "session.error") throw new Error("OpenCode root session failed");
          if (event?.type === "session.idle") idle();
        }
      })();
      void events.catch(() => { if (!this.finished) this.finish("needs_attention", "OpenCode event stream ended before the root task was confirmed."); });
      const model = this.run.model && this.run.model.includes("/") ? {
        providerID: this.run.model.split("/", 1)[0], modelID: this.run.model.slice(this.run.model.indexOf("/") + 1),
      } : undefined;
      if (this.run.model && !model) throw new Error("OpenCode model ID must include its provider");
      const providers = data(await this.read(client.provider.list({ directory: this.path })));
      if (this.run.model && !openCodeModels(providers).some(item => item.id === this.run.model))
        throw new Error("OpenCode pinned model was not confirmed in the connected catalog");
      const answer = data(await this.race(client.session.prompt({ sessionID: session.id, directory: this.path,
        ...(model ? { model } : {}), parts: [{ type: "text", text: composeWorkerPrompt(this.run) }] })));
      if (object(answer?.info)?.error) throw new Error("OpenCode root prompt returned an error");
      if (this.finished) return;
      await this.race(Promise.race([idled, timeout(30000, "OpenCode root session did not become idle")]));
      await this.read(Promise.all([...this.settlements]));
      const messages = data(await this.read(client.session.messages({ sessionID: session.id, directory: this.path, limit: 100 })));
      const rootMessages = Array.isArray(messages) ? messages.filter(item => object(item)?.info?.sessionID === session.id && object(item.info)?.role === "assistant") : [];
      const final = rootMessages.at(-1);
      const info = object(final?.info);
      if (!info || info.error || !info.time?.completed || info.finish !== "stop" || this.pending.size || this.children.size ||
        (object(answer?.info)?.finish === "tool-calls" && rootMessages.length < 2)) {
        this.finish("needs_attention", "OpenCode did not confirm a finished root response. Review the session in its native CLI."); return;
      }
      const children = data(await this.read(client.session.children({ sessionID: session.id, directory: this.path })));
      if (!Array.isArray(children) || children.length) { this.finish("needs_attention", "OpenCode used child sessions that AgentKlar could not verify."); return; }
      const parts = Array.isArray(final.parts) ? final.parts : [];
      const output = parts.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n");
      const totals = rootMessages.map(item => object(item.info)?.tokens?.total);
      const sum = totals.reduce((count: number, value: number) => count + value, 0);
      const tokens = messages.length < 100 && totals.length > 0 && totals.every(value => Number.isSafeInteger(value) && value >= 0) &&
        Number.isSafeInteger(sum) ? sum : null;
      this.callbacks.update({ result: output.slice(0, 24000), resultTruncated: output.length > 24000,
        tokens, turnId: id(info.id) || undefined, effectiveModel: id(info.providerID) && id(info.modelID) ? `${info.providerID}/${info.modelID}` : undefined });
      this.finish("completed");
    } catch {
      if (!this.finished) this.finish("failed", "OpenCode worker could not complete. Check its native CLI and provider setup.");
    } finally {
      if (this.host && this.sessionId && this.terminalState !== "completed")
        await Promise.race([
          this.host.client.session.abort({ sessionID: this.sessionId, directory: this.path }).catch(() => {}),
          timeout(2000, "OpenCode native abort timed out").catch(() => {}),
        ]);
      await (this.host?.close() || this.closeOpening?.().catch(() => {}));
      if (this.pid && alive(this.pid)) this.callbacks.event("attention", "Owned OpenCode process group may still be alive. New work is blocked until it exits.");
      else this.callbacks.update({ workerPid: undefined });
      this.callbacks.done();
    }
  }
}
