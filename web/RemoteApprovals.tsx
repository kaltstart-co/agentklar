import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Group, Stack } from "@mantine/core";
import type { Approval } from "../src/contracts.js";

type Summary = Omit<Approval, "details"> & { digest: string; available: boolean; reason?: string };
type Receipt = { state: "recorded" | "submitted" | "callback_failed"; message: string; decision: string };
export type PendingHumanAnswer = { approvalId: string; requestId: string; expectedDigest: string; decision: string };
type Intent = PendingHumanAnswer & {dispatchId:string;state:"pending"|"acknowledged"|"rejected";error?:string;receipt?:Receipt};
type Read = { actionIntent?: Intent; approval: Approval | null; digest?: string; receipt?: Receipt };

export function RemoteApprovals({ dispatchId, peerId, owner, connected, connection, active, request, details, pendingStore }: {
  dispatchId: string; peerId: string; owner: string; connected: boolean; connection: string; active: boolean;
  request: <T>(path: string, body?: unknown) => Promise<T>;
  details: (approval: Approval) => ReactNode;
  pendingStore: Record<string, PendingHumanAnswer>;
}) {
  const [configured, setConfigured] = useState(false);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [checked, setChecked] = useState(false);
  const [read, setRead] = useState<Read | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [pending, setPending] = useState<PendingHumanAnswer | undefined>(pendingStore[dispatchId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    generation.current++; inFlight.current=false; setChecked(false); setSummaries([]); setRead(null); setReceipt(null); setError(""); setBusy(false);
    return () => { generation.current++; };
  }, [dispatchId, connected, connection, active]);
  // Settings are local, secret-free metadata. Owner reads happen only on a button click.
  useEffect(() => {
    let live = true;
    setConfigured(false);
    if (connected) void request<{ connections: { peerId: string }[]; actionIntents: Intent[] }>("/peers/settings/human")
      .then(value => { if (live) { setConfigured(value.connections.some(item => item.peerId === peerId)); const intent=value.actionIntents.find(item => item.dispatchId === dispatchId && item.state === "pending"); if(intent) { pendingStore[dispatchId]=intent; setPending(intent); } } })
      .catch(() => {});
    return () => { live = false; };
  }, [connected, request, peerId, dispatchId]);
  async function act(action: (current: () => boolean) => Promise<void>) {
    if (inFlight.current || !connected) return;
    inFlight.current=true;
    const key = generation.current; const current = () => key === generation.current;
    setBusy(true); setError("");
    try { await action(current); } catch (e) { if (current()) { setError((e as Error).message); setRead(null); setSummaries([]);
      try { const value=await request<{actionIntents:Intent[]}>("/peers/settings/human");const intent=value.actionIntents.find(item=>item.dispatchId===dispatchId && item.requestId===pendingStore[dispatchId]?.requestId && item.approvalId===pendingStore[dispatchId]?.approvalId && item.state==="rejected");if(current() && intent) {delete pendingStore[dispatchId];setPending(undefined);setError(`${intent.error || "The answer was rejected."} Review the request again before choosing.`);} } catch {} if (current() && /revoked|capability.*missing/i.test((e as Error).message)) setConfigured(false); } }
    finally { if (current()) { inFlight.current=false;setBusy(false); } }
  }
  const approval = read?.approval;
  const available = !!approval && summaries.some(item => item.id === approval.id && item.digest === read?.digest && item.available);
  async function send(answer: PendingHumanAnswer, current: () => boolean) {
    const result = await request<Receipt>(`/remote-approvals/${dispatchId}/${answer.approvalId}/answer`, { requestId: answer.requestId, expectedDigest: answer.expectedDigest, decision: answer.decision });
    if (current()) { setReceipt(result); setRead(null); setSummaries([]); setPending(undefined); delete pendingStore[dispatchId]; }
  }
  return <Stack gap="xs" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <p className="hint">{configured ? "Approval sharing is configured. Check the owner for exact pending requests." : "Native approvals stay on the owner computer. Optional approval sharing can be configured in Settings."}</p>
    {configured && <Button variant="light" loading={busy} disabled={!connected || busy || !active} onClick={() => void act(async current => {
      const value = await request<{ approvals: Summary[]; actionIntents?: Intent[] }>(`/remote-approvals/${dispatchId}/list`, {});
      if (current()) { setChecked(true);setSummaries(value.approvals); setRead(null); setReceipt(null); const intent=value.actionIntents?.find(item=>item.dispatchId===dispatchId && item.state==="pending"); if(intent) {pendingStore[dispatchId]=intent;setPending(intent);} }
    })}>Check approvals</Button>}
    {checked && !summaries.length && !pending && !receipt && <p className="hint">No pending native requests were reported by the owner.</p>}
    {error && <Alert color="orange">{error}{pending && " The answer was not confirmed. Retry the same choice."}</Alert>}
    {pending && <Alert color="orange"><p>Unconfirmed submission: {pending.decision}. A retry keeps the same request and choice.</p>
      <Button variant="light" disabled={!connected || busy || !configured} onClick={() => void act(current => send(pending, current))}>Retry same choice</Button>
    </Alert>}
    {receipt && <Alert color={receipt.state === "callback_failed" ? "orange" : "blue"} title={receipt.state === "submitted" ? "Submitted" : receipt.state === "callback_failed" ? "Callback failed" : "Recorded"}>{receipt.message}</Alert>}
    {summaries.length > 0 && summaries.map(item => <div key={item.id}>
      <strong>{item.title}</strong>
      {!item.available && <p className="hint">{item.reason || "Answer this request on the owner computer."}</p>}
      <Button size="xs" variant="light" disabled={busy || !connected || !active || !item.available || !!pending} onClick={() => void act(async current => {
        const value = await request<Read>(`/remote-approvals/${dispatchId}/${item.id}/read`, {});
        if (current()) { setRead(value); setReceipt(value.receipt ?? null); if(value.actionIntent?.state === "pending") { pendingStore[dispatchId]=value.actionIntent;setPending(value.actionIntent); } }
      })}>Review request</Button>
    </div>)}
    {approval && <div className="permission">
      <Badge color="orange">Permission needed</Badge><h3>{approval.title}</h3>
      <p>Owner: {owner}. Review this {approval.kind === "command" ? "command" : "file change"} before continuing.</p>
      {details(approval)}
      <details><summary>All request details</summary><pre style={{overflow:"auto",maxHeight:260}}>{JSON.stringify(approval.details,null,2)}</pre></details>
      <Group>{approval.decisions.map(decision => <Button size="xs" key={decision} variant={decision.toLowerCase().includes("accept") ? "filled" : "light"}
        disabled={!connected || busy || !active || !available || !!pending} onClick={() => {
          if(pendingStore[dispatchId]) return;
          const answer = { approvalId: approval.id, requestId: crypto.randomUUID(), expectedDigest: read!.digest!, decision };
          pendingStore[dispatchId] = answer; setPending(answer);
          void act(current => send(answer, current));
        }}>{{accept:"Allow once",decline:"Decline",cancel:"Cancel"}[decision] || decision}</Button>)}</Group>
    </div>}
  </Stack>;
}
