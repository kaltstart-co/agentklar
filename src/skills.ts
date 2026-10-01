import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  rmdirSync,
  closeSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Project } from "./contracts.ts";
import { projectRootIdentity, rootStamp } from "./project-root.ts";

export const skillHarness = z.enum(["codex", "claude"]);
export const skillSource = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/([A-Za-z0-9][A-Za-z0-9_.-]{0,98})(#[A-Za-z0-9][A-Za-z0-9._/-]{0,127})?$/,
  )
  .refine((v) => !v.includes("..") && !v.includes("//") && !v.endsWith("/"));
export const skillName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const skillPreviewInput = z
  .object({ harness: skillHarness, source: skillSource, name: skillName })
  .strict()
  .refine(
    (v) =>
      v.harness !== "claude" ||
      (v.name !== "synced" && !v.name.startsWith("anthropic-skills")),
  );
export const skillIdInput = z.object({ previewId: z.uuid() }).strict();
export const skillRemoveInput = z.object({ installId: z.uuid() }).strict();
export type SkillHarness = z.infer<typeof skillHarness>;
type File = {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  hash: string | null;
  mode: number;
  identity?: string;
};
type Preview = {
  id: string;
  projectId: string;
  harness: SkillHarness;
  source: string;
  name: string;
  path: string;
  root: string;
  parents: (string | null)[];
  files: File[];
  text: string;
  stage: string;
  stageIdentity: string;
  stageParents: string[];
  expires: number;
  upstreamHash: string | null;
  previous: Install | null;
};
type Install = {
  id: string;
  projectId: string;
  harness: SkillHarness;
  source: string;
  name: string;
  path: string;
  root: string;
  parents: string[];
  files: File[];
  targetIdentity: string;
  state: "prepared" | "installed" | "updating" | "removing" | "removed" | "interrupted";
  message: string | null;
  upstreamHash: string | null;
  createdAt: string;
};
export class SkillError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 422 | 503 = 422,
  ) {
    super(message);
  }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const subdir = (h: SkillHarness) => (h === "codex" ? ".agents" : ".claude");
const folder = (p: Project, h: SkillHarness, name: string) =>
  join(p.path, subdir(h), "skills", name);
