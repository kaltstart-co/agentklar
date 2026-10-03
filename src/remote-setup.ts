import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PeerError, sshPeerTransport, type PeerTransport } from "./peers.ts";
import type { Store } from "./store.ts";
import type { NativeSetup } from "./setup.ts";
import type { Project } from "./contracts.ts";
import { setupHarness } from "./onboarding.ts";
import { projectRootIdentity } from "./project-root.ts";
// Relative creation uses the child's captured working directory, so a renamed
// parent cannot redirect the write to a replacement path or symbolic link.
export const remoteCreateScript = `
import { statSync, mkdirSync } from "node:fs";
const [folder, expected] = process.argv.slice(1);
let result;
try {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,119}$/.test(folder)) throw Object.assign(new Error(), {code:"EINVAL"});
  const st = statSync(".", {bigint:true});
  const stamp = "v2:" + st.dev + ":" + st.ino + ":" + st.birthtimeNs;
  if (!st.isDirectory() || st.birthtimeNs <= 0n || stamp !== expected) throw Object.assign(new Error(), {code:"ESTALE"});
  mkdirSync(folder, {mode:0o700});
  result = {ok:true};
} catch (error) {
  result = {ok:false,code:["EEXIST","ESTALE","EINVAL","EACCES","ENOENT","EROFS"].includes(error.code) ? error.code : "EIO"};
}
process.stdout.write(JSON.stringify(result));
`;
function createInParent(
  rootPath: string,
  folderName: string,
  rootStamp: string,
) {
  let result: { ok: boolean; code?: string };
  try {
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", remoteCreateScript, folderName, rootStamp],
      {
        cwd: rootPath,
        timeout: 5000,
        maxBuffer: 2048,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      },
    );
    result = JSON.parse(output);
  } catch {
    throw new PeerError(
      "Could not safely create the folder on its owner.",
      409,
    );
  }
  if (result.ok !== true)
    throw new PeerError(
      result.code === "EEXIST"
        ? "Creation was interrupted before its folder receipt. Inspect this destination on the owner."
        : result.code === "ESTALE"
          ? "Authorized folder changed before creation."
          : "Could not create folder.",
      409,
    );
}
const uuid = z.uuid(),
  token = z.string().regex(/^[0-9a-f]{64}$/),
  path = z
    .string()
    .min(1)
    .max(1000)
    .refine((p) => isAbsolute(p) && !/[\0\r\n]/.test(p));
const deviceSchema = z
  .object({
    id: uuid,
    label: z.string().max(120),
    platform: z.string().max(80),
  })
  .strict();
const launchSchema = z
  .object({
    command: z.string().regex(/^(?:agentklar|\/[a-zA-Z0-9_./ -]{1,500})$/),
    nodePath: path.optional(),
  })
  .strict()
  .refine((v) => !v.nodePath || v.command.startsWith("/"));
export const setupCallSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("hello"), payload: z.object({}).strict() }),
  z.object({
    operation: z.literal("projects"),
    payload: z.object({}).strict(),
  }),
  z.object({
    operation: z.literal("createProject"),
    payload: z
      .object({
        requestId: uuid,
        name: z.string().trim().min(1).max(120),
        folderName: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,119}$/)
          .refine((v) => v !== "." && v !== ".."),
      })
      .strict(),
  }),
  z.object({
    operation: z.literal("setupStatus"),
    payload: z.object({ projectId: uuid, harness: setupHarness }).strict(),
  }),
  z.object({
    operation: z.literal("setupPreview"),
    payload: z.object({ projectId: uuid, harness: setupHarness }).strict(),
  }),
  z.object({
    operation: z.literal("setupApply"),
    payload: z
      .object({ projectId: uuid, harness: setupHarness, previewId: uuid })
      .strict(),
  }),
  z.object({
    operation: z.literal("setupUndo"),
    payload: z
      .object({ projectId: uuid, harness: setupHarness, changeId: uuid })
      .strict(),
  }),
]);
export const setupEnvelopeSchema = z
  .object({
    channel: z.literal("setup"),
    version: z.literal(1),
    sourceDeviceId: uuid,
    targetDeviceId: uuid,
    grantId: uuid,
    token,
    requestId: uuid,
    operation: z.enum([
      "hello",
      "projects",
      "createProject",
      "setupStatus",
      "setupPreview",
      "setupApply",
      "setupUndo",
    ]),
    payload: z.unknown(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      !setupCallSchema.safeParse({ operation: v.operation, payload: v.payload })
        .success
    )
      c.addIssue({ code: "custom", message: "Invalid setup operation." });
  });
export type SetupEnvelope = z.infer<typeof setupEnvelopeSchema>;
type Device = z.infer<typeof deviceSchema>;
type Grant = {
  id: string;
  sourceDeviceId: string;
  rootPath: string;
  rootStamp: string;
  tokenHash: string;
  revoked: boolean;
};
const codeSchema = z
  .object({
    grantId: uuid,
    token,
    device: deviceSchema,
    launch: launchSchema,
    rootPath: path,
    sourceDeviceId: uuid,
  })
  .strict();
