import { expect, it } from "@effect/vitest";
import {
  type AgentctlSandbox,
  type AgentctlSandboxesSnapshot,
  EnvironmentId,
  type PeerLink,
  type PeerLinkCreateInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentctlSandboxLinks from "./AgentctlSandboxLinks.ts";
import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";

const first = EnvironmentId.make("environment-first");
const second = EnvironmentId.make("environment-second");

const sandbox = (overrides: Partial<AgentctlSandbox>): AgentctlSandbox => ({
  name: "worker",
  phase: "ready",
  detail: null,
  since: null,
  cpu: null,
  memory: null,
  disk: null,
  network: null,
  sshAccess: true,
  environmentId: first,
  settingsSeeded: true,
  harnesses: [],
  workingDirectory: null,
  connectError: null,
  action: null,
  actionError: null,
  manifestPath: null,
  variant: null,
  ...overrides,
});

const snapshot = (sandboxes: ReadonlyArray<AgentctlSandbox>): AgentctlSandboxesSnapshot => ({
  status: "available",
  error: null,
  sandboxes,
  homeDirectory: "/home/user",
});

type Call =
  | { readonly _tag: "link"; readonly input: PeerLinkCreateInput }
  | { readonly _tag: "relocate"; readonly environmentId: EnvironmentId; readonly urls: unknown }
  | { readonly _tag: "unlink"; readonly environmentId: EnvironmentId };

/** Runs the links layer against queues standing in for agentctl and records what it asks of PeerLinks. */
const harness = Effect.gen(function* () {
  const changes = yield* Queue.unbounded<AgentctlSandboxesSnapshot>();
  const reached = yield* Queue.unbounded<AgentctlSandboxes.SandboxReached>();
  const calls = yield* Queue.unbounded<Call>();
  const stored = new Map<EnvironmentId, PeerLink>();
  const upstream = { url: "http://127.0.0.1:41001/" };
  const record = (call: Call) => Queue.offer(calls, call).pipe(Effect.asVoid);

  yield* Layer.build(
    AgentctlSandboxLinks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentctlSandboxes.AgentctlSandboxes)({
            changes: Stream.fromQueue(changes),
            reached: Stream.fromQueue(reached),
            relayUpstream: () => Effect.succeedSome(upstream.url),
            pair: () => Effect.succeed({ environmentId: first, pairingToken: "PAIRCODE" }),
          }),
          Layer.mock(PeerLinks.PeerLinks)({
            enabled: Effect.succeed(true),
            get: (environmentId) => Effect.succeed(Option.fromNullishOr(stored.get(environmentId))),
            link: (input) =>
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                const linked: PeerLink = {
                  environmentId: input.expectedEnvironmentId!,
                  label: "worker",
                  urls: [new URL(input.url).origin],
                  access: input.access,
                  linkedAt: now,
                  expiresAt: DateTime.add(now, { days: 30 }),
                  lastReachedAt: now,
                  lastError: null,
                };
                stored.set(linked.environmentId, linked);
                yield* record({ _tag: "link", input });
                return linked;
              }),
            relocate: (environmentId, urls) =>
              record({ _tag: "relocate", environmentId, urls }).pipe(Effect.as(true)),
            unlink: (environmentId) =>
              Effect.sync(() => stored.delete(environmentId)).pipe(
                Effect.tap(() => record({ _tag: "unlink", environmentId })),
              ),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            subscribeChanges: Effect.succeed(Stream.never),
          }),
        ),
      ),
    ),
  );
  return { changes, reached, calls, upstream };
});

it.effect(
  "links a running Sandbox once, supervised, and moves the link when its forward moves",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { changes, reached, calls, upstream } = yield* harness;

        yield* Queue.offer(changes, snapshot([sandbox({})]));
        expect(yield* Queue.take(calls)).toEqual({
          _tag: "link",
          input: {
            url: "http://127.0.0.1:41001/",
            pairingCode: "PAIRCODE",
            access: "approval-required",
            expectedEnvironmentId: first,
            expectedLabel: "worker",
          },
        });

        // A reconnect at the same forward changes nothing; at a new one, the link follows it.
        yield* Queue.offer(reached, {
          name: "worker",
          environmentId: first,
          httpBaseUrl: upstream.url,
        });
        upstream.url = "http://127.0.0.1:41002/";
        yield* Queue.offer(reached, {
          name: "worker",
          environmentId: first,
          httpBaseUrl: upstream.url,
        });
        expect(yield* Queue.take(calls)).toEqual({
          _tag: "relocate",
          environmentId: first,
          urls: ["http://127.0.0.1:41002/"],
        });
        expect(yield* Queue.size(calls)).toBe(0);
      }),
    ),
);

it.effect("forgets the link of a Sandbox that is recreated or deleted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { changes, calls } = yield* harness;
      const stopped = { phase: "stopped" as const };

      yield* Queue.offer(changes, snapshot([sandbox({ ...stopped })]));
      yield* Queue.offer(changes, snapshot([sandbox({ ...stopped, environmentId: second })]));
      expect(yield* Queue.take(calls)).toEqual({ _tag: "unlink", environmentId: first });
      yield* Queue.offer(changes, snapshot([]));
      expect(yield* Queue.take(calls)).toEqual({ _tag: "unlink", environmentId: second });
    }),
  ),
);
