import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { startSchema, contextUpdateSchema } from "./service.ts";
import { recommendationSchema } from "./recommend.ts";
export function bounded(result: unknown) {
  const text = JSON.stringify(result);
  return text.length <= 24000
    ? text
    : JSON.stringify({
        truncated: true,
        preview: text.slice(0, 20000),
        message:
          "Response shortened to fit the MCP context budget. Inspect the local UI for more.",
      });
}
export function createMcp(base: string, token: string) {
  const server = new McpServer({ name: "agentklar", version: "0.1.0" });
  async function call(path: string, method = "GET", body?: unknown) {
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      return {
        content: [{ type: "text" as const, text: bounded(result) }],
        isError: !response.ok,
      };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: "AgentKlar local service is unavailable. Start npm start in the AgentKlar folder.",
          },
        ],
        isError: true,
      };
    }
  }
  server.registerTool(
    "projects_list",
    {
      description: "List explicitly registered local projects.",
      inputSchema: z.object({}).strict(),
    },
    () => call("/api/projects"),
  );
  server.registerTool(
    "harnesses_list",
    {
      description:
        "Discover installed native host CLIs and actual worker adapter support.",
      inputSchema: z.object({}).strict(),
    },
    () => call("/api/harnesses"),
  );
  server.registerTool(
    "models_list",
    {
      description:
        "Read project-scoped native model catalogs and Codex account quota. Refresh defaults to true, with a 30-second local cache. Catalog discovery does not verify sign-in or model entitlement; quota remains unknown where unavailable. This starts no worker or inference.",
      inputSchema: z
        .object({ projectId: z.uuid(), refresh: z.boolean().default(true) })
        .strict(),
    },
    ({ projectId, refresh }) =>
      call(`/api/projects/${projectId}/catalog`, refresh ? "POST" : "GET"),
  );
  server.registerTool(
    "recommend_worker",
    {
      description:
        "Get deterministic local worker advice from saved cost preference, explicit role/model pins, offered native models and quota. The main native agent classifies complexity and image needs. No model call or worker starts. When the user has not pinned a model, inspect the limited advice and explicitly choose a model before task_start. Preserve user pins; a blocked pin returns no replacement. Unknown access, billing and capabilities remain unknown.",
      inputSchema: recommendationSchema
        .extend({ projectId: z.uuid() })
        .strict(),
    },
    ({ projectId, ...body }) =>
      call(`/api/projects/${projectId}/recommend`, "POST", body),
  );
  server.registerTool(
    "project_register",
    {
      description: "Register an existing local project folder.",
      inputSchema: z.object({ name: z.string(), path: z.string() }).strict(),
    },
    (args) => call("/api/projects", "POST", args),
  );
  server.registerTool(
    "project_update",
    {
      description:
        "Save project team roles and cost preference. Preference guides recommend_worker advice; task_start still uses only explicit task or role model choices.",
      inputSchema: z
        .object({
          projectId: z.uuid(),
          preference: z.enum(["economical", "balanced", "best"]).optional(),
          roles: z
            .array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                  harness: z.string(),
                  model: z.string().optional(),
                  responsibility: z.string(),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    },
    ({ projectId, ...body }) =>
      call(`/api/projects/${projectId}`, "PATCH", body),
  );
  server.registerTool(
    "project_context_read",
    {
      description:
        "Read the latest manually saved brief, memory and handoff for a registered project. Revision 0 means no context has been saved.",
      inputSchema: z.object({ projectId: z.uuid() }).strict(),
    },
    ({ projectId }) => call(`/api/projects/${projectId}/context`),
  );
  server.registerTool(
    "project_context_update",
    {
      description:
        "Save all three project context fields using the revision you read. A stale revision returns a conflict: reread and review the latest context before retrying; do not overwrite another writer's edits blindly. This does not modify native config or approve actions.",
      inputSchema: contextUpdateSchema.extend({ projectId: z.uuid() }).strict(),
    },
    ({ projectId, ...body }) =>
      call(`/api/projects/${projectId}/context`, "PUT", body),
  );
  server.registerTool(
    "task_start",
    {
      description:
        "Start one durable native Codex or Claude Code worker for a registered project. Includes a saved project context snapshot by default; includeProjectContext:false opts out. Returns promptly. Completion means worker finished; review is separate. Keep the returned run ID. When no user model is pinned, classify complexity and image needs, call recommend_worker, inspect its reasons and limits, then explicitly choose a model for this call.",
      inputSchema: startSchema,
    },
    (args) => call("/api/tasks/start", "POST", args),
  );
  for (const [name, suffix, description] of [
    ["run_status", "", "Read worker state and native IDs."],
    [
      "run_context_read",
      "/context",
      "Inspect the immutable saved project context captured when this run started, or null if absent or disabled.",
    ],
    [
      "run_result",
      "/result",
      "Read compact result and actual token count when reported.",
    ],
    ["run_stop", "/stop", "Interrupt and terminate this owned worker."],
  ] as const)
    server.registerTool(
      name,
      { description, inputSchema: z.object({ runId: z.uuid() }).strict() },
      ({ runId }) =>
        call(
          `/api/runs/${runId}${suffix}`,
          name === "run_stop" ? "POST" : "GET",
        ),
    );
  server.registerTool(
    "run_tail",
    {
      description: "Read up to 200 compact events after an event ID.",
      inputSchema: z
        .object({
          runId: z.uuid(),
          after: z.number().int().nonnegative().default(0),
        })
        .strict(),
    },
    ({ runId, after }) => call(`/api/runs/${runId}/tail?after=${after}`),
  );
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const home =
    process.env.AGENTKLAR_HOME || join(homedir(), ".agentklar", "local-v1");
  let token: string;
  try {
    token = readFileSync(join(home, "mcp-token"), "utf8").trim();
  } catch {
    console.error(
      "Start the AgentKlar local service once before connecting MCP.",
    );
    process.exit(1);
  }
  const port = Number(process.env.AGENTKLAR_PORT || 4317);
  await createMcp(`http://127.0.0.1:${port}`, token!).connect(
    new StdioServerTransport(),
  );
}
