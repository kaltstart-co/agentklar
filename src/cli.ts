import * as p from "@clack/prompts";
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { Harness, OnboardingPreferences, OnboardingSnapshot, Project, SetupChange, SetupHarness, SetupPreview, SetupStatus } from "./contracts.ts";
import { main as serviceMain, managedCliState, managedOnboarding, openManagedDashboard } from "./launchd.ts";

const supported = ["codex", "claude", "muse", "opencode", "antigravity"] as const;
type Preferences = OnboardingPreferences;
type Onboarding = OnboardingSnapshot;
type Option = { value: string; label: string; hint?: string };
export type TerminalPrompts = {
  select(message: string, options: Option[], initialValue?: string): Promise<string | symbol>;
  confirm(message: string): Promise<boolean | symbol>;
  text(message: string): Promise<string | symbol>;
  note(message: string, title: string): void;
};
export type MenuClient = {
  request(route: string, body?: unknown): Promise<unknown>;
  open(view: "work" | "team" | "connections" | "devices"): Promise<void>;
  launch(harness: Harness, project: Project): Promise<void>;
};
const prompts: TerminalPrompts = {
  select: (message, options, initialValue) => p.select({ message, options, initialValue }),
  confirm: message => p.confirm({ message, initialValue: false }),
  text: message => p.text({ message, validate: value => value?.trim() ? undefined : "Enter a project folder." }),
  note: (message, title) => p.note(message, title),
};
const cancelled = Symbol("cancelled");
function answer<T>(value: T | symbol): T { if (typeof value === "symbol") throw cancelled; return value; }
// Native names and paths can contain terminal controls. Do not let them control the menu.
export function terminalText(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "); }
function terminalBlock(value: string): string { return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " "); }
export function installedMainHarnesses(harnesses: Harness[]): Harness[] {
  return harnesses.filter(h => supported.includes(h.id as SetupHarness) && h.available && h.hostSupported && h.executable);
}
export function nativeLaunch(harness: Harness) {
  if (!supported.includes(harness.id as SetupHarness) || !harness.available || !harness.hostSupported || !harness.executable || !isAbsolute(harness.executable))
    throw new Error("Choose an installed native main harness first.");
  const entry = realpathSync(harness.executable);
  if (!statSync(entry).isFile()) throw new Error("The native executable is no longer available.");
  if (entry.endsWith(".cjs")) {
    if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node 24 to open this native harness.");
    return { command: process.execPath, args: [entry] };
  }
  accessSync(entry, constants.X_OK);
  return { command: harness.executable, args: [] as string[] };
}
export async function openNativeHarness(harness: Harness, project: Project) {
  const { command, args } = nativeLaunch(harness), cwd = realpathSync(project.path);
  if (!statSync(cwd).isDirectory()) throw new Error("The project folder is no longer available.");
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { cwd, env: { ...process.env }, stdio: "inherit", shell: false });
    child.once("error", () => fail(new Error("The native harness could not open. Check its installation.")));
    child.once("close", (code, signal) => code === 0 || signal === "SIGINT" ? done() : fail(new Error("The native harness exited. Check its own terminal message.")));
  });
}
async function chooseProject(ui: TerminalPrompts, client: MenuClient, state: Onboarding, cwd: string): Promise<Project> {
  const selected = answer(await ui.select("Which project?", [
    { value: "cwd", label: "Use this folder", hint: terminalText(cwd) },
    ...state.projects.map(project => ({ value: project.id, label: terminalText(project.name), hint: terminalText(project.path) })),
    { value: "choose", label: "Choose another folder" },
  ], state.preferences.projectId ?? "cwd"));
  const saved = state.projects.find(project => project.id === selected);
  if (saved) return saved;
  const path = selected === "cwd" ? cwd : resolve(answer(await ui.text("Project folder")));
  return await client.request("onboarding/project", { name: basename(path), path }) as Project;
}
async function chooseHarness(ui: TerminalPrompts, state: Onboarding): Promise<Harness | null> {
  const available = installedMainHarnesses(state.harnesses);
  if (!available.length) { ui.note("Install Codex, Claude Code, Muse, OpenCode or Antigravity with its native installer, then run agentklar setup again.", "No native main harness found"); return null; }
  const id = answer(await ui.select("Choose your main harness", available.map(h => ({ value: h.id, label: terminalText(h.name), hint: "Installed" })), state.preferences.mainHarness ?? undefined));
  return available.find(h => h.id === id) ?? null;
}
async function connectHarness(ui: TerminalPrompts, client: MenuClient, project: Project, harness: Harness): Promise<SetupStatus> {
  const base = { projectId: project.id, harness: harness.id };
  let status = await client.request("onboarding/setup", { ...base, operation: "status" }) as SetupStatus;
  ui.note(terminalText(status.message), `${terminalText(harness.name)} · ${status.status}`);
  if (status.status === "conflict" || status.change?.state === "interrupted") {
    ui.note("Inspect native settings before making another connection change.", "Connection needs attention");
    if (status.canUndo && status.change && answer(await ui.confirm("Undo the unchanged AgentKlar connection?"))) {
      await client.request("onboarding/setup", { ...base, operation: "undo", changeId: status.change.id });
      status = await client.request("onboarding/setup", { ...base, operation: "status" }) as SetupStatus;
    }
    return status;
  }
  if (status.status !== "missing") return status;
  const preview = await client.request("onboarding/setup", { ...base, operation: "preview" }) as SetupPreview;
  ui.note(terminalBlock([`Scope: ${preview.scope}`, `Native file: ${preview.configPath}`, ...(preview.cwd ? [`Project: ${preview.cwd}`] : []), ...(preview.command ? [preview.command] : []), JSON.stringify(preview.entry, null, 2)].join("\n")), "Exact connection preview");
  if (!answer(await ui.confirm(`Add this AgentKlar entry to ${terminalText(harness.name)}?`))) return status;
  const change = await client.request("onboarding/setup", { ...base, operation: "apply", previewId: preview.id }) as SetupChange;
  if (change.state !== "applied") throw new Error("Connection was interrupted. Refresh status before trying again.");
  status = await client.request("onboarding/setup", { ...base, operation: "status" }) as SetupStatus;
  ui.note("Start or restart your native session to load the connection.", "Entry added");
  return status;
}
export async function runMenu(ui: TerminalPrompts, client: MenuClient, cwd = process.cwd()) {
  let state = await client.request("onboarding") as Onboarding;
  const savedProject = state.projects.find(project => project.id === state.preferences.projectId);
  const savedHarness = installedMainHarnesses(state.harnesses).find(h => h.id === state.preferences.mainHarness) ?? null;
  let project = savedProject && savedHarness ? savedProject : await chooseProject(ui, client, state, cwd);
  let harness = savedProject && savedHarness ? savedHarness : await chooseHarness(ui, state);
  const ready = (status: SetupStatus) => status.status === "configured" && status.change?.state !== "interrupted";
  async function saveMain(h: Harness | null) {
    if (state.preferences.projectId === project.id && state.preferences.mainHarness === (h?.id ?? null)) return;
    state.preferences = await client.request("onboarding/preferences", { projectId: project.id, mainHarness: h?.id ?? null, expectedRevision: state.preferences.revision }) as Preferences;
  }
  let connected = harness ? ready(await connectHarness(ui, client, project, harness)) : false;
  await saveMain(connected ? harness : null);
  while (true) {
    const action = answer(await ui.select(`${terminalText(project.name)} · ${harness ? `${terminalText(harness.name)}${connected ? "" : " · entry not configured"}` : "Choose a main harness"}`, [
      ...(harness ? [{ value: "native", label: `Open ${terminalText(harness.name)}`, hint: "Your native account and permissions" }] : []),
      { value: "work", label: "View work" }, { value: "team", label: "Manage team" },
      { value: "connect", label: "Connect a harness" }, { value: "devices", label: "Add a computer" },
      { value: "project", label: "Change project" }, { value: "exit", label: "Exit" },
    ]));
    if (action === "exit") return;
    try {
      if (action === "native" && harness) await client.launch(harness, project);
      else if (["work", "team", "devices"].includes(action)) await client.open(action as "work" | "team" | "devices");
      else if (action === "connect") {
        state = await client.request("onboarding") as Onboarding;
        const chosen = await chooseHarness(ui, state);
        if (chosen) {
          const configured = ready(await connectHarness(ui, client, project, chosen));
          if (configured && answer(await ui.confirm(`Save ${terminalText(chosen.name)} as your main harness?`))) {
            await saveMain(chosen); harness = chosen; connected = true;
          }
        }
      } else if (action === "project") {
        state = await client.request("onboarding") as Onboarding;
        project = await chooseProject(ui, client, state, cwd);
        connected = harness ? ready(await connectHarness(ui, client, project, harness)) : false;
        await saveMain(connected ? harness : null);
      }
    } catch (error) {
      if (error === cancelled) throw error;
      ui.note(terminalText(error instanceof Error ? error.message : "The action could not finish."), "Needs attention");
      state = await client.request("onboarding") as Onboarding;
    }
  }
}
export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Setup needs an interactive terminal. Run `agentklar setup` in a terminal, or use `agentklar start` and its browser setup link.");
  p.intro("AgentKlar");
  try {
    if (process.platform !== "darwin") {
      p.note("Run `agentklar start` in another terminal and open its setup link. Linux currently uses a foreground service.", "Open browser setup"); p.outro("Your native harness stays in charge."); return;
    }
    const state = await managedCliState();
    if (state !== "running") {
      const yes = answer(await prompts.confirm(state === "not-installed" ? "Start AgentKlar at login on this Mac?" : "Start the installed AgentKlar background service?"));
      if (!yes) { p.outro("Setup left unchanged. Run agentklar setup when ready."); return; }
      await serviceMain([state === "not-installed" ? "install" : "start"]);
    }
    await runMenu(prompts, { request: managedOnboarding, open: openManagedDashboard, launch: openNativeHarness });
    p.outro("Your native harness stays in charge.");
  } catch (error) {
    if (error === cancelled) { p.cancel("Setup cancelled. Confirmed changes remain saved."); return; }
    throw error;
  }
}
