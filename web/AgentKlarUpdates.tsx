import { useEffect, useRef, useState } from "react";
import { Alert, Button, CopyButton, Group, Stack } from "@mantine/core";
import type { UpdateStatus } from "../src/update.ts";

export function AgentKlarUpdates({ connected, request }: {
  connected: boolean;
  request: <T>(path: string, body?: unknown) => Promise<T>;
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0), inFlight = useRef(false);
  useEffect(() => {
    const id = ++generation.current;
    inFlight.current = false; setStatus(null); setError(""); setBusy(false);
    if (connected) void request<UpdateStatus>("/update")
      .then(value => { if (id === generation.current) setStatus(value); })
      .catch(e => { if (id === generation.current) setError((e as Error).message); });
    return () => { generation.current++; };
  }, [connected]);
  async function check() {
    if (!connected || inFlight.current) return;
    const id = ++generation.current;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const value = await request<UpdateStatus>("/update/check", {});
      if (id === generation.current) setStatus(value);
    } catch (e) { if (id === generation.current) setError((e as Error).message); }
    finally { if (id === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  return <section className="settings-card updates-card">
    <h3>AgentKlar updates</h3>
    <Stack gap="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      {!connected && <p className="hint">Open the local app to check its installed version.</p>}
      {status && <>
        <p>Installed version: <strong>{status.current}</strong></p>
        {(status.error || error) ? <Alert color="orange">{status.error || error} The available version is unknown.</Alert>
          : status.checkedAt && status.latest ? <p>{status.available ? `Update available: ${status.latest}` : `No newer compatible release. Latest: ${status.latest}`}</p>
          : <p className="hint">Release checks run when you select Check for update.</p>}
        {status.checkedAt && <p className="hint">Checked {new Date(status.checkedAt).toLocaleString()}</p>}
        <p className="hint">{status.installation.reason}</p>
        {status.installation.supported && <>
          <p className="hint">Save open drafts first. The terminal command refuses active workers. Reopen the dashboard after the update.</p>
          <Group gap="xs"><code>{status.command}</code><CopyButton value={status.command}>{({ copied, copy }) => <Button size="sm" variant="light" onClick={copy}>{copied ? "Copied" : "Copy update command"}</Button>}</CopyButton></Group>
        </>}
      </>}
      <Group gap="sm">
        <Button variant="default" disabled={!connected || busy} loading={busy} onClick={() => void check()}>Check service update</Button>
      </Group>
      {error && !status && <Alert color="red">{error}</Alert>}
    </Stack>
  </section>;
}
