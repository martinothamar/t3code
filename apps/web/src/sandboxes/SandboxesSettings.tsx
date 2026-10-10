import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type AgentctlSandbox,
  type AgentctlSandboxSettings,
} from "@t3tools/contracts";
import { FolderPlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useEnvironmentPresentation } from "../state/presentation";
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
import { runningLabel, useRunningThreadCounts } from "./sandboxActivity";
import { readAgentctlBridge } from "./sandboxConnections";
import { useSandboxProjectSeeding } from "./sandboxProjects";
import { useSandboxSnapshot } from "./useSandboxes";

const TONE_VARIANT = {
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const satisfies Record<SandboxTone, string>;

/** Lists agentctl Sandboxes with their lifecycle, on desktop builds that have agentctl. */
export function SandboxesSettings() {
  const snapshot = useSandboxSnapshot();
  if (readAgentctlBridge() === null) return null;

  return (
    <SettingsSection
      {...searchableSetting("agentctl-sandboxes")}
      title="agentctl Sandboxes"
      headerAction={
        snapshot.status === "available" ? (
          <Button size="xs" variant="ghost-muted" onClick={() => openNewSandboxDialog()}>
            <PlusIcon className="size-3" />
            <span>New Sandbox</span>
          </Button>
        ) : null
      }
    >
      {snapshot.status === "unavailable" ? (
        <SettingsRow
          title="agentctl is not available"
          description={snapshot.error ?? "Install agentctl to run agents in Sandboxes."}
        />
      ) : snapshot.status === "loading" ? (
        <SettingsRow title="Looking for Sandboxes…" />
      ) : snapshot.sandboxes.length === 0 ? (
        <SettingsRow
          title="No Sandboxes"
          description="Create one from a manifest, or with agentctl apply."
        />
      ) : (
        <SandboxRows sandboxes={snapshot.sandboxes} />
      )}
      {snapshot.status === "available" ? <SandboxManifestSettings /> : null}
    </SettingsSection>
  );
}

function SandboxRows({ sandboxes }: { readonly sandboxes: ReadonlyArray<AgentctlSandbox> }) {
  const running = useRunningThreadCounts();
  return sandboxes.map((sandbox) => (
    <SandboxRow
      key={sandbox.name}
      sandbox={sandbox}
      running={
        sandbox.environmentId === null
          ? 0
          : (running.get(EnvironmentId.make(sandbox.environmentId)) ?? 0)
      }
    />
  ));
}

function SandboxRow({
  sandbox,
  running,
}: {
  readonly sandbox: AgentctlSandbox;
  readonly running: number;
}) {
  const environmentId =
    sandbox.environmentId === null ? null : EnvironmentId.make(sandbox.environmentId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const seed = useSandboxProjectSeeding();
  const [rescanning, setRescanning] = useState(false);
  const status = sandboxStatus(sandbox);
  const detail = sandboxStatusDetail(sandbox);
  const connection =
    sandbox.phase === "ready" && presentation !== null
      ? connectionStatusText(presentation.connection)
      : null;
  const connected = presentation?.connection.phase === "connected";

  const rescan = async () => {
    if (environmentId === null) return;
    setRescanning(true);
    const result = await seed({ name: sandbox.name, environmentId, includeSeeded: true }).catch(
      (cause: unknown) => ({
        created: 0,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    setRescanning(false);
    toastManager.add(
      stackedThreadToast(
        result.error === null
          ? {
              type: "success",
              title:
                result.created === 0
                  ? `No new repositories in ${sandbox.name}`
                  : `Added ${result.created} ${result.created === 1 ? "project" : "projects"} from ${sandbox.name}`,
            }
          : {
              type: "error",
              title: `Could not add projects from ${sandbox.name}`,
              description: result.error,
            },
      ),
    );
  };

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
        <span className="block min-w-0 break-words">
          {[detail, connection, running > 0 ? runningLabel(running) : null]
            .filter((part) => part !== null && part !== "")
            .join(" · ") || sandbox.manifestPath}
        </span>
      }
      control={
        <div className="flex shrink-0 items-center gap-1">
          {canStartSandbox(sandbox) ? (
            <Button size="xs" variant="outline" onClick={() => void startSandbox(sandbox)}>
              Start
            </Button>
          ) : null}
          {connected ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={rescanning}
              onClick={() => void rescan()}
            >
              {rescanning ? "Scanning…" : "Find projects"}
            </Button>
          ) : null}
          {canStopSandbox(sandbox) ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void stopSandbox(sandbox, running)}
            >
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

/** Where "New Sandbox" looks for manifests, and the env file it passes by default. */
function SandboxManifestSettings() {
  const [settings, setSettings] = useState<AgentctlSandboxSettings | null>(null);
  const [envFile, setEnvFile] = useState("");

  useEffect(() => {
    void readAgentctlBridge()
      ?.getSettings()
      .then((next) => {
        setSettings(next);
        setEnvFile(next.envFile ?? "");
      });
  }, []);

  const save = async (next: AgentctlSandboxSettings) => {
    const saved = await readAgentctlBridge()?.setSettings(next);
    if (saved) setSettings(saved);
  };

  if (settings === null) return null;
  const addRoot = async () => {
    const folder = await window.desktopBridge?.pickFolder();
    if (!folder) return;
    await save({ ...settings, manifestRoots: [...new Set([...settings.manifestRoots, folder])] });
  };

  return (
    <>
      <SettingsRow
        title="Manifest folders"
        description={
          settings.manifestRoots.length === 0 ? (
            "Folders searched for agent.yaml and agent.<variant>.yaml when creating a Sandbox."
          ) : (
            <span className="flex flex-col gap-0.5">
              {settings.manifestRoots.map((root) => (
                <span key={root} className="inline-flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-xs">{root}</span>
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Remove ${root}`}
                    onClick={() =>
                      void save({
                        ...settings,
                        manifestRoots: settings.manifestRoots.filter((entry) => entry !== root),
                      })
                    }
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              ))}
            </span>
          )
        }
        control={
          <Button size="xs" variant="outline" onClick={() => void addRoot()}>
            <FolderPlusIcon className="size-3" />
            Add folder
          </Button>
        }
      />
      <SettingsRow
        title="Env file"
        description="Default --env-file for new Sandboxes. Empty uses .env beside the manifest."
        control={
          <Input
            className="w-full sm:w-64"
            size="sm"
            value={envFile}
            placeholder="~/agents.env"
            spellCheck={false}
            onChange={(event) => setEnvFile(event.target.value)}
            onBlur={() => {
              const trimmed = envFile.trim();
              if ((settings.envFile ?? "") === trimmed) return;
              void save({ ...settings, envFile: trimmed === "" ? null : trimmed });
            }}
          />
        }
      />
    </>
  );
}