type Connection = z.infer<typeof codeSchema> & {
  id: string;
  label: string;
  sshHost: string;
};
type Creation = {
  id: string;
  digest: string;
  grantId: string;
  path: string;
  project: Project;
  state: "reserved" | "created" | "registered";
  stamp?: string;
};
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class RemoteSetup {
  private launch = {
    nodePath: process.execPath,
    command: fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../bin/agentklar.mjs"
          : "../../bin/agentklar.mjs",
        import.meta.url,
      ),
    ),
  };
  constructor(
    private store: Store,
    private device: Device,
    private native: NativeSetup,
    private harnesses: () => unknown,
    private transport: PeerTransport = sshPeerTransport,
    private guard: <T>(
      action: () => Promise<T>,
      write?: boolean,
    ) => Promise<T> = (action) => action(),
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS setup_grants(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS setup_connections(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS setup_creations(id TEXT PRIMARY KEY,data TEXT NOT NULL);",
    );
  }
  private rows<T>(table: string): T[] {
    return this.store.db
      .prepare(`SELECT data FROM ${table}`)
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  private save<T extends { id: string }>(table: string, value: T) {
    this.store.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
  }
  settings() {
    return {
      device: this.device,
      launch: this.launch,
      connections: this.rows<Connection>("setup_connections").map(
        ({ token, ...v }) => v,
      ),
      grants: this.rows<Grant>("setup_grants").map(
        ({ tokenHash, rootStamp, ...v }) => v,
      ),
    };
  }
  grant(input: unknown) {
    const v = z
      .object({ sourceDeviceId: uuid, rootPath: path })
      .strict()
      .parse(input);
    if (v.sourceDeviceId === this.device.id)
      throw new PeerError("Choose another device.");
    const stamp = this.identity(v.rootPath);
    const secret = randomBytes(32).toString("hex"),
      g: Grant = {
        id: randomUUID(),
        ...v,
        rootStamp: stamp,
        tokenHash: hash(secret),
        revoked: false,
      };
    this.save("setup_grants", g);
    return {
      grantId: g.id,
      token: secret,
      device: this.device,
      launch: this.launch,
      rootPath: g.rootPath,
      sourceDeviceId: g.sourceDeviceId,
    };
  }
  revoke(input: unknown) {
    const { grantId } = z.object({ grantId: uuid }).strict().parse(input),
      g = this.rows<Grant>("setup_grants").find((g) => g.id === grantId);
    if (!g) throw new PeerError("Setup grant not found.", 404);
    this.save("setup_grants", { ...g, revoked: true });
    return { ok: true };
  }
  saveConnection(input: unknown) {
    const v = z
      .object({
        label: z.string().trim().min(1).max(120),
        sshHost: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,199}$/),
        code: codeSchema,
      })
      .strict()
      .parse(input);
    if (
      v.code.sourceDeviceId !== this.device.id ||
      v.code.device.id === this.device.id
    )
      throw new PeerError("Setup code belongs to another device.", 409);
    const c = {
      id: randomUUID(),
      label: v.label,
      sshHost: v.sshHost,
      ...v.code,
    };
    this.save("setup_connections", c);
    const { token, ...result } = c;
    return result;
  }
  remove(input: unknown) {
    const { connectionId } = z
      .object({ connectionId: uuid })
      .strict()
      .parse(input);
    this.store.db
      .prepare("DELETE FROM setup_connections WHERE id=?")
      .run(connectionId);
    return { ok: true };
  }
  async call(id: string, input: unknown) {
    const v = setupCallSchema.parse(input),
      c = this.rows<Connection>("setup_connections").find(
        (c) => c.id === uuid.parse(id),
      );
    if (!c) throw new PeerError("Setup connection not found.", 404);
    const request: SetupEnvelope = {
      channel: "setup",
      version: 1,
      sourceDeviceId: this.device.id,
      targetDeviceId: c.device.id,
      grantId: c.grantId,
      token: c.token,
      requestId:
        v.operation === "createProject" ? v.payload.requestId : randomUUID(),
      ...v,
    };
    const reply = await this.transport(
      {
        id: c.id,
        label: c.label,
        deviceId: c.device.id,
        sshHost: c.sshHost,
        ...c.launch,
      },
      request,
    );
    if (reply.status >= 400)
      throw new PeerError(
        (reply.body as { error?: string })?.error || "Owner rejected setup.",
        reply.status,
      );
    const body = reply.body as { device?: Device; rootPath?: string };
    if (body.device?.id !== c.device.id || body.rootPath !== c.rootPath)
      throw new PeerError("Owner identity or authorized folder changed.", 409);
    return body;
  }
  private identity(p: string) {
    try {
      return projectRootIdentity(p);
    } catch {
      throw new PeerError(
        "Folder is unavailable, replaced, or uses a symbolic link.",
        409,
      );
    }
  }
  private within(g: Grant, p: string) {
    if (this.identity(g.rootPath) !== g.rootStamp)
      throw new PeerError("Authorized folder changed.", 409);
    const r = relative(g.rootPath, p);
    if (!r || r === ".." || r.startsWith(".." + sep) || isAbsolute(r))
      throw new PeerError("Project is outside the authorized folder.", 403);
    this.identity(p);
    let current = g.rootPath;
    for (const segment of r.split(sep)) {
      current = join(current, segment);
      if (
        lstatSync(current).isSymbolicLink() ||
        realpathSync(current) !== current
      )
        throw new PeerError("Project path uses a symbolic link.", 403);
    }
  }
  async owner(input: unknown) {
    const e = setupEnvelopeSchema.parse(input);
    if (e.targetDeviceId !== this.device.id)
      throw new PeerError("Wrong owner device.", 409);
    const g = this.rows<Grant>("setup_grants").find((g) => g.id === e.grantId);
    if (
      !g ||
      g.revoked ||
      g.sourceDeviceId !== e.sourceDeviceId ||
      !timingSafeEqual(Buffer.from(g.tokenHash), Buffer.from(hash(e.token)))
    )
      throw new PeerError(
        "Setup grant is missing, revoked or does not match.",
        403,
      );
    if (this.identity(g.rootPath) !== g.rootStamp)
      throw new PeerError("Authorized folder changed.", 409);
    const v = setupCallSchema.parse({
      operation: e.operation,
      payload: e.payload,
    });
    let result: unknown;
    if (v.operation === "hello")
      result = { version: 1, harnesses: this.harnesses() };
    else if (v.operation === "projects")
      result = {
        projects: this.store
          .projects()
          .filter((p) => {
            try {
              this.within(g, p.path);
              return true;
            } catch {
              return false;
            }
          })
          .slice(0, 100),
      };
    else if (v.operation === "createProject") {
      if (e.requestId !== v.payload.requestId)
        throw new PeerError("Creation request IDs must match.");
      result = this.create(g, v.payload);
    } else {
      const p = this.store.projects().find((p) => p.id === v.payload.projectId);
      if (!p) throw new PeerError("Project not found.", 404);
      this.within(g, p.path);
      result = await this.guard<unknown>(
        () =>
          v.operation === "setupStatus"
            ? this.native.status(p, v.payload.harness)
            : v.operation === "setupPreview"
              ? this.native.preview(p, v.payload.harness)
              : v.operation === "setupApply"
                ? this.native.apply(p, v.payload.harness, v.payload.previewId)
                : this.native.undo(p, v.payload.harness, v.payload.changeId),
        v.operation === "setupApply" || v.operation === "setupUndo",
      );
    }
    return {
      status: 200,
      body: {
        ...(result as object),
        device: this.device,
        rootPath: g.rootPath,
      },
    };
  }
  private create(
    g: Grant,
    v: { requestId: string; name: string; folderName: string },
  ) {
    const id = `${g.sourceDeviceId}:${v.requestId}`,
      digest = hash({ grantId: g.id, ...v });
    let c = this.rows<Creation>("setup_creations").find((c) => c.id === id);
    if (c && c.digest !== digest)
      throw new PeerError(
        "Creation request already has different inputs.",
        409,
      );
    if (!c) {
      const destination = join(g.rootPath, v.folderName);
      try {
        lstatSync(destination);
        throw new PeerError("Destination already exists.", 409);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      c = {
        id,
        digest,
        grantId: g.id,
        path: destination,
        project: {
          id: randomUUID(),
          name: v.name,
          path: destination,
          preference: "balanced",
          roles: [],
          createdAt: new Date().toISOString(),
        },
        state: "reserved",
      };
      this.save("setup_creations", c);
    }
    if (c.state === "reserved") {
      createInParent(g.rootPath, v.folderName, g.rootStamp);
      if (this.identity(g.rootPath) !== g.rootStamp)
        throw new PeerError(
          "Authorized folder changed during creation. Inspect the original folder on the owner.",
          409,
        );
      c = { ...c, state: "created", stamp: this.identity(c.path) };
      this.save("setup_creations", c);
    }
    this.within(g, c.path);
    if (this.identity(c.path) !== c.stamp)
      throw new PeerError("Created folder was replaced.", 409);
    if (c.state === "created") {
      try {
        this.store.saveProject(c.project);
      } catch {
        throw new PeerError(
          "Folder was created but registration failed. Retry the same request ID to recover.",
          409,
        );
      }
      c = { ...c, state: "registered" };
      this.save("setup_creations", c);
    }
    return { requestId: v.requestId, state: c.state, project: c.project };
  }
}
