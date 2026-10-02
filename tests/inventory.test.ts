import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { nativeInventory } from "../src/inventory.ts";
import { createService } from "../src/service.ts";
const write = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-inventory-")));
  const home = join(dir, "user"), project = join(dir, "project"), codex = join(dir, "custom-codex"), claude = join(dir, "custom-claude"), xdg = join(dir, "custom-xdg");
  for (const path of [home, project, codex, claude, xdg]) mkdirSync(path);
  return { dir, home, project, codex, claude, xdg, env: { HOME: home, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, XDG_CONFIG_HOME: xdg }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test("native inventory reports only source metadata and allowlisted cache names using custom homes", () => {
  const f = fixture();
  try {
    const secret = "PRIVATE_CONFIG_TOKEN_SHOULD_NEVER_APPEAR";
    const config = join(f.codex, "config.toml"), settings = join(f.claude, "settings.json"), mcp = join(f.project, ".mcp.json");
    const manifest = join(f.codex, "plugins/cache/market/sample/1.2.3/.codex-plugin/plugin.json");
    const portable = join(f.claude, "plugins/cache/market/claude-sample/2.0.0/.claude-plugin/plugin.json");
    write(config, `[mcp_servers.private]\ncommand="${secret}"\n`); write(settings, JSON.stringify({ env: { TOKEN: secret }, accountId: secret })); write(mcp, JSON.stringify({ mcpServers: { private: { command: secret } } }));
    write(manifest, JSON.stringify({ name: "sample", version: "1.2.3", command: secret, description: secret, env: { TOKEN: secret }, accountId: secret }));
    write(portable, JSON.stringify({ name: "claude-sample", version: "2.0.0", credentials: secret }));
    write(join(f.project, ".claude-plugin/plugin.json"), JSON.stringify({ name: "project-plugin", version: "0.1", description: secret }));
    write(join(f.project, ".mcp.json"), secret); // Presence works even for unparseable native config.
    write(join(f.xdg, "opencode/opencode.jsonc"), `// ${secret}`);
    const snapshots = [config, settings, mcp, manifest, portable].map(path => ({ path, hash: createHash("sha256").update(readFileSync(path)).digest("hex"), mtime: statSync(path).mtimeMs }));
    const result = nativeInventory(randomUUID(), f.project, { env: f.env });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.equal(result.activationUnknown, true);
    const codex = result.harnesses.find(g => g.harness === "codex")!;
    assert.deepEqual(codex.extensions.map(e => [e.name, e.version, e.evidence]), [["sample", "1.2.3", "cached-package"]]);
    assert.equal(codex.sources.find(s => s.path === config)!.inspection, "metadata");
    assert.equal(codex.sources.find(s => s.path === config)!.status, "present");
    assert.equal(result.harnesses.find(g => g.harness === "muse")!.sources.some(s => s.path === mcp && s.status === "present"), true);
    assert.equal(result.harnesses.find(g => g.harness === "claude")!.extensions.length, 2);
    assert.equal(result.harnesses.flatMap(g => g.extensions).every(e => e.activationUnknown), true);
    for (const before of snapshots) { assert.equal(createHash("sha256").update(readFileSync(before.path)).digest("hex"), before.hash); assert.equal(statSync(before.path).mtimeMs, before.mtime); }
    const defaults = nativeInventory(randomUUID(), f.project, { env: {}, userHome: f.home });
    assert.equal(defaults.harnesses[0].sources[0].path, join(f.home, ".codex/config.toml"));
    assert.equal(defaults.harnesses[1].sources[0].path, join(f.home, ".claude/settings.json"));
    const relative = nativeInventory(randomUUID(), f.project, { env: { ...f.env, CODEX_HOME: "relative", CLAUDE_CONFIG_DIR: "relative", XDG_CONFIG_HOME: "relative" } });
    assert.equal(relative.harnesses[0].sources[0].path, null);
    assert.equal(relative.harnesses[0].sources[0].status, "unsupported");
  } finally { f.cleanup(); }
});
test("inventory refuses symlinks, FIFOs, oversized or changing manifests and bounds cache traversal", () => {
  const f = fixture();
  try {
    const unsafe = join(f.dir, "unsafe"), hidden = join(f.dir, "hidden"); mkdirSync(hidden); symlinkSync(hidden, unsafe);
    write(join(hidden, "config.toml"), "secret");
    const fifo = join(f.project, ".mcp.json"); execFileSync("mkfifo", [fifo]);
    const oversize = join(f.codex, "plugins/cache/market/large/1/plugin.json"); write(oversize, "x".repeat(32769));
    const changing = join(f.project, ".claude-plugin/plugin.json"); write(changing, JSON.stringify({ name: "changing", version: "1" }));
    const result = nativeInventory(randomUUID(), f.project, { env: f.env, beforeRead: path => { if (path === changing) writeFileSync(path, JSON.stringify({ name: "changed", version: "200" })); } });
    assert.equal(result.harnesses.find(g => g.harness === "claude")!.sources.find(s => s.path === changing)!.status, "changed");
    assert.equal(result.harnesses.find(g => g.harness === "claude")!.sources.find(s => s.path === fifo)!.status, "unsafe");
    assert.equal(result.harnesses[0].sources.some(s => s.status === "oversized"), true);
    const linked = nativeInventory(randomUUID(), f.project, { env: { ...f.env, CODEX_HOME: unsafe } });
    assert.equal(linked.harnesses[0].sources[0].status, "unsafe");
    for (let i = 0; i < 100; i++) write(join(f.codex, `plugins/cache/many/plugin-${i}/1/plugin.json`), JSON.stringify({ name: `plugin-${i}`, version: "1", env: { SECRET: "must-not-appear" } }));
    write(join(f.codex, "plugins/cache/many/node_modules/1/plugin.json"), JSON.stringify({ name: "forbidden-node-modules", version: "1" }));
    const bounded = nativeInventory(randomUUID(), f.project, { env: f.env });
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.harnesses[0].extensionsTruncated, true);
    assert.ok(bounded.harnesses.flatMap(g => g.extensions).length <= 24);
    assert.ok(bounded.harnesses.flatMap(g => g.sources).length <= 40);
    assert.ok(JSON.stringify(bounded).length <= 22000);
    assert.doesNotMatch(JSON.stringify(bounded), /must-not-appear|forbidden-node-modules/);
  } finally { f.cleanup(); }
});
test("authenticated project inventory route uses service environment without a CLI or worker", async () => {
  const f = fixture(); const home = join(f.dir, "agentklar"); let launches = 0;
  const service = createService(home, 4317, () => { launches++; throw new Error("No worker should start"); }, null, null, undefined, { env: f.env });
  const req = (path: string, headers: Record<string, string> = { Authorization: `Bearer ${service.bearer}` }) => service.app.request(`http://127.0.0.1:4317${path}`, { headers });
  try {
    const registered = await service.app.request("http://127.0.0.1:4317/api/projects", { method: "POST", headers: { Authorization: `Bearer ${service.bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "inventory", path: f.project }) });
    const project = await registered.json(); const path = `/api/projects/${project.id}/native-inventory`;
    assert.equal((await req(path, {})).status, 401);
    assert.equal((await req(path, { Authorization: `Bearer ${service.bearer}`, Origin: "https://evil.example" })).status, 403);
    assert.equal((await req("/api/projects/bad/native-inventory")).status, 400);
    assert.equal((await req(`/api/projects/${randomUUID()}/native-inventory`)).status, 404);
    assert.equal((await req(path + "?raw=true")).status, 400);
    const response = await req(path); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json(); assert.equal(result.projectId, project.id); assert.equal(result.harnesses[0].sources[0].path, join(f.codex, "config.toml"));
    assert.equal(launches, 0); assert.equal(service.store.runs().length, 0);
  } finally { await service.close(); f.cleanup(); }
});
