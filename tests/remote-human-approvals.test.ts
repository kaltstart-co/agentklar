import {test} from "node:test";
import assert from "node:assert/strict";
import {Client} from "@modelcontextprotocol/client";
import {InMemoryTransport} from "@modelcontextprotocol/server";
import {serve} from "@hono/node-server";
import {createMcp} from "../src/mcp.ts";
import {createService} from "../src/service.ts";
import {Peers,PeerError,type PeerTransport} from "../src/peers.ts";
import {deviceSettings} from "../src/devices.ts";
import type {Project} from "../src/contracts.ts";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Approvals} from "../src/approvals.ts";
import {Store} from "../src/store.ts";
import {randomUUID,createHash} from "node:crypto";

const wait=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail("fixture timed out");};
test("only separately paired trusted human UI can consume an exact remote native approval",async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"agentklar-human-relay-"))),a=join(dir,"a"),b=join(dir,"b");mkdirSync(a);
 const git=(...args:string[])=>execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();git("-C",a,"init");git("-C",a,"config","user.name","Test");git("-C",a,"config","user.email","test@example.test");writeFileSync(join(a,"one.txt"),"one");git("-C",a,"add",".");git("-C",a,"commit","-m","base");git("clone",a,b);
 const sourcePort=31000+Math.floor(Math.random()*2000),ownerPort=sourcePort+1,sourceHome=join(dir,"source"),ownerHome=join(dir,"owner");
 let answers=0,loseAck=false;
 const ownerFactory:Parameters<typeof createService>[2]=(_,run,path,cb)=>{const id=randomUUID();queueMicrotask(()=>{cb.update({state:"needs_attention"});cb.approval({id,runId:run.id,kind:"command",title:"Approve exact command",details:{command:run.prompt.endsWith("large")?"x".repeat(90000):"git status",cwd:path},decisions:["accept","decline","cancel"],createdAt:new Date().toISOString()},decision=>{answers++;if(run.prompt.endsWith("throw"))throw new Error("fixture callback failure");cb.update({state:"completed",result:`Decision ${decision}`});cb.done();});});return {stop(){},closed:Promise.resolve()};};
 let owner=createService(ownerHome,ownerPort,ownerFactory,process.execPath,null);
 const call=(s:typeof owner,port:number)=>async(path:string,method="GET",body?:unknown,headers?:Record<string,string>)=>{const r=await s.app.request(`http://127.0.0.1:${port}${path}`,{method,headers:headers||{Authorization:`Bearer ${s.bearer}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
 const transport:PeerTransport=async(_,request)=>{const human="channel" in request;const result=await call(owner,ownerPort)(human?"/api/peer-human":"/api/peer","POST",request);if(human&&request.operation==="answer"&&loseAck){loseAck=false;throw new PeerError("fixture lost reply",503);}return result;};
 const makeSource=()=>createService(sourceHome,sourcePort,()=>{throw new Error("no local worker");},null,null,undefined,undefined,undefined,undefined,undefined,null,undefined,null,transport);
 let source=makeSource();
 const ui=async(s:typeof owner,port:number)=>{const setup=await s.app.request(s.setupUrl);return{Cookie:setup.headers.get("set-cookie")!.split(";")[0],Origin:`http://127.0.0.1:${port}`,"Content-Type":"application/json"};};
 let sourceUi=await ui(source,sourcePort);const ownerUi=await ui(owner,ownerPort);
 const project=(s:typeof owner,path:string)=>{const p:Project={id:randomUUID(),path,name:"test",preference:"balanced",roles:[],createdAt:"now"};s.store.saveProject(p);return p;};
 const lp=project(source,a),rp=project(owner,b),ld=deviceSettings(source.store.db).device,od=deviceSettings(owner.store.db).device;
 const op=new Peers(owner.store,od,call(owner,ownerPort)),sp=new Peers(source.store,ld,call(source,sourcePort),transport);const grant=op.grant({sourceDeviceId:ld.id,projectId:rp.id});const mapping=sp.saveConnection({label:"Owner",deviceId:od.id,projectId:lp.id,remoteProjectId:rp.id,sshHost:"fixture",command:"agentklar",grantId:grant.id,grantToken:grant.token});source.store.saveProject({...lp,roles:[{id:"worker",name:"Worker",harness:"codex",responsibility:"",peerId:mapping.id}]});
 const http=serve({fetch:source.app.fetch,hostname:"127.0.0.1",port:sourcePort}),mcp=createMcp(`http://127.0.0.1:${sourcePort}`,source.bearer),client=new Client({name:"human-boundary-test",version:"1"});const[cw,sw]=InMemoryTransport.createLinkedPair();await mcp.connect(sw);await client.connect(cw);
 let closedWire=false;
 try{
 const tools=await client.listTools();assert.ok(!tools.tools.some(t=>/approval|human_grant|human_save/.test(t.name)));
 const reply=await client.callTool({name:"task_start",arguments:{projectId:lp.id,roleId:"worker",prompt:"first",idempotencyKey:"first",workspace:"worktree"}});assert.ok(!reply.isError);const first=JSON.parse((reply.content as {text:string}[])[0].text);await wait(()=>owner.store.approvals().some(x=>x.runId===first.ownerRunId));
 const request=(path:string,body:unknown,headers:Record<string,string>=sourceUi)=>call(source,sourcePort)(path,"POST",body,headers);
 const listPath=`/api/remote-approvals/${first.id}/list`;
 const deniedHeaders:Record<string,string>[]=[{Authorization:`Bearer ${source.bearer}`,"Content-Type":"application/json"},{...sourceUi,Authorization:`Bearer ${source.bearer}`},{...sourceUi,Authorization:"Bearer invalid"},{Cookie:sourceUi.Cookie,"Content-Type":"application/json"},{...sourceUi,Origin:"https://evil.example"}];for(const headers of deniedHeaders)assert.equal((await request(listPath,{},headers)).status,403);
 assert.equal((await request("/api/peers/settings/human/grant",{grantId:grant.id},{Authorization:`Bearer ${source.bearer}`})).status,403);
 assert.equal((await request(listPath,{})).status,403);
 const minted=await call(owner,ownerPort)("/api/peers/settings/human/grant","POST",{grantId:grant.id},ownerUi);assert.equal(minted.status,200);const human=minted.body;
 assert.equal((await request("/api/peers/settings/human/save",{peerId:mapping.id,humanGrantId:human.id,token:human.token})).status,200);
 const settings=await call(source,sourcePort)("/api/peers/settings/human","GET",undefined,sourceUi);assert.equal(settings.status,200);assert.doesNotMatch(JSON.stringify(settings.body),new RegExp(human.token));
 const listed=await request(listPath,{});assert.equal(listed.status,200);const approval=listed.body.approvals[0];assert.equal(approval.available,true);
 const readPath=`/api/remote-approvals/${first.id}/${approval.id}/read`,answerPath=`/api/remote-approvals/${first.id}/${approval.id}/answer`;
 const concrete=await request(readPath,{});assert.equal(concrete.body.approval.details.command,"git status");assert.equal(concrete.body.digest,approval.digest);
 const humanEnvelope={version:1,channel:"human",sourceDeviceId:ld.id,targetDeviceId:od.id,humanGrantId:human.id,token:human.token,operation:"read",runId:first.ownerRunId,approvalId:approval.id,requestId:randomUUID()};
 assert.equal((await call(owner,ownerPort)("/api/peer-human","POST",{...humanEnvelope,sourceDeviceId:randomUUID()})).status,403);
 assert.equal((await call(owner,ownerPort)("/api/peer-human","POST",{...humanEnvelope,runId:randomUUID()})).status,403);
 assert.equal((await call(owner,ownerPort)("/api/peer-human","POST",{...humanEnvelope,token:grant.token})).status,403);
 assert.equal((await call(owner,ownerPort)("/api/peer","POST",humanEnvelope)).status,400);
 const otherGrant=op.grant({sourceDeviceId:ld.id,projectId:rp.id});const otherHuman=(await call(owner,ownerPort)("/api/peers/settings/human/grant","POST",{grantId:otherGrant.id},ownerUi)).body;assert.equal((await call(owner,ownerPort)("/api/peer-human","POST",{...humanEnvelope,humanGrantId:otherHuman.id,token:otherHuman.token})).status,403);
 const bad=await call(owner,ownerPort)("/api/peer-human","POST",{...humanEnvelope,operation:"answer",expectedDigest:"0".repeat(64),decision:"accept"});assert.equal(bad.status,409);assert.equal(answers,0);
 const body={requestId:randomUUID(),expectedDigest:concrete.body.digest,decision:"accept"};loseAck=true;assert.equal((await request(answerPath,body)).status,503);assert.equal(answers,1);assert.equal(owner.store.approvals().length,0);
 await client.close();await mcp.close();await new Promise<void>(r=>http.close(()=>r()));closedWire=true;await source.close();source=makeSource();sourceUi=await ui(source,sourcePort);
 const recovered=await request(readPath,{});assert.equal(recovered.body.approval,null);assert.equal(recovered.body.receipt.requestId,body.requestId);assert.equal(recovered.body.actionIntent.state,"pending");assert.equal((await request(answerPath,body)).body.state,"submitted");assert.equal(answers,1);assert.equal((await request(answerPath,{...body,decision:"decline"})).status,409);
 const next=async(prompt:string)=>{const run=(await request("/api/tasks/start",{projectId:lp.id,roleId:"worker",prompt,idempotencyKey:prompt,workspace:"worktree"})).body;await wait(()=>owner.store.approvals().some(a=>a.runId===run.ownerRunId));const l=await request(`/api/remote-approvals/${run.id}/list`,{});return{run,a:l.body.approvals[0]};};
 const race=await next("race"),racePath=`/api/remote-approvals/${race.run.id}/${race.a.id}/answer`,raceBody={requestId:randomUUID(),expectedDigest:race.a.digest,decision:"accept"};const beforeRace=answers;
 const competing=await Promise.all([request(racePath,raceBody),call(owner,ownerPort)(`/api/approvals/${race.a.id}`,"POST",{decision:"decline"},ownerUi)]);assert.equal(competing.filter(r=>r.status===200).length,1);assert.equal(answers,beforeRace+1);
 const twoHumans=await next("two-humans"),beforeHumans=answers;const humanChoices=await Promise.all(["accept","decline"].map(decision=>call(owner,ownerPort)("/api/peer-human","POST",{...humanEnvelope,operation:"answer",runId:twoHumans.run.ownerRunId,approvalId:twoHumans.a.id,requestId:randomUUID(),expectedDigest:twoHumans.a.digest,decision})));assert.equal(humanChoices.filter(r=>r.status===200).length,1);assert.equal(answers,beforeHumans+1);
 const failure=await next("throw"),failurePath=`/api/remote-approvals/${failure.run.id}/${failure.a.id}/answer`,failureBody={requestId:randomUUID(),expectedDigest:failure.a.digest,decision:"accept"};assert.equal((await request(failurePath,failureBody)).body.state,"callback_failed");assert.equal(owner.store.run(failure.run.ownerRunId)?.state,"needs_attention");assert.match(owner.store.run(failure.run.ownerRunId)?.error || "",/native callback failed.*execution is unknown/);assert.match((await call(owner,ownerPort)(`/api/runs/${failure.run.ownerRunId}`)).body.error,/cannot be answered again/);const beforeRetry=answers;assert.equal((await request(failurePath,failureBody)).body.state,"callback_failed");assert.equal(answers,beforeRetry);
 owner.store.saveRun({...owner.store.run(failure.run.ownerRunId)!,state:"completed"});
 const large=await next("large");assert.equal(large.a.available,false);assert.equal((await request(`/api/remote-approvals/${large.run.id}/${large.a.id}/read`,{})).status,413);const beforeLarge=answers;assert.equal((await request(`/api/remote-approvals/${large.run.id}/${large.a.id}/answer`,{requestId:randomUUID(),expectedDigest:large.a.digest,decision:"accept"})).status,413);assert.equal(answers,beforeLarge);assert.equal((await call(owner,ownerPort)(`/api/approvals/${large.a.id}`,"POST",{decision:"decline"},ownerUi)).status,200);
 const pending=await next("restart");await owner.close();owner=createService(ownerHome,ownerPort,ownerFactory,process.execPath,null);assert.equal(owner.store.approvals().length,0);assert.equal(owner.store.run(pending.run.ownerRunId)?.state,"interrupted");const beforeRestart=answers;assert.equal((await request(`/api/remote-approvals/${pending.run.id}/${pending.a.id}/answer`,{requestId:randomUUID(),expectedDigest:pending.a.digest,decision:"accept"})).status,404);assert.equal(answers,beforeRestart);
 const newOwnerUi=await ui(owner,ownerPort);assert.equal((await call(owner,ownerPort)("/api/peers/settings/human/revoke","POST",{humanGrantId:human.id},newOwnerUi)).status,200);assert.equal((await request(readPath,{})).status,403);assert.equal((await request(answerPath,body)).status,403);
 }finally{if(!closedWire){await client.close();await mcp.close();await new Promise<void>(r=>http.close(()=>r()));}await source.close();await owner.close();rmSync(dir,{recursive:true,force:true});}
});

test("receipt survives failure after native submission and restart without invoking the callback twice",()=>{
 const dir=mkdtempSync(join(tmpdir(),"agentklar-approval-receipt-"));let store=new Store(dir);let calls=0;
 const runId=randomUUID(),approvalId=randomUUID(),projectId=randomUUID(),now=new Date().toISOString();
 const approval={id:approvalId,runId,kind:"command" as const,title:"Concrete request",details:{command:"git status"},decisions:["accept","decline"],createdAt:now};
 store.insertRun({id:runId,projectId,harness:"codex",prompt:"test",readOnly:false,state:"needs_attention",result:"",tokens:null,createdAt:now,updatedAt:now},"receipt");store.saveApproval(approval);
 const answers=new Map([[approvalId,()=>{calls++;}]]);const actions=new Approvals(store,answers,()=>true);
 const input={approvalId,requestId:randomUUID(),expectedDigest:createHash("sha256").update(JSON.stringify(approval)).digest("hex"),decision:"accept"};
 try{
 store.db.exec("CREATE TRIGGER receipt_failure BEFORE UPDATE ON approval_receipts BEGIN SELECT RAISE(FAIL,'fixture receipt update failure'); END");
 assert.throws(()=>actions.consume(runId,input),/fixture receipt update failure/);assert.equal(calls,1);assert.equal(store.approvals().length,0);assert.equal(actions.consume(runId,input).state,"recorded");assert.equal(calls,1);
 store.db.close();store=new Store(dir);assert.equal(store.run(runId)?.state,"interrupted");const restarted=new Approvals(store,new Map([[approvalId,()=>{calls++;}]]),()=>false);assert.equal(restarted.consume(runId,input).state,"recorded");assert.equal(calls,1);assert.throws(()=>restarted.consume(runId,{...input,decision:"decline"}),/different approval or decision/);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
