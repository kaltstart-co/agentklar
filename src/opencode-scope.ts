import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { OpenCodeScope } from "./contracts.ts";

export const openCodePathKeys = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_TUI_CONFIG"] as const;
// Known native overrides that would make a copied shell command use a different scope.
export const openCodeUnsetKeys = ["OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", "OPENCODE_TEST_HOME",
  "OPENCODE_WORKSPACE_ID", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_PURE",
  "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE_PLUGINS",
  "OPENCODE_EXPERIMENTAL_EXTERNAL_SKILLS", "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_CHANNEL_DB", "OPENCODE_GIT_BASH_PATH", "OPENCODE_FAKE_VCS",
  "OPENCODE_MODELS_URL", "OPENCODE_MODELS_PATH", "OPENCODE_PLUGIN_META_FILE", "OPENCODE_CLIENT",
  "OPENCODE_CONSOLE_TOKEN", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME",
  "OPENCODE_EXPERIMENTAL", "OPENCODE_EXPERIMENTAL_REFERENCES", "OPENCODE_EXPERIMENTAL_WORKSPACES",
  "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_ALWAYS_NOTIFY_UPDATE", "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_DISABLE_TERMINAL_TITLE", "OPENCODE_SHOW_TTFD", "OPENCODE_DISABLE_AUTOCOMPACT",
  "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_MOUSE", "OPENCODE_DISABLE_FFF",
  "OPENCODE_EXPERIMENTAL_FILEWATCHER", "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
  "OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT", "OPENCODE_AUTO_HEAP_SNAPSHOT",
  "OPENCODE_AUTO_SHARE", "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_LSP_DOWNLOAD", "OPENCODE_ENABLE_EXA",
  "OPENCODE_ENABLE_EXPERIMENTAL_MODELS", "OPENCODE_ENABLE_PARALLEL", "OPENCODE_ENABLE_QUESTION_TOOL",
  "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS", "OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS",
  "OPENCODE_EXPERIMENTAL_CODE_MODE", "OPENCODE_EXPERIMENTAL_EVENT_SYSTEM", "OPENCODE_EXPERIMENTAL_EXA",
  "OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", "OPENCODE_EXPERIMENTAL_LSP_TOOL", "OPENCODE_EXPERIMENTAL_LSP_TY",
  "OPENCODE_EXPERIMENTAL_NATIVE_LLM", "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX", "OPENCODE_EXPERIMENTAL_OXFMT",
  "OPENCODE_EXPERIMENTAL_PARALLEL", "OPENCODE_EXPERIMENTAL_PLAN_MODE", "OPENCODE_EXPERIMENTAL_WEBSOCKETS"] as const;
export const safeNativePath = (value: unknown): value is string => typeof value === "string" &&
  isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) &&
  (value as string & { isWellFormed(): boolean }).isWellFormed();

/** Capture only nonsecret native path settings from the exact worker environment. */
export function captureOpenCodeScope(nativeEnv: NodeJS.ProcessEnv): OpenCodeScope {
  const env: Record<string, string> = {};
  const envUnset: string[] = [];
  const supported = new Set<string>([...openCodePathKeys, "OPENCODE_DB"]);
  let unsupported = nativeEnv.OPENCODE_CONFIG_CONTENT !== undefined || nativeEnv.OPENCODE_PERMISSION !== undefined ||
    nativeEnv.OPENCODE_TEST_HOME !== undefined || nativeEnv.OPENCODE_WORKSPACE_ID !== undefined ||
    nativeEnv.OPENCODE_DISABLE_PROJECT_CONFIG !== undefined || nativeEnv.OPENCODE_PURE !== undefined ||
    nativeEnv.OPENCODE_DB === ":memory:" ||
    Object.keys(nativeEnv).some(key => key.startsWith("OPENCODE_") && !supported.has(key));
  for (const key of openCodePathKeys) {
    const value = nativeEnv[key];
    if (value === undefined) envUnset.push(key);
    else if (safeNativePath(value)) env[key] = value;
    else unsupported = true;
  }
  const rawHome = nativeEnv.HOME ?? homedir();
  let home = rawHome;
  try { home = realpathSync(rawHome); } catch { unsupported = true; }
  if (!safeNativePath(home)) unsupported = true;
  const dataRoot = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const dataDir = join(dataRoot, "opencode");
  if (!safeNativePath(dataDir)) unsupported = true;
  if (nativeEnv.OPENCODE_DB !== undefined &&
    (nativeEnv.OPENCODE_DB.length > 4096 || /[\x00-\x1f\x7f]/.test(nativeEnv.OPENCODE_DB) ||
      !(nativeEnv.OPENCODE_DB as string & { isWellFormed(): boolean }).isWellFormed())) unsupported = true;
  return { home, dataDir, env, envUnset, ...(unsupported ? { unsupported: true } : {}) };
}

export function verifiedOpenCodeScope(scope: OpenCodeScope, dbPath: string): OpenCodeScope {
  if (scope.unsupported || !safeNativePath(dbPath)) return scope;
  try {
    const dataDir = realpathSync(scope.dataDir);
    const db = realpathSync(dbPath);
    if (!statSync(dataDir).isDirectory() || !statSync(db).isFile() || !safeNativePath(dataDir) || !safeNativePath(db)) return scope;
    return { ...scope, dataDir, dbPath: db };
  } catch { return scope; }
}
