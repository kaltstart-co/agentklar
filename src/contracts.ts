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
export type ProjectContext = {
  projectId: string;
  revision: number;
  brief: string;
  memory: string;
  handoff: string;
  updatedAt: string | null;
  updatedVia: "ui" | "mcp" | null;
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
  harness?: "codex" | "claude";
  projectId: string;
  roleId?: string;
  prompt: string;
  model?: string;
  effectiveModel?: string;
  roleSnapshot?: Role;
  contextSnapshot?: ProjectContext;
  contextRevision?: number | null;
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

export type CatalogModel = {
  id: string;
  name: string;
  description: string;
  resolvedModel: string | null;
  isDefault: boolean;
  inputModalities: string[] | null;
};
export type QuotaWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};
export type QuotaBucket = {
  id: string;
  name: string | null;
  normalModel: string | null;
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  spendControlReached: boolean | null;
};
export type AccountQuota = {
  status: "available" | "unavailable";
  message: string | null;
  ordinaryUsageAllowed: boolean | null;
  buckets: QuotaBucket[];
};
export type HarnessCatalog = {
  harness: "codex" | "claude";
  models: CatalogModel[];
  modelsStatus: "available" | "unavailable";
  modelsMessage: string | null;
  modelsTruncated: boolean;
  quota: AccountQuota;
};
export type CatalogSnapshot = {
  projectId: string;
  checkedAt: string;
  harnesses: HarnessCatalog[];
};
