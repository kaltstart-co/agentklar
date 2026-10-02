import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createService} from '../src/service.ts';
import {Control} from '../src/control.ts';
import {Store} from '../src/store.ts';
import type {ProjectLead} from '../src/contracts.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
test('coordinated policy, two bridge handoff, fences, receipts, expiry and restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agentklar-control-')),home=join(dir,'home'),path=join(dir,'project');mkdirSync(path);let tick=0,waiting:ReturnType<typeof deferred>|undefined,entered=deferred(),launches=0;
 const make=()=>createService(home,4317,(_cmd,_run,_path,cb)=>{launches++;return {stop(){},closed:Promise.resolve()} as any;},process.execPath,null,async p=>{if(waiting){entered.resolve();await waiting.promise;}return {projectId:p.id,checkedAt:new Date().toISOString(),harnesses:[]};},undefined,undefined,undefined,undefined,undefined,{now:()=>tick,wallNow:()=>1000,leaseMs:100});
 let s=make();let cookie='';
 const headers=(id?:string)=>({'Content-Type':'application/json',Authorization:`Bearer ${s.bearer}`,...(id?{'x-agentklar-bridge-id':id.repeat(64)}:{})});
 const ui=()=>({'Content-Type':'application/json',Cookie:cookie,Origin:'http://127.0.0.1:4317'});
 const req=async(route:string,method='GET',body?:unknown,h:Record<string,string>=headers())=>s.app.request('http://127.0.0.1:4317'+route,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(route:string,method='GET',body?:unknown,h?:Record<string,string>)=>{const r=await req(route,method,body,h);assert.equal(r.status<400,true,await r.clone().text());return r.json();};
 try{
 const setup=await s.app.request(s.setupUrl);cookie=setup.headers.get('set-cookie')!.split(';')[0];const p=await json('/api/projects','POST',{name:'control',path});const base=`/api/projects/${p.id}`;
 let a=(await json(base+'/lead','POST',{action:'claim'},headers('a'))).lead;
 // Advisory starts/context stay available to another bridge.
 assert.equal((await req(base+'/context','PUT',{brief:'saved',memory:'memory',handoff:'next',expectedRevision:0},headers('b'))).status,200);
 assert.equal((await req('/api/projects/bad/control')).status,400);
 assert.equal((await req(`/api/projects/${randomUUID()}/control/packets`)).status,404);
 assert.equal((await req(base+'/control/packets?limit=1&limit=2')).status,400);
 assert.equal((await req(base+'/control/prepare','POST',{unexpected:true})).status,400);
 let status=await json(base+'/control');
 assert.equal((await req(base+'/control','PUT',{mode:'coordinated',expectedRevision:status.revision},{...ui(),Authorization:'invalid'})).status,403);
 status=await json(base+'/control','PUT',{mode:'coordinated',expectedRevision:status.revision},ui());
 const task={projectId:p.id,prompt:'test',idempotencyKey:randomUUID(),harness:'codex',includeProjectContext:false};
 assert.equal((await req('/api/tasks/start','POST',task,headers('b'))).status,409);
 assert.equal((await req(base+'/context','PUT',{brief:'blocked',memory:'',handoff:'',expectedRevision:1},headers('b'))).status,409);
 const packet=await json(base+'/control/prepare','POST',{});assert.equal(packet.context.brief,'saved');assert.equal(packet.observedLead.claimId,a.claimId);assert.equal(packet.work.totalLocal,0);
 const input={requestId:randomUUID(),expectedDigest:packet.digest,expectedContextRevision:1,expectedControlRevision:packet.control.revision};
 waiting=deferred();const delayed=req('/api/tasks/start','POST',{...task,routing:{complexity:'routine',requiresImages:false,taskType:'coding'}},headers('a'));await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error("catalog not reached")),2000))]);
 const accepted=await json(base+`/control/packets/${packet.id}/accept`,'POST',input,headers('b'));waiting.resolve();waiting=undefined;assert.equal((await delayed).status,409);assert.equal(launches,0);
 assert.equal((await req(base+'/lead','POST',{action:'takeover',observedClaimId:accepted.receipt.lead.claimId},headers('a'))).status,409);
 const replay=await json(base+`/control/packets/${packet.id}/accept`,'POST',input,headers('b'));assert.deepEqual(replay.receipt,accepted.receipt);
 assert.equal((await req(base+`/control/packets/${packet.id}/accept`,'POST',input,headers('a'))).status,409);
 assert.equal((await req(base+`/control/packets/${packet.id}/accept`,'POST',{...input,expectedDigest:'0'.repeat(64)},headers('b'))).status,409);
 const stale=await json(base+'/control/prepare','POST',{});await json(base+'/context','PUT',{brief:'updated',memory:'memory',handoff:'next',expectedRevision:1},headers('b'));
 assert.equal((await req(base+`/control/packets/${stale.id}/accept`,'POST',{requestId:randomUUID(),expectedDigest:stale.digest,expectedContextRevision:1,expectedControlRevision:stale.control.revision},headers('a'))).status,409);
 // Scoped owner callback is independently authorized; ordinary caller cannot imitate it.
 assert.equal((await req('/api/tasks/start','POST',task,{...headers('a'),'x-agentklar-peer-internal':'fake'})).status,409);
 const state=await json(base+'/control');assert.equal((await req(base+'/control/recover','POST',{expectedRevision:state.revision-1,observedClaimId:state.lead.claimId},ui())).status,409);
 await json(base+'/control/recover','POST',{expectedRevision:state.revision,observedClaimId:state.lead.claimId},ui());
 assert.equal((await req('/api/tasks/start','POST',task,headers('b'))).status,409);
 await json(base+'/lead','POST',{action:'claim'},headers('a'));tick=101;assert.equal((await json(base+'/control')).lead,null);
 assert.equal((await req('/api/tasks/start','POST',task,headers('a'))).status,409);
 await s.close();s=make();const after=await json(base+`/control/packets/${packet.id}/accept`,'POST',input,headers('b'));assert.deepEqual(after.receipt,accepted.receipt);assert.equal(after.control.lead,null);assert.equal((await req('/api/tasks/start','POST',task,headers('b'))).status,409);
 assert.equal((await json(base+'/control/packets?limit=1')).nextOffset,1);assert.equal((await req(base+'/control/packets?offset=-1')).status,400);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});
