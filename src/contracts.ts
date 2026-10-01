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
export type FollowUp = { kind: "review" | "fix"; parentRunId: string; rootRunId: string };
export type FollowUpContext = {
  originalPrompt: string;
  originalPromptTruncated: boolean;
  sourceResult: string;
  sourceResultTruncated: boolean;
  sourceRunId: string;
  sourceHarness: "codex" | "claude";
  sourceModel: string | null;
  sourceState: "completed";
};
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
  nativeHome?: string;
  nativeHomeEnv?: "set" | "unset";
  workerPid?: number;
  launchHash?: string;
  routing?: RoutingDecision;
  followUp?: FollowUp;
  followUpContext?: FollowUpContext;
};
export type RunEvent = {
  id: number;
  runId: string;
  kind: string;
  text: string;
  textTruncated?: boolean;
  createdAt: string;
};
export type RunHandoff = {
  runId: string;
  available: boolean;
  reason: string | null;
  harness: "codex" | "claude" | null;
  nativeSessionId: string | null;
  command: null | {
    executable: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    envUnset: string[];
    shell: "posix";
    display: string;
  };
  notes: string[];
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

export type TaskComplexity = "routine" | "standard" | "hard";
export type WorkerChoice = {
  harness: "codex" | "claude";
  model: string;
  roleId?: string;
  basis: "task-pin" | "role-pin" | "policy";
  tier: "efficient" | "balanced" | "capable" | "unknown";
  reasons: string[];
  warnings: string[];
};
export type WorkerAdvice = {
  projectId: string;
  createdAt: string;
  catalogCheckedAt: string;
  preference: Preference;
  complexity: TaskComplexity;
  requiresImages: boolean;
  choice: WorkerChoice | null;
  alternatives: WorkerChoice[];
  reasons: string[];
  warnings: string[];
  policyVersion: string;
  confidence: "limited";
  sources: string[];
};

// Saved with a run. Keep native catalog and quota details out of run polling.
export type RoutingDecision = {
  selected: Pick<WorkerChoice, "harness" | "model" | "roleId" | "basis" | "tier">;
  preference: Preference;
  complexity: TaskComplexity;
  requiresImages: boolean;
  catalogCheckedAt: string;
  policyVersion: string;
  reasons: string[];
  warnings: string[];
};

export type InstructionFileId = "agents" | "claude";
export type InstructionFileMetadata = {
  id: InstructionFileId;
  path: string;
  status: "present" | "missing" | "unavailable";
  hash: string | null;
  bytes: number | null;
  message: string | null;
};
export type InstructionDocument = {
  id: InstructionFileId;
  path: string;
  exists: boolean;
  hash: string | null;
  text: string;
  bytes: number;
};
export type InstructionPreview = {
  id: string;
  projectId: string;
  file: InstructionFileId;
  path: string;
  before: string | null;
  after: string;
  beforeHash: string | null;
  afterHash: string;
  createdAt: string;
};
export type InstructionChange = {
  id: string;
  projectId: string;
  file: InstructionFileId;
  path: string;
  createdAt: string;
  updatedAt: string;
  state: "prepared" | "applied" | "rolled_back" | "interrupted";
  operation: "apply" | "rollback";
  beforeHash: string | null;
  afterHash: string;
  message: string | null;
};
export type InstructionSnapshot = {
  projectId: string;
  checkedAt: string;
  files: InstructionFileMetadata[];
  changes: InstructionChange[];
};

export type SetupHarness = "codex" | "claude";
export type SetupEntry = { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
export type SetupChange = { id: string; projectId: string; harness: SetupHarness; operation: "apply" | "undo"; state: "prepared" | "applied" | "undone" | "interrupted"; message: string | null; createdAt: string; updatedAt: string };
export type SetupStatus = { projectId: string; harness: SetupHarness; scope: "User" | "Local project"; status: "missing" | "configured" | "conflict" | "unavailable"; message: string; checkedAt: string; change: SetupChange | null; canUndo: boolean };
export type SetupPreview = { id: string; projectId: string; harness: SetupHarness; scope: "User" | "Local project"; configPath: string; cwd: string | null; command: string; entry: SetupEntry; createdAt: string };
