import { EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { isSandboxBeingDeleted } from "./sandboxConnections";
import { useEnsureSandboxProject } from "./sandboxProjects";
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
      />
    ),
  );
}

function SandboxEnvironmentCoordinator(props: {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly running: boolean;
  readonly workingDirectory: string | null;
}) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(props.environmentId));
  const ensureProject = useEnsureSandboxProject();
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

  return null;
}
