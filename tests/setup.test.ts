import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync, linkSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createService } from "../src/service.ts";
import { nativeSetupCommand } from "../src/setup.ts";
import { parse as parseJsonc } from "jsonc-parser";

async function fixture(port = 4317, homeName = "agentklar home") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-setup-test-")));
  const home = join(dir, homeName), codex = join(dir, "codex home"), claude = join(dir, "claude home"), xdg = join(dir, "xdg home"), project = join(dir, "project with spaces ' $()"), userHome = join(dir, "user home"), managed = join(dir, "managed");
  for (const path of [home, codex, claude, xdg, project, userHome, managed]) mkdirSync(path);
  const command = join(dir, "native cli.mjs"), mode = join(dir, "mode"), calls = join(dir, "calls");
  writeFileSync(mode, "");
  writeFileSync(command, `#!${process.execPath}\n` + String.raw`
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), cwd = process.cwd(), mode = readFileSync(process.env.SETUP_MODE,'utf8');
const codexFile = join(process.env.CODEX_HOME,'config.toml'), claudeFile = join(process.env.CLAUDE_CONFIG_DIR,'.claude.json');
function read(path) { return existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : {}; }
function save(path,data) { writeFileSync(path,JSON.stringify(data)); }
function stall() { const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(process.env.SETUP_MODE+'.pids',JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000); }
function secretFail() { process.stderr.write('NATIVE_PRIVATE_SECRET'); process.exit(1); }
if(args[0]==='app-server') {
 let input=''; process.stdin.on('data',data=> {input+=data;let n;while((n=input.indexOf('\n'))!==-1){const r=JSON.parse(input.slice(0,n));input=input.slice(n+1); if(r.method) appendFileSync(process.env.SETUP_CALLS,r.method+'\n');
 if(r.method==='initialize') process.stdout.write(JSON.stringify({id:r.id,result:{}})+'\n');
 if(r.method==='config/read') {
  if(mode==='readDelay') {stall();continue;}
  if(mode==='readFail') {process.stdout.write(JSON.stringify({id:r.id,error:{message:'NATIVE_PRIVATE_SECRET'}})+'\n');continue;}
  const projectFile=join(cwd,'.codex','config.toml');
  const layers=[{name:{type:'user',file:codexFile,profile:null},version:createHash('sha256').update(JSON.stringify(read(codexFile))).digest('hex'),config:read(codexFile)}];
  if(existsSync(projectFile)) layers.unshift({name:{type:'project',dotCodexFolder:join(cwd,'.codex')},version:createHash('sha256').update(JSON.stringify(read(projectFile))).digest('hex'),config:read(projectFile)});
  process.stdout.write(JSON.stringify({id:r.id,result:{layers,config:read(codexFile),origins:{}}})+'\n');
 }
 }});
} else {
 appendFileSync(process.env.SETUP_CALLS,JSON.stringify({args,cwd})+'\n');
 const isCodex=!args.includes('--scope'), file=isCodex?codexFile:claudeFile;
 if(mode==='timeout') stall();
 else if(mode==='overflow') {process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000);}
 else if(mode==='addFailBefore'||mode==='undoFailBefore') secretFail();
 else {
 const config=read(file);
 let servers;
 if(isCodex) servers=config.mcp_servers??={};
 else {config.projects??={};config.projects[cwd]??={};servers=config.projects[cwd].mcpServers??={};}
 if(args[1]==='add') {
 if(!isCodex && Object.hasOwn(servers,'agentklar')) secretFail();
 const split=args.indexOf('--'), env={};for(let i=0;i<split;i++)if(args[i]==='--env'){const assignment=args[++i],eq=assignment.indexOf('=');env[assignment.slice(0,eq)]=assignment.slice(eq+1);}
 servers.agentklar={...(isCodex?{}:{type:'stdio'}),command:args[split+1],args:args.slice(split+2),env};
 } else if(args[1]==='remove') delete servers.agentklar;
 else secretFail();
 save(file,config);
 if(mode==='addFailAfter'||mode==='undoFailAfter') secretFail();
 }
}
`, { mode: 0o700 });
  let starts = 0;
  const nativeEnv: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, XDG_CONFIG_HOME: xdg, OPENCODE_TEST_MANAGED_CONFIG_DIR: managed, SETUP_MODE: mode, SETUP_CALLS: calls };
  let currentPort = port;
  let service = createService(home, currentPort, () => { starts++; return { stop() {} }; }, command, command, undefined, { env: nativeEnv, timeoutMs: 1200 }, undefined, {}, {}, command, {}, command);
  let cookie = "";
  async function auth() { const response = await service.app.request(service.setupUrl); cookie = response.headers.get("set-cookie")!.split(";")[0]; }
  await auth();
  const headers = () => ({ Cookie: cookie, Origin: `http://127.0.0.1:${currentPort}`, "Content-Type": "application/json" });
  const call = (path: string, method = "GET", body?: unknown, authHeaders: Record<string,string> = headers()) => service.app.request(`http://127.0.0.1:${currentPort}${path}`, { method, headers: authHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const p = await (await call("/api/projects", "POST", { name: "setup test", path: project })).json();
  const base = (harness = "codex") => `/api/projects/${p.id}/setup/${harness}`;
  const preview = async (harness = "codex") => (await call(`${base(harness)}/preview`, "POST", {})).json();
  const apply = async (id: string, harness = "codex") => call(`${base(harness)}/apply`, "POST", { previewId: id });
  return { dir, home, codex, claude, xdg, userHome, managed, nativeEnv, project, p, command, mode, calls, base, call, preview, apply, get service() { return service; }, get cookie() { return cookie; }, get starts() { return starts; }, restart: async (nextPort = port) => { await service.close(); currentPort = nextPort; service = createService(home, currentPort, () => { starts++; return { stop() {} }; }, command, command, undefined, { env: nativeEnv, timeoutMs: 1200 }, undefined, {}, {}, command, {}, command); await auth(); }, cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function config(path: string) { return JSON.parse(readFileSync(path,"utf8")); }
test("OpenCode setup preserves JSONC, uses its native entry, and undoes after restart", async () => {
  const f = await fixture();
  try {
    const folder = join(f.xdg, "opencode"), file = join(folder, "opencode.jsonc"); mkdirSync(folder);
    const source = '{\n  // Keep this provider setting\n  "provider": {"apiKey":"{env:NATIVE_PRIVATE_SECRET}"},\n  "mcp": {"other":{"type":"remote","url":"https://example.test"}},\n}\n';
    writeFileSync(file, source, { mode: 0o640 });
    const before = await (await f.call(f.base("opencode"))).json(); assert.equal(before.status, "missing");
    const preview = await f.preview("opencode");
    assert.equal(preview.configPath, file); assert.equal(preview.command, null);
    assert.equal(preview.entry.type, "local"); assert.equal(preview.entry.command[0], process.execPath);
    assert.deepEqual(preview.entry.environment, { AGENTKLAR_HOME: f.home, AGENTKLAR_PORT: "4317" });
    assert.equal(JSON.stringify(preview).includes("NATIVE_PRIVATE_SECRET"), false);
    const applied = await (await f.apply(preview.id, "opencode")).json(); assert.equal(applied.state, "applied");
    const changed = readFileSync(file, "utf8"); assert.match(changed, /Keep this provider setting/);
    assert.equal(parseJsonc(changed).provider.apiKey, "{env:NATIVE_PRIVATE_SECRET}");
    assert.deepEqual(parseJsonc(changed).mcp.agentklar, preview.entry);
    assert.equal(statSync(file).mode & 0o777, 0o640);
    await f.restart();
    assert.equal((await (await f.call(f.base("opencode"))).json()).canUndo, true);
    assert.equal((await f.call(`${f.base("opencode")}/undo`, "POST", { changeId: applied.id })).status, 200);
    const undone = readFileSync(file, "utf8");
    assert.match(undone, /Keep this provider setting/);
    assert.equal(parseJsonc(undone).mcp.other.url, "https://example.test");
    assert.equal(parseJsonc(undone).mcp.agentklar, undefined);
    assert.equal(existsSync(f.calls), false);
  } finally { await f.cleanup(); }
});
test("OpenCode setup creates a private user file and rejects changed entries, previews and unsafe paths", async () => {
  const f = await fixture();
  try {
    const folder = join(f.xdg, "opencode"), file = join(folder, "opencode.json");
    const preview = await f.preview("opencode"); assert.equal(preview.configPath, file);
    const applied = await (await f.apply(preview.id, "opencode")).json(); assert.equal(applied.state, "applied");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(config(file).$schema, "https://opencode.ai/config.json");
    const edited = config(file); edited.mcp.agentklar.environment.EXTRA = "changed"; writeFileSync(file, JSON.stringify(edited));
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "conflict");
    assert.equal((await f.call(`${f.base("opencode")}/undo`, "POST", { changeId: applied.id })).status, 409);
    rmSync(file); const stale = await f.preview("opencode");
    writeFileSync(file, '{}'); assert.equal((await f.apply(stale.id, "opencode")).status, 409);
    rmSync(file); symlinkSync(join(f.dir, "elsewhere"), file);
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "unavailable");
    rmSync(file); writeFileSync(file, '{}'); linkSync(file, join(f.dir, "hardlink"));
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "unavailable");
    const linkedHome = join(f.dir, "linked config home"); symlinkSync(f.xdg, linkedHome, "dir");
    f.nativeEnv.XDG_CONFIG_HOME = linkedHome; await f.restart();
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "unavailable");
    assert.equal((await f.call(`${f.base("opencode")}/preview`, "POST", {}, { Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" })).status, 401);
  } finally { await f.cleanup(); }
});
test("OpenCode setup checks project, ancestor, custom and managed layers without native commands", async () => {
  const f = await fixture();
  try {
    const foreign = '{"mcp":{"agentklar":{"type":"local","command":["foreign"]}}}';
    const parent = join(f.dir, "opencode.jsonc"); writeFileSync(parent, foreign);
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "conflict");
    rmSync(parent); const preview = await f.preview("opencode");
    const global = join(f.xdg, "opencode", "config.json"); mkdirSync(dirname(global)); writeFileSync(global, foreign);
    assert.equal((await f.apply(preview.id, "opencode")).status, 409);
    rmSync(global);
    const fresh = await f.preview("opencode");
    const projectFile = join(f.project, ".opencode", "opencode.json"); mkdirSync(dirname(projectFile)); writeFileSync(projectFile, foreign);
    assert.equal((await f.apply(fresh.id, "opencode")).status, 409);
    rmSync(projectFile); writeFileSync(join(f.managed, "opencode.jsonc"), foreign);
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "conflict");
    rmSync(join(f.managed, "opencode.jsonc"));
    f.nativeEnv.OPENCODE_CONFIG_CONTENT = foreign; await f.restart();
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "conflict");
    delete f.nativeEnv.OPENCODE_CONFIG_CONTENT;
    const custom = join(f.dir, "custom.jsonc"); writeFileSync(custom, foreign); f.nativeEnv.OPENCODE_CONFIG = custom; await f.restart();
    assert.equal((await (await f.call(f.base("opencode"))).json()).status, "conflict");
    assert.equal(existsSync(f.calls), false);
  } finally { await f.cleanup(); }
});
test("OpenCode setup refuses ambiguous MCP expansion and generated native paths", async () => {
  const f = await fixture();
  try {
    const folder = join(f.xdg, "opencode"), file = join(folder, "opencode.jsonc"); mkdirSync(folder);
    for (const text of ['{"m{env:X}p":{}}', '{"mcp":{"agentklar":{"command":["{file:secret}"]}}}', '{"mcp":{"agentklar":{}} , "mcp":{}}']) {
      writeFileSync(file, text);
      assert.equal((await (await f.call(f.base("opencode"))).json()).status, "unavailable");
    }
  } finally { await f.cleanup(); }
  const pathFixture = await fixture(4317, "home {env:BAD}");
  try { assert.equal((await (await pathFixture.call(pathFixture.base("opencode"))).json()).status, "unavailable"); }
  finally { await pathFixture.cleanup(); }
});
test("Muse setup writes only its user MCP entry and restores other settings after restart", async () => {
  const f = await fixture();
  try {
    const file = join(f.xdg, "muse", "settings.json"); mkdirSync(join(f.xdg, "muse"));
    const original = { schema_version: 1, modes: { custom: { description: "NATIVE_PRIVATE_SECRET" } }, mcpServers: { other: { type: "stdio", command: "/bin/true", args: [] } } };
    writeFileSync(file, JSON.stringify(original), { mode: 0o660 }); chmodSync(file, 0o660);
    const before = await (await f.call(f.base("muse"))).json(); assert.equal(before.status, "missing"); assert.equal(before.scope, "User");
    const preview = await f.preview("muse"); assert.equal(preview.command, null); assert.equal(preview.cwd, null); assert.equal(preview.configPath, file);
    assert.equal(JSON.stringify(preview).includes("NATIVE_PRIVATE_SECRET"), false);
    const applied = await (await f.apply(preview.id, "muse")).json(); assert.equal(applied.state, "applied");
    assert.deepEqual(config(file).modes, original.modes); assert.deepEqual(config(file).mcpServers.other, original.mcpServers.other);
    assert.deepEqual(config(file).mcpServers.agentklar, preview.entry); assert.equal(statSync(file).mode & 0o777, 0o660);
    assert.equal((await (await f.call(f.base("muse"))).json()).canUndo, true);
    await f.restart();
    assert.equal((await f.call(`${f.base("muse")}/undo`, "POST", { changeId: applied.id })).status, 200);
    assert.deepEqual(config(file), original); assert.equal(statSync(file).mode & 0o777, 0o660);
    assert.equal(existsSync(f.calls), false);
    assert.equal(JSON.stringify(f.service.store.db.prepare("SELECT data FROM native_setup_changes").all()).includes("NATIVE_PRIVATE_SECRET"), false);
  } finally { await f.cleanup(); }
});
test("Muse setup creates private settings and refuses old schemas and foreign entries", async () => {
  const f = await fixture();
  try {
    const file = join(f.xdg, "muse", "settings.json");
    const applied = await (await f.apply((await f.preview("muse")).id, "muse")).json();
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(config(file).schema_version, 1);
    assert.equal((await f.call(`${f.base("muse")}/undo`, "POST", { changeId: applied.id })).status, 200);
    for (const body of [{ mcpServers: {} }, { schema_version: 1, mcp_servers: {} }, { schema_version: 2 }, { schema_version: 1, mcpServers: [] }]) {
      writeFileSync(file, JSON.stringify(body));
      assert.equal((await (await f.call(f.base("muse"))).json()).status, "unavailable");
      assert.equal((await f.call(`${f.base("muse")}/preview`, "POST", {})).status, 422);
    }
    writeFileSync(file, JSON.stringify({ schema_version: 1, mcpServers: { agentklar: { type: "stdio", command: "foreign", args: [], env: {} } } }));
    assert.equal((await (await f.call(f.base("muse"))).json()).status, "conflict");
    assert.equal((await f.call(`${f.base("muse")}/preview`, "POST", {})).status, 409);
  } finally { await f.cleanup(); }
});
test("Muse undo removes its unchanged saved entry after the service port changes", async () => {
  const f = await fixture();
  try {
    const file = join(f.xdg, "muse", "settings.json");
    const applied = await (await f.apply((await f.preview("muse")).id, "muse")).json();
    assert.equal(config(file).mcpServers.agentklar.env.AGENTKLAR_PORT, "4317");
    await f.restart(4318);
    const status = await (await f.call(f.base("muse"))).json();
    assert.equal(status.canUndo, true);
    assert.equal((await f.call(`${f.base("muse")}/undo`, "POST", { changeId: applied.id })).status, 200);
    assert.equal(Object.hasOwn(config(file).mcpServers, "agentklar"), false);
  } finally { await f.cleanup(); }
});
test("Muse setup rejects stale settings, project overrides and unsafe files", async () => {
  const f = await fixture();
  try {
    const folder = join(f.xdg, "muse"), file = join(folder, "settings.json"); mkdirSync(folder);
    const first = await f.preview("muse"); writeFileSync(file, JSON.stringify({ schema_version: 1, unrelated: true }));
    assert.equal((await f.apply(first.id, "muse")).status, 409);
    mkdirSync(join(f.dir, ".git"));
    const second = await f.preview("muse");
    writeFileSync(join(f.dir, ".mcp.json"), JSON.stringify({ mcpServers: { agentklar: { type: "stdio", command: "foreign" } } }));
    assert.equal((await f.apply(second.id, "muse")).status, 409);
    assert.equal((await (await f.call(f.base("muse"))).json()).status, "conflict");
    mkdirSync(join(f.project, ".git"));
    assert.equal((await (await f.call(f.base("muse"))).json()).status, "missing");
    const third = await f.preview("muse"); const applied = await (await f.apply(third.id, "muse")).json();
    const settings = config(file); settings.mcpServers.agentklar.env.EXTRA = "foreign"; writeFileSync(file, JSON.stringify(settings));
    assert.equal((await (await f.call(f.base("muse"))).json()).canUndo, false);
    assert.equal((await f.call(`${f.base("muse")}/undo`, "POST", { changeId: applied.id })).status, 409);
    rmSync(file); symlinkSync(join(f.dir, ".mcp.json"), file);
    assert.equal((await (await f.call(f.base("muse"))).json()).status, "unavailable");
    rmSync(file); writeFileSync(file, JSON.stringify({ schema_version: 1 })); linkSync(file, join(f.dir, "hardlinked-settings"));
    assert.equal((await (await f.call(f.base("muse"))).json()).status, "unavailable");
  } finally { await f.cleanup(); }
});
test("Muse setup rejects a replaced settings folder before creating a missing file", async () => {
  const f = await fixture();
  try {
    const folder = join(f.xdg, "muse"); mkdirSync(folder);
    const preview = await f.preview("muse");
    rmSync(folder, { recursive: true }); mkdirSync(folder);
    assert.equal((await f.apply(preview.id, "muse")).status, 409);
    assert.equal(existsSync(join(folder, "settings.json")), false);
  } finally { await f.cleanup(); }
});
test("Muse setup rejects data paths that Muse would expand as environment variables", async () => {
  const f = await fixture(4317, "agentklar ${HOME}");
  try {
    assert.equal((await (await f.call(f.base("muse"))).json()).status, "unavailable");
    assert.equal((await f.call(`${f.base("muse")}/preview`, "POST", {})).status, 422);
    assert.equal(existsSync(join(f.xdg, "muse", "settings.json")), false);
  } finally { await f.cleanup(); }
});
test("Muse setup leaves bounded input unchanged when formatted output would exceed 2 MiB", async () => {
  const f = await fixture();
  try {
    const folder = join(f.xdg, "muse"), file = join(folder, "settings.json"); mkdirSync(folder);
    const original = JSON.stringify({ schema_version: 1, dense: Array(300000).fill(0) });
    assert.ok(Buffer.byteLength(original) < 2 * 1024 * 1024);
    writeFileSync(file, original);
    const preview = await f.preview("muse");
    assert.equal((await f.apply(preview.id, "muse")).status, 503);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(readdirSync(folder), ["settings.json"]);
    assert.equal(Object.hasOwn(config(file), "mcpServers"), false);
  } finally { await f.cleanup(); }
});
test("native setup previews exact absolute bridge argv, installs per harness and undoes only owned entry after restart", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.codex, "config.toml"), JSON.stringify({ model: "sentinel", private: "NATIVE_PRIVATE_SECRET" }));
    writeFileSync(join(f.claude, ".claude.json"), JSON.stringify({ global: "sentinel", private: "NATIVE_PRIVATE_SECRET" }));
    for (const harness of ["codex", "claude"]) {
      const status = await (await f.call(f.base(harness))).json(); assert.equal(status.status,"missing"); assert.equal(status.canUndo,false);
      const preview = await f.preview(harness); assert.equal(preview.entry.command,process.execPath); assert.equal(preview.entry.args[0],"--import"); assert.ok(preview.entry.args[1].startsWith("/")); assert.ok(preview.entry.args[2].endsWith("/src/mcp.ts"));
      assert.deepEqual(preview.entry.env,{AGENTKLAR_HOME:f.home,AGENTKLAR_PORT:"4317"}); assert.equal(preview.scope,harness==="codex"?"User":"Local project"); assert.equal(preview.cwd,harness==="codex"?null:f.project);
      assert.equal(JSON.stringify(preview).includes("NATIVE_PRIVATE_SECRET"),false); assert.equal(JSON.stringify(preview).includes(f.service.bearer),false);
      const applied = await (await f.apply(preview.id,harness)).json(); assert.equal(applied.state,"applied");
      const added = await (await f.call(f.base(harness))).json(); assert.equal(added.status,"configured"); assert.equal(added.canUndo,true); assert.match(added.message,/Start or restart/);
      assert.equal((await f.apply(preview.id,harness)).status,404); assert.equal((await f.call(`${f.base(harness)}/preview`,"POST",{})).status,409);
      await f.restart();
      assert.equal((await f.call(`${f.base(harness)}/undo`,"POST",{changeId:applied.id})).status,200);
      assert.equal((await f.call(`${f.base(harness)}/undo`,"POST",{changeId:applied.id})).status,409);
      assert.equal((await (await f.call(f.base(harness))).json()).status,"missing");
    }
    assert.equal(config(join(f.codex,"config.toml")).model,"sentinel"); assert.equal(config(join(f.claude,".claude.json")).global,"sentinel");
    assert.equal(f.starts,0); assert.equal(f.service.store.runs().length,0);
    const calls = readFileSync(f.calls,"utf8").split("\n"); assert.ok(calls.includes("config/read")); assert.ok(!calls.some(x=>/thread\/|turn\//.test(x)));
    const saved = f.service.store.db.prepare("SELECT data FROM native_setup_changes").all(); assert.equal(JSON.stringify(saved).includes("NATIVE_PRIVATE_SECRET"),false);
  } finally { await f.cleanup(); }
});
test("the exact generated bridge launches by absolute argv and speaks real MCP on a custom service home and port", async () => {
  const probe=createServer(); await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));
  const port=(probe.address() as {port:number}).port; await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const f=await fixture(port);
  const http=serve({fetch:f.service.app.fetch,hostname:"127.0.0.1",port});
  const client=new Client({name:"setup-bridge-test",version:"1.0.0"});
  try {
    const preview=await f.preview(); assert.equal(preview.entry.env.AGENTKLAR_PORT,String(port)); assert.equal(preview.entry.env.AGENTKLAR_HOME,f.home);
    await client.connect(new StdioClientTransport({command:preview.entry.command,args:preview.entry.args,env:{...process.env,...preview.entry.env} as Record<string,string>,stderr:"pipe"}));
    const response=await client.callTool({name:"projects_list",arguments:{}}); assert.equal(response.isError,false);
    const content=response.content as {type:string;text:string}[]; const projects=JSON.parse(content[0].text); assert.equal(projects[0].id,f.p.id); assert.equal(projects[0].path,f.project);
    assert.equal(f.starts,0); assert.equal(f.service.store.runs().length,0);
  } finally { await client.close(); await new Promise<void>(resolve=>http.close(()=>resolve())); await f.cleanup(); }
});
test("setup rejects MCP-only and mixed credentials, absent Origin, extra paths and arbitrary command fields", async () => {
  const f = await fixture();
  try {
    const bearer = {Authorization:`Bearer ${f.service.bearer}`,Origin:"http://127.0.0.1:4317","Content-Type":"application/json"};
    for(const auth of [bearer,{...bearer,Cookie:f.cookie}]) for (const harness of ["codex", "muse"]) {
      assert.equal((await f.call(f.base(harness),"GET",undefined,auth)).status,403);
      for(const op of ["preview","apply","undo"]) assert.equal((await f.call(`${f.base(harness)}/${op}`,"POST",{},auth)).status,403);
    }
    assert.equal((await f.call(`${f.base()}/preview`,"POST",{}, { Cookie:f.cookie,"Content-Type":"application/json" })).status,403);
    assert.equal((await f.call(`${f.base()}/preview`,"POST",{}, { Cookie:f.cookie,Origin:"https://evil.example","Content-Type":"application/json" })).status,403);
    for(const body of [{command:"rm",args:["-rf"]},{path:"/tmp/native"},{harness:"gemini"}]) assert.equal((await f.call(`${f.base()}/preview`,"POST",body)).status,400);
    assert.equal((await f.call(f.base("unknown"))).status,400); assert.equal((await f.call("/api/projects/00000000-0000-4000-8000-000000000000/setup/codex")).status,404);
    assert.equal(existsSync(f.calls),false);
  } finally { await f.cleanup(); }
});
test("existing entry is never adopted or overwritten, and Codex/project Claude scope shadows block setup", async () => {
  const f = await fixture();
  try {
    const entry=(await f.preview()).entry;
    writeFileSync(join(f.codex,"config.toml"),JSON.stringify({mcp_servers:{agentklar:{command:entry.command,args:entry.args,env:entry.env}}}));
    let s=await (await f.call(f.base())).json(); assert.equal(s.status,"configured"); assert.equal(s.canUndo,false); assert.equal(s.change,null);
    writeFileSync(join(f.codex,"config.toml"),JSON.stringify({mcp_servers:{agentklar:{command:"external",env:{TOKEN:"NATIVE_PRIVATE_SECRET"}}}}));
    s=await (await f.call(f.base())).json(); assert.equal(s.status,"conflict"); assert.equal(JSON.stringify(s).includes("NATIVE_PRIVATE_SECRET"),false); assert.equal((await f.call(`${f.base()}/preview`,"POST",{})).status,409);
    writeFileSync(join(f.codex,"config.toml"),"{}"); mkdirSync(join(f.project,".codex")); writeFileSync(join(f.project,".codex","config.toml"),JSON.stringify({mcp_servers:{agentklar:{command:"shadow"}}}));
    assert.equal((await (await f.call(f.base())).json()).status,"conflict"); assert.equal((await f.call(`${f.base()}/preview`,"POST",{})).status,409);
    writeFileSync(join(f.project,".mcp.json"),JSON.stringify({mcpServers:{agentklar:entry}})); assert.equal((await (await f.call(f.base("claude"))).json()).status,"conflict");
    rmSync(join(f.project,".mcp.json")); writeFileSync(join(f.claude,".claude.json"),JSON.stringify({mcpServers:{agentklar:entry}})); assert.equal((await (await f.call(f.base("claude"))).json()).status,"conflict");
  } finally { await f.cleanup(); }
});
test("preview freshness and undo protect external edits, changes to other config, symlinks and replaced roots", async () => {
  const f=await fixture();
  try {
    const preview=await f.preview(); writeFileSync(join(f.codex,"config.toml"),JSON.stringify({external:true})); assert.equal((await f.apply(preview.id)).status,409);
    const next=await f.preview(); const applied=await (await f.apply(next.id)).json(); const file=join(f.codex,"config.toml"), data=config(file); data.mcp_servers.agentklar.env.EXTRA="external"; writeFileSync(file,JSON.stringify(data));
    assert.equal((await (await f.call(f.base())).json()).canUndo,false); assert.equal((await f.call(`${f.base()}/undo`,"POST",{changeId:applied.id})).status,409); assert.equal(config(file).mcp_servers.agentklar.env.EXTRA,"external");
    rmSync(file); symlinkSync(join(f.claude,".claude.json"),file); writeFileSync(join(f.claude,".claude.json"),"{}"); assert.equal((await (await f.call(f.base())).json()).status,"unavailable");
    rmSync(file); const fresh=await f.preview(); rmSync(f.project,{recursive:true}); mkdirSync(f.project); assert.equal((await f.apply(fresh.id)).status,409);
  } finally { await f.cleanup(); }
});
test("older saved folder identity cannot authorize native setup undo", async () => {
  const f = await fixture();
  try {
    const applied = await (await f.apply((await f.preview("claude")).id, "claude")).json();
    const row = f.service.store.db.prepare("SELECT data FROM native_setup_changes WHERE id=?").get(applied.id) as { data: string };
    const old = JSON.parse(row.data);
    old.root = old.root.split(":").slice(1, 3).join(":");
    f.service.store.db.prepare("UPDATE native_setup_changes SET data=? WHERE id=?").run(JSON.stringify(old), applied.id);
    assert.equal((await f.call(`${f.base("claude")}/undo`, "POST", { changeId: applied.id })).status, 409);
  } finally { await f.cleanup(); }
});
test("failed add/remove remain interrupted and recoverable without native output leakage", async () => {
  const f=await fixture();
  try {
    const preview=await f.preview("claude"); writeFileSync(f.mode,"addFailAfter"); const failure=await f.apply(preview.id,"claude"); assert.equal(failure.status,503); assert.equal(JSON.stringify(await failure.json()).includes("NATIVE_PRIVATE_SECRET"),false);
    let status=await (await f.call(f.base("claude"))).json(); assert.equal(status.status,"configured"); assert.equal(status.change.state,"interrupted"); assert.equal(status.canUndo,true);
    await f.restart(); writeFileSync(f.mode,"undoFailBefore"); assert.equal((await f.call(`${f.base("claude")}/undo`,"POST",{changeId:status.change.id})).status,503);
    status=await (await f.call(f.base("claude"))).json(); assert.equal(status.change.operation,"undo"); assert.equal(status.canUndo,true);
    await f.restart(); writeFileSync(f.mode,""); assert.equal((await f.call(`${f.base("claude")}/undo`,"POST",{changeId:status.change.id})).status,200);
    const next=await f.preview(); const applied=await (await f.apply(next.id)).json(); writeFileSync(f.mode,"undoFailAfter"); assert.equal((await f.call(`${f.base()}/undo`,"POST",{changeId:applied.id})).status,503);
    status=await (await f.call(f.base())).json(); assert.equal(status.status,"missing"); assert.equal(status.change.state,"interrupted"); assert.equal(status.canUndo,false);
  } finally { await f.cleanup(); }
});
test("Claude malformed relevant config shapes are unavailable and never reach a native mutation", async () => {
  const f=await fixture();
  try {
    const file=join(f.claude,".claude.json");
    for(const body of [[],"private text",{projects:[]},{projects:{[f.project]:"bad"}},{projects:{[f.project]:{mcpServers:[]}}},{mcpServers:"bad"},{projects:{[f.project]:{mcpServers:{agentklar:null}}}}]) {
      writeFileSync(file,JSON.stringify(body)); assert.equal((await (await f.call(f.base("claude"))).json()).status,"unavailable"); assert.equal((await f.call(`${f.base("claude")}/preview`,"POST",{})).status,422);
    }
    writeFileSync(file,"{}"); writeFileSync(join(f.project,".mcp.json"),"[]"); assert.equal((await (await f.call(f.base("claude"))).json()).status,"unavailable");
    assert.equal(existsSync(f.calls),false);
  } finally { await f.cleanup(); }
});
test("native command timeout/output bounds kill the owned group and return fixed errors", async () => {
  const f=await fixture();
  try {
    function stopped(pid: number) {
      if (process.platform === "linux") {
        let stat: string;
        try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
        // PID 1 may leave a killed orphan as a zombie. It cannot run or hold pipes.
        return ["Z", "X", "x"].includes(stat.charAt(stat.lastIndexOf(") ") + 2));
      }
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    }
    assert.equal(stopped(process.pid), false, "The process check must reject a live process.");
    // Allow slow CI startup so this checks cleanup of a running fixture, not a pre-start timeout.
    writeFileSync(f.mode,"timeout"); await assert.rejects(nativeSetupCommand(f.command,["mcp","add"],f.project,{...process.env,CODEX_HOME:f.codex,CLAUDE_CONFIG_DIR:f.claude,SETUP_MODE:f.mode,SETUP_CALLS:f.calls},{timeoutMs:2000}),/timed out/);
    assert.ok(existsSync(`${f.mode}.pids`), "The timeout fixture must start before process cleanup is checked.");
    const pids: unknown = JSON.parse(readFileSync(`${f.mode}.pids`,"utf8"));
    assert.ok(Array.isArray(pids)); assert.equal(pids.length, 2);
    assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
    assert.equal(new Set(pids).size, 2);
    for(const pid of pids) {
      const deadline = Date.now() + 1000;
      while (!stopped(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(stopped(pid), `Owned PID ${pid} is still running after timeout cleanup.`);
    }
    writeFileSync(f.mode,"overflow"); await assert.rejects(nativeSetupCommand(f.command,["mcp","add"],f.project,{...process.env,CODEX_HOME:f.codex,CLAUDE_CONFIG_DIR:f.claude,SETUP_MODE:f.mode,SETUP_CALLS:f.calls},{timeoutMs:1200,maxOutputBytes:1024}),/exceeded/);
  } finally { await f.cleanup(); }
});
test("service close waits for setup operation journal and status probes, and no mutation restarts afterward", async () => {
  const f=await fixture();
  try {
    const preview=await f.preview("claude"); writeFileSync(f.mode,"timeout"); const pending=f.apply(preview.id,"claude");
    const deadline=Date.now()+3000;
    while(!existsSync(`${f.mode}.pids`) && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
    assert.ok(existsSync(`${f.mode}.pids`),"Owned timeout fixture must start within three seconds.");
    await f.service.close(); assert.equal((await pending).status,503);
    writeFileSync(f.mode,""); await f.restart(); const status=await (await f.call(f.base("claude"))).json(); assert.equal(status.change.state,"interrupted"); assert.equal(status.status,"missing");
    writeFileSync(f.mode,"readDelay"); const reading=f.call(f.base()); await new Promise(r=>setTimeout(r,100)); await f.service.close(); assert.equal((await reading).status,200);
  } finally { await f.cleanup(); }
});

function olderBridge(f: Awaited<ReturnType<typeof fixture>>, harness: string) {
  const packageRoot = join(f.dir, "older AgentKlar", harness);
  mkdirSync(join(packageRoot, "dist", "server"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "agentklar", version: "0.1.0-beta.1" }));
  const bridge = join(packageRoot, "dist", "server", "mcp.js");
  writeFileSync(bridge, "// Older AgentKlar fixture bridge\n");
  const env = { AGENTKLAR_HOME: f.home, AGENTKLAR_PORT: "4317" };
  return harness === "opencode" ? { type: "local", command: [realpathSync(process.execPath), bridge], environment: env }
    : { ...(harness === "codex" ? {} : { type: "stdio" }), command: realpathSync(process.execPath), args: [bridge], env };
}
function writeOlderConnection(f: Awaited<ReturnType<typeof fixture>>, harness: string, entry: unknown) {
  const file = harness === "codex" ? join(f.codex, "config.toml") : join(f.xdg, harness, harness === "muse" ? "settings.json" : "opencode.json");
  mkdirSync(dirname(file), { recursive: true });
  const servers = { agentklar: entry, other: { url: "https://example.test", token: "UNRELATED_SECRET" } };
  writeFileSync(file, JSON.stringify(harness === "codex" ? { native: true, mcp_servers: servers }
    : harness === "muse" ? { schema_version: 1, theme: "dark", mcpServers: servers } : { theme: "dark", mcp: servers }));
  return file;
}
function savedEntry(file: string, harness: string) {
  const value = config(file);
  return (harness === "codex" ? value.mcp_servers : harness === "muse" ? value.mcpServers : value.mcp).agentklar;
}

test("reviewed older AgentKlar connections update and restore only the previous entry after restart", async () => {
  const f = await fixture();
  try {
    for (const harness of ["codex", "muse", "opencode"]) {
      const old = olderBridge(f, harness), file = writeOlderConnection(f, harness, old);
      const before = readFileSync(file, "utf8");
      const status = await (await f.call(f.base(harness))).json();
      assert.equal(status.status, "conflict"); assert.equal(status.canUpdate, true);
      assert.equal(JSON.stringify(status).includes("UNRELATED_SECRET"), false);
      const preview = await f.preview(harness);
      assert.equal(preview.operation, "replace"); assert.deepEqual(preview.previousEntry, old);
      assert.equal(JSON.stringify(preview).includes("UNRELATED_SECRET"), false);
      assert.equal(readFileSync(file, "utf8"), before, "Review does not write native settings");
      const response = await f.apply(preview.id, harness); assert.equal(response.status, 200);
      const change = await response.json(); assert.equal(change.replacesExisting, true);
      assert.notDeepEqual(savedEntry(file, harness), old);
      assert.match(readFileSync(file, "utf8"), /UNRELATED_SECRET/);
      await f.restart();
      assert.equal((await (await f.call(f.base(harness))).json()).canUndo, true);
      assert.equal((await f.call(`${f.base(harness)}/undo`, "POST", { changeId: change.id })).status, 200);
      assert.deepEqual(savedEntry(file, harness), old);
      assert.match(readFileSync(file, "utf8"), /UNRELATED_SECRET/);
    }
  } finally { await f.cleanup(); }
});

test("older connection review refuses foreign homes, ports, secrets, properties, bridges and scopes", async () => {
  const f = await fixture();
  try {
    const old = olderBridge(f, "codex") as { command: string; args: string[]; env: Record<string, string> };
    const entries = [
      { ...old, env: { ...old.env, AGENTKLAR_HOME: f.dir } },
      { ...old, env: { ...old.env, AGENTKLAR_PORT: "4318" } },
      { ...old, env: { ...old.env, TOKEN: "NATIVE_PRIVATE_SECRET" } },
      { ...old, enabled: true },
      { ...old, args: [join(f.dir, "foreign.js")] },
      { ...old, args: ["--inspect", ...old.args] },
      { url: "https://example.test", headers: { Authorization: "NATIVE_PRIVATE_SECRET" } },
    ];
    for (const entry of entries) {
      const file = writeOlderConnection(f, "codex", entry), before = readFileSync(file, "utf8");
      const status = await (await f.call(f.base())).json();
      assert.equal(status.canUpdate, false);
      assert.equal(JSON.stringify(status).includes("NATIVE_PRIVATE_SECRET"), false);
      assert.equal((await f.call(`${f.base()}/preview`, "POST", {})).status, 409);
      assert.equal(readFileSync(file, "utf8"), before);
    }
    writeOlderConnection(f, "codex", old);
    mkdirSync(join(f.project, ".codex"));
    writeFileSync(join(f.project, ".codex", "config.toml"), JSON.stringify({ mcp_servers: { agentklar: old } }));
    assert.equal((await (await f.call(f.base())).json()).canUpdate, false);
    assert.equal((await f.call(`${f.base()}/preview`, "POST", {})).status, 409);
    rmSync(join(f.project, ".codex"), { recursive: true });
    writeFileSync(join(dirname(dirname(dirname(old.args[0]!))), "package.json"), JSON.stringify({ name: "foreign-package" }));
    assert.equal((await (await f.call(f.base())).json()).canUpdate, false);
  } finally { await f.cleanup(); }
});

test("reviewed replacement rejects changed native settings and interrupted replacement can restore the old bridge", async () => {
  const f = await fixture();
  try {
    const old = olderBridge(f, "codex"), file = writeOlderConnection(f, "codex", old);
    const stale = await f.preview();
    writeFileSync(file, JSON.stringify({ ...config(file), otherNativeSetting: true }));
    assert.equal((await f.apply(stale.id)).status, 409);
    assert.deepEqual(savedEntry(file, "codex"), old);
    const preview = await f.preview();
    writeFileSync(f.mode, "addFailAfter");
    assert.equal((await f.apply(preview.id)).status, 503);
    await f.restart(); writeFileSync(f.mode, "");
    const status = await (await f.call(f.base())).json();
    assert.equal(status.change.state, "interrupted"); assert.equal(status.canUndo, true);
    assert.equal((await f.call(`${f.base()}/undo`, "POST", { changeId: status.change.id })).status, 200);
    assert.deepEqual(savedEntry(file, "codex"), old);
    assert.equal(config(file).otherNativeSetting, true);
  } finally { await f.cleanup(); }
});
