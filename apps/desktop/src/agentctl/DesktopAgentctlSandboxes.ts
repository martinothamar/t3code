import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  AgentctlSandboxSettings,
  type AgentctlActionResult,
  type AgentctlCreateSandboxInput,
  type AgentctlManifestRoot,
  type AgentctlPullResult,
  type AgentctlSandboxAction,
  type AgentctlSandboxManifest,
  type AgentctlSandboxesSnapshot,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveLoopbackSshHttpBaseUrl } from "@t3tools/ssh/tunnel";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as AgentctlCli from "./AgentctlCli.ts";
import { isConnectable, shouldCloseTunnel, sshAliasFor, type AgentResource } from "./agentState.ts";
import { discoverManifests } from "./manifests.ts";
import { describeManifestRoots, pullManifestRepositories } from "./manifestRepositories.ts";
import {
  DEFAULT_SANDBOX_SETTINGS,
  IDLE_RUNTIME,
  SandboxStoreDocument,
  buildSandbox,
  reconcileRecords,
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
    /** The current snapshot, then every change to it, which tests wait on. */
    readonly changes: Stream.Stream<AgentctlSandboxesSnapshot>;
    /** Reads agentctl now instead of waiting for the next poll. */
    readonly refresh: Effect.Effect<AgentctlSandboxesSnapshot>;
    readonly start: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly stop: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly remove: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly create: (input: AgentctlCreateSandboxInput) => Effect.Effect<AgentctlActionResult>;
    readonly listManifests: Effect.Effect<ReadonlyArray<AgentctlSandboxManifest>>;
    readonly listManifestRoots: Effect.Effect<ReadonlyArray<AgentctlManifestRoot>>;
    /** Fetches each manifest repository before describing it. */
    readonly refreshManifestRoots: Effect.Effect<ReadonlyArray<AgentctlManifestRoot>>;
    readonly getSettings: Effect.Effect<AgentctlSandboxSettings>;
    /** Folders are merged here, so two views never overwrite each other's changes. */
    readonly addManifestRoot: (folder: string) => Effect.Effect<AgentctlSandboxSettings>;
    readonly removeManifestRoot: (folder: string) => Effect.Effect<AgentctlSandboxSettings>;
    readonly pullManifestRoots: (
      folders: ReadonlyArray<string>,
    ) => Effect.Effect<AgentctlPullResult>;
    /** Remembers that this environment of the Sandbox got its preference settings. */
    readonly markSettingsSeeded: (
      name: string,
      environmentId: EnvironmentId,
    ) => Effect.Effect<void>;
    /** Whether a folder is configured and still a directory, before opening one the renderer names. */
    readonly isManifestRootDirectory: (folder: string) => Effect.Effect<boolean>;
    /**
     * Starts watching agentctl. Call it once the app has loaded its shell
     * environment, so a macOS app opened from Finder finds agentctl on PATH.
     * Later calls do nothing.
     */
    readonly startPolling: Effect.Effect<void>;
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
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  // Overlapping manifest folders can refer to the same repository.
  const pullLock = yield* Semaphore.make(1);
  // Each Sandboxes page asks for a refresh when it opens; they share the one in flight.
  const refreshing = yield* Ref.make<Deferred.Deferred<ReadonlyArray<AgentctlManifestRoot>> | null>(
    null,
  );

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
  const snapshotRef = yield* SubscriptionRef.make<AgentctlSandboxesSnapshot>({
    status: "loading",
    error: null,
    sandboxes: [],
    homeDirectory: environment.homeDirectory,
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
  // time in each run of the app, and again each time it becomes reachable, in
  // case it was recreated or its T3 home reset. After that the renderer's SSH
  // connection owns the tunnel.
  const discover = (name: string) =>
    Effect.gen(function* () {
      const result = yield* Effect.all([
        ssh.ensureEnvironment(sandboxTarget(name)).pipe(
          Effect.flatMap((bootstrap) =>
            resolveLoopbackSshHttpBaseUrl(bootstrap.httpBaseUrl).pipe(
              Effect.flatMap((httpBaseUrl) => fetchRemoteEnvironmentDescriptor({ httpBaseUrl })),
              Effect.map((descriptor) => ({ descriptor, sshTarget: bootstrap.target })),
            ),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
        cli.sshInfo(name),
      ]).pipe(Effect.result);
      const now = yield* Clock.currentTimeMillis;
      if (result._tag === "Failure") {
        yield* Effect.logWarning("Could not reach an agentctl Sandbox.", {
          name,
          error: result.failure,
        });
        // A known Sandbox keeps its environment; its live connection reports trouble.
        const known = (yield* Ref.get(store)).sandboxes?.[name] !== undefined;
        yield* updateRuntime(name, (runtime) => ({
          ...runtime,
          discovering: false,
          retryAt: now + DISCOVERY_RETRY_MS,
          connectError: known ? runtime.connectError : discoveryErrorMessage(result.failure),
        }));
      } else {
        const [{ descriptor, sshTarget }, sshInfo] = result.success;
        yield* updateStore((document) => ({
          ...document,
          sandboxes: {
            ...document.sandboxes,
            // Registering the resolved target keeps the SSH connection from
            // recording a changed profile on every connect. A recreated
            // Sandbox has a new environment, which is seeded again.
            [name]: {
              environmentId: descriptor.environmentId,
              sshTarget,
              ...(document.sandboxes?.[name]?.environmentId === descriptor.environmentId &&
              document.sandboxes[name].settingsSeeded === true
                ? { settingsSeeded: true }
                : {}),
            },
          },
        }));
        yield* updateRuntime(name, (runtime) => ({
          ...runtime,
          discovering: false,
          connectError: null,
          verified: true,
          workingDirectory: sshInfo.workingDirectory,
        }));
      }
      yield* publish;
    });

  const refreshBody = Effect.gen(function* () {
    const listed = yield* cli.listAgents.pipe(Effect.result);
    if (listed._tag === "Failure") {
      // Keep the last known Sandboxes: dropping them would remove their
      // environments, and with them cached threads and drafts, over one
      // failed call such as agentd restarting.
      const error = listed.failure.message;
      yield* SubscriptionRef.update(snapshotRef, (snapshot): AgentctlSandboxesSnapshot =>
        snapshot.status === "loading"
          ? { ...snapshot, status: "unavailable", error, sandboxes: [] }
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

    // Close tunnels to Sandboxes that are stopping or went away; a Sandbox
    // that is only re-provisioning keeps its SSH server.
    for (const previous of previousAgents) {
      const current = agents.find((agent) => agent.metadata.name === previous.metadata.name);
      if (isConnectable(previous) && shouldCloseTunnel(current)) {
        yield* closeTunnelSoon(previous.metadata.name);
      }
    }

    // Forget Sandboxes that are gone, unless a request on them is still running.
    yield* Ref.update(runtimes, (current) => {
      const next = new Map(current);
      for (const [name, state] of current) {
        const present = agents.some((agent) => agent.metadata.name === name);
        if (!present && state.action === null) next.delete(name);
      }
      return next;
    });

    const now = yield* Clock.currentTimeMillis;
    const states = yield* Ref.get(runtimes);
    for (const agent of agents) {
      const name = agent.metadata.name;
      const state = states.get(name) ?? IDLE_RUNTIME;
      if (!isConnectable(agent)) {
        // Check again, without waiting out the throttle, once it is back.
        if (state.verified || state.retryAt !== 0) {
          yield* updateRuntime(name, (current) => ({ ...current, verified: false, retryAt: 0 }));
        }
        continue;
      }
      if (state.verified || state.discovering || now < state.retryAt) continue;
      yield* updateRuntime(name, (current) => ({ ...current, discovering: true }));
      yield* Effect.forkIn(discover(name), scope);
    }
    yield* publish;
  });

  const nextActionId = yield* Ref.make(0);

  const refresh = refreshLock
    .withPermits(1)(refreshBody)
    .pipe(Effect.andThen(SubscriptionRef.get(snapshotRef)));

  const runAction = (
    name: string,
    action: AgentctlSandboxAction,
    run: Effect.Effect<void, AgentctlCli.AgentctlError>,
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
      const superseded = (yield* Ref.get(runtimes)).get(name)?.actionId !== actionId;
      if (!superseded) {
        yield* updateRuntime(name, (runtime) => ({ ...runtime, action: null, actionError: error }));
      }
      yield* refresh;
      return { error: superseded ? null : error } satisfies AgentctlActionResult;
    });

  const getSettings = Ref.get(store).pipe(
    Effect.map((document) => document.settings ?? DEFAULT_SANDBOX_SETTINGS),
  );
  const isDirectory = (directory: string) =>
    fileSystem.stat(directory).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  const updateManifestRoots = (update: (roots: ReadonlyArray<string>) => ReadonlyArray<string>) =>
    updateStore((document) => {
      const settings = document.settings ?? DEFAULT_SANDBOX_SETTINGS;
      return {
        ...document,
        settings: { ...settings, manifestRoots: update(settings.manifestRoots) },
      };
    }).pipe(Effect.andThen(getSettings));
  const polling = yield* Ref.make(false);

  // Without agentctl there is nothing to watch closely, so check rarely.
  const pollOnce = refresh.pipe(
    Effect.catchCause((cause) => Effect.logError("agentctl Sandbox polling failed.", { cause })),
    Effect.andThen(SubscriptionRef.get(snapshotRef)),
    Effect.flatMap((snapshot) =>
      Effect.sleep(snapshot.status === "unavailable" ? UNAVAILABLE_POLL_INTERVAL : POLL_INTERVAL),
    ),
  );

  return DesktopAgentctlSandboxes.of({
    snapshot: SubscriptionRef.get(snapshotRef),
    changes: SubscriptionRef.changes(snapshotRef),
    refresh,
    start: (name) => runAction(name, "starting", cli.start(name)),
    stop: (name) => runAction(name, "stopping", cli.stop(name)),
    remove: (name) => runAction(name, "deleting", cli.remove(name)),
    create: (input) =>
      Effect.gen(function* () {
        // Applying an existing name would replace that Sandbox's manifest, so
        // check agentctl now rather than the last poll.
        const agents = yield* cli.listAgents.pipe(Effect.result);
        if (agents._tag === "Failure") {
          return { error: agents.failure.message } satisfies AgentctlActionResult;
        }
        if (agents.success.some((agent) => agent.metadata.name === input.name)) {
          return {
            error: `A Sandbox named ${input.name} already exists.`,
          } satisfies AgentctlActionResult;
        }
        // Its manifest is offered first for the next Sandbox.
        const remember = updateStore((document) => ({
          ...document,
          settings: {
            ...(document.settings ?? DEFAULT_SANDBOX_SETTINGS),
            lastManifestPath: input.manifestPath,
          },
        }));
        return yield* runAction(
          input.name,
          "creating",
          cli
            .apply({ manifestPath: input.manifestPath, name: input.name })
            .pipe(Effect.tap(() => remember)),
        );
      }),
    listManifests: getSettings.pipe(
      Effect.flatMap((settings) => discoverManifests(settings.manifestRoots)),
      Effect.provide(context),
    ),
    getSettings,
    listManifestRoots: getSettings.pipe(
      Effect.flatMap((settings) => describeManifestRoots(settings.manifestRoots, { fetch: false })),
      Effect.provide(context),
    ),
    // Fetching takes no lock: Git guards its refs, and a slow remote must not hold up a pull.
    refreshManifestRoots: Effect.gen(function* () {
      const next = yield* Deferred.make<ReadonlyArray<AgentctlManifestRoot>>();
      const running = yield* Ref.modify(refreshing, (current) =>
        current === null ? [null, next] : [current, current],
      );
      if (running !== null) return yield* Deferred.await(running);
      yield* getSettings.pipe(
        Effect.flatMap((settings) =>
          describeManifestRoots(settings.manifestRoots, { fetch: true }),
        ),
        Effect.provide(context),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(next, exit)),
        Effect.ensuring(Ref.set(refreshing, null)),
        Effect.forkIn(scope),
      );
      return yield* Deferred.await(next);
    }),
    addManifestRoot: (folder) =>
      Effect.gen(function* () {
        // "/a/" and "/a" are one folder.
        const resolved = path.resolve(folder);
        // Only directories, since a configured folder can be opened with the system handler.
        if (!(yield* isDirectory(resolved))) return yield* getSettings;
        return yield* updateManifestRoots((roots) =>
          roots.some((root) => path.resolve(root) === resolved) ? roots : [...roots, resolved],
        );
      }),
    removeManifestRoot: (folder) =>
      updateManifestRoots((roots) => roots.filter((root) => root !== folder)),
    pullManifestRoots: (folders) =>
      pullLock.withPermits(1)(
        Effect.gen(function* () {
          const settings = yield* getSettings;
          if (folders.some((folder) => !settings.manifestRoots.includes(folder))) {
            return {
              error: "This manifest folder is no longer configured.",
              repositories: [],
            } satisfies AgentctlPullResult;
          }
          return yield* pullManifestRepositories(folders).pipe(
            Effect.provide(context),
            Effect.map((repositories): AgentctlPullResult => ({ error: null, repositories })),
            Effect.catch((error) => Effect.succeed({ error: error.message, repositories: [] })),
          );
        }),
      ),
    markSettingsSeeded: (name, environmentId) =>
      updateStore((document) => {
        const record = document.sandboxes?.[name];
        return record?.environmentId === environmentId
          ? {
              ...document,
              sandboxes: { ...document.sandboxes, [name]: { ...record, settingsSeeded: true } },
            }
          : document;
      }).pipe(Effect.andThen(publish)),
    isManifestRootDirectory: (folder) =>
      getSettings.pipe(
        Effect.flatMap((settings) =>
          settings.manifestRoots.includes(folder) ? isDirectory(folder) : Effect.succeed(false),
        ),
      ),
    startPolling: Ref.getAndSet(polling, true).pipe(
      Effect.flatMap((started) =>
        started ? Effect.void : Effect.forever(pollOnce).pipe(Effect.forkIn(scope), Effect.asVoid),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopAgentctlSandboxes, make).pipe(
  Layer.provide(AgentctlCli.layer),
);
