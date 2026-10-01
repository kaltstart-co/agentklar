import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack, Textarea } from "@mantine/core";
import type { InstructionChange, InstructionDocument, InstructionFileId, InstructionPreview, InstructionSnapshot } from "../src/contracts.js";

const filenames = { agents: "AGENTS.md", claude: "CLAUDE.md" };
const fileUsers = { agents: "Codex + Muse", claude: "Claude Code" };
async function request<T>(projectId: string, suffix = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/instructions${suffix}`, {
    credentials: "same-origin",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "Could not read or change this file."), { status: response.status });
  return data;
}

export function InstructionsForm({ projectId, connected }: { projectId: string; connected: boolean }) {
  const [snapshot, setSnapshot] = useState<InstructionSnapshot | null>(null);
  const [file, setFile] = useState<InstructionFileId>("agents");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const currentConnected = useRef(connected);
  currentConnected.current = connected;
  async function refresh() {
    const id = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const data = await request<InstructionSnapshot>(projectId);
      if (id === generation.current && currentConnected.current) setSnapshot(data);
    } catch (e) {
      if (id === generation.current && currentConnected.current) setError((e as Error).message);
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setLoading(false);
    if (connected) void refresh();
    return () => { generation.current++; };
  }, [connected, projectId, file]);
  const metadata = snapshot?.files.find((entry) => entry.id === file);
  return <section className="content-panel instructions-panel">
    <h2>Native project instructions</h2>
    <p className="muted">Edit this project's root instruction files. Codex and Muse can read AGENTS.md. Claude Code reads CLAUDE.md. Muse checks AGENTS.md first and can use CLAUDE.md when AGENTS.md is absent.</p>
    <p className="hint">Muse loads trusted project rules. Native settings, parent files, and active sessions can affect what loads. Start a new native session to check.</p>
    <Group justify="space-between">
      <Select style={{ width: "min(100%, 360px)" }} label="Instruction file" value={file} onChange={(value) => setFile(value as InstructionFileId)} allowDeselect={false}
        data={Object.entries(filenames).map(([value, label]) => ({ value, label: `${label} · ${fileUsers[value as InstructionFileId]}` }))} />
      <Button variant="subtle" size="xs" disabled={!connected} loading={loading} onClick={() => void refresh()}>Refresh file status</Button>
    </Group>
    {error && <Alert color="red">{error}</Alert>}
    {metadata && <><p className="instruction-path"><code>{metadata.path}</code> <Badge variant="light" color={metadata.status === "unavailable" ? "orange" : "gray"}>{metadata.status}</Badge></p>
      {metadata.message && <p className="hint">{metadata.message}</p>}</>}
    {(["agents", "claude"] as const).map((editorFile) => (
      <div key={editorFile} hidden={editorFile !== file}>
        <InstructionEditor projectId={projectId} file={editorFile} connected={connected} active={editorFile === file}
          unavailable={snapshot?.files.find((entry) => entry.id === editorFile)?.status === "unavailable"}
          agentsPresent={snapshot?.files.some((entry) => entry.id === "agents" && entry.status === "present") || false}
          claudePresent={snapshot?.files.some((entry) => entry.id === "claude" && entry.status === "present") || false}
          changes={snapshot?.changes || []} refresh={refresh} />
      </div>
    ))}
  </section>;
}

function InstructionEditor({ projectId, file, connected, active, unavailable, agentsPresent, claudePresent, changes, refresh }: {
  projectId: string; file: InstructionFileId; connected: boolean; active: boolean; unavailable: boolean; agentsPresent: boolean; claudePresent: boolean; changes: InstructionChange[]; refresh: () => Promise<void>;
}) {
  const [document, setDocument] = useState<InstructionDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<InstructionPreview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const currentConnected = useRef(connected);
  currentConnected.current = connected && active;
  useEffect(() => {
    generation.current++;
    setBusy("");
    setPreview(null);
    return () => { generation.current++; };
  }, [connected, active]);
  const bytes = new TextEncoder().encode(draft).byteLength;
  const dirty = Boolean(document && draft !== document.text);
  async function load() {
    if (!connected || !active || busy) return;
    const id = ++generation.current;
    setBusy("load"); setError(""); setNotice("");
      try {
        const value = await request<InstructionDocument>(projectId, `/${file}`);
        if (id !== generation.current || !currentConnected.current) return;
        setDocument(value); setDraft(value.text); setPreview(null); setConflict(false);
      } catch (e) { if (id === generation.current && currentConnected.current) setError((e as Error).message); }
      finally { if (id === generation.current) setBusy(""); }
  }
  async function propose() {
    if (!connected || !active || busy || !document || bytes > 32768 || conflict) return;
    const id = ++generation.current;
    setBusy("preview"); setError(""); setNotice("");
      try {
        const value = await request<InstructionPreview>(projectId, "/preview", { file, text: draft, expectedHash: document.hash });
        if (id === generation.current && currentConnected.current) setPreview(value);
      } catch (e) {
        if (id === generation.current && currentConnected.current) { setError((e as Error).message); setConflict((e as { status?: number }).status === 409); setPreview(null); }
      } finally { if (id === generation.current) setBusy(""); }
  }
  async function change(undo?: InstructionChange) {
    if (!connected || !active || busy || !document || (!undo && !preview)) return;
    const id = ++generation.current;
    setBusy(undo ? "undo" : "apply"); setError(""); setNotice("");
      try {
        await request<InstructionChange>(projectId, undo ? "/rollback" : "/apply", undo ? { changeId: undo.id } : { previewId: preview!.id });
        if (id !== generation.current || !currentConnected.current) return;
        const value = await request<InstructionDocument>(projectId, `/${file}`);
        if (id !== generation.current || !currentConnected.current) return;
        setDocument(value); setDraft(value.text); setPreview(null); setConflict(false);
        setNotice(undo ? "Change undone." : "Instruction file saved.");
        await refresh();
      } catch (e) {
        if (id === generation.current && currentConnected.current) { setError((e as Error).message); setConflict((e as { status?: number }).status === 409); setPreview(null); }
      } finally { if (id === generation.current) setBusy(""); }
  }
  const history = changes.filter((entry) => entry.file === file);
  const latest = history.find((entry) => entry.state === "applied" && entry.operation === "apply");
  return <Stack mt="md">
    {error && <Alert color={conflict ? "orange" : "red"} title={conflict ? "File changed on disk" : "Could not complete request"}>{error}{conflict && <p>Your draft is still here. Reload the file to replace this draft with the current file.</p>}</Alert>}
    {notice && <Alert color="teal">{notice}</Alert>}
    <Group>
      <Button variant="light" loading={busy === "load"} disabled={!connected || Boolean(busy) || unavailable} onClick={() => void load()}>{document ? "Reload file (replaces draft)" : "Load file"}</Button>
      {latest && <Button variant="subtle" disabled={!connected || Boolean(busy) || !document || dirty} loading={busy === "undo"} onClick={() => void change(latest)}>Undo latest change</Button>}
    </Group>
    {document && <>
      <Textarea label={filenames[file]} description={`${bytes.toLocaleString()} / 32,768 UTF-8 bytes. Changes are saved only after preview and apply.`}
        value={draft} rows={12} disabled={!connected || Boolean(busy)} onChange={(event) => { generation.current++; setDraft(event.currentTarget.value); setPreview(null); setNotice(""); }} />
      {bytes > 32768 && <Alert color="orange">Keep the file within 32 KiB (32,768 UTF-8 bytes).</Alert>}
      <Button style={{ alignSelf: "flex-start" }} disabled={!connected || Boolean(busy) || conflict || bytes > 32768} loading={busy === "preview"} onClick={() => void propose()}>Preview changes</Button>
    </>}
    {preview && <div className="instruction-preview">
      <h3>Proposed change</h3>
      <p className="instruction-path"><code>{preview.path}</code></p>
      {file === "agents" && preview.before === null && claudePresent && <Alert color="orange">Creating AGENTS.md makes Muse read it before CLAUDE.md in this folder.</Alert>}
      {file === "claude" && preview.before === null && agentsPresent && <Alert color="orange">Creating CLAUDE.md may stop Claude from loading AGENTS.md under its default settings.</Alert>}
      <details open={preview.before !== preview.after}>
        <summary>{preview.before === preview.after ? "No content change · show file" : "Before and after"}</summary>
        <h3>Before</h3><pre>{preview.before === null ? "File does not exist." : preview.before || "Empty file."}</pre>
        <h3>After</h3><pre>{preview.after || "Empty file."}</pre>
      </details>
      <Button mt="sm" disabled={!connected || Boolean(busy) || preview.before === preview.after} loading={busy === "apply"} onClick={() => void change()}>Apply change</Button>
    </div>}
    <details><summary>Recent changes{history.length ? ` · ${history.length}` : ""}</summary>
      {history.some((entry) => entry.state === "interrupted") && (
        <p className="hint">An interrupted change can be undone only if the native file still matches that change. Load the file first. Save or reload any unsaved draft before undoing.</p>
      )}
      {history.length ? history.map((entry) => <div key={entry.id}>
        <p className="hint">{new Date(entry.createdAt).toLocaleString()} · {entry.operation} · {entry.state}{entry.message && ` · ${entry.message}`}</p>
        {entry.state === "interrupted" && (
          <Button size="xs" variant="light" disabled={!connected || Boolean(busy) || !document || dirty}
            loading={busy === "undo"} onClick={() => void change(entry)}>Try undo</Button>
        )}
      </div>) : <p className="hint">No saved changes for this file.</p>}
    </details>
  </Stack>;
}
