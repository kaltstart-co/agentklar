import { isDeepStrictEqual } from "node:util";
// Native OpenCode 2 protocol, verified against the official v2.0.12 schema.
// This facade preserves the worker's permission, completion and cleanup guards.
const record = (value: unknown): Record<string, any> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const component = (value: string) => encodeURIComponent(value);

export function openCode2Providers(providers: unknown, models: unknown) {
  if (!Array.isArray(providers) || !Array.isArray(models)) throw new Error("Invalid OpenCode 2 catalog");
  const active = providers.filter(p => record(p) && typeof p.id === "string" && ["auto", "enabled"].includes(p.activation));
  return { connected: active.map(p => p.id), all: active.map(p => ({ id: p.id, models: Object.fromEntries(models.filter(m =>
    record(m) && m.providerID === p.id && typeof m.id === "string").map(m => [m.id, {
      id: m.id, name: m.name, capabilities: { toolcall: m.capabilities?.tools === true,
        input: { text: m.capabilities?.input?.includes("text") === true, image: m.capabilities?.input?.includes("image") === true } },
    }])) })) };
}

export function openCode2Permission(value: unknown) {
  const request = record(value), source = record(request?.source);
  if (!request || source?.type !== "tool") return value;
  return { id: request.id, sessionID: request.sessionID, permission: request.action, patterns: request.resources,
    metadata: request.metadata, tool: { messageID: source.messageID, callID: source.id } };
}

export function openCode2Event(value: unknown) {
  const event = record(value), properties = record(event?.data);
  if (!event || typeof event.type !== "string" || !properties) throw new Error("Invalid OpenCode 2 event");
  if (event.type === "permission.asked") return { type: event.type, properties: openCode2Permission(properties) };
  if (event.type === "session.created") return { type: event.type, properties: { ...properties, info: { id: properties.sessionID, parentID: properties.parentID } } };
  if (event.type === "session.status" && properties.status?.type === "idle") return { type: "session.idle", properties };
  if (event.type === "form.created") return { type: "question.asked", properties };
  return { type: event.type, properties };
}

export function openCode2Message(value: unknown, sessionID: string) {
  const message = record(value);
  if (!message || message.type !== "assistant") return { info: { sessionID, role: message?.type } };
  const usage = record(message.tokens), cache = record(usage?.cache);
  const counts = [usage?.input, usage?.output, usage?.reasoning, cache?.read, cache?.write];
  const total = counts.every(n => Number.isSafeInteger(n) && n >= 0) ? counts.reduce((sum, n) => sum + n, 0) : undefined;
  return { info: { id: message.id, sessionID, role: "assistant", finish: message.finish, error: message.error,
    time: message.time, providerID: message.model?.providerID, modelID: message.model?.id,
    tokens: { total: Number.isSafeInteger(total) ? total : undefined } }, parts: Array.isArray(message.content) ? message.content : [] };
}

