import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeSessions } from "../web/NativeSessions.tsx";
import type { ObservedSessionView } from "../src/observations.ts";
const session: ObservedSessionView = { id: "hashed-session", projectId: "project", harness: "claude", state: "idle", event: "Stop",
  createdAt: "2026-10-03T10:00:00Z", observedAt: "2026-10-03T10:01:00Z", recent: true, trackingEnabled: true };
const render = (rows: ObservedSessionView[], connected = true) => renderToStaticMarkup(createElement(NativeSessions,
  { projectId: "project", sessions: rows, connected, busy: false, onDisable: () => assert.fail("render must not mutate") }));
test("browser native signals keep project scope and never label Stop as completion", () => {
  const html = render([session, { ...session, id: "other", projectId: "other", event: "StopFailure" }]);
  assert.match(html, /Idle/); assert.match(html, /Recent signal/); assert.match(html, /do not confirm task completion/);
  assert.match(html, /Stop showing sessions/); assert.doesNotMatch(html, /StopFailure|hashed-session|Completed|tokens|approval/);
  assert.equal(render([{ ...session, projectId: "other" }]), "");
});
test("browser native signals label stale, disconnected and disabled observations", () => {
  assert.match(render([{ ...session, recent: false, state: "working" }]), /Working.*Last seen/);
  assert.match(render([session], false), /Last seen/);
  const disabled = render([{ ...session, trackingEnabled: false, state: "needs_attention", event: "StopFailure" }]);
  assert.match(disabled, /Needs attention.*Tracking off/); assert.doesNotMatch(disabled, /Stop showing sessions/);
});
