import type { AgentctlSandboxesSnapshot, DesktopAgentctlBridge } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import { AGENTCTL_CHANNELS } from "./channels.ts";

const UNAVAILABLE: AgentctlSandboxesSnapshot = {
  status: "unavailable",
  error: null,
  sandboxes: [],
};

export function makeAgentctlBridge(ipcRenderer: IpcRenderer): DesktopAgentctlBridge {
  return {
    getSnapshot: () => {
      const result: unknown = ipcRenderer.sendSync(AGENTCTL_CHANNELS.getSnapshot);
      return typeof result === "object" && result !== null
        ? (result as AgentctlSandboxesSnapshot)
        : UNAVAILABLE;
    },
    start: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.start, name),
    stop: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.stop, name),
    remove: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.remove, name),
    create: (input) => ipcRenderer.invoke(AGENTCTL_CHANNELS.create, input),
    listManifests: () => ipcRenderer.invoke(AGENTCTL_CHANNELS.listManifests),
    getSettings: () => ipcRenderer.invoke(AGENTCTL_CHANNELS.getSettings),
    setSettings: (settings) => ipcRenderer.invoke(AGENTCTL_CHANNELS.setSettings, settings),
    getWorkspace: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.getWorkspace, name),
    markProjectCreated: (input) => ipcRenderer.invoke(AGENTCTL_CHANNELS.markProjectCreated, input),
    pickEnvFile: (current) => ipcRenderer.invoke(AGENTCTL_CHANNELS.pickEnvFile, current),
    suggestEnvFiles: (manifestPath) =>
      ipcRenderer.invoke(AGENTCTL_CHANNELS.suggestEnvFiles, manifestPath),
  };
}
