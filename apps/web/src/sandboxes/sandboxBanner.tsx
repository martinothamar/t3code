import type { AgentctlSandboxesSnapshot } from "@t3tools/contracts";
import { WifiOffIcon } from "lucide-react";
import { useMemo } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { startSandbox } from "./sandboxActions";
import { useSandboxSelector } from "./useSandboxes";

const findSandbox = (snapshot: AgentctlSandboxesSnapshot, environmentId: string | null) =>
  environmentId === null
    ? undefined
    : snapshot.sandboxes.find((sandbox) => sandbox.environmentId === environmentId);

/**
 * The composer's offline banner for a Sandbox environment, in place of the
 * generic one: a stopped Sandbox is not reconnecting, it needs starting.
 */
export function useSandboxBanner(environmentId: string | null): ComposerBannerStackItem | null {
  // Primitive selections, so ChatView only re-renders when the banner changes.
  const name = useSandboxSelector((snapshot) => findSandbox(snapshot, environmentId)?.name ?? null);
  const state = useSandboxSelector((snapshot) => {
    const sandbox = findSandbox(snapshot, environmentId);
    if (sandbox?.action === null && sandbox.phase === "stopped") return "stopped";
    if (sandbox?.action === "starting" || sandbox?.phase === "starting") return "starting";
    return null;
  });

  return useMemo(() => {
    if (environmentId === null || name === null || state === null) return null;
    return {
      id: `environment-unavailable:${environmentId}`,
      variant: "warning",
      icon: <WifiOffIcon />,
      title: state === "stopped" ? `${name} is stopped` : `${name} is starting…`,
      actions:
        state === "stopped" ? (
          <Button size="xs" variant="ghost" onClick={() => void startSandbox(name)}>
            Start
          </Button>
        ) : undefined,
    };
  }, [environmentId, name, state]);
}
