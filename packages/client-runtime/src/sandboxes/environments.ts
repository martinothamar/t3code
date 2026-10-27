import {
  EnvironmentId,
  WS_METHODS,
  type AgentctlSandbox,
  type AgentctlSandboxesSnapshot,
} from "@t3tools/contracts";
import { environmentServerUrl } from "@t3tools/shared/advertisedEndpoint";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget, type ConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { requestGuarded, subscribe } from "../rpc/client.ts";

// A host that advertises `agentctlSandboxes` relays each of its Sandboxes at
// `/sandbox/<name>/`. Each Sandbox reached once becomes an environment of its
// own on that route, paired with a code the host asks the Sandbox for, so
// every client gets them the same way.

const CONNECTION_ID_PREFIX = "agentctl:";

/** One id per host, Sandbox and environment, so a recreated Sandbox pairs again. */
export const sandboxConnectionId = (
  hostEnvironmentId: EnvironmentId,
  name: string,
  environmentId: EnvironmentId,
) => `${CONNECTION_ID_PREFIX}${hostEnvironmentId}:${name}:${environmentId}`;

/** The host and Sandbox an environment connects to, or null for any other environment. */
export function sandboxForTarget(
  target: ConnectionTarget,
): { readonly hostEnvironmentId: EnvironmentId; readonly name: string } | null {
  if (
    target._tag !== "BearerConnectionTarget" ||
    !target.connectionId.startsWith(CONNECTION_ID_PREFIX)
  ) {
    return null;
  }
  const [host, name] = target.connectionId.slice(CONNECTION_ID_PREFIX.length).split(":");
  return host && name ? { hostEnvironmentId: EnvironmentId.make(host), name } : null;
}

/** A Sandbox on its way out, whose environment clients let go of right away. */
const isSandboxBeingDeleted = (sandbox: AgentctlSandbox) =>
  sandbox.action === "deleting" || sandbox.phase === "terminating";

const isSandboxRunning = (sandbox: AgentctlSandbox) =>
  sandbox.phase === "ready" && sandbox.action === null;

export function sandboxRoute(hostHttpBaseUrl: string, name: string) {
  const httpBaseUrl = environmentServerUrl(hostHttpBaseUrl, `/sandbox/${name}/`).toString();
  return { httpBaseUrl, wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws") };
}

export function sandboxRegistration(input: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly hostHttpBaseUrl: string;
  readonly sandbox: AgentctlSandbox & { readonly environmentId: EnvironmentId };
  readonly token: string;
}): BearerConnectionRegistration {
  const { sandbox } = input;
  const connectionId = sandboxConnectionId(
    input.hostEnvironmentId,
    sandbox.name,
    sandbox.environmentId,
  );
  const route = sandboxRoute(input.hostHttpBaseUrl, sandbox.name);
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: sandbox.environmentId,
      label: sandbox.name,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: sandbox.environmentId,
      label: sandbox.name,
      ...route,
    }),
    credential: new BearerConnectionCredential({ token: input.token }),
  });
}

export class SandboxEnvironments extends Context.Service<
  SandboxEnvironments,
  {
    /** Each host's latest Sandbox list. */
    readonly hosts: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, AgentctlSandboxesSnapshot>
    >;
    /** The Sandbox environments of every host, which the registry adds to the platform's. */
    readonly registrations: SubscriptionRef.SubscriptionRef<
      ReadonlyArray<BearerConnectionRegistration>
    >;
  }
>()("@t3tools/client-runtime/sandboxes/environments/SandboxEnvironments") {}

export const layer = Layer.effect(
  SandboxEnvironments,
  Effect.gen(function* () {
    return SandboxEnvironments.of({
      hosts: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, AgentctlSandboxesSnapshot>>(
        new Map(),
      ),
      registrations: yield* SubscriptionRef.make<ReadonlyArray<BearerConnectionRegistration>>([]),
    });
  }),
);

interface HostView {
  readonly snapshot: AgentctlSandboxesSnapshot;
  readonly httpBaseUrl: string;
}

// The host's Sandbox list with the address this client reaches the host at, which its
// Sandboxes' routes follow. Hosts that do not manage Sandboxes send nothing.
const hostView = Stream.unwrap(
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filterMap((current) =>
        Option.isSome(current) ? Result.succeed(current.value) : Result.failVoid,
      ),
      Stream.runHead,
    );
    if (Option.isNone(session)) return Stream.empty;
    const config = yield* session.value.initialConfig.pipe(Effect.option);
    if (Option.isNone(config) || config.value.agentctlSandboxes !== true) return Stream.empty;
    const addresses = SubscriptionRef.changes(supervisor.prepared).pipe(
      Stream.filterMap((prepared) =>
        Option.isSome(prepared) ? Result.succeed(prepared.value.httpBaseUrl) : Result.failVoid,
      ),
      Stream.changes,
    );
    return Stream.zipLatest(subscribe(WS_METHODS.subscribeAgentctlSandboxes, {}), addresses).pipe(
      Stream.map(([snapshot, httpBaseUrl]): HostView => ({ snapshot, httpBaseUrl })),
    );
  }),
);

/**
 * Follows the Sandboxes of every connected host and keeps their environments registered. Runs for
 * the life of the connection layer.
 */