test('advisory transition and policy A-B-A fencing use immutable stamps',()=>{const dir=mkdtempSync(join(tmpdir(),'agentklar-control-stamp-'));const store=new Store(dir),control=new Control(store.db),project=randomUUID();const lead=(id:string):ProjectLead&{bridgeId:string}=>({projectId:project,claimId:id,clientName:'A',claimedAt:'now',lastSeenAt:'now',expiresAt:'later',bridgeId:'a'});try{const a=lead(randomUUID());const advisory=control.stamp(project,'a',a,false);control.bump(project);control.check(project,advisory,lead(randomUUID()));let status=control.status(project,a);control.policy(project,'coordinated',status.revision);assert.throws(()=>control.check(project,advisory,a));const stamp=control.stamp(project,'a',a,false);control.bump(project);assert.throws(()=>control.check(project,stamp,a));status=control.status(project,a);control.policy(project,'advisory',status.revision);assert.throws(()=>control.check(project,stamp,a));assert.throws(()=>control.check(project,advisory,a));}finally{store.close();rmSync(dir,{recursive:true,force:true});}});
test('two real stdio MCP clients inspect and accept saved handoff without interrupting worker or native approval',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agentklar-control-wire-')),home=join(dir,'home'),path=join(dir,'project');mkdirSync(path);const port=25000+Math.floor(Math.random()*5000);let cb:any;
 const s=createService(home,port,(_cmd,_r,_p,callbacks)=>{cb=callbacks;const finished=deferred();return {closed:finished.promise,stop(){finished.resolve();}} as any;},process.execPath);const http=serve({fetch:s.app.fetch,hostname:'127.0.0.1',port});const clients=[new Client({name:'Lead A',version:'1'}),new Client({name:'Lead B',version:'1'})];const transports=clients.map(()=>new StdioClientTransport({command:'npm',args:['--prefix',resolve('.'),'run','--silent','mcp'],env:{...process.env as Record<string,string>,AGENTKLAR_HOME:home,AGENTKLAR_PORT:String(port)},stderr:'pipe'}));const call=async(index:number,name:string,args:any)=>{const r=await clients[index].callTool({name,arguments:args});assert.equal(r.isError,false,JSON.stringify(r));return JSON.parse((r.content as {text:string}[])[0].text);};
 try{await Promise.all(clients.map((c,i)=>c.connect(transports[i])));const p=await call(0,'project_register',{name:'wire',path});await call(0,'project_lead',{projectId:p.id,action:'claim'});const run=await call(0,'task_start',{projectId:p.id,prompt:'existing work',idempotencyKey:randomUUID(),harness:'codex'});let answered=0;cb.approval({id:randomUUID(),runId:run.id,kind:'command',title:'Native request',details:{command:'fixture'},decisions:['accept'],createdAt:new Date().toISOString()},()=>answered++);const approval=s.store.approvals()[0];
 const setup=await s.app.request(s.setupUrl),cookie=setup.headers.get('set-cookie')!.split(';')[0];const status=await (await s.app.request(`http://127.0.0.1:${port}/api/projects/${p.id}/control`,{headers:{Cookie:cookie}})).json();const policy=await s.app.request(`http://127.0.0.1:${port}/api/projects/${p.id}/control`,{method:'PUT',headers:{Cookie:cookie,Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json'},body:JSON.stringify({mode:'coordinated',expectedRevision:status.revision})});assert.equal(policy.status,200);
 const packet=await call(0,'project_handoff',{projectId:p.id,action:'prepare'});const read=await call(1,'project_handoff',{projectId:p.id,action:'read',packetId:packet.id});assert.equal(read.work.local[0].id,run.id);assert.equal(read.work.local[0].state,'running');const args={projectId:p.id,action:'accept',packetId:packet.id,requestId:randomUUID(),expectedDigest:packet.digest,expectedContextRevision:packet.context.revision,expectedControlRevision:packet.control.revision};const accepted=await call(1,'project_handoff',args);assert.equal(accepted.receipt.lead.clientName,'Lead B');assert.deepEqual((await call(1,'project_handoff',args)).receipt,accepted.receipt);assert.equal((await clients[0].callTool({name:'run_stop',arguments:{runId:run.id}})).isError,true);assert.equal(s.store.run(run.id)!.state,'running');assert.equal(s.store.approvals()[0].id,approval.id);assert.equal(answered,0);await clients[0].close();assert.equal((await call(1,'project_lead',{projectId:p.id,action:'status'})).lead.clientName,'Lead B');
 }finally{await Promise.all(clients.map(c=>c.close().catch(()=>{})));await new Promise<void>(r=>http.close(()=>r()));await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('factory fence after async Git; direct peer starts and cancellations share coordinated gate',()=>{
 execFileSync(process.execPath,['--import','tsx',resolve('tests/fixtures/control-git-race.mts')],{cwd:resolve('.'),timeout:15000,stdio:'pipe'});
});
test('handoff history continues past 128 and worst escaped context is rejected without generic truncation',()=>{const dir=mkdtempSync(join(tmpdir(),'agentklar-control-budget-'));const store=new Store(dir),control=new Control(store.db),projectId=randomUUID();try{const context=store.context(projectId);const input={projectId,context,control:control.status(projectId,null),observedLead:null,work:{local:[],remote:[],totalLocal:0,totalRemote:0,pointers:{context:'context',runs:'runs',remoteRuns:'remote'}}};for(let i=0;i<132;i++)control.prepare(input);const ids=new Set<string>();let offset:number|null=0;while(offset!==null){const page=control.list(projectId,offset,10);for(const p of page.packets){assert.equal(ids.has(p.id),false);ids.add(p.id);}offset=page.nextOffset;}assert.equal(ids.size,132);assert.throws(()=>control.prepare({...input,context:{...context,brief:'\u0000'.repeat(2000),memory:'\u0000'.repeat(4000),handoff:'\u0000'.repeat(2000)}}),/review budget/);assert.equal(control.list(projectId,130,10).packets.length,2);}finally{store.close();rmSync(dir,{recursive:true,force:true});}});
