import { useEffect, useRef, useState } from "react";
import { NativeSetupForm } from "./NativeSetupForm.js";
import { NativeInstallations } from "./NativeInstallations.js";
import { GitChanges } from "./GitChanges.js";
import { RemoteApprovals, type PendingHumanAnswer } from "./RemoteApprovals.js";
import { Devices } from "./Devices.js";
import { InstructionsForm } from "./InstructionsForm.js";
import { Benchmarks, BenchmarkDetail, BenchmarkEvidenceView } from "./Benchmarks.js";
import type { BenchmarkSnapshot, TaskType } from "../src/benchmarks.js";
import { SkillsForm } from "./SkillsForm.js";
import {
  Alert,
  Autocomplete,
  Progress,
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
  CatalogSnapshot,
  QuotaWindow,
  Run,
  RunEvent,
  Role,
  Preference,
  ProjectContext,
  WorkerAdvice,
  RunHandoff,
  MuseSubscriptionUsage,
} from "../src/contracts.js";

type View = "Work" | "Instructions" | "Context" | "Team" | "Models" | "Usage" | "Settings";
const local = ["127.0.0.1", "localhost"].includes(location.hostname);
const empty: Snapshot = {
  projects: [],
  runs: [],
  approvals: [],
  harnesses: [],
  leads: {},
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
    throw Object.assign(
      new Error(
        [data.error || "The local service could not complete this request.",
          ...(Array.isArray(data.warnings) ? data.warnings.slice(0, 2) : []),
          ...(Array.isArray(data.reasons) ? data.reasons.slice(0, 1) : [])].join(" "),
      ),
      { status: response.status },
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
  const [catalogs, setCatalogs] = useState<
    Record<string, CatalogSnapshot | null>
  >({});
  const [benchmarks, setBenchmarks] = useState<BenchmarkSnapshot | null>(null);
  const [catalogBusy, setCatalogBusy] = useState("");
  const [catalogError, setCatalogError] = useState<{
    projectId: string;
    message: string;
  } | null>(null);
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
  const [connectionError, setConnectionError] = useState("");
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(!local);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [projectModal, setProjectModal] = useState(false);
  const [taskModal, setTaskModal] = useState(false);
  const [draftProjectId, setDraftProjectId] = useState("");
  const [followUp, setFollowUp] = useState<{ runId: string; kind: "review" | "fix" } | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [prompt, setPrompt] = useState("");
  const [roleId, setRoleId] = useState<string | null>(null);
  const [harness, setHarness] = useState("automatic");
  const [model, setModel] = useState("");
  const [automaticRouting, setAutomaticRouting] = useState(true);
  const [deviceScope, setDeviceScope] = useState<"connected" | "local">("connected");
  const [complexity, setComplexity] = useState<WorkerAdvice["complexity"]>("standard");
  const [taskType, setTaskType] = useState<TaskType>("coding");
  const [requiresImages, setRequiresImages] = useState(false);
  const [advice, setAdvice] = useState<{ key: string; data: WorkerAdvice } | null>(null);
  const [adviceBusy, setAdviceBusy] = useState("");
  const [adviceError, setAdviceError] = useState<{ key: string; message: string } | null>(null);
  const adviceRequest = useRef(0);
  const humanApprovalPending = useRef<Record<string, PendingHumanAnswer>>({});
  const [readOnly, setReadOnly] = useState(true);
  const [includeProjectContext, setIncludeProjectContext] = useState(true);
  const [workspace, setWorkspace] = useState<"project" | "worktree">("project");
  const [roles, setRoles] = useState<Role[]>([]);
  const [preference, setPreference] = useState<Preference>("balanced");
  const project = snapshot.projects.find((p) => p.id === projectId);
  const lead = snapshot.leads?.[projectId];
  const taskProject = snapshot.projects.find((p) => p.id === draftProjectId);
  const run = snapshot.runs.find(
    (r) => r.id === runId && r.projectId === projectId,
  );
  const remoteRun = snapshot.remoteDispatches?.find((r) => r.id === runId && r.projectId === projectId);
  const projectPeers = snapshot.peers?.filter((p) => p.projectId === projectId) || [];
  const catalog = catalogs[projectId];
  const modelChoices = (id: string, forProjectId = projectId) =>
    catalogs[forProjectId]?.harnesses
      .find((h) => h.harness === id)
      ?.models.map((m) => m.id) || [];
  const workers = snapshot.harnesses.filter((h) => h.workerSupported);
  const selectedRole = taskProject?.roles.find((r) => r.id === roleId);
  const taskHarness = selectedRole?.harness || harness;
  const remoteFollowUp = followUp ? snapshot.remoteDispatches?.find((item) => item.id === followUp.runId) : undefined;
  const remoteRole = Boolean(selectedRole?.peerId || remoteFollowUp);
  const followUpPeer = remoteFollowUp ? snapshot.peers?.find((p) => p.id === remoteFollowUp.peerId) : undefined;
  const connectedRouting = automaticRouting && deviceScope === "connected" && workspace === "worktree" && !followUp && !selectedRole && snapshot.peers?.some((p) => p.projectId === draftProjectId);
  const taskWorker = remoteRole || connectedRouting || (automaticRouting && taskHarness === "automatic" && workers.length > 0) || workers.find((h) => h.id === taskHarness);
  const museModels = catalogs[draftProjectId]?.harnesses.find((entry) => entry.harness === "muse")?.models || [];
  const museModel = taskHarness === "muse" ? museModels.find((item) => item.id === (model.trim() || selectedRole?.model)) ||
    (!model.trim() && !selectedRole?.model ? museModels.find((item) => item.isDefault) : undefined) : undefined;
  useEffect(() => {
    if (taskHarness === "muse" || taskHarness === "opencode") setAutomaticRouting(false);
  }, [taskHarness]);
  useEffect(() => {
    if (remoteRole || !taskModal || (taskHarness !== "muse" && taskHarness !== "opencode") || !connected || !draftProjectId ||
        catalogs[draftProjectId]?.harnesses.some((entry) => entry.harness === taskHarness)) return;
    let active = true;
    setCatalogBusy(draftProjectId);
    void api<CatalogSnapshot>(`/projects/${draftProjectId}/catalog`, {})
      .then((data) => { if (active) setCatalogs((current) => ({ ...current, [draftProjectId]: data })); })
      .catch((e) => { if (active) setCatalogError({ projectId: draftProjectId, message: (e as Error).message }); })
      .finally(() => { if (active) setCatalogBusy((current) => current === draftProjectId ? "" : current); });
    return () => { active = false; };
  }, [taskModal, taskHarness, connected, draftProjectId]);
  const adviceKey = JSON.stringify([
    draftProjectId, roleId, taskHarness, model, selectedRole?.model,
    taskProject?.preference, complexity, requiresImages, taskType, taskModal, connected,
    deviceScope, workspace, followUp, prompt, selectedRole?.peerId,
  ]);
  const currentAdviceKey = useRef(adviceKey);
  currentAdviceKey.current = adviceKey;
  const currentAdvice = advice?.key === adviceKey ? advice.data : null;
  const adviceChoice = currentAdvice?.choice;
  const canUseAdvice = Boolean(adviceChoice && !adviceChoice.device?.peerId && connected &&
    (remoteRole || workers.some((worker) => worker.id === adviceChoice.harness)) &&
    (!selectedRole || selectedRole.harness === adviceChoice.harness));
  useEffect(() => {
    adviceRequest.current++;
    setAdvice(null);
    setAdviceError(null);
    setAdviceBusy("");
  }, [adviceKey]);
  async function suggestModel() {
    const key = adviceKey;
    const request = ++adviceRequest.current;
    setAdvice(null);
    setAdviceError(null);
    setAdviceBusy(key);
    try {
      const data = await api<WorkerAdvice>(`/projects/${draftProjectId}/recommend`, {
        roleId: roleId || undefined,
        harness: taskHarness === "automatic" ? undefined : taskHarness,
        model: model.trim() || undefined,
        complexity,
        requiresImages,
        taskType,
        deviceScope, workspace, followUp: followUp || undefined,
      });
      if (request === adviceRequest.current && key === currentAdviceKey.current)
        setAdvice({ key, data });
    } catch (e) {
      if (request === adviceRequest.current && key === currentAdviceKey.current)
        setAdviceError({ key, message: (e as Error).message });
    } finally {
      if (request === adviceRequest.current && key === currentAdviceKey.current)
        setAdviceBusy("");
    }
  }
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
  const remoteRuns = (snapshot.remoteDispatches || []).filter((r) => r.projectId === projectId)
    .filter((r) => (r.prompt || r.lastKnownRun?.prompt || "Remote task").toLowerCase().includes(search.toLowerCase()) &&
      (status === "all" || r.lastKnownRun?.state === status));
  const museUsage = snapshot.runs
    .filter((item) => !projectId || item.projectId === projectId)
    .reduce<MuseSubscriptionUsage | undefined>((latest, item) =>
      item.museSubscriptionUsage && (!latest || item.museSubscriptionUsage.observedAtMs > latest.observedAtMs)
        ? item.museSubscriptionUsage : latest, undefined);
  const hasMuseRuns = snapshot.runs.some((item) =>
    item.harness === "muse" && (!projectId || item.projectId === projectId));
  const linkedRuns = run ? snapshot.runs.filter((item) =>
    item.projectId === run.projectId &&
    (item.id === (run.followUp?.rootRunId || run.id) ||
      item.followUp?.rootRunId === (run.followUp?.rootRunId || run.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  function openTask(source?: Run) {
    const kind = source?.followUp?.kind === "review" ? "fix" : "review";
    setDraftProjectId(source?.projectId || projectId);
    setFollowUp(source ? { runId: source.id, kind } : null);
    setPrompt(source ? (kind === "review"
      ? "Review the linked work. Check the changes and report concrete findings with file paths and lines."
      : "Fix the findings in the linked review. Check the result and explain what changed.") : "");
    setReadOnly(source ? kind === "review" : true);
    setWorkspace(source?.workspace?.kind || "project");
    setRoleId(null);
    setHarness(source?.harness || "automatic");
    setAutomaticRouting(true);
    setModel("");
    setTaskModal(true);
  }
  function openRemoteTask(source: NonNullable<Snapshot["remoteDispatches"]>[number]) {
    const kind = source.lastKnownRun?.followUp?.kind === "review" ? "fix" : "review";
    setDraftProjectId(source.projectId);
    setFollowUp({ runId: source.id, kind });
    setPrompt(kind === "review" ? "Review the linked work. Check the changes and report concrete findings with file paths and lines." : "Fix the findings in the linked review. Check the result and explain what changed.");
    setReadOnly(kind === "review"); setWorkspace("worktree"); setRoleId(null);
    setHarness(source.lastKnownRun?.harness || "codex"); setModel(""); setTaskModal(true);
  }
  async function refresh() {
    if (!local) return;
    try {
      const next = await api<Snapshot>("/snapshot");
      setSnapshot(next);
      setConnectionError("");
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
      setConnectionError((e as Error).message);
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
    setCatalogError(null);
    if (!local || !projectId) return;
    let active = true;
    api<CatalogSnapshot | null>(`/projects/${projectId}/catalog`)
      .then((data) => {
        if (active)
          setCatalogs((current) => {
            const previous = current[projectId];
            if (previous && (!data || previous.checkedAt > data.checkedAt))
              return current;
            return { ...current, [projectId]: data };
          });
      })
      .catch((e) => {
        if (active)
          setCatalogError({ projectId, message: (e as Error).message });
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  async function refreshCatalog() {
    if (!local || !projectId) return;
    setCatalogBusy(projectId);
    setCatalogError(null);
    try {
      const data = await api<CatalogSnapshot>(
        `/projects/${projectId}/catalog`,
        {},
      );
      setCatalogs((current) => ({ ...current, [projectId]: data }));
    } catch (e) {
      setCatalogError({ projectId, message: (e as Error).message });
    } finally {
      setCatalogBusy((current) => (current === projectId ? "" : current));
    }
  }
  const catalogHeader = (
    <>
      <Group justify="space-between">
        <p className="hint">
          {catalog
            ? `Checked ${time(catalog.checkedAt)}`
            : "No native list has been checked for this project."}
        </p>
        <Button
          size="xs"
          variant="light"
          loading={catalogBusy === projectId}
          disabled={!connected || !projectId}
          onClick={() => void refreshCatalog()}
        >
          Refresh models and allowance
        </Button>
      </Group>
      {catalogError?.projectId === projectId && (
        <Alert color="red">{catalogError.message}</Alert>
      )}
    </>
  );
  useEffect(() => {
    setRunId("");
    setRoleId(null);
    setModel("");
  }, [projectId]);
  useEffect(() => {
    if (!remoteRole && harness !== "automatic" && workers.length && !workers.some((h) => h.id === harness)) {
      setHarness(workers[0]!.id);
      setModel("");
    }
  }, [snapshot.harnesses, harness, remoteRole]);
  useEffect(() => {
    setEvents([]);
    setFullResult(null);
    setTailShortened(false);
    if (!run || !connected) return;
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
  }, [runId, connected, run?.id]);
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
          command: "agentklar",
          args: ["mcp"],
        },
      },
    },
    null,
    2,
  );
  const backgroundSetup = (
    <details><summary>Start at login on macOS</summary>
      <p className="hint">Stop the foreground terminal service first. Use the same custom home and port, if set.</p>
      <pre>agentklar service install{"\n"}agentklar service open</pre>
      <p className="hint">The setup link works once for five minutes. See README for stop, start, and uninstall.</p>
    </details>
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
      <p className="hint">Requires Node 24 on macOS or Linux. Install the pinned beta package:</p>
      <pre>npm install -g https://github.com/kaltstart-co/agentklar/releases/download/v0.1.0-beta.23/agentklar-0.1.0-beta.23.tgz{"\n"}agentklar start</pre>
      <p>
        Open the setup link from the terminal, then use{" "}
        <code>http://127.0.0.1:4317</code>.
      </p>
      {backgroundSetup}
      <details><summary>Run from a source checkout</summary><pre>npm ci{"\n"}npm run build{"\n"}npm start</pre></details>
      <Button variant="light" onClick={() => setView("Settings")}>
        See MCP setup
      </Button>
      {local && (
        <Button
          variant="subtle"
          onClick={() => {
            setConnectionError("");
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
          {(
            ["Work", "Instructions", "Context", "Team", "Models", "Usage", "Settings"] as View[]
          ).map((item, i) => (
            <button
              key={item}
              className={view === item ? "nav active" : "nav"}
              aria-current={view === item ? "page" : undefined}
              onClick={() => setView(item)}
            >
              <span aria-hidden="true">
                {["▦", "✎", "≡", "♧", "◇", "◷", "⚙"][i]}
              </span>
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
              onClick={() => openTask()}
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
        {connectionError && (
          <Alert color="red" title="Local service disconnected">
            {connectionError}
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
        {project && (
          <div hidden={view !== "Context" || !connected}>
            <ContextForm
              key={project.id}
              projectId={project.id}
              connected={connected}
            />
          </div>
        )}
        {project && (
          <div hidden={view !== "Instructions" || !connected}>
            <InstructionsForm key={`instructions-${project.id}`} projectId={project.id} connected={connected} />
          </div>
        )}
        <div hidden={view !== "Instructions" || !connected}>
          <SkillsForm key={`skills-${project?.id || "personal"}`} projectId={project?.id} connected={connected} />
        </div>
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
                  <p className="hint instruction-path">
                    {lead ? `Lead connected: ${lead.clientName || "Unknown MCP client"} · MCP client report · Last seen ${time(lead.lastSeenAt)}.` : "No lead connected."}
                    {lead && <Button size="xs" variant="subtle" ml="xs" disabled={busy}
                      onClick={() => void act(async () => {
                        await api(`/projects/${project.id}/lead`, { observedClaimId: lead.claimId }, "DELETE");
                      })}>Clear lead</Button>}
                  </p>
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
                      {remoteRuns.map((item) => <button key={item.id} className={item.id === runId ? "task-row selected" : "task-row"} onClick={() => setRunId(item.id)}>
                        <div><span className="task-title">{item.prompt || item.lastKnownRun?.prompt || "Remote task awaiting owner confirmation"}</span></div>
                        <div className="task-meta"><span>{snapshot.peers?.find((p) => p.id === item.peerId)?.label || "Other computer"} · {item.lastKnownRun ? `Last known: ${labels[item.lastKnownRun.state]}` : "Owner state unknown"}</span></div>
                        <div className="task-meta"><span>{item.connection === "unknown" ? "Connection unknown" : "Owner observed"}{item.lastObservedAt ? ` · ${time(item.lastObservedAt)}` : ""}</span></div>
                      </button>)}
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
                      ) : remoteRuns.length ? null : (
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
                              onClick={() => openTask()}
                            >
                              Start a task
                            </Button>
                          )}
                        </div>
                      )}
                    </section>
                    <section className="task-detail" aria-label="Task detail">
                      {remoteRun ? <Stack gap="sm">
                        <h3>{remoteRun.prompt || remoteRun.lastKnownRun?.prompt || "Remote task"}</h3>
                        <p>Owner: {snapshot.peers?.find((p) => p.id === remoteRun.peerId)?.label || remoteRun.ownerDeviceId}</p>
                        <p className="hint">Owner run ID: {remoteRun.ownerRunId || "Acceptance not confirmed"}</p>
                        <Badge color={remoteRun.connection === "unknown" ? "orange" : "blue"}>{remoteRun.connection === "unknown" ? "Connection unknown" : "Owner observed"}</Badge>
                        <p>Last known worker state: {remoteRun.lastKnownRun ? labels[remoteRun.lastKnownRun.state] : "Unknown"}</p>
                        {remoteRun.lastObservedAt && <p className="hint">Observed {time(remoteRun.lastObservedAt)}. This is saved evidence; the worker may have changed since then.</p>}
                        {remoteRun.routing && <details>
                          <summary>Model choice at launch</summary>
                          <p className="hint">{harnessName(remoteRun.routing.selected.harness)} · {remoteRun.routing.selected.model}{remoteRun.routing.selected.device && ` · ${remoteRun.routing.selected.device.label}`}</p>
                          <p className="hint">Native list checked {time(remoteRun.routing.catalogCheckedAt)}. Saved preference: {remoteRun.routing.preference}.</p>
                          {remoteRun.routing.selected.benchmark && <BenchmarkEvidenceView evidence={remoteRun.routing.selected.benchmark} method={remoteRun.routing.benchmarkMethod} />}
                          <ul>{[...remoteRun.routing.reasons, ...remoteRun.routing.warnings].map((reason) => <li key={reason}>{reason}</li>)}</ul>
                        </details>}
                        {remoteRun.error && <Alert color="orange">{remoteRun.error}</Alert>}
                        <RemoteApprovals key={`approvals-${remoteRun.id}`} dispatchId={remoteRun.id} peerId={remoteRun.peerId}
                          owner={snapshot.peers?.find(p => p.id === remoteRun.peerId)?.label || "Owner computer"}
                          connected={connected} connection={remoteRun.connection}
                          active={!!remoteRun.lastKnownRun && ["running", "needs_attention"].includes(remoteRun.lastKnownRun.state)}
                          request={api} pendingStore={humanApprovalPending.current} details={approval => <PermissionDetails kind={approval.kind} details={approval.details} />} />
                        <p className="hint">Lost contact does not stop the owner worker.</p>
                        <Group><Button variant="light" disabled={busy || !connected} onClick={() => void act(async () => { await api(`/runs/${remoteRun.id}`); })}>Check owner status</Button>
                          <Button color="orange" variant="light" disabled={busy || !connected || !remoteRun.ownerRunId} onClick={() => void act(async () => { await api(`/runs/${remoteRun.id}/stop`, {}); })}>Request stop</Button></Group>
                        {remoteRun.lastKnownRun?.state === "completed" && <Button variant="light" disabled={!connected || busy} onClick={() => openRemoteTask(remoteRun)}>{remoteRun.lastKnownRun.followUp?.kind === "review" ? "Fix findings" : "Review work"}</Button>}
                        <GitChanges key={remoteRun.id} runId={remoteRun.id} projectId={projectId} snapshot={snapshot} connected={connected} request={api} />
                        {remoteRun.lastKnownRun?.result && <pre className="worker-result">{remoteRun.lastKnownRun.result}</pre>}
                      </Stack> : run ? (
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
                            {run.effectiveModel || run.model || "Harness default model"}{" "}
                            · {time(run.createdAt)}
                          </p>
                          <p className="hint instruction-path">
                            Started by: {run.launchSource?.kind === "ui" ? "Local UI" :
                              run.launchSource?.kind === "mcp" ? `${run.launchSource.clientName}${run.launchSource.clientVersion ? ` ${run.launchSource.clientVersion}` : ""} · MCP client report` :
                              "Unknown"}
                          </p>
                          {run.workspace?.kind === "worktree" && <p className="hint instruction-path">
                            Worktree: {run.workspace.path || (run.state === "running" ? "Claude is preparing it" : "Folder was not confirmed")}
                            {run.workspace.branch ? ` · ${run.workspace.branch}` : ""}.
                            {run.workspace.verified ? " Changes stay there until you move or remove them." : " The folder is not verified yet."}
                            {!run.workspace.path && run.workspace.plannedPath ? ` Expected folder: ${run.workspace.plannedPath}.` : ""}
                          </p>}
                          {run.harness === "muse" && <MuseSubscriptionUsageView usage={run.museSubscriptionUsage} />}
                          {linkedRuns.length > 1 && (
                            <div>
                              <strong>Linked work</strong>
                              <Group gap="xs" mt="xs">
                                {linkedRuns.map((item) => (
                                  <Button key={item.id} size="xs" variant={item.id === run.id ? "filled" : "light"}
                                    onClick={() => setRunId(item.id)}>
                                    {item.followUp?.kind === "review" ? "Review" : item.followUp?.kind === "fix" ? "Fix" : "Original"} · {labels[item.state]}
                                  </Button>
                                ))}
                              </Group>
                            </div>
                          )}
                          <GitChanges key={run.id} runId={run.id} projectId={projectId} snapshot={snapshot} connected={connected} request={api} />
                          {run.state === "completed" && run.followUp?.kind !== "review" && (
                            <Button size="xs" variant="light" onClick={() => openTask(run)}>Review work</Button>
                          )}
                          {run.state === "completed" && run.followUp?.kind === "review" && (
                            <Button size="xs" variant="light" onClick={() => openTask(run)}>Fix findings</Button>
                          )}
                          {run.routing && (
                            <details>
                              <summary>Model choice at launch</summary>
                              <p className="hint">
                                {harnessName(run.routing.selected.harness)} · {run.routing.selected.model}
                                {run.routing.selected.device && ` · ${run.routing.selected.device.label}`}
                                {run.routing.selected.basis === "task-pin" ? " · Task model pin" :
                                  run.routing.selected.basis === "role-pin" ? " · Saved role model pin" : " · Policy choice"}
                              </p>
                              <p className="hint">
                                Saved preference: {run.routing.preference}. Task: {run.routing.taskType || "coding"}, {run.routing.complexity}
                                {run.routing.requiresImages ? ", images needed" : ""}.
                                Native list checked {time(run.routing.catalogCheckedAt)}. Policy {run.routing.policyVersion}.
                              </p>
                              {run.routing.selected.benchmark && <BenchmarkEvidenceView evidence={run.routing.selected.benchmark} method={run.routing.benchmarkMethod} />}
                              {run.routing.reasons.length > 0 && <ul>{run.routing.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                              {run.routing.warnings.length > 0 && <ul>{run.routing.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                              <p className="hint">Requested model: {run.model || "native default"}. Native reported model: {run.effectiveModel || "not reported"}.</p>
                            </details>
                          )}
                          <RunContext
                            key={`context-${run.id}`}
                            run={run}
                            connected={connected}
                          />
                          {!["running", "needs_attention"].includes(run.state) && (
                            <NativeHandoff key={`handoff-${run.id}`} runId={run.id} connected={connected}
                              projectBusy={snapshot.runs.some((item) => item.projectId === run.projectId &&
                                (item.workspace?.kind === "worktree" ? item.workspace.rootRunId : "project") ===
                                (run.workspace?.kind === "worktree" ? run.workspace.rootRunId : "project") &&
                                ["running", "needs_attention"].includes(item.state))} />
                          )}
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
            {view === "Context" && !project && (
              <p className="empty-note">
                Add an existing project to save its context.
              </p>
            )}
            {view === "Team" &&
              (project ? (
                <section className="content-panel">
                  <h2>Roles for {project.name}</h2>
                  <p className="muted">
                    Save who should do what. Your MCP host can choose a role.
                    Installed Codex, Claude Code, Muse and OpenCode harnesses can run workers.
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
                    Automatic model choice uses this saved preference when you
                    start a task with it enabled. It does not enforce a budget.
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
                        <Select label="Computer" value={role.peerId || "local"} data={[
                          { value: "local", label: `This computer${snapshot.device ? ` · ${snapshot.device.label}` : ""}` },
                          ...projectPeers.map((peer) => ({ value: peer.id, label: peer.label })),
                          ...(role.peerId && !projectPeers.some((peer) => peer.id === role.peerId) ? [{ value: role.peerId, label: "Saved computer unavailable", disabled: true }] : []),
                        ]} onChange={(value) => setRoles(roles.map((r) => r.id === role.id ? { ...r, peerId: value && value !== "local" ? value : undefined } : r))} />
                        <Select
                          label="Harness"
                          value={role.harness}
                          data={[
                            ...(role.peerId ? ["codex", "claude", "muse", "opencode"].map((id) => ({ value: id, label: harnessName(id) })) : workers.map((h) => ({ value: h.id, label: h.name }))),
                            ...(![...(role.peerId ? ["codex", "claude", "muse", "opencode"] : workers.map((h) => h.id))].includes(role.harness) && !workers.some((h) => h.id === role.harness)
                              ? [{ value: role.harness, label: `${harnessName(role.harness)} (worker unavailable)`, disabled: true }]
                              : []),
                          ]}
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
                        <Autocomplete
                          data={role.peerId ? [] : modelChoices(role.harness)}
                          label="Model (optional)"
                          placeholder={`${harnessName(role.harness)} native default`}
                          value={role.model || ""}
                          onChange={(value) =>
                            setRoles(
                              roles.map((r) =>
                                r.id === role.id ? { ...r, model: value } : r,
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
            {view === "Models" && (
              <section className="content-panel">
                <h2>Native model list</h2>
                <p className="muted">
                  Models offered by your native harness. A listing does not
                  verify sign-in or account access. Any prices in vendor
                  descriptions are API prices, not your subscription bill.
                </p>
                {catalogHeader}
                <Benchmarks connected={connected} snapshot={benchmarks} onChange={setBenchmarks} />
                {catalog?.harnesses.map((entry) => (
                  <div className="role-card" key={entry.harness}>
                    <h3>{harnessName(entry.harness)}</h3>
                    {entry.auth && <Alert color={entry.auth.status === "sign_in_required" ? "orange" : "blue"}>{entry.auth.message}</Alert>}
                    {entry.modelsMessage &&
                      (entry.harness === "muse" || entry.modelsStatus === "unavailable" ||
                        entry.modelsTruncated) && (
                        <p className="hint">{entry.modelsMessage}</p>
                      )}
                    {entry.modelsStatus === "unavailable" && (
                      <p>Model list unavailable.</p>
                    )}
                    {entry.modelsTruncated && (
                      <Alert color="orange">
                        The native model list was shortened.
                      </Alert>
                    )}
                    {entry.models.map((item) => (
                      <div className="catalog-model" key={item.id}>
                        <Group gap="xs">
                          <strong>{item.name}</strong>
                          {item.isDefault && (
                            <Badge size="xs">Native default</Badge>
                          )}
                        </Group>
                        <p className="hint">
                          {item.id}
                          {item.resolvedModel
                            ? ` · Resolves to ${item.resolvedModel}`
                            : ""}
                          {" · "}Inputs:{" "}
                          {item.inputModalities?.length
                            ? item.inputModalities.join(", ")
                            : "Unknown"}
                        </p>
                        {item.description && <p>{item.description}</p>}
                        <BenchmarkDetail snapshot={benchmarks} harness={entry.harness} model={item.resolvedModel || item.id} />
                      </div>
                    ))}
                    {entry.modelsStatus === "available" &&
                      !entry.models.length && <p>No models were returned.</p>}
                  </div>
                ))}
                <p className="hint">
                  Choose a listed model or enter a custom model in New task or Team.
                  Muse model descriptions include native data-use terms. Leave the worker model blank to use the saved
                  role model or native default.
                </p>
              </section>
            )}
            {view === "Usage" && (
              <section className="content-panel">
                <h2>Reported usage</h2>
                <p className="muted">
                  Token counts come from native worker events. Dollar cost is
                  unknown.
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
                    <span>Dollar cost</span>
                    <strong className="unknown">Unknown</strong>
                  </div>
                </div>
                <p className="hint">
                  A zero total means no tokens have been reported. It does not
                  mean the work was free.
                </p>
                {hasMuseRuns && <>
                  <h2>Muse subscription usage</h2>
                  <MuseSubscriptionUsageView usage={museUsage} />
                </>}
                <h2>Native account allowance</h2>
                <p className="muted">
                  These limits apply across your native account. They are not
                  calculated from the task tokens above.
                </p>
                {catalogHeader}
                {catalog?.harnesses.map((entry) => (
                  <div className="role-card" key={entry.harness}>
                    <h3>{harnessName(entry.harness)}</h3>
                    {entry.quota.message && <p>{entry.quota.message}</p>}
                    {entry.quota.observedAt && <p className="hint">Observed: {new Date(entry.quota.observedAt).toLocaleString()}</p>}
                    <div>
                      {entry.quota.ordinaryUsageAllowed === false ? (
                        <Alert color="orange">
                          Native included usage is blocked.
                        </Alert>
                      ) : entry.quota.ordinaryUsageAllowed === true ? (
                        "Native included usage is allowed."
                      ) : (
                        "Included usage permission: unknown."
                      )}
                    </div>
                    {entry.quota.status === "unavailable" && (
                      <p>Account allowance unavailable.</p>
                    )}
                    {entry.quota.buckets.map((bucket) => (
                      <div key={bucket.id}>
                        <h4>{bucket.name || bucket.id}</h4>
                        {bucket.normalModel && (
                          <p className="hint">Model: {bucket.normalModel}</p>
                        )}
                        <QuotaWindowView
                          label="Primary window"
                          window={bucket.primary}
                        />
                        <QuotaWindowView
                          label="Secondary window"
                          window={bucket.secondary}
                        />
                        <p className="hint">
                          Spend control:{" "}
                          {bucket.spendControlReached === null
                            ? "Unknown"
                            : bucket.spendControlReached
                              ? "Limit reached"
                              : "Limit not reached"}
                        </p>
                      </div>
                    ))}
                    {entry.quota.status === "available" &&
                      !entry.quota.buckets.length && (
                        <p>No allowance windows were returned.</p>
                      )}
                  </div>
                ))}
              </section>
            )}
            {view === "Settings" && (
              <section className="content-panel">
                <h2>Connect your native harness</h2>
                <p className="muted">
                  Your harness stays in charge. Add AgentKlar as an MCP server
                  to register projects, start workers and collect results.
                </p>
                {!connected && <>
                  {setup}
                </>}
                {connected && backgroundSetup}
                {connected && <NativeInstallations device={snapshot.device} request={api} />}
                <Devices device={snapshot.device} projects={snapshot.projects} connected={connected} request={api} />
                <h3>Native connection</h3>
                {connected && project ? <NativeSetupForm key={project.id} projectId={project.id} connected={connected} /> : connected ? <p className="hint">Add or select a project to connect Codex, Claude Code, Muse, or OpenCode.</p> :
                  <p className="hint">Open the local app and select a project. Settings can then check, preview and add the native connection. This hosted guide has no access to your computer.</p>}
                <details><summary>Manual setup for other MCP hosts</summary><pre>{snippet}</pre></details>
                <h3>Harnesses on this computer</h3>
                {connected ? (
                  snapshot.harnesses.map((h) => (
                    <div className="harness" key={h.id}>
                      <div>
                        <strong>{h.name}</strong>
                        <p>{h.reason}</p>
                        {h.executable && <p className="hint">Current CLI: {h.executable}</p>}
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
                  Installed means the executable was found. Sign in through your
                  native harness before starting a worker.
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
        title={followUp ? (followUp.kind === "review" ? "Review work" : "Fix findings") : "Start a task"}
        classNames={{ body: "task-modal-body" }}
        yOffset="5vh"
        centered
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const task = await api<Run>("/tasks/start", {
                projectId: draftProjectId,
                prompt,
                idempotencyKey: crypto.randomUUID(),
                roleId: roleId || undefined,
                harness: taskHarness === "automatic" ? undefined : taskHarness,
                model: model.trim() || undefined,
                ...(automaticRouting ? { routing: { complexity, requiresImages, taskType, deviceScope } } : {}),
                readOnly,
                includeProjectContext,
                ...(followUp ? { followUp } : {}),
                ...(!followUp ? { workspace: remoteRole ? "worktree" : workspace } : {}),
              });
              setProjectId(draftProjectId);
              setRunId(task.id);
              setTaskModal(false);
              setFollowUp(null);
              setPrompt("");
            });
          }}
        >
          <Stack gap="sm">
            {error && <Alert color="red">{error}</Alert>}
            {followUp && <p className="hint">Linked to a completed run in {taskProject?.name || "this project"}. {followUp.kind === "review" ? "Review is read only." : "Fix can change workspace files."} Choose the worker and model below.</p>}
            {followUp ? <p className="hint">This task uses the same workspace as its linked work{remoteFollowUp ? " on the owner computer" : ""}.</p> : <>
              <Select label="Workspace" disabled={remoteRole} value={remoteRole ? "worktree" : workspace} allowDeselect={false}
                onChange={(value) => setWorkspace(value as "project" | "worktree")}
                data={[{ value: "project", label: "Current project folder" }, { value: "worktree", label: "New worktree (separate folder)" }]} />
              {workspace === "worktree" && <p className="hint">Starts from the latest local commit. Uncommitted changes and local-only files stay in the current folder; Claude may include files through its own .worktreeinclude. The new folder and its changes are kept after the task ends. At most two workers can run in one project.</p>}
            </>}
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
                taskProject?.roles.filter((r) => (!remoteFollowUp || snapshot.peers?.some((p) => p.id === r.peerId && p.deviceId === followUpPeer?.deviceId && p.remoteProjectId === followUpPeer?.remoteProjectId)) && (r.peerId || workers.some((h) => h.id === r.harness))).map((r) => ({ value: r.id, label: r.name })) ||
                []
              }
            />
            <Select
              label="Worker harness"
              value={taskHarness}
              disabled={Boolean(selectedRole)}
              placeholder="No installed worker harness"
              data={!selectedRole && !followUp && automaticRouting ? [{value:"automatic",label:"Automatic"}, ...["codex", "claude", "muse", "opencode"].map((id) => ({value:id,label:harnessName(id)}))] : remoteRole ? ["codex", "claude", "muse", "opencode"].map((id) => ({ value: id, label: harnessName(id) })) : workers.map((h) => ({ value: h.id, label: h.name }))}
              onChange={(id) => {
                setHarness(id || "codex");
                setModel("");
              }}
            />
            {selectedRole && (
              <p className="hint">The saved role chooses its harness{remoteRole ? ` on ${snapshot.peers?.find((p) => p.id === selectedRole.peerId)?.label || "the saved remote computer"}` : ""}. {remoteRole && "Its native accounts and permission rules apply; approvals are answered on that computer."}</p>
            )}
            {!taskWorker && (
              <Alert color="orange">
                {selectedRole
                  ? "This role does not have an installed, supported worker harness. Choose another role or change it in Team."
                  : "Install Codex, Claude Code, Muse or OpenCode to start a worker."}
              </Alert>
            )}
            <Autocomplete
              data={remoteRole ? [] : modelChoices(taskHarness, draftProjectId)}
              label="Model (optional)"
              placeholder={
                selectedRole?.model ||
                (automaticRouting
                  ? "Chosen from saved preference on Start"
                  : `${harnessName(taskHarness)} native default`)
              }
              value={model}
              onChange={setModel}
            />
            {selectedRole?.model && !model.trim() && (
              <p className="hint">This role pins {selectedRole.model}. Type a task model to override it.</p>
            )}
            {taskHarness === "muse" && museModel?.description && (
              <Alert color="blue" title={`${museModel.name}${museModel.isDefault && !model.trim() && !selectedRole?.model ? " · Native default" : ""}`}>
                {museModel.description}
              </Alert>
            )}
            {taskHarness === "muse" && catalogBusy === draftProjectId && <p className="hint">Loading Muse model descriptions…</p>}
            {taskHarness === "muse" && catalogError?.projectId === draftProjectId && <Alert color="orange">Muse model descriptions are unavailable: {catalogError.message}</Alert>}
            {taskHarness === "opencode" && <p className="hint">OpenCode uses its own providers, sign-in and permissions. Its listed models show capabilities, not access or cost. Leave Model blank for its native default.</p>}
            {!remoteRole && taskHarness === "claude" && catalogs[draftProjectId]?.harnesses.find((entry) => entry.harness === "claude")?.auth?.status === "sign_in_required" &&
              <Alert color="orange">{catalogs[draftProjectId]?.harnesses.find((entry) => entry.harness === "claude")?.auth?.message}</Alert>}
            {remoteRole && <p className="hint">Remote work uses a separate worktree on the owner computer. Both projects need the same committed Git HEAD. Local changes are not copied. Model choice is checked by the owner at launch.</p>}
            <Checkbox
              label="Choose model automatically"
              checked={automaticRouting}
              onChange={(e) => { setAutomaticRouting(e.currentTarget.checked); if (!e.currentTarget.checked && harness === "automatic") setHarness(workers[0]?.id || "codex"); }}
            />
            {automaticRouting && !selectedRole && !followUp && <Select label="Choose on" value={deviceScope} allowDeselect={false}
              data={[{value:"connected",label:"Connected computers"},{value:"local",label:"This computer"}]}
              onChange={(value) => setDeviceScope(value as "connected" | "local")} />}
            {automaticRouting && !selectedRole && !followUp && <p className="hint">{deviceScope === "local" ? "Automatic choice stays on this computer." : workspace === "project" ? "Using the project folder keeps this task on this computer. Choose a separate worktree to consider mapped computers." : "Mapped computers are checked at launch. Native approvals stay on the chosen owner computer."}</p>}
            <p className="hint">
              {automaticRouting
                ? "Uses the saved cost preference and task needs when you select Start worker. Any chosen harness, role and model pin stay fixed."
                : "Uses the model above, or the native harness default if none is set."}
            </p>
            <details>
              <summary>Task needs and model preview</summary>
              <Stack gap="sm" mt="sm">
                <p className="hint">
                  Saved preference: {taskProject?.preference === "best"
                    ? "Best capability"
                    : taskProject?.preference === "economical" ? "Economical" : "Balanced"}.
                  Change and save it in Team.
                </p>
                <Select
                  label="Task complexity"
                  value={complexity}
                  onChange={(value) => setComplexity(value as WorkerAdvice["complexity"])}
                  data={[
                    { value: "routine", label: "Routine" },
                    { value: "standard", label: "Standard" },
                    { value: "hard", label: "Hard" },
                  ]}
                />
                <Select label="Task type" value={taskType} allowDeselect={false}
                  data={[{ value: "coding", label: "Coding" }, { value: "reasoning", label: "Reasoning" }, { value: "data-analysis", label: "Data analysis" }, { value: "language", label: "Language" }]}
                  onChange={(value) => setTaskType(value as TaskType)} />
                <Checkbox
                  label="Images needed"
                  checked={requiresImages}
                  onChange={(e) => setRequiresImages(e.currentTarget.checked)}
                />
                <p className="hint">
                  Checks model image support. Browser and tool access depend on
                  the native harness.
                </p>
                {remoteRole && <p className="hint">{remoteFollowUp && !selectedRole ? "Owner model choice is checked when you start. Choose a saved role on this owner for a model preview." : "Model preview reads the owner computer's native catalog. Automatic choice is checked again there when you start."}</p>}
                <Button
                  variant="light"
                  loading={adviceBusy === adviceKey}
                  disabled={!connected || !draftProjectId || (!!remoteFollowUp && !selectedRole)}
                  onClick={() => void suggestModel()}
                >
                  Suggest a model
                </Button>
                {adviceError?.key === adviceKey && (
                  <Alert color="red">{adviceError.message}</Alert>
                )}
                {currentAdvice && (
                  <div aria-live="polite">
                    <strong>
                      {adviceChoice
                        ? `${harnessName(adviceChoice.harness)} · ${adviceChoice.model}${adviceChoice.device ? ` · ${adviceChoice.device.label}` : ""}`
                        : "No suitable model found"}
                    </strong>
                    {adviceChoice?.basis !== "policy" && adviceChoice && (
                      <p className="hint">
                        {adviceChoice.basis === "task-pin" ? "Your task model pin" : "Saved role model pin"}
                      </p>
                    )}
                    {!adviceChoice && (
                      <ul>
                        {currentAdvice.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    )}
                    {adviceChoice?.warnings.filter((warning) => /headroom is low|usage credits|data-use|capability|exhausted/i.test(warning))
                      .map((warning) => <Alert color="orange" key={warning}>{warning}</Alert>)}
                    {adviceChoice && <p className="hint">Checked again on Start.</p>}
                    {adviceChoice && !adviceChoice.device?.peerId && (
                      <Button
                        size="xs"
                        variant="light"
                        disabled={!canUseAdvice}
                        onClick={() => {
                          if (!canUseAdvice) return;
                          setHarness(adviceChoice.harness);
                          setModel(adviceChoice.model);
                        }}
                      >
                        Use suggestion
                      </Button>
                    )}
                    <details>
                      <summary>{adviceChoice ? "Why this suggestion" : "Details"}</summary>
                      <p className="hint">Native policy advice may use LiveBench reference scores to break ties. Subscription cost remains unknown.</p>
                      {adviceChoice?.benchmark && <BenchmarkEvidenceView evidence={adviceChoice.benchmark} method={currentAdvice.benchmarkMethod} />}
                      {adviceChoice && (
                        <ul>
                          {[...new Set([...currentAdvice.reasons, ...adviceChoice.reasons])]
                            .map((reason) => <li key={reason}>{reason}</li>)}
                        </ul>
                      )}
                      <ul>
                        {[...new Set([...currentAdvice.warnings, ...(adviceChoice?.warnings || [])])]
                          .map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                      <p className="hint">Native list checked {time(currentAdvice.catalogCheckedAt)}.</p>
                      {currentAdvice.sources.length > 0 && (
                        <ul>
                          {currentAdvice.sources.map((source) => (
                            <li key={source}>
                              <a href={source} target="_blank" rel="noreferrer">{source}</a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </details>
                  </div>
                )}
              </Stack>
            </details>
            <Checkbox
              label="Use project context"
              checked={includeProjectContext}
              onChange={(e) =>
                setIncludeProjectContext(e.currentTarget.checked)
              }
            />
            <p className="hint">
              Uses this project's saved brief, decisions and next steps at launch.
            </p>
            <Checkbox
              label="Read only"
              checked={readOnly}
              disabled={!!followUp}
              onChange={(e) => setReadOnly(e.currentTarget.checked)}
            />
            {(taskHarness === "muse" || taskHarness === "opencode") && <p className="hint">{harnessName(taskHarness)} cannot enforce read-only work. Turn off Read only for a regular task, or choose Codex or Claude Code for a review.</p>}
            {readOnly && taskHarness !== "muse" && taskHarness !== "opencode" && (
              <p className="hint">
                {taskHarness === "claude"
                  ? "Claude can use only Read, Glob and Grep tools. Your configured hooks can still run. This does not add an operating system sandbox."
                  : taskHarness === "automatic" ? "The chosen worker uses its native read-only controls." : "Codex uses its native read-only sandbox."}
              </p>
            )}
            <p className="hint">
              {taskHarness === "automatic" ? "Chooses a native worker" : `Runs a native ${harnessName(taskHarness)} worker`} in {taskProject?.name}
              . Native permission requests appear {remoteRole || connectedRouting ? "in AgentKlar on the owner computer" : "in the task detail"}.
            </p>
            <Button type="submit" loading={busy} disabled={!taskWorker || !taskProject || ((taskHarness === "muse" || taskHarness === "opencode") && readOnly)}>
              Start worker
            </Button>
          </Stack>
        </form>
      </Modal>
    </div>
  );
}

function MuseSubscriptionUsageView({ usage }: { usage?: MuseSubscriptionUsage }) {
  return <div className="subscription-usage">
    <strong>{usage ? `Account snapshot as of ${new Date(usage.observedAtMs).toLocaleString()}` : "Account snapshot unknown"}</strong>
    {usage ? <div>
      {usage.window.windowDurationMins}-minute window: {usage.window.usedPercent}% used; resets {new Date(usage.window.resetsAtMs).toLocaleString()}.<br />
      Weekly: {usage.weekly.usedPercent}% used; resets {new Date(usage.weekly.resetsAtMs).toLocaleString()}.
    </div> : <div>No Muse subscription usage was observed for this work.</div>}
    <div className="hint">This account snapshot may include work outside AgentKlar. It is a past reading, not a live balance or dollar cost.</div>
  </div>;
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
        <p>
          <strong>{d.file_path}</strong>
        </p>
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

function ContextForm({
  projectId,
  connected,
}: {
  projectId: string;
  connected: boolean;
}) {
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [draft, setDraft] = useState({ brief: "", memory: "", handoff: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api<ProjectContext>(`/projects/${projectId}/context`)
      .then((value) => {
        if (!active) return;
        setContext(value);
        setDraft({
          brief: value.brief,
          memory: value.memory,
          handoff: value.handoff,
        });
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  async function loadLatest() {
    setLoading(true);
    setError("");
    try {
      const value = await api<ProjectContext>(`/projects/${projectId}/context`);
      setContext(value);
      setDraft({
        brief: value.brief,
        memory: value.memory,
        handoff: value.handoff,
      });
      setConflict(false);
      setSaved(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="content-panel context-panel">
      <h2>Shared project context</h2>
      <p className="muted">
        Save the brief, decisions and next steps for your native harnesses and
        new tasks. Your harness stays in charge.
      </p>
      <p className="hint">
        Memory is saved by you or through MCP. AgentKlar does not collect it
        automatically from chats or files.
      </p>
      {loading && <p className="hint">Loading project context…</p>}
      {context && (
        <p className="hint">
          {context.revision === 0
            ? "No saved context yet."
            : `Revision ${context.revision}`}
          {context.updatedAt && ` · Saved ${time(context.updatedAt)}`}
          {context.updatedVia &&
            ` · ${context.updatedVia === "ui" ? "Local UI" : "MCP"}`}
        </p>
      )}
      {error && (
        <Alert
          color="red"
          title={
            conflict ? "Context changed" : "Could not save or load context"
          }
        >
          {conflict
            ? "Someone saved a newer revision. Your draft is still here. Load the latest context to replace this draft."
            : error}
        </Alert>
      )}
      {saved && <Alert color="teal">Project context saved.</Alert>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!context || saving || loading || !connected || conflict) return;
          setSaving(true);
          setError("");
          setSaved(false);
          void api<ProjectContext>(
            `/projects/${projectId}/context`,
            {
              ...draft,
              expectedRevision: context.revision,
            },
            "PUT",
          )
            .then((value) => {
              setContext(value);
              setDraft({
                brief: value.brief,
                memory: value.memory,
                handoff: value.handoff,
              });
              setSaved(true);
            })
            .catch((e: Error & { status?: number }) => {
              setError(e.message);
              setConflict(e.status === 409);
            })
            .finally(() => setSaving(false));
        }}
      >
        <Stack>
          {(
            [
              [
                "brief",
                "Project brief",
                2000,
                "What are we building, and what matters?",
              ],
              [
                "memory",
                "Decisions and lessons",
                4000,
                "What should future work remember?",
              ],
              ["handoff", "Next steps", 2000, "What should happen next?"],
            ] as const
          ).map(([field, label, maxLength, placeholder]) => (
            <Textarea
              key={field}
              label={label}
              placeholder={placeholder}
              description={`Up to ${maxLength.toLocaleString()} characters.`}
              maxLength={maxLength}
              minRows={field === "memory" ? 5 : 3}
              autosize
              disabled={loading || saving || !context || !connected}
              value={draft[field]}
              onChange={(e) => {
                setDraft({ ...draft, [field]: e.currentTarget.value });
                setSaved(false);
              }}
            />
          ))}
          <Group>
            <Button
              type="submit"
              loading={saving}
              disabled={!connected || !context || loading || conflict}
            >
              Save context
            </Button>
            <Button
              variant="subtle"
              onClick={() => void loadLatest()}
              disabled={!connected || saving || loading}
            >
              Load latest (replaces draft)
            </Button>
          </Group>
        </Stack>
      </form>
    </section>
  );
}

function NativeHandoff({ runId, connected, projectBusy }: { runId: string; connected: boolean; projectBusy: boolean }) {
  const [packet, setPacket] = useState<RunHandoff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const canShow = connected && !projectBusy;
  const currentCanShow = useRef(canShow);
  currentCanShow.current = canShow;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!canShow) { setPacket(null); setCopied(false); }
  }, [canShow]);
  async function load() {
    if (!canShow || pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    setPacket(null);
    setCopied(false);
    try {
      const data = await api<RunHandoff>(`/runs/${runId}/handoff`);
      if (mounted.current && currentCanShow.current) setPacket(data);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  async function copy() {
    if (!packet?.command || !canShow || pending.current) return;
    pending.current = true;
    setLoading(true);
    setCopied(false);
    setError("");
    try {
      let current: RunHandoff;
      try {
        current = await api<RunHandoff>(`/runs/${runId}/handoff`);
      } catch (e) {
        if (mounted.current) {
          setPacket(null);
          setError(`Could not refresh the native command: ${(e as Error).message} Show it again to retry.`);
        }
        return;
      }
      if (!mounted.current || !currentCanShow.current) return;
      setPacket(current);
      if (!current.command) return;
      try {
        await navigator.clipboard.writeText(current.command.display);
        if (mounted.current && currentCanShow.current) setCopied(true);
      } catch {
        if (mounted.current && currentCanShow.current)
          setError("Could not copy the command. Select the text below instead.");
      }
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  return (
    <details className="run-context">
      <summary>Continue in native harness</summary>
      <p className="hint">Show a command for your terminal. AgentKlar will not run it.</p>
      <Button size="xs" variant="light" loading={loading} disabled={!canShow} onClick={() => void load()}>
        Show native command
      </Button>
      {projectBusy && <p className="hint">A worker is active in this checkout. Close it before preparing a native command.</p>}
      {error && <Alert color="red">{error}</Alert>}
      {canShow && packet && !packet.available && <Alert color="yellow">{packet.reason}</Alert>}
      {canShow && packet?.command && (
        <div>
          <p className="hint">Copy into your terminal (macOS or Linux):</p>
          <Button size="xs" variant="light" disabled={loading} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy command"}
          </Button>
          <pre className="result native-command" tabIndex={0} aria-label="Native continuation command">{packet.command.display}</pre>
          {packet.notes.map((note) => <p className="hint" key={note}>{note}</p>)}
        </div>
      )}
    </details>
  );
}

function RunContext({ run, connected }: { run: Run; connected: boolean }) {
  const [snapshot, setSnapshot] = useState<ProjectContext | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (!connected || loaded || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<{
        runId: string;
        contextSnapshot: ProjectContext | null;
      }>(`/runs/${run.id}/context`);
      setSnapshot(data.contextSnapshot);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  if (run.contextRevision == null)
    return (
      <p className="hint">Project context was not included in this task.</p>
    );
  return (
    <details
      className="run-context"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>Project context · revision {run.contextRevision}</summary>
      <p className="hint">Saved context used when this task started.</p>
      {loading && <p className="hint">Loading context…</p>}
      {error && (
        <Alert color="red">
          {error}{" "}
          <Button size="xs" variant="subtle" onClick={() => void load()}>
            Try again
          </Button>
        </Alert>
      )}
      {loaded &&
        (snapshot ? (
          <>
            {(
              [
                ["brief", "Project brief"],
                ["memory", "Decisions and lessons"],
                ["handoff", "Next steps"],
              ] as const
            ).map(([field, label]) => (
              <div key={field}>
                <h3>{label}</h3>
                <pre>{snapshot[field] || "None saved."}</pre>
              </div>
            ))}
          </>
        ) : (
          <p className="hint">No saved context was included.</p>
        ))}
    </details>
  );
}

function QuotaWindowView({
  label,
  window,
}: {
  label: string;
  window: QuotaWindow | null;
}) {
  if (!window) return <p className="hint">{label}: unknown.</p>;
  const used = Math.min(100, Math.max(0, window.usedPercent));
  return (
    <div>
      <p>
        {label}: {window.usedPercent}% used ·{" "}
        {Math.round((100 - used) * 10) / 10}% remaining
      </p>
      <Progress value={used} aria-label={`${label}: ${used}% used`} />
      <p className="hint">
        Duration:{" "}
        {window.windowDurationMins === null
          ? "Unknown"
          : window.windowDurationMins % 1440 === 0
            ? `${window.windowDurationMins / 1440} days`
            : window.windowDurationMins % 60 === 0
              ? `${window.windowDurationMins / 60} hours`
              : `${window.windowDurationMins} minutes`}
        {" · "}Reset:{" "}
        {window.resetsAt === null
          ? "Unknown"
          : new Date(window.resetsAt * 1000).toLocaleString(undefined, {
              timeZoneName: "short",
            })}
      </p>
    </div>
  );
}
