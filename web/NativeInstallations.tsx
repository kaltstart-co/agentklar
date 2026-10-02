import { useState } from "react";
import { Alert, Button, Select, Stack } from "@mantine/core";
import type { NativeInstallationStatus, Snapshot } from "../src/contracts.js";

export function NativeInstallations({ device, request }: { device: Snapshot["device"]; request: <T>(path: string, body?: unknown) => Promise<T> }) {
  const [entries, setEntries] = useState<NativeInstallationStatus[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function refresh() {
    setBusy(true); setError("");
    try { setEntries(await request<NativeInstallationStatus[]>("/native-installations")); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save(entry: NativeInstallationStatus) {
    const installation = entry.installations.find((item) => item.path === (choices[entry.harness] ?? entry.saved ?? entry.selected));
    if (!installation) return;
    setBusy(true); setError("");
    try {
      const reply = await request<{ restartRequired: boolean }>("/native-installations", { harness: entry.harness, path: installation.path, fingerprint: installation.fingerprint });
      setNotice(reply.restartRequired ? "Choice saved for this computer. After all jobs finish, restart AgentKlar to use it. Running jobs keep their current CLI." : "This installation is already selected.");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Stack gap="sm">
    <h3>This computer</h3>
    <p>{device ? `${device.label} · ${device.platform}` : "Computer details are unavailable. Restart AgentKlar after updating."}</p>
    {device && <p className="hint">Device ID: {device.id}</p>}
    <p className="hint">Workers and native sign-in checks run on this computer. Each computer uses its own native accounts and project folders.</p>
    <Button variant="light" loading={busy} onClick={() => void refresh()}>Find native installations</Button>
    {error && <Alert color="red">{error}</Alert>}
    {notice && <Alert color="blue">{notice}</Alert>}
    {entries.map((entry) => <Stack gap="xs" key={entry.harness}>
      <strong>{entry.harness}</strong>
      <p className="hint">Current CLI: {entry.selected || "Not available"}</p>
      {(entry.restartRequired || (entry.saved && entry.selected === null)) && <Alert color="orange">{entry.selected === null
        ? `Saved CLI unavailable: ${entry.saved}. Review a listed installation and save it again.`
        : `Saved choice: ${entry.saved}. Restart after jobs finish to apply it.`}</Alert>}
      <Select label="Native installation on this computer" value={choices[entry.harness] ?? entry.saved ?? entry.selected} data={entry.installations.map((item) => ({ value: item.path, label: `${item.version || "Version unknown"} · ${item.path}` }))} onChange={(value) => setChoices({ ...choices, [entry.harness]: value || "" })} disabled={busy || !entry.installations.length} />
      <Button variant="light" disabled={busy || !entry.installations.some((item) => item.path === (choices[entry.harness] ?? entry.saved ?? entry.selected))} onClick={() => void save(entry)}>Save for next restart</Button>
    </Stack>)}
  </Stack>;
}
