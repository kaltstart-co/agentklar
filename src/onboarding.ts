import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { OnboardingPreferences } from "./contracts.ts";

export const setupHarness = z.enum(["codex", "claude", "muse", "opencode", "antigravity"]);
export const onboardingPreferencesInput = z.object({
  projectId: z.uuid(),
  mainHarness: setupHarness.nullable(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
export const onboardingSetupInput = z.discriminatedUnion("operation", [
  z.object({ projectId: z.uuid(), harness: setupHarness, operation: z.literal("status") }).strict(),
  z.object({ projectId: z.uuid(), harness: setupHarness, operation: z.literal("preview") }).strict(),
  z.object({ projectId: z.uuid(), harness: setupHarness, operation: z.literal("apply"), previewId: z.uuid() }).strict(),
  z.object({ projectId: z.uuid(), harness: setupHarness, operation: z.literal("undo"), changeId: z.uuid() }).strict(),
]);
export const onboardingProjectInput = z.object({
  name: z.string().trim().min(1).max(120), path: z.string().min(1).max(4096),
}).strict();

export class Onboarding {
  constructor(private db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS onboarding_preferences(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO onboarding_preferences VALUES(1,0,?)").run(JSON.stringify({
      revision: 0, projectId: null, mainHarness: null, updatedAt: null,
    } satisfies OnboardingPreferences));
  }
  read(): OnboardingPreferences {
    return JSON.parse(this.db.prepare("SELECT data FROM onboarding_preferences WHERE id=1").get()!.data as string);
  }
  save(input: z.infer<typeof onboardingPreferencesInput>): OnboardingPreferences | null {
    const preferences: OnboardingPreferences = {
      revision: input.expectedRevision + 1, projectId: input.projectId,
      mainHarness: input.mainHarness, updatedAt: new Date().toISOString(),
    };
    return this.db.prepare("UPDATE onboarding_preferences SET revision=?,data=? WHERE id=1 AND revision=?")
      .run(preferences.revision, JSON.stringify(preferences), input.expectedRevision).changes === 1 ? preferences : null;
  }
}
