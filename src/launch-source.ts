import type { LaunchSource } from "./contracts.ts";

const header = "x-agentklar-mcp-client";

function plain(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length > max ||
      value !== Buffer.from(value, "utf8").toString("utf8") ||
      /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

export function mcpClientSource(value: unknown): LaunchSource | undefined {
  if (!value || typeof value !== "object") return;
  const info = value as Record<string, unknown>;
  const clientName = plain(info.name, 80);
  if (!clientName) return;
  const clientVersion = plain(info.version, 40);
  return { kind: "mcp", clientName, ...(clientVersion ? { clientVersion } : {}) };
}

export function clientSourceHeader(source: LaunchSource | undefined): Record<string, string> {
  return source?.kind === "mcp"
    ? { [header]: Buffer.from(JSON.stringify({ name: source.clientName, version: source.clientVersion })).toString("base64url") }
    : {};
}

export function sourceFromHeader(value: string | undefined): LaunchSource | undefined {
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return;
  try {
    return mcpClientSource(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return;
  }
}
