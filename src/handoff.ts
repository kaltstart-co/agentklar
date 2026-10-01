import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Project, Run, RunHandoff } from "./contracts.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safePath = (value: string) => isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function runHandoff(run: Run, project: Project | undefined, busy: boolean, cli: string | null): RunHandoff {
  const harness = run.harness === "codex" || run.harness === "claude" ? run.harness : null;
  const packet: RunHandoff = { runId: run.id, available: false, reason: null, harness,
    nativeSessionId: typeof run.threadId === "string" && uuid.test(run.threadId) ? run.threadId : null,
    command: null, notes: [] };
  const unavailable = (reason: string) => ({ ...packet, reason });
  if (!harness) return unavailable("This run has no supported native harness.");
  if (["running", "needs_attention"].includes(run.state)) return unavailable("The worker is still active.");
  if (!["completed", "failed", "cancelled", "interrupted"].includes(run.state))
    return unavailable("The run is not in a finished state.");
  if (busy) return unavailable("This project has an active worker or a possibly surviving worker process group. Close it before continuing in the native harness.");
  if (!project) return unavailable("The saved project no longer exists.");
  if (!safePath(project.path)) return unavailable("The saved project folder path is not safe for a native command.");
  try {
    if (!statSync(project.path).isDirectory() || realpathSync(project.path) !== project.path)
      return unavailable("The saved project folder changed or is no longer a directory.");
  } catch { return unavailable("The saved project folder is missing."); }
  if (!packet.nativeSessionId) return unavailable("No native session UUID was recorded for this run.");
  if (harness === "claude" && run.readOnly)
    return unavailable("Claude read-only runs use an AgentKlar SDK tool hook that native CLI resume cannot preserve. Open the session in Claude only if you accept its native permissions.");
  if (!cli || !safePath(cli)) return unavailable(`${harness === "codex" ? "Codex" : "Claude Code"} native CLI is unavailable.`);
  try {
    accessSync(cli, constants.X_OK);
    if (!statSync(cli).isFile()) return unavailable("The native CLI is not an executable file.");
  } catch { return unavailable("The native CLI is not installed or executable."); }
  if (!run.nativeHome || !safePath(run.nativeHome))
    return unavailable("The native session home was not recorded as a safe absolute path for this run.");
  if (harness === "claude") {
    if (run.nativeHomeEnv !== "set" && run.nativeHomeEnv !== "unset")
      return unavailable("The Claude config environment scope was not recorded for this run.");
    if (run.nativeHomeEnv === "unset" && run.nativeHome !== join(homedir(), ".claude"))
      return unavailable("The current user home differs from this Claude session's saved home.");
  }
  const model = run.effectiveModel || run.model;
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,119}$/.test(model))
    return unavailable("The saved model name is not safe for a native command.");
  const variable = harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const argv = harness === "codex"
    ? ["resume", "--cd", project.path, ...(run.readOnly ? ["--sandbox", "read-only"] : []),
        ...(model ? [`--model=${model}`] : []), packet.nativeSessionId]
    : ["--resume", packet.nativeSessionId, ...(model ? [`--model=${model}`] : [])];
  const unsetClaude = harness === "claude" && run.nativeHomeEnv === "unset";
  const env = unsetClaude ? {} : { [variable]: run.nativeHome };
  const envUnset = unsetClaude ? [variable] : [];
  const commandText = [cli, ...argv].map(quote).join(" ");
  const display = unsetClaude
    ? `(unset CLAUDE_CONFIG_DIR && cd ${quote(project.path)} && ${commandText})`
    : `cd ${quote(project.path)} && ${variable}=${quote(run.nativeHome)} ${commandText}`;
  const ready: RunHandoff = { ...packet, available: true, reason: null,
    command: { executable: cli, argv, cwd: project.path, env, envUnset, shell: "posix", display },
    notes: [
      ...(model ? [] : ["No model was saved. The native harness will choose its current default model."]),
      "The native harness will check whether this saved session can be opened.",
      "This is a snapshot. AgentKlar does not monitor or take ownership of the manual native session. Close native work before starting another worker in this project.",
    ] };
  return JSON.stringify(ready).length <= 20000
    ? ready : unavailable("The native command is too long to copy safely.");
}
