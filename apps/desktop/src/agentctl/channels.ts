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
  scanRepositories: "desktop:agentctl-scan-repositories",
  markRepositoriesSeeded: "desktop:agentctl-mark-repositories-seeded",
} as const;
