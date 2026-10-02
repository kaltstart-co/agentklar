export const toolCapabilities = ["web_search", "image_generation"] as const;
export type ToolCapability = (typeof toolCapabilities)[number];
export type ToolAvailability = "available" | "unavailable" | "unknown";

export type ToolEvidence = {
  harness: "codex" | "claude" | "opencode";
  modelId: string;
  tools: string[];
  source: "native-model-metadata" | "native-session" | "adapter-restriction";
  checkedAt: string;
  complete: boolean;
  message: string;
};

/** Keep advertised IDs only. Descriptions, config and permission payloads are discarded. */
export function normalizeToolEvidence(input: {
  harness: ToolEvidence["harness"];
  modelId: string;
  tools: unknown;
  source: ToolEvidence["source"];
  checkedAt: string;
  complete: boolean;
}): ToolEvidence {
  const rows = Array.isArray(input.tools) ? input.tools : [];
  let complete = input.complete && Array.isArray(input.tools) && rows.length <= 80;
  const tools: string[] = [];
  for (const row of rows.slice(0, 80)) {
    const id = typeof row === "string" ? row
      : row && typeof row === "object" ? ("id" in row ? row.id : "name" in row ? row.name : undefined)
      : undefined;
    if (typeof id !== "string" || !id.length || id.length > 120 || /[\x00-\x1f\x7f]/.test(id)) {
      complete = false;
      continue;
    }
    if (!tools.includes(id)) tools.push(id);
  }
  return {
    harness: input.harness,
    modelId: input.modelId,
    tools,
    source: input.source,
    checkedAt: Number.isFinite(Date.parse(input.checkedAt)) ? input.checkedAt : "",
    complete,
    message: input.source === "adapter-restriction"
      ? "The adapter restricts this worker's tools."
      : input.source === "native-session"
        ? "Tools observed in a past run; not evidence for a new worker."
        : "Native metadata advertises these tools. Native permissions still apply.",
  };
}

export function readOnlyClaudeToolEvidence(modelId: string, checkedAt: string): ToolEvidence {
  return normalizeToolEvidence({
    harness: "claude", modelId, checkedAt,
    source: "adapter-restriction", complete: true, tools: ["Read", "Glob", "Grep"],
  });
}

/** Exact native IDs only: MCP names and model modalities do not imply a capability. */
export function toolAvailability(evidence: ToolEvidence, capability: ToolCapability): ToolAvailability {
  if (evidence.source === "adapter-restriction") {
    if (evidence.harness === "claude" && evidence.complete
      && evidence.tools.every((tool) => ["Read", "Glob", "Grep"].includes(tool))) return "unavailable";
    return "unknown";
  }
  if (capability === "image_generation") return "unknown";
  const id = evidence.harness === "claude" ? "WebSearch"
    : evidence.harness === "opencode" ? "websearch" : undefined;
  if (!id) return "unknown";
  if (evidence.tools.includes(id)) return "available";
  return evidence.complete ? "unavailable" : "unknown";
}

/** Historical runs never satisfy a new catalog request. Unknown never satisfies strict routing. */
export function satisfiesRequiredTools(
  evidence: ToolEvidence | undefined,
  modelId: string,
  required: readonly ToolCapability[],
  now = Date.now(),
): boolean {
  if (!required.length) return true;
  if (!evidence || evidence.modelId !== modelId || !evidence.complete
    || evidence.source === "native-session") return false;
  const age = now - Date.parse(evidence.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60_000) return false;
  return required.every((capability) => toolAvailability(evidence, capability) === "available");
}
