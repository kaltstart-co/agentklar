import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Harness } from "./contracts.ts";
export function executable(
  name: string,
  pathEnv = process.env.PATH || "",
  home = homedir(),
): string | null {
  const candidates = pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((p) => join(p, name));
  if (name === "codex")
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  if (name === "claude") {
    candidates.push(join(home, ".local", "bin", "claude"));
    const desktop = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    try {
      const versions = readdirSync(desktop).filter((v) =>
        /^\d+\.\d+\.\d+$/.test(v),
      );
      versions.sort((a, b) => {
        const x = a.split(".").map(Number),
          y = b.split(".").map(Number);
        return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
      });
      candidates.push(
        ...versions.map((v) =>
          join(desktop, v, "claude.app", "Contents", "MacOS", "claude"),
        ),
      );
    } catch {}
  }
  for (const path of candidates)
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
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
      workerSupported: ["codex", "claude"].includes(id) && !!path,
      hostSupported: !!path,
      reason:
        id === "codex"
          ? "Native app-server worker adapter"
          : id === "claude"
            ? "Official Claude Agent SDK worker adapter; native sign-in required"
            : "Discovered host CLI; worker adapter is planned",
    };
  });
}
