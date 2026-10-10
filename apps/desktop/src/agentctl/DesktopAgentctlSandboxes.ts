import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  AgentctlSandboxSettings,
  type AgentctlActionResult,
  type AgentctlCreateSandboxInput,
  type AgentctlMarkProjectCreatedInput,
  type AgentctlSandboxAction,
  type AgentctlSandboxManifest,
  type AgentctlSandboxWorkspace,
  type AgentctlSandboxesSnapshot,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { resolveLoopbackSshHttpBaseUrl } from "@t3tools/ssh/tunnel";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as AgentctlCli from "./AgentctlCli.ts";
import { isConnectable, shouldCloseTunnel, sshAliasFor, type AgentResource } from "./agentState.ts";
import { discoverManifests, expandHome } from "./manifests.ts";
import {
  DEFAULT_SANDBOX_SETTINGS,
  IDLE_RUNTIME,
  SandboxStoreDocument,
  buildSandbox,
  discoveredRecord,
  isActionSettled,
  needsDiscovery,
  reconcileRecords,
  sandboxNameError,
  type SandboxRuntime,
} from "./sandboxModel.ts";

// Discovers agentctl Agents and makes each Ready one with SSH access reachable
// as an SSH environment. The renderer registers them from `snapshot` and
// connects through the regular SSH gateway, so a stopped Sandbox behaves like
// any unreachable SSH host. This service never starts an Agent on its own.

export class DesktopAgentctlSandboxes extends Context.Service<
  DesktopAgentctlSandboxes,
  {
    readonly snapshot: Effect.Effect<AgentctlSandboxesSnapshot>;
    /** The current snapshot, then every change to it. */
    readonly changes: Stream.Stream<AgentctlSandboxesSnapshot>;
    /** Reads agentctl now instead of waiting for the next poll. */
    readonly refresh: Effect.Effect<AgentctlSandboxesSnapshot>;
    readonly start: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly stop: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly remove: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly create: (input: AgentctlCreateSandboxInput) => Effect.Effect<AgentctlActionResult>;
    readonly listManifests: Effect.Effect<ReadonlyArray<AgentctlSandboxManifest>>;
    readonly getSettings: Effect.Effect<AgentctlSandboxSettings>;
    readonly setSettings: (
      settings: AgentctlSandboxSettings,
    ) => Effect.Effect<AgentctlSandboxSettings>;
    readonly getWorkspace: (
      name: string,
    ) => Effect.Effect<AgentctlSandboxWorkspace, AgentctlCli.AgentctlError>;
    readonly markProjectCreated: (input: AgentctlMarkProjectCreatedInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/agentctl/DesktopAgentctlSandboxes") {}

const POLL_INTERVAL = Duration.seconds(3);
const UNAVAILABLE_POLL_INTERVAL = Duration.seconds(30);
// A Sandbox that could not be reached is retried, but not on every poll.
const DISCOVERY_RETRY_MS = 30_000;
// Closing a tunnel also stops T3's server over SSH, which hangs while the
// Sandbox is stopping; nothing waits for it, and it gives up after this.
const TUNNEL_CLOSE_TIMEOUT = Duration.seconds(15);

const sandboxTarget = (name: string): DesktopSshEnvironmentTarget => {
  const alias = sshAliasFor(name);
  return { alias, hostname: alias, username: null, port: null };
};

/** SSH's own wording when agentctl's generated config is not included. */
function discoveryErrorMessage(error: { readonly message: string }): string {
  return /could not resolve hostname/i.test(error.message)
    ? "SSH cannot resolve this Sandbox. Run `agentctl ssh-config install` and try again."
    : error.message;
}

const decodeStore = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxStoreDocument));
const encodeStore = Schema.encodeEffect(Schema.fromJsonString(SandboxStoreDocument, { space: 2 }));