export function createOpenCode2Client(baseUrl: string, directory: string, authorization: string, nativeFetch: typeof fetch = fetch) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password)
    throw new Error("OpenCode 2 requires its private local server");
  let sessionID: string | undefined;
  let executionStarted = false;
  const permissions = new Map<string, Record<string, any>>();
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    const url = new URL(path, origin); url.searchParams.set("directory", directory);
    const response = await nativeFetch(url, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("OpenCode 2 native request failed"); }
    if (response.status === 204) return true;
    const reader = response.body?.getReader(); if (!reader) throw new Error("OpenCode 2 response missing");
    let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
        if (bytes > 2 * 1024 * 1024) throw new Error("OpenCode 2 response exceeded its limit"); chunks.push(part.value); }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } finally { await reader.cancel().catch(() => {}); }
  }
  const unwrap = (reply: unknown) => { const value = record(reply); if (!value || !("data" in value)) throw new Error("OpenCode 2 response shape changed");
    if (value.location && value.location.directory !== directory) throw new Error("OpenCode 2 response changed location"); return value.data; };
  const path = (id: string) => `/api/session/${component(id)}`;
  async function timeline(url: string) {
    const first = await request(url);
    const items = unwrap(first);
    if (!Array.isArray(items)) throw new Error("OpenCode 2 history missing");
    // Native cursors mark page boundaries even when there is no further item.
    if (items.length >= 100) throw new Error("OpenCode 2 task history exceeded its limit");
    if (first.cursor?.next) {
      const nextUrl = new URL(url, origin);
      nextUrl.searchParams.delete("order");
      nextUrl.searchParams.set("cursor", first.cursor.next);
      const following = unwrap(await request(nextUrl.pathname + nextUrl.search));
      if (!Array.isArray(following) || following.length) throw new Error("OpenCode 2 task history is incomplete");
    }
    return items;
  }

  return {
    protocol: 2,
    global: { health: async () => { const info = record(await request("/api/info"));
      if (!info || !/^2\./.test(info.version) || !Number.isSafeInteger(info.pid) || info.pid < 0) throw new Error("OpenCode 2 identity missing");
      return { data: { healthy: true, version: info.version } }; } },
    provider: { list: async () => {
      // Native plugins settle after server startup; an initial snapshot can be empty.
      let catalog;
      for (let attempt = 0; attempt < 6; attempt++) {
        const [providers, models] = await Promise.all([request("/api/provider"), request("/api/model")]);
        catalog = openCode2Providers(unwrap(providers), unwrap(models));
        if (catalog.all.some(provider => Object.keys(provider.models).length) || attempt === 5) break;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      return { data: catalog };
    } },
    event: { subscribe: async (_query: unknown, options: { signal: AbortSignal }) => {
      const response = await nativeFetch(new URL("/api/event", origin), { headers: { Authorization: authorization }, signal: options.signal, redirect: "error" });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("OpenCode 2 event stream failed");
      const reader = response.body.getReader();
      return { stream: (async function* () {
        const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "";
        try { while (true) { const part = await reader.read(); if (part.done) throw new Error("OpenCode 2 event stream ended");
          buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, "\n");
          if (buffer.length > 2 * 1024 * 1024) throw new Error("OpenCode 2 event exceeded its limit");
          while (buffer.includes("\n\n")) { const end = buffer.indexOf("\n\n"); const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const payload = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!payload) continue; const parsed = JSON.parse(payload); const normalized = openCode2Event(parsed);
            if (normalized.type === "permission.asked") {
              const request = record(normalized.properties);
              if (request?.id && request.sessionID) {
                const reviewed = permissions.get(request.id);
                if (reviewed) {
                  if (!isDeepStrictEqual(reviewed, request)) throw new Error("OpenCode 2 outstanding permission changed");
                  continue;
                }
                permissions.set(request.id, request);
              }
            }
            const owned = record(normalized.properties)?.sessionID === sessionID;
            if (owned && normalized.type === "session.execution.started") executionStarted = true;
            if (owned && normalized.type === "session.idle") continue;
            if (owned && normalized.type === "session.execution.succeeded") {
              if (!executionStarted) throw new Error("OpenCode 2 completion has no owned execution start");
              yield { type: "session.idle", properties: normalized.properties }; continue;
            }
            if (owned && ["session.execution.failed", "session.execution.interrupted"].includes(normalized.type)) {
              yield { type: "session.error", properties: normalized.properties }; continue;
            }
            yield normalized;
          }
        } } finally { await reader.cancel().catch(() => {}); } })() };
    } },
    session: {
      create: async ({ title }: { title: string }) => { const session = unwrap(await request("/api/session", { title, location: { directory } }));
        if (!record(session) || session.location?.directory !== directory || typeof session.id !== "string") throw new Error("OpenCode 2 session location missing");
        sessionID = session.id; return { data: { ...session, directory } }; },
      prompt: async ({ sessionID: id, model, parts }: any) => {
        if (id !== sessionID) throw new Error("OpenCode 2 session changed");
        if (model) await request(path(id) + "/model", { model: { providerID: model.providerID, id: model.modelID } });
        const input = unwrap(await request(path(id) + "/prompt", { text: parts.map((part: any) => part.text).join("\n") }));
        if (!record(input)) throw new Error("OpenCode 2 did not admit the prompt"); return { data: { info: {} } };
      },
      messages: async ({ sessionID: id, limit }: { sessionID: string; limit: number }) => {
        const session = unwrap(await request(path(id)));
        if (session?.outcome !== "succeeded" || !session.time?.idle) throw new Error("OpenCode 2 did not confirm successful completion");
        const messages = await timeline(path(id) + `/message?limit=${limit}&order=asc`);
        return { data: messages.map(message => openCode2Message(message, id)) };
      },
      children: async ({ sessionID: id }: { sessionID: string }) => ({ data: await timeline(`/api/session?parentID=${component(id)}&limit=100&order=asc`) }),
      abort: async ({ sessionID: id }: { sessionID: string }) => ({ data: unwrap(await request(path(id) + "/interrupt", { resume: false })) }),
    },
    permission: { reply: async ({ requestID, reply }: { requestID: string; reply: string }) => {
      const reviewed = permissions.get(requestID); const owner = reviewed?.sessionID; if (!reviewed || !owner || owner !== sessionID || !["once", "reject"].includes(reply)) throw new Error("OpenCode 2 permission is not owned by this root task");
      const latest = openCode2Permission(unwrap(await request(path(owner) + `/permission/${component(requestID)}`)));
      if (!isDeepStrictEqual(latest, reviewed)) throw new Error("OpenCode 2 permission changed after review");
      const confirmation = await request(path(owner) + `/permission/${component(requestID)}/reply`, { decision: reply });
      if (confirmation !== true) throw new Error("OpenCode 2 permission was not confirmed"); permissions.delete(requestID); return { data: true };
    } },
  };
}
