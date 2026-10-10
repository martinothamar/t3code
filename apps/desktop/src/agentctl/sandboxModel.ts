import {
  AgentctlSandboxSettings,
  DesktopSshEnvironmentTargetSchema,
  EnvironmentId,
  type AgentctlSandbox,
  type AgentctlSandboxAction,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  deriveAgentState,
  hasSshAccess,
  manifestVariant,
  sshAliasFor,
  type AgentResource,
} from "./agentState.ts";

/**
 * What T3 remembers about a Sandbox it reached: the environment its server
 * reported, so a stopped Sandbox still shows up as that environment, and
 * whether it already made the Sandbox's project, so removing it sticks.
 */
export const SandboxRecord = Schema.Struct({
  sandboxId: Schema.NullOr(Schema.String),
  environmentId: EnvironmentId,
  sshTarget: Schema.NullOr(DesktopSshEnvironmentTargetSchema),
  // Optional so a state file from before this field still loads.
  projectCreated: Schema.optionalKey(Schema.Boolean),
});
export type SandboxRecord = typeof SandboxRecord.Type;

export const SandboxStoreDocument = Schema.Struct({
  settings: Schema.optionalKey(AgentctlSandboxSettings),
  sandboxes: Schema.optionalKey(Schema.Record(Schema.String, SandboxRecord)),
});
export type SandboxStoreDocument = typeof SandboxStoreDocument.Type;

export const DEFAULT_SANDBOX_SETTINGS: AgentctlSandboxSettings = {
  manifestRoots: [],
  envFile: null,
};

/** In-memory state for one Sandbox; none of it survives a restart. */
export interface SandboxRuntime {
  readonly action: AgentctlSandboxAction | null;
  /** Which request owns `action`, so a superseded one leaves it alone. */
  readonly actionId: number;
  readonly actionError: string | null;
  readonly connectError: string | null;
  /**
   * T3 confirmed the Sandbox's environment since it last became reachable.
   * Until then it keeps checking, so a reset T3 home inside it is noticed.
   */
  readonly verified: boolean;
}

export const IDLE_RUNTIME: SandboxRuntime = {
  action: null,
  actionId: 0,
  actionError: null,
  connectError: null,
  verified: false,
};

/** Drops records for Sandboxes that are gone or being deleted. */
export function reconcileRecords(
  records: Readonly<Record<string, SandboxRecord>>,
  agents: ReadonlyArray<AgentResource>,
): Record<string, SandboxRecord> {
  const next: Record<string, SandboxRecord> = {};
  for (const [name, record] of Object.entries(records)) {
    const agent = agents.find((candidate) => candidate.metadata.name === name);
    if (agent === undefined || agent.metadata.deletionTimestamp !== undefined) continue;
    next[name] = record;
  }
  return next;
}

/**
 * Whether T3 must reach the Sandbox to learn its environment: it never has, or
 * agentctl reports a different sandbox, which may be a recreated one with a
 * fresh disk. The record stays until discovery says which.
 */
export function needsDiscovery(record: SandboxRecord | undefined, agent: AgentResource): boolean {
  if (record === undefined) return true;
  const sandboxId = agent.status?.sandbox?.id ?? null;
  return sandboxId !== null && record.sandboxId !== null && sandboxId !== record.sandboxId;
}

/** The record after discovery: the same environment keeps its project state. */
export function discoveredRecord(
  previous: SandboxRecord | undefined,
  discovered: Omit<SandboxRecord, "projectCreated">,
): SandboxRecord {
  return {
    ...discovered,
    projectCreated:
      previous?.environmentId === discovered.environmentId && previous.projectCreated === true,
  };
}

export function buildSandbox(
  agent: AgentResource,
  record: SandboxRecord | undefined,
  runtime: SandboxRuntime,
): AgentctlSandbox {
  const state = deriveAgentState(agent);
  const manifestPath = agent.status?.provenance?.manifestPath ?? null;
  return {
    name: agent.metadata.name,
    phase: state.phase,
    detail: state.detail,
    sshAccess: hasSshAccess(agent),
    sshAlias: sshAliasFor(agent.metadata.name),
    sshTarget: record?.sshTarget ?? null,
    environmentId: record?.environmentId ?? null,
    projectCreated: record?.projectCreated === true,
    connectError: state.phase === "ready" ? runtime.connectError : null,
    action: runtime.action,
    actionError: runtime.actionError,
    manifestPath,
    variant: manifestPath === null ? null : manifestVariant(manifestPath),
  };
}

/** Whether a lifecycle request T3 started has run its course. */
export function isActionSettled(action: AgentctlSandboxAction, agent: AgentResource | undefined) {
  if (action === "deleting") return agent === undefined;
  if (agent === undefined) return action !== "creating";
  const phase = deriveAgentState(agent).phase;
  // A pass agentctl keeps retrying settles the request too: agentctl owns the
  // retries, and the user must be able to stop or delete the Sandbox meanwhile.
  const stuck = phase === "failed" || phase === "retrying" || phase === "unresponsive";
  switch (action) {
    case "creating":
      return phase === "ready" || phase === "stopped" || stuck;
    // Right after a start, agentctl can still read stopped; the start call
    // itself settles that case when it returns.
    case "starting":
      return phase === "ready" || stuck;
    case "stopping":
      return phase === "stopped" || stuck;
  }
}

// agentctl's own rule for `metadata.name`, so T3 rejects a bad name before applying.
const SANDBOX_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function sandboxNameError(
  name: string,
  existing: ReadonlyArray<AgentResource>,
): string | null {
  if (!SANDBOX_NAME.test(name)) {
    return "Use lowercase letters, digits and dashes, starting and ending with a letter or digit.";
  }
  // Applying an existing name updates that Sandbox's manifest instead of creating one.
  if (existing.some((agent) => agent.metadata.name === name)) {
    return `A Sandbox named ${name} already exists.`;
  }
  return null;
}
