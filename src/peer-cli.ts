import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One bounded request. Ending SSH only ends this bridge, never the owner service. */
export async function startPeerStdio() {
  const port = Number(process.env.AGENTKLAR_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid AgentKlar port.");
  const home = process.env.AGENTKLAR_HOME || join(homedir(), ".agentklar", "local-v1");
  let token: string;
  try { token = readFileSync(join(home, "mcp-token"), "utf8").trim(); } catch { throw new Error("Owner AgentKlar service is not set up. Start it on this device."); }
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 64_000) throw new Error("Peer request exceeded the allowed size.");
    if (input.includes("\n")) break;
  }
  let request: { requestId?: string; operation?: string; channel?: string };
  try { request = JSON.parse(input.trim()); } catch { throw new Error("Peer request is not valid JSON."); }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Peer request must be an object.");
  const response = await fetch(`http://127.0.0.1:${port}${request.channel === "human" ? "/api/peer-human" : request.channel === "setup" ? "/api/peer-setup" : "/api/peer"}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(33_000) }).catch(() => { throw new Error("Owner AgentKlar service is unavailable. Start it on this device and check its configured port."); });
  const body = await response.text();
  if (Buffer.byteLength(body) > (request.operation === "changes" ? 760_000 : 120_000)) throw new Error("Peer reply exceeded the allowed size.");
  let result: unknown;
  try { result = JSON.parse(body); } catch { throw new Error("Local service sent an invalid peer reply."); }
  process.stdout.write(JSON.stringify({ id: request.requestId, status: response.status, body: result }) + "\n");
}
