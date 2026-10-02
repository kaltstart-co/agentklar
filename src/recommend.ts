import { benchmarksFresh, evidenceForModel, benchmarkNotice, type BenchmarkSnapshot } from "./benchmarks.ts";
import { z } from "zod";
import type {
  CatalogModel,
  CatalogSnapshot,
  HarnessCatalog,
  Project,
  WorkerAdvice,
  WorkerChoice,
} from "./contracts.ts";

export const recommendationSchema = z
  .object({
    roleId: z.string().min(1).max(80).optional(),
    harness: z.enum(["codex", "claude", "muse", "opencode"]).optional(),
    model: z.string().min(1).max(120).optional(),
    complexity: z.enum(["routine", "standard", "hard"]).default("standard"),
    taskType: z.enum(["coding", "reasoning", "data-analysis", "language"]).default("coding"),
    requiresImages: z.boolean().default(false),
  })
  .strict();
export type RecommendationInput = z.infer<typeof recommendationSchema>;
type Harness = WorkerChoice["harness"];
type WorkerCatalog = HarnessCatalog & { harness: Harness };
type Tier = WorkerChoice["tier"];
type Candidate = {
  choice: WorkerChoice;
  distance: number;
  allowed: boolean;
  exhausted: boolean;
  order: number;
  benchmarkModel: string;
};

// Reviewed product policy order, not measured coding quality or price.
const profiles: Record<Exclude<Harness, "muse" | "opencode">, Record<Exclude<Tier, "unknown">, string[]>> = {
  codex: {
    efficient: ["gpt-6-luna", "gpt-5.6-luna"],
    balanced: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"],
    capable: ["gpt-6-astra"],
  },
  claude: {
    efficient: ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    balanced: [
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
    ],
    capable: [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
    ],
  },
};
const sources = [
  "https://developers.openai.com/api/docs/guides/model-selection",
  "https://developers.openai.com/api/docs/guides/latest-model",
  "https://code.claude.com/docs/en/model-config",
];
const tiers = ["efficient", "balanced", "capable"] as const;
function profile(
  harness: Harness,
  model: CatalogModel | undefined,
  pin?: string,
) {
  if (harness === "muse" || harness === "opencode") return { tier: "unknown" as const, order: 999 };
  const id =
    harness === "claude"
      ? model?.resolvedModel || model?.id || pin
      : model?.id || pin;
  for (const tier of tiers) {
    const order = profiles[harness][tier].indexOf(id || "");
    if (order >= 0) return { tier, order };
  }
  return { tier: "unknown" as const, order: 999 };
}
function quota(
  catalog: HarnessCatalog,
  model: CatalogModel | undefined,
  id: string,
  now: number,
  checkedAt: string,
) {
  const nativeModel = model?.resolvedModel || model?.id || id;
  const claudeFamily = /^(?:claude-)?(opus|sonnet)(?:-|$)/.exec(nativeModel)?.[1];
  const relevant = catalog.quota.buckets.filter(b => {
    if (b.normalModel === null) return catalog.harness === "codex" && b.id === "codex" ||
      catalog.harness === "muse" && b.id === "muse" ||
      catalog.harness === "claude" && ["claude", "seven_day_oauth_apps"].includes(b.id);
    if (catalog.harness === "claude" && ["opus", "sonnet"].includes(b.normalModel)) return b.normalModel === claudeFamily;
    return b.normalModel === id || b.normalModel === model?.id || b.normalModel === model?.resolvedModel;
  });
  const windows = relevant
    .flatMap((b) => [b.primary, b.secondary])
    .filter((w) => w !== null);
  // Product freshness bound, not a prediction of consumption between reads.
  const observed = Date.parse(catalog.quota.observedAt || checkedAt);
  const fresh = Number.isFinite(observed) && observed <= now && now - observed <= 5 * 60_000;
  const remaining = (fresh ? windows : []).flatMap((w) =>
    Number.isFinite(w.usedPercent) &&
    (w.resetsAt === null ||
      (Number.isFinite(w.resetsAt) && w.resetsAt * 1000 > now))
      ? [Math.max(0, Math.min(100, 100 - w.usedPercent))]
      : [],
  );
  return {
    blocked:
      fresh && (catalog.quota.ordinaryUsageAllowed === false ||
      relevant.some((b) => b.spendControlReached === true)),
    allowed: fresh && catalog.quota.ordinaryUsageAllowed === true,
    exhausted: remaining.some(r => r === 0),
    old: !fresh,
    headroom: remaining.length ? Math.min(...remaining) : null,
    stale: windows.some((w) => w.resetsAt !== null && w.resetsAt * 1000 <= now),
  };
}
function target(
  project: Project,
  input: RecommendationInput,
  headroom: number | null,
) {
  if (project.preference === "best") return "capable";
  if (project.preference === "economical")
    return input.complexity === "hard" ? "balanced" : "efficient";
  if (headroom !== null && headroom <= 20)
    return input.complexity === "hard" ? "balanced" : "efficient";
  if (headroom !== null && headroom >= 50 && input.complexity !== "routine")
    return "capable";
  return input.complexity === "routine"
    ? "efficient"
    : input.complexity === "hard"
      ? "capable"
      : "balanced";
}

