import type { AccountQuota, QuotaWindow } from "./contracts.ts";

const unavailableMessage = "Muse usage/read has no valid last-seen subscription observation. It does not fetch a live balance; account allowance remains unknown.";
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const stamp = (value: unknown): value is number => count(value) && value >= Date.UTC(2000, 0, 1) && value <= 8_640_000_000_000_000;

/** Official MSP UsageReadResult: last-seen observations, not a new balance request. */
export function parseMuseQuota(value: unknown): AccountQuota {
  const usage = record(record(value)?.usage);
  const weekly = record(usage?.weekly), current = record(usage?.window);
  if (!usage || !stamp(usage.observedAtMs) || !weekly || !current ||
      !stamp(weekly.resetsAtMs) || !stamp(current.resetsAtMs) ||
      !count(weekly.usedPercent) || !count(current.usedPercent) ||
      !count(current.windowDurationMins) || current.windowDurationMins === 0) {
    return { status: "unavailable", message: unavailableMessage, ordinaryUsageAllowed: null, buckets: [] };
  }
  const primary: QuotaWindow = { usedPercent: current.usedPercent, windowDurationMins: current.windowDurationMins, resetsAt: current.resetsAtMs / 1000 };
  const secondary: QuotaWindow = { usedPercent: weekly.usedPercent, windowDurationMins: 10080, resetsAt: weekly.resetsAtMs / 1000 };
  return {
    status: "available", observedAt: new Date(usage.observedAtMs).toISOString(), ordinaryUsageAllowed: null,
    message: "Last-seen Muse subscription windows from native usage/read; not a live balance or access guarantee. Routing ignores observations older than five minutes or past their reset.",
    buckets: [{ id: "muse", name: "Observed Muse subscription usage", normalModel: null, primary, secondary, spendControlReached: null }],
  };
}
