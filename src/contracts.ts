import type { BenchmarkEvidence, TaskType } from "./benchmarks.ts";
import type { ToolEvidence, ToolCapability } from "./capabilities.ts";
export const workerHarnesses = ["codex", "claude", "muse", "opencode", "gemini", "cursor-agent", "zcode"] as const;
export type WorkerHarness = typeof workerHarnesses[number];
export type Preference = "economical" | "balanced" | "best";
export type Role = {
  id: string;
  name: string;
  harness: string;
  model?: string;
  peerId?: string;
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
export type LaunchSource =
  | { kind: "ui" }
  | { kind: "mcp"; clientName: string; clientVersion?: string };
export type ProjectLead = {
  claimId: string;
  projectId: string;
  clientName: string | null;
  clientVersion?: string;
  claimedAt: string;
  lastSeenAt: string;
  expiresAt: string;
};
export type FollowUp = { kind: "review" | "fix"; parentRunId: string; rootRunId: string };
export type FollowUpContext = {
  originalPrompt: string;
  originalPromptTruncated: boolean;
  sourceResult: string;
  sourceResultTruncated: boolean;
  sourceRunId: string;
  sourceHarness: WorkerHarness;
  sourceModel: string | null;
  sourceState: "completed";
};
export type RunWorkspace =
  | { kind: "project"; path: string }
  | {
      kind: "worktree";
      path?: string;
      branch?: string;
      repoRoot: string;
      commonDir: string;
      repoStamp: string;
      commonStamp: string;
      baseCommit: string;
      rootRunId: string;
      nativeName?: string;
      plannedPath?: string;
      verified?: boolean;
      workspaceStamp?: string;
    };
export type MuseSubscriptionUsage = {
  observedAtMs: number;
  weekly: { resetsAtMs: number; usedPercent: number };
  window: { resetsAtMs: number; usedPercent: number; windowDurationMins: number };
};
export type OpenCodeScope = {
  home: string;
  dataDir: string;
  dbPath?: string;
  env: Record<string, string>;
  envUnset: string[];
  unsupported?: boolean;
};
export type Run = {
  id: string;
  harness?: WorkerHarness;
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
  museSubscriptionUsage?: MuseSubscriptionUsage;
  threadId?: string;
  turnId?: string;
  nativeHome?: string;
  nativeHomeEnv?: "set" | "unset";
  openCodeScope?: OpenCodeScope;
  workerPid?: number;
  workspace?: RunWorkspace;
  launchSource?: LaunchSource;
  launchHash?: string;
  routing?: RoutingDecision;
  nativeTools?: ToolEvidence;
  followUp?: FollowUp;
  followUpContext?: FollowUpContext;
};
export type ProjectRun = Pick<Run, "id" | "projectId" | "harness" | "roleId" | "readOnly" | "state" | "createdAt" | "updatedAt" | "followUp" | "launchSource"> & {
  prompt: string;
  promptTruncated: boolean;
  workspaceKind: "project" | "worktree";
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
  harness: WorkerHarness | null;
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
  device?: { id: string; label: string; platform: string };
  peers?: { id: string; label: string; deviceId: string; projectId: string; remoteProjectId: string }[];
  remoteDispatches?: RemoteDispatch[];
  projects: Project[];
  runs: Run[];
  approvals: Approval[];
  harnesses: Harness[];
  leads: Record<string, ProjectLead>;
  controls?:Record<string,ControlStatus>;
};
export type RemoteDispatch = { routing?:RoutingDecision; id: string; prompt: string; createdAt: string; launchHash?: string; projectId: string; peerId: string; ownerDeviceId: string; ownerRunId?: string; lastKnownRun?: Run; lastObservedAt?: string; connection: "unknown" | "observed"; error?: string };
export type ChangeContinuation = { harness: string; cwd: string; display: string; freshSession: true };
export type NativeInstallation = { path: string; version: string | null; fingerprint: string };
export type NativeInstallationStatus = { harness: string; selected: string | null; saved: string | null; restartRequired: boolean; installations: NativeInstallation[]; changed?: boolean; baseline?: { path: string | null; fingerprint: string | null; version: string | null }; current?: { path: string | null; fingerprint: string | null; version: string | null } };

export type CatalogModel = {
  toolEvidence?: ToolEvidence;
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
  observedAt?: string;
  status: "available" | "unavailable";
  message: string | null;
  ordinaryUsageAllowed: boolean | null;
  buckets: QuotaBucket[];
};
export type HarnessCatalog = {
  harness: WorkerHarness | "antigravity";
  auth?: {
    status: "signed_in" | "sign_in_required" | "unknown";
    source: "claude-auth-status";
    message: string;
  };
  models: CatalogModel[];
  modelsStatus: "available" | "unavailable";
  modelsMessage: string | null;
  modelsTruncated: boolean;
  connectedProviderIds?: string[];
  quota: AccountQuota;
};
export type CatalogSnapshot = {
  projectId: string;
  checkedAt: string;
  harnesses: HarnessCatalog[];
};

export type TaskComplexity = "routine" | "standard" | "hard";
export type WorkerChoice = {
  device?: {id: string; label: string; peerId?: string};
  catalogCheckedAt?: string;
  benchmark?: BenchmarkEvidence;
  harness: WorkerHarness;
  model: string;
  roleId?: string;
  basis: "task-pin" | "role-pin" | "policy";
  tier: "efficient" | "balanced" | "capable" | "unknown";
  reasons: string[];
  warnings: string[];
};
export type WorkerAdvice = {
  requiresTools?: ToolCapability[];
  readOnly?: boolean;
  taskType?: TaskType;
  benchmarkMethod?: "reference-tie-break" | "policy-fallback" | "pin";
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
  requiresTools?: ToolCapability[];
  taskType?: TaskType;
  benchmarkMethod?: "reference-tie-break" | "policy-fallback" | "pin";
  selected: Pick<WorkerChoice, "harness" | "model" | "roleId" | "basis" | "tier" | "benchmark" | "device" | "catalogCheckedAt">;
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

export type SetupHarness = "codex" | "claude" | "muse" | "opencode" | "antigravity";
export type OnboardingPreferences = {
  revision: number;
  projectId: string | null;
  mainHarness: SetupHarness | null;
  updatedAt: string | null;
};
export type OnboardingSnapshot = { preferences: OnboardingPreferences; projects: Project[]; harnesses: Harness[] };
export type AntigravitySetupEntry = { command: string; args: string[]; env: Record<string, string>; disabled: false };
export type SetupEntry = { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
export type OpenCodeSetupEntry = { type: "local"; command: string[]; environment: Record<string, string> };
export type SetupChange = { id: string; projectId: string; harness: SetupHarness; operation: "apply" | "undo"; state: "prepared" | "applied" | "undone" | "interrupted"; message: string | null; createdAt: string; updatedAt: string };
export type SetupStatus = { projectId: string; harness: SetupHarness; scope: "User" | "Local project"; status: "missing" | "configured" | "conflict" | "unavailable"; message: string; checkedAt: string; change: SetupChange | null; canUndo: boolean };
export type SetupPreview = { id: string; projectId: string; harness: SetupHarness; scope: "User" | "Local project"; configPath: string; cwd: string | null; command: string | null; entry: SetupEntry | OpenCodeSetupEntry | AntigravitySetupEntry; createdAt: string };

export type ControlStatus = {
  projectId: string;
  mode: 'advisory'|'coordinated';
  revision: number;
  lead: ProjectLead|null
};
export type ControlPacket = {
  receipt?: ControlReceipt;
  id: string;
  projectId: string;
  digest: string;
  createdAt: string;
  context: ProjectContext;
  control: ControlStatus;
  observedLead: ProjectLead|null;
  work: {
    local: {
      id: string;
      state: string;
      harness: string;
      updatedAt: string;
      workspace?: {
        kind: string;
        path?: string;
        pathTruncated?: boolean
      };
      followUp?: FollowUp
    }[];
    remote: {
      id: string;
      ownerDeviceId: string;
      ownerRunId?: string;
      state: string|null;
      lastObservedAt?: string;
      connection: string
    }[];
    totalLocal: number;
    totalRemote: number;
    pointers: {
      context: string;
      runs: string;
      remoteRuns: string
    }
  }
};
export type ControlReceipt = {
  id: string;
  packetId: string;
  projectId: string;
  requestId: string;
  digest: string;
  revision: number;
  lead: ProjectLead;
  acceptedAt: string
};

export type NativeInventorySource = {
  path: string | null;
  pathTruncated: boolean;
  scope: "user" | "project" | "system" | "environment";
  kind: "config" | "plugin-cache" | "plugin-manifest" | "marketplace" | "extension-directory" | "desktop-sync";
  status: "present" | "missing" | "unsafe" | "unreadable" | "oversized" | "invalid" | "unsupported" | "changed";
  inspection: "metadata" | "manifest";
  message: string;
};
export type NativeInventoryExtension = {
  name: string;
  version: string | null;
  sourcePath: string;
  pathTruncated: boolean;
  scope: "user" | "project";
  evidence: "cached-package" | "project-manifest";
  activationUnknown: true;
};
export type NativeInventory = {
  projectId: string;
  checkedAt: string;
  activationUnknown: true;
  harnesses: {
    harness: SetupHarness;
    sources: NativeInventorySource[];
    extensions: NativeInventoryExtension[];
    extensionsTruncated: boolean;
    coverage: string[];
  }[];
  truncated: boolean;
};
