# Native parity acceptance, beta 39

This is a test checklist, not a claim that all checks passed. Use an isolated service home and temporary Git project. Do not use a live account, modify the user's coding app configuration, or start inference for these checks.

## Evidence recorded in this change

- Native SwiftUI build passes with MacOSX26.5 SDK after the remote routing and report detail changes. A final rebuild must include all changes from the parallel work.
- Source comparison: web/App.tsx remote task model choice matches NativeRemoteViews.swift launch evidence fields: requested app/model, owner device, model-list check time, preset, reasons, warnings, and benchmark evidence.
- Owner reported model, token usage and tools appear separately from requested launch choices. Missing reports say they are not reported.
- NativeReportedWorkView.swift shows harness-reported progress/result, report revision, report IDs, and first/last report times. A report never proves a session is running or grants permission.

## Required native GUI checks

Record each result as Pass, Fail, or Not tested, with the app build and fixture used. A build alone does not pass these checks.

| Area | Fixture and action | Expected result | Status |
| --- | --- | --- | --- |
| Remote launch evidence | Open a saved remote dispatch with routing reasons and warnings. Expand Model choice at launch. | Requested model, owner reported model, list age, preset and warnings are readable. Missing effective model says Not reported. | Not tested |
| Remote observed evidence | Open a dispatch with tools, usage and model, then one without them. | Only owner-reported evidence appears. Missing fields say Not reported; zero reported tokens stays zero. | Not tested |
| Remote completion | Open completed dispatch, then unknown connection dispatch. | Completed means ready for human review. Lost connection does not claim worker stopped. | Not tested |
| Reported harness work | Select working, blocked and finished activity fixtures. Expand Report details. | Correct title/progress/result/revision/report identity. The harness reporting notice remains visible. | Not tested |
| Project isolation | Open two local projects and one remote project. Switch tabs during delayed refresh. | Each detail belongs to its selected project; an old response cannot overwrite another project's detail. | Not tested |
| Remote approval | Use a fake owner with concrete command/file approval and changed digest. | Review exact action, allow once only; changed request requires review again; retry preserves saved choice. | Not tested |
| Context | Edit brief, memory and next steps in temporary project; provoke a revision conflict. | Draft survives conflict and explicit reload is offered. Save stays scoped to current project. | Not tested |
| Layout | Resize native window through its supported sizes and use keyboard navigation. | No clipped critical actions; labels remain readable; detail scrolls and text can be copied. | Not tested |

## Remote owner read acceptance

The new setup grant option, View tasks and project context, explicitly permits read-only workspace viewing. It defaults to false. Existing grants never gain this permission. It does not permit starting workers, editing context, answering approvals or reading native account data.

| Check | Expected result | Evidence |
| --- | --- | --- |
| Grant without workspaceRead | projectWorkspace denied | Focused automated test passes |
| Existing stored grant without field | projectWorkspace denied | Focused automated test passes |
| Explicit workspaceRead grant | Authorized project workspace returned | Focused automated test passes |
| Different source or owner | Denied before reader callback | Focused automated test passes |
| Project outside shared root | Denied before reader callback | Focused automated test passes |
| Revoked grant | Denied before reader callback | Focused automated test passes |
| Worker start through setup channel | Rejected operation | Focused automated test passes |
| Share folder native toggle | New code has only the permission explicitly chosen | Native GUI check required |
| Remote Work and Context tabs | Authorized saved data shown with read-only labels | Native GUI check required |
| Setup grant without read permission | Clear permission error; no stale owner data shown | Native GUI check required |
| Lost owner connection | Clear error; cached data cleared on failure | Native GUI check required |
| Revocation after successful read | Refresh denies and removes previous workspace data | Native GUI check required |

## Remaining scope

The setup channel remains separate from worker execution and human approval sharing. Native remote-only workspace views provide read-only Work and Context through the explicit read grant. Team, Models, Usage and other remote-only configuration workflows still require their own authorized owner routes and GUI acceptance. Do not claim full parity from a successful build or this limited read path.

Final service integration must return bounded task/report previews and the saved project context only, with no approval payloads, credentials, native account data, event dumps or worker configuration. Run the complete check/test/build suite after all parallel changes are combined and record native GUI results above.

## Mac mini native MCP discovery, beta 39

Verified on 2026-10-03 over SSH, using the Mac mini's installed OpenCode v2.0.12. The immutable beta39 packaged runtime was copied into a temporary folder. The test used a private HOME, XDG directories, AgentKlar service home, temporary project and local ports. It used no live tmux session, normal service configuration, account or inference request.

| Check | Result |
| --- | --- |
| AgentKlar runtime | 0.1.0-beta.39 |
| Actual native client initialization | `cli`, version `2.0.12` |
| Native OpenCode MCP status | Connected |
| Actual native `tools/list` reply | 27 tools |
| `work_report` discovered | Yes |
| Owner worker runs / pending approvals | 0 / 0 |
| Inference started | No |
| Owned test processes | Stopped |
| Temporary remote profile | Removed |

Discovery was observed through a transparent stdio forwarder, which recorded only the native client's initialization identity and tool names/count. It did not replace the native client with a generic MCP test client.

The actual installed v2 API exposed `GET /api/mcp`. The explicit runtime connection used `PUT /api/experimental/mcp/agentklar` with a `config` body. The native client then initialized AgentKlar and fetched its tool list. Its local API required a private startup credential, used inside the isolated probe.

The configured server list was initially empty with both flat and nested private configuration. This proof covers the explicit native runtime add/connect path. Automatic loading after applying the saved native configuration remains unverified. This test also does not prove that OpenCode includes these tools in an inference request or that a user can call them from every native UI surface.

Local evidence: `/private/tmp/agentklar-beta39-remote-native-mcp-proof.json`. The report records actual versions, native connection state, tool names, zero worker/approval counts and stopped test processes. OpenCode's [MCP documentation](https://opencode.ai/docs/mcp-servers/) describes its local stdio configuration; its [v2 configuration source](https://github.com/anomalyco/opencode/blob/dev/specs/v2/config.md) describes the newer nested layout. Actual installed behavior above takes precedence over a documentation assumption.

## Follow-up native MCP report proof, beta.40

A single bounded model request on OpenCode 2.0.12 called `work_report` through
the connected AgentKlar MCP server. The owner saved report revision 1 with native
client `cli 2.0.12`. No workers or approvals were created. The session was stopped
after persistence, without checking final assistant completion. Existing Node
and dependencies were reused read-only in a private profile. Test processes and
files were removed. This establishes a real report tool invocation; saved-config
autoload, delegated worker starts and the GUI checks above remain unverified.
Evidence: `/private/tmp/agentklar-beta40-native-mcp-invocation-proof.json`.
