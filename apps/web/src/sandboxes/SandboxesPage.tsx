import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type AgentctlSandbox,
  type AgentctlSandboxSettings,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FolderPlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
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
  const available = snapshot.status === "available";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Sandboxes breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Sandboxes</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            {available ? (
              <Button size="xs" variant="outline" onClick={() => openNewSandboxDialog()}>
                <PlusIcon className="size-3" />
                New Sandbox
              </Button>
            ) : null}
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
                <SettingsSection title="Sandboxes">
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
                      <SandboxRow key={sandbox.name} sandbox={sandbox} />
                    ))
                  )}
                </SettingsSection>
                <ManifestFolders />
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

function SandboxRow({ sandbox }: { readonly sandbox: AgentctlSandbox }) {
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
            <span className="truncate font-mono text-xs">{sandbox.manifestPath}</span>
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

/** Where "New Sandbox" looks for manifests. */
function ManifestFolders() {
  const [settings, setSettings] = useState<AgentctlSandboxSettings | null>(null);

  useEffect(() => {
    void readAgentctlBridge()
      ?.getSettings()
      .then((next) => {
        setSettings(next);
      });
  }, []);

  if (settings === null) return null;
  const addRoot = async () => {
    const folder = await window.desktopBridge?.pickFolder();
    if (!folder) return;
    const saved = await readAgentctlBridge()?.addManifestRoot(folder);
    if (saved) setSettings(saved);
  };
  const removeRoot = async (folder: string) => {
    const saved = await readAgentctlBridge()?.removeManifestRoot(folder);
    if (saved) setSettings(saved);
  };

  return (
    <SettingsSection
      title="Manifest folders"
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={() => void addRoot()}>
          <FolderPlusIcon className="size-3" />
          Add folder
        </Button>
      }
    >
      {settings.manifestRoots.length === 0 ? (
        <SettingsRow
          title="No folders yet"
          description="New Sandbox finds every agent.yaml and agent.<variant>.yaml in these folders."
        />
      ) : (
        settings.manifestRoots.map((root) => (
          <SettingsRow
            key={root}
            title={<span className="truncate font-mono text-xs">{root}</span>}
            control={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${root}`}
                onClick={() => void removeRoot(root)}
              >
                <XIcon className="size-3" />
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
