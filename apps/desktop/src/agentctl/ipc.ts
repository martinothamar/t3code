import {
  AgentctlActionResult,
  AgentctlCreateSandboxInput,
  AgentctlMarkProjectCreatedInput,
  AgentctlSandboxManifest,
  AgentctlSandboxSettings,
  AgentctlSandboxWorkspace,
  AgentctlSandboxesSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { expandHome } from "./manifests.ts";
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

const getWorkspace = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.getWorkspace,
  payload: Schema.String,
  result: AgentctlSandboxWorkspace,
  handler: (name) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.getWorkspace(name)),
});

const markProjectCreated = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.markProjectCreated,
  payload: AgentctlMarkProjectCreatedInput,
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(DesktopAgentctlSandboxes, (sandboxes) => sandboxes.markProjectCreated(input)),
});

const pickEnvFile = DesktopIpc.makeIpcMethod({
  channel: AGENTCTL_CHANNELS.pickEnvFile,
  payload: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.agentctl.pickEnvFile")(function* (current) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const paths = yield* dialog.pickFiles({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: Option.some(
        current === null || current.trim() === ""
          ? environment.homeDirectory
          : expandHome(current.trim(), environment.homeDirectory),
      ),
      multiple: false,
      filters: [],
    });
    return paths[0] ?? null;
  }),
});

export const installAgentctlIpcHandlers = Effect.fn("desktop.ipc.installAgentctlHandlers")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* ipc.handleSync(getSnapshot);
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.start, "start"));
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.stop, "stop"));
    yield* ipc.handle(lifecycle(AGENTCTL_CHANNELS.remove, "remove"));
    yield* ipc.handle(create);
    yield* ipc.handle(listManifests);
    yield* ipc.handle(getSettings);
    yield* ipc.handle(setSettings);
    yield* ipc.handle(getWorkspace);
    yield* ipc.handle(markProjectCreated);
    yield* ipc.handle(pickEnvFile);
  },
);
