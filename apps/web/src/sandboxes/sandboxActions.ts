import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { AgentctlActionResult, AgentctlSandbox } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { readAgentctlBridge } from "./sandboxConnections";
import { refreshSandboxSnapshot } from "./useSandboxes";

export type SandboxTone = "success" | "info" | "warning" | "error" | "muted";

/** What a Sandbox is doing, with T3's own pending request taking precedence. */
export function sandboxStatus(sandbox: AgentctlSandbox): {
  readonly label: string;
  readonly tone: SandboxTone;
} {
  switch (sandbox.action) {
    case "creating":
      return { label: "Creating…", tone: "info" };
    case "starting":
      return { label: "Starting…", tone: "info" };
    case "stopping":
      return { label: "Stopping…", tone: "info" };
    case "deleting":
      return { label: "Deleting…", tone: "info" };
    case null:
      break;
  }
  switch (sandbox.phase) {
    case "ready":
      if (!sandbox.sshAccess) return { label: "Running, no SSH", tone: "warning" };
      if (sandbox.connectError !== null) return { label: "Cannot connect", tone: "error" };
      // T3 installs and starts its server in the Sandbox before it is reachable.
      if (sandbox.environmentId === null) return { label: "Connecting…", tone: "info" };
      return { label: "Running", tone: "success" };
    case "stopped":
      return { label: "Stopped", tone: "muted" };
    case "pending":
    case "provisioning":
      return { label: "Provisioning…", tone: "info" };
    case "starting":
      return { label: "Starting…", tone: "info" };
    case "stopping":
      return { label: "Stopping…", tone: "info" };
    case "retrying":
      return { label: "Retrying", tone: "warning" };
    case "unresponsive":
      return { label: "Unresponsive", tone: "error" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "terminating":
      return { label: "Deleting…", tone: "info" };
  }
}

/** The line that explains the status: progress, or why something failed. */
export function sandboxStatusDetail(sandbox: AgentctlSandbox): string | null {
  if (sandbox.actionError !== null) return sandbox.actionError;
  if (!sandbox.sshAccess)
    return "Add `access: [{type: ssh}]` to its manifest to use it from T3 Code.";
  return sandbox.connectError ?? sandbox.detail;
}

export const canStartSandbox = (sandbox: AgentctlSandbox) =>
  sandbox.action === null && sandbox.phase === "stopped";

// Stop and Delete stay available while a create or start is pending, so a
// Sandbox agentctl is stuck on is never out of reach.
const isLeaving = (sandbox: AgentctlSandbox) =>
  sandbox.action === "stopping" || sandbox.action === "deleting" || sandbox.phase === "terminating";

export const canStopSandbox = (sandbox: AgentctlSandbox) =>
  !isLeaving(sandbox) && sandbox.phase !== "stopped" && sandbox.phase !== "stopping";

export const canDeleteSandbox = (sandbox: AgentctlSandbox) => !isLeaving(sandbox);

function reportResult(title: string, result: AgentctlActionResult) {
  refreshSandboxSnapshot();
  if (result.error === null) return true;
  toastManager.add(stackedThreadToast({ type: "error", title, description: result.error }));
  return false;
}

// One request of each kind per Sandbox at a time, so a double click does not
// run it twice; a pending start does not block a stop or delete.
const inFlight = new Set<string>();

async function once(key: string, run: () => Promise<boolean>): Promise<boolean> {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/** Threads working in the Sandbox now, read at confirm time from any entry point. */
function runningThreads(sandbox: AgentctlSandbox): number {
  if (sandbox.environmentId === null) return 0;
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter(
      (thread) =>
        thread.environmentId === sandbox.environmentId && threadRuntimeIsActive(thread.runtime),
    ).length;
}

function runningWarning(sandbox: AgentctlSandbox): string {
  const running = runningThreads(sandbox);
  if (running === 0) return "";
  return ` ${running === 1 ? "1 thread is" : `${running} threads are`} still working there.`;
}

async function confirm(message: string, destructive: boolean) {
  return (
    (await requestConfirmDialog(message, destructive ? { variant: "destructive" } : undefined)) ??
    false
  );
}

export function startSandbox(sandbox: AgentctlSandbox): Promise<boolean> {
  return once(`start:${sandbox.name}`, () => runStart(sandbox.name));
}

/** Starts a Sandbox by name, for callers that only hold its name. */
export function startSandboxNamed(name: string): Promise<boolean> {
  return once(`start:${name}`, () => runStart(name));
}

async function runStart(name: string): Promise<boolean> {
  const bridge = readAgentctlBridge();
  if (bridge === null) return false;
  const pending = bridge.start(name);
  refreshSandboxSnapshot();
  return reportResult(`Could not start ${name}`, await pending);
}

export function stopSandbox(sandbox: AgentctlSandbox): Promise<boolean> {
  return once(`stop:${sandbox.name}`, () => runStop(sandbox));
}

async function runStop(sandbox: AgentctlSandbox): Promise<boolean> {
  const bridge = readAgentctlBridge();
  if (bridge === null) return false;
  const busy = runningWarning(sandbox);
  const confirmed = await confirm(
    `Stop ${sandbox.name}?\nIts disk is kept, so you can start it again. Agents running in it stop with it.${busy}`,
    busy !== "",
  );
  if (!confirmed) return false;
  const pending = bridge.stop(sandbox.name);
  refreshSandboxSnapshot();
  return reportResult(`Could not stop ${sandbox.name}`, await pending);
}

export function deleteSandbox(sandbox: AgentctlSandbox): Promise<boolean> {
  return once(`delete:${sandbox.name}`, () => runDelete(sandbox));
}

async function runDelete(sandbox: AgentctlSandbox): Promise<boolean> {
  const bridge = readAgentctlBridge();
  if (bridge === null) return false;
  const confirmed = await confirm(
    `Delete ${sandbox.name}?\nThe Sandbox and its disk are deleted, including work that was not pushed. Its project and threads leave T3 Code.${runningWarning(sandbox)}`,
    true,
  );
  if (!confirmed) return false;
  const pending = bridge.remove(sandbox.name);
  refreshSandboxSnapshot();
  return reportResult(`Could not delete ${sandbox.name}`, await pending);
}

/** Suggests the manifest's own name, numbered past the Sandboxes that already use it. */
export function suggestSandboxName(
  agentName: string | null,
  existing: ReadonlyArray<AgentctlSandbox>,
): string {
  const base = agentName ?? "sandbox";
  const taken = new Set(existing.map((sandbox) => sandbox.name));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
  }
}
