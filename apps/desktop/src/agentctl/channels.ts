// Imported by both desktop main and the preload, so it stays dependency free.
export const AGENTCTL_CHANNELS = {
  getSnapshot: "desktop:agentctl-get-snapshot",
  start: "desktop:agentctl-start",
  stop: "desktop:agentctl-stop",
  remove: "desktop:agentctl-remove",
  create: "desktop:agentctl-create",
  listManifests: "desktop:agentctl-list-manifests",
  listManifestRoots: "desktop:agentctl-list-manifest-roots",
  getSettings: "desktop:agentctl-get-settings",
  addManifestRoot: "desktop:agentctl-add-manifest-root",
  removeManifestRoot: "desktop:agentctl-remove-manifest-root",
  refreshManifestRoots: "desktop:agentctl-refresh-manifest-roots",
  pullManifestRoots: "desktop:agentctl-pull-manifest-roots",
  openManifestRoot: "desktop:agentctl-open-manifest-root",
} as const;
