import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShells } from "../state/entities";
import { useSandboxes } from "./useSandboxes";

/** How many threads are working in each environment, so a Sandbox can show it is busy. */
export function useRunningThreadCounts(): ReadonlyMap<EnvironmentId, number> {
  const threads = useThreadShells();
  return useMemo(() => {
    const counts = new Map<EnvironmentId, number>();
    for (const thread of threads) {
      if (!threadRuntimeIsActive(thread.runtime)) continue;
      counts.set(thread.environmentId, (counts.get(thread.environmentId) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
}

export function runningLabel(count: number): string {
  return count === 1 ? "1 thread running" : `${count} threads running`;
}

/**
 * Names the Sandbox on a thread row next to its machine glyph. Other remote
 * environments keep the glyph alone, as upstream shows them.
 */
export function SandboxThreadLabel(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const sandboxes = useSandboxes();
  const isSandbox = sandboxes.some((sandbox) => sandbox.environmentId === props.environmentId);
  if (!isSandbox || props.label === null) return null;
  return <span className="max-w-24 truncate text-2xs leading-none">{props.label}</span>;
}
