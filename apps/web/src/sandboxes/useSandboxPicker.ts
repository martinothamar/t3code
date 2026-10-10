import { EnvironmentId, type AgentctlSandbox } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useEnvironmentPresentation } from "../state/presentation";
import { openNewSandboxDialog } from "./NewSandboxDialog";
import { sandboxStatus, startSandbox } from "./sandboxActions";
import { useSandboxProjectSeeding } from "./sandboxProjects";
import { useSandboxSnapshot, useSandboxes } from "./useSandboxes";

const SANDBOX_VALUE_PREFIX = "agentctl-sandbox:";
// Long enough for a Sandbox that clones its repositories on first boot.
const PROJECT_WAIT_MS = 3 * 60_000;
export const NEW_SANDBOX_VALUE = `${SANDBOX_VALUE_PREFIX}new`;

/** Whether the location picker offers Sandboxes, even with a single environment. */
export function useOffersSandboxes(): boolean {
  return useSandboxSnapshot().status === "available";
}

export interface SandboxPickerItem {
  readonly value: string;
  readonly label: string;
  readonly status: string;
  readonly disabled: boolean;
}

/**
 * Sandboxes the draft cannot move to yet: stopped ones (picking one starts it)
 * and ones still being set up. Sandboxes that already hold the draft's
 * project are ordinary environment options.
 */
export function sandboxPickerItems(
  sandboxes: ReadonlyArray<AgentctlSandbox>,
  availableEnvironmentIds: ReadonlySet<string>,
): SandboxPickerItem[] {
  return sandboxes.flatMap((sandbox) => {
    if (sandbox.environmentId !== null && availableEnvironmentIds.has(sandbox.environmentId)) {
      return [];
    }
    if (!sandbox.sshAccess || sandbox.phase === "terminating") return [];
    const status = sandboxStatus(sandbox);
    const startable = sandbox.action === null && sandbox.phase === "stopped";
    const running = sandbox.phase === "ready" && sandbox.action === null;
    return [
      {
        value: `${SANDBOX_VALUE_PREFIX}${sandbox.name}`,
        label: sandbox.name,
        status: startable ? "Start" : running ? "Project not found" : status.label,
        disabled: !startable,
      },
    ];
  });
}

/**
 * Handles the picker's Sandbox entries. Starting or creating a Sandbox moves
 * the draft onto it once the Sandbox holds the draft's project; if it never
 * does, the draft stays and a toast says why.
 */
export function useSandboxPicker(input: {
  readonly availableEnvironmentIds: ReadonlySet<string>;
  readonly onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
}) {
  const sandboxes = useSandboxes();
  const [pendingName, setPendingName] = useState<string | null>(null);
  const found = sandboxes.find((sandbox) => sandbox.name === pendingName) ?? null;
  // A Sandbox that failed to come up is no longer waited on.
  const pending =
    found !== null && !(found.action === null && found.phase === "failed") ? found : null;
  const pendingEnvironmentId =
    pending?.environmentId == null ? null : EnvironmentId.make(pending.environmentId);
  const { presentation } = useEnvironmentPresentation(pendingEnvironmentId);
  const connected = presentation?.connection.phase === "connected";
  const arrived =
    pendingEnvironmentId !== null && input.availableEnvironmentIds.has(pendingEnvironmentId);
  const seed = useSandboxProjectSeeding();

  const moveDraft = useEffectEvent((environmentId: EnvironmentId) => {
    input.onEnvironmentChange?.(environmentId);
  });

  useEffect(() => {
    if (arrived && pendingEnvironmentId !== null) moveDraft(pendingEnvironmentId);
  }, [arrived, pendingEnvironmentId]);

  // Connected without the project: the repository may still be cloning or
  // turning into a project. The connection coordinator keeps scanning.
  const waitingName = pending?.name ?? null;
  useEffect(() => {
    if (waitingName === null || pendingEnvironmentId === null || !connected || arrived) return;
    void seed({
      name: waitingName,
      environmentId: pendingEnvironmentId,
      includeSeeded: false,
    }).catch(() => undefined);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `Waiting for this project in ${waitingName}`,
        description: "The draft moves there once the repository is in the Sandbox.",
      }),
    );
    const timeout = setTimeout(() => {
      setPendingName(null);
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `${waitingName} does not have this project`,
          description:
            "The draft stays where it is. Clone the repository into the Sandbox to use it there.",
        }),
      );
    }, PROJECT_WAIT_MS);
    return () => clearTimeout(timeout);
  }, [waitingName, pendingEnvironmentId, connected, arrived, seed]);

  const select = (value: string): boolean => {
    if (!value.startsWith(SANDBOX_VALUE_PREFIX)) return false;
    if (value === NEW_SANDBOX_VALUE) {
      openNewSandboxDialog({ onReady: (sandbox) => setPendingName(sandbox.name) });
      return true;
    }
    const sandbox = sandboxes.find(
      (candidate) => `${SANDBOX_VALUE_PREFIX}${candidate.name}` === value,
    );
    if (sandbox !== undefined) {
      setPendingName(sandbox.name);
      void startSandbox(sandbox).then((started) => (started ? null : setPendingName(null)));
    }
    return true;
  };

  return {
    offered: useOffersSandboxes(),
    items: sandboxPickerItems(sandboxes, input.availableEnvironmentIds),
    pendingName: pending === null || arrived ? null : pending.name,
    select,
  };
}