/** Pure advice. The caller supplies only service-read native metadata and installed commands. */
export type RecommendationSource = {
  catalog: CatalogSnapshot;
  installed: Record<"codex" | "claude", boolean> & Partial<Record<"muse" | "opencode", boolean>>;
  device?: { id: string; label: string; peerId?: string };
};
export function recommendWorker(project: Project, input: RecommendationInput, snapshot: CatalogSnapshot, installed: RecommendationSource["installed"], now = Date.now(), benchmarks?: BenchmarkSnapshot): WorkerAdvice {
  return recommendWorkers(project, input, [{catalog: snapshot, installed}], now, benchmarks);
}
export function recommendWorkers(project: Project, input: RecommendationInput, sourcesInput: RecommendationSource[], now = Date.now(), benchmarks?: BenchmarkSnapshot): WorkerAdvice {
  const role = input.roleId
    ? project.roles.find((r) => r.id === input.roleId)
    : undefined;
  if (input.roleId && !role) throw new Error("Role not found");
  if (role && input.harness && input.harness !== role.harness)
    throw new Error("Task harness must match the selected role harness.");
  if (role && role.harness !== "codex" && role.harness !== "claude" && role.harness !== "muse" && role.harness !== "opencode")
    throw new Error("This role harness has no worker adapter yet.");
  const harness =
    (role?.harness as Harness | undefined) ||
    input.harness ||
    (input.model ? "codex" : undefined);
  const pin = input.model || role?.model;
  const basis = input.model ? "task-pin" : pin ? "role-pin" : "policy";
  const advice: WorkerAdvice = {
    projectId: project.id,
    createdAt: new Date(now).toISOString(),
    catalogCheckedAt: sourcesInput[0]?.catalog.checkedAt || new Date(now).toISOString(),
    preference: project.preference,
    complexity: input.complexity,
    taskType: input.taskType,
    benchmarkMethod: pin ? "pin" : "policy-fallback",
    requiresImages: input.requiresImages,
    choice: null,
    alternatives: [],
    reasons: [],
    warnings: [
      "Limited policy advice. Model access, coding quality and actual subscription cost are not verified.",
    ],
    policyVersion: "2026-10-02.3",
    confidence: "limited",
    sources: [...sources],
  };
  const warn = (message: string) => {
    if (advice.warnings.length < 8 && !advice.warnings.includes(message))
      advice.warnings.push(message);
  };
  const candidates: Candidate[] = [];
  const evaluate = (
    catalog: WorkerCatalog,
    model: CatalogModel | undefined,
    id: string,
    pinned: boolean,
    source: RecommendationSource,
    nativeFallback = false,
  ) => {
    const q = quota(catalog, model, id, now, source.catalog.checkedAt);
    const p = profile(catalog.harness, model, id);
    const warnings: string[] = [];
    const reasons: string[] = [];
    const reject = (reason: string) => {
      if (pinned)
        advice.reasons.push(
          `Pinned ${catalog.harness} model ${id}: ${reason} No replacement was selected.`,
        );
      else warn(`${catalog.harness} ${id}: ${reason}`);
    };
    if (q.blocked)
      return reject(
        "native ordinary usage or a relevant spend control is blocked.",
      );
    if (q.exhausted && !pinned)
      return reject("an applicable fresh subscription window is exhausted; paid overage access is unknown.");
    if (q.exhausted && pinned)
      warnings.push("An applicable fresh subscription window is exhausted. Preserved your pin; native access or paid overage may be required.");
    if (q.old)
      warnings.push("Allowance observation is older than five minutes, invalid or in the future; it was ignored. Refresh native evidence.");
    if (catalog.quota.observedAt)
      reasons.push(`Subscription usage was observed at ${catalog.quota.observedAt}; this is not a live balance.`);
    const sourceChecked = Date.parse(source.catalog.checkedAt);
    if (pinned && !role && source.device?.peerId && (!model || catalog.modelsStatus !== "available" || !Number.isFinite(sourceChecked) || sourceChecked > now || now - sourceChecked > 5 * 60_000))
      return reject("fresh mapped native catalog evidence did not offer this exact model.");
    if (catalog.harness === "opencode" && !model)
      return reject("connected OpenCode provider did not offer this exact text-and-tool model.");
    if (input.requiresImages && !model?.inputModalities?.includes("image"))
      return reject(
        model?.inputModalities
          ? "native catalog does not list image input."
          : "native image support is unknown.",
      );
    if (!pinned && model?.id === "fable")
      return reject(
        "Fable billing may require usage credits; automatic advice excludes it.",
      );
    if (pinned && (model?.id === "fable" || id === "fable"))
      warnings.push(
        "Fable billing may require usage credits; included access and billing are unknown.",
      );
    if (
      !pinned && !nativeFallback &&
      (p.tier === "unknown" ||
        (catalog.harness === "claude" && model?.id === "default"))
    )
      return reject(
        "no reviewed policy tier is available for this native choice.",
      );
    if (!pinned && input.complexity === "hard" && p.tier === "efficient")
      return reject("hard tasks require at least the balanced policy tier.");
    if (!q.allowed)
      warnings.push(
        "Native included usage allowance is unknown; access or billing may need a native check.",
      );
    if (q.headroom === null)
      warnings.push(
        "Applicable quota headroom is unknown; no empty or full quota is assumed.",
      );
    else {
      reasons.push(
        `Applicable native windows have at least ${q.headroom}% remaining. The 20% and 50% thresholds are product rules; their effect on subscription units is unknown.`,
      );
      if (q.headroom <= 20)
        warnings.push(
          "Native headroom is low. This advice does not estimate remaining tasks or cost.",
        );
    }
    if (q.stale)
      warnings.push(
        "A reported reset time has passed; recovery is unknown and stale windows were ignored.",
      );
    if (!model)
      warnings.push(
        "Pinned model is absent from the current catalog; capability and access are unknown.",
      );
    if (p.tier === "unknown")
      warnings.push(nativeFallback
        ? "Native fallback has no reviewed tier or comparable scores. Cost and quality ranking are unknown; the saved preference cannot be compared."
        : "Pinned model has no reviewed tier; capability, billing and access are unknown.");
    if (catalog.harness === "muse" && /contributor/i.test(id))
      warnings.push("Review the native model description for contributor data-use terms before starting work.");
    const wanted = target(project, input, q.headroom);
    if (pinned)
      reasons.unshift(
        `Preserved the explicit ${basis === "task-pin" ? "task" : "role"} model pin.`,
      );
    else if (nativeFallback)
      reasons.unshift(`Used the ${model?.isDefault ? "explicit native default" : "only offered native model"} after no reviewed candidate remained. Native ordinary usage is allowed; no cost or quality rank was inferred.`);
    else
      reasons.unshift(
        `Saved ${project.preference} preference and ${input.complexity} complexity target the ${wanted} tier. This model is in the reviewed ${p.tier} tier.`,
      );
    const tierIndex = tiers.indexOf(p.tier as Exclude<Tier, "unknown">);
    const targetIndex = tiers.indexOf(wanted);
    if (!pinned && !nativeFallback && tierIndex !== targetIndex)
      warnings.push(
        `No exact target is selected here; this is the nearest available reviewed tier (${p.tier}).`,
      );
    const choice: WorkerChoice = {
      ...(source.device ? { device: source.device } : {}),
      catalogCheckedAt: source.catalog.checkedAt,
      harness: catalog.harness,
      model:
        !pinned && catalog.harness === "claude"
          ? model?.resolvedModel || id
          : id,
      ...(role ? { roleId: role.id } : {}),
      basis,
      tier: p.tier,
      reasons: reasons.slice(0, 4),
      warnings: warnings.slice(0, 6),
    };
    candidates.push({
      choice,
      distance: p.tier === "unknown" ? 99 : Math.abs(tierIndex - targetIndex),
      allowed: q.allowed,
      exhausted: q.exhausted,
      order: p.order,
      benchmarkModel: catalog.harness === "claude" ? model?.resolvedModel || id : id,
    });
  };
  const allowedHarnesses: Harness[] = harness ? [harness] : ["codex", "claude"];
  const eligibleSources = sourcesInput.filter(source => !role || (role.peerId ? source.device?.peerId === role.peerId : !source.device?.peerId));
  if (role && !eligibleSources.length) advice.reasons.push("Pinned role device is unavailable. No replacement was selected.");
  for (const source of eligibleSources) {
  const {catalog: snapshot, installed} = source;
  for (const h of allowedHarnesses) {
    if (!installed[h]) {
      const message = `${h} worker is not installed or available.`;
      if (pin)
        advice.reasons.push(
          `Pinned ${h} model ${pin}: ${message} No replacement was selected.`,
        );
      else warn(message);
      continue;
    }
    const catalog = snapshot.harnesses.find((c): c is WorkerCatalog => c.harness === h);
    if (!catalog) {
      if (pin)
        advice.reasons.push(
          `Pinned ${h} model ${pin}: native catalog evidence is unavailable. No replacement was selected.`,
        );
      else warn(`${h}: native catalog evidence is unavailable.`);
      continue;
    }
    if (h === "claude" && catalog.auth?.status === "sign_in_required") {
      const message = "Claude Code worker sign-in is required in its native CLI.";
      if (pin) advice.reasons.push(`Pinned ${h} model ${pin}: ${message} No replacement was selected.`);
      else warn(message);
      continue;
    }
    if (h === "claude" && catalog.auth?.status === "unknown")
      warn("Claude Code worker sign-in could not be checked.");
    if (catalog.modelsTruncated)
      warn(`${h}: the native catalog was shortened and may omit choices.`);
    if (pin)
      evaluate(
        catalog,
        catalog.models.find((m) => m.id === pin || m.resolvedModel === pin),
        pin,
        true,
        source,
      );
    else if (catalog.modelsStatus === "available") {
      for (const model of catalog.models)
        evaluate(catalog, model, model.id, false, source);
    } else warn(`${h}: native models could not be read.`);
  }
  }
  // Unranked native choices need positive allowance evidence; never infer a paid-provider fallback.
  const fallbackHarnesses: Harness[] = harness ? [harness].filter(h => h === "muse" || h === "opencode") : ["muse", "opencode"];
  if (!pin && candidates.length === 0) {
    for (const source of eligibleSources) for (const h of fallbackHarnesses) {
      if (!source.installed[h]) continue;
      const catalog = source.catalog.harnesses.find((c): c is WorkerCatalog => c.harness === h);
      const checked = Date.parse(source.catalog.checkedAt);
      if (!catalog || catalog.modelsStatus !== "available" || catalog.modelsTruncated || catalog.auth?.status === "sign_in_required" ||
          !Number.isFinite(checked) || checked > now || now - checked > 5 * 60_000 || input.complexity === "hard" || project.preference === "best") continue;
      const defaults = catalog.models.filter(model => model.isDefault);
      const model = defaults.length === 1 ? defaults[0] : defaults.length === 0 && catalog.models.length === 1 ? catalog.models[0] : undefined;
      if (!model || /contributor/i.test(model.id)) continue;
      const q = quota(catalog, model, model.id, now, source.catalog.checkedAt);
      if (!q.allowed || q.blocked || q.exhausted) continue;
      evaluate(catalog, model, model.id, false, source, true);
    }
    if (candidates.length === 0 && eligibleSources.some(source => fallbackHarnesses.some(h => source.installed[h]))) {
      advice.reasons.unshift("Automatic selection cannot safely rank this native setup. Choose Muse or OpenCode explicitly, review its native model, and turn off Choose model automatically to use its native default. For images, choose a model with confirmed image input. Native access and billing still need checking.");
    }
  }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      Number(a.exhausted) - Number(b.exhausted) ||
      Number(b.allowed) - Number(a.allowed) ||
      a.order - b.order ||
      a.choice.harness.localeCompare(b.choice.harness) ||
      a.choice.model.localeCompare(b.choice.model) ||
      Number(Boolean(a.choice.device?.peerId)) - Number(Boolean(b.choice.device?.peerId)),
  );
  // Native aliases can resolve to the same model; rank that identity once.
  candidates.splice(0, candidates.length, ...candidates.filter((c, i) => candidates.findIndex(other => other.choice.device?.id === c.choice.device?.id && other.choice.device?.peerId === c.choice.device?.peerId && other.choice.harness === c.choice.harness && other.choice.model === c.choice.model) === i));
  // Compare whole groups only: mixing scored and unknown pairs breaks sort consistency.
  if (!pin && benchmarks && benchmarksFresh(benchmarks, now)) {
    for (let start = 0; start < candidates.length;) {
      let end = start + 1;
      while (end < candidates.length && candidates[end].distance === candidates[start].distance && candidates[end].allowed === candidates[start].allowed && candidates[end].exhausted === candidates[start].exhausted) end++;
      const group = candidates.slice(start, end);
      const evidence = group.map(c => c.choice.harness === "muse" || c.choice.harness === "opencode" ? undefined : evidenceForModel(benchmarks, c.choice.harness, c.benchmarkModel, input.taskType));
      if (group.length > 1 && evidence.every(e => e !== undefined)) {
        group.forEach((c, i) => { c.choice.benchmark = evidence[i]; });
        group.sort((a, b) => b.choice.benchmark!.score - a.choice.benchmark!.score);
        candidates.splice(start, group.length, ...group);
      }
      start = end;
    }
  }
  const unique = candidates;
  advice.choice = unique[0]?.choice || null;
  if (advice.choice?.catalogCheckedAt) advice.catalogCheckedAt = advice.choice.catalogCheckedAt;
  if (advice.choice?.benchmark) {
    advice.benchmarkMethod = "reference-tie-break";
    advice.reasons.push(`Fresh LiveBench ${advice.choice.benchmark.metric} reference scores break this equal policy fit after native included usage priority.`);

  } else if (advice.choice?.tier === "unknown" && !pin) {
    advice.reasons.push("No reviewed candidate remained. The native fallback is unranked; preference, capability and cost comparisons are unknown.");
  } else if (advice.choice && !pin) {
    advice.reasons.push("Policy order is used: no comparable tie needs ranking, or the group lacks fresh, exact LiveBench scores for every candidate.");
  }
  // Report exact references even when they did not affect policy ordering or a pin.
  if (benchmarks) unique.forEach(c => { if (c.choice.harness !== "muse" && c.choice.harness !== "opencode") c.choice.benchmark ??= evidenceForModel(benchmarks, c.choice.harness, c.benchmarkModel, input.taskType); });
  if (advice.choice?.benchmark) {
    advice.warnings = [benchmarkNotice, ...advice.warnings.filter(w => w !== benchmarkNotice)].slice(0, 8);
    advice.sources.push(advice.choice.benchmark.sourceUrl);
    if (!benchmarksFresh(benchmarks!, now)) warn("LiveBench reference data is older than seven days or has a future check time; it was excluded from routing.");
  }
  advice.alternatives = pin ? [] : unique.slice(1, 4).map((c) => c.choice);
  advice.reasons.push(
    advice.choice
      ? pin
        ? "Advice preserves the model pin. Starting a worker still needs an explicit task_start call."
        : advice.choice.tier === "unknown"
          ? "Selected a fresh native default or only offered model with positive ordinary usage evidence. No reviewed quality or cost ranking was assigned."
        : advice.benchmarkMethod === "reference-tie-break"
          ? "Choices prefer the target tier, then the nearest reviewed tier; equal fits prefer known native included usage, then fresh comparable LiveBench reference scores."
          : "Choices prefer the target tier, then the nearest reviewed tier; equal fits prefer known native included usage, then the reviewed policy order."
      : "No supported choice has enough evidence for this request. Inspect native settings or change the request explicitly.",
  );
  return advice;
}


