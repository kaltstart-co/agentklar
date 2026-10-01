import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { homedir } from "node:os";
import { join } from "node:path";
import { createService } from "./service.ts";
const port = Number(process.env.AGENTKLAR_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid AGENTKLAR_PORT");
const service = createService(
  process.env.AGENTKLAR_HOME || join(homedir(), ".agentklar", "local-v1"),
  port,
);
service.app.get("*", serveStatic({ root: "dist/web" }));
service.app.get("*", (c) =>
  c.text(
    "Build the UI with npm run build, or open http://127.0.0.1:5173 after npm run dev.",
  ),
);
const server = serve(
  { fetch: service.app.fetch, hostname: "127.0.0.1", port },
  () =>
    console.log(
      `AgentKlar local service. Open this one-time setup link:\n${service.setupUrl}`,
    ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      void service.close().then(() => process.exit(0));
    }),
  );
