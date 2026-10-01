import { createHash } from "node:crypto";
import { z } from "zod";
import { bundledBenchmarks } from "./benchmark-snapshot.ts";

export const benchmarkRelease = "2026-06-25";
export const benchmarkSources = { csv: "https://livebench.ai/table_2026_06_25.csv", categories: "https://livebench.ai/categories_2026_06_25.json" };
export const benchmarkMetrics = { coding: "Agentic Coding", reasoning: "Reasoning", "data-analysis": "Data Analysis", language: "Language" } as const;
export type TaskType = keyof typeof benchmarkMetrics;
const categories = {
  Reasoning: ["theory_of_mind", "zebra_puzzle", "spatial", "logic_with_navigation"],
  Coding: ["code_generation", "code_completion"],
  "Agentic Coding": ["javascript", "typescript", "python"],
  Mathematics: ["AMPS_Hard", "integrals_with_game", "math_comp", "olympiad"],
  "Data Analysis": ["consecutive_events", "tablejoin", "tablereformat"],
  Language: ["connections", "plot_unscrambling", "typos"],
  IF: ["paraphrase", "simplify", "story_generation", "summarize"],
};
const mappings = [
  ...["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(model => ({ harness: "codex" as const, model, sourceRow: `${model}-max` })),
  ...["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"].map(model => ({ harness: "claude" as const, model, sourceRow: `${model}-max-effort` })),
];
const rowSchema = z.object({ harness: z.enum(["codex", "claude"]), model: z.string(), sourceRow: z.string(), scores: z.record(z.string(), z.number().finite().min(0).max(100)) }).strict();
const snapshotSchema = z.object({ release: z.literal(benchmarkRelease), checkedAt: z.iso.datetime(), csvHash: z.string().regex(/^[a-f0-9]{64}$/), categoriesHash: z.string().regex(/^[a-f0-9]{64}$/), measuredEffort: z.literal("max"), models: z.array(rowSchema).max(mappings.length) }).strict();
export type BenchmarkSnapshot = z.infer<typeof snapshotSchema>;
export type BenchmarkEvidence = { provider: "LiveBench"; metric: string; score: number; release: string; checkedAt: string; measuredEffort: "max"; sourceRow: string; sourceUrl: string; contentHash: string; referenceOnly: true };
export const benchmarkNotice = "LiveBench reference scores use max effort and a benchmark setup. Native worker settings are unchanged and unverified for this run. Scores do not predict your task result or subscription cost.";
export function validateBenchmarkSnapshot(value: unknown): BenchmarkSnapshot {
  const snapshot = snapshotSchema.parse(value);
  const seen = new Set<string>();
  for (const row of snapshot.models) {
    if (!mappings.some(m => m.harness === row.harness && m.model === row.model && m.sourceRow === row.sourceRow) || seen.has(row.sourceRow)) throw new Error("Unknown or duplicate benchmark identity");
    seen.add(row.sourceRow);
    if (Object.keys(row.scores).sort().join() !== Object.keys(categories).sort().join()) throw new Error("Invalid benchmark metrics");
  }
  return snapshot;
}
export function parseBenchmarks(csv: string, categoryJson: string, checkedAt = new Date().toISOString()): BenchmarkSnapshot {
  if (Buffer.byteLength(csv) > 128_000 || Buffer.byteLength(categoryJson) > 16_000) throw new Error("Benchmark data is too large");
  const supplied = JSON.parse(categoryJson);
  if (!supplied || Object.keys(supplied).sort().join() !== Object.keys(categories).sort().join() || Object.entries(categories).some(([key, cols]) => JSON.stringify(supplied[key]) !== JSON.stringify(cols))) throw new Error("Benchmark categories need a reviewed update");
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2 || lines.length > 1001) throw new Error("Invalid benchmark row count");
  const header = lines[0].split(",");
  const expected = Object.values(categories).flat().sort();
  if (header[0] !== "model" || header.slice(1).sort().join() !== expected.join()) throw new Error("Invalid benchmark CSV columns");
  const models: BenchmarkSnapshot["models"] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells.length !== header.length || !/^[a-zA-Z0-9_.-]{1,160}$/.test(cells[0]) || seen.has(cells[0])) throw new Error("Invalid benchmark row");
    seen.add(cells[0]);
    const scores = cells.slice(1).map(cell => {
      if (!/^\d+(?:\.\d+)?$/.test(cell)) throw new Error("Invalid numeric benchmark score");
      const number = Number(cell);
      if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error("Benchmark score out of range");
      return number;
    });
    const mapping = mappings.find(m => m.sourceRow === cells[0]);
    if (mapping) models.push({ ...mapping, scores: Object.fromEntries(Object.entries(categories).map(([key, columns]) => [key, columns.reduce((sum, col) => sum + scores[header.indexOf(col) - 1], 0) / columns.length])) });
  }
  return validateBenchmarkSnapshot({ release: benchmarkRelease, checkedAt, measuredEffort: "max", csvHash: createHash("sha256").update(csv).digest("hex"), categoriesHash: createHash("sha256").update(categoryJson).digest("hex"), models });
}
export function benchmarksFresh(snapshot: BenchmarkSnapshot, now = Date.now()) {
  const age = now - Date.parse(snapshot.checkedAt);
  return age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
}
export function evidenceForModel(snapshot: BenchmarkSnapshot, harness: "codex" | "claude", model: string, taskType: TaskType): BenchmarkEvidence | undefined {
  const row = snapshot.models.find(row => row.harness === harness && row.model === model);
  if (!row) return undefined;
  const metric = benchmarkMetrics[taskType];
  return { provider: "LiveBench", metric, score: row.scores[metric], release: snapshot.release, checkedAt: snapshot.checkedAt, measuredEffort: snapshot.measuredEffort, sourceRow: row.sourceRow, sourceUrl: benchmarkSources.csv, contentHash: snapshot.csvHash, referenceOnly: true };
}
export class BenchmarkCache {
  private snapshot: BenchmarkSnapshot;
  private pending?: Promise<BenchmarkSnapshot>;
  private closed = false;
  private controller?: AbortController;
  constructor(private save: (snapshot: BenchmarkSnapshot) => void = () => {}, cached?: unknown, private fetcher: typeof fetch = fetch, private timeoutMs = 10_000) {
    this.snapshot = validateBenchmarkSnapshot(bundledBenchmarks);
    if (cached) { try { this.snapshot = validateBenchmarkSnapshot(cached); } catch { /* Keep bundled last-good data. */ } }
  }
  get() { return structuredClone(this.snapshot); }
  refresh(): Promise<BenchmarkSnapshot> {
    if (this.closed) return Promise.reject(new Error("Benchmark cache is closed"));
    if (this.pending) return this.pending;
    this.pending = this.download().finally(() => { this.controller?.abort(); this.pending = undefined; });
    return this.pending;
  }
  async close() { this.closed = true; this.controller?.abort(); await this.pending?.catch(() => {}); }
  private async download() {
    this.controller = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.controller.signal]);
    const read = async (url: string, limit: number) => {
      const response = await this.fetcher(url, { signal, redirect: "error", credentials: "omit", headers: { Accept: "text/plain, application/json" } });
      if (!response.ok || !response.body) throw new Error("Public benchmark download failed");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) throw new Error("Public benchmark download is too large"); chunks.push(part.value); } } finally { await reader.cancel(); }
      return Buffer.concat(chunks).toString("utf8");
    };
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Public benchmark download was cancelled or timed out")), { once: true });
    });
    const [csv, json] = await Promise.race([Promise.all([read(benchmarkSources.csv, 128_000), read(benchmarkSources.categories, 16_000)]), aborted]);
    const next = parseBenchmarks(csv, json);
    if (this.closed) throw new Error("Benchmark cache is closed");
    this.save(next);
    this.snapshot = next;
    return this.get();
  }
}
