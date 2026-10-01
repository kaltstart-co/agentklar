import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RunWorkspace } from "./contracts.ts";
import { projectRootIdentity } from "./project-root.ts";

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args], {
  encoding: "utf8", timeout: 10000, maxBuffer: 256000, stdio: ["ignore", "pipe", "ignore"], env: gitEnv,
}).trim();

function canonicalDirectory(path: string) {
  if (!statSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error("Workspace folder changed.");
}

export function gitCheckout(path: string) {
  try {
    canonicalDirectory(path);
    return {
      root: realpathSync(git(path, "rev-parse", "--show-toplevel")),
      commonDir: realpathSync(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    };
  } catch { return null; }
}

export function gitBase(projectPath: string) {
  const checkout = gitCheckout(projectPath);
  if (!checkout) throw new Error("Worktrees need a Git repository with a local HEAD commit.");
  if (checkout.root !== projectPath)
    throw new Error("Worktrees require the registered project to be the Git repository root.");
  let baseCommit: string;
  try { baseCommit = git(projectPath, "rev-parse", "HEAD"); }
  catch { throw new Error("Worktrees need a Git repository with a local HEAD commit."); }
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("No local HEAD commit found.");
  return { repoRoot: checkout.root, commonDir: checkout.commonDir, baseCommit,
    repoStamp: projectRootIdentity(checkout.root), commonStamp: projectRootIdentity(checkout.commonDir) };
}

export function verifyWorktree(workspace: Extract<RunWorkspace, { kind: "worktree" }>, path: string) {
  const checkout = gitCheckout(path);
  if (!checkout || checkout.root !== path || checkout.commonDir !== workspace.commonDir || path === workspace.repoRoot)
    throw new Error("Worktree is missing, changed, or belongs to another repository.");
  if (projectRootIdentity(workspace.repoRoot) !== workspace.repoStamp ||
    projectRootIdentity(workspace.commonDir) !== workspace.commonStamp ||
    (workspace.workspaceStamp && projectRootIdentity(path) !== workspace.workspaceStamp))
    throw new Error("Worktree or repository folder was replaced.");
  let branch: string;
  try { branch = git(path, "symbolic-ref", "--short", "HEAD"); }
  catch { throw new Error("Worktree branch changed or is detached."); }
  if (!branch) throw new Error("Worktree branch is missing.");
  return branch;
}

export function plannedWorktree(workspace: Extract<RunWorkspace, { kind: "worktree" }>, home: string) {
  return { ...workspace, path: join(realpathSync(home), "worktrees", workspace.rootRunId),
    branch: `agentklar/${workspace.rootRunId}`, verified: false };
}

export async function createWorktree(workspace: Extract<RunWorkspace, { kind: "worktree" }>, signal: AbortSignal, onPid: (pid?: number) => void) {
  const path = workspace.path!;
  if (existsSync(path)) throw new Error("Worktree destination is already occupied.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", ["-C", workspace.repoRoot, "worktree", "add", "-b", workspace.branch!, path, workspace.baseCommit], {
      stdio: "ignore", detached: process.platform !== "win32", env: gitEnv,
    });
    if (child.pid) onPid(child.pid);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      error ? reject(error) : resolvePromise();
    };
    const stop = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
    };
    const timer = setTimeout(stop, 10000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", () => {});
    child.once("close", (code) => {
      let groupAlive = false;
      try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, 0); groupAlive = !!child.pid; }
      catch (error) { groupAlive = (error as NodeJS.ErrnoException).code === "EPERM"; }
      if (!groupAlive) onPid(undefined);
      finish(groupAlive ? new Error("Git worktree process group may still be alive.") :
        code === 0 ? undefined : new Error("Git could not create the worktree."));
    });
  });
  if (verifyWorktree(workspace, path) !== workspace.branch || git(path, "rev-parse", "HEAD") !== workspace.baseCommit)
    throw new Error("Created worktree could not be verified.");
  return { ...workspace, verified: true, workspaceStamp: projectRootIdentity(path) };
}

export function verifyNativeWorktree(workspace: Extract<RunWorkspace, { kind: "worktree" }>, path: string) {
  const expected = resolve(workspace.repoRoot, ".claude", "worktrees", workspace.nativeName!);
  if (path !== expected || !workspace.nativeName || !/^[0-9a-f-]{36}$/.test(workspace.nativeName))
    throw new Error("Claude did not report its expected worktree folder.");
  const branch = verifyWorktree(workspace, path);
  if (git(path, "rev-parse", "HEAD") !== workspace.baseCommit)
    throw new Error("Claude worktree did not start from local HEAD.");
  return { ...workspace, path, branch, verified: true, workspaceStamp: projectRootIdentity(path) };
}
