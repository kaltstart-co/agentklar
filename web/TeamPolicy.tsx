import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Select } from "@mantine/core";
import type { Project, RoutingPreset } from "../src/contracts.js";

export function TeamPolicy({ project, connected, request, onSaved }: {
  project: Project;
  connected: boolean;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  onSaved: () => Promise<void>;
}) {
  const [presets, setPresets] = useState<RoutingPreset[]>([]);
  const [presetId, setPresetId] = useState(project.routingPreset?.id ?? project.preference);
  const [mode, setMode] = useState<"manual" | "automatic">(project.delegationMode ?? "manual");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const savedPolicy = JSON.stringify([project.routingPreset, project.preference, project.delegationMode]);
  useEffect(() => {
    setPresetId(project.routingPreset?.id ?? project.preference);
    setMode(project.delegationMode ?? "manual");
    setNotice("");
  }, [project.id, savedPolicy]);
  useEffect(() => {
    const current = ++generation.current;
    setPresets([]); setError(""); setSaving(false);
    if (!connected) { setLoading(false); return; }
    setLoading(true);
    void request<RoutingPreset[]>("/routing-presets")
      .then(value => { if (generation.current === current) setPresets(value); })
      .catch(reason => { if (generation.current === current) setError((reason as Error).message); })
      .finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current++; };
  }, [project.id, connected]);
  const selected = presets.find(preset => preset.id === presetId);
  async function apply() {
    if (!connected || saving || !selected) return;
    const current = generation.current;
    setSaving(true); setError(""); setNotice("");
    try {
      await request(`/projects/${project.id}`, { routingPresetId: selected.id, delegationMode: mode }, "PATCH");
      if (generation.current !== current) return;
      await onSaved();
      if (generation.current === current) setNotice("Worker policy applied.");
    } catch (reason) { if (generation.current === current) setError((reason as Error).message); }
    finally { if (generation.current === current) setSaving(false); }
  }
  return <>
    <h2>Worker policy</h2>
    <Group align="end">
      <Select label="Routing preset" value={presetId} disabled={!connected || loading || saving}
        data={presets.map(preset => ({ value: preset.id, label: preset.name }))}
        onChange={value => { if (value) { setPresetId(value); setNotice(""); } }} />
      <Select label="Delegation" value={mode} disabled={!connected || saving}
        data={[{ value: "manual", label: "Only when I ask" }, { value: "automatic", label: "Use team when helpful" }]}
        onChange={value => { if (value) { setMode(value as typeof mode); setNotice(""); } }} />
      <Button loading={saving} disabled={!connected || loading || !selected} onClick={() => void apply()}>Apply policy</Button>
    </Group>
    <p className="hint">{mode === "manual"
      ? "Claude Code and Codex keep work in the current session. Ask them to use AgentKlar when you want a worker."
      : "Claude Code and Codex may delegate larger independent tasks when useful. Saying ‘work directly’ or ‘no delegation’ overrides this setting."}</p>
    {selected && <p className="hint">{selected.name}: routine → {selected.rules.routine}, standard → {selected.rules.standard}, hard → {selected.rules.hard}.
      {selected.rules.adjustToAllowance ? ` Adjusts to known allowance at ${selected.rules.lowAllowancePercent}% and ${selected.rules.highAllowancePercent}%.` : " Uses fixed tiers."} Explicit role and model pins stay fixed.</p>}
    {error && <Alert color="red">{error}</Alert>}
    {notice && <p role="status" className="hint">{notice}</p>}
  </>;
}
