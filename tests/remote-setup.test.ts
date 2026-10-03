import { execFileSync } from "node:child_process";
import { projectRootIdentity } from "../src/project-root.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.ts";
import { RemoteSetup, remoteCreateScript } from "../src/remote-setup.ts";
import { createService } from "../src/service.ts";
import type { NativeSetup } from "../src/setup.ts";

test("setup grants isolate identity, scope, replay and registration recovery", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "remote-setup-"))),
    root = join(dir, "projects");
  mkdirSync(root);
  const store = new Store(join(dir, "state.sqlite"));
  const device = { id: randomUUID(), label: "Owner", platform: "darwin" },
    sourceDeviceId = randomUUID();
  let previews = 0;
  const native = {
    status: async () => ({ status: "available" }),
    preview: async () => {
      previews++;
      return { id: randomUUID() };
    },
    apply: async () => {
      throw new Error("stale preview");
    },
    undo: async () => ({ state: "undone" }),
  } as unknown as NativeSetup;
  const setup = new RemoteSetup(store, device, native, () => []);
  const grant = setup.grant({ sourceDeviceId, rootPath: root });
  const request = (operation: string, payload: unknown, fields = {}) => ({
    channel: "setup",
    version: 1,
    sourceDeviceId,
    targetDeviceId: device.id,
    grantId: grant.grantId,
    token: grant.token,
    requestId:
      operation === "createProject"
        ? (payload as { requestId: string }).requestId
        : randomUUID(),
    operation,
    payload,
    ...fields,
  });
  try {
    await assert.rejects(
      setup.owner(request("hello", {}, { targetDeviceId: randomUUID() })),
      /Wrong owner/,
    );
    await assert.rejects(
      setup.owner(request("hello", {}, { token: "0".repeat(64) })),
      /grant/,
    );
    await assert.rejects(setup.owner(request("start", {})), /Invalid/);
    const payload = { requestId: randomUUID(), name: "New", folderName: "new" },
      first = await setup.owner(request("createProject", payload)),
      second = await setup.owner(request("createProject", payload));
    assert.deepEqual(first, second);
    assert.equal(store.projects().length, 1);
    await assert.rejects(
      setup.owner(request("createProject", { ...payload, name: "changed" })),
      /different inputs/,
    );
    await assert.rejects(
      setup.owner(
        request("createProject", { ...payload, requestId: randomUUID() }),
      ),
      /already exists/,
    );
    const project = (first.body as unknown as { project: { id: string } })
      .project;
    await setup.owner(
      request("setupPreview", { projectId: project.id, harness: "codex" }),
    );
    assert.equal(previews, 1);
    await assert.rejects(
      setup.owner(
        request("setupApply", {
          projectId: project.id,
          harness: "codex",
          previewId: randomUUID(),
        }),
      ),
      /stale/,
    );
    const saved = store.saveProject.bind(store);
    let fail = true;
    store.saveProject = (p) => {
      if (fail) {
        fail = false;
        throw new Error("fixture registration failure");
      }
      saved(p);
    };
    const recovery = {
      requestId: randomUUID(),
      name: "Recover",
      folderName: "recover",
    };
    await assert.rejects(
      setup.owner(request("createProject", recovery)),
      /registration failed/,
    );
    const recovered = await setup.owner(request("createProject", recovery));
    assert.equal(
      (recovered.body as unknown as { state: string }).state,
      "registered",
    );
    assert.equal(store.projects().length, 2);
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "linked"));
    await assert.rejects(
      setup.owner(
        request("createProject", {
          requestId: randomUUID(),
          name: "Unsafe",
          folderName: "linked",
        }),
      ),
      /exists/,
    );
    assert.throws(
      () => setup.grant({ sourceDeviceId, rootPath: join(root, "linked") }),
      /symbolic link/,
    );
    const other = {
      id: randomUUID(),
      name: "Outside",
      path: outside,
      preference: "balanced" as const,
      roles: [],
      createdAt: "now",
    };
    store.saveProject(other);
    await assert.rejects(
      setup.owner(
        request("setupPreview", { projectId: other.id, harness: "codex" }),
      ),
      /outside/,
    );
    const listed = await setup.owner(request("projects", {}));
    assert.equal(
      (listed.body as unknown as { projects: { id: string }[] }).projects.some(
        (p) => p.id === other.id,
      ),
      false,
    );
    setup.revoke({ grantId: grant.grantId });
    await assert.rejects(setup.owner(request("hello", {})), /revoked/);
    const replacement = setup.grant({ sourceDeviceId, rootPath: root });
    renameSync(root, join(dir, "old"));
    mkdirSync(root);
    await assert.rejects(
      setup.owner(
        request(
          "hello",
          {},
          { grantId: replacement.grantId, token: replacement.token },
        ),
      ),
      /changed/,
    );
    assert.ok(!JSON.stringify(setup.settings()).includes(grant.token));
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote setup GUI rejects bearer, absent Origin and mixed auth; owner requires bridge bearer", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "remote-setup-auth-"))),
    port = 33000 + Math.floor(Math.random() * 1000),
    service = createService(
      join(dir, "home"),
      port,
      () => {
        throw new Error("no inference");
      },
      null,
      null,
    );
  try {
    const setup = await service.app.request(service.setupUrl),
      cookie = setup.headers.get("set-cookie")!.split(";")[0],
      url = `http://127.0.0.1:${port}/api/remote-settings`;
    for (const headers of [
      { Authorization: `Bearer ${service.bearer}` },
      { Cookie: cookie },
      { Cookie: cookie, Origin: "https://evil.example" },
      {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${port}`,
        Authorization: "Bearer invalid",
      },
    ] as Record<string, string>[])
      assert.equal((await service.app.request(url, { headers })).status, 403);
    assert.equal(
      (
        await service.app.request(url, {
          headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await service.app.request(`http://127.0.0.1:${port}/api/peer-setup`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saved setup connection retries a lost creation acknowledgement with one owner project", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "remote-setup-retry-"))),
    root = join(dir, "root");
  mkdirSync(root);
  const a = new Store(join(dir, "a.sqlite")),
    b = new Store(join(dir, "b.sqlite")),
    source = { id: randomUUID(), label: "Source", platform: "darwin" },
    device = { id: randomUUID(), label: "Owner", platform: "darwin" },
    native = {} as NativeSetup,
    owner = new RemoteSetup(b, device, native, () => []);
  let lost = true,
    wrong = false;
  const sourceSetup = new RemoteSetup(
    a,
    source,
    native,
    () => [],
    async (_, request) => {
      const reply = await owner.owner(request);
      if (lost) {
        lost = false;
        throw new Error("Lost acknowledgement");
      }
      if (wrong) return { ...reply, body: { ...reply.body, device: source } };
      return reply;
    },
  );
  try {
    const code = owner.grant({ sourceDeviceId: source.id, rootPath: root }),
      connection = sourceSetup.saveConnection({
        label: "Owner",
        sshHost: "fixture",
        code,
      }),
      payload = {
        operation: "createProject",
        payload: { requestId: randomUUID(), name: "Once", folderName: "once" },
      };
    await assert.rejects(sourceSetup.call(connection.id, payload), /Lost/);
    assert.equal(b.projects().length, 1);
    const result = await sourceSetup.call(connection.id, payload);
    assert.equal(
      (result as unknown as { project: { id: string } }).project.id,
      b.projects()[0].id,
    );
    assert.equal(b.projects().length, 1);
    wrong = true;
    await assert.rejects(
      sourceSetup.call(connection.id, { operation: "hello", payload: {} }),
      /identity/,
    );
    assert.ok(!JSON.stringify(sourceSetup.settings()).includes(code.token));
  } finally {
    a.db.close();
    b.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creation helper keeps its captured parent when its pathname becomes a symlink", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "remote-parent-race-")));
  const root = join(dir, "root"),
    original = join(dir, "original"),
    outside = join(dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const stamp = projectRootIdentity(root);
  const race = `const fixtureFs = await import("node:fs"); fixtureFs.renameSync(${JSON.stringify(root)},${JSON.stringify(original)}); fixtureFs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(root)});
`;
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        race + remoteCreateScript,
        "created",
        stamp,
      ],
      {
        cwd: root,
        timeout: 5000,
        maxBuffer: 2048,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      },
    );
    assert.deepEqual(JSON.parse(output), { ok: true });
    assert.equal(existsSync(join(original, "created")), true);
    assert.equal(existsSync(join(outside, "created")), false);
    const rejected = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", remoteCreateScript, "rejected", stamp],
      {
        cwd: root,
        timeout: 5000,
        maxBuffer: 2048,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      },
    );
    assert.deepEqual(JSON.parse(rejected), { ok: false, code: "ESTALE" });
    assert.equal(existsSync(join(outside, "rejected")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
