import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToolEvidence, readOnlyClaudeToolEvidence, satisfiesRequiredTools,
  toolAvailability, toolCapabilities,
} from "../src/capabilities.ts";

const now = Date.parse("2026-10-02T10:00:00Z");
const metadata = (tools: unknown, overrides = {}) => normalizeToolEvidence({
  harness: "claude", modelId: "haiku", tools,
  source: "native-model-metadata", checkedAt: new Date(now).toISOString(),
  complete: true, ...overrides,
});

test("normalization retains bounded IDs and no config or permission payloads", () => {
  const evidence = metadata([{ name: "WebSearch", description: "SECRET", config: "SECRET" },
    { id: "Read" }, "Read", "x".repeat(121), "bad\nname", null]);
  assert.deepEqual(evidence.tools, ["WebSearch", "Read"]);
  assert.equal(evidence.complete, false);
  assert.equal(JSON.stringify(evidence).includes("SECRET"), false);
  const capped = metadata(Array.from({ length: 81 }, (_, index) => `tool${index}`));
  assert.equal(capped.tools.length, 80);
  assert.equal(capped.complete, false);
  assert.equal(metadata(undefined).complete, false);
});

test("only exact known native IDs establish web search; image generation stays unknown", () => {
  assert.equal(toolAvailability(metadata(["WebSearch"]), "web_search"), "available");
  assert.equal(toolAvailability(metadata(["websearch"], { harness: "opencode" }), "web_search"), "available");
  for (const name of ["websearch", "mcp__search__WebSearch", "WebSearchExtra", "image_gen"]) {
    assert.equal(toolAvailability(metadata([name], { complete: false }), "web_search"), "unknown");
  }
  assert.equal(toolAvailability(metadata(["WebSearch", "image_gen"]), "image_generation"), "unknown");
  assert.equal(toolAvailability(metadata([], { harness: "codex" }), "web_search"), "unknown");
  assert.equal(toolAvailability(metadata([]), "web_search"), "unavailable");
});

test("strict requirements need fresh complete evidence for the exact model", () => {
  const evidence = metadata(["WebSearch"]);
  assert.equal(satisfiesRequiredTools(evidence, "haiku", ["web_search"], now), true);
  assert.equal(satisfiesRequiredTools(evidence, "haiku", ["web_search"], now + 300_000), true);
  assert.equal(satisfiesRequiredTools(evidence, "haiku", ["web_search"], now + 300_001), false);
  assert.equal(satisfiesRequiredTools(evidence, "haiku", ["web_search"], now - 1), false);
  assert.equal(satisfiesRequiredTools(evidence, "other", ["web_search"], now), false);
  assert.equal(satisfiesRequiredTools(metadata(["WebSearch"], { complete: false }), "haiku", ["web_search"], now), false);
  assert.equal(satisfiesRequiredTools(metadata(["WebSearch"], { checkedAt: "invalid" }), "haiku", ["web_search"], now), false);
  assert.equal(satisfiesRequiredTools(evidence, "haiku", ["image_generation"], now), false);
  assert.equal(satisfiesRequiredTools(undefined, "haiku", [], now), true);
});

test("runtime observations remain historical and read-only Claude cannot search or generate images", () => {
  const runtime = metadata(["WebSearch"], { source: "native-session" });
  assert.equal(toolAvailability(runtime, "web_search"), "available");
  assert.equal(satisfiesRequiredTools(runtime, "haiku", ["web_search"], now), false);
  const restricted = readOnlyClaudeToolEvidence("haiku", new Date(now).toISOString());
  assert.deepEqual(restricted.tools, ["Read", "Glob", "Grep"]);
  for (const capability of toolCapabilities) {
    assert.equal(toolAvailability(restricted, capability), "unavailable");
    assert.equal(satisfiesRequiredTools(restricted, "haiku", [capability], now), false);
  }
});
