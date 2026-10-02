import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {NativeSetup} from "../src/setup.ts";
import {executable} from "../src/harnesses.ts";

function fixture(native?:string) {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"agentklar-agy-setup-"))),home=join(dir,"service"),nativeHome=join(dir,"native"),path=join(dir,"project"),config=join(nativeHome,".gemini","config","mcp_config.json");
 for(const p of [home,path,join(nativeHome,".gemini","config")]) mkdirSync(p,{recursive:true});
 const fake=join(dir,"agy-fixture.mjs");
 writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import {readFileSync,writeFileSync} from "node:fs";import {join} from "node:path";
const path=join(process.env.HOME,".gemini","config","mcp_config.json"),data=JSON.parse(readFileSync(path,"utf8")),args=process.argv.slice(2);data.mcpServers ??= {};
if(args[1]==="add") {const env={};let i=2;while(args[i]==="--env") {const value=args[i+1],k=value.indexOf("=");env[value.slice(0,k)]=value.slice(k+1);i+=2;}const name=args[i++];if(args[i]==="--")i++;data.mcpServers[name]={command:args[i++],args:args.slice(i),env,disabled:false};}
else if(args[1]==="remove") delete data.mcpServers[args[2]];else process.exit(2);
writeFileSync(path,JSON.stringify(data,null,2));
`,{mode:0o700});
 const untouched={privateNativeSetting:"fixture-secret",mcpServers:{other:{serverUrl:"https://example.test",headers:{Authorization:"fixture-secret"},disabledTools:["one"]}}};writeFileSync(config,JSON.stringify(untouched));
 const db=new DatabaseSync(join(home,"setup.db"));const setup=new NativeSetup(db,home,4599,{codex:null,claude:null,antigravity:native || fake},{env:{HOME:nativeHome,PATH:process.env.PATH},timeoutMs:2000});
 const project={id:randomUUID(),name:"Fixture",path,preference:"balanced" as const,roles:[],createdAt:new Date().toISOString()};
 return {dir,config,project,setup,untouched,cleanup:async()=>{await setup.close();db.close();rmSync(dir,{recursive:true,force:true});}};
}
async function roundTrip(native?:string) {
 const f=fixture(native);
 try {
  assert.equal((await f.setup.status(f.project,"antigravity")).status,"missing");
  const preview=await f.setup.preview(f.project,"antigravity");assert.equal(preview.scope,"User");assert.equal(preview.configPath,f.config);assert.equal(preview.cwd,null);assert.ok(preview.command?.includes("'--env'"));assert.ok(preview.command?.includes("'--'"));assert.equal("type" in preview.entry,false);
  const change=await f.setup.apply(f.project,"antigravity",preview.id);assert.equal(change.state,"applied");
  const config=JSON.parse(readFileSync(f.config,"utf8"));assert.deepEqual(config.mcpServers.other,f.untouched.mcpServers.other);assert.equal(config.privateNativeSetting,f.untouched.privateNativeSetting);assert.deepEqual(config.mcpServers.agentklar,preview.entry);
  const status=await f.setup.status(f.project,"antigravity");assert.equal(status.status,"configured");assert.equal(status.canUndo,true);assert.ok(!JSON.stringify(status).includes("fixture-secret"));
  await f.setup.undo(f.project,"antigravity",change.id);assert.deepEqual(JSON.parse(readFileSync(f.config,"utf8")),f.untouched);
 } finally {await f.cleanup();}
}
test("Antigravity native-shaped user MCP setup preserves unrelated entries and undoes exactly",()=>roundTrip());
const native=executable("agy");
test("installed agy MCP metadata commands validate isolated HOME setup without auth or inference",{skip:!native},()=>roundTrip(native!));
test("Antigravity setup rejects stale previews, workspace conflicts and unsafe MCP JSON",async()=>{
 const f=fixture();try {
  const preview=await f.setup.preview(f.project,"antigravity");writeFileSync(f.config,JSON.stringify({...f.untouched,changed:true}));await assert.rejects(f.setup.apply(f.project,"antigravity",preview.id),/settings changed/);
  mkdirSync(join(f.project.path,".agents"));writeFileSync(join(f.project.path,".agents","mcp_config.json"),JSON.stringify({mcpServers:{agentklar:{command:"other"}}}));assert.equal((await f.setup.status(f.project,"antigravity")).status,"conflict");
  rmSync(join(f.project.path,".agents"),{recursive:true});writeFileSync(f.config,'{"mcpServers":{},"mcpServers":{}}');assert.equal((await f.setup.status(f.project,"antigravity")).status,"unavailable");
  rmSync(f.config);const other=join(f.dir,"linked.json");writeFileSync(other,"{}");symlinkSync(other,f.config);assert.equal((await f.setup.status(f.project,"antigravity")).status,"unavailable");
 } finally {await f.cleanup();}
});


test("Antigravity Git setup requires registered repository root and checks its workspace conflict",async()=>{
 const f=fixture();try {
  execFileSync("git",["init",f.project.path],{stdio:"ignore"});
  const nested=join(f.project.path,"src","nested");mkdirSync(nested,{recursive:true});
  mkdirSync(join(f.project.path,".agents"));writeFileSync(join(f.project.path,".agents","mcp_config.json"),JSON.stringify({mcpServers:{agentklar:{command:"root-workspace"}}}));
  const nestedProject={...f.project,path:nested};
  const status=await f.setup.status(nestedProject,"antigravity");assert.equal(status.status,"unavailable");assert.match(status.message,/Register that root folder/);
  await assert.rejects(f.setup.preview(nestedProject,"antigravity"),/registered repository root/);
  assert.equal((await f.setup.status(f.project,"antigravity")).status,"conflict");
  await assert.rejects(f.setup.preview(f.project,"antigravity"),/another scope/);
  rmSync(join(f.project.path,".agents"),{recursive:true});assert.equal((await f.setup.status(f.project,"antigravity")).status,"missing");
  const preview=await f.setup.preview(f.project,"antigravity");
  await assert.rejects(f.setup.apply(nestedProject,"antigravity",preview.id),/registered repository root/);
 } finally {await f.cleanup();}
});
