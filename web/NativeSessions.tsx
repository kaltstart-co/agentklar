import type { ObservedSessionView } from "../src/observations.js";
import { HarnessIcon } from "./HarnessIcon.js";

const states: Record<ObservedSessionView["state"], string> = {
  idle: "Idle", working: "Working", needs_attention: "Needs attention", ended: "Ended",
};
export function NativeSessions({ projectId, sessions, connected, busy, onDisable }: {
  projectId: string; sessions: ObservedSessionView[]; connected: boolean; busy: boolean; onDisable: () => void;
}) {
  const rows = sessions.filter(session => session.projectId === projectId);
  if (!rows.length) return null;
  return <section aria-label="Native sessions">
    <h2>Native sessions</h2>
    <p className="hint">Session signals from your native harness. These do not confirm task completion or passing checks.</p>
    {rows.some(session => session.trackingEnabled) && <button type="button" disabled={!connected || busy} onClick={onDisable}>Stop showing sessions</button>}
    <ul style={{ listStyle: "none", padding: 0 }}>
      {rows.map(session => <li key={session.id} style={{ padding: "8px 0" }}>
        <details>
          <summary><HarnessIcon harness={session.harness} /> Claude Code session · {states[session.state]}
            {!session.trackingEnabled ? " · Tracking off" : !session.recent || !connected ? " · Last seen" : " · Recent signal"}</summary>
          <p className="hint">Last signal: {session.event} · {new Date(session.observedAt).toLocaleString()}</p>
          <p className="hint">Started: {new Date(session.createdAt).toLocaleString()}. Prompts, conversations and tool inputs stay in your harness.</p>
        </details>
      </li>)}
    </ul>
  </section>;
}
