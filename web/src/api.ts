export type Project = {
  ID: string;
  Name: string;
  RepoPath: string;
  WorkspacePath: string;
};
export type Task = {
  ID: string;
  Title: string;
  State: string;
  Objective: string;
  Verification: string;
  Criteria: string[] | null;
  Priority: string;
  Assignee: string;
  Labels: string[] | null;
  UpdatedAt: string;
};
export type Evidence = {
  ID: number;
  Provenance: string;
  Criterion: string;
  Command: string;
  ExitCode: number | null;
  LogPath: string;
  Hash: string;
  Note: string;
  CreatedAt: string;
};
export type Detail = {
  task: Task;
  evidence: Evidence[];
  comments: { ID: number; Actor: string; Body: string; CreatedAt: string }[];
  dependencies: string[];
};
export type Memory = {
  ID: number;
  Key: string;
  Value: string;
  Holder: string;
  SourceTask: string;
  CreatedAt: string;
};
export type Context = {
  packet: {
    Items:
      | { Source: string; Ref: string; Title: string; Body: string }[]
      | null;
  };
  indexed_at: string;
};
export type AlertRow = {
  ID: number;
  Title: string;
  Message: string;
  Body?: string;
  TaskID: string;
  Acknowledged: boolean;
  project_id?: string;
  project_name?: string;
};
export type Run = {
  id: string;
  task_id: string;
  holder: string;
  status: string;
  harness: string;
  model: string;
  result: string;
  error: string;
  updated_at: string;
  pending_request?: {
    request_id: number | string;
    method: string;
    params: Record<string, unknown>;
    context?: unknown;
  };
};
export const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(
  location.hostname,
);

export async function apiResponse<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<{ data: T; etag: string }> {
  if (!isLocal)
    throw new Error("Device pairing is required before hosted access.");
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const value = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok || value?.error) {
    const reason =
      typeof value === "string"
        ? value
        : typeof value.error === "object"
          ? value.error.message
          : value.error || value.message;
    throw new Error(reason || `Request failed (${response.status})`);
  }
  return { data: value, etag: response.headers.get("ETag") || "" };
}
export const label = (state: string) =>
  ({
    in_progress: "In progress",
    completion_review: "Review",
    auto_qa: "Checking",
    user_approval: "Needs approval",
    changes_requested: "Changes requested",
  })[state] || state.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const attentionStates = [
  "user_approval",
  "blocked",
  "waiting",
  "changes_requested",
];
export const stateColor = (state: string) =>
  state === "done"
    ? "teal"
    : attentionStates.includes(state)
      ? "orange"
      : state === "in_progress"
        ? "indigo"
        : "gray";

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<T> {
  return (await apiResponse<T>(path, method, body, signal, headers)).data;
}
