import { test } from "node:test";
import assert from "node:assert/strict";
import { BenchmarkCache, benchmarkSources, benchmarksFresh, evidenceForModel, parseBenchmarks, validateBenchmarkSnapshot } from "../src/benchmarks.ts";
import { recommendationSchema, recommendWorker } from "../src/recommend.ts";
import type { CatalogSnapshot, Project } from "../src/contracts.ts";
const categories = {Reasoning:["theory_of_mind","zebra_puzzle","spatial","logic_with_navigation"],Coding:["code_generation","code_completion"],"Agentic Coding":["javascript","typescript","python"],Mathematics:["AMPS_Hard","integrals_with_game","math_comp","olympiad"],"Data Analysis":["consecutive_events","tablejoin","tablereformat"],Language:["connections","plot_unscrambling","typos"],IF:["paraphrase","simplify","story_generation","summarize"]};
const columns = Object.values(categories).flat();
const json = JSON.stringify(categories);
const checkedAt = "2026-10-02T04:00:00.000Z", now = Date.parse(checkedAt);
function csv(rows = ["gpt-6.1-sol-max", "gpt-6-sol-max", "gpt-6-sol-low", "gpt-6-sol-unknown"]) {
  return ["model," + columns.join(","), ...rows.map((id, i) => id + "," + columns.map(col => ["javascript","typescript","python"].includes(col) ? 50 + i * 10 : col === "theory_of_mind" ? 80 : 40).join(","))].join("\n");
}
const snapshot = parseBenchmarks(csv(), json, checkedAt);
test("strict identities, category means, source hashes and schema bounds", () => {
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models[0].scores.Reasoning, 50);
  assert.equal(snapshot.models[0].scores["Agentic Coding"], 50);
  assert.equal(evidenceForModel(snapshot, "codex", "gpt-6-sol-low", "coding"), undefined);
  assert.equal(evidenceForModel(snapshot, "claude", "gpt-6-sol", "coding"), undefined);
  assert.equal(snapshot.csvHash.length, 64);
  for (const bad of [csv().replace(",50,", ",NaN,"), csv().replace(",50,", ",,"), csv().replace(",50,", ",101,"), csv().replace("model,", "name,"), csv(["gpt-6-sol-max", "gpt-6-sol-max"])]) assert.throws(() => parseBenchmarks(bad, json));
  assert.throws(() => parseBenchmarks(csv(), JSON.stringify({...categories,Coding:["python"]})));
  assert.throws(() => validateBenchmarkSnapshot({...snapshot,models:[{...snapshot.models[0],model:"gpt-6.1-sol-new"}]}));
  assert.equal(benchmarksFresh(snapshot, now), true);
  assert.equal(benchmarksFresh(snapshot, now + 7 * 86400000 + 1), false);
  assert.equal(benchmarksFresh(snapshot, now - 1), false);
});
const project: Project = { id:"p", name:"p", path:"/tmp", preference:"balanced", roles:[], createdAt:checkedAt };
function advice(data = snapshot, input = {}, ids = ["gpt-6.1-sol", "gpt-6-sol"]) {
  const catalog: CatalogSnapshot = {projectId:"p",checkedAt,harnesses:[{harness:"codex",models:ids.map(id=>({id,name:id,description:"",resolvedModel:null,isDefault:false,inputModalities:["text"]})),modelsStatus:"available",modelsMessage:null,modelsTruncated:false,quota:{status:"available",message:null,ordinaryUsageAllowed:true,buckets:[]}}]};
  return recommendWorker(project,recommendationSchema.parse(input),catalog,{codex:true,claude:false},now,data);
}
test("whole-group reference ties change task rank; incomplete, stale and pins retain policy", () => {
  assert.equal(advice().choice?.model,"gpt-6-sol");
  assert.equal(advice().benchmarkMethod,"reference-tie-break");
  assert.equal(advice(snapshot,{taskType:"reasoning"}).choice?.model,"gpt-6.1-sol");
  assert.equal(advice({...snapshot,checkedAt:"2026-09-01T00:00:00.000Z"}).choice?.model,"gpt-6.1-sol");
  assert.equal(advice(snapshot,{},["gpt-6.1-sol","gpt-6-sol","gpt-5.6-sol"]).choice?.model,"gpt-6.1-sol");
  assert.equal(advice(snapshot,{model:"gpt-6.1-sol"}).choice?.model,"gpt-6.1-sol");
  assert.equal(advice(snapshot,{model:"gpt-6.1-sol"}).benchmarkMethod,"pin");
});
test("explicit refresh coalesces, validates, preserves last good on failure and restores cached state", async () => {
  let calls = 0, saved: unknown;
  const fetcher: typeof fetch = async url => { calls++; assert.ok(Object.values(benchmarkSources).includes(String(url))); return new Response(String(url).endsWith(".csv") ? csv() : json); };
  const cache = new BenchmarkCache(value => {saved=value;},snapshot,fetcher);
  assert.equal(calls,0);
  const first = cache.refresh(), second = cache.refresh(); assert.equal(first,second);
  await first; assert.equal(calls,2);
  assert.deepEqual(new BenchmarkCache(()=>{},saved).get(),cache.get());
  const broken = new BenchmarkCache(()=>{},snapshot,async()=>new Response("bad"));
  await assert.rejects(broken.refresh()); assert.deepEqual(broken.get(),snapshot);
  const oversized = new BenchmarkCache(()=>{},snapshot,async()=>new Response("x".repeat(129000)));
  await assert.rejects(oversized.refresh(),/too large/);
  await cache.close(); await assert.rejects(cache.refresh(),/closed/);
});
test("timeout and close bound unresponsive downloads and prevent persistence", async () => {
  let saves=0;
  const stalled: typeof fetch = async () => new Promise(()=>{});
  const cache = new BenchmarkCache(()=>{saves++;},snapshot,stalled,10);
  // Keep the test process alive: AbortSignal.timeout uses an unref timer.
  const timer=setTimeout(()=>{},100);
  await assert.rejects(cache.refresh(),/timed out/); clearTimeout(timer); assert.equal(saves,0);
  const closing=new BenchmarkCache(()=>{saves++;},snapshot,stalled);
  const pending=closing.refresh(); await closing.close(); await assert.rejects(pending,/cancelled/); assert.equal(saves,0);
});
test("known allowance outranks higher reference and exact native aliases preserve pins", () => {
  const aliasData=parseBenchmarks(csv(["claude-sonnet-5-5-max-effort","claude-opus-5-5-max-effort"]),json,checkedAt);
  const harnesses: CatalogSnapshot["harnesses"]=["codex","claude"].map(harness=>({harness:harness as "codex"|"claude",models:[{id:harness==="codex"?"gpt-6.1-sol":"sonnet",name:"",description:"",resolvedModel:harness==="claude"?"claude-sonnet-5-5":null,isDefault:false,inputModalities:["text"]}],modelsStatus:"available",modelsMessage:null,modelsTruncated:false,quota:{status:"available",message:null,ordinaryUsageAllowed:harness==="codex"?true:null,buckets:[]}}));
  const merged={...snapshot,models:[...snapshot.models,...aliasData.models]};
  merged.models.find(m=>m.model==="claude-sonnet-5-5")!.scores["Agentic Coding"]=100;
  const native={projectId:"p",checkedAt,harnesses};
  const result=recommendWorker(project,recommendationSchema.parse({}),native,{codex:true,claude:true},now,merged);
  assert.equal(result.choice?.model,"gpt-6.1-sol");
  assert.equal(result.benchmarkMethod,"policy-fallback");
  const pin=recommendWorker(project,recommendationSchema.parse({harness:"claude",model:"sonnet"}),native,{codex:true,claude:true},now,merged);
  assert.equal(pin.choice?.model,"sonnet");
  assert.equal(pin.choice?.benchmark?.sourceRow,"claude-sonnet-5-5-max-effort");
  assert.equal(pin.benchmarkMethod,"pin");
  assert.ok(pin.warnings.some(w=>w.includes("Native worker settings")));
});
test("repeated advice keeps sources bounded and duplicate aliases do not create a tie", () => {
  for(let i=0;i<3;i++) assert.equal(advice().sources.length,4);
  const noSnapshot = recommendWorker(project,recommendationSchema.parse({}),{projectId:"p",checkedAt,harnesses:[]},{codex:true,claude:false},now);
  assert.equal(noSnapshot.sources.length,3);
  const data=parseBenchmarks(csv(["claude-sonnet-5-5-max-effort"]),json,checkedAt);
  const models=["sonnet","claude-sonnet-5-5"].map(id=>({id,name:id,description:"",resolvedModel:"claude-sonnet-5-5",isDefault:false,inputModalities:["text"]}));
  const native:CatalogSnapshot={projectId:"p",checkedAt,harnesses:[{harness:"claude",models,modelsStatus:"available",modelsMessage:null,modelsTruncated:false,quota:{status:"available",message:null,ordinaryUsageAllowed:true,buckets:[]}}]};
  const result=recommendWorker(project,recommendationSchema.parse({}),native,{codex:false,claude:true},now,data);
  assert.equal(result.choice?.model,"claude-sonnet-5-5");
  assert.equal(result.alternatives.length,0);
  assert.equal(result.benchmarkMethod,"policy-fallback");
  assert.match(result.reasons.join(" "),/no comparable tie/);
});
test("selected reference settings notice survives the global warning cap", () => {
  const models=[...Array.from({length:20},(_,i)=>`unknown-${i}`),"gpt-6.1-sol"].map(id=>({id,name:id,description:"",resolvedModel:null,isDefault:false,inputModalities:["text"]}));
  const native:CatalogSnapshot={projectId:"p",checkedAt,harnesses:[{harness:"codex",models,modelsStatus:"available",modelsMessage:null,modelsTruncated:false,quota:{status:"available",message:null,ordinaryUsageAllowed:true,buckets:[]}}]};
  const result=recommendWorker(project,recommendationSchema.parse({}),native,{codex:true,claude:false},now,snapshot);
  assert.equal(result.warnings.length,8);
  assert.match(result.warnings[0],/Native worker settings are unchanged/);
});
