import {
  SshConnectionProfile,
  SshConnectionRegistration,
  SshConnectionTarget,
  type ConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type AgentctlSandbox,
  type AgentctlSandboxesSnapshot,
  type DesktopAgentctlBridge,
} from "@t3tools/contracts";

/**
 * agentctl Sandboxes are registered by the connection platform source as SSH
 * connections whose id carries this prefix. The producer mints ids with
 * {@link sandboxConnectionId} and consumers classify with
 * {@link sandboxNameForTarget}, so the two never drift apart.
 */
const SANDBOX_CONNECTION_ID_PREFIX = "agentctl:";

export function sandboxConnectionId(name: string): string {
  return `${SANDBOX_CONNECTION_ID_PREFIX}${name}`;
}

/** The Sandbox an environment connects to, or null for any other environment. */
export function sandboxNameForTarget(target: ConnectionTarget): string | null {
  return target._tag === "SshConnectionTarget" &&
    target.connectionId.startsWith(SANDBOX_CONNECTION_ID_PREFIX)
    ? target.connectionId.slice(SANDBOX_CONNECTION_ID_PREFIX.length)
    : null;
}

export function readAgentctlBridge(): DesktopAgentctlBridge | null {
  return typeof window === "undefined" ? null : (window.desktopBridge?.agentctl ?? null);
}

export const EMPTY_SANDBOX_SNAPSHOT: AgentctlSandboxesSnapshot = {
  status: "unavailable",
  error: null,
  sandboxes: [],
};

/**
 * Every Sandbox T3 has reached once is an environment, whether or not it is
 * running now: like a saved SSH host, a stopped one stays listed and simply
 * fails to connect until it is started. A deleted or recreated Sandbox loses
 * its environment id upstream, and with it the registration.
 */
export function sandboxRegistrations(
  sandboxes: ReadonlyArray<AgentctlSandbox>,
): SshConnectionRegistration[] {
  return sandboxes.flatMap((sandbox) => {
    if (sandbox.environmentId === null || sandbox.sshTarget === null || !sandbox.sshAccess) {
      return [];
    }
    const environmentId = EnvironmentId.make(sandbox.environmentId);
    const connectionId = sandboxConnectionId(sandbox.name);
    return [
      new SshConnectionRegistration({
        target: new SshConnectionTarget({ environmentId, label: sandbox.name, connectionId }),
        profile: new SshConnectionProfile({
          connectionId,
          environmentId,
          label: sandbox.name,
          target: sandbox.sshTarget,
        }),
      }),
    ];
  });
}
