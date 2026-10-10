import { EnvironmentId, type AgentctlSandbox } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canDeleteSandbox,
  canStopSandbox,
  sandboxStatus,
  suggestSandboxName,
} from "./sandboxActions";
import { sandboxNameForTarget, sandboxRegistrations } from "./sandboxConnections";
import { ensureSandboxProject, queueSandboxProject } from "./sandboxProjects";

function sandbox(overrides: Partial<AgentctlSandbox> = {}): AgentctlSandbox {
  return {
    name: "worker",
    phase: "ready",
    detail: null,
    sshAccess: true,
    sshAlias: "agentctl-worker",
    sshTarget: null,
    environmentId: EnvironmentId.make("env-worker"),
    projectCreated: false,
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

describe("ensureSandboxProject", () => {
  const environmentId = EnvironmentId.make("env-worker");

  function dependencies(options: { readonly existing?: boolean; readonly createError?: string }) {
    const calls: string[] = [];
    return {
      calls,
      dependencies: {
        workingDirectory: async () => {
          calls.push("ssh-info");
          return "/home/agent/code";
        },
        hasProjectAt: () => options.existing === true,
        createProject: async (input: {
          readonly title: string;
          readonly workspaceRoot: string;
        }) => {
          calls.push(`create ${input.title} at ${input.workspaceRoot}`);
          return options.createError ?? null;
        },
        markCreated: async () => {
          calls.push("mark");
        },
      },
    };
  }

  it("makes one project at the working directory, named after the Agent", async () => {
    const { calls, dependencies: deps } = dependencies({});
    const result = await ensureSandboxProject(deps, {
      name: "worker",
      environmentId,
      projectCreated: false,
      force: false,
    });
    expect(result).toEqual({ created: true, error: null });
    expect(calls).toEqual(["ssh-info", "create worker at /home/agent/code", "mark"]);
  });

  it("leaves a removed project removed without asking agentctl", async () => {
    const { calls, dependencies: deps } = dependencies({});
    await ensureSandboxProject(deps, {
      name: "worker",
      environmentId,
      projectCreated: true,
      force: false,
    });
    expect(calls).toEqual([]);
  });

  it("makes it again on request, and adopts one that already exists", async () => {
    const forced = dependencies({});
    await ensureSandboxProject(forced.dependencies, {
      name: "worker",
      environmentId,
      projectCreated: true,
      force: true,
    });
    expect(forced.calls).toContain("create worker at /home/agent/code");

    const existing = dependencies({ existing: true });
    const result = await ensureSandboxProject(existing.dependencies, {
      name: "worker",
      environmentId,
      projectCreated: false,
      force: false,
    });
    expect(result.created).toBe(false);
    expect(existing.calls).toEqual(["ssh-info", "mark"]);
  });

  it("does not record a project that failed to be made", async () => {
    const { calls, dependencies: deps } = dependencies({ createError: "no such directory" });
    const result = await ensureSandboxProject(deps, {
      name: "worker",
      environmentId,
      projectCreated: false,
      force: false,
    });
    expect(result).toEqual({ created: false, error: "no such directory" });
    expect(calls).not.toContain("mark");
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

describe("queueSandboxProject", () => {
  const environmentId = EnvironmentId.make("env-worker");

  function deferred() {
    let resolve!: (result: { created: boolean; error: string | null }) => void;
    const promise = new Promise<{ created: boolean; error: string | null }>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("lets a reconnect join the attempt already running", async () => {
    const inFlight = new Map();
    const automatic = deferred();
    const first = queueSandboxProject(inFlight, environmentId, false, () => automatic.promise);
    let started = 0;
    const second = queueSandboxProject(inFlight, environmentId, false, async () => {
      started += 1;
      return { created: true, error: null };
    });
    automatic.resolve({ created: false, error: null });
    expect(await second).toEqual(await first);
    expect(started).toBe(0);
  });

  it("runs a click after the automatic attempt, unless that one made the project", async () => {
    const order: string[] = [];
    const inFlight = new Map();
    const automatic = deferred();
    void queueSandboxProject(inFlight, environmentId, false, () => automatic.promise);
    const click = queueSandboxProject(inFlight, environmentId, true, async () => {
      order.push("click");
      return { created: true, error: null };
    });
    order.push("automatic done");
    automatic.resolve({ created: false, error: null });
    expect(await click).toEqual({ created: true, error: null });
    expect(order).toEqual(["automatic done", "click"]);

    const madeIt = deferred();
    void queueSandboxProject(inFlight, environmentId, false, () => madeIt.promise);
    let clicked = false;
    const second = queueSandboxProject(inFlight, environmentId, true, async () => {
      clicked = true;
      return { created: false, error: "duplicate" };
    });
    madeIt.resolve({ created: true, error: null });
    expect(await second).toEqual({ created: true, error: null });
    expect(clicked).toBe(false);
  });
});
