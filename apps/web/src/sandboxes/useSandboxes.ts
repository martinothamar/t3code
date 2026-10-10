import type { AgentctlSandbox, AgentctlSandboxesSnapshot } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import {
  EMPTY_SANDBOX_SNAPSHOT,
  readAgentctlBridge,
  readSandboxSnapshot,
} from "./sandboxConnections";

// The bridge has no change event, so one shared poller reads the desktop's
// snapshot while anything is subscribed. Reads are a cheap synchronous IPC.
const POLL_MS = 1_500;

let current: AgentctlSandboxesSnapshot = EMPTY_SANDBOX_SNAPSHOT;
let currentKey = "";
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;

function read() {
  const next = readSandboxSnapshot();
  const key = JSON.stringify(next);
  if (key === currentKey) return;
  current = next;
  currentKey = key;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (interval === null && readAgentctlBridge() !== null) {
    read();
    interval = setInterval(read, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

/** Re-reads right away, such as after a lifecycle request changed the snapshot. */
export function refreshSandboxSnapshot() {
  read();
}

export function useSandboxSnapshot(): AgentctlSandboxesSnapshot {
  return useSyncExternalStore(subscribe, () => current);
}

export function useSandboxes(): ReadonlyArray<AgentctlSandbox> {
  return useSandboxSnapshot().sandboxes;
}

export function useSandbox(name: string | null): AgentctlSandbox | null {
  const sandboxes = useSandboxes();
  return name === null ? null : (sandboxes.find((sandbox) => sandbox.name === name) ?? null);
}
