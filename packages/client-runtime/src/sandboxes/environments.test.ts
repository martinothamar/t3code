import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type AgentctlSandbox } from "@t3tools/contracts";

import { BearerConnectionTarget, SshConnectionTarget } from "../connection/model.ts";
import {
  sandboxConnectionId,
  sandboxForTarget,
  sandboxRegistration,
  sandboxRoute,
} from "./environments.ts";

const HOST = EnvironmentId.make("host-env");
const SANDBOX = EnvironmentId.make("sandbox-env");

const sandbox: AgentctlSandbox & { readonly environmentId: EnvironmentId } = {
  name: "worker-1",
  phase: "ready",
  detail: null,
  since: null,
  cpu: null,
  memory: null,
  disk: null,
  network: null,
  sshAccess: true,
  sshTarget: null,
  environmentId: SANDBOX,
  settingsSeeded: false,
  harnesses: [],
  workingDirectory: "/home/agent/code",
  connectError: null,
  action: null,
  actionError: null,
  manifestPath: null,
  variant: null,
};

describe("Sandbox environments", () => {
  it("reaches a Sandbox below its host's address, however the client reaches the host", () => {
    expect(sandboxRoute("http://100.64.0.7:3773/", "worker-1")).toEqual({
      httpBaseUrl: "http://100.64.0.7:3773/sandbox/worker-1/",
      wsBaseUrl: "ws://100.64.0.7:3773/sandbox/worker-1/",
    });
    expect(sandboxRoute("https://machine.tailnet.ts.net/", "worker-1").wsBaseUrl).toBe(
      "wss://machine.tailnet.ts.net/sandbox/worker-1/",
    );
  });

  it("registers a Sandbox as a bearer environment that names its host", () => {
    const registration = sandboxRegistration({
      hostEnvironmentId: HOST,
      hostHttpBaseUrl: "http://192.168.1.20:3773/",
      sandbox,
      token: "sandbox-token",
    });
    expect(registration.target.environmentId).toBe(SANDBOX);
    expect(registration.target.label).toBe("worker-1");
    expect(registration.profile.httpBaseUrl).toBe("http://192.168.1.20:3773/sandbox/worker-1/");
    expect(registration.credential.token).toBe("sandbox-token");
    expect(sandboxForTarget(registration.target)).toEqual({
      hostEnvironmentId: HOST,
      name: "worker-1",
    });
  });

  it("does not take other environments for Sandboxes", () => {
    expect(
      sandboxForTarget(
        new BearerConnectionTarget({
          environmentId: SANDBOX,
          label: "laptop",
          connectionId: "bearer:sandbox-env:http://192.168.1.20:3773",
        }),
      ),
    ).toBeNull();
    expect(
      sandboxForTarget(
        new SshConnectionTarget({
          environmentId: SANDBOX,
          label: "worker-1",
          connectionId: sandboxConnectionId(HOST, "worker-1", SANDBOX),
        }),
      ),
    ).toBeNull();
  });

  it("gives a recreated Sandbox a connection of its own", () => {
    expect(sandboxConnectionId(HOST, "worker-1", SANDBOX)).not.toBe(
      sandboxConnectionId(HOST, "worker-1", EnvironmentId.make("recreated")),
    );
  });
});
