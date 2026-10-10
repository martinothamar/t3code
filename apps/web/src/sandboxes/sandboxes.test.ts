import { EnvironmentId, type AgentctlSandbox } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canDeleteSandbox,
  canStopSandbox,
  sandboxStatus,
  suggestSandboxName,
} from "./sandboxActions";
import { sandboxNameForTarget, sandboxRegistrations } from "./sandboxConnections";
import { ensureSandboxProject } from "./sandboxProjects";

function sandbox(overrides: Partial<AgentctlSandbox> = {}): AgentctlSandbox {
  return {
    name: "worker",
    phase: "ready",
    detail: null,
    sshAccess: true,
    sshTarget: { alias: "agentctl-worker", hostname: "worker", username: "agent", port: 22 },
    environmentId: EnvironmentId.make("env-worker"),
    workingDirectory: "/home/agent/code",
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
      sandbox({
        name: "stopped",
        phase: "stopped",
        environmentId: EnvironmentId.make("env-stopped"),
      }),
      sandbox({ name: "new", environmentId: null, sshTarget: null }),
      sandbox({ name: "no-ssh", sshAccess: false }),
    ]);
    expect(registrations.map((registration) => registration.target.label)).toEqual([
      "worker",
      "stopped",
    ]);
    expect(sandboxNameForTarget(registrations[0]!.target)).toBe("worker");
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
  const named = (...names: string[]) => names.map((name) => sandbox({ name }));

  it("numbers a new Sandbox one past the highest in use", () => {
    expect(suggestSandboxName("worker", [])).toBe("worker-1");
    expect(suggestSandboxName("worker", named("worker-1", "worker-3", "other-9"))).toBe("worker-4");
    expect(suggestSandboxName("worker", named("worker"))).toBe("worker-1");
    expect(suggestSandboxName(null, [])).toBe("sandbox-1");
  });

  it("only increments a manifest name that already ends in a number", () => {
    expect(suggestSandboxName("worker-2", [])).toBe("worker-2");
    expect(suggestSandboxName("worker-2", named("worker-2"))).toBe("worker-3");
    expect(suggestSandboxName("worker-2", named("worker-5"))).toBe("worker-6");
  });

  it("treats the name literally", () => {
    expect(suggestSandboxName("a.b", named("axb-4"))).toBe("a.b-1");
  });
});

describe("ensureSandboxProject", () => {
  const environmentId = EnvironmentId.make("env-worker");
  const input = { name: "worker", environmentId, workingDirectory: "/home/agent/code" };

  function dependencies(options: { readonly existing?: boolean; readonly createError?: string }) {
    const created: string[] = [];
    let finish: (error: string | null) => void = () => {};
    return {
      created,
      finish: (error: string | null) => finish(error),
      dependencies: {
        hasProjectAt: () => options.existing === true,
        createProject: (project: { readonly title: string; readonly workspaceRoot: string }) => {
          created.push(`${project.title} at ${project.workspaceRoot}`);
          return new Promise<string | null>((resolve) => {
            finish = resolve;
          });
        },
      },
    };
  }

  it("makes one project at the working directory, named after the Agent", async () => {
    const deps = dependencies({});
    const first = ensureSandboxProject(new Map(), deps.dependencies, input);
    deps.finish(null);
    expect(await first).toBeNull();
    expect(deps.created).toEqual(["worker at /home/agent/code"]);
  });

  it("leaves an existing project alone", async () => {
    const deps = dependencies({ existing: true });
    expect(await ensureSandboxProject(new Map(), deps.dependencies, input)).toBeNull();
    expect(deps.created).toEqual([]);
  });

  it("joins an attempt that is still running instead of making a second project", async () => {
    const inFlight = new Map();
    const deps = dependencies({});
    const first = ensureSandboxProject(inFlight, deps.dependencies, input);
    const second = ensureSandboxProject(inFlight, deps.dependencies, input);
    deps.finish("no such directory");
    expect(await second).toBe("no such directory");
    expect(await first).toBe("no such directory");
    expect(deps.created).toHaveLength(1);
    expect(inFlight.size).toBe(0);
  });
});

describe("Sandbox actions", () => {
  it("keeps Stop and Delete within reach while a create is pending", () => {
    const creating = sandbox({ phase: "retrying", action: "creating" });
    expect(canStopSandbox(creating)).toBe(true);
    expect(canDeleteSandbox(creating)).toBe(true);
    expect(canDeleteSandbox(sandbox({ action: "deleting" }))).toBe(false);
    expect(canStopSandbox(sandbox({ phase: "stopped" }))).toBe(false);
  });
});
