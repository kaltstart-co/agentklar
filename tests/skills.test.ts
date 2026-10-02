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
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/service.ts";

async function fixture(timeoutMs = 10000, stagedSkill?: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-skills-"));
  const home = join(dir, "home");
  const userHome = join(dir, "user-home");
  const project = join(dir, "project");
  const source = join(dir, "source");
  mkdirSync(project);
  mkdirSync(userHome);
  mkdirSync(source);
  if (!stagedSkill) mkdirSync(join(source, "references"));
  writeFileSync(
    join(source, "SKILL.md"),
    stagedSkill ?? "---\nname: agentklar-qa\ndescription: Test skill.\n---\n\n# Test\nReview me.\n",
  );
  if (!stagedSkill) writeFileSync(join(source, "references", "example.md"), "example\n");
  const requestedSources: string[] = [];
  const sourceOverride = (requested: string) => { requestedSources.push(requested); return source; };
  let service = createService(
    home,
    4317,
    () => ({ stop() {} }),
    null,
    null,
    undefined,
    {},
    undefined,
    { sourceOverride, timeoutMs, userHome },
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
    userHome,
    project,
    source,
    requestedSources,
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
        { sourceOverride, timeoutMs, userHome },
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
test("the shipped AgentKlar workflow skill stages through the existing reviewed installer", async () => {
  const skill = readFileSync(new URL("../skills/agentklar-workflow/SKILL.md", import.meta.url), "utf8");
  const f = await fixture(10000, skill);
  try {
    const source = "kaltstart-co/agentklar#v0.1.0-beta.17";
    const response = await f.call(`${f.base}/preview`, "POST", { harness: "codex", source, name: "agentklar-workflow" });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.text, skill);
    assert.equal(preview.sourceVersion, "v0.1.0-beta.17");
    assert.deepEqual(preview.files.map((file: { path: string }) => file.path), ["SKILL.md"]);
    assert.deepEqual(f.requestedSources, [source]);
    const installed = await (await f.call(`${f.base}/install`, "POST", { previewId: preview.id })).json();
    assert.equal(readFileSync(join(f.project, ".agents", "skills", "agentklar-workflow", "SKILL.md"), "utf8"), skill);
    assert.equal((await f.call(`${f.base}/remove`, "POST", { installId: installed.id })).status, 200);
  } finally { await f.close(); }
});

test("personal skills have one durable owner across projects and keep scope-specific previews", async () => {
  const f = await fixture();
  try {
    const personal = "/api/skills";
    const input = { harness: "codex", source: "example/skills#main", name: "agentklar-qa" };
    const globalPreview = await (await f.call(`${personal}/preview`, "POST", input)).json();
    assert.equal(globalPreview.path, join(realpathSync(f.userHome), ".agents/skills/agentklar-qa"));
    assert.equal((await f.call(`${f.base}/install`, "POST", { previewId: globalPreview.id })).status, 404);
    const global = await (await f.call(`${personal}/install`, "POST", { previewId: globalPreview.id })).json();
    const projectPreview = await f.preview();
    assert.equal((await f.call(`${personal}/install`, "POST", { previewId: projectPreview.id })).status, 404);
    const local = await (await f.call(`${f.base}/install`, "POST", { previewId: projectPreview.id })).json();
    const claudePreview = await (await f.call(`${personal}/preview`, "POST", { ...input, harness: "claude" })).json();
    assert.equal(claudePreview.path, join(realpathSync(f.userHome), ".claude/skills/agentklar-qa"));
    const claude = await (await f.call(`${personal}/install`, "POST", { previewId: claudePreview.id })).json();
    const other = await (await f.call("/api/projects", "POST", { name: "other", path: f.source })).json();
    assert.equal((await (await f.call(`/api/projects/${other.id}/skills`)).json()).skills.some((x: { id: string }) => x.id === global.id), false);
    await f.restart();
    const globalList = await (await f.call(personal)).json();
    assert.equal(globalList.scope, "personal");
    assert.equal(globalList.projectId, undefined);
    assert.equal(globalList.skills.filter((x: { state: string }) => x.state === "installed").length, 2);
    assert.equal((await f.call(`${f.base}/remove`, "POST", { installId: global.id })).status, 404);
    assert.equal((await f.call(`${personal}/remove`, "POST", { installId: local.id })).status, 404);
    writeFileSync(join(f.source, "SKILL.md"), globalPreview.text.replace("Review me.", "Updated upstream."));
    const update = await (await f.call(`${personal}/preview-update`, "POST", { installId: global.id })).json();
    assert.equal(update.updateInstallId, global.id);
    assert.equal((await (await f.call(`${personal}/update`, "POST", { previewId: update.id })).json()).id, global.id);
    assert.match(readFileSync(join(globalPreview.path, "SKILL.md"), "utf8"), /Updated upstream/);
    assert.match(readFileSync(join(projectPreview.path, "SKILL.md"), "utf8"), /Review me/);
    assert.match(readFileSync(join(claudePreview.path, "SKILL.md"), "utf8"), /Review me/);
    assert.equal((await f.call(`${personal}/remove`, "POST", { installId: global.id })).status, 200);
    assert.equal((await f.call(`${personal}/remove`, "POST", { installId: claude.id })).status, 200);
    assert.equal(lstatMissing(globalPreview.path), true);
    assert.equal(lstatMissing(claudePreview.path), true);
    assert.equal(lstatMissing(projectPreview.path), false);
  } finally { await f.close(); }
});

test("personal skill API protects preview text, user-home targets and external edits", async () => {
  const f = await fixture();
  try {
    const base = "/api/skills";
    const input = { harness: "codex", source: "example/skills", name: "agentklar-qa" };
    const bearer = { Authorization: `Bearer ${f.service.bearer}`, Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" };
    assert.equal((await f.call(base, "GET", undefined, {})).status, 401);
    assert.equal((await f.call(`${base}/preview`, "POST", input, bearer)).status, 403);
    assert.equal((await f.call(`${base}/preview`, "POST", { ...input, path: f.project })).status, 400);
    const preview = await (await f.call(`${base}/preview`, "POST", input)).json();
    assert.doesNotMatch(await (await f.call(base, "GET", undefined, bearer)).text(), /Review me/);
    assert.equal((await f.call(`${base}/install`, "POST", { previewId: preview.id }, bearer)).status, 403);
    const installed = await (await f.call(`${base}/install`, "POST", { previewId: preview.id })).json();
    writeFileSync(join(preview.path, "SKILL.md"), "edited outside AgentKlar");
    assert.equal((await f.call(`${base}/preview-update`, "POST", { installId: installed.id })).status, 409);
    assert.equal((await f.call(`${base}/remove`, "POST", { installId: installed.id })).status, 409);
    assert.equal(readFileSync(join(preview.path, "SKILL.md"), "utf8"), "edited outside AgentKlar");
    const outside = join(f.dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.userHome, ".claude"));
    assert.equal((await f.call(`${base}/preview`, "POST", { ...input, harness: "claude" })).status, 409);
    assert.equal(readdirSync(outside).length, 0);
  } finally { await f.close(); }
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
    for (const operation of ["preview", "preview-update", "install", "update", "remove"])
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


test("skill updates re-stage the saved source, preview both trees, and keep durable per-harness ownership", async () => {
  const f = await fixture();
  try {
    const original = await (await f.call(`${f.base}/preview`, "POST", {
      harness: "codex", source: "example/skills#main", name: "agentklar-qa",
    })).json();
    const installed = await (await f.call(`${f.base}/install`, "POST", { previewId: original.id })).json();
    const currentIdentity = lstatSync(original.path).ino;
    const unchanged = await (await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id })).json();
    assert.equal(unchanged.hasChanges, false);
    assert.equal((await (await f.call(`${f.base}/update`, "POST", { previewId: unchanged.id })).json()).unchanged, true);
    assert.equal(lstatSync(original.path).ino, currentIdentity);
    const claude = await f.preview("claude");
    await f.call(`${f.base}/install`, "POST", { previewId: claude.id });
    writeFileSync(join(f.source, "SKILL.md"), original.text.replace("Review me.", "Updated upstream."));
    rmSync(join(f.source, "references"), { recursive: true });
    writeFileSync(join(f.source, "extra.txt"), "upstream file");
    const response = await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id });
    assert.equal(response.status, 200, await response.clone().text());
    const update = await response.json();
    assert.equal(f.requestedSources.at(-1), "example/skills#main");
    assert.equal(update.source, installed.source);
    assert.equal(update.updateInstallId, installed.id);
    assert.equal(update.currentText, original.text);
    assert.deepEqual(update.currentFiles.map((x: { path: string }) => x.path), ["SKILL.md", "references", "references/example.md"]);
    assert.match(update.text, /Updated upstream/);
    assert.equal(readFileSync(join(original.path, "SKILL.md"), "utf8"), original.text);
    assert.equal((await f.call(`${f.base}/install`, "POST", { previewId: update.id })).status, 409);
    const stale = await (await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id })).json();
    const applied = await f.call(`${f.base}/update`, "POST", { previewId: update.id });
    assert.equal(applied.status, 200, await applied.clone().text());
    assert.equal((await applied.json()).id, installed.id);
    assert.equal(readFileSync(join(original.path, "SKILL.md"), "utf8"), update.text);
    assert.equal(lstatMissing(join(original.path, "references")), true);
    assert.equal(readFileSync(join(original.path, "extra.txt"), "utf8"), "upstream file");
    assert.equal(readFileSync(join(claude.path, "SKILL.md"), "utf8"), original.text);
    assert.equal((await f.call(`${f.base}/update`, "POST", { previewId: stale.id })).status, 409);
    assert.equal((await f.call(`${f.base}/update`, "POST", { previewId: update.id })).status, 404);
    await f.restart();
    const list = await (await f.call(f.base)).json();
    assert.equal(list.skills.find((s: { id: string }) => s.id === installed.id).state, "installed");
    assert.equal((await f.call(`${f.base}/remove`, "POST", { installId: installed.id })).status, 200);
    assert.equal(lstatMissing(original.path), true);
    assert.equal(lstatMissing(claude.path), false);
    assert.equal(readdirSync(join(f.project, ".agents")).some(x => x.startsWith(".skill-update-")), false);
  } finally { await f.close(); }
});

