import { useEffect, useRef, useState } from "react";
import { Alert, Button, Select, Stack } from "@mantine/core";
import type { Snapshot } from "../src/contracts.js";
import type { ChangePreview, ChangeApply } from "../src/changes.js";

type Preview = Omit<ChangePreview, "packet" | "applied"> & { applied?: Applied; packet: Omit<ChangePreview["packet"], "patch"> & { patch?: string; fileCount?: number; filesTruncated?: boolean } };
type Applied = ChangeApply & { continuations: { harness: "codex" | "claude"; cwd: string; display: string; freshSession: true }[] };

export function GitChanges({ runId, projectId, snapshot, connected, request }: {
  runId: string; projectId: string; snapshot: Snapshot; connected: boolean;
  request: <T>(path: string, body?: unknown) => Promise<T>;
}) {
  const [target, setTarget] = useState<string | null>(projectId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [saved, setSaved] = useState<{ id: string; projectId: string; createdAt: string; applied?: Applied }[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { setTarget(projectId); }, [runId, projectId]);
  useEffect(() => { generation.current++; setPreview(null); setApplied(null); setSaved([]); setError(""); setBusy(""); }, [runId, projectId, target, connected]);
  async function act(key: string, action: (current: () => boolean) => Promise<void>) {
    if (busy || !connected) return;
    const id = ++generation.current;
    const current = () => mounted.current && generation.current === id;
    setBusy(key); setError("");
    try { await action(current); }
    catch (e) { if (current()) setError((e as Error).message); }
    finally { if (current()) setBusy(""); }
  }
  return <details>
    <summary>Copy changes to a new local worktree</summary>
    <Stack gap="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <p className="hint">Prepare a saved Git patch from finished work. Review it here, then apply it to a new local worktree, a separate checkout. Applying does not merge changes or mark them reviewed.</p>
      <Select label="Local destination project" data={snapshot.projects.map((p) => ({ value: p.id, label: p.name }))} value={preview?.projectId || target} disabled={!connected || !!busy || !!applied} onChange={(value) => { setTarget(value); setPreview(null); setApplied(null); }} />
      <Button variant="light" disabled={!connected || !!busy || !target || !!applied} loading={busy === "prepare"} onClick={() => void act("prepare", async (current) => {
        setPreview(null);
        const value = await request<Preview>(`/runs/${runId}/changes/prepare`, { projectId: preview?.projectId || target });
        if (current()) { setPreview(value); setApplied(value.applied ?? null); }
      })}>Prepare and preview changes</Button>
      <Button variant="subtle" disabled={!connected || !!busy} loading={busy === "saved"} onClick={() => void act("saved", async (current) => {
        const value = await request<{ handoffs?: typeof saved }>(`/runs/${runId}/changes`);
        if (current()) setSaved(value.handoffs || []);
      })}>Find saved handoffs</Button>
      {saved.map((handoff) => <Button key={handoff.id} variant="subtle" disabled={!connected || !!busy} onClick={() => void act("recover", async (current) => {
        const value = await request<Preview>(`/changes/${handoff.id}`);
        if (current()) { setPreview(value); setApplied(value.applied ?? null); }
      })}>Open {handoff.applied ? "applied" : "prepared"} handoff · {snapshot.projects.find((p) => p.id === handoff.projectId)?.name || "local project"} · {new Date(handoff.createdAt).toLocaleString()}</Button>)}
      {error && <Alert color="red">{error}</Alert>}
      {preview && <>
        <p>From {snapshot.peers?.find((p) => p.deviceId === preview.packet.sourceDeviceId)?.label || (snapshot.device?.id === preview.packet.sourceDeviceId ? snapshot.device.label : "the source computer")}</p>
        <details><summary>Details</summary><p className="hint">Source device ID: {preview.packet.sourceDeviceId}<br />Source run ID: {preview.packet.sourceRunId}<br />Base commit: {preview.packet.baseCommit}<br />Source HEAD: {preview.packet.headCommit}<br />Patch digest: {preview.packet.digest}</p></details>
        <p>{preview.packet.fileCount ?? preview.packet.files.length} changed files. Snapshot prepared {new Date(preview.packet.createdAt).toLocaleString()}.</p>
        {(preview.packet.ignoredPaths.length > 0 || preview.packet.ignoredTruncated) && <Alert color="orange">
          Ignored files are excluded from this patch.
          <ul>{preview.packet.ignoredPaths.map((path) => <li key={path}>{path}</li>)}</ul>
          {preview.packet.ignoredTruncated && <p>More ignored paths exist. Check the owner checkout before continuing.</p>}
        </Alert>}
        {preview.packet.filesTruncated && <p className="hint">Showing the first {preview.packet.files.length} files. View the full patch to see every changed file.</p>}
        <ul>{preview.packet.files.map((file) => <li key={file.path}>{file.path} · +{file.added} / −{file.removed}</li>)}</ul>
        {preview.packet.patch === undefined ? <Button variant="subtle" disabled={!connected || !!busy} loading={busy === "diff"} onClick={() => void act("diff", async (current) => {
          const value = await request<Preview>(`/changes/${preview.id}?includePatch=true`);
          if (current()) { setPreview(value); setApplied(value.applied ?? null); }
        })}>View full patch</Button> : <details open><summary>Patch</summary><pre style={{ maxHeight: 260, overflow: "auto", maxWidth: "100%", fontSize: 12 }}>{preview.packet.patch}</pre></details>}
        <p className="hint">The destination needs this exact base commit. Text changes and supported new text files are included; unsupported changes block preparation with a reason. Original folders are preserved.</p>
        <Button disabled={!connected || !!busy || !!applied} loading={busy === "apply"} onClick={() => void act("apply", async (current) => {
          const value = await request<Applied>(`/changes/${preview.id}/apply`, { expectedDigest: preview.packet.digest, expectedBaseCommit: preview.packet.baseCommit });
          if (current()) setApplied(value);
        })}>Apply to a new local worktree</Button>
      </>}
      {applied && <Alert color="blue"><Stack gap="xs">
        <strong>Changes applied in a new worktree</strong>
        <p>Folder: {applied.workspace.path}<br />Branch: {applied.workspace.branch}</p>
        <p className="hint">Changes are staged in this new worktree. Review and test before committing. Your original folder was preserved.</p>
        {applied.continuations?.map((command) => <Stack gap="xs" key={command.harness}>
          <strong>Open a fresh {command.harness === "codex" ? "Codex" : "Claude Code"} session here</strong>
          <pre style={{ maxHeight: 160, overflow: "auto", maxWidth: "100%", fontSize: 12 }}>{command.display}</pre>
          <Button variant="light" onClick={() => void navigator.clipboard.writeText(command.display).catch(() => setError("Could not copy. Select the command text instead."))}>Copy native command</Button>
        </Stack>)}
        {!applied.continuations?.length && <p className="hint">Open this folder in your native harness to continue. No supported native CLI command is available.</p>}
      </Stack></Alert>}
    </Stack>
  </details>;
}
