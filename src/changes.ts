import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Project, Run, RunWorkspace } from "./contracts.ts";
import type { Store } from "./store.ts";
import { gitBase, verifyWorktree, plannedWorktree, createWorktree } from "./workspace.ts";
import { projectRootIdentity } from "./project-root.ts";

const MAX_PATCH = 96_000;
const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const safeFile = (path: string) => path.length <= 512 && !/[\x00-\x1f\x7f\\]/.test(path) && !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === "." || part.toLowerCase() === ".git" || part === "") && !/^[A-Za-z]:/.test(path);
const file = z.object({ path: z.string().refine(safeFile), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).strict();
export const changePacketSchema = z.object({ version: z.literal(1), sourceDeviceId: z.uuid(), sourceProjectId: z.uuid(), sourceRunId: z.uuid(), baseCommit: sha, headCommit: sha, createdAt: z.iso.datetime(), patch: z.string().max(MAX_PATCH).refine(s => Buffer.byteLength(s) <= MAX_PATCH && !s.includes("\0")), files: z.array(file).min(1).max(100), stat: z.string().max(6000), ignoredPaths: z.array(z.string().max(512)).max(50), ignoredTruncated: z.boolean(), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ChangePacket = z.infer<typeof changePacketSchema>;
export type ChangeApply = { previewId: string; digest: string; workspace: Extract<RunWorkspace, { kind: "worktree" }>; appliedAt: string };
export type ChangeIntent = { workspace: Extract<RunWorkspace, { kind: "worktree" }>; expectedTree: string; startedAt: string; state: "creating" | "applying" | "interrupted" | "complete"; error?: string };
export type ChangePreview = { application?: ChangeIntent; id: string; projectId: string; packet: ChangePacket; createdAt: string; applied?: ChangeApply };
type Saved = ChangePreview & { contentKey: string; root: ReturnType<typeof gitBase> };
export class ChangeError extends Error { constructor(message: string, public status = 409) { super(message); } }
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
function git(path: string, args: string[], index?: string, input?: string, maxBuffer = 256_000): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(execFileSync("git", ["-C", path, ...args], { timeout: 10000, maxBuffer, input, stdio: ["pipe", "pipe", "ignore"], env: { ...gitEnv, ...(index ? { GIT_INDEX_FILE: index } : {}) } })); }
  catch (error) { if (error instanceof TypeError && (error as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA") throw new ChangeError("Non-UTF8 content cannot be transferred by this text handoff."); throw new ChangeError("Git could not verify these changes. The patch may conflict, exceed its size limit or reference unsupported paths."); }
}
function temporaryIndex<T>(work: (index: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "agentklar-change-index-"));
  try { return work(join(directory, "index")); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function identity(packet: Omit<ChangePacket, "digest">): string {
  return createHash("sha256").update(JSON.stringify(changePacketSchema.omit({ digest: true }).parse(packet))).digest("hex");
}
function entries(path: string, base: string, tree: string) {
  const raw = git(path, ["diff", "--no-ext-diff", "--no-textconv", "--raw", "-z", "--no-renames", base, tree, "--"]).split("\0");
  for (let i = 0; i < raw.length - 1; i += 2) {
    const fields = raw[i].slice(1).split(" "), name = raw[i + 1];
    if (!safeFile(name)) throw new ChangeError("Changes contain a path unsupported by this handoff.");
    if (![fields[0], fields[1]].every(mode => ["000000", "100644", "100755"].includes(mode))) throw new ChangeError("Symlink and submodule changes cannot be transferred by this text handoff.");
  }
  const nums = git(path, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--no-renames", base, tree, "--"]).split("\0").filter(Boolean);
  if (!nums.length) throw new ChangeError("No transferable changes were found.");
  if (nums.length > 100) throw new ChangeError("This handoff supports at most 100 changed files. Split the work explicitly.");
  return nums.map(entry => {
    const first = entry.indexOf("\t"), second = entry.indexOf("\t", first + 1), added = entry.slice(0, first), removed = entry.slice(first + 1, second), name = entry.slice(second + 1);
    if (added === "-" || removed === "-") throw new ChangeError("Binary changes cannot be transferred by this text handoff.");
    return file.parse({ path: name, added: Number(added), removed: Number(removed) });
  });
}
function checkedPacket(value: unknown): ChangePacket {
  const packet = changePacketSchema.parse(value), { digest, ...body } = packet;
  if (identity(body) !== digest) throw new ChangeError("Patch digest does not match its contents.");
  return packet;
}
function validatePatch(path: string, packet: ChangePacket) {
  return temporaryIndex(index => {
    git(path, ["read-tree", packet.baseCommit], index);
    git(path, ["apply", "--cached", "--check", "--whitespace=nowarn", "-"], index, packet.patch);
    git(path, ["apply", "--cached", "--whitespace=nowarn", "-"], index, packet.patch);
    const tree = git(path, ["write-tree"], index).trim();
    const actual = entries(path, packet.baseCommit, tree);
    if (JSON.stringify(actual) !== JSON.stringify(packet.files)) throw new ChangeError("Patch file list does not match the reviewed packet.");
    return tree;
  });
}

export class Changes {
  private applying = new Set<string>();
  constructor(private store: Store, private home: string) { store.db.exec("CREATE TABLE IF NOT EXISTS change_previews(id TEXT PRIMARY KEY,data TEXT NOT NULL)"); }
  export(run: Run, project: Project | undefined, sourceDeviceId: string, busy: boolean): ChangePacket {
    if (!project || run.projectId !== project.id) throw new ChangeError("Source project no longer exists.");
    if (busy || ["running", "needs_attention"].includes(run.state)) throw new ChangeError("Source checkout has an active or possibly surviving worker. Wait until it stops.");
    const workspace = run.workspace;
    if (!workspace || workspace.kind !== "worktree" || !workspace.verified || !workspace.path || !workspace.branch) throw new ChangeError("Export requires a finished run with a verified separate worktree.");
    if (workspace.repoRoot !== project.path || verifyWorktree(workspace, workspace.path) !== workspace.branch) throw new ChangeError("Source worktree or project identity changed.");
    const path = workspace.path, headCommit = git(path, ["rev-parse", "HEAD"]).trim();
    git(path, ["merge-base", "--is-ancestor", workspace.baseCommit, headCommit]);
    const result = temporaryIndex(index => {
      git(path, ["read-tree", headCommit], index);
      git(path, ["add", "-A", "--", "."], index);
      const tree = git(path, ["write-tree"], index).trim();
      const files = entries(path, workspace.baseCommit, tree);
      const patch = git(path, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--full-index", "--binary", workspace.baseCommit, tree, "--"], undefined, undefined, MAX_PATCH + 1);
      if (Buffer.byteLength(patch) > MAX_PATCH || patch.includes("\0")) throw new ChangeError("Patch exceeds the text handoff limit or contains binary content.");
      const stat = git(path, ["diff", "--no-ext-diff", "--no-textconv", "--stat=100", "--no-renames", workspace.baseCommit, tree, "--"]).slice(0, 6000);
      const ignored = git(path, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal", "--no-renames"]).split("\0").filter(s => s.startsWith("!! ")).map(s => s.slice(3));
      git(path, ["add", "-A", "--", "."], index);
      if (git(path, ["write-tree"], index).trim() !== tree || git(path, ["rev-parse", "HEAD"]).trim() !== headCommit || verifyWorktree(workspace, path) !== workspace.branch) throw new ChangeError("Source changed during export. Prepare a fresh handoff.");
      return { files, patch, stat, ignoredPaths: ignored.slice(0, 50).map(p => p.slice(0, 512)), ignoredTruncated: ignored.length > 50 };
    });
    const body = { version: 1 as const, sourceDeviceId, sourceProjectId: project.id, sourceRunId: run.id, baseCommit: workspace.baseCommit, headCommit, createdAt: new Date().toISOString(), ...result };
    return checkedPacket({ ...body, digest: identity(body) });
  }
  prepare(projectId: string, value: unknown): ChangePreview {
    const packet = checkedPacket(value), project = this.store.projects().find(p => p.id === projectId);
    if (!project) throw new ChangeError("Recipient project not found.", 404);
    const root = gitBase(project.path);
    git(project.path, ["cat-file", "-e", `${packet.baseCommit}^{commit}`]);
    validatePatch(project.path, packet);
    const { digest: _digest, createdAt: _createdAt, ...content } = packet;
    const contentKey = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    const prior = this.store.db.prepare("SELECT data FROM change_previews WHERE json_extract(data,'$.projectId')=? AND json_extract(data,'$.contentKey')=? ORDER BY rowid DESC LIMIT 1").get(projectId, contentKey);
    if (prior) {
      const saved = JSON.parse(prior.data as string) as Saved;
      if (saved.root.repoStamp === root.repoStamp && saved.root.commonStamp === root.commonStamp) return this.public(saved);
    }
    const saved: Saved = { contentKey, id: randomUUID(), projectId, packet, root, createdAt: new Date().toISOString() };
    this.store.db.prepare("INSERT INTO change_previews(id,data) VALUES(?,?)").run(saved.id, JSON.stringify(saved));
    return this.public(saved);
  }
  private saved(id: string): Saved {
    z.uuid().parse(id);
    const row = this.store.db.prepare("SELECT data FROM change_previews WHERE id=?").get(id);
    if (!row) throw new ChangeError("Patch preview not found.", 404);
    return JSON.parse(row.data as string);
  }
  private save(saved: Saved) { this.store.db.prepare("UPDATE change_previews SET data=? WHERE id=?").run(JSON.stringify(saved), saved.id); }
  private public({ root, contentKey, ...preview }: Saved): ChangePreview { return preview; }
  forSource(sourceDeviceId: string, sourceRunId: string) {
    z.uuid().parse(sourceDeviceId); z.uuid().parse(sourceRunId);
    return this.store.db.prepare("SELECT data FROM change_previews WHERE json_extract(data,'$.packet.sourceDeviceId')=? AND json_extract(data,'$.packet.sourceRunId')=? ORDER BY rowid DESC LIMIT 10")
      .all(sourceDeviceId, sourceRunId).map(row => {
        const saved = JSON.parse(row.data as string) as Saved;
        return { id: saved.id, projectId: saved.projectId, digest: saved.packet.digest, baseCommit: saved.packet.baseCommit,
          sourceDeviceId, sourceRunId, createdAt: saved.createdAt, ...(saved.application ? { application: saved.application } : {}), ...(saved.applied ? { applied: saved.applied } : {}) };
      });
  }
  read(id: string) { return this.public(this.saved(id)); }
  async apply(id: string, expectedDigest: string, expectedBaseCommit: string): Promise<ChangeApply> {
    const saved = this.saved(id), packet = checkedPacket(saved.packet);
    if (expectedDigest !== packet.digest || expectedBaseCommit !== packet.baseCommit) throw new ChangeError("Reviewed patch digest or base differs. Read the saved preview before applying.");
    if (saved.applied) {
      if (verifyWorktree(saved.applied.workspace, saved.applied.workspace.path!) !== saved.applied.workspace.branch) throw new ChangeError("The applied worktree changed or is missing.");
      return saved.applied;
    }
    if (this.applying.has(id)) throw new ChangeError("This patch is already being applied.");
    const project = this.store.projects().find(p => p.id === saved.projectId);
    if (!project || project.path !== saved.root.repoRoot || projectRootIdentity(project.path) !== saved.root.repoStamp || projectRootIdentity(saved.root.commonDir) !== saved.root.commonStamp) throw new ChangeError("Recipient project identity changed. Prepare a fresh handoff.");
    const expectedTree = validatePatch(project.path, packet);
    this.applying.add(id);
    try {
      if (!saved.application) {
        const workspace = plannedWorktree({ kind: "worktree", ...saved.root, baseCommit: packet.baseCommit, rootRunId: id }, this.home);
        saved.application = { workspace, expectedTree, startedAt: new Date().toISOString(), state: "creating" };
        this.save(saved); // Record the exact destination before Git changes anything.
      }
      const intent = saved.application;
      if (intent.expectedTree !== expectedTree) throw new ChangeError("Saved apply intent differs from this patch. Inspect its destination manually.");
      let verified = intent.workspace;
      if (!existsSync(verified.path!)) {
        if (intent.state !== "creating") throw new ChangeError("Interrupted apply destination is missing. Inspect the saved intent before continuing.");
        verified = await createWorktree(verified, new AbortController().signal, () => {});
      } else {
        if (verifyWorktree(verified, verified.path!) !== verified.branch || git(verified.path!, ["rev-parse", "HEAD"]).trim() !== packet.baseCommit) throw new ChangeError("Saved destination does not match its owned worktree and base. No files were overwritten.");
        verified = { ...verified, verified: true, workspaceStamp: projectRootIdentity(verified.path!) };
      }
      intent.workspace = verified; intent.state = "applying"; intent.error = undefined; this.save(saved);
      if (projectRootIdentity(project.path) !== saved.root.repoStamp) throw new ChangeError("Recipient project changed during worktree creation.");
      const indexed = git(verified.path!, ["write-tree"]).trim(), baseTree = git(verified.path!, ["rev-parse", `${packet.baseCommit}^{tree}`]).trim();
      git(verified.path!, ["diff", "--quiet", "--no-ext-diff", "--no-textconv"]);
      if (git(verified.path!, ["ls-files", "--others", "--exclude-standard", "-z"]).length) throw new ChangeError("Saved destination contains new untracked files. Inspect it before continuing.");
      if (indexed === baseTree) {
        git(verified.path!, ["apply", "--index", "--check", "--whitespace=nowarn", "-"], undefined, packet.patch);
        git(verified.path!, ["apply", "--index", "--whitespace=nowarn", "-"], undefined, packet.patch);
      } else if (indexed !== expectedTree) throw new ChangeError("Interrupted apply contains different staged changes. No files were overwritten.");
      if (git(verified.path!, ["write-tree"]).trim() !== expectedTree || verifyWorktree(verified, verified.path!) !== verified.branch) throw new ChangeError("Recipient worktree changed during apply.");
      git(verified.path!, ["diff", "--quiet", "--no-ext-diff", "--no-textconv"]);
      const result: ChangeApply = { previewId: id, digest: packet.digest, workspace: verified, appliedAt: new Date().toISOString() };
      saved.applied = result; intent.state = "complete"; this.save(saved);
      return result;
    } catch {
      delete saved.applied;
      if (saved.application) {
        saved.application.state = "interrupted";
        saved.application.error = `Apply did not finish. Inspect the separate destination at ${saved.application.workspace.path}. The original checkout was not overwritten.`;
        try { this.save(saved); } catch { /* The durable intent already names the destination. */ }
        throw new ChangeError(saved.application.error);
      }
      throw new ChangeError("Apply could not begin. Read the saved preview before trying again.");
    } finally { this.applying.delete(id); }
  }
}
