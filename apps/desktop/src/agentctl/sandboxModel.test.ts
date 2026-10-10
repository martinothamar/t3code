import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AgentResource } from "./agentState.ts";
import { manifestFileNames } from "./manifests.ts";
import {
  discoveredRecord,
  isActionSettled,
  needsDiscovery,
  reconcileRecords,
  sandboxNameError,
  type SandboxRecord,
} from "./sandboxModel.ts";

function agent(
  name: string,
  options: { sandboxId?: string; deleting?: boolean; ready?: boolean; stopped?: boolean } = {},
): AgentResource {
  return {
    metadata: {
      name,
      ...(options.deleting ? { deletionTimestamp: "2026-10-10T00:00:00Z" } : {}),
    },
    spec: options.stopped ? { runState: "Stopped" } : {},
    status: {
      ...(options.sandboxId === undefined ? {} : { sandbox: { id: options.sandboxId } }),
      conditions: [
        options.stopped
          ? { type: "Ready", status: "False", reason: "Stopped" }
          : options.ready
            ? { type: "Ready", status: "True", reason: "SandboxReady" }
            : { type: "Ready", status: "False", reason: "ProviderSelected" },
      ],
    },
  };
}

const SSH_TARGET = { alias: "agentctl-worker", hostname: "worker", username: "agent", port: 22 };

const record = (sandboxId: string | null): SandboxRecord => ({
  sandboxId,
  environmentId: EnvironmentId.make("env-1"),
  sshTarget: SSH_TARGET,
  projectCreated: false,
});

describe("reconcileRecords", () => {
  it("keeps the environment of a Sandbox that is stopped", () => {
    const records = { worker: record("sandbox-1") };
    expect(
      reconcileRecords(records, [agent("worker", { sandboxId: "sandbox-1", stopped: true })]),
    ).toEqual(records);
  });

  it("forgets a Sandbox that was deleted or is being deleted", () => {
    const records = { gone: record("a"), deleting: record("b") };
    expect(
      reconcileRecords(records, [agent("deleting", { sandboxId: "b", deleting: true })]),
    ).toEqual({});
  });
});

describe("discovery", () => {
  it("rediscovers a Sandbox agentctl now reports under another sandbox id", () => {
    expect(needsDiscovery(undefined, agent("worker"))).toBe(true);
    expect(needsDiscovery(record("a"), agent("worker", { sandboxId: "a" }))).toBe(false);
    expect(needsDiscovery(record("a"), agent("worker", { sandboxId: "b" }))).toBe(true);
    expect(needsDiscovery(record("a"), agent("worker"))).toBe(false);
  });

  it("keeps the project state only for the same environment", () => {
    const previous = { ...record("a"), projectCreated: true };
    const sameEnvironment = {
      sandboxId: "b",
      environmentId: previous.environmentId,
      sshTarget: SSH_TARGET,
    };
    expect(discoveredRecord(previous, sameEnvironment).projectCreated).toBe(true);
    const newEnvironment = { ...sameEnvironment, environmentId: EnvironmentId.make("env-2") };
    expect(discoveredRecord(previous, newEnvironment).projectCreated).toBe(false);
  });
});

describe("isActionSettled", () => {
  it("waits for a created Sandbox to become Ready or fail", () => {
    expect(isActionSettled("creating", undefined)).toBe(false);
    expect(isActionSettled("creating", agent("worker"))).toBe(false);
    expect(isActionSettled("creating", agent("worker", { ready: true }))).toBe(true);
  });

  it("settles a request agentctl keeps retrying, so the Sandbox can be stopped or deleted", () => {
    const retrying: AgentResource = {
      metadata: { name: "worker", generation: 1 },
      spec: {},
      status: {
        observedGeneration: 1,
        failure: "transient",
        conditions: [{ type: "Ready", status: "False", reason: "SandboxReconcileFailed" }],
      },
    };
    expect(isActionSettled("creating", retrying)).toBe(true);
    expect(isActionSettled("starting", retrying)).toBe(true);
  });

  it("does not settle a start on the stopped state agentctl reports right after it", () => {
    expect(isActionSettled("starting", agent("worker", { stopped: true }))).toBe(false);
    expect(isActionSettled("starting", agent("worker", { ready: true }))).toBe(true);
  });

  it("waits for a deleted Sandbox to disappear", () => {
    expect(isActionSettled("deleting", agent("worker", { deleting: true }))).toBe(false);
    expect(isActionSettled("deleting", undefined)).toBe(true);
  });
});

describe("Sandbox names", () => {
  const existing = [agent("worker"), agent("worker-2")];

  it("rejects a name that would update an existing Sandbox", () => {
    expect(sandboxNameError("worker", existing)).toMatch(/already exists/);
    expect(sandboxNameError("Worker", existing)).toMatch(/lowercase/);
    expect(sandboxNameError("-worker", existing)).toMatch(/lowercase/);
    expect(sandboxNameError("worker-3", existing)).toBeNull();
  });
});

describe("manifestFileNames", () => {
  it("lists the base manifest first, then its variants", () => {
    expect(
      manifestFileNames([
        "README.md",
        "agent.nested.yaml",
        "agent.yaml",
        "agent.big.yaml",
        "Dockerfile",
      ]),
    ).toEqual(["agent.yaml", "agent.big.yaml", "agent.nested.yaml"]);
  });
});
