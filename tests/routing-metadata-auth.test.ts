import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";

test("routing metadata authenticates before discovery and respects the maintenance gate", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-routing-auth-")));
  const projectPath = join(root, "project"); mkdirSync(projectPath);
  const git = (...args: string[]) => execFileSync("git", ["-C", projectPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init"); git("config", "user.email", "fixture@example.test"); git("config", "user.name", "Fixture");
  writeFileSync(join(projectPath, "file.txt"), "fixture\n"); git("add", "."); git("commit", "-m", "fixture");
  let discoveries = 0;
  const operator = { id: randomUUID(), key: "fixture-operator-key" };
  const service = createService(join(root, "home"), 4333, () => { throw new Error("No worker allowed"); }, null, null,
    async project => { discoveries++; return { projectId: project.id, checkedAt: new Date().toISOString(), harnesses: [] }; }, {}, operator, {}, {}, null, {}, null);
  const project = { id: randomUUID(), name: "Routing auth", path: projectPath, preference: "balanced" as const, roles: [], createdAt: new Date().toISOString() };
  service.store.saveProject(project);
  const route = `/api/projects/${project.id}/routing-metadata`;
  const bearer = { Authorization: `Bearer ${service.bearer}` };
  const request = (path: string, headers: Record<string, string> = {}) => service.app.request(`http://127.0.0.1:4333${path}`, { headers });
  const maintenance = (action: "quiesce" | "resume") => service.app.request(`http://127.0.0.1:4333/api/operator/${action}`, {
    method: "POST", headers: { "x-agentklar-operator-key": operator.key, "x-agentklar-service-id": operator.id, "Content-Type": "application/json" }, body: JSON.stringify({ force: false }),
  });
  try {
    assert.equal((await request(`/api/projects/${randomUUID()}/routing-metadata`)).status, 401);
    assert.equal((await request(route)).status, 401);
    assert.equal((await request(route, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal((await request(route, { ...bearer, Host: "evil.example" })).status, 403);
    assert.equal((await request(route, { ...bearer, Origin: "https://evil.example" })).status, 403);
    assert.equal(discoveries, 0);
    assert.equal((await maintenance("quiesce")).status, 200);
    assert.equal((await request(route, bearer)).status, 503);
    assert.equal(discoveries, 0, "Quiesced metadata must not invoke native discovery");
    assert.equal((await maintenance("resume")).status, 200);
    const response = await request(route, bearer);
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.projectId, project.id);
    assert.equal(metadata.baseCommit, git("rev-parse", "HEAD"));
    assert.deepEqual(metadata.installed, { codex: false, claude: false, muse: false, opencode: false });
    assert.equal(discoveries, 1);
    assert.equal(service.store.runs().length, 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
