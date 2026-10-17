import {
  AgentctlActionResult,
  AgentctlCreateSandboxInput,
  AgentctlManifestRoot,
  AgentctlPullResult,
  AgentctlSandboxManifest,
  AgentctlSandboxSettings,
  AgentctlSandboxesSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronShell from "../electron/ElectronShell.ts";
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

const pullManifestRoots = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.pullManifestRoots,
  payload: Schema.Array(Schema.String),
  result: AgentctlPullResult,
  handler: (folders) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.pullManifestRoots(folders)),
});

const openManifestRoot = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.openManifestRoot,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.agentctl.openManifestRoot")(function* (folder) {
    const sandboxes = yield* DesktopAgentctlSandboxes;
    // Only configured directories, so the renderer cannot open, and so run, an arbitrary file.
    if (!(yield* sandboxes.isManifestRootDirectory(folder))) return false;
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openPath(folder);
  }),
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

const refreshManifestRoots = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.refreshManifestRoots,
  payload: Schema.Void,
  result: Schema.Array(AgentctlManifestRoot),
  handler: () =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.refreshManifestRoots),
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
    yield* ipc.handle(pullManifestRoots);
    yield* ipc.handle(openManifestRoot);
    yield* ipc.handle(refreshManifestRoots);
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
