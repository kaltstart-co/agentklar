import { useEffect, useState } from "react";
import { Alert, Button } from "@mantine/core";
import type { BenchmarkSnapshot, BenchmarkEvidence } from "../src/benchmarks.js";

const source = "https://livebench.ai/table_2026_06_25.csv";
const notice = "Max-effort benchmark settings differ from native worker settings. These are reference scores, not a promise for your task or a measure of subscription cost.";
function fresh(snapshot: BenchmarkSnapshot) {
  const age = Date.now() - Date.parse(snapshot.checkedAt);
  return age >= 0 && age <= 7 * 86400000;
}
export function Benchmarks({ connected, snapshot, onChange }: { connected: boolean; snapshot: BenchmarkSnapshot | null; onChange: (snapshot: BenchmarkSnapshot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!connected) return;
    let active = true;
    fetch("/api/benchmarks", { credentials: "same-origin" }).then(async response => {
      if (!response.ok) throw new Error("Could not read benchmark scores.");
      const data = await response.json();
      if (active) onChange(data);
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [connected, onChange]);
  async function refresh() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/benchmarks/refresh", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not refresh benchmark scores.");
      onChange(data);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="role-card">
    <h3>LiveBench reference scores</h3>
    <p className="hint">{notice}</p>
    {snapshot && <p className="hint">Release {snapshot.release} · Checked {new Date(snapshot.checkedAt).toLocaleString()} · {fresh(snapshot) ? "Fresh" : "Stale: excluded from tie breaking"}. Release names the benchmark version; individual evaluation dates are unknown.</p>}
    <p className="hint">Coding advice uses Agentic Coding; other task types use Reasoning, Data Analysis or Language. Only exact reviewed model IDs have scores.</p>
    <Button size="sm" variant="light" disabled={!connected} loading={busy} onClick={() => void refresh()}>Refresh benchmarks</Button>
    {error && <Alert color="red">{error}</Alert>}
  </div>;
}
export function BenchmarkDetail({ snapshot, harness, model }: { snapshot: BenchmarkSnapshot | null; harness: string; model: string }) {
  if (!snapshot) return null;
  const row = snapshot.models.find(row => row.harness === harness && row.model === model);
  return <details><summary>Benchmark reference {row ? `· Agentic Coding ${row.scores["Agentic Coding"].toFixed(2)}/100` : "· No exact model match"}</summary>
    {row ? <><p className="hint">{Object.entries(row.scores).map(([metric, score]) => `${metric}: ${score.toFixed(2)}/100`).join(" · ")}</p><p className="hint">Source row: {row.sourceRow} · Release {snapshot.release} · Effort: {snapshot.measuredEffort}.</p><a href={source} target="_blank" rel="noreferrer">LiveBench source scores</a><p className="hint">{notice}</p></> : <p className="hint">No score is inferred from a model alias or family name.</p>}
  </details>;
}
export function BenchmarkEvidenceView({ evidence, method }: { evidence: BenchmarkEvidence; method?: string }) {
  return <details><summary>LiveBench {evidence.metric}: {evidence.score.toFixed(2)}/100 · {method === "reference-tie-break" ? "Tie break applied" : "Reference only"}</summary>
    <p className="hint">Release {evidence.release} · Checked {new Date(evidence.checkedAt).toLocaleString()} · Effort: {evidence.measuredEffort} · Source row: {evidence.sourceRow}.</p>
    <a href={evidence.sourceUrl} target="_blank" rel="noreferrer">LiveBench source scores</a>
    <p className="hint">{notice}</p>
  </details>;
}
