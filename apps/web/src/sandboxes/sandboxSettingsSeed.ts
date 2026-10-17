import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

const MODEL_SELECTION_KEYS = [
  "defaultModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
] as const satisfies ReadonlyArray<ProjectScopedServerSettingKey>;

/**
 * The preferences a new Sandbox should start with: each project-scoped key the
 * user changed on this computer while the Sandbox still has the default.
 * A Sandbox's own choices are never overwritten. Model selections are only
 * copied when the Sandbox has that provider instance; without its provider
 * list (`sandboxProviderInstanceIds` null) they are skipped.
 */
export function sandboxSettingsSeedPatch(input: {
  readonly local: ServerSettings;
  readonly sandbox: ServerSettings;
  readonly sandboxProviderInstanceIds: ReadonlySet<string> | null;
}): ServerSettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    const value = input.local[key];
    if (Equal.equals(value, DEFAULT_SERVER_SETTINGS[key])) continue;
    if (!Equal.equals(input.sandbox[key], DEFAULT_SERVER_SETTINGS[key])) continue;
    if ((MODEL_SELECTION_KEYS as ReadonlyArray<string>).includes(key)) {
      const selection = input.local[key as (typeof MODEL_SELECTION_KEYS)[number]];
      if (
        selection !== null &&
        !input.sandboxProviderInstanceIds?.has(String(selection.instanceId))
      ) {
        continue;
      }
    }
    patch[key] = value;
  }
  return patch as ServerSettingsPatch;
}
