#!/usr/bin/env node
import { readFileSync } from "node:fs";

const usage = "Usage: agentklar start | mcp | peer --stdio | update [--check | --recover <folder>] | service install|status|open|stop|start|uninstall [--print|--force]\n       agentklar --help | --version";
const [action, ...args] = process.argv.slice(2);

if (!action || action === "--help" || action === "-h") {
  console.log(usage);
} else if (action === "--version" || action === "-v") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
} else if (Number(process.versions.node.split(".")[0]) !== 24) {
  console.error("AgentKlar requires Node 24.");
  process.exitCode = 1;
} else {
  try {
    if (action === "start" && args.length === 0) await import("../dist/server/server.js");
    else if (action === "mcp" && args.length === 0) await (await import("../dist/server/mcp.js")).startMcp();
    else if (action === "peer" && args.length === 1 && args[0] === "--stdio") await (await import("../dist/server/peer-cli.js")).startPeerStdio();
    else if (action === "update") await (await import("../dist/server/update.js")).main(args);
    else if (action === "service") await (await import("../dist/server/launchd.js")).main(args);
    else throw new Error(usage);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "AgentKlar could not start.");
    process.exitCode = 1;
  }
}
