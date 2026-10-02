import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-package-smoke-")));
const prefix = join(temp, "prefix"), foreign = join(temp, "unrelated-cwd"), home = join(temp, "service-home");
mkdirSync(foreign);
let server, client, setup, db;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || result.error}`);
  return result.stdout.trim();
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function ready(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Installed service exited before health check passed.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Installed service did not become ready within 15 seconds.");
}

try {
  const packOutput = run("npm", ["pack", "--json", "--pack-destination", temp]);
  const pack = JSON.parse(packOutput.slice(packOutput.lastIndexOf("\n[\n") + 1));
  assert.equal(pack.length, 1);
  assert.ok(pack[0].files.every(({ path }) => path === "package.json" || path === "README.md" || path === "LICENSE" || path === "THIRD_PARTY_NOTICES.md" || path === "skills/agentklar-workflow/SKILL.md" || path.startsWith("bin/") || path.startsWith("dist/")));
  const tarball = join(temp, `agentklar-${version}.tgz`);
  assert.ok(existsSync(tarball));
  run("npm", ["install", "-g", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], foreign);
  const cli = join(prefix, "bin", "agentklar");
  const packageDir = join(prefix, "lib", "node_modules", "agentklar");
  assert.ok(existsSync(cli));
  assert.match(readFileSync(join(packageDir, "THIRD_PARTY_NOTICES.md"), "utf8"), /LiveBench/);
  assert.equal(readFileSync(join(packageDir, "skills/agentklar-workflow/SKILL.md"), "utf8"), readFileSync(new URL("../skills/agentklar-workflow/SKILL.md", import.meta.url), "utf8"));
  assert.ok(!existsSync(join(packageDir, "node_modules", "tsx")));
  assert.ok(!existsSync(join(packageDir, "node_modules", "vite")));
  assert.equal(run(cli, ["--version"], foreign), version);
  assert.match(run(cli, ["--help"], foreign), /agentklar start/);

  const port = await freePort();
  const env = { ...process.env, AGENTKLAR_HOME: home, AGENTKLAR_PORT: String(port) };
  server = spawn(cli, ["start"], { cwd: foreign, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream.resume();
  await ready(port);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html/);
  const asset = html.match(/src="([^"]+\.js)"/);
  assert.ok(asset, "Built UI script is missing");
  assert.equal((await fetch(`http://127.0.0.1:${port}${asset[1]}`)).status, 200);

  const { NativeSetup } = await import(pathToFileURL(join(packageDir, "dist", "server", "setup.js")).href);
  db = new DatabaseSync(":memory:");
  setup = new NativeSetup(db, home, port, { codex: null, claude: null });
  assert.deepEqual(setup.entry.args, [join(packageDir, "dist", "server", "mcp.js")]);
  assert.equal(setup.entry.command, process.execPath);
  client = new Client({ name: "package-smoke", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: setup.entry.command, args: setup.entry.args, env: { ...env, ...setup.entry.env }, stderr: "pipe" }));
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "projects_list"));
  assert.ok(tools.tools.some((tool) => tool.name === "project_runs_list"));
  const response = await client.callTool({ name: "projects_list", arguments: {} });
  assert.equal(response.isError, false);
  assert.deepEqual(JSON.parse(response.content[0].text), []);
  const registered = await client.callTool({ name: "project_register", arguments: { name: "smoke", path: foreign } });
  assert.equal(registered.isError, false);
  const project = JSON.parse(registered.content[0].text);
  const runs = await client.callTool({ name: "project_runs_list", arguments: { projectId: project.id } });
  assert.equal(runs.isError, false);
  assert.deepEqual(JSON.parse(runs.content[0].text), { projectId: project.id, runs: [], nextCursor: null, hasMore: false });
  const leadStatus = await client.callTool({ name: "project_lead", arguments: { projectId: project.id, action: "status" } });
  assert.equal(leadStatus.isError, false);
  assert.equal(JSON.parse(leadStatus.content[0].text).lead, null);
  const leadClaim = await client.callTool({ name: "project_lead", arguments: { projectId: project.id, action: "claim" } });
  assert.equal(leadClaim.isError, false);
  const claimed = JSON.parse(leadClaim.content[0].text).lead;
  assert.equal(claimed.clientName, "package-smoke");
  const leadRelease = await client.callTool({ name: "project_lead", arguments: { projectId: project.id, action: "release", observedClaimId: claimed.claimId } });
  assert.equal(leadRelease.isError, false);
  assert.equal(JSON.parse(leadRelease.content[0].text).lead, null);
  console.log(`Package smoke passed: ${version}, built UI, installed MCP bridge, ${tools.tools.length} tools.`);
} finally {
  if (client) await client.close().catch(() => {});
  if (setup) await setup.close();
  if (db) db.close();
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  rmSync(temp, { recursive: true, force: true });
}
