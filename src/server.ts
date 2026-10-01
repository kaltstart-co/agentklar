import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createService } from "./service.ts";
import { operatorKey } from "./launchd.ts";
const port = Number(process.env.AGENTKLAR_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid AGENTKLAR_PORT");
const home = process.env.AGENTKLAR_HOME || join(homedir(), ".agentklar", "local-v1");
const operator = process.env.AGENTKLAR_SERVICE_ID
  ? { id: process.env.AGENTKLAR_SERVICE_ID, key: operatorKey(home) }
  : undefined;
const service = createService(
  home,
  port,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  operator,
);
service.app.get("*", serveStatic({ root: fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/web/" : "../web/", import.meta.url)) }));
service.app.get("*", (c) =>
  c.text(
    "The AgentKlar UI is missing. Reinstall the package or run npm run build in the source checkout.",
  ),
);
const server = serve(
  { fetch: service.app.fetch, hostname: "127.0.0.1", port },
  () => console.log(operator
    ? "AgentKlar local service started. Use `agentklar service open` to open it."
    : `AgentKlar local service. Open this one-time setup link:\n${service.setupUrl}`),
);
server.on("error", (error) => {
  console.error(`Local service could not listen on port ${port}: ${(error as NodeJS.ErrnoException).code || "unknown error"}`);
  void service.close().finally(() => { process.exitCode = 1; });
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      void service.close().then(() => process.exit(0));
    }),
  );
