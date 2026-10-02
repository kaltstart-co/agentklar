# Using AgentKlar from Claude Code or Codex

Work stays in your normal Claude Code or Codex session. Each project starts with **Only when asked**. A routing preset chooses model tiers when a worker starts. Choosing a preset does not turn on delegation.

If Claude Code is not connected, open **Settings → Connections**, choose **Claude Code**, and choose **Connect Claude Code**. Review the change and choose **Apply connection**. Start a new Claude Code session so it loads the MCP tools and instructions.

For one task, say:

> Use AgentKlar for this task. Ask a worker to review the parser for bugs and report its findings. Keep the review read only.

The agent reads `projects_list`, then the project's context and existing runs. It sets `delegation:"requested"` for this worker because you asked for it. A general request such as “Fix the parser” keeps the work in your current session under the default policy.

For a project default, open **Team → Delegation**, choose **Use team when helpful**, then choose **Apply policy**. Or explicitly ask your agent:

> Set this project's AgentKlar delegation mode to automatic and apply the Balanced routing preset.

The agent can read `routing_presets_list` and use `project_update` with the chosen `routingPresetId` and `delegationMode:"automatic"`. It may then delegate larger independent tasks when that helps. Small work stays in the current session. You can override the default for any task:

> Work directly in Claude Code for this task. No delegation.

An agent must not turn on automatic mode or change the routing preset to give itself permission to start workers. Those are project settings that you choose. The separate **Save team** action changes roles only.

Built-in presets are read only. In the Mac app, choose **Edit presets**, then **Make a copy** or **New preset** to create a custom preset. Choose efficient, balanced or capable tiers for routine, standard and hard tasks. You can also adjust those choices using known account allowance. **Save and use** saves the preset and applies it to the current project. Applying a preset saves a copy in the project. Editing the source preset does not change that copy; apply it again when you want the updated rules. Explicit model, harness and computer pins stay fixed.

The backend enforces the manual default on new MCP worker starts. It accepts an explicit `delegation:"requested"` declaration for a human request. The agent is responsible for following your instructions in automatic mode. Starting a worker directly from the trusted dashboard is an explicit start. Native sign-in and approval decisions still belong to the native harness and trusted dashboard.
