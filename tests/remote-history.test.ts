import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../src/service.ts";

test("remote history uses independent bounded cursors without omissions, duplicates or private dispatch fields", async () => {
  const dir=mkdtempSync(join(tmpdir(),"agentklar-remote-history-"));
  const service=createService(dir,4317,undefined,null,null);
  try {
    const projectId=randomUUID(),otherProjectId=randomUUID();
    for(const id of [projectId,otherProjectId]) service.store.saveProject({id,name:"History",path:dir+id,roles:[],preference:"balanced",createdAt:"now"});
    const expected:string[]=[];
    for(let i=0;i<47;i++) {
      const id=randomUUID(); expected.unshift(id);
      const data={id,projectId,peerId:randomUUID(),ownerDeviceId:randomUUID(),prompt:`Task ${i}`,createdAt:"now",key:`key-${i}`,digest:"SECRET_DIGEST",request:{token:"SECRET_TOKEN"},connection:"unknown",lastKnownRun:{id:randomUUID(),projectId:randomUUID(),prompt:"x".repeat(32000),result:"r".repeat(1000),roleSnapshot:{responsibility:"PRIVATE_ROLE_CONTEXT"},state:"running",readOnly:false,createdAt:"now",updatedAt:"now",tokens:null}};
      service.store.db.prepare("INSERT INTO peer_dispatches(id,projectId,key,data) VALUES(?,?,?,?)").run(id,projectId,data.key,JSON.stringify(data));
      const other={...data,id:randomUUID(),projectId:otherProjectId};service.store.db.prepare("INSERT INTO peer_dispatches(id,projectId,key,data) VALUES(?,?,?,?)").run(other.id,otherProjectId,data.key,JSON.stringify(other));
    }
    const headers={Authorization:`Bearer ${service.bearer}`};
    const get=(query="")=>service.app.request(`http://127.0.0.1:4317/api/projects/${projectId}/runs${query}`,{headers});
    const seen:string[]=[]; let cursor:string|null=null,pages=0;
    do {
      const response=await get(`?remoteLimit=20${cursor?`&remoteCursor=${cursor}`:""}`);assert.equal(response.status,200);
      const page=await response.json(); assert.ok(page.remoteDispatches.length<=20);assert.ok(JSON.stringify(page).length<21000);
      assert.doesNotMatch(JSON.stringify(page),/SECRET|PRIVATE_ROLE_CONTEXT/);
      seen.push(...page.remoteDispatches.map((d:{id:string})=>d.id));pages++;
      cursor=page.remoteNextCursor;assert.equal(page.remoteDispatchesHasMore,cursor!==null);
      assert.equal(page.runs.length,0);assert.equal(page.nextCursor,null);
    }while(cursor);
    assert.equal(pages,3);assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,47);
    for(const query of ["?remoteCursor=0","?remoteCursor=-1","?remoteCursor=1.5","?remoteCursor=9007199254740992","?remoteCursor=1&remoteCursor=2","?remoteLimit=21","?remoteLimit=0","?remoteLimit=2&remoteLimit=3"])assert.equal((await get(query)).status,400,query);
    const empty=await(await get("?remoteCursor=1")).json();assert.deepEqual(empty.remoteDispatches,[]);assert.equal(empty.remoteNextCursor,null);assert.equal(empty.remoteDispatchesHasMore,false);
  }finally{await service.close();rmSync(dir,{recursive:true,force:true});}
});
