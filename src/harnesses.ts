import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Harness } from "./contracts.ts";
export function executable(name: string): string | null {
  const candidates = (process.env.PATH || "")
    .split(delimiter)
    .map((p) => join(p, name));
  if (name === "codex")
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  for (const path of candidates)
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  return null;
}
export function harnesses(): Harness[] {
  return [
    ["codex", "Codex"],
    ["claude", "Claude Code"],
    ["gemini", "Gemini CLI"],
    ["cursor-agent", "Cursor"],
    ["opencode", "OpenCode"],
  ].map(([id, name]) => {
    const path = executable(id);
    return {
      id,
      name,
      available: !!path,
      executable: path,
      workerSupported: id === "codex" && !!path,
      hostSupported: !!path,
      reason:
        id === "codex"
          ? "Native app-server worker adapter"
          : "Discovered host CLI; worker adapter is planned",
    };
  });
}
