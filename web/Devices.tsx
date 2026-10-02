import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack, Textarea, TextInput } from "@mantine/core";
import type { Snapshot } from "../src/contracts.js";

type Device = NonNullable<Snapshot["device"]>;
type Peer = { id: string; label: string; deviceId: string; sshHost: string; command: string; projectId: string; remoteProjectId: string; grantId: string; lastObservedAt?: string; lastError?: string };
type Grant = { id: string; sourceDeviceId: string; projectId: string; revoked: boolean };
type Settings = { launch?: { nodePath: string; command: string }; device: Device; peers: Peer[]; grants: Grant[]; projects: { id: string; name: string; path: string }[] };
type Export = { launch?: { nodePath: string; command: string }; id: string; sourceDeviceId: string; projectId: string; token: string };
const blank = { label: "", deviceId: "", sshHost: "", command: "agentklar", projectId: "", remoteProjectId: "", grantId: "", grantToken: "" };

export function Devices({ device, connected, request }: {
  device: Snapshot["device"]; projects?: Snapshot["projects"]; connected: boolean;
  request: <T>(path: string, body?: unknown) => Promise<T>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState(blank);
  const [connectionCode, setConnectionCode] = useState("");
  const [sourceDeviceId, setSourceDeviceId] = useState("");
  const [grantProject, setGrantProject] = useState<string | null>(null);
  const [exported, setExported] = useState<Export | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checks, setChecks] = useState<Record<string, { checkedAt?: string; error?: string }>>({});
  const generation = useRef(0);
  const currentConnected = useRef(connected);
  currentConnected.current = connected;
  async function load() {
    const data = await request<Settings>("/peers/settings");
    if (currentConnected.current) setSettings(data);
  }
  useEffect(() => {
    const id = ++generation.current;
    if (connected) void request<Settings>("/peers/settings").then((data) => {
      if (id === generation.current) setSettings(data);
    }).catch((e) => { if (id === generation.current) setError((e as Error).message); });
    else { setSettings(null); setExported(null); setDraft(blank); setConnectionCode(""); setChecks({}); }
    return () => { generation.current++; };
  }, [connected, request]);
  async function act(key: string, action: () => Promise<void>) {
    if (busy || !connected) return;
    setBusy(key); setError(""); setNotice("");
    try { await action(); }
    catch (e) { if (currentConnected.current) setError((e as Error).message); }
    finally { setBusy(""); }
  }
  const projectOptions = settings?.projects.map((p) => ({ value: p.id, label: `${p.name} · ${p.path}` })) || [];
  const disabled = !connected || !!busy;
  return <Stack gap="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <h3>Other computers</h3>
    <p className="hint">Each computer keeps its own project folders, native CLI choices and accounts. Saving a connection does not test it or start a job.</p>
    <details>
      <summary>Set up a connection</summary>
      <ol>
        <li>Install and start AgentKlar on each computer. Add the project folder on each one.</li>
        <li>Set up SSH access yourself and verify the remote computer's identity. Use an existing SSH host name below.</li>
        <li>On the computer that will run jobs, create a project grant for this computer's device ID.</li>
        <li>Copy its connection code here. Choose your matching local project, save, then test the connection.</li>
      </ol>
      <p className="hint">AgentKlar does not install software, create SSH keys, or sign in to native accounts through this form.</p>
    </details>
    {device && <Group><p className="hint">This computer: {device.label}</p><Button variant="subtle" onClick={() => void navigator.clipboard.writeText(device.id).then(() => setNotice("Computer ID copied. Paste it when granting this computer access on the other computer.")).catch(() => setError("Could not copy the computer ID."))}>Copy this computer ID</Button></Group>}
    {!connected && <Alert color="orange">Open the local AgentKlar app to manage computers.</Alert>}
    {error && <Alert color="red">{error}</Alert>}
    {notice && <Alert color="blue">{notice}</Alert>}
    <Button variant="subtle" disabled={disabled} loading={busy === "refresh"} onClick={() => void act("refresh", load)}>Refresh saved connections</Button>
    {settings && settings.peers.length === 0 && <p>No other computers saved.</p>}
    {settings?.peers.map((peer) => {
      const check = checks[peer.id];
      const checkedAt = check?.checkedAt || peer.lastObservedAt;
      const failure = check?.error || peer.lastError;
      return <Stack className="role-card" gap="xs" key={peer.id}>
        <Group justify="space-between"><strong>{peer.label}</strong><Badge color={failure ? "orange" : checkedAt ? "blue" : "gray"}>{failure ? "Check failed" : checkedAt ? "Previously verified" : "Not tested"}</Badge></Group>
        <p className="hint">{peer.sshHost} · {peer.command}</p>
        <p className="hint">Local project: {settings.projects.find((p) => p.id === peer.projectId)?.name || peer.projectId}<br />Remote project ID: {peer.remoteProjectId}<br />Remote device ID: {peer.deviceId}</p>
        {checkedAt && <p className="hint">Last verified: {new Date(checkedAt).toLocaleString()}. Current reachability is unknown until tested.</p>}
        {failure && <Alert color="orange">{failure}</Alert>}
        <Button variant="light" disabled={disabled} loading={busy === peer.id} onClick={() => void act(peer.id, async () => {
          try {
            const result = await request<{ device: Device; checkedAt: string }>("/peers/settings/test", { peerId: peer.id });
            setChecks((v) => ({ ...v, [peer.id]: { checkedAt: result.checkedAt } }));
            await load();
          } catch (e) {
            setChecks((v) => ({ ...v, [peer.id]: { error: (e as Error).message } }));
            throw e;
          }
        })}>Test connection</Button>
      </Stack>;
    })}
    <details>
      <summary>Add a computer and project mapping</summary>
      <form onSubmit={(e) => { e.preventDefault(); void act("save", async () => {
        if (connectionCode.length > 4096) throw new Error("Connection code is too long.");
        let code: unknown;
        try { code = JSON.parse(connectionCode); } catch { throw new Error("Paste the complete connection code from the other computer."); }
        const fields = code as Record<string, unknown> | null;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!fields || typeof fields !== "object" || Array.isArray(fields) ||
          !["deviceId", "remoteProjectId", "grantId"].every((key) => typeof fields[key] === "string" && uuid.test(fields[key] as string)) ||
          typeof fields.grantToken !== "string" || !/^[0-9a-f]{64}$/.test(fields.grantToken))
          throw new Error("This connection code is invalid. Copy a fresh code from the other computer.");
        if (fields.nodePath !== undefined && (typeof fields.nodePath !== "string" || !fields.nodePath.startsWith("/") || fields.nodePath.length > 1000 || /[\x00-\x1f]/.test(fields.nodePath) || typeof fields.command !== "string" || !fields.command.startsWith("/") || fields.command.length > 1000 || /[\x00-\x1f]/.test(fields.command)))
          throw new Error("The connection code has invalid launch paths. Copy a fresh code from the other computer.");
        await request<Peer>("/peers/settings/save", { ...draft, ...(fields.nodePath ? { nodePath: fields.nodePath, command: fields.command } : {}), deviceId: fields.deviceId, remoteProjectId: fields.remoteProjectId, grantId: fields.grantId, grantToken: fields.grantToken });
        setConnectionCode(""); setDraft(blank); setNotice("Connection saved. Test it to verify the remote computer and project grant."); await load();
      }); }}>
        <Stack gap="sm">
          <TextInput required label="Computer name" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.currentTarget.value })} disabled={disabled} />
          <TextInput required label="SSH host" description="An existing SSH host or user@host. No password or key goes here." value={draft.sshHost} onChange={(e) => setDraft({ ...draft, sshHost: e.currentTarget.value })} disabled={disabled} />
          <Select required label="Matching local project" data={projectOptions} value={draft.projectId || null} onChange={(value) => setDraft({ ...draft, projectId: value || "" })} disabled={disabled} />
          <Textarea required label="Connection code from the other computer" description="Contains a project grant token. Keep it private." autoComplete="off" maxLength={4096} minRows={3} value={connectionCode} onChange={(e) => setConnectionCode(e.currentTarget.value)} disabled={disabled} />
          <details><summary>Advanced connection settings</summary>
            <TextInput required label="Remote AgentKlar command" description="Use agentklar or its absolute path on that computer." value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.currentTarget.value })} disabled={disabled} />
          </details>
          <Button type="submit" disabled={disabled} loading={busy === "save"}>Save connection</Button>
        </Stack>
      </form>
    </details>
    <details>
      <summary>Allow another computer to use a project here</summary>
      <Stack gap="sm">
        <p className="hint">A grant lets the named device run work in one project on this computer using this computer's native accounts. Share its token only with that device.</p>
        <TextInput label="Computer ID allowed to connect" description="Paste the ID copied from the connecting computer." required value={sourceDeviceId} onChange={(e) => setSourceDeviceId(e.currentTarget.value)} disabled={disabled} />
        <Select label="Project on this computer" data={projectOptions} value={grantProject} onChange={setGrantProject} disabled={disabled} />
        <Button disabled={disabled || !sourceDeviceId || !grantProject} loading={busy === "grant"} onClick={() => void act("grant", async () => {
          setExported(null);
          const result = await request<Export>("/peers/settings/grant", { sourceDeviceId, projectId: grantProject });
          if (currentConnected.current) setExported(result);
          await load();
        })}>Create project grant</Button>
        {exported && <Alert color="blue"><Stack gap="xs">
          <p>Copy this connection code to the source computer now. The token will not be shown again after you leave this screen.</p>
          <Textarea label="Private connection code" value={JSON.stringify({ deviceId: settings?.device.id || device?.id, remoteProjectId: exported.projectId, grantId: exported.id, grantToken: exported.token, ...((exported.launch || settings?.launch) ?? {}) })} readOnly autoComplete="off" minRows={3} />
          <Button variant="light" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ deviceId: settings?.device.id || device?.id, remoteProjectId: exported.projectId, grantId: exported.id, grantToken: exported.token, ...((exported.launch || settings?.launch) ?? {}) })).then(() => setNotice("Private connection code copied.")).catch(() => setError("Could not copy. Select the connection code text instead."))}>Copy connection code</Button>
          <Button variant="subtle" onClick={() => setExported(null)}>Hide token</Button>
        </Stack></Alert>}
        {settings?.grants.map((grant) => <Group key={grant.id} justify="space-between">
          <p className="hint">{settings.projects.find((p) => p.id === grant.projectId)?.name || grant.projectId}<br />Source device: {grant.sourceDeviceId}</p>
          {grant.revoked ? <Badge color="gray">Revoked</Badge> : <Button color="orange" variant="light" disabled={disabled} onClick={() => void act(grant.id, async () => {
            await request("/peers/settings/revoke", { grantId: grant.id });
            if (exported?.id === grant.id) setExported(null);
            setNotice("Project grant revoked."); await load();
          })}>Revoke grant</Button>}
        </Group>)}
      </Stack>
    </details>
  </Stack>;
}
