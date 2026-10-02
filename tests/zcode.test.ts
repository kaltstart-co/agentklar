import { test } from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ZCodeWorker, zcodeApproval, zcodeEnvironment, zcodeModel } from "../src/zcode.ts";
import type { Approval, Run } from "../src/contracts.ts";
const fake = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [mode,log] = process.argv.slice(2);
let input;
const send = m=>process.stdout.write(JSON.stringify(m)+'\n');
const event=(type,payload,turnId='root',sessionId='session')=>send({method:'session/event',params:{eventId:'event',sessionId,turnId,seq:1,type,payload}});
const complete=()=>event('turn.completed',{inputId:input,resultType:'success',response:'Done',tokenCount:17});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(log,line+'\n');
 if(m.method==='session/create')send({id:m.id,result:{protocol:{name:'ZCode Protocol',version:1},session:{sessionId:'session',mode:mode==='yolo'?'yolo':'build'},settings:{mode:{current:'build'},permission:mode==='unknownmode'?{}:{mode:'build'},model:{available:[{ref:{providerId:'native',modelId:'model',options:{reasoningLevel:'high'}}}]}}}});
 else if(m.method==='session/subscribe')send({id:m.id,result:{sessionId:'session',eventSeq:0,events:[]}});
 else if(m.method==='session/send'){
  input=m.params.inputId;
  send({id:m.id,result:{sessionId:'session',accepted:true,stateRevision:1}});
  event('turn.started',{inputId:input});
  if(mode==='hang')return;
  if(mode==='malformed'){process.stdout.write('{bad\n');return;}
  if(mode==='earlyexit'){process.exit(0);return;}
  if(mode==='survivor'){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);"],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{appendFileSync(log,JSON.stringify({ownedDescendant:child.pid})+'\n');complete();});return;}
  if(mode==='approval'||mode==='unsupported'||mode==='origin'){
   const params={requestId:'approval',sessionId:'session',turnId:'root',toolCallId:'tool',toolName:mode==='unsupported'?'Mcp':'Bash',input:{command:'npm test'},options:[{kind:'allow_once',optionId:'allow_once'}],...(mode==='origin'?{origin:{kind:'subagent'}}:{})};
   send({id:'server-1',method:'interaction/requestPermission',params});
   send({id:'server-2',method:'interaction/requestPermission',params});return;
  }
  if(mode==='auth'){send({id:'auth',method:'interaction/requestProviderRuntimeHeaders',params:{secret:'PRIVATE AUTH'}});return;}
  event('turn.completed',{inputId:'other',resultType:'success',response:'CHILD',tokenCount:99},'child');
  event('turn.completed',{inputId:input,resultType:'success',response:'WRONG',tokenCount:99},'root','other');
  complete();
 }
 else if(m.id==='server-1'&&m.result?.decision==='allow')complete();
});
`;
test("ZCode bundle startup preserves native environment and uses only its shipped regular provider file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-zcode-env-"));
  try {
    const resources = join(dir, "Resources"), entry = join(resources, "glm", "zcode.cjs"), config = join(resources, "config", "provider", "zcode-builtin.json");
    mkdirSync(dirname(entry), { recursive: true }); mkdirSync(dirname(config), { recursive: true });
    writeFileSync(entry, ""); writeFileSync(config, "{}");
    const native = { PATH: "/native/bin", NATIVE_PROFILE: "unchanged" };
    assert.deepEqual(zcodeEnvironment(process.execPath, [entry, "app-server", "--stdio"], native), { ...native, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: realpathSync(config) });
    assert.deepEqual(native, { PATH: "/native/bin", NATIVE_PROFILE: "unchanged" });
    const explicit = { ...native, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/native/override.json" };
    assert.deepEqual(zcodeEnvironment(entry, [], explicit), { ...explicit, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: realpathSync(config) });
    const personal = { ...native, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/native/personal.json" };
    assert.deepEqual(zcodeEnvironment(entry, [], personal), personal);
    const active = { ...native, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/native/active.json" };
    assert.deepEqual(zcodeEnvironment(entry, [], active), active);
    rmSync(config); symlinkSync(entry, config);
    assert.deepEqual(zcodeEnvironment(entry, [], native), native);
    assert.deepEqual(zcodeEnvironment("zcode", ["app-server", "--stdio"], native), native);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function fixture(mode: string, patch: Partial<Run> = {}) {
  const dir=mkdtempSync(join(tmpdir(),"agentklar-zcode-")), script=join(dir,"fake.mjs"), log=join(dir,"wire");
  writeFileSync(script,fake);writeFileSync(log,"");
  let run:Run={id:"run",projectId:"project",prompt:"test",readOnly:false,state:"running",result:"",tokens:null,createdAt:"now",updatedAt:"now",...patch};
  const approvals:{value:Approval;answer:(decision:string)=>void}[]=[],events:string[]=[];let done=0;
  const worker=new ZCodeWorker(process.execPath,run,dir,{update:p=>{run={...run,...p};},event:(_k,t)=>events.push(t),approval:(value,answer)=>approvals.push({value,answer}),done:()=>{done++;}},{args:[script,mode,log],timeoutMs:1000});
  return {worker,approvals,events,run:()=>run,done:()=>done,wire:()=>readFileSync(log,"utf8").trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)),clean:()=>rmSync(dir,{recursive:true,force:true})};
}
async function until(check:()=>boolean){for(let n=0;n<250;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail("Timed out");}
test("ZCode root completion uses exact native input/turn/session IDs and preserves model pin",async()=>{
 const f=fixture("complete",{model:"native/model$high"});try{await f.worker.closed;assert.equal(f.run().state,"completed");assert.equal(f.run().result,"Done");assert.equal(f.run().tokens,17);assert.equal(f.run().turnId,"root");const wire=f.wire();assert.equal(wire[0].params.mode,"build");assert.deepEqual(wire.find(m=>m.method==='session/send').params.modelSelection,{providerId:'native',modelId:'model',options:{reasoningLevel:'high'}});assert.ok(!wire.some(m=>/setModel|setMode|login|authenticate/.test(m.method)));assert.equal(f.done(),1);}finally{f.clean();}
});
test("ZCode admission alone remains running and stop aborts the native session",async()=>{
 const f=fixture("hang");try{await until(()=>f.run().turnId==='root');assert.equal(f.run().state,"running");f.worker.stop();await f.worker.closed;assert.equal(f.run().state,"cancelled");assert.ok(f.wire().some(m=>m.method==='session/stop'&&m.params.sessionId==='session'));assert.equal(f.run().workerPid,undefined);}finally{f.clean();}
});
test("ZCode reannounced concrete approval settles once with no persistent permission updates",async()=>{
 const f=fixture("approval");try{await until(()=>f.approvals.length===1);await new Promise(r=>setTimeout(r,20));assert.equal(f.approvals.length,1);f.approvals[0].answer('accept');f.approvals[0].answer('decline');await f.worker.closed;assert.equal(f.run().state,'completed');const answers=f.wire().filter(m=>m.id==='server-1'&&m.result);assert.equal(answers.length,1);assert.deepEqual(answers[0].result,{decision:'allow',reason:'Approved once in AgentKlar'});}finally{f.clean();}
});
test("ZCode rejects unsafe mode, unsupported approvals/auth requests and incomplete transport",async()=>{
 for(const mode of ['yolo','unknownmode','unsupported','origin','auth','malformed','earlyexit']){const f=fixture(mode);try{await f.worker.closed;assert.ok(['failed','needs_attention'].includes(f.run().state));assert.equal(f.approvals.length,0);assert.doesNotMatch(JSON.stringify(f.run())+JSON.stringify(f.events),/PRIVATE AUTH/);if(mode==='yolo'||mode==='unknownmode')assert.ok(!f.wire().some(m=>m.method==='session/send'));}finally{f.clean();}}
});
test("ZCode refuses unoffered model pins and read-only work before inference",async()=>{
 for(const patch of [{model:'native/missing'},{model:'native/model$unoffered'},{readOnly:true}]){const f=fixture('complete',patch);try{await f.worker.closed;assert.equal(f.run().state,'needs_attention');assert.ok(!f.wire().some(m=>m.method==='session/send'));if(patch.readOnly)assert.equal(f.worker.child,undefined);}finally{f.clean();}}
 assert.deepEqual(zcodeModel('native/model'),{providerId:'native',modelId:'model'});
 assert.throws(()=>zcodeModel('unqualified'));
 assert.equal(zcodeApproval({toolCallId:'t',toolName:'Bash',input:{command:'echo hi',run_in_background:true}},'r','/tmp'),null);
 assert.equal(zcodeApproval({toolCallId:'t',toolName:'Write',input:{file_path:'/tmp/x'}},'r','/tmp'),null);
});
test("ZCode closed waits for surviving owned process cleanup", { skip: process.platform === 'win32' }, async () => {
  const f = fixture('survivor');
  try {
    await f.worker.closed;
    const pid = f.worker.child!.pid!;
    assert.equal(f.run().workerPid, undefined);
    assert.throws(() => process.kill(-pid, 0));
    assert.ok(f.events.some(t => t.includes('Stopping remaining owned ZCode')));
    assert.equal(f.done(), 1);
  } finally { f.clean(); }
});

test("process exit after ZCode closed cannot orphan an owned resistant descendant", { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentklar-zcode-exit-"));
  const log = join(dir, "wire"), script = join(dir, "fake.mjs"), owner = join(dir, "owner.mjs");
  writeFileSync(log, ""); writeFileSync(script, fake);
  writeFileSync(owner, `import {ZCodeWorker} from ${JSON.stringify(new URL("../src/zcode.ts", import.meta.url).href)};
const run={id:'run',projectId:'project',prompt:'test',readOnly:false,state:'running',result:'',tokens:null,createdAt:'now',updatedAt:'now'};
const worker=new ZCodeWorker(process.execPath,run,${JSON.stringify(dir)},{update(){},event(){},approval(){},done(){}},{args:[${JSON.stringify(script)},'survivor',${JSON.stringify(log)}]});
await worker.closed; process.exit(0);\n`);
  let descendant: number | undefined;
  const child = spawn(process.execPath, ["--import", "tsx", owner], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0);
    descendant = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.ownedDescendant)?.ownedDescendant;
    assert.equal(typeof descendant, "number");
    assert.throws(() => process.kill(descendant!, 0));
  } finally {
    child.kill("SIGKILL");
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});
