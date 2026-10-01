import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/service.ts";

async function fixture(timeoutMs = 10000) {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-skills-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  const source = join(dir, "source");
  mkdirSync(project);
  mkdirSync(source);
  mkdirSync(join(source, "references"));
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: agentklar-qa\ndescription: Test skill.\n---\n\n# Test\nReview me.\n",
  );
  writeFileSync(join(source, "references", "example.md"), "example\n");
  let service = createService(
    home,
    4317,
    () => ({ stop() {} }),
    null,
    null,
    undefined,
    {},
    undefined,
    { sourceOverride: () => source, timeoutMs },
  );
  let cookie = "";
  async function auth() {
    cookie = (await service.app.request(service.setupUrl)).headers
      .get("set-cookie")!
      .split(";")[0];
  }
  await auth();
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {
      Cookie: cookie,
      Origin: "http://127.0.0.1:4317",
      "Content-Type": "application/json",
    },
  ) =>
    service.app.request(`http://127.0.0.1:4317${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const p = await (
    await call("/api/projects", "POST", { name: "skill test", path: project })
  ).json();
  const base = `/api/projects/${p.id}/skills`;
  const preview = async (harness = "codex") => {
    const response = await call(`${base}/preview`, "POST", {
      harness,
      source: "example/skills",
      name: "agentklar-qa",
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return {
    dir,
    home,
    project,
    source,
    p,
    base,
    call,
    preview,
    get service() {
      return service;
    },
    restart: async () => {
      await service.close();
      service = createService(
        home,
        4317,
        () => ({ stop() {} }),
        null,
        null,
        undefined,
        {},
        undefined,
        { sourceOverride: () => source, timeoutMs },
      );
      await auth();
    },
    close: async () => {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("project skills stage exact CLI bytes, install separately by harness, survive restart and remove owned files", async () => {
  const f = await fixture();
  try {
    const first = await f.preview();
    assert.equal(first.path, join(f.p.path, ".agents/skills/agentklar-qa"));
    assert.match(first.text, /Review me/);
    assert.deepEqual(
      first.files.map((x: { path: string }) => x.path),
      ["SKILL.md", "references", "references/example.md"],
    );
    assert.equal(first.installerVersion, "skills@1.7.0");
    assert.equal(lstatMissing(first.path), true);
    const result = await f.call(`${f.base}/install`, "POST", {
      previewId: first.id,
    });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(
      readFileSync(join(first.path, "SKILL.md"), "utf8"),
      first.text,
    );
    const claude = await f.preview("claude");
    assert.equal(claude.path, join(f.p.path, ".claude/skills/agentklar-qa"));
    assert.equal(
      (await f.call(`${f.base}/install`, "POST", { previewId: claude.id }))
        .status,
      200,
    );
    await f.restart();
    const list = await (await f.call(f.base)).json();
    assert.equal(
      list.skills.filter((x: { state: string }) => x.state === "installed")
        .length,
      2,
    );
    for (const skill of list.skills)
      assert.equal(
        (await f.call(`${f.base}/remove`, "POST", { installId: skill.id }))
          .status,
        200,
      );
    assert.equal(lstatMissing(first.path), true);
    assert.equal(lstatMissing(claude.path), true);
    assert.equal(
      (
        await f.call(`${f.base}/remove`, "POST", {
          installId: list.skills[0].id,
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
function lstatMissing(path: string) {
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
}

test("skill previews refuse changed stage, existing native folders and external edits", async () => {
  const f = await fixture();
  try {
    const stage = await f.preview();
    // Stage is private, but a local writer can still race it. The install must detect changed bytes.
    const staged = readdirSync(f.home).find((name) =>
      name.startsWith("skill-stage-"),
    )!;
    writeFileSync(
      join(f.home, staged, ".agents/skills/agentklar-qa/SKILL.md"),
      "changed",
    );
    assert.equal(
      (await f.call(`${f.base}/install`, "POST", { previewId: stage.id }))
        .status,
      409,
    );
    assert.equal(lstatMissing(stage.path), true);
    const next = await f.preview();
    mkdirSync(join(f.project, ".agents"));
    mkdirSync(join(f.project, ".agents/skills"));
    mkdirSync(next.path);
    assert.equal(
      (await f.call(`${f.base}/install`, "POST", { previewId: next.id }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.call(`${f.base}/preview`, "POST", {
          harness: "codex",
          source: "example/skills",
          name: "agentklar-qa",
        })
      ).status,
      409,
    );
    rmSync(next.path, { recursive: true });
    const install = await f.preview();
    const installed = await (
      await f.call(`${f.base}/install`, "POST", { previewId: install.id })
    ).json();
    writeFileSync(join(install.path, "SKILL.md"), "external edit");
    assert.equal(
      (await f.call(`${f.base}/remove`, "POST", { installId: installed.id }))
        .status,
      409,
    );
    assert.equal(
      readFileSync(join(install.path, "SKILL.md"), "utf8"),
      "external edit",
    );
  } finally {
    await f.close();
  }
});

test("skill API limits native writes to trusted UI and rejects invalid sources and paths", async () => {
  const f = await fixture();
  try {
    const bearer = {
      Authorization: `Bearer ${f.service.bearer}`,
      Origin: "http://127.0.0.1:4317",
      "Content-Type": "application/json",
    };
    assert.equal((await f.call(f.base, "GET", undefined, bearer)).status, 200);
    for (const operation of ["preview", "install", "remove"])
      assert.equal(
        (await f.call(`${f.base}/${operation}`, "POST", {}, bearer)).status,
        403,
      );
    assert.equal(
      (
        await f.call(
          `${f.base}/preview`,
          "POST",
          {},
          { Cookie: "invalid", Origin: "http://127.0.0.1:4317" },
        )
      ).status,
      401,
    );
    for (const source of [
      "https://github.com/a/b",
      "../repo",
      "a/b;sh",
      "a/b#../main",
      "a/b#main//other",
    ])
      assert.equal(
        (
          await f.call(`${f.base}/preview`, "POST", {
            harness: "codex",
            source,
            name: "agentklar-qa",
          })
        ).status,
        400,
      );
    for (const name of ["../other", "synced", "anthropic-skills-test", "A B"])
      assert.equal(
        (
          await f.call(`${f.base}/preview`, "POST", {
            harness: "claude",
            source: "example/skills",
            name,
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await f.call(`${f.base}/preview`, "POST", {
          harness: "codex",
          source: "example/skills",
          name: "agentklar-qa",
          path: "/tmp/oops",
        })
      ).status,
      400,
    );
    const external = join(f.project, ".agents/skills/external");
    mkdirSync(join(f.project, ".agents/skills"), { recursive: true });
    mkdirSync(external);
    const list = await (await f.call(f.base)).json();
    assert.equal(list.skills[0].state, "external");
    assert.equal(list.skills[0].id, null);
    const outside = join(f.dir, "outside");
    mkdirSync(outside);
    rmSync(join(f.project, ".agents/skills"), { recursive: true });
    symlinkSync(outside, join(f.project, ".agents/skills"));
    assert.equal(
      (
        await f.call(`${f.base}/preview`, "POST", {
          harness: "codex",
          source: "example/skills",
          name: "agentklar-qa",
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("skill staging timeout and service shutdown leave no staged folders", async () => {
  const timed = await fixture(1);
  try {
    const response = await timed.call(`${timed.base}/preview`, "POST", {
      harness: "codex",
      source: "example/skills",
      name: "agentklar-qa",
    });
    assert.equal(response.status, 503);
    assert.equal(
      readdirSync(timed.home).some((name) => name.startsWith("skill-stage-")),
      false,
    );
  } finally {
    await timed.close();
  }
  const stopped = await fixture();
  try {
    const pending = stopped.call(`${stopped.base}/preview`, "POST", {
      harness: "codex",
      source: "example/skills",
      name: "agentklar-qa",
    });
    await stopped.service.close();
    assert.equal((await pending).status, 503);
    assert.equal(
      readdirSync(stopped.home).some((name) => name.startsWith("skill-stage-")),
      false,
    );
  } finally {
    await stopped.close();
  }
});

test("staged links and plugin bundles cannot be installed", async () => {
  const f = await fixture();
  try {
    const preview = await f.preview();
    const staged = readdirSync(f.home).find((name) =>
      name.startsWith("skill-stage-"),
    )!;
    const target = join(f.home, staged, ".agents/skills/agentklar-qa");
    mkdirSync(join(target, ".claude-plugin"));
    assert.equal(
      (await f.call(`${f.base}/install`, "POST", { previewId: preview.id }))
        .status,
      422,
    );
    rmSync(join(target, ".claude-plugin"), { recursive: true });
    symlinkSync(f.source, join(target, "linked"));
    assert.equal(
      (await f.call(`${f.base}/install`, "POST", { previewId: preview.id }))
        .status,
      422,
    );
    assert.equal(lstatMissing(preview.path), true);
  } finally {
    await f.close();
  }
});