test("skill update refuses local edits, changed staging, wrong project and changed source fields", async () => {
  const f = await fixture();
  try {
    const original = await f.preview();
    assert.equal((await f.call(`${f.base}/update`, "POST", { previewId: original.id })).status, 409);
    const installed = await (await f.call(`${f.base}/install`, "POST", { previewId: original.id })).json();
    assert.equal((await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id, source: "other/repo" })).status, 400);
    const other = await (await f.call("/api/projects", "POST", { name: "other", path: f.source })).json();
    assert.equal((await f.call(`/api/projects/${other.id}/skills/preview-update`, "POST", { installId: installed.id })).status, 404);
    const update = await (await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id })).json();
    const staged = readdirSync(f.home).find(name => name.startsWith("skill-stage-"))!;
    writeFileSync(join(f.home, staged, ".agents/skills/agentklar-qa/SKILL.md"), "changed stage");
    assert.equal((await f.call(`${f.base}/update`, "POST", { previewId: update.id })).status, 409);
    assert.equal(readFileSync(join(original.path, "SKILL.md"), "utf8"), original.text);
    const next = await (await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id })).json();
    writeFileSync(join(original.path, "SKILL.md"), "local changes");
    assert.equal((await f.call(`${f.base}/update`, "POST", { previewId: next.id })).status, 409);
    assert.equal((await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id })).status, 409);
    assert.equal(readFileSync(join(original.path, "SKILL.md"), "utf8"), "local changes");
    const listed = await (await f.call(f.base)).json();
    assert.equal(listed.skills[0].state, "changed");
    assert.match(listed.skills[0].message, /Update and remove are disabled/);
  } finally { await f.close(); }
});

