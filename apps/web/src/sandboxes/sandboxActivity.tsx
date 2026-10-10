import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShells } from "../state/entities";

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
