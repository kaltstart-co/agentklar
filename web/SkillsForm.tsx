import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";

type Harness = "codex" | "claude";
type Scope = "project" | "personal";
const workflowSource = "kaltstart-co/agentklar#v0.1.0-beta.23";
type Item = {
  id: string | null;
  harness: Harness;
  name: string;
  path: string;
  state: string;
  source: string | null;
  message: string | null;
};
type Preview = {
  id: string;
  harness: Harness;
  name: string;
  source: string;
  path: string;
  text: string;
  files: { path: string; bytes: number }[];
  upstreamHash: string | null;
  sourceVersion: string | null;
  installerVersion: string;
  expiresAt: string;
  updateInstallId: string | null;
  hasChanges: boolean;
  unchanged?: boolean;
  currentText: string | null;
  currentFiles: { path: string; bytes: number }[] | null;
};
async function request<T>(
  base: string,
  operation = "",
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `${base}${operation}`,
    {
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Skill request failed.");
  return data;
}
export function SkillsForm({
  projectId,
  connected,
}: {
  projectId?: string;
  connected: boolean;
}) {
  const [scope, setScope] = useState<Scope>(projectId ? "project" : "personal");
  const base = scope === "project" && projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/skills`
    : "/api/skills";
  const [harness, setHarness] = useState<Harness>("codex");
  const [drafts, setDrafts] = useState<
    Record<Harness, { source: string; name: string }>
  >({ codex: { source: "", name: "" }, claude: { source: "", name: "" } });
  const [items, setItems] = useState<Item[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const currentConnected = useRef(connected);
  currentConnected.current = connected;
  async function refresh() {
    const id = ++generation.current;
    setBusy("refresh");
    setError("");
    try {
      const data = await request<{ skills: Item[] }>(base);
      if (id === generation.current && currentConnected.current)
        setItems(data.skills);
    } catch (e) {
      if (id === generation.current) setError((e as Error).message);
    } finally {
      if (id === generation.current) setBusy("");
    }
  }
  useEffect(() => {
    if (!projectId && scope === "project") { setScope("personal"); return; }
    if (connected) void refresh();
    else {
      setBusy("");
      setPreview(null);
    }
    return () => {
      generation.current++;
    };
  }, [projectId, scope, connected]);
  const draft = drafts[harness];
  function edit(field: "source" | "name", value: string) {
    generation.current++;
    setDrafts((v) => ({ ...v, [harness]: { ...v[harness], [field]: value } }));
    setPreview(null);
    setNotice("");
  }
  function useWorkflowSource() {
    generation.current++;
    setDrafts((v) => ({ ...v, [harness]: { source: workflowSource, name: "agentklar-workflow" } }));
    setPreview(null);
    setNotice("");
    setError("");
  }
  async function act(
    operation: "preview" | "preview-update" | "install" | "update" | "remove",
    body: unknown,
  ) {
    const id = ++generation.current;
    setBusy(operation);
    setError("");
    setNotice("");
    try {
      const result = await request<Preview>(base, `/${operation}`, body);
      if (id !== generation.current || !currentConnected.current) return;
      if (operation === "preview" || operation === "preview-update") setPreview(result);
      else {
        setPreview(null);
        setNotice(
          result.unchanged
            ? "Already up to date."
            : operation === "update"
            ? "Skill updated. Start a new native session to load it."
            : operation === "install"
            ? "Skill installed. Start a new native session to load it."
            : "Managed skill removed. Start a new native session to unload it.",
        );
        const data = await request<{ skills: Item[] }>(base);
        if (id === generation.current) setItems(data.skills);
      }
    } catch (e) {
      if (id === generation.current) {
        setError((e as Error).message);
        if (operation !== "remove") setPreview(null);
      }
    } finally {
      if (id === generation.current) setBusy("");
    }
  }
  return (
    <section className="content-panel instructions-panel">
      <h2>Skills</h2>
      <p className="muted">
        Add one skill from a GitHub repo to this project or your personal skill folder.
        Shared .agents/skills works with Codex and OpenCode. Claude Code uses .claude/skills.
        OpenCode can read both folders unless native compatibility is disabled.
        {scope === "project" && " Muse can read both project folders."}
      </p>
      <p className="hint">
        Review the skill text and full file list before installing or updating.
        Updates use the saved source and need your review each time. Skills may
        tell a future agent to run commands. Native trust, compatibility, and
        activation affect loading. Start a new native session after a change.
      </p>
      <Stack gap="sm">
        <Select
          label="Scope"
          value={scope}
          disabled={Boolean(busy)}
          data={[
            ...(projectId ? [{ value: "project", label: "This project" }] : []),
            { value: "personal", label: "All projects on this computer" },
          ]}
          allowDeselect={false}
          onChange={(v) => {
            generation.current++;
            setScope(v as Scope);
            setItems([]);
            setPreview(null);
            setError("");
            setNotice("");
          }}
        />
        {scope === "personal" && <p className="hint">Uses the default personal folders in your home directory. A custom native profile may use a different folder.</p>}
        <Select
          label="Native skill folder"
          value={harness}
          disabled={Boolean(busy)}
          data={[
            { value: "codex", label: scope === "personal" ? "Shared · ~/.agents/skills" : "Shared · .agents/skills" },
            { value: "claude", label: scope === "personal" ? "Claude · ~/.claude/skills" : "Claude · .claude/skills" },
          ]}
          allowDeselect={false}
          onChange={(v) => {
            generation.current++;
            setHarness(v as Harness);
            setPreview(null);
            setError("");
            setNotice("");
          }}
        />
        <details>
          <summary>Add a skill from GitHub</summary>
          <Stack gap="sm" mt="sm">
            <Button size="xs" variant="subtle" style={{ alignSelf: "flex-start" }} disabled={Boolean(busy)} onClick={useWorkflowSource}>Use AgentKlar workflow</Button>
            <TextInput
              label="GitHub repository"
              placeholder="vercel-labs/skills"
              disabled={Boolean(busy)}
              value={draft.source}
              onChange={(e) => edit("source", e.currentTarget.value)}
            />
            <TextInput
              label="Exact skill name"
              placeholder="find-skills"
              disabled={Boolean(busy)}
              value={draft.name}
              onChange={(e) => edit("name", e.currentTarget.value)}
            />
            <Button
              disabled={!connected || Boolean(busy)}
              loading={busy === "preview"}
              onClick={() =>
                void act("preview", {
                  harness,
                  source: draft.source,
                  name: draft.name,
                })
              }
            >
              Preview skill
            </Button>
          </Stack>
        </details>
        {preview && (
          <div className="instruction-preview">
            <h3>Review {preview.updateInstallId ? "update to " : ""}{preview.name}</h3>
            <p className="instruction-path">
              <code>{preview.path}</code>
            </p>
            <p className="hint">
              Source: {preview.source} · Ref:{" "}
              {preview.sourceVersion || "default branch"} · Installer:{" "}
              {preview.installerVersion} · Source hash:{" "}
              {preview.upstreamHash || "unavailable"}
            </p>
            {preview.updateInstallId && (
              <details>
                <summary>Current installed skill</summary>
                <pre>{preview.currentText}</pre>
                <ul>
                  {preview.currentFiles?.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code> · {file.bytes.toLocaleString()} bytes
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <h4>{preview.updateInstallId ? "Upstream SKILL.md" : "SKILL.md"}</h4>
            <pre>{preview.text}</pre>
            <h4>Files</h4>
            <ul>
              {preview.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code> · {f.bytes.toLocaleString()} bytes
                </li>
              ))}
            </ul>
            {!preview.hasChanges && <Alert color="teal">Already up to date.</Alert>}
            {preview.hasChanges && <Button
              disabled={!connected || Boolean(busy)}
              loading={busy === "install" || busy === "update"}
              onClick={() => void act(preview.updateInstallId ? "update" : "install", { previewId: preview.id })}
            >
              {preview.updateInstallId ? "Apply reviewed update" : "Install reviewed skill"}
            </Button>}
          </div>
        )}
        {error && <Alert color="red">{error}</Alert>}
        {notice && <Alert color="teal">{notice}</Alert>}
        <Group>
          <h3>Native {scope === "project" ? "project" : "personal"} skill folders</h3>
          <Button
            variant="subtle"
            size="xs"
            disabled={!connected || Boolean(busy)}
            loading={busy === "refresh"}
            onClick={() => void refresh()}
          >
            Refresh list
          </Button>
        </Group>
        {items.filter((item) => item.harness === harness).length ? (
          items
            .filter((item) => item.harness === harness)
            .map((item) => (
              <div key={`${item.harness}:${item.id || item.name}`}>
                <Group>
                  <strong>{item.name}</strong>
                  <Badge
                    color={
                      item.state === "installed"
                        ? "teal"
                        : item.state === "external"
                          ? "gray"
                          : "orange"
                    }
                  >
                    {item.state === "installed"
                      ? "AgentKlar managed"
                      : item.state}
                  </Badge>
                </Group>
                <p className="instruction-path">
                  <code>{item.path}</code>
                </p>
                {item.source && <p className="hint">Source: {item.source}</p>}
                {item.message && <p className="hint">{item.message}</p>}
                {item.id && item.state === "installed" && (
                  <Group>
                    <Button
                      size="xs"
                      variant="light"
                      disabled={!connected || Boolean(busy)}
                      loading={busy === "preview-update"}
                      onClick={() => void act("preview-update", { installId: item.id })}
                    >
                      Preview upstream update
                    </Button>
                    <Button
                      size="xs"
                      variant="light"
                      color="red"
                      disabled={!connected || Boolean(busy)}
                      loading={busy === "remove"}
                      onClick={() => void act("remove", { installId: item.id })}
                    >
                      Remove managed skill
                    </Button>
                  </Group>
                )}
              </div>
            ))
        ) : (
          <p className="hint">No {scope === "project" ? "project" : "personal"} skills found in this folder.</p>
        )}
      </Stack>
    </section>
  );
}
