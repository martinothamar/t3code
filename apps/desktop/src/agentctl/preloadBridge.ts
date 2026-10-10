import type { DesktopAgentctlBridge } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import { AGENTCTL_CHANNELS } from "./channels.ts";

export function makeAgentctlBridge(ipcRenderer: IpcRenderer): DesktopAgentctlBridge {
  return {
    getSnapshot: () => ipcRenderer.sendSync(AGENTCTL_CHANNELS.getSnapshot),
    start: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.start, name),
    stop: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.stop, name),
    remove: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.remove, name),
    create: (input) => ipcRenderer.invoke(AGENTCTL_CHANNELS.create, input),
    listManifests: () => ipcRenderer.invoke(AGENTCTL_CHANNELS.listManifests),
    getSettings: () => ipcRenderer.invoke(AGENTCTL_CHANNELS.getSettings),
    setSettings: (settings) => ipcRenderer.invoke(AGENTCTL_CHANNELS.setSettings, settings),
    getWorkspace: (name) => ipcRenderer.invoke(AGENTCTL_CHANNELS.getWorkspace, name),
    markProjectCreated: (input) => ipcRenderer.invoke(AGENTCTL_CHANNELS.markProjectCreated, input),
  };
}
