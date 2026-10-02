import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Preference, Project, RoutingPreset, RoutingRules } from "./contracts.ts";

const tier = z.enum(["efficient", "balanced", "capable"]);
export const routingRulesSchema = z.object({
  routine: tier,
  standard: tier,
  hard: tier,
  adjustToAllowance: z.boolean(),
  lowAllowancePercent: z.number().finite().min(0).max(100),
  highAllowancePercent: z.number().finite().min(0).max(100),
}).strict().refine(rules => rules.lowAllowancePercent < rules.highAllowancePercent,
  "Low allowance must be less than high allowance.");
export const routingPresetInput = z.object({
  name: z.string().trim().min(1).max(80).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), "Preset name must use plain text."),
  rules: routingRulesSchema,
}).strict();
const customPresetSchema = routingPresetInput.extend({ id: z.uuid() });
const customPresetsSchema = z.array(customPresetSchema).max(50)
  .refine(presets => new Set(presets.map(preset => preset.id)).size === presets.length);

export const builtInRoutingPresets: RoutingPreset[] = [
  { id: "economical", name: "Economical", rules: { routine: "efficient", standard: "efficient", hard: "balanced", adjustToAllowance: false, lowAllowancePercent: 20, highAllowancePercent: 50 } },
  { id: "balanced", name: "Balanced", rules: { routine: "efficient", standard: "balanced", hard: "capable", adjustToAllowance: true, lowAllowancePercent: 20, highAllowancePercent: 50 } },
  { id: "best", name: "Best", rules: { routine: "capable", standard: "capable", hard: "capable", adjustToAllowance: false, lowAllowancePercent: 20, highAllowancePercent: 50 } },
];

export function projectRoutingRules(project: Project): RoutingRules {
  return project.routingPreset?.rules ?? builtInRoutingPresets.find(preset => preset.id === project.preference)!.rules;
}
export function presetPreference(preset: RoutingPreset): Preference {
  return builtInRoutingPresets.some(builtin => builtin.id === preset.id) ? preset.id as Preference : "balanced";
}
export class RoutingPresetError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Projects save a copy; editing this registry never changes an applied preset. */
export class RoutingPresets {
  constructor(private db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS routing_presets(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
  }
  private custom(): RoutingPreset[] {
    const row = this.db.prepare("SELECT data FROM routing_presets WHERE id=1").get();
    return row ? customPresetsSchema.parse(JSON.parse(row.data as string)) : [];
  }
  list(): RoutingPreset[] { return structuredClone([...builtInRoutingPresets, ...this.custom()]); }
  get(id: string): RoutingPreset {
    const preset = this.list().find(preset => preset.id === id);
    if (!preset) throw new RoutingPresetError("Routing preset not found.", 404);
    return preset;
  }
  save(input: unknown, id?: string): RoutingPreset {
    const parsed = routingPresetInput.safeParse(input);
    if (!parsed.success) throw new RoutingPresetError(parsed.error.issues[0]?.message || "Invalid routing preset.");
    if (id && builtInRoutingPresets.some(preset => preset.id === id)) throw new RoutingPresetError("Built-in routing presets are read only. Save a custom copy.", 403);
    const presets = this.custom();
    const index = id ? presets.findIndex(preset => preset.id === id) : -1;
    if (id && index < 0) throw new RoutingPresetError("Routing preset not found.", 404);
    if (!id && presets.length >= 50) throw new RoutingPresetError("At most 50 custom routing presets can be saved.", 409);
    const preset = { id: id ?? randomUUID(), ...parsed.data };
    if (index < 0) presets.push(preset); else presets[index] = preset;
    this.db.prepare("INSERT INTO routing_presets(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(presets));
    return preset;
  }
}
