import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack } from "@mantine/core";
import type { SetupChange, SetupHarness, SetupPreview, SetupStatus } from "../src/contracts.js";
async function request<T>(projectId: string, harness: SetupHarness, operation = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/setup/${harness}${operation ? `/${operation}` : ""}`, {
    credentials: "same-origin",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Native MCP setup could not finish.");
  return data;
}
export function NativeSetupForm({ projectId, connected }: { projectId: string; connected: boolean }) {
  const names = { codex: "Codex", claude: "Claude Code", muse: "Muse", opencode: "OpenCode", antigravity: "Antigravity" };
  const [harness, setHarness] = useState<SetupHarness>("codex");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [preview, setPreview] = useState<SetupPreview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const currentConnected = useRef(connected); currentConnected.current = connected;
  async function refresh() {
    const id = ++generation.current;
    setBusy("status"); setError(""); setPreview(null);
    try {
      const value = await request<SetupStatus>(projectId, harness);
      if (id === generation.current && currentConnected.current) setStatus(value);
    } catch (e) { if (id === generation.current && currentConnected.current) { setError((e as Error).message); setStatus(null); } }
    finally { if (id === generation.current) setBusy(""); }
  }
  useEffect(() => {
    setStatus(null); setPreview(null); setBusy(""); setNotice(""); setError("");
    if (connected) void refresh();
    return () => { generation.current++; };
  }, [projectId, harness, connected]);
  async function change(operation: "preview" | "apply" | "undo") {
    if (!connected || busy || (operation === "apply" && !preview) || (operation === "undo" && !status?.canUndo)) return;
    const id = ++generation.current;
    setBusy(operation); setError(""); setNotice("");
    try {
      if (operation === "preview") {
        const value = await request<SetupPreview>(projectId, harness, operation, {});
        if (id === generation.current && currentConnected.current) setPreview(value);
      } else {
        const result = await request<SetupChange>(projectId, harness, operation, operation === "apply" ? { previewId: preview!.id } : { changeId: status!.change!.id });
        if (id !== generation.current || !currentConnected.current) return;
        setPreview(null);
        setNotice(result.state === "applied" ? "AgentKlar entry added. Start or restart your native session to load it." : "AgentKlar entry removed. Restart your native session to unload it.");
        const value = await request<SetupStatus>(projectId, harness);
        if (id === generation.current && currentConnected.current) setStatus(value);
      }
    } catch (e) {
      if (id !== generation.current || !currentConnected.current) return;
      setError((e as Error).message); setPreview(null);
      try { const value = await request<SetupStatus>(projectId, harness); if (id === generation.current && currentConnected.current) setStatus(value); }
      catch { if (id === generation.current && currentConnected.current) setStatus(null); }
    } finally { if (id === generation.current) setBusy(""); }
  }
  return <Stack gap="sm">
    <Select label="Native harness" value={harness} allowDeselect={false} disabled={Boolean(busy) && busy !== "status"}
      data={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }, { value: "muse", label: "Muse" }, { value: "opencode", label: "OpenCode" }, { value: "antigravity", label: "Antigravity (MCP host)" }]} onChange={(value) => setHarness(value as SetupHarness)} />
    <p className="hint">{harness === "claude" ? "Local project scope · only this project's Claude Code sessions." : `User scope · available to your ${names[harness]} projects.`} Setup adds MCP access. Your native session keeps its trust and permission settings.</p>
    {harness === "antigravity" && <p className="hint">Connects your native Antigravity session to AgentKlar. Start or restart agy to load the entry. Antigravity workers are unavailable.</p>}
    {harness === "opencode" && <p className="hint">Checks local config files. Restart OpenCode to load the entry.</p>}
    {status && <div aria-live="polite"><Badge color={status.status === "configured" ? "teal" : status.status === "conflict" ? "orange" : "gray"} variant="light">{status.status === "configured" ? "Entry configured" : status.status}</Badge><p className="hint">{status.message}</p></div>}
    {error && <Alert color="red">{error}</Alert>}
    {notice && <Alert color="teal">{notice}</Alert>}
    {status?.change?.state === "interrupted" && <Alert color="orange">{status.change.message || "A setup change was interrupted. Refresh status and inspect native settings."}</Alert>}
    <Group>
      <Button size="xs" variant="light" disabled={!connected || Boolean(busy)} loading={busy === "status"} onClick={() => void refresh()}>Refresh native status</Button>
      <Button size="xs" disabled={!connected || Boolean(busy) || status?.status !== "missing"} loading={busy === "preview"} onClick={() => void change("preview")}>Preview connection</Button>
      {status?.canUndo && <Button size="xs" variant="subtle" disabled={!connected || Boolean(busy)} loading={busy === "undo"} onClick={() => void change("undo")}>{status.change?.state === "interrupted" ? "Try undo unchanged entry" : "Undo managed connection"}</Button>}
    </Group>
    {preview && <div className="instruction-preview">
      <h3>{preview.command ? "Native add command" : "Native settings change"} · {preview.scope} scope</h3>
      <p className="instruction-path">Native config <code>{preview.configPath}</code></p>
      {preview.cwd && <p className="instruction-path">Run in <code>{preview.cwd}</code></p>}
      {preview.command && <pre>{preview.command}</pre>}
      <details><summary>AgentKlar entry</summary><pre>{JSON.stringify(preview.entry, null, 2)}</pre></details>
      <p className="hint">The bridge uses this service's data home and port. It reads the private local token file. No token is added to native settings.</p>
      <Button mt="sm" disabled={!connected || Boolean(busy)} loading={busy === "apply"} onClick={() => void change("apply")}>Add to {names[harness]}</Button>
    </div>}
  </Stack>;
}
