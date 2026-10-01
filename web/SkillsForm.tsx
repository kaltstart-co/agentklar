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
};
async function request<T>(
  projectId: string,
  operation = "",
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/skills${operation}`,
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
  projectId: string;
  connected: boolean;
}) {
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
      const data = await request<{ skills: Item[] }>(projectId);
      if (id === generation.current && currentConnected.current)
        setItems(data.skills);
    } catch (e) {
      if (id === generation.current) setError((e as Error).message);
    } finally {
      if (id === generation.current) setBusy("");
    }
  }
  useEffect(() => {
    if (connected) void refresh();
    else {
      setBusy("");
      setPreview(null);
    }
    return () => {
      generation.current++;
    };
  }, [projectId, connected]);
  const draft = drafts[harness];
  function edit(field: "source" | "name", value: string) {
    generation.current++;
    setDrafts((v) => ({ ...v, [harness]: { ...v[harness], [field]: value } }));
    setPreview(null);
    setNotice("");
  }
  async function act(
    operation: "preview" | "install" | "remove",
    body: unknown,
  ) {
    const id = ++generation.current;
    setBusy(operation);
    setError("");
    setNotice("");
    try {
      const result = await request<Preview>(projectId, `/${operation}`, body);
      if (id !== generation.current || !currentConnected.current) return;
      if (operation === "preview") setPreview(result);
      else {
        setPreview(null);
        setNotice(
          operation === "install"
            ? "Skill installed. Start a new native session to load it."
            : "Managed skill removed. Start a new native session to unload it.",
        );
        const data = await request<{ skills: Item[] }>(projectId);
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
      <h2>Project skills</h2>
      <p className="muted">
        Add one skill from a GitHub repo to this project's native skill folder.
        Codex uses .agents/skills. Claude Code uses .claude/skills. Codex's
        folder may also be read by other native tools.
      </p>
      <p className="hint">
        Review the skill text and full file list before installing. Skills may
        tell a future agent to run commands. Start a new native session after a
        change.
      </p>
      <Stack gap="sm">
        <Select
          label="Native harness"
          value={harness}
          disabled={Boolean(busy)}
          data={[
            { value: "codex", label: "Codex" },
            { value: "claude", label: "Claude Code" },
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
            {preview && (
              <div className="instruction-preview">
                <h3>Review {preview.name}</h3>
                <p className="instruction-path">
                  <code>{preview.path}</code>
                </p>
                <p className="hint">
                  Source: {preview.source} · Ref:{" "}
                  {preview.sourceVersion || "default branch"} · Installer:{" "}
                  {preview.installerVersion} · Source hash:{" "}
                  {preview.upstreamHash || "unavailable"}
                </p>
                <h4>SKILL.md</h4>
                <pre>{preview.text}</pre>
                <h4>Files</h4>
                <ul>
                  {preview.files.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code> · {f.bytes.toLocaleString()} bytes
                    </li>
                  ))}
                </ul>
                <Button
                  disabled={!connected || Boolean(busy)}
                  loading={busy === "install"}
                  onClick={() => void act("install", { previewId: preview.id })}
                >
                  Install reviewed skill
                </Button>
              </div>
            )}
          </Stack>
        </details>
        {error && <Alert color="red">{error}</Alert>}
        {notice && <Alert color="teal">{notice}</Alert>}
        <Group>
          <h3>Native project skill folders</h3>
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
                )}
              </div>
            ))
        ) : (
          <p className="hint">No project skills found for this harness.</p>
        )}
      </Stack>
    </section>
  );
}
