// Imported by both desktop main and the preload, so it stays dependency free.
export const AGENTCTL_CHANNELS = {
  getSnapshot: "desktop:agentctl-get-snapshot",
  refresh: "desktop:agentctl-refresh",
  start: "desktop:agentctl-start",
  stop: "desktop:agentctl-stop",
  remove: "desktop:agentctl-remove",
  create: "desktop:agentctl-create",
  listManifests: "desktop:agentctl-list-manifests",
  getSettings: "desktop:agentctl-get-settings",
  setSettings: "desktop:agentctl-set-settings",
  getWorkspace: "desktop:agentctl-get-workspace",
  markProjectCreated: "desktop:agentctl-mark-project-created",
} as const;
