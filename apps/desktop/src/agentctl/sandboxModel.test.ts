import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AgentResource } from "./agentState.ts";
import { manifestFileNames } from "./manifests.ts";
import {
  isActionSettled,
  parseRepositoryList,
  reconcileRecords,
  sandboxNameError,
  suggestSandboxName,
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

const record = (sandboxId: string | null): SandboxRecord => ({
  sandboxId,
  environmentId: EnvironmentId.make("env-1"),
  sshTarget: null,
  seededRepositories: [],
});

describe("reconcileRecords", () => {
  it("keeps the environment of a Sandbox that is stopped", () => {
    const records = { worker: record("sandbox-1") };
    expect(
      reconcileRecords(records, [agent("worker", { sandboxId: "sandbox-1", stopped: true })]),
    ).toEqual(records);
  });

  it("forgets a Sandbox that was deleted, is being deleted, or was recreated", () => {
    const records = { gone: record("a"), deleting: record("b"), recreated: record("c") };
    const agents = [
      agent("deleting", { sandboxId: "b", deleting: true }),
      agent("recreated", { sandboxId: "c2" }),
    ];
    expect(reconcileRecords(records, agents)).toEqual({});
  });

  it("keeps a record while the Sandbox has no id to compare yet", () => {
    const records = { worker: record("sandbox-1") };
    expect(reconcileRecords(records, [agent("worker")])).toEqual(records);
  });
});

describe("isActionSettled", () => {
  it("waits for a created Sandbox to become Ready or fail", () => {
    expect(isActionSettled("creating", undefined)).toBe(false);
    expect(isActionSettled("creating", agent("worker"))).toBe(false);
    expect(isActionSettled("creating", agent("worker", { ready: true }))).toBe(true);
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

  it("suggests the manifest's name, numbered past the ones in use", () => {
    expect(suggestSandboxName("worker", existing)).toBe("worker-3");
    expect(suggestSandboxName("reviewer", existing)).toBe("reviewer");
    expect(suggestSandboxName(null, existing)).toBe("sandbox");
  });
});

describe("parseRepositoryList", () => {
  it("keeps absolute paths and drops anything else the shell printed", () => {
    expect(
      parseRepositoryList("/home/agent/code/app\n\nwarning: x\n/home/agent/code/lib\n"),
    ).toEqual(["/home/agent/code/app", "/home/agent/code/lib"]);
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
