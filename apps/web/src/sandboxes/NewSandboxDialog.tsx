import type {
  AgentctlEnvFileCandidate,
  AgentctlSandboxManifest,
  AgentctlSandboxSettings,
} from "@t3tools/contracts";
import { FolderSearchIcon } from "lucide-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useProjects } from "../state/entities";
import {
  deleteSandbox,
  sandboxStatus,
  sandboxStatusDetail,
  suggestSandboxName,
} from "./sandboxActions";
import { rememberCreatedSandbox } from "./createdSandboxes";
import { readAgentctlBridge } from "./sandboxConnections";
import { refreshSandboxSnapshot, useSandbox, useSandboxes } from "./useSandboxes";

let open = false;
const listeners = new Set<() => void>();

/** Opens the dialog from anywhere: Settings or the command palette. */
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

function manifestLabel(manifest: AgentctlSandboxManifest) {
  const directory = manifest.directory.split(/[\\/]/).at(-1) ?? manifest.directory;
  const name = manifest.agentName ?? directory;
  return manifest.variant === null ? name : `${name} · ${manifest.variant}`;
}

function NewSandboxDialogContent() {
  const sandboxes = useSandboxes();
  const [manifests, setManifests] = useState<ReadonlyArray<AgentctlSandboxManifest> | null>(null);
  const [settings, setSettings] = useState<AgentctlSandboxSettings | null>(null);
  const [manifestPath, setManifestPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [envFile, setEnvFile] = useState("");
  const [envFileEdited, setEnvFileEdited] = useState(false);
  const [envCandidates, setEnvCandidates] = useState<ReadonlyArray<AgentctlEnvFileCandidate>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const created = useSandbox(createdName);
  const projects = useProjects();
  const openThread = useNewThreadHandler();

  const apply = (
    nextManifests: ReadonlyArray<AgentctlSandboxManifest>,
    nextSettings: AgentctlSandboxSettings,
  ) => {
    setManifests(nextManifests);
    setSettings(nextSettings);
    setEnvFile((current) => current || (nextSettings.envFile ?? ""));
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

  // Env files that already set what the manifest needs, so picking one by
  // hand is rarely necessary. The first is filled in until the user types.
  const loadEnvCandidates = useEffectEvent((path: string, isCancelled: () => boolean) => {
    void readAgentctlBridge()
      ?.suggestEnvFiles(path)
      .then((candidates) => {
        if (isCancelled()) return;
        setEnvCandidates(candidates);
        const complete = candidates.find((candidate) => candidate.complete);
        if (!envFileEdited && complete !== undefined) setEnvFile(complete.path);
      })
      .catch(() => undefined);
  });
  useEffect(() => {
    if (manifestPath === null) return;
    let cancelled = false;
    loadEnvCandidates(manifestPath, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [manifestPath]);
  const otherEnvFiles = envCandidates.filter(
    (candidate) => candidate.complete && candidate.path !== envFile.trim(),
  );
  const suggestedName = manifest === null ? "" : suggestSandboxName(manifest.agentName, sandboxes);
  const effectiveName = nameEdited ? name : suggestedName;

  const ready = created !== null && created.phase === "ready" && created.environmentId !== null;
  // The Sandbox's project appears once T3 has connected to it.
  const project =
    created?.environmentId == null
      ? null
      : (projects.find((candidate) => candidate.environmentId === created.environmentId) ?? null);
  const failed =
    created !== null &&
    created.action === null &&
    (created.phase === "failed" || created.actionError !== null);

  const addManifestRoot = async () => {
    const bridge = readAgentctlBridge();
    const folder = await window.desktopBridge?.pickFolder();
    if (!bridge || !folder || settings === null) return;
    const next = await bridge.setSettings({
      ...settings,
      manifestRoots: [...new Set([...settings.manifestRoots, folder])],
    });
    setSettings(next);
    const loaded = await load();
    if (loaded !== null) apply(...loaded);
  };

  const create = async () => {
    const bridge = readAgentctlBridge();
    if (bridge === null || manifest === null) return;
    setSubmitting(true);
    setError(null);
    const trimmedEnvFile = envFile.trim();
    const result = await bridge.create({
      manifestPath: manifest.path,
      name: effectiveName.trim(),
      envFile: trimmedEnvFile === "" ? null : trimmedEnvFile,
    });
    setSubmitting(false);
    refreshSandboxSnapshot();
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    rememberCreatedSandbox(effectiveName.trim());
    setCreatedName(effectiveName.trim());
  };

  if (createdName !== null) {
    const status = created === null ? null : sandboxStatus(created);
    const detail = created === null ? null : sandboxStatusDetail(created);
    return (
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{createdName}</DialogTitle>
          <DialogDescription>
            {ready
              ? "The Sandbox is running. Its project is its working directory."
              : failed
                ? "The Sandbox could not be set up."
                : "Setting up the Sandbox. You can close this; it keeps going."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-start gap-2 text-sm">
            {!ready && !failed ? <Spinner className="mt-0.5 size-4 shrink-0" /> : null}
            <div className="min-w-0">
              <div className="font-medium">
                {ready ? "Ready" : (status?.label ?? "Waiting for agentctl…")}
              </div>
              {detail ? (
                <div className="break-words text-muted-foreground text-xs">{detail}</div>
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {failed && created !== null ? (
            <Button variant="destructive-outline" onClick={() => void deleteSandbox(created)}>
              Delete Sandbox
            </Button>
          ) : null}
          <Button variant="outline" onClick={closeNewSandboxDialog}>
            Close
          </Button>
          {ready ? (
            <Button
              disabled={project === null}
              onClick={() => {
                if (project === null) return;
                closeNewSandboxDialog();
                void openThread(scopeProjectRef(project.environmentId, project.id));
              }}
            >
              {project === null ? "Connecting…" : "New thread"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    );
  }

  const browseEnvFile = async () => {
    const picked = await readAgentctlBridge()?.pickEnvFile(envFile.trim() || null);
    if (picked) {
      setEnvFileEdited(true);
      setEnvFile(picked);
    }
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
          <div className="grid gap-1.5">
            <Label>Manifest</Label>
            {manifests === null ? (
              <div className="text-muted-foreground text-sm">Looking for manifests…</div>
            ) : manifests.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                No agent.yaml manifests in {settings?.manifestRoots.join(", ")}.
              </div>
            ) : (
              <Select value={manifestPath} onValueChange={(value) => setManifestPath(value)}>
                <SelectTrigger aria-label="Manifest">
                  <SelectValue>
                    {manifest ? manifestLabel(manifest) : "Choose a manifest"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {manifests.map((candidate) => (
                    <SelectItem key={candidate.path} value={candidate.path}>
                      <span className="flex min-w-0 flex-col">
                        <span>{manifestLabel(candidate)}</span>
                        <span className="truncate text-muted-foreground text-xs">
                          {candidate.path}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
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
          <div className="grid gap-1.5">
            <Label htmlFor="new-sandbox-env-file">Env file</Label>
            <div className="flex gap-2">
              <Input
                id="new-sandbox-env-file"
                className="flex-1"
                value={envFile}
                placeholder=".env beside the manifest"
                onChange={(event) => {
                  setEnvFileEdited(true);
                  setEnvFile(event.target.value);
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="button" variant="outline" onClick={() => void browseEnvFile()}>
                Browse…
              </Button>
            </div>
            {otherEnvFiles.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
                <span>Also complete:</span>
                {otherEnvFiles.map((candidate) => (
                  <Button
                    key={candidate.path}
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => {
                      setEnvFileEdited(true);
                      setEnvFile(candidate.path);
                    }}
                  >
                    {candidate.path}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="text-muted-foreground text-xs">
              Values for the manifest's environment and secrets. Files beside the manifest and in
              your home folder that set them all are filled in for you.
            </div>
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
