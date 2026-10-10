import { EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { useSandboxProjectSeeding } from "./sandboxProjects";
import { useSandboxes } from "./useSandboxes";

const RESCAN_INTERVAL_MS = 20_000;
const RESCANS_AFTER_CONNECT = 15;

/**
 * Keeps each known Sandbox's environment in step with the Sandbox: connects
 * as soon as it is running again, and adds its repositories as projects each
 * time T3 connects to it.
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
        sandbox.environmentId === null ? [] : [sandbox.environmentId],
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
      />
    ),
  );
}

function SandboxEnvironmentCoordinator(props: {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly running: boolean;
}) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(props.environmentId));
  const seed = useSandboxProjectSeeding();
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const connected = presentation?.connection.phase === "connected";
  // Wait for the project list, or every repository would look new.
  const ready = connected && shell.data?.snapshot._tag === "Some";

  // A started Sandbox should not wait out the backoff its stopped time built up.
  const reconnect = useEffectEvent(() => {
    if (!connected) void retryNow(props.environmentId);
  });
  useEffect(() => {
    if (props.running) reconnect();
  }, [props.running]);

  // Repositories are often still being cloned when a Sandbox comes up, so
  // look again for a few minutes after each connect.
  useEffect(() => {
    if (!ready) return;
    const scan = () =>
      void seed({
        name: props.name,
        environmentId: props.environmentId,
        includeSeeded: false,
      }).catch((error: unknown) => console.warn("Could not add Sandbox projects.", error));
    scan();
    let remaining = RESCANS_AFTER_CONNECT;
    const interval = setInterval(() => {
      remaining -= 1;
      scan();
      if (remaining === 0) clearInterval(interval);
    }, RESCAN_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [ready, seed, props.name, props.environmentId]);

  return null;
}
