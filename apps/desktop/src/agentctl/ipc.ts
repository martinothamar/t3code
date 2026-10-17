import {
  AgentctlActionResult,
  AgentctlCreateSandboxInput,
  AgentctlManifestRoot,
  AgentctlSandboxManifest,
  AgentctlSandboxSettings,
  AgentctlSandboxesSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { AGENTCTL_CHANNELS } from "./channels.ts";
import { DesktopAgentctlSandboxes } from "./DesktopAgentctlSandboxes.ts";

const getSnapshot = DesktopIpc.makeSyncIpcMethod({
  channel: AGENTCTL_CHANNELS.getSnapshot,
  result: AgentctlSandboxesSnapshot,
  handler: () => Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.snapshot),
});

const lifecycle = (channel: string, run: "start" | "stop" | "remove") =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: Schema.String,
    result: AgentctlActionResult,
    handler: (name) =>
      Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes[run](name)),
  });

const create = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.create,
  payload: AgentctlCreateSandboxInput,
  result: AgentctlActionResult,
  handler: (input) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.create(input)),
});

const pullManifestRoot = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.pullManifestRoot,
  payload: Schema.String,
  result: AgentctlActionResult,
  handler: (folder) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.pullManifestRoot(folder)),
});

const listManifests = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.listManifests,
  payload: Schema.Void,
  result: Schema.Array(AgentctlSandboxManifest),
  handler: () => Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.listManifests),
});

const getSettings = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.getSettings,
  payload: Schema.Void,
  result: AgentctlSandboxSettings,
  handler: () => Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.getSettings),
});

const listManifestRoots = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.listManifestRoots,
  payload: Schema.Void,
  result: Schema.Array(AgentctlManifestRoot),
  handler: () =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.listManifestRoots),
});

const manifestRoot = (channel: string, run: "addManifestRoot" | "removeManifestRoot") =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: Schema.String,
    result: AgentctlSandboxSettings,
    handler: (folder) =>
      Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes[run](folder)),
  });

export const installAgentctlIpcHandlers = Effect.fn("desktop.ipc.installAgentctlHandlers")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* ipc.handleSync(getSnapshot);
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.start, "start"));
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.stop, "stop"));
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.remove, "remove"));
    yield* ipc.handle(create);
    yield* ipc.handle(pullManifestRoot);
    yield* ipc.handle(listManifests);
    yield* ipc.handle(listManifestRoots);
    yield* ipc.handle(getSettings);
    yield* ipc.handle(manifestRoot(AGENTCTL_CHANNELS.addManifestRoot, "addManifestRoot"));
    yield* ipc.handle(manifestRoot(AGENTCTL_CHANNELS.removeManifestRoot, "removeManifestRoot"));
    // Polling starts with the handlers that read it, after startup has loaded
    // the shell environment.
    const sandboxes = yield* DesktopAgentctlSandboxes;
    yield* sandboxes.startPolling;
  },
);
