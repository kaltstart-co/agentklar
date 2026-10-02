import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Harness } from "./contracts.ts";
export function executables(
  name: string,
  pathEnv = process.env.PATH || "",
  home = homedir(),
): string[] {
  const candidates = pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((p) => join(p, name));
  if (name === "codex")
    candidates.push("/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
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
  if (name === "muse") candidates.push(join(home, ".local", "bin", "muse"));
  if (name === "agy") candidates.push(join(home, ".local", "bin", "agy"));
  if (name === "opencode") candidates.push(join(home, ".opencode", "bin", "opencode"), join(home, ".bun", "bin", "opencode"));
  const found: string[] = [];
  for (const path of new Set(candidates))
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) found.push(path);
    } catch {}
  return found;
}
export function executable(name: string, pathEnv = process.env.PATH || "", home = homedir()): string | null {
  return executables(name, pathEnv, home)[0] ?? null;
}
export function harnesses(): Harness[] {
  return [
    ["codex", "Codex"],
    ["claude", "Claude Code"],
    ["muse", "Muse"],
    ["gemini", "Gemini CLI"],
    ["cursor-agent", "Cursor"],
    ["opencode", "OpenCode"],
    ["antigravity", "Antigravity CLI"],
  ].map(([id, name]) => {
    const path = executable(id === "antigravity" ? "agy" : id);
    return {
      id,
      name,
      available: !!path,
      executable: path,
      workerSupported: ["codex", "claude", "muse", "opencode"].includes(id) && !!path,
      hostSupported: !!path,
      reason:
        id === "codex"
          ? "Native app-server worker adapter"
          : id === "claude"
            ? "Official Claude Agent SDK worker adapter; native sign-in required"
            : id === "muse"
              ? "Native MSP worker adapter; MCP host setup uses Muse settings"
            : id === "opencode"
              ? "Native OpenCode local server worker adapter; provider setup stays in OpenCode"
            : id === "antigravity"
              ? "Native Antigravity CLI found; worker support unavailable until its adapter is verified"
              : "Discovered host CLI; worker adapter is planned",
    };
  });
}
