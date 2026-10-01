import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createService } from "../src/service.ts";
import { nativeSetupCommand } from "../src/setup.ts";

async function fixture(port = 4317) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentklar-setup-test-")));
  const home = join(dir, "agentklar home"), codex = join(dir, "codex home"), claude = join(dir, "claude home"), project = join(dir, "project with spaces ' $()");
  for (const path of [home, codex, claude, project]) mkdirSync(path);
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
 if(Object.hasOwn(servers,'agentklar')) secretFail();
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
  const nativeEnv = { ...process.env, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, SETUP_MODE: mode, SETUP_CALLS: calls };
  let service = createService(home, port, () => { starts++; return { stop() {} }; }, command, command, undefined, { env: nativeEnv, timeoutMs: 1200 });
  let cookie = "";
  async function auth() { const response = await service.app.request(service.setupUrl); cookie = response.headers.get("set-cookie")!.split(";")[0]; }
  await auth();
  const headers = () => ({ Cookie: cookie, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" });
  const call = (path: string, method = "GET", body?: unknown, authHeaders: Record<string,string> = headers()) => service.app.request(`http://127.0.0.1:${port}${path}`, { method, headers: authHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const p = await (await call("/api/projects", "POST", { name: "setup test", path: project })).json();
  const base = (harness = "codex") => `/api/projects/${p.id}/setup/${harness}`;
  const preview = async (harness = "codex") => (await call(`${base(harness)}/preview`, "POST", {})).json();
  const apply = async (id: string, harness = "codex") => call(`${base(harness)}/apply`, "POST", { previewId: id });
  return { dir, home, codex, claude, project, p, command, mode, calls, base, call, preview, apply, get service() { return service; }, get cookie() { return cookie; }, get starts() { return starts; }, restart: async () => { await service.close(); service = createService(home, port, () => { starts++; return { stop() {} }; }, command, command, undefined, { env: nativeEnv, timeoutMs: 1200 }); await auth(); }, cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function config(path: string) { return JSON.parse(readFileSync(path,"utf8")); }
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
    for(const auth of [bearer,{...bearer,Cookie:f.cookie}]) {
      assert.equal((await f.call(f.base(),"GET",undefined,auth)).status,403);
      for(const op of ["preview","apply","undo"]) assert.equal((await f.call(`${f.base()}/${op}`,"POST",{},auth)).status,403);
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
    writeFileSync(f.mode,"timeout"); await assert.rejects(nativeSetupCommand(f.command,["mcp","add"],f.project,{...process.env,CODEX_HOME:f.codex,CLAUDE_CONFIG_DIR:f.claude,SETUP_MODE:f.mode,SETUP_CALLS:f.calls},{timeoutMs:180}),/timed out/);
    const pids=JSON.parse(readFileSync(`${f.mode}.pids`,"utf8")); for(const pid of pids) assert.throws(()=>process.kill(pid,0));
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
