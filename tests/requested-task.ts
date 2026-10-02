/** Existing launch fixtures simulate a human asking for each fake worker. */
export function requestedTaskBody(path: string, body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const task = body as Record<string, unknown>;
  if (path === "/api/tasks/start") return { ...task, delegation: "requested" };
  if (path === "/api/peers/dispatch" && task.task && typeof task.task === "object")
    return { ...task, task: { ...task.task, delegation: "requested" } };
  return body;
}
