import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Checkbox, Group, Select, Stack, TextInput } from "@mantine/core";
import type { NativeSettings, NativeSettingPreview } from "../src/native-settings.js";
import type { NativePlugins, PluginPreview } from "../src/plugins.js";

type SettingStatus = Awaited<ReturnType<NativeSettings["read"]>>;
type PluginStatus = Awaited<ReturnType<NativePlugins["status"]>>;
type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
async function localRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error("The local service could not be reached. Reconnect and try again."); }
  if (!response.ok) throw new Error(data.error || "The native change could not finish.");
  return data;
}

export function NativePreferences({ projectId, connected, request = localRequest }: { projectId: string; connected: boolean; request?: Request }) {
  const [harness, setHarness] = useState<"claude" | "codex">("claude");
  const [settings, setSettings] = useState<SettingStatus | null>(null);
  const [plugins, setPlugins] = useState<PluginStatus | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<string | null>(null);
  const [settingPreview, setSettingPreview] = useState<NativeSettingPreview | null>(null);
  const [pluginPreview, setPluginPreview] = useState<PluginPreview | null>(null);
  const [observeActivity, setObserveActivity] = useState(false);
  const [busy, setBusy] = useState("");
  const [settingError, setSettingError] = useState("");
  const [pluginError, setPluginError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const changing = useRef(false);
  const scope = `${projectId}:${harness}:${connected}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const requestRef = useRef(request); requestRef.current = request;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const valid = (id: number, originalScope: string) => id === generation.current && currentScope.current === originalScope && connected;

  async function refresh() {
    if (!connected || busy) return;
    const id = ++generation.current, originalScope = scope;
    setBusy("refresh"); setSettingError(""); setPluginError(""); setSettingPreview(null); setPluginPreview(null);
    await Promise.all([
      requestRef.current<SettingStatus>(`${base}/native-settings/${harness}`).then(value => {
        if (valid(id, originalScope)) { setSettings(value); setModel(value.model ?? ""); setEffort(value.effort); }
      }).catch(error => { if (valid(id, originalScope)) { setSettingError((error as Error).message); setSettings(null); } }),
      requestRef.current<PluginStatus>(`${base}/plugins`).then(value => {
        if (valid(id, originalScope)) setPlugins(value);
      }).catch(error => { if (valid(id, originalScope)) { setPluginError((error as Error).message); setPlugins(null); } }),
    ]);
    if (valid(id, originalScope)) setBusy("");
  }
  useEffect(() => {
    generation.current++;
    setSettings(null); setPlugins(null); setModel(""); setEffort(null); setSettingPreview(null); setPluginPreview(null); setObserveActivity(false);
    setBusy(""); setSettingError(""); setPluginError(""); setNotice("");
    // Start after resetting this scope; an old response cannot refill its draft.
    if (connected) {
      const id = ++generation.current, originalScope = scope;
      setBusy("refresh");
      void Promise.all([
        requestRef.current<SettingStatus>(`${base}/native-settings/${harness}`).then(value => {
          if (valid(id, originalScope)) { setSettings(value); setModel(value.model ?? ""); setEffort(value.effort); }
        }).catch(error => { if (valid(id, originalScope)) setSettingError((error as Error).message); }),
        requestRef.current<PluginStatus>(`${base}/plugins`).then(value => { if (valid(id, originalScope)) setPlugins(value); })
          .catch(error => { if (valid(id, originalScope)) setPluginError((error as Error).message); }),
      ]).finally(() => { if (valid(id, originalScope)) setBusy(""); });
    }
    return () => { generation.current++; };
  }, [projectId, harness, connected]);

  async function change(kind: "native-settings" | "plugins", operation: "preview" | "apply" | "undo", changeId?: string, field?: "model" | "effort") {
    if (!connected || busy || changing.current) return;
    const preview = kind === "plugins" ? pluginPreview : settingPreview;
    if ((operation === "apply" && !preview) || (operation === "undo" && !changeId)) return;
    changing.current = true;
    const id = ++generation.current, originalScope = scope;
    setBusy(`${kind}/${operation}`); setNotice("");
    const showError = kind === "plugins" ? setPluginError : setSettingError;
    showError("");
    const body = operation === "apply" ? { previewId: preview!.id } : operation === "undo" ? { changeId } : kind === "plugins" ? { observeActivity } : { harness, field, value: field === "model" ? model.trim() || null : effort };
    try {
      const result = await requestRef.current<NativeSettingPreview | PluginPreview>(`${base}/${kind}/${operation}`, body);
      if (!valid(id, originalScope)) return;
      if (operation === "preview") {
        if (kind === "plugins") setPluginPreview(result as PluginPreview); else setSettingPreview(result as NativeSettingPreview);
      } else {
        setSettingPreview(null); setPluginPreview(null);
        setNotice(operation === "undo" ? "Managed change undone. Start a new native session to load the settings." : "Change applied. Start a new native session or reload native plugins.");
      }
    } catch (error) {
      if (!valid(id, originalScope)) return;
      showError((error as Error).message); setSettingPreview(null); setPluginPreview(null);
    } finally {
      if (valid(id, originalScope) && operation !== "preview") {
        // Failed commands can leave a recoverable receipt. Read it before offering Undo.
        if (kind === "plugins") {
          try { const value = await requestRef.current<PluginStatus>(`${base}/plugins`); if (valid(id, originalScope)) setPlugins(value); }
          catch (error) { if (valid(id, originalScope)) { setPlugins(null); showError((error as Error).message); } }
        } else {
          try { const value = await requestRef.current<SettingStatus>(`${base}/native-settings/${harness}`); if (valid(id, originalScope)) { setSettings(value); setModel(value.model ?? ""); setEffort(value.effort); } }
          catch (error) { if (valid(id, originalScope)) { setSettings(null); showError((error as Error).message); } }
        }
      }
      if (valid(id, originalScope)) setBusy("");
      changing.current = false;
    }
  }
  const disabled = !connected || Boolean(busy);
  const efforts = harness === "claude" ? ["low", "medium", "high", "xhigh"] : ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const fallback = (value: string | null) => value ?? "Use native fallback";
  return <Stack gap="lg">
    <section>
      <h3>Native defaults</h3>
      <Select label="Native harness" value={harness} allowDeselect={false} disabled={disabled}
        data={[{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }]} onChange={value => setHarness(value as "claude" | "codex")} />
      <p className="hint">{harness === "codex" ? "User scope · affects all your Codex projects." : "Local project scope · affects only this project's Claude Code sessions."} Changes manage one default field at a time. Model access and supported effort values depend on your native CLI and account.</p>
      {settings && <p className="instruction-path">Native config <code>{settings.path}</code></p>}
      <TextInput label="Default model" placeholder="Use native fallback" value={model} disabled={disabled || !settings}
        onChange={event => { setModel(event.currentTarget.value); setSettingPreview(null); }} />
      <Group mt="xs">
        <Button size="sm" disabled={disabled || !settings} onClick={() => void change("native-settings", "preview", undefined, "model")}>Preview model</Button>
        <Button size="sm" variant="subtle" disabled={disabled || !settings} onClick={() => { setModel(""); setSettingPreview(null); }}>Clear model draft</Button>
      </Group>
      <Select mt="sm" label="Default effort" placeholder="Use native fallback" clearable value={effort} data={efforts} disabled={disabled || !settings}
        onChange={value => { setEffort(value); setSettingPreview(null); }} />
      <Button mt="xs" size="sm" disabled={disabled || !settings} onClick={() => void change("native-settings", "preview", undefined, "effort")}>Preview effort</Button>
      <p className="hint">An empty model or effort removes that managed default and uses the native fallback.</p>
      {settingError && <Alert color="red">{settingError}</Alert>}
      {settingPreview && <div className="instruction-preview">
        <h3>{settingPreview.key} · {settingPreview.scope}</h3>
        <p>Before: <code>{fallback(settingPreview.before)}</code></p><p>After: <code>{fallback(settingPreview.after)}</code></p>
        <p className="hint">{settingPreview.message}</p>
        <Button size="sm" disabled={disabled} loading={busy === "native-settings/apply"} onClick={() => void change("native-settings", "apply")}>Apply reviewed default</Button>
      </div>}
      {settings?.changes.filter(change => change.canUndo).map(receipt => <Group key={receipt.id} mt="xs">
        <Badge color={receipt.state === "interrupted" ? "orange" : "gray"}>{receipt.field} · {receipt.state}</Badge>
        <Button size="sm" variant="subtle" disabled={disabled} onClick={() => void change("native-settings", "undo", receipt.id)}>Undo unchanged {receipt.field}</Button>
      </Group>)}
      {settings?.changes.some(change => change.state === "interrupted" && !change.canUndo) && <Alert mt="sm" color="orange">A native change was interrupted. Its settings have changed since; inspect the native config before continuing.</Alert>}
    </section>
    <section>
      <h3>Claude workflow plugin</h3>
      <p className="hint">A real native plugin with the AgentKlar workflow skill. Local project scope. Individual skill installs stay separate.</p>
      {plugins && <><Badge color={plugins.available ? "teal" : "orange"}>{plugins.available ? "Native plugin commands available" : "Native plugin commands unavailable"}</Badge><p className="hint">{plugins.message}</p></>}
      {pluginError && <Alert color="red">{pluginError}</Alert>}
      <Checkbox mt="sm" label="Show Claude sessions in Work" description="Records session signals. Prompts, conversations and tool inputs stay in Claude." checked={observeActivity} disabled={disabled} onChange={event => { setObserveActivity(event.currentTarget.checked); setPluginPreview(null); }} />
      <Button size="sm" disabled={disabled || !plugins?.available} loading={busy === "plugins/preview"} onClick={() => void change("plugins", "preview")}>Preview workflow plugin</Button>
      {pluginPreview && <div className="instruction-preview">
        <h3>{pluginPreview.name} · {pluginPreview.version}</h3>
        <p>{pluginPreview.scope} · {pluginPreview.capabilities.skills.length} skill · {pluginPreview.capabilities.agents} agents · {pluginPreview.capabilities.hooks} hooks · {pluginPreview.capabilities.mcpServers} MCP servers</p>
        <p className="hint">{pluginPreview.message}</p>
        <details><summary>Reviewed native commands and package</summary><pre>{JSON.stringify({ commands: pluginPreview.commands, manifest: pluginPreview.manifest, files: pluginPreview.files }, null, 2)}</pre></details>
        <Button mt="sm" size="sm" disabled={disabled} loading={busy === "plugins/apply"} onClick={() => void change("plugins", "apply")}>Install reviewed plugin</Button>
      </div>}
      {plugins?.changes.filter(receipt => receipt.state !== "undone").map(receipt => <div key={receipt.id} className="instruction-preview">
        <Group><Badge>{receipt.version} · {receipt.state}</Badge><Badge color={receipt.installed && plugins.available ? "teal" : "gray"}>{!plugins.available ? "Install state unavailable" : receipt.installed ? "Installed" : "Not installed"}</Badge><Badge color={receipt.recognized ? "teal" : "gray"}>{receipt.recognized ? "Components recognized at install" : "Recognition unverified"}</Badge></Group>
        <p className="hint">{receipt.message}</p>
        {receipt.canUndo && <Button size="sm" variant="subtle" disabled={disabled} onClick={() => void change("plugins", "undo", receipt.id)}>Undo unchanged plugin</Button>}
      </div>)}
    </section>
    {notice && <Alert color="teal">{notice}</Alert>}
    <Button size="sm" variant="light" disabled={disabled} loading={busy === "refresh"} onClick={() => void refresh()}>Refresh native defaults and plugins</Button>
  </Stack>;
}
