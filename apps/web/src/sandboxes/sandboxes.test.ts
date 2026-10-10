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
    since: null,
    cpu: null,
    memory: null,
    disk: null,
    network: null,
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

  function dependencies(options: {
    readonly existing?: boolean;
    readonly createError?: string;
    /** Another window made the project meanwhile, so this create fails. */
    readonly madeElsewhere?: boolean;
  }) {
    let exists = options.existing === true;
    const created: string[] = [];
    return {
      created,
      dependencies: {
        hasProjectAt: () => exists,
        createProject: async (project: {
          readonly title: string;
          readonly workspaceRoot: string;
        }) => {
          created.push(`${project.title} at ${project.workspaceRoot}`);
          if (options.madeElsewhere) exists = true;
          return options.createError ?? null;
        },
      },
    };
  }

  it("makes one project at the working directory, named after the Agent", async () => {
    const deps = dependencies({});
    expect(await ensureSandboxProject(deps.dependencies, input)).toBeNull();
    expect(deps.created).toEqual(["worker at /home/agent/code"]);
  });

  it("leaves an existing project alone", async () => {
    const deps = dependencies({ existing: true });
    expect(await ensureSandboxProject(deps.dependencies, input)).toBeNull();
    expect(deps.created).toEqual([]);
  });

  it("succeeds when another window made the project first", async () => {
    const deps = dependencies({ createError: "workspace in use", madeElsewhere: true });
    expect(await ensureSandboxProject(deps.dependencies, input)).toBeNull();
  });

  it("reports a create that failed for another reason", async () => {
    const deps = dependencies({ createError: "no such directory" });
    expect(await ensureSandboxProject(deps.dependencies, input)).toBe("no such directory");
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
