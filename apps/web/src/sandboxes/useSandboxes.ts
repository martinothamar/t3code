import type { AgentctlSandbox, AgentctlSandboxesSnapshot } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { EMPTY_SANDBOX_SNAPSHOT, readAgentctlBridge } from "./sandboxConnections";

// The bridge has no change event, so one shared poller reads the desktop's
// snapshot while anything is subscribed. Reads are a cheap synchronous IPC,
// and rare without agentctl. Desktop main keeps the last Sandboxes when
// agentctl fails, so a read never drops them.
// Desktop main refreshes every 3 seconds, so reading more often finds nothing new.
const POLL_MS = 3_000;
const UNAVAILABLE_POLL_MS = 15_000;

let current: AgentctlSandboxesSnapshot = EMPTY_SANDBOX_SNAPSHOT;
let currentKey = "";
const listeners = new Set<() => void>();

function read() {
  const next = readAgentctlBridge()?.getSnapshot() ?? EMPTY_SANDBOX_SNAPSHOT;
  const key = JSON.stringify(next);
  if (key === currentKey) return;
  current = next;
  currentKey = key;
  for (const listener of listeners) listener();
}

let timer: ReturnType<typeof setTimeout> | null = null;

function poll() {
  read();
  timer = setTimeout(poll, current.status === "unavailable" ? UNAVAILABLE_POLL_MS : POLL_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null && readAgentctlBridge() !== null) poll();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** The current snapshot, read through the poller when it runs, for code outside React. */
export function readSandboxSnapshot(): AgentctlSandboxesSnapshot {
  if (timer === null) read();
  return current;
}

/** Re-reads right away, such as after a lifecycle request changed the snapshot. */
export function refreshSandboxSnapshot() {
  read();
}

export function useSandboxSnapshot(): AgentctlSandboxesSnapshot {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * Subscribes to one derived value. Return a primitive, so a component only
 * re-renders when that value changes rather than on every snapshot.
 */
export function useSandboxSelector<T extends string | number | boolean | null>(
  select: (snapshot: AgentctlSandboxesSnapshot) => T,
): T {
  return useSyncExternalStore(subscribe, () => select(current));
}

export function useSandboxes(): ReadonlyArray<AgentctlSandbox> {
  return useSandboxSnapshot().sandboxes;
}

export function useSandbox(name: string | null): AgentctlSandbox | null {
  const sandboxes = useSandboxes();
  return name === null ? null : (sandboxes.find((sandbox) => sandbox.name === name) ?? null);
}
