import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type AgentctlSandboxesSnapshot,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { TestClock } from "effect/testing";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { SshLaunchError } from "@t3tools/ssh/errors";

import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as AgentctlCli from "./AgentctlCli.ts";
import type { AgentResource } from "./agentState.ts";
import * as DesktopAgentctlSandboxes from "./DesktopAgentctlSandboxes.ts";

const NAME = "worker";

function agent(phase: "ready" | "stopped" | "retrying"): AgentResource {
  const conditions =
    phase === "ready"
      ? [
          { type: "Ready", status: "True", reason: "SandboxReady" },
          { type: "SshReady", status: "True", reason: "ServerRunning" },
        ]
      : phase === "stopped"
        ? [{ type: "Ready", status: "False", reason: "Stopped" }]
        : [{ type: "Ready", status: "False", reason: "SandboxReconcileFailed" }];
  return {
    metadata: { name: NAME, generation: 1 },
    spec: { access: [{ type: "ssh" }], ...(phase === "stopped" ? { runState: "Stopped" } : {}) },
    status: {
      observedGeneration: 1,
      conditions,
      ...(phase === "retrying" ? { failure: "transient" } : {}),
    },
  };
}

interface Harness {
  readonly agents: Ref.Ref<ReadonlyArray<AgentResource>>;
  readonly listFails: Ref.Ref<boolean>;
  readonly ensured: Ref.Ref<number>;
  /** What the Sandbox's T3 server reports; plain, because fetch reads it. */
  readonly environment: { id: string };
  readonly disconnected: Deferred.Deferred<void>;
  /** The next SSH reach fails, like a Sandbox still booting. */
  readonly ensureFails: Ref.Ref<boolean>;
  /**
   * While set, each start hands its gate to `heldStarts`, then waits for it and
   * fails, like a start a stop cut short.
   */
  readonly holdStarts: Ref.Ref<boolean>;
  readonly heldStarts: Queue.Queue<Deferred.Deferred<void>>;
  readonly applyFails: Ref.Ref<boolean>;
}

const makeHarness = Effect.gen(function* () {
  return {
    agents: yield* Ref.make<ReadonlyArray<AgentResource>>([agent("ready")]),
    listFails: yield* Ref.make(false),
    ensured: yield* Ref.make(0),
    environment: { id: "env-1" },
    disconnected: yield* Deferred.make<void>(),
    ensureFails: yield* Ref.make(false),
    holdStarts: yield* Ref.make(false),
    heldStarts: yield* Queue.unbounded<Deferred.Deferred<void>>(),
    applyFails: yield* Ref.make(false),
  } satisfies Harness;
});

const environmentLayer = (baseDir: string) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

function layer(harness: Harness, baseDir: string) {
  const cli = AgentctlCli.AgentctlCli.of({
    listAgents: Ref.get(harness.listFails).pipe(
      Effect.flatMap((fails) =>
        fails
          ? Effect.fail(
              new AgentctlCli.AgentctlError({
                command: "get",
                reason: "failed",
                reported: "agentd is restarting",
              }),
            )
          : Ref.get(harness.agents),
      ),
    ),
    sshInfo: () => Effect.succeed({ workingDirectory: "/home/agent/code" }),
    start: () =>
      Ref.get(harness.holdStarts).pipe(
        Effect.flatMap((hold) =>
          hold
            ? Effect.gen(function* () {
                const gate = yield* Deferred.make<void>();
                yield* Queue.offer(harness.heldStarts, gate);
                yield* Deferred.await(gate);
                return yield* new AgentctlCli.AgentctlError({
                  command: "start",
                  reason: "failed",
                  reported: "Agent was stopped",
                });
              })
            : Ref.set(harness.agents, [agent("ready")]),
        ),
      ),
    stop: () => Ref.set(harness.agents, [agent("stopped")]),
    remove: () => Ref.set(harness.agents, []),
    apply: () =>
      Ref.get(harness.applyFails).pipe(
        Effect.flatMap((fails) =>
          fails
            ? Effect.fail(
                new AgentctlCli.AgentctlError({
                  command: "apply",
                  reason: "failed",
                  reported: "invalid manifest",
                }),
              )
            : Ref.set(harness.agents, [agent("retrying")]),
        ),
      ),
  });
  const target: DesktopSshEnvironmentTarget = {
    alias: `agentctl-${NAME}`,
    hostname: `agentctl-${NAME}`,
    username: "agent",
    port: 22,
  };
  const ssh = DesktopSshEnvironment.DesktopSshEnvironment.of({
    discoverHosts: () => Effect.succeed([]),
    resolveHost: () => Effect.succeed(target),
    ensureEnvironment: () =>
      Ref.update(harness.ensured, (count) => count + 1).pipe(
        Effect.andThen(Ref.getAndSet(harness.ensureFails, false)),
        Effect.flatMap((fails) =>
          fails
            ? Effect.fail(new SshLaunchError({ message: "Sandbox still booting", stdout: "" }))
            : Effect.void,
        ),
        Effect.as({
          target,
          httpBaseUrl: "http://127.0.0.1:4010/",
          wsBaseUrl: "ws://127.0.0.1:4010/",
          pairingToken: null,
        }),
      ),
    // Stopping T3's server over SSH hangs while a Sandbox stops; nothing may wait for it.
    disconnectEnvironment: () =>
      Deferred.succeed(harness.disconnected, undefined).pipe(Effect.andThen(Effect.never)),
  });
  const fetchDescriptor: typeof globalThis.fetch = () =>
    Promise.resolve(
      Response.json({
        environmentId: harness.environment.id,
        label: NAME,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: 2,
        capabilities: { repositoryIdentity: true },
      }),
    );
  return Layer.effect(
    DesktopAgentctlSandboxes.DesktopAgentctlSandboxes,
    DesktopAgentctlSandboxes.make,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentctlCli.AgentctlCli, cli),
        Layer.succeed(DesktopSshEnvironment.DesktopSshEnvironment, ssh),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchDescriptor)),
        ),
        environmentLayer(baseDir),
        NodeServices.layer,
      ),
    ),
  );
}

