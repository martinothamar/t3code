// Imported by both desktop main and the preload, so it stays dependency free.
export const AGENTCTL_CHANNELS = {
  getSnapshot: "desktop:agentctl-get-snapshot",
  start: "desktop:agentctl-start",
  stop: "desktop:agentctl-stop",
  remove: "desktop:agentctl-remove",
  create: "desktop:agentctl-create",
  listManifests: "desktop:agentctl-list-manifests",
  getSettings: "desktop:agentctl-get-settings",
  addManifestRoot: "desktop:agentctl-add-manifest-root",
  removeManifestRoot: "desktop:agentctl-remove-manifest-root",
} as const;
