import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AcpWorker, acpApproval } from "../src/acp.ts";
import type { Run, Approval } from "../src/contracts.ts";

const fake = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [mode, log] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let prompt;
const complete = () => {send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'usage_update',used:999,size:1000}}});send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done'}}}});send({id:prompt.id,result:{stopReason:'end_turn',...(mode==='cursor'?{}:{usage:{totalTokens:12}})}});};
const options=[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'},{kind:'allow_always',optionId:'always'}];
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(log,line+'\n');
 if(m.method==='initialize') {if(mode==='timeout')return;send({id:m.id,result:{protocolVersion:mode==='version'?2:1}});}
 else if(m.method==='session/new') {if(mode==='auth'){send({id:m.id,error:{code:-32000,message:'PRIVATE AUTH PAYLOAD'}});return;}send({id:m.id,result:{sessionId:'session-1',models:{currentModelId:'native',availableModels:[{modelId:'native'},{modelId:'pinned'}]}}});send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});}
 else if(m.method==='session/set_model')send({id:m.id,result:{}});
 else if(m.method==='session/prompt') {
  prompt=m;
  if(mode==='hang')return;
  if(mode==='survivor'){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);"],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{appendFileSync(log,JSON.stringify({ownedDescendant:child.pid})+'\n');complete();});return;}
  if(mode==='badjson'){process.stdout.write('{bad\n');return;}
  if(mode==='oversize'){process.stdout.write('a'.repeat(256001));return;}
  if(mode==='wrongsession'){send({method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG'}}}});return;}
  if(mode==='exit'){process.exit(0);return;}
  if(mode==='question'||mode==='plan'){send({id:51,method:mode==='question'?'cursor/ask_question':'cursor/create_plan',params:{plan:'Unreviewed plan'}});return;}
  if(mode==='command'||mode==='title'||mode==='file'||mode==='pending'){
   const toolCall=mode==='file'?{toolCallId:'tool-1',kind:'edit',content:[{type:'diff',path:'/tmp/test.txt',oldText:'old',newText:'new'}]}:{toolCallId:'tool-1',kind:'execute',title:'rm -rf /',...(mode==='title'?{}:{rawInput:{command:'npm test'}})};
   send({id:50,method:'session/request_permission',params:{sessionId:'session-1',options,toolCall}});
   if(mode==='pending')send({id:prompt.id,result:{stopReason:'end_turn'}});
   return;
  }
  complete();
 }
 else if(m.id===50 && m.result?.outcome?.outcome==='selected')complete();
});
`;
function fixture(mode: string, patch: Partial<Run> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-acp-"));
  const log = join(dir, "wire.jsonl"), script = join(dir, "fake.mjs");
  writeFileSync(script, fake); writeFileSync(log, "");
  let run: Run = { id:"run",projectId:"project",prompt:"test",readOnly:false,state:"running",result:"",tokens:null,createdAt:"now",updatedAt:"now",...patch };
  const approvals: { value: Approval; answer: (decision: string) => void }[] = [];
  const events: string[] = []; let done = 0;
  const worker = new AcpWorker(process.execPath, run, dir, {
    update: value => {run={...run,...value};}, event: (_kind,text) => {events.push(text);},
    approval: (value,answer) => {approvals.push({value,answer});}, done:()=>{done++;},
  }, mode==="cursor"?"cursor-agent":"gemini", { args:[script,mode,log],handshakeTimeoutMs:1000 });
  return { worker, approvals, run:()=>run,events,done:()=>done,wire:()=>readFileSync(log,"utf8").trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),clean:()=>rmSync(dir,{recursive:true,force:true}) };
}
async function until(check:()=>boolean) { for(let n=0;n<200;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail("Timed out"); }

test("ACP saves root output/session and final usage without login or client proxies",async()=>{
 for(const mode of ["complete","cursor"]){const f=fixture(mode);try{await f.worker.closed;assert.equal(f.run().state,"completed");assert.equal(f.run().threadId,"session-1");assert.equal(f.run().result,"Done");assert.equal(f.run().tokens,mode==="cursor"?null:12);assert.equal(f.run().workerPid,undefined);assert.equal(f.done(),1);assert.deepEqual(f.wire()[0].params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false});assert.ok(!f.wire().some(m=>/authenticate|login/.test(m.method)));}finally{f.clean();}}
});
test("ACP model pins require native offered IDs and an acknowledged selection",async()=>{
 const f=fixture("complete",{model:"pinned"});try{await f.worker.closed;assert.equal(f.run().effectiveModel,"pinned");assert.equal(f.wire().find(m=>m.method==="session/set_model").params.modelId,"pinned");}finally{f.clean();}
 const missing=fixture("complete",{model:"not-offered"});try{await missing.worker.closed;assert.equal(missing.run().state,"needs_attention");assert.ok(!missing.wire().some(m=>m.method==="session/prompt"));}finally{missing.clean();}
});
test("ACP approvals settle once using only native once-only options",async()=>{
 for(const mode of ["command","file"]){const f=fixture(mode);try{await until(()=>!!f.approvals.length);assert.equal(f.run().state,"needs_attention");assert.equal(f.approvals[0].value.kind,mode==="file"?"file":"command");f.approvals[0].answer("accept");f.approvals[0].answer("decline");await f.worker.closed;assert.equal(f.run().state,"completed");const answers=f.wire().filter(m=>m.id===50&&m.result);assert.equal(answers.length,1);assert.deepEqual(answers[0].result,{outcome:{outcome:"selected",optionId:"yes"}});assert.doesNotMatch(JSON.stringify(f.approvals),/rm -rf/);}finally{f.clean();}}
});
test("ACP cancels display-only approvals and blocking Cursor extensions explicitly",async()=>{
 for(const mode of ["title","question","plan","pending"]){const f=fixture(mode);try{await f.worker.closed;assert.equal(f.run().state,"needs_attention");assert.ok(f.wire().some(m=>m.result?.outcome?.outcome==="cancelled"));if(mode!=="pending")assert.equal(f.approvals.length,0);}finally{f.clean();}}
});
test("ACP refuses malformed, oversized, wrong-session, unsupported-version and early exit",async()=>{
 for(const mode of ["badjson","oversize","wrongsession","version","exit","auth"]){const f=fixture(mode);try{await f.worker.closed;assert.ok(["failed","needs_attention"].includes(f.run().state));assert.equal(f.run().result,"");assert.doesNotMatch(JSON.stringify(f.run())+JSON.stringify(f.events),/PRIVATE AUTH/);}finally{f.clean();}}
});
test("ACP read-only refuses before spawning and handshake timeout stops owned process",async()=>{
 const readonly=fixture("complete",{readOnly:true});try{await readonly.worker.closed;assert.equal(readonly.run().state,"needs_attention");assert.equal(readonly.wire().length,0);assert.equal(readonly.worker.child,undefined);}finally{readonly.clean();}
 const timeout=fixture("timeout");try{await timeout.worker.closed;assert.equal(timeout.run().state,"needs_attention");assert.equal(timeout.run().workerPid,undefined);}finally{timeout.clean();}
});
test("ACP stop cancels pending permissions and owns process shutdown",async()=>{
 const f=fixture("command");try{await until(()=>!!f.approvals.length);f.worker.stop();await f.worker.closed;assert.equal(f.run().state,"cancelled");assert.equal(f.run().workerPid,undefined);assert.equal(f.done(),1);assert.ok(f.wire().some(m=>m.result?.outcome?.outcome==="cancelled"));}finally{f.clean();}
});
test("ACP concrete approvals reject hidden command fields and incomplete diffs",()=>{
 assert.equal(acpApproval({toolCallId:"x",kind:"execute",rawInput:{command:"echo hi",secret:"value"}},"run","/tmp"),null);
 assert.equal(acpApproval({toolCallId:"x",kind:"execute",rawInput:{command:"echo hi",cwd:"/elsewhere"}},"run","/tmp"),null);
 assert.equal(acpApproval({toolCallId:"x",kind:"edit",content:[{type:"diff",path:"relative",oldText:"old",newText:"new"}]},"run","/tmp"),null);
 assert.equal(acpApproval({toolCallId:"x",kind:"edit",content:[{type:"diff",path:"/tmp/x",oldText:null,newText:"new"}]},"run","/tmp"),null);
});

function groupAlive(pid: number) {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; } catch { return false; }
}
test("ACP closed waits for surviving owned processes to exit", { skip: process.platform === "win32" }, async () => {
  const f = fixture("survivor");
  try {
    await f.worker.closed;
    const pid = f.worker.child!.pid!;
    assert.equal(f.run().workerPid, undefined);
    assert.equal(groupAlive(pid), false);
    assert.ok(f.events.some(event => event.includes("Stopping remaining owned ACP")));
    assert.equal(f.done(), 1);
  } finally { f.clean(); }
});

test("process exit after ACP closed cannot orphan a SIGTERM-resistant descendant", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-acp-exit-")), log = join(dir, "wire.jsonl"), script = join(dir, "fake.mjs"), owner = join(dir, "owner.mjs");
  writeFileSync(log, ""); writeFileSync(script, fake);
  writeFileSync(owner, `import {AcpWorker} from ${JSON.stringify(new URL("../src/acp.ts", import.meta.url).href)};
const run={id:'run',projectId:'project',prompt:'test',readOnly:false,state:'running',result:'',tokens:null,createdAt:'now',updatedAt:'now'};
const worker=new AcpWorker(process.execPath,run,${JSON.stringify(dir)},{update(){},event(){},approval(){},done(){}},'gemini',{args:[${JSON.stringify(script)},'survivor',${JSON.stringify(log)}]});
await worker.closed; process.exit(0);\n`);
  let descendant: number | undefined;
  const child = spawn(process.execPath, ["--import", "tsx", owner], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0);
    descendant = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.ownedDescendant)?.ownedDescendant;
    assert.equal(typeof descendant, "number");
    let alive = true; try { process.kill(descendant!, 0); } catch { alive = false; }
    assert.equal(alive, false);
  } finally { child.kill("SIGKILL"); if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} } rmSync(dir, { recursive: true, force: true }); }
});