const withSandboxes = <A, E>(
  test: (
    sandboxes: DesktopAgentctlSandboxes.DesktopAgentctlSandboxes["Service"],
    harness: Harness,
    stateDir: string,
  ) => Effect.Effect<A, E>,
  prepare?: (
    stateDir: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agentctl-test-" });
    const harness = yield* makeHarness;
    const stateDir = yield* Effect.provide(
      Effect.map(DesktopEnvironment.DesktopEnvironment, (environment) => environment.stateDir),
      environmentLayer(baseDir),
    );
    if (prepare) yield* prepare(stateDir);
    return yield* Effect.gen(function* () {
      const sandboxes = yield* DesktopAgentctlSandboxes.DesktopAgentctlSandboxes;
      yield* sandboxes.startPolling;
      return yield* test(sandboxes, harness, stateDir);
    }).pipe(Effect.provide(layer(harness, baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** Waits for the snapshot to reach a state; the stream replays the current one first. */
const until = (
  sandboxes: DesktopAgentctlSandboxes.DesktopAgentctlSandboxes["Service"],
  predicate: (snapshot: AgentctlSandboxesSnapshot) => boolean,
) =>
  sandboxes.changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const discovered = (environmentId: string) => (snapshot: AgentctlSandboxesSnapshot) =>
  snapshot.sandboxes[0]?.environmentId === environmentId;

describe("DesktopAgentctlSandboxes", () => {
  it.effect("reaches a running Sandbox once and records its environment", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        const snapshot = yield* until(sandboxes, discovered("env-1"));
        assert.deepStrictEqual(snapshot.sandboxes[0]?.sshTarget?.username, "agent");
        assert.strictEqual(snapshot.sandboxes[0]?.workingDirectory, "/home/agent/code");
        yield* sandboxes.refresh;
        yield* sandboxes.refresh;
        assert.strictEqual(yield* Ref.get(harness.ensured), 1);
      }),
    ),
  );

  it.effect("keeps the known Sandboxes when agentctl fails", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* Ref.set(harness.listFails, true);
        const snapshot = yield* sandboxes.refresh;
        assert.strictEqual(snapshot.status, "available");
        assert.strictEqual(snapshot.error, "agentd is restarting");
        assert.strictEqual(snapshot.sandboxes[0]?.environmentId, "env-1");
      }),
    ),
  );

  it.effect("stops without waiting for the tunnel to close", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        const result = yield* sandboxes.stop(NAME);
        assert.strictEqual(result.error, null);
        yield* Deferred.await(harness.disconnected);
        const snapshot = yield* sandboxes.refresh;
        assert.strictEqual(snapshot.sandboxes[0]?.phase, "stopped");
        // A stopped Sandbox keeps its environment, like an unreachable SSH host.
        assert.strictEqual(snapshot.sandboxes[0]?.environmentId, "env-1");
      }),
    ),
  );

  it.effect("lets go of a create that agentctl keeps retrying", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.agents, []);
        yield* sandboxes.refresh;
        const result = yield* sandboxes.create({
          manifestPath: "/agents/worker/agent.yaml",
          name: NAME,
        });
        assert.strictEqual(result.error, null);
        const sandbox = (yield* sandboxes.snapshot).sandboxes[0];
        assert.strictEqual(sandbox?.phase, "retrying");
        assert.strictEqual(sandbox?.action, null);
        // Its manifest is offered first for the next Sandbox.
        assert.strictEqual(
          (yield* sandboxes.getSettings).lastManifestPath,
          "/agents/worker/agent.yaml",
        );
      }),
    ),
  );

  it.effect("refuses a name agentctl already has, even one made since the last poll", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.agents, []);
        yield* sandboxes.refresh;
        yield* Ref.set(harness.agents, [agent("ready")]);
        const result = yield* sandboxes.create({
          manifestPath: "/agents/worker/agent.yaml",
          name: NAME,
        });
        assert.strictEqual(result.error, `A Sandbox named ${NAME} already exists.`);
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.action ?? null, null);
      }),
    ),
  );

  it.effect("remembers the manifest only when agentctl accepted it", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.agents, []);
        yield* Ref.set(harness.applyFails, true);
        const result = yield* sandboxes.create({
          manifestPath: "/agents/worker/agent.yaml",
          name: NAME,
        });
        assert.strictEqual(result.error, "invalid manifest");
        assert.isUndefined((yield* sandboxes.getSettings).lastManifestPath);
      }),
    ),
  );

  it.effect("checks the environment again when a Sandbox becomes reachable", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        // Its T3 home was reset while it was stopped.
        harness.environment.id = "env-2";
        yield* sandboxes.start(NAME);
        yield* until(sandboxes, discovered("env-2"));
      }),
    ),
  );

  it.effect("keeps checking a known Sandbox quietly until the check succeeds", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        harness.environment.id = "env-2";
        yield* Ref.set(harness.ensureFails, true);
        yield* sandboxes.start(NAME);
        // The first check failed: the known environment stays, with no error of its own.
        const failed = yield* sandboxes.refresh;
        assert.strictEqual(failed.sandboxes[0]?.environmentId, "env-1");
        assert.strictEqual(failed.sandboxes[0]?.connectError, null);
        // It is checked again once the throttle passes, and finds the reset environment.
        yield* TestClock.adjust("31 seconds");
        yield* sandboxes.refresh;
        yield* until(sandboxes, discovered("env-2"));
      }),
    ),
  );

  it.effect("does not report a start that a stop cut short as failed", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* Ref.set(harness.holdStarts, true);
        const starting = yield* Effect.forkChild(sandboxes.start(NAME));
        const gate = yield* Queue.take(harness.heldStarts);
        assert.strictEqual((yield* sandboxes.stop(NAME)).error, null);
        yield* Deferred.succeed(gate, undefined);
        assert.strictEqual((yield* Fiber.join(starting)).error, null);
        const sandbox = (yield* sandboxes.snapshot).sandboxes[0];
        assert.strictEqual(sandbox?.action, null);
        assert.strictEqual(sandbox?.actionError, null);
      }),
    ),
  );

  it.effect("keeps a start shown until the last of two overlapping starts ends", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* Ref.set(harness.holdStarts, true);
        const firstStart = yield* Effect.forkChild(sandboxes.start(NAME));
        const first = yield* Queue.take(harness.heldStarts);
        // A second window starts it too, before the first request returns.
        const secondStart = yield* Effect.forkChild(sandboxes.start(NAME));
        const second = yield* Queue.take(harness.heldStarts);
        yield* Deferred.succeed(first, undefined);
        assert.strictEqual((yield* Fiber.join(firstStart)).error, null);
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.action, "starting");
        yield* Deferred.succeed(second, undefined);
        yield* Fiber.join(secondStart);
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.action, null);
      }),
    ),
  );

  it.effect("merges manifest folder changes instead of replacing the list", () =>
    withSandboxes((sandboxes) =>
      Effect.gen(function* () {
        yield* sandboxes.addManifestRoot("/a");
        yield* sandboxes.addManifestRoot("/b");
        yield* sandboxes.addManifestRoot("/a");
        const settings = yield* sandboxes.removeManifestRoot("/a");
        assert.deepStrictEqual(settings.manifestRoots, ["/b"]);
      }),
    ),
  );

  it.effect("sets an unreadable state file aside instead of overwriting it", () =>
    withSandboxes(
      (sandboxes, _harness, stateDir) =>
        Effect.gen(function* () {
          yield* until(sandboxes, discovered("env-1"));
          const fileSystem = yield* FileSystem.FileSystem;
          const entries = yield* fileSystem.readDirectory(stateDir);
          assert.isTrue(
            entries.some((entry) => entry.startsWith("agentctl-sandboxes.json.unreadable-")),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      (stateDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.makeDirectory(stateDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(stateDir, "agentctl-sandboxes.json"),
            "{oops",
          );
        }),
    ),
  );
});
