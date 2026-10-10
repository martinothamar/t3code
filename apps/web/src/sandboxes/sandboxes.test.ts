import type { AgentctlSandbox } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxStatus, suggestSandboxName } from "./sandboxActions";
import { sandboxNameForTarget, sandboxRegistrations } from "./sandboxConnections";
import { sandboxPickerItems } from "./useSandboxPicker";

function sandbox(overrides: Partial<AgentctlSandbox> = {}): AgentctlSandbox {
  return {
    name: "worker",
    phase: "ready",
    detail: null,
    sshAccess: true,
    sshAlias: "agentctl-worker",
    sshTarget: null,
    environmentId: "env-worker",
    connectError: null,
    action: null,
    actionError: null,
    manifestPath: null,
    variant: null,
    ...overrides,
  };
}

describe("sandboxRegistrations", () => {
  it("registers every Sandbox T3 has reached, running or not", () => {
    const registrations = sandboxRegistrations([
      sandbox(),
      sandbox({ name: "stopped", phase: "stopped", environmentId: "env-stopped" }),
      sandbox({ name: "new", environmentId: null }),
      sandbox({ name: "no-ssh", sshAccess: false }),
    ]);
    expect(registrations.map((registration) => registration.target.label)).toEqual([
      "worker",
      "stopped",
    ]);
    expect(sandboxNameForTarget(registrations[0]!.target)).toBe("worker");
  });

  it("connects with the target resolved on first contact", () => {
    const target = {
      alias: "agentctl-worker",
      hostname: "agentctl-worker",
      username: "agent",
      port: 22,
    };
    const [registration] = sandboxRegistrations([sandbox({ sshTarget: target })]);
    expect(registration?.profile.target).toEqual(target);
  });
});

describe("sandboxPickerItems", () => {
  it("offers Sandboxes that do not hold the draft's project yet", () => {
    const items = sandboxPickerItems(
      [
        sandbox({ name: "here", environmentId: "env-here" }),
        sandbox({ name: "stopped", phase: "stopped" }),
        sandbox({ name: "elsewhere", environmentId: "env-elsewhere" }),
        sandbox({ name: "booting", phase: "provisioning", environmentId: null }),
        sandbox({ name: "going", phase: "terminating" }),
      ],
      new Set(["env-here"]),
    );
    expect(items.map(({ label, status, disabled }) => ({ label, status, disabled }))).toEqual([
      { label: "stopped", status: "Start", disabled: false },
      { label: "elsewhere", status: "Project not found", disabled: true },
      { label: "booting", status: "Provisioning…", disabled: true },
    ]);
  });
});

describe("sandboxStatus", () => {
  it("does not call a Sandbox running before T3 can reach it", () => {
    expect(sandboxStatus(sandbox({ environmentId: null })).label).toBe("Connecting…");
    expect(sandboxStatus(sandbox({ connectError: "no route" })).label).toBe("Cannot connect");
    expect(sandboxStatus(sandbox()).label).toBe("Running");
  });

  it("shows T3's own pending request first", () => {
    expect(sandboxStatus(sandbox({ phase: "stopped", action: "starting" })).label).toBe(
      "Starting…",
    );
  });
});

describe("suggestSandboxName", () => {
  it("numbers the manifest's name past the ones in use", () => {
    const existing = [sandbox({ name: "worker" }), sandbox({ name: "worker-2" })];
    expect(suggestSandboxName("worker", existing)).toBe("worker-3");
    expect(suggestSandboxName(null, [])).toBe("sandbox");
  });
});
