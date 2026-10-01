import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Select,
  Stack,
  TextInput,
  Textarea,
} from "@mantine/core";
import type {
  Snapshot,
  Run,
  RunEvent,
  Role,
  Preference,
} from "../src/contracts.js";

type View = "Work" | "Team" | "Usage" | "Settings";
const local = ["127.0.0.1", "localhost"].includes(location.hostname);
const empty: Snapshot = {
  projects: [],
  runs: [],
  approvals: [],
  harnesses: [],
};
const labels: Record<Run["state"], string> = {
  running: "Active",
  needs_attention: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};
async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error || "The local service could not complete this request.",
    );
  return data;
}
const time = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export function App() {
  const [view, setView] = useState<View>("Work");
  const [snapshot, setSnapshot] = useState(empty);
  const [projectId, setProjectId] = useState("");
  const [runId, setRunId] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [tailShortened, setTailShortened] = useState(false);
  const [fullResult, setFullResult] = useState<Pick<
    Run,
    "result" | "resultTruncated"
  > | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(!local);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [projectModal, setProjectModal] = useState(false);
  const [taskModal, setTaskModal] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [prompt, setPrompt] = useState("");
  const [roleId, setRoleId] = useState<string | null>(null);
  const [harness, setHarness] = useState("codex");
  const [model, setModel] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [roles, setRoles] = useState<Role[]>([]);
  const [preference, setPreference] = useState<Preference>("balanced");
  const project = snapshot.projects.find((p) => p.id === projectId);
  const run = snapshot.runs.find(
    (r) => r.id === runId && r.projectId === projectId,
  );
  const workers = snapshot.harnesses.filter((h) => h.workerSupported);
  const selectedRole = project?.roles.find((r) => r.id === roleId);
  const taskHarness = selectedRole?.harness || harness;
  const taskWorker = workers.find((h) => h.id === taskHarness);
  const harnessName = (id: string) =>
    snapshot.harnesses.find((h) => h.id === id)?.name || id;
  const runs = snapshot.runs
    .filter((r) => r.projectId === projectId)
    .filter(
      (r) =>
        r.prompt.toLowerCase().includes(search.toLowerCase()) &&
        (status === "all" || r.state === status),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  async function refresh() {
    if (!local) return;
    try {
      const next = await api<Snapshot>("/snapshot");
      setSnapshot(next);
      setConnected(true);
      setLoaded(true);
      setProjectId((id) =>
        next.projects.some((p) => p.id === id)
          ? id
          : next.projects[0]?.id || "",
      );
    } catch (e) {
      setConnected(false);
      setLoaded(true);
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!local) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    setRoles(project?.roles.map((r) => ({ ...r })) || []);
    setPreference(project?.preference || "balanced");
  }, [project?.id]);
  useEffect(() => {
    setRunId("");
    setRoleId(null);
    setModel("");
  }, [projectId]);
  useEffect(() => {
    if (workers.length && !workers.some((h) => h.id === harness)) {
      setHarness(workers[0]!.id);
      setModel("");
    }
  }, [snapshot.harnesses, harness]);
  useEffect(() => {
    setEvents([]);
    setFullResult(null);
    setTailShortened(false);
    if (!runId || !connected) return;
    let active = true;
    let after = 0;
    let polling = false;
    // ponytail: keep the latest 200 native events; older history remains available through MCP.
    let buffer: RunEvent[] = [];
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        for (let page = 0; page < 10 && active; page++) {
          const data = await api<{
            events: RunEvent[];
            nextAfter: number;
            hasMore: boolean;
          }>(`/runs/${runId}/tail?after=${after}`);
          if (!active) return;
          const next = data.nextAfter ?? data.events.at(-1)?.id ?? after;
          const combined = [...buffer, ...data.events];
          if (
            combined.length > 200 ||
            data.events.some((event) => event.textTruncated)
          )
            setTailShortened(true);
          buffer = combined.slice(-200);
          setEvents(buffer);
          if (next <= after) break;
          after = next;
          if (!data.hasMore) break;
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        polling = false;
      }
    };
    const result = () =>
      api<Pick<Run, "result" | "resultTruncated">>(`/runs/${runId}/result`)
        .then((data) => {
          if (active) setFullResult(data);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void poll();
    void result();
    const interval = setInterval(() => {
      void poll();
      void result();
    }, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [runId, connected]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setView("Work");
        document.getElementById("task-search")?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const snippet = JSON.stringify(
    {
      mcpServers: {
        agentklar: {
          command: "npm",
          args: [
            "--prefix",
            "/absolute/path/to/Agentklar",
            "run",
            "--silent",
            "mcp",
          ],
        },
      },
    },
    null,
    2,
  );
  const setup = (
    <div className="setup">
      <div className="empty-mark">↗</div>
      <h2>
        {local
          ? "Connect your local workspace"
          : "Your work stays on your computer"}
      </h2>
      <p>
        {local
          ? "Start AgentKlar, then open the one-time setup link printed by the service. This gives this browser a local session."
          : "This hosted page is a setup guide. Run the local app to see projects, workers and permission requests."}
      </p>
      <pre>
        npm install{"\n"}npm run build{"\n"}npm start
      </pre>
      <p>
        Open the setup link from the terminal, then use{" "}
        <code>http://127.0.0.1:4317</code>.
      </p>
      <Button variant="light" onClick={() => setView("Settings")}>
        See MCP setup
      </Button>
      {local && (
        <Button
          variant="subtle"
          onClick={() => {
            setError("");
            void refresh();
          }}
        >
          Try connection again
        </Button>
      )}
    </div>
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("Work");
          }}
        >
          <span className="brand-mark">a</span>AgentKlar
          <span className="preview">local</span>
        </a>
        <div className="project-label">WORKSPACE</div>
        <Select
          aria-label="Choose project"
          placeholder="Choose a project"
          value={projectId || null}
          data={snapshot.projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => setProjectId(id || "")}
          disabled={!connected}
        />
        <button
          className="add-project"
          disabled={!connected}
          onClick={() => setProjectModal(true)}
        >
          ＋ Add existing project
        </button>
        <nav aria-label="Main navigation">
          {(["Work", "Team", "Usage", "Settings"] as View[]).map((item, i) => (
            <button
              key={item}
              className={view === item ? "nav active" : "nav"}
              aria-current={view === item ? "page" : undefined}
              onClick={() => setView(item)}
            >
              <span aria-hidden="true">{["▦", "♧", "◷", "⚙"][i]}</span>
              {item}
              {item === "Work" &&
                snapshot.runs.some((r) => r.state === "running") && (
                  <span className="nav-dot" />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span
            className={connected ? "connection-dot online" : "connection-dot"}
          />
          {connected ? "Local service connected" : "Local service disconnected"}
          <p>
            Your harness leads.
            <br />
            AgentKlar keeps work in view.
          </p>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <div className="eyebrow">{project?.name || "YOUR WORKSPACE"}</div>
            <h1>{view}</h1>
          </div>
          {view === "Work" && (
            <Button
              disabled={!connected || !project}
              onClick={() => setTaskModal(true)}
            >
              ＋ New task
            </Button>
          )}
        </header>
        {notice && (
          <Alert color="teal" withCloseButton onClose={() => setNotice("")}>
            {notice}
          </Alert>
        )}
        {error && (
          <Alert
            color="red"
            title="Could not complete request"
            withCloseButton
            onClose={() => setError("")}
          >
            {error}
          </Alert>
        )}
        {!loaded ? (
          <div className="setup">
            <p>Connecting to your local service…</p>
          </div>
        ) : !connected && view !== "Settings" ? (
          setup
        ) : (
          <>
            {view === "Work" &&
              (project ? (
                <>
                  <div className="work-toolbar">
                    <TextInput
                      id="task-search"
                      aria-label="Search tasks"
                      placeholder="Search tasks…"
                      value={search}
                      onChange={(e) => setSearch(e.currentTarget.value)}
                    />
                    <Select
                      aria-label="Filter tasks by status"
                      value={status}
                      onChange={(v) => setStatus(v || "all")}
                      data={[
                        { value: "all", label: "All tasks" },
                        ...Object.entries(labels).map(([value, label]) => ({
                          value,
                          label,
                        })),
                      ]}
                    />
                  </div>
                  <div className="work-grid">
                    <section className="task-list" aria-label="Tasks">
                      {runs.length ? (
                        runs.map((item) => (
                          <button
                            key={item.id}
                            className={
                              item.id === run?.id
                                ? "task-row selected"
                                : "task-row"
                            }
                            onClick={() => setRunId(item.id)}
                          >
                            <div>
                              <span className={`state-dot ${item.state}`} />
                              <span className="task-title">{item.prompt}</span>
                            </div>
                            <div className="task-meta">
                              <span>{labels[item.state]}</span>
                              <span>{time(item.createdAt)}</span>
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="list-empty">
                          <h3>
                            {search || status !== "all"
                              ? "No matching tasks"
                              : "A clear place for your work"}
                          </h3>
                          <p>
                            {search || status !== "all"
                              ? "Try another search or status."
                              : "Start a task here, or send one from your native harness through MCP."}
                          </p>
                          {!search && status === "all" && (
                            <Button
                              variant="light"
                              onClick={() => setTaskModal(true)}
                            >
                              Start a task
                            </Button>
                          )}
                        </div>
                      )}
                    </section>
                    <section className="task-detail" aria-label="Task detail">
                      {run ? (
                        <>
                          <div className="detail-top">
                            <Badge
                              color={
                                run.state === "failed"
                                  ? "red"
                                  : run.state === "completed"
                                    ? "teal"
                                    : "indigo"
                              }
                              variant="light"
                            >
                              {labels[run.state]}
                            </Badge>
                            {["running", "needs_attention"].includes(
                              run.state,
                            ) && (
                              <Button
                                size="xs"
                                color="gray"
                                variant="subtle"
                                loading={busy}
                                onClick={() =>
                                  void act(async () => {
                                    await api(`/runs/${run.id}/stop`, {});
                                  })
                                }
                              >
                                Cancel task
                              </Button>
                            )}
                          </div>
                          <h2>{run.prompt}</h2>
                          {run.promptTruncated && (
                            <p className="hint">Task preview shortened.</p>
                          )}
                          <p className="muted">
                            {harnessName(run.harness || "codex")} worker
                            {run.roleId
                              ? ` · ${run.roleSnapshot?.name || project?.roles.find((r) => r.id === run.roleId)?.name || "Saved role"}`
                              : ""}{" "}
                            ·{" "}
                            {run.readOnly
                              ? "Read only"
                              : "Workspace changes allowed"}{" "}
                            ·{" "}
                            {run.effectiveModel ||
                              run.model ||
                              "Harness default model"}{" "}
                            · {time(run.createdAt)}
                          </p>
                          {snapshot.approvals
                            .filter((a) => a.runId === run.id)
                            .map((a) => (
                              <div className="permission" key={a.id}>
                                <Badge color="orange">Permission needed</Badge>
                                <h3>{a.title}</h3>
                                <p>
                                  Review this{" "}
                                  {a.kind === "command"
                                    ? "command"
                                    : "file change"}{" "}
                                  before continuing.
                                </p>
                                <PermissionDetails
                                  kind={a.kind}
                                  details={a.details}
                                />
                                <Group>
                                  {a.decisions.map((decision) => (
                                    <Button
                                      key={decision}
                                      size="xs"
                                      variant={
                                        decision
                                          .toLowerCase()
                                          .includes("accept")
                                          ? "filled"
                                          : "light"
                                      }
                                      loading={busy}
                                      onClick={() =>
                                        void act(async () => {
                                          await api(`/approvals/${a.id}`, {
                                            decision,
                                          });
                                        })
                                      }
                                    >
                                      {{
                                        accept: "Allow once",
                                        decline: "Decline",
                                        cancel: "Cancel",
                                      }[decision] || decision}
                                    </Button>
                                  ))}
                                </Group>
                              </div>
                            ))}
                          {run.error && <Alert color="red">{run.error}</Alert>}
                          {(fullResult?.result || run.result) && (
                            <>
                              <h3 className="section-label">RESULT</h3>
                              <pre className="result">
                                {fullResult?.result || run.result}
                              </pre>
                              {(fullResult?.resultTruncated ??
                                run.resultTruncated) && (
                                <p className="hint">
                                  Result preview shortened.
                                </p>
                              )}
                            </>
                          )}
                          <h3 className="section-label">NATIVE EVENTS</h3>
                          {events.length ? (
                            <div className="events">
                              {groupEvents(events).map((event) => (
                                <div key={event.id}>
                                  <span>
                                    {time(event.createdAt)} · {event.kind}
                                  </span>
                                  <pre>{event.text}</pre>
                                  {event.textTruncated && (
                                    <p className="hint">
                                      Event preview shortened.
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="muted">
                              No native events have been received yet.
                            </p>
                          )}
                          {tailShortened && (
                            <p className="hint">
                              Event history shortened. Use run_tail in your MCP
                              host for more.
                            </p>
                          )}
                        </>
                      ) : (
                        <div className="detail-empty">
                          <span>↖</span>
                          <h3>Select a task</h3>
                          <p>
                            See its native events, result and permission
                            requests here.
                          </p>
                        </div>
                      )}
                    </section>
                  </div>
                </>
              ) : (
                <div className="setup">
                  <div className="empty-mark">＋</div>
                  <h2>Bring your project</h2>
                  <p>
                    Register an existing folder. Keep using your editor and
                    native harness.
                  </p>
                  <Button onClick={() => setProjectModal(true)}>
                    Add existing project
                  </Button>
                  <button
                    className="text-link"
                    onClick={() => setView("Settings")}
                  >
                    Then connect one MCP host →
                  </button>
                </div>
              ))}
            {view === "Team" &&
              (project ? (
                <section className="content-panel">
                  <h2>Roles for {project.name}</h2>
                  <p className="muted">
                    Save who should do what. Your MCP host can choose a role.
                    Installed Codex and Claude harnesses can run workers.
                  </p>
                  <Select
                    label="Cost preference"
                    value={preference}
                    onChange={(v) => setPreference(v as Preference)}
                    data={[
                      { value: "economical", label: "Economical" },
                      { value: "balanced", label: "Balanced" },
                      { value: "best", label: "Best capability" },
                    ]}
                  />
                  <p className="hint">
                    This preference is shared with your orchestrator. It does
                    not enforce a budget or change a model automatically.
                  </p>
                  {roles.map((role, index) => (
                    <div className="role-card" key={role.id}>
                      <Group justify="space-between">
                        <h3>Role {index + 1}</h3>
                        <Button
                          size="xs"
                          color="gray"
                          variant="subtle"
                          onClick={() =>
                            setRoles(roles.filter((r) => r.id !== role.id))
                          }
                        >
                          Remove
                        </Button>
                      </Group>
                      <div className="role-fields">
                        <TextInput
                          label="Role name"
                          value={role.name}
                          onChange={(e) =>
                            setRoles(
                              roles.map((r) =>
                                r.id === role.id
                                  ? { ...r, name: e.currentTarget.value }
                                  : r,
                              ),
                            )
                          }
                        />
                        <Select
                          label="Harness"
                          value={role.harness}
                          data={snapshot.harnesses.map((h) => ({
                            value: h.id,
                            label: h.name,
                          }))}
                          onChange={(v) =>
                            setRoles(
                              roles.map((r) =>
                                r.id === role.id
                                  ? {
                                      ...r,
                                      harness: v || "codex",
                                      model: undefined,
                                    }
                                  : r,
                              ),
                            )
                          }
                        />
                        <TextInput
                          label="Model (optional)"
                          placeholder={`${harnessName(role.harness)} native default`}
                          value={role.model || ""}
                          onChange={(e) =>
                            setRoles(
                              roles.map((r) =>
                                r.id === role.id
                                  ? { ...r, model: e.currentTarget.value }
                                  : r,
                              ),
                            )
                          }
                        />
                      </div>
                      <Textarea
                        label="Responsibility"
                        value={role.responsibility}
                        onChange={(e) =>
                          setRoles(
                            roles.map((r) =>
                              r.id === role.id
                                ? {
                                    ...r,
                                    responsibility: e.currentTarget.value,
                                  }
                                : r,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                  {!roles.length && (
                    <p className="empty-note">
                      No saved roles yet. Add the people or worker roles your
                      project needs.
                    </p>
                  )}
                  <Group mt="lg">
                    <Button
                      variant="light"
                      onClick={() =>
                        setRoles([
                          ...roles,
                          {
                            id: crypto.randomUUID(),
                            name: "",
                            harness: workers[0]?.id || "codex",
                            responsibility: "",
                          },
                        ])
                      }
                    >
                      ＋ Add role
                    </Button>
                    <Button
                      loading={busy}
                      onClick={() =>
                        void act(async () => {
                          await api(
                            `/projects/${project.id}`,
                            {
                              roles: roles.map((r) => ({
                                ...r,
                                model: r.model?.trim() || undefined,
                              })),
                              preference,
                            },
                            "PATCH",
                          );
                          setNotice("Team saved.");
                        })
                      }
                    >
                      Save team
                    </Button>
                  </Group>
                </section>
              ) : (
                <div className="setup">
                  <h2>Add a project to set up its team</h2>
                  <Button onClick={() => setProjectModal(true)}>
                    Add existing project
                  </Button>
                </div>
              ))}
            {view === "Usage" && (
              <section className="content-panel">
                <h2>Reported usage</h2>
                <p className="muted">
                  Usage comes from native worker events. Pricing and account
                  quotas are not available.
                </p>
                <div className="usage-grid">
                  <div>
                    <span>Reported tokens</span>
                    <strong>
                      {snapshot.runs
                        .filter((r) => !projectId || r.projectId === projectId)
                        .reduce((sum, r) => sum + (r.tokens || 0), 0)
                        .toLocaleString()}
                    </strong>
                  </div>
                  <div>
                    <span>Tasks with unknown usage</span>
                    <strong>
                      {
                        snapshot.runs.filter(
                          (r) =>
                            (!projectId || r.projectId === projectId) &&
                            r.tokens === null,
                        ).length
                      }
                    </strong>
                  </div>
                  <div>
                    <span>Cost / account quota</span>
                    <strong className="unknown">Unknown</strong>
                  </div>
                </div>
                <p className="hint">
                  A zero total means no tokens have been reported. It does not
                  mean the work was free.
                </p>
              </section>
            )}
            {view === "Settings" && (
              <section className="content-panel">
                <h2>Connect your native harness</h2>
                <p className="muted">
                  Your harness stays in charge. Add AgentKlar as an MCP server
                  to register projects, start workers and collect results.
                </p>
                {!connected && setup}
                <h3>1. Start the local service</h3>
                <pre>npm run build{"\n"}npm start</pre>
                <p className="hint">
                  Open the one-time setup URL printed by the service to
                  authenticate the local UI.
                </p>
                <h3>2. Add this MCP server</h3>
                <p className="hint">
                  Replace the absolute path with this checkout. Run from the
                  same local account as the service. The server reads the local
                  service credentials automatically.
                </p>
                <pre>{snippet}</pre>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() =>
                    void act(async () => {
                      await navigator.clipboard.writeText(snippet);
                      setNotice("MCP configuration copied.");
                    })
                  }
                >
                  Copy configuration
                </Button>
                <h3>Harnesses on this computer</h3>
                {connected ? (
                  snapshot.harnesses.map((h) => (
                    <div className="harness" key={h.id}>
                      <div>
                        <strong>{h.name}</strong>
                        <p>{h.reason}</p>
                      </div>
                      <Badge
                        color={h.available ? "teal" : "gray"}
                        variant="light"
                      >
                        {h.available ? "Installed" : "Not found"}
                      </Badge>
                      <span>
                        {h.workerSupported
                          ? "Worker supported"
                          : h.hostSupported
                            ? "MCP host"
                            : "Discovery only"}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="muted">
                    Open the local app to check installed harnesses. This hosted
                    page has no connection to your computer.
                  </p>
                )}
                <p className="hint">
                  Installed means the executable was found. Sign in through
                  your native harness before starting a worker.
                </p>
              </section>
            )}
          </>
        )}
      </main>
      <Modal
        opened={projectModal}
        onClose={() => setProjectModal(false)}
        title="Add existing project"
        centered
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const p = await api<{ id: string }>("/projects", { name, path });
              setProjectId(p.id);
              setProjectModal(false);
              setName("");
              setPath("");
            });
          }}
        >
          <Stack>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput
              label="Project name"
              placeholder="My project"
              required
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <TextInput
              label="Absolute folder path"
              placeholder="/Users/you/Projects/my-project"
              required
              value={path}
              onChange={(e) => setPath(e.currentTarget.value)}
            />
            <p className="hint">Choose an existing folder on this computer.</p>
            <Button type="submit" loading={busy}>
              Add project
            </Button>
          </Stack>
        </form>
      </Modal>
      <Modal
        opened={taskModal}
        onClose={() => setTaskModal(false)}
        title="Start a task"
        classNames={{ body: "task-modal-body" }}
        yOffset="5vh"
        centered
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const task = await api<Run>("/tasks/start", {
                projectId,
                prompt,
                idempotencyKey: crypto.randomUUID(),
                roleId: roleId || undefined,
                harness: taskHarness,
                model: model.trim() || undefined,
                readOnly,
              });
              setRunId(task.id);
              setTaskModal(false);
              setPrompt("");
            });
          }}
        >
          <Stack gap="sm">
            {error && <Alert color="red">{error}</Alert>}
            <Textarea
              label="What should the worker do?"
              placeholder="Describe the task and what a good result looks like."
              required
              minRows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
            <Select
              label="Role (optional)"
              placeholder="No role"
              clearable
              value={roleId}
              onChange={(id) => {
                setRoleId(id);
                setModel("");
              }}
              data={
                project?.roles.map((r) => ({ value: r.id, label: r.name })) ||
                []
              }
            />
            <Select
              label="Worker harness"
              value={taskHarness}
              disabled={Boolean(selectedRole)}
              placeholder="No installed worker harness"
              data={workers.map((h) => ({ value: h.id, label: h.name }))}
              onChange={(id) => {
                setHarness(id || "codex");
                setModel("");
              }}
            />
            {selectedRole && (
              <p className="hint">The saved role chooses its harness.</p>
            )}
            {!taskWorker && (
              <Alert color="orange">
                {selectedRole
                  ? "This role does not have an installed, supported worker harness. Choose another role or change it in Team."
                  : "Install Codex or Claude to start a worker."}
              </Alert>
            )}
            <TextInput
              label="Model (optional)"
              placeholder={
                selectedRole?.model ||
                `${harnessName(taskHarness)} native default`
              }
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
            />
            <Checkbox
              label="Read only"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.currentTarget.checked)}
            />
            {readOnly && (
              <p className="hint">
                {taskHarness === "claude"
                  ? "Claude can use only Read, Glob and Grep tools. Your configured hooks can still run. This does not add an operating system sandbox."
                  : "Codex uses its native read-only sandbox."}
              </p>
            )}
            <p className="hint">
              Runs a native {harnessName(taskHarness)} worker in {project?.name}.
              Native permission requests appear in the task detail.
            </p>
            <Button type="submit" loading={busy} disabled={!taskWorker}>
              Start worker
            </Button>
          </Stack>
        </form>
      </Modal>
    </div>
  );
}

function PermissionDetails({
  kind,
  details,
}: {
  kind: string;
  details: unknown;
}) {
  const d =
    details && typeof details === "object"
      ? (details as Record<string, unknown>)
      : {};
  if (kind === "command" && typeof d.command === "string")
    return (
      <>
        <div className="permission-label">Command</div>
        <pre>{d.command}</pre>
        {typeof d.cwd === "string" && (
          <p>
            <strong>Working folder</strong>
            <br />
            <code>{d.cwd}</code>
          </p>
        )}
        {typeof d.reason === "string" && <p>{d.reason}</p>}
      </>
    );
  if (
    kind === "file" &&
    typeof d.file_path === "string" &&
    (d.tool === "Write" || d.tool === "Edit")
  )
    return (
      <>
        <div className="permission-label">File</div>
        <p><strong>{d.file_path}</strong></p>
        {d.tool === "Write" && typeof d.content === "string" && (
          <>
            <div className="permission-label">Proposed content</div>
            <pre>{d.content}</pre>
          </>
        )}
        {d.tool === "Edit" && (
          <>
            {d.replace_all === true && <p>Replace all matching text.</p>}
            {typeof d.old_string === "string" && (
              <>
                <div className="permission-label">Before</div>
                <pre>{d.old_string}</pre>
              </>
            )}
            {typeof d.new_string === "string" && (
              <>
                <div className="permission-label">After</div>
                <pre>{d.new_string}</pre>
              </>
            )}
          </>
        )}
      </>
    );
  if (kind === "file" && Array.isArray(d.changes))
    return (
      <>
        {d.changes.map((change, index) => {
          const c =
            change && typeof change === "object"
              ? (change as Record<string, unknown>)
              : {};
          return typeof c.path === "string" ? (
            <div key={index}>
              <p>
                <strong>{c.path}</strong>
              </p>
              {typeof c.diff === "string" ? (
                <pre>{c.diff}</pre>
              ) : (
                <pre>{JSON.stringify(c, null, 2)}</pre>
              )}
            </div>
          ) : (
            <pre key={index}>{JSON.stringify(change, null, 2)}</pre>
          );
        })}
        {typeof d.reason === "string" && <p>{d.reason}</p>}
      </>
    );
  return <pre>{JSON.stringify(details, null, 2)}</pre>;
}

function groupEvents(events: RunEvent[]): RunEvent[] {
  const grouped: RunEvent[] = [];
  for (const event of events) {
    const prior = grouped.at(-1);
    if (event.kind === "output" && prior?.kind === "output") {
      prior.text += event.text;
      prior.textTruncated ||= event.textTruncated;
    } else grouped.push({ ...event });
  }
  return grouped;
}