export const make = Effect.gen(function* () {
  const cli = yield* AgentctlCli.AgentctlCli;
  const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const storePath = path.join(environment.stateDir, "agentctl-sandboxes.json");
  // A file T3 cannot read is kept aside rather than overwritten by the next save.
  const loaded = yield* fileSystem.readFileString(storePath).pipe(
    Effect.map((raw): string | null => raw),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.flatMap((raw) =>
      raw === null ? Effect.succeed<SandboxStoreDocument>({}) : decodeStore(raw),
    ),
    Effect.catch((error) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const aside = `${storePath}.unreadable-${now}`;
          return fileSystem
            .rename(storePath, aside)
            .pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.logWarning("Set aside unreadable agentctl Sandbox state.", { aside, error }),
              ),
            );
        }),
        Effect.as<SandboxStoreDocument>({}),
      ),
    ),
  );
  const store = yield* Ref.make<SandboxStoreDocument>(loaded);
  // Writes go to a temporary file first, so a crash never leaves half a document.
  const persist = Ref.get(store).pipe(
    Effect.flatMap(encodeStore),
    Effect.flatMap((json) =>
      fileSystem
        .writeFileString(`${storePath}.tmp`, `${json}\n`)
        .pipe(Effect.andThen(fileSystem.rename(`${storePath}.tmp`, storePath))),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not save agentctl Sandbox state.", { storePath, error }),
    ),
  );
  // One update at a time, each saved before the next, so none is lost or reordered.
  const storeLock = yield* Semaphore.make(1);
  const updateStore = (update: (document: SandboxStoreDocument) => SandboxStoreDocument) =>
    storeLock.withPermits(1)(Ref.update(store, update).pipe(Effect.andThen(persist)));
  const scope = yield* Effect.scope;

  const agentsRef = yield* Ref.make<ReadonlyArray<AgentResource>>([]);
  const runtimes = yield* Ref.make<ReadonlyMap<string, SandboxRuntime>>(new Map());
  const discovering = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const snapshotRef = yield* SubscriptionRef.make<AgentctlSandboxesSnapshot>({
    status: "loading",
    error: null,
    sandboxes: [],
  });
  const refreshLock = yield* Semaphore.make(1);

  const closeTunnelSoon = (name: string) =>
    ssh
      .disconnectEnvironment(sandboxTarget(name))
      .pipe(
        Effect.timeout(TUNNEL_CLOSE_TIMEOUT),
        Effect.ignore,
        Effect.forkIn(scope),
        Effect.asVoid,
      );

  const updateRuntime = (name: string, update: (runtime: SandboxRuntime) => SandboxRuntime) =>
    Ref.update(runtimes, (current) => {
      const next = new Map(current);
      next.set(name, update(current.get(name) ?? IDLE_RUNTIME));
      return next;
    });

  const publish = Effect.gen(function* () {
    const agents = yield* Ref.get(agentsRef);
    const records = (yield* Ref.get(store)).sandboxes ?? {};
    const runtime = yield* Ref.get(runtimes);
    yield* SubscriptionRef.update(snapshotRef, (snapshot) => ({
      ...snapshot,
      sandboxes: agents.map((agent) =>
        buildSandbox(
          agent,
          records[agent.metadata.name],
          runtime.get(agent.metadata.name) ?? IDLE_RUNTIME,
        ),
      ),
    }));
  });

  // Reaches the Sandbox's T3 server to learn its environment id: the first
  // time, and again each time it becomes reachable, in case its T3 home was
  // reset. After that the renderer's SSH connection owns the tunnel.
  const discover = (agent: AgentResource) =>
    Effect.gen(function* () {
      const name = agent.metadata.name;
      const result = yield* ssh.ensureEnvironment(sandboxTarget(name)).pipe(
        Effect.flatMap((bootstrap) =>
          resolveLoopbackSshHttpBaseUrl(bootstrap.httpBaseUrl).pipe(
            Effect.flatMap((httpBaseUrl) => fetchRemoteEnvironmentDescriptor({ httpBaseUrl })),
            Effect.map((descriptor) => ({ descriptor, sshTarget: bootstrap.target })),
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.result,
      );
      if (result._tag === "Failure") {
        yield* Effect.logWarning("Could not reach an agentctl Sandbox.", {
          name,
          error: result.failure,
        });
        // A known Sandbox keeps its environment; its live connection reports trouble.
        const known = (yield* Ref.get(store)).sandboxes?.[name] !== undefined;
        if (!known) {
          yield* updateRuntime(name, (runtime) => ({
            ...runtime,
            connectError: discoveryErrorMessage(result.failure),
          }));
        }
      } else {
        const discovered = {
          sandboxId: agent.status?.sandbox?.id ?? null,
          environmentId: result.success.descriptor.environmentId,
          // Registering the resolved target keeps the SSH connection from
          // recording a changed profile on every connect.
          sshTarget: result.success.sshTarget,
        };
        yield* updateStore((document) => ({
          ...document,
          sandboxes: {
            ...document.sandboxes,
            [name]: discoveredRecord(document.sandboxes?.[name], discovered),
          },
        }));
        yield* updateRuntime(name, (runtime) => ({
          ...runtime,
          connectError: null,
          verified: true,
        }));
      }
      yield* publish;
    }).pipe(
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Ref.update(discovering, (current) =>
              new Map(current).set(agent.metadata.name, now + DISCOVERY_RETRY_MS),
            ),
          ),
        ),
      ),
    );

  const refreshBody = Effect.gen(function* () {
    const listed = yield* cli.listAgents.pipe(Effect.result);
    if (listed._tag === "Failure") {
      // Keep the last known Sandboxes: dropping them would remove their
      // environments, and with them cached threads and drafts, over one
      // failed call such as agentd restarting.
      const error = listed.failure.message;
      yield* SubscriptionRef.update(snapshotRef, (snapshot): AgentctlSandboxesSnapshot =>
        snapshot.status === "loading"
          ? { status: "unavailable", error, sandboxes: [] }
          : { ...snapshot, error },
      );
      return;
    }
    const agents = listed.success;
    const previousAgents = yield* Ref.get(agentsRef);
    yield* Ref.set(agentsRef, agents);
    yield* SubscriptionRef.update(snapshotRef, (snapshot): AgentctlSandboxesSnapshot => ({
      ...snapshot,
      status: "available",
      error: null,
    }));

    const known = (yield* Ref.get(store)).sandboxes ?? {};
    if (Object.keys(reconcileRecords(known, agents)).length !== Object.keys(known).length) {
      yield* updateStore((document) => ({
        ...document,
        sandboxes: reconcileRecords(document.sandboxes ?? {}, agents),
      }));
    }
    const records = (yield* Ref.get(store)).sandboxes ?? {};

    // Close tunnels to Sandboxes that are stopping or went away; a Sandbox
    // that is only re-provisioning keeps its SSH server.
    for (const previous of previousAgents) {
      const current = agents.find((agent) => agent.metadata.name === previous.metadata.name);
      if (isConnectable(previous) && shouldCloseTunnel(current)) {
        yield* closeTunnelSoon(previous.metadata.name);
      }
    }

    // Settle requests T3 is waiting on, such as a create that became Ready.
    const runtime = yield* Ref.get(runtimes);
    for (const [name, state] of runtime) {
      const agent = agents.find((candidate) => candidate.metadata.name === name);
      if (state.action !== null && isActionSettled(state.action, agent)) {
        yield* updateRuntime(name, (current) => ({ ...current, action: null }));
      }
      if (agent === undefined && state.action === null) {
        yield* Ref.update(runtimes, (current) => {
          const next = new Map(current);
          next.delete(name);
          return next;
        });
      }
    }

    const now = yield* Clock.currentTimeMillis;
    const pending = yield* Ref.get(discovering);
    const states = yield* Ref.get(runtimes);
    for (const agent of agents) {
      const name = agent.metadata.name;
      const state = states.get(name) ?? IDLE_RUNTIME;
      if (!isConnectable(agent)) {
        // Check again, without waiting out the throttle, once it is back.
        if (state.verified)
          yield* updateRuntime(name, (current) => ({ ...current, verified: false }));
        if (pending.get(name) !== Number.POSITIVE_INFINITY) {
          yield* Ref.update(discovering, (current) => {
            const next = new Map(current);
            next.delete(name);
            return next;
          });
        }
        continue;
      }
      if (state.verified && !needsDiscovery(records[name], agent)) continue;
      const retryAt = pending.get(name);
      if (retryAt !== undefined && now < retryAt) continue;
      yield* Ref.update(discovering, (current) =>
        new Map(current).set(name, Number.POSITIVE_INFINITY),
      );
      yield* Effect.forkIn(discover(agent), scope);
    }
    yield* publish;
  });

  const refresh = refreshLock
    .withPermits(1)(refreshBody)
    .pipe(Effect.andThen(SubscriptionRef.get(snapshotRef)));

  const nextActionId = yield* Ref.make(0);

  const runAction = (
    name: string,
    action: AgentctlSandboxAction,
    run: Effect.Effect<void, AgentctlCli.AgentctlError>,
    options: { readonly settleOnPoll: boolean },
  ) =>
    Effect.gen(function* () {
      const actionId = yield* Ref.updateAndGet(nextActionId, (id) => id + 1);
      yield* updateRuntime(name, (runtime) => ({
        ...runtime,
        action,
        actionId,
        actionError: null,
      }));
      yield* publish;
      const result = yield* Effect.result(run);
      const error = result._tag === "Failure" ? result.failure.message : null;
      // A later request took over, such as a stop while a start was waiting;
      // this one's outcome, even a failure caused by it, no longer matters.
      const superseded = ((yield* Ref.get(runtimes)).get(name)?.actionId ?? actionId) !== actionId;
      if (!superseded) {
        yield* updateRuntime(name, (runtime) => ({
          ...runtime,
          action: error === null && options.settleOnPoll ? runtime.action : null,
          actionError: error,
        }));
      }
      yield* refresh;
      return { error: superseded ? null : error } satisfies AgentctlActionResult;
    });

  const getSettings = Ref.get(store).pipe(
    Effect.map((document) => document.settings ?? DEFAULT_SANDBOX_SETTINGS),
  );

  // Without agentctl there is nothing to watch closely, so check rarely.
  const pollOnce = refresh.pipe(
    Effect.catchCause((cause) => Effect.logError("agentctl Sandbox polling failed.", { cause })),
    Effect.andThen(SubscriptionRef.get(snapshotRef)),
    Effect.flatMap((snapshot) =>
      Effect.sleep(snapshot.status === "unavailable" ? UNAVAILABLE_POLL_INTERVAL : POLL_INTERVAL),
    ),
  );
  yield* Effect.forever(pollOnce).pipe(Effect.forkScoped);

  return DesktopAgentctlSandboxes.of({
    snapshot: SubscriptionRef.get(snapshotRef),
    changes: SubscriptionRef.changes(snapshotRef),
    refresh,
    start: (name) => runAction(name, "starting", cli.start(name), { settleOnPoll: false }),
    stop: (name) =>
      runAction(name, "stopping", cli.stop(name).pipe(Effect.tap(() => closeTunnelSoon(name))), {
        settleOnPoll: false,
      }),
    remove: (name) =>
      runAction(name, "deleting", closeTunnelSoon(name).pipe(Effect.andThen(cli.remove(name))), {
        settleOnPoll: true,
      }),
    create: (input) =>
      Effect.gen(function* () {
        const nameError = sandboxNameError(input.name, yield* Ref.get(agentsRef));
        if (nameError !== null) return { error: nameError } satisfies AgentctlActionResult;
        const envFile =
          input.envFile === null || input.envFile.trim() === ""
            ? null
            : path.resolve(expandHome(input.envFile.trim(), environment.homeDirectory));
        return yield* runAction(
          input.name,
          "creating",
          cli.apply({ manifestPath: input.manifestPath, name: input.name, envFile }),
          { settleOnPoll: true },
        );
      }),
    listManifests: getSettings.pipe(
      Effect.flatMap((settings) =>
        discoverManifests(settings.manifestRoots, environment.homeDirectory),
      ),
      Effect.provide(context),
    ),
    getSettings,
    setSettings: (settings) =>
      updateStore((document) => ({ ...document, settings })).pipe(Effect.andThen(getSettings)),
    getWorkspace: (name) =>
      cli
        .sshInfo(name)
        .pipe(
          Effect.map(({ workingDirectory }): AgentctlSandboxWorkspace => ({ workingDirectory })),
        ),
    markProjectCreated: ({ name, environmentId }) =>
      updateStore((document) => {
        const record = document.sandboxes?.[name];
        if (record === undefined || record.environmentId !== environmentId) return document;
        return {
          ...document,
          sandboxes: { ...document.sandboxes, [name]: { ...record, projectCreated: true } },
        };
      }),
  });
});

export const layer = Layer.effect(DesktopAgentctlSandboxes, make).pipe(
  Layer.provide(AgentctlCli.layer),
);