function identity(path: string) {
  const st = lstatSync(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new SkillError(
      "A skill folder changed or is not a real directory.",
      409,
    );
  return rootStamp(st);
}
function root(project: Project) {
  try {
    return projectRootIdentity(project.path);
  } catch {
    throw new SkillError(
      "Project folder changed or cannot be checked safely.",
      409,
    );
  }
}
function maybeIdentity(path: string): string | null {
  try {
    return identity(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
function parents(project: Project, harness: SkillHarness) {
  return [
    join(project.path, subdir(harness)),
    join(project.path, subdir(harness), "skills"),
  ];
}
function folderNames(path: string) {
  const names: string[] = [];
  let truncated = false;
  const dir = opendirSync(path);
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (names.length === 200) {
        truncated = true;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  return { names: names.sort(), truncated };
}
function manifest(dir: string, withIdentity = false): File[] {
  const files: File[] = [];
  let total = 0,
    bytesTotal = 0;
  function walk(current: string, prefix: string, depth: number) {
    if (depth > 8) throw new SkillError("Skill folder is too deep.");
    const entries: string[] = [];
    const opened = opendirSync(current);
    try {
      let entry;
      while ((entry = opened.readSync())) {
        if (++total > 200) throw new SkillError("Skill exceeds 200 entries.");
        entries.push(entry.name);
      }
    } finally {
      opened.closeSync();
    }
    for (const entry of entries.sort()) {
      const path = join(current, entry),
        rel = prefix ? `${prefix}/${entry}` : entry;
      if (
        rel
          .split("/")
          .some((s) => [".claude-plugin", "hooks", "mcp"].includes(s)) ||
        [".mcp.json", "mcp.json", "plugin.json"].includes(entry.toLowerCase())
      )
        throw new SkillError(
          "Plugin, hook and MCP bundles are outside project skill support.",
        );
      const st = lstatSync(path);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        files.push({
          path: rel,
          kind: "directory",
          bytes: 0,
          hash: null,
          mode: st.mode & 0o777,
          ...(withIdentity
            ? { identity: `${st.dev}:${st.ino}:${st.birthtimeMs}` }
            : {}),
        });
        walk(path, rel, depth + 1);
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
        throw new SkillError("Skill contains a link or unsupported file.");
      if (st.size > 4_194_304)
        throw new SkillError("Skill exceeds the file or size limit.");
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        const actual = fstatSync(fd);
        if (
          !actual.isFile() ||
          actual.nlink !== 1 ||
          actual.ino !== st.ino ||
          actual.dev !== st.dev ||
          actual.size !== st.size
        )
          throw new SkillError("Skill file changed during review.", 409);
        bytes = readFileSync(fd);
        if (fstatSync(fd).size !== st.size)
          throw new SkillError("Skill file changed during review.", 409);
      } finally {
        closeSync(fd);
      }
      bytesTotal += bytes.length;
      if (bytesTotal > 4_194_304) throw new SkillError("Skill exceeds 4 MiB.");
      files.push({
        path: rel,
        kind: "file",
        bytes: bytes.length,
        hash: sha(bytes),
        mode: st.mode & 0o777,
        ...(withIdentity
          ? { identity: `${st.dev}:${st.ino}:${st.birthtimeMs}` }
          : {}),
      });
    }
  }
  walk(dir, "", 0);
  if (!files.some((f) => f.path === "SKILL.md" && f.kind === "file"))
    throw new SkillError("Skill must contain SKILL.md and fit 4 MiB.");
  if (files.find((f) => f.path === "SKILL.md")!.bytes > 32768)
    throw new SkillError("SKILL.md exceeds 32 KiB.");
  return files;
}
function textFile(dir: string, expected: File[]) {
  const file = expected.find((f) => f.path === "SKILL.md")!;
  const fd = openSync(
    join(dir, "SKILL.md"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.size !== file.bytes ||
      st.size > 32768
    )
      throw new SkillError("SKILL.md changed during review.", 409);
    bytes = readFileSync(fd);
    if (sha(bytes) !== file.hash)
      throw new SkillError("SKILL.md changed during review.", 409);
  } finally {
    closeSync(fd);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new SkillError("SKILL.md must be UTF-8.");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new SkillError("SKILL.md contains binary control text.");
  return text;
}
function sameFiles(a: File[], b: File[], identityRequired = false) {
  return (
    JSON.stringify(
      a.map(({ identity, ...f }) =>
        identityRequired ? { ...f, identity } : f,
      ),
    ) ===
    JSON.stringify(
      b.map(({ identity, ...f }) =>
        identityRequired ? { ...f, identity } : f,
      ),
    )
  );
}
function copyTree(from: string, to: string, files: File[]) {
  // Make SKILL.md last so a native watcher sees the completed support tree.
  const order = [
    ...files.filter((f) => f.kind === "directory"),
    ...files.filter((f) => f.kind === "file" && f.path !== "SKILL.md"),
    ...files.filter((f) => f.path === "SKILL.md"),
  ];
  for (const file of order) {
    const target = join(to, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (file.kind === "directory") {
      mkdirSync(target, { mode: 0o700 });
      continue;
    }
    const source = openSync(
      join(from, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const st = fstatSync(source);
      if (!st.isFile() || st.nlink !== 1 || st.size !== file.bytes)
        throw new SkillError("Reviewed skill changed.", 409);
      bytes = readFileSync(source);
      if (sha(bytes) !== file.hash)
        throw new SkillError("Reviewed skill changed.", 409);
    } finally {
      closeSync(source);
    }
    writeFileSync(target, bytes, { flag: "wx", mode: file.mode });
    chmodSync(target, file.mode);
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  for (const file of files.filter((f) => f.kind === "directory").reverse())
    chmodSync(join(to, file.path), file.mode);
  const fd = openSync(to, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("skills/package.json")),
  "bin/cli.mjs",
);
function stageCommand(
  cwd: string,
  source: string,
  name: string,
  harness: SkillHarness,
  timeoutMs: number,
  live: Set<ChildProcess>,
  signal: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "add",
        source,
        "--skill",
        name,
        "--agent",
        harness === "codex" ? "codex" : "claude-code",
        "--copy",
        "--yes",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
          CI: "1",
          TMPDIR: cwd,
          TEMP: cwd,
          TMP: cwd,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    live.add(child);
    let out = "",
      err = "",
      failed = false;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            "SIGKILL",
          );
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const stop = () => {
      failed = true;
      kill();
    };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    child.stdout?.on("data", (b) => {
      out += b;
      if (Buffer.byteLength(out) > 65536) stop();
    });
    child.stderr?.on("data", (b) => {
      err += b;
      if (Buffer.byteLength(err) > 65536) stop();
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      live.delete(child);
      if (failed || code !== 0)
        reject(
          new SkillError(
            "Skill source could not be staged within the time and output limits.",
            503,
          ),
        );
      else resolve(out);
    });
    if (signal.aborted) stop();
  });
}
export class ProjectSkills {
  private previews = new Map<string, Preview>();
  private live = new Set<ChildProcess>();
  private abort = new AbortController();
  private busy = false;
  private closed = false;
  private activePreview: Promise<void> | null = null;
  constructor(
    private db: DatabaseSync,
    private home: string,
    private options: {
      timeoutMs?: number;
      sourceOverride?: (source: string) => string;
    } = {},
  ) {
    db.exec("PRAGMA synchronous=FULL");
    db.exec(
      "CREATE TABLE IF NOT EXISTS project_skills(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL)",
    );
    for (const row of db.prepare("SELECT data FROM project_skills").all()) {
      const install: Install = JSON.parse(row.data as string);
      if (["prepared", "updating", "removing"].includes(install.state))
        this.save({
          ...install,
          state: "interrupted",
          message:
            install.message ?? "Change was interrupted. Inspect the skill folder; no automatic recovery was attempted.",
        });
    }
  }
  private save(install: Install) {
    this.db
      .prepare(
        "INSERT INTO project_skills VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(install.id, install.projectId, JSON.stringify(install));
  }
  private cleanup() {
    for (const [id, p] of this.previews)
      if (p.expires <= Date.now()) {
        rmSync(p.stage, { recursive: true, force: true });
        this.previews.delete(id);
      }
  }
  list(project: Project) {
    const rows = this.db
      .prepare(
        "SELECT data FROM project_skills WHERE projectId=? ORDER BY rowid DESC",
      )
      .all(project.id)
      .map((r) => JSON.parse(r.data as string) as Install);
    const skills = [] as {
      id: string | null;
      harness: SkillHarness;
      name: string;
      path: string;
      state: string;
      source: string | null;
      message: string | null;
    }[];
    for (const harness of ["codex", "claude"] as const) {
      const base = parents(project, harness)[1];
      const latest = new Map<string, Install>();
      for (const row of rows)
        if (row.harness === harness && !latest.has(row.name))
          latest.set(row.name, row);
      try {
        root(project);
        identity(parents(project, harness)[0]);
        identity(base);
        const { names, truncated } = folderNames(base);
        for (const name of names) {
          const path = join(base, name),
            saved = latest.get(name),
            owned = saved?.state === "removed" ? undefined : saved;
          const st = lstatSync(path);
          let state =
            owned?.state ??
            (st.isDirectory() && !st.isSymbolicLink()
              ? "external"
              : "unavailable");
          if (owned?.state === "installed") {
            try {
              if (
                root(project) !== owned.root ||
                identity(path) !== owned.targetIdentity ||
                !sameFiles(manifest(path, true), owned.files, true)
              )
                state = "changed";
            } catch {
              state = "changed";
            }
          }
          skills.push({
            id: owned?.id ?? null,
            harness,
            name,
            path,
            state,
            source: owned?.source ?? null,
            message:
              state === "changed"
                ? "Managed skill changed outside AgentKlar. Update and remove are disabled."
                : (owned?.message ?? null),
          });
        }
        if (truncated)
          skills.push({
            id: null,
            harness,
            name: "(more folders)",
            path: base,
            state: "unavailable",
            source: null,
            message: "Showing the first 200 project skill folders.",
          });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          skills.push({
            id: null,
            harness,
            name: "(folder unavailable)",
            path: base,
            state: "unavailable",
            source: null,
            message: "Skill folder cannot be listed safely.",
          });
      }
      for (const row of [...latest.values()].filter(
        (r) => r.state !== "removed" && !skills.some((s) => s.id === r.id),
      ))
        skills.push({
          id: row.id,
          harness,
          name: row.name,
          path: row.path,
          state: "interrupted",
          source: row.source,
          message: row.message ?? "Managed folder is missing.",
        });
    }
    return {
      projectId: project.id,
      checkedAt: new Date().toISOString(),
      skills,
    };
  }
  preview(project: Project, input: z.infer<typeof skillPreviewInput>, previous: Install | null = null) {
    if (this.busy)
      return Promise.reject(
        new SkillError("A skill preview is already running.", 409),
      );
    const work = this.buildPreview(project, input, previous);
    this.activePreview = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  private async buildPreview(
    project: Project,
    input: z.infer<typeof skillPreviewInput>,
    previous: Install | null,
  ) {
    if (this.closed) throw new SkillError("Service is stopping.", 503);
    this.cleanup();
    if (this.previews.size >= 20)
      throw new SkillError(
        "Too many open skill previews. Wait for a preview to expire.",
        409,
      );
    const rootBefore = root(project),
      path = folder(project, input.harness, input.name);
    const parentBefore = parents(project, input.harness).map(maybeIdentity);
    if (previous) this.unchanged(project, previous);
    else if (maybeIdentity(path) !== null)
      throw new SkillError("A skill already exists at this target.", 409);
    const stage = mkdtempSync(join(this.home, "skill-stage-"));
    const stageIdentity = identity(stage);
    this.busy = true;
    try {
      const cliSource =
        this.options.sourceOverride?.(input.source) ?? input.source;
      const stdout = await stageCommand(
        stage,
        cliSource,
        input.name,
        input.harness,
        this.options.timeoutMs ?? 120000,
        this.live,
        this.abort.signal,
      );
      if (this.closed) throw new SkillError("Service is stopping.", 503);
      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new SkillError("Skill CLI returned invalid JSON.", 503);
      }
      const expected = join(stage, subdir(input.harness), "skills", input.name);
      const entry =
        Array.isArray(result) && result.length === 1 ? result[0] : null;
      if (
        !entry ||
        entry.status !== "installed" ||
        entry.name !== input.name ||
        entry.source !== cliSource.split("#")[0] ||
        entry.ref !==
          (cliSource.includes("#") ? cliSource.split("#")[1] : null) ||
        entry.scope !== "project" ||
        entry.mode !== "copy" ||
        JSON.stringify(entry.agents) !==
          JSON.stringify([
            input.harness === "codex" ? "Codex" : "Claude Code",
          ]) ||
        entry.path !== realpathSync(expected)
      )
        throw new SkillError("Skill CLI installed an unexpected target.", 503);
      if (identity(stage) !== stageIdentity)
        throw new SkillError("Staged folder changed.", 409);
      const stageParents = [
        join(stage, subdir(input.harness)),
        join(stage, subdir(input.harness), "skills"),
        expected,
      ].map(identity);
      const files = manifest(expected),
        text = textFile(expected, files);
      if (
        root(project) !== rootBefore ||
        parents(project, input.harness).some(
          (p, i) => maybeIdentity(p) !== parentBefore[i],
        ) ||
        (previous ? !this.matches(project, previous) : maybeIdentity(path) !== null)
      )
        throw new SkillError(
          "Project or skill target changed during preview.",
          409,
        );
      const preview: Preview = {
        id: randomUUID(),
        projectId: project.id,
        harness: input.harness,
        source: input.source,
        name: input.name,
        path,
        root: rootBefore,
        parents: parentBefore,
        files,
        text,
        stage,
        stageIdentity,
        stageParents,
        expires: Date.now() + 600000,
        upstreamHash: typeof entry.hash === "string" ? entry.hash : null,
        previous,
      };
      this.previews.set(preview.id, preview);
      return this.publicPreview(preview);
    } catch (e) {
      rmSync(stage, { recursive: true, force: true });
      throw e;
    } finally {
      this.busy = false;
    }
  }
  private publicPreview(p: Preview) {
    const {
      stage,
      stageIdentity,
      stageParents,
      root,
      parents,
      expires,
      previous,
      ...safe
    } = p;
    return {
      ...safe,
      updateInstallId: previous?.id ?? null,
      hasChanges: previous ? !sameFiles(p.files, previous.files) : true,
      currentText: previous ? textFile(previous.path, previous.files) : null,
      currentFiles: previous?.files.map(({ identity, ...file }) => file) ?? null,
      expiresAt: new Date(expires).toISOString(),
      sourceVersion: p.source.includes("#") ? p.source.split("#")[1] : null,
      installerVersion: "skills@1.7.0",
    };
  }
  private reviewed(project: Project, id: string) {
    if (this.closed) throw new SkillError("Service is stopping.", 503);
    const p = this.previews.get(id);
    if (!p || p.projectId !== project.id || p.expires <= Date.now())
      throw new SkillError("Skill preview expired or was not found.", 404);
    const sourceDir = join(p.stage, subdir(p.harness), "skills", p.name);
    if (
      root(project) !== p.root ||
      identity(p.stage) !== p.stageIdentity ||
      [
        join(p.stage, subdir(p.harness)),
        join(p.stage, subdir(p.harness), "skills"),
        sourceDir,
      ].some((path, i) => identity(path) !== p.stageParents[i]) ||
      parents(project, p.harness).some(
        (path, i) => maybeIdentity(path) !== p.parents[i],
      ) ||
      (p.previous ? !this.matches(project, p.previous) : maybeIdentity(p.path) !== null) ||
      !sameFiles(manifest(sourceDir), p.files)
    )
      throw new SkillError("Reviewed skill or target changed. Preview again.", 409);
    return { p, sourceDir };
  }
  install(project: Project, id: string) {
    const { p, sourceDir } = this.reviewed(project, id);
    if (p.previous) throw new SkillError("Use the update action for this preview.", 409);
    const install: Install = {
      id: randomUUID(),
      projectId: project.id,
      harness: p.harness,
      source: p.source,
      name: p.name,
      path: p.path,
      root: p.root,
      parents: [],
      files: p.files,
      targetIdentity: "",
      state: "prepared",
      message: null,
      upstreamHash: p.upstreamHash,
      createdAt: new Date().toISOString(),
    };
    this.save(install);
    this.previews.delete(id);
    try {
      const dirs = parents(project, p.harness);
      for (const [i, dir] of dirs.entries()) {
        if (p.parents[i] === null) mkdirSync(dir, { mode: 0o700 });
        if (root(project) !== p.root)
          throw new SkillError("Project folder changed.", 409);
        install.parents.push(identity(dir));
      }
      this.save(install);
      mkdirSync(p.path, { mode: 0o700 }); // Exclusive creation prevents overwriting a native skill.
      copyTree(sourceDir, p.path, p.files);
      if (
        !sameFiles(manifest(p.path), p.files) ||
        root(project) !== p.root ||
        dirs.some((dir, i) => identity(dir) !== install.parents[i])
      )
        throw new SkillError("Skill or target changed during install.", 409);
      const fd = openSync(dirs[1], constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      install.targetIdentity = identity(p.path);
      install.files = manifest(p.path, true);
      install.state = "installed";
      this.save(install);
      return this.publicInstall(install);
    } catch (e) {
      install.state = "interrupted";
      install.message =
        "Install interrupted. Inspect the skill folder; no automatic recovery will run.";
      this.save(install);
      if (e instanceof SkillError) throw e;
      throw new SkillError(install.message, 409);
    } finally {
      rmSync(p.stage, { recursive: true, force: true });
    }
  }
  private managed(project: Project, id: string) {
    if (this.closed) throw new SkillError("Service is stopping.", 503);
    const row = this.db
      .prepare("SELECT data FROM project_skills WHERE id=? AND projectId=?")
      .get(id, project.id);
    if (!row) throw new SkillError("Managed skill not found.", 404);
    return JSON.parse(row.data as string) as Install;
  }
  private matches(project: Project, install: Install) {
    try {
      const current = this.managed(project, install.id);
      return current.state === "installed" &&
        current.targetIdentity === install.targetIdentity &&
        install.path === folder(project, install.harness, install.name) &&
        root(project) === install.root &&
        parents(project, install.harness).every((dir, i) => identity(dir) === install.parents[i]) &&
        identity(install.path) === install.targetIdentity &&
        sameFiles(manifest(install.path, true), install.files, true);
    } catch {
      return false;
    }
  }
  private unchanged(project: Project, install: Install) {
    if (!this.matches(project, install))
      throw new SkillError("Skill or project folder changed. AgentKlar will keep it.", 409);
  }
  previewUpdate(project: Project, id: string) {
    const previous = this.managed(project, id);
    this.unchanged(project, previous);
    return this.preview(project, {
      harness: previous.harness, source: previous.source, name: previous.name,
    }, previous);
  }
  update(project: Project, id: string) {
    const { p, sourceDir } = this.reviewed(project, id);
    if (!p.previous) throw new SkillError("Use the install action for this preview.", 409);
    const previous = p.previous;
    this.unchanged(project, previous);
    if (sameFiles(p.files, previous.files)) {
      this.previews.delete(id);
      rmSync(p.stage, { recursive: true, force: true });
      return { ...this.publicInstall(previous), unchanged: true };
    }
    const transaction = mkdtempSync(join(parents(project, p.harness)[0], ".skill-update-"));
    const transactionIdentity = identity(transaction);
    const replacement = join(transaction, "next"), backup = join(transaction, "previous");
    let replacementIdentity = "", moved = false, applied = false, restored = false;
    const recoveryMessage = `Update interrupted. Previous and replacement files may be in ${transaction}. Inspect before making changes.`;
    const install: Install = { ...previous, state: "updating", message: recoveryMessage };
    this.previews.delete(id);
    try {
      mkdirSync(replacement, { mode: 0o700 });
      copyTree(sourceDir, replacement, p.files);
      replacementIdentity = identity(replacement);
      if (!sameFiles(manifest(replacement), p.files))
        throw new SkillError("Replacement skill changed during preparation.", 409);
      this.unchanged(project, previous);
      if (identity(transaction) !== transactionIdentity)
        throw new SkillError("Update folder changed during preparation.", 409);
      this.save(install);
      renameSync(p.path, backup);
      moved = true;
      if (identity(backup) !== previous.targetIdentity || !sameFiles(manifest(backup, true), previous.files, true) || maybeIdentity(p.path) !== null)
        throw new SkillError("Skill target changed during update.", 409);
      renameSync(replacement, p.path);
      applied = true;
      if (identity(p.path) !== replacementIdentity || !sameFiles(manifest(p.path), p.files) || root(project) !== p.root || parents(project, p.harness).some((dir, i) => identity(dir) !== p.parents[i]))
        throw new SkillError("Skill or project changed during update.", 409);
      for (const dir of [transaction, parents(project, p.harness)[1]]) {
        const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      install.state = "installed";
      install.message = null;
      install.files = manifest(p.path, true);
      install.targetIdentity = replacementIdentity;
      install.upstreamHash = p.upstreamHash;
      this.save(install);
      // Only discard the backup if its exact saved tree is still present.
      let backupKept = true;
      try {
        if (identity(transaction) === transactionIdentity && identity(backup) === previous.targetIdentity && sameFiles(manifest(backup, true), previous.files, true)) {
          rmSync(transaction, { recursive: true });
          backupKept = false;
        }
      } catch {}
      if (backupKept) {
        install.message = `Update applied. A changed backup was kept at ${backup}.`;
        this.save(install);
      }
      return this.publicInstall(install);
    } catch {
      try {
        if (identity(transaction) !== transactionIdentity)
          throw new SkillError("Update folder changed. Keep it for inspection.", 409);
        if (applied && identity(p.path) === replacementIdentity && sameFiles(manifest(p.path), p.files)) {
          renameSync(p.path, replacement);
          applied = false;
        }
        if (moved && !applied && maybeIdentity(p.path) === null && identity(backup) === previous.targetIdentity && sameFiles(manifest(backup, true), previous.files, true)) {
          renameSync(backup, p.path);
          restored = true;
        }
        if (!moved || restored) {
          this.save(previous);
          rmSync(transaction, { recursive: true });
        } else {
          install.state = "interrupted";
          install.message = recoveryMessage;
          this.save(install);
        }
      } catch {
        // Keep both trees if rollback cannot prove ownership or finish safely.
        install.state = "interrupted";
        install.message = recoveryMessage;
        try { this.save(install); } catch {}
      }
      throw new SkillError(restored ? "Skill update failed. The previous skill was restored." : !moved ? "Skill update failed before replacing the current skill." : recoveryMessage, 409);
    } finally {
      rmSync(p.stage, { recursive: true, force: true });
    }
  }
  remove(project: Project, id: string) {
    const install = this.managed(project, id);
    this.unchanged(project, install);
    install.state = "removing";
    this.save(install);
    try {
      for (const file of install.files.filter((f) => f.kind === "file"))
        unlinkSync(join(install.path, file.path));
      for (const file of install.files
        .filter((f) => f.kind === "directory")
        .reverse())
        rmdirSync(join(install.path, file.path));
      rmdirSync(install.path);
      install.state = "removed";
      install.message = null;
      this.save(install);
      return this.publicInstall(install);
    } catch {
      install.state = "interrupted";
      install.message =
        "Remove interrupted. Inspect the skill folder; no automatic recovery will run.";
      this.save(install);
      throw new SkillError(install.message, 409);
    }
  }
  private publicInstall({
    root,
    parents,
    files,
    targetIdentity,
    ...safe
  }: Install) {
    return safe;
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.activePreview;
    for (const p of this.previews.values())
      rmSync(p.stage, { recursive: true, force: true });
    this.previews.clear();
  }
}
