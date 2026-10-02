import { spawn } from "node:child_process";
import type { AccountQuota, CatalogModel, HarnessCatalog, Run } from "./contracts.ts";
import type { NativeCallbacks } from "./native.ts";

export const antigravityWorkerSupported = false;
export const antigravityWorkerReason = "Antigravity headless execution has no verified native approval roundtrip. Continue in agy; AgentKlar worker execution is unavailable.";
export type AntigravityCatalog = Omit<HarnessCatalog, "harness"> & { harness: "antigravity" };
type MetadataReader = (command: string, args: string[], cwd: string, signal: AbortSignal) => Promise<string>;
const unavailableQuota = (): AccountQuota => ({ status: "unavailable", ordinaryUsageAllowed: null, buckets: [],
  message: "Native agy -p /usage grouped limits could not be read. Access, billing and unsupported limits remain unknown." });

/** Native models output is a TSV catalog, not evidence of access, billing, images, or a default. */
export function parseAntigravityModels(output: string): { models: CatalogModel[]; truncated: boolean } {
  if (Buffer.byteLength(output) > 64_000) return { models: [], truncated: false };
  const entries = output.split(/\r?\n/).filter(line => line.trim());
  if (entries.length > 200) return { models: [], truncated: true };
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const line of entries) {
    const fields = line.split("\t");
    if (fields.length !== 2 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(fields[0]!) ||
      !fields[1]?.trim() || fields[1].length > 160 || /[\x00-\x1f\x7f]/.test(fields[1])) return { models: [], truncated: false };
    const [id, name] = fields as [string, string];
    if (seen.has(id)) return { models: [], truncated: false };
    seen.add(id);
    models.push({ id, name, description: "Native Antigravity model. Access, cost and image support are not verified.",
      resolvedModel: null, isDefault: false, inputModalities: null });
  }
  return { models, truncated: false };
}

/** Keep only the two observed native group labels and their known windows. */
export function parseAntigravityQuota(output: string, observedAt = new Date().toISOString()): AccountQuota {
  if (Buffer.byteLength(output) > 16_000) return unavailableQuota();
  const rows = output.split(/\r?\n/).filter(line => line.trim());
  if (rows.length > 20) return unavailableQuota();
  const groups = new Map<string, AccountQuota["buckets"][number]>();
  for (const row of rows) {
    const [name, label, remaining, reset, extra] = row.split("\t");
    if (extra !== undefined || !["Gemini Models", "Claude and GPT models"].includes(name ?? "")) continue;
    const slot = label === "Five Hour Limit Remaining" ? "primary" : label === "Weekly Limit Remaining" ? "secondary" : null;
    if (!slot || !/^\d+(?:\.\d+)?%$/.test(remaining ?? "") ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(reset ?? "")) return unavailableQuota();
    const percentage = Number(remaining!.slice(0, -1));
    const stamp = Date.parse(reset!);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 || !Number.isFinite(stamp) ||
      new Date(stamp).toISOString() !== reset!.replace("Z", ".000Z")) return unavailableQuota();
    const id = name === "Gemini Models" ? "antigravity-gemini" : "antigravity-claude-gpt";
    const bucket = groups.get(id) ?? { id, name: name!, normalModel: null, primary: null, secondary: null, spendControlReached: null };
    if (bucket[slot] !== null) return unavailableQuota();
    bucket[slot] = { usedPercent: 100 - percentage, windowDurationMins: slot === "primary" ? 300 : 10080,
      resetsAt: Math.floor(stamp / 1000) };
    groups.set(id, bucket);
  }
  if (!groups.size) return unavailableQuota();
  return { status: "available", observedAt, ordinaryUsageAllowed: null, buckets: [...groups.values()],
    message: "Native agy -p /usage reports grouped limits. These are not account-wide access or billing guarantees; unsupported limits remain unknown." };
}

const readMetadata: MetadataReader = (command, args, cwd, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error("Metadata cancelled")); return; }
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let output = Buffer.alloc(0), failed = false;
  const kill = (kind: NodeJS.Signals) => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch {}
  };
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    if (failed) return;
    failed = true; kill("SIGTERM");
    escalation = setTimeout(() => kill("SIGKILL"), 1000); escalation.unref();
  };
  const timer = setTimeout(stop, 15_000); timer.unref();
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", chunk => {
    if (failed) return;
    output = Buffer.concat([output, Buffer.from(chunk)]);
    if (output.length > 64_000) { output = Buffer.alloc(0); stop(); }
  });
  child.stderr.on("data", () => {}); // Native diagnostics may include account payloads.
  child.on("error", stop);
  child.on("close", code => {
    clearTimeout(timer); clearTimeout(escalation); signal.removeEventListener("abort", stop);
    // Close means all stdio pipes ended; also stop any remaining descendants from this metadata process.
    kill("SIGKILL");
    if (failed || code !== 0 || signal.aborted) reject(new Error("Native metadata unavailable"));
    else resolve(output.toString("utf8"));
  });
});

/** Only CLI-handled metadata commands; no model prompt, account switching, or settings edits. */
export async function readAntigravityCatalog(command: string, cwd: string, signal: AbortSignal,
  reader: MetadataReader = readMetadata): Promise<AntigravityCatalog> {
  const [modelsReply, quotaReply] = await Promise.allSettled([
    reader(command, ["models"], cwd, signal), reader(command, ["-p", "/usage"], cwd, signal),
  ]);
  const parsed = modelsReply.status === "fulfilled" ? parseAntigravityModels(modelsReply.value) : { models: [], truncated: false };
  const models = signal.aborted ? [] : parsed.models;
  return { harness: "antigravity", models, modelsStatus: models.length ? "available" : "unavailable",
    modelsMessage: models.length ? "Models reported by native agy models. Default model and account access are unknown."
      : "Native agy models could not be read. Check native sign-in and CLI support.",
    modelsTruncated: parsed.truncated,
    quota: !signal.aborted && quotaReply.status === "fulfilled" ? parseAntigravityQuota(quotaReply.value) : unavailableQuota() };
}

/** Explicit fail-closed gate until a native permission roundtrip is verified. Never starts a process. */
export class AntigravityWorker {
  closed: Promise<void>;
  constructor(_command: string, _run: Run, _cwd: string, callbacks: NativeCallbacks) {
    this.closed = Promise.resolve().then(() => {
      callbacks.update({ state: "needs_attention", error: antigravityWorkerReason }); callbacks.done();
    });
  }
  stop() {}
}
