import type { AgentctlSandboxManifest, AgentctlSandboxSettings } from "@t3tools/contracts";
import { FolderSearchIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { rememberCreatedSandbox } from "./createdSandboxes";
import { ManifestPicker } from "./ManifestPicker";
import { suggestSandboxName } from "./sandboxActions";
import { readAgentctlBridge } from "./sandboxConnections";
import { refreshSandboxSnapshot, useSandboxes } from "./useSandboxes";

let open = false;
const listeners = new Set<() => void>();

/** Opens the dialog from anywhere: the sidebar, the Sandboxes page or the command palette. */
export function openNewSandboxDialog() {
  open = true;
  for (const listener of listeners) listener();
}

function closeNewSandboxDialog() {
  open = false;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function NewSandboxDialogHost() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  if (readAgentctlBridge() === null) return null;
  return (
    <Dialog open={isOpen} onOpenChange={(next) => (next ? null : closeNewSandboxDialog())}>
      {isOpen ? <NewSandboxDialogContent /> : null}
    </Dialog>
  );
}

function NewSandboxDialogContent() {
  const sandboxes = useSandboxes();
  const [manifests, setManifests] = useState<ReadonlyArray<AgentctlSandboxManifest> | null>(null);
  const [settings, setSettings] = useState<AgentctlSandboxSettings | null>(null);
  const [manifestPath, setManifestPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (
    nextManifests: ReadonlyArray<AgentctlSandboxManifest>,
    nextSettings: AgentctlSandboxSettings,
  ) => {
    setManifests(nextManifests);
    setSettings(nextSettings);
    // The manifest of the last Sandbox comes first, so "another one" is one click.
    setManifestPath(
      (current) =>
        current ??
        nextManifests.find((candidate) => candidate.path === nextSettings.lastManifestPath)?.path ??
        nextManifests[0]?.path ??
        null,
    );
  };
  const load = () => {
    const bridge = readAgentctlBridge();
    if (bridge === null) return Promise.resolve(null);
    return Promise.all([bridge.listManifests(), bridge.getSettings()]).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    });
  };

  const loadInitial = useEffectEvent((isCancelled: () => boolean) => {
    void load().then((loaded) => {
      if (loaded !== null && !isCancelled()) apply(...loaded);
    });
  });

  // Loads once when the dialog opens; adding a folder reloads explicitly.
  useEffect(() => {
    let cancelled = false;
    loadInitial(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  const manifest = manifests?.find((candidate) => candidate.path === manifestPath) ?? null;

  const suggestedName = manifest === null ? "" : suggestSandboxName(manifest.agentName, sandboxes);
  const effectiveName = nameEdited ? name : suggestedName;

  const addManifestRoot = async () => {
    const bridge = readAgentctlBridge();
    const folder = await window.desktopBridge?.pickFolder();
    if (!bridge || !folder) return;
    await bridge.addManifestRoot(folder);
    const loaded = await load();
    if (loaded !== null) apply(...loaded);
  };

  const create = async () => {
    const bridge = readAgentctlBridge();
    if (bridge === null || manifest === null) return;
    setSubmitting(true);
    setError(null);
    const result = await bridge.create({
      manifestPath: manifest.path,
      name: effectiveName.trim(),
    });
    setSubmitting(false);
    refreshSandboxSnapshot();
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    // The sidebar shows its progress from here, so there is nothing to wait for.
    rememberCreatedSandbox(effectiveName.trim());
    closeNewSandboxDialog();
  };

  // Without a manifest folder there is nothing to choose from yet, so that comes first.
  if (settings !== null && settings.manifestRoots.length === 0) {
    return (
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Sandbox</DialogTitle>
          <DialogDescription>
            Choose a folder with agentctl manifests, such as a repository with an agents folder. T3
            Code finds every agent.yaml and agent.&lt;variant&gt;.yaml in it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={closeNewSandboxDialog}>
            Cancel
          </Button>
          <Button onClick={() => void addManifestRoot()}>
            <FolderSearchIcon className="size-4" />
            Choose folder…
          </Button>
        </DialogFooter>
      </DialogPopup>
    );
  }

  return (
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle>New Sandbox</DialogTitle>
        <DialogDescription>
          Applies an agentctl manifest and connects to the Sandbox when it is ready.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {manifests === null ? (
            <div className="text-muted-foreground text-sm">Looking for manifests…</div>
          ) : manifests.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              No agent.yaml manifests in {settings?.manifestRoots.join(", ")}.
            </div>
          ) : (
            <ManifestPicker
              manifests={manifests}
              value={manifest}
              onValueChange={(next) => setManifestPath(next.path)}
            />
          )}
          <div>
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => void addManifestRoot()}
            >
              <FolderSearchIcon className="size-3" />
              Add manifest folder
            </Button>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-sandbox-name">Name</Label>
            <Input
              id="new-sandbox-name"
              value={effectiveName}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {error ? <div className="break-words text-destructive text-sm">{error}</div> : null}
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={closeNewSandboxDialog}>
          Cancel
        </Button>
        <Button
          onClick={() => void create()}
          disabled={submitting || manifest === null || effectiveName.trim() === ""}
        >
          {submitting ? "Applying…" : "Create Sandbox"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
