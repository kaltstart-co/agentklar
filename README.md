# AgentKlar

Keep your native coding harness. AgentKlar gives registered projects a shared local work record, saved project context, team roles, and durable worker runs. Start from Codex, Claude Code, Gemini CLI, Cursor, or OpenCode and connect its MCP client to AgentKlar. Codex, Claude Code and Muse have worker adapters. Muse MCP host setup is unavailable. Other installed CLIs are listed with their current support; worker adapters are planned.

This is a fresh TypeScript rewrite. The old Go application is preserved in Git at `archive/pre-rewrite-2026-10-01`. Old databases and configuration are never imported. A run marked **completed** means the worker finished. Review the changes in your normal editor and harness.

## Install and start

Requires Node 24 and npm on macOS or Linux. Install this pinned GitHub beta package, then start the local service:

```sh
npm install -g https://github.com/kaltstart-co/agentklar/releases/download/v0.1.0-beta.6/agentklar-0.1.0-beta.6.tgz
agentklar start
```

The install does not start a service, open a browser, or change native harness settings. Keep that terminal running. Open the one-time setup URL it prints within five minutes. It creates a private local browser session. After setup, the UI lives at `http://127.0.0.1:4317`.

For workers, install Codex or Claude Code and sign in through its native setup first. Use the discovered executable path if the command is not on your shell PATH. For Claude Code, run that executable with `auth login`. No new model API key is required. An installed executable does not prove that you are signed in.

<details>
<summary>Run from a source checkout</summary>

```sh
npm ci
npm run build
npm start
```

For frontend development, run `npm run dev` in another terminal and open `http://127.0.0.1:5173`.

</details>

### Start at login on macOS

After installing the package, install a private per-user [launchd LaunchAgent](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac):

```sh
agentklar service install
agentklar service status
agentklar service open
```

Stop a foreground `agentklar start` first. `open` creates a new one-use browser link, valid for five minutes, and opens it. Use `agentklar service open --print` to print the link without opening a browser. Your existing browser session stays signed in. The service starts at login. Keep the installed package and its Node 24 installation in place. To control it later, use `agentklar service stop`, `start`, or `uninstall`. Stop and uninstall refuse active work; add `--force` to stop active workers. A stopped service starts again at the next login. If a stop command is interrupted, run `agentklar service start` to resume task starts. Uninstall removes login startup and keeps your local projects and run history. Native harness settings and sign-in remain where each harness keeps them. This uses macOS [launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) with your user account. It needs no sudo.

`AGENTKLAR_HOME` and `AGENTKLAR_PORT` choose an isolated service. Set the same values for each command. The setup saves absolute paths for Node and the installed service files. It never stores model API keys in launchd settings. The one-use browser link is not written to launchd logs. A service restart marks unfinished runs interrupted; it does not resume workers.

To update, stop the service, install a new pinned release tarball, then start it again. Native MCP entries and a macOS launchd job contain absolute file paths, so keep the same global npm prefix and Node 24 path when updating. If either path changes, remove and add the managed connection or background job through the local UI and CLI.

Register an existing project folder. Add roles with a harness, optional model, and responsibility. Start a task from your native harness through MCP or from the local UI. Only registered projects can run workers. Each project allows one worker at a time; a busy request returns an error. Repeating the same task with the same idempotency key returns its original run.

Project cost preference is saved as economical, balanced, or best. Optional model advice uses that saved preference, task type, complexity, native availability and model family profiles. Fresh comparable LiveBench reference scores can break policy ties. Your explicit task or role model pin takes priority. Role responsibility is sent with the task, and the role snapshot, worker harness, and actual native model stay in its history. Choose an installed worker harness in the local UI. A selected role chooses its harness. Changing the harness clears the model pin so a model name from another harness is not carried over.

## Native models and account allowance

Open **Models**, choose a project, and select **Refresh models and allowance**. AgentKlar reads the native Codex, Claude, and Muse model lists. New task and Team offer models for supported workers. Muse's native model descriptions can include data-use terms; review them before choosing a model. Loading the list never changes your model pin. A listed model does not prove that your account can use it or that you are signed in. Prices in native vendor descriptions describe API usage, not your subscription bill.