test("skill update rolls back a failed durable save and preserves conflicting files with a recovery path", async () => {
  const f = await fixture();
  try {
    const original = await f.preview();
    const installed = await (await f.call(`${f.base}/install`, "POST", { previewId: original.id })).json();
    writeFileSync(join(f.source, "SKILL.md"), original.text.replace("Review me.", "Updated upstream."));
    const update = await (await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id })).json();
    f.service.store.db.exec(`CREATE TRIGGER reject_skill_update BEFORE UPDATE ON project_skills
      WHEN json_extract(NEW.data, '$.state')='installed' AND json_extract(NEW.data, '$.files[0].hash') != json_extract(OLD.data, '$.files[0].hash')
      BEGIN SELECT RAISE(ABORT, 'fixture durable save failure'); END`);
    const response = await f.call(`${f.base}/update`, "POST", { previewId: update.id });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /previous skill was restored/);
    assert.equal(readFileSync(join(original.path, "SKILL.md"), "utf8"), original.text);
    assert.equal((await (await f.call(f.base)).json()).skills[0].state, "installed");
    assert.equal(readdirSync(join(f.project, ".agents")).some(x => x.startsWith(".skill-update-")), false);
    f.service.store.db.exec("DROP TRIGGER reject_skill_update");
    const conflict = await (await f.call(`${f.base}/preview-update`, "POST", { installId: installed.id })).json();
    f.service.store.db.function("fixture_edit_skill", () => {
      writeFileSync(join(original.path, "SKILL.md"), "concurrent user edit");
      throw new Error("fixture durable save failure after edit");
    });
    f.service.store.db.exec(`CREATE TRIGGER edit_skill_update BEFORE UPDATE ON project_skills
      WHEN json_extract(NEW.data, '$.state')='installed' AND json_extract(NEW.data, '$.files[0].hash') != json_extract(OLD.data, '$.files[0].hash')
      BEGIN SELECT fixture_edit_skill(); END`);
    const failed = await f.call(`${f.base}/update`, "POST", { previewId: conflict.id });
    assert.equal(failed.status, 409);
    assert.match((await failed.json()).error, /Previous and replacement files may be in/);
    assert.equal(readFileSync(join(original.path, "SKILL.md"), "utf8"), "concurrent user edit");
    const kept = readdirSync(join(f.project, ".agents")).find(x => x.startsWith(".skill-update-"))!;
    assert.equal(readFileSync(join(f.project, ".agents", kept, "previous/SKILL.md"), "utf8"), original.text);
    f.service.store.db.exec("DROP TRIGGER edit_skill_update");
    await f.restart();
    const listed = await (await f.call(f.base)).json();
    assert.equal(listed.skills[0].state, "interrupted");
    assert.match(listed.skills[0].message, new RegExp(kept.replaceAll(".", "\\.")));
    assert.equal((await f.call(`${f.base}/remove`, "POST", { installId: installed.id })).status, 409);
    assert.equal(readFileSync(join(original.path, "SKILL.md"), "utf8"), "concurrent user edit");
  } finally { await f.close(); }
});
