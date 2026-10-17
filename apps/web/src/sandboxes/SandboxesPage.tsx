import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, type AgentctlSandbox, type AgentctlManifestRoot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  DownloadIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { sortThreads } from "../lib/threadSort";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironmentPresentation } from "../state/presentation";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { openNewSandboxDialog } from "./NewSandboxDialog";
import {
  canDeleteSandbox,
  canStartSandbox,
  canStopSandbox,
  deleteSandbox,
  sandboxStatus,
  sandboxStatusDetail,
  startSandbox,
  stopSandbox,
  type SandboxTone,
} from "./sandboxActions";
import { folderName, pullToast, repositoryBadges, tildePath } from "./manifestFolders";
import { readAgentctlBridge } from "./sandboxConnections";
import { useSandboxSnapshot } from "./useSandboxes";

const TONE_VARIANT = {
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const satisfies Record<SandboxTone, string>;

// The most recent threads each Sandbox lists; the sidebar has the rest.
const RECENT_THREADS = 3;

/** Manages agentctl Sandboxes and where new ones come from, opened from the sidebar footer. */
export function SandboxesPage() {
  const snapshot = useSandboxSnapshot();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Sandboxes breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Sandboxes</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {readAgentctlBridge() === null ? (
              <p className="text-muted-foreground text-sm">
                agentctl Sandboxes are available in the desktop app.
              </p>
            ) : snapshot.status === "unavailable" ? (
              <SettingsSection title="agentctl">
                <SettingsRow
                  title="agentctl is not available"
                  description={snapshot.error ?? "Install agentctl to run agents in Sandboxes."}
                />
              </SettingsSection>
            ) : snapshot.status === "loading" ? (
              <p className="text-muted-foreground text-sm">Looking for Sandboxes…</p>
            ) : (
              <>
                <SettingsSection
                  title="Sandboxes"
                  headerAction={
                    <Button size="xs" variant="ghost-muted" onClick={() => openNewSandboxDialog()}>
                      <PlusIcon className="size-3" />
                      New Sandbox
                    </Button>
                  }
                >
                  {snapshot.error !== null ? (
                    // The Sandboxes below are as agentctl last reported them.
                    <SettingsRow title="agentctl is not responding" description={snapshot.error} />
                  ) : null}
                  {snapshot.sandboxes.length === 0 ? (
                    <SettingsRow
                      title="No Sandboxes"
                      description="Create one from a manifest, or with agentctl apply."
                    />
                  ) : (
                    snapshot.sandboxes.map((sandbox) => (
                      <SandboxRow
                        key={sandbox.name}
                        sandbox={sandbox}
                        homeDirectory={snapshot.homeDirectory}
                      />
                    ))
                  )}
                </SettingsSection>
                <ManifestFolders homeDirectory={snapshot.homeDirectory} />
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** "4 CPUs · 6Gi memory · 32Gi disk · mediated network", from the manifest. */
function specLine(sandbox: AgentctlSandbox): string | null {
  const parts = [
    sandbox.cpu === null ? null : `${sandbox.cpu} ${sandbox.cpu === "1" ? "CPU" : "CPUs"}`,
    sandbox.memory === null ? null : `${sandbox.memory} memory`,
    sandbox.disk === null ? null : `${sandbox.disk} disk`,
    sandbox.network === null ? null : `${sandbox.network} network`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

function SandboxRow({
  sandbox,
  homeDirectory,
}: {
  readonly sandbox: AgentctlSandbox;
  readonly homeDirectory: string;
}) {
  const environmentId =
    sandbox.environmentId === null ? null : EnvironmentId.make(sandbox.environmentId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const projects = useProjects();
  const allThreads = useThreadShells();
  const openThread = useNewThreadHandler();
  const threads = useMemo(
    () =>
      sortThreads(
        allThreads.filter(
          (thread) => thread.environmentId === environmentId && thread.archivedAt === null,
        ),
        "updated_at",
      ),
    [allThreads, environmentId],
  );
  const running = threads.filter((thread) => threadRuntimeIsActive(thread.runtime)).length;
  const project =
    environmentId === null
      ? null
      : (projects.find((candidate) => candidate.environmentId === environmentId) ?? null);
  const status = sandboxStatus(sandbox);
  const detail = sandboxStatusDetail(sandbox);
  const connection =
    sandbox.phase === "ready" && presentation !== null
      ? connectionStatusText(presentation.connection)
      : null;
  const since = sandbox.since === null ? null : formatRelativeTimeLabel(sandbox.since);
  const threadSummary =
    threads.length === 0
      ? "No threads"
      : `${threads.length} ${threads.length === 1 ? "thread" : "threads"}${running > 0 ? `, ${running} running` : ""}`;

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{sandbox.name}</span>
          <Badge variant={TONE_VARIANT[status.tone]} size="sm">
            {status.label}
          </Badge>
          {sandbox.variant ? (
            <span className="text-muted-foreground text-xs">{sandbox.variant}</span>
          ) : null}
        </span>
      }
      description={
        <span className="flex min-w-0 flex-col gap-0.5">
          {[detail, connection, since ? `Changed ${since}` : null]
            .filter((part) => part !== null && part !== "")
            .join(" · ") || null}
          {specLine(sandbox) ? <span>{specLine(sandbox)}</span> : null}
          {sandbox.manifestPath ? (
            <span className="truncate font-mono text-xs">
              {tildePath(sandbox.manifestPath, homeDirectory)}
            </span>
          ) : null}
          <span>{threadSummary}</span>
          {threads.slice(0, RECENT_THREADS).map((thread) => (
            <Link
              key={thread.id}
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
              className="truncate text-foreground hover:underline"
            >
              {thread.title}
            </Link>
          ))}
        </span>
      }
      control={
        <div className="flex shrink-0 items-center gap-1">
          {project !== null && sandbox.phase === "ready" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void openThread(scopeProjectRef(project.environmentId, project.id))}
            >
              New thread
            </Button>
          ) : null}
          {canStartSandbox(sandbox) ? (
            <Button size="xs" variant="outline" onClick={() => void startSandbox(sandbox.name)}>
              Start
            </Button>
          ) : null}
          {canStopSandbox(sandbox) ? (
            <Button size="xs" variant="ghost-muted" onClick={() => void stopSandbox(sandbox)}>
              Stop
            </Button>
          ) : null}
          {canDeleteSandbox(sandbox) ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              onClick={() => void deleteSandbox(sandbox)}
            >
              Delete
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

/** Where "New Sandbox" looks for manifests, and whether their repositories are current. */
function ManifestFolders({ homeDirectory }: { homeDirectory: string }) {
  const [roots, setRoots] = useState<ReadonlyArray<AgentctlManifestRoot> | null>(null);
  // The folders being pulled, so their rows show it and nothing pulls twice.
  const [pulling, setPulling] = useState<ReadonlyArray<string>>([]);
  // Bumped by every read, so a slow fetch cannot overwrite a newer add or remove.
  const generation = useRef(0);
  const load = (read: Promise<ReadonlyArray<AgentctlManifestRoot>>) => {
    const current = ++generation.current;
    return read.then(
      (next) => {
        if (generation.current === current) setRoots(next);
      },
      () => undefined,
    );
  };

  useEffect(() => {
    const bridge = readAgentctlBridge();
    if (bridge === null) return;
    // Local state first, then again once each repository has fetched; the fetch
    // is ignored if the list changed meanwhile or the page closed.
    void bridge
      .listManifestRoots()
      .then((next) => setRoots((current) => current ?? next))
      .catch(() => undefined);
    const current = ++generation.current;
    void bridge.refreshManifestRoots().then(
      (next) => {
        if (generation.current === current) setRoots(next);
      },
      () => undefined,
    );
    return () => {
      generation.current += 1;
    };
  }, []);

  if (roots === null) return null;
  const addRoot = async () => {
    const folder = await window.desktopBridge?.pickFolder();
    if (!folder) return;
    const bridge = readAgentctlBridge();
    if (bridge === null) return;
    await bridge.addManifestRoot(folder);
    await load(bridge.listManifestRoots());
  };
  const removeRoot = async (folder: string) => {
    const bridge = readAgentctlBridge();
    if (bridge === null) return;
    await bridge.removeManifestRoot(folder);
    await load(bridge.listManifestRoots());
  };
  const pullRoots = async (folders: ReadonlyArray<string>) => {
    const bridge = readAgentctlBridge();
    if (bridge === null || pulling.length > 0) return;
    setPulling(folders);
    try {
      toastManager.add(stackedThreadToast(pullToast(await bridge.pullManifestRoots(folders))));
    } catch {
      toastManager.add(stackedThreadToast({ type: "error", title: "Could not pull repositories" }));
    } finally {
      await load(bridge.listManifestRoots());
      setPulling([]);
    }
  };
  const openRoot = async (folder: string) => {
    const opened = await readAgentctlBridge()
      ?.openManifestRoot(folder)
      .catch(() => false);
    if (!opened) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Could not open folder", description: folder }),
      );
    }
  };
  const pullable = roots
    .filter((root) => root.repositories.length > 0)
    .map((root) => root.directory);

  return (
    <SettingsSection
      title="Manifest folders"
      headerAction={
        <span className="flex items-center gap-1">
          {pullable.length > 1 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pulling.length > 0}
              onClick={() => void pullRoots(pullable)}
            >
              <DownloadIcon className="size-3" />
              {pulling.length > 1 ? "Pulling…" : "Pull all"}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={() => void addRoot()}>
            <FolderPlusIcon className="size-3" />
            Add folder
          </Button>
        </span>
      }
    >
      {roots.length === 0 ? (
        <SettingsRow
          title="No folders yet"
          description="New Sandbox finds every agent.yaml and agent.<variant>.yaml in these folders."
        />
      ) : (
        roots.map((root) => (
          <ManifestFolderRow
            key={root.directory}
            root={root}
            homeDirectory={homeDirectory}
            pulling={pulling.includes(root.directory)}
            busy={pulling.length > 0}
            onPull={() => void pullRoots([root.directory])}
            onOpen={() => void openRoot(root.directory)}
            onRemove={() => void removeRoot(root.directory)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ManifestFolderRow({
  root,
  homeDirectory,
  pulling,
  busy,
  onPull,
  onOpen,
  onRemove,
}: {
  root: AgentctlManifestRoot;
  homeDirectory: string;
  pulling: boolean;
  busy: boolean;
  onPull: () => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const path = tildePath(root.directory, homeDirectory);
  const Icon = root.repositories.length > 0 ? FolderGit2Icon : FolderIcon;
  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{folderName(root.directory)}</span>
          {!root.exists ? (
            <Badge variant="error" size="sm">
              Not found
            </Badge>
          ) : root.manifests === 0 ? (
            <Badge variant="warning" size="sm">
              No manifests
            </Badge>
          ) : (
            <span className="shrink-0 text-muted-foreground text-xs">
              {root.manifests} {root.manifests === 1 ? "manifest" : "manifests"}
            </span>
          )}
        </span>
      }
      description={
        <span className="flex min-w-0 flex-col gap-1">
          <span className="break-all font-mono text-xs">{path}</span>
          {root.repositories.map((repository) => (
            <span key={repository.path} className="flex flex-wrap items-center gap-1.5 text-xs">
              {/* Name the checkout when it is not the folder itself. */}
              {repository.path !== root.directory && root.repositories.length > 1 ? (
                <span className="font-medium text-foreground">{folderName(repository.path)}</span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <GitBranchIcon className="size-3" />
                {repository.branch ?? "detached"}
              </span>
              {repositoryBadges(repository).map((badge) => (
                <Badge
                  key={badge.label}
                  variant={TONE_VARIANT[badge.tone]}
                  size="sm"
                  title={badge.title}
                >
                  {badge.label}
                </Badge>
              ))}
            </span>
          ))}
        </span>
      }
      control={
        <div className="flex shrink-0 items-center gap-1">
          {root.repositories.length > 0 ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Pull repositories in ${path}`}
              disabled={busy}
              onClick={onPull}
            >
              <DownloadIcon className="size-3" />
              {pulling ? "Pulling…" : "Pull"}
            </Button>
          ) : null}
          {root.exists ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Open ${path}`}
              title="Open folder"
              onClick={onOpen}
            >
              <FolderOpenIcon className="size-3" />
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Remove ${path}`}
            title="Remove folder"
            disabled={pulling}
            onClick={onRemove}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      }
    />
  );
}
