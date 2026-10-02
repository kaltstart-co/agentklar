import { requestedTaskBody } from "./requested-task.ts";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serve } from "@hono/node-server";
import { createMcp } from "../src/mcp.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";
import { Peers, PeerError, type PeerTransport } from "../src/peers.ts";
import { deviceSettings } from "../src/devices.ts";
import type { Run } from "../src/contracts.ts";

test("remote build review fix review keeps owner worktree across main commits and hands exact changes to a new local worktree", async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"agentklar-remote-chain-"))),a=join(dir,"a"),b=join(dir,"b");mkdirSync(a);
 const git=(...args:string[])=>execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();
 git("-C",a,"init");git("-C",a,"config","user.email","test@example.test");git("-C",a,"config","user.name","Test");writeFileSync(join(a,"one.txt"),"base\n");writeFileSync(join(a,".gitignore"),"ignored.txt\n");git("-C",a,"add",".");git("-C",a,"commit","-m","base");git("clone",a,b);git("-C",b,"config","user.email","test@example.test");git("-C",b,"config","user.name","Test");
 const sourcePort=22000+Math.floor(Math.random()*5000),ownerPort=sourcePort+1;
 const base=git("-C",a,"rev-parse","HEAD"),calls:Run[]=[];let localStarts=0,offline=false;
 const owner=createService(join(dir,"owner"),ownerPort,(_,run,path,callbacks)=>{
  calls.push(run);
  queueMicrotask(()=>{if(!run.followUp){writeFileSync(join(path,"one.txt"),"built\n");writeFileSync(join(path,"new.txt"),"new\n");for(let i=0;i<11;i++)writeFileSync(join(path,`extra-${i}.txt`),`extra ${i}\n`);writeFileSync(join(path,"ignored.txt"),"excluded\n");}else if(run.followUp.kind==="fix")writeFileSync(join(path,"one.txt"),"fixed\n");callbacks.update({state:"completed",result:run.followUp?.kind==="review"?"Review findings":"Work complete",effectiveModel:run.model});callbacks.done();});
  return{stop(){},closed:Promise.resolve()};
 },process.execPath,process.execPath);
 const call=(service:typeof owner,port:number)=>async(path:string,method="GET",body?:unknown)=>{const r=await service.app.request(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:`Bearer ${service.bearer}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(requestedTaskBody(path, body))})});return{status:r.status,body:await r.json()};};
 const ownerDevice=deviceSettings(owner.store.db).device,ownerPeers=new Peers(owner.store,ownerDevice,call(owner,ownerPort));
 const transport:PeerTransport=async(_,request)=>{if(offline)throw new PeerError("Fixture offline",503);return ownerPeers.owner(request);};
 const coordinator=createService(join(dir,"coordinator"),sourcePort,()=>{localStarts++;throw new Error("No local fallback");},process.execPath,null,undefined,undefined,undefined,undefined,undefined,null,undefined,null,transport);
 const http=serve({fetch:coordinator.app.fetch,hostname:"127.0.0.1",port:sourcePort});
 const mcp=createMcp(`http://127.0.0.1:${sourcePort}`,coordinator.bearer);
 const client=new Client({name:"chain-test",version:"1"});
 const [clientWire,serverWire]=InMemoryTransport.createLinkedPair();await mcp.connect(serverWire);await client.connect(clientWire);
 const tool=async(name:string,args:Record<string,unknown>)=>{const reply=await client.callTool({name,arguments:args});return {status:reply.isError?400:200,body:JSON.parse((reply.content as {text:string}[])[0].text)};};
 try{
  const project=(service:typeof owner,path:string)=>{const p={id:randomUUID(),name:"Chain",path,roles:[],preference:"balanced" as const,createdAt:"now"};service.store.saveProject(p);return p;};
  const sourceProject=project(coordinator,a),ownerProject=project(owner,b),sourceDevice=deviceSettings(coordinator.store.db).device,peers=new Peers(coordinator.store,sourceDevice,call(coordinator,sourcePort),transport);
  const grant=ownerPeers.grant({sourceDeviceId:sourceDevice.id,projectId:ownerProject.id});
  const mapping=peers.saveConnection({label:"Owner",deviceId:ownerDevice.id,sshHost:"fixture",command:"agentklar",projectId:sourceProject.id,remoteProjectId:ownerProject.id,grantId:grant.id,grantToken:grant.token});
  const duplicate=peers.saveConnection({label:"Same owner reviewer",deviceId:ownerDevice.id,sshHost:"fixture",command:"agentklar",projectId:sourceProject.id,remoteProjectId:ownerProject.id,grantId:grant.id,grantToken:grant.token});
  const wrong=peers.saveConnection({label:"Wrong owner",deviceId:randomUUID(),sshHost:"fixture",command:"agentklar",projectId:sourceProject.id,remoteProjectId:ownerProject.id,grantId:grant.id,grantToken:grant.token});
  const api=call(coordinator,sourcePort);
  assert.equal((await api(`/api/projects/${sourceProject.id}`,"PATCH",{roles:[{id:"builder",name:"Builder",harness:"codex",model:"gpt-6.1-sol",peerId:mapping.id,responsibility:"Build carefully"},{id:"reviewer",name:"Reviewer",harness:"claude",model:"fixture-claude",peerId:duplicate.id,responsibility:"Review only"},{id:"local",name:"Local",harness:"codex",responsibility:"Local"},{id:"wrong",name:"Wrong",harness:"codex",peerId:wrong.id,responsibility:"Wrong"}]})).status,200);
  owner.store.saveContext({projectId:ownerProject.id,revision:1,brief:"UNRELATED OWNER CONTEXT",memory:"",handoff:"",updatedAt:"now",updatedVia:"ui"},0);
  const start=async(input:object)=>{const response=await tool("task_start",{projectId:sourceProject.id,delegation:"requested",...input});assert.ok([200,202].includes(response.status),JSON.stringify(response.body));const dispatch=response.body as {id:string;ownerRunId:string};for(let i=0;i<200&&owner.store.run(dispatch.ownerRunId)?.state!=="completed";i++)await new Promise(r=>setTimeout(r,10));assert.equal(owner.store.run(dispatch.ownerRunId)?.state,"completed");return dispatch;};
  const build=await start({prompt:"Build",idempotencyKey:"build",roleId:"builder",workspace:"worktree"});
  for(const path of[a,b]){writeFileSync(join(path,"main-only.txt"),"main advanced\n");git("-C",path,"add","main-only.txt");git("-C",path,"commit","-m","main advanced");}
  const buildRun=owner.store.run(build.ownerRunId)!;owner.store.saveRun({...buildRun,state:"running"});
  const premature=await api("/api/tasks/start","POST",{projectId:sourceProject.id,prompt:"Premature",idempotencyKey:"premature",followUp:{runId:build.id,kind:"review"},readOnly:true});assert.equal(premature.status,409);assert.match(premature.body.error,/must be completed/);owner.store.saveRun(buildRun);
  const reviewInput={prompt:"Review build",idempotencyKey:"review",roleId:"reviewer",followUp:{runId:build.id,kind:"review"},readOnly:true};
  const review=await start(reviewInput);assert.equal((await start(reviewInput)).id,review.id);
  const fix=await start({prompt:"Fix findings",idempotencyKey:"fix",roleId:"builder",followUp:{runId:review.id,kind:"fix"},readOnly:false});
  const finalReview=await start({prompt:"Review fix",idempotencyKey:"final-review",followUp:{runId:fix.id,kind:"review"},readOnly:true});
  assert.equal(calls.length,4);assert.equal(localStarts,0);assert.equal(new Set(calls.map(r=>r.workspace?.path)).size,1);assert.equal(calls[1].harness,"claude");assert.equal(calls[1].model,"fixture-claude");assert.equal(calls[3].harness,"codex");assert.equal(calls[3].model,"gpt-6.1-sol");
  for(const run of calls){assert.equal(run.workspace?.kind,"worktree");if(run.workspace?.kind==="worktree"){assert.equal(run.workspace.baseCommit,base);assert.equal(run.workspace.rootRunId,build.ownerRunId);}assert.equal(run.contextSnapshot,undefined);assert.doesNotMatch(run.prompt,/UNRELATED OWNER CONTEXT/);}
  assert.equal(calls[2].followUpContext?.sourceRunId,review.ownerRunId);assert.equal(calls[2].followUpContext?.sourceResult,"Review findings");
  const context=await api(`/api/runs/${fix.id}/context`);assert.equal(context.status,200);assert.equal(context.body.followUpContext.sourceRunId,review.ownerRunId);
  for(const roleId of["local","wrong"]){const mismatch=await api("/api/tasks/start","POST",{projectId:sourceProject.id,prompt:"Wrong owner",idempotencyKey:roleId,roleId,followUp:{runId:build.id,kind:"review"},readOnly:true});assert.equal(mismatch.status,409);assert.match(mismatch.body.error,/owning computer|same owning computer/);}
  const invalid=await api("/api/tasks/start","POST",{projectId:sourceProject.id,prompt:"Invalid review",idempotencyKey:"invalid",followUp:{runId:fix.id,kind:"review"},readOnly:false});assert.equal(invalid.status,400);
  const summary=await tool("run_changes_read",{runId:finalReview.id});assert.equal(summary.status,200);assert.equal(summary.body.patch,undefined);assert.equal(summary.body.baseCommit,base);assert.equal(summary.body.files.length,10);assert.equal(summary.body.fileCount,13);assert.equal(summary.body.filesTruncated,true);assert.ok(summary.body.ignoredPaths.includes("ignored.txt"));
  const full=await api(`/api/runs/${finalReview.id}/changes?includePatch=true`);assert.match(full.body.patch,/fixed/);assert.match(full.body.patch,/new.txt/);assert.doesNotMatch(full.body.patch,/excluded/);assert.equal(full.body.files.length,13);
  const patchPage=await tool("run_changes_read",{runId:finalReview.id,includePatch:true,patchLimit:400});assert.equal(patchPage.body.patch.length,400);assert.equal(patchPage.body.patchNextOffset,400);assert.equal(patchPage.body.files.length,10);assert.equal(patchPage.body.fileCount,13);
  const nextPatchPage=await tool("run_changes_read",{runId:finalReview.id,includePatch:true,patchOffset:400,patchLimit:400});assert.equal(nextPatchPage.body.patch,full.body.patch.slice(400,800));
  const prepared=await tool("changes_prepare",{runId:finalReview.id,projectId:sourceProject.id});assert.equal(prepared.status,200);assert.equal(prepared.body.packet.patch,undefined);
  const preview=prepared.body,again=await api(`/api/runs/${finalReview.id}/changes/prepare`,"POST",{projectId:sourceProject.id});assert.equal(again.body.id,preview.id);assert.equal(again.body.packet.digest,preview.packet.digest);
  assert.equal((await api(`/api/changes/${preview.id}/apply`,"POST",{expectedDigest:"0".repeat(64),expectedBaseCommit:base})).status,409);
  const applied=await tool("changes_apply",{previewId:preview.id,expectedDigest:preview.packet.digest,expectedBaseCommit:base});assert.equal(applied.status,200);assert.equal(applied.body.staged,true);assert.ok(git("-C",applied.body.workspace.path,"diff","--cached","--name-only").split("\n").includes("new.txt"));assert.equal(readFileSync(join(applied.body.workspace.path,"one.txt"),"utf8"),"fixed\n");assert.equal(readFileSync(join(applied.body.workspace.path,"new.txt"),"utf8"),"new\n");
  assert.equal(readFileSync(join(a,"one.txt"),"utf8"),"base\n");assert.equal(readFileSync(join(b,"one.txt"),"utf8"),"base\n");assert.equal(existsSync(join(applied.body.workspace.path,"main-only.txt")),false);assert.equal(existsSync(join(applied.body.workspace.path,"ignored.txt")),false);assert.equal(applied.body.workspace.baseCommit,base);assert.equal(applied.body.continuations[0].freshSession,true);assert.match(applied.body.continuations[0].display,/env -u CODEX_HOME/);
  const replay=await api(`/api/changes/${preview.id}/apply`,"POST",{expectedDigest:preview.packet.digest,expectedBaseCommit:base});assert.equal(replay.body.workspace.path,applied.body.workspace.path);
  offline=true;const recovered=await api(`/api/runs/${finalReview.id}/changes`);assert.equal(recovered.status,200);assert.equal(recovered.body.currentChangesStatus,"unavailable");assert.equal(recovered.body.handoffs[0].id,preview.id);assert.equal(recovered.body.handoffs[0].applied.workspace.path,applied.body.workspace.path);
  const saved=await tool("changes_preview_read",{previewId:preview.id});assert.equal(saved.body.packet.patch,undefined);assert.equal(saved.body.applied.workspace.path,applied.body.workspace.path);
 }finally{await client.close();await mcp.close();await new Promise<void>(resolve=>http.close(()=>resolve()));await coordinator.close();await owner.close();rmSync(dir,{recursive:true,force:true});}
});
