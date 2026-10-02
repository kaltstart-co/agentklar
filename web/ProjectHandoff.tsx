import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack } from "@mantine/core";
import type { ControlStatus, ControlPacket, ControlReceipt } from "../src/contracts.js";

type Control = ControlStatus;
type Packet = ControlPacket & { receipt?: ControlReceipt };
type History = { packets: { id: string; createdAt: string; contextRevision: number; controlRevision: number; receipt?: ControlReceipt }[]; nextOffset: number | null };
export function ProjectHandoff({ projectId, connected, request, onSelectRun, ownerLabel }: {
  projectId: string; connected: boolean; onSelectRun: (id: string) => void; ownerLabel: (id: string) => string;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
}) {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [offset, setOffset] = useState(0);
  const [control, setControl] = useState<Control | null>(null);
  const [mode, setMode] = useState<Control["mode"]>("advisory");
  const [review, setReview] = useState<"mode" | "recover" | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0), flight = useRef(false);
  const base = `/projects/${projectId}/control`;
  useEffect(() => { generation.current++; flight.current = false; setControl(null); setPacket(null); setHistory(null); setOffset(0); setReview(null); setError(""); setNotice(""); setBusy(""); }, [projectId, connected]);
  useEffect(() => () => { generation.current++; }, []);
  async function act(key: string, action: (current: () => boolean) => Promise<void>) {
    if (!connected || flight.current) return;
    const id = ++generation.current; flight.current = true; setBusy(key); setError(""); setNotice("");
    const current = () => generation.current === id;
    try { await action(current); }
    catch (e) { if (current()) { setError((e as Error).message); setReview(null); } }
    finally { if (current()) { flight.current = false; setBusy(""); } }
  }
  async function load(current: () => boolean) {
    const value = await request<Control>(base);
    if (current()) { setControl(value); setMode(value.mode); }
    return value;
  }
  return <details onToggle={event => { if (event.currentTarget.open && !control && !busy) void act("load", async current => { await load(current); }); }}>
    <summary>Switch main harness</summary>
    <Stack gap="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <p className="hint">Keep saved context and work references when another native harness takes over. Existing workers stay on their computers. Native sessions and permissions stay with their harness.</p>
      {error && <Alert color="red">{error} Refresh before trying again.</Alert>}
      {notice && <Alert color="teal">{notice}</Alert>}
      <Button size="sm" variant="light" disabled={!connected || !!busy} loading={busy === "load"} onClick={() => void act("load", async current => { setReview(null); await load(current); })}>Refresh handoff status</Button>
      <Group>
        <Button size="sm" disabled={!connected || !!busy} loading={busy === "prepare"} onClick={() => void act("prepare", async current => { const value = await request<Packet>(`${base}/prepare`, {}); if (current()) setPacket(value); })}>Prepare handoff</Button>
        <Button size="sm" variant="light" disabled={!connected || !!busy} onClick={() => void act("history", async current => { const value = await request<History>(`${base}/packets?offset=0&limit=10`); if (current()) { setHistory(value); setOffset(0); } })}>Saved handoffs</Button>
      </Group>
      {history && <Stack gap="xs">{history.packets.length ? history.packets.map(item => <Button key={item.id} size="sm" variant="subtle" style={{ height: "auto", whiteSpace: "normal" }} disabled={!connected || !!busy} onClick={() => void act("packet", async current => { const value = await request<Packet>(`${base}/packets/${item.id}`); if (current()) setPacket(value); })}>{new Date(item.createdAt).toLocaleString()} · {item.receipt ? "Accepted" : "Prepared"}</Button>) : <p className="hint">No saved handoffs.</p>}{history.nextOffset !== null && <Button size="sm" variant="light" disabled={!connected || !!busy} onClick={() => void act("history", async current => { const next = history.nextOffset!; const value = await request<History>(`${base}/packets?offset=${next}&limit=10`); if (current()) { setHistory(value); setOffset(next); } })}>Older handoffs</Button>}{offset > 0 && <p className="hint">Showing an older page.</p>}</Stack>}
      {packet && <Stack gap="sm">
        <h3>Saved handoff · {new Date(packet.createdAt).toLocaleString()}</h3>
        <Badge variant="light">{packet.receipt ? "Accepted by receiving harness" : "Prepared snapshot"}</Badge>
        {!packet.receipt && control && packet.control.revision !== control.revision && <Alert color="orange">Control changed after this snapshot. Prepare a fresh handoff before acceptance.</Alert>}
        {packet.receipt && <p className="hint">{packet.receipt.lead.clientName || "Unknown MCP client"} accepted {new Date(packet.receipt.acceptedAt).toLocaleString()}. This is a saved receipt; refresh status to see the current lead.</p>}
        <p className="hint">Saved context revision {packet.context.revision}. {packet.work.totalLocal} local and {packet.work.totalRemote} remote work references. These are observed states, not live completion checks.</p>
        <details><summary>Saved project context</summary><h4>Brief</h4><pre>{packet.context.brief || "No saved brief."}</pre><h4>Memory</h4><pre>{packet.context.memory || "No saved memory."}</pre><h4>Next steps</h4><pre>{packet.context.handoff || "No saved next steps."}</pre></details>
        <details><summary>Work references</summary><Stack gap="xs">
          {packet.work.local.map(item => <div key={item.id}><Button size="sm" variant="subtle" onClick={() => onSelectRun(item.id)}>View {item.harness} task · {item.state}</Button><p className="hint">Observed {new Date(item.updatedAt).toLocaleString()}{item.workspace?.path ? ` · ${item.workspace.path}${item.workspace.pathTruncated ? " (path shortened; read task for full path)" : ""}` : ""}{item.followUp ? ` · ${item.followUp.kind} of ${item.followUp.parentRunId}` : ""}</p></div>)}
          {packet.work.remote.map(item => <div key={item.id}><Button size="sm" variant="subtle" onClick={() => onSelectRun(item.id)}>View {ownerLabel(item.ownerDeviceId)} task · {item.state || "Owner state unknown"}</Button><p className="hint">{item.connection}{item.lastObservedAt ? ` · observed ${new Date(item.lastObservedAt).toLocaleString()}` : ""}</p></div>)}
          {(packet.work.totalLocal > packet.work.local.length || packet.work.totalRemote > packet.work.remote.length) && <p className="hint">Showing the first ten references of each kind. Read project history for the remaining work.</p>}
          <pre>{JSON.stringify(packet.work.pointers, null, 2)}</pre>
        </Stack></details>
        <details><summary>Receiving harness instructions</summary><p className="hint">Open your normal native harness with AgentKlar MCP. Read this saved packet and projects_list for current roles and cost preference. Review the context and work, then explicitly accept with a stable request ID. A stale packet needs a new prepare. The dashboard does not impersonate the receiving client.</p><pre>{`project_handoff({action:"read",projectId:"${projectId}",packetId:"${packet.id}"})
After review, project_handoff({action:"accept",projectId:"${projectId}",packetId:"${packet.id}",requestId:"YOUR_STABLE_UUID",expectedDigest:"${packet.digest}",expectedContextRevision:${packet.context.revision},expectedControlRevision:${packet.control.revision}})`}</pre><Button size="sm" variant="light" disabled={!connected || !!busy} onClick={() => { const id = generation.current; void navigator.clipboard.writeText(`Read AgentKlar project ${projectId} handoff ${packet.id} with project_handoff action read. Read projects_list for current roles and cost preference. Review saved context and work, then explicitly accept with a stable UUID and the packet's exact digest/context/control revisions.`).then(() => { if (generation.current === id) setNotice("Receiving harness pointer copied."); }).catch(() => { if (generation.current === id) setError("Could not copy. Use the displayed instructions."); }); }}>Copy handoff pointer</Button></details>
      </Stack>}
      {control && <>
        <Badge variant="light">{control.mode === "advisory" ? "Advisory lead" : "Coordinated control"}</Badge>
        <p className="hint">{control.lead ? `Current lead: ${control.lead.clientName || "Unknown MCP client"}.` : "No lead connected."} Client names are reported by the harness.</p>
        <details><summary>Project control setting</summary><Stack gap="sm">
          <Select label="Control mode" value={mode} data={[{ value: "advisory", label: "Advisory (default)" }, { value: "coordinated", label: "Coordinated" }]} disabled={!connected || !!busy} allowDeselect={false} onChange={value => { setMode(value as Control["mode"]); setReview(null); }} />
          <p className="hint">Coordinated control limits MCP task starts, worker stops and shared-context changes to the current lead. Reads and trusted human dashboard actions stay available. It does not control direct file edits or native permissions.</p>
          <Button size="sm" disabled={!connected || !!busy || mode === control.mode} onClick={() => setReview("mode")}>Review setting change</Button>
          {review === "mode" && <Alert color="orange">Change this project to {mode} control? Existing workers keep running.<Group mt="sm"><Button size="sm" disabled={!connected || !!busy} onClick={() => void act("mode", async current => { await request(base, { mode, expectedRevision: control.revision }, "PUT"); if (!current()) return; setReview(null); await load(current); if (current()) setNotice("Project control setting saved."); })}>Save reviewed setting</Button><Button size="sm" variant="subtle" onClick={() => setReview(null)}>Cancel</Button></Group></Alert>}
        </Stack></details>
        <details><summary>Recover a lost lead</summary><Stack gap="sm"><p className="hint">Release the observed lead so a native harness can claim coordination again. Existing workers continue. This does not approve native requests.</p><Button size="sm" disabled={!connected || !!busy || !control.lead} onClick={() => void act("review", async current => { const value = await load(current); if (current()) { setReview(value.lead ? "recover" : null); if (!value.lead) setNotice("No lead remains. Your native harness can claim coordination."); } })}>Review recovery</Button>{review === "recover" && control.lead && <Alert color="orange">Release {control.lead?.clientName || "the observed lead"}?<Group mt="sm"><Button size="sm" disabled={!connected || !!busy} onClick={() => void act("recover", async current => { await request(`${base}/recover`, { expectedRevision: control.revision, observedClaimId: control.lead?.claimId || null }); if (!current()) return; setReview(null); await load(current); if (current()) setNotice("Lead released. Your receiving harness can now claim coordination."); })}>Release reviewed lead</Button><Button size="sm" variant="subtle" onClick={() => setReview(null)}>Cancel</Button></Group></Alert>}</Stack></details>
      </>}
    </Stack>
  </details>;
}