export const watchSandboxEnvironments = Effect.fn("SandboxEnvironments.watch")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const environments = yield* SandboxEnvironments;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const byHost = yield* Ref.make<
    ReadonlyMap<EnvironmentId, ReadonlyArray<BearerConnectionRegistration>>
  >(new Map());
  const running = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());

  const publish = Ref.get(byHost).pipe(
    Effect.flatMap((current) =>
      SubscriptionRef.set(environments.registrations, [...current.values()].flat()),
    ),
  );

  const savedToken = (connectionId: string) =>
    credentials.get(connectionId).pipe(
      Effect.map((saved) =>
        Option.isSome(saved) && saved.value._tag === "BearerConnectionCredential"
          ? saved.value.token
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const pairSandbox = (hostEnvironmentId: EnvironmentId, name: string, httpBaseUrl: string) =>
    registry.run(hostEnvironmentId, requestGuarded(WS_METHODS.agentctlPairSandbox, { name })).pipe(
      Effect.flatMap((pairing) =>
        bootstrapRemoteBearerSession({
          httpBaseUrl: sandboxRoute(httpBaseUrl, name).httpBaseUrl,
          credential: pairing.pairingToken,
          clientMetadata: presentation.metadata,
        }).pipe(
          Effect.map((access) => ({
            environmentId: pairing.environmentId,
            token: access.access_token,
          })),
        ),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const applyHost = Effect.fn("SandboxEnvironments.applyHost")(function* (
    hostEnvironmentId: EnvironmentId,
    view: HostView,
  ) {
    yield* SubscriptionRef.update(environments.hosts, (current) =>
      new Map(current).set(hostEnvironmentId, view.snapshot),
    );
    const registrations: BearerConnectionRegistration[] = [];
    for (const sandbox of view.snapshot.sandboxes) {
      if (sandbox.environmentId === null || isSandboxBeingDeleted(sandbox)) continue;
      const environmentId = EnvironmentId.make(sandbox.environmentId);
      const connectionId = sandboxConnectionId(hostEnvironmentId, sandbox.name, environmentId);
      let token = yield* savedToken(connectionId);
      // A Sandbox this client never paired with is not an environment until it runs.
      if (token === null && isSandboxRunning(sandbox)) {
        const paired = yield* pairSandbox(hostEnvironmentId, sandbox.name, view.httpBaseUrl).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not pair with a Sandbox.", { name: sandbox.name, error }),
          ),
          Effect.option,
        );
        if (Option.isSome(paired) && paired.value.environmentId === environmentId) {
          token = paired.value.token;
        }
      }
      if (token === null) continue;
      registrations.push(
        sandboxRegistration({
          hostEnvironmentId,
          hostHttpBaseUrl: view.httpBaseUrl,
          sandbox: { ...sandbox, environmentId },
          token,
        }),
      );
    }
    yield* Ref.update(byHost, (current) => new Map(current).set(hostEnvironmentId, registrations));
    yield* publish;

    // A started Sandbox should not wait out the backoff its stopped time built up.
    const nowRunning = new Set(
      view.snapshot.sandboxes.flatMap((sandbox) =>
        sandbox.environmentId !== null && isSandboxRunning(sandbox)
          ? [EnvironmentId.make(sandbox.environmentId)]
          : [],
      ),
    );
    const before = yield* Ref.getAndUpdate(running, (current) => {
      const next = new Set(current);
      for (const sandbox of view.snapshot.sandboxes) {
        if (sandbox.environmentId === null) continue;
        const environmentId = EnvironmentId.make(sandbox.environmentId);
        if (nowRunning.has(environmentId)) next.add(environmentId);
        else next.delete(environmentId);
      }
      return next;
    });
    yield* Effect.forEach(
      [...nowRunning].filter((environmentId) => !before.has(environmentId)),
      registry.retryNow,
      { discard: true },
    );
  });

  const forgetHost = Effect.fn("SandboxEnvironments.forgetHost")(function* (
    hostEnvironmentId: EnvironmentId,
  ) {
    yield* SubscriptionRef.update(environments.hosts, (current) => {
      const next = new Map(current);
      next.delete(hostEnvironmentId);
      return next;
    });
    yield* Ref.update(byHost, (current) => {
      const next = new Map(current);
      next.delete(hostEnvironmentId);
      return next;
    });
    yield* publish;
  });

  const followers = yield* FiberMap.make<EnvironmentId>();
  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (entries) {
        const sandboxIds = new Set(
          (yield* SubscriptionRef.get(environments.registrations)).map(
            (registration) => registration.target.environmentId,
          ),
        );
        // A Sandbox's own server manages no Sandboxes worth following.
        const hostIds = [...entries.keys()].filter((id) => !sandboxIds.has(id));
        for (const hostEnvironmentId of hostIds) {
          if (yield* FiberMap.has(followers, hostEnvironmentId)) continue;
          yield* FiberMap.run(
            followers,
            hostEnvironmentId,
            registry.followStream(hostEnvironmentId, hostView).pipe(
              Stream.runForEach((view) => applyHost(hostEnvironmentId, view)),
              Effect.catchCause((cause) =>
                Effect.logWarning("Stopped following a host's Sandboxes.", {
                  hostEnvironmentId,
                  cause,
                }),
              ),
            ),
          );
        }
        // Copied, since removing a fiber changes the map.
        for (const [hostEnvironmentId] of Array.from(followers)) {
          if (entries.has(hostEnvironmentId) && !sandboxIds.has(hostEnvironmentId)) continue;
          yield* FiberMap.remove(followers, hostEnvironmentId);
          if (!entries.has(hostEnvironmentId)) yield* forgetHost(hostEnvironmentId);
        }
      }),
    ),
  );
});
