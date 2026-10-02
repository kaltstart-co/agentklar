import { HarnessIcon } from "./HarnessIcon.js";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, CopyButton, Group, Select, Stack } from "@mantine/core";
import type { Harness, OnboardingPreferences, Project, SetupHarness, SetupStatus } from "../src/contracts.js";
import { NativeSetupForm } from "./NativeSetupForm.js";

const setupHarnesses: SetupHarness[] = ["codex", "claude", "muse", "opencode", "antigravity"];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function GuidedSetup({ project, projects, harnesses, preferences, connected, request, onSaved, onProjectSelected, onAddProject, onDone }: {
  project?: Project; projects: Project[]; harnesses: Harness[]; preferences: OnboardingPreferences | null; connected: boolean;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  onSaved: (preferences: OnboardingPreferences) => void; onProjectSelected: (id: string) => void;
  onAddProject: () => void; onDone: () => void;
}) {
  const [statuses, setStatuses] = useState<Partial<Record<SetupHarness, SetupStatus>>>({});
  const [failures, setFailures] = useState<Partial<Record<SetupHarness, string>>>({});
  const [active, setActive] = useState<SetupHarness | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [launchVisible, setLaunchVisible] = useState(false);
  const generation = useRef(0);
  const installed = harnesses.filter(h => h.available && setupHarnesses.includes(h.id as SetupHarness));
  const other = harnesses.filter(h => !installed.includes(h));
  const main = preferences?.projectId === project?.id ? preferences?.mainHarness : null;
  const mainName = harnesses.find(h => h.id === main)?.name;

  async function refresh() {
    const id = ++generation.current;
    setChecking(true); setError("");
    if (!project || !connected) { setChecking(false); return; }
    const next: Partial<Record<SetupHarness, SetupStatus>> = {}, errors: Partial<Record<SetupHarness, string>> = {};
    await Promise.all(installed.map(async h => {
      const key = h.id as SetupHarness;
      try { next[key] = await request<SetupStatus>(`/projects/${project!.id}/setup/${key}`); }
      catch (e) { errors[key] = (e as Error).message; }
    }));
    if (id === generation.current) { setStatuses(next); setFailures(errors); setChecking(false); }
  }
  const installations = installed.map(h => `${h.id}:${h.executable}`).join("|");
  useEffect(() => {
    setStatuses({}); setFailures({}); setActive(null); setLaunchVisible(false); setSaving(false);
    void refresh();
    return () => { generation.current++; };
  }, [project?.id, connected, installations]);

  async function remember(harness: SetupHarness) {
    if (!project || !preferences || saving || !connected) return;
    const id = generation.current;
    setSaving(true); setError("");
    try {
      const value = await request<OnboardingPreferences>("/onboarding", { projectId: project.id, mainHarness: harness, expectedRevision: preferences.revision }, "PUT");
      if (id === generation.current) { onSaved(value); setActive(null); setLaunchVisible(true); }
    } catch (e) { if (id === generation.current) setError((e as Error).message); }
    finally { if (id === generation.current) setSaving(false); }
  }

  return <section className="guided-setup" aria-labelledby="guided-setup-title">
    <div className="guided-heading">
      <span className="setup-kicker">YOUR SETUP</span>
      <h2 id="guided-setup-title">{project ? "Connect your harness" : "Start with a project"}</h2>
      <p className="hint">Keep working in your harness. See delegated work and results here.</p>
    </div>
    {!project ? <Stack gap="md">
      {projects.length > 0 && <Select label="Existing project" placeholder="Choose a project" data={projects.map(p => ({ value: p.id, label: p.name }))} onChange={id => { if (id) onProjectSelected(id); }} />}
      <Button disabled={!connected} onClick={onAddProject}>Add project folder</Button>
      <p className="hint">Use a folder that already exists on this computer.</p>
    </Stack> : <>
      <div className="guided-project"><div><strong>{project.name}</strong><p className="hint">{project.path}</p></div><Badge variant="light" color="gray">Project</Badge></div>
      {error && <Alert color="red" mt="md">{error}</Alert>}
      <div className="guided-section-heading"><h3>Installed harnesses</h3><Button size="sm" variant="subtle" loading={checking} disabled={saving || !connected} leftSection={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void refresh()}>Check connections</Button></div>
      {installed.length === 0 && <p className="hint">No supported connection was found. Open More harnesses for guidance, then check again after installing.</p>}
      <div className="guided-connections" aria-live="polite">
        {installed.map(h => {
          const key = h.id as SetupHarness, status = statuses[key], failure = failures[key];
          const interrupted = status?.change?.state === "interrupted";
          const configured = status?.status === "configured" && !interrupted, selected = main === key;
          return <div className="guided-harness" key={key}>
            <div className="guided-harness-row">
              <div><strong className="harness-label"><HarnessIcon harness={h.id} size={22} />{h.name}</strong><p className="hint">{failure ? "Connection check failed" : interrupted ? "Interrupted setup needs attention" : configured ? "MCP entry configured" : status?.status === "conflict" ? "Existing entry needs attention" : status?.status === "unavailable" ? "Native setup unavailable" : checking || !status ? "Checking connection…" : "Ready to connect"}</p></div>
              <Group gap="xs" wrap="nowrap">
                {selected && <Badge color="teal" variant="light">Main</Badge>}
                {configured && !selected ? <Button size="sm" variant="light" loading={saving} disabled={!preferences || checking || !connected} onClick={() => void remember(key)}>Use as main</Button>
                  : <Button size="sm" variant="light" disabled={checking || saving || !connected} onClick={() => { setActive(active === key ? null : key); setLaunchVisible(false); }}>{active === key ? "Close" : selected && configured ? "Manage" : status?.status === "missing" && !interrupted ? "Connect" : "Review setup"}</Button>}
              </Group>
            </div>
            {active === key && <div className="guided-connection-detail">
              {failure && <Alert color="red" mb="sm">{failure}</Alert>}
              <NativeSetupForm key={`${project.id}-${key}`} projectId={project.id} connected={connected} initialHarness={key} showSelector={false} previewOnLoad onStatus={next => setStatuses(current => ({ ...current, [key]: next }))} />
            </div>}
          </div>;
        })}
      </div>
      <p className="hint guided-evidence">Connections do not confirm sign-in, available tools or remaining quota. Your harness checks its own account when you open it.</p>
      {other.length > 0 && <details className="settings-disclosure"><summary>More harnesses</summary><div className="disclosure-body">
        {other.map(h => <div className="guided-other" key={h.id}><strong className="harness-label"><HarnessIcon harness={h.id} size={20} />{h.name}</strong><p className="hint">{h.available ? "Installed · guided MCP setup is not available yet. Use its native MCP settings." : "Not found · use its native installer. After tasks finish, restart AgentKlar to discover it."}</p></div>)}
      </div></details>}
      <div className="guided-footer">
        <Group gap="sm"><Button onClick={onDone}>{main ? "View work" : "Continue to work"}</Button>{main && <Button variant="default" leftSection={<ExternalLink size={15} aria-hidden="true" />} onClick={() => setLaunchVisible(!launchVisible)}>Open {mainName || "main harness"}</Button>}</Group>
        {launchVisible && main && <div className="guided-launch"><p className="hint">Run this in a terminal, then choose Open {mainName || "main harness"}.</p><pre><code>{`cd ${quote(project.path)}\nagentklar`}</code></pre><CopyButton value={`cd ${quote(project.path)}\nagentklar`}>{({ copied, copy }) => <Button variant="subtle" size="sm" leftSection={<Copy size={14} aria-hidden="true" />} onClick={copy}>{copied ? "Copied" : "Copy command"}</Button>}</CopyButton></div>}
      </div>
    </>}
  </section>;
}
