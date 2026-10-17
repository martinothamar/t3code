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
    addManifestRoot: (folder) => ipcRenderer.invoke(AGENTCTL_CHANNELS.addManifestRoot, folder),
    removeManifestRoot: (folder) =>
      ipcRenderer.invoke(AGENTCTL_CHANNELS.removeManifestRoot, folder),
    pullManifestRoot: (folder) => ipcRenderer.invoke(AGENTCTL_CHANNELS.pullManifestRoot, folder),
  };
}
