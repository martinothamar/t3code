import {
  AgentctlActionResult,
  AgentctlCreateSandboxInput,
  AgentctlMarkReposSeededInput,
  AgentctlSandboxManifest,
  AgentctlSandboxRepoScan,
  AgentctlSandboxRepoScanInput,
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

const refresh = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.refresh,
  payload: Schema.Void,
  result: AgentctlSandboxesSnapshot,
  handler: () => Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.refresh),
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

const setSettings = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.setSettings,
  payload: AgentctlSandboxSettings,
  result: AgentctlSandboxSettings,
  handler: (settings) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.setSettings(settings)),
});

const scanRepositories = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.scanRepositories,
  payload: AgentctlSandboxRepoScanInput,
  result: AgentctlSandboxRepoScan,
  handler: (input) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.scanRepositories(input)),
});

const markRepositoriesSeeded = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.markRepositoriesSeeded,
  payload: AgentctlMarkReposSeededInput,
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) =>
      sandboxes.markRepositoriesSeeded(input),
    ),
});

export const installAgentctlIpcHandlers = Effect.fn("desktop.ipc.installAgentctlHandlers")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* ipc.handleSync(getSnapshot);
    yield* ipc.handle(refresh);
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.start, "start"));
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.stop, "stop"));
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.remove, "remove"));
    yield* ipc.handle(create);
    yield* ipc.handle(listManifests);
    yield* ipc.handle(getSettings);
    yield* ipc.handle(setSettings);
    yield* ipc.handle(scanRepositories);
    yield* ipc.handle(markRepositoriesSeeded);
  },
);
