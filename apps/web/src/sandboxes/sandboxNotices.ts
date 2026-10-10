import { useMemo } from "react";

import { useSandboxSelector } from "./useSandboxes";

/** Whether this desktop build can reach agentctl, so Sandbox actions are worth offering. */
export function useOffersSandboxes(): boolean {
  return useSandboxSelector((snapshot) => snapshot.status === "available");
}

/**
 * Says why a Sandbox environment is unreachable, for the composer's offline
 * banner: a stopped Sandbox is not reconnecting, it needs starting.
 */
export function useSandboxUnavailableNotice(environmentId: string | null): {
  readonly title: string;
  readonly name: string;
  readonly canStart: boolean;
} | null {
  // A primitive key, so ChatView only re-renders when the notice itself changes.
  const key = useSandboxSelector((snapshot) => {
    if (environmentId === null) return null;
    const sandbox = snapshot.sandboxes.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (sandbox === undefined) return null;
    if (sandbox.action === null && sandbox.phase === "stopped") return `stopped:${sandbox.name}`;
    if (sandbox.action === "starting" || sandbox.phase === "starting") {
      return `starting:${sandbox.name}`;
    }
    return null;
  });
  return useMemo(() => {
    if (key === null) return null;
    const separator = key.indexOf(":");
    const name = key.slice(separator + 1);
    return key.startsWith("stopped:")
      ? { title: `${name} is stopped`, name, canStart: true }
      : { title: `${name} is starting…`, name, canStart: false };
  }, [key]);
}
