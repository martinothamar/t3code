import type { AgentctlActionResult, AgentctlSandbox } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
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

export const canStopSandbox = (sandbox: AgentctlSandbox) =>
  sandbox.action === null &&
  sandbox.phase !== "stopped" &&
  sandbox.phase !== "stopping" &&
  sandbox.phase !== "terminating";

export const canDeleteSandbox = (sandbox: AgentctlSandbox) =>
  sandbox.action === null && sandbox.phase !== "terminating";

function reportResult(title: string, result: AgentctlActionResult) {
  refreshSandboxSnapshot();
  if (result.error === null) return true;
  toastManager.add(stackedThreadToast({ type: "error", title, description: result.error }));
  return false;
}

async function confirm(message: string, destructive: boolean) {
  return (
    (await requestConfirmDialog(message, destructive ? { variant: "destructive" } : undefined)) ??
    false
  );
}

export async function startSandbox(sandbox: AgentctlSandbox): Promise<boolean> {
  const bridge = readAgentctlBridge();
  if (bridge === null) return false;
  const pending = bridge.start(sandbox.name);
  refreshSandboxSnapshot();
  return reportResult(`Could not start ${sandbox.name}`, await pending);
}

export async function stopSandbox(sandbox: AgentctlSandbox, running = 0): Promise<boolean> {
  const bridge = readAgentctlBridge();
  if (bridge === null) return false;
  const busy =
    running > 0
      ? ` ${running === 1 ? "1 thread is" : `${running} threads are`} still working there.`
      : "";
  const confirmed = await confirm(
    `Stop ${sandbox.name}?\nIts disk is kept, so you can start it again. Agents running in it stop with it.${busy}`,
    running > 0,
  );
  if (!confirmed) return false;
  const pending = bridge.stop(sandbox.name);
  refreshSandboxSnapshot();
  return reportResult(`Could not stop ${sandbox.name}`, await pending);
}

export async function deleteSandbox(sandbox: AgentctlSandbox): Promise<boolean> {
  const bridge = readAgentctlBridge();
  if (bridge === null) return false;
  const confirmed = await confirm(
    `Delete ${sandbox.name}?\nThe Sandbox and its disk are deleted, including work that was not pushed. Its projects and threads leave T3 Code.`,
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
