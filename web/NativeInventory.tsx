import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Stack } from "@mantine/core";
import type { NativeInventory as Inventory } from "../src/contracts.js";

const names: Record<string, string> = { codex: "Codex", claude: "Claude Code", muse: "Muse", opencode: "OpenCode", antigravity: "Antigravity" };
export function NativeInventory({ projectId, connected, request }: {
  projectId: string; connected: boolean;
  request: <T>(path: string, body?: unknown) => Promise<T>;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0), inFlight = useRef(false);
  useEffect(() => { generation.current++; inFlight.current = false; setInventory(null); setBusy(false); setError(""); return () => { generation.current++; }; }, [projectId, connected]);
  async function refresh() {
    if (!connected || inFlight.current) return;
    const id = ++generation.current; inFlight.current = true; setBusy(true); setInventory(null); setError("");
    try {
      const value = await request<Inventory>(`/projects/${projectId}/native-inventory`);
      if (id === generation.current) setInventory(value);
    } catch (e) { if (id === generation.current) setError((e as Error).message); }
    finally { if (id === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  return <details>
    <summary>Native config and extensions</summary>
    <Stack gap="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <p className="hint">Read source presence and bounded extension metadata for this project and computer. Config values stay private. Cached packages and manifests do not prove an extension is enabled or loaded in your native session.</p>
      <Button size="xs" variant="light" disabled={!connected || busy} loading={busy} onClick={() => void refresh()}>Refresh native inventory</Button>
      {!connected && <p className="hint">Reconnect the local service to read inventory.</p>}
      {error && <Alert color="red">{error}</Alert>}
      {inventory && <>
        <p className="hint">Observed {new Date(inventory.checkedAt).toLocaleString()}. Activation is unknown; native settings and sessions decide what loads.</p>
        {inventory.truncated && <Alert color="orange">Inventory reached its read limit. This is a partial view.</Alert>}
        {inventory.harnesses.map(item => <details key={item.harness}>
          <summary>{names[item.harness] || item.harness} · {item.sources.length} sources · {item.extensions.length} extension {item.extensions.length === 1 ? "record" : "records"}</summary>
          <Stack gap="xs">
            {item.coverage.map((message, index) => <p className="hint" key={index}>{message}</p>)}
            <details><summary>Source presence and scope</summary><Stack gap="xs">{item.sources.map((source, index) => <div key={index}>
              <Group gap="xs"><Badge variant="light" color={["present", "missing"].includes(source.status) ? "gray" : "orange"}>{source.status}</Badge><span>{source.scope} · {source.kind.replaceAll("-", " ")}</span></Group>
              <p className="hint">{source.path || "Path unavailable"}{source.pathTruncated ? " (path shortened)" : ""}</p>
              <p className="hint">{source.message}</p>
            </div>)}</Stack></details>
            <details><summary>Extension metadata</summary><Stack gap="xs">
              {!item.extensions.length && <p className="hint">No extension records in the inspected sources. Other native sources may exist.</p>}
              {item.extensions.map((extension, index) => <div key={index}>
                <strong>{extension.name}</strong><p className="hint">{extension.version ? `Version ${extension.version}` : "Version unknown"} · {extension.scope} · {extension.evidence === "cached-package" ? "Cached package" : "Project manifest"} · Activation unknown</p>
                <p className="hint">{extension.sourcePath}{extension.pathTruncated ? " (path shortened)" : ""}</p>
              </div>)}
              {item.extensionsTruncated && <Alert color="orange">Extension records are partial because the read limit was reached.</Alert>}
            </Stack></details>
          </Stack>
        </details>)}
      </>}
    </Stack>
  </details>;
}
