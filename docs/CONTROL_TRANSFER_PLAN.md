# Main-harness handoff

Implementation plan. This feature is not shipped yet.

## User flow

A person switches from Claude Code to Codex, or opens another harness. The new harness reads the project's saved work and takes over coordination. Existing workers continue on their own computers and in their existing workspaces.

The handoff contains the saved brief, memory and next steps; open run and dispatch IDs; their observed status and time; review or fix links; and the current lead. Include bounded summaries and pointers. Fetch detailed results only when needed. Native sessions stay with their own harness and computer.

The main harness can prepare and accept this handoff through MCP. The optional dashboard shows the same record. A person can use the dashboard to recover a lost lead. Changing harness does not require another chat interface.

## Control scope

Keep today's advisory lead as the default. Add coordinated control as an explicit project option, with a preview of the operations it covers. Once enabled, the active lead controls AgentKlar task starts, worker stops and shared-context changes. Trusted human dashboard actions remain available. Reads remain available to every connected harness.

The service checks the current lead and its revision before a managed change. Passing an earlier check must not permit a delayed launch after ownership changes. Recheck before local launch or durable remote dispatch. Already accepted remote work continues; a lost acknowledgment keeps its original dispatch and owner.

This coordinates AgentKlar requests. It cannot stop a native harness from editing files directly, and it does not change OS or native harness permissions. Independent workers still need separate workspaces when their edits could overlap.

## Durable handoff

1. Prepare a saved, bounded packet with the project context revision, observed lead claim, work references and creation time. Preparation starts no worker and changes no native files.
2. The receiving MCP client reads the packet and explicitly accepts it. Check the expected context and control revisions again. A stale packet needs a fresh review.
3. Save the accepted handoff and new control revision together. Repeating the same acceptance returns its receipt; another client or changed input conflicts. A lost reply must not transfer control again.
4. Fence older lead requests from new managed changes. Their existing workers keep running. Never copy credentials or treat a native session ID as transferred execution.
5. Record expired or disconnected leads honestly. After service restart, preserve handoff history and require a fresh lead claim; do not resume native workers automatically.

MCP client names are reported labels. Bridge identity supports coordination within the local service's existing trust boundary; it is not a new security boundary. Human recovery uses the trusted local UI and a fresh observed revision. Native approvals remain separate.

## Verification gate

- Two real MCP clients: prepare in one, inspect and accept in the other.
- Context, open work and owner/workspace references survive the switch.
- A delayed old-client start, stop or context write cannot pass after transfer.
- Lost acceptance reply retries once; changed input and stale revisions fail.
- A disconnected source, expired claim and service restart need no silent takeover.
- Existing local and remote workers continue; permission requests stay pending.
- Default advisory behavior and ordinary native harness use remain unchanged.
- Dashboard recovery uses the same revisions and receipts; compact layout fits.

Passing these checks establishes AgentKlar coordination. It does not establish control over manual native sessions or direct file edits.
