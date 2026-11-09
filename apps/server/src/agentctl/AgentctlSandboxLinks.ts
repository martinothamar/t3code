import type { AgentctlSandbox, AgentctlSandboxesSnapshot, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";

// While the Linked environments beta is on here, links this server to each Sandbox it reaches,
// supervised, so its agents can hand them work. A Sandbox answers at its SSH forward, which moves
// on every reconnect, so a reconnect moves the link there instead of pairing again. A deleted or
// recreated Sandbox's link is forgotten.

const SANDBOX_LINK_ACCESS = "approval-required";

const runningSandboxes = (snapshot: AgentctlSandboxesSnapshot) =>
  snapshot.sandboxes.flatMap((sandbox: AgentctlSandbox) =>
    sandbox.phase === "ready" && sandbox.action === null && sandbox.environmentId !== null
      ? [{ name: sandbox.name, environmentId: sandbox.environmentId }]
      : [],
  );

/** What a snapshot says that matters here, so provisioning progress does not link again. */
const linkState = (snapshot: AgentctlSandboxesSnapshot) =>
  [
    snapshot.status,
    ...snapshot.sandboxes.map(
      (sandbox) =>
        `${sandbox.name}:${sandbox.environmentId}:${sandbox.phase}:${sandbox.action}:${sandbox.settingsSeeded}`,
    ),
  ].join("\n");

/** The environments a listing no longer has under the name it had them, whose links can go. */
function goneEnvironments(
  previous: ReadonlyMap<string, EnvironmentId>,
  current: ReadonlyMap<string, EnvironmentId>,
): ReadonlyArray<EnvironmentId> {
  return [...previous].flatMap(([name, environmentId]) =>
    current.get(name) === environmentId ? [] : [environmentId],
  );
}

const make = Effect.gen(function* () {
  const sandboxes = yield* AgentctlSandboxes.AgentctlSandboxes;
  const links = yield* PeerLinks.PeerLinks;
  const settings = yield* ServerSettings.ServerSettingsService;
  // A reconnect and a listing can both ask for the same Sandbox; one pairing is enough.
  const lock = yield* Semaphore.make(1);
  const known = yield* Ref.make<ReadonlyMap<string, EnvironmentId>>(new Map());

  const ensureLink = Effect.fn("AgentctlSandboxLinks.ensureLink")(
    function* ({ name, environmentId, httpBaseUrl }: AgentctlSandboxes.SandboxReached) {
      const existing = yield* links.get(environmentId);
      const now = yield* DateTime.now;
      if (Option.isSome(existing) && DateTime.isGreaterThan(existing.value.expiresAt, now)) {
        if (!existing.value.urls.includes(new URL(httpBaseUrl).origin)) {
          yield* links.relocate(environmentId, [httpBaseUrl]);
        }
        return;
      }
      const pairing = yield* sandboxes.pair(name);
      // Recreated since it was reached; reaching the new one links that.
      if (pairing.environmentId !== environmentId) return;
      yield* links.link({
        url: httpBaseUrl,
        pairingCode: pairing.pairingToken,
        access: SANDBOX_LINK_ACCESS,
        expectedEnvironmentId: environmentId,
        expectedLabel: name,
      });
      yield* Effect.logInfo("Linked an agentctl Sandbox.", { name, environmentId });
    },
    (effect, { name }) =>
      effect.pipe(
        lock.withPermits(1),
        // Refused while the Sandbox has the beta off; its settings seed changes the listing,
        // which tries again.
        Effect.catch((error) =>
          Effect.logInfo("Could not link an agentctl Sandbox.", { name, error: error.message }),
        ),
      ),
  );

  const onSnapshot = Effect.fn("AgentctlSandboxLinks.onSnapshot")(function* (
    snapshot: AgentctlSandboxesSnapshot,
  ) {
    // A listing that failed keeps its last Sandboxes, so only a fresh one can show one gone.
    if (snapshot.status === "available") {
      const current = new Map(
        snapshot.sandboxes.flatMap((sandbox) =>
          sandbox.environmentId === null ? [] : [[sandbox.name, sandbox.environmentId] as const],
        ),
      );
      const previous = yield* Ref.getAndSet(known, current);
      yield* Effect.forEach(
        goneEnvironments(previous, current),
        (environmentId) => links.unlink(environmentId).pipe(Effect.ignoreCause({ log: true })),
        { discard: true },
      );
    }
    yield* Effect.forEach(
      runningSandboxes(snapshot),
      ({ name, environmentId }) =>
        sandboxes.relayUpstream(name).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (httpBaseUrl) => ensureLink({ name, environmentId, httpBaseUrl }),
            }),
          ),
        ),
      { discard: true },
    );
  });

  const settingsChanges = yield* settings.subscribeChanges;
  const enabled = yield* links.enabled;
  yield* Stream.concat(
    Stream.make(enabled),
    settingsChanges.pipe(Stream.map((current) => current.linkedEnvironmentsEnabled)),
  ).pipe(
    Stream.changes,
    // Following the Sandboxes starts watching agentctl, so only while there is something to link.
    Stream.switchMap((on) =>
      on
        ? Stream.merge(
            sandboxes.changes.pipe(
              Stream.changesWith((left, right) => linkState(left) === linkState(right)),
              Stream.mapEffect(onSnapshot),
            ),
            sandboxes.reached.pipe(Stream.mapEffect(ensureLink)),
          )
        : Stream.empty,
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
