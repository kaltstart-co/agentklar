export type Preference = "economical" | "balanced" | "best";
export type Role = {
  id: string;
  name: string;
  harness: string;
  model?: string;
  responsibility: string;
};
export type Project = {
  id: string;
  name: string;
  path: string;
  preference: Preference;
  roles: Role[];
  createdAt: string;
};
export type RunState =
  | "running"
  | "needs_attention"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type Run = {
  id: string;
  projectId: string;
  roleId?: string;
  prompt: string;
  model?: string;
  effectiveModel?: string;
  roleSnapshot?: Role;
  readOnly: boolean;
  state: RunState;
  result: string;
  resultTruncated?: boolean;
  promptTruncated?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
  tokens: number | null;
  threadId?: string;
  turnId?: string;
  workerPid?: number;
  launchHash?: string;
};
export type RunEvent = {
  id: number;
  runId: string;
  kind: string;
  text: string;
  textTruncated?: boolean;
  createdAt: string;
};
export type Approval = {
  id: string;
  runId: string;
  kind: "command" | "file";
  title: string;
  details: unknown;
  decisions: string[];
  createdAt: string;
};
export type Harness = {
  id: string;
  name: string;
  available: boolean;
  executable: string | null;
  workerSupported: boolean;
  hostSupported: boolean;
  reason: string;
};
export type Snapshot = {
  projects: Project[];
  runs: Run[];
  approvals: Approval[];
  harnesses: Harness[];
};
