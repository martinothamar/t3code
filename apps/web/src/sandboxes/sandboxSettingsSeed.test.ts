import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxSettingsSeedPatch } from "./sandboxSettingsSeed";

const settings = (overrides: Partial<ServerSettings>): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...overrides,
});
const providers = new Set(["codex"]);
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
const other = { instanceId: ProviderInstanceId.make("elsewhere"), model: "gpt-test" };

describe("sandboxSettingsSeedPatch", () => {
  it("copies preferences the user changed locally", () => {
    const patch = sandboxSettingsSeedPatch({
      local: settings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
        defaultProjectScripts: [],
        branchNamePrefix: "me/",
      }),
      sandbox: settings({}),
      sandboxProviderInstanceIds: providers,
    });
    expect(patch).toEqual({
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnMerge: false,
      branchNamePrefix: "me/",
    });
  });

  it("never touches a value the Sandbox already changed", () => {
    const patch = sandboxSettingsSeedPatch({
      local: settings({ branchNamePrefix: "me/", sidebarAutoSettleAfterDays: null }),
      sandbox: settings({ branchNamePrefix: "sandbox/" }),
      sandboxProviderInstanceIds: providers,
    });
    expect(patch).toEqual({ sidebarAutoSettleAfterDays: null });
  });

  it("leaves out keys outside the project-scoped list", () => {
    const patch = sandboxSettingsSeedPatch({
      local: settings({ enableDeviceSupport: true, deviceOnboardingCompleted: true }),
      sandbox: settings({}),
      sandboxProviderInstanceIds: providers,
    });
    expect(patch).toEqual({});
  });

  it("compares structurally, so equal objects produce an empty patch", () => {
    const local = settings({
      defaultProjectScripts: structuredClone(DEFAULT_SERVER_SETTINGS.defaultProjectScripts),
      sourceControlWritingStyle: structuredClone(DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle),
    });
    expect(
      sandboxSettingsSeedPatch({
        local,
        sandbox: settings({}),
        sandboxProviderInstanceIds: providers,
      }),
    ).toEqual({});
  });

  it("copies a model selection only for a provider instance the Sandbox has", () => {
    const patch = (selection: typeof codex, ids: ReadonlySet<string> | null) =>
      sandboxSettingsSeedPatch({
        local: settings({ defaultModelSelection: selection }),
        sandbox: settings({}),
        sandboxProviderInstanceIds: ids,
      });
    expect(patch(codex, providers)).toEqual({ defaultModelSelection: codex });
    expect(patch(other, providers)).toEqual({});
    expect(patch(codex, null)).toEqual({});
  });
});
