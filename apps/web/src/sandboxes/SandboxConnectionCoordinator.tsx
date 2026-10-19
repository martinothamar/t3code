import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  requiredScopesForServerSettingsPatch,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerConfigAtom, serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { isSandboxBeingDeleted, readAgentctlBridge } from "./sandboxConnections";
import { useEnsureSandboxProject } from "./sandboxProjects";
import { sandboxSettingsSeed } from "./sandboxSettingsSeed";
import { useSandboxes } from "./useSandboxes";

/**
 * Keeps each known Sandbox's environment in step with the Sandbox: connects
 * as soon as it is running again, and gives it its project once connected.
 */
export function SandboxConnectionCoordinator() {
  const sandboxes = useSandboxes();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const knownEnvironmentIds = useRef(new Set<string>());

  // A deleted Sandbox takes its environment along; leave a thread view on it.
  const leaveRemovedEnvironment = useEffectEvent((removed: ReadonlyArray<string>) => {
    if (removed.some((environmentId) => pathname.startsWith(`/${environmentId}/`))) {
      void navigate({ to: "/" });
    }
  });
  useEffect(() => {
    const current = new Set<string>(
      sandboxes.flatMap((sandbox) =>
        sandbox.environmentId === null || isSandboxBeingDeleted(sandbox)
          ? []
          : [sandbox.environmentId],
      ),
    );
    const removed = [...knownEnvironmentIds.current].filter((id) => !current.has(id));
    knownEnvironmentIds.current = current;
    if (removed.length > 0) leaveRemovedEnvironment(removed);
  }, [sandboxes]);

  return sandboxes.map((sandbox) =>
    sandbox.environmentId === null ? null : (
      <SandboxEnvironmentCoordinator
        key={`${sandbox.name}:${sandbox.environmentId}`}
        name={sandbox.name}
        environmentId={EnvironmentId.make(sandbox.environmentId)}
        running={sandbox.phase === "ready" && sandbox.action === null}
        workingDirectory={sandbox.workingDirectory}
        settingsSeeded={sandbox.settingsSeeded}
        harnesses={sandbox.harnesses}
      />
    ),
  );
}

function SandboxEnvironmentCoordinator(props: {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly running: boolean;
  readonly workingDirectory: string | null;
  readonly settingsSeeded: boolean;
  readonly harnesses: ReadonlyArray<string>;
}) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(props.environmentId));
  const ensureProject = useEnsureSandboxProject();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const localConfig = useAtomValue(primaryServerConfigAtom);
  const sandboxConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  // The Sandbox's providers arrive after it connects; waiting for them keeps
  // model selections from being skipped for good.
  const configsLoaded =
    localConfig !== null && sandboxConfig !== null && sandboxConfig.providers.length > 0;
  const seeding = useRef(false);
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const connected = presentation?.connection.phase === "connected";
  // Only a live project list can show the project is missing; a cached one may predate a removal.
  const ready = connected && shell.data?.status === "live" && shell.data.snapshot._tag === "Some";

  // A started Sandbox should not wait out the backoff its stopped time built up.
  const reconnect = useEffectEvent(() => {
    if (!connected) void retryNow(props.environmentId);
  });
  useEffect(() => {
    if (props.running) reconnect();
  }, [props.running]);

  // Each connect makes sure the Sandbox has its project, so a removed one comes back.
  useEffect(() => {
    if (!ready || props.workingDirectory === null) return;
    void ensureProject({
      name: props.name,
      environmentId: props.environmentId,
      workingDirectory: props.workingDirectory,
    }).then((error) => {
      if (error !== null) console.warn("Could not add the Sandbox project.", error);
    });
  }, [ready, ensureProject, props.name, props.environmentId, props.workingDirectory]);

  // A new Sandbox starts with the preferences changed on this computer, once,
  // so a later deliberate choice in the Sandbox is never undone.
  const seedSettings = useEffectEvent(async () => {
    if (seeding.current || props.settingsSeeded || !configsLoaded) {
      return;
    }
    seeding.current = true;
    try {
      const seed = sandboxSettingsSeed({
        local: localConfig.settings,
        sandbox: sandboxConfig.settings,
        sandboxProviderInstanceIds: new Set(
          sandboxConfig.providers
            .filter((provider) => provider.enabled)
            .map((provider) => provider.instanceId),
        ),
        harnesses: props.harnesses,
      });
      const changesSettings = Object.keys(seed.patch).length > 0;
      if (changesSettings || seed.providerInstanceMutation !== undefined) {
        const scopes = [
          ...(changesSettings ? requiredScopesForServerSettingsPatch(seed.patch) : []),
          ...(seed.providerInstanceMutation !== undefined ? [AuthProvidersManageScope] : []),
        ];
        if (!scopes.every((scope) => readEnvironmentScope(props.environmentId, scope))) return;
        const result = await updateSettings({ environmentId: props.environmentId, input: seed });
        if (result._tag === "Failure") {
          console.warn("Could not seed the Sandbox settings.");
          return;
        }
      }
      await readAgentctlBridge()?.markSettingsSeeded(props.name, props.environmentId);
    } finally {
      seeding.current = false;
    }
  });
  useEffect(() => {
    if (ready && configsLoaded) void seedSettings();
  }, [ready, configsLoaded]);

  return null;
}