**Usage** shows native Codex account allowance when available: used and remaining percentages, window duration, and reset time in your local time zone. These limits are shared across the native account; project task tokens do not calculate them. A native included-usage block remains visible even when a percentage window has reset. Claude account allowance is unavailable through the current SDK. Muse account allowance is not read by this adapter. Missing information stays unknown. Native reads occur when you request a refresh or model advice; the normal task polling reads no model or quota data. Catalog snapshots are cached per project and refreshes within 30 seconds reuse that cache.

## Benchmark references

Models shows cached [LiveBench scores](https://livebench.ai/table_2026_06_25.csv) from reviewed release 2026-06-25. Expand a model to see its category scores and source row. Refresh benchmarks downloads only fixed public sources; it sends no project data and makes no model call. The last good snapshot stays available if refresh fails. Advice and launches use bundled or cached scores without downloading them. Scores checked more than seven days ago are excluded from tie breaking. Automatic discovery of a new benchmark release is not implemented.

Task type selects Agentic Coding (default), Reasoning, Data Analysis or Language. Exact reviewed model IDs use max-effort benchmark rows. Native settings and task environments can differ, so the scores are reference evidence and do not promise native performance or subscription savings. Explicit pins and native limits still take priority. See [third-party notices](THIRD_PARTY_NOTICES.md) for source attribution.

## Model advice

In **New task**, **Choose model automatically** is on by default. Select task complexity and **Images needed** under **Task needs and model preview**, then select **Start worker**. AgentKlar reads native model and allowance metadata, applies the saved Team preference, records its choice and starts one worker. The selected worker harness and task or role model pin stay fixed. Turn automatic choice off to use a typed model or native default. **Suggest a model** is an optional preview; **Use suggestion** copies that model into the form and makes it a task pin. A failed choice leaves the draft open and starts no worker.

Your native harness can classify the task with its existing model and call `task_start` with `routing:{complexity,requiresImages,taskType}`. This chooses and starts a worker in one call. `recommend_worker` remains an optional preview. The router itself uses no LLM. Choices use reviewed family profiles and native model lists. Fresh LiveBench reference scores can break ties within the same policy and known-allowance group when every candidate has comparable evidence. Subscription cost and savings remain unknown. Unknown account allowance stays unknown. Model image support does not imply browser or tool access. Claude image support is unknown through the current SDK.

Muse can be selected directly or through a saved Muse role. Automatic advice keeps Muse out of unpinned choices because no reviewed Muse cost or quality tier is available. A specific Muse model pin can receive advice with unknown tier and allowance. A manual Muse task with no model pin uses the native default.

Each routed run keeps a small record of the selected model, task needs and policy reasons. The task detail shows the requested model and the model reported by the native harness separately. A worker failure does not trigger another model automatically. The task detail also shows any selected benchmark reference and whether it broke a tie.

## Linked review and fix

Open a completed work task and select **Review work**. The draft starts a read-only review of that task. Open a completed review and select **Fix findings** to draft a worker task that can change files. After the fix completes, select **Review work** again. Choose the role, harness, model and task needs for each step before starting it. The task detail links all runs in the chain. Each step starts only when you select **Start worker** or call `task_start` through MCP.

Muse cannot enforce read-only work through its worker interface. Use Codex or Claude Code for a linked review. Muse can run a linked fix when workspace changes are allowed.

The new worker receives the original work prompt and the immediately preceding result, each capped at 8,000 characters. This data is frozen when the linked run starts and marked as untrusted task data. It does not resume the earlier native session or grant permissions. A completed review, including one that says `NO_FINDINGS`, means only that the worker finished; it is not a human acceptance decision.

## Shared project context

Open **Context** to save a project brief, decisions and lessons, and next steps. This is a shared local record that your native harnesses can read and update through MCP. Memory is saved explicitly; AgentKlar does not collect it automatically from chats or project files. The fields allow 2,000, 4,000, and 2,000 characters respectively.

Each save creates a revision. If another harness saves first, the UI keeps your draft and shows a conflict. **Load latest (replaces draft)** loads that newer revision. New tasks use saved project context by default; turn off **Use project context** to skip it. Each task retains the exact context used at launch. Open its **Project context** disclosure to inspect that snapshot. Unsaved edits apply after you save them.

## Native project instructions

Open **Instructions** and choose **Codex · AGENTS.md** or **Claude Code · CLAUDE.md**. AgentKlar shows the status and actual path of that file in the project root. Select **Load file**, edit the text, then **Preview changes** to read the before and after. **Apply change** writes that file. Files must fit within 32 KiB of UTF-8 text. Nothing is saved automatically.

Each harness keeps its own native instruction file. These files are separate from the shared project context above. Native settings and parent files can change what loads. Start a new native session to check. Creating CLAUDE.md may stop Claude from loading AGENTS.md under its default settings; AgentKlar does not copy the instructions between files.

Drafts stay in the open app when you switch views or harnesses, or the local service briefly disconnects. If a file changes on disk, the UI keeps your draft. **Reload file (replaces draft)** loads the current file. **Undo latest change** restores the saved prior contents only when the current file still matches that change. Recent changes remain visible in the local UI. An interrupted change has a **Try undo** action with the same file check. Instruction editing is available through the trusted local UI; MCP can read file status and change metadata.

## Project skills

Open **Instructions → Project skills**. Choose Codex or Claude Code, then enter a GitHub `owner/repo` (optionally `#ref`) and one exact skill name. **Preview skill** shows its target folder, source hash, full `SKILL.md` text, and a list of every file and folder with sizes. **Install reviewed skill** copies those exact staged bytes into `.agents/skills/<name>` for Codex or `.claude/skills/<name>` for Claude Code. Codex's `.agents/skills` folder can also be read by other native tools. Start a new native session to check whether the skill loads.

For a managed skill, choose **Preview upstream update**. AgentKlar stages the same saved repository, ref and skill name. Review the upstream text and file list alongside the current install, then choose **Apply reviewed update**. A matching tree shows **Already up to date** and makes no project write. A pinned ref stays pinned; updating does not select a newer tag.

The trusted local UI can stage, install, update, and remove skills. The authenticated local HTTP API can list folder metadata. There is no MCP skill tool. AgentKlar installs only when the target name is free. **Remove managed skill** checks the original project and parent folders, every managed file, its mode, and its folder identity. External or changed skills stay in place. Update checks the current managed tree and the reviewed stage again before replacing it. It prepares the new tree first and keeps the old tree in a temporary backup during the swap. An ordinary failed update restores the old tree when both paths still match. A conflicting edit or interrupted process keeps recovery files and shows their path for manual inspection; restart makes no recovery writes. A failed install or remove can leave a partial folder. No global skill or native user config is changed. Plugin, hook, and MCP bundles are outside this support.

## Connect MCP

Open **Settings**, select a registered project, then choose **Codex** or **Claude Code**. **Refresh native status** reads the current `agentklar` entry. **Preview connection** shows the exact native add command, config path, scope and generated bridge entry. **Add to Codex/Claude Code** runs that command. This is an explicit local UI action; MCP cannot install itself.

Codex uses **User** scope, shared across projects. Claude Code uses **Local project** scope in the selected project's real folder. AgentKlar respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. A different existing `agentklar` entry, or an entry in another native scope, needs handling in native MCP settings. An exact existing entry is shown as configured and is never adopted for undo.

The generated bridge uses absolute paths for Node 24 and `dist/server/mcp.js`. It passes this running service's `AGENTKLAR_HOME` and `AGENTKLAR_PORT`, and reads the private local token file. Native settings contain no AgentKlar token. Keep the installed package and local service available. Native add/remove commands own their config serialization and migrations; unknown native keys may change under those rules.

**Undo managed connection** removes only the unchanged entry that this app installed from the selected project. Native entries changed outside AgentKlar are kept. An interrupted change remains visible after restart; **Try undo unchanged entry** is available only when the saved entry still matches. Setup does not start your harness. Start or restart a native session to load or unload MCP, and keep its native trust and permission decisions. A configured entry does not prove that an active session has loaded it.

The folder check now includes its creation time, so a deleted project cannot pass as the same folder if the disk reuses its file number. Older saved changes lack this check. Their undo is refused; inspect the instruction file or native MCP entry and change it through the native tool if needed. A filesystem that cannot report a stable folder creation time cannot use these guarded edits.

For other MCP hosts, use their normal setup. This example expects `agentklar` on that host's PATH:

```json
{
  "mcpServers": {
    "agentklar": {
      "command": "agentklar",
      "args": ["mcp"]
    }
  }
}
```

Start the local service before the MCP connection. The stdio bridge talks to the independent service. Closing the MCP caller leaves its worker running. Ask the tools for registered projects, discovered harnesses, run status, compact events, result, or stop. No MCP tool can approve a native permission request. The API and tool list are in [docs/API.md](docs/API.md).

## Native permissions and data

Codex workers use `codex app-server` with your existing authentication and settings. AgentKlar leaves native approval and sandbox settings in place. Selecting read only adds Codex’s read-only filesystem restriction. Claude Code workers reuse the [official Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and the installed native CLI with its own authentication and settings. Claude read only permits only the model tools Read, Glob, and Grep; user-configured hooks may still run. It does not add an operating system sandbox. Muse workers use the native Muse SDK and installed CLI; native sign-in and permissions still apply. Muse read-only starts are rejected. Supported concrete native approvals appear in the authenticated local UI. Allow once, decline, or cancel there. Broader permission changes and unsupported native input requests need attention; stop that run and continue in your native harness.

Private records live in `~/.agentklar/local-v1/`: SQLite state, a private MCP bearer token, and a separate SQLite service ownership lock. `AGENTKLAR_HOME` can choose a different isolated folder. `AGENTKLAR_PORT` changes the loopback port. Browser writes require an exact allowed local Origin and session cookie. The server binds only to `127.0.0.1`. A hosted static preview has no local connection and shows no invented work.

On a service restart, unfinished runs become interrupted. Native sessions are recorded, but AgentKlar does not claim to recover a live worker. A possibly surviving owned process group keeps its project blocked until it exits; the service never kills an unverified or reused process ID. Cancellation interrupts the owned turn and terminates its owned subprocess group. Keep the service running for active work.

For a finished run, open **Continue in native harness** in its task detail, or call `run_handoff({runId})` through MCP. AgentKlar shows a POSIX terminal command only when it has the saved native session UUID, session home, project folder, and installed CLI, with no active worker in that project. The command keeps the saved model when known and Codex read-only sandbox when selected. For Claude, it also keeps whether `CLAUDE_CONFIG_DIR` was set or unset when the worker started; setting that variable changes where Claude reads its config. For Muse, it pins `XDG_DATA_HOME` to the parent of the native data home recorded by Muse before resuming. Claude read-only runs have no ready command because their SDK tool restriction cannot be carried into native CLI resume. Older runs without saved session scope have no ready command. The command is a snapshot; AgentKlar does not launch or monitor the manual session. Close native work before starting another worker in the same project.

Results and event tails have character limits and explicit truncation flags. Native token counts are shown when available. Dollar cost and native task quality remain unknown. Account allowance is shown only when the native harness provides it.

## Check the code

```sh
npm run check
npm run build
npm test
npm run smoke:package
```

Tests use a fake native protocol process and the official MCP SDK on real stdio. They verify persistence, project isolation, idempotency, cancellation, restart state, exclusive service ownership, native event identity, role context, and approval boundaries. The package smoke builds a tarball, installs only production dependencies in a clean prefix, then checks the CLI, built UI, and generated MCP bridge from another working folder. It starts no model. The verified Codex smoke tests use separate temporary projects and explicitly pinned Sol models. Claude Code integration is in progress. The installed CLI was found, but native authentication was not active; a successful live Claude worker run has not been verified.

See [docs/VALIDATION.md](docs/VALIDATION.md) for local and real native evidence. See [BUILD_PLAN.md](BUILD_PLAN.md) for the staged roadmap and [FEATURE_CHECKLIST.md](FEATURE_CHECKLIST.md) for verified scope. MIT license.