/** Recheck one selected native candidate; never rank replacements on its owner. */
export function selectedWorkerEligibility(choice: Pick<WorkerChoice,"harness"|"model">, source: RecommendationSource, requiresImages: boolean, now = Date.now(), basis: WorkerChoice["basis"] = "policy"): {eligible:boolean;reason?:string} {
  if (!source.installed[choice.harness]) return {eligible:false,reason:"Selected native worker is unavailable."};
  const catalog = source.catalog.harnesses.find(c => c.harness === choice.harness);
  const model = catalog?.models.find(m => m.id === choice.model || m.resolvedModel === choice.model);
  if (!catalog || catalog.modelsStatus !== "available" || !model) return {eligible:false,reason:"Selected exact model is absent from the current native catalog."};
  if (catalog.auth?.status === "sign_in_required") return {eligible:false,reason:"Selected worker requires native sign-in."};
  if (requiresImages && !model.inputModalities?.includes("image")) return {eligible:false,reason:"Selected native model image support is unavailable."};
  const q = quota(catalog,model,choice.model,now,source.catalog.checkedAt);
  if (basis === "policy" && (choice.harness === "muse" || choice.harness === "opencode")) {
    const checked = Date.parse(source.catalog.checkedAt);
    if (!q.allowed || catalog.modelsTruncated || !Number.isFinite(checked) || checked > now || now - checked > 5 * 60_000)
      return { eligible: false, reason: "Unranked automatic choice needs a fresh native catalog and positive ordinary usage evidence. Choose the harness and model explicitly instead." };
  }
  if (q.blocked || (q.exhausted && basis === "policy")) return {eligible:false,reason:"Selected native usage is blocked or its applicable fresh window is exhausted."};
  return {eligible:true};
}
