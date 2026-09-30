import Usage from "./Usage";
import { useEffect, useRef, useState } from "react";
import {
  Accordion,
  Alert,
  AppShell,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  NavLink,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
  useMantineColorScheme,
  useComputedColorScheme,
} from "@mantine/core";
import { Spotlight, spotlight } from "@mantine/spotlight";
import { useDisclosure } from "@mantine/hooks";
import {
  api,
  apiResponse,
  attentionStates,
  isLocal,
  label,
  stateColor,
} from "./api";
import type {
  AlertRow,
  Context,
  Detail,
  Memory,
  Project,
  Run,
  Task,
} from "./api";

type View = "Work" | "Team" | "Usage" | "Settings";
const views: View[] = ["Work", "Team", "Usage", "Settings"];
const symbols = ["▤", "◎", "↗", "⚙"];
const time = (value: string) =>
  value ? new Date(value).toLocaleString() : "Not recorded";

export default function App() {
  const [view, setView] = useState<View>("Work");
  const [human, setHuman] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectID, setProjectID] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runError, setRunError] = useState("");
  const [newOpened, newModal] = useDisclosure(false);
  const [navOpened, nav] = useDisclosure(false);
  const search = useRef<HTMLInputElement>(null);
  const project = projects.find((p) => p.ID === projectID);
  const base = projectID
    ? `/api/projects/${encodeURIComponent(projectID)}`
    : "/api";
  const reload = () => setRefresh((n) => n + 1);
  const chooseProject = (id: string) => {
    setSelected("");
    setTasks([]);
    setDetail(null);
    setProjectID(id);
  };
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme("light");

  useEffect(() => {
    if (!isLocal) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    api<{ human: boolean }>("/api/session", "GET", undefined, controller.signal)
      .then((data) => setHuman(data.human))
      .catch(() => {});
    api<Project[]>("/api/projects", "GET", undefined, controller.signal)
      .then((rows) => {
        setProjects(rows);
        const remembered = localStorage.getItem("agentklar-project");
        setProjectID(
          rows.some((p) => p.ID === remembered)
            ? remembered!
            : rows[0]?.ID || "",
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!projectID) return;
    localStorage.setItem("agentklar-project", projectID);
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDetail(null);
    setRuns([]);
    api<Task[]>(`${base}/tasks`, "GET", undefined, controller.signal)
      .then((rows) => {
        setTasks(rows);
        setSelected((old) =>
          rows.some((t) => t.ID === old) ? old : rows[0]?.ID || "",
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    api<AlertRow[]>("/api/alerts", "GET", undefined, controller.signal)
      .then(setAlerts)
      .catch(() => {});
    api<{ runs: Run[] }>(`${base}/runs`, "GET", undefined, controller.signal)
      .then((data) => {
        setRuns(data.runs || []);
        setRunError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setRunError(e.message);
      });
    return () => controller.abort();
  }, [projectID, base, refresh]);

  useEffect(() => {
    if (!selected || !projectID) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    api<Detail>(
      `${base}/tasks/${encodeURIComponent(selected)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setDetail)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [selected, projectID, base, refresh]);

  const filtered = tasks.filter(
    (t) =>
      (!query ||
        `${t.ID} ${t.Title} ${t.Assignee} ${(t.Labels || []).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === "all" ||
        (filter === "attention" &&
          (attentionStates.includes(t.State) ||
            runs.some(
              (r) =>
                r.task_id === t.ID &&
                [
                  "failed",
                  "interrupted",
                  "attention_required",
                  "waiting",
                ].includes(r.status),
            ))) ||
        (filter === "active" &&
          ["ready", "in_progress", "completion_review", "auto_qa"].includes(
            t.State,
          )) ||
        (filter === "done" && t.State === "done")) &&
      (!status || t.State === status),
  );
  useEffect(() => {
    if (!filtered.some((t) => t.ID === selected))
      setSelected(filtered[0]?.ID || "");
  }, [query, filter, status, tasks, selected]);

  useEffect(() => {
    if (!projectID || (view !== "Work" && view !== "Usage")) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden) return;
      api<Task[]>(`${base}/tasks`, "GET", undefined, controller.signal)
        .then(setTasks)
        .catch(() => {});
      api<{ runs: Run[] }>(`${base}/runs`, "GET", undefined, controller.signal)
        .then((data) => setRuns(data.runs || []))
        .catch(() => {});
      api<AlertRow[]>("/api/alerts", "GET", undefined, controller.signal)
        .then(setAlerts)
        .catch(() => {});
      if (selected)
        api<Detail>(
          `${base}/tasks/${encodeURIComponent(selected)}`,
          "GET",
          undefined,
          controller.signal,
        )
          .then(setDetail)
          .catch(() => {});
    }, 4000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [projectID, base, selected, view]);
  const pendingAlerts = alerts.filter(
    (a) => !a.Acknowledged && (!a.project_id || a.project_id === projectID),
  );
  const attention =
    tasks.filter(
      (t) =>
        attentionStates.includes(t.State) ||
        runs.some(
          (r) =>
            r.task_id === t.ID &&
            ["failed", "interrupted", "attention_required", "waiting"].includes(
              r.status,
            ),
        ),
    ).length + pendingAlerts.length;
  const navigate = (next: View) => {
    setView(next);
    nav.close();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.matches("input, textarea, select") ||
        target.isContentEditable ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        search.current?.focus();
      }
      if (
        view === "Work" &&
        (target === document.body || target.classList.contains("task-row")) &&
        ["ArrowDown", "ArrowUp", "j", "k"].includes(event.key)
      ) {
        event.preventDefault();
        const index = filtered.findIndex((t) => t.ID === selected);
        const delta = ["ArrowDown", "j"].includes(event.key) ? 1 : -1;
        setSelected(
          filtered[Math.max(0, Math.min(filtered.length - 1, index + delta))]
            ?.ID || "",
        );
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filtered, selected, view]);

  async function acknowledge(alert: AlertRow) {
    try {
      await api(`${base}/alerts/${alert.ID}/ack`, "POST");
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <AppShell
        header={{ height: 66 }}
        navbar={{
          width: 226,
          breakpoint: "sm",
          collapsed: { mobile: !navOpened },
        }}
        padding="lg"
      >
        <AppShell.Header>
          <Group h="100%" px="lg" justify="space-between">
            <Group gap="sm">
              <Button
                hiddenFrom="sm"
                variant="subtle"
                onClick={nav.toggle}
                aria-label="Toggle navigation"
              >
                ☰
              </Button>
              <ThemeIcon size={30} radius="md" color="indigo">
                A
              </ThemeIcon>
              <Text fw={700} size="lg">
                AgentKlar
              </Text>
              <Badge
                variant="light"
                color={isLocal ? "teal" : "orange"}
                visibleFrom="xs"
              >
                {isLocal ? "Local workspace" : "Pairing required"}
              </Badge>
            </Group>
            <Group gap="xs">
              <Button
                variant="default"
                size="compact-sm"
                onClick={() => spotlight.open()}
              >
                Search commands{" "}
                <Text component="span" c="dimmed" ml="sm" size="xs">
                  ⌘ K
                </Text>
              </Button>
              <Button
                variant="subtle"
                size="compact-sm"
                onClick={() =>
                  setColorScheme(
                    computedColorScheme === "dark" ? "light" : "dark",
                  )
                }
                aria-label="Toggle color theme"
              >
                {computedColorScheme === "dark" ? "☀" : "☾"}
              </Button>
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar p="md">
          <Stack gap="xs">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} px="sm" mb="xs">
              Workspace
            </Text>
            {views.map((name, i) => (
              <NavLink
                component="button"
                type="button"
                key={name}
                label={name}
                leftSection={
                  <Text w={20} aria-hidden>
                    {symbols[i]}
                  </Text>
                }
                active={name === view}
                onClick={() => navigate(name)}
                rightSection={
                  name === "Work" && attention > 0 ? (
                    <Badge size="sm" color="orange">
                      {attention}
                    </Badge>
                  ) : undefined
                }
              />
            ))}
            <Divider my="lg" />
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} px="sm">
              Projects
            </Text>
            {projects.map((p) => (
              <NavLink
                component="button"
                type="button"
                key={p.ID}
                label={p.Name}
                active={p.ID === projectID}
                onClick={() => {
                  chooseProject(p.ID);
                  navigate("Work");
                }}
                leftSection={
                  <Text c="dimmed" size="sm">
                    ◇
                  </Text>
                }
              />
            ))}
            {!projects.length && (
              <Text size="sm" c="dimmed" px="sm">
                {isLocal
                  ? "No projects loaded"
                  : "Connect a local device to see projects."}
              </Text>
            )}
          </Stack>
          <Box mt="auto">
            <Divider my="md" />
            <Text size="xs" c="dimmed">
              Your tools do the coding.
              <br />
              AgentKlar keeps the work clear.
            </Text>
          </Box>
        </AppShell.Navbar>
        <AppShell.Main>
          <Group justify="space-between" mb="lg" align="flex-start">
            <div>
              <Text size="xs" c="dimmed" mb={5}>
                {project?.Name || "AgentKlar"} / {view}
              </Text>
              <Title order={1} size="h2">
                {view}
              </Title>
              <Text size="sm" c="dimmed" mt={5}>
                {view === "Work"
                  ? "Tasks, evidence, and decisions in one place."
                  : view === "Team"
                    ? "Choose who handles the work."
                    : view === "Usage"
                      ? "Know what has been measured."
                      : "Manage this workspace."}
              </Text>
            </div>
            {isLocal && (
              <Group>
                <Button variant="default" onClick={reload} loading={loading}>
                  Refresh
                </Button>
                {view === "Work" && projectID && (
                  <Button disabled={!human} onClick={newModal.open}>
                    New task
                  </Button>
                )}
              </Group>
            )}
          </Group>
          {!isLocal && (
            <Alert color="orange" title="Device pairing is still being built">
              This hosted interface cannot access your local projects. Open
              AgentKlar on your computer for work and human decisions.
              <Button
                component="a"
                href="https://github.com/kaltstart-co/agentklar/blob/main/docs/USAGE.md"
                mt="md"
                variant="default"
                size="xs"
              >
                Local setup guide
              </Button>
            </Alert>
          )}
          {isLocal && !human && (
            <Alert color="gray" mb="md" title="Read-only browser session">
              Open agentklar serve --open for human changes and native
              permission decisions.
            </Alert>
          )}
          {error && (
            <Alert
              color="red"
              title="Could not complete this request"
              mb="md"
              withCloseButton
              onClose={() => setError("")}
            >
              {error}
            </Alert>
          )}
          {isLocal && view === "Work" && (
            <>
              {runError && (
                <Alert color="gray" mb="md" title="Worker history unavailable">
                  {runError}
                </Alert>
              )}
              {pendingAlerts.length > 0 && (
                <Accordion variant="contained" mb="md">
                  <Accordion.Item value="attention">
                    <Accordion.Control>
                      <Group gap="sm">
                        <Badge color="orange" size="sm">
                          {pendingAlerts.length}
                        </Badge>
                        <Text size="sm" fw={500}>
                          Attention inbox
                        </Text>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Stack gap="sm">
                        {pendingAlerts.map((a) => (
                          <Group
                            key={`${a.project_id}-${a.ID}`}
                            justify="space-between"
                            wrap="nowrap"
                          >
                            <div>
                              <Text size="sm" fw={600}>
                                {a.Title || "Agent alert"}
                              </Text>
                              <Text size="sm" c="dimmed">
                                {a.Message || a.Body}
                              </Text>
                            </div>
                            <Button
                              size="xs"
                              variant="default"
                              disabled={!human}
                              onClick={() => acknowledge(a)}
                            >
                              Acknowledge
                            </Button>
                          </Group>
                        ))}
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              )}
              <Paper withBorder radius="lg" className="work-panel">
                <Group p="md" justify="space-between" className="work-toolbar">
                  <TextInput
                    ref={search}
                    aria-label="Search work"
                    placeholder="Search tasks…   /"
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                    className="work-search"
                  />
                  <SegmentedControl
                    aria-label="Work filter"
                    value={filter}
                    onChange={setFilter}
                    data={[
                      { value: "all", label: "All" },
                      { value: "active", label: "Active" },
                      { value: "attention", label: "Attention" },
                      { value: "done", label: "Done" },
                    ]}
                  />
                  <Select
                    aria-label="Filter by status"
                    placeholder="Any status"
                    clearable
                    value={status}
                    onChange={setStatus}
                    data={[...new Set(tasks.map((t) => t.State))].map((s) => ({
                      value: s,
                      label: label(s),
                    }))}
                    w={170}
                  />
                </Group>
                <div className="work-grid">
                  <section className="work-list" aria-label="Work list">
                    <Group px="md" py="sm" justify="space-between">
                      <Text size="xs" c="dimmed" fw={600}>
                        {filtered.length}{" "}
                        {filtered.length === 1 ? "task" : "tasks"}
                      </Text>
                      <Text size="xs" c="dimmed">
                        ↑ ↓ to select
                      </Text>
                    </Group>
                    <ScrollArea h="calc(100vh - 330px)" mih={320}>
                      {loading ? (
                        <Box p="xl">
                          <Loader size="sm" />
                        </Box>
                      ) : filtered.length ? (
                        filtered.map((t) => (
                          <UnstyledButton
                            key={t.ID}
                            className={`task-row ${selected === t.ID ? "selected" : ""}`}
                            aria-pressed={selected === t.ID}
                            onClick={() => setSelected(t.ID)}
                          >
                            <Group justify="space-between" gap="xs" mb="xs">
                              <Text size="xs" c="dimmed" ff="monospace">
                                {t.ID}
                              </Text>
                              <Badge
                                variant="light"
                                size="xs"
                                color={stateColor(t.State)}
                              >
                                {label(t.State)}
                              </Badge>
                            </Group>
                            <Text size="sm" fw={600} lineClamp={2}>
                              {t.Title}
                            </Text>
                            <Group justify="space-between" mt="sm">
                              <Text size="xs" c="dimmed">
                                {t.Assignee || "Unassigned"}
                              </Text>
                              {t.Priority && t.Priority !== "none" && (
                                <Text size="xs" c="dimmed">
                                  {label(t.Priority)}
                                </Text>
                              )}
                            </Group>
                          </UnstyledButton>
                        ))
                      ) : (
                        <Box p="xl">
                          <Text fw={500} size="sm">
                            {tasks.length
                              ? "No matching tasks"
                              : "Start with one clear task"}
                          </Text>
                          <Text size="sm" c="dimmed" mt="xs">
                            {tasks.length
                              ? "Try another search or filter."
                              : "Add the goal, what success means, and how to check it."}
                          </Text>
                        </Box>
                      )}
                    </ScrollArea>
                  </section>
                  <section className="work-detail" aria-label="Task detail">
                    {selected && !detail ? (
                      <Box p="xl">
                        <Loader size="sm" />
                      </Box>
                    ) : detail ? (
                      <TaskDetail
                        detail={detail}
                        human={human}
                        base={base}
                        projectID={projectID}
                        runs={runs.filter((r) => r.task_id === selected)}
                        reload={reload}
                        onError={setError}
                      />
                    ) : (
                      <Box p="xl">
                        <Text c="dimmed" size="sm">
                          Select a task to see its details.
                        </Text>
                      </Box>
                    )}
                  </section>
                </div>
              </Paper>
            </>
          )}
          {isLocal && (
            <Box display={view === "Team" ? undefined : "none"}>
              <TeamSettings
                base={base}
                projectID={projectID}
                refresh={refresh}
                human={human}
              />
            </Box>
          )}
          {isLocal && view === "Usage" && (
            <Usage base={base} refresh={refresh} />
          )}
          {isLocal && view === "Settings" && (
            <Stack>
              <Paper withBorder p="xl" radius="lg">
                <Title order={3}>Appearance</Title>
                <Text size="sm" c="dimmed" mb="md" mt="xs">
                  Saved in this browser.
                </Text>
                <SegmentedControl
                  aria-label="Color theme"
                  value={colorScheme}
                  onChange={(value) =>
                    setColorScheme(value as "light" | "dark" | "auto")
                  }
                  data={[
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                    { value: "auto", label: "System" },
                  ]}
                />
              </Paper>
              <Paper withBorder p="xl" radius="lg">
                <Group justify="space-between">
                  <Title order={3}>Local connection</Title>
                  <Badge color="teal">Same device</Badge>
                </Group>
                <Text size="sm" c="dimmed" mt="sm">
                  Work runs on this computer. Human changes need the browser
                  session opened by AgentKlar.
                </Text>
                <Text size="sm" mt="md">
                  Open with{" "}
                  <Text span ff="monospace">
                    agentklar serve --open
                  </Text>{" "}
                  to make decisions.
                </Text>
                <Divider my="lg" />
                <Text fw={600} size="sm">
                  Project folder
                </Text>
                <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                  {project?.RepoPath || "No project selected"}
                </Text>
                <Group mt="lg">
                  <Button component="a" href="/approvals" variant="default">
                    Human approvals
                  </Button>
                  <Button
                    component="a"
                    href={
                      projectID
                        ? `/projects/${encodeURIComponent(projectID)}/knowledge`
                        : "/knowledge"
                    }
                    variant="subtle"
                  >
                    Project knowledge
                  </Button>
                </Group>
              </Paper>
              <Paper withBorder p="xl" radius="lg">
                <Title order={3}>Hosted access</Title>
                <Text c="dimmed" size="sm" mt="sm">
                  Secure device pairing, revocation, and hosted status are
                  pending. The hosted interface has no access to this local
                  service.
                </Text>
              </Paper>
            </Stack>
          )}
        </AppShell.Main>
      </AppShell>
      <Spotlight
        shortcut={["mod + K"]}
        actions={[
          ...views.map((name) => ({
            id: name,
            label: `Open ${name}`,
            onClick: () => navigate(name),
          })),
          ...(projectID && human
            ? [
                {
                  id: "new-task",
                  label: "Create a task",
                  onClick: newModal.open,
                },
              ]
            : []),
          ...projects.map((p) => ({
            id: `project-${p.ID}`,
            label: `Switch to ${p.Name}`,
            onClick: () => {
              chooseProject(p.ID);
              navigate("Work");
            },
          })),
          ...tasks.map((t) => ({
            id: `task-${t.ID}`,
            label: t.Title,
            description: `${t.ID} · ${label(t.State)}`,
            onClick: () => {
              setSelected(t.ID);
              navigate("Work");
            },
          })),
        ]}
        nothingFound="No matching commands"
        searchProps={{ placeholder: "Find a view, project, or task…" }}
      />
      <NewTask
        opened={newOpened}
        onClose={newModal.close}
        base={base}
        onCreated={(task) => {
          setTasks((old) => [...old, task]);
          setSelected(task.ID);
          reload();
        }}
      />
    </>
  );
}

function TaskDetail({
  detail,
  human,
  base,
  projectID,
  runs,
  reload,
  onError,
}: {
  detail: Detail;
  human: boolean;
  base: string;
  projectID: string;
  runs: Run[];
  reload: () => void;
  onError: (message: string) => void;
}) {
  const task = detail.task;
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<string | null>("overview");
  useEffect(() => {
    setComment("");
    setTab("overview");
  }, [task.ID]);
  async function transition(state: string) {
    setBusy(true);
    try {
      await api(
        `${base}/tasks/${encodeURIComponent(task.ID)}/transition`,
        "POST",
        { state },
      );
      reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addComment() {
    setBusy(true);
    try {
      await api(
        `${base}/tasks/${encodeURIComponent(task.ID)}/comments`,
        "POST",
        { body: comment, type: "human" },
      );
      setComment("");
      reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Box p="lg">
        <Group justify="space-between">
          <Text size="xs" ff="monospace" c="dimmed">
            {task.ID}
          </Text>
          <Badge color={stateColor(task.State)} variant="light">
            {label(task.State)}
          </Badge>
        </Group>
        <Title order={2} size="h3" mt="md">
          {task.Title}
        </Title>
        <Group gap="lg" mt="md">
          <Text size="xs" c="dimmed">
            {task.Assignee || "Unassigned"}
          </Text>
          <Text size="xs" c="dimmed">
            Updated {time(task.UpdatedAt)}
          </Text>
        </Group>
        {task.State === "draft" && (
          <Button
            mt="md"
            size="xs"
            loading={busy}
            disabled={!human}
            onClick={() => transition("ready")}
          >
            Mark ready
          </Button>
        )}
        {task.State === "user_approval" && (
          <Alert mt="md" color="orange" title="Your approval is required">
            <Text size="sm">
              Review the evidence, then make the decision in the trusted
              approval view.
            </Text>
            <Button component="a" href="/approvals" size="xs" mt="sm">
              Review approval
            </Button>
          </Alert>
        )}
      </Box>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List px="lg">
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="evidence">
            Evidence ({detail.evidence.length})
          </Tabs.Tab>
          <Tabs.Tab value="context">Context</Tabs.Tab>
          <Tabs.Tab value="runs">Runs ({runs.length})</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" p="lg">
          <Stack gap="lg">
            <div>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb="xs">
                Goal
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {task.Objective || "No goal recorded."}
              </Text>
            </div>
            <div>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb="xs">
                Success criteria
              </Text>
              {(task.Criteria || []).length ? (
                <Stack gap="xs">
                  {task.Criteria!.map((criterion, i) => (
                    <Text size="sm" key={i}>
                      • {criterion}
                    </Text>
                  ))}
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  No criteria recorded.
                </Text>
              )}
            </div>
            <div>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb="xs">
                Verification
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {task.Verification || "No check recorded."}
              </Text>
            </div>
            {detail.dependencies.length > 0 && (
              <div>
                <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                  Depends on
                </Text>
                <Text size="sm" mt="xs">
                  {detail.dependencies.join(", ")}
                </Text>
              </div>
            )}
            <Divider />
            <div>
              <Text fw={600} size="sm" mb="md">
                Work history
              </Text>
              {detail.comments.length ? (
                <Stack gap="md">
                  {detail.comments.map((c, i) => (
                    <Box key={c.ID || i}>
                      <Group gap="sm">
                        <Text size="xs" fw={600}>
                          {c.Actor}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {time(c.CreatedAt)}
                        </Text>
                      </Group>
                      <Text mt={4} size="sm" style={{ whiteSpace: "pre-wrap" }}>
                        {c.Body}
                      </Text>
                    </Box>
                  ))}
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  No comments yet.
                </Text>
              )}
              <Textarea
                label="Add a note"
                placeholder="A decision, question, or useful detail…"
                value={comment}
                onChange={(e) => setComment(e.currentTarget.value)}
                autosize
                minRows={2}
                mt="lg"
              />
              <Button
                size="xs"
                mt="sm"
                disabled={!human || !comment.trim()}
                loading={busy}
                onClick={addComment}
              >
                Save note
              </Button>
            </div>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="evidence" p="lg">
          {detail.evidence.length ? (
            <Accordion variant="separated">
              {detail.evidence.map((e) => (
                <Accordion.Item key={e.ID} value={`${e.ID}`}>
                  <Accordion.Control>
                    <Group gap="sm">
                      <Badge
                        size="xs"
                        color={
                          e.ExitCode === null
                            ? "gray"
                            : e.ExitCode === 0
                              ? "teal"
                              : "red"
                        }
                      >
                        {e.ExitCode === null
                          ? "Unverified"
                          : e.ExitCode === 0
                            ? "Passed"
                            : "Failed"}
                      </Badge>
                      <Text size="sm">
                        {e.Criterion || e.Command || "Evidence record"}
                      </Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="xs">
                      <Text size="xs" c="dimmed">
                        {e.Provenance} · {time(e.CreatedAt)}
                      </Text>
                      {e.Command && (
                        <Text
                          size="sm"
                          ff="monospace"
                          style={{ overflowWrap: "anywhere" }}
                        >
                          {e.Command}
                        </Text>
                      )}
                      {e.Note && (
                        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                          {e.Note}
                        </Text>
                      )}
                      {e.ExitCode !== null && (
                        <Text size="sm">Exit code: {e.ExitCode}</Text>
                      )}
                      {e.LogPath && (
                        <Text size="xs" c="dimmed">
                          Local log: {e.LogPath}
                        </Text>
                      )}
                      {e.Hash && (
                        <Text
                          size="xs"
                          c="dimmed"
                          style={{ overflowWrap: "anywhere" }}
                        >
                          Recorded hash: {e.Hash}
                        </Text>
                      )}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          ) : (
            <Text size="sm" c="dimmed">
              No evidence has been recorded for this task.
            </Text>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="context" p="lg">
          {tab === "context" && (
            <TaskContext base={base} taskID={task.ID} projectID={projectID} />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="runs" p="lg">
          {runs.length ? (
            <Stack>
              {runs.map((r) => (
                <RunCard key={r.id} run={r} base={base} reload={reload} />
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              No native worker run is recorded for this task.
            </Text>
          )}
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function TaskContext({
  base,
  taskID,
  projectID,
}: {
  base: string;
  taskID: string;
  projectID: string;
}) {
  const [memory, setMemory] = useState<Memory[]>([]);
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      api<Memory[]>(
        `${base}/memory?task=${encodeURIComponent(taskID)}`,
        "GET",
        undefined,
        controller.signal,
      ),
      api<Context>(
        `${base}/context?task=${encodeURIComponent(taskID)}`,
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([mem, ctx]) => {
        setMemory(mem);
        setContext(ctx);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, taskID]);
  if (loading) return <Loader size="sm" />;
  return (
    <Stack>
      {error && <Alert color="red">{error}</Alert>}
      <Text size="xs" c="dimmed">
        Index updated: {time(context?.indexed_at || "")}
      </Text>
      <Accordion variant="separated">
        {memory.map((m) => (
          <Accordion.Item value={`memory-${m.ID}`} key={m.ID}>
            <Accordion.Control>
              <Text size="sm">Memory · {m.Key}</Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {m.Value}
              </Text>
              <Text size="xs" c="dimmed" mt="sm">
                Recorded by {m.Holder || "unknown"} · {time(m.CreatedAt)}
              </Text>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
        {context?.packet.Items?.map((item, i) => (
          <Accordion.Item
            value={`context-${i}`}
            key={`${item.Source}-${item.Ref}`}
          >
            <Accordion.Control>
              <Text size="sm">
                {label(item.Source)} · {item.Title || item.Ref}
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Text size="xs" c="dimmed" mb="sm">
                {item.Ref}
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {item.Body}
              </Text>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
      {!memory.length && !context?.packet.Items?.length && (
        <Text size="sm" c="dimmed">
          No shared context is recorded for this task.
        </Text>
      )}
      <Button
        component="a"
        href={`/projects/${encodeURIComponent(projectID)}/knowledge`}
        variant="subtle"
        size="xs"
      >
        Open project knowledge
      </Button>
    </Stack>
  );
}

function NewTask({
  opened,
  onClose,
  base,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  base: string;
  onCreated: (task: Task) => void;
}) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [verification, setVerification] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<Task>(`${base}/tasks`, "POST", {
        id: `work-${crypto.randomUUID().slice(0, 8)}`,
        title,
        objective,
        criteria: criteria
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean),
        verification,
        lane: "quick",
        priority: "medium",
        isolation: "auto",
        target: "any",
      });
      onCreated(data);
      onClose();
      setTitle("");
      setObjective("");
      setCriteria("");
      setVerification("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal opened={opened} onClose={onClose} title="Create a task" size="lg">
      <form onSubmit={create}>
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <TextInput
            label="Task title"
            placeholder="What should be done?"
            required
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            data-autofocus
          />
          <Textarea
            label="Goal"
            placeholder="Why is this work needed?"
            value={objective}
            onChange={(e) => setObjective(e.currentTarget.value)}
            minRows={2}
          />
          <Textarea
            label="Success criteria"
            description="One clear outcome per line."
            value={criteria}
            onChange={(e) => setCriteria(e.currentTarget.value)}
            minRows={3}
          />
          <Textarea
            label="How to verify"
            description="Describe how to check the result. This does not enable a shell command."
            value={verification}
            onChange={(e) => setVerification(e.currentTarget.value)}
            minRows={2}
          />
          <Text size="xs" c="dimmed">
            This small task uses one worker at a time in the primary project
            folder. The task starts as a draft. Criteria and verification are
            required before it can be ready.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create draft
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

type Role = {
  id: string;
  responsibility: string;
  harness: string;
  model: string;
  skills: string[];
  access: string[];
  expected_evidence: string[];
  allowed_fallback: { harness: string; model: string }[];
};
type TeamConfig = {
  version: number;
  preference: string;
  roles: Role[];
  pins: { task_id: string; harness: string; model: string }[];
};
function TeamSettings({
  base,
  projectID,
  refresh,
  human,
}: {
  base: string;
  projectID: string;
  refresh: number;
  human: boolean;
}) {
  const [config, setConfig] = useState<TeamConfig | null>(null);
  const [etag, setEtag] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const drafts = useRef(
    new Map<string, { config: TeamConfig; etag: string; dirty: boolean }>(),
  );
  useEffect(() => {
    if (!projectID) return;
    const cached = drafts.current.get(projectID);
    if (cached?.dirty) {
      setConfig(cached.config);
      setEtag(cached.etag);
      setDirty(true);
      return;
    }
    const controller = new AbortController();
    setError("");
    setConfig(null);
    apiResponse<TeamConfig>(`${base}/team`, "GET", undefined, controller.signal)
      .then(({ data, etag: revision }) => {
        setConfig(data);
        setEtag(revision);
        setDirty(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [base, projectID, refresh]);
  const edit = (next: TeamConfig) => {
    setConfig(next);
    setDirty(true);
    drafts.current.set(projectID, { config: next, etag, dirty: true });
  };
  const updateRole = (index: number, patch: Partial<Role>) =>
    config &&
    edit({
      ...config,
      roles: config.roles.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  async function save() {
    setBusy(true);
    setError("");
    try {
      const response = await apiResponse<TeamConfig>(
        `${base}/team`,
        "PUT",
        config,
        undefined,
        { "If-Match": etag },
      );
      setConfig(response.data);
      setEtag(response.etag);
      setDirty(false);
      drafts.current.set(projectID, {
        config: response.data,
        etag: response.etag,
        dirty: false,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!config)
    return (
      <Paper withBorder p="xl" radius="lg">
        <Text size="sm" c="dimmed">
          {error ||
            (projectID
              ? "Loading team settings…"
              : "Select a project to manage its team.")}
        </Text>
      </Paper>
    );
  return (
    <Stack>
      {error && (
        <Alert color="red" title="Settings were not saved">
          {error} Your edits are still here. Refresh to reload the saved
          version.
        </Alert>
      )}
      <Paper withBorder p="xl" radius="lg">
        <Group justify="space-between">
          <Title order={3}>Delegation preference</Title>
          <Badge variant="light" color={dirty ? "orange" : "teal"}>
            {dirty ? "Unsaved edits" : "Saved"}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" mt="sm" mb="md">
          Guide a future tool choice when capability, account access, and quota
          evidence are available.
        </Text>
        <SegmentedControl
          aria-label="Cost and quality preference"
          value={config.preference}
          onChange={(preference) => edit({ ...config, preference })}
          data={[
            { value: "cost", label: "Lower cost" },
            { value: "balanced", label: "Balanced" },
            { value: "quality", label: "Higher quality" },
          ]}
        />
      </Paper>
      <Paper withBorder p="xl" radius="lg">
        <Group justify="space-between" mb="md">
          <Title order={3}>Team roles</Title>
          <Button
            size="xs"
            variant="default"
            onClick={() =>
              edit({
                ...config,
                roles: [
                  ...config.roles,
                  {
                    id: `role-${config.roles.length + 1}`,
                    responsibility: "",
                    harness: "auto",
                    model: "auto",
                    skills: [],
                    access: ["read"],
                    expected_evidence: ["declared checks"],
                    allowed_fallback: [],
                  },
                ],
              })
            }
          >
            Add role
          </Button>
        </Group>
        <Text size="sm" c="dimmed" mb="lg">
          Roles describe responsibility and a preferred tool. Access labels
          describe intent; native tools still control permissions.
        </Text>
        {config.roles.length ? (
          <Accordion variant="separated">
            {config.roles.map((r, i) => (
              <Accordion.Item key={i} value={`${i}`}>
                <Accordion.Control>
                  <Group gap="sm">
                    <Text fw={600} size="sm">
                      {r.id || "New role"}
                    </Text>
                    <Badge size="xs" variant="light">
                      {r.harness} / {r.model}
                    </Badge>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <TextInput
                      label="Role name"
                      value={r.id}
                      onChange={(e) =>
                        updateRole(i, { id: e.currentTarget.value })
                      }
                    />
                    <Textarea
                      label="Responsibility"
                      value={r.responsibility}
                      onChange={(e) =>
                        updateRole(i, { responsibility: e.currentTarget.value })
                      }
                    />
                    <Group grow>
                      <Select
                        label="Preferred tool"
                        value={r.harness}
                        onChange={(value) =>
                          updateRole(i, { harness: value || "auto" })
                        }
                        data={[
                          "auto",
                          "codex",
                          "claude",
                          "cursor",
                          "gemini",
                          "opencode",
                          "muse",
                          "zcode",
                        ]}
                      />
                      <TextInput
                        label="Preferred model"
                        description="Use auto to leave the model open."
                        value={r.model}
                        onChange={(e) =>
                          updateRole(i, { model: e.currentTarget.value })
                        }
                      />
                    </Group>
                    <Textarea
                      label="Expected evidence"
                      description="One item per line."
                      value={(r.expected_evidence || []).join("\n")}
                      onChange={(e) =>
                        updateRole(i, {
                          expected_evidence: e.currentTarget.value.split("\n"),
                        })
                      }
                    />
                    <Textarea
                      label="Skill paths"
                      description="Relative project paths. One per line."
                      value={(r.skills || []).join("\n")}
                      onChange={(e) =>
                        updateRole(i, {
                          skills: e.currentTarget.value
                            .split("\n")
                            .filter(Boolean),
                        })
                      }
                    />
                    <TextInput
                      label="Access labels"
                      description="Descriptive only. Separate with commas."
                      value={(r.access || []).join(", ")}
                      onChange={(e) =>
                        updateRole(i, {
                          access: e.currentTarget.value
                            .split(",")
                            .map((value) => value.trim()),
                        })
                      }
                    />
                    {r.allowed_fallback?.length > 0 && (
                      <Text size="xs" c="dimmed">
                        Saved fallbacks:{" "}
                        {r.allowed_fallback
                          .map((f) => `${f.harness} / ${f.model}`)
                          .join(", ")}
                      </Text>
                    )}
                    <Button
                      color="red"
                      variant="subtle"
                      size="xs"
                      onClick={() =>
                        edit({
                          ...config,
                          roles: config.roles.filter((_, index) => index !== i),
                        })
                      }
                    >
                      Remove role from this draft
                    </Button>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        ) : (
          <Text size="sm" c="dimmed">
            No roles yet. Add a builder or reviewer when you want a saved
            delegation choice.
          </Text>
        )}
        {config.pins?.length > 0 && (
          <>
            <Divider my="lg" />
            <Text size="sm" fw={600}>
              Pinned task choices
            </Text>
            {config.pins.map((p) => (
              <Text key={p.task_id} size="sm" mt="xs">
                {p.task_id} · {p.harness} / {p.model}
              </Text>
            ))}
          </>
        )}
      </Paper>
      <Group justify="flex-end">
        <Text size="xs" c="dimmed">
          Stored with this project.
        </Text>
        <Button loading={busy} disabled={!human || !dirty} onClick={save}>
          Save team settings
        </Button>
      </Group>
    </Stack>
  );
}

function RunCard({
  run,
  base,
  reload,
}: {
  run: Run;
  base: string;
  reload: () => void;
}) {
  const [loaded, setLoaded] = useState<Run | null>(null);
  const [events, setEvents] = useState<
    {
      method: string;
      payload: {
        item?: { id?: string; changes?: { path: string; diff?: string }[] };
      };
    }[]
  >([]);
  const [session, setSession] = useState({
    human: false,
    native_permissions: false,
    native_project_id: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ run: Run; events: typeof events }>(
      `${base}/runs/${encodeURIComponent(run.id)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => {
        setLoaded(data.run);
        setEvents(data.events || []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    api<typeof session>("/api/session", "GET", undefined, controller.signal)
      .then(setSession)
      .catch(() => {});
    return () => controller.abort();
  }, [base, run.id, run.updated_at, run.status]);
  const canAnswer =
    session.human &&
    session.native_permissions &&
    base === `/api/projects/${encodeURIComponent(session.native_project_id)}`;
  const request = (loaded || run).pending_request;
  const params = request?.params || {};
  const command = typeof params.command === "string" ? params.command : "";
  const cwd = typeof params.cwd === "string" ? params.cwd : "";
  const reason = typeof params.reason === "string" ? params.reason : "";
  const item = events
    .map((e) => e.payload?.item)
    .find((item) => item?.id === params.itemId);
  const context = request?.context || item;
  const fileChanges =
    typeof context === "object" && context !== null && "changes" in context
      ? (context as { changes: { path: string; diff?: string }[] }).changes
      : [];
  const hasContext = Boolean(
    command ||
      (Array.isArray(fileChanges) &&
        fileChanges.some(
          (change) => change && typeof change.path === "string" && change.path,
        )),
  );
  async function decide(decision: "accept" | "decline" | "cancel") {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `${base}/runs/${encodeURIComponent(run.id)}/permission`,
        "POST",
        { request_id: request.request_id, decision },
      );
      setLoaded(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Paper withBorder p="md">
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          {run.harness} {run.model}
        </Text>
        <Badge
          color={
            run.error
              ? "red"
              : run.status === "attention_required"
                ? "orange"
                : "gray"
          }
          variant="light"
        >
          {label(run.status)}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" mt="xs">
        {run.id} · {time(run.updated_at)}
      </Text>
      {run.result && (
        <Text size="sm" mt="sm" style={{ whiteSpace: "pre-wrap" }}>
          {run.result}
        </Text>
      )}
      {run.error && (
        <Alert color="red" mt="sm">
          {run.error}
        </Alert>
      )}
      {error && (
        <Alert color="red" mt="sm">
          {error}
        </Alert>
      )}
      {request && (
        <Alert color="orange" title="Native tool needs your permission" mt="md">
          <Stack gap="sm">
            <Text size="sm">
              {label(request.method.split("/")[1] || request.method)}
            </Text>
            {reason && <Text size="sm">{reason}</Text>}
            {command && (
              <Text
                size="sm"
                ff="monospace"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {command}
              </Text>
            )}
            {cwd && <Text size="xs">Working folder: {cwd}</Text>}
            {context !== undefined && (
              <Accordion variant="contained">
                <Accordion.Item value="change">
                  <Accordion.Control>Requested change</Accordion.Control>
                  <Accordion.Panel>
                    <Text
                      size="xs"
                      ff="monospace"
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {typeof context === "string"
                        ? context
                        : JSON.stringify(context, null, 2)}
                    </Text>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}
            {!hasContext && (
              <Text size="sm">
                The tool has not supplied enough detail to approve this request.
              </Text>
            )}
            {!canAnswer && (
              <Text size="sm">
                Open the connected local service with agentklar serve --open to
                answer native permission requests.
              </Text>
            )}
            <Group>
              <Button
                size="xs"
                color="teal"
                disabled={!canAnswer || !hasContext}
                loading={busy}
                onClick={() => decide("accept")}
              >
                Allow this request
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={!canAnswer}
                loading={busy}
                onClick={() => decide("decline")}
              >
                Decline
              </Button>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                disabled={!canAnswer}
                loading={busy}
                onClick={() => decide("cancel")}
              >
                Cancel run
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {run.status === "attention_required" && !request && (
        <Text c="dimmed" size="sm" mt="sm">
          This run needs attention. Its native interaction is not supported here
          yet.
        </Text>
      )}
    </Paper>
  );
}
